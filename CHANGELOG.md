# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> 规则：**每次修改都要在 `[Unreleased]` 记一行**——包括重构、文档、构建脚本与依赖升级。
> 用户可感知的进 `Added / Changed / Fixed / Removed`；其余进 `Internal`。发布时整段移到版本号下。

## [Unreleased]

### Added

- `/qr` 输入即预览：在本机生成二维码（字节模式 UTF-8、纠错 M、版本 1–20，纯 TS 实现 ISO/IEC 18004 子集），结果面板首行以 200px 大图实时刷新；回车把同一张图画成 PNG **复制进剪贴板**（同时落盘，路径回在 toast 里），中文/emoji/URL/WiFi/vCard 全部离线可用，超出上限时明确提示而不静默截断。
- SDK 契约新增可选 `PanelItem.iconSize`：插件可请求把该行的**图片**图标放大到指定边长，壳层夹取 28–224px（上限归壳层，防止个别插件把主窗口撑破）；不声明的老条目渲染逐字节不变。

- `/shot` 选区可调整 + 拖拽实时预览：四角/四边 8 个把手拖拽改选区大小（拖过对边自动翻转），选区外长按 0.26s 重新框选；拖拽全程实时显示边框、把手、尺寸标签与选区内清晰预览（视觉层改由"实时矩形"统一驱动，修复"松手才突然清晰"的突兀感）。
- `/shot` 截图重做为 flameshot 式流程：触发即隐藏启动器，冻结整屏置顶、**选区外虚化**供框选；松手后可在冻结画面上**即时作画**——画笔/矩形框/圆形框/箭头/马赛克（笔刷式像素化），全部支持配色板，可撤销；确认时前端直接从冻结底图裁剪合成（不再二次抓屏，全程无闪烁），选区**原位钉图**置顶：钉图可拖动、右键复制到剪贴板/关闭、Esc 关闭，支持多张共存；图片本体自动进剪贴板。宿主配套：`ViewSpec.geometry_from_params`（open 参数以全局物理像素定位定尺寸，钉图窗首帧即正确位置）、`svc.screen.copyPng`（截图目录内 PNG 直进剪贴板不落副本）、`svc.screen.capture` 窗口避让跳过调用者自身（遮罩层全透明无需避让——X11 上 hide→restore 会让 mutter 把全屏窗口重新最大化，框选坐标错位）。
- `/time` 世界时钟升级：面板秒级实时刷新（新增 PanelData.live 声明位，壳层在面板停留期间定时重跑 query，按 id 保住选中项、窗口隐藏即停、回焦即补刷）；回车把该城市的墙面时钟弹到桌面——SVG 表盘 + 数字读数，可同时弹出多个（每个时区一枚、右上角向下堆叠），首帧渲染完成后自动贴到壁纸层（Wayland 降级为置顶浮窗并如实标注），Ctrl+Enter 仍复制时间。
- 修复 `/time` 桌面时钟“一闪即逝 / 主程序崩溃退出”的三处根因：① `svc.window.attachDesktop` 在 async 命令线程（tokio worker）里 `block_on`，宿主 panic=abort 下直接静默杀进程（pomo 的 native 桥接线程上下文不同所以未暴露）→ 改为独立 OS 线程执行；② 新版 Win11 上 Progman 兄弟链里已无 WorkerW，回退到 Progman 后子窗塌缩成 0×0 隐形子窗 → WorkerW 候选改为“兄弟链 + 全局 EnumWindows 补扫”，只接受可见且覆盖全虚拟桌面者；③ SetParent 后未重申矩形 → 显式换算父坐标系并顶回原尺寸；④ SetParent 会重置创建时设置的 DWM 无边框属性，系统重新画上一圈主题色边框（用户看到的“下巴/状态栏”）→ 挂载完成后再次 remove_window_border。附带：运行期 svc 调用接入 lifecycle.log（此前 svc_context 用空 logger，运行期诊断日志全被吞）；SetParent 返回 NULL（顶层窗原无父）不再误报为失败（补 GetParent 反查）。

