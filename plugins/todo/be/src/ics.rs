//! `.ics` 子集解析与导出（RFC 5545 里个人日程真正用得上的那部分）
//!
//! 明确不支持的字段一律忽略而不是报错——协作类属性（ATTENDEE/ORGANIZER）、
//! 实例级例外（EXDATE/RDATE/RECURRENCE-ID）在单人日历里没有落点，
//! 为了它们把整个导入卡住只会让用户换不掉别的日历。
//!
//! 时区策略：本项目全程存"本地裸串"（`YYYY-MM-DD HH:MM`，无时区），因此
//! - 带 `Z` 的 UTC 时刻 → 换算成本地墙上时间；
//! - 带 `TZID=` 的时刻 → **只取墙上时间、丢掉时区**（等价于"按我这边的钟点理解它"）。
//! 两种做法在导出端统一成"浮动本地时间"（不写 Z 也不写 TZID），
//! 所以本项目导出再导入是恒等的；跨时区分享不在设计范围内。

use chrono::{Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};

/// RFC 5545 要求物理行不超过 75 字节（不含 CRLF）
const MAX_LINE_OCTETS: usize = 75;

/// 一条 VEVENT 的解析结果；字段与 `todos` 表一一对应，导入侧不用再翻译
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IcsEvent {
    pub uid: String,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start: Option<NaiveDateTime>,
    pub end: Option<NaiveDateTime>,
    pub all_day: bool,
    /// `"free"` | `"busy"`（对应 TRANSP:TRANSPARENT / OPAQUE）
    pub status: String,
    /// 规范式 `every:N<unit>`，与 `recur::parse_repeat_rule` 同一套
    pub repeat_rule: Option<String>,
    /// `count:N` 或 `YYYY-MM-DD HH:MM`
    pub repeat_until: Option<String>,
    /// 提前多少分钟；与 `event_alarms.minutes_before` 同义
    pub alarms: Vec<i64>,
}

/// 解析 .ics 文本。返回的条目顺序与文件里一致；没有 SUMMARY 也没有时间的块丢掉
pub fn parse(text: &str) -> Vec<IcsEvent> {
    let mut out: Vec<IcsEvent> = Vec::new();
    let mut cur: Option<IcsEvent> = None;
    let mut in_event = false;
    let mut alarm_minutes: Option<i64> = None;

    for (name, params, value) in unfold(text) {
        // VALARM 内部的 DESCRIPTION/TRIGGER 属于提醒，不能落到事件本体上
        // （否则一条提醒就把日程备注覆盖了）。
        if alarm_minutes.is_some() && in_event && name != "BEGIN" && name != "END" {
            if name == "TRIGGER" {
                if let Some(min) = alarm_minutes.as_mut() {
                    *min = parse_trigger(&value).unwrap_or(0);
                }
            }
            continue;
        }
        match name.as_str() {
            "BEGIN" => match value.to_ascii_uppercase().as_str() {
                "VEVENT" => {
                    in_event = true;
                    cur = Some(IcsEvent {
                        status: "busy".to_string(),
                        ..Default::default()
                    });
                }
                "VALARM" if in_event => alarm_minutes = Some(0),
                _ => {}
            },
            "END" => match value.to_ascii_uppercase().as_str() {
                "VALARM" if in_event => {
                    if let (Some(ev), Some(min)) = (cur.as_mut(), alarm_minutes.take()) {
                        if !ev.alarms.contains(&min) {
                            ev.alarms.push(min);
                        }
                    }
                }
                "VEVENT" => {
                    if let Some(ev) = cur.take() {
                        if usable(&ev) {
                            out.push(ev);
                        }
                    }
                    in_event = false;
                    alarm_minutes = None;
                }
                _ => {}
            },
            _ if !in_event => {}
            _ => {
                if let Some(ev) = cur.as_mut() {
                    apply_property(ev, &name, &params, &value);
                }
            }
        }
    }
    out
}

/// 至少得有个标题或一个时间，否则导进来是一条什么都看不见的空记录
fn usable(ev: &IcsEvent) -> bool {
    !ev.summary.trim().is_empty() || ev.start.is_some()
}

