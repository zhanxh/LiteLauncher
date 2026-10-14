#!/usr/bin/env python3
"""/pomo 侧状态机的纯逻辑测试（不起 sidecar 进程、不真等倒计时）。

番茄钟的节奏全在 `pomo.py` 的 `_state` 里：专注↔短休按 5:1 交替、到点后自动衔接
还是停在 hold 等人工点按钮、暂停后恢复的是哪一段、进程重启后能不能把这套节奏接回来。
这些正是最容易出错、又最难用眼睛验证的地方——"5 分钟跑完挂件显示 25:00 准备开始"
那种事故，类型全对、日志全无，只有把状态机单测出来才拦得住。

跑法：python tools/test-pomo-logic.py
"""

import json
import os
import sys
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "plugins", "pomo"))

import pomo as P  # noqa: E402

# 挂件（独立进程）每秒从 settings 读的键。**这份清单是跨进程契约**：
# sidecar 少写一个键，挂件那边就静默读到 null 并退回默认值——不是报错，是显示错。
# 改 `_persist` 或改挂件读取键时，必须有一边先红。
WIDGET_KEYS = ["target", "label", "minutes", "paused_remain", "phase",
               "next_phase", "rounds", "auto", "hold", "snap"]

T0 = 1_700_000_000.0  # 任意固定的秒级时间戳（Python 侧全程用 time.time()）


class _Clock(object):
    """假时钟：`sleep` 不真等，只把时间推过去。

    为什么要替掉 `P.time`：`_worker` 会 `sleep(min(remain, 20))` 直到目标时刻。
    真等 25 分钟不现实；把 sleep 换成"改内部读数"后，整条"到点→推进下一段"
    的链路就能在毫秒内跑完，测到的仍是生产代码。
    """

    def __init__(self, t=T0):
        self.t = t

    def time(self):
        return self.t

    def monotonic(self):
        return self.t

    def sleep(self, sec):
        self.t += max(0.0, sec)

    def advance(self, sec):
        self.t += sec

    def __getattr__(self, name):
        # 只接管 time/sleep/monotonic/time 这几个"读时钟"的入口；
        # strftime/localtime 这类纯函数仍用真实标准库，免得假时钟越补越大
        import time as _real_time
        return getattr(_real_time, name)


_THREADS = []


class _NoSpawn(object):
    """替掉 `threading.Thread`：记下待执行的 worker，由测试决定何时触发。

    为什么要替：`_arm` 起线程睡到目标时刻。让它真跑起来会让断言与后台线程抢状态，
    替成可手动触发的记录对象后，"到点"这个事件就归测试支配了。
    """

    def __init__(self, target=None, args=(), kwargs=None, daemon=None):
        self._target = target
        self._args = args
        self._kwargs = kwargs or {}

    def start(self):
        _THREADS.append(self)

    def join(self, timeout=None):
        return None

    def fire(self):
        self._target(*self._args, **self._kwargs)


