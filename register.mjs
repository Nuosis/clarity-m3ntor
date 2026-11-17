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
      // -X takes hex, so any password characters survive the `security -i` parser.
      child.stdin.end(`add-generic-password -U -s "${service}" -a "${account}" -X ${Buffer.from(value, 'utf8').toString('hex')}\n`);
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
const suppliedPassword = Boolean(opts['password-stdin']);
let jwt = null;
let created_account = false;
let loginError = null;

const login = async () => {
  const result = await httpJson('POST', `${apiUrl}/auth/login`, { data: { email, password } });
  loginError = result.ok ? null : (result.payload?.error?.message || `HTTP ${result.status}`);
  return result.ok ? sessionJwt(result.response) : null;
};

// The installation identity is fixed before any server call, so a lost
// registration response or failed local save is recovered, never duplicated.
let profile = { ...(existing || {}), api_url: apiUrl, email };
profile.installation_id ||= randomUUID();
const installation_id = profile.installation_id;
const saveProfile = async patch => { profile = { ...profile, ...patch }; await writeProfile(profile); };
if (!existing?.installation_id || existing?.email !== email) await saveProfile({});

if (password) jwt = await login();
// A supplied password that signs in is kept for later token recovery.
if (jwt && suppliedPassword) await secretPut(ACCOUNT_SERVICE, email, password);
const registrationFields = { installation_id, harness: opts.harness || null, company_name: opts.company || null, username: opts.username || null };
let registration;
// "I forgot": an existing account is claimed with a one-time code that Clarity sent by
// A2A to an agent the account's organization already has. No password is involved.
const forgot = async () => {
  const sent = await httpJson('POST', `${apiUrl}/agent/mentor/forgot`, { data: { email, installation_id, deliver_to: opts['deliver-to'] } });
  if (!sent.ok) done(1, { status: 'error', step: 'forgot', http_status: sent.status, error: sent.payload?.error?.message || sent.payload });
  done(2, { status: 'code_sent', deliver_to: opts['deliver-to'], expires_in_minutes: sent.payload.expires_in_minutes, next: `Read the M3NT0R registration code from ${opts['deliver-to']}'s A2A inbox and rerun with --code <code>.` });
};
if (opts.code) {
  registration = await httpJson('POST', `${apiUrl}/agent/mentor/registrations/claim`, { data: { email, code: opts.code, ...registrationFields } });
} else if (jwt) {
  registration = await httpJson('POST', `${apiUrl}/agent/mentor/registrations`, { bearer: jwt, data: registrationFields });
} else if (!suppliedPassword && (!password || profile.pending_signup)) {
  // New account: one call creates the confirmed account and registers this
  // installation; no email access is needed. The generated password is stored
  // (and the signup marked pending) first, so a lost response is retried with it.
  if (!password) {
    password = randomBytes(24).toString('base64url');
    await saveProfile({ pending_signup: true });
    await secretPut(ACCOUNT_SERVICE, email, password);
  }
  registration = await httpJson('POST', `${apiUrl}/agent/mentor/signup`, { data: { email, password, ...registrationFields } });
  if (registration.status === 409) {
    if (opts['deliver-to']) await forgot();
    done(1, { status: 'error', step: 'signup', http_status: 409, detail: 'A Clarity account already exists for this email. Rerun with --deliver-to <handle of an A2A agent your organization already has> to get a one-time code by A2A.' });
  }
  if (registration.ok) { await saveProfile({ pending_signup: false }); created_account = true; }
} else {
  if (opts['deliver-to']) await forgot();
  done(1, { status: 'error', step: 'signin', login_error: loginError, detail: 'Sign-in failed with the stored password. Rerun with --deliver-to <handle of an A2A agent your organization already has> to get a one-time code by A2A.' });
}
if (!registration.ok) done(1, { status: 'error', step: 'registration', http_status: registration.status, error: registration.payload?.error?.message || registration.payload, retry: 'Rerun the same command; the installation and any generated password are kept.' });
const { token, ...identity } = registration.payload;
const token_command = await secretPut(TOKEN_SERVICE, identity.agent_id, token);
delete profile.token_env; // the stored token command replaces any rejected injected token
await saveProfile({
  organization_id: identity.organization_id, agent_id: identity.agent_id, agent_handle: identity.agent_handle,
  capabilities: identity.capabilities, token_command, registered_at: new Date().toISOString(),
});
const me = await clarityRequest('GET', '/agent/mentor/me');
done(0, { status: 'registered', profile: profilePath(), created_account, created_agent: identity.created_agent, token_id: identity.token_id, ...me });
