/* Новорічний декор: сніг (canvas). Гірлянда — чистий CSS (.card::before/::after).
 * Кнопка ❄ у шапці вмикає/вимикає ефекти; вибір запам'ятовується. Поважає prefers-reduced-motion. */
(function () {
  const KEY = 'tr-festive';
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let on = true;
  try { on = localStorage.getItem(KEY) !== 'off'; } catch (e) {}
  if (reduce) on = false;

  const canvas = document.createElement('canvas');
  canvas.className = 'snow';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  let w, h, flakes = [], raf = 0;

  function resize() {
    const d = window.devicePixelRatio || 1;
    w = canvas.width = innerWidth * d; h = canvas.height = innerHeight * d;
    canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
    const n = Math.min(90, Math.round(innerWidth / 14));
    flakes = Array.from({ length: n }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: (Math.random() * 2.2 + 0.8) * d, v: (Math.random() * 0.7 + 0.35) * d,
      s: Math.random() * Math.PI * 2, a: Math.random() * 0.5 + 0.35,
    }));
  }
  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    for (const f of flakes) {
      f.y += f.v; f.x += Math.sin(t / 1500 + f.s) * 0.35;
      if (f.y > h + 5) { f.y = -5; f.x = Math.random() * w; }
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.283);
      ctx.fillStyle = `rgba(255,255,255,${f.a})`; ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }

  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'festive-btn'; btn.title = 'Новорічний настрій'; btn.textContent = '❄';
  document.body.appendChild(btn);

  function apply() {
    document.body.classList.toggle('festive', on);
    btn.setAttribute('aria-pressed', on);
    cancelAnimationFrame(raf);
    if (on) { resize(); raf = requestAnimationFrame(frame); } else ctx.clearRect(0, 0, w || 0, h || 0);
  }
  btn.addEventListener('click', () => {
    on = !on; try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {} apply();
  });
  addEventListener('resize', () => { if (on) resize(); });
  apply();
})();