- 系统托盘菜单新增「设置」选项，点击可快速呼出或前置聚焦设置面板窗口。
- 完善开机自动启动机制：开机自启注册 `--autostart` 参数并在系统登录时静默常驻托盘不弹窗；设置面板提供开机自启开关与即时状态反馈。
- 自动更新端点配置校正：默认更新源指向 `zhanxiaohai/LiteLauncher`，联动设置面板「检查更新」与启动期静默检测。

- 应用目录自动索引：首次启动后台收录开始菜单与桌面应用，无需再手动 `/app add`。
- 中文检索：应用名支持全拼与首字母（`wx` → 微信、`vsc` → Visual Studio Code）。
- 应用排序：手动添加优先，其次按启动次数与最近使用时间。
- `/app` 新增 `import_system` / `rescan` / `suggest` 接口，为后续空状态与引导做准备。
- 应用真实图标：`ll-icon://` 协议 + 32×32 PNG 磁盘/内存缓存（Windows 抽取 exe/lnk/url/ico，失败回退 emoji）。
- 空状态三块内容：常用应用 / 最近使用 / 推荐指令，带分组标题；不再是一根 70px 空框。
- 首启欢迎引导（3 步：认识热键 / 确认应用目录 / 试一条指令）；设置 → 关于可重新观看。
- 设置中心新增「通用」「快捷键」：热键可改、开机自启、重新扫描应用、重看引导。
- 插件热键 manifest 化：`hotkeys[]` 声明默认值，宿主统一注册与仲裁；设置页可改键、恢复默认、停用。
- 结果项动作层：底部动作条提示当前可用按键；`Ctrl/Shift/Alt + Enter` 触发次级动作。
- 截图热键 `Alt+Shift+S` 从整屏直接存盘改为直达区域框选，拖拽后图片进剪贴板。
- 应用/文件条目支持「打开所在文件夹」与「复制路径」；说明项（统计/用法/搜索头）不再被键盘选中。
- 单实例：重复启动只唤起已有窗口，不再出现第二个托盘图标。
- 修复 `/clip` 暂停/开启监听时报「manifest 未声明权限: clipboard:history」：运行期上下文现在会为 `clipboard:history` 打开插件库连接（与 `db` 权限同等对待），历史表与监听开关恢复正常。
- 剪贴板历史改为宿主后台监听（800ms 轮询）：关闭 `/clip` 后复制的内容也会保留；来源命中密码管理器名单或疑似凭据时不入库；暂停开关下一拍生效；条目显示来源应用。
- 查询加载态：150ms 后显示骨架；8s 显示「仍在查询」；15s 超时给「重试」。错误统一翻译成可行动文案（缺 Python / 网络超时 / 权限不足），原始信息写日志。
- `/cal new` 支持自然语言时间兜底：明天/后天/周几/下周几、上午/下午/晚上、3点/三点半/15:30、1小时/半小时；显式 DSL 优先，引号标题不参与解析。
- 日志分级与轮转：默认 `info`，`LL_LOG=debug` 才记录窗口/IPC 高频事件，`LL_LOG=off` 全关；超过 2MB 启动时轮转为 `.1`。
- 截图统一保存到 `%LOCALAPPDATA%\LiteLauncher\screenshots`，最多 500 张 / 30 天自动清理；`/shot` 面板显示已保存张数与占用。
- 分发：NSIS/MSI 安装包配置、`release/plugins` 随包、WebView2 bootstrapper；`build.cmd ship` 产出 NSIS 安装包。
- 自动更新：设置 → 关于可检查/下载安装；启动后每天最多静默检查一次；未配置签名公钥时明确提示。
- 发布流水线：打 `v*` tag 触发 GitHub Release，上传安装包、更新 zip/签名与 `latest.json`。
- API Key 在 Windows 上用 DPAPI 加密存储；旧明文首次读取自动迁移，换用户/换机解密失败时提示重填。
- 文档索引 `docs/README.md`；历史评审标注快照，状态以 CHANGELOG 与代码为准。
- `/hash`、`/cron`、`/cidr`、`/time`、`/pwd` 从 Python sidecar 迁为纯前端插件：干净 Windows 无需 Python，功能与输出保持兼容。
- 新增 [docs/records/monetization.md](docs/records/monetization.md)：明确不做广告、不做功能阉割式会员，捐赠优先、云同步可选。
- 工程基线：MIT LICENSE、版本号单一真相源脚本、GitHub Actions CI、本 CHANGELOG。

