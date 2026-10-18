//! 搜索词整形：把用户输入里**不属于索引语法**的控制词剥掉，剩下的原样交给后端。
//!
//! 迁移前这套逻辑在 `find.py::_scan`。它只做三件事：
//!   1. `desc <字段>` / `asc <字段>` → Everything 的 sort code（低 16 位字段 + 0x8000_0000 降序位）；
//!   2. `limit N` → 条数（夹到 `[1, MAX_LIMIT]`）；
//!   3. 首个 token 若是 `recent/open/dir/where` 这个 Action 子命令，从搜索词里摘掉。
//!
//! 判定依据只能是「参数是否合法」——字段名（`size`/`dm`）完全可能就是用户想搜的词，
//! 所以 `desc zzzz` 里的 `desc` 必须原样保留。这条规则有几个静默失败的变体，
//! 单测逐个钉住（见文件末尾）。

use crate::MAX_LIMIT;

/// 排序字段别名 → Everything sort code（与迁移前 `SORT_ALIASES` 逐项一致）
pub const SORT_ALIASES: [(&str, u32); 8] = [
    ("name", 1),
    ("path", 2),
    ("size", 3),
    ("ext", 4),
    ("type", 5),
    ("dm", 11),
    ("dc", 12),
    ("da", 13),
];

/// 降序位（Everything sort code 的高位）
pub const SORT_DESC_FLAG: u32 = 0x8000_0000;

/// 首个 token 位置的 Action 子命令：不是搜索词
const LEADING_ACTIONS: [&str; 4] = ["recent", "open", "dir", "where"];

fn sort_code(field: &str) -> Option<u32> {
    SORT_ALIASES
        .iter()
        .find(|(alias, _)| *alias == field)
        .map(|(_, code)| *code)
}

fn as_limit(token: &str) -> Option<usize> {
    // 只认纯十进制正整数：`-5`（tokenizer 会把它当 flag）与 `abc` 都退回搜索词
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: usize = token.parse().ok()?;
    Some(n.clamp(1, MAX_LIMIT))
}

/// 扫一遍：返回（保留的搜索词, sort code, limit）。
///
/// `limit` 为 `None` 表示用户没写或写错；调用方用 `DEFAULT_LIMIT` 兜底。
pub fn scan(tokens: &[String]) -> (Vec<String>, Option<u32>, Option<usize>) {
    let mut kept = Vec::new();
    let mut sort = None;
    let mut limit = None;
    let mut i = 0;
    while i < tokens.len() {
        let low = tokens[i].to_lowercase();
        // desc / asc 只有后面跟合法字段时才成立
        if (low == "desc" || low == "asc") && i + 1 < tokens.len() {
            if let Some(code) = sort_code(&tokens[i + 1].to_lowercase()) {
                sort = Some(code | if low == "desc" { SORT_DESC_FLAG } else { 0 });
                i += 2;
                continue;
            }
            kept.push(tokens[i].clone());
            i += 1;
            continue;
        }
        if low == "limit" && i + 1 < tokens.len() {
            if let Some(n) = as_limit(&tokens[i + 1]) {
                limit = Some(n);
                i += 2;
                continue;
            }
        }
        // 首个子命令是 Action，不进搜索词
        if i == 0 && LEADING_ACTIONS.contains(&low.as_str()) {
            i += 1;
            continue;
        }
        kept.push(tokens[i].clone());
        i += 1;
    }
    (kept, sort, limit)
}

fn tokens_of(text: &str) -> Vec<String> {
    text.split_whitespace().map(String::from).collect()
}

/// 搜索词（已剥控制词）。`keyword` 是壳层给的 queryText（trigger 之后整串）。
pub fn parse_term(keyword: &str) -> String {
    let (kept, _, _) = scan(&tokens_of(keyword));
    kept.join(" ")
}

/// 排序：keyword 是整串输入，args 里可能还有子命令后的残留（补扫一次不会重复剥离）。
pub fn resolve_sort(keyword: &str, args: &[String]) -> Option<u32> {
    let mut tokens = tokens_of(keyword);
    tokens.extend(args.iter().cloned());
    scan(&tokens).1
}

