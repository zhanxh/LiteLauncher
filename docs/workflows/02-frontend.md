# 02 前端（SolidJS 壳层）

## 1. 边界

| 区域 | 位置 | 谁能 import 谁 |
| :--- | :--- | :--- |
| 壳层 | `src/` | 只能通过 `@ll/sdk` 消费插件产物，**永不 import 具体插件实现** |
| SDK | `plugins/sdk/src/` | 插件唯一允许依赖的壳层包 |
| 共享 UI | `plugins/ui/src/` | 插件可用的通用组件（如 `PopupFrame`） |
| 插件前端 | `plugins/<id>/fe/src/index.ts` | **只允许 import `@ll/sdk` 与 `solid-js`**（及 `@ll/ui`） |

壳层是"搜索框 + 结果面板 + 窗口生命周期 + 通用动作"，具体指令一律是插件。
新增功能时先问：这是壳层职责（窗口/焦点/键盘/IPC 通道）还是插件职责？默认插件。

## 2. 目录职责

| 路径 | 职责 |
| :--- | :--- |
| `src/App.tsx` | 主窗口装配：搜索框、结果面板、焦点与高度联动 |
| `src/components/` | 壳层组件（`SearchBar`、`ResultPanel`、`PreviewCapsule`、`SettingsPanel`、`Toast`、`WelcomePanel`） |
| `src/core/tokenizer.ts` `parser.ts` | DSL 分词与指令解析（`/cal new ...`） |
| `src/core/fuzzy.ts` | 模糊匹配与候选排序 |
| `src/core/externalPlugins.ts` | LLP/native 插件的前端注册（统一 `plugin_call` 通道） |
| `src/core/builtin*.ts` | 壳层自带指令（`/help`、`/setting`） |
| `src/plugins.generated.ts` | **生成文件**：`npm run gen` 扫描 `plugins/*/fe` 产出 |
| `src/theme.ts`、`src/styles/` | 主题令牌与全局样式 |

## 3. Solid 的三条硬规则

1. **不要解构 props**：`const { item } = props` 会切断响应性；用 `props.item`。
2. 派生用 `createMemo`，副作用用 `createEffect`；不要照搬 React 的依赖数组语义。
3. 列表渲染用 `<For>`，条件用 `<Show>`；不要在 JSX 里做重计算（放 `createMemo`）。

类型：`strict` + `noUnusedLocals/Parameters` 已开。外部数据先进 `unknown` 再收窄，
不要用 `any` 让类型检查通过。

## 4. 插件前端注册链路

```
plugins/<id>/fe/package.json  ("llplugin": true, "main": "src/index.ts")
        │  npm run gen（predev / prebuild 自动执行）
        ▼
src/plugins.generated.ts  →  registerBuiltinPlugins()
        ▼
壳层启动时调用 setup() → 插件把指令注册进 registry
```

- 新增插件后忘记 `npm run gen`，症状是"指令不存在"；`npm run dev/build` 会自动补。
- **不要手改** `src/plugins.generated.ts`，它每次构建都会重写。
- 外部插件（`llp`/`native`）不走这条链路：宿主扫描后由 `externalPlugins.ts` 按 manifest 生成通用指令。

## 5. 窗口与交互

- 主窗口按内容高度伸缩（70px ↔ 最多 640px），失焦自动隐藏，带 1.5s 启动保护期。
- 视图窗口统一走"通用基窗"：`decorated:false` + `auto_height` + `max_height`，
  前端套 `PopupFrame`；标题栏可拖、内容区滚动、状态栏常驻。
- 物理/逻辑像素换算与四角锚定**只在宿主做**，前端不要自己量屏幕拼坐标。
- 按键：`Enter` 执行、`Ctrl/Shift/Alt+Enter` 次级动作、`Esc` 清空/隐藏、`↑/↓` 选择。
  新增动作要同时更新底部动作条提示，否则用户发现不了。

## 6. 验证

```powershell
npm run check                      # 类型先行（最快）
npm run build                      # 确认打包期没有解析/生成问题
npm run tauri dev                  # 真实窗口冒烟
```

手测清单（每次涉及交互都过一遍）：

- [ ] 唤起 → 输入 → 候选出现 → `↑/↓` 选择 → `Enter` 执行
- [ ] `Esc` 有文本先清空，无文本才隐藏
- [ ] 失焦隐藏，但启动后 1.5s 内不失焦
- [ ] 面板高度随内容变化，长内容只滚内容区
- [ ] 亮/暗主题切换后无残留硬编码颜色
- [ ] 无效输入不崩、给出可行动提示

## 7. 调试

- `F12` 打开 DevTools（开发构建启用）。
- `LL_LOG=debug` 后重启，`lifecycle.log` 会记录窗口尺寸、焦点、IPC；
  前端 `console` 也会进日志（发布版默认 `info`，不会污染）。
- 白屏优先怀疑：dev server 未起（1420 被占）、`node_modules` 不完整、
  以及是否误用了 `cargo build --release`。