### Changed

- `/qr` 不再借道 `api.qrserver.com` 取图：待编码内容不再发给第三方，断网也可用；权限随之从 `process` 改为 `screen` + `clipboard:write`（插件版本 0.1.0 → 0.2.0）。原「回车在浏览器打开远程大图 / 复制远程链接」两项行为被"面板内预览 + 复制图片"替代。
- `/weather` 天气查询优化：默认不带城市参数时自动通过 `ipwho.is`（与 `/ip` 同口径）获取当前公网 IP 所在城市并查询该城市天气；仍支持输入指定城市名；manifest 相应补充 `net:ipwho.is` 白名单权限。
- `/cal` 面板默认第一行为「打开日程管理」，回车直接打开日程窗口（等同 `/cal app`），不再要求用户先记住这条子命令——与 `/note` 首项「打开笔记管理面板」对齐。带关键词检索时入口同样在首位，过滤只作用于日程本体；该入口的回车走 `open_manager`，不会被当成日程去 `toggle`。
- 启动器、插件窗口与设置中心统一圆角：改为透明窗口 + 4px 圆角面板（四角透出桌面，系统投影改为随圆角关闭）。插件窗口新增 `rounded` 声明位（默认开启），pomo 挂件声明 `rounded: false` 保持直角，全屏遮罩类（截图框选）不受影响。
- `apps.db` schema v2：新增 `source/pinyin/initials/launch_count/last_used_at/hidden/last_seen_at` 列与索引；迁移前自动备份、幂等可重跑。
- 应用列表描述由完整路径改为来源标签（开始菜单 / 桌面 / 自定义），完整路径仍在 `metadata.path`。
- 预置应用种子（`code.exe` 等裸命令）在同名系统快捷方式出现时自动升级为真实路径，避免首启启动失败。

### Fixed

- `/pomo` 桌面挂件底部凭空多出一条空白"状态栏"：统一 4px 圆角那轮改动给插件视图加了 `.plugin-window-root` 包裹层，但它的尺寸样式只写在 `html.ll-rounded` 下，`rounded:false` 的挂件于是拿到一张无尺寸的白纸，视图自己的 `height:100%` 逐级落空、卡片只长到内容高，剩下的窗口高度露成一条同色空白带。现把尺寸（铺满整窗）与外观（不透明底/圆角/描边）拆开，非圆角视图同样吃满整窗；`/time` 桌面时钟当初是在插件 CSS 里用 `position:fixed` 自救的，这次修在共享层，后续任何 `rounded:false` 视图不再重犯。
- Linux 上输入 `/time`、`/rand` 等纯前端插件指令时程序冻结（窗口停在少一个字符的最后绘制帧、进程满负荷空转）：壳层查询效果经 `beginQuery` 常规读取 `panelItems` 把它注册成效果依赖，查询完成后 `setPanelItems` 触发效果重跑 → 再查询，形成死循环；纯 JS 插件的 await 落在微任务里，事件循环被饿死（走 IPC 的 `/app` 等每圈让出事件循环，因此从未暴露）。`beginQuery` 改用 `untrack` 读取切断反馈环。
- Linux 上启动器动态高度从未生效，面板永远只有一条小窗：`resizable: false` 的窗口被 GTK 锁死尺寸提示（实测 min=max=680×200），所有 `set_size` 被 X 静默夹回且 Tauri 照样返回 Ok。运行时解锁 resizable 并写入显式宽高约束（宽锁 680，高 70..640），被夹掉的 resize 在窗口 Resized 事件里补发收敛；与 auto_height 弹窗的 Linux 处理同思路。
- `set_main_window_height` 改为 async 命令并把 resize 派发到主循环独立迭代：同步命令在 Linux 上于 WebKitGTK 的 IPC 回调里执行，直接 gtk_window_resize 会打断 GDK 窗口更新 freeze/thaw 记账（每次启动触发 `gdk_window_thaw_toplevel_updates` 断言）。
- native 插件 manifest 的 `backend.entry` 补齐双平台条目（ai/apps/echo/notes/pomo/todo 六个此前只声明 `.dll`）：Linux 构建时 integrity 才能回填到 `lib*.so`，便携包不再携带 Linux 上必然被宿主拒载的插件清单（表现为「未知插件 apps」）。
- 旧库搬迁失败（如核心库 `todos` 缺列）时，插件 schema 升级不再被一起跳过，避免 `apps.db` 永久停留在 v1。

