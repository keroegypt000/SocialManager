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
const PLATFORM = { facebook: 'فيسبوك', instagram: 'إنستجرام', whatsapp: 'حالة واتساب' };

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
      <div style="font-weight:600;line-height:1.8">${esc(message)}</div>
      <div class="dlg-actions" style="border:0;padding:0">
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
    <div class="dlg-actions" style="border:0;padding:0">
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
function askText(message, placeholder = '') {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog confirm-dialog';
    dlg.innerHTML = `<form method="dialog" class="dlg-body">
      <label style="font-weight:600;line-height:1.8">${esc(message)}</label>
      <input name="v" placeholder="${esc(placeholder)}" autofocus>
      <div class="dlg-actions" style="border:0;padding:0">
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
};

let me = null;

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, query = ''] = hash.split('?');
  return { name: routes[name] ? name : 'dashboard', params: new URLSearchParams(query) };
}

async function router() {
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
  const main = $('#main');
  main.innerHTML = '<div class="boot">جاري التحميل…</div>';
  try {
    await routes[name](main, params);
  } catch (err) {
    main.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', router);

function shell(active) {
  if (!$('#main')) {
    app.innerHTML = `
      <div class="layout">
        <aside class="sidebar">
          <div class="brand">Social <span>Manager</span></div>
          <nav class="nav">
            <a href="#/dashboard" data-r="dashboard">لوحة التحكم</a>
            <a href="#/compose" data-r="compose">منشور جديد</a>
            <a href="#/calendar" data-r="calendar">التقويم</a>
            <a href="#/posts" data-r="posts">المنشورات</a>
            <a href="#/whatsapp" data-r="whatsapp">📱 حالات واتساب <span class="nav-badge" id="wa-badge" hidden></span></a>
            <a href="#/clients" data-r="clients">العملاء والحسابات</a>
          </nav>
          <div class="spacer"></div>
          <button class="btn small" id="logout">تسجيل الخروج</button>
        </aside>
        <main class="main" id="main"></main>
      </div>`;
    $('#logout').onclick = async () => {
      await api('/logout', { method: 'POST' });
      me = null;
      renderLogin();
    };
  }
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === active));
}

// ---------- login ----------
function renderLogin() {
  me = null;
  app.innerHTML = `
    <div class="login">
      <form class="card" id="login-form">
        <div class="brand" style="text-align:center">Social <span>Manager</span></div>
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
      await api('/login', { method: 'POST', body: { password: $('#pw').value } });
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
  publishing: 'اتبعت ✅ إنستجرام بيجهّز الفيديو، وهينزل لوحده خلال دقايق',
  manual: 'اتنشر ✅ وحالة الواتساب جاهزة: افتح "حالات واتساب" من الموبايل وانشرها بلمسة',
}[status] || 'فيه حسابات ماتنشرش عليها، شوف السبب تحت المنشور');

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

