'use strict';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS = {
  draft: 'مسودة',
  scheduled: 'مجدول',
  publishing: 'جاري النشر',
  published: 'اتنشر',
  partial: 'اتنشر جزئياً',
  manual: 'مستني تنشره على واتساب',
  failed: 'فشل',
  pending: 'منتظر',
  processing: 'إنستجرام بيجهّز الفيديو',
};
const PLATFORM = { facebook: 'فيسبوك', instagram: 'إنستجرام', whatsapp: 'حالة واتساب', youtube: 'يوتيوب', tiktok: 'تيك توك', linkedin: 'لينكدإن', meta_ads: 'إعلانات Meta' };
// Platforms connected with their own login (switched on by keys in Cloudflare).
const EXTRA = ['youtube', 'tiktok', 'linkedin'];
const connectBtn = (p, clientId, cls = 'btn small') => (me?.providers?.[p]
  ? `<a class="${cls}" href="/auth/${p}/start?client_id=${clientId}">ربط ${PLATFORM[p]}</a>` : '');
// Account types you can't post to (they don't show in the composer).
const NON_POSTING = ['meta_ads'];

const fmtDate = (ms) => ms ? new Date(ms).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : '';

let toastTimer;
// Short message at the bottom. With `undo`, shows an "تراجع" button for 10 seconds.
function toast(msg, { undo } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  if (undo) {
    const b = document.createElement('button');
    b.className = 'toast-undo';
    b.textContent = '↩ تراجع';
    b.onclick = async () => {
      b.disabled = true;
      try {
        await undo();
        toast('رجعت زي ما كانت');
      } catch (err) {
        toast(err.message);
      }
    };
    t.appendChild(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 10000 : 3500);
}

// In-page yes/no question. The browser's own confirm() is blocked in some
// browsers (e.g. embedded ones), which made actions silently do nothing.
function askConfirm(message, { ok = 'تمام', cancel = 'إلغاء' } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog confirm-dialog';
    dlg.innerHTML = `<form method="dialog" class="dlg-body">
      <div style="font-weight:600;line-height:1.8;white-space:pre-line">${esc(message)}</div>
      <div class="dlg-actions">
        <button class="btn primary" value="ok">${esc(ok)}</button>
        <button class="btn" value="cancel">${esc(cancel)}</button>
      </div></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
    dlg.showModal();
    dlg.querySelector('[value=ok]').focus();
  });
}

// Shows a new invite link with copy / send-on-WhatsApp buttons.
function showInviteDialog(clientId, clientName, inv) {
  const msg = `أهلاً ${clientName} 👋
عشان أقدر أنشر على صفحتك على فيسبوك وإنستجرام، افتح اللينك ده من موبايلك واربط صفحتك (مش هتحتاج تبعتلي الباسورد):
${inv.url}`;
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.innerHTML = `<form method="dialog" class="dlg-body">
    <div class="dlg-head"><b>🔗 لينك دعوة: ${esc(clientName)}</b><button class="btn small dlg-close" value="close">✕</button></div>
    <p style="margin:0">ابعت اللينك ده للعميل. هيفتحه من موبايله، يدخل فيسبوك <b>بحسابه هو</b>، ويختار صفحاته، وهتلاقيها اتربطت عنده هنا.</p>
    <input readonly dir="ltr" value="${esc(inv.url)}" onclick="this.select()">
    <div class="dlg-actions">
      <button type="button" class="btn primary small" data-copy-link>📋 انسخ اللينك</button>
      <a class="btn small" style="background:#25d366;border-color:#25d366;color:#fff" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">ابعته واتساب</a>
      <button type="button" class="btn small" data-copy-msg>📋 انسخ الرسالة كاملة</button>
    </div>
    <div class="notice small" style="margin:0">⏳ اللينك شغال <b>7 أيام</b>. ⚠️ طول ما تطبيق Meta في وضع التطوير، لازم تضيف العميل <b>Tester</b> في التطبيق الأول (الخطوات في README)، وإلا فيسبوك هيرفض الدخول.</div>
    <button type="button" class="btn small danger" data-revoke style="justify-self:start">إلغاء كل لينكات العميل ده</button>
  </form>`;
  document.body.appendChild(dlg);
  const copy = async (text, done) => {
    try { await navigator.clipboard.writeText(text); toast(done); } catch { dlg.querySelector('input').select(); toast('علّم على اللينك وانسخه'); }
  };
  dlg.querySelector('[data-copy-link]').onclick = () => copy(inv.url, 'اللينك اتنسخ 📋');
  dlg.querySelector('[data-copy-msg]').onclick = () => copy(msg, 'الرسالة اتنسخت 📋');
  dlg.querySelector('[data-revoke]').onclick = async () => {
    if (!(await askConfirm('كل لينكات الدعوة اللي اتبعتت للعميل ده هتبطل تشتغل. الحسابات المربوطة مش هتتأثر.', { ok: 'إلغاء اللينكات' }))) return;
    const r = await api(`/clients/${clientId}/invites`, { method: 'DELETE' });
    toast(`اتلغى ${r.deleted} لينك`);
    dlg.close();
  };
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// In-page text question; resolves to the text, or null if cancelled.
function askText(message, placeholder = '', value = '') {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog confirm-dialog';
    dlg.innerHTML = `<form method="dialog" class="dlg-body">
      <label style="font-weight:600;line-height:1.8">${esc(message)}</label>
      <input name="v" placeholder="${esc(placeholder)}" value="${esc(value)}" autofocus>
      <div class="dlg-actions">
        <button class="btn primary" value="ok">تمام</button>
        <button class="btn" value="cancel" formnovalidate>إلغاء</button>
      </div></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok' ? dlg.querySelector('input').value.trim() : null);
      dlg.remove();
    });
    dlg.showModal();
  });
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    renderLogin();
    throw new Error(data.error || 'سجّل الدخول الأول');
  }
  if (!res.ok) {
    const err = new Error(data.error || 'حصل خطأ');
    err.setup = data.setup;
    throw err;
  }
  return data;
}

