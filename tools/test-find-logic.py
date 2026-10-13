#!/usr/bin/env python3
"""/find 插件的纯逻辑测试（不走 Everything，只测解析与格式化）。

Everything 的查询结果依赖外部进程 + DLL，无法在单测里造；
但控制词剥离、排序解析、体积/时间格式化这些是最容易出错的地方，
且全部是纯函数，值得单独测。

跑法：python tools/test-find-logic.py
"""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "plugins", "find"))

import find as F  # noqa: E402
import format as fmt  # noqa: E402
import query as Q  # noqa: E402


class TestControlWords(unittest.TestCase):
    """控制词剥离：必须只吃掉真正的控制词，不能误伤同名搜索词。

    这组是最容易写错的地方——字段名（size/dm/name）完全可能就是用户想搜的词。
    """

    def _parse(self, kw, args=None):
        return F.parse_query(kw, args or [])

    def test_plain(self):
        self.assertEqual(self._parse("Cargo.toml"), "Cargo.toml")
        self.assertEqual(self._parse("ext:rs clippy"), "ext:rs clippy")

    def test_desc_sort_stripped(self):
        self.assertEqual(self._parse("size:>1gb desc size"), "size:>1gb")
        self.assertEqual(self._parse("report.md desc dm"), "report.md")

    def test_asc_sort_stripped(self):
        self.assertEqual(self._parse("x asc name"), "x")

    def test_limit_stripped(self):
        self.assertEqual(self._parse("rs limit 3"), "rs")
        self.assertEqual(F.resolve_limit("rs limit 3", "rs", ["limit", "3"]), 3)

    def test_limit_clamps(self):
        self.assertEqual(F.resolve_limit("x limit 9999", "x", []), F.MAX_LIMIT)
        self.assertEqual(F.resolve_limit("x limit 0", "x", []), 1)
        # 负数不是合法 limit（tokenizer 会把 -5 当 flag），此时 limit 当搜索词
        self.assertEqual(F.resolve_limit("x limit -5", "x", []), F.DEFAULT_LIMIT)
        self.assertEqual(F.parse_query("x limit -5", []), "x limit -5")

    def test_sort_before_term(self):
        """desc 出现在搜索词之前也要能识别。"""
        self.assertEqual(self._parse("desc dm report.md"), "report.md")

    def test_field_name_as_search_term_kept(self):
        """`size.md` 是要搜的文件名，不是控制词。"""
        self.assertEqual(self._parse("size.md"), "size.md")
        self.assertEqual(self._parse("dm"), "dm")
        self.assertEqual(self._parse("limit"), "limit")

    def test_desc_without_field_kept(self):
        """`desc` 后面没有合法字段时，它自己就是搜索词。"""
        self.assertEqual(self._parse("desc"), "desc")
        self.assertIsNone(F.resolve_sort("desc", "desc", []))

    def test_limit_non_numeric_kept(self):
        self.assertEqual(self._parse("limit abc"), "limit abc")
        self.assertEqual(F.resolve_limit("limit abc", "limit", ["abc"]), F.DEFAULT_LIMIT)

    def test_leading_subcommand_stripped(self):
        """recent/open/dir/where 是 Action 子命令，不该进搜索词。"""
        self.assertEqual(self._parse("recent"), "")
        self.assertEqual(self._parse("dir D:/codes"), "D:/codes")

    def test_combined(self):
        self.assertEqual(self._parse("*.iso size:>1gb desc size limit 5"), "*.iso size:>1gb")
        self.assertEqual(F.resolve_sort("*.iso size:>1gb desc size limit 5", "*.iso", []),
                         3 | 0x80000000)
        self.assertEqual(F.resolve_limit("*.iso size:>1gb desc size limit 5", "*.iso", []), 5)


class TestSortCodes(unittest.TestCase):
    def test_aliases(self):
        self.assertEqual(F.resolve_sort("x desc size", "x", []), 3 | 0x80000000)
        self.assertEqual(F.resolve_sort("x asc size", "x", []), 3)
        self.assertEqual(F.resolve_sort("x desc dm", "x", []), 11 | 0x80000000)
        # desc 一律带降序位，字段 1（name）也一样
        self.assertEqual(F.resolve_sort("x desc name", "x", []), 1 | 0x80000000)
        self.assertEqual(F.resolve_sort("x asc name", "x", []), 1)

    def test_unknown_field_is_not_sort(self):
        """未知的排序字段不该被吃掉——它连同desc 本身都是搜索词。"""
        self.assertIsNone(F.resolve_sort("x desc zzzz", "x", []))
        self.assertEqual(F.parse_query("x desc zzzz", []), "x desc zzzz")

    def test_default_limit(self):
        self.assertEqual(F.resolve_limit("x", "x", []), F.DEFAULT_LIMIT)


