#!/usr/bin/env node
/**
 * 提交门禁（工具无关）——验证"已建档"与"已做方案设计"。
 *
 * 检查项：
 *   --check-active   存在有效任务绑定（默认）
 *                    绑定有效 = 计划文件存在，且（绑定 in_progress 或 计划状态行未完成）
 *   --check-design   方案设计门禁（硬拦）
 *                    本次提交新增 `plugins/<id>/`（sdk/ui 除外）或
 *                    `src-tauri/crates/<crate>/` 时，必须同时新增 `docs/design/` 文档
 *   --check-changelog 变更日志门禁：本次提交必须包含 `CHANGELOG.md`
 *                    （merge/rebase/cherry-pick 与无暂存改动时跳过）
 *
 * 退出码：0 = 放行，1 = 拦截
 * 降级：  GATE_SKIP=1 跳过全部检查（显式留痕）
 *
 * 依据：docs/standards/basic/plan-workflow.md、design-workflow.md
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTEXTS_DIR = ".agent/contexts";
const PLANS_DIR = "docs/plans";
const DONE_MARKS = ["✅", "✔", "已完成", "已实施完成", "已归档"];
const IGNORED_PLUGIN_DIRS = new Set(["sdk", "ui"]);

const abs = (p) => path.join(ROOT, p);
const has = (p) => fs.existsSync(abs(p));

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function planState(file) {
  if (!has(file)) return "missing";
  const m = fs.readFileSync(abs(file), "utf8").match(/^\*\*状态\*\*[:：]\s*(.+)$/m);
  if (!m) return "unknown";
  return DONE_MARKS.some((s) => m[1].includes(s)) ? "done" : "active";
}

function readBinding(file) {
  const data = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
      v = v.slice(1, -1);
    }
    data[m[1]] = v;
  }
  return data;
}

function bindings() {
  const dir = abs(CONTEXTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => ({ stem: f.replace(/\.yaml$/, ""), ...readBinding(path.join(dir, f)) }))
    .sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
}

function admits(b) {
  const plan = (b.plan || "").trim();
  if (!plan || !has(plan)) return false;
  if ((b.status || "in_progress") === "in_progress") return true;
  return planState(plan) === "active";
}

function checkActive() {
  const list = bindings();
  if (!list.length) {
    console.log("[gate] ❌ 没有任务绑定（.agent/contexts/ 为空）");
    console.log("[gate]   1) 创建 docs/plans/<YYYYMMDD_HHMMSS>_<slug>.md 与同名任务");
    console.log("[gate]   2) npm run task:auto -- docs/plans/<file>.md");
    console.log("[gate]   规则见 docs/standards/basic/plan-workflow.md");
    return false;
  }
  for (const b of list) {
    if (admits(b)) {
      const head = b === list[0] ? "（主上下文）" : "";
      console.log(`[gate] ✅ 任务绑定有效${head} · ${b.stem} · ${b.plan}`);
      return true;
    }
    const why = !b.plan ? "未指向计划" : !has(b.plan) ? `计划不存在 ${b.plan}` : "已关闭且计划已完成";
    console.log(`[gate]   绑定 ${b.stem}: ${why}`);
  }
  const active = fs.existsSync(abs(PLANS_DIR))
    ? fs.readdirSync(abs(PLANS_DIR)).filter((f) => f.endsWith(".md") && planState(`${PLANS_DIR}/${f}`) !== "done")
    : [];
  console.log("[gate] ❌ 没有有效绑定（全部已关闭或指向无效计划）");
  console.log(`[gate]   进行中的计划: ${active.join(", ") || "（无）"}`);
  console.log("[gate]   运行: npm run task:auto -- docs/plans/<file>.md");
  return false;
}

function stagedAdded() {
  const out = git(["diff", "--cached", "--name-status", "--diff-filter=A"], { allowFail: true });
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t").at(-1))
    .filter(Boolean);
}

function trackedUnder(dir) {
  const out = git(["ls-tree", "-r", "--name-only", "HEAD", "--", dir], { allowFail: true });
  if (!out) return [];
  return out.split(/\r?\n/).filter(Boolean);
}

function gitDir() {
  const out = git(["rev-parse", "--git-dir"], { allowFail: true });
  return out ? path.resolve(ROOT, out.trim()) : null;
}

function inProgressOperation(dir) {
  const files = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
  const dirs = ["rebase-merge", "rebase-apply"];
  return files.some((f) => fs.existsSync(path.join(dir, f))) || dirs.some((d) => fs.existsSync(path.join(dir, d)));
}

function checkChangelog() {
  const dir = gitDir();
  if (dir && inProgressOperation(dir)) {
    console.log("[gate] （merge/rebase/cherry-pick 进行中，跳过变更日志检查）");
    return true;
  }
  const staged = (git(["diff", "--cached", "--name-only"], { allowFail: true }) || "")
    .split(/\r?\n/)
    .filter(Boolean);
  if (!staged.length) {
    console.log("[gate] （无暂存改动，跳过变更日志检查）");
    return true;
  }
  if (staged.includes("CHANGELOG.md")) {
    console.log("[gate] ✅ CHANGELOG.md 已随本次提交更新");
    return true;
  }
  console.log("[gate] ❌ 本次提交没有更新 CHANGELOG.md");
  console.log("[gate]   在 [Unreleased] 记一行：用户可感知 → Added/Changed/Fixed/Removed，其余 → Internal");
  console.log("[gate]   规则见 docs/standards/basic/coding-conventions.md §四");
  return false;
}

function newRiskModules(files) {
  const candidates = new Set();
  for (const file of files) {
    const plugin = /^plugins\/([^/]+)\//.exec(file);
    if (plugin && !IGNORED_PLUGIN_DIRS.has(plugin[1])) candidates.add(`plugins/${plugin[1]}`);
    const crate = /^src-tauri\/crates\/([^/]+)\//.exec(file);
    if (crate) candidates.add(`src-tauri/crates/${crate[1]}`);
  }
  return [...candidates].filter((dir) => trackedUnder(dir).length === 0);
}

function checkDesign() {
  const added = stagedAdded();
  if (!added.length) {
    console.log("[gate] （无暂存新增文件，跳过方案设计门禁）");
    return true;
  }
  const risks = newRiskModules(added);
  if (!risks.length) {
    console.log("[gate] ✅ 本次提交未新增高风险模块");
    return true;
  }
  const design = added.filter((f) => f.startsWith("docs/design/") && f.endsWith(".md") && !/README\.md$/.test(f));
  if (design.length) {
    console.log(`[gate] ✅ 已附设计文档：${design.join(", ")}`);
    return true;
  }
  console.log("[gate] ❌ 新增了高风险模块，但本次提交没有 docs/design/ 设计文档：");
  for (const dir of risks) console.log(`[gate]      ${dir}（新模块）`);
  console.log("[gate]   先按 docs/standards/basic/design-workflow.md 写方案设计，再提交。");
  console.log("[gate]   已做设计但被判误伤：GATE_SKIP=1 git commit ...（留痕）");
  return false;
}

/* ── 入口 ─────────────────────────────────────────────── */

if (process.env.GATE_SKIP === "1") {
  console.log("[gate] GATE_SKIP=1，跳过门禁（显式降级）");
  process.exit(0);
}

if (!git(["rev-parse", "--git-dir"], { allowFail: true })) {
  console.log("[gate] 不在 git 仓库中，跳过门禁");
  process.exit(0);
}

const args = process.argv.slice(2);
const all = args.length === 0;
const runActive = all || args.includes("--check-active");
const runDesign = all || args.includes("--check-design");
const runChangelog = all || args.includes("--check-changelog");

let ok = true;
if (runActive) ok = checkActive() && ok;
if (runDesign) ok = checkDesign() && ok;
if (runChangelog) ok = checkChangelog() && ok;

process.exit(ok ? 0 : 1);
