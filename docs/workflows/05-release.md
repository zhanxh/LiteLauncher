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
4. 预检更新签名私钥（先试签，再把签名里的 key id 与 `pubkey` 对账）；
5. 构建：`windows` job 跑 `build.cmd ship`，`linux` job 跑 `SHIP_BUNDLES=deb,appimage ./build.sh ship`；
6. 每个平台 `node tools/make-latest-json.mjs --platform <平台>` 生成清单片段（windows job
   另把 `release/plugins` 打包成 `plugins.zip`），产物与片段一起上传为 artifact；
7. 两个平台都成功后，`release` job 用 `node tools/merge-latest-json.mjs` 合成一份
   `latest.json`（缺任一平台直接失败，避免那台机器从此收不到更新），等 tag 收敛后
   一次性创建 GitHub Release 并附上全部资产。

## 5. 发布后抽查

- [ ] Release 页面有 `LiteLauncher.exe`、`plugins.zip`、`latest.json`、NSIS 安装包、
      `.deb` 与 `.AppImage`（+ 更新用的 `.AppImage.tar.gz` 和两份 `.sig`）
- [ ] 安装包在干净机器可装可启动（不要求 Python，纯前端插件已编进前端包）
- [ ] `latest.json` 同时有 `windows-x86_64` 与 `linux-x86_64`：前者的 `url` 指向
      `*-setup.exe`、后者指向 `*.AppImage.tar.gz`，`signature` 都是同名 `.sig` 全文
- [ ] 旧版本客户端能检测到新版本并完成更新（Linux 只有 `.AppImage` 那份能自动更新，
      `.deb` 装的会因 payload 不是 deb 而报 `InvalidUpdaterFormat`，需手动重装）
- [ ] 需要时把 `release/plugins` 部署到目标机 `~/.local/share/LiteLauncher/extplugins/`（`.deb` 不含外部插件）

## 6. 回滚

1. 把 `latest.json` 指回上一个版本的安装包与签名（每个平台各一条），重新上传到 Release 资产；
2. 不删除 tag 与安装包，保留可追溯记录；
3. 需要撤销功能时，发一个更高的修订版本（patch），而不是改写已发布的历史。

## 7. 平台差异

| 平台 | 命令 | 产物 |
| :--- | :--- | :--- |
| Windows | `build.cmd ship` | NSIS 安装包 + updater `.exe`/`.sig` + 便携 exe |
| Linux | `SHIP_BUNDLES=deb,appimage ./build.sh ship`（日常不带该变量时只打 `.deb`） | `bundle/deb/*.deb`、`bundle/appimage/*.AppImage` 与 updater 用的 `*.AppImage.tar.gz`(+`.sig`) |

Linux 的更新载体只能是 AppImage：Tauri 的 updater 在 Linux 上只认 AppImage，`.deb` 不是载体，
所以 `latest.json` 的 `linux-x86_64.url` 指向 `.AppImage.tar.gz`；`.deb` 供人工 `apt` 安装。
`.deb` 只含主程序，`Depends` 是 Tauri 探模块写的短列表；新接原生依赖时要重跑
`ldd` 与 `Depends` 闭包对账（完整脚本见根 `README.md`）。

CI 的 `linux` job 跑在 `debian:bookworm` 容器里（宿主 `ubuntu-24.04`），而不是直接用
Ubuntu runner 镜像，两个原因叠在一起：`xcap → libspa-sys` 要 pipewire ≥ 0.3.6x 的头文件，
jammy 最高只有 0.3.48（编译期缺 `spa_meta_first` / `spa_video_info_raw.flags`），noble 能编
但把 glibc 抬到 2.39，产物连开发机（Debian 12，glibc 2.36）都跑不起来、更新链路无从自测。
bookworm 同时满足两点；容器里 `apt` 直接以 root 跑（无 sudo），且因为不挂 `/dev/fuse`，
必须给 job 设 `APPIMAGE_EXTRACT_AND_RUN=1`，否则 linuxdeploy/appimagetool 自己就起不来。
