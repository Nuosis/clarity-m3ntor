#!/usr/bin/env node
// Installs the M3NT0R service under the operating system's own service manager so it
// starts at login, restarts after a crash and keeps one fixed port.
//
//   node install-service.mjs --workspace <dir> --harness codex|claude --port <n>
//        [--source <dir>] [--label <name>] [--replace]
//
// An existing definition with the same label is kept as it is (its port and settings
// are reported and it is loaded if needed) unless --replace is given.
// Prints one JSON status.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    if (name === 'replace') { out.replace = true; continue; }
    out[name] = argv[++i];
  }
  return out;
}

function run(cmd, list, options = {}) {
  try { return { ok: true, out: execFileSync(cmd, list, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }) }; }
  catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message }; }
}

function which(name) {
  const r = process.platform === 'win32' ? run('where', [name]) : run('/bin/sh', ['-c', `command -v "$1"`, 'sh', name]);
  return r.ok ? r.out.split(/\r?\n/)[0].trim() || null : null;
}

function finish(status) { process.stdout.write(JSON.stringify(status) + '\n'); process.exit(status.status === 'error' ? 1 : 0); }

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function responding(port) {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const opts = args(process.argv.slice(2));
const platform = process.platform;
const source = path.resolve(opts.source || here);
const workspace = opts.workspace ? path.resolve(opts.workspace) : null;
const harness = opts.harness;
const label = opts.label || (platform === 'darwin' ? 'com.clarity.m3ntor' : 'clarity-m3ntor');
// Prefer the PATH entry (for example /opt/homebrew/bin/node) so a node upgrade keeps working.
const node = which('node') || process.execPath;
const home = os.homedir();

// ---- Locate the definition and read an existing port -------------------------------
let file;
if (platform === 'darwin') file = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
else if (platform === 'linux') file = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', `${label}.service`);
else if (platform === 'win32') file = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ClarityM3NT0R', `${label}.xml`);
else finish({ status: 'error', platform, label, error: `Unsupported platform ${platform}.` });

function existingPort() {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  if (platform === 'darwin') { const r = run('/usr/bin/plutil', ['-extract', 'EnvironmentVariables.PORT', 'raw', '-o', '-', file]); return r.ok ? Number(r.out.trim()) : null; }
  if (platform === 'linux') { const m = text.match(/^Environment="?PORT=(\d+)"?/m); return m ? Number(m[1]) : null; }
  const cmd = path.join(path.dirname(file), `${label}.cmd`);
  const m = existsSync(cmd) && readFileSync(cmd, 'utf8').match(/set "PORT=(\d+)"/);
  return m ? Number(m[1]) : null;
}

const exists = existsSync(file);
const keep = exists && !opts.replace;
let port = keep ? existingPort() : Number(opts.port);

if (!keep) {
  const missing = [];
  if (!workspace) missing.push('--workspace');
  if (!['codex', 'claude'].includes(harness)) missing.push('--harness codex|claude');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) missing.push('--port');
  if (missing.length) finish({ status: 'missing_input', platform, label, file, missing });
  if (!existsSync(path.join(source, 'server.mjs'))) finish({ status: 'error', platform, label, error: `server.mjs not found in ${source}` });
}

// The service runs the harness CLI, so its PATH must reach node and the harness.
const pathDirs = [path.dirname(node), harness && which(harness) && path.dirname(which(harness)), ...(process.env.PATH || '').split(path.delimiter)]
  .filter(Boolean).filter((d, i, all) => all.indexOf(d) === i);
const servicePath = pathDirs.join(path.delimiter);
const logs = workspace ? path.join(workspace, '.clarity_coach', 'logs') : null;
const env = workspace ? { HOME: home, PATH: servicePath, PORT: String(port), M3NTOR_WORKSPACE: workspace, M3NTOR_HARNESS: harness } : null;

function writePrivate(target, content, mode = 0o600) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { mode });
  chmodSync(target, mode);
}

const status = { status: keep ? 'existing' : exists ? 'replaced' : 'installed', platform, label, file, port, url: port ? `http://127.0.0.1:${port}/` : null, mcp_url: port ? `http://127.0.0.1:${port}/mcp/local` : null };

// ---- macOS: LaunchAgent ------------------------------------------------------------
if (platform === 'darwin') {
  const domain = `gui/${process.getuid()}`;
  const loaded = () => run('/bin/launchctl', ['print', `${domain}/${label}`]);
  if (!keep) {
    if (loaded().ok) run('/bin/launchctl', ['bootout', `${domain}/${label}`]);
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
  if (!loaded().ok) {
    let r = run('/bin/launchctl', ['bootstrap', domain, file]);
    for (let i = 0; !r.ok && i < 5; i++) { await new Promise((ok) => setTimeout(ok, 1000)); r = run('/bin/launchctl', ['bootstrap', domain, file]); }
    if (!r.ok) finish({ ...status, status: 'error', loaded: false, error: r.out });
  }
  const info = loaded();
  status.loaded = info.ok;
  status.pid = Number(info.out.match(/\bpid = (\d+)/)?.[1]) || null;
}

// ---- Linux: systemd user unit ------------------------------------------------------
if (platform === 'linux') {
  const ctl = (...a) => run('systemctl', ['--user', ...a]);
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
StandardOutput=append:${path.join(logs, 'mcp.log')}
StandardError=append:${path.join(logs, 'mcp.stderr.log')}

[Install]
WantedBy=default.target
`);
    ctl('daemon-reload');
    if (exists) ctl('restart', `${label}.service`);
  }
  const r = ctl('enable', '--now', `${label}.service`);
  if (!r.ok) finish({ ...status, status: 'error', loaded: false, error: r.out });
  status.loaded = ctl('is-enabled', `${label}.service`).ok;
  status.pid = Number(ctl('show', '-p', 'MainPID', '--value', `${label}.service`).out?.trim()) || null;
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
  status.loaded = q.ok;
  if (q.ok && !/Running/i.test(q.out)) run('schtasks', ['/Run', '/TN', label]);
  status.pid = null;
}

status.responding = port ? await responding(port) : false;
finish(status);
