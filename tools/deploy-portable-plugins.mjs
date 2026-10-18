// 部署外部插件到便携目录 release/plugins/，使 release/ 构成完整可分发包：
//   LiteLauncher(.exe) + release/plugins/<id>/
// 覆盖两种外部形态：
//   llp  —— 拷贝整个插件目录（manifest + sidecar 脚本）
//   native —— 拷贝整个插件目录（manifest + 动态库 + 资产），剔除 native/ 源码目录
//   none —— 纯前端插件：代码已编译进应用包，只部署 manifest.json
//          （宿主据此注册插件，权限门控与设置面板的启用/禁用都依赖它）
// 由 build.sh / build.cmd 在构建末尾自动调用，也可手动执行：
//   node tools/deploy-portable-plugins.mjs
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const srcRoot = path.join(root, "plugins");
const destRoot = path.join(root, "release", "plugins");
const EXTERNAL_KINDS = new Set(["llp", "none", "native"]);
// Windows 上"删不掉"是常态而非事故：EPERM/EBUSY 都可能来自占用，只读属性也报 EPERM。
const OCCUPIED = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

function rmdir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
}

function clearReadonly(dir) {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, dirent.name);
    try {
      if (dirent.isDirectory()) {
        chmodSync(p, 0o755);
        clearReadonly(p);
      } else {
        chmodSync(p, 0o644);
      }
    } catch {}
  }
}

// 清空目标目录，返回是否真的清空了。删不掉的两种成因：
//   1. 宿主以插件目录为子进程 cwd（llp.rs 的 current_dir），进程活着时该目录不可删除；
//      番茄钟这类常驻挂件尤其明显。
//   2. 旧文件带只读属性，Windows 拒绝 unlink。
// 情况 2 清掉属性就能删；情况 1 只能等进程退出，脚本不该因此中断整个构建。
function resetDir(dir) {
  if (!existsSync(dir)) return true;
  try {
    rmdir(dir);
    return true;
  } catch (err) {
    if (!OCCUPIED.has(err.code)) throw err;
  }
  try {
    chmodSync(dir, 0o755);
    clearReadonly(dir);
    rmdir(dir);
    return true;
  } catch (err) {
    if (!OCCUPIED.has(err.code)) throw err;
    return false;
  }
}

if (!existsSync(srcRoot)) {
  console.error("[deploy-plugins] 未找到 plugins/ 目录");
  process.exit(1);
}
mkdirSync(destRoot, { recursive: true });

let deployed = 0;
for (const dirent of readdirSync(srcRoot, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;
  const manifestPath = path.join(srcRoot, dirent.name, "manifest.json");
  if (!existsSync(manifestPath)) continue;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const kind = manifest.backend?.kind;
  if (!EXTERNAL_KINDS.has(kind)) continue; // 编译期内置插件：无部署物

  const dest = path.join(destRoot, dirent.name);
  if (!resetDir(dest)) {
    console.warn(`[deploy-plugins] ${dirent.name}：旧目录删不掉（LiteLauncher 大概率正在运行），改为就地覆盖；如需干净副本请退出宿主后手动删除 release/plugins/${dirent.name}`);
  }
  if (kind === "none") {
    mkdirSync(dest, { recursive: true });
    cpSync(manifestPath, path.join(dest, "manifest.json"));
    console.log(`[deploy-plugins] ${manifest.id}@${manifest.version}（纯前端，仅 manifest） → ${path.relative(root, dest)}`);
  } else {
    cpSync(path.join(srcRoot, dirent.name), dest, { recursive: true });
    if (kind === "native") {
      // native 插件只分发产物：根级 manifest + 动态库 + fe/ + assets/ + bin/；
      // 源码目录（native/ 独立工程、be/ 复用源）一律留在仓库。
      // bin/ 必须保留：/find 的 Everything64.dll 就装在那里（丢了它便携版直接不可用）。
      rmSync(path.join(dest, "native"), { recursive: true, force: true });
      for (const ent of readdirSync(dest, { withFileTypes: true })) {
        if (ent.isDirectory() && !["fe", "assets", "bin"].includes(ent.name)) {
          rmSync(path.join(dest, ent.name), { recursive: true, force: true });
        }
      }
    }
    console.log(`[deploy-plugins] ${manifest.id}@${manifest.version} → ${path.relative(root, dest)}`);
  }
  deployed += 1;
}

console.log(`[deploy-plugins] 完成：${deployed} 个外部插件已部署到 release/plugins/`);
