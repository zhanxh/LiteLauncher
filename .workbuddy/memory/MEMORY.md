# LiteLauncher 项目长期约定

## 核心原则
- **一切皆插件**：功能不得硬编码进壳层/宿主。术语坑：文档的"编译期内置插件"专指 `plugins/*/be`（Rust 随主程序编译），与口语"内置"（=硬编码进宿主）是两回事。沟通统一说「编译期插件（Rust）/ 外部插件（LLP）/ 纯前端插件」。

## 插件形态（共通：同一注册表 + plugin_call + 同一份 svc.*）
- 编译期 `builtin`：`plugins/<id>/{be,fe}`，需重编译；外部 LLP `llp`：manifest+脚本，拷目录即装，`backend.entry` 可指任意可执行文件；纯前端 `none`：无后端进程，但可有视图窗口（共享状态只靠 `ctx.settings`）。
- 外部插件前端零代码：`src/core/externalPlugins.ts` 按 manifest 自动生成 CommandPlugin 并映射参数。

## 插件交互契约
- 复制走 `AfterSelect.copy` → 宿主 `clipboard_write`（勿用 navigator.clipboard，窗口隐藏会被拒）。面板项：`{id,title,description,badge,icon,metadata:{value}}`。
- 纯前端插件只准 import `@ll/sdk`(+`@ll/ui`+solid-js)；依赖方向恒为 ui→sdk。
- **网络类插件**：壳层 query 逐键无防抖，绝不能在 query 里发请求。范式：query 命中缓存才渲染，否则渲染「查询」项（metadata.fetch=缓存键）→ onSelect 抓取+写缓存+回 `{refresh:true}` → 重跑 query → 结果项回 `{copy}`。TTL 5–30min，参考 weather/fx/ip/dict/tr。HTTP 走 `ctx.http`；manifest 必须声明 `net:<host>`。
- LLP 参数：queryText=trigger 后所有 token 原样拼接，subcommand 会从 args 挖走 → 不能把 args 拼回 keyword；剥控制词看参数合法性，别按字符删。
- 可选字段：`queryDebounceMs`（网络/索引类必设 200–600，纯计算勿设）、`argsHint`（只拼描述尾，不塞输入框）、`examples`（/help 可搜索）、`hotkeys`（自报供 /hotkey，只在 register 成功后收录）。

## 宿主 svc.*（唯一入口 services.rs::dispatch_svc，LLP 反向请求与前端 ctx.call 共用）
- 权限按 manifest.permissions 门控；未注册退 shell_safe_manifest。用 db/process/net/screen/window/shortcut 就必须把 manifest 部署到宿主可见目录。
- ⚠️ `process.launch` 按"目标类型"分两套校验：URL 走 validate_url_target（放行 `& ? = % #`，Windows 用 rundll32 不走 cmd start）；路径/裸命令走完整 Shell 黑名单。合并成一套会挡掉带查询串的链接。

## 屏幕/热键（D 组）
- 坐标一律桌面全局物理像素；xcap capture_region 要显示器内相对 u32，换算只在宿主做。
- ⚠️ capture({region}) 返回的图已是选区本身，下游勿再算裁剪偏移；savePng 传 base64；写图片剪贴板需 clipboard:write 门控。
- 全局热键：manifest `shortcut:<accel>` 逐条声明无通配、先到先得；`ctx.shortcuts.on` 默认 scope:'main'，视图窗口内要显式 'any'（否则每个窗口加载都执行一遍）。
- ⚠️ 新增视图窗口必须登记 capabilities/default.json 的 windows 白名单（标签=`<pluginId>-<viewId>`，unique_by 带后缀）并逐条列全 permissions，漏了静默失败/死窗。
- ⚠️ Tauri 建窗 API 收逻辑像素、Monitor 给物理像素，HiDPI 必须除 scaleFactor。
- ⚠️ GTK 小窗下限 200×200：修在 services.rs::clamp_gtk_child_min_size（压回声明 min_*）。Linux 界面偏小通常是会话没开缩放，系统侧解决，app 别补偿。
- desktop.rs 挂壁纸层 SetWindowPos 必须带 SWP_NOMOVE（SetParent 后坐标系变相对 WorkerW）。

