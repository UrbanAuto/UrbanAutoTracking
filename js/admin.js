(function () {
  const CFG = window.TRACKING_CONFIG || {};
  const API = CFG.API_URL;
  const $ = (id) => document.getElementById(id);
  const SITE = location.href.replace(/admin\.html.*$/, '');
  let token = '', data = null, pending = null;

  const store = {
    get() { try { return localStorage.getItem('admToken') || sessionStorage.getItem('admToken') || ''; } catch (e) { return ''; } },
    set(v, remember) { try { sessionStorage.setItem('admToken', v); remember ? localStorage.setItem('admToken', v) : localStorage.removeItem('admToken'); } catch (e) { /* без збереження теж працює */ } },
    clear() { try { sessionStorage.removeItem('admToken'); localStorage.removeItem('admToken'); } catch (e) { /* */ } },
  };

  const fmtDate = (ts) => ts ? new Date(ts).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }) : '—';
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2600); }

  async function api(path, opt = {}) {
    const r = await fetch(API + '/admin/api' + path, { ...opt, headers: { authorization: 'Bearer ' + token, ...(opt.headers || {}) } });
    if (r.status === 401) { const e = new Error('unauthorized'); e.code = 401; throw e; }
    if (!r.ok) throw new Error('http_' + r.status);
    return r.json();
  }

  function showLogin(msg) {
    $('panel').classList.add('hidden'); $('loginView').classList.remove('hidden');
    const e = $('loginErr'); e.textContent = msg || ''; e.classList.toggle('hidden', !msg);
  }

  async function load() {
    try {
      data = await api('/cars');
      $('loginView').classList.add('hidden'); $('panel').classList.remove('hidden'); $('loadErr').classList.add('hidden');
      render(); loadBlocked(); loadGroups();
    } catch (e) {
      if (e.code === 401) { store.clear(); token = ''; showLogin('Невірний токен.'); }
      else { $('loadErr').textContent = 'Не вдалося завантажити дані. Спробуйте ще раз.'; $('loadErr').classList.remove('hidden'); }
    }
  }

  function render() {
    const q = $('search').value.trim().toLowerCase();
    const cars = data.cars.filter((c) => !q || [c.title, c.vin, c.booking, c.container, c.route, c.order_id, c.code].some((v) => v && String(v).toLowerCase().includes(q)));
    const photos = data.cars.reduce((a, c) => a + c.photos, 0);
    const stats = $('stats'); stats.textContent = '';
    for (const [k, v] of [['Авто', data.cars.length], ['Фото', photos], ['Показано', cars.length], ['Фото в очікуванні', data.buffered]]) {
      const s = el('span', null, k + ': '); s.appendChild(el('b', null, String(v))); stats.appendChild(s);
    }
    const box = $('cars'); box.textContent = '';
    if (!cars.length) { box.appendChild(el('div', 'card empty', data.cars.length ? 'Нічого не знайдено.' : 'У базі ще немає авто.')); return; }
    for (const c of cars) {
      const card = el('article', 'car');
      const head = el('div', 'car-head'); const left = el('div');
      left.appendChild(el('h3', null, c.title));
      left.appendChild(el('div', 'sub', (c.vin ? 'VIN ' + c.vin : 'без VIN') + (c.order_id ? ' · замовлення №' + c.order_id : '')));
      head.appendChild(left); card.appendChild(head);

      const meta = el('div', 'meta');
      for (const [k, v] of [['Маршрут', c.route], ['Букінг', c.booking], ['Контейнер', c.container], ['Код', c.code]]) {
        if (!v) continue; const s = el('span', null, k + ' '); s.appendChild(el('b', null, v)); meta.appendChild(s);
      }
      card.appendChild(meta);

      const bar = el('div', 'car-bar'); const b = el('div', 'bar'); const i = el('i'); i.style.width = Math.round((c.current / data.total) * 100) + '%'; b.appendChild(i);
      const st = el('div', 'st'); st.appendChild(document.createTextNode(c.current ? `Етап ${c.current}/${data.total}: ` : 'Без етапу '));
      if (c.current) st.appendChild(el('em', null, data.stages[c.current - 1]));
      bar.appendChild(b); bar.appendChild(st); card.appendChild(bar);
      card.appendChild(el('div', 'sub', `Фото: ${c.photos} · подій: ${c.events} · оновлено: ${fmtDate(c.updated || c.created_at)}`));

      const act = el('div', 'car-act');
      const open = el('a', 'btn sm', 'Кабінет клієнта ↗'); open.href = `${SITE}?c=${c.code}`; open.target = '_blank'; open.rel = 'noopener'; act.appendChild(open);
      const det = el('button', 'btn sm', 'Деталі'); det.type = 'button'; det.addEventListener('click', () => openDetail(c.code)); act.appendChild(det);
      const del = el('button', 'btn sm danger', 'Видалити'); del.type = 'button'; del.addEventListener('click', () => askDeleteCar(c)); act.appendChild(del);
      card.appendChild(act); box.appendChild(card);
    }
  }

  async function loadBlocked() {
    try {
      const { blocked } = await api('/blocked');
      const list = $('blockedList'); list.textContent = '';
      $('blockedCard').classList.toggle('hidden', !blocked.length);
      for (const b of blocked) {
        const row = el('div', 'blk'); row.appendChild(el('span', null, b.key.startsWith('order:') ? 'Замовлення №' + b.key.slice(6) : 'VIN ' + b.key));
        const btn = el('button', 'btn sm', 'Розблокувати'); btn.type = 'button';
        btn.addEventListener('click', async () => { await api('/blocked/' + encodeURIComponent(b.key), { method: 'DELETE' }); toast('Розблоковано'); loadBlocked(); });
        row.appendChild(btn); list.appendChild(row);
      }
    } catch (e) { /* список необов'язковий */ }
  }

  async function openDetail(code) {
    const d = await api('/car/' + code).catch(() => null);
    if (!d) return toast('Не вдалося відкрити');
    const body = $('detailBody'); body.textContent = '';
    body.appendChild(el('h3', null, d.car.title));
    const info = el('div', 'd-info');
    for (const [k, v] of [['VIN', d.car.vin], ['Замовлення', d.car.order_id && '№' + d.car.order_id], ['Маршрут', d.car.route], ['Букінг', d.car.booking], ['Контейнер', d.car.container], ['Код клієнта', d.car.code], ['Створено', fmtDate(d.car.created_at)]]) {
      if (!v) continue; const row = el('div'); row.appendChild(el('span', 'k', k)); row.appendChild(el('span', 'v', v)); info.appendChild(row);
    }
    body.appendChild(info);
    const byStage = {};
    for (const e of d.events) (byStage[e.stage] = byStage[e.stage] || []).push(e);
    if (!d.events.length) body.appendChild(el('p', 'note', 'Подій ще немає.'));
    for (const stage of Object.keys(byStage).map(Number).sort((a, b) => a - b)) {
      const sec = el('div', 'd-stage'); const h = el('h4', null, `${stage}. ${d.stages[stage - 1] || 'Етап ' + stage}`);
      const evs = byStage[stage]; const photos = evs.filter((e) => e.photo); h.appendChild(el('small', null, `${photos.length} фото · з ${fmtDate(evs[0].ts)}`));
      sec.appendChild(h);
      const markers = evs.filter((e) => !e.photo);
      for (const m of markers) {
        const t = el('span', 'ev-text', 'Відмітка етапу · ' + fmtDate(m.ts)); const x = el('button', null, '×'); x.type = 'button'; x.title = 'Видалити відмітку';
        x.addEventListener('click', () => askDeleteEvent(m, code)); t.appendChild(x); sec.appendChild(t);
      }
      if (photos.length) {
        const grid = el('div', 'thumbs');
        for (const p of photos) {
          const t = el('div', 'thumb'); const img = el('img'); img.loading = 'lazy'; img.alt = ''; img.src = `${API}/photo/${code}/${p.id}?s=thumb`; t.appendChild(img);
          const x = el('button', null, '×'); x.type = 'button'; x.title = 'Видалити фото'; x.addEventListener('click', () => askDeleteEvent(p, code)); t.appendChild(x); grid.appendChild(t);
        }
        sec.appendChild(grid);
      }
      body.appendChild(sec);
    }
    $('detail').classList.remove('hidden');
  }

  /* ── підтвердження ── */
  function ask({ title, text, block, blockLabel, onYes }) {
    $('confirmTitle').textContent = title; $('confirmText').textContent = text;
    $('blockLabel').textContent = blockLabel || 'Не додавати це авто знову (ігнорувати повідомлення з цим VIN)';
    $('blockRow').classList.toggle('hidden', !block); $('blockChk').checked = false;
    pending = onYes; $('confirm').classList.remove('hidden');
  }
  function askDeleteCar(c) {
    ask({ title: `Видалити «${c.title}»?`, text: `Буде видалено картку, усі етапи та ${c.photos} фото. Клієнтське посилання перестане працювати. Це не можна скасувати.`, block: true,
      onYes: async () => { const blk = $('blockChk').checked; await api(`/car/${c.code}?block=${blk ? 1 : 0}`, { method: 'DELETE' }); toast('Авто видалено'); $('detail').classList.add('hidden'); load(); } });
  }
  function askDeleteEvent(e, code) {
    ask({ title: e.photo ? 'Видалити це фото?' : 'Видалити відмітку етапу?', text: e.photo ? 'Фото зникне з кабінету клієнта.' : 'Етап може змінитися, якщо це була єдина подія цього етапу.', block: false,
      onYes: async () => { await api('/event/' + e.id, { method: 'DELETE' }); toast('Видалено'); await load(); openDetail(code); } });
  }
  $('confirmNo').addEventListener('click', () => { pending = null; $('confirm').classList.add('hidden'); });
  $('confirmYes').addEventListener('click', async () => {
    const f = pending; pending = null; $('confirm').classList.add('hidden');
    if (f) { try { await f(); } catch (e) { toast(e.code === 401 ? 'Сесія завершена' : 'Помилка видалення'); } }
  });
  $('detailClose').addEventListener('click', () => $('detail').classList.add('hidden'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('confirm').classList.add('hidden'); $('detail').classList.add('hidden'); } });


  /* ── групи сповіщень ── */
  let groups = [];
  const STATUS = { active: 'Активна', pending: 'Очікує підтвердження', disabled: 'Вимкнена', error: 'Помилка' };

  function setTab(name) {
    for (const t of document.querySelectorAll('#tabs .tab')) t.classList.toggle('on', t.dataset.tab === name);
    $('carsWrap').classList.toggle('hidden', name !== 'cars'); $('groupsWrap').classList.toggle('hidden', name !== 'groups'); $('contractsWrap').classList.toggle('hidden', name !== 'contracts');
    if (name === 'groups') loadGroups();
    if (name === 'contracts') loadContracts();
  }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });

  async function loadGroups() {
    try { groups = (await api('/groups')).groups; } catch (e) { return; }
    const pend = groups.filter((g) => g.status === 'pending').length;
    const bd = $('pendingBadge'); bd.textContent = pend; bd.classList.toggle('hidden', !pend);
    renderGroups();
  }

  function renderGroups() {
    const box = $('groups'); box.textContent = '';
    if (!groups.length) { box.appendChild(el('div', 'card empty', 'Груп ще немає. Додайте бота в групу — вона з’явиться тут.')); return; }
    for (const g of groups) {
      const card = el('article', 'car'); const head = el('div', 'car-head'); const left = el('div');
      left.appendChild(el('h3', null, g.title || g.chat_id));
      left.appendChild(el('div', 'sub', 'chat_id ' + g.chat_id));
      head.appendChild(left); head.appendChild(el('span', 'chip ' + g.status, STATUS[g.status] || g.status)); card.appendChild(head);
      card.appendChild(el('div', 'sub', g.scope === 'all' ? 'Надсилає сповіщення по всіх авто' : `Вибрані авто: ${g.cars.length}`));
      if (g.last_error) card.appendChild(el('div', 'err-line', g.last_error));
      const act = el('div', 'car-act');
      const cfg = el('button', 'btn sm', g.status === 'pending' ? 'Налаштувати й підключити' : 'Налаштувати'); cfg.type = 'button'; cfg.addEventListener('click', () => openGroup(g)); act.appendChild(cfg);
      const test = el('button', 'btn sm', 'Тест'); test.type = 'button'; test.addEventListener('click', () => testGroup(g)); act.appendChild(test);
      const del = el('button', 'btn sm danger', 'Видалити'); del.type = 'button'; del.addEventListener('click', () => askDeleteGroup(g)); act.appendChild(del);
      card.appendChild(act); box.appendChild(card);
    }
  }

  let editing = null;
  function openGroup(g) {
    editing = g;
    $('groupTitle').textContent = g.title || g.chat_id;
    $('groupMeta').textContent = `chat_id ${g.chat_id} · ${STATUS[g.status] || g.status}`;
    $('gActive').checked = g.status === 'active' || g.status === 'pending' ? g.status === 'active' : false;
    if (g.status === 'pending') $('gActive').checked = true; // «Налаштувати й підключити» — одразу вмикаємо
    for (const r of document.getElementsByName('gScope')) r.checked = r.value === g.scope;
    $('gCarsSearch').value = ''; renderCarChecks(new Set(g.cars));
    $('groupModal').classList.remove('hidden');
  }
  function renderCarChecks(selected) {
    const q = $('gCarsSearch').value.trim().toLowerCase(); const box = $('gCars'); box.textContent = '';
    const all = document.querySelector('input[name=gScope][value=all]').checked; box.classList.toggle('off', all);
    for (const c of (data ? data.cars : [])) {
      if (q && ![c.title, c.vin, c.code].some((v) => v && String(v).toLowerCase().includes(q))) continue;
      const lab = el('label'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = c.code; cb.checked = selected.has(c.code);
      cb.addEventListener('change', () => { cb.checked ? selected.add(c.code) : selected.delete(c.code); });
      lab.appendChild(cb); const t = el('span', null, c.title + ' '); t.appendChild(el('small', null, c.vin || c.code)); lab.appendChild(t); box.appendChild(lab);
    }
    if (!box.childNodes.length) box.appendChild(el('div', 'empty', 'Авто не знайдено'));
    renderCarChecks.sel = selected;
  }
  $('gCarsSearch').addEventListener('input', () => renderCarChecks(renderCarChecks.sel || new Set()));
  for (const r of document.getElementsByName('gScope')) r.addEventListener('change', () => renderCarChecks(renderCarChecks.sel || new Set()));
  $('groupCancel').addEventListener('click', () => $('groupModal').classList.add('hidden'));
  $('groupClose').addEventListener('click', () => $('groupModal').classList.add('hidden'));
  $('groupSave').addEventListener('click', async () => {
    if (!editing) return;
    const scope = document.querySelector('input[name=gScope]:checked')?.value || 'cars';
    const cars = [...(renderCarChecks.sel || [])];
    if ($('gActive').checked && scope === 'cars' && !cars.length) return toast('Оберіть хоча б одне авто або «Усі авто»');
    try {
      await api('/groups/' + editing.chat_id, { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ status: $('gActive').checked ? 'active' : 'disabled', scope, cars }) });
      $('groupModal').classList.add('hidden'); toast('Збережено'); loadGroups();
    } catch (e) { toast('Не вдалося зберегти'); }
  });

  async function testGroup(g) {
    try { const r = await api(`/groups/${g.chat_id}/test`, { method: 'POST' }); toast(r.ok ? 'Тестове сповіщення надіслано' : 'Не вдалося: ' + (r.error || '')); } catch (e) { toast('Не вдалося надіслати'); }
  }
  function askDeleteGroup(g) {
    ask({ title: `Видалити групу «${g.title || g.chat_id}»?`, text: 'Сповіщення в цю групу припиняться. Сама група в Telegram не видаляється.', block: true, blockLabel: 'Також вийти бота з цієї групи',
      onYes: async () => { await api(`/groups/${g.chat_id}?leave=${$('blockChk').checked ? 1 : 0}`, { method: 'DELETE' }); toast('Групу видалено'); loadGroups(); } });
  }
  $('groupAddForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const id = $('groupIdInput').value.trim(); if (!id) return;
    try {
      const r = await fetch(API + '/admin/api/groups', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: id }) });
      const d = await r.json();
      if (!r.ok) return toast(d.error === 'bot_not_in_chat' ? 'Бота немає в цій групі — спершу додайте його' : d.error === 'bad_chat_id' ? 'Невірний chat_id' : 'Помилка');
      $('groupIdInput').value = ''; toast('Групу додано — налаштуйте, які авто надсилати'); await loadGroups();
      const g = groups.find((x) => x.chat_id === d.chat_id); if (g) openGroup(g);
    } catch (e2) { toast('Помилка мережі'); }
  });


  /* ── договори ── */
  async function loadContracts() {
    let list; try { list = (await api('/contracts')).contracts; } catch (e) { return; }
    const box = $('contracts'); box.textContent = '';
    if (!list.length) { box.appendChild(el('div', 'card empty', 'Договорів ще немає. У Telegram надішліть боту /договір.')); return; }
    for (const c of list) {
      const card = el('article', 'car'); const head = el('div', 'car-head'); const left = el('div');
      left.appendChild(el('h3', null, `Договір №${c.number}`));
      left.appendChild(el('div', 'sub', (c.name || (c.purged ? '🔒 Дані клієнта видалено з бази' : 'ПІБ ще не вказано')) + (c.phone ? ' · ' + c.phone : '')));
      head.appendChild(left); head.appendChild(el('span', 'chip ' + (c.purged ? 'disabled' : c.filled === c.total ? 'active' : 'pending'), c.purged ? 'Дані видалено' : c.filled === c.total ? 'Готовий' : `Дані ${c.filled}/${c.total}`)); card.appendChild(head);
      card.appendChild(el('div', 'sub', `Версія PDF: ${c.version} · створено ${fmtDate(c.created_at)} · оновлено ${fmtDate(c.updated_at)}`));
      const act = el('div', 'car-act'); const del = el('button', 'btn sm danger', 'Видалити'); del.type = 'button';
      del.addEventListener('click', () => ask({ title: `Видалити договір №${c.number}?`, text: 'Договір і персональні дані клієнта буде видалено остаточно. PDF, надіслані в Telegram, залишаться в чаті — їх видаліть вручну.', block: false,
        onYes: async () => { await api('/contracts/' + c.number, { method: 'DELETE' }); toast('Договір видалено'); loadContracts(); } }));
      act.appendChild(del); card.appendChild(act); box.appendChild(card);
    }
  }
  /* ── вхід/вихід ── */
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault(); const v = $('tokenInput').value.trim(); if (!v) return;
    token = v; store.set(v, $('remember').checked); $('tokenInput').value = ''; load();
  });
  $('logoutBtn').addEventListener('click', () => { store.clear(); token = ''; data = null; showLogin(''); });
  $('refreshBtn').addEventListener('click', () => { load(); toast('Оновлено'); });
  $('search').addEventListener('input', () => data && render());

  if (!API) { $('loadErr').textContent = 'Не налаштовано API_URL у js/config.js'; $('loadErr').classList.remove('hidden'); }
  else { token = store.get(); token ? load() : showLogin(''); }
})();