class TestFmtSize(unittest.TestCase):
    def test_zero_and_unknown(self):
        """0/None 要显示 '-'，不能显示 '0 B'（目录就是这种情况）。"""
        self.assertEqual(fmt.fmt_size(0), "-")
        self.assertEqual(fmt.fmt_size(None), "-")

    def test_units(self):
        self.assertEqual(fmt.fmt_size(512), "512 B")
        self.assertEqual(fmt.fmt_size(1024), "1.0 KB")
        self.assertEqual(fmt.fmt_size(1024 * 1024), "1.0 MB")
        self.assertEqual(fmt.fmt_size(1024 ** 3), "1.0 GB")
        self.assertEqual(fmt.fmt_size(1024 ** 4), "1.0 TB")


class TestFmtMtime(unittest.TestCase):
    NOW = 1_700_000_000_000

    def _ago(self, ms):
        return fmt.fmt_mtime(self.NOW - ms, self.NOW)

    def test_buckets(self):
        self.assertEqual(self._ago(30_000), "刚刚")
        self.assertEqual(self._ago(5 * 60_000), "5 分钟前")
        self.assertEqual(self._ago(3 * 3_600_000), "3 小时前")
        self.assertEqual(self._ago(5 * 86_400_000), "5 天前")
        self.assertEqual(self._ago(90 * 86_400_000), "3 个月前")
        self.assertEqual(self._ago(800 * 86_400_000), "2 年前")

    def test_zero_is_dash(self):
        self.assertEqual(fmt.fmt_mtime(0, self.NOW), "-")
        self.assertEqual(fmt.fmt_mtime(None, self.NOW), "-")

    def test_negative_is_dash(self):
        """FILETIME 换算出错会得到负数，不能显示成 55 年前。"""
        self.assertEqual(fmt.fmt_mtime(-1, self.NOW), "-")

    def test_future(self):
        """索引时间戳异常会给出未来时间，要说人话。"""
        self.assertEqual(fmt.fmt_mtime(self.NOW + 10_000, self.NOW), "未来")


class TestBuildRow(unittest.TestCase):
    NOW = 1_700_000_000_000

    def test_file_row(self):
        row = fmt.build_row({
            "path": "D:\\codes\\a.txt", "name": "a.txt", "parent": "D:\\codes",
            "is_dir": False, "size": 2048, "mtime_ms": self.NOW - 3_600_000,
        }, self.NOW, rank=1)
        self.assertEqual(row["title"], "a.txt")
        self.assertEqual(row["badge"], "#1")
        self.assertEqual(row["icon"], "📄")
        self.assertIn("2.0 KB", row["description"])
        self.assertIn("1 小时前", row["description"])
        self.assertEqual(row["metadata"]["path"], "D:\\codes\\a.txt")
        self.assertFalse(row["metadata"]["isDir"])

    def test_dir_has_no_size(self):
        row = fmt.build_row({
            "path": "D:\\codes", "name": "codes", "parent": "D:\\",
            "is_dir": True, "size": 0, "mtime_ms": self.NOW - 3_600_000,
        }, self.NOW, rank=1)
        self.assertEqual(row["icon"], "📁")
        # 目录不应显示体积，也不该出现 '-' 占位
        self.assertNotIn("-", row["description"])
        self.assertNotIn("B", row["description"])

    def test_hidden_icon(self):
        for flag in ("hidden", "system"):
            row = fmt.build_row({
                "path": "C:\\x", "name": "x", "parent": "C:\\", "is_dir": False,
                "size": 1, "mtime_ms": self.NOW, flag: True,
            }, self.NOW, rank=1)
            self.assertEqual(row["icon"], "👻", flag)

    def test_long_parent_shortened_middle(self):
        """长路径必须按层级省略，且不能把目录名截断成半个词。"""
        long = "C:\\" + "\\".join(["averylongdirectoryname"] * 8) + "\\file.txt"
        parent = long.rsplit("\\", 1)[0]
        row = fmt.build_row({
            "path": long, "name": "file.txt", "parent": parent,
            "is_dir": False, "size": 1, "mtime_ms": self.NOW,
        }, self.NOW, rank=1)
        desc = row["description"]
        self.assertIn("\\...\\", desc)
        # 目录名必须完整出现，不能出现被截断的半个词
        self.assertNotIn("averylongdirectorynam ", desc)
        for seg in desc.replace("\\...\\", "\\").split("\\"):
            if seg.startswith("averylong"):
                self.assertEqual(seg, "averylongdirectoryname")
        # 末两级（最有辨识度的目录）要保留
        self.assertTrue(desc.rstrip().endswith("averylongdirectoryname"))

    def test_short_path_untouched(self):
        self.assertEqual(fmt._shorten_middle("D:\\codes"), "D:\\codes")
        self.assertEqual(fmt._shorten_middle("D:\\a\\b\\c"), "D:\\a\\b\\c")