/// 条数：同上，没写或不合法时用默认值。
pub fn resolve_limit(keyword: &str, args: &[String], default: usize) -> usize {
    let mut tokens = tokens_of(keyword);
    tokens.extend(args.iter().cloned());
    scan(&tokens).2.unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DEFAULT_LIMIT, MAX_LIMIT};

    fn term(kw: &str) -> String {
        parse_term(kw)
    }

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn plain_terms_pass_through() {
        assert_eq!(term("Cargo.toml"), "Cargo.toml");
        // 索引语法原样保留：Everything 自己认识 ext:/size:/dm:
        assert_eq!(term("ext:rs clippy"), "ext:rs clippy");
    }

    #[test]
    fn desc_sort_is_stripped() {
        assert_eq!(term("size:>1gb desc size"), "size:>1gb");
        assert_eq!(term("report.md desc dm"), "report.md");
        assert_eq!(term("x asc name"), "x");
    }

    #[test]
    fn sort_before_term_is_recognised() {
        assert_eq!(term("desc dm report.md"), "report.md");
    }

    #[test]
    fn limit_is_stripped_and_clamped() {
        assert_eq!(term("rs limit 3"), "rs");
        assert_eq!(resolve_limit("rs limit 3", &[], DEFAULT_LIMIT), 3);
        assert_eq!(resolve_limit("x limit 9999", &[], DEFAULT_LIMIT), MAX_LIMIT);
        assert_eq!(resolve_limit("x limit 0", &[], DEFAULT_LIMIT), 1);
        // 负数不是合法 limit（tokenizer 会把 -5 当 flag），此时 limit 当搜索词
        assert_eq!(resolve_limit("x limit -5", &[], DEFAULT_LIMIT), DEFAULT_LIMIT);
        assert_eq!(term("x limit -5"), "x limit -5");
    }

    #[test]
    fn field_names_survive_as_search_terms() {
        // `size.md` 是要搜的文件名，不是控制词
        assert_eq!(term("size.md"), "size.md");
        assert_eq!(term("dm"), "dm");
        assert_eq!(term("limit"), "limit");
        assert_eq!(term("limit abc"), "limit abc");
        assert_eq!(resolve_limit("limit abc", &["abc".into()], DEFAULT_LIMIT), DEFAULT_LIMIT);
    }

    #[test]
    fn desc_without_valid_field_stays_a_term() {
        assert_eq!(term("desc"), "desc");
        assert_eq!(resolve_sort("desc", &[]), None);
        assert_eq!(term("x desc zzzz"), "x desc zzzz");
        assert_eq!(resolve_sort("x desc zzzz", &[]), None);
    }

    #[test]
    fn leading_action_is_stripped() {
        assert_eq!(term("recent"), "");
        assert_eq!(term("dir D:/codes"), "D:/codes");
        // 只有首个 token 才算子命令：后面的 dir 是搜索词
        assert_eq!(term("codes dir"), "codes dir");
    }

    #[test]
    fn alias_codes_match_everything_sdk() {
        assert_eq!(resolve_sort("x desc size", &[]), Some(3 | SORT_DESC_FLAG));
        assert_eq!(resolve_sort("x asc size", &[]), Some(3));
        assert_eq!(resolve_sort("x desc dm", &[]), Some(11 | SORT_DESC_FLAG));
        assert_eq!(resolve_sort("x desc name", &[]), Some(1 | SORT_DESC_FLAG));
        assert_eq!(resolve_sort("x asc name", &[]), Some(1));
        assert_eq!(resolve_sort("x", &[]), None);
    }

    #[test]
    fn combined_expression() {
        let kw = "*.iso size:>1gb desc size limit 5";
        assert_eq!(term(kw), "*.iso size:>1gb");
        assert_eq!(resolve_sort(kw, &[]), Some(3 | SORT_DESC_FLAG));
        assert_eq!(resolve_limit(kw, &[], DEFAULT_LIMIT), 5);
    }

    #[test]
    fn args_are_scanned_too() {
        // subcommand 被壳层从 args 里挖走后，剩余 token 仍可能带控制词
        assert_eq!(resolve_limit("x", &args(&["limit", "7"][..2]), DEFAULT_LIMIT), 7);
    }
}
