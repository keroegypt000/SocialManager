// Web Push without any outside service. The push carries no data: the phone's service
// worker wakes up, asks the platform how many WhatsApp statuses are waiting, and shows
// the notification. That way we only need the VAPID signature, not payload encryption.
//
// The VAPID key pair is generated on first use and kept in the settings table.

const enc = new TextEncoder();

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getVapid(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'vapid'").first();
  if (row) return JSON.parse(row.value);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const vapid = {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
  };
  // INSERT OR IGNORE: if two requests raced, keep whichever was saved first.
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)").bind(JSON.stringify(vapid)).run();
  const saved = await env.DB.prepare("SELECT value FROM settings WHERE key = 'vapid'").first();
  return JSON.parse(saved.value);
}

export async function publicKey(env) {
  return (await getVapid(env)).publicKey;
}

async function vapidHeader(vapid, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${vapid.publicKey}`;
}

export async function subscribe(env, endpoint) {
  if (!/^https:\/\//.test(String(endpoint || ''))) throw new Error('اشتراك غير صالح');
  await env.DB.prepare('INSERT OR REPLACE INTO push_subscriptions (endpoint, created_at) VALUES (?, ?)').bind(endpoint, Date.now()).run();
}

// Wake every subscribed phone/browser. Returns how many accepted the push.
export async function notifyAll(env) {
  const { results } = await env.DB.prepare('SELECT endpoint FROM push_subscriptions').all();
  if (!results.length) return 0;
  const vapid = await getVapid(env);
  const subject = env.PUSH_SUBJECT || 'https://socialmanager.app';
  let ok = 0;
  for (const { endpoint } of results) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: await vapidHeader(vapid, endpoint, subject), TTL: '86400', Urgency: 'high', 'Content-Length': '0' },
      });
      if (res.status === 404 || res.status === 410) {
        // The phone unsubscribed or the browser data was cleared.
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
      } else if (res.ok) {
        ok++;
      } else {
        console.error('push rejected', res.status, await res.text().catch(() => ''));
      }
    } catch (err) {
      console.error('push error', err);
    }
  }
  return ok;
}