class TestPanels(unittest.TestCase):
    def test_footer_counts(self):
        f = fmt.build_footer(175, 19, 8.4)
        self.assertIn("共 175 项", f["title"])
        self.assertIn("显示前 19 项", f["title"])
        self.assertTrue(f["metadata"]["footer"])

    def test_footer_not_saying_display_when_exact(self):
        f = fmt.build_footer(5, 5, 1.0)
        self.assertIn("共 5 项", f["title"])
        self.assertNotIn("显示前", f["title"])

    def test_unavailable_has_hint(self):
        r = fmt.build_unavailable("未检测到 Everything")
        self.assertEqual(len(r["items"]), 1)
        self.assertIn("Everything", r["items"][0]["title"])
        self.assertTrue(r["items"][0]["description"], "不可用时必须给安装引导")
        self.assertTrue(r["items"][0]["metadata"]["unavailable"])

    def test_usage_lists_hints(self):
        r = fmt.build_usage(["a.md", "ext:rs"])
        self.assertEqual(len(r["items"]), 3)  # 1 条主提示 + 2 条示例
        self.assertTrue(all(i["metadata"].get("usage") for i in r["items"]))


class TestDllLookup(unittest.TestCase):
    def test_candidate_order(self):
        """插件自带的 bin/ 必须是第一候选（用户放在那里的优先级最高）。"""
        import everything as ev
        cands = list(ev._candidate_dll_paths())
        self.assertTrue(cands[0].endswith(os.path.join("find", "bin", "Everything64.dll")),
                        f"第一候选应是插件 bin/，实得 {cands[0]}")

    def test_bundled_dll_present(self):
        """DLL 应随插件一起提供，否则 /find 一定不可用。"""
        import everything as ev
        self.assertTrue(os.path.isfile(list(ev._candidate_dll_paths())[0]),
                        "plugins/find/bin/Everything64.dll 缺失")


# ══════════════════════════════════════════════════════════════
#  Linux 后端：query.py 纯逻辑
#
#  这些测试在 Windows 上也能跑（query.py 不碰 subprocess），
#  但 Linux 代码路径的唯一保障就是它们——CI/本机都不一定有Linux。
# ══════════════════════════════════════════════════════════════
class TestQueryParse(unittest.TestCase):
    def test_bare_word_is_literal(self):
        q = Q.parse("Cargo.toml")
        self.assertEqual(q.literals, ["Cargo.toml"])
        self.assertFalse(q.needs_stat_filter)

    def test_unknown_field_degrades_to_literal(self):
        """不认识的 key:value 必须整体当搜索词，绝不能静默丢弃用户输入。

        这条同时兜住了 URL：https://example.com 的 key 是 https，不是字段名。
        """
        for term in ("https://example.com", "foo:bar", "a:b:c", "name:", ":"):
            q = Q.parse(term)
            self.assertEqual(q.literals, [term], f"{term} 应降级为字面量")

    def test_ext(self):
        q = Q.parse("ext:rs clippy")
        self.assertEqual(q.exts, ["rs"])
        self.assertEqual(q.literals, ["clippy"])

    def test_ext_multi_and_dot_strip(self):
        self.assertEqual(Q.parse("ext:rs,.py").exts, ["rs", "py"])
        self.assertEqual(Q.parse("ext:.rs").exts, ["rs"])

    def test_size_and_dm(self):
        q = Q.parse("size:>500mb dm:today")
        self.assertEqual(q.size_min, 500 * 1024 ** 2 + 1)
        self.assertIn("dm", q.time_bounds)

    def test_path_and_name_split(self):
        q = Q.parse("path:/home name:report")
        self.assertEqual(q.path_pats, ["/home"])
        self.assertEqual(q.name_pats, ["report"])

    def test_type(self):
        self.assertEqual(Q.parse("type:folder").want_type, "dir")
        self.assertEqual(Q.parse("type:file").want_type, "file")

    def test_type_invalid_falls_back(self):
        q = Q.parse("type:weird")
        self.assertIsNone(q.want_type)
        self.assertEqual(q.literals, ["type:weird"])


