// 安装外部插件：把 plugins/<id> 拷贝到宿主扫描目录，拷入即安装。
// 用法：
//   npm run plugin:install -- sysinfo             → 用户安装目录 extplugins/（同名优先）
//   npm run plugin:install -- sysinfo --portable  → 便携目录 release/plugins/（随程序分发）
//   npm run plugin:install -- --all               → 安装全部 backend.kind ∈ {llp, none} 的插件
//   npm run plugin:install                        → 等同于 --all
// 卸载：直接删除对应目录。宿主加载顺序：extplugins > 便携目录（同名取前者）。
//
// 两种外部形态：
//   llp  —— 脚本随包分发，拷贝整个插件目录
//   none —— 纯前端插件，代码已编译进应用包，**只需部署 manifest.json**
//           （宿主据此注册插件，权限门控与设置面板的启用/禁用都依赖它）
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const arg = process.argv[2];
const portable = process.argv.includes("--portable");
const installAll = !arg || arg === "--all";

const pluginsRoot = path.resolve("plugins");
const EXTERNAL_KINDS = new Set(["llp", "none", "native"]);

function resolveDest(id) {
  if (portable) {
    // 便携模式：主程序旁 plugins/（本仓库布局为 release/plugins，随 release/ 一起分发）
    return path.resolve("release", "plugins", id);
  }
  // 与宿主 db::extplugins_dir() 对齐（dirs::data_local_dir()/LiteLauncher/extplugins）：
  // Windows = %LOCALAPPDATA%，macOS = ~/Library/Application Support，Linux = XDG_DATA_HOME 或 ~/.local/share
  let dataHome;
  if (process.platform === "win32") {
    dataHome = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  } else if (process.platform === "darwin") {
    dataHome = path.join(os.homedir(), "Library", "Application Support");
  } else {
    dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
  }
  return path.join(dataHome, "LiteLauncher", "extplugins", id);
}

function listExternalPluginIds() {
  return readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => existsSync(path.join(pluginsRoot, id, "manifest.json")))
    .filter((id) => {
      try {
        const m = JSON.parse(readFileSync(path.join(pluginsRoot, id, "manifest.json"), "utf8"));
        return EXTERNAL_KINDS.has(m.backend?.kind);
      } catch {
        return false;
      }
    })
    .sort();
}

function installOne(id) {
  const src = path.join(pluginsRoot, id);
  const manifestPath = path.join(src, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`  ✗ ${id}: 未找到 ${manifestPath}`);
    return false;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const kind = manifest.backend?.kind;
  if (!EXTERNAL_KINDS.has(kind)) {
    console.error(`  ✗ ${id}: backend.kind=${kind} 非外部插件形态，编译期内置无需安装`);
    return false;
  }
  const dest = resolveDest(id);
  mkdirSync(path.dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true }); // 重装 = 覆盖
  if (kind === "none") {
    mkdirSync(dest, { recursive: true });
    cpSync(manifestPath, path.join(dest, "manifest.json"));
    console.log(`  ✓ ${id}@${manifest.version}（纯前端：代码已在应用包内，仅部署 manifest） → ${dest}`);
  } else {
    cpSync(src, dest, { recursive: true });
    console.log(`  ✓ ${id}@${manifest.version} → ${dest}`);
  }
  return true;
}

if (!installAll) {
  const ok = installOne(arg);
  process.exit(ok ? 0 : 1);
}

const ids = listExternalPluginIds();
if (ids.length === 0) {
  console.log("[install] 未发现任何 backend.kind ∈ {llp, none} 的插件");
  process.exit(0);
}
console.log(`[install] 安装 ${ids.length} 个外部插件${portable ? "（便携，随程序分发）" : "（用户安装）"}：`);
let failed = 0;
for (const id of ids) {
  if (!installOne(id)) failed += 1;
}
console.log(`[install] 完成 ${ids.length - failed}/${ids.length}；重启 LiteLauncher 后生效，设置面板可启用/禁用`);
process.exit(failed > 0 ? 1 : 0);
