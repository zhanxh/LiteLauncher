# ⚡ LiteLauncher (v3.0)

> **基于 Tauri 2 + SolidJS + SQLite (FTS5) 的下一代生产力启动器（Launcher）**
> **核心理念：** Command-First, Window-as-Context, Plugin-Driven

---

## 📖 架构概览

搜索框作为启动器的唯一交互入口，所有功能均降级为"插件/指令"，窗口从"固定面板"变为"按需弹出的上下文容器"。

```mermaid
flowchart TD
    A["全局快捷键 (Alt+Space / Alt+X)"] --> B["主搜索框 (居中/置顶/无边框)"]
    B --> C{"DSL 指令分词与解析器"}
    C -->|"Action 命令 (如 /todo new)"| D["实时语义胶囊 + 回车直接执行"]
    C -->|"Query 命令 (如 /note)"| E["展开结果面板"]
    C -->|"数学算式 (如 12 * 85)"| F["即时计算胶囊 + 回车复制"]
    C -->|"普通文本"| G["本地应用 / 系统命令 / 网络搜索"]
    E -->|"回车选择笔记"| H["弹出独立 Markdown 编辑窗口 (Ctrl+S 保存)"]
    E -->|"回车选择应用"| I["外部启动程序并自动隐藏启动器"]
    D --> J["SQLite 数据库持久化"]
    H --> K["磁盘原生 .md 文件"]
```

**进程模型**：单实例常驻（系统托盘），关闭窗口仅隐藏、退出走托盘菜单"退出"。主窗口按内容高度动态伸缩（70px 搜索条 ↔ 最多 640px 面板），失焦自动隐藏（带 1.5s 启动保护期）。

---

## ⌨️ 快捷键速查

| 快捷键 | 作用范围 | 功能说明 |
| :--- | :--- | :--- |
| **`Alt + Space`** | 全局 | 唤起 / 隐藏 LiteLauncher 主搜索框 |
| **`Alt + X`** | 全局 | 备选热键（系统 Alt+Space 被占用时的容错方案） |
| **`Enter` (回车)** | 主搜索框 | 执行即时命令 / 补全候选指令 / 选择当前高亮项 |
| **`Esc`** | 主搜索框 | 若有文本优先清空；文本为空时隐藏主窗口 |
| **`Esc`** | 笔记编辑器 | 关闭编辑器窗口 |
| **`↑ / ↓`** | 结果面板 | 在列表项之间快速切换选择高亮 |
| **`Ctrl + S`** | 独立编辑器 | 立即保存当前 Markdown 文件并增量更新 SQLite 索引 |
| **`F12`** | 任意窗口 | 打开 / 关闭 DevTools（开发调试用） |

---

## 🚀 指令系统

### 1. 应用启动 (`/app`)
- **Query 模式**：输入 `/app` 或 `/app [关键字]` 过滤系统应用，敲击回车直接唤起程序并自动隐藏启动器。
- **Action 模式**：输入 `/app add "应用名称" "可执行路径"`，实时预览胶囊，回车持久化保存至捷径库。
- **拼音简写**：支持直接输入 `jsq`（计算器）、`jsb`（记事本）智能推荐。

### 2. 待办日程 (`/todo`)
- **Action 即时添加**：
  - `/todo new "下午技术周会" 14:30` → 今天 14:30 提醒。
  - `/todo new "周报撰写" fri 09:00` → 周五 09:00。
  - `/todo new "晨会" daily 08:30` → 每天 08:30。
  - 实时解析出内容与提醒标签，敲击回车直接写入 SQLite，Toast 提示并清空输入框。
- **Query 列表管理**：
  - 输入 `/todo` 展开待办列表（未完成置顶），回车一键切换已完成/待办状态。

### 3. Markdown 笔记 (`/note`)
- **文件原生优先**：
  - 默认管理目录：`%USERPROFILE%\Documents\LiteNotes`。
  - 启动时自动增量比对文件 `mtime`，提取标题与纯文本摘要写入 SQLite FTS5 全文索引库。
  - 数据库不存储正文，正文始终为磁盘原生文件。
- **双窗口协作**：
  - 输入 `/note [关键字]` 极速全文检索与摘要高亮。
  - 敲击回车弹出独立 Markdown 编辑器窗口（双栏编辑实时预览、`Ctrl+S` 原生保存、`Esc` 关闭）。
  - 编辑器窗口按文件路径去重：同一篇笔记重复打开只会聚焦既有窗口。

### 4. 辅助指令与计算
- **帮助指南**：`/help` 查看所有已注册指令与语法。
- **实时计算器**：输入任意算术表达式（如 `12 * 85 + 3.14`），实时展现计算结果，回车一键复制。
- **无斜杠直达**：输入 `todo`、`note`、`app` 自动智能映射到对应指令。
- **模糊容错**：输入 `/not`、`/notes` 等前缀会推荐 `/note` 候选，回车一键补全。

---

## 🛠️ 本地开发与构建

### 1. 环境准备
- **Node.js**：`v24+`
- **Rust**：`1.99+`（stable）
- **Windows 构建工具**：二选一
  - MSVC 工具链：Visual Studio 2022 C++ 构建工具（官方默认路径），或
  - GNU 工具链：`rustup default stable-x86_64-pc-windows-gnu` + 完整 MinGW binutils/gcc（无需管理员权限）

### 2. 启动开发模式
```powershell
# 启动 Tauri 开发调试服务器（前端 Vite + Rust 增量编译）
npm run tauri dev
```

### 3. 生产打包构建
```powershell
# 方式一：一步完成（前端打包 + Rust release 编译 + 拷贝到 release\LiteLauncher.exe）
build.cmd

# 方式二：等价的显式命令
npm run build
npx tauri build --no-bundle
copy /Y src-tauri\target\release\tauri-app.exe release\LiteLauncher.exe
```

> ⚠️ **注意**：请使用 `npx tauri build`（或 `build.cmd`）打包，不要直接用 `cargo build --release`。
> 后者不会启用 `custom-protocol` 特性，产出的 exe 会去连 `localhost:1420` dev server，导致窗口白屏或"localhost 拒绝连接"。

### 4. 排障日志
- `lifecycle.log`：生成在 exe 同目录，记录窗口事件、IPC 调用与前端 console 转发，排障首选。

---

## 📦 技术栈

| 层 | 技术 | 说明 |
| :--- | :--- | :--- |
| 桌面框架 | Tauri 2 | 无边框窗口、系统托盘、全局快捷键、多窗口 |
| 前端 | SolidJS + TypeScript + Vite | 响应式 UI，无虚拟 DOM |
| 后端 | Rust + rusqlite (bundled) | SQLite + FTS5 全文索引 |
| 存储 | 磁盘原生文件 + SQLite | 笔记正文永在磁盘，库只存索引 |

---

## 📄 License

MIT
