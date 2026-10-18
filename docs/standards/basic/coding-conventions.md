# 编码与提交规范

> 目标是让改动在**构建期**就被发现，而不是在用户桌面上被发现。本项目的主程序
> `panic = "abort"`：宿主路径上的一次 panic 直接结束进程，没有 unwind 兜底。

## 一、TypeScript / SolidJS

- `tsconfig.json` 已开 `strict`、`noUnusedLocals`、`noUnusedParameters`：
  不允许用 `any` 逃逸；外部数据先 `unknown` 再收窄。
- Solid 的 props **不要解构**（解构会丢掉响应性）；派生状态用 `createMemo`，
  副作用用 `createEffect`，不要照搬 React 的 `useEffect` 依赖数组思维。
- 模块导入走别名：`@ll/sdk`（插件 SDK）、`@ll/ui`（共享 UI）、`@ll/plugin-*`（插件前端入口），
  与 `vite.config.ts`、`tsconfig.json` 的 `paths` 保持一致。
- 生成文件 `src/plugins.generated.ts` 由 `npm run gen` 产出，**不手改**。
- 样式：全局在 `src/styles/` 与 `App.css`，主题令牌走 `src/theme.ts`；插件自带样式留在插件内。
- 注释写**为什么**（约束、坑、取舍），不写"这行在赋值"。

## 二、Rust / 宿主

- Edition 2024，workspace resolver 2；crate 命名 `ll-<domain>`。
- **依赖方向是硬约束**（CI 与评审都按这条看）：
  - `plugins/*/be` 只能依赖 `ll-plugin-api` 与零平台依赖的通用库（serde / chrono / uuid / dirs / 文本类），
    **禁止**依赖 `ll-host`、`tauri` 或彼此 —— 保证插件能独立编译、独立演进；
  - `ll-host` **不得**依赖任何具体插件（注册方向：应用 crate → 插件 crate）；
  - 插件不进主程序的 `[workspace].members`，在 `exclude` 里，用各自 `plugins/<id>/native` 工程引用。
- 宿主路径避免 panic：不用 `panic!`/`expect` 处理可预期的外部输入；锁中毒式的
  `RwLock::unwrap()` 可以接受。面向用户的错误要能映射成可行动文案（缺 Python / 超时 / 权限不足）。
- 契约类型（manifest、ABI 结构体）改动视为**破坏性变更**：先写设计文档，再同步
  `plugins/sdk`、指南与 `api_version`。
- 提交前跑 `cargo check --workspace`（或 `build.cmd check`）；重要逻辑补 `#[cfg(test)]` 单测，
  插件业务逻辑的单测放 `plugins/<id>/be`，`cargo test --manifest-path plugins/<id>/be/Cargo.toml`。

## 三、插件

- 权限最小化：`permissions` 只写真正用到的那几条，`shortcut:<accel>` 逐条声明，没有通配。
- `query()` 是**逐键调用且无防抖**：网络请求一律放到 `onSelect`，结果按输入缓存，
  抓取完成后返回 `refresh`（见根 README「网络插件范式」）。
- 新增/重建 dll 后必须回填 `backend.integrity`（`node tools/update-plugin-integrity.mjs`），
  否则加载器会在启动时静默拒绝该插件。
- 交付前跑对应形态的测试：`npm run plugin:test:fe`（纯前端）、`npm run plugin:test`（LLP）、
  `cargo test --manifest-path plugins/<id>/be/Cargo.toml`（native 业务逻辑）。

## 四、提交与变更日志

- 提交信息用 Conventional Commits + 作用域，说明用中文写"做了什么"：

  ```
  feat(plugins): /find 与 /sysinfo 迁为 native 动态库
  fix(host): 内容尺寸读写统一为客户区
  docs(standards): 引入六步闭环与门禁
  chore(plugins): 按当前 dll 刷新 native 插件 integrity
  ```

  常用类型：`feat` / `fix` / `refactor` / `perf` / `docs` / `test` / `chore` / `build`。
- `CHANGELOG.md`：**每次提交都要在 `[Unreleased]` 记一行**——
  - 用户可感知的变化 → `Added` / `Changed` / `Fixed` / `Removed`；
  - 重构、注释、文档、CI、依赖升级 → `Internal`；
  - 一行说清"改了什么、影响哪里"，不贴实现细节；发布时整段移到版本号下。
  版本号遵循 SemVer，`package.json` 是单一真相源（`npm run version:sync` / `version:check`）。
  门禁：本次提交未修改 `CHANGELOG.md` 会被 `pre-commit` 拦截（merge/rebase 除外）。
- 一个提交只做一件事；格式化、重命名等噪声改动不要混进功能提交。

## 五、格式化

- 仓库当前没有独立的 lint/format 流水线（CI 只跑类型检查、构建与测试），
  所以**以所在文件的既有风格为准**：Rust 按 `cargo fmt` 默认风格书写，TS 沿用周边文件的
  引号、缩进与换行习惯。
- 不要为了"顺手格式化"制造大范围 diff —— 它会让评审无法看清真正的改动。
