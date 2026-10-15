//! 重复规则解析与区间展开：日历视图与提醒调度共用同一套推进语义。
//!
//! 时间存储沿用 todo 的本地裸串约定 `YYYY-MM-DD HH:MM`（无时区），
//! 因此这里一律用 NaiveDateTime——不引入 chrono-tz，也不做夏令时换算。

use chrono::{Duration, Months, NaiveDateTime};

/// 重复展开出的一个日程实例
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Occurrence {
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
}

impl Occurrence {
    /// 规范起始串，用作 alarm_fires 的 occ_key
    pub fn key(&self) -> String {
        self.start.format("%Y-%m-%d %H:%M").to_string()
    }
}

/// 解析重复规则为 (间隔数, 单位)，单位: i=分钟 h=小时 d=天 w=周 m=月 y=年
pub fn parse_repeat_rule(raw: &str) -> Option<(u32, char)> {
    let raw = raw.trim().to_lowercase();
    if raw.is_empty() {
        return None;
    }

    match raw.as_str() {
        "daily" => return Some((1, 'd')),
        "weekly" => return Some((1, 'w')),
        "monthly" => return Some((1, 'm')),
        "yearly" | "annually" => return Some((1, 'y')),
        "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" => return Some((1, 'w')),
        _ => {}
    }

    let rest = raw
        .strip_prefix("every:")
        .or_else(|| raw.strip_prefix("repeat:"))?;
    let split = rest.find(|c: char| !c.is_ascii_digit())?;
    let n: u32 = rest[..split].parse().ok()?;
    if n == 0 || n > 999 {
        return None;
    }
    let unit = match &rest[split..] {
        "min" | "mins" | "minute" | "minutes" => 'i',
        "h" | "hour" | "hours" => 'h',
        "d" | "day" | "days" => 'd',
        "w" | "week" | "weeks" => 'w',
        "mo" | "month" | "months" | "m" => 'm',
        "y" | "year" | "years" => 'y',
        _ => return None,
    };
    Some((n, unit))
}

/// 规范化重复规则为标准存储格式 `every:{n}{min|hour|day|week|month|year}`
pub fn canonical_repeat_rule(raw: &str) -> Option<String> {
    parse_repeat_rule(raw).map(|(n, unit)| {
        let unit = match unit {
            'i' => "min",
            'h' => "hour",
            'd' => "day",
            'w' => "week",
            'y' => "year",
            _ => "month",
        };
        format!("every:{}{}", n, unit)
    })
}

/// 第 i 次实例的起始时刻（i 从 0 起）。
///
/// **必须相对原始锚点算，不能在上一条结果上继续加**：1-31 每月重复时，
/// `2026-01-31 +1month = 02-28` 之后再 `+1month` 会漂成 `03-28`，"31 号"这个
/// 语义被永久吃掉。锚点相对推算则每次独立钳位，得到 RFC 5545 期望的
/// 01-31 / 02-28 / 03-31 / 04-30。
fn nth(anchor: NaiveDateTime, i: u64, n: u32, unit: char) -> Option<NaiveDateTime> {
    match unit {
        'm' => anchor.checked_add_months(Months::new(n.checked_mul(i as u32)?)),
        'y' => anchor.checked_add_months(Months::new(n.checked_mul(12)?.checked_mul(i as u32)?)),
        'i' => anchor.checked_add_signed(Duration::minutes(n as i64 * i as i64)),
        'h' => anchor.checked_add_signed(Duration::hours(n as i64 * i as i64)),
        'd' => anchor.checked_add_signed(Duration::days(n as i64 * i as i64)),
        'w' => anchor.checked_add_signed(Duration::weeks(n as i64 * i as i64)),
        _ => None,
    }
}

/// 固定步长单位的分钟数；月/年返回 None（变长，只能按 nth 逐次钳位）
fn fixed_step_minutes(n: u32, unit: char) -> Option<i64> {
    Some(match unit {
        'i' => n as i64,
        'h' => n as i64 * 60,
        'd' => n as i64 * 1440,
        'w' => n as i64 * 10080,
        _ => return None,
    })
}

/// `repeat_until` 的两种形态：`count:N`（含首次，共 N 次）与 `YYYY-MM-DD HH:MM`（截止时刻）
enum Bound {
    None,
    Count(u32),
    Until(NaiveDateTime),
}

fn parse_bound(raw: Option<&str>) -> Bound {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Bound::None;
    };
    if let Some(n) = raw.strip_prefix("count:") {
        return match n.trim().parse::<u32>() {
            Ok(n) if n > 0 => Bound::Count(n),
            _ => Bound::None,
        };
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M") {
        return Bound::Until(dt);
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        // 只给日期 → 覆盖到当天结束
        if let Some(dt) = date.and_hms_opt(23, 59, 0) {
            return Bound::Until(dt);
        }
    }
    Bound::None
}

/// 输出上限。`every:1min` 铺满一个月是 4 万多个实例，宁可截断也不要
/// 让一次日历查询把主线程打满——返回的 truncated 标志由调用方提示用户。
pub const MAX_INSTANCES: usize = 5000;

