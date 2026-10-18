#!/usr/bin/env node
/**
 * 任务上下文管理：当前进行中的计划/任务（跨会话续接）。
 *
 * 绑定文件：.agent/contexts/<stem>.yaml（gitignored，本机会话态，每计划一份）
 *   plan:    docs/plans/<file>.md
 *   task:    docs/tasks/<file>.md
 *   owner:   本机用户名（仅用于区分会话）
 *   status:  in_progress | done
 *   updated: ISO 本地时间
 *
 * 用法：
 *   node tools/agent/task-context.mjs list               # 扫描进行中的计划/任务（含绑定标注）
 *   node tools/agent/task-context.mjs current [stem]     # 显示绑定（缺省全部，最新者为主上下文）
 *   node tools/agent/task-context.mjs auto <plan>        # 建档后自动绑定计划 + 同名任务
 *   node tools/agent/task-context.mjs switch <stem|file> # 绑定到已有计划/任务
 *   node tools/agent/task-context.mjs close [stem]       # 标记绑定完成（不归档）
 *   node tools/agent/task-context.mjs archive [stem]     # 归档该计划/任务并释放绑定
 *
 * 状态判定：计划文档 `**状态**:` 行含 ✅/已完成 视为完成；任务文档按未勾选步骤计数。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLANS_DIR = "docs/plans";
const TASKS_DIR = "docs/tasks";
const ARCHIVE_DIR = "docs/archive";
const CONTEXTS_DIR = ".agent/contexts";
const DONE_MARKS = ["✅", "✔", "已完成", "已实施完成", "已归档"];

const abs = (p) => path.join(ROOT, p);
const has = (p) => fs.existsSync(abs(p));
const ensure = (p) => fs.mkdirSync(abs(p), { recursive: true });
const stemOf = (file) => path.basename(file).replace(/\.md$/i, "");

function now() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function listMarkdown(dir) {
  if (!has(dir)) return [];
  return fs
    .readdirSync(abs(dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "README.md")
    .map((e) => e.name)
    .sort();
}

function read(file) {
  return fs.readFileSync(abs(file), "utf8");
}

/** 计划状态：done / active / unknown */
function planState(file) {
  if (!has(file)) return "missing";
  const m = read(file).match(/^\*\*状态\*\*[:：]\s*(.+)$/m);
  if (!m) return "unknown";
  return DONE_MARKS.some((s) => m[1].includes(s)) ? "done" : "active";
}

function taskProgress(file) {
  if (!has(file)) return null;
  const text = read(file);
  const done = (text.match(/^\s*\d+\.\s*\[[xX]\]/gm) || []).length;
  const todo = (text.match(/^\s*\d+\.\s*\[ \]/gm) || []).length;
  return { done, todo, total: done + todo };
}

const STATE_LABEL = { done: "✅ 已完成", active: "🟡 进行中", unknown: "❔ 无状态行", missing: "❌ 缺失" };

