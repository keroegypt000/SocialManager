// Small WebCrypto helpers: HMAC signing for sessions/OAuth state, AES-GCM for stored tokens.
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const b = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function sha256(text) {
  return toB64(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function sign(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toB64(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function verify(secret, data, sig) {
  return safeEqual(await sign(secret, data), sig);
}

async function aesKey(secret) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('token-encryption:' + secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(text));
  return toB64(iv) + '.' + toB64(ct);
}

export async function decrypt(secret, payload) {
  const [iv, ct] = payload.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await aesKey(secret), fromB64(ct));
  return dec.decode(pt);
}
