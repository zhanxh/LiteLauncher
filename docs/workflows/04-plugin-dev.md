# 04 插件开发

> 完整契约与 SDK 细节：[插件开发指南](../guides/plugin-development-guide.md)；
> native ABI 与构建：[native 插件指南](../guides/native-plugin-guide.md)；
> 交付前逐条过 [插件交付验收](../standards/business/plugin-acceptance.md)。

## 1. 选形态

| 形态 | `backend.kind` | 何时用 | 运行时依赖 | 重编主程序 |
| :--- | :--- | :--- | :--- | :--- |
| 纯前端 | `none` | 纯计算/文本/换算，输入即出结果 | 无 | 不需要 |
| native | `native` | 要直连系统 API（文件、窗口、进程、截图、索引） | 无（进程内） | 不需要 |
| 外部脚本 | `llp` | 有状态或依赖 Python 标准库 | Python 3 | 不需要 |
| 编译期 | `builtin` | **遗留**，不再新增 | 无 | 需要 |

判据：能在浏览器里算完的用 `none`；要碰系统或要常驻监听用 `native`；
脚本生态已有的用 `llp`。`none` 的代码会编进前端包，安装时只部署 `manifest.json`。

## 2. 起骨架

```powershell
npm run plugin:create -- my-tools --name "我的工具"   # native 骨架：manifest + native/ + fe/
```

- 生成的是 **native** 形态；要 `none` / `llp`，复制 `plugins/json`（`none`）或
  `plugins/cost`（`llp`）后改 `id`、`trigger`、`manifest.json`。
- id 规则：小写字母开头，仅 `a-z0-9-_`；目录名、`trigger`、`id` 三者一致。
- 新增插件后 `npm run gen`（dev/build 会自动跑），否则指令不会出现在壳层。

## 3. manifest 要点

```json
{
  "id": "my-tools",
  "name": "我的工具",
  "version": "0.1.0",
  "api_version": "^1",
  "trigger": "/my-tools",
  "permissions": ["clipboard:write"],
  "backend": { "kind": "native", "entry": ["my-tools.dll"], "integrity": "sha256:..." },
  "views": [{ "id": "panel", "title": "面板", "frontend": "assets", "decorated": false, "auto_height": true, "max_height": 480, "on_existing": "focus" }],
  "command": { "icon": "🧰", "action_subcommands": ["add"], "hint": "按 Enter 执行" }
}
```

- `backend.entry` 写多个平台产物名（`["x.dll", "libx.so"]`），宿主按平台挑；
  `integrity` 由 `node tools/update-plugin-integrity.mjs` 回填，**不手写**。
- `permissions` 最小化：`clipboard:*`、`db`、`net:<host>`、`notifications`、`process`、
  `screen`、`shortcut:<accel>`、`windows`。没声明的能力，宿主给的是 `None` 句柄。
- `views[].frontend: "assets"` 表示用插件自带前端（`plugins/<id>/fe`）。

## 4. 搜索与执行语义

| 阶段 | 你的代码 | 注意 |
| :--- | :--- | :--- |
| `query()` | 返回候选/面板数据 | **逐键调用且默认无防抖**；要每键查外部索引的（如 `/find`）声明 `command.queryDebounceMs` |
| 网络请求 | 放在 `onSelect` | `query` 里发请求等于边打字边打 API；结果按输入缓存，完成后返回 `refresh` |
| `execute()` | 回车执行 | 返回 `ActionResult`（复制/打开/通知等） |
| `onSelect` | 打开窗口、抓取数据 | 幂等：同一项重复触发不应产生副作用 |

面板数据统一是 `PanelData`；壳层不识别具体插件类型，也不做特判。插件不要假设自己
能拿到原始按键流——热键走 `ctx.shortcuts.on(accel, cb)`，默认只在主窗口生效，
视图窗口内响应要显式 `{ scope: 'any' }`。

## 5. 视图窗口

- 卡片式：`decorated:false` + `auto_height` + `max_height`，前端套 `PopupFrame`，
  内容自然高度上报给宿主（`ctx.windows.setContentSize({ height })`）。
- 定尺寸：`fill` 模式，窗口大小归用户，标题/状态栏钉死，长内容只滚内容区。
- 重复打开声明 `on_existing: "focus"`；`svc.window.open` 只能打开 manifest 里声明过的 `views`。

## 6. 测试

```powershell
npm run plugin:test:fe                                   # kind:none，直跑逻辑断言
npm run plugin:test                                      # llp，逐个 initialize/search/execute
cargo test --manifest-path plugins/<id>/be/Cargo.toml    # native 业务逻辑
cargo check --manifest-path plugins/<id>/native/Cargo.toml
build.cmd check                                          # 全仓
```

再加一次真实冒烟：`npm run tauri dev` → 输入指令 → 执行 → 开窗口 → 关闭。
`plugin:test:fe` 只断言计算结果，不覆盖窗口与热键。

## 7. 分发

```powershell
npm run plugin:install -- <id>                # 装到用户目录 extplugins/
npm run plugin:install -- <id> --portable     # 装到 release/plugins/，随包分发
npm run plugin:install -- --all               # 安装全部 llp/none 插件
```

- 加载优先级：`extplugins/` > 便携目录（同名取前者）。
- 卸载 = 删除对应目录。
- `none` 插件代码已在前端包里，安装只拷 `manifest.json`。

## 8. 常见坑

| 现象 | 原因 |
| :--- | :--- |
| 输入指令无反应 | 忘了 `npm run gen`，或 `fe/package.json` 缺 `"llplugin": true` |
| 调用报"未声明权限" | manifest `permissions` 缺对应条目 |
| 重启后插件消失 | `backend.entry` 文件名不匹配当前平台，或 integrity 与 dll 不一致 |
| 输入很卡 | `query()` 里做了重活/网络请求；改用 `onSelect` + 缓存 + `queryDebounceMs` |
| 窗口没有标题栏又不能拖 | 忘了套 `PopupFrame`（`decorated:false` 只是去掉系统标题栏） |