fn apply_property(ev: &mut IcsEvent, name: &str, params: &[String], value: &str) {
    match name {
        "UID" => ev.uid = value.trim().to_string(),
        "SUMMARY" => ev.summary = unescape_text(value),
        "DESCRIPTION" => ev.description = Some(unescape_text(value)),
        "LOCATION" => ev.location = Some(unescape_text(value)),
        "STATUS" => {
            // RFC 的 STATUS 是事件确认态，我们的"忙/闲"在 TRANSP 上；
            // 只把明确的 CANCELLED/TENTATIVE 当作"空闲"看待。
            if value.eq_ignore_ascii_case("CANCELLED") {
                ev.status = "free".to_string();
            }
        }
        "TRANSP" => ev.status = if value.eq_ignore_ascii_case("TRANSPARENT") { "free" } else { "busy" }.to_string(),
        "DTSTART" => {
            if let Some((dt, all_day)) = parse_time(value, params) {
                ev.start = Some(dt);
                ev.all_day |= all_day;
            }
        }
        "DTEND" => {
            if let Some((dt, all_day)) = parse_time(value, params) {
                // 全天的 DTEND 是**不含**结束日的下一天 00:00，减一天回到"到 10-15"的语义
                ev.end = if all_day {
                    dt.date().pred_opt().and_then(|d| d.and_hms_opt(0, 0, 0))
                } else {
                    Some(dt)
                };
                ev.all_day |= all_day;
            }
        }
        "RRULE" => {
            let (rule, until) = parse_rrule(value);
            ev.repeat_rule = rule;
            ev.repeat_until = until;
        }
        _ => {} // DTSTAMP / CREATED / SEQUENCE / PRIORITY / CATEGORIES …：读到但不落库
    }
}

// ───────────────────────────── 行与转义 ─────────────────────────────

/// 拆成 (属性名, 参数列表, 值)，并把折行还原回一条逻辑行。
///
/// 折行的续行以单个 SP/HTAB 开头，去掉那**一个**字符后直接拼接——
/// 用 trim 会把 SUMMARY 里有意保留的前导空格吃掉。
fn unfold(text: &str) -> Vec<(String, Vec<String>, String)> {
    let mut logical: Vec<String> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let starts_with_space = line.starts_with(' ') || line.starts_with('\t');
        if starts_with_space && !logical.is_empty() {
            let last = logical.len() - 1;
            logical[last].push_str(&line[1..]);
            continue;
        }
        logical.push(line.to_string());
    }

    logical
        .into_iter()
        .filter_map(|line| {
            // 参数值里理论上可以出现带引号的 ':'，个人日历的字段碰不到；
            // 按第一个 ':' 切，剩下的整段当值（SUMMARY 里冒号很常见）。
            let (head, value) = line.split_once(':')?;
            let mut parts = head.split(';');
            let name = parts.next()?.trim().to_ascii_uppercase();
            let params = parts.map(|p| p.trim().to_ascii_uppercase()).collect();
            Some((name, params, value.to_string()))
        })
        .collect()
}

/// 反斜杠转义：`\` `;` `,` 与换行
fn escape_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(ch),
        }
    }
    out
}

fn unescape_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(c) => out.push(c),
            None => out.push('\\'),
        }
    }
    out
}

/// 按 **字节** 折行，且绝不切断 UTF-8 字符：中文标题按字符数折会把一个汉字
/// 劈成两半，导入方解码直接失败。
fn fold(line: &str) -> String {
    let mut out = String::with_capacity(line.len() + 8);
    let mut used = 0usize;
    let mut segments = 0usize;
    for ch in line.chars() {
        let limit = if segments == 0 { MAX_LINE_OCTETS } else { MAX_LINE_OCTETS - 1 };
        let len = ch.len_utf8();
        if used + len > limit {
            out.push_str("\r\n ");
            segments += 1;
            used = 0;
        }
        out.push(ch);
        used += len;
    }
    out
}

/// 一条逻辑行 → CRLF 结尾的物理行（可能已折好）
fn put(out: &mut String, line: &str) {
    out.push_str(&fold(line));
    out.push_str("\r\n");
}

// ───────────────────────────── 时间与规则 ─────────────────────────────

