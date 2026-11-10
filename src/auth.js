import { sign, verify, sha256, safeEqual } from './crypto.js';

const COOKIE = 'sm_session';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function requireSecrets(env) {
  const missing = ['ADMIN_PASSWORD', 'SESSION_SECRET'].filter((k) => !env[k]);
  if (missing.length) throw new Error('ناقص إعدادات سرية في Cloudflare: ' + missing.join(', '));
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export async function checkPassword(env, password) {
  return safeEqual(await sha256(String(password || '')), await sha256(env.ADMIN_PASSWORD));
}

export async function sessionCookie(env) {
  const exp = Date.now() + TTL_MS;
  const sig = await sign(env.SESSION_SECRET, 'session.' + exp);
  return `${COOKIE}=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_MS / 1000}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function isAuthed(req, env) {
  const value = parseCookies(req.headers.get('Cookie'))[COOKIE];
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return verify(env.SESSION_SECRET, 'session.' + exp, sig);
}

// OAuth "state", signed so it can't be forged. `subject` is either a client id
// (you connecting from the dashboard) or "inv-<token>" (a client using an invite link).
export async function makeState(env, subject) {
  const data = `${subject}.${Date.now() + 15 * 60 * 1000}`;
  return `${data}.${await sign(env.SESSION_SECRET, 'state.' + data)}`;
}

export async function readState(env, state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return null;
  const [subject, exp, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  if (!(await verify(env.SESSION_SECRET, `state.${subject}.${exp}`, sig))) return null;
  return subject;
}
