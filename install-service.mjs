#!/usr/bin/env node
// Installs the M3NT0R service under the operating system's own service manager so it
// starts at login, restarts after a crash and keeps one fixed port. Prints one JSON
// status; run with --help for usage.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const platform = process.platform;
const defaultLabel = platform === 'darwin' ? 'com.clarity.m3ntor' : 'clarity-m3ntor';

const USAGE = `Usage: node install-service.mjs --workspace <dir> --harness codex|claude|antigravity --port <n>
                                [--source <dir>] [--label <name>] [--replace]

Installs the M3NT0R service (macOS LaunchAgent, Linux systemd --user unit, Windows
logon task) so it starts at login, restarts after a crash and keeps its port.

  --workspace  business workspace (M3NTOR_WORKSPACE)
  --harness    codex, claude, or antigravity (M3NTOR_HARNESS; agy alias accepted)
  --port       fixed loopback port
  --source     M3NT0R checkout (default: this file's directory)
  --label      service name (default: ${defaultLabel})
  --replace    rewrite a service with this label that already exists
  --help       print this text; changes nothing

A service with this label that is already defined or loaded is kept as it is and
reported, unless --replace is given. Prints one JSON status.
`;

const VALUE_OPTIONS = new Set(['workspace', 'harness', 'port', 'source', 'label']);
const FLAGS = new Set(['replace', 'help']);

function finish(status) { process.stdout.write(JSON.stringify(status) + '\n'); process.exit(['error', 'missing_input', 'port_in_use'].includes(status.status) ? 1 : 0); }

const argv = process.argv.slice(2);
if (argv.some((a) => a === '--help' || a === '-h')) { process.stdout.write(USAGE); process.exit(0); }

function args(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    const match = token.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!match) finish({ status: 'error', error: `Unexpected argument ${token}. Run with --help.` });
    const [, name, inline] = match;
    if (FLAGS.has(name)) { if (inline !== undefined) finish({ status: 'error', error: `--${name} takes no value.` }); out[name] = true; continue; }
    if (!VALUE_OPTIONS.has(name)) finish({ status: 'error', error: `Unknown option --${name}. Run with --help.` });
    const value = inline !== undefined ? inline : list[++i];
    if (value === undefined || value === '' || value.startsWith('--')) finish({ status: 'error', error: `--${name} needs a value.` });
    out[name] = value;
  }
  return out;
}
const opts = args(argv);

function run(cmd, list, options = {}) {
  try { return { ok: true, out: execFileSync(cmd, list, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }) }; }
  catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message }; }
}

