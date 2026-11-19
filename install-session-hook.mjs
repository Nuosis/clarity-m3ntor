#!/usr/bin/env node
// Register session-start-hook.mjs as a SessionStart hook in the owner's harness, keeping every
// other hook and setting. Repeat-safe: an existing registration for this file is updated in place.
// Usage: node install-session-hook.mjs --harness codex|claude --port <port>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const harness = arg('harness'), port = arg('port');
if (!['codex', 'claude'].includes(harness) || !/^\d+$/.test(port || '')) {
  console.log(JSON.stringify({ status: 'missing_input', need: '--harness codex|claude and --port <port>' })); process.exit(1);
}
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-start-hook.mjs');
// Prefer a stable node path over a versioned one (Homebrew's Cellar path changes on upgrade).
const node = process.execPath.includes('/Cellar/') ? ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(existsSync) || process.execPath : process.execPath;
const command = `"${node}" "${script}" --port ${port}`;
const file = harness === 'codex' ? path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'hooks.json') : path.join(homedir(), '.claude', 'settings.json');
const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
config.hooks ||= {};
const groups = config.hooks.SessionStart ||= [];
const entry = { type: 'command', command, timeout: 10, ...(harness === 'codex' ? { statusMessage: 'Checking Clarity M3NT0R questions' } : {}) };
const existing = groups.flatMap(group => group.hooks || []).find(hook => String(hook.command || '').includes(script));
let changed = true;
if (existing) { changed = existing.command !== command; Object.assign(existing, entry); }
else groups.push({ hooks: [entry] });
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log(JSON.stringify({ status: 'installed', harness, file, command, changed,
  ...(harness === 'codex' ? { trust: 'Codex runs a new or changed hook only after the owner trusts it: in the next interactive Codex session, review and trust the "SessionStart" hook for session-start-hook.mjs when Codex asks (or through its hooks review).' } : {}) }));