function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(STATUS[status] || status)}</span>`;
}

function platformTag(p) {
  return `<span class="platform ${esc(p)}">${esc(PLATFORM[p] || p)}</span>`;
}

// ---------- routing ----------
const routes = {
  dashboard: renderDashboard,
  clients: renderClients,
  compose: renderCompose,
  calendar: renderCalendar,
  posts: renderPosts,
  connect: renderConnect,
  whatsapp: renderWhatsApp,
  reports: renderReports,
  ads: renderAds,
  users: renderUsers,
};
// Which permission each page needs ('owner' = only the account owner).
const ROUTE_PERM = { compose: 'posts', calendar: 'posts', posts: 'posts', whatsapp: 'whatsapp', reports: 'reports', ads: 'ads', clients: 'owner', connect: 'owner', users: 'owner' };
const isOwnerUser = () => !me?.user || me.user.owner; // older servers: treat as owner
const can = (perm) => !perm || isOwnerUser() || (perm !== 'owner' && (me.user.perms || []).includes(perm));

let me = null;

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, query = ''] = hash.split('?');
  const ok = routes[name] && can(ROUTE_PERM[name]);
  return { name: ok ? name : 'dashboard', params: new URLSearchParams(query) };
}

async function router() {
  // A client opening a shared report link: no login, no sidebar.
  const shared = location.hash.match(/^#\/r\/([0-9a-f-]{36})(?:\?(.*))?$/);
  if (shared) return renderPublicReport(shared[1], new URLSearchParams(shared[2] || ''));
  if (!me) {
    try {
      me = await api('/me');
    } catch (err) {
      if (err.setup) return renderSetupError(err.message);
      return; // login screen already shown on 401
    }
  }
  const { name, params } = currentRoute();
  shell(name);
  updateWaBadge();
  // Each visit renders into its own container. If you leave (or change a filter)
  // before a slow page finishes, its late result lands in a detached container
  // and its errors are ignored, instead of breaking the page you're on now.
  const token = ++routeToken;
  const main = document.createElement('div');
  main.className = 'view';
  main.innerHTML = '<div class="boot">جاري التحميل…</div>';
  $('#main').replaceChildren(main);
  try {
    await routes[name](main, params);
  } catch (err) {
    if (token !== routeToken || !main.isConnected) return;
    main.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}
let routeToken = 0;

window.addEventListener('hashchange', router);

// Tap outside any popup (on the dark background) to close it.
document.addEventListener('click', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDialogElement) || !d.open) return;
  const r = d.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) d.close();
});

function shell(active) {
  if (!$('#main')) {
    app.innerHTML = `
      <header class="topbar">
        <button class="menu-btn" id="menu-btn" aria-label="القايمة" aria-expanded="false">☰</button>
        <div class="brand">Social <span>Manager</span></div>
        <a class="btn primary small" href="#/compose">+ منشور</a>
      </header>
      <div class="backdrop" id="backdrop" hidden></div>
      <div class="layout">
        <aside class="sidebar" id="sidebar">
          <div class="brand">Social <span>Manager</span></div>
          <nav class="nav">
            <a href="#/dashboard" data-r="dashboard">🏠 لوحة التحكم</a>
            <a href="#/compose" data-r="compose">✍️ منشور جديد</a>
            <a href="#/calendar" data-r="calendar">🗓️ التقويم</a>
            <a href="#/posts" data-r="posts">📋 المنشورات</a>
            <a href="#/reports" data-r="reports">📊 التقارير</a>
            <a href="#/ads" data-r="ads">📢 الإعلانات</a>
            <a href="#/whatsapp" data-r="whatsapp">📱 حالات واتساب <span class="nav-badge" id="wa-badge" hidden></span></a>
            <a href="#/clients" data-r="clients">🏢 العملاء والحسابات</a>
            <a href="#/users" data-r="users">👥 الفريق والصلاحيات</a>
          </nav>
          <div class="spacer"></div>
          <div class="who small"><span class="muted">داخل باسم:</span> <b id="who-name"></b></div>
          <button class="btn small" id="logout">تسجيل الخروج</button>
        </aside>
        <main class="main" id="main"></main>
      </div>`;
    // Phones: the menu is a side drawer opened from ☰.
    const setMenu = (open) => {
      document.body.classList.toggle('menu-open', open);
      $('#backdrop').hidden = !open;
      $('#menu-btn').setAttribute('aria-expanded', String(open));
    };
    $('#menu-btn').onclick = () => setMenu(!document.body.classList.contains('menu-open'));
    $('#backdrop').onclick = () => setMenu(false);
    $('#sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
    window.addEventListener('hashchange', () => setMenu(false));
    $('#logout').onclick = async () => {
      await api('/logout', { method: 'POST' });
      me = null;
      renderLogin();
    };
  }
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.r === active);
    a.hidden = !can(ROUTE_PERM[a.dataset.r]);
  });
  const who = $('#who-name');
  if (who) who.textContent = me?.user ? (me.user.owner ? 'صاحب الحساب' : me.user.name) : '';
  document.querySelectorAll('.topbar a[href="#/compose"]').forEach((a) => { a.hidden = !can('posts'); });
}

// ---------- login ----------
function renderLogin() {
  me = null;
  app.innerHTML = `
    <div class="login">
      <form class="card" id="login-form">
        <div class="brand" style="text-align:center">Social <span>Manager</span></div>
        <div class="field">
          <label for="un">اسم المستخدم <span class="muted small">(صاحب الحساب يسيبه فاضي)</span></label>
          <input id="un" dir="ltr" autocomplete="username" autocapitalize="none" spellcheck="false">
        </div>
        <div class="field">
          <label for="pw">كلمة السر</label>
          <input id="pw" type="password" autocomplete="current-password" required autofocus>
        </div>
        <div id="login-err" class="notice bad" hidden></div>
        <button class="btn primary" style="width:100%;justify-content:center">دخول</button>
      </form>
    </div>`;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await api('/login', { method: 'POST', body: { username: $('#un').value.trim(), password: $('#pw').value } });
      app.innerHTML = '';
      router();
    } catch (err) {
      const box = $('#login-err');
      box.textContent = err.message;
      box.hidden = false;
      btn.disabled = false;
    }
  };
}

function renderSetupError(message) {
  app.innerHTML = `
    <div class="login"><div class="card" style="max-width:560px">
      <h1>المنصة محتاجة إعداد</h1>
      <p class="notice bad">${esc(message)}</p>
      <p>افتح ملف <b>README.md</b> في الـ Repository على GitHub واتبع خطوات الإعداد.</p>
    </div></div>`;
}

// ---------- shared data ----------
async function loadClients() {
  return api('/clients');
}

// Message after "publish now".
const publishMsg = (status) => ({
  published: 'اتنشر بنجاح ✅',
  publishing: 'تمام ✅ المنشور بيتنشر في الخلفية، تقدر تكمّل شغلك. الحالة هتتحدث لوحدها',
  manual: 'اتنشر ✅ وحالة الواتساب جاهزة: افتح "حالات واتساب" من الموبايل وانشرها بلمسة',
}[status] || 'فيه حسابات ماتنشرش عليها، شوف السبب تحت المنشور');

// While something is publishing in the background, refresh the page every few
// seconds so its status updates on its own (skipped while a popup is open).
function refreshWhilePublishing(main, posts, rerender) {
  if (!posts.some((p) => p.status === 'publishing')) return;
  setTimeout(function tick() {
    if (!main.isConnected) return;
    if (document.querySelector('dialog[open]')) { setTimeout(tick, 5000); return; }
    rerender();
  }, 7000);
}

// Small media helpers shared by the posts list, calendar and popup.
const mediaIcon = (p) => {
  const m = p.media || [];
  if (m.some((x) => x.type === 'video')) return '🎬 ';
  if (m.length > 1) return `🖼️${m.length} `;
  return '';
};
function thumbHtml(p) {
  const m = p.media || [];
  if (m.some((x) => x.type === 'video')) return '<div class="thumb-video" title="فيديو">🎬</div>';
  if (!m.length) return '';
  return `<div style="position:relative;flex:none"><img class="thumb" src="${esc(m[0].url)}" alt="" loading="lazy">${m.length > 1 ? `<span class="media-badge">${m.length}</span>` : ''}</div>`;
}
function dialogMedia(p) {
  const m = p.media || [];
  const v = m.find((x) => x.type === 'video');
  if (v) return `<video src="${esc(v.url)}" controls preload="metadata" style="width:140px;border-radius:8px;background:#000"></video>`;
  if (!m.length) return '';
  return `<div style="position:relative"><img src="${esc(m[0].url)}" alt="">${m.length > 1 ? `<span class="media-badge">ألبوم ${m.length}</span>` : ''}</div>`;
}

function postRow(p, { actions = true, timeFirst = false } = {}) {
  const at = p.scheduled_at || p.created_at;
  const when = timeFirst ? '' : fmtDate(at);
  const targets = p.targets.map((t) => `
    <span>${platformTag(t.platform)} ${esc(t.name)} ${t.status !== 'pending' ? badge(t.status) : ''}</span>
    ${t.error ? `<div class="target-error" style="width:100%">${esc(t.name)}: ${esc(t.error)}</div>` : ''}`).join('');
  const editable = ['draft', 'scheduled', 'failed', 'partial'].includes(p.status);
  return `
    <div class="post" data-id="${p.id}" data-series="${esc(p.series_id || '')}">
      ${timeFirst ? `<div class="post-time"><b>${esc(fmtTime(at))}</b><span class="muted small">${esc(relTime(at))}</span></div>` : ''}
      ${thumbHtml(p)}
      <div class="body">
        <div class="meta" style="margin:0 0 4px">
          <span class="dot" style="background:${esc(p.client_color)}"></span><b>${esc(p.client_name)}</b>
          ${badge(p.status)} ${when ? `<span>${esc(when)}</span>` : ''}
          ${p.series_id ? '<span class="badge" title="جزء من سلسلة متكررة">🔁 متكرر</span>' : ''}
        </div>
        <div class="text">${esc(p.message) || '<span class="muted">(صورة بدون نص)</span>'}</div>
        <div class="meta">${targets}</div>
      </div>
      ${actions ? `<div class="actions">
        ${editable ? `<button class="btn small" data-act="publish">${p.status === 'failed' || p.status === 'partial' ? 'إعادة المحاولة' : 'انشر دلوقتي'}</button>` : ''}
        ${editable ? `<a class="btn small" href="#/compose?edit=${p.id}">تعديل</a>` : ''}
        <a class="btn small" href="#/compose?copy=${p.id}" title="انسخ المنشور لميعاد أو مواعيد تانية">نسخ / تكرار</a>
        ${p.targets.some((t) => t.platform === 'facebook' && t.status === 'published') ? '<button class="btn small" data-act="boost" title="اعمل إعلان ممول للمنشور ده">📢 روّج</button>' : ''}
        <button class="btn small danger" data-act="delete">حذف</button>
        ${p.series_id ? '<button class="btn small danger" data-act="delete-series" title="يحذف كل المنشورات الجاية في السلسلة دي">حذف السلسلة الجاية</button>' : ''}
      </div>` : ''}
    </div>`;
}

function bindPostActions(root, reload) {
  root.querySelectorAll('.post [data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest('.post');
      const id = row.dataset.id;
      if (btn.dataset.act === 'boost') {
        openBoostDialog(await api(`/posts/${id}`)).catch((err) => toast(err.message));
        return;
      }
      if (btn.dataset.act === 'delete') {
        if (!(await askConfirm('متأكد إنك عايز تحذف المنشور ده من المنصة؟ (مش هيتمسح من فيسبوك أو إنستجرام لو كان اتنشر)'))) return;
        await api(`/posts/${id}`, { method: 'DELETE' });
        toast('اتحذف');
      } else if (btn.dataset.act === 'delete-series') {
        if (!(await askConfirm('هيتحذف كل المنشورات اللي لسه منزلتش في السلسلة دي. اللي اتنشر خلاص مش هيتأثر. متأكد؟'))) return;
        const r = await api(`/series/${row.dataset.series}`, { method: 'DELETE' });
        toast(`اتحذف ${r.deleted} منشور`);
      } else {
        btn.disabled = true;
        btn.textContent = 'جاري النشر…';
        try {
          const p = await api(`/posts/${id}/publish`, { method: 'POST' });
          toast(publishMsg(p.status));
        } catch (err) {
          toast(err.message);
        }
      }
      reload();
    };
  });
}

// ---------- dashboard ----------
async function renderDashboard(main) {
  const $ = (sel) => main.querySelector(sel); // this page's own elements only
  const s = await api('/stats');
  main.innerHTML = `
    <div class="page-head"><h1>لوحة التحكم</h1>${can('posts') ? '<a class="btn primary" href="#/compose">+ منشور جديد</a>' : ''}</div>
    ${!me.metaConfigured ? `<div class="notice">ربط فيسبوك وإنستجرام لسه مش متفعّل. ضيف <code>META_APP_ID</code> و <code>META_APP_SECRET</code> في Cloudflare (الخطوات في README).</div>` : ''}
    <div class="grid stats">
      <div class="card stat"><div class="label">العملاء</div><div class="value">${s.clients}</div></div>
      <div class="card stat"><div class="label">الحسابات المربوطة</div><div class="value">${s.accounts}</div></div>
      <div class="card stat"><div class="label">منشورات مجدولة</div><div class="value">${s.scheduled}</div></div>
      <div class="card stat"><div class="label">اتنشر آخر 30 يوم</div><div class="value">${s.published30}</div></div>
      <div class="card stat"><div class="label">محتاج مراجعة</div><div class="value" style="color:${s.failed ? 'var(--bad)' : 'inherit'}">${s.failed}</div></div>
    </div>
    <div class="card">
      <h2>المنشورات الجاية</h2>
      <div id="upcoming">${s.upcoming.length ? s.upcoming.map((p) => postRow(p)).join('') : '<div class="empty">مفيش منشورات مجدولة. <a href="#/compose">جدول أول منشور</a></div>'}</div>
    </div>
    ${s.clients === 0 ? `<div class="notice ok" style="margin-top:16px">ابدأ بإضافة أول عميل من <a href="#/clients">العملاء والحسابات</a>، وبعدين اربط صفحاته.</div>` : ''}`;
  bindPostActions(main, router);
  refreshWhilePublishing(main, s.upcoming || [], () => renderDashboard(main));
}

// ---------- clients ----------
function syncNotice(s) {
  const parts = [];
  if (s.new_clients?.length) parts.push(`اتعمل <b>${s.new_clients.length}</b> عميل جديد: ${s.new_clients.map(esc).join('، ')}`);
  if (s.added) parts.push(`اتضاف <b>${s.added}</b> حساب`);
  if (s.updated) parts.push(`اتحدّث <b>${s.updated}</b> حساب`);
  if (s.unassigned) parts.push(`<b>${s.unassigned}</b> حساب إعلانات مش عارفين بتاع مين، حطيناهم في "📦 حسابات مش متوزعة"، انقلهم للعميل الصح من القايمة اللي جنبهم`);
  if (s.ignored) parts.push(`<span class="muted">اتجاهلنا ${s.ignored} حساب كنت مسحته</span>`);
  let ads = '';
  if (s.ads_note?.startsWith('missing:')) ads = '<br>📢 فيسبوك مدّاش صلاحية الإعلانات، فمفيش حسابات إعلانات اتجابت. دوس "اربط فيسبوك تاني"، وفي شاشة فيسبوك دوس <b>تعديل الإعدادات / Edit settings</b> واختار حسابات الإعلانات ووافق على كل الصلاحيات.';
  else if (s.ads_note?.startsWith('error:')) ads = `<br>📢 حسابات الإعلانات: فيسبوك رد بخطأ: <span dir="ltr">${esc(s.ads_note.slice(6))}</span>`;
  else if (s.ads_note === 'none') ads = '<br>📢 مالقيناش حسابات إعلانات إنت أدمن عليها.';
  const head = `✅ لقينا ${s.pages ?? 0} صفحة و ${s.ad_accounts ?? 0} حساب إعلانات.`;
  return `<div class="notice ok">${head} ${parts.join(' · ')}${ads}</div>`;
}

async function renderClients(main, params) {
  const $ = (sel) => main.querySelector(sel); // this page's own elements only
  const [clients, accounts, sync] = await Promise.all([loadClients(), api('/accounts'), api('/sync').catch(() => ({}))]);
  let notice = '';
  if (params.get('synced')) {
    let s = {};
    try { s = JSON.parse(params.get('synced')); } catch { /* ignore */ }
    notice = syncNotice(s);
  }
  if (params.get('connected')) notice = `<div class="notice ok">اتربط ${esc(params.get('connected'))} حساب بنجاح.</div>`;
  if (params.get('connected') === '0') notice = `<div class="notice">الربط تم بس مالقيناش صفحات. اتأكد إنك اخترت الصفحات في شاشة فيسبوك، وإنك أدمن عليها.</div>`;
  if (params.get('error')) notice = `<div class="notice bad">${esc(params.get('error'))}</div>`;

  main.innerHTML = `
    <div class="page-head"><h1>العملاء والحسابات</h1></div>
    ${notice}
    ${!me.metaConfigured ? `<div class="notice">علشان تربط فيسبوك وإنستجرام لازم تضيف بيانات تطبيق Meta في Cloudflare. رابط الـ Redirect اللي هتحطه في إعدادات تطبيق Meta هو:<br><code>${esc(me.redirectUri)}</code></div>` : ''}
    ${me.metaConfigured ? `<section class="card sync-card">
      <div>
        <h2>🔄 اكتشاف الحسابات تلقائياً</h2>
        <p class="muted small" style="margin:4px 0 0">ادخل فيسبوك مرة واحدة، والمنصة هتجيب كل الصفحات وحسابات إنستجرام وحسابات الإعلانات اللي إنت أدمن عليها، وتعمل لكل صفحة عميل باسمها، وتحط إنستجرام والإعلانات بتوعها جواه. ولو ضفت صفحة جديدة بعدين، هتتضاف لوحدها مرة كل يوم.</p>
        ${sync.last_sync ? `<p class="small" style="margin:6px 0 0">آخر تحديث: <b>${esc(new Date(sync.last_sync).toLocaleString('ar-EG'))}</b></p>` : ''}
      </div>
      <div class="sync-actions">
        <a class="btn primary" href="/auth/meta/start?sync=1">${sync.connected ? 'اربط فيسبوك تاني' : 'اكتشف كل حساباتي'}</a>
        ${sync.connected ? '<button class="btn" id="sync-now">🔄 حدّث دلوقتي</button>' : ''}
        ${sync.ignored ? `<button class="btn small" id="sync-unignore" title="حسابات مسحتها، والتحديث مش بيرجّعها">رجّع ${sync.ignored} حساب ممسوح</button>` : ''}
      </div>
    </section>` : ''}
    <details class="card" id="new-client-box" style="margin-bottom:16px">
    <summary><b>➕ عميل جديد بإيدك</b> <span class="muted small">(لو عايز تضيف عميل مش ليه صفحة عندك، أو تبعتله لينك دعوة)</span></summary>
    <form id="new-client" style="margin-top:12px">
      <div class="row">
        <div><label for="c-name">اسم العميل</label><input id="c-name" required placeholder="مثلاً: مطعم الشيف"></div>
        <div style="max-width:90px;min-width:70px"><label for="c-color">اللون</label><input id="c-color" type="color" value="#4f46e5"></div>
        <div style="flex:0"><button class="btn primary">إضافة</button></div>
      </div>
    </form>
    </details>
    <div class="grid clients">
      ${clients.length ? clients.map((c) => clientCard(c, accounts.filter((a) => a.client_id === c.id), clients)).join('') : '<div class="card empty">لسه مفيش عملاء</div>'}
    </div>
    <p class="muted small" style="margin-top:16px">ملحوظة: إنستجرام بيظهر هنا بس لو حساب Business أو Creator ومربوط بصفحة فيسبوك.</p>`;

  $('#sync-now')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'بيحدّث…';
    try {
      const s = await api('/sync', { method: 'POST' });
      main.innerHTML = '';
      await renderClients(main, new URLSearchParams({ synced: JSON.stringify(s) }));
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
      e.target.textContent = '🔄 حدّث دلوقتي';
    }
  });
  $('#sync-unignore')?.addEventListener('click', async () => {
    if (!(await askConfirm('الحسابات اللي مسحتها قبل كده هترجع مع التحديث الجاي. تمام؟'))) return;
    await api('/sync/ignored', { method: 'DELETE' });
    toast('تمام، دوس "حدّث دلوقتي" عشان ترجع');
    renderClients(main, new URLSearchParams());
  });

  $('#new-client').onsubmit = async (e) => {
    e.preventDefault();
    await api('/clients', { method: 'POST', body: { name: $('#c-name').value, color: $('#c-color').value } });
    toast('العميل اتضاف');
    renderClients(main, new URLSearchParams());
  };

  main.querySelectorAll('[data-del-account]').forEach((b) => {
    b.onclick = async () => {
      if (!(await askConfirm('فك ربط الحساب ده؟ المنشورات المجدولة عليه هتتشال منه.'))) return;
      await api(`/accounts/${b.dataset.delAccount}`, { method: 'DELETE' });
      renderClients(main, new URLSearchParams());
    };
  });
  main.querySelectorAll('[data-invite]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const inv = await api(`/clients/${b.dataset.invite}/invites`, { method: 'POST' });
        showInviteDialog(b.dataset.invite, b.dataset.name, inv);
      } catch (err) {
        toast(err.message);
      } finally {
        b.disabled = false;
      }
    };
  });
  main.querySelectorAll('[data-add-wa]').forEach((b) => {
    b.onclick = async () => {
      const name = await askText('اسم لحساب واتساب ده (مثلاً رقم العميل أو اسم الموبايل):', 'واتساب المحل');
      if (name === null) return;
      await api('/accounts/whatsapp', { method: 'POST', body: { client_id: Number(b.dataset.addWa), name } });
      toast('اتضاف ✅ اختاره في منشور جديد مع باقي الحسابات');
      renderClients(main, new URLSearchParams());
    };
  });
  main.querySelectorAll('[data-move-account]').forEach((sel) => {
    sel.onchange = async () => {
      if (!sel.value) return;
      await api(`/accounts/${sel.dataset.moveAccount}`, { method: 'PUT', body: { client_id: Number(sel.value) } });
      toast('الحساب اتنقل');
      renderClients(main, new URLSearchParams());
    };
  });
  main.querySelectorAll('[data-rename-client]').forEach((b) => {
    b.onclick = async () => {
      const c = clients.find((x) => String(x.id) === b.dataset.renameClient);
      const name = await askText('اسم العميل:', 'اسم العميل', c.name);
      if (name === null || !name.trim() || name.trim() === c.name) return;
      try {
        await api(`/clients/${c.id}`, { method: 'PUT', body: { name: name.trim(), color: c.color, notes: c.notes } });
        toast('الاسم اتغيّر ✅');
        renderClients(main, new URLSearchParams());
      } catch (err) {
        toast(err.message);
      }
    };
  });
  main.querySelectorAll('[data-wa-auto]').forEach((b) => {
    b.onclick = () => openWhatsAppAuto(Number(b.dataset.waAuto), b.dataset.name, b.classList.contains('on'), () => renderClients(main, new URLSearchParams()));
  });
  main.querySelectorAll('[data-del-client]').forEach((b) => {
    b.onclick = async () => {
      if (!(await askConfirm('حذف العميل هيمسح كل حساباته ومنشوراته من المنصة. متأكد؟'))) return;
      await api(`/clients/${b.dataset.delClient}`, { method: 'DELETE' });
      renderClients(main, new URLSearchParams());
    };
  });
}

function clientCard(c, accounts, clients) {
  const others = clients.filter((o) => o.id !== c.id);
  return `
    <div class="card">
      <div class="client-head">
        <span class="dot" style="background:${esc(c.color)};width:14px;height:14px"></span>
        <h2>${esc(c.name)}</h2>
        <button class="btn small" data-rename-client="${c.id}" title="غيّر اسم العميل">✏️ تعديل</button>
        <button class="btn small danger" data-del-client="${c.id}">حذف</button>
      </div>
      ${accounts.map((a) => `
        <div class="account">
          ${a.picture ? `<img src="${esc(a.picture)}" alt="">` : '<img alt="">'}
          <span class="name">${esc(a.name)}</span>
          ${platformTag(a.platform)}
          ${a.platform === 'whatsapp' ? (a.auto
            ? `<button class="btn small wa-auto on" data-wa-auto="${a.id}" data-name="${esc(a.name)}" title="بتتنشر لوحدها">⚡ تلقائي</button>`
            : `<button class="btn small wa-auto" data-wa-auto="${a.id}" data-name="${esc(a.name)}" title="خلّي الحالات تتنشر لوحدها">⚡ خليها تلقائي</button>`) : ''}
          ${others.length ? `<select class="move" data-move-account="${a.id}" title="نقل لعميل تاني">
            <option value="">نقل ←</option>
            ${others.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}
          </select>` : ''}
          <button class="btn small" data-del-account="${a.id}" title="فك الربط">✕</button>
        </div>`).join('') || '<p class="muted small">مفيش حسابات مربوطة.</p>'}
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        ${me.metaConfigured
          ? `<a class="btn primary small" href="/auth/meta/start?client_id=${c.id}">ربط فيسبوك وإنستجرام</a>`
          : '<span class="muted small">الربط هيتفعّل بعد إعداد تطبيق Meta</span>'}
        ${EXTRA.map((p) => connectBtn(p, c.id)).join('')}
        <button class="btn small" data-invite="${c.id}" data-name="${esc(c.name)}" title="ابعت اللينك للعميل يربط صفحاته بنفسه">🔗 لينك دعوة</button>
        <button class="btn small" data-add-wa="${c.id}">+ حالة واتساب</button>
        <a class="btn small" href="#/compose?client=${c.id}">منشور جديد</a>
      </div>
    </div>`;
}

// ---------- team members (owner only) ----------
const PERM_LABELS = {
  posts: ['✍️ نشر وجدولة', 'يكتب منشورات وينشرها ويجدولها ويعدّلها (التقويم والمنشورات)'],
  whatsapp: ['📱 حالات واتساب', 'يشوف صفحة حالات واتساب وينشر الحالات اليدوي'],
  reports: ['📊 التقارير', 'يشوف تقارير العملاء بتوعه ويعمل لينك تقرير'],
  ads: ['📢 الإعلانات', 'يشوف الحملات ويشغّلها ويوقفها ويعمل حملات جديدة (بفلوس!)'],
};

async function renderUsers(main) {
  const $ = (sel) => main.querySelector(sel);
  const [users, clients] = await Promise.all([api('/users'), loadClients()]);
  const clientName = (id) => clients.find((c) => c.id === id)?.name || `#${id}`;
  main.innerHTML = `
    <div class="page-head"><h1>👥 الفريق والصلاحيات</h1><button class="btn primary" id="add-user">+ شخص جديد</button></div>
    <div class="notice small">كل شخص بيدخل باسم مستخدم وكلمة سر بتوعه، ويشوف <b>العملاء اللي تختارهم بس</b>، ويعمل <b>اللي تسمحله بيه بس</b>.
      إنت (صاحب الحساب) بتدخل زي ما انت: من غير اسم مستخدم، بكلمة السر بتاعتك. ربط الحسابات وإضافة العملاء والفريق ليك انت بس.</div>
    ${users.length ? `<div class="grid users-grid">${users.map((u) => `
      <div class="card user-card ${u.active ? '' : 'off'}">
        <div class="client-head"><h2>${esc(u.name)}</h2>${u.active ? '' : '<span class="badge failed">موقوف</span>'}</div>
        <div class="muted small" dir="ltr" style="text-align:end">@${esc(u.username)}</div>
        <div class="small"><b>العملاء:</b> ${u.all_clients ? 'كل العملاء' : (u.clients || []).map((id) => esc(clientName(id))).join('، ') || '—'}</div>
        <div class="user-perms">${u.perms.length ? u.perms.map((p) => `<span class="badge published">${esc(PERM_LABELS[p]?.[0] || p)}</span>`).join(' ') : '<span class="muted small">مفيش صلاحيات</span>'}</div>
        <div class="muted small">آخر دخول: ${u.last_login ? esc(fmtDate(u.last_login)) : 'لسه مدخلش'}</div>
        <div class="wa-actions">
          <button class="btn small" data-edit="${u.id}">✏️ تعديل</button>
          <button class="btn small" data-toggle="${u.id}" data-active="${u.active ? 1 : 0}">${u.active ? '⏸ إيقاف' : '▶ تشغيل'}</button>
          <button class="btn small danger" data-del="${u.id}">حذف</button>
        </div>
      </div>`).join('')}</div>`
      : '<div class="card empty">لسه مفيش حد في الفريق. دوس <b>+ شخص جديد</b>.</div>'}`;

  const reload = () => renderUsers(main);
  $('#add-user').onclick = () => openUserDialog(null, clients, reload);
  main.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => openUserDialog(users.find((u) => String(u.id) === b.dataset.edit), clients, reload); });
  main.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = async () => {
      const on = b.dataset.active !== '1';
      if (!on && !(await askConfirm('الشخص ده هيتقفل حسابه ويخرج من المنصة فوراً. تمام؟', { ok: 'إيقاف' }))) return;
      await api(`/users/${b.dataset.toggle}`, { method: 'PUT', body: { active: on } });
      toast(on ? 'اتشغّل ✅' : 'اتوقف ⏸');
      reload();
    };
  });
  main.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!(await askConfirm('تحذف الشخص ده؟ المنشورات اللي عملها هتفضل موجودة.', { ok: 'احذف' }))) return;
      await api(`/users/${b.dataset.del}`, { method: 'DELETE' });
      toast('اتحذف');
      reload();
    };
  });
}

