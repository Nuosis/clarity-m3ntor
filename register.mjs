#!/usr/bin/env node
// Headless Clarity sign-up/sign-in and M3NT0R installation registration.
// Prints one JSON status object; secrets go only to the owner's secret store.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { clarityRequest, defaultApiUrl, httpJson, profilePath } from './clarity-client.mjs';

const exec = promisify(execFile);
const ACCOUNT_SERVICE = 'clarity_m3ntor_account';
const TOKEN_SERVICE = 'clarity_m3ntor';
const secretsDir = () => path.join(path.dirname(profilePath()), 'secrets');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'password-stdin') out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}
const done = (code, value) => { console.log(JSON.stringify(value, null, 2)); process.exit(code); };

// macOS Keychain via `security -i` so values never appear in process arguments;
// elsewhere an owner-only file read back by the token command.
async function secretPut(service, account, value) {
  if (process.platform === 'darwin') {
    await new Promise((resolve, reject) => {
      const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => (code === 0 && !stderr.trim() ? resolve() : reject(new Error(`Keychain write failed (${code}).`))));
      child.stdin.end(`add-generic-password -U -s "${service}" -a "${account}" -w "${value}"\n`);
    });
    return ['security', 'find-generic-password', '-s', service, '-a', account, '-w'];
  }
  await mkdir(secretsDir(), { recursive: true, mode: 0o700 });
  const file = path.join(secretsDir(), `${service}__${account}`);
  await writeFile(file, value, { mode: 0o600 });
  return ['cat', file];
}

async function secretGet(service, account) {
  try {
    if (process.platform === 'darwin') return (await exec('security', ['find-generic-password', '-s', service, '-a', account, '-w'])).stdout.trim() || null;
    return (await readFile(path.join(secretsDir(), `${service}__${account}`), 'utf8')).trim() || null;
  } catch { return null; }
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

const sessionJwt = response => {
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('clarity_access_token='));
  return cookie ? decodeURIComponent(cookie.split(';')[0].slice('clarity_access_token='.length)) : null;
};

async function readProfile() {
  try { return JSON.parse(await readFile(profilePath(), 'utf8')); } catch { return null; }
}

async function writeProfile(profile) {
  await mkdir(path.dirname(profilePath()), { recursive: true, mode: 0o700 });
  const temporary = `${profilePath()}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, profilePath());
}

const opts = args(process.argv.slice(2));
const existing = await readProfile();
const apiUrl = (opts.api || existing?.api_url || defaultApiUrl).replace(/\/+$/, '');

// Later starts: a valid stored token is the sign-in.
if (existing?.token_command || existing?.token_env) {
  try {
    const identity = await clarityRequest('GET', '/agent/mentor/me');
    done(0, { status: 'signed_in', profile: profilePath(), ...identity });
  } catch (error) {
    if (!/HTTP 40[13]/.test(error.message)) done(1, { status: 'error', step: 'token_sign_in', error: error.message });
    // Rejected token: recover by re-registering the same installation below.
  }
}

const email = opts.email || existing?.email;
if (!email) done(1, { status: 'missing_input', input: 'email', detail: "The owner's account email is required: node register.mjs --email <owner email>" });

let password = opts['password-stdin'] ? await readStdin() : await secretGet(ACCOUNT_SERVICE, email);
let jwt = null;
let created_account = false;

const login = async () => {
  const result = await httpJson('POST', `${apiUrl}/auth/login`, { data: { email, password } });
  return result.ok ? sessionJwt(result.response) : null;
};

if (password) jwt = await login();
if (!jwt && !password) {
  password = randomBytes(24).toString('base64url');
  await secretPut(ACCOUNT_SERVICE, email, password);
  const signup = await httpJson('POST', `${apiUrl}/auth/signup`, { data: { email, password, company_name: opts.company || null, username: opts.username || null } });
  if (!signup.ok) done(1, { status: 'error', step: 'signup', http_status: signup.status, error: signup.payload?.error?.message || signup.payload });
  created_account = true;
  jwt = signup.payload.authenticated ? sessionJwt(signup.response) : null;
  if (!jwt && signup.payload.verification_pending && !opts['verify-url']) {
    done(2, { status: 'verification_pending', email, account_password_stored: `${ACCOUNT_SERVICE}/${email}`, next: 'Read the Clarity confirmation email in the owner\'s inbox and rerun with --verify-url "<confirmation link>".' });
  }
}
if (!jwt && opts['verify-url']) {
  // Follow the emailed confirmation link over plain HTTPS, hop by hop through any
  // click-tracking redirect, until the auth service's verify step answers.
  let link = new URL(opts['verify-url']);
  let verifiedAt = null;
  for (let hop = 0; hop < 6 && !verifiedAt; hop++) {
    const reply = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const location = reply.headers.get('location');
    if (link.pathname.endsWith('/auth/v1/verify')) {
      if (reply.status >= 400 || /error/.test(location || '')) done(1, { status: 'error', step: 'email_verification', http_status: reply.status, detail: (location || '').replace(/#.*/, '').replace(/[?&](access|refresh)_token=[^&]*/g, '') || 'Confirmation link was rejected.' });
      verifiedAt = link.origin;
    } else if (location && reply.status >= 300 && reply.status < 400) link = new URL(location, link);
    else break;
  }
  if (!verifiedAt) done(1, { status: 'error', step: 'email_verification', detail: 'The link did not lead to an /auth/v1/verify confirmation step.' });
  jwt = await login();
}
if (!jwt) {
  done(1, created_account
    ? { status: 'error', step: 'signin', detail: 'Signup was accepted but sign-in failed. If this email already had a Clarity account, supply its password with --password-stdin.' }
    : { status: 'error', step: 'signin', detail: 'Sign-in failed with the stored or supplied password. Supply the account password with --password-stdin.' });
}

const installation_id = existing?.installation_id || randomUUID();
const registration = await httpJson('POST', `${apiUrl}/agent/mentor/registrations`, {
  bearer: jwt,
  data: { installation_id, harness: opts.harness || null, company_name: opts.company || null, username: opts.username || null },
});
if (!registration.ok) done(1, { status: 'error', step: 'registration', http_status: registration.status, error: registration.payload?.error?.message || registration.payload });
const { token, ...identity } = registration.payload;
const token_command = await secretPut(TOKEN_SERVICE, identity.agent_id, token);
await writeProfile({
  api_url: apiUrl, email, installation_id,
  organization_id: identity.organization_id, agent_id: identity.agent_id, agent_handle: identity.agent_handle,
  capabilities: identity.capabilities, token_command, registered_at: new Date().toISOString(),
});
const me = await clarityRequest('GET', '/agent/mentor/me');
done(0, { status: 'registered', profile: profilePath(), created_account, created_agent: identity.created_agent, token_id: identity.token_id, ...me });