function contextsDir() {
  ensure(CONTEXTS_DIR);
  return abs(CONTEXTS_DIR);
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

function writeBinding(stem, data) {
  const dir = contextsDir();
  const body = [
    `plan: "${data.plan || ""}"`,
    `task: "${data.task || ""}"`,
    `owner: "${data.owner || ""}"`,
    `status: "${data.status || "in_progress"}"`,
    `updated: "${now()}"`,
    "",
  ].join("\n");
  const target = path.join(dir, `${stem}.yaml`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, target);
}

function bindings() {
  const dir = abs(CONTEXTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => ({ stem: f.replace(/\.yaml$/, ""), file: path.join(dir, f), ...readBinding(path.join(dir, f)) }))
    .sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
}

function bindingAdmits(b) {
  const plan = (b.plan || "").trim();
  if (!plan || !has(plan)) return false;
  if ((b.status || "in_progress") === "in_progress") return true;
  return planState(plan) === "active";
}

function resolvePlan(arg) {
  if (!arg) return null;
  const cleaned = arg.replace(/\\/g, "/").replace(/^\.\//, "");
  if (cleaned.endsWith(".md")) {
    if (has(cleaned)) return cleaned;
    const stem = stemOf(cleaned);
    const guess = `${PLANS_DIR}/${stem}.md`;
    return has(guess) ? guess : null;
  }
  const guess = `${PLANS_DIR}/${cleaned}.md`;
  return has(guess) ? guess : null;
}

function printActivePlans() {
  const plans = listMarkdown(PLANS_DIR);
  if (!plans.length) {
    console.log("[task]   （docs/plans/ 为空）");
    return;
  }
  console.log("[task]   进行中的计划:");
  for (const name of plans) {
    const state = planState(`${PLANS_DIR}/${name}`);
    if (state === "done") continue;
    console.log(`[task]     ${name}  ${STATE_LABEL[state]}`);
  }
}

/* ── 命令 ─────────────────────────────────────────────── */

function cmdList() {
  const plans = listMarkdown(PLANS_DIR);
  const tasks = listMarkdown(TASKS_DIR);
  const boundBy = new Map();
  for (const b of bindings()) {
    const stem = stemOf(b.plan || "");
    if (stem) boundBy.set(stem, b.status || "in_progress");
  }

  console.log(`[task] 计划 ${plans.length} · 任务 ${tasks.length} · 绑定 ${bindings().length}`);
  if (!plans.length && !tasks.length) {
    console.log("[task] 目录为空。建档：docs/plans|tasks/YYYYMMDD_HHMMSS_<slug>.md");
    return;
  }
  if (plans.length) {
    console.log("\n[task] 计划");
    for (const name of plans) {
      const stem = stemOf(name);
      const mark = boundBy.has(stem) ? `🔗 ${boundBy.get(stem)}` : "";
      console.log(`  ${STATE_LABEL[planState(`${PLANS_DIR}/${name}`)]}  ${name}  ${mark}`);
    }
  }
  if (tasks.length) {
    console.log("\n[task] 任务");
    for (const name of tasks) {
      const p = taskProgress(`${TASKS_DIR}/${name}`);
      const stem = stemOf(name);
      const mark = boundBy.has(stem) ? `🔗 ${boundBy.get(stem)}` : "";
      console.log(`  ${p ? `${p.done}/${p.total} 步` : "—"}  ${name}  ${mark}`);
    }
  }
}

function cmdCurrent(arg) {
  let list = bindings();
  if (arg) list = list.filter((b) => b.stem === stemOf(arg));
  if (!list.length) {
    console.log("[task] 无任务绑定。");
    console.log("[task] 建档后绑定：npm run task:auto -- docs/plans/<file>.md");
    printActivePlans();
    return;
  }
  list.forEach((b, i) => {
    const head = i === 0 && !arg ? "（主上下文）" : "";
    console.log(`[task] ${b.stem} ${head}`);
    console.log(`  计划: ${b.plan || "（无）"}  ${b.plan ? STATE_LABEL[planState(b.plan)] : ""}`);
    console.log(`  任务: ${b.task || "（无）"}`);
    const p = b.task ? taskProgress(b.task) : null;
    if (p) console.log(`  进度: ${p.done}/${p.total} 步`);
    console.log(`  状态: ${b.status || "in_progress"} · 更新 ${b.updated || "?"} · owner ${b.owner || "?"}`);
  });
}

function cmdAuto(arg) {
  const plan = resolvePlan(arg);
  if (!plan) {
    console.error(`[task] ❌ 找不到计划文档: ${arg}`);
    console.error("[task]   先按模板创建 docs/plans/YYYYMMDD_HHMMSS_<slug>.md");
    process.exit(1);
  }
  const stem = stemOf(plan);
  const task = `${TASKS_DIR}/${stem}.md`;
  writeBinding(stem, {
    plan,
    task: has(task) ? task : "",
    owner: os.userInfo().username,
    status: "in_progress",
  });
  console.log(`[task] ✅ 已绑定 ${stem}`);
  console.log(`[task]   计划 ${plan}`);
  console.log(`[task]   任务 ${has(task) ? task : "（无同名任务，可后补）"}`);
}

function cmdSwitch(arg) {
  if (!arg) {
    console.error("用法: node tools/agent/task-context.mjs switch <stem|docs/plans/xxx.md>");
    process.exit(1);
  }
  const plan = resolvePlan(arg) || `${PLANS_DIR}/${stemOf(arg)}.md`;
  if (!has(plan)) {
    console.error(`[task] ❌ 计划不存在: ${plan}`);
    process.exit(1);
  }
  const stem = stemOf(plan);
  const task = `${TASKS_DIR}/${stem}.md`;
  writeBinding(stem, {
    plan,
    task: has(task) ? task : "",
    owner: os.userInfo().username,
    status: "in_progress",
  });
  console.log(`[task] ✅ 已切换到 ${stem}`);
}

function cmdClose(arg) {
  const list = bindings();
  const target = arg ? list.find((b) => b.stem === stemOf(arg)) : list[0];
  if (!target) {
    console.error(arg ? `[task] ❌ 未找到绑定: ${arg}` : "[task] ❌ 没有任何绑定");
    process.exit(1);
  }
  writeBinding(target.stem, { ...target, status: "done" });
  console.log(`[task] ✅ 已标记完成: ${target.stem}（未归档，收尾请用 archive）`);
}

function moveToArchive(file) {
  if (!has(file)) return null;
  const sub = file.startsWith(TASKS_DIR) ? "tasks" : "plans";
  const dir = `${ARCHIVE_DIR}/${sub}`;
  ensure(dir);
  const base = path.basename(file);
  let dest = `${dir}/${base}`;
  if (has(dest)) {
    const stamp = now().replace(/[-:T]/g, "").slice(0, 14);
    dest = `${dir}/${base.replace(/\.md$/, `_${stamp}.md`)}`;
  }
  fs.renameSync(abs(file), abs(dest));
  return dest;
}

function archiveOne(stem) {
  const plan = `${PLANS_DIR}/${stem}.md`;
  const task = `${TASKS_DIR}/${stem}.md`;
  const movedPlan = moveToArchive(plan);
  const movedTask = moveToArchive(task);
  const bindingFile = abs(`${CONTEXTS_DIR}/${stem}.yaml`);
  if (fs.existsSync(bindingFile)) fs.rmSync(bindingFile);
  if (!movedPlan && !movedTask) {
    console.log(`[task] ${stem}: 没有可归档的文档（绑定已释放）`);
    return;
  }
  if (movedPlan) console.log(`[task]   计划 → ${movedPlan}`);
  if (movedTask) console.log(`[task]   任务 → ${movedTask}`);
}

function cmdArchive(arg) {
  const list = bindings();
  if (arg) {
    console.log(`[task] 归档 ${stemOf(arg)}`);
    archiveOne(stemOf(arg));
    return;
  }
  const openStems = new Set(list.filter((b) => (b.status || "in_progress") === "in_progress").map((b) => b.stem));
  const candidates = listMarkdown(PLANS_DIR)
    .map((n) => stemOf(n))
    .filter((s) => planState(`${PLANS_DIR}/${s}.md`) === "done" && !openStems.has(s));
  if (!candidates.length) {
    console.log("[task] 没有已完成且未被绑定的计划可归档。");
    console.log("[task]   只归档自己：npm run task:archive -- <stem>");
    return;
  }
  for (const stem of candidates) archiveOne(stem);
}

/* ── 入口 ─────────────────────────────────────────────── */

const [cmd = "list", ...rest] = process.argv.slice(2);
const arg = rest[0];

switch (cmd) {
  case "list":
    cmdList();
    break;
  case "current":
    cmdCurrent(arg);
    break;
  case "auto":
    cmdAuto(arg);
    break;
  case "switch":
    cmdSwitch(arg);
    break;
  case "close":
    cmdClose(arg);
    break;
  case "archive":
    cmdArchive(arg);
    break;
  case "-h":
  case "--help":
  case "help":
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    break;
  default:
    console.error(`[task] 未知命令: ${cmd}`);
    console.error("可用命令: list | current | auto | switch | close | archive");
    process.exit(1);
}