/// `.ics` 时间形态 → (本地裸时间, 是否全天)
///
/// 支持 `20261012`（配 `VALUE=DATE`）、`20261012T140000`（浮动本地）、
/// `20261012T140000Z`（UTC 转本地）、`TZID=…:…`（取墙上时间丢时区）。
fn parse_time(value: &str, params: &[String]) -> Option<(NaiveDateTime, bool)> {
    let raw = value.trim();
    if params.iter().any(|p| p == "VALUE=DATE") || raw.len() == 8 && raw.chars().all(|c| c.is_ascii_digit())
    {
        let date = NaiveDate::parse_from_str(raw, "%Y%m%d").ok()?;
        return Some((date.and_hms_opt(0, 0, 0)?, true));
    }

    if let Some(stripped) = raw.strip_suffix('Z') {
        let utc = NaiveDateTime::parse_from_str(stripped, "%Y%m%dT%H%M%S").ok()?;
        let local = Utc.from_utc_datetime(&utc).with_timezone(&Local).naive_local();
        return Some((local, false));
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(raw, "%Y%m%dT%H%M%S") {
        return Some((dt, false));
    }
    // 少数导出端省掉秒
    NaiveDateTime::parse_from_str(raw, "%Y%m%dT%H%M")
        .ok()
        .map(|dt| (dt, false))
}

/// `RRULE:FREQ=…;INTERVAL=…;COUNT=…|UNTIL=…` → (`every:N<unit>`, repeat_until)
///
/// `BYDAY`/`BYMONTHDAY` 这类展开规则不支持：本项目的重复语义就是
/// "从锚点按固定步长推进"，锚点自身的星期/日期已经承载了用户想要的落点。
fn parse_rrule(value: &str) -> (Option<String>, Option<String>) {
    let mut freq = String::new();
    let mut interval = 1u32;
    let mut count: Option<u32> = None;
    let mut until: Option<String> = None;

    for part in value.split(';') {
        let Some((k, v)) = part.split_once('=') else { continue };
        match k.trim().to_ascii_uppercase().as_str() {
            "FREQ" => freq = v.trim().to_ascii_uppercase(),
            "INTERVAL" => interval = v.trim().parse::<u32>().unwrap_or(1).clamp(1, 999),
            "COUNT" => count = v.trim().parse::<u32>().ok().filter(|n| *n > 0),
            "UNTIL" => until = parse_time(v, &[]).map(|(dt, _)| dt.format("%Y-%m-%d %H:%M").to_string()),
            _ => {}
        }
    }

    let unit = match freq.as_str() {
        "MINUTELY" => "min",
        "HOURLY" => "hour",
        "DAILY" => "day",
        "WEEKLY" => "week",
        "MONTHLY" => "month",
        "YEARLY" => "year",
        _ => return (None, None),
    };
    (
        Some(format!("every:{}{}", interval, unit)),
        count.map(|n| format!("count:{}", n)).or(until),
    )
}

/// `TRIGGER:-PT15M` / `-P1D` / `-PT2H30M` → 提前多少分钟。
/// `+` 开头（开始后提醒）与绝对时刻触发都表达不了，按"准时"处理。
fn parse_trigger(value: &str) -> Option<i64> {
    let raw = value.trim().to_ascii_uppercase();
    let (sign, rest) = match raw.strip_prefix('-') {
        Some(r) => (1i64, r),
        None => return Some(0), // '+' 或无前缀（绝对时间）→ 退化成准时提醒
    };
    let rest = rest.strip_prefix('P')?;
    let (date_part, time_part) = match rest.split_once('T') {
        Some((d, t)) => (d, t),
        None => (rest, ""),
    };

    let mut minutes = 0i64;
    let mut digits = String::new();
    for ch in date_part.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        let n: i64 = digits.parse().ok()?;
        digits.clear();
        match ch {
            'D' => minutes += n * 1440,
            'W' => minutes += n * 7 * 1440,
            _ => return Some(0),
        }
    }
    if !digits.is_empty() {
        return Some(0); // P 后面只有数字没有单位，非法
    }
    for ch in time_part.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        let n: i64 = digits.parse().ok()?;
        digits.clear();
        match ch {
            'H' => minutes += n * 60,
            'M' => minutes += n,
            'S' => minutes += (n + 59) / 60,
            _ => return Some(0),
        }
    }
    if !digits.is_empty() {
        return Some(0);
    }
    Some(sign * minutes.max(0))
}

/// 分钟数 → ISO 8601 时长串（整天用 `PnD`，其余统一分钟，读起来不绕）
fn format_trigger(minutes: i64) -> String {
    if minutes > 0 && minutes % 1440 == 0 {
        format!("-P{}D", minutes / 1440)
    } else {
        format!("-PT{}M", minutes)
    }
}

// ───────────────────────────── 导出 ─────────────────────────────

