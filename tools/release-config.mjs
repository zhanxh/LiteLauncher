#!/usr/bin/env node
/**
 * 把自动更新端点参数化写入 tauri.conf.json。
 *
 * 本地/CI 都可显式传：
 *   node tools/release-config.mjs --owner myname --repo LiteLauncher
 * 也接受 GitHub Actions 的 GITHUB_REPOSITORY / GITHUB_REPOSITORY_OWNER，
 * 以及 TAURI_UPDATER_PUBKEY（公钥会直接写进配置，私钥只放 CI secret）。
 *
 * 为什么不在配置里写死 owner：仓库可能 fork/改名，发布流水线必须能覆盖。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const repoFull = process.env.GITHUB_REPOSITORY ?? '';
const [envOwner, envRepo] = repoFull.split('/');
const owner = argOf('owner') || process.env.GITHUB_REPOSITORY_OWNER || envOwner || '';
const repo = argOf('repo') || envRepo || 'LiteLauncher';

// GitHub 的 Variable/Secret 常被从文件粘贴，尾随换行会让 Tauri 的
// base64 解码在打包最后一步失败，所以这里统一 trim 并提前校验。
let pubkey = (argOf('pubkey') ?? process.env.TAURI_UPDATER_PUBKEY ?? '').trim();
if (pubkey && existsSync(pubkey)) {
  pubkey = readFileSync(pubkey, 'utf8').trim();
}

if (!owner || owner === 'OWNER') {
  console.error('缺少更新源 owner：传 --owner，或设置 GITHUB_REPOSITORY_OWNER');
  process.exit(1);
}

const confPath = resolve(argOf('config') || 'src-tauri/tauri.conf.json');
const conf = JSON.parse(readFileSync(confPath, 'utf8'));

function validateUpdaterPubkey(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(
      'TAURI_UPDATER_PUBKEY 不是合法 base64：应填 `tauri signer generate` 输出的 Public 值（或 .pub 文件内容），不要填解码后的文本、路径或私钥',
    );
  }
  let text;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    throw new Error('TAURI_UPDATER_PUBKEY base64 解码失败');
  }
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !lines[0].includes('public key')) {
    throw new Error('TAURI_UPDATER_PUBKEY 不是 minisign 公钥（首行缺少 "untrusted comment: minisign public key"）');
  }
  const raw = Buffer.from(lines[1], 'base64');
  if (raw.length !== 42) {
    throw new Error(`TAURI_UPDATER_PUBKEY 公钥长度异常：期望 42 字节，实际 ${raw.length}`);
  }
}

if (pubkey) {
  try {
    validateUpdaterPubkey(pubkey);
  } catch (err) {
    console.error(`[release-config] ${err.message}`);
    process.exit(1);
  }
}

conf.plugins ??= {};
conf.plugins.updater ??= {};
conf.plugins.updater.endpoints = [
  `https://github.com/${owner}/${repo}/releases/latest/download/latest.json`,
];
if (pubkey) conf.plugins.updater.pubkey = pubkey;
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`, 'utf8');

console.log(`[release-config] updater → ${conf.plugins.updater.endpoints[0]}`);
console.log(
  conf.plugins.updater.pubkey
    ? '[release-config] updater pubkey 已写入'
    : '[release-config] updater pubkey 为空（检查更新会提示未配置）',
);
