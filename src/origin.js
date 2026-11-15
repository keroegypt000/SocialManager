// The site's address can change (e.g. renaming the Cloudflare account subdomain).
// Uploaded photos/videos are saved in posts as full links, and Facebook/Instagram
// download them from those links, so when the site is opened from a new address
// we rewrite the saved links once to the new address.
let known = null;

export async function trackOrigin(env, origin) {
  if (!/^https:\/\//.test(origin) || /localhost|127\.0\.0\.1/.test(origin)) return;
  // On workers.dev only the real addresses count: "som." (the short front door, a tiny
  // worker that forwards here) or "socialmanager." itself; preview links don't.
  const host = new URL(origin).hostname;
  if (host.endsWith('.workers.dev') && !/^(som|socialmanager)\./.test(host)) return;
  if (known === origin) return;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site_origin'").first();
  const old = row?.value;
  // Once the short "som." address is in use, visits to the long one don't move links back.
  if (old && /^https:\/\/som\./.test(old) && host.startsWith('socialmanager.')) { known = origin; return; }
  if (old && old !== origin) {
    await env.DB.batch([
      env.DB.prepare('UPDATE posts SET media = replace(media, ?, ?) WHERE instr(media, ?) > 0').bind(old, origin, old),
      env.DB.prepare('UPDATE posts SET image_url = replace(image_url, ?, ?) WHERE instr(image_url, ?) > 0').bind(old, origin, old),
    ]);
    console.log('site address changed', old, '->', origin);
  }
  if (old !== origin) {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('site_origin', ?)").bind(origin).run();
  }
  known = origin;
}