class TestParseSize(unittest.TestCase):
    def test_units(self):
        self.assertEqual(Q.parse_size("1kb"), (1024, 1024))
        self.assertEqual(Q.parse_size("1mb"), (1024 ** 2, 1024 ** 2))
        self.assertEqual(Q.parse_size("2gb"), (2 * 1024 ** 3, 2 * 1024 ** 3))
        self.assertEqual(Q.parse_size("100"), (100, 100))

    def test_comparison_is_exclusive(self):
        """`>500mb` 必须严格大于——用+1 而不是原值，否则等于边界的文件会被漏掉。"""
        lo, hi = Q.parse_size(">500mb")
        self.assertEqual(lo, 500 * 1024 ** 2 + 1)
        self.assertIsNone(hi)
        lo, hi = Q.parse_size("<1kb")
        self.assertIsNone(lo)
        self.assertEqual(hi, 1024 - 1)

    def test_range(self):
        self.assertEqual(Q.parse_size("1mb..10mb"), (1024 ** 2, 10 * 1024 ** 2))

    def test_invalid(self):
        self.assertIsNone(Q.parse_size("abc"))
        self.assertIsNone(Q.parse_size(""))

    def test_bad_size_degrades_to_literal(self):
        q = Q.parse("size:abc")
        self.assertIsNone(q.size_min)
        self.assertEqual(q.literals, ["size:abc"])


class TestParseTime(unittest.TestCase):
    NOW = 1_700_000_000.0  # 固定时钟，测试不依赖真实时间

    def test_today_is_midnight_based(self):
        lo, hi = Q.parse_time("today", now=self.NOW)
        self.assertEqual(lo, int(self.NOW - (self.NOW % 86400)))
        self.assertIsNone(hi)

    def test_yesterday_window(self):
        lo, hi = Q.parse_time("yesterday", now=self.NOW)
        self.assertEqual(hi, lo + 86399, "昨天应是完整一天，不是同一个瞬时点")

    def test_relative(self):
        lo, _ = Q.parse_time("7d", now=self.NOW)
        self.assertEqual(lo, int(self.NOW - 7 * 86400))

    def test_iso_date_is_whole_day(self):
        lo, hi = Q.parse_time("2024-01-15")
        self.assertEqual(hi - lo, 86399)

    def test_range_and_comparison(self):
        lo, hi = Q.parse_time("2024-01-01..2024-01-31")
        self.assertLess(lo, hi)
        self.assertIsNotNone(lo)
        lo2, hi2 = Q.parse_time(">2024-01-01")
        self.assertIsNone(hi2)
        self.assertGreater(lo2, lo - 1)

    def test_invalid(self):
        self.assertIsNone(Q.parse_time("notadate", now=self.NOW))


