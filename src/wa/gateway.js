// Our own WhatsApp gateway, running inside Cloudflare (no outside service).
// One Durable Object per WhatsApp account. It links the number like WhatsApp Web
// (QR scan), keeps the login keys in its own storage, and connects only when needed:
// while you scan the QR, to post a status, and once a day to stay linked and refresh
// the contact list (statuses go to these contacts).
import './patches.js'; // must run before Baileys encodes anything
import { DurableObject } from 'cloudflare:workers';
import makeWASocket, { initAuthCreds, BufferJSON, DisconnectReason, generateWAMessageFromContent, S_WHATSAPP_NET, getBinaryNodeChild, getBinaryNodeChildren } from 'baileys';
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
    // saved = 1: saved in the phone's address book (Baileys gives `name` only for those).
    try { this.sql.exec('ALTER TABLE contacts ADD COLUMN saved INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
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
        const saved = c.name ? 1 : 0;
        this.sql.exec(
          `INSERT INTO contacts (jid, pn, name, saved) VALUES (?, ?, ?, ?)
           ON CONFLICT(jid) DO UPDATE SET pn = COALESCE(excluded.pn, contacts.pn), name = COALESCE(excluded.name, contacts.name),
             saved = MAX(contacts.saved, excluded.saved)`,
          jid, pn, name, saved
        );
      }
    });
  }

  contactCount() { return this.sql.exec('SELECT COUNT(*) AS n FROM contacts').toArray()[0].n; }

  // Who receives a status: every known contact, by phone-number JID when we have it.
  // Who receives a status: the number itself (so it shows under "My status") plus every
  // contact, all as phone-number JIDs (@s.whatsapp.net). WhatsApp rejects (400) a status
  // whose recipient list mixes phone numbers and LIDs, so LID-only contacts are mapped
  // to their phone number, and dropped if WhatsApp doesn't know it.
  // Your phone's status privacy (Settings > Privacy > Status): the default list is
  // "contacts" (all), "blacklist" (all except) or "whitelist" (only these).
  async statusPrivacy() {
    try {
      const res = await this.sock.query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'status' }, content: [{ tag: 'privacy', attrs: {} }] });
      const lists = getBinaryNodeChildren(getBinaryNodeChild(res, 'privacy'), 'list');
      const def = lists.find((l) => l.attrs?.default === 'true') || lists[0];
      if (!def) return { type: 'contacts', list: [] };
      const jids = (Array.isArray(def.content) ? def.content : []).map((c) => c?.attrs?.jid).filter(Boolean);
      return { type: def.attrs.type || 'contacts', list: jids };
    } catch (err) {
      return { type: 'contacts', list: [], error: err.message };
    }
  }

  // Phone-number JIDs for a list of JIDs (LIDs are looked up; unknown ones dropped).
  async toPN(jids) {
    const norm = (j) => `${String(j).split('@')[0].split(':')[0]}@s.whatsapp.net`;
    const out = new Set();
    const lids = [];
    for (const j of jids) {
      if (String(j).endsWith('@lid')) lids.push(j);
      else if (String(j).includes('@s.whatsapp.net')) out.add(norm(j));
    }
    let mapped = 0;
    if (lids.length) {
      try {
        const pairs = (await this.sock.signalRepository.lidMapping.getPNsForLIDs(lids)) || [];
        this.ctx.storage.transactionSync(() => {
          for (const p of pairs) {
            if (!p?.pn) continue;
            out.add(norm(p.pn));
            mapped++;
            this.sql.exec('UPDATE contacts SET pn = ? WHERE jid = ?', norm(p.pn), p.lid);
          }
        });
      } catch (err) {
        console.error('lid mapping', err.message);
      }
    }
    return { list: [...out], lids: lids.length, mapped };
  }

  // Who receives a status, following the phone's status privacy. The number itself is
  // always included so the status shows under "My status". Only phone-number JIDs:
  // WhatsApp rejects (400) a list that mixes phone numbers and LIDs.
  async audience() {
    const me = dec(this.get('creds'))?.me;
    const own = me?.id ? `${me.id.split('@')[0].split(':')[0]}@s.whatsapp.net` : null;
    const valid = (j) => /^\d{6,15}@s\.whatsapp\.net$/.test(j) && j !== own;
    const privacy = await this.statusPrivacy();
    // "My contacts" means contacts saved on the phone; if we don't know which are saved yet, use everyone we know.
    const savedCount = this.sql.exec('SELECT COUNT(*) AS n FROM contacts WHERE saved = 1').toArray()[0].n;
    const rows = this.sql.exec(`SELECT jid, pn FROM contacts ${savedCount >= 5 ? 'WHERE saved = 1' : ''}`).toArray();
    const contacts = await this.toPN(rows.map((r) => r.pn || r.jid));
    let list;
    if (privacy.type === 'whitelist') {
      list = (await this.toPN(privacy.list)).list;
    } else if (privacy.type === 'blacklist') {
      const blocked = new Set((await this.toPN(privacy.list)).list);
      list = contacts.list.filter((j) => !blocked.has(j));
    } else {
      list = contacts.list;
    }
    list = [...new Set(list.filter(valid))];
    return {
      list: own ? [own, ...list] : list,
      privacy: privacy.type, privacy_list: privacy.list.length, privacy_error: privacy.error || null,
      lids: contacts.lids, mapped: contacts.mapped, dropped: contacts.lids - contacts.mapped, saved_only: savedCount >= 5,
    };
  }

  // Delete (revoke) statuses we posted: they disappear for everyone who received them.
  async deleteStatus(ids) {
    if (!this.isLinked()) throw new Error('الرقم مش مربوط');
    this.wantOpen = true;
    try {
      await this.connect();
      await this.waitOpen();
      await sleep(1500);
      const aud = await this.audience();
      for (const id of ids) {
        await this.sock.sendMessage('status@broadcast', { delete: { remoteJid: 'status@broadcast', fromMe: true, id } }, { statusJidList: aud.list });
      }
      return { ok: true, deleted: ids.length };
    } finally {
      this.wantOpen = false;
      this.touch();
    }
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
      last_status: (() => { try { return JSON.parse(this.get('last_status')); } catch { return null; } })(),
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
      const aud = await this.audience();
      const audience = aud.list;
      if (audience.length < 2) {
        throw new Error('لسه مفيش جهات اتصال وصلت من الموبايل، فالحالة مش هتوصل لحد. افتح واتساب على الموبايل شوية وجرّب تاني بعد 10 دقايق.');
      }
      // Collect WhatsApp's server acks so we only report success when WhatsApp accepted it.
      const acks = new Map();
      const onAck = (node) => { if (node?.attrs?.id) acks.set(node.attrs.id, node.attrs); };
      this.sock.ws.on('CB:ack,class:message', onAck);
      let id;
      let sentInfo = null;
      try {
        if (media) {
          // Our own media path (no temp files): read from storage, encrypt, upload, relay.
          const { info: mediaInfo, ...content } = await prepareStatusMedia(this.env, this.sock, media, caption);
          sentInfo = mediaInfo;
          const msg = generateWAMessageFromContent('status@broadcast', content, { userJid: this.sock.user.id });
          id = msg.key.id;
          await this.sock.relayMessage('status@broadcast', msg.message, { messageId: id, statusJidList: audience });
        } else {
          const msg = await this.sock.sendMessage('status@broadcast', { text }, {
            statusJidList: audience,
            backgroundColor: background,
            font: 1,
            broadcast: true,
          });
          id = msg?.key?.id;
        }
        for (let i = 0; i < 60 && !acks.has(id); i++) await sleep(250);
      } finally {
        this.sock?.ws?.off?.('CB:ack,class:message', onAck);
      }
      const ack = acks.get(id) || null;
      const pn = this.sql.exec('SELECT COUNT(*) AS n FROM contacts WHERE pn IS NOT NULL').toArray()[0].n;
      const diag = { at: Date.now(), audience: audience.length - 1, with_phone: pn, lids: aud.lids, mapped: aud.mapped, dropped: aud.dropped, privacy: aud.privacy, privacy_list: aud.privacy_list, privacy_error: aud.privacy_error, saved_only: aud.saved_only, kind: media?.type || 'text', media: sentInfo, id, ack };
      this.put('last_status', JSON.stringify(diag));
      if (!ack) throw new Error('واتساب مأكدش استلام الحالة (مفيش رد من السيرفر خلال 15 ثانية). جرّب تاني.');
      if (ack.error) throw new Error(`واتساب رفض الحالة (كود ${ack.error}). ابعت الرقم ده للدعم.`);
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
    const { info: _i, ...c } = await prepareStatusMedia(this.env, fake, media, 'cap');
    const m = c.imageMessage || c.videoMessage;
    return { type: Object.keys(c)[0], url: m.url, len: m.fileLength, enc: m.fileEncSha256.toString('base64'), seconds: m.seconds, width: m.width, height: m.height };
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