class SegmentMachineTest(unittest.TestCase):
    def setUp(self):
        self.kv = {}
        self.notices = []
        self.clock = _Clock()
        del _THREADS[:]
        # 这些全是模块级名字，逐个打补丁并在 tearDown 还原最省事
        self._orig = (P.svc, P.svc_read_settings, P.fire, P._notify,
                      threading.Thread, P.time)
        P.svc = self._svc
        P.svc_read_settings = lambda key: self.kv.get(key)
        P.fire = self._fire
        P._notify = lambda title, body: self.notices.append((title, body))
        threading.Thread = _NoSpawn
        P.time = self.clock
        with P._state_lock:
            P._state.update({"target": 0.0, "label": "", "minutes": P.DEFAULT_MIN,
                             "running": False, "paused": False, "paused_remain": 0.0,
                             "phase": P.PHASE_FOCUS, "focus_label": "",
                             "focus_minutes": P.DEFAULT_MIN, "break_minutes": 1,
                             "auto": True, "hold": False,
                             "next_phase": P.PHASE_BREAK, "rounds": 0})

    def tearDown(self):
        (P.svc, P.svc_read_settings, P.fire, P._notify,
         threading.Thread, P.time) = self._orig

    # ── 假宿主 ────────────────────────────────────────────────
    def _svc(self, method, params=None, timeout=10.0):
        if method == "svc.settings.get":
            return self.kv.get((params or {}).get("key"))
        return None

    def _fire(self, method, params=None):
        if method == "svc.settings.set":
            self.kv[params["key"]] = params["value"]

    def _state(self):
        with P._state_lock:
            return dict(P._state)

    def _start(self, minutes=5, label="写代码"):
        """开一轮，并把 `_arm` 起的那条 worker 收走（各测试自行决定何时触发）"""
        bmin = P._start_new(minutes, label)
        del _THREADS[:]
        return bmin

    # ── 5:1 比例 ──────────────────────────────────────────────
    def test_break_ratio(self):
        self.assertEqual(P.break_minutes_of(25), 5)
        self.assertEqual(P.break_minutes_of(30), 6)
        # 5 分钟专注按 5:1 只有 1 分钟——再小就不是"休息"而是噪声
        self.assertEqual(self._start(5), 1)
        self.assertEqual(P.break_minutes_of(1), 1, "短休至少 1 分钟")
        self.assertEqual(P.break_minutes_of(0), 5, "非法输入应回落默认 25 的比例")
        self.assertEqual(P.break_minutes_of(None), 5)
        self.assertEqual(P.break_minutes_of("abc"), 5)

    def test_break_ratio_matches_frontend(self):
        """两侧各写一遍 5:1，就会各错一遍——这里把两边钉死成同一个数。"""
        path = os.path.join(ROOT, "plugins", "pomo", "fe", "src", "timer.ts")
        with open(path, encoding="utf-8") as fp:
            src = fp.read()
        self.assertIn("export const BREAK_RATIO = %d;" % P.BREAK_RATIO, src)
        # 前端公式是 max(1, round(m/5))，取整方向也要一致
        for m in (5, 7, 25, 30, 45, 60, 90):
            self.assertEqual(P.break_minutes_of(m), max(1, round(m / float(P.BREAK_RATIO))),
                             "%d 分钟的短休应与前端公式一致" % m)

    def test_start_sets_up_the_cycle(self):
        self._start(25, "写代码")
        s = self._state()
        self.assertEqual(s["focus_minutes"], 25)
        self.assertEqual(s["break_minutes"], 5)
        self.assertEqual(s["phase"], P.PHASE_FOCUS)
        self.assertEqual(s["next_phase"], P.PHASE_BREAK)
        self.assertEqual(s["rounds"], 0)
        self.assertFalse(s["hold"])
        # 用户要求"初始 add 后就是自动勾选"
        self.assertTrue(s["auto"], "新建番茄钟默认自动衔接")

    # ── 到点后的去向 ───────────────────────────────────────────
    def test_auto_advances_focus_to_break(self):
        self._start(25, "写代码")
        P._on_phase_end(P.PHASE_FOCUS)
        s = self._state()
        self.assertEqual(s["phase"], P.PHASE_BREAK)
        self.assertEqual(s["minutes"], 5, "短休段必须用 5:1 推出来的分钟数")
        self.assertEqual(s["label"], "短休")
        self.assertEqual(s["rounds"], 1, "专注段跑完才算完成一轮")
        self.assertFalse(s["hold"])
        self.assertTrue(s["running"])

    def test_auto_advances_break_back_to_focus(self):
        self._start(25, "写代码")
        P._on_phase_end(P.PHASE_FOCUS)
        P._on_phase_end(P.PHASE_BREAK)
        s = self._state()
        self.assertEqual(s["phase"], P.PHASE_FOCUS)
        self.assertEqual(s["minutes"], 25, "短休结束后要回到**用户设定**的专注分钟数")
        self.assertEqual(s["label"], "写代码", "短休不应把任务名吃掉")
        self.assertEqual(s["rounds"], 1, "短休结束不加轮数")

    def test_manual_mode_parks_in_hold(self):
        """自动衔接关掉时，到点必须停在 hold，而不是退回"从未计时"。

        这是真机事故的原型：只把 target 清零，挂件读到 target=0 就显示
        「25:00 准备开始」，用户以为倒计时从没跑过。
        """
        self._start(5, "写代码")
        P._set_auto(False)
        P._on_phase_end(P.PHASE_FOCUS)
        s = self._state()
        self.assertTrue(s["hold"])
        self.assertEqual(s["target"], 0.0)
        self.assertFalse(s["running"])
        self.assertFalse(s["paused"], "hold 不是暂停，否则挂件冒出「继续」而非「下一段」")
        self.assertEqual(s["next_phase"], P.PHASE_BREAK)
        self.assertEqual(s["rounds"], 1)
        _r, _l, _m, kind = P._remaining()
        self.assertEqual(kind, "hold", "hold 不能混进 idle，否则「结束」这件事会被抹掉")
        self.assertTrue(any("点挂件的" in body for _t, body in self.notices),
                        "手动模式的通知要把「去哪儿点」说清楚")

    def test_next_segment_only_works_in_hold(self):
        self._start(5, "写代码")
        self.assertFalse(P._next_segment(), "计时中没有「下一段」可推进")
        P._set_auto(False)
        P._on_phase_end(P.PHASE_FOCUS)
        self.assertTrue(P._next_segment())
        s = self._state()
        self.assertEqual(s["phase"], P.PHASE_BREAK)
        self.assertFalse(s["hold"])
        self.assertTrue(s["running"])

    def test_turning_auto_on_while_holding_resumes_at_once(self):
        """勾选自动的瞬间正停在 hold，就该立刻接上——用户的意图是"别再等我"。"""
        self._start(5, "写代码")
        P._set_auto(False)
        P._on_phase_end(P.PHASE_FOCUS)
        self.assertTrue(P._set_auto(True))
        s = self._state()
        self.assertTrue(s["running"])
        self.assertFalse(s["hold"])
        self.assertEqual(s["phase"], P.PHASE_BREAK)

    def test_worker_drives_the_whole_cycle(self):
        """端到端：`_arm` 起的 worker 到点后自己推进段别，连跑「专注→短休→专注」。

        只测 `_on_phase_end` 的话，"worker 判定被覆盖/已暂停则作废"这层保护测不到，
        而那层恰恰决定了暂停后原来的计时会不会越过暂停抢跑下一段。
        """
        self._start(10, "写代码")          # 专注 10 分钟，短休 2 分钟
        P._set_auto(True)
        worker = _NoSpawn(P._worker, (self._state()["target"], "写代码", 10, P.PHASE_FOCUS))
        worker.fire()                       # 假时钟 sleep 到点，不真等
        s = self._state()
        self.assertEqual(s["phase"], P.PHASE_BREAK)
        self.assertEqual(s["minutes"], 2)
        # 短休的 worker 由 _arm 记录在案，取出触发
        break_worker = _THREADS[-1]
        break_worker.fire()
        s = self._state()
        self.assertEqual(s["phase"], P.PHASE_FOCUS)
        self.assertEqual(s["minutes"], 10)
        self.assertEqual(s["rounds"], 1)

    def test_stale_worker_does_not_advance(self):
        """暂停会把 target 归零：原来那条 worker 到点后必须作废，
        否则会越过暂停直接接下一段（用户看到的"暂停了却自己开始短休"）。"""
        self._start(10, "写代码")
        target = self._state()["target"]
        P._pause()
        _NoSpawn(P._worker, (target, "写代码", 10, P.PHASE_FOCUS)).fire()
        s = self._state()
        self.assertTrue(s["paused"], "暂停态不该被过期 worker 破坏")
        self.assertFalse(s["running"])

    # ── 暂停 / 恢复 / 停止 ──────────────────────────────────────
    def test_pause_resume_keeps_phase(self):
        self._start(5, "写代码")
        self.assertTrue(P._pause())
        s = self._state()
        self.assertTrue(s["paused"])
        self.assertEqual(s["target"], 0.0)
        self.assertEqual(s["paused_remain"], 5 * 60)
        self.assertTrue(P._resume())
        s = self._state()
        self.assertEqual(s["phase"], P.PHASE_FOCUS, "恢复的是**同一段**，不该跳到短休")
        self.assertEqual(s["label"], "写代码")
        self.assertFalse(s["paused"])

    def test_stop_clears_everything_the_widget_reads(self):
        self._start(5, "写代码")
        P._set_auto(False)
        P._pause()
        self.assertTrue(P._stop())
        s = self._state()
        self.assertEqual(s["target"], 0.0)
        self.assertEqual(s["paused_remain"], 0.0, "残留会让停止后又冒出继续按钮")
        self.assertFalse(s["hold"])
        self.assertFalse(s["paused"])
        self.assertEqual(s["rounds"], 0)
        self.assertEqual(s["phase"], P.PHASE_FOCUS)

    # ── 跨进程契约 ────────────────────────────────────────────
    def test_persist_covers_every_widget_key(self):
        self._start(25, "写代码")
        for key in WIDGET_KEYS:
            self.assertIn(key, self.kv, "挂件要读的键没写出来，那边会静默用默认值")

    def test_snap_is_json_of_state(self):
        self._start(25, "写代码")
        snap = json.loads(self.kv["snap"])
        s = self._state()
        self.assertEqual(sorted(snap), sorted(s))
        self.assertEqual(snap["phase"], P.PHASE_FOCUS)
        self.assertTrue(snap["auto"])
        # 挂件对 snap 里的 target 也要做秒/毫秒归一，所以这里必须仍是**秒级**
        self.assertLess(snap["target"], 1e11)
        # 散装键与 snap 必须同源，否则回退路径与主路径会显示两样东西
        self.assertEqual(self.kv["target"], str(snap["target"]))
        self.assertEqual(self.kv["auto"], "1")

    def test_persist_after_hold(self):
        """hold 态也必须落盘：挂件是另一个进程，只能从 settings 看到"这段跑完了"。"""
        self._start(5, "写代码")
        del self.kv["snap"]
        P._set_auto(False)
        P._on_phase_end(P.PHASE_FOCUS)
        snap = json.loads(self.kv["snap"])
        self.assertTrue(snap["hold"])
        self.assertEqual(snap["next_phase"], P.PHASE_BREAK)
        self.assertEqual(snap["rounds"], 1)
        self.assertEqual(self.kv["hold"], "1")

    # ── 面板条目 ──────────────────────────────────────────────
    def _ids(self):
        return [i["id"] for i in P._status_items()]

    def test_status_items_expose_next_and_auto(self):
        self._start(5, "写代码")
        ids = self._ids()
        self.assertIn("pomo:auto", ids)
        self.assertNotIn("pomo:next", ids, "计时中不该出现「下一段」")
        P._set_auto(False)
        P._on_phase_end(P.PHASE_FOCUS)
        ids = self._ids()
        self.assertIn("pomo:next", ids)
        self.assertIn("pomo:hold", ids, "面板也要看得见「已完成几轮、在等什么」")

    # ── 命令入口 ──────────────────────────────────────────────
    def test_execute_auto_and_next(self):
        self._start(5, "写代码")
        self.assertTrue(P.on_execute({"subcommand": "auto", "args": ["off"]})["success"])
        self.assertFalse(self._state()["auto"])
        self.assertFalse(
            P.on_execute({"subcommand": "next", "args": []})["success"],
            "没在 hold 时 next 应明确失败，而不是静默无事发生")
        P._on_phase_end(P.PHASE_FOCUS)
        self.assertTrue(P.on_execute({"subcommand": "next", "args": []})["success"])
        self.assertEqual(self._state()["phase"], P.PHASE_BREAK)
        self.assertFalse(P.on_execute({"subcommand": "auto", "args": ["maybe"]})["success"])

    # ── 进程重启后的恢复 ────────────────────────────────────────
    def test_restore_rearms_a_running_phase(self):
        """重启后不能退化成"永远重复同一个分钟数的专注段"。"""
        self._start(25, "写代码")
        P._on_phase_end(P.PHASE_FOCUS)  # auto → 进入短休
        self.assertGreater(self._state()["target"], self.clock.time())
        del _THREADS[:]
        with P._state_lock:
            P._state.update({"running": False, "target": 0.0})  # 模拟进程被换掉
        P._restore_from_settings()
        s = self._state()
        self.assertTrue(s["running"])
        self.assertEqual(s["phase"], P.PHASE_BREAK)
        self.assertEqual(s["focus_minutes"], 25)
        self.assertEqual(s["rounds"], 1)

    def test_restore_keeps_hold(self):
        """hold 标记不恢复，挂件上「下一段」按钮就看得见点不动——最难排查的一类。"""
        self._start(5, "写代码")
        P._set_auto(False)
        P._on_phase_end(P.PHASE_FOCUS)
        with P._state_lock:
            P._state.update({"hold": False, "rounds": 0, "auto": True})
        P._restore_from_settings()
        s = self._state()
        self.assertTrue(s["hold"])
        self.assertEqual(s["rounds"], 1)
        self.assertFalse(s["auto"])
        del _THREADS[:]
        self.assertTrue(P._next_segment(), "恢复后的 hold 应能被「下一段」推进")
        self.assertEqual(self._state()["phase"], P.PHASE_BREAK)

    def test_restore_marks_paused(self):
        self._start(5, "写代码")
        P._pause()
        with P._state_lock:
            P._state.update({"paused": False, "paused_remain": 0.0})
        P._restore_from_settings()
        self.assertTrue(self._state()["paused"])

    def test_restore_backfills_snap_for_old_state(self):
        """升级前留下的状态没有 snap 键，恢复时必须补写，否则挂件一直走回退路径。"""
        self._start(25, "写代码")
        del self.kv["snap"]
        self.kv["target"] = "0"
        with P._state_lock:
            P._state.update({"running": False, "target": 0.0})
        P._restore_from_settings()
        self.assertIn("snap", self.kv)


if __name__ == "__main__":
    unittest.main(verbosity=2)