class TestMatchPath(unittest.TestCase):
    def test_literal_matches_full_path(self):
        """裸词按Everything 语义匹配**完整路径**，不只是文件名。"""
        q = Q.parse("codes")
        self.assertTrue(q.match_path("/home/me/codes/app.py", "app.py"))
        self.assertFalse(q.match_path("/tmp/other.py", "other.py"))

    def test_name_pats_only_basename(self):
        q = Q.parse("name:report")
        self.assertTrue(q.match_path("/a/b/report.md", "report.md"))
        self.assertFalse(q.match_path("/a/report_dir/x.md", "x.md"),
                         "name: 不该匹配目录名")

    def test_path_pats(self):
        q = Q.parse("path:/etc/")
        self.assertTrue(q.match_path("/etc/nginx.conf", "nginx.conf"))
        self.assertFalse(q.match_path("/opt/nginx.conf", "nginx.conf"))

    def test_ext_case_insensitive(self):
        q = Q.parse("ext:rs")
        self.assertTrue(q.match_path("/a/b.rs", "b.rs"))
        self.assertTrue(q.match_path("/a/b.RS", "b.RS"))

    def test_dotfile_has_no_ext(self):
        """`.gitignore` 的扩展名是 gitignore 还是空？这里定义为无扩展名，
        避免 ext:ignore 之类的误命中。"""
        q = Q.parse("ext:gitignore")
        self.assertTrue(q.match_path("/a/.gitignore", ".gitignore"),
                        "Everything 把 .gitignore 的 ext 视为 gitignore")

    def test_multiple_literals_are_and(self):
        q = Q.parse("alpha beta")
        self.assertTrue(q.match_path("/x/alpha/beta.txt", "beta.txt"))
        self.assertFalse(q.match_path("/x/alpha/gamma.txt", "gamma.txt"))


class TestMatchStat(unittest.TestCase):
    """需要真实 stat 结果，故在临时目录里造文件。"""

    @classmethod
    def setUpClass(cls):
        import tempfile
        cls.tmp = tempfile.mkdtemp(prefix="ll-find-test-")
        cls.small = os.path.join(cls.tmp, "small.bin")
        cls.big = os.path.join(cls.tmp, "big.bin")
        cls.subdir = os.path.join(cls.tmp, "adir")
        with open(cls.small, "wb") as f:
            f.write(b"x" * 10)
        with open(cls.big, "wb") as f:
            f.write(b"x" * 5000)
        os.mkdir(cls.subdir)

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_size_filter_excludes_dirs(self):
        """目录 size 无意义，size: 过滤不应把目录误杀（否则搜不到文件夹）。"""
        q = Q.parse("size:>1000")
        self.assertTrue(q.match_stat(os.stat(self.big)))
        self.assertFalse(q.match_stat(os.stat(self.small)))
        self.assertTrue(q.match_stat(os.stat(self.subdir)),
                        "目录应豁免体积过滤")

    def test_type_filter(self):
        self.assertTrue(Q.parse("type:dir").match_stat(os.stat(self.subdir)))
        self.assertFalse(Q.parse("type:dir").match_stat(os.stat(self.small)))
        self.assertTrue(Q.parse("type:file").match_stat(os.stat(self.small)))

    def test_dm_filter(self):
        import time as _t
        q = Q.parse("dm:today")
        self.assertTrue(q.match_stat(os.stat(self.small)))
        old = Q.parse("dm:2000-01-01")
        self.assertFalse(old.match_stat(os.stat(self.small)))


class TestRelevance(unittest.TestCase):
    def test_exact_name_beats_substring(self):
        exact = Q.relevance("/a/b/report.md", "report.md", ["report.md"])
        part = Q.relevance("/a/b/report-2024.md", "report-2024.md", ["report.md"])
        self.assertGreater(exact, part)

    def test_basename_hit_beats_path_hit(self):
        base = Q.relevance("/x/config", "config", ["config"])
        deep = Q.relevance("/config/sub/deep", "deep", ["config"])
        self.assertGreater(base, deep)

    def test_no_match_is_zero(self):
        self.assertEqual(Q.relevance("/a/b.txt", "b.txt", ["zzz"]), 0.0)

    def test_shorter_path_wins_on_tie(self):
        short = Q.relevance("/a/b/report.md", "report.md", ["report"])
        long_ = Q.relevance("/a/very/deep/tree/of/dirs/report.md", "report.md", ["report"])
        self.assertGreater(short, long_)


