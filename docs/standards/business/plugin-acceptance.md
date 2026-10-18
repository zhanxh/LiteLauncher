# 插件交付验收

> 适用于 `plugins/<id>/` 下的全部插件（native / llp / none）。
> 机械可查的项已尽量收进测试与 `gate-check.mjs`，其余靠本清单逐条确认。

## 一、结构与契约

- [ ] 目录为 `plugins/<id>/`，`id` 与 `trigger`（如 `/todo`）、目录名一致
- [ ] `manifest.json` 必填齐全：`id` `name` `version` `api_version` `trigger` `description`
      `permissions` `backend` `command`
- [ ] `api_version` 与宿主兼容（当前 `^1`）；契约变更需先写 `docs/design/` 设计文档
- [ ] `backend.kind` 选择正确：能纯前端算的用 `none`，需要进程内系统能力的用 `native`，
      需要任意运行时的用 `llp`；`builtin` 是遗留形态，不再新增
- [ ] `backend.entry` 按平台列出产物名（`["x.dll", "libx.so"]`），
      `backend.integrity` 由 `node tools/update-plugin-integrity.mjs` 回填，**不手写**

## 二、权限与安全

- [ ] `permissions` 最小化：只声明真正调用到的能力
- [ ] `shortcut:<accel>` 逐条声明，没有通配；热键冲突交给宿主仲裁
- [ ] `net:<host>` 精确到域名，不写 `*`；网络未通时应给出可行动提示
- [ ] 不读取与本插件无关的用户数据；凭据类信息不入库、不落日志
- [ ] `query()` 内**不发网络请求**（默认逐键调用、无防抖）；抓取放 `onSelect` 并按输入缓存；
      确需每键查外部索引的（如 `/find`）显式声明 `command.queryDebounceMs`

## 三、视图与交互

- [ ] `views[]` 只声明真正需要的窗口，`id` 稳定（外部深链与 `svc.window.open` 依赖它）
- [ ] 卡片式窗口声明 `decorated:false` + `auto_height` + `max_height`，用 `PopupFrame` 套壳
- [ ] 定尺寸窗口用 `fill` 模式；重复打开声明 `on_existing: "focus"`
- [ ] 内容超长时只有内容区滚动，标题栏/状态栏始终可见
- [ ] 主窗口之外的视图窗口若需响应热键，`ctx.shortcuts.on(accel, cb, { scope: 'any' })`

## 四、验证

| 形态 | 必跑命令 |
| :--- | :--- |
| 纯前端 `none` | `npm run plugin:test:fe` |
| 外部 `llp` | `npm run plugin:test`（可用 `LLP_PYTHON` 指定解释器） |
| native 业务逻辑 | `cargo test --manifest-path plugins/<id>/be/Cargo.toml` |
| native 全量编译 | `cargo check --manifest-path plugins/<id>/native/Cargo.toml` |
| 全仓 | `build.cmd check`（cargo check + tsc + 插件单测 + native crate 检查） |

- [ ] 至少完成一次**真实启动冒烟**：`npm run tauri dev` → 输入指令 → 执行 → 关闭窗口
- [ ] 卸载/禁用后宿主不报错（插件缺失时 `plugins.generated.ts` 与注册表要能自洽）

## 五、交付

- [ ] `CHANGELOG.md` 写了用户可感知的变化（新增指令、行为变更）
- [ ] 新增指令已同步文档：根 `README.md` 指令表、必要时 `docs/guides/plugin-development-guide.md`
- [ ] 插件目录内无临时文件、无 `target/`、无调试图片