function which(name) {
  const r = platform === 'win32' ? run('where', [name]) : run('/bin/sh', ['-c', `command -v "$1"`, 'sh', name]);
  return r.ok ? r.out.split(/\r?\n/)[0].trim() || null : null;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// The process listening on a loopback port, if any: { pid, command }.
function portHolder(port) {
  if (platform === 'win32') {
    const r = run('netstat', ['-ano', '-p', 'TCP']);
    const line = r.ok && r.out.split(/\r?\n/).find((l) => new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`, 'i').test(l));
    if (!line) return null;
    const pid = Number(line.trim().split(/\s+/).pop());
    const c = run('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]);
    return { pid, command: c.ok ? c.out.trim() : null };
  }
  let r = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  if (r.ok) {
    const pid = Number(r.out.match(/^p(\d+)/m)?.[1]);
    if (pid) return { pid, command: run('ps', ['-o', 'command=', '-p', String(pid)]).out?.trim() || r.out.match(/^c(.*)$/m)?.[1] || null };
  }
  if (platform === 'linux') {
    r = run('ss', ['-ltnpH', `sport = :${port}`]);
    const pid = r.ok && Number(r.out.match(/pid=(\d+)/)?.[1]);
    if (pid) return { pid, command: run('ps', ['-o', 'command=', '-p', String(pid)]).out?.trim() || null };
  }
  return null;
}

// Whether the process holding the port belongs to this service.
function ownsPort(holder, servicePid) {
  if (!holder) return false;
  if (servicePid) return holder.pid === servicePid;
  if (platform !== 'win32') return false;
  // Windows: node runs under the task's .cmd loop; walk the parents.
  let pid = holder.pid;
  for (let i = 0; i < 4 && pid; i++) {
    const r = run('powershell', ['-NoProfile', '-Command', `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; "$($p.ParentProcessId)|$($p.CommandLine)"`]);
    if (!r.ok) return false;
    const [parent, ...rest] = r.out.trim().split('|');
    if (rest.join('|').toLowerCase().includes((windowsScript || `${label}.cmd`).toLowerCase())) return true;
    pid = Number(parent);
  }
  return false;
}

// Confirms an M3NT0R owner view answers on the port.
async function m3ntorAnswers(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.text()).includes('<title>Clarity M3NT0R</title>');
  } catch { return false; }
}

const source = path.resolve(opts.source || here);
const workspace = opts.workspace ? path.resolve(opts.workspace) : null;
const harness = opts.harness === 'agy' ? 'antigravity' : opts.harness;
const label = opts.label || defaultLabel;
// Prefer the PATH entry (for example /opt/homebrew/bin/node) so a node upgrade keeps working.
const node = which('node') || process.execPath;
const home = os.homedir();

let file;
if (platform === 'darwin') file = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
else if (platform === 'linux') file = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', `${label}.service`);
else if (platform === 'win32') file = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ClarityM3NT0R', `${label}.xml`);
else finish({ status: 'error', platform, label, error: `Unsupported platform ${platform}.` });

// ---- What the service manager already has under this label -------------------------
const domain = platform === 'darwin' ? `gui/${process.getuid()}` : null;
const ctl = (...a) => run('systemctl', ['--user', ...a]);

function current() {
  if (platform === 'darwin') {
    const r = run('/bin/launchctl', ['print', `${domain}/${label}`]);
    if (!r.ok) return existsSync(file) ? { loaded: false, file, port: plistPort(file) } : null;
    const loadedFile = r.out.match(/^\s*path = (.+)$/m)?.[1]?.trim() || null;
    const port = Number(r.out.match(/^\s*PORT => (\d+)$/m)?.[1]) || (loadedFile && plistPort(loadedFile)) || null;
    return { loaded: true, file: loadedFile || file, port, pid: Number(r.out.match(/^\s*pid = (\d+)$/m)?.[1]) || null };
  }
  if (platform === 'linux') {
    const r = ctl('show', `${label}.service`, '-p', 'LoadState', '-p', 'FragmentPath', '-p', 'MainPID', '-p', 'Environment');
    const prop = (k) => r.out?.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || '';
    if (!r.ok || prop('LoadState') !== 'loaded') return existsSync(file) ? { loaded: false, file, port: unitPort(readFileSync(file, 'utf8')) } : null;
    return { loaded: true, file: prop('FragmentPath') || file, port: Number(prop('Environment').match(/(?:^|\s)PORT=(\d+)/)?.[1]) || null, pid: Number(prop('MainPID')) || null };
  }
  // Follow the registered task's own action to the script it runs: wscript <.vbs> -> <.cmd>, or a .cmd directly.
  // PowerShell writes the action as UTF-8, so non-ASCII profile paths survive any console code page.
  const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $t=Get-ScheduledTask -TaskName '${label.replace(/'/g, "''")}' -ErrorAction Stop; $a=$t.Actions | Select-Object -First 1; "$($a.Execute)\`n$($a.Arguments)"`;
  const q = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (!q.ok && !run('schtasks', ['/Query', '/TN', label]).ok) return null;
  const [command = '', argsText = ''] = q.ok ? q.out.replace(/^﻿/, '').split(/\r?\n/).map((v) => v.trim()) : [];
  const target = (/\.(cmd|bat)"?$/i.test(command) ? command : argsText).replace(/^"+|"+$/g, '');
  let script = null;
  if (/\.vbs$/i.test(target) && existsSync(target)) script = readFileSync(target, 'utf8').match(/"""(.+?)"""/)?.[1] || null;
  else if (/\.(cmd|bat)$/i.test(target)) script = target;
  if (script && !existsSync(script)) script = null;
  windowsScript = script;
  const port = script ? Number(readFileSync(script, 'utf8').match(/set "PORT=(\d+)"/)?.[1]) || null : null;
  return { loaded: true, file: script, task_action: `${command} ${argsText}`.trim(), port, pid: null };
}
function plistPort(f) { const r = run('/usr/bin/plutil', ['-extract', 'EnvironmentVariables.PORT', 'raw', '-o', '-', f]); return r.ok ? Number(r.out.trim()) || null : null; }
function unitPort(text) { return Number(text.match(/^Environment="?PORT=(\d+)"?/m)?.[1]) || null; }

let windowsScript = null; // the .cmd the registered Windows task runs
const before = current();
const keep = Boolean(before) && !opts.replace;
// A kept service must be reported by its definition and port, and then verified.
if (keep && (!before.file || !before.port)) finish({ status: 'error', platform, label, file: before.file || null, port: before.port || null, task_action: before.task_action, error: 'A service with this label exists but its definition or port could not be read. Inspect it, or rerun with --replace and --port.' });
const port = keep ? before.port : Number(opts.port);
const status = { status: keep ? 'existing' : before ? 'replaced' : 'installed', platform, label, file: keep ? before.file : file, port, url: port ? `http://127.0.0.1:${port}/` : null, mcp_url: port ? `http://127.0.0.1:${port}/mcp/local` : null };
if (!keep && before?.file && before.file !== file) status.previous_file = before.file;

// ---- Environment the service needs from this shell -----------------------------------
let env = null;
if (!keep) {
  const missing = [];
  if (!workspace) missing.push('--workspace');
  if (!['codex', 'claude', 'antigravity'].includes(harness)) missing.push('--harness codex|claude|antigravity');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) missing.push('--port');
  if (missing.length) finish({ ...status, status: 'missing_input', missing });
  if (!existsSync(path.join(source, 'server.mjs'))) finish({ ...status, status: 'error', error: `server.mjs not found in ${source}` });
  const holder = portHolder(port);
  const replacingOwnListener = before && (before.pid ? holder?.pid === before.pid : platform === 'win32' && ownsPort(holder, null));
  if (holder && !replacingOwnListener) finish({ ...status, status: 'port_in_use', holder });

  // The service runs the harness CLI, so its PATH must reach node and the harness.
  const harnessBin = harness === 'antigravity' ? 'agy' : harness;
  const harnessPath = which(harnessBin);
  const servicePath = [path.dirname(node), harnessPath && path.dirname(harnessPath), ...(process.env.PATH || '').split(path.delimiter)]
    .filter(Boolean).filter((d, i, all) => all.indexOf(d) === i).join(path.delimiter);
  env = { HOME: home, PATH: servicePath, PORT: String(port), M3NTOR_WORKSPACE: workspace, M3NTOR_HARNESS: harness };
  // Non-secret selectors read by the service or its harness; the service manager does not inherit the shell.
  for (const key of ['M3NTOR_CONFIG', 'M3NTOR_JOB_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'ANTIGRAVITY_CONFIG_DIR']) {
    if (process.env[key]) env[key] = path.resolve(process.env[key]);
  }
  status.environment = Object.keys(env);
  const profileFile = process.env.M3NTOR_CONFIG || path.join(home, '.config', 'clarity_m3ntor', 'config.json');
  try {
    const profile = JSON.parse(readFileSync(profileFile, 'utf8'));
    if (profile.token_env) status.token_note = `The profile reads its token from ${profile.token_env}, which the service does not receive. Rerun register.mjs so the token comes from the profile's token_command (Keychain or owner-only file).`;
  } catch {}
}
const logs = workspace ? path.join(workspace, '.clarity_coach', 'logs') : null;

function writePrivate(target, content, mode = 0o600) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { mode });
  chmodSync(target, mode);
}

// ---- macOS: LaunchAgent ------------------------------------------------------------
if (platform === 'darwin') {
  if (!keep) {
    if (before?.loaded) run('/bin/launchctl', ['bootout', `${domain}/${label}`]);
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const envXml = Object.entries(env).map(([k, v]) => `\t\t<key>${k}</key>\n\t\t<string>${xml(v)}</string>`).join('\n');
    writePrivate(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xml(node)}</string>
\t\t<string>${xml(path.join(source, 'server.mjs'))}</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${envXml}
\t</dict>
\t<key>WorkingDirectory</key>
\t<string>${xml(workspace)}</string>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>30</integer>
\t<key>StandardOutPath</key>
\t<string>${xml(path.join(logs, 'mcp.log'))}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(path.join(logs, 'mcp.stderr.log'))}</string>
</dict>
</plist>
`);
  }
  if (!current()?.loaded) {
    const target = keep ? before.file : file;
    let r = run('/bin/launchctl', ['bootstrap', domain, target]);
    for (let i = 0; !r.ok && i < 5; i++) { await sleep(1000); r = run('/bin/launchctl', ['bootstrap', domain, target]); }
    if (!r.ok) finish({ ...status, status: 'error', loaded: false, error: r.out });
  }
}

// ---- Linux: systemd user unit ------------------------------------------------------
if (platform === 'linux') {
  if (!keep) {
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    writePrivate(file, `[Unit]
Description=Clarity M3NT0R
After=network-online.target

[Service]
Type=simple
ExecStart=${quote(node)} ${quote(path.join(source, 'server.mjs'))}
WorkingDirectory=${workspace}
${Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=10
# Restarting the server leaves detached task and harness jobs running.
KillMode=process
StandardOutput=append:${path.join(logs, 'mcp.log')}
StandardError=append:${path.join(logs, 'mcp.stderr.log')}

[Install]
WantedBy=default.target
`);
    ctl('daemon-reload');
    if (before?.loaded) ctl('restart', `${label}.service`);
  }
  const r = ctl('enable', '--now', `${label}.service`);
  if (!r.ok) finish({ ...status, status: 'error', loaded: false, error: r.out });
  const linger = run('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value']);
  status.linger = linger.ok ? linger.out.trim() === 'yes' : null;
  if (status.linger === false) status.note = 'Runs while the owner is logged in; starting at boot without a login needs `loginctl enable-linger`, which may need administrator rights.';
}

// ---- Windows: current-user Scheduled Task at logon ---------------------------------
if (platform === 'win32') {
  const dir = path.dirname(file);
  const cmd = path.join(dir, `${label}.cmd`);
  const vbs = path.join(dir, `${label}.vbs`);
  const user = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`;
  if (!keep) {
    mkdirSync(logs, { recursive: true });
    run('schtasks', ['/End', '/TN', label]);
    windowsScript = cmd;
    // The script loops so a crashed server restarts within 10 seconds.
    writePrivate(cmd, `@echo off\r\n${Object.entries(env).map(([k, v]) => `set "${k}=${v}"`).join('\r\n')}\r\ncd /d "${workspace}"\r\n:loop\r\n"${node}" "${path.join(source, 'server.mjs')}" >> "${path.join(logs, 'mcp.log')}" 2>> "${path.join(logs, 'mcp.stderr.log')}"\r\ntimeout /t 10 /nobreak > nul\r\ngoto loop\r\n`, 0o700);
    // wscript keeps the console window hidden.
    writePrivate(vbs, `CreateObject("WScript.Shell").Run """${cmd}""", 0, True\r\n`, 0o700);
    const task = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Clarity M3NT0R</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"${xml(vbs)}"</Arguments></Exec></Actions>
</Task>
`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, '﻿' + task, { encoding: 'utf16le' });
    const r = run('schtasks', ['/Create', '/TN', label, '/XML', file, '/F']);
    if (!r.ok) finish({ ...status, status: 'error', loaded: false, error: r.out });
  }
  const q = run('schtasks', ['/Query', '/TN', label, '/FO', 'LIST']);
  if (q.ok && !/Running/i.test(q.out)) run('schtasks', ['/Run', '/TN', label]);
}

// ---- Read back: this service's own process answers as M3NT0R on the port --------------
status.loaded = Boolean(current()?.loaded);
status.responding = false;
if (port) {
  for (let i = 0; i < 20 && !status.responding; i++) {
    const now = current();
    status.pid = now?.pid || null;
    const holder = portHolder(port);
    if (holder && !ownsPort(holder, status.pid)) {
      // Another program holds the port (a still-exiting old copy is given a few seconds).
      if (i >= 5) finish({ ...status, status: 'port_in_use', holder });
    } else if (holder && await m3ntorAnswers(port)) {
      status.responding = true;
      if (platform === 'win32') status.pid = holder.pid;
      break;
    }
    await sleep(1000);
  }
}
finish(status);