class TestLocateBackend(unittest.TestCase):
    """locate.py 里不依赖具体平台工具的部分。"""

    def test_sort_code_roundtrip(self):
        """sort code 必须与 everything.py 的数值对齐，否则跨平台排序行为不一致。"""
        import locate
        self.assertEqual(locate.SORT_SIZE, 3)
        self.assertEqual(locate.SORT_DATE_MODIFIED, 11)
        field, desc = locate._decode_sort(3 | locate.SORT_DESC_FLAG)
        self.assertEqual(field, "size")
        self.assertTrue(desc)
        field, desc = locate._decode_sort(1)
        self.assertEqual(field, "name")
        self.assertFalse(desc)

    def test_sort_aliases_shared_with_find(self):
        """find.py 的 SORT_ALIASES 必须能直接喂给 Linux 后端。"""
        import find as F
        import locate
        for alias, code in F.SORT_ALIASES.items():
            if alias == "ext":
                continue
            field, _ = locate._decode_sort(code)
            self.assertEqual(field, alias, f"{alias} 的 sort code 对不上")

    def test_fd_size_string(self):
        import locate
        self.assertEqual(locate._fd_size_str(1024), "1k")
        self.assertEqual(locate._fd_size_str(1024 ** 3), "1g")
        self.assertIsNone(locate._fd_size_str(0))

    def test_locate_patterns_escaped(self):
        """传给plocate 的模式必须转义，否则 a.b 会变成正则、aXb 也命中。"""
        import re as _re
        q = Q.parse("a.b")
        pats = q.locate_patterns()
        self.assertEqual(len(pats), 1)
        self.assertNotEqual(pats[0], "a.b", "含点号的模式必须转义")
        rx = _re.compile(pats[0])
        self.assertTrue(rx.search("xa.by"))
        self.assertFalse(rx.search("xaxby"), "转义后不该把 . 当通配")

    def test_locate_patterns_exclude_basename_fields(self):
        """name:/ext: 是 basename 维度，plocate 表达不了，不该混进路径模式。"""
        q = Q.parse("name:report ext:md path:/etc")
        pats = q.locate_patterns()
        self.assertEqual(len(pats), 1)
        self.assertIn("etc", pats[0])

    def test_row_shape_matches_everything(self):
        """locate 的 row 必须与 everything 的 row 键完全一致，否则 format 会 KeyError。"""
        import locate
        st = os.stat(__file__)
        row = locate._make_row(__file__, st)
        expected = {"path", "name", "parent", "is_dir", "size", "mtime_ms",
                    "attributes", "hidden", "system", "readonly"}
        self.assertEqual(set(row.keys()), expected)
        self.assertFalse(row["is_dir"])
        self.assertGreater(row["size"], 0)
        self.assertGreater(row["mtime_ms"], 0)
        self.assertFalse(row["hidden"], "本测试文件不是隐藏文件")

    def test_row_detects_hidden(self):
        """隐藏判定只看 basename 首字符，所以可以脱离真实文件构造。"""
        import locate
        st = os.stat(__file__)
        self.assertTrue(locate._make_row("/a/.secret", st)["hidden"],
                        "以点开头的 basename 应标为隐藏")
        self.assertFalse(locate._make_row("/a/normal.txt", st)["hidden"])


class TestFindExpression(unittest.TestCase):
    """find 的命令行表达式：踩过的坑都固化成断言。

    这些坑的特点是**静默失败**——命令不报错、只是返回空，
    单元测试若不检查命令结构就会漏过去。
    """

    def _cmd(self, term, roots=("/tmp",)):
        import locate
        b = locate.Find.__new__(locate.Find)
        b.bin = "find"
        captured = {}
        orig = locate._run
        try:
            locate._run = lambda cmd, timeout, cap: (captured.update(cmd=cmd), [])[1]
            b.candidates(Q.parse(term), 10, 5, list(roots))
        finally:
            locate._run = orig
        return captured["cmd"]

    def test_no_nested_parens(self):
        """find 不支持嵌套括号，必须展平成单层 -o 链。"""
        for term in ("ext:rs", "ext:rs,py", "ext:md ext:txt"):
            cmd = self._cmd(term)
            depth = 0
            for tok in cmd:
                if tok == "(":
                    depth += 1
                    self.assertLessEqual(depth, 1, f"{term} 产生了嵌套括号: {cmd}")
                elif tok == ")":
                    depth -= 1

    def test_ext_uses_implicit_and(self):
        """「文件 且 扩展名」要写成 `-type f -a -name`，不是 `-o`。"""
        cmd = self._cmd("ext:rs")
        self.assertIn("-a", cmd, f"缺少隐含且: {cmd}")
        self.assertEqual(cmd.count("-o"), 0, f"ext: 不该出现 -o: {cmd}")

    def test_ext_never_returns_dirs(self):
        """ext: 过滤时必须限定 -type f，目录没有扩展名，混进来是错的。"""
        for term in ("ext:rs", "ext:rs,py"):
            self.assertIn("-type", self._cmd(term))

    def test_type_branch_has_no_parens(self):
        for term, flag in (("type:dir", "-type"), ("type:file", "-type")):
            cmd = self._cmd(term)
            self.assertEqual(cmd[0], "find")
            self.assertNotIn("(", cmd, f"{term} 不该有括号: {cmd}")

    def test_plain_lists_both_types(self):
        cmd = self._cmd("foo")
        self.assertIn("-o", cmd, "无过滤时应同时列文件与目录")
        self.assertIn("-print", cmd)


