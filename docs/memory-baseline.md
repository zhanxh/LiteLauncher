# 内存基线（WP-10）

> 2026-10-18，release 构建，Windows 11 + WebView2。
> 方法：启动后空闲 5 秒，按 `LiteLauncher.exe` 的进程树汇总主进程与全部
> `msedgewebview2.exe` 子进程的 Working Set / Private Bytes。

## 结果

| 指标 | 数值 |
|---|---:|
| 进程数 | 7（1 主进程 + 6 WebView2） |
| Working Set 合计 | 442.4 MB |
| Private Bytes 合计 | **267.8 MB** |
| 主进程 Private | 40.2 MB |
| 最大 WebView2 子进程 Private | 138.6 MB |

## 结论

- WP-10 设定的“空闲私有内存 ≤ 220 MB”**未达到**。
- 主要占用来自 WebView2 多进程（渲染/GPU/网络/Utility），主进程本身约 40 MB；
  当前没有证据表明是 LiteLauncher 的泄漏，暂不通过关闭硬件加速或裁剪 WebView
  功能来换数字。
- 该目标按计划关闭，记录为基线；后续若出现持续增长，再按“进程树私有内存
  30 分钟斜率”排查泄漏，而不是看单次绝对值。
- 可控项已处理：日志分级/轮转、截图统一目录与 500 张/30 天清理、后台窗口不常驻。

## 复测方法

启动 release 版，空闲 5 秒后用 PowerShell 按进程树汇总主进程与全部
`msedgewebview2.exe` 子进程的 `WorkingSet64` / `PrivateMemorySize64`。
不要只取 `LiteLauncher.exe` 单进程，否则会漏掉 WebView2 的大头。
