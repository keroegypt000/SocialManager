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
  failed: 'فشل',
  pending: 'منتظر',
};
const PLATFORM = { facebook: 'فيسبوك', instagram: 'إنستجرام' };

const fmtDate = (ms) => ms ? new Date(ms).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : '';

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
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

function postRow(p, { actions = true } = {}) {
  const when = p.scheduled_at ? fmtDate(p.scheduled_at) : fmtDate(p.created_at);
  const targets = p.targets.map((t) => `
    <span>${platformTag(t.platform)} ${esc(t.name)} ${t.status !== 'pending' ? badge(t.status) : ''}</span>
    ${t.error ? `<div class="target-error" style="width:100%">${esc(t.name)}: ${esc(t.error)}</div>` : ''}`).join('');
  const editable = ['draft', 'scheduled', 'failed', 'partial'].includes(p.status);
  return `
    <div class="post" data-id="${p.id}" data-series="${esc(p.series_id || '')}">
      ${p.image_url ? `<img class="thumb" src="${esc(p.image_url)}" alt="" loading="lazy">` : ''}
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
          toast(p.status === 'published' ? 'اتنشر بنجاح' : 'فيه حسابات ماتنشرش عليها، شوف السبب تحت المنشور');
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
          <label for="p-client">العميل</label>
          <select id="p-client">${clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(preselect) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label>هينزل على</label>
          <div id="p-accounts" class="account-picks"></div>
        </div>
        <div class="field">
          <label for="p-message">نص المنشور</label>
          <textarea id="p-message" placeholder="اكتب البوست هنا…">${esc(source?.message || '')}</textarea>
          <div class="counter" id="p-count">0 حرف</div>
        </div>
        <div class="field">
          <label>الصورة (مطلوبة لإنستجرام)</label>
          <label class="drop" id="p-drop" for="p-file">
            <input id="p-file" type="file" accept="image/*" hidden>
            <span id="p-drop-text">📷 دوس هنا واختار صورة من جهازك، أو اسحبها وسيبها هنا</span>
          </label>
          <input id="p-image" type="url" dir="ltr" placeholder="أو حط رابط صورة: https://...jpg" style="margin-top:8px" value="${esc(source?.image_url || '')}">
          <button type="button" class="btn small danger" id="p-clear-img" ${source?.image_url ? '' : 'hidden'} style="margin-top:6px">شيل الصورة</button>
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

  // --- accounts ---
  const clientSel = $('#p-client');
  const preChecked = source ? new Set(source.targets.map((t) => t.account_id)) : null;
  const loadAccounts = async () => {
    const box = $('#p-accounts');
    box.innerHTML = '<span class="muted small">جاري التحميل…</span>';
    const accounts = await api(`/accounts?client_id=${clientSel.value}`);
    const sameClient = source && String(source.client_id) === clientSel.value;
    box.innerHTML = accounts.length
      ? accounts.map((a) => `<label class="pick"><input type="checkbox" value="${a.id}" data-platform="${a.platform}" ${!sameClient || preChecked.has(a.id) ? 'checked' : ''}> ${platformTag(a.platform)} ${esc(a.name)}</label>`).join('')
      : `<span class="muted small">العميل ده مفيش عنده حسابات مربوطة. <a href="#/clients">اربط حساباته</a></span>`;
  };
  clientSel.onchange = loadAccounts;
  await loadAccounts();

  // --- preview ---
  const updatePreview = () => {
    const msg = $('#p-message').value;
    const img = $('#p-image').value.trim();
    $('#p-count').textContent = `${msg.length} حرف${msg.length > 2200 ? ' (إنستجرام أقصاه 2200)' : ''}`;
    $('#preview').innerHTML = (msg || img)
      ? `${esc(msg)}${/^https?:\/\//.test(img) ? `<img src="${esc(img)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'notice bad',textContent:'الصورة مش بتفتح من الرابط ده'}))">` : ''}`
      : '<span class="muted">اكتب المنشور وهتظهر المعاينة هنا</span>';
  };
  $('#p-message').oninput = updatePreview;
  $('#p-image').oninput = () => { $('#p-clear-img').hidden = !$('#p-image').value; updatePreview(); };
  updatePreview();

  // --- image upload ---
  const dropIdle = '📷 دوس هنا واختار صورة من جهازك، أو اسحبها وسيبها هنا';
  const dropText = $('#p-drop-text');
  const submitBtn = $('#p-submit');
  const uploadFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) return toast('اختار ملف صورة');
    dropText.textContent = 'جاري رفع الصورة…';
    submitBtn.disabled = true;
    try {
      const jpeg = await toJpeg(file);
      const res = await fetch('/api/media', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'فشل رفع الصورة');
      $('#p-image').value = data.url;
      $('#p-clear-img').hidden = false;
      dropText.textContent = `✅ ${file.name}، دوس هنا لو عايز تغيّرها`;
      updatePreview();
    } catch (err) {
      dropText.textContent = dropIdle;
      toast(err.message);
    } finally {
      submitBtn.disabled = false;
    }
  };
  $('#p-file').onchange = (e) => uploadFile(e.target.files[0]);
  const drop = $('#p-drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFile(e.dataTransfer.files[0]); };
  $('#p-clear-img').onclick = () => {
    $('#p-image').value = '';
    $('#p-file').value = '';
    $('#p-clear-img').hidden = true;
    dropText.textContent = dropIdle;
    updatePreview();
  };

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
      image_url: $('#p-image').value.trim() || null,
      link: $('#p-link').value.trim() || null,
      mode: m === 'repeat' || m === 'dates' ? 'schedule' : m,
      scheduled_times: times,
    };
    submitBtn.disabled = true;
    try {
      const post = await api(isEdit ? `/posts/${editId}` : '/posts', { method: isEdit ? 'PUT' : 'POST', body: payload });
      if (m === 'now') toast(post.status === 'published' ? 'اتنشر بنجاح' : 'فيه حسابات ماتنشرش عليها، شوف التفاصيل');
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
            <span class="chip-time">${p.series_id ? '🔁 ' : ''}${fmtTime(postTime(p))}</span>
            <span class="chip-text">${esc(p.message.slice(0, 40) || '📷 صورة')}</span>
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
      دوس على منشور عشان تعدّله أو تنسخه · اسحب منشور لأي يوم عشان تنقله · اسحب وإنت ضاغط <b>Ctrl</b> عشان تعمل نسخة · دوس على <b>+</b> في أي يوم لمنشور جديد
    </div>
    <div class="cal-head">${weekdays.map((w) => `<div>${w}</div>`).join('')}</div>
    <div class="cal">${days.join('')}</div>
    <dialog id="post-dialog" class="dialog"></dialog>`;

  const reload = () => renderCalendar(main);
  $('#prev').onclick = () => { calMonth = new Date(year, month - 1, 1); reload(); };
  $('#next').onclick = () => { calMonth = new Date(year, month + 1, 1); reload(); };
  $('#this').onclick = () => { calMonth = null; reload(); };

  // Click a post -> popup. Click "+" on a day -> new post on that day.
  main.querySelector('.cal').addEventListener('click', (e) => {
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
        await api(`/posts/${p.id}/${copy ? 'duplicate' : 'move'}`, { method: 'POST', body: { scheduled_at: at } });
        toast((copy ? `اتعملت نسخة يوم ${fmtDate(at)}` : `اتنقل لـ ${fmtDate(at)}`) + note);
        reload();
      } catch (err) {
        toast(err.message);
      }
    });
  });
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
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="">` : ''}
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
          await api(`/posts/${p.id}/move`, { method: 'POST', body: { scheduled_at: at } });
          toast(`الميعاد اتغير لـ ${fmtDate(at)}`);
        });
      }
      if (act === 'copy') {
        return run(async () => {
          const at = new Date(copyInput.value).getTime();
          await api(`/posts/${p.id}/duplicate`, { method: 'POST', body: { scheduled_at: at } });
          toast(`اتعملت نسخة يوم ${fmtDate(at)}`);
        });
      }
      if (act === 'publish') {
        b.disabled = true;
        b.textContent = 'جاري النشر…';
        return run(async () => {
          const r = await api(`/posts/${p.id}/publish`, { method: 'POST' });
          toast(r.status === 'published' ? 'اتنشر بنجاح' : 'فيه حسابات ماتنشرش عليها');
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