### Internal

- `/qr` 真实窗口冒烟留痕补进设计文档：本机无 `xdotool`/Playwright，改用 `gcc + libXtst` 的 XTEST 注入驱动真实 release 窗口，截图与剪贴板 PNG 均由独立解码器 `zxing-cpp` 解回原文（`hello!!` / `你好世界` / 232×232 PNG），"能扫"不靠人眼判断；暗色主题一项利用"启动器开机即恢复上次查询并渲染面板"补测（临时改 `app_settings.theme` 后已还原并停掉测试实例），真机验证项至此全部闭合。
- `/qr` 编码器接入常驻回归：`tools/test-fe-plugins.mjs` 新增 `testQrcodeModule()`——29 条黄金 sha256 覆盖 v1–v20 每档装满长度与中文/emoji/URL/WiFi/vCard，加上定位/定时/对齐/暗模块的结构不变量、分块表与 ISO 字节容量的自洽校验、SVG 转义与留白检查；黄金摘要已与 python `qrcode`（等级 M、显式字节模式、强制同掩码）**逐格比对 201 例全部一致**。测试壳层配套：`sdkStub.screen` 补 `savePng`（解析 IHDR 回宽高），并加最小 canvas 桩以断言"回车确实画出了 PNG 且 `toClipboard=true`"。
- 修复 Linux 编译：主窗解锁尺寸用的 `WindowSizeConstraints` 未导入（改完整路径 `tauri::WindowSizeConstraints`）；`ll-host` 的 `Ordering` 只在 `#[cfg(windows)]` 分支引用，改为按平台导入，消除 unused_imports 告警。
- 修复：build.sh 的 node_modules 残缺探测覆盖前端实际引用的 `@tauri-apps/plugin-updater` / `plugin-process`，部分安装不再静默进入前端打包（Linux 实测曾在 vite 阶段报 import 解析失败）。
- 工程：清理 ll-host 与 ll-icons 的 Linux 编译警告——删除未使用的 `Ordering` 导入与非 Windows 平台死代码（`drive_root_pythons` 空桩、`ICON_SIZE` 移入 Windows cfg）。
- 工程：按 Linux 构建产物刷新 find / sysinfo 的 native 插件 `backend.integrity`。
- 工程：按 Linux 构建产物刷新 ai / apps / find / notes / pomo / sysinfo / todo 的 native 插件 `backend.integrity`。
- 工程：文档按 `workflows/standards/design/guides/records/knowledge` 分层，新增根 `AGENT.md` 与开发工作流（六步闭环、方案设计前置、提交门禁、文档死链检查）。
- 工程：提交门禁新增变更日志检查（`--check-changelog`），每次提交必须在 `[Unreleased]` 记一行。

## [0.1.0] - 2026-10-10

### Added

- 初始版本：Tauri 2 + SolidJS 启动器壳层、插件体系（native / LLP / 纯前端）、
  `/app` `/todo` `/note` `/shot` `/pick` `/clip` 等指令与工作模块。
