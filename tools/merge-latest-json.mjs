#!/usr/bin/env node
/**
 * 把多个平台的 latest.json 片段（tools/make-latest-json.mjs 产出）合成一份多平台清单。
 *
 * 用法（CI）：
 *   node tools/merge-latest-json.mjs --out latest.json \
 *     --require windows-x86_64,linux-x86_64 \
 *     latest-windows.json latest-linux.json
 *
 * 为什么要 --require：某个平台的构建失败时，流水线可能只拿到一部分片段，
 * 而少一个平台的清单照样能发布出去，只是那台机器从此再也收不到更新。
 * 缺平台必须在这里报错，而不是静默产出一份"看起来成功"的清单。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const out = resolve(argOf('out') || 'latest.json');
const requirePlatforms = (argOf('require') || '').split(',').map((s) => s.trim()).filter(Boolean);
const inputs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--require');

if (inputs.length === 0) {
  console.error('用法: node tools/merge-latest-json.mjs --out latest.json [--require p1,p2] <片段文件...>');
  process.exit(1);
}

const fragments = inputs.map((file) => {
  const path = resolve(file);
  if (!existsSync(path)) {
    console.error(`片段文件不存在: ${path}`);
    process.exit(1);
  }
  return { file, manifest: JSON.parse(readFileSync(path, 'utf8')) };
});

const versions = [...new Set(fragments.map((f) => f.manifest.version))];
if (versions.length > 1) {
  console.error(`片段版本不一致: ${fragments.map((f) => `${f.file}=${f.manifest.version}`).join(', ')}`);
  process.exit(1);
}

const platforms = Object.assign({}, ...fragments.map((f) => f.manifest.platforms));
const missing = requirePlatforms.filter((p) => !platforms[p]);
if (missing.length) {
  console.error(
    `清单缺少必需平台: ${missing.join(', ')}（实际有 ${Object.keys(platforms).join(', ') || '无'}）\n` +
      '对应平台的构建或签名步骤可能失败了，缺平台发布会让那台机器收不到更新',
  );
  process.exit(1);
}

const merged = {
  version: versions[0],
  notes: fragments[0].manifest.notes,
  pub_date: fragments.map((f) => f.manifest.pub_date).sort().at(-1),
  platforms,
};
writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
console.log(`[merge-latest-json] ${merged.version} → ${Object.keys(platforms).join(', ')}`);