/// 渲染成 .ics 文本。`stamp` 是本次导出的 UTC 串（DTSTAMP，RFC 要求必填）
pub fn render(events: &[IcsEvent], stamp: &str) -> String {
    let mut out = String::new();
    put(&mut out, "BEGIN:VCALENDAR");
    put(&mut out, "PRODID:-//LiteLauncher//Cal//CN");
    put(&mut out, "VERSION:2.0");
    put(&mut out, "CALSCALE:GREGORIAN");
    for ev in events {
        put(&mut out, "BEGIN:VEVENT");
        put(&mut out, &format!("UID:{}", escape_text(&ev.uid)));
        put(&mut out, &format!("DTSTAMP:{}", stamp));
        match (ev.start, ev.all_day) {
            (Some(start), true) => {
                put(&mut out, &format!("DTSTART;VALUE=DATE:{}", start.format("%Y%m%d")));
                // 全天用"不含端点"的 DTEND：到 10-15 要写成 10-16
                let end_date = ev.end.map(|e| e.date()).unwrap_or(start.date());
                let exclusive = end_date + Duration::days(1);
                put(&mut out, &format!("DTEND;VALUE=DATE:{}", exclusive.format("%Y%m%d")));
            }
            (Some(start), false) => {
                put(&mut out, &format!("DTSTART:{}", start.format("%Y%m%dT%H%M%S")));
                if let Some(end) = ev.end {
                    put(&mut out, &format!("DTEND:{}", end.format("%Y%m%dT%H%M%S")));
                }
            }
            // 无日期事项在 .ics 里没有合法表达，但仍带 SUMMARY/UID 导出，
            // 导回来靠 UID 认得出同一条，不至于变成重复记录。
            (None, _) => {}
        }
        put(&mut out, &format!("SUMMARY:{}", escape_text(ev.summary.trim())));
        if let Some(desc) = ev.description.as_deref().filter(|s| !s.trim().is_empty()) {
            put(&mut out, &format!("DESCRIPTION:{}", escape_text(desc)));
        }
        if let Some(loc) = ev.location.as_deref().filter(|s| !s.trim().is_empty()) {
            put(&mut out, &format!("LOCATION:{}", escape_text(loc)));
        }
        put(&mut out, "STATUS:CONFIRMED");
        put(
            &mut out,
            &format!("TRANSP:{}", if ev.status == "free" { "TRANSPARENT" } else { "OPAQUE" }),
        );
        if let Some(rule) = ev.repeat_rule.as_deref().filter(|s| !s.is_empty()) {
            if let Some(line) = render_rrule(rule, ev.repeat_until.as_deref()) {
                put(&mut out, &line);
            }
        }
        for minutes in &ev.alarms {
            put(&mut out, "BEGIN:VALARM");
            put(&mut out, "ACTION:DISPLAY");
            put(&mut out, "DESCRIPTION:提醒");
            put(&mut out, &format!("TRIGGER:{}", format_trigger(*minutes)));
            put(&mut out, "END:VALARM");
        }
        put(&mut out, "END:VEVENT");
    }
    put(&mut out, "END:VCALENDAR");
    out
}