class TestLocateProbe(unittest.TestCase):
    """后端探测：不能只看 which 命中。"""

    def test_probe_uses_plocate_specific_flags(self):
        """探测必须用 plocate 专属参数，否则 MSYS/GNU 的同名 locate 会蒙混过关。

        实测踩过：Git Bash 自带 GNU findutils locate 返回码 1（无结果），
        被当成"索引可用" → 真正查询永远返回空 → /find 在该机器上完全失效。
        """
        import locate
        self.assertTrue(hasattr(locate.Plocate, "probe"))
        b = locate.Plocate.__new__(locate.Plocate)
        b.bin = "locate"
        captured = {}
        import subprocess as _sp
        orig = _sp.run
        try:
            def fake(cmd, **kw):
                captured["cmd"] = cmd
                return type("R", (), {"returncode": 1, "stdout": "", "stderr": ""})()
            locate.subprocess.run = fake
            b.probe()
        finally:
            locate.subprocess.run = orig
        for flag in ("-i", "-l", "--all"):
            self.assertIn(flag, captured["cmd"],
                          f"探测命令缺 {flag}，无法区分真 plocate 与 GNU locate")

    def test_locate_db_paths_documented(self):
        import locate
        self.assertTrue(locate.Plocate.DB_PATHS)
        self.assertTrue(any("plocate" in p for p in locate.Plocate.DB_PATHS))


class TestIndexAndTraversalMerge(unittest.TestCase):
    def test_index_empty_still_falls_back(self):
        """索引库由 updatedb 定时刷新，新建文件可能还不在库里。
        索引返回空时必须仍跑遍历兜底，否则用户刚保存的文件永远搜不到。"""
        import inspect
        import locate
        src = inspect.getsource(locate.LocateIndex._candidates)
        self.assertNotIn("return []", src,
                         "_candidates 里出现无条件 return [] 会跳过遍历兜底")
        self.assertIn("Fd.detect", src)
        self.assertIn("Find.detect", src)

    def test_backend_cls_injection_for_tests(self):
        """测试需要能强制指定后端，隔离机器差异（Windows 上没有 plocate）。"""
        import inspect
        import locate
        sig = inspect.signature(locate.LocateIndex.__init__)
        self.assertIn("backend_cls", sig.parameters)


class TestPlatformDispatch(unittest.TestCase):
    def test_backend_label(self):
        import find as F
        expected = "Everything" if F.IS_WINDOWS else "plocate"
        self.assertEqual(F.backend_label(), expected)

    def test_windows_uses_everything_linux_uses_locate(self):
        """平台分派必须明确，不能在 Linux 上误载Everything。"""
        import find as F
        if F.IS_WINDOWS:
            self.assertTrue(os.path.isfile(
                os.path.join(ROOT, "plugins", "find", "everything.py")))
        else:
            self.assertTrue(os.path.isfile(
                os.path.join(ROOT, "plugins", "find", "locate.py")))

    def test_unavailable_hint_platform_appropriate(self):
        import find as F
        hint = F.unavailable_hint()
        if F.IS_WINDOWS:
            self.assertIn("Everything", hint)
        else:
            self.assertIn("plocate", hint)
            self.assertNotIn("Everything64.dll", hint, "Linux 不该让用户去装 DLL")

    def test_format_source_not_hardcoded(self):
        """format 的来源标签必须可注入，否则 Linux 上会显示 "Everything 索引"。"""
        f = fmt.build_footer(5, 5, 2.0, source="plocate 索引")
        self.assertEqual(f["description"], "plocate 索引")


if __name__ == "__main__":
    unittest.main(verbosity=2)