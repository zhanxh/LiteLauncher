# 版本与发布约束

> 版本号只有一个真相源：`package.json` 的 `version`。
> 发布只有一个入口：打 `v*` tag 触发 `.github/workflows/release.yml`。

## 一、版本号

- 遵循 SemVer；`src-tauri/tauri.conf.json` 的 `version` 由脚本同步，**不手改**。
- 日常校验：`npm run version:check`（CI 与 release 都会跑）；
  需要修正时：`npm run version:sync`。
- 版本号变更属于发布动作，不随功能提交零散修改。

## 二、发布前

- [ ] `CHANGELOG.md` 的 `[Unreleased]` 已整理成本版本的条目（每次修改累积而来）
- [ ] `npm run version:check` 通过
- [ ] `build.cmd check` 通过（Windows 主目标平台）
- [ ] 至少一次 `npm run tauri dev` 冒烟，覆盖本次改动的用户路径
- [ ] 更新源配置齐全：仓库 Variable `TAURI_UPDATER_PUBKEY`、
      Secrets `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`（见 [分发手册](../../guides/distribution.md)）

## 三、产物清单

| 产物 | 位置 | 说明 |
| :--- | :--- | :--- |
| 便携 exe | `release/LiteLauncher.exe` | 仍需旁边有 `plugins/` |
| 便携插件 | `release/plugins/`（Release 里打包为 `plugins.zip`） | 外部插件随包分发 |
| NSIS 安装包 | `src-tauri/target-ship/release/bundle/nsis/*.exe` | `build.cmd ship` |
| 更新包 | 同目录 `*.nsis.zip` + `.sig` | Tauri updater artifacts |
| 更新清单 | `latest.json` | `tools/make-latest-json.mjs` 生成 |

## 四、发布

1. 提交并推送 `main`/`master`，确认 CI 绿；
2. `git tag v<version>` → `git push origin v<version>`；
3. Release 工作流校验 tag 与 `package.json` 一致（不一致直接失败），再构建并上传；
4. 发布后抽查：安装包可装、`latest.json` 指向的 zip 可下载、更新检查能读到新版本。

## 五、回滚

- 客户端更新走 `latest.json`：把该文件指回上一个版本并重新上传，即可停止扩散。
- 安装包与 tag **不删除**：保留可追溯的发布记录；需要撤销时发一个更高的修订版本。
- 插件随包分发，回滚安装包同时回滚插件；用户目录下的外部插件（`extplugins/`）不随包回滚。
