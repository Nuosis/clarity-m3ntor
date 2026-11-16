import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const exec = promisify(execFile);
const exists = file => access(file).then(() => true, () => false);

export async function inspectBridge() {
  let installed = false, observed = {};
  try {
    const response = await exec('a2a-bridge', ['status'], { timeout: 10000, maxBuffer: 2_000_000 });
    installed = true;
    const health = JSON.parse(response.stdout).health || {};
    observed = { realtime: health.realtime?.status || 'unknown', runtime: health.runtime_connection?.status || 'unknown', observation: 'Last recorded bridge health; not a new delivery check.' };
  } catch (e) { installed = e.code !== 'ENOENT'; }
  let serviceRunning = false;
  if (process.platform === 'darwin') {
    try { const response = await exec('launchctl', ['print', `gui/${process.getuid()}/com.clarity.a2a-bridge`], { timeout: 5000 }); serviceRunning = /state = running/.test(response.stdout); } catch {}
  }
  return { installed, serviceRunning, lastObserved: observed, communicationVerified: false, checkedAt: new Date().toISOString() };
}

export async function establishBridge() {
  const existing = await inspectBridge();
  if (existing.installed && existing.serviceRunning) return { ...existing, action: 'Reused the existing running bridge; preserved its identity and configuration.' };
  const config = path.join(os.homedir(), '.config/a2a-bridge/config.json');
  if (!(await exists(config))) return { ...existing, setupNeeded: 'No existing bridge configuration was found. Discover the documented registration and configuration route in owner context; do not invent credentials or an agent identity.' };
  try {
    if (existing.installed) await exec('a2a-bridge', ['install'], { timeout: 30000, maxBuffer: 500_000 });
    else {
      const source = path.join(os.homedir(), 'python/a2a-bridge');
      if (!(await exists(path.join(source, 'pyproject.toml')))) return { ...existing, setupNeeded: 'No bridge executable or established local installation source was found. An identified installation source is needed.' };
      await exec('uv', ['sync'], { cwd: source, timeout: 60000, maxBuffer: 500_000 });
      await exec('uv', ['run', 'a2a-bridge', '--config', config, 'install'], { cwd: source, timeout: 30000, maxBuffer: 500_000 });
    }
    return { ...await inspectBridge(), action: 'Applied the documented bridge installation using the existing configuration.' };
  } catch (e) { return { ...await inspectBridge(), setupNeeded: `Bridge setup did not complete (${e.code || 'command error'}). No automatic retry was started.` }; }
}