/// 展开 `[from, to]` 内的全部实例；`dur_min` 为单次时长（分钟，<=0 视为零时长）。
///
/// 固定步长单位（分/时/天/周）按 `(from - dur - anchor) / interval` 直接快进到
/// 视区边缘，因此二十年前的每日重复事件查本月也只算几十步；月/年步长变长，
/// 由 `nth` 按序号一次算到位。
pub fn expand_range(
    anchor: NaiveDateTime,
    dur_min: i64,
    rule: Option<&str>,
    until: Option<&str>,
    from: NaiveDateTime,
    to: NaiveDateTime,
) -> (Vec<Occurrence>, bool) {
    let dur = Duration::minutes(dur_min.clamp(0, 5 * 365 * 1440));
    let Some((n, unit)) = rule.and_then(parse_repeat_rule) else {
        let end = anchor + dur;
        if end >= from && anchor <= to {
            return (vec![Occurrence { start: anchor, end }], false);
        }
        return (vec![], false);
    };

    let bound = parse_bound(until);

    // 快进：直接算出"结束时刻仍不早于 from"的第一个实例序号
    let mut idx: u64 = 0;
    if let Some(step_min) = fixed_step_minutes(n, unit) {
        if let Some(target) = from.checked_sub_signed(dur) {
            if target > anchor {
                let delta = target.signed_duration_since(anchor).num_minutes();
                let skip = (delta / step_min).max(0) as u64;
                if let Bound::Count(cap) = bound {
                    if skip >= cap as u64 {
                        return (vec![], false);
                    }
                }
                idx = skip;
            }
        }
    }

    let mut out = Vec::new();
    let mut truncated = false;
    loop {
        let Some(t) = nth(anchor, idx, n, unit) else {
            break;
        };
        if let Bound::Count(cap) = bound {
            if idx >= cap as u64 {
                break;
            }
        }
        if let Bound::Until(limit) = bound {
            if t > limit {
                break;
            }
        }
        if t > to {
            break;
        }
        let end = t + dur;
        if end >= from {
            if out.len() >= MAX_INSTANCES {
                truncated = true;
                break;
            }
            out.push(Occurrence { start: t, end });
        }
        idx += 1;
    }
    (out, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn dt(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        chrono::Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .unwrap()
            .naive_local()
    }

    #[test]
    fn non_repeating_yields_single_intersection() {
        let (v, tr) = expand_range(
            dt(2026, 10, 15, 14, 0),
            60,
            None,
            None,
            dt(2026, 10, 1, 0, 0),
            dt(2026, 10, 31, 23, 59),
        );
        assert_eq!(v.len(), 1);
        assert!(!tr);
        // 视区之外 → 空
        let (v2, _) = expand_range(
            dt(2026, 12, 25, 9, 0),
            60,
            None,
            None,
            dt(2026, 10, 1, 0, 0),
            dt(2026, 10, 31, 23, 59),
        );
        assert!(v2.is_empty());
    }

    #[test]
    fn expanding_daily_covers_whole_month() {
        let (v, _) = expand_range(
            dt(2026, 10, 10, 9, 0),
            60,
            Some("every:1day"),
            None,
            dt(2026, 10, 1, 0, 0),
            dt(2026, 10, 31, 23, 59),
        );
        assert_eq!(v.len(), 22); // 10-10 .. 10-31
        assert_eq!(v[0].start.to_string(), "2026-10-10 09:00:00");
        assert_eq!(v.last().unwrap().start.to_string(), "2026-10-31 09:00:00");
    }

    #[test]
    fn fast_forward_matches_full_expansion() {
        // 快进是这条路径上唯一的"聪明"优化，必须证明它与老老实实全量展开再筛一致。
        // 用例实例数都要低于 MAX_INSTANCES，否则参照侧自己被截断，比对无意义。
        let from = dt(2026, 10, 12, 0, 0);
        let to = dt(2026, 10, 18, 23, 59);
        for (anchor, dur, rule) in [
            (dt(2020, 3, 15, 8, 30), 45, "every:1day"),
            (dt(2021, 6, 1, 0, 0), 120, "every:2week"),
            (dt(2019, 11, 30, 23, 0), 60, "every:1month"),
            (dt(2000, 2, 29, 12, 0), 30, "every:1year"),
            (dt(2026, 9, 1, 6, 0), 30, "every:2hour"),
        ] {
            let (all, _) = expand_range(anchor, dur, Some(rule), None, anchor, to);
            let expected: Vec<String> = all
                .iter()
                .filter(|o| o.end >= from && o.start <= to)
                .map(Occurrence::key)
                .collect();
            let (windowed, _) = expand_range(anchor, dur, Some(rule), None, from, to);
            let keys: Vec<String> = windowed.iter().map(Occurrence::key).collect();
            assert_eq!(keys, expected, "rule={}", rule);
        }
    }

    #[test]
    fn monthly_anchor_carries_safely_at_month_end() {
        // 1-31 逐月推进：2 月落到 28 号，3 月回到 31 号（chrono 的月末安全进位）
        let (v, _) = expand_range(
            dt(2026, 1, 31, 9, 0),
            60,
            Some("every:1month"),
            None,
            dt(2026, 1, 1, 0, 0),
            dt(2026, 6, 30, 23, 59),
        );
        let days: Vec<String> = v
            .iter()
            .map(|o| o.start.format("%Y-%m-%d").to_string())
            .collect();
        assert_eq!(
            days,
            vec![
                "2026-01-31",
                "2026-02-28",
                "2026-03-31",
                "2026-04-30",
                "2026-05-31",
                "2026-06-30"
            ]
        );
    }

    #[test]
    fn count_and_until_bounds() {
        let (v, _) = expand_range(
            dt(2026, 10, 1, 8, 0),
            30,
            Some("every:1day"),
            Some("count:3"),
            dt(2026, 10, 1, 0, 0),
            dt(2026, 12, 31, 0, 0),
        );
        assert_eq!(v.len(), 3);
        let (v2, _) = expand_range(
            dt(2026, 10, 1, 8, 0),
            30,
            Some("every:1day"),
            Some("2026-10-05"),
            dt(2026, 10, 1, 0, 0),
            dt(2026, 12, 31, 0, 0),
        );
        assert_eq!(v2.len(), 5); // 10-01..10-05
    }

    #[test]
    fn fast_forward_skips_years_of_daily_events() {
        // 2000 年起的每日重复，查 2026-10 这一周：结果只覆盖视区，且第一步就落在视区边缘
        let (v, _) = expand_range(
            dt(2000, 1, 1, 7, 0),
            60,
            Some("every:1day"),
            None,
            dt(2026, 10, 12, 0, 0),
            dt(2026, 10, 18, 23, 59),
        );
        assert_eq!(v.len(), 7);
        assert_eq!(v[0].start.to_string(), "2026-10-12 07:00:00");
        assert_eq!(v.last().unwrap().start.to_string(), "2026-10-18 07:00:00");
    }

    #[test]
    fn fast_forward_honours_count_limit() {
        // count:10 只允许前 10 次（2000-01-01..01-10），2026 年的视区内一个都没有
        let (v, _) = expand_range(
            dt(2000, 1, 1, 7, 0),
            60,
            Some("every:1day"),
            Some("count:10"),
            dt(2026, 10, 1, 0, 0),
            dt(2026, 10, 31, 23, 59),
        );
        assert!(v.is_empty());
    }

    #[test]
    fn multi_day_event_intersects_from_the_left() {
        // 跨天事件：起始在视区之前但结束在视区内，必须出现
        let (v, _) = expand_range(
            dt(2026, 10, 8, 20, 0),
            2000,
            Some("every:1week"),
            None,
            dt(2026, 10, 10, 0, 0),
            dt(2026, 10, 16, 23, 59),
        );
        assert!(!v.is_empty());
        assert!(v[0].start < dt(2026, 10, 10, 0, 0));
        assert!(v[0].end >= dt(2026, 10, 10, 0, 0));
    }

    #[test]
    fn instance_cap_reports_truncation() {
        // every:1min 铺满一年 = 52 万个实例，应在 MAX_INSTANCES 处截断
        let (_v, truncated) = expand_range(
            dt(2026, 1, 1, 0, 0),
            1,
            Some("every:1min"),
            None,
            dt(2026, 1, 1, 0, 0),
            dt(2026, 12, 31, 23, 59),
        );
        assert!(truncated);
    }

    #[test]
    fn yearly_rule_advances_by_twelve_months() {
        let (v, _) = expand_range(
            dt(2020, 2, 29, 9, 0),
            60,
            Some("every:1year"),
            None,
            dt(2026, 1, 1, 0, 0),
            dt(2027, 12, 31, 0, 0),
        );
        let days: Vec<String> = v
            .iter()
            .map(|o| o.start.format("%Y-%m-%d").to_string())
            .collect();
        assert_eq!(days, vec!["2026-02-28", "2027-02-28"]);
    }

    #[test]
    fn occurrence_key_is_canonical() {
        let (v, _) = expand_range(
            dt(2026, 10, 15, 14, 30),
            60,
            None,
            None,
            dt(2026, 10, 1, 0, 0),
            dt(2026, 10, 31, 23, 59),
        );
        assert_eq!(v[0].key(), "2026-10-15 14:30");
    }

    #[test]
    fn repeat_rule_supports_year_and_month_aliases() {
        assert_eq!(parse_repeat_rule("yearly"), Some((1, 'y')));
        assert_eq!(parse_repeat_rule("every:2years"), Some((2, 'y')));
        assert_eq!(parse_repeat_rule("monthly"), Some((1, 'm')));
        assert_eq!(
            canonical_repeat_rule("every:2y").as_deref(),
            Some("every:2year")
        );
        assert_eq!(
            canonical_repeat_rule("daily").as_deref(),
            Some("every:1day")
        );
    }
}
