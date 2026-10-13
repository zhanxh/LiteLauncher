// LLP/1 插件冒烟测试：扮演宿主，与每个外部插件的 sidecar 走一遍协议。
//
// 覆盖：
//   1. initialize 握手（必须回 {"protocol":"LLP/1"}）
//   2. search（空参 / 样例关键词）→ 必须返回 { items: [...] }
//   3. execute（用不存在的子命令探测）→ 必须返回 success:false，不得抛协议错
//   4. shutdown → 进程应正常退出
//
// 说明：测试进程扮演宿主，负责应答插件发出的 svc.* 反向请求（返回 null 桩），
// 因此插件不会真的写设置、弹通知或打开浏览器。
//
// 用法：npm run plugin:test        （可用 LLP_PYTHON 指定解释器）
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const pluginsDir = path.join(root, "plugins");

// 每个插件的代表性输入（用于覆盖主要分支）
// 注：纯前端插件（backend.kind = "none"）不在此覆盖，见 tools/test-fe-plugins.mjs
const SAMPLES = {
  hash: ["hello"],
  cron: ["0 9 * * 1-5"],
  cidr: ["192.168.1.0/24 4"],
  bookmark: ["", "git"],
  snip: [""],
  pwd: ["24"],
  cost: [""],
  memo: [""],
  cheat: ["", "git"],
  time: [""],
  pomo: [""],
  sysinfo: [""],
  // /find 的样例要能命中真实条目；用 Everything 索引里几乎必然存在的词
  find: ["", "annotate-view.tsx", "path:plugins", "ext:rs clippy"],
};

const SVC_STUB = {
  "svc.settings.get": null,
  "svc.settings.set": null,
  "svc.notify.send": null,
  "svc.process.launch": null,
  "svc.log.write": null,
  "svc.db.execute": 0,
  "svc.db.query": [],
};

let nextId = 1;

class Sidecar {
  constructor(program, entry, cwd) {
    this.program = program;
    this.entry = entry;
    this.cwd = cwd;
    this.pending = new Map();
    this.buf = "";
    this.stderr = "";
    this.child = null;
  }

  start() {
    this.child = spawn(this.program, this.entry, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("error", (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    return this;
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method) {
        // 插件 → 宿主：反向服务请求，用桩应答
        const result = msg.method in SVC_STUB ? SVC_STUB[msg.method] : null;
        this._write({ jsonrpc: "2.0", id: msg.id, result });
      } else if (msg.id !== undefined) {
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(msg.error.message || "插件返回错误"));
          else waiter.resolve(msg.result);
        }
      }
    }
  }

  _write(obj) {
    if (!this.child || this.child.killed) return;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params, timeoutMs = 5000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`超时 ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  call(inner, params) {
    return this.request("call", { method: inner, params });
  }

  async stop() {
    this._write({ jsonrpc: "2.0", method: "shutdown" });
    await new Promise((r) => setTimeout(r, 120));
    if (this.child && !this.child.killed) this.child.kill();
  }

  get alive() {
    return this.child && !this.child.killed && this.child.exitCode === null;
  }
}

function splitArgs(text) {
  const tokens = [];
  let cur = "";
  let quoted = false;
  for (const ch of text.trim()) {
    if (ch === '"' || ch === "'") {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** 把一段输入文本转成插件 search 期望的 { keyword, subcommand, args } */
function toSearchParams(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return { keyword: null, subcommand: null, args: [] };
  const tokens = splitArgs(trimmed);
  const subcommand = tokens.length > 0 && !tokens[0].startsWith("-") ? tokens[0] : null;
  const args = subcommand ? tokens.slice(1) : tokens;
  return { keyword: trimmed, subcommand, args };
}

function loadPlugins() {
  const out = [];
  for (const dirent of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = path.join(pluginsDir, dirent.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.backend?.kind !== "llp") continue;
    out.push({ dir: path.join(pluginsDir, dirent.name), manifest });
  }
  return out.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

function resolvePython() {
  if (process.env.LLP_PYTHON) return process.env.LLP_PYTHON;
  return process.platform === "win32" ? "python" : "python3";
}

async function testPlugin({ dir, manifest }, python) {
  const failures = [];
  const entry = manifest.backend.entry;
  if (!entry || entry.length < 2) {
    return { id: manifest.id, failures: ["manifest.backend.entry 未声明"] };
  }
  const program = entry[0] === "python3" || entry[0] === "python" ? python : entry[0];
  const script = path.join(dir, entry[1]);
  if (!existsSync(script)) {
    return { id: manifest.id, failures: [`脚本不存在: ${entry[1]}`] };
  }

  const side = new Sidecar(program, [entry[1]], dir).start();
  try {
    const ack = await side.request("initialize", { protocol: "LLP/1", pluginId: manifest.id }, 8000);
    if (!ack || ack.protocol !== "LLP/1") {
      failures.push(`initialize 未回 LLP/1（收到 ${JSON.stringify(ack)}）`);
      return { id: manifest.id, failures };
    }

    const samples = SAMPLES[manifest.id] ?? [""];
    for (const sample of samples) {
      const params = toSearchParams(sample);
      const data = await side.call("search", params);
      if (!data || !Array.isArray(data.items)) {
        failures.push(`search("${sample}") 未返回 items 数组：${JSON.stringify(data)?.slice(0, 120)}`);
        continue;
      }
      if (data.items.length === 0 && !data.emptyText) {
        failures.push(`search("${sample}") 返回空 items 且无 emptyText`);
      }
      for (const it of data.items) {
        if (!it.id || !it.title) {
          failures.push(`search("${sample}") 条目缺 id/title：${JSON.stringify(it).slice(0, 120)}`);
          break;
        }
      }
    }

    const actionSubs = manifest.command?.action_subcommands ?? [];
    if (actionSubs.length > 0) {
      const res = await side.call("execute", {
        raw: `${manifest.trigger} __smoke__`,
        subcommand: "__smoke__",
        args: [],
        namedArgs: {},
      });
      if (!res || typeof res.success !== "boolean") {
        failures.push(`execute 未返回 { success: boolean }：${JSON.stringify(res)?.slice(0, 120)}`);
      } else if (res.success !== false) {
        failures.push("execute 对未知子命令未返回 success:false");
      }
    }
  } catch (err) {
    failures.push(String(err?.message || err));
  } finally {
    await side.stop();
  }

  if (side.stderr.trim()) {
    // stderr 不算失败，但打印便于排查
    process.stdout.write(`      [stderr] ${side.stderr.trim().split("\n").slice(0, 3).join(" | ")}\n`);
  }
  return { id: manifest.id, failures };
}

async function main() {
  const python = resolvePython();
  const plugins = loadPlugins();
  console.log(`[plugin:test] 解释器: ${python}`);
  console.log(`[plugin:test] 发现 ${plugins.length} 个 LLP 插件\n`);

  let failed = 0;
  for (const plugin of plugins) {
    const { id, failures } = await testPlugin(plugin, python);
    if (failures.length === 0) {
      console.log(`  ✓ ${id}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${id}`);
      for (const f of failures) console.log(`      - ${f}`);
    }
  }

  console.log(`\n[plugin:test] ${plugins.length - failed}/${plugins.length} 通过`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
