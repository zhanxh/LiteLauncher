//! 老库原地升级 + 区间展开：验的是最容易被静默打死的两条路径
//!
//! 1. `db.migrate()` 是 `execute_batch`，任一语句出错整个 `init()` 就废——
//!    老库补列必须**幂等**，否则第二次启动直接把插件打死；
//! 2. `query_range` 的 SQL 要过宿主的语句头白名单，且展开逻辑依赖列的真实类型。

#![cfg(test)]

mod common;
use common::{cols, count, ctx_with, upgraded, Shared, V1_DDL};
use serde_json::{json, Value as JsonValue};
use ll_plugin_api::PluginBackend;
use std::sync::{Arc, Mutex};

/// 老库原地升级：init() 必须成功、补齐 9 列、建 3 张新表，且**第二次启动不再撞 duplicate column**
#[test]
fn legacy_db_upgrades_once_and_survives_restart() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(V1_DDL).unwrap();
    conn.execute_batch(
        "INSERT INTO todos VALUES
         ('a','已完成的老提醒','2026-10-01 09:00',NULL,1,'',1761000000,1),
         ('b','每天喝水','2026-10-11 13:35','every:1day',0,'',1761000100,1),
         ('c','无日期便签',NULL,NULL,0,'',1761000200,0)",
    )
    .unwrap();

    let before = cols(&conn);
    assert_eq!(before.len(), 8, "起点必须是 8 列的 v1 库");

    let shared: Shared = Arc::new(Mutex::new(conn));
    let plugin = ll_plugin_todo::TodoPlugin::new();
    // 第一次 init：补列 + 建表 + 回填
    plugin
        .init(ctx_with(Arc::clone(&shared)))
        .expect("老库 init 失败");

    let after = cols(&shared.lock().unwrap());
    assert_eq!(after.len(), 17, "v2 应共 17 列，实得 {:?}", after);
    assert!(after.contains(&"start_at".to_string()));
    assert!(after.contains(&"repeat_until".to_string()));

    {
        let c = shared.lock().unwrap();
        assert_eq!(count(&c, "todos"), 3, "老数据不能被删");
        assert_eq!(count(&c, "event_alarms"), 2, "有提醒时间的两行各补一条提醒");
        // notified=1 的历史待办必须预写触发记录，否则升级后会集体重弹
        assert_eq!(count(&c, "alarm_fires"), 2, "已通知过的两行要预写 alarm_fires");
        // 升级即备好默认分类，老数据才有归属（回填把 calendar_id 为空的行挂到它下面）
        assert_eq!(count(&c, "calendars"), 1);
        assert_eq!(
            c.query_row(
                "SELECT name FROM calendars WHERE id='default'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "我的日程"
        );
        assert_eq!(
            count(&c, "todos WHERE calendar_id='default'"),
            3,
            "老行必须挂到默认分类，否则前端按分类筛选会整表消失"
        );
        assert_eq!(
            c.query_row("SELECT all_day FROM todos WHERE id='c'", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1,
            "无日期的旧便签应降为全天事项"
        );
        assert_eq!(
            c.query_row("SELECT start_at FROM todos WHERE id='b'", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "2026-10-11 13:35"
        );
        let uid: String = c
            .query_row("SELECT uid FROM todos WHERE id='a'", [], |r| r.get(0))
            .unwrap();
        assert!(uid.len() >= 32, "uid 应补齐以便 .ics 去重，实得 {uid}");
    }

    // 第二次 init（模拟重启）：schema 已齐，不得再发 ALTER，否则 duplicate column 打死插件。
    // 新 ctx 意味着空的 settings 存储，回填守卫失效——正好连带验证回填本身也幂等。
    let again = ll_plugin_todo::TodoPlugin::new();
    again
        .init(ctx_with(Arc::clone(&shared)))
        .expect("第二次 init 失败：迁移不幂等，插件会在重启后永久废掉");

    {
        let c = shared.lock().unwrap();
        assert_eq!(count(&c, "event_alarms"), 2, "重启不应重复补提醒");
        assert_eq!(count(&c, "alarm_fires"), 2, "重启不应重复写触发记录");
        assert_eq!(count(&c, "calendars"), 1, "默认分类不该被种第二次");
    }
}

/// 升级后的库必须能被 `query_range` 正常展开（这是月视图唯一的数据来源）
#[test]
fn query_range_expands_upgraded_rows() {
    let (plugin, shared) = upgraded();
    // v1 库经 init 升级到 v2 后，再手工放一条每周一 09:00 的重复日程
    shared.lock().unwrap().execute_batch(
        "INSERT INTO todos (id,content,start_at,end_at,repeat_rule,completed,created_at,notified,uid)
         VALUES ('w','周会','2026-10-05 09:00','2026-10-05 10:00','every:1week',0,1,0,'u-w');
         INSERT INTO event_alarms (id,event_id,minutes_before) VALUES ('al','w',10);
         INSERT INTO event_alarms (id,event_id,minutes_before) VALUES ('al2','w',30)",
    ).unwrap();

    let res = plugin
        .call(
            "query_range",
            json!({"from": "2026-10-01", "to": "2026-10-31"}),
        )
        .expect("query_range 失败");
    let inst = res
        .get("instances")
        .and_then(|v| v.as_array())
        .expect("返回应含 instances 数组");

    let weds: Vec<&JsonValue> = inst
        .iter()
        .filter(|i| i.get("event_id").and_then(|v| v.as_str()) == Some("w"))
        .collect();
    assert_eq!(weds.len(), 4, "10 月有 4 个周一，实得 {}", weds.len());
    assert_eq!(
        weds[0].get("start").unwrap(),
        &json!("2026-10-05 09:00")
    );
    assert_eq!(
        weds[0].get("is_virtual").unwrap(),
        &json!(false),
        "首实例沿用原记录"
    );
    assert_eq!(
        weds[1].get("is_virtual").unwrap(),
        &json!(true),
        "后续实例是虚拟展开"
    );
    assert_eq!(
        weds[0].get("occ_key").unwrap(),
        &json!("2026-10-05 09:00"),
        "occ_key 是提醒幂等的键"
    );
    let alarms = weds[0].get("alarms").unwrap().as_array().unwrap();
    assert_eq!(alarms.len(), 2, "两条提醒都要带出来，实得 {alarms:?}");
    assert_eq!(res.get("truncated").unwrap(), &json!(false));

    // 空区间/倒序区间要被拒，而不是返回全表
    assert!(plugin
        .call("query_range", json!({"from": "2026-10-31", "to": "2026-10-01"}))
        .is_err());
    assert!(plugin.call("query_range", json!({})).is_err());
}

/// 无日期的旧便签不该在日历上占位（否则每月都多出 N 条"00:00"条目）
#[test]
fn undated_legacy_rows_stay_off_the_grid() {
    let shared: Shared = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
    shared.lock().unwrap().execute_batch(V1_DDL).unwrap();
    shared.lock().unwrap().execute_batch(
        "INSERT INTO todos VALUES ('n','没写时间的便签',NULL,NULL,0,'',1,0)",
    ).unwrap();

    let plugin = ll_plugin_todo::TodoPlugin::new();
    plugin.init(ctx_with(Arc::clone(&shared))).unwrap();

    let res = plugin
        .call("query_range", json!({"from": "2026-10-01", "to": "2026-10-31"}))
        .unwrap();
    let inst = res.get("instances").unwrap().as_array().unwrap();
    assert!(
        inst.iter()
            .all(|i| i.get("event_id").and_then(|v| v.as_str()) != Some("n")),
        "无日期条目不该进日历：{inst:?}"
    );
    // 但清单视图仍应看到它——降级不能丢数据
    let listed = plugin.call("list", json!({"keyword": null})).unwrap();
    assert!(listed
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t.get("id").and_then(|v| v.as_str()) == Some("n")));
}
