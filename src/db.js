// Database schema. Tables are created automatically on first request,
// so there is no separate migration step to run.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#4f46e5',
    notes TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    picture TEXT,
    token_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (client_id, platform, external_id)
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    message TEXT NOT NULL DEFAULT '',
    image_url TEXT,
    link TEXT,
    scheduled_at INTEGER,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS post_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    external_post_id TEXT,
    error TEXT
  )`,
  // Pages returned by Facebook, waiting for the user to pick which ones belong to the client.
  `CREATE TABLE IF NOT EXISTS pending_links (
    token TEXT PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    payload_enc TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // Invite links a client opens to connect their own pages.
  `CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  )`,
  // Reports: cached results (live Graph API calls are slow) and read-only links for clients.
  `CREATE TABLE IF NOT EXISTS report_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS report_links (
    token TEXT PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // Small key/value store (e.g. the web-push keys, generated on first use).
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Phones/browsers that asked for notifications.
  `CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_due ON posts (status, scheduled_at)`,
  `CREATE INDEX IF NOT EXISTS idx_targets_post ON post_targets (post_id)`,
];

const MIGRATIONS = [
  'ALTER TABLE posts ADD COLUMN series_id TEXT',
  'CREATE INDEX IF NOT EXISTS idx_posts_series ON posts (series_id)',
  // media: JSON [{type:'image'|'video', url}], several images = album (carousel)
  'ALTER TABLE posts ADD COLUMN media TEXT',
  'ALTER TABLE posts ADD COLUMN fb_reel INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE posts ADD COLUMN media_cleaned INTEGER NOT NULL DEFAULT 0',
  // When an Instagram video started processing (status 'processing').
  'ALTER TABLE post_targets ADD COLUMN started_at INTEGER',
];

let ready = false;

export async function ensureSchema(env) {
  if (ready) return;
  if (!env.DB) throw new Error('قاعدة البيانات (D1) مش مربوطة. راجع خطوة إنشاء D1 في ملف README.');
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  // Columns added after the first release (CREATE TABLE IF NOT EXISTS won't add them).
  for (const sql of MIGRATIONS) {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      if (!/duplicate column/i.test(String(err.message))) throw err;
    }
  }
  ready = true;
}