function openUserDialog(user, clients, done) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  const has = (id) => user && !user.all_clients && (user.clients || []).includes(id);
  dlg.innerHTML = `<form method="dialog" class="dlg-body">
    <div class="dlg-head"><b>${user ? `✏️ تعديل: ${esc(user.name)}` : '+ شخص جديد في الفريق'}</b><button class="btn small dlg-close" value="close">✕</button></div>
    <div class="row">
      <div><label>الاسم</label><input name="name" required value="${esc(user?.name || '')}" placeholder="مثلاً: أحمد"></div>
      <div><label>اسم المستخدم (للدخول)</label><input name="username" required dir="ltr" autocomplete="off" value="${esc(user?.username || '')}" placeholder="ahmed"></div>
    </div>
    <div class="field"><label>كلمة السر ${user ? '<span class="muted small">(سيبها فاضية لو مش هتغيّرها)</span>' : ''}</label>
      <div style="display:flex;gap:6px"><input name="password" type="text" dir="ltr" autocomplete="new-password" ${user ? '' : 'required'} minlength="6" placeholder="6 حروف أو أكتر">
      <button type="button" class="btn small" data-gen>🎲 اعمل واحدة</button></div></div>
    <label>العملاء اللي يشوفهم</label>
    <label class="check"><input type="checkbox" name="all" ${user?.all_clients ? 'checked' : ''}> كل العملاء (حتى اللي هيتضافوا بعدين)</label>
    <div class="pick-list" data-clients ${user?.all_clients ? 'hidden' : ''}>${clients.map((c) => `
      <label class="check"><input type="checkbox" name="client" value="${c.id}" ${has(c.id) ? 'checked' : ''}>
        <span class="dot" style="background:${esc(c.color)}"></span> ${esc(c.name)}</label>`).join('')}</div>
    <label style="margin-top:8px">يقدر يعمل إيه</label>
    <div class="pick-list">${Object.entries(PERM_LABELS).map(([k, [l, hint]]) => `
      <label class="check"><input type="checkbox" name="perm" value="${k}" ${(user ? user.perms.includes(k) : k === 'posts') ? 'checked' : ''}>
        <span><b>${l}</b><br><span class="muted small">${hint}</span></span></label>`).join('')}</div>
    <div id="u-err" class="notice bad" hidden></div>
    <div class="dlg-actions"><button type="button" class="btn primary" data-save>${user ? 'حفظ' : 'ضيف'}</button></div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  const f = dlg.querySelector('form');
  f.elements.all.onchange = (e) => { dlg.querySelector('[data-clients]').hidden = e.target.checked; };
  dlg.querySelector('[data-gen]').onclick = () => {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    f.elements.password.value = Array.from(crypto.getRandomValues(new Uint8Array(10)), (n) => chars[n % chars.length]).join('');
  };
  dlg.querySelector('[data-save]').onclick = async (e) => {
    const errBox = dlg.querySelector('#u-err');
    const payload = {
      name: f.elements.name.value, username: f.elements.username.value, password: f.elements.password.value || undefined,
      all_clients: f.elements.all.checked,
      clients: [...f.querySelectorAll('[name=client]:checked')].map((x) => Number(x.value)),
      perms: [...f.querySelectorAll('[name=perm]:checked')].map((x) => x.value),
    };
    e.target.disabled = true;
    try {
      await api(user ? `/users/${user.id}` : '/users', { method: user ? 'PUT' : 'POST', body: payload });
      dlg.close();
      toast(user ? 'اتحفظ ✅' : 'اتضاف ✅');
      if (payload.password) {
        await askConfirm(`ابعت للشخص ده بيانات الدخول:\n\nاللينك: ${location.origin}\nاسم المستخدم: ${payload.username.trim().toLowerCase()}\nكلمة السر: ${payload.password}`, { ok: 'تمام', cancel: 'قفل' });
      }
      done();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
      e.target.disabled = false;
    }
  };
  dlg.showModal();
}

// ---------- automatic WhatsApp statuses (our own gateway inside Cloudflare) ----------
function openWhatsAppAuto(accountId, name, isAuto, done) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.innerHTML = `<form method="dialog" class="dlg-body">
    <div class="dlg-head"><b>⚡ حالات واتساب تلقائي: ${esc(name)}</b><button class="btn small dlg-close" value="close">✕</button></div>
    <div id="wa-state"><div class="muted small">بيتصل بواتساب…</div></div>
    <div class="notice small" style="margin:0">⚠️ الربط ده زي WhatsApp Web بالظبط، ومش رسمي من واتساب. استخدمه بهدوء (حط حد يومي من صفحة 📱 حالات واتساب). الحالة بتوصل لجهات الاتصال اللي على الرقم.</div>
    <div id="wa-err" class="notice bad" hidden></div>
    <div class="dlg-actions" id="wa-actions"></div>
  </form>`;
  document.body.appendChild(dlg);
  let timer = null;
  let closed = false;
  dlg.addEventListener('close', () => { closed = true; clearTimeout(timer); dlg.remove(); done(); });
  const box = dlg.querySelector('#wa-state');
  const errBox = dlg.querySelector('#wa-err');
  const actions = dlg.querySelector('#wa-actions');
  const showErr = (m) => { errBox.textContent = m || ''; errBox.hidden = !m; };

  const render = (s) => {
    if (s.connected) {
      const when = (ms) => (ms ? new Date(ms).toLocaleString('ar-EG') : '—');
      box.innerHTML = `<div class="notice ok">✅ مربوط${s.phone ? ` بالرقم <b dir="ltr">+${esc(s.phone)}</b>` : ''}${s.name ? ` (${esc(s.name)})` : ''}.<br>
        الحالات اللي هتتجدول على الحساب ده هتتنشر لوحدها في ميعادها.</div>
        <div class="small">👥 جهات الاتصال اللي هتشوف الحالة: <b>${fmtNum(s.contacts)}</b>${s.contacts ? '' : ' <span class="muted">(بتوصل من الموبايل خلال دقايق بعد الربط، سيب واتساب مفتوح على الموبايل شوية)</span>'}<br>
        ${s.last_status ? `📤 آخر حالة: اتبعتت لـ <b>${fmtNum(s.last_status.audience)}</b> جهة اتصال (${esc(when(s.last_status.at))})${
          s.last_status.ack ? (s.last_status.ack.error ? ` · <b style="color:var(--bad)">واتساب رفضها (كود ${esc(s.last_status.ack.error)})</b>` : ' · ✅ واتساب استلمها') : (s.last_status.id ? ' · ⚠️ مفيش تأكيد من واتساب' : '')
        }<br><span class="muted small" dir="ltr">diag: ${esc(JSON.stringify({ a: s.last_status.audience, pn: s.last_status.with_phone, lid: s.last_status.lids, map: s.last_status.mapped, drop: s.last_status.dropped, k: s.last_status.kind, m: s.last_status.media, ack: s.last_status.ack }))}</span><br>` : ''}
        <span class="muted">آخر اتصال: ${esc(when(s.last_open))}</span><br>
        <span class="muted small">الحالة بتظهر عند الشخص لو رقمك متسجل عنده <b>و</b> رقمه متسجل عندك، وحسب إعدادات خصوصية الحالة على موبايلك.</span></div>`;
      actions.innerHTML = '<button type="button" class="btn danger" data-unlink>افصل الرقم ورجّعها يدوي</button>';
      actions.querySelector('[data-unlink]').onclick = async () => {
        if (!(await askConfirm('الرقم هيتشال من الأجهزة المرتبطة، والحالات هترجع تيجيلك إشعار وتنشرها بإيدك. تمام؟'))) return;
        await api(`/whatsapp/accounts/${accountId}/unlink`, { method: 'POST' });
        toast('اتفصل، ورجعت يدوي');
        dlg.close();
      };
      // Keep refreshing while contacts are still arriving.
      if (!s.contacts) timer = setTimeout(poll, 8000);
      return;
    }
    box.innerHTML = `<div class="wa-qr">${s.qr ? `<div class="wa-qr-img">${s.qr}</div>` : '<div class="muted small">بيجهّز الكود…</div>'}
      <ol class="wa-steps small">
        <li>افتح واتساب على موبايل صاحب الرقم</li>
        <li><b>الإعدادات</b> (أو ⋮) ← <b>الأجهزة المرتبطة</b> ← <b>ربط جهاز</b></li>
        <li>امسح الكود ده. الكود بيتجدد لوحده</li>
      </ol></div>`;
    actions.innerHTML = '';
    timer = setTimeout(poll, 3000);
  };
  const poll = async () => {
    if (closed) return;
    try {
      render(await api(`/whatsapp/accounts/${accountId}/link`));
      showErr('');
    } catch (err) {
      showErr(err.message);
      timer = setTimeout(poll, 6000);
    }
  };
  poll();
  dlg.showModal();
}

// ---------- connect: pick which pages belong to the client ----------
async function renderConnect(main, params) {
  const $ = (sel) => main.querySelector(sel); // this page's own elements only
  const token = params.get('token') || '';
  const data = await api(`/connect/${encodeURIComponent(token)}`);
  // Group each Instagram account under its Facebook page.
  const pages = data.items.filter((i) => i.platform === 'facebook');
  const igFor = (pageId) => data.items.filter((i) => i.platform === 'instagram' && i.page_id === pageId);
  const row = (it) => {
    const elsewhere = it.linked_client_id && it.linked_client_id !== data.client_id;
    const here = it.linked_client_id === data.client_id;
    return `
      <label class="pick">
        <input type="checkbox" value="${esc(it.key)}" ${here ? 'checked' : ''}>
        ${it.picture ? `<img src="${esc(it.picture)}" alt="" style="width:28px;height:28px;border-radius:50%">` : ''}
        ${platformTag(it.platform)} <b>${esc(it.name)}</b>
        ${elsewhere ? `<span class="badge partial">مربوط بـ ${esc(it.linked_client_name)}، هيتنقل</span>` : ''}
        ${here ? '<span class="badge published">مربوط بالعميل ده</span>' : ''}
      </label>`;
  };

  main.innerHTML = `
    <div class="page-head"><h1>اختار حسابات: ${esc(data.client_name)}</h1></div>
    <div class="notice">فيسبوك بيبعت كل الصفحات اللي إنت أدمن عليها. علّم على صفحات <b>${esc(data.client_name)}</b> بس.</div>
    <form class="card" id="connect-form">
      <div class="account-picks">
        ${pages.map((p) => row(p) + igFor(p.page_id).map((ig) => `<div style="margin-inline-start:28px">${row(ig)}</div>`).join('')).join('')}
        ${data.items.filter((i) => i.platform === 'meta_ads').map((ad) => row(ad)).join('')}
      </div>
      ${data.ads_note ? `<div class="notice" style="margin-top:14px">📢 <b>مفيش حسابات إعلانات ظهرت.</b> ${
        data.ads_note.startsWith('missing:')
          ? `فيسبوك مدّاش صلاحية الإعلانات (${esc(data.ads_note.slice(8))}). دوس ربط تاني، وفي شاشة فيسبوك دوس <b>تعديل الإعدادات / Edit settings</b> واختار حساب الإعلانات ووافق على كل الصلاحيات.`
          : data.ads_note.startsWith('error:')
            ? `فيسبوك رد بالخطأ ده: <span dir="ltr">${esc(data.ads_note.slice(6))}</span>`
            : 'حسابك على فيسبوك مش أدمن على أي حساب إعلانات، أو مختارتوش في شاشة فيسبوك. لو حساب الإعلانات بتاع العميل، خلّيه يضيفك عليه من Business Manager أو يربط من لينك الدعوة.'
      }</div>` : ''}
      <div id="c-err" class="notice bad" hidden style="margin-top:14px"></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn primary">حفظ</button>
        <a class="btn" href="#/clients">إلغاء</a>
      </div>
    </form>`;

  $('#connect-form').onsubmit = async (e) => {
    e.preventDefault();
    const keys = [...main.querySelectorAll('#connect-form input:checked')].map((i) => i.value);
    try {
      const r = await api(`/connect/${encodeURIComponent(token)}`, { method: 'POST', body: { keys } });
      location.hash = `#/clients?connected=${r.saved}`;
    } catch (err) {
      const box = $('#c-err');
      box.textContent = err.message;
      box.hidden = false;
    }
  };
}

// ---------- compose (new / edit / copy) ----------
const pad2 = (n) => String(n).padStart(2, '0');
const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const toDateInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseDateInput = (v) => { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d); };
const WEEKDAYS = [[6, 'السبت'], [0, 'الأحد'], [1, 'الاثنين'], [2, 'الثلاثاء'], [3, 'الأربعاء'], [4, 'الخميس'], [5, 'الجمعة']];
const MAX_SERIES = 200;

// Every publish time for a repeat rule (only future times, capped at MAX_SERIES).
function repeatTimes({ freq, interval, start, times, weekdays, endType, count, until }) {
  const out = [];
  if (!start || !times.length) return out;
  const startDay = parseDateInput(start);
  let untilMs = Infinity;
  if (endType === 'until' && until) {
    const u = parseDateInput(until);
    untilMs = new Date(u.getFullYear(), u.getMonth(), u.getDate(), 23, 59).getTime();
  }
  const limit = endType === 'count' ? Math.min(count || 1, MAX_SERIES) : MAX_SERIES;
  const now = Date.now();
  const sortedTimes = [...times].sort();
  for (let i = 0; i < 366 * 3 && out.length < limit; i++) {
    const day = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + i);
    let match = false;
    if (freq === 'daily') match = i % interval === 0;
    if (freq === 'weekly') match = weekdays.includes(day.getDay()) && Math.floor(i / 7) % interval === 0;
    if (freq === 'monthly') {
      const months = (day.getFullYear() - startDay.getFullYear()) * 12 + day.getMonth() - startDay.getMonth();
      match = day.getDate() === startDay.getDate() && months % interval === 0;
    }
    if (!match) continue;
    for (const t of sortedTimes) {
      const [hh, mm] = t.split(':').map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm).getTime();
      if (at > untilMs) return out;
      if (at > now && out.length < limit) out.push(at);
    }
  }
  return out;
}

