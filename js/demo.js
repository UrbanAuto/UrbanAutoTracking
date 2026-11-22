// Демо-дані для перегляду вигляду без сервера (?demo або порожній API_URL).
(function () {
  const day = 86400000, now = Date.now();
  const titles = ['Куплено на аукціоні', 'Авто на складі в США', 'Завантажено в контейнер', 'В дорозі морем',
    'Прибуло в порт', 'Розформування контейнера', 'Прямує до терміналу', 'Готове до видачі'];
  const photos = [1, 2, 3, 0, 1, 12, 0, 0];
  window.DEMO_CAR = {
    code: 'DEMO2024', title: 'Honda Accord 2020', vin: '1HGCV1F30LA012345', lot: '48213907',
    current: 6, updated: now - 2 * day,
    stages: titles.map((t, i) => ({
      id: i + 1, title: t,
      date: i < 6 ? now - (22 - i * 3.6) * day : (i === 6 ? now + 2 * day : null),
      planned: i === 6,
      photos: Array.from({ length: photos[i] }, (_, k) => 'demo-' + (i + 1) + '-' + (k + 1)),
    })),
  };
  // Заглушки-«фото» (SVG), щоб демо виглядало як справжнє
  window.demoPhoto = function (id) {
    const h = (id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) * 37) % 360;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='480'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
      `<stop offset='0' stop-color='hsl(${h},55%,28%)'/><stop offset='1' stop-color='hsl(${(h + 40) % 360},60%,14%)'/></linearGradient></defs>` +
      `<rect width='640' height='480' fill='url(#g)'/><text x='320' y='260' font-family='Arial' font-size='64' text-anchor='middle' fill='rgba(255,255,255,.55)'>🚗</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  };
})();
