// Urban Auto — трекер авто. Cloudflare Worker + D1.
//   POST /webhook            ← Telegram (повідомлення з групи → етапи й фото авто)
//   GET  /api/car/:code      → дані авто для кабінету клієнта
//   GET  /photo/:code/:id    → фото (Telegram-токен ніколи не потрапляє до клієнта)

// Етапи. Бот шукає в тексті повідомлення ключові слова (укр/рос/англ).
// Явно вказати етап можна й так: #етап3 або #3. Слова підлаштуємо під ваші реальні повідомлення.
// Повідомлення CargoPlus мають вигляд «📍 Статус: Розформований», «📅 Розформування контейнера: 20.11.2026»,
// «2015 FORD ESCAPE SE», «VIN: …». Статуси, яких я ще не бачив, треба додати сюди (regex на текст статусу).
const STAGES = [
  { id: 1, title: 'Куплено на аукціоні',        re: /купл|куплен|викуплен|выкуплен|won|bought|purchased/i },
  { id: 2, title: 'Авто на складі в США',       re: /склад|warehouse|забра[лв]|вивез|вывез|pick.?up|picked/i },
  { id: 3, title: 'Завантажено в контейнер',    re: /завантаж|погруз|loaded|container loaded/i },
  { id: 4, title: 'В дорозі морем',             re: /в дорозі|в дороге|в пути|в морі|в море|відплив|отплыл|вийшов|вышел|sailed|sailing|shipped/i },
  { id: 5, title: 'Прибуло в порт',             re: /порт|прибув|прибыл|arrived/i },
  { id: 6, title: 'Розформування контейнера',   re: /розформ|розвантаж|devan|unload/i },
  { id: 7, title: 'Прямує до терміналу',        re: /прямує|термінал|терминал|митн|розмитн|таможн|customs/i },
  { id: 8, title: 'Готове до видачі',           re: /готов|видан|выдан|передан|вручен|delivered|ready/i },
];

const VIN_RE = /(?<![A-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9])/i;
const TITLE_RE = /^\s*((?:19|20)\d{2}\s+[^\n]{2,})$/m;   // «2015 FORD ESCAPE SE»
const DATE_RE = /(\d{2})\.(\d{2})\.(20\d{2})/;           // «20.11.2026»
const LOT_RE = /(?:lot|лот)\s*[#№:]?\s*(\d{6,9})/i;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    try {
      if (req.method === 'POST' && url.pathname === '/webhook') return await webhook(req, env);
      let m;
      if ((m = url.pathname.match(/^\/api\/car\/([A-Za-z0-9]{6,32})$/))) return await apiCar(m[1].toUpperCase(), env);
      if ((m = url.pathname.match(/^\/photo\/([A-Za-z0-9]{6,32})\/(\d+)$/))) return await photo(req, ctx, env, m[1].toUpperCase(), +m[2]);
      if (url.pathname === '/') return new Response('Urban Auto tracking API', { headers: cors(env) });
      return json(env, { error: 'not_found' }, 404);
    } catch (e) {
      console.error(e);
      return json(env, { error: 'server_error' }, 500);
    }
  },
};

/* ───────────── допоміжне ───────────── */
const cors = (env) => ({ 'access-control-allow-origin': env.ALLOWED_ORIGIN || '*', 'access-control-allow-methods': 'GET,OPTIONS' });
const json = (env, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(env) } });

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}

function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
}

const clientLink = (env, code) => `${(env.SITE_URL || '').replace(/\/$/, '')}/?c=${code}`;

/* ───────────── API для клієнта ───────────── */
async function apiCar(code, env) {
  const car = await env.DB.prepare('SELECT code, vin, lot, title FROM cars WHERE code = ?1').bind(code).first();
  if (!car) return json(env, { error: 'not_found' }, 404);
  const { results } = await env.DB.prepare('SELECT id, stage, photo_id IS NOT NULL AS has_photo, ts FROM events WHERE code = ?1 ORDER BY ts, id').bind(code).all();

  const now = Date.now();
  const stages = STAGES.map((s) => ({ id: s.id, title: s.title, date: null, planned: false, photos: [] }));
  let current = 0, updated = 0;
  for (const ev of results) {
    const st = stages[ev.stage - 1];
    if (!st) continue;
    if (!st.date || ev.ts < st.date) st.date = ev.ts;
    if (ev.has_photo) st.photos.push(ev.id);
    if (ev.ts <= now) { current = Math.max(current, ev.stage); updated = Math.max(updated, ev.ts); } // майбутня дата = лише план
  }
  for (const st of stages) st.planned = !!st.date && st.date > now;
  // Сирі тексти з групи клієнту не віддаємо — лише етап, дату й фото.
  return json(env, { code: car.code, title: car.title, vin: car.vin, lot: car.lot, current, updated: updated || null, stages });
}