function postRow(p, { actions = true } = {}) {
  const when = p.scheduled_at ? fmtDate(p.scheduled_at) : fmtDate(p.created_at);
  const targets = p.targets.map((t) => `
    <span>${platformTag(t.platform)} ${esc(t.name)} ${t.status !== 'pending' ? badge(t.status) : ''}</span>
    ${t.error ? `<div class="target-error" style="width:100%">${esc(t.name)}: ${esc(t.error)}</div>` : ''}`).join('');
  const editable = ['draft', 'scheduled', 'failed', 'partial'].includes(p.status);
  return `
    <div class="post" data-id="${p.id}" data-series="${esc(p.series_id || '')}">
      ${thumbHtml(p)}
      <div class="body">
        <div class="meta" style="margin:0 0 4px">
          <span class="dot" style="background:${esc(p.client_color)}"></span><b>${esc(p.client_name)}</b>
          ${badge(p.status)} <span>${esc(when)}</span>
          ${p.series_id ? '<span class="badge" title="جزء من سلسلة متكررة">🔁 متكرر</span>' : ''}
        </div>
        <div class="text">${esc(p.message) || '<span class="muted">(صورة بدون نص)</span>'}</div>
        <div class="meta">${targets}</div>
      </div>
      ${actions ? `<div class="actions">
        ${editable ? `<button class="btn small" data-act="publish">${p.status === 'failed' || p.status === 'partial' ? 'إعادة المحاولة' : 'انشر دلوقتي'}</button>` : ''}
        ${editable ? `<a class="btn small" href="#/compose?edit=${p.id}">تعديل</a>` : ''}
        <a class="btn small" href="#/compose?copy=${p.id}" title="انسخ المنشور لميعاد أو مواعيد تانية">نسخ / تكرار</a>
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
  const s = await api('/stats');
  main.innerHTML = `
    <div class="page-head"><h1>لوحة التحكم</h1><a class="btn primary" href="#/compose">+ منشور جديد</a></div>
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
}

// ---------- clients ----------
async function renderClients(main, params) {
  const [clients, accounts] = await Promise.all([loadClients(), api('/accounts')]);
  let notice = '';
  if (params.get('connected')) notice = `<div class="notice ok">اتربط ${esc(params.get('connected'))} حساب بنجاح.</div>`;
  if (params.get('connected') === '0') notice = `<div class="notice">الربط تم بس مالقيناش صفحات. اتأكد إنك اخترت الصفحات في شاشة فيسبوك، وإنك أدمن عليها.</div>`;
  if (params.get('error')) notice = `<div class="notice bad">${esc(params.get('error'))}</div>`;

  main.innerHTML = `
    <div class="page-head"><h1>العملاء والحسابات</h1></div>
    ${notice}
    ${!me.metaConfigured ? `<div class="notice">علشان تربط فيسبوك وإنستجرام لازم تضيف بيانات تطبيق Meta في Cloudflare. رابط الـ Redirect اللي هتحطه في إعدادات تطبيق Meta هو:<br><code>${esc(me.redirectUri)}</code></div>` : ''}
    <form class="card" id="new-client" style="margin-bottom:16px">
      <h2>عميل جديد</h2>
      <div class="row">
        <div><label for="c-name">اسم العميل</label><input id="c-name" required placeholder="مثلاً: مطعم الشيف"></div>
        <div style="max-width:90px;min-width:70px"><label for="c-color">اللون</label><input id="c-color" type="color" value="#4f46e5"></div>
        <div style="flex:0"><button class="btn primary">إضافة</button></div>
      </div>
    </form>
    <div class="grid clients">
      ${clients.length ? clients.map((c) => clientCard(c, accounts.filter((a) => a.client_id === c.id), clients)).join('') : '<div class="card empty">لسه مفيش عملاء</div>'}
    </div>
    <p class="muted small" style="margin-top:16px">ملحوظة: إنستجرام بيظهر هنا بس لو حساب Business أو Creator ومربوط بصفحة فيسبوك.</p>`;

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
        <button class="btn small danger" data-del-client="${c.id}">حذف</button>
      </div>
      ${accounts.map((a) => `
        <div class="account">
          ${a.picture ? `<img src="${esc(a.picture)}" alt="">` : '<img alt="">'}
          <span class="name">${esc(a.name)}</span>
          ${platformTag(a.platform)}
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
        <button class="btn small" data-invite="${c.id}" data-name="${esc(c.name)}" title="ابعت اللينك للعميل يربط صفحاته بنفسه">🔗 لينك دعوة</button>
        <button class="btn small" data-add-wa="${c.id}">+ حالة واتساب</button>
        <a class="btn small" href="#/compose?client=${c.id}">منشور جديد</a>
      </div>
    </div>`;
}

// ---------- connect: pick which pages belong to the client ----------
async function renderConnect(main, params) {
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
      </div>
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
    const chips = [['all', `🌐 الكل (${accounts.length})`], ...Object.keys(PLATFORM).map((p) => [p, `${PLATFORM[p]} (${count(p)})`])];
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
    } else if (platformChoice === 'facebook' || platformChoice === 'instagram') {
      box.innerHTML = `<div class="notice">العميل ده لسه مش مربوط بـ${PLATFORM[platformChoice]}.
        ${me.metaConfigured ? `<a class="btn small primary" href="/auth/meta/start?client_id=${clientSel.value}">ربط فيسبوك وإنستجرام</a>` : ''}</div>`;
    } else {
      box.innerHTML = `<span class="muted small">العميل ده مفيش عنده حسابات مربوطة. <a href="#/clients">اربط حساباته</a></span>`;
    }
  };

  async function loadAccounts() {
    $('#p-accounts').innerHTML = '<span class="muted small">جاري التحميل…</span>';
    accounts = await api(`/accounts?client_id=${clientSel.value}`);
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
  const [data, push] = await Promise.all([api('/whatsapp/queue'), pushStatus().catch(() => 'unsupported')]);
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

  main.innerHTML = `
    <div class="page-head"><h1>📱 حالات واتساب</h1><a class="btn primary" href="#/compose?platform=whatsapp">+ حالة جديدة</a></div>
    ${pushBox}
    ${!shareOk ? '<div class="notice">💡 عشان تنشر بلمسة واحدة، افتح الصفحة دي من <b>الموبايل</b> اللي عليه واتساب. من الكمبيوتر تقدر تحمّل الصورة وتنسخ الكلام.</div>' : ''}
    <h2>جاهزة للنشر ${data.ready.length ? `(${data.ready.length})` : ''}</h2>
    <div class="grid wa-grid">${data.ready.length ? data.ready.map(card).join('') : '<div class="card empty">مفيش حالات مستنياك دلوقتي 👌</div>'}</div>
    <h2 style="margin-top:24px">الجاية (الأسبوع ده)</h2>
    <div class="card">${data.upcoming.length ? data.upcoming.map((it) => `
      <div class="post"><div class="body">
        <div class="meta" style="margin:0"><span class="dot" style="background:${esc(it.client_color)}"></span><b>${esc(it.client_name)}</b> · ${esc(fmtDate(it.scheduled_at))} ${mediaIcon(it)}</div>
        <div class="text">${esc(it.message) || '<span class="muted">(صورة بدون نص)</span>'}</div>
      </div></div>`).join('') : '<div class="empty">مفيش حالات مجدولة الأسبوع ده. ضيف حساب "حالة واتساب" للعميل من صفحة العملاء، واختاره في منشور جديد.</div>'}</div>`;

  const reload = () => { renderWhatsApp(main); updateWaBadge(); };
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
    <dialog id="post-dialog" class="dialog"></dialog>`;

  const reload = () => renderCalendar(main);
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
async function renderPosts(main, params) {
  const clients = await loadClients();
  const clientId = params.get('client') || '';
  const status = params.get('status') || '';
  const q = new URLSearchParams();
  if (clientId) q.set('client_id', clientId);
  if (status) q.set('status', status);
  const posts = await api(`/posts?${q}`);

  main.innerHTML = `
    <div class="page-head"><h1>المنشورات</h1><a class="btn primary" href="#/compose">+ منشور جديد</a></div>
    <div class="row" style="margin-bottom:16px">
      <div><label for="f-client">العميل</label>
        <select id="f-client"><option value="">الكل</option>${clients.map((c) => `<option value="${c.id}" ${String(c.id) === clientId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div><label for="f-status">الحالة</label>
        <select id="f-status"><option value="">الكل</option>${['scheduled', 'published', 'draft', 'partial', 'failed'].map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${STATUS[s]}</option>`).join('')}</select></div>
    </div>
    <div class="card">${posts.length ? posts.map((p) => postRow(p)).join('') : '<div class="empty">مفيش منشورات</div>'}</div>`;

  const apply = () => {
    const nq = new URLSearchParams();
    if ($('#f-client').value) nq.set('client', $('#f-client').value);
    if ($('#f-status').value) nq.set('status', $('#f-status').value);
    location.hash = '#/posts' + (nq.toString() ? '?' + nq : '');
  };
  $('#f-client').onchange = apply;
  $('#f-status').onchange = apply;
  bindPostActions(main, () => renderPosts(main, params));
}

router();
