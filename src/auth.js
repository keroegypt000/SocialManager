import { sign, verify, sha256, safeEqual } from './crypto.js';

const COOKIE = 'sm_session';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Everything a team member can be allowed to do (the owner can do all of it).
export const PERMS = ['posts', 'whatsapp', 'reports', 'ads'];

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

// ---------- team member passwords: PBKDF2-SHA256 with a random salt ----------
const ITER = 100000; // Workers' maximum for PBKDF2
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITER))}`;
}

export async function verifyPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored || '').split('$');
  if (kind !== 'pbkdf2' || !salt || !hash) return false;
  return safeEqual(b64(await pbkdf2(password, unb64(salt), Number(iter))), hash);
}

// ---------- sessions ----------
// Cookie: <uid>.<exp>.<ver>.<sig>. uid 0 is the owner (ADMIN_PASSWORD). `ver` is the
// member's session_ver, bumped on password change / disable, which logs them out.
export async function sessionCookie(env, uid = 0, ver = 0) {
  const exp = Date.now() + TTL_MS;
  const sig = await sign(env.SESSION_SECRET, `session.${uid}.${exp}.${ver}`);
  return `${COOKIE}=${uid}.${exp}.${ver}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_MS / 1000}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

const OWNER = Object.freeze({ id: 0, owner: true, name: 'المالك', username: 'admin', clients: null, perms: PERMS });

// Who is calling: the owner, an active team member, or null.
export async function currentUser(req, env) {
  const value = parseCookies(req.headers.get('Cookie'))[COOKIE];
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length === 2) {
    // Older owner cookie (before team members existed).
    const [exp, sig] = parts;
    if (Number(exp) < Date.now()) return null;
    return (await verify(env.SESSION_SECRET, 'session.' + exp, sig)) ? OWNER : null;
  }
  if (parts.length !== 4) return null;
  const [uid, exp, ver, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  if (!(await verify(env.SESSION_SECRET, `session.${uid}.${exp}.${ver}`, sig))) return null;
  if (uid === '0') return OWNER;
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(Number(uid)).first();
  if (!row || String(row.session_ver) !== ver) return null;
  return memberFromRow(row);
}

export function memberFromRow(row) {
  let clients = [];
  let perms = [];
  try { clients = JSON.parse(row.clients || '[]'); } catch { /* none */ }
  try { perms = JSON.parse(row.perms || '[]'); } catch { /* none */ }
  return {
    id: row.id, owner: false, name: row.name, username: row.username,
    clients: clients === '*' ? null : clients.map(Number), perms: perms.filter((p) => PERMS.includes(p)),
  };
}

export async function isAuthed(req, env) {
  return !!(await currentUser(req, env));
}

export async function isOwner(req, env) {
  return !!(await currentUser(req, env))?.owner;
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