async function photo(req, ctx, env, code, id) {
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;
  const ev = await env.DB.prepare('SELECT photo_id, thumb_id FROM events WHERE id = ?1 AND code = ?2 AND photo_id IS NOT NULL').bind(id, code).first();
  if (!ev) return json(env, { error: 'not_found' }, 404);
  const wantThumb = new URL(req.url).searchParams.get('s') === 'thumb';
  const f = await tg(env, 'getFile', { file_id: (wantThumb && ev.thumb_id) || ev.photo_id });
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.file_path}`);
  if (!r.ok) return json(env, { error: 'file_unavailable' }, 502);
  const ext = (f.file_path.split('.').pop() || '').toLowerCase();
  const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const res = new Response(r.body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=86400', ...cors(env) } });
  ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

/* ───────────── Telegram webhook ───────────── */
async function webhook(req, env) {
  if (env.WEBHOOK_SECRET && req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET)
    return new Response('forbidden', { status: 403 });
  const update = await req.json();
  const msg = update.message || update.channel_post;
  if (msg) {
    try { await handleMessage(msg, env); } catch (e) { console.error('handleMessage', e); }
  }
  return new Response('ok'); // завжди 200, щоб Telegram не повторював «биті» повідомлення
}

const reply = (env, msg, text) =>
  tg(env, 'sendMessage', { chat_id: msg.chat.id, text, message_thread_id: msg.message_thread_id, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }).catch(console.error);

// Розбір повідомлення: VIN, назва авто, дата події, «сигнал» для визначення етапу.
function parseInfo(text) {
  const vin = (text.match(VIN_RE) || [])[0]?.toUpperCase();
  const lot = (text.match(LOT_RE) || [])[1];
  const title = (text.match(TITLE_RE) || [])[1]?.trim();
  const d = text.match(DATE_RE);
  const eventTs = d ? Date.UTC(+d[3], +d[2] - 1, +d[1], 9) : null; // дата з тексту (≈полудень за Києвом)
  // Для пошуку етапу прибираємо посилання, VIN, назву авто й «54 фото», щоб вони не давали хибних збігів
  const signal = text
    .replace(/https?:\/\/\S+/g, ' ').replace(new RegExp(VIN_RE.source, 'gi'), ' ')
    .replace(TITLE_RE, ' ').replace(/\d+\s*фото/gi, ' ').replace(/VIN:?/gi, ' ');
  return { vin, lot, title, eventTs, signal };
}

async function handleMessage(msg, env) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || msg.caption || '').trim();
  const ctxKey = `${chatId}:${msg.message_thread_id || 0}`;

  // /id працює скрізь — щоб дізнатися chat_id групи для ALLOWED_CHATS
  if (/^\/id(@\w+)?$/i.test(text)) return await reply(env, msg, `chat_id: ${chatId}`);

  const allowed = (env.ALLOWED_CHATS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(chatId)) return; // чужі чати ігноруємо

  if (text.startsWith('/')) return handleCommand(msg, text, ctxKey, env);

  // 1) до якого авто належить повідомлення
  const { vin, lot, title, eventTs, signal } = parseInfo(text);
  let code = null, groupEvent = null;

  if (vin) code = (await env.DB.prepare('SELECT code FROM cars WHERE vin = ?1').bind(vin).first())?.code;
  if (!code && lot) code = (await env.DB.prepare('SELECT code FROM cars WHERE lot = ?1').bind(lot).first())?.code;
  if (!code && (vin || lot)) code = await createCar(env, { vin, lot, title: title || (vin ? `VIN ${vin}` : `Лот ${lot}`) }, msg);
  if (!code && msg.media_group_id) {
    groupEvent = await env.DB.prepare('SELECT code, stage FROM events WHERE group_id = ?1 AND chat_id = ?2 LIMIT 1').bind(msg.media_group_id, chatId).first();
    code = groupEvent?.code;
  }
  if (!code && msg.reply_to_message) {
    code = (await env.DB.prepare('SELECT code FROM events WHERE chat_id = ?1 AND msg_id = ?2').bind(chatId, msg.reply_to_message.message_id).first())?.code;
  }
  if (!code) code = (await env.DB.prepare('SELECT code FROM ctx WHERE key = ?1').bind(ctxKey).first())?.code;
  if (!code) return; // не знаємо, чиє авто — ігноруємо
  await env.DB.prepare('INSERT INTO ctx (key, code) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET code = ?2').bind(ctxKey, code).run();
  // назва з повідомлення краща за заглушку «VIN …»
  if (title) await env.DB.prepare("UPDATE cars SET title = ?1 WHERE code = ?2 AND (title LIKE 'VIN %' OR title LIKE 'Лот %')").bind(title, code).run();

  // 2) який етап
  const photos = msg.photo?.length ? msg.photo : null;
  const photoId = photos ? photos[photos.length - 1].file_id : null;
  const thumbId = photos ? photos[Math.min(1, photos.length - 1)].file_id : null;
  let stage = detectStage(signal) || groupEvent?.stage;
  if (!stage && photoId) {
    // фото без підпису (наступні альбоми) — в етап останньої події цього авто
    stage = (await env.DB.prepare('SELECT stage FROM events WHERE code = ?1 ORDER BY id DESC LIMIT 1').bind(code).first())?.stage || 1;
  }
  if (!stage) return;

  // дата: з тексту («Розформування контейнера: 20.11.2026»), інакше — час повідомлення (для пересланих — оригіналу)
  const ts = eventTs || (msg.forward_origin?.date || msg.date) * 1000;
  await env.DB.prepare('INSERT OR IGNORE INTO events (code, stage, photo_id, thumb_id, ts, chat_id, msg_id, group_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
    .bind(code, stage, photoId, thumbId, ts, chatId, msg.message_id, msg.media_group_id || null).run();
}

function detectStage(text) {
  const tag = text.match(/#\s*(?:етап|этап|stage)?\s*([1-8])\b/i);
  if (tag) return +tag[1];
  // Якщо є «Статус: …» — вирішує він; інакше шукаємо слова в усьому тексті
  const status = (text.match(/Статус:?\s*([^\n]+)/i) || [])[1];
  const hay = status || text;
  let best = 0;
  for (const s of STAGES) if (s.re.test(hay)) best = s.id; // при кількох збігах — найдальший етап
  return best;
}

async function createCar(env, { vin, lot, title }, msg) {
  const code = newCode();
  await env.DB.prepare('INSERT INTO cars (code, vin, lot, title, created_at) VALUES (?1,?2,?3,?4,?5)')
    .bind(code, vin || null, lot || null, title, Date.now()).run();
  await reply(env, msg, `✅ Створено картку авто «${title}»\nПосилання для клієнта: ${clientLink(env, code)}`);
  return code;
}

/* ───────────── команди ───────────── */
async function handleCommand(msg, text, ctxKey, env) {
  const chatId = String(msg.chat.id);
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, '');
  const arg = rest.join(' ').trim();
  const cur = async () => (await env.DB.prepare('SELECT code FROM ctx WHERE key = ?1').bind(ctxKey).first())?.code;

  if (cmd === '/start' || cmd === '/help') {
    return await reply(env, msg,
      'Команди:\n/car VIN Назва авто — створити/перейменувати авто\n/link — посилання для клієнта\n/stage N — вручну додати етап (1–8)\n/undo — видалити останню подію\n/id — chat_id групи\n\n' +
      'Етапи:\n' + STAGES.map((s) => `${s.id}. ${s.title}`).join('\n'));
  }
  if (cmd === '/car') {
    const vin = (arg.match(VIN_RE) || [])[0]?.toUpperCase();
    const title = arg.replace(VIN_RE, '').trim() || (vin ? `VIN ${vin}` : '');
    if (!title) return await reply(env, msg, 'Формат: /car VIN Назва авто\nнапр.: /car 1HGCV1F30LA012345 Honda Accord 2020');
    let code = vin ? (await env.DB.prepare('SELECT code FROM cars WHERE vin = ?1').bind(vin).first())?.code : null;
    if (code) {
      await env.DB.prepare('UPDATE cars SET title = ?1 WHERE code = ?2').bind(title, code).run();
      await reply(env, msg, `✏️ Оновлено: «${title}»\n${clientLink(env, code)}`);
    } else {
      code = await createCar(env, { vin, lot: (arg.match(LOT_RE) || [])[1], title }, msg);
    }
    return void await env.DB.prepare('INSERT INTO ctx (key, code) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET code = ?2').bind(ctxKey, code).run();
  }
  const code = await cur();
  if (!code) return await reply(env, msg, 'Спершу вкажіть авто: /car VIN Назва або надішліть повідомлення з VIN.');
  if (cmd === '/link') {
    const car = await env.DB.prepare('SELECT title FROM cars WHERE code = ?1').bind(code).first();
    return await reply(env, msg, `${car?.title}\n${clientLink(env, code)}`);
  }
  if (cmd === '/stage') {
    const n = +arg;
    if (!(n >= 1 && n <= 8)) return await reply(env, msg, 'Формат: /stage 1…8');
    await env.DB.prepare('INSERT OR IGNORE INTO events (code, stage, photo_id, ts, chat_id, msg_id, group_id) VALUES (?1,?2,NULL,?3,?4,?5,NULL)')
      .bind(code, n, msg.date * 1000, chatId, msg.message_id).run();
    return await reply(env, msg, `✅ Етап ${n}: ${STAGES[n - 1].title}`);
  }
  if (cmd === '/undo') {
    const last = await env.DB.prepare('SELECT id, stage FROM events WHERE code = ?1 ORDER BY ts DESC, id DESC LIMIT 1').bind(code).first();
    if (!last) return await reply(env, msg, 'Подій немає.');
    await env.DB.prepare('DELETE FROM events WHERE id = ?1').bind(last.id).run();
    return await reply(env, msg, `↩️ Видалено останню подію (етап ${last.stage}).`);
  }
}
