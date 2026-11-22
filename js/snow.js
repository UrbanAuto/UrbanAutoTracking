/* Сніг (canvas) поверх сторінки. Без кнопок і гірлянди.
 * Для плавності на телефонах:
 *  – канвас лежить ПОВЕРХ вмісту й не заважає кліками (pointer-events: none): картки з backdrop-filter під ним не
 *    перемальовуються кожен кадр, як це було, коли сніг був позаду;
 *  – висота полотна стабільна (lvh) і сніжинки не перестворюються, коли ховається/з'являється адресний рядок
 *    браузера (це змінює innerHeight під час прокручування) — перебудова лише при зміні ширини (поворот екрана);
 *  – ~30 кадрів/с, менше сніжинок на малих екранах, пауза у фоновій вкладці;
 *  – не вмикається при prefers-reduced-motion. */
(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'snow';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const FRAME = 1000 / 30;
  let W = 0, H = 0, lastW = 0, flakes = [], raf = 0, last = 0;

  function build() {
    lastW = innerWidth;
    // розмір полотна береться з CSS-розмірів (ширина 100%, висота lvh — стабільна), тож сніжинки лишаються круглими
    W = canvas.width = Math.round((canvas.clientWidth || lastW) * dpr);
    H = canvas.height = Math.round((canvas.clientHeight || innerHeight) * dpr);
    const n = Math.max(18, Math.min(70, Math.round(lastW / 18)));
    flakes = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: (Math.random() * 2 + 0.8) * dpr, v: (Math.random() * 0.6 + 0.3) * dpr * 1.6,
      s: Math.random() * 6.283, a: Math.random() * 0.45 + 0.35,
    }));
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (t - last < FRAME) return;
    last = t;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    for (const f of flakes) {
      f.y += f.v; f.x += Math.sin(t / 1500 + f.s) * 0.5 * dpr;
      if (f.y > H + 5) { f.y = -5; f.x = Math.random() * W; }
      ctx.globalAlpha = f.a;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function start() { if (!raf) raf = requestAnimationFrame(frame); }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  build(); start();
  // лише зміна ширини (поворот телефона, зміна вікна) перебудовує сніг; зміна висоти від адресного рядка ігнорується
  addEventListener('resize', () => { if (innerWidth !== lastW) build(); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
})();