async function renderCompose(main, params) {
  const $ = (sel) => main.querySelector(sel); // this page's own elements only
  const clients = await loadClients();
  if (!clients.length) {
    main.innerHTML = `<div class="page-head"><h1>منشور جديد</h1></div><div class="card empty">ضيف عميل الأول من <a href="#/clients">العملاء والحسابات</a>.</div>`;
    return;
  }
  const editId = params.get('edit');
  const copyId = params.get('copy');
  const source = editId || copyId ? await api(`/posts/${editId || copyId}`) : null;
  const isEdit = Boolean(editId);
  const preselect = source ? source.client_id : params.get('client') || clients[0].id;
  const soon = Date.now() + 60 * 60 * 1000;
  // Opened from a calendar day: default to 10 AM that day (or an hour from now if that's already past).
  let firstWhen = isEdit && source.scheduled_at ? source.scheduled_at : soon;
  if (!isEdit && /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '')) {
    const d = parseDateInput(params.get('date'));
    firstWhen = Math.max(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0).getTime(), soon);
  }
  const title = isEdit ? 'تعديل منشور' : copyId ? 'نسخ / تكرار منشور' : 'منشور جديد';

  main.innerHTML = `
    <div class="page-head"><h1>${title}</h1></div>
    ${copyId ? '<div class="notice ok">ده نسخة من منشور قديم. عدّل اللي إنت عايزه واختار المواعيد الجديدة.</div>' : ''}
    ${isEdit && source.series_id ? '<div class="notice">المنشور ده جزء من سلسلة متكررة. التعديل هيغيّر المنشور ده بس.</div>' : ''}
    <div class="grid compose">
      <form class="card" id="compose">
        <div class="field">
          <label>هتنشر على إيه؟</label>
          <div class="modes platform-pick" id="p-platforms"></div>
        </div>
        <div class="field">
          <label for="p-client">العميل</label>
          <select id="p-client">${clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(preselect) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label>الحسابات</label>
          <div id="p-accounts" class="account-picks"></div>
        </div>
        <div class="field">
          <label for="p-message">نص المنشور</label>
          <textarea id="p-message" placeholder="اكتب البوست هنا…">${esc(source?.message || '')}</textarea>
          <div class="counter" id="p-count">0 حرف</div>
        </div>
        <div class="field">
          <label>الصور أو الفيديو (مطلوبين لإنستجرام)</label>
          <div id="p-media" class="media-list"></div>
          <label class="drop" id="p-drop" for="p-file">
            <input id="p-file" type="file" accept="image/*,video/mp4,video/quicktime,.mov" multiple hidden>
            <span id="p-drop-text">📷🎬 دوس هنا واختار صور (لحد 10 = ألبوم) أو فيديو واحد، أو اسحبهم وسيبهم هنا</span>
          </label>
          <div class="progress" id="p-progress" hidden><div></div><span></span></div>
          <div class="time-row" id="p-url-row" style="margin-top:8px">
            <input id="p-url" type="url" dir="ltr" placeholder="أو حط رابط صورة: https://...jpg">
            <button type="button" class="btn small" id="p-url-add">إضافة</button>
          </div>
          <label class="pick" id="p-reel-wrap" hidden style="margin-top:8px"><input type="checkbox" id="p-reel"> انشر الفيديو كـ <b>Reel</b> على فيسبوك (لو مش متعلّم بينزل فيديو عادي)</label>
          <div class="muted small" id="p-media-hint" style="margin-top:6px"></div>
        </div>
        <div class="field">
          <label for="p-link">رابط (لفيسبوك فقط، اختياري)</label>
          <input id="p-link" type="url" dir="ltr" placeholder="https://" value="${esc(source?.link || '')}">
        </div>
        <div class="field">
          <label>النشر</label>
          <div class="modes">
            <label><input type="radio" name="mode" value="schedule" checked> ميعاد واحد</label>
            ${isEdit ? '' : `
            <label><input type="radio" name="mode" value="repeat"> 🔁 تكرار تلقائي</label>
            <label><input type="radio" name="mode" value="dates"> 📅 مواعيد مخصوصة</label>`}
            <label><input type="radio" name="mode" value="now"> انشر دلوقتي</label>
            <label><input type="radio" name="mode" value="draft"> مسودة</label>
          </div>
        </div>

        <div class="field panel" data-panel="schedule">
          <label for="p-when">الميعاد</label>
          <input id="p-when" type="datetime-local" value="${toLocalInput(firstWhen)}">
        </div>

        <div class="panel" data-panel="repeat" hidden>
          <div class="row">
            <div><label for="r-freq">يتكرر</label>
              <select id="r-freq">
                <option value="daily">كل يوم</option>
                <option value="weekly" selected>كل أسبوع (أيام معينة)</option>
                <option value="monthly">كل شهر</option>
              </select></div>
            <div style="max-width:140px"><label for="r-interval" id="r-interval-label">كل كام أسبوع؟</label>
              <input id="r-interval" type="number" min="1" max="12" value="1"></div>
            <div><label for="r-start">من يوم</label>
              <input id="r-start" type="date" value="${toDateInput(new Date())}"></div>
          </div>
          <div class="field" id="r-weekdays-wrap" style="margin-top:12px">
            <label>في الأيام دي</label>
            <div class="modes" id="r-weekdays">
              ${WEEKDAYS.map(([v, n]) => `<label><input type="checkbox" value="${v}" ${v === new Date().getDay() ? 'checked' : ''}> ${n}</label>`).join('')}
            </div>
          </div>
          <div class="muted small" id="r-monthly-note" hidden style="margin:8px 0">هينزل في نفس رقم اليوم من كل شهر (حسب "من يوم").</div>
          <div class="field" style="margin-top:12px">
            <label>الساعة (ممكن أكتر من ميعاد في اليوم)</label>
            <div id="r-times" class="times"></div>
            <button type="button" class="btn small" id="r-add-time">+ ميعاد تاني في نفس اليوم</button>
          </div>
          <div class="field">
            <label>يقف إمتى؟</label>
            <div class="modes">
              <label><input type="radio" name="r-end" value="count" checked> بعد <input id="r-count" type="number" min="1" max="${MAX_SERIES}" value="10" style="width:70px;padding:2px 6px"> مرة</label>
              <label><input type="radio" name="r-end" value="until"> لحد يوم <input id="r-until" type="date" style="width:auto;padding:2px 6px" value="${toDateInput(new Date(Date.now() + 30 * 86400000))}"></label>
            </div>
          </div>
        </div>

        <div class="panel" data-panel="dates" hidden>
          <div class="field">
            <label>المواعيد</label>
            <div id="d-list" class="times"></div>
            <button type="button" class="btn small" id="d-add">+ ميعاد تاني</button>
          </div>
        </div>

        <div id="p-summary"></div>
        <div class="muted small">النشر المجدول بيتم في خلال 5 دقايق من الميعاد.</div>
        <div id="p-err" class="notice bad" hidden style="margin-top:10px"></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn primary" id="p-submit">حفظ</button>
          ${isEdit || copyId ? '<a class="btn" href="#/posts">إلغاء</a>' : ''}
        </div>
      </form>
      <div class="card">
        <h2>معاينة</h2>
        <div class="preview" id="preview"><span class="muted">اكتب المنشور وهتظهر المعاينة هنا</span></div>
      </div>
    </div>`;

  // --- platform choice + accounts ---
  // "الكل" or one platform; every platform in PLATFORM shows up here automatically.
  const clientSel = $('#p-client');
  const preChecked = source ? new Set(source.targets.map((t) => t.account_id)) : null;
  let platformChoice = params.get('platform') || (source ? 'all' : (() => { try { return localStorage.getItem('sm.platform') || 'all'; } catch { return 'all'; } })());
  if (platformChoice !== 'all' && !PLATFORM[platformChoice]) platformChoice = 'all';
  let accounts = [];

  const renderPlatforms = () => {
    const count = (p) => accounts.filter((a) => a.platform === p).length;
    const chips = [['all', `🌐 الكل (${accounts.length})`], ...Object.keys(PLATFORM).filter((p) => !NON_POSTING.includes(p)).map((p) => [p, `${PLATFORM[p]} (${count(p)})`])];
    $('#p-platforms').innerHTML = chips.map(([v, label]) =>
      `<label class="${v !== 'all' ? `pf-${v}` : ''}"><input type="radio" name="platform" value="${v}" ${v === platformChoice ? 'checked' : ''}> ${esc(label)}</label>`).join('');
    $('#p-platforms').querySelectorAll('input').forEach((r) => {
      r.onchange = () => {
        platformChoice = r.value;
        try { localStorage.setItem('sm.platform', platformChoice); } catch { /* private mode */ }
        renderAccountList();
      };
    });
  };

  const renderAccountList = () => {
    const box = $('#p-accounts');
    const sameClient = source && String(source.client_id) === clientSel.value;
    const list = platformChoice === 'all' ? accounts : accounts.filter((a) => a.platform === platformChoice);
    if (list.length) {
      box.innerHTML = list.map((a) => `<label class="pick"><input type="checkbox" value="${a.id}" data-platform="${a.platform}" ${!sameClient || preChecked.has(a.id) ? 'checked' : ''}> ${platformTag(a.platform)} ${esc(a.name)}</label>`).join('');
    } else if (platformChoice === 'whatsapp') {
      box.innerHTML = `<div class="notice">العميل ده لسه ملوش حساب "حالة واتساب". <button type="button" class="btn small primary" id="p-add-wa">+ ضيف حالة واتساب</button></div>`;
      $('#p-add-wa').onclick = async () => {
        const name = await askText('اسم لحساب واتساب ده (مثلاً رقم العميل أو اسم الموبايل):', 'واتساب المحل');
        if (name === null) return;
        await api('/accounts/whatsapp', { method: 'POST', body: { client_id: Number(clientSel.value), name } });
        toast('اتضاف ✅');
        await loadAccounts();
      };
    } else if (EXTRA.includes(platformChoice)) {
      box.innerHTML = me?.providers?.[platformChoice]
        ? `<div class="notice">العميل ده لسه مش مربوط بـ${PLATFORM[platformChoice]}. ${connectBtn(platformChoice, clientSel.value, 'btn small primary')}</div>`
        : `<div class="notice">${PLATFORM[platformChoice]} لسه مش متفعّل في المنصة. محتاج تعمل تطبيق مطوّرين وتحط مفاتيحه في Cloudflare (الخطوات في README).</div>`;
    } else if (platformChoice === 'facebook' || platformChoice === 'instagram') {
      box.innerHTML = `<div class="notice">العميل ده لسه مش مربوط بـ${PLATFORM[platformChoice]}.
        ${me.metaConfigured ? `<a class="btn small primary" href="/auth/meta/start?client_id=${clientSel.value}">ربط فيسبوك وإنستجرام</a>` : ''}</div>`;
    } else {
      box.innerHTML = `<span class="muted small">العميل ده مفيش عنده حسابات مربوطة. <a href="#/clients">اربط حساباته</a></span>`;
    }
  };

  async function loadAccounts() {
    $('#p-accounts').innerHTML = '<span class="muted small">جاري التحميل…</span>';
    accounts = (await api(`/accounts?client_id=${clientSel.value}`)).filter((a) => !NON_POSTING.includes(a.platform));
    renderPlatforms();
    renderAccountList();
  }
  clientSel.onchange = loadAccounts;
  await loadAccounts();


  // --- media: up to 10 images (album) or one video ---
  let media = source ? (source.media || []).map((m) => ({ type: m.type, url: m.url })) : [];
  const submitBtn = $('#p-submit');
  const dropIdle = '📷🎬 دوس هنا واختار صور (لحد 10 = ألبوم) أو فيديو واحد، أو اسحبهم وسيبهم هنا';
  const dropText = $('#p-drop-text');
  if (source?.fb_reel) $('#p-reel').checked = true;

  const renderMedia = () => {
    const box = $('#p-media');
    const video = media.find((m) => m.type === 'video');
    box.innerHTML = media.map((m, i) => `
      <div class="media-item" data-i="${i}">
        ${m.type === 'video'
          ? `<video src="${esc(m.url)}" muted preload="metadata"></video><span class="media-badge">🎬 فيديو${m.duration ? ` · ${Math.round(m.duration)} ث` : ''}</span>`
          : `<img src="${esc(m.url)}" alt="" onerror="this.classList.add('broken')"><span class="media-badge">${media.length > 1 ? i + 1 : '📷'}</span>`}
        <div class="media-tools">
          ${m.type === 'image' && media.length > 1 ? `
            <button type="button" class="btn small" data-mv="-1" title="قدّمها" ${i === 0 ? 'disabled' : ''}>→</button>
            <button type="button" class="btn small" data-mv="1" title="أخّرها" ${i === media.length - 1 ? 'disabled' : ''}>←</button>` : ''}
          <button type="button" class="btn small danger" data-rm title="شيل">✕</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('.media-item').forEach((el) => {
      const i = Number(el.dataset.i);
      el.querySelector('[data-rm]').onclick = () => { media.splice(i, 1); renderMedia(); };
      el.querySelectorAll('[data-mv]').forEach((b) => {
        b.onclick = () => {
          const j = i + Number(b.dataset.mv);
          [media[i], media[j]] = [media[j], media[i]];
          renderMedia();
        };
      });
    });
    $('#p-reel-wrap').hidden = !video;
    const hint = $('#p-media-hint');
    if (video) {
      hint.textContent = 'إنستجرام هينزله Reel (من 3 ثواني لـ 15 دقيقة). Reel فيسبوك لازم يكون طولي (9:16) ومن 3 لـ 90 ثانية، غير كده خليه فيديو عادي. الفيديو بيتمسح من التخزين بعد النشر بأسبوع.';
    } else if (media.length > 1) {
      hint.textContent = `ألبوم ${media.length} صور. رتّبهم بالأسهم، والأولى هي اللي بتظهر الأول.`;
    } else {
      hint.textContent = '';
    }
    $('#p-url-row').hidden = Boolean(video) || media.length >= 10;
    $('#p-drop').hidden = Boolean(video) || media.length >= 10;
    updatePreview();
  };

  // --- preview ---
  function updatePreview() {
    const msg = $('#p-message').value;
    $('#p-count').textContent = `${msg.length} حرف${msg.length > 2200 ? ' (إنستجرام أقصاه 2200)' : ''}`;
    let mediaHtml = '';
    const video = media.find((m) => m.type === 'video');
    if (video) mediaHtml = `<video src="${esc(video.url)}" controls preload="metadata"></video>`;
    else if (media.length > 1) mediaHtml = `<div class="album">${media.map((m) => `<img src="${esc(m.url)}" alt="">`).join('')}</div>`;
    else if (media.length === 1) mediaHtml = `<img src="${esc(media[0].url)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'notice bad',textContent:'الصورة مش بتفتح من الرابط ده'}))">`;
    $('#preview').innerHTML = (msg || media.length) ? `${esc(msg)}${mediaHtml}` : '<span class="muted">اكتب المنشور وهتظهر المعاينة هنا</span>';
  }
  $('#p-message').oninput = updatePreview;

  // --- upload ---
  const progress = (label, pct) => {
    const bar = $('#p-progress');
    bar.hidden = pct == null;
    if (pct != null) {
      bar.querySelector('div').style.width = `${Math.round(pct)}%`;
      bar.querySelector('span').textContent = `${label} ${Math.round(pct)}%`;
    }
  };
  const uploadImage = async (file) => {
    const jpeg = await toJpeg(file);
    const res = await fetch('/api/media', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل رفع الصورة');
    return data.url;
  };
  const uploadVideo = async (file) => {
    const info = await videoInfo(file);
    const type = file.type || (file.name.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4');
    const start = await api('/media/video', { method: 'POST', body: { size: file.size, type } });
    for (let i = 0; i < start.chunks; i++) {
      const part = file.slice(i * start.chunkSize, Math.min(file.size, (i + 1) * start.chunkSize));
      await putWithProgress(`/api/media/video/${start.id}/${i}`, part, (loaded) => {
        progress('جاري رفع الفيديو', ((i * start.chunkSize + loaded) / file.size) * 100);
      });
    }
    const done = await api(`/media/video/${start.id}/finish`, { method: 'POST' });
    return { url: done.url, ...info };
  };

  const addFiles = async (files) => {
    files = [...files].filter(Boolean);
    if (!files.length) return;
    const videos = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov)$/i.test(f.name));
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (videos.length + images.length !== files.length) return toast('فيه ملف مش صورة ولا فيديو');
    if (videos.length > 1 || (videos.length && images.length)) return toast('اختار فيديو واحد بس، أو صور بس');
    if (videos.length && media.length) {
      if (!(await askConfirm('الفيديو هيشيل الصور اللي ضفتها (فيديو وصور مينفعوش في نفس المنشور). تمام؟'))) return;
      media = [];
    }
    if (images.length && media.some((m) => m.type === 'video')) {
      if (!(await askConfirm('الصور هتشيل الفيديو (فيديو وصور مينفعوش في نفس المنشور). تمام؟'))) return;
      media = [];
    }
    if (images.length + media.length > 10) return toast(`أقصى عدد 10 صور. فاضل ${10 - media.length}`);

    submitBtn.disabled = true;
    try {
      if (videos.length) {
        const f = videos[0];
        if (f.size > 100 * 1024 * 1024) throw new Error('الفيديو أكبر من 100 ميجا. صغّره أو قصّره الأول.');
        progress('جاري رفع الفيديو', 0);
        const v = await uploadVideo(f);
        media = [{ type: 'video', ...v }];
        $('#p-reel').checked = v.width < v.height && v.duration <= 90;
      } else {
        for (let i = 0; i < images.length; i++) {
          progress(`جاري رفع الصور (${i + 1} من ${images.length})`, (i / images.length) * 100);
          media.push({ type: 'image', url: await uploadImage(images[i]) });
          renderMedia();
        }
      }
      renderMedia();
    } catch (err) {
      toast(err.message);
    } finally {
      progress('', null);
      submitBtn.disabled = false;
      $('#p-file').value = '';
      dropText.textContent = dropIdle;
    }
  };
  $('#p-file').onchange = (e) => addFiles(e.target.files);
  const drop = $('#p-drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
  $('#p-url-add').onclick = () => {
    const u = $('#p-url').value.trim();
    if (!/^https?:\/\//i.test(u)) return toast('الرابط لازم يبدأ بـ http أو https');
    if (media.some((m) => m.type === 'video')) return toast('شيل الفيديو الأول');
    media.push({ type: 'image', url: u });
    $('#p-url').value = '';
    renderMedia();
  };
  renderMedia();

  // --- time rows (repeat times and custom dates) ---
  const addRow = (box, type, value) => {
    const row = document.createElement('div');
    row.className = 'time-row';
    row.innerHTML = `<input type="${type}" value="${value}"><button type="button" class="btn small danger" title="شيل">✕</button>`;
    row.querySelector('button').onclick = () => { if (box.children.length > 1) { row.remove(); refresh(); } };
    row.querySelector('input').addEventListener('input', refresh);
    box.appendChild(row);
  };
  addRow($('#r-times'), 'time', '10:00');
  $('#r-add-time').onclick = () => { addRow($('#r-times'), 'time', '20:00'); refresh(); };
  addRow($('#d-list'), 'datetime-local', toLocalInput(soon));
  $('#d-add').onclick = () => {
    const rows = [...$('#d-list').querySelectorAll('input')];
    const last = rows.length ? new Date(rows[rows.length - 1].value).getTime() : soon;
    addRow($('#d-list'), 'datetime-local', toLocalInput((last || soon) + 86400000));
    refresh();
  };

  const mode = () => document.querySelector('input[name=mode]:checked').value;

  // Every publish time for the current mode.
  const collectTimes = () => {
    const m = mode();
    if (m === 'schedule') { const v = new Date($('#p-when').value).getTime(); return v ? [v] : []; }
    if (m === 'dates') {
      const vals = [...$('#d-list').querySelectorAll('input')].map((i) => new Date(i.value).getTime()).filter(Boolean);
      return [...new Set(vals)].sort((a, b) => a - b);
    }
    if (m === 'repeat') {
      return repeatTimes({
        freq: $('#r-freq').value,
        interval: Math.max(1, Number($('#r-interval').value) || 1),
        start: $('#r-start').value,
        times: [...$('#r-times').querySelectorAll('input')].map((i) => i.value).filter(Boolean),
        weekdays: [...$('#r-weekdays').querySelectorAll('input:checked')].map((i) => Number(i.value)),
        endType: document.querySelector('input[name=r-end]:checked').value,
        count: Number($('#r-count').value),
        until: $('#r-until').value,
      });
    }
    return [];
  };

  function refresh() {
    const m = mode();
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== m; });
    const freq = $('#r-freq').value;
    $('#r-weekdays-wrap').hidden = freq !== 'weekly';
    $('#r-monthly-note').hidden = freq !== 'monthly';
    $('#r-interval-label').textContent = { daily: 'كل كام يوم؟', weekly: 'كل كام أسبوع؟', monthly: 'كل كام شهر؟' }[freq];
    const summary = $('#p-summary');
    let label = { now: 'انشر دلوقتي', draft: 'حفظ كمسودة' }[m];
    if (m === 'schedule') {
      summary.innerHTML = '';
      label = isEdit ? 'حفظ التعديل' : 'جدولة المنشور';
    } else if (m === 'repeat' || m === 'dates') {
      const times = collectTimes();
      if (!times.length) {
        summary.innerHTML = '<div class="notice bad">مفيش ولا ميعاد في المستقبل بالاختيارات دي.</div>';
        label = 'جدولة';
      } else {
        const shown = times.slice(0, 8).map((t) => `<li>${esc(fmtDate(t))}</li>`).join('');
        summary.innerHTML = `<div class="notice ok"><b>هيتعمل ${times.length} منشور</b>${times.length >= MAX_SERIES ? ` (الحد الأقصى ${MAX_SERIES})` : ''}، من ${esc(fmtDate(times[0]))} لحد ${esc(fmtDate(times[times.length - 1]))}<ul class="dates">${shown}${times.length > 8 ? `<li>… و${times.length - 8} كمان</li>` : ''}</ul></div>`;
        label = `جدولة ${times.length} منشور`;
      }
    } else {
      summary.innerHTML = '';
      if (isEdit) label = m === 'now' ? 'حفظ وانشر دلوقتي' : 'حفظ كمسودة';
    }
    submitBtn.textContent = label;
  }
  main.querySelectorAll('input[name=mode], input[name=r-end], #r-freq, #r-interval, #r-start, #r-weekdays input, #r-count, #r-until, #p-when')
    .forEach((el) => { el.addEventListener('change', refresh); el.addEventListener('input', refresh); });
  refresh();

  // --- submit ---
  $('#compose').onsubmit = async (e) => {
    e.preventDefault();
    const errBox = $('#p-err');
    errBox.hidden = true;
    const m = mode();
    const times = collectTimes();
    if (['schedule', 'repeat', 'dates'].includes(m) && !times.length) {
      errBox.textContent = 'اختار ميعاد في المستقبل';
      errBox.hidden = false;
      return;
    }
    if (times.length > 1 && !(await askConfirm(`هيتعمل ${times.length} منشور مجدول. تمام؟`))) return;
    const payload = {
      client_id: Number(clientSel.value),
      account_ids: [...document.querySelectorAll('#p-accounts input:checked')].map((i) => Number(i.value)),
      message: $('#p-message').value,
      media: media.map((m) => ({ type: m.type, url: m.url })),
      fb_reel: $('#p-reel').checked,
      link: $('#p-link').value.trim() || null,
      mode: m === 'repeat' || m === 'dates' ? 'schedule' : m,
      scheduled_times: times,
    };
    submitBtn.disabled = true;
    try {
      const post = await api(isEdit ? `/posts/${editId}` : '/posts', { method: isEdit ? 'PUT' : 'POST', body: payload });
      if (m === 'now') toast(publishMsg(post.status));
      else if (m === 'draft') toast('اتحفظ كمسودة');
      else if (isEdit) toast('التعديل اتحفظ');
      else toast(post.created > 1 ? `اتجدول ${post.created} منشور` : 'اتجدول بنجاح');
      location.hash = '#/posts';
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
      submitBtn.disabled = false;
    }
  };
}

// Duration and size of a video file, read in the browser.
function videoInfo(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const info = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
      URL.revokeObjectURL(url);
      if (info.duration < 3) return reject(new Error('الفيديو أقصر من 3 ثواني، إنستجرام وفيسبوك مش هيقبلوه'));
      if (info.duration > 15 * 60) return reject(new Error('الفيديو أطول من 15 دقيقة، إنستجرام مش هيقبله'));
      resolve(info);
    };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('مش قادر أقرا الفيديو ده. لازم يكون MP4 أو MOV.')); };
    v.src = url;
  });
}

// Upload one chunk with progress (fetch can't report upload progress).
function putWithProgress(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || 'فشل رفع الفيديو'));
    };
    xhr.onerror = () => reject(new Error('النت فصل أثناء رفع الفيديو، جرّب تاني'));
    xhr.send(blob);
  });
}

// Re-encode an image as JPEG, max 2048px on the long side, inside Instagram's aspect-ratio limits.
async function toJpeg(file) {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('مش قادر أقرا الصورة دي، جرّب صورة JPG أو PNG'); });
  let { width: w, height: h } = bitmap;
  const ratio = w / h;
  if (ratio > 1.91 || ratio < 0.8) {
    toast('تنبيه: إنستجرام بيقبل نسبة أبعاد بين 4:5 و 1.91:1، الصورة دي ممكن تترفض على إنستجرام');
  }
  const scale = Math.min(1, 2048 / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs get a white background instead of black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('فشل تجهيز الصورة'))), 'image/jpeg', 0.9));
}

// ---------- WhatsApp statuses: share from the phone in one tap ----------
const canShareFiles = () => {
  try {
    return Boolean(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.jpg', { type: 'image/jpeg' })] }));
  } catch { return false; }
};

async function updateWaBadge() {
  try {
    const { count } = await api('/whatsapp/count');
    const b = $('#wa-badge');
    if (b) { b.textContent = count; b.hidden = !count; }
    return count;
  } catch { return 0; }
}

// --- notifications ---
async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub ? 'on' : Notification.permission === 'denied' ? 'denied' : 'off';
}

function urlB64ToBytes(b64) {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('الإشعارات اترفضت. فعّلها من إعدادات المتصفح للموقع ده.');
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const { publicKey } = await api('/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(publicKey) });
  await api('/push/subscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
}

async function renderWhatsApp(main) {
  const $ = (sel) => main.querySelector(sel); // this page's own elements only
  const [data, push, { limit, media_only: mediaOnly = true }] = await Promise.all([api('/whatsapp/queue'), pushStatus().catch(() => 'unsupported'), api('/whatsapp/limit').catch(() => ({ limit: 0 }))]);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const shareOk = canShareFiles();

  const pushBox = {
    on: `<div class="notice ok">🔔 الإشعارات شغالة على الجهاز ده. <button class="btn small" id="push-test">جرّب إشعار</button></div>`,
    off: `<div class="notice">🔔 عشان يوصلك إشعار لما حالة يجي ميعادها، فعّل الإشعارات على الموبايل اللي عليه واتساب.
           <button class="btn primary small" id="push-on">فعّل الإشعارات</button></div>`,
    denied: '<div class="notice bad">الإشعارات مقفولة للموقع ده. فعّلها من إعدادات المتصفح وارجع هنا.</div>',
    unsupported: isIOS && !standalone
      ? '<div class="notice">📱 على الآيفون: دوس زرار المشاركة <b>⎋</b> تحت في Safari ← <b>إضافة إلى الشاشة الرئيسية</b>، وافتح المنصة من الأيقونة الجديدة، وبعدها فعّل الإشعارات من هنا.</div>'
      : '<div class="notice">المتصفح ده مش بيدعم الإشعارات. افتح المنصة من Chrome على الموبايل.</div>',
  }[push];

  const card = (it) => {
    const m = it.media || [];
    const video = m.find((x) => x.type === 'video');
    const when = it.scheduled_at || it.created_at;
    const preview = video
      ? `<video src="${esc(video.url)}" controls preload="metadata"></video>`
      : m.length ? `<div class="wa-imgs">${m.map((x) => `<img src="${esc(x.url)}" alt="">`).join('')}</div>` : '';
    return `
      <div class="card wa-card" data-target="${it.target_id}">
        <div class="meta" style="margin:0 0 8px">
          <span class="dot" style="background:${esc(it.client_color)}"></span><b>${esc(it.client_name)}</b>
          <span class="platform whatsapp">واتساب</span> ${esc(it.account_name)} · <span>${esc(fmtDate(when))}</span>
        </div>
        ${preview}
        ${it.message ? `<div class="wa-text">${esc(it.message)}</div>` : ''}
        <div class="wa-actions">
          ${shareOk ? `<button class="btn primary" data-share disabled>⏳ بيتجهز…</button>` : ''}
          ${it.message ? '<button class="btn small" data-copy>📋 انسخ الكلام</button>' : ''}
          ${m.map((x, i) => `<a class="btn small" href="${esc(x.url)}" download="status-${it.target_id}-${i + 1}.${x.type === 'video' ? 'mp4' : 'jpg'}">⬇️ حمّل ${x.type === 'video' ? 'الفيديو' : m.length > 1 ? `صورة ${i + 1}` : 'الصورة'}</a>`).join('')}
        </div>
        <div class="wa-actions" style="margin-top:6px">
          <button class="btn small" data-done>✅ نزلتها على الحالة</button>
          <button class="btn small danger" data-skip>تخطي</button>
        </div>
      </div>`;
  };

  const reload = () => { renderWhatsApp(main); updateWaBadge(); };
  // A posted/upcoming status as a phone-like tile: media preview or green text card.
  const DAY_MS = 86400000;
  const tile = (it, kind) => {
    const m = it.media || [];
    const when = it.scheduled_at || it.created_at;
    const first = m[0];
    const live = kind === 'published' && Date.now() - when < DAY_MS;
    const body = first
      ? first.type === 'video'
        ? `<video src="${esc(first.url)}" preload="metadata" muted playsinline controls></video>`
        : `<img src="${esc(first.url)}" alt="" loading="lazy">${m.length > 1 ? `<span class="st-more">+${m.length - 1}</span>` : ''}`
      : `<div class="st-text">${esc((it.message || '').slice(0, 160))}</div>`;
    const badgeHtml = {
      published: live ? `<span class="st-badge live">🟢 ظاهرة · ${esc(relTime(when + DAY_MS).replace('بعد', 'باقي'))}</span>` : '<span class="st-badge">انتهت</span>',
      upcoming: when < Date.now() ? '<span class="st-badge soon">⏳ بتتنشر دلوقتي</span>' : `<span class="st-badge soon">🕒 ${esc(relTime(when))}</span>`,
      failed: '<span class="st-badge bad">❌ فشلت</span>',
    }[kind];
    return `
      <div class="st-tile ${kind}" data-post="${it.post_id}">
        <div class="st-media">${body}${badgeHtml}</div>
        <div class="st-info">
          <div class="st-who"><span class="dot" style="background:${esc(it.client_color)}"></span><b>${esc(it.client_name)}</b></div>
          <div class="muted small">${esc(it.account_name)} · ${it.auto ? '⚡ تلقائي' : '✋ يدوي'}</div>
          <div class="small">${esc(fmtDate(when))}</div>
          ${first && it.message ? `<div class="st-cap muted small">${esc(it.message.slice(0, 80))}</div>` : ''}
          ${kind === 'failed' ? `<div class="target-error">${esc(it.error || '')}</div>
            <div class="wa-actions"><button class="btn small primary" data-retry="${it.post_id}">🔁 إعادة المحاولة</button></div>` : ''}
        </div>
      </div>`;
  };

  const today = new Date().toDateString();
  const todayCount = (accId) => [...data.published, ...data.ready].filter((x) => x.account_id === accId && new Date(x.scheduled_at || x.created_at).toDateString() === today).length;
  const liveNow = data.published.filter((x) => Date.now() - (x.scheduled_at || x.created_at) < DAY_MS);
  const older = data.published.filter((x) => Date.now() - (x.scheduled_at || x.created_at) >= DAY_MS);
  const anyManual = (data.accounts || []).some((a) => !a.auto);

  main.innerHTML = `
    <div class="page-head"><h1>📱 حالات واتساب</h1><a class="btn primary" href="#/compose?platform=whatsapp">+ حالة جديدة</a></div>

    ${(data.accounts || []).length ? `<div class="wa-numbers">${data.accounts.map((a) => `
      <div class="wa-num">
        <span class="dot" style="background:${esc(a.client_color)}"></span>
        <div><b>${esc(a.client_name)}</b><div class="muted small">${esc(a.name)}</div></div>
        <span class="badge ${a.auto ? 'published' : ''}">${a.auto ? '⚡ تلقائي' : '✋ يدوي'}</span>
        <span class="small">النهارده: <b>${fmtNum(todayCount(a.id))}</b>${limit ? ` من ${fmtNum(limit)}` : ''}</span>
      </div>`).join('')}</div>`
      : '<div class="notice">مفيش أرقام واتساب لسه. من <a href="#/clients">العملاء والحسابات</a> دوس <b>+ حالة واتساب</b> للعميل، وبعدين <b>⚡ خليها تلقائي</b>.</div>'}

    ${data.ready.length ? `<section class="wa-sec">
      <h2>✋ مستنية تنشرها بإيدك <span class="count-pill">${data.ready.length}</span></h2>
      ${!shareOk ? '<div class="notice small">💡 افتح الصفحة دي من <b>الموبايل</b> اللي عليه واتساب عشان تنشر بلمسة واحدة.</div>' : ''}
      <div class="grid wa-grid">${data.ready.map(card).join('')}</div>
    </section>` : ''}

    ${data.failed.length ? `<section class="wa-sec">
      <h2>❌ فشلت <span class="count-pill bad">${data.failed.length}</span></h2>
      <div class="st-grid">${data.failed.map((it) => tile(it, 'failed')).join('')}</div>
    </section>` : ''}

    <section class="wa-sec">
      <h2>📤 منشورة دلوقتي <span class="muted small">(الحالة بتفضل 24 ساعة)</span> <span class="count-pill">${liveNow.length}</span></h2>
      ${liveNow.length ? `<div class="st-grid">${liveNow.map((it) => tile(it, 'published')).join('')}</div>`
        : '<div class="card empty">مفيش حالات ظاهرة دلوقتي.</div>'}
    </section>

    <section class="wa-sec">
      <h2>🕒 الجاية <span class="count-pill">${data.upcoming.length}</span></h2>
      ${data.upcoming.length ? `<div class="st-grid">${data.upcoming.map((it) => tile(it, 'upcoming')).join('')}</div>`
        : '<div class="card empty">مفيش حالات مجدولة الأسبوع ده.</div>'}
    </section>

    ${older.length ? `<details class="wa-sec card"><summary><b>🗂️ اتنشرت قبل كده (آخر أسبوع)</b> <span class="count-pill">${older.length}</span></summary>
      <div class="st-grid" style="margin-top:12px">${older.map((it) => tile(it, 'published')).join('')}</div></details>` : ''}

    ${isOwnerUser() ? `<details class="card wa-settings">
      <summary><b>⚙️ إعدادات الحالات</b></summary>
      <form class="wa-limit" id="wa-limit">
        <label for="wa-limit-n">🛡️ الحد الأقصى للحالات في اليوم لكل رقم</label>
        <input id="wa-limit-n" type="number" min="0" max="50" placeholder="من غير حد" value="${limit || ''}">
        <button class="btn small primary">حفظ</button>
        <span class="muted small">${limit ? `دلوقتي: ${limit} في اليوم.` : 'فاضي = من غير حد.'}</span>
      </form>
      <label class="check"><input type="checkbox" id="wa-media-only" ${mediaOnly ? 'checked' : ''}>
        🖼️ لو المنشور فيه صورة أو فيديو: انشر على الواتساب <b>الصورة/الفيديو بس</b> (الكلام بيفضل على فيسبوك وإنستجرام)</label>
      ${anyManual ? pushBox : ''}
    </details>` : (anyManual ? pushBox : '')}`;

  main.querySelectorAll('[data-retry]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = 'جاري النشر…';
      try {
        const r = await api(`/posts/${b.dataset.retry}/publish`, { method: 'POST' });
        toast(publishMsg(r.status));
      } catch (err) {
        toast(err.message);
      }
      reload();
    };
  });

  if ($('#wa-media-only')) $('#wa-media-only').onchange = async (e) => {
    await api('/whatsapp/limit', { method: 'PUT', body: { media_only: e.target.checked } });
    toast(e.target.checked ? 'الواتساب هياخد الصور والفيديو بس ✅' : 'الواتساب هياخد الكلام مع الصورة');
  };
  if ($('#wa-limit')) $('#wa-limit').onsubmit = async (e) => {
    e.preventDefault();
    const r = await api('/whatsapp/limit', { method: 'PUT', body: { limit: Number($('#wa-limit-n').value) || 0 } });
    toast(r.limit ? `الحد بقى ${r.limit} حالة في اليوم لكل رقم 🛡️` : 'اتشال الحد');
    reload();
  };
  $('#push-on')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await enablePush(); toast('الإشعارات اتفعّلت ✅'); reload(); } catch (err) { toast(err.message); e.target.disabled = false; }
  });
  $('#push-test')?.addEventListener('click', async () => {
    const r = await api('/push/test', { method: 'POST' });
    toast(r.sent ? 'اتبعت إشعار تجربة، المفروض يوصلك دلوقتي' : 'مفيش أجهزة مفعّل عليها الإشعارات');
  });

  for (const it of data.ready) {
    const el = main.querySelector(`.wa-card[data-target="${it.target_id}"]`);
    let files = null;
    const shareBtn = el.querySelector('[data-share]');
    // Download the files ahead of time: the share sheet must open right on the tap.
    if (shareBtn) {
      Promise.all((it.media || []).map(async (x, i) => {
        const blob = await (await fetch(x.url)).blob();
        const type = blob.type || (x.type === 'video' ? 'video/mp4' : 'image/jpeg');
        return new File([blob], `status-${it.target_id}-${i + 1}.${x.type === 'video' ? 'mp4' : 'jpg'}`, { type });
      })).then((f) => {
        files = f;
        shareBtn.disabled = false;
        shareBtn.textContent = '📤 انشر على الحالة';
      }).catch(() => { shareBtn.textContent = 'مقدرتش أجهز الملف، حمّله'; });

      shareBtn.onclick = async () => {
        const text = it.message || '';
        if (text) navigator.clipboard?.writeText(text).catch(() => {});
        const payload = files.length ? { files, text } : { text };
        try {
          await navigator.share(payload);
        } catch (err) {
          if (err.name !== 'AbortError') toast('المشاركة مش شغالة هنا، حمّل الملف وانشره يدوي');
          return;
        }
        if (await askConfirm('نزلت الحالة على واتساب؟', { ok: 'أيوه نزلت ✅', cancel: 'لسه' })) {
          await api(`/whatsapp/targets/${it.target_id}/done`, { method: 'POST' });
          toast('تمام ✅');
          reload();
        }
      };
    }
    el.querySelector('[data-copy]')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(it.message); toast('الكلام اتنسخ 📋'); } catch { toast('مقدرتش أنسخ، علّم على الكلام وانسخه'); }
    });
    el.querySelector('[data-done]').onclick = async () => {
      await api(`/whatsapp/targets/${it.target_id}/done`, { method: 'POST' });
      toast('تمام ✅');
      reload();
    };
    el.querySelector('[data-skip]').onclick = async () => {
      if (!(await askConfirm('تتخطى الحالة دي؟ مش هتظهر هنا تاني.', { ok: 'تخطي' }))) return;
      await api(`/whatsapp/targets/${it.target_id}/skip`, { method: 'POST' });
      reload();
    };
  }
}

// ---------- reports ----------
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('ar-EG'));
const RANGES = [
  ['7', 'آخر 7 أيام'],
  ['30', 'آخر 30 يوم'],
  ['this_month', 'الشهر ده'],
  ['last_month', 'الشهر اللي فات'],
  ['90', 'آخر 3 شهور'],
];

function rangeFor(key) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86400000);
  if (key === 'this_month') return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), tomorrow.getTime()];
  if (key === 'last_month') return [new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime()];
  const days = Number(key) || 30;
  return [new Date(today.getTime() - (days - 1) * 86400000).getTime(), tomorrow.getTime()];
}

function barChart(daily, label, color) {
  if (!daily?.length) return '';
  const max = Math.max(1, ...daily.map((d) => d.value));
  const w = 600;
  const h = 150;
  const bw = w / daily.length;
  const bars = daily.map((d, i) => {
    const bh = Math.max(1, (d.value / max) * (h - 20));
    return `<rect x="${(i * bw + bw * 0.15).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${esc(color)}"><title>${esc(d.day)}: ${fmtNum(d.value)}</title></rect>`;
  }).join('');
  return `<div class="chart">
    <div class="chart-head"><b>${esc(label)} يوم بيوم</b><span class="muted small">أعلى يوم: ${fmtNum(max)}</span></div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" dir="ltr" role="img" aria-label="${esc(label)}">${bars}</svg>
    <div class="chart-foot muted small" dir="ltr"><span>${esc(daily[0].day)}</span><span>${esc(daily.at(-1).day)}</span></div>
  </div>`;
}

function kpi(label, value, extra = '') {
  return `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${fmtNum(value)}</div>${extra}</div>`;
}

function reportHtml(r) {
  const accs = r.accounts || [];
  const total = (k) => {
    const vals = accs.map((a) => a.kpis?.[k]).filter((v) => v != null);
    return vals.length ? vals.reduce((x, y) => x + y, 0) : null;
  };
  const period = `من ${new Date(r.from).toLocaleDateString('ar-EG', { dateStyle: 'medium' })} لحد ${new Date(r.to - 1).toLocaleDateString('ar-EG', { dateStyle: 'medium' })}`;
  const anyErrors = accs.some((a) => a.errors?.length);
  const color = r.client.color || '#4f46e5';

  const section = (a) => {
    const k = a.kpis || {};
    const change = k.followers_change;
    const changeHtml = change == null ? '' : `<div class="kpi-change ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${fmtNum(Math.abs(change))} في الفترة</div>`;
    const rate = k.engagement != null && k.reach ? `${((k.engagement / k.reach) * 100).toFixed(1)}%` : null;
    const top = [...(a.posts || [])].sort((x, y) => (y.engagement || 0) - (x.engagement || 0)).slice(0, 5);
    return `
      <section class="card report-acc">
        <div class="acc-head">
          ${a.picture ? `<img src="${esc(a.picture)}" alt="">` : ''}
          ${platformTag(a.platform)} <h2>${esc(a.name)}</h2>
        </div>
        <div class="kpis">
          ${kpi('المتابعين', k.followers, changeHtml)}
          ${kpi('المشاهدات', k.views, k.views_from_posts ? '<div class="kpi-change muted">مجموع المنشورات</div>' : '')}
          ${kpi('الوصول', k.reach, k.reach_from_posts ? '<div class="kpi-change muted">مجموع المنشورات</div>' : '')}
          ${kpi('التفاعل', k.engagement, rate ? `<div class="kpi-change">${rate} من الوصول</div>` : '')}
          ${kpi('المنشورات', k.posts)}
        </div>
        ${barChart(a.daily, a.dailyLabel || 'الأرقام', a.platform === 'instagram' ? '#dd2a7b' : '#1877f2')}
        ${top.length ? `<h3>أحسن ${top.length} منشورات</h3>
          <div class="top-posts">${top.map((p, i) => `
            <a class="top-post" ${p.url ? `href="${esc(p.url)}" target="_blank" rel="noopener"` : ''}>
              <span class="rank">${i + 1}</span>
              ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : '<div class="noimg">📝</div>'}
              <div class="tp-body">
                <div class="tp-text">${esc((p.text || '').slice(0, 90)) || '<span class="muted">(من غير نص)</span>'}</div>
                <div class="tp-meta muted small">
                  ${p.time ? esc(new Date(p.time).toLocaleDateString('ar-EG', { dateStyle: 'medium' })) : ''}
                  ${p.views != null ? ` · 👁 ${fmtNum(p.views)}` : ''} · ❤️ ${fmtNum(p.likes)} · 💬 ${fmtNum(p.comments)}${p.shares ? ` · 🔁 ${fmtNum(p.shares)}` : ''}${p.saved ? ` · 🔖 ${fmtNum(p.saved)}` : ''}
                </div>
              </div>
            </a>`).join('')}</div>` : '<p class="muted small">مفيش منشورات في الفترة دي.</p>'}
      </section>`;
  };

  return `
    <div class="report">
      <div class="report-title">
        <span class="dot" style="background:${esc(color)};width:14px;height:14px"></span>
        <div><h1>تقرير ${esc(r.client.name)}</h1><div class="muted">${esc(period)}</div></div>
      </div>
      <div class="kpis summary">
        ${kpi('إجمالي المتابعين', total('followers'))}
        ${kpi('إجمالي المشاهدات', total('views'))}
        ${kpi('إجمالي الوصول', total('reach'))}
        ${kpi('إجمالي التفاعل', total('engagement'))}
        ${kpi('منشورات اتنشرت من المنصة', r.platform?.published)}
        ${r.platform?.whatsapp ? kpi('حالات واتساب', r.platform.whatsapp) : ''}
      </div>
      ${(r.ads || []).filter((a) => a.totals || a.error).map((a) => `<section class="card report-acc">
        <div class="acc-head">${platformTag('meta_ads')} <h2>${esc(a.name)}</h2></div>
        ${a.error ? `<p class="muted small">${esc(a.error)}</p>` : adsTotalsHtml(a.totals, a.currency)}</section>`).join('')}
      ${accs.length ? accs.map(section).join('') : '<div class="card empty">العميل ده مفيش عنده حسابات فيسبوك أو إنستجرام مربوطة.</div>'}
      ${anyErrors ? `<details class="card no-print report-errors"><summary>⚠️ بعض الأرقام مش ظاهرة، دوس عشان تعرف السبب</summary>
        <p class="small">غالباً الصلاحية <code>read_insights</code> (فيسبوك) أو <code>instagram_manage_insights</code> (إنستجرام) مش متضافة، أو الحساب محتاج يتربط تاني بعد إضافتها. وإنستجرام مش بيدّي عدد المتابعين الجداد للحسابات اللي أقل من 100 متابع.</p>
        ${accs.filter((a) => a.errors?.length).map((a) => `<div class="small"><b>${esc(a.name)}:</b><ul>${a.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`).join('')}
      </details>` : ''}
      <p class="muted small report-foot">اتعمل ${esc(fmtDate(r.generated_at))} · الأرقام من فيسبوك وإنستجرام، وممكن تتأخر لحد يومين.</p>
    </div>`;
}

