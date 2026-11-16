import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// One shared HTTPS client for Clarity remote operations, authenticated by this
// installation's registered clrtok_ token. register.mjs writes the profile.
const exec = promisify(execFile);
export const profilePath = () => process.env.M3NTOR_CONFIG || path.join(os.homedir(), '.config', 'clarity_m3ntor', 'config.json');
export const defaultApiUrl = 'https://api.claritycustomsoftware.com';

export async function loadProfile() {
  let profile;
  try { profile = JSON.parse(await readFile(profilePath(), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error(`This installation is not registered with Clarity (${profilePath()} is missing). Run: node register.mjs --email <owner email>`);
    throw new Error(`The Clarity connection profile could not be read: ${e.message}`);
  }
  if (typeof profile.api_url !== 'string') throw new Error('The Clarity connection profile lacks api_url.');
  return profile;
}

export async function readToken(profile) {
  if (typeof profile.token_env === 'string' && profile.token_env) {
    const value = process.env[profile.token_env]?.trim();
    if (value) return value;
    throw new Error(`The Clarity token variable ${profile.token_env} is not set.`);
  }
  const command = profile.token_command;
  if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string')) throw new Error('The Clarity connection profile needs token_env or a token_command argument array.');
  let stdout;
  try { ({ stdout } = await exec(command[0], command.slice(1), { timeout: 30000, env: process.env })); }
  // Never echo command output; it may contain the secret.
  catch (error) { throw new Error(`The Clarity token command failed (${error.code || error.name}).`); }
  const token = stdout.trim();
  if (!token) throw new Error('The Clarity token command returned no token.');
  return token;
}

export async function httpJson(method, url, { bearer, data, headers = {} } = {}) {
  const body = data === undefined ? undefined : JSON.stringify(data);
  let response;
  try {
    response = await fetch(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers },
      ...(body ? { body } : {}),
    });
  } catch (error) { throw new Error(`Clarity API request failed (${error.name}). No automatic retry was started.`); }
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Clarity API returned non-JSON data (HTTP ${response.status}).`); }
  const payload = parsed && parsed.success === true && Object.hasOwn(parsed, 'data') ? parsed.data : parsed;
  return { status: response.status, ok: response.ok, payload, response };
}

export async function clarityRequest(method, route, data) {
  const profile = await loadProfile();
  const token = await readToken(profile);
  const url = new URL(route.replace(/^\/+/, ''), profile.api_url.endsWith('/') ? profile.api_url : profile.api_url + '/');
  const result = await httpJson(method, url, { bearer: token, data });
  if (!result.ok) {
    const reason = result.payload?.error?.message || result.payload?.detail || JSON.stringify(result.payload);
    throw new Error(`Clarity API ${method} ${new URL(url).pathname} failed (HTTP ${result.status}): ${reason}`);
  }
  return result.payload;
}