## 弹出式基窗（auto_height + PopupFrame，宿主通用能力）
- 无边框拖拽用 Tauri 注入 drag.js（`data-tauri-drag-region="deep"`，勿手写 mousedown）；高度跟内容、超长内部滚动；物理↔逻辑换算与四角锚定只在宿主（ll-plugin-api，有单测）。
- `setContentSize` 只能改自己所在视图且该视图须声明 auto_height；window_label() 同时用于建窗与校验，勿拆两处。
- ⚠️ 测量的目标是内容自然高度，被测元素禁 height:100vh（自激棘轮）；三段式骨架量「标题+body-inner+状态栏」之和。
- ⚠️ 三段式只有 .ll-popup-body 滚动；别改回 body 滚动+标题 sticky（#root overflow:hidden 会让 sticky 找错容器）。popup.css 全收在 body.ll-popup-mode 下、对 index.html 的钉死样式要带 !important。
- ⚠️ 逐帧改尺寸时锚定基准不能用实时读回的矩形（WM 半成品态会逐帧漂移）：宿主记住上次"请求"矩形，未追上用请求值续算。
- 视觉定案：实心窗口+系统圆角（WebView2 透明窗口真机露白，不可靠）。

## 挂件与 LLP sidecar
- Windows 启动任何子进程必须走 ll-host/src/python.rs::hide_console（CREATE_NO_WINDOW），否则抢焦点+黑窗。
- sidecar↔挂件唯一通道 ctx.settings；每帧合并成单键 JSON 快照一次读；键名清单是跨进程契约，用测试常量断言（tools/test-pomo-logic.py 的 WIDGET_KEYS）。
- 尺寸常量三处对齐：代码 ↔ manifest views 的 min_* ↔ CSS；min_width 大于收拢宽度会被夹住（"代码动窗口不动"）。

## 测试约定
- LLP(Python) 状态机用 tools/test-*-logic.py（unittest，模块级打补丁：假 svc/time/Thread）；plugin:test 只验协议不报错。
- 纯前端测试 .ts 递归转译、.tsx 返回空模块 → 可测逻辑抽到 .ts。
- "只有真机看得出错"的断言要做变异验证防永真（npm run plugin:test:fe 的弹出式基窗组）。
- ⚠️ cargo 构建脚本链接参数作用域：`link-arg-bins` 只进 bin；`link-arg-tests` 只认 tests/ 集成测试（包内无该类目标时 Cargo 直接报错）；**lib 单测要用 `link-arg`（embed_resource::compile_for_everything）**；`-cdylib` 变体有效。GNU 侧 windres 产 `lib*.a`。
- ⚠️ Windows 测试二进制必须嵌 Common-Controls v6 清单（2026-10-27 修 CI）：tauri→muda 静态导入 comctl32!TaskDialogIndirect（仅 v6 有），无清单→绑定 System32 v5→0xC0000139。`ll-host/build.rs` 与 `src-tauri/build.rs` 用 compile_for_everything 嵌入；app 侧同时 `WindowsAttributes::new_without_app_manifest()` 关掉 tauri 的 bins-only 清单防双 RT_MANIFEST（MSVC 报重复资源）。MSVC 下 webview2-com-sys 静态链接（无 DLL 依赖）；GNU 动态导入 WebView2Loader.dll，需 `deps/` 有该 DLL（cargo clean 后要重拷）。
- ⚠️ 本地 MinGW：tauri-app 的 cdylib 无 #[no_mangle] 导出时 ld 回退 auto-export-all（≈15.7 万符号）→ "export ordinal too large"。修法：build.rs 在 gnu 目标发 `cargo:rustc-link-arg-cdylib=-Wl,--exclude-all-symbols`（桌面 cdylib 无消费方，bin 静态链接 rlib）。
- CI：Windows MSVC 全量（`cargo test --workspace` 等）；rust-cache 第一行必须是 `. -> src-tauri/target`（target-dir 被 .cargo/config.toml 钉走，写 `. -> target` 缓存空转）。Linux job 只跑前端。

## 命令速查
`npm run gen`（改 fe 必跑）/ plugin:install / plugin:test / plugin:test:fe / plugin:test:pomo；`npx tsc --noEmit`；`cargo check --workspace`；`build.cmd|build.sh [ship]`（ship 档用环境变量覆盖 profile+独立 target 目录，别改 Cargo.toml）；`npm run check` = cargo check + tsc，**不含 cargo test**；开发期 debug 构建自动扫描仓库 plugins/。

## 版本控制 / 环境
- origin = git@github.com:zhanxh/LiteLauncher.git（GitHub Actions 随 push 触发），主分支 master；.workbuddy/memory/ 随代码一起提交；conventional commits、按关注点拆分。
- 本机 GNU 工具链（/d/tools/mingw64，gcc 16.2.0）；cargo 走 rsproxy。**Windows `cargo test --workspace` 已可全跑**（2026-10-27 清单修复后）；Linux ll-host 测试也正常。
- Linux 构建机缺库：libclang-dev（xcap bindgen）、libgbm-dev、libwebkit2gtk-4.1-dev 等；报 "Unable to find libclang"/"-lX" 一律缺 -dev，别改 build.rs。
