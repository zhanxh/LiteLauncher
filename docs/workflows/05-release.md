# 05 发布

> 约束（版本真相源、产物清单、回滚）见 [版本与发布规范](../standards/business/versioning-release.md)；
> 签名与更新源的细节见 [分发手册](../guides/distribution.md)。

## 0. 一次性准备

仓库配置齐全后，发布流程才跑得通：

| 配置 | 类型 | 用途 |
| :--- | :--- | :--- |
| `TAURI_UPDATER_PUBKEY` | Actions Variable | 客户端校验更新包签名 |
| `TAURI_SIGNING_PRIVATE_KEY` | Actions Secret | CI 给产物签名 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Actions Secret | 私钥口令 |

本地只需保证 `npm run version:check` 与 `build.cmd check` 能跑通。

## 1. 定版本

```powershell
# 1) 改 package.json 的 version（唯一真相源）
# 2) 同步到 tauri.conf.json
npm run version:sync
npm run version:check
```

同一次提交里整理 `CHANGELOG.md`：把 `[Unreleased]` **整段**（含 `Internal`）归到
`## [<version>] - YYYY-MM-DD` 下，不要在发布时丢掉工程类条目。

## 2. 发布前验证

```powershell
npm run check            # 类型 + 编译
build.cmd check          # 全量自检（含插件单测）
npm run tauri dev        # 冒烟：覆盖本次改动的用户路径
```

可选但推荐：本地跑一次 `build.cmd ship`，确认 NSIS 产物能装、能启动。
（首次 ship 会在 `target-ship/` 全量重编，约 8~9G 磁盘。）

## 3. 提交与打标签

```powershell
git add -A
git commit -m "chore(release): v<version>"
git push origin master
git tag v<version>
git push origin v<version>
```

tag 与 `package.json` 不一致时，Release 工作流会在第一步直接失败——这是有意的。

## 4. CI 做了什么

`.github/workflows/release.yml`（`push` tag `v*` 触发）：

1. `npm ci` → `npm run version:check`；
2. 校验 tag 去 `v` 后与 `package.json` 一致；
3. `node tools/release-config.mjs` 写入 owner/repo/pubkey；
4. `build.cmd ship`（fat LTO + 1 CGU + NSIS + updater artifacts）；
5. `node tools/make-latest-json.mjs` 生成更新清单；
6. 打包 `release/plugins` 为 `plugins.zip`；
7. 创建 GitHub Release，附 exe、安装包、`.sig`、`latest.json`、`plugins.zip`。

## 5. 发布后抽查

- [ ] Release 页面有 `LiteLauncher.exe`、`plugins.zip`、`latest.json` 与 NSIS 安装包
- [ ] 安装包在干净机器可装可启动（不要求 Python，纯前端插件已编进前端包）
- [ ] `latest.json` 的 `url` 指向 `.nsis.zip`，`signature` 是 `.sig` 全文
- [ ] 旧版本客户端能检测到新版本并完成更新
- [ ] 需要时把 `release/plugins` 部署到目标机 `~/.local/share/LiteLauncher/extplugins/`（`.deb` 不含外部插件）

## 6. 回滚

1. 把 `latest.json` 指回上一个版本的 zip 与签名，重新上传到 Release 资产；
2. 不删除 tag 与安装包，保留可追溯记录；
3. 需要撤销功能时，发一个更高的修订版本（patch），而不是改写已发布的历史。

## 7. 平台差异

| 平台 | 命令 | 产物 |
| :--- | :--- | :--- |
| Windows | `build.cmd ship` | NSIS 安装包 + updater zip/sig + 便携 exe |
| Linux | `./build.sh ship` | 多一个 `.deb`，落在 `target-ship/release/bundle/deb/` |

Linux 的 `.deb` 只含主程序，`Depends` 是 Tauri 探模块写的短列表；新接原生依赖时要重跑
`ldd` 与 `Depends` 闭包对账（完整脚本见根 `README.md`）。
