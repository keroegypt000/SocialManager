// Our own WhatsApp gateway, running inside Cloudflare (no outside service).
// One Durable Object per WhatsApp account. It links the number like WhatsApp Web
// (QR scan), keeps the login keys in its own storage, and connects only when needed:
// while you scan the QR, to post a status, and once a day to stay linked and refresh
// the contact list (statuses go to these contacts).
import './patches.js'; // must run before Baileys encodes anything
import { DurableObject } from 'cloudflare:workers';
import makeWASocket, { initAuthCreds, BufferJSON, DisconnectReason, generateWAMessageFromContent } from 'baileys';
import { prepareStatusMedia } from './media.js';
import QRCode from 'qrcode';

const IDLE_MS = 3 * 60 * 1000; // close the connection after this much quiet time
const FIRST_SYNC_MS = 6 * 60 * 1000; // after linking, stay a bit longer to receive contacts
const enc = (v) => JSON.stringify(v, BufferJSON.replacer);
const dec = (s) => (s == null ? undefined : JSON.parse(s, BufferJSON.reviver));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isUser = (jid) => typeof jid === 'string' && /@(s\.whatsapp\.net|lid)$/.test(jid);

export class WhatsAppGateway extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS contacts (jid TEXT PRIMARY KEY, pn TEXT, name TEXT)');
    this.sock = null;
    this.status = 'offline'; // offline | connecting | qr | open | logged_out
    this.qr = null;
    this.lastError = null;
    this.openWaiters = [];
  }

  // ---------- storage ----------
  get(k) { return this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]?.v ?? null; }
  put(k, v) { this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, v); }
  del(k) { this.sql.exec('DELETE FROM kv WHERE k = ?', k); }

  authState() {
    const creds = dec(this.get('creds')) || initAuthCreds();
    const keys = {
      get: async (type, ids) => {
        const out = {};
        for (const id of ids) {
          const v = dec(this.get(`key:${type}:${id}`));
          if (v !== undefined) out[id] = v;
        }
        return out;
      },
      set: async (data) => {
        this.ctx.storage.transactionSync(() => {
          for (const type in data) {
            for (const id in data[type]) {
              const v = data[type][id];
              if (v == null) this.del(`key:${type}:${id}`);
              else this.put(`key:${type}:${id}`, enc(v));
            }
          }
        });
      },
    };
    return { creds, keys };
  }

  saveContacts(list) {
    this.ctx.storage.transactionSync(() => {
      for (const c of list || []) {
        const jid = c.id;
        if (!isUser(jid)) continue;
        const pn = c.phoneNumber || (jid.endsWith('@s.whatsapp.net') ? jid : null);
        const name = c.name || c.notify || c.verifiedName || null;
        this.sql.exec(
          `INSERT INTO contacts (jid, pn, name) VALUES (?, ?, ?)
           ON CONFLICT(jid) DO UPDATE SET pn = COALESCE(excluded.pn, contacts.pn), name = COALESCE(excluded.name, contacts.name)`,
          jid, pn, name
        );
      }
    });
  }

  contactCount() { return this.sql.exec('SELECT COUNT(*) AS n FROM contacts').toArray()[0].n; }

  // Who receives a status: every known contact, by phone-number JID when we have it.
  audience() {
    const me = dec(this.get('creds'))?.me;
    const mine = new Set([me?.id, me?.lid].filter(Boolean).map((j) => j.replace(/:\d+@/, '@')));
    const set = new Set();
    for (const r of this.sql.exec('SELECT jid, pn FROM contacts').toArray()) {
      const j = r.pn || r.jid;
      if (!mine.has(j)) set.add(j);
    }
    return [...set];
  }

  // ---------- connection ----------
  async connect() {
    if (this.sock && ['connecting', 'qr', 'open'].includes(this.status)) return;
    this.status = 'connecting';
    this.lastError = null;
    const { creds, keys } = this.authState();
    const sock = makeWASocket({
      auth: { creds, keys },
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      fireInitQueries: true,
      generateHighQualityLinkPreview: false,
      browser: ['Social Manager', 'Chrome', '1.0'],
    });
    this.sock = sock;

    sock.ev.on('creds.update', (update) => {
      const cur = dec(this.get('creds')) || creds;
      this.put('creds', enc({ ...cur, ...update }));
    });
    sock.ev.on('contacts.upsert', (list) => this.saveContacts(list));
    sock.ev.on('contacts.update', (list) => this.saveContacts(list.filter((c) => c.id)));
    sock.ev.on('messaging-history.set', ({ contacts, chats }) => {
      this.saveContacts(contacts);
      this.saveContacts((chats || []).filter((c) => isUser(c.id)).map((c) => ({ id: c.id, name: c.name })));
    });

    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        this.status = 'qr';
        this.qr = u.qr;
        this.touch();
      }
      if (u.connection === 'open') {
        this.status = 'open';
        this.qr = null;
        const firstTime = !this.get('linked_at');
        if (firstTime) this.put('linked_at', String(Date.now()));
        this.put('last_open', String(Date.now()));
        this.openWaiters.splice(0).forEach((w) => w.resolve());
        this.touch(firstTime ? FIRST_SYNC_MS : IDLE_MS);
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        this.sock = null;
        if (code === DisconnectReason.loggedOut) {
          this.status = 'logged_out';
          this.wipe();
          this.openWaiters.splice(0).forEach((w) => w.reject(new Error('الرقم اتفصل من الأجهزة المرتبطة. امسح الكود تاني من صفحة العملاء.')));
          return;
        }
        if (code === DisconnectReason.restartRequired || (this.wantOpen && code !== DisconnectReason.connectionReplaced)) {
          // Normal right after scanning the QR: WhatsApp asks for a fresh connection.
          this.status = 'offline';
          await sleep(500);
          this.connect().catch((e) => { this.lastError = e.message; });
          return;
        }
        this.status = 'offline';
        this.lastError = u.lastDisconnect?.error?.message || null;
        this.openWaiters.splice(0).forEach((w) => w.reject(new Error(this.lastError || 'الاتصال بواتساب اتقفل')));
      }
    });
  }

  waitOpen(ms = 40000) {
    if (this.status === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('واتساب مردش في الوقت. جرّب تاني بعد شوية.')), ms);
      this.openWaiters.push({ resolve: () => { clearTimeout(t); resolve(); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }

  // Close the connection after a quiet period (alarm survives the object sleeping).
  touch(ms = IDLE_MS) {
    this.ctx.storage.setAlarm(Date.now() + ms);
  }

  async alarm() {
    if (this.wantOpen) { this.touch(); return; }
    await this.disconnect();
  }

  async disconnect() {
    const s = this.sock;
    this.sock = null;
    this.wantOpen = false;
    if (s) {
      try { s.end(undefined); } catch { /* ignore */ }
    }
    if (this.status !== 'logged_out') this.status = 'offline';
    this.qr = null;
  }

  wipe() {
    this.sql.exec('DELETE FROM kv');
    this.sql.exec('DELETE FROM contacts');
  }

  isLinked() { return !!dec(this.get('creds'))?.me; }

  // ---------- RPC methods (called from the Worker) ----------

  // What the "⚡ تلقائي" dialog shows: linked info, or a QR to scan.
  async link() {
    if (!this.isLinked() || this.status === 'qr') {
      if (this.status === 'logged_out') this.status = 'offline';
      await this.connect();
      for (let i = 0; i < 30 && !this.qr && this.status !== 'open'; i++) await sleep(200);
      this.touch(2 * 60 * 1000);
      if (this.qr) {
        return { connected: false, qr: await QRCode.toString(this.qr, { type: 'svg', margin: 1, width: 260 }), state: this.status };
      }
    }
    return this.info();
  }

  info() {
    const me = dec(this.get('creds'))?.me;
    return {
      connected: !!me,
      online: this.status === 'open',
      phone: me?.id ? me.id.split(/[:@]/)[0] : null,
      name: me?.name || null,
      contacts: this.contactCount(),
      linked_at: Number(this.get('linked_at')) || null,
      last_open: Number(this.get('last_open')) || null,
      error: this.lastError,
    };
  }

  // Post one status: { text } or { media: {type, url}, caption }.
  async postStatus({ text, media, caption, background = '#128C7E' }) {
    if (!this.isLinked()) throw new Error('الرقم مش مربوط. افتح ⚡ تلقائي وامسح الكود.');
    this.wantOpen = true;
    try {
      await this.connect();
      await this.waitOpen();
      // Give WhatsApp a moment to deliver pending notifications after connecting.
      await sleep(2500);
      const audience = this.audience();
      if (!audience.length) {
        throw new Error('لسه مفيش جهات اتصال وصلت من الموبايل، فالحالة مش هتوصل لحد. افتح واتساب على الموبايل شوية وجرّب تاني بعد 10 دقايق.');
      }
      let id;
      if (media) {
        // Our own media path (no temp files): read from storage, encrypt, upload, relay.
        const content = await prepareStatusMedia(this.env, this.sock, media, caption);
        const msg = generateWAMessageFromContent('status@broadcast', content, { userJid: this.sock.user.id });
        await this.sock.relayMessage('status@broadcast', msg.message, { messageId: msg.key.id, statusJidList: audience });
        id = msg.key.id;
      } else {
        const msg = await this.sock.sendMessage('status@broadcast', { text }, {
          statusJidList: audience,
          backgroundColor: background,
          font: 1,
          broadcast: true,
        });
        id = msg?.key?.id;
      }
      this.put('last_status', String(Date.now()));
      return { id: id || 'ok', audience: audience.length };
    } catch (err) {
      // Keep where it broke, so a failure message is useful.
      const where = String(err.stack || '').split('\n').slice(1, 3).map((l) => l.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' < ');
      console.error('wa postStatus', err.stack || err);
      throw new Error(`${err.message}${where ? ` [${where}]` : ''}`.slice(0, 480));
    } finally {
      this.wantOpen = false;
      this.touch();
    }
  }

  // Local tests only (WA_MEDIA_TEST_HTTP set): run the media path against a fake media host.
  async debugPrepareMedia(media) {
    if (!this.env.WA_MEDIA_TEST_HTTP) throw new Error('not available');
    const fake = { refreshMediaConn: async () => ({ auth: 'test', hosts: [{ hostname: this.env.WA_MEDIA_TEST_HTTP }] }) };
    const c = await prepareStatusMedia(this.env, fake, media, 'cap');
    const m = c.imageMessage || c.videoMessage;
    return { type: Object.keys(c)[0], url: m.url, len: m.fileLength, enc: m.fileEncSha256.toString('base64') };
  }

  // Daily: come online briefly so the link stays alive and contacts stay fresh.
  async keepAlive() {
    if (!this.isLinked()) return { skipped: true };
    await this.connect();
    await this.waitOpen().catch(() => {});
    this.touch(90 * 1000);
    return this.info();
  }

  async logout() {
    try {
      if (this.isLinked()) {
        await this.connect();
        await this.waitOpen(15000);
        await this.sock?.logout();
      }
    } catch { /* unlink anyway */ }
    await this.disconnect();
    this.wipe();
    this.status = 'offline';
    return { ok: true };
  }
}
