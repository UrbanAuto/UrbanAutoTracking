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
    const r = await fetch(API + '/admin/api' + path, { ...opt, headers: { authorization: 'Bearer ' + token } });
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
      render(); loadBlocked();
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
  function ask({ title, text, block, onYes }) {
    $('confirmTitle').textContent = title; $('confirmText').textContent = text;
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
