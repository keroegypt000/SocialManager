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
  const canPublish = ['draft', 'scheduled', 'failed', 'partial'].includes(p.status);
  return `
    <div class="post" data-id="${p.id}">
      ${p.image_url ? `<img class="thumb" src="${esc(p.image_url)}" alt="" loading="lazy">` : ''}
      <div class="body">
        <div class="meta" style="margin:0 0 4px">
          <span class="dot" style="background:${esc(p.client_color)}"></span><b>${esc(p.client_name)}</b>
          ${badge(p.status)} <span>${esc(when)}</span>
        </div>
        <div class="text">${esc(p.message) || '<span class="muted">(صورة بدون نص)</span>'}</div>
        <div class="meta">${targets}</div>
      </div>
      ${actions ? `<div class="actions">
        ${canPublish ? `<button class="btn small" data-act="publish">${p.status === 'failed' || p.status === 'partial' ? 'إعادة المحاولة' : 'انشر دلوقتي'}</button>` : ''}
        <button class="btn small danger" data-act="delete">حذف</button>
      </div>` : ''}
    </div>`;
}

function bindPostActions(root, reload) {
  root.querySelectorAll('.post [data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.closest('.post').dataset.id;
      if (btn.dataset.act === 'delete') {
        if (!confirm('متأكد إنك عايز تحذف المنشور ده من المنصة؟ (مش هيتمسح من فيسبوك أو إنستجرام لو كان اتنشر)')) return;
        await api(`/posts/${id}`, { method: 'DELETE' });
        toast('اتحذف');
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
      if (!confirm('فك ربط الحساب ده؟ المنشورات المجدولة عليه هتتشال منه.')) return;
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
      if (!confirm('حذف العميل هيمسح كل حساباته ومنشوراته من المنصة. متأكد؟')) return;
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

// ---------- compose ----------
async function renderCompose(main, params) {
  const clients = await loadClients();
  if (!clients.length) {
    main.innerHTML = `<div class="page-head"><h1>منشور جديد</h1></div><div class="card empty">ضيف عميل الأول من <a href="#/clients">العملاء والحسابات</a>.</div>`;
    return;
  }
  const preselect = params.get('client') || clients[0].id;
  const pad = (n) => String(n).padStart(2, '0');
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  const soonStr = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:00`;

  main.innerHTML = `
    <div class="page-head"><h1>منشور جديد</h1></div>
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
          <textarea id="p-message" placeholder="اكتب البوست هنا…"></textarea>
          <div class="counter" id="p-count">0 حرف</div>
        </div>
        <div class="field">
          <label>الصورة (مطلوبة لإنستجرام)</label>
          <label class="drop" id="p-drop" for="p-file">
            <input id="p-file" type="file" accept="image/*" hidden>
            <span id="p-drop-text">📷 دوس هنا واختار صورة من جهازك، أو اسحبها وسيبها هنا</span>
          </label>
          <input id="p-image" type="url" dir="ltr" placeholder="أو حط رابط صورة: https://...jpg" style="margin-top:8px">
          <button type="button" class="btn small danger" id="p-clear-img" hidden style="margin-top:6px">شيل الصورة</button>
        </div>
        <div class="field">
          <label for="p-link">رابط (لفيسبوك فقط، اختياري)</label>
          <input id="p-link" type="url" dir="ltr" placeholder="https://">
        </div>
        <div class="field">
          <label>النشر</label>
          <div class="modes">
            <label><input type="radio" name="mode" value="schedule" checked> جدولة</label>
            <label><input type="radio" name="mode" value="now"> انشر دلوقتي</label>
            <label><input type="radio" name="mode" value="draft"> احفظ مسودة</label>
          </div>
        </div>
        <div class="field" id="when-wrap">
          <label for="p-when">الميعاد</label>
          <input id="p-when" type="datetime-local" value="${soonStr}">
          <div class="muted small">النشر المجدول بيتم في خلال 5 دقايق من الميعاد.</div>
        </div>
        <div id="p-err" class="notice bad" hidden></div>
        <button class="btn primary" id="p-submit">حفظ</button>
      </form>
      <div class="card">
        <h2>معاينة</h2>
        <div class="preview" id="preview"><span class="muted">اكتب المنشور وهتظهر المعاينة هنا</span></div>
      </div>
    </div>`;

  const clientSel = $('#p-client');
  const loadAccounts = async () => {
    const box = $('#p-accounts');
    box.innerHTML = '<span class="muted small">جاري التحميل…</span>';
    const accounts = await api(`/accounts?client_id=${clientSel.value}`);
    box.innerHTML = accounts.length
      ? accounts.map((a) => `<label class="pick"><input type="checkbox" value="${a.id}" data-platform="${a.platform}" checked> ${platformTag(a.platform)} ${esc(a.name)}</label>`).join('')
      : `<span class="muted small">العميل ده مفيش عنده حسابات مربوطة. <a href="#/clients">اربط حساباته</a></span>`;
  };
  clientSel.onchange = loadAccounts;
  await loadAccounts();

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

  // Image upload: convert any image to JPEG (Instagram only accepts JPEG) and shrink big photos.
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
      dropText.textContent = '📷 دوس هنا واختار صورة من جهازك، أو اسحبها وسيبها هنا';
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
    dropText.textContent = '📷 دوس هنا واختار صورة من جهازك، أو اسحبها وسيبها هنا';
    updatePreview();
  };

  const updateMode = () => {
    const mode = document.querySelector('input[name=mode]:checked').value;
    $('#when-wrap').hidden = mode !== 'schedule';
    $('#p-submit').textContent = { schedule: 'جدولة المنشور', now: 'انشر دلوقتي', draft: 'حفظ كمسودة' }[mode];
  };
  document.querySelectorAll('input[name=mode]').forEach((r) => { r.onchange = updateMode; });
  updateMode();

  $('#compose').onsubmit = async (e) => {
    e.preventDefault();
    const errBox = $('#p-err');
    errBox.hidden = true;
    const mode = document.querySelector('input[name=mode]:checked').value;
    const accountIds = [...document.querySelectorAll('#p-accounts input:checked')].map((i) => Number(i.value));
    const whenVal = $('#p-when').value;
    const btn = $('#p-submit');
    btn.disabled = true;
    try {
      const post = await api('/posts', {
        method: 'POST',
        body: {
          client_id: Number(clientSel.value),
          account_ids: accountIds,
          message: $('#p-message').value,
          image_url: $('#p-image').value.trim() || null,
          link: $('#p-link').value.trim() || null,
          mode,
          scheduled_at: mode === 'schedule' && whenVal ? new Date(whenVal).getTime() : null,
        },
      });
      if (mode === 'now') {
        toast(post.status === 'published' ? 'اتنشر بنجاح' : 'فيه حسابات ماتنشرش عليها، شوف التفاصيل');
      } else {
        toast(mode === 'draft' ? 'اتحفظ كمسودة' : 'اتجدول بنجاح');
      }
      location.hash = '#/posts';
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
      btn.disabled = false;
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
  const byDay = {};
  for (const p of posts) {
    const d = new Date(p.scheduled_at || p.created_at);
    const key = d.toDateString();
    (byDay[key] ||= []).push(p);
  }

  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const list = (byDay[d.toDateString()] || []).sort((a, b) => (a.scheduled_at || a.created_at) - (b.scheduled_at || b.created_at));
    days.push(`
      <div class="day ${d.getMonth() !== month ? 'out' : ''} ${d.toDateString() === today.toDateString() ? 'today' : ''}">
        <div class="num">${d.getDate()}</div>
        ${list.map((p) => `<span class="chip" style="background:${esc(p.client_color)}" title="${esc(p.client_name)} — ${esc(STATUS[p.status])}\n${esc(p.message)}">
          ${new Date(p.scheduled_at || p.created_at).toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' })} ${esc(p.message.slice(0, 30) || 'صورة')}
        </span>`).join('')}
      </div>`);
  }

  const weekdays = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];
  main.innerHTML = `
    <div class="page-head">
      <h1>${first.toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' })}</h1>
      <div style="display:flex;gap:8px">
        <button class="btn" id="prev">→ الشهر اللي فات</button>
        <button class="btn" id="this">النهارده</button>
        <button class="btn" id="next">الشهر الجاي ←</button>
      </div>
    </div>
    <div class="cal-head">${weekdays.map((w) => `<div>${w}</div>`).join('')}</div>
    <div class="cal">${days.join('')}</div>`;

  $('#prev').onclick = () => { calMonth = new Date(year, month - 1, 1); renderCalendar(main); };
  $('#next').onclick = () => { calMonth = new Date(year, month + 1, 1); renderCalendar(main); };
  $('#this').onclick = () => { calMonth = null; renderCalendar(main); };
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