/// `every:2week` + `count:5`/`2026-12-31 00:00` → `FREQ=WEEKLY;INTERVAL=2;COUNT=5`
fn render_rrule(rule: &str, until: Option<&str>) -> Option<String> {
    let rest = rule.strip_prefix("every:")?;
    let split = rest.find(|c: char| !c.is_ascii_digit())?;
    let n: u32 = rest[..split].parse().ok()?;
    let freq = match &rest[split..] {
        "min" => "MINUTELY",
        "hour" => "HOURLY",
        "day" => "DAILY",
        "week" => "WEEKLY",
        "month" => "MONTHLY",
        "year" => "YEARLY",
        _ => return None,
    };
    let mut line = format!("RRULE:FREQ={}", freq);
    if n != 1 {
        line.push_str(&format!(";INTERVAL={}", n));
    }
    match until {
        Some(raw) if raw.trim().starts_with("count:") => {
            if let Ok(c) = raw.trim()[6..].parse::<u32>() {
                line.push_str(&format!(";COUNT={}", c));
            }
        }
        Some(raw) => {
            let trimmed = raw.trim();
            let until = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M")
                .ok()
                .or_else(|| {
                    NaiveDate::parse_from_str(trimmed, "%Y-%m-%d")
                        .ok()
                        .and_then(|d| d.and_hms_opt(0, 0, 0))
                });
            if let Some(dt) = until {
                line.push_str(&format!(";UNTIL={}", dt.format("%Y%m%dT%H%M%S")));
            }
        }
        None => {}
    }
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn d(y: i32, m: u32, day: u32, hh: u32, mm: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, day)
            .unwrap()
            .and_hms_opt(hh, mm, 0)
            .unwrap()
    }

    fn one(text: &str) -> IcsEvent {
        let v = parse(text);
        assert_eq!(v.len(), 1, "应恰好解析出一条：{v:?}");
        v.into_iter().next().unwrap()
    }

    #[test]
    fn parses_floating_local_time() {
        let ev = one("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nSUMMARY:周会\r\nDTSTART:20261012T140000\r\nDTEND:20261012T150000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
        assert_eq!(ev.uid, "u1");
        assert_eq!(ev.summary, "周会");
        assert_eq!(ev.start, Some(d(2026, 10, 12, 14, 0)));
        assert_eq!(ev.end, Some(d(2026, 10, 12, 15, 0)));
        assert!(!ev.all_day);
        assert_eq!(ev.status, "busy", "缺省按忙碌");
    }

    #[test]
    fn parses_all_day_span_as_inclusive_end_date() {
        let ev = one("BEGIN:VEVENT\r\nUID:u2\r\nSUMMARY:出差\r\nDTSTART;VALUE=DATE:20261012\r\nDTEND;VALUE=DATE:20261016\r\nEND:VEVENT");
        assert!(ev.all_day);
        assert_eq!(ev.start, Some(d(2026, 10, 12, 0, 0)));
        // DTEND 不含端点 → 还原成"到 10-15"
        assert_eq!(ev.end, Some(d(2026, 10, 15, 0, 0)));
    }

    #[test]
    fn converts_utc_and_drops_tzid() {
        // 东八区的 2026-10-12 02:00 = UTC 2026-10-11 18:00；换到任何时区的机器
        // 上都应还原成"本地钟点 02:00"，这是本项目丢时区策略的可观察结果。
        let utc = one("BEGIN:VEVENT\r\nUID:u3\r\nSUMMARY:Z\r\nDTSTART:20261011T180000Z\r\nEND:VEVENT");
        let local = chrono::DateTime::parse_from_rfc3339("2026-10-12T02:00:00+08:00")
            .unwrap()
            .with_timezone(&Local)
            .naive_local();
        assert_eq!(utc.start, Some(local), "Z 结尾必须换算到本地");

        let wall = one("BEGIN:VEVENT\r\nUID:u4\r\nSUMMARY:T\r\nDTSTART;TZID=Asia/Shanghai:20261012T140000\r\nEND:VEVENT");
        assert_eq!(wall.start, Some(d(2026, 10, 12, 14, 0)), "TZID 只取墙上时间");
    }

    #[test]
    fn parses_rrule_and_multiple_alarms() {
        let ev = one("BEGIN:VEVENT\r\nUID:u5\r\nSUMMARY:双周评审\r\nDTSTART:20261012T140000\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=5\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT30M\r\nEND:VALARM\r\nBEGIN:VALARM\r\nTRIGGER:-P1D\r\nEND:VALARM\r\nBEGIN:VALARM\r\nTRIGGER:-PT2H\r\nEND:VALARM\r\nEND:VEVENT");
        assert_eq!(ev.repeat_rule.as_deref(), Some("every:2week"));
        assert_eq!(ev.repeat_until.as_deref(), Some("count:5"));
        assert_eq!(ev.alarms, vec![30, 1440, 120], "多条提醒按出现顺序保留");
    }

    #[test]
    fn parses_until_and_positive_trigger() {
        let ev = one("BEGIN:VEVENT\r\nUID:u6\r\nSUMMARY:x\r\nDTSTART:20261012T140000\r\nRRULE:FREQ=MONTHLY;UNTIL=20261231T155900Z\r\nBEGIN:VALARM\r\nTRIGGER:PT10M\r\nEND:VALARM\r\nEND:VEVENT");
        assert_eq!(ev.repeat_rule.as_deref(), Some("every:1month"));
        assert!(ev.repeat_until.as_deref().unwrap().starts_with("2026-12-3"), "UNTIL 落到本地日期：{:?}", ev.repeat_until);
        assert_eq!(ev.alarms, vec![0], "开始后提醒表达不了，退化成准时");
    }

    #[test]
    fn ignores_unsupported_blocks_but_keeps_the_event() {
        let ev = one("BEGIN:VCALENDAR\r\nMETHOD:PUBLISH\r\nBEGIN:VTIMEZONE\r\nTZID:Asia/Shanghai\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:u7\r\nSUMMARY:有参与人的会\r\nDTSTART:20261012T140000\r\nATTENDEE:mailto:a@b.c\r\nORGANIZER:mailto:d@e.f\r\nEXDATE:20261019T140000\r\nRECURRENCE-ID:20261013T140000\r\nEND:VEVENT\r\nEND:VCALENDAR");
        assert_eq!(ev.summary, "有参与人的会");
        assert_eq!(ev.start, Some(d(2026, 10, 12, 14, 0)));
    }

    #[test]
    fn unfolds_folded_lines() {
        let folded = "BEGIN:VEVENT\r\nUID:u8\r\nSUMMARY:这是一条很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长\r\n 很长的标题\r\nDTSTART:20261012T140000\r\nEND:VEVENT";
        let ev = one(folded);
        assert!(ev.summary.ends_with("很长的标题"), "续行要拼回原值：{}", ev.summary);
        assert!(!ev.summary.starts_with(' '), "只去掉一个前导空格，其余保留");
    }

    #[test]
    fn escapes_and_unescapes_text() {
        let src = IcsEvent {
            uid: "u9".into(),
            summary: "评审; 需要\\准备, 两行\n第二行".into(),
            start: Some(d(2026, 10, 12, 9, 0)),
            status: "busy".into(),
            ..Default::default()
        };
        let text = render(std::slice::from_ref(&src), "20261012T000000Z");
        assert!(text.contains("SUMMARY:评审\\; 需要\\\\准备\\, 两行\\n第二行"), "{text}");
        let back = one(&text);
        assert_eq!(back.summary, src.summary, "转义必须可逆");
    }

    #[test]
    fn folds_at_75_bytes_without_splitting_utf8() {
        let long = format!("SUMMARY:{}", "汉字".repeat(60));
        let physical = fold(&long);
        for line in physical.split("\r\n") {
            assert!(line.len() <= MAX_LINE_OCTETS, "物理行 {} 字节超了", line.len());
            assert!(std::str::from_utf8(line.as_bytes()).is_ok(), "折行不能切断字符");
        }
        assert!(physical.contains("\r\n "), "应发生折行");
        assert_eq!(physical.replace("\r\n ", ""), long, "折行不能改内容");
    }

    #[test]
    fn roundtrip_is_stable() {
        let src = IcsEvent {
            uid: "uid-1".into(),
            summary: "晨读".into(),
            description: Some("第 12 章".into()),
            location: Some("图书馆".into()),
            start: Some(d(2026, 10, 12, 7, 30)),
            end: Some(d(2026, 10, 12, 8, 0)),
            all_day: false,
            status: "free".into(),
            repeat_rule: Some("every:2week".into()),
            repeat_until: Some("2026-12-31 23:59".into()),
            alarms: vec![1440, 10],
        };
        let once = render(&[src.clone()], "20261012T000000Z");
        let parsed = one(&once);
        assert_eq!(parsed, src, "导出→导入必须回到同一条");
        let twice = render(&[parsed], "20261012T000000Z");
        assert_eq!(once, twice, "第二次导出应逐字节相同");
    }

    #[test]
    fn renders_all_day_and_count_rule() {
        let src = IcsEvent {
            uid: "uid-2".into(),
            summary: "假期".into(),
            start: Some(d(2026, 10, 1, 0, 0)),
            end: Some(d(2026, 10, 7, 0, 0)),
            all_day: true,
            status: "busy".into(),
            repeat_rule: Some("every:1day".into()),
            repeat_until: Some("count:3".into()),
            alarms: vec![0, 1440],
            ..Default::default()
        };
        let text = render(&[src], "20261012T000000Z");
        assert!(text.contains("DTSTART;VALUE=DATE:20261001"));
        assert!(text.contains("DTEND;VALUE=DATE:20261008"), "全天 DTEND 不含端点：{text}");
        assert!(text.contains("RRULE:FREQ=DAILY;COUNT=3"), "INTERVAL=1 不必写出来：{text}");
        assert!(text.contains("TRIGGER:-PT0M"), "准时提醒：{text}");
        assert!(text.contains("TRIGGER:-P1D"), "整天用 PnD：{text}");
    }

    #[test]
    fn drops_empty_events_and_keeps_order() {
        let text = "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:第一条\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:c\r\nSUMMARY:第三条\r\nDTSTART:20261012T100000\r\nEND:VEVENT";
        let v = parse(text);
        let uids: Vec<&str> = v.iter().map(|e| e.uid.as_str()).collect();
        assert_eq!(uids, vec!["a", "c"], "空标题且无时间的块丢掉，其余保序");
    }
}
