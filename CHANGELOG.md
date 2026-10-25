# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> 规则：**每次修改都要在 `[Unreleased]` 记一行**——包括重构、文档、构建脚本与依赖升级。
> 用户可感知的进 `Added / Changed / Fixed / Removed`；其余进 `Internal`。发布时整段移到版本号下。

## [Unreleased]

### Added

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

- 启动器、插件窗口与设置中心统一圆角：改为透明窗口 + 4px 圆角面板（四角透出桌面，系统投影改为随圆角关闭）。插件窗口新增 `rounded` 声明位（默认开启），pomo 挂件声明 `rounded: false` 保持直角，全屏遮罩类（截图框选）不受影响。
- `apps.db` schema v2：新增 `source/pinyin/initials/launch_count/last_used_at/hidden/last_seen_at` 列与索引；迁移前自动备份、幂等可重跑。
- 应用列表描述由完整路径改为来源标签（开始菜单 / 桌面 / 自定义），完整路径仍在 `metadata.path`。
- 预置应用种子（`code.exe` 等裸命令）在同名系统快捷方式出现时自动升级为真实路径，避免首启启动失败。

### Fixed

- Linux 上输入 `/time`、`/rand` 等纯前端插件指令时程序冻结（窗口停在少一个字符的最后绘制帧、进程满负荷空转）：壳层查询效果经 `beginQuery` 常规读取 `panelItems` 把它注册成效果依赖，查询完成后 `setPanelItems` 触发效果重跑 → 再查询，形成死循环；纯 JS 插件的 await 落在微任务里，事件循环被饿死（走 IPC 的 `/app` 等每圈让出事件循环，因此从未暴露）。`beginQuery` 改用 `untrack` 读取切断反馈环。
- Linux 上启动器动态高度从未生效，面板永远只有一条小窗：`resizable: false` 的窗口被 GTK 锁死尺寸提示（实测 min=max=680×200），所有 `set_size` 被 X 静默夹回且 Tauri 照样返回 Ok。运行时解锁 resizable 并写入显式宽高约束（宽锁 680，高 70..640），被夹掉的 resize 在窗口 Resized 事件里补发收敛；与 auto_height 弹窗的 Linux 处理同思路。
- `set_main_window_height` 改为 async 命令并把 resize 派发到主循环独立迭代：同步命令在 Linux 上于 WebKitGTK 的 IPC 回调里执行，直接 gtk_window_resize 会打断 GDK 窗口更新 freeze/thaw 记账（每次启动触发 `gdk_window_thaw_toplevel_updates` 断言）。
- native 插件 manifest 的 `backend.entry` 补齐双平台条目（ai/apps/echo/notes/pomo/todo 六个此前只声明 `.dll`）：Linux 构建时 integrity 才能回填到 `lib*.so`，便携包不再携带 Linux 上必然被宿主拒载的插件清单（表现为「未知插件 apps」）。
- 旧库搬迁失败（如核心库 `todos` 缺列）时，插件 schema 升级不再被一起跳过，避免 `apps.db` 永久停留在 v1。

### Internal

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