async function renderReports(main, params) {
  const $ = (sel) => main.querySelector(sel); // this page's own elements only
  const clients = await loadClients();
  if (!clients.length) {
    main.innerHTML = '<div class="page-head"><h1>📊 التقارير</h1></div><div class="card empty">ضيف عميل الأول.</div>';
    return;
  }
  const clientId = params.get('client') || clients[0].id;
  const rangeKey = params.get('range') || '30';
  main.innerHTML = `
    <div class="page-head no-print"><h1>📊 التقارير</h1>
      <div class="report-actions">
        <button class="btn" id="r-refresh" title="هات الأرقام من جديد من فيسبوك وإنستجرام">🔄 تحديث</button>
        <button class="btn" id="r-print">🖨️ طباعة / PDF</button>
        <button class="btn primary" id="r-link">🔗 لينك للعميل</button>
      </div>
    </div>
    <div class="row no-print" style="margin-bottom:16px">
      <div><label for="r-client">العميل</label>
        <select id="r-client">${clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(clientId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div><label for="r-range">الفترة</label>
        <select id="r-range">${RANGES.map(([v, l]) => `<option value="${v}" ${v === rangeKey ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div id="r-body"><div class="boot">بيجمّع الأرقام من فيسبوك وإنستجرام… (أول مرة بتاخد ثواني)</div></div>`;

  const go = () => { location.hash = `#/reports?client=${$('#r-client').value}&range=${$('#r-range').value}`; };
  $('#r-client').onchange = go;
  $('#r-range').onchange = go;
  $('#r-print').onclick = () => window.print();
  const [from, to] = rangeFor(rangeKey);
  const load = async (refresh) => {
    $('#r-body').innerHTML = '<div class="boot">بيجمّع الأرقام من فيسبوك وإنستجرام…</div>';
    try {
      const r = await api(`/reports/${clientId}?from=${from}&to=${to}${refresh ? '&refresh=1' : ''}`);
      $('#r-body').innerHTML = reportHtml(r);
    } catch (err) {
      $('#r-body').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    }
  };
  $('#r-refresh').onclick = () => load(true);
  $('#r-link').onclick = async () => {
    const c = clients.find((x) => String(x.id) === String(clientId));
    const link = await api(`/reports/${clientId}/link`, { method: 'POST' });
    const msg = `أهلاً ${c.name} 👋\nده تقرير صفحاتك، بيتحدث لوحده وتقدر تختار الفترة:\n${link.url}`;
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.innerHTML = `<form method="dialog" class="dlg-body">
      <div class="dlg-head"><b>🔗 لينك التقرير: ${esc(c.name)}</b><button class="btn small dlg-close" value="close">✕</button></div>
      <p style="margin:0">العميل يقدر يفتح التقرير ده في أي وقت ويشوف الأرقام محدّثة، من غير ما يدخل المنصة. <b>للقراية بس</b>، ومش هيقدر يغيّر حاجة.</p>
      <input readonly dir="ltr" value="${esc(link.url)}" onclick="this.select()">
      <div class="dlg-actions">
        <button type="button" class="btn primary small" data-c>📋 انسخ اللينك</button>
        <a class="btn small" style="background:#25d366;border-color:#25d366;color:#fff" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">ابعته واتساب</a>
      </div>
      <div class="muted small">اللينك شغال 3 شهور.</div></form>`;
    document.body.appendChild(dlg);
    dlg.querySelector('[data-c]').onclick = async () => {
      try { await navigator.clipboard.writeText(link.url); toast('اللينك اتنسخ 📋'); } catch { dlg.querySelector('input').select(); }
    };
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  };
  await load(false);
}

// Read-only report opened by a client from a shared link (no login).
async function renderPublicReport(token, params) {
  const rangeKey = params.get('range') || '30';
  app.innerHTML = `<main class="main public-report">
    <div class="row no-print" style="margin-bottom:16px;align-items:end">
      <div><label for="pr-range">الفترة</label>
        <select id="pr-range">${RANGES.map(([v, l]) => `<option value="${v}" ${v === rangeKey ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div style="flex:0"><button class="btn" id="pr-print">🖨️ طباعة / PDF</button></div>
    </div>
    <div id="pr-body"><div class="boot">بيجهّز التقرير…</div></div></main>`;
  $('#pr-range').onchange = () => { location.hash = `#/r/${token}?range=${$('#pr-range').value}`; };
  $('#pr-print').onclick = () => window.print();
  const [from, to] = rangeFor(rangeKey);
  try {
    const res = await fetch(`/api/public/report/${token}?from=${from}&to=${to}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'مش قادر أفتح التقرير');
    $('#pr-body').innerHTML = reportHtml(data);
  } catch (err) {
    $('#pr-body').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}

// ---------- Meta Ads ----------
const OBJECTIVES = {
  OUTCOME_ENGAGEMENT: 'تفاعل', OUTCOME_AWARENESS: 'وعي بالعلامة', OUTCOME_TRAFFIC: 'زيارات', OUTCOME_LEADS: 'عملاء محتملين',
  OUTCOME_SALES: 'مبيعات', OUTCOME_APP_PROMOTION: 'تطبيقات', MESSAGES: 'رسائل', POST_ENGAGEMENT: 'تفاعل', LINK_CLICKS: 'زيارات',
};
const RESULT_LABEL = {
  'onsite_conversion.messaging_conversation_started_7d': 'محادثة', lead: 'عميل محتمل', 'offsite_conversion.fb_pixel_purchase': 'شراء',
  purchase: 'شراء', link_click: 'نقرة', post_engagement: 'تفاعل', page_engagement: 'تفاعل',
};
const money = (v, cur) => (v == null ? '—' : `${Number(v).toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ${cur || ''}`);
const budgetText = (c, cur) => {
  const minorDiv = ['JPY', 'KRW', 'CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'PYG', 'TWD', 'VND'].includes(cur) ? 1 : 100;
  if (c.daily_budget) return `${money(c.daily_budget / minorDiv, cur)} / يوم`;
  if (c.lifetime_budget) return `${money(c.lifetime_budget / minorDiv, cur)} إجمالي`;
  return 'على مستوى المجموعة';
};

function adsTotalsHtml(t, cur) {
  if (!t) return '';
  return `<div class="kpis">
    ${kpi('المصروف', null).replace('—', money(t.spend, cur))}
    ${kpi('الظهور', t.impressions)}
    ${kpi('الوصول', t.reach)}
    ${kpi('النقرات', t.clicks, t.ctr != null ? `<div class="kpi-change">CTR ${Number(t.ctr).toFixed(2)}%</div>` : '')}
    ${kpi('تكلفة النقرة', null).replace('—', money(t.cpc, cur))}
    ${t.result ? kpi(`النتايج (${RESULT_LABEL[t.result.type] || t.result.type})`, t.result.value) : ''}
  </div>`;
}

async function renderAds(main, params) {
  const $ = (sel) => main.querySelector(sel); // this page's own elements only
  const clients = await loadClients();
  if (!clients.length) {
    main.innerHTML = '<div class="page-head"><h1>📢 الإعلانات</h1></div><div class="card empty">ضيف عميل الأول.</div>';
    return;
  }
  const clientId = params.get('client') || clients[0].id;
  const rangeKey = params.get('range') || '30';
  main.innerHTML = `
    <div class="page-head"><h1>📢 الإعلانات</h1>
      <a class="btn" href="https://adsmanager.facebook.com/" target="_blank" rel="noopener">فتح مدير الإعلانات ↗</a></div>
    <div class="row" style="margin-bottom:16px">
      <div><label for="a-client">العميل</label>
        <select id="a-client">${clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(clientId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div><label for="a-range">الفترة</label>
        <select id="a-range">${RANGES.map(([v, l]) => `<option value="${v}" ${v === rangeKey ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div id="a-body"><div class="boot">بيجيب الحملات من Meta…</div></div>`;
  const go = () => { location.hash = `#/ads?client=${$('#a-client').value}&range=${$('#a-range').value}`; };
  $('#a-client').onchange = go;
  $('#a-range').onchange = go;

  const [from, to] = rangeFor(rangeKey);
  let list;
  try {
    list = await api(`/ads/${clientId}?from=${from}&to=${to}`);
  } catch (err) {
    $('#a-body').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    return;
  }
  if (!list.length) {
    $('#a-body').innerHTML = `<div class="card empty">العميل ده مفيش عنده حساب إعلانات مربوط.<br>
      لما تربط فيسبوك (أو العميل يربط من لينك الدعوة)، علّم على <b>حساب الإعلانات</b> في قايمة الاختيار.<br>
      <a class="btn primary small" style="margin-top:10px" href="#/clients">العملاء والحسابات</a></div>`;
    return;
  }
  const statusBadge = (c) => {
    const s = c.effective_status || c.status;
    const map = { ACTIVE: ['شغالة', 'published'], PAUSED: ['متوقفة', ''], CAMPAIGN_PAUSED: ['متوقفة', ''], ARCHIVED: ['مؤرشفة', ''], IN_PROCESS: ['بتتراجع', 'scheduled'], WITH_ISSUES: ['فيها مشكلة', 'failed'] };
    const [l, cls] = map[s] || [s, ''];
    return `<span class="badge ${cls}">${esc(l)}</span>`;
  };
  const statusBtn = (o, accId) => {
    if (o.status === 'ACTIVE') return `<button class="btn small" data-status="${esc(o.id)}" data-acc-id="${accId}" data-to="PAUSED" title="وقّف">⏸</button>`;
    if (o.status === 'PAUSED') return `<button class="btn small primary" data-status="${esc(o.id)}" data-acc-id="${accId}" data-to="ACTIVE" title="شغّل">▶</button>`;
    return '';
  };
  const actions = (o, accId, { budget = true, del = true } = {}) => `<div class="ad-actions">
    ${statusBtn(o, accId)}
    ${budget && (o.daily_budget || o.lifetime_budget) ? `<button class="btn small" data-budget="${esc(o.id)}" data-acc-id="${accId}" data-cur-budget="${esc(budgetText(o, ''))}" title="غيّر الميزانية">💰</button>` : ''}
    ${del ? `<button class="btn small danger" data-status="${esc(o.id)}" data-acc-id="${accId}" data-to="DELETED" title="امسح">🗑</button>` : ''}
  </div>`;
  const statsCells = (o, cur) => `<td>${money(o.spend, cur)}</td><td>${fmtNum(o.impressions)}</td><td>${fmtNum(o.clicks)}</td>
    <td>${o.result ? `${fmtNum(o.result.value)} ${esc(RESULT_LABEL[o.result.type] || '')}` : '—'}</td>`;

  $('#a-body').innerHTML = list.map((a) => `
    <section class="card report-acc" data-acc="${a.id}">
      <div class="acc-head">${platformTag('meta_ads')} <h2>${esc(a.name)}</h2>
        ${a.error ? '' : `<button class="btn primary small" data-new-camp="${a.id}" style="margin-inline-start:auto">➕ حملة جديدة</button>`}</div>
      ${a.error ? `<div class="notice bad">${esc(a.error)}</div>` : `
      ${adsTotalsHtml(a.totals, a.currency)}
      <h3>الحملات (${a.campaigns.length})</h3>
      ${a.campaigns.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>الحملة</th><th>الحالة</th><th>الهدف</th><th>الميزانية</th><th>المصروف</th><th>الظهور</th><th>النقرات</th><th>النتايج</th><th>تحكم</th></tr></thead>
        <tbody>${a.campaigns.map((c) => `<tr>
          <td><button class="linkish" data-details="${esc(c.id)}" data-acc-id="${a.id}" title="المجموعات والإعلانات">▸ <b>${esc(c.name)}</b></button></td>
          <td>${statusBadge(c)}</td>
          <td>${esc(OBJECTIVES[c.objective] || c.objective || '')}</td>
          <td class="small">${esc(budgetText(c, a.currency))}</td>
          ${statsCells(c, a.currency)}
          <td>${actions(c, a.id)}</td>
        </tr><tr class="camp-details" data-for="${esc(c.id)}" hidden><td colspan="9"></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted small">مفيش حملات لسه. دوس <b>➕ حملة جديدة</b> فوق.</p>'}`}
    </section>`).join('');

  const accCurrency = (accId) => list.find((x) => String(x.id) === String(accId))?.currency || '';

  async function loadDetails(row, campId, accId) {
    const cell = row.querySelector('td');
    cell.innerHTML = '<div class="muted small">بيجيب المجموعات والإعلانات…</div>';
    try {
      const d = await api(`/ads/accounts/${accId}/campaigns/${campId}?from=${from}&to=${to}`);
      const cur = accCurrency(accId);
      const gender = (g) => (g?.length === 1 ? (g[0] === 1 ? 'رجالة' : 'ستات') : 'الكل');
      cell.innerHTML = `<div class="camp-inner">
        <b>المجموعات الإعلانية (الجمهور والميزانية)</b>
        <table class="table small"><thead><tr><th>المجموعة</th><th>الحالة</th><th>الجمهور</th><th>الميزانية</th><th>المصروف</th><th>الظهور</th><th>النقرات</th><th>النتايج</th><th>تحكم</th></tr></thead>
        <tbody>${d.adsets.map((s) => `<tr><td>${esc(s.name)}</td><td>${statusBadge(s)}</td>
          <td class="small">${esc(s.audience.countries.join(', ') || '—')} · ${esc(String(s.audience.age_min ?? 18))}-${esc(String(s.audience.age_max ?? 65))} · ${gender(s.audience.genders)}</td>
          <td class="small">${esc(budgetText(s, cur))}</td>${statsCells(s, cur)}<td>${actions(s, accId)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">مفيش</td></tr>'}</tbody></table>
        <b>الإعلانات</b>
        <table class="table small"><thead><tr><th>الإعلان</th><th>الحالة</th><th>المصروف</th><th>الظهور</th><th>النقرات</th><th>النتايج</th><th>تحكم</th></tr></thead>
        <tbody>${d.ads.map((x) => `<tr><td>${x.thumbnail ? `<img class="ad-thumb" src="${esc(x.thumbnail)}" alt="">` : ''} ${esc(x.name)}</td><td>${statusBadge(x)}</td>
          ${statsCells(x, cur)}<td>${actions(x, accId, { budget: false })}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">مفيش</td></tr>'}</tbody></table>
      </div>`;
      wire(cell);
    } catch (err) {
      cell.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    }
  }

  function wire(root) {
    root.querySelectorAll('[data-details]').forEach((b) => {
      b.onclick = () => {
        const row = main.querySelector(`.camp-details[data-for="${b.dataset.details}"]`);
        row.hidden = !row.hidden;
        b.firstChild.textContent = row.hidden ? '▸ ' : '▾ ';
        if (!row.hidden) loadDetails(row, b.dataset.details, b.dataset.accId);
      };
    });
    root.querySelectorAll('[data-status]').forEach((b) => {
      b.onclick = async () => {
        const to = b.dataset.to;
        const msg = {
          ACTIVE: 'هيشتغل ويبدأ يصرف من الميزانية. متأكد؟',
          PAUSED: 'هيقف ومش هيصرف لحد ما تشغّله تاني.',
          DELETED: 'هيتمسح من حساب الإعلانات خالص ومش هينفع ترجّعه (الأرقام القديمة بتفضل في التقارير). متأكد؟',
        }[to];
        const ok = await askConfirm(msg, { ok: { ACTIVE: 'شغّل', PAUSED: 'وقّف', DELETED: 'امسح' }[to] });
        if (!ok) return;
        b.disabled = true;
        try {
          await api(`/ads/objects/${b.dataset.status}/status`, { method: 'POST', body: { account_id: Number(b.dataset.accId), status: to } });
          toast({ ACTIVE: 'اشتغل ▶', PAUSED: 'وقف ⏸', DELETED: 'اتمسح 🗑' }[to]);
          renderAds(main, params);
        } catch (err) {
          toast(err.message);
          b.disabled = false;
        }
      };
    });
    root.querySelectorAll('[data-budget]').forEach((b) => {
      b.onclick = async () => {
        const v = await askText(`الميزانية الجديدة (دلوقتي: ${b.dataset.curBudget}). اكتب الرقم بس بعملة حساب الإعلانات`, 'مثلاً 100');
        if (v == null || v === '') return;
        const amount = Number(String(v).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(',', '.'));
        if (!(amount > 0)) { toast('اكتب رقم صحيح'); return; }
        try {
          await api(`/ads/objects/${b.dataset.budget}/budget`, { method: 'POST', body: { account_id: Number(b.dataset.accId), amount } });
          toast('الميزانية اتغيرت 💰');
          renderAds(main, params);
        } catch (err) {
          toast(err.message);
        }
      };
    });
  }
  wire(main);
  main.querySelectorAll('[data-new-camp]').forEach((b) => {
    b.onclick = () => openNewCampaignDialog(clientId, list.find((x) => String(x.id) === b.dataset.newCamp), () => renderAds(main, params))
      .catch((err) => toast(err.message));
  });
}

// Audience + budget fields shared by "➕ حملة جديدة" and "📢 روّج".
function adFormFields() {
  return `
    <div class="field"><label>الهدف</label><select name="objective">
      <option value="engagement">تفاعل (لايكات وكومنتات وشير)</option>
      <option value="awareness">وصول (يوصل لأكبر عدد ناس)</option></select></div>
    <div class="row">
      <div><label>الميزانية في اليوم</label><input name="budget" type="number" min="1" step="0.5" value="5" required></div>
      <div><label>كام يوم</label><input name="days" type="number" min="1" max="90" value="7" required></div>
    </div>
    <div class="row">
      <div><label>الدول (كود الدولة)</label><input name="countries" value="EG" dir="ltr" placeholder="EG, KW, SA"></div>
      <div><label>السن من</label><input name="age_min" type="number" min="18" max="65" value="18"></div>
      <div><label>لحد</label><input name="age_max" type="number" min="18" max="65" value="65"></div>
      <div><label>النوع</label><select name="genders"><option value="">الكل</option><option value="1">رجالة</option><option value="2">ستات</option></select></div>
    </div>
    <label class="check"><input type="checkbox" name="start_now"> شغّلها على طول (من غير ما تعلّم عليها هتتعمل متوقفة)</label>
    <div class="notice small" style="margin:0">الميزانية بعملة حساب الإعلانات. لو مش معلّم على "شغّلها على طول"، الإعلان مش هيصرف حاجة لحد ما تدوس ▶ من صفحة <b>📢 الإعلانات</b>.</div>`;
}

function adFormValues(f) {
  const v = (n) => f.elements[n].value;
  return {
    objective: v('objective'), daily_budget: Number(v('budget')), days: Number(v('days')), countries: v('countries'),
    age_min: Number(v('age_min')), age_max: Number(v('age_max')), genders: v('genders') ? Number(v('genders')) : null,
    start_now: f.elements.start_now.checked,
  };
}

async function submitAd(dlg, body) {
  const box = dlg.querySelector('#b-err');
  if (body.start_now) {
    const ok = await askConfirm(`الإعلان هيشتغل على طول ويصرف ${body.daily_budget} في اليوم لمدة ${body.days} يوم. متأكد؟`, { ok: 'أيوه شغّله' });
    if (!ok) return false;
  }
  try {
    const r = await api('/ads/boost', { method: 'POST', body });
    dlg.close();
    toast(r.status === 'ACTIVE' ? 'الإعلان اتعمل واشتغل ✅' : 'الإعلان اتعمل ✅ (متوقف). شغّله من صفحة الإعلانات لما تكون جاهز');
    return true;
  } catch (err) {
    box.textContent = err.message;
    box.hidden = false;
    return false;
  }
}

// "➕ حملة جديدة": pick any post from the client's Facebook pages and promote it.
async function openNewCampaignDialog(clientId, adAcc, done) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.innerHTML = `<form method="dialog" class="dlg-body">
    <div class="dlg-head"><b>➕ حملة جديدة: ${esc(adAcc.name)}</b><button class="btn small dlg-close" value="close">✕</button></div>
    <label>اختار المنشور اللي هتروّجه</label>
    <div class="post-pick" id="n-posts"><div class="muted small">بيجيب منشورات الصفحة…</div></div>
    <div class="field"><label>اسم الحملة (اختياري)</label><input name="name" placeholder="مثلاً عرض الصيف"></div>
    ${adFormFields()}
    <div id="b-err" class="notice bad" hidden></div>
    <div class="dlg-actions"><button type="button" class="btn primary" data-go disabled>اعمل الحملة</button></div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();

  let picked = null;
  const posts = await api(`/ads/${clientId}/page-posts`);
  const box = dlg.querySelector('#n-posts');
  const ok = posts.filter((p) => !p.error);
  const errs = posts.filter((p) => p.error);
  box.innerHTML = (ok.length ? ok.map((p, i) => `
    <button type="button" class="pick-post" data-i="${i}">
      ${p.image ? `<img src="${esc(p.image)}" alt="">` : '<span class="pick-noimg">📝</span>'}
      <span class="small"><b>${esc(p.page_name)}</b> · ${esc(new Date(p.time).toLocaleDateString('ar-EG'))}<br>${esc((p.text || '(من غير كلام)').slice(0, 90))}</span>
    </button>`).join('') : '<div class="notice">مالقيناش منشورات على صفحات فيسبوك بتاعة العميل ده.</div>')
    + errs.map((p) => `<div class="notice bad small">${esc(p.page_name)}: ${esc(p.error)}</div>`).join('');
  box.querySelectorAll('.pick-post').forEach((b) => {
    b.onclick = () => {
      box.querySelectorAll('.pick-post').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      picked = ok[Number(b.dataset.i)];
      dlg.querySelector('[data-go]').disabled = false;
    };
  });
  dlg.querySelector('[data-go]').addEventListener('click', async (e) => {
    if (!picked) return;
    const f = dlg.querySelector('form');
    e.target.disabled = true;
    const name = f.elements.name.value.trim() || `ترويج: ${(picked.text || 'منشور').slice(0, 40)}`;
    const done2 = await submitAd(dlg, { account_id: adAcc.id, page_account_id: picked.page_account_id, page_post_id: picked.id, name, ...adFormValues(f) });
    if (done2) done();
    else e.target.disabled = false;
  });
}

// "📢 روّج": promote a published Facebook post. Created paused; you turn it on from the ads page.
async function openBoostDialog(post) {
  const fbTarget = post.targets.find((t) => t.platform === 'facebook' && t.status === 'published');
  const adAccounts = (await api(`/accounts?client_id=${post.client_id}`)).filter((a) => a.platform === 'meta_ads');
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.innerHTML = `<form method="dialog" class="dlg-body">
    <div class="dlg-head"><b>📢 روّج المنشور ده</b><button class="btn small dlg-close" value="close">✕</button></div>
    <div class="dlg-text muted small">${esc((post.message || '').slice(0, 140))}</div>
    ${!adAccounts.length ? `<div class="notice">العميل ده مفيش عنده حساب إعلانات مربوط. اربط فيسبوك تاني وعلّم على حساب الإعلانات.</div>` : `
    <div class="field"><label>حساب الإعلانات</label><select name="acc">${adAccounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
    ${adFormFields()}
    <div id="b-err" class="notice bad" hidden></div>
    <div class="dlg-actions"><button type="button" class="btn primary" data-go>اعمل الإعلان</button></div>`}
  </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelector('[data-go]')?.addEventListener('click', async (e) => {
    const f = dlg.querySelector('form');
    e.target.disabled = true;
    const ok = await submitAd(dlg, { account_id: Number(f.elements.acc.value), post_target_id: fbTarget.id, name: `ترويج: ${(post.message || 'منشور').slice(0, 40)}`, ...adFormValues(f) });
    if (!ok) e.target.disabled = false;
  });
  dlg.showModal();
}

// ---------- calendar ----------
let calMonth = null;
const EDITABLE = ['draft', 'scheduled', 'failed', 'partial'];
const postTime = (p) => p.scheduled_at || p.created_at;
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' });
// Same clock time on another day.
const atDay = (dateStr, fromMs) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const f = new Date(fromMs);
  return new Date(y, m - 1, d, f.getHours(), f.getMinutes()).getTime();
};

async function renderCalendar(main) {
  const $ = (sel) => main.querySelector(sel); // this page's own elements only
  const today = new Date();
  if (!calMonth) calMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const year = calMonth.getFullYear();
  const month = calMonth.getMonth();

  // Week starts on Saturday (common in Egypt).
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 1) % 7;
  const start = new Date(year, month, 1 - offset);
  const end = new Date(start);
  end.setDate(start.getDate() + 42);

  const posts = await api(`/posts?from=${start.getTime()}&to=${end.getTime()}`);
  const byId = new Map(posts.map((p) => [String(p.id), p]));
  const byDay = {};
  for (const p of posts) (byDay[new Date(postTime(p)).toDateString()] ||= []).push(p);

  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const list = (byDay[d.toDateString()] || []).sort((a, b) => postTime(a) - postTime(b));
    days.push(`
      <div class="day ${d.getMonth() !== month ? 'out' : ''} ${d.toDateString() === today.toDateString() ? 'today' : ''}" data-date="${toDateInput(d)}">
        <div class="num">${d.getDate()}<span class="add" title="منشور جديد في اليوم ده">+</span></div>
        ${list.map((p) => `
          <div class="chip status-${esc(p.status)}" draggable="true" data-id="${p.id}" style="--c:${esc(p.client_color)}"
               title="${esc(p.client_name)} — ${esc(STATUS[p.status])}\n${esc(p.message)}">
            <button type="button" class="chip-del" title="شيل من التقويم">✕</button>
            <span class="chip-time">${p.series_id ? '🔁 ' : ''}${fmtTime(postTime(p))}</span>
            <span class="chip-text">${mediaIcon(p)}${esc(p.message.slice(0, 40) || (mediaIcon(p) ? '' : '📷 صورة'))}</span>
          </div>`).join('')}
      </div>`);
  }

  const weekdays = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];
  // Phones: the month as a list of days (only days of this month that have posts, plus today).
  const agendaDays = [];
  for (let d = new Date(year, month, 1); d.getMonth() === month; d.setDate(d.getDate() + 1)) {
    const list = (byDay[d.toDateString()] || []).sort((a, b) => postTime(a) - postTime(b));
    const isToday = d.toDateString() === today.toDateString();
    if (list.length || isToday) agendaDays.push({ date: new Date(d), list, isToday });
  }
  const agendaHtml = agendaDays.length ? agendaDays.map(({ date, list, isToday }) => `
    <section class="ag-day ${isToday ? 'today' : ''}">
      <div class="ag-head"><b>${esc(date.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' }))}</b>${isToday ? ' <span class="badge scheduled">النهارده</span>' : ''}
        <a class="btn small" href="#/compose?date=${toDateInput(date)}">+ منشور</a></div>
      ${list.length ? list.map((p) => `
        <button type="button" class="ag-item" data-ag="${p.id}" style="--c:${esc(p.client_color)}">
          <span class="ag-time">${p.series_id ? '🔁 ' : ''}${fmtTime(postTime(p))}</span>
          <span class="ag-body"><b>${esc(p.client_name)}</b> ${badge(p.status)}<br><span class="muted small">${mediaIcon(p)}${esc(p.message.slice(0, 70) || '📷')}</span></span>
        </button>`).join('') : '<div class="muted small" style="padding:6px 0">مفيش منشورات</div>'}
    </section>`).join('') : '<div class="card empty">مفيش منشورات الشهر ده.</div>';
  main.innerHTML = `
    <div class="page-head">
      <h1>${first.toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' })}</h1>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="prev">→ الشهر اللي فات</button>
        <button class="btn" id="this">النهارده</button>
        <button class="btn" id="next">الشهر الجاي ←</button>
      </div>
    </div>
    <div class="muted small cal-tips">
      دوس على منشور عشان تعدّله أو تنسخه · اسحب منشور لأي يوم عشان تنقله · اسحب وإنت ضاغط <b>Ctrl</b> عشان تعمل نسخة · <b>✕</b> على المنشور تشيله · دوس على <b>+</b> في أي يوم لمنشور جديد · لو غلطت دوس <b>تراجع</b> في الرسالة اللي تحت
    </div>
    <div class="cal-head">${weekdays.map((w) => `<div>${w}</div>`).join('')}</div>
    <div class="cal">${days.join('')}</div>
    <div class="cal-agenda">${agendaHtml}</div>
    <dialog id="post-dialog" class="dialog"></dialog>`;

  const reload = () => renderCalendar(main);
  refreshWhilePublishing(main, posts, reload);
  main.querySelectorAll('[data-ag]').forEach((b) => { b.onclick = () => openPostDialog(byId.get(b.dataset.ag), reload); });
  $('#prev').onclick = () => { calMonth = new Date(year, month - 1, 1); reload(); };
  $('#next').onclick = () => { calMonth = new Date(year, month + 1, 1); reload(); };
  $('#this').onclick = () => { calMonth = null; reload(); };

  // Click a post -> popup. Click "+" on a day -> new post on that day.
  main.querySelector('.cal').addEventListener('click', async (e) => {
    const del = e.target.closest('.chip-del');
    if (del) {
      const p = byId.get(del.closest('.chip').dataset.id);
      const msg = p.status === 'published'
        ? 'تشيل المنشور ده من التقويم؟ (هيفضل موجود على فيسبوك وإنستجرام، ده بيمسحه من المنصة بس)'
        : `تشيل منشور ${fmtTime(postTime(p))} من التقويم؟ مش هيتنشر.`;
      if (!(await askConfirm(msg, { ok: 'شيله' }))) return;
      try {
        await api(`/posts/${p.id}`, { method: 'DELETE' });
        toast('اتشال من التقويم');
        reload();
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    const chip = e.target.closest('.chip');
    if (chip) return openPostDialog(byId.get(chip.dataset.id), reload);
    if (e.target.closest('.add')) location.hash = `#/compose?date=${e.target.closest('.day').dataset.date}`;
  });

  // Drag a post to another day: move it, or copy it when Ctrl/Alt is held.
  // Past days can't take a drop; today after the post's hour uses "in 15 minutes".
  const todayStr = toDateInput(new Date());
  const isPastDay = (dateStr) => dateStr < todayStr;
  let dragged = null;
  const endDrag = () => {
    dragged = null;
    main.querySelector('.cal').classList.remove('dragging-on');
    main.querySelectorAll('.drop-target').forEach((d) => d.classList.remove('drop-target'));
  };
  main.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('dragstart', (e) => {
      dragged = byId.get(chip.dataset.id);
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', chip.dataset.id);
      chip.classList.add('dragging');
      main.querySelector('.cal').classList.add('dragging-on');
    });
    chip.addEventListener('dragend', () => { chip.classList.remove('dragging'); endDrag(); });
  });
  main.querySelectorAll('.day').forEach((day) => {
    if (isPastDay(day.dataset.date)) day.classList.add('past');
    day.addEventListener('dragover', (e) => {
      if (!dragged || isPastDay(day.dataset.date)) return; // no preventDefault = drop not allowed
      e.preventDefault();
      e.dataTransfer.dropEffect = e.ctrlKey || e.altKey || e.metaKey || !EDITABLE.includes(dragged.status) ? 'copy' : 'move';
      day.classList.add('drop-target');
    });
    day.addEventListener('dragleave', (e) => {
      if (!day.contains(e.relatedTarget)) day.classList.remove('drop-target');
    });
    day.addEventListener('drop', async (e) => {
      e.preventDefault();
      const p = dragged;
      endDrag();
      if (!p) return;
      if (isPastDay(day.dataset.date)) return toast('اليوم ده فات. اسحب المنشور لليوم النهارده أو يوم جاي.');
      let copy = e.ctrlKey || e.altKey || e.metaKey;
      // A published post can't move, so dragging it makes a copy.
      if (!EDITABLE.includes(p.status)) copy = true;
      let at = atDay(day.dataset.date, postTime(p));
      const sameDay = new Date(postTime(p)).toDateString() === new Date(at).toDateString();
      if (!copy && sameDay) return;
      let note = '';
      if (at < Date.now() + 5 * 60 * 1000) {
        // Today, but that hour already passed: schedule it 15 minutes from now (rounded to 5).
        at = Math.ceil((Date.now() + 15 * 60 * 1000) / 300000) * 300000;
        note = ' (الساعة الأصلية فاتت النهارده، فاتحط بعد ربع ساعة. تقدر تغيّره من المنشور)';
      }
      try {
        const res = await api(`/posts/${p.id}/${copy ? 'duplicate' : 'move'}`, { method: 'POST', body: { scheduled_at: at } });
        toast((copy ? `اتعملت نسخة يوم ${fmtDate(at)}` : `اتنقل لـ ${fmtDate(at)}`) + note, { undo: undoFor(p, res, copy, reload) });
        reload();
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

// Undo for a calendar action: delete the copy, or put a moved post back where it was.
function undoFor(original, result, wasCopy, reload) {
  return async () => {
    if (wasCopy) await api(`/posts/${result.id}`, { method: 'DELETE' });
    else await api(`/posts/${original.id}/move`, { method: 'POST', body: { scheduled_at: postTime(original), undo_status: original.status } });
    reload();
  };
}

// Popup with everything you can do to one post without leaving the calendar.
function openPostDialog(p, reload) {
  const dlg = $('#post-dialog');
  const editable = EDITABLE.includes(p.status);
  const when = postTime(p);
  const base = Math.max(when, Date.now() + 15 * 60 * 1000);
  const targets = p.targets.map((t) => `
    <div>${platformTag(t.platform)} ${esc(t.name)} ${t.status !== 'pending' ? badge(t.status) : ''}
      ${t.error ? `<div class="target-error">${esc(t.error)}</div>` : ''}</div>`).join('');

  dlg.innerHTML = `
    <form method="dialog" class="dlg-body">
      <div class="dlg-head">
        <span class="dot" style="background:${esc(p.client_color)}"></span><b>${esc(p.client_name)}</b>
        ${badge(p.status)} ${p.series_id ? '<span class="badge">🔁 متكرر</span>' : ''}
        <button class="btn small dlg-close" value="close" title="قفل">✕</button>
      </div>
      <div class="dlg-when">🕒 ${esc(fmtDate(when))}</div>
      <div class="dlg-content">
        ${dialogMedia(p)}
        <div class="dlg-text">${esc(p.message) || '<span class="muted">(صورة بدون نص)</span>'}</div>
      </div>
      <div class="meta" style="display:grid;gap:4px">${targets}</div>

      ${editable ? `
      <div class="dlg-section">
        <label for="dlg-move">🕒 تغيير الميعاد</label>
        <div class="time-row">
          <input id="dlg-move" type="datetime-local" value="${toLocalInput(when > Date.now() ? when : base)}">
          <button type="button" class="btn primary small" data-do="move">حفظ الميعاد</button>
        </div>
      </div>` : ''}

      <div class="dlg-section">
        <label for="dlg-copy">📋 نسخ لميعاد تاني</label>
        <div class="quick">
          <button type="button" class="btn small" data-plus="1">+ يوم</button>
          <button type="button" class="btn small" data-plus="7">+ أسبوع</button>
          <button type="button" class="btn small" data-plus="month">+ شهر</button>
        </div>
        <div class="time-row">
          <input id="dlg-copy" type="datetime-local" value="${toLocalInput(when + 86400000 > Date.now() ? when + 86400000 : base + 86400000)}">
          <button type="button" class="btn primary small" data-do="copy">انسخ</button>
        </div>
      </div>

      <div id="dlg-err" class="notice bad" hidden></div>
      <div class="dlg-actions">
        ${editable ? `<a class="btn small" href="#/compose?edit=${p.id}">✏️ تعديل كامل</a>` : ''}
        <a class="btn small" href="#/compose?copy=${p.id}">🔁 نسخ وتكرار</a>
        ${editable ? '<button type="button" class="btn small" data-do="publish">انشر دلوقتي</button>' : ''}
        <button type="button" class="btn small danger" data-do="delete">حذف</button>
      </div>
    </form>`;

  const err = dlg.querySelector('#dlg-err');
  const run = async (fn) => {
    err.hidden = true;
    try {
      await fn();
      dlg.close();
      reload();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  };
  const copyInput = dlg.querySelector('#dlg-copy');
  dlg.querySelectorAll('[data-plus]').forEach((b) => {
    b.onclick = () => {
      const d = new Date(when);
      if (b.dataset.plus === 'month') d.setMonth(d.getMonth() + 1);
      else d.setDate(d.getDate() + Number(b.dataset.plus));
      copyInput.value = toLocalInput(d.getTime());
    };
  });
  dlg.querySelectorAll('[data-do]').forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.do;
      if (act === 'move') {
        return run(async () => {
          const at = new Date(dlg.querySelector('#dlg-move').value).getTime();
          const res = await api(`/posts/${p.id}/move`, { method: 'POST', body: { scheduled_at: at } });
          toast(`الميعاد اتغير لـ ${fmtDate(at)}`, { undo: undoFor(p, res, false, reload) });
        });
      }
      if (act === 'copy') {
        return run(async () => {
          const at = new Date(copyInput.value).getTime();
          const res = await api(`/posts/${p.id}/duplicate`, { method: 'POST', body: { scheduled_at: at } });
          toast(`اتعملت نسخة يوم ${fmtDate(at)}`, { undo: undoFor(p, res, true, reload) });
        });
      }
      if (act === 'publish') {
        b.disabled = true;
        b.textContent = 'جاري النشر…';
        return run(async () => {
          const r = await api(`/posts/${p.id}/publish`, { method: 'POST' });
          toast(publishMsg(r.status));
        });
      }
      if (act === 'delete') {
        if (!(await askConfirm('تحذف المنشور ده من المنصة؟ (مش هيتمسح من فيسبوك أو إنستجرام لو كان اتنشر)'))) return;
        return run(async () => {
          await api(`/posts/${p.id}`, { method: 'DELETE' });
          toast('اتحذف');
        });
      }
    };
  });
  dlg.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => dlg.close()));
  dlg.showModal();
}

// ---------- posts ----------
// ---------- posts list: tabs + filters, grouped by day ----------
const POST_TABS = [
  ['upcoming', '🕒 الجاية'],
  ['attention', '⚠️ محتاجة تدخّل'],
  ['done', '✅ اتنشرت'],
  ['drafts', '📝 مسودات'],
  ['all', 'الكل'],
];
const POST_PERIODS = [['', 'أي وقت'], ['today', 'النهارده'], ['tomorrow', 'بكرة'], ['week', 'الأسبوع ده'], ['month', 'الشهر ده'], ['custom', 'من … لحد …']];

function periodRange(key, fromStr, toStr) {
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const D = 86400000;
  if (key === 'today') return [day0, day0 + D];
  if (key === 'tomorrow') return [day0 + D, day0 + 2 * D];
  if (key === 'week') return [day0 - 6 * D, day0 + 7 * D];
  if (key === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()];
  if (key === 'custom') {
    const f = fromStr ? new Date(fromStr + 'T00:00').getTime() : null;
    const t = toStr ? new Date(toStr + 'T00:00').getTime() + D : null;
    return [f, t];
  }
  return [null, null];
}

// "بعد ساعتين" / "من 3 أيام"
function relTime(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  let s;
  if (m < 1) s = 'دلوقتي';
  else if (m < 60) s = `${m} دقيقة`;
  else if (m < 60 * 24) s = `${Math.round(m / 60)} ساعة`;
  else s = `${Math.round(m / 1440)} يوم`;
  if (s === 'دلوقتي') return s;
  return diff > 0 ? `بعد ${s}` : `من ${s}`;
}

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((d0 - t0) / 86400000);
  const name = d.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
  if (diff === 0) return `النهارده · ${name}`;
  if (diff === 1) return `بكرة · ${name}`;
  if (diff === -1) return `امبارح · ${name}`;
  return name;
}

async function renderPosts(main, params) {
  const $ = (sel) => main.querySelector(sel); // this page's own elements only
  const clients = await loadClients();
  const get = (k) => params.get(k) || '';
  const tab = POST_TABS.some(([k]) => k === get('tab')) ? get('tab') : 'upcoming';
  const clientId = get('client');
  const platform = get('platform');
  const period = get('period');
  const text = get('q');
  const [from, to] = periodRange(period, get('from'), get('to'));

  const filters = new URLSearchParams();
  if (clientId) filters.set('client_id', clientId);
  if (platform) filters.set('platform', platform);
  if (text) filters.set('q', text);
  if (from) filters.set('from', from);
  if (to) filters.set('to', to);
  const listQ = new URLSearchParams(filters);
  if (tab !== 'all') listQ.set('tab', tab);
  const [posts, counts] = await Promise.all([api(`/posts?${listQ}`), api(`/posts/counts?${filters}`)]);

  const platforms = ['facebook', 'instagram', 'whatsapp', 'youtube', 'tiktok', 'linkedin'];
  const groups = [];
  for (const p of posts) {
    const at = postTime(p);
    const key = new Date(at).toDateString();
    if (!groups.length || groups.at(-1).key !== key) groups.push({ key, at, items: [] });
    groups.at(-1).items.push(p);
  }
  const anyFilter = clientId || platform || period || text;

  main.innerHTML = `
    <div class="page-head"><h1>المنشورات</h1><a class="btn primary" href="#/compose">+ منشور جديد</a></div>
    <div class="post-tabs" role="tablist">${POST_TABS.map(([k, l]) => `
      <button class="post-tab ${k === tab ? 'on' : ''} ${k === 'attention' && counts.attention ? 'warn' : ''}" data-tab="${k}" role="tab" aria-selected="${k === tab}">
        ${l} <span class="count">${fmtNum(counts[k] || 0)}</span></button>`).join('')}</div>
    <details class="pf-wrap" ${anyFilter || window.innerWidth > 700 ? 'open' : ''}><summary class="btn small">🔎 فلترة${anyFilter ? ' (شغالة)' : ''}</summary>
    <form class="card post-filters" id="pf">
      <div><label for="f-client">العميل</label>
        <select id="f-client"><option value="">كل العملاء</option>${clients.map((c) => `<option value="${c.id}" ${String(c.id) === clientId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div><label for="f-platform">المنصة</label>
        <select id="f-platform"><option value="">كل المنصات</option>${platforms.map((pl) => `<option value="${pl}" ${pl === platform ? 'selected' : ''}>${esc(PLATFORM[pl])}</option>`).join('')}</select></div>
      <div><label for="f-period">الوقت</label>
        <select id="f-period">${POST_PERIODS.map(([k, l]) => `<option value="${k}" ${k === period ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="pf-custom" ${period === 'custom' ? '' : 'hidden'}><label for="f-from">من</label><input id="f-from" type="date" value="${esc(get('from'))}"></div>
      <div class="pf-custom" ${period === 'custom' ? '' : 'hidden'}><label for="f-to">لحد</label><input id="f-to" type="date" value="${esc(get('to'))}"></div>
      <div class="pf-search"><label for="f-q">بحث في الكلام</label><input id="f-q" type="search" value="${esc(text)}" placeholder="كلمة من المنشور"></div>
      ${anyFilter ? '<div style="flex:0"><button type="button" class="btn small" id="f-clear">✕ شيل الفلاتر</button></div>' : ''}
    </form></details>
    ${posts.length ? groups.map((g) => `
      <section class="day-group">
        <h3 class="day-head">${esc(dayLabel(g.at))} <span class="muted small">(${g.items.length})</span></h3>
        <div class="card">${g.items.map((p) => postRow(p, { timeFirst: true })).join('')}</div>
      </section>`).join('')
      : `<div class="card empty">${{
        upcoming: 'مفيش منشورات جاية. <a href="#/compose">اعمل منشور جديد</a>',
        attention: 'كله تمام 👌 مفيش حاجة فشلت ولا مستنية منك حاجة.',
        done: 'لسه مفيش منشورات اتنشرت في الفترة دي.',
        drafts: 'مفيش مسودات.',
        all: 'مفيش منشورات.',
      }[tab]}</div>`}
    ${posts.length >= 500 ? '<p class="muted small">بيظهر أول 500 بس. استخدم الفلاتر عشان تضيّق.</p>' : ''}`;

  const go = (changes) => {
    const nq = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) { if (v) nq.set(k, v); else nq.delete(k); }
    location.hash = '#/posts' + (nq.toString() ? '?' + nq : '');
  };
  main.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => go({ tab: b.dataset.tab === 'upcoming' ? '' : b.dataset.tab }); });
  $('#f-client').onchange = () => go({ client: $('#f-client').value });
  $('#f-platform').onchange = () => go({ platform: $('#f-platform').value });
  $('#f-period').onchange = () => {
    const v = $('#f-period').value;
    if (v === 'custom') { main.querySelectorAll('.pf-custom').forEach((el) => { el.hidden = false; }); return; }
    go({ period: v, from: '', to: '' });
  };
  const applyCustom = () => { if ($('#f-from').value || $('#f-to').value) go({ period: 'custom', from: $('#f-from').value, to: $('#f-to').value }); };
  $('#f-from').onchange = applyCustom;
  $('#f-to').onchange = applyCustom;
  $('#pf').onsubmit = (e) => { e.preventDefault(); go({ q: $('#f-q').value.trim() }); };
  $('#f-q').addEventListener('search', () => go({ q: $('#f-q').value.trim() }));
  $('#f-clear')?.addEventListener('click', () => go({ client: '', platform: '', period: '', from: '', to: '', q: '' }));
  bindPostActions(main, () => renderPosts(main, params));
  refreshWhilePublishing(main, posts, () => renderPosts(main, params));
}

router();
