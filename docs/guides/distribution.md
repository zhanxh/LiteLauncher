# 分发、签名与自动更新（WP-11 / WP-12）

## 构建产物

| 产物 | 位置 | 说明 |
|---|---|---|
| 便携 exe | `release/LiteLauncher.exe` | 仍需旁边有 `plugins/` |
| 便携插件 | `release/plugins/` | 可分发包；安装包会把它放到 `$INSTDIR/plugins` |
| NSIS 安装包 | `src-tauri/target-ship/release/bundle/nsis/*.exe` | `build.cmd ship` |
| deb 安装包 | `src-tauri/target-ship/release/bundle/deb/*.deb` | `./build.sh ship`（不是更新载体） |
| AppImage | `src-tauri/target-ship/release/bundle/appimage/*.AppImage` | `SHIP_BUNDLES=deb,appimage ./build.sh ship`；Linux 的更新载体就是它本身 |
| 更新包 | NSIS 同目录 `*-setup.exe.sig`、AppImage 同目录 `*.AppImage.sig` | Tauri `createUpdaterArtifacts: true` |
| 更新清单 | `latest.json` | 各平台片段由 `make-latest-json.mjs` 生成，`merge-latest-json.mjs` 合成 |

`build.cmd ship` 会先部署 `release/plugins`，再执行 `tauri build --bundles nsis`，
所以安装包内的插件是当前版本（`bundle.resources` 映射）。

## 签名

```powershell
npx tauri signer generate -w "$env:USERPROFILE\.tauri\litelauncher.key"
```

- 公钥：填 GitHub 仓库 Variables `TAURI_UPDATER_PUBKEY`，或本地

  ```powershell
  node tools/release-config.mjs --owner your-name --repo LiteLauncher --pubkey "<公钥>"
  ```

- 私钥：只放 GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY`（内容或路径），密码放
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；**不要提交私钥**。
- 未配置公钥时，设置页检查更新会显示"更新源未配置"，不会崩。
- 没有代码签名证书时 SmartScreen 会拦安装包，这是预期；可先提供 SHA256 校验和。

## 自动更新

- 配置：`src-tauri/tauri.conf.json` → `plugins.updater.endpoints` / `pubkey`。
- 端点参数化：`node tools/release-config.mjs --owner <owner> --repo <repo>`。
- 客户端：启动 5 秒后每天最多静默检查一次；发现新版本只提示，不自动装。
  设置 → 关于 → 检查更新 / 下载并安装；安装后自动重启。
- 发布：打 `v*` tag 触发 `.github/workflows/release.yml`，两个平台各自构建、各自生成清单片段，
  最后由 `release` job 合成 `latest.json` 并一次性上传 NSIS、deb、AppImage、签名、便携插件 zip。

## 平台

Windows 走 NSIS 安装包更新；Linux 走 AppImage（Tauri 的 updater 在 Linux 上只认 AppImage，
`.deb` 只能人工 `apt` 装，不进清单）。清单里的 `linux-x86_64.url` 指向 `.AppImage` 本体
——v2 的 `createUpdaterArtifacts` 签的就是它，v1 时代的 `.AppImage.tar.gz` 已经不生成；
客户端 `install_appimage` 两种 payload 都收（gzip 就解 tar 取里面的 AppImage，ELF 就直接覆写）。
updater 按二进制的 bundle type 分派安装方式：deb 装的客户端会把这份 AppImage 当 deb 包校验，
报 `InvalidUpdaterFormat` —— **deb 用户只能手动重装，要自动更新就得跑 `.AppImage`**。
配置里保留 `msi` 目标，但 CI 默认只跑 `nsis`（MSI 需要 WiX，不阻塞主路径）。macOS 暂未接入。
