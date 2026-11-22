(function () {
  const CFG = window.TRACKING_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const demo = params.has('demo') || !CFG.API_URL;

  const store = {
    get() { try { return localStorage.getItem('trackingCode'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem('trackingCode', v); } catch (e) { /* без збереження теж працює */ } },
  };

  let code = (params.get('c') || (demo ? 'DEMO2024' : store.get()) || '').trim().toUpperCase();
  let timer = null;
  let gallery = [], gIdx = 0;

  const fmtDate = (ts) => new Date(ts).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtDay = (ts) => new Date(ts).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
  const fmtDateTime = (ts) => new Date(ts).toLocaleString('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const photoUrl = (c, id, thumb) => (demo ? window.demoPhoto(String(id)) : `${CFG.API_URL}/photo/${c}/${id}${thumb ? '?s=thumb' : ''}`);
  const MAX_THUMBS = 8; // у сітці одразу показуємо стільки фото, решта — по кнопці

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // тільки textContent — дані приходять з Telegram
    return n;
  }

  async function load() {
    if (demo) return window.DEMO_CAR;
    const r = await fetch(`${CFG.API_URL}/api/car/${encodeURIComponent(code)}`);
    if (r.status === 404) { const e = new Error('not_found'); e.notFound = true; throw e; }
    if (!r.ok) throw new Error('http_' + r.status);
    return r.json();
  }

  function render(car) {
    $('loginView').classList.add('hidden');
    $('carView').classList.remove('hidden');
    $('loadErr').classList.add('hidden');
    $('demoBadge').classList.toggle('hidden', !demo);
    document.title = `${car.title} — Urban Auto`;

    $('carTitle').textContent = car.title;
    const chips = $('carChips'); chips.textContent = '';
    for (const [k, v] of [['VIN', car.vin], ['Лот', car.lot]]) {
      if (!v) continue;
      const c = el('span', 'chip', k + ' '); c.appendChild(el('b', null, v)); chips.appendChild(c);
    }

    // Букінг і контейнер — окремий блок зліва, під назвою авто
    const info = $('infoBox'); info.textContent = '';
    for (const [k, v] of [['Маршрут', car.route], ['Букінг', car.booking], ['Контейнер', car.container]]) {
      if (!v) continue;
      const row = el('div', 'inforow'); row.appendChild(el('span', 'k', k)); row.appendChild(el('span', 'v', v)); info.appendChild(row);
    }
    info.classList.toggle('hidden', !info.childNodes.length);

    const total = car.stages.length;
    const cur = car.stages.find((s) => s.id === car.current);
    $('statusNow').textContent = cur ? cur.title : 'Очікуємо оновлення';
    $('statusStep').textContent = car.current ? `Етап ${car.current} з ${total}` : '';
    const pct = Math.round((car.current / total) * 100);
    $('barFill').style.width = pct + '%';
    $('bar').setAttribute('aria-valuenow', pct);
    $('updated').textContent = car.updated ? 'Оновлено: ' + fmtDateTime(car.updated) : '';

    gallery = [];
    const tl = $('timeline'); tl.textContent = '';
    for (const s of car.stages) {
      const state = s.id < car.current || (s.id === car.current && car.current === total) ? 'done' : s.id === car.current ? 'now' : '';
      const li = el('li', 'step ' + (s.date || state ? state : ''));
      if (!s.date && state === 'done') li.className = 'step done'; // етап пропущено, але авто вже далі
      li.appendChild(el('span', 'dot', state === 'done' ? '✓' : String(s.id)));

      const head = el('div', 's-head');
      const title = el('span', 's-title', s.title);
      if (state === 'now') title.appendChild(el('span', 's-badge', 'зараз'));
      head.appendChild(title);
      head.appendChild(el('span', 's-date', !s.date ? (state === 'done' ? 'пройдено' : 'очікується') : s.planned ? 'очікується ' + fmtDay(s.date) : fmtDate(s.date)));
      li.appendChild(head);

      if (s.photos.length) {
        const ph = el('div', 'photos');
        s.photos.forEach((id, i) => {
          const full = photoUrl(car.code, id);
          const idx = gallery.push(full) - 1;
          const b = el('button', i >= MAX_THUMBS ? 'extra hidden' : ''); b.type = 'button'; b.setAttribute('aria-label', 'Відкрити фото');
          const img = el('img'); img.src = photoUrl(car.code, id, true); img.loading = 'lazy'; img.alt = s.title;
          b.appendChild(img); b.addEventListener('click', () => openLb(idx));
          ph.appendChild(b);
        });
        li.appendChild(ph);
        if (s.photos.length > MAX_THUMBS) {
          const more = el('button', 'more', `Показати всі фото (${s.photos.length})`); more.type = 'button';
          more.addEventListener('click', () => { ph.querySelectorAll('.extra').forEach((n) => n.classList.remove('hidden')); more.remove(); });
          li.appendChild(more);
        }
      }
      tl.appendChild(li);
    }
  }

  function showLogin(msg) {
    $('carView').classList.add('hidden');
    $('loginView').classList.remove('hidden');
    const e = $('loginErr');
    e.textContent = msg || ''; e.classList.toggle('hidden', !msg);
  }

  async function refresh(first) {
    try {
      render(await load());
      if (!demo) store.set(code);
    } catch (e) {
      if (e.notFound) { clearInterval(timer); if (first) { store.set(''); showLogin('Авто з таким кодом не знайдено. Перевірте код.'); } }
      else if (first) { $('loadErr').textContent = 'Не вдалося завантажити дані. Спробуйте пізніше.'; $('loadErr').classList.remove('hidden'); }
      // при фоновому оновленні помилки мовчки ігноруємо — лишаються попередні дані
    }
  }

  function start() {
    if (!code) return showLogin();
    refresh(true);
    clearInterval(timer);
    if (!demo) timer = setInterval(() => document.hidden || refresh(false), CFG.POLL_MS || 60000);
  }

  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('codeInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!v) return;
    code = v;
    history.replaceState(null, '', '?c=' + encodeURIComponent(v));
    start();
  });

  /* ── перегляд фото ── */
  function openLb(i) { gIdx = i; $('lbImg').src = gallery[gIdx]; $('lightbox').classList.remove('hidden'); }
  function closeLb() { $('lightbox').classList.add('hidden'); $('lbImg').removeAttribute('src'); }
  function step(d) { gIdx = (gIdx + d + gallery.length) % gallery.length; $('lbImg').src = gallery[gIdx]; }
  $('lbClose').addEventListener('click', closeLb);
  $('lbPrev').addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
  $('lbNext').addEventListener('click', (e) => { e.stopPropagation(); step(1); });
  $('lightbox').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeLb(); });
  document.addEventListener('keydown', (e) => {
    if ($('lightbox').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeLb();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  start();
})();
