// Urban Auto — трекер авто. Cloudflare Worker + D1.
//   POST /webhook            ← Telegram (повідомлення з групи → етапи й фото авто)
//   GET  /api/car/:code      → дані авто для кабінету клієнта
//   GET  /photo/:code/:id    → фото (Telegram-токен ніколи не потрапляє до клієнта)

// Етапи. Бот шукає в тексті повідомлення ключові слова (укр/рос/англ).
// Явно вказати етап можна й так: #етап3 або #3. Слова підлаштуємо під ваші реальні повідомлення.
// Повідомлення CargoPlus мають вигляд «📍 Статус: Розформований», «📅 Розформування контейнера: 20.11.2026»,
// «2015 FORD ESCAPE SE», «VIN: …». Статуси, яких я ще не бачив, треба додати сюди (regex на текст статусу).
const STAGES = [
  { id: 1, title: 'Викуплено з Аукціону',      re: /викуплен|выкуплен|куплен|призначен|назначен|won|bought|purchased/i },
  { id: 2, title: 'Отримання з аукціону',      re: /отриман|отримали|забра[лв]|вивез|вывез|pick.?up|picked/i },
  { id: 3, title: 'Доставка',                  re: /прийом|прием|автовоз|доставк|прямує|в дорозі|в дороге|в пути|транспорт|delivery/i },
  { id: 4, title: 'Майданчик',                 re: /майданчик|площадк|склад|yard|warehouse/i },
  { id: 5, title: 'Завантаження в контейнер',  re: /завантаж|погруз|loaded|в контейнер/i },
  { id: 6, title: 'Розформування контейнера',  re: /розформ|розвантаж|devan|unload/i },
];
const CONTAINER_RE = /номер\s+контейнер[а-яіїєґ]*\s*(?:№|#|:|-)?\s*([^\n]{3,40})/i;   // «Номер контейнера: ABCDEFG2299 (MAERSK)»
const ROUTE_RE = /маршрут\s*:\s*([^\n]{3,80})/i;   // «🧭 Маршрут: Лос-Анджелес (США) → Клайпеда (Литва)»
const ORDER_RE = /cargoplus\.pro\/cars\/order_(\d+)/i;   // «…/cars/order_20171» — номер замовлення CargoPlus (запасний ключ авто)
const BOOKING_RE = /(?:номер\s+)?(?:букінг[а-яіїєґ]*|booking)\s*(?:№|#|:|-)?\s*([^\n]{3,40})/i;

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
  const car = await env.DB.prepare('SELECT code, vin, lot, booking, container, route, title FROM cars WHERE code = ?1').bind(code).first();
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
  return json(env, { code: car.code, title: car.title, vin: car.vin, lot: car.lot, booking: car.booking, container: car.container, route: car.route, current, updated: updated || null, stages });
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
  const msg = update.message || update.channel_post || update.business_message; // business_message — режим «Секретар» (чат з ботом CargoPlus)
  if (msg && update.backfill) msg.__quiet = true; // імпорт історії (tools/backfill.mjs): без сповіщень у чат
  if (update.backfill_reset && msg) await env.DB.prepare("DELETE FROM ctx WHERE key LIKE ?1").bind(`${msg.chat.id}:%`).run(); // старт імпорту — без застарілого «поточного авто»
  if (msg) {
    try { await handleMessage(msg, env); } catch (e) { console.error('handleMessage', e); }
  }
  return new Response('ok'); // завжди 200, щоб Telegram не повторював «биті» повідомлення
}

const reply = (env, msg, text) => (msg.business_connection_id || msg.__quiet) ? null : // у чужому бізнес-чаті від імені бота нічого не пишемо
  tg(env, 'sendMessage', { chat_id: msg.chat.id, text, message_thread_id: msg.message_thread_id, // На повідомлення іншого бота — звичайне повідомлення, а не reply: так воно не адресоване йому й не запускає цикл бот↔бот
    ...(msg.from?.is_bot ? {} : { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }) }).catch(console.error);

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
    .replace(TITLE_RE, ' ').replace(/\d+\s*фото/gi, ' ').replace(/VIN:?/gi, ' ').replace(new RegExp(BOOKING_RE.source, 'gi'), ' ').replace(new RegExp(CONTAINER_RE.source, 'gi'), ' ').replace(new RegExp(ROUTE_RE.source, 'gi'), ' ');
  const booking = (text.match(BOOKING_RE) || [])[1]?.replace(/[\s.,;]+$/, '').trim() || null;
  const container = (text.match(CONTAINER_RE) || [])[1]?.replace(/[\s.,;]+$/, '').trim() || null;
  const orderId = (text.match(ORDER_RE) || [])[1] || null;
  const route = (text.match(ROUTE_RE) || [])[1]?.replace(/[\s.,;]+$/, '').trim() || null;
  const captionLabel = (text.match(/[A-HJ-NPR-Z0-9]{17}_([^\n]+)/i) || [])[1]?.trim() || null;   // «VIN_Видача з терміналу» → «Видача з терміналу»
  return { vin, lot, title, eventTs, signal, booking, container, orderId, route, captionLabel };
}

async function handleMessage(msg, env) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || msg.caption || '').trim();
  // Бізнес-чат (режим «Секретар»): беремо лише вхідні від співрозмовника, без команд
  if (msg.business_connection_id && (msg.from?.id !== msg.chat.id || text.startsWith('/'))) return;
  const ctxKey = `${chatId}:${msg.message_thread_id || 0}`;

  // /id працює скрізь — щоб дізнатися chat_id групи для ALLOWED_CHATS
  if (/^\/id(@\w+)?$/i.test(text)) return await reply(env, msg, `chat_id: ${chatId}`);

  const allowed = (env.ALLOWED_CHATS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(chatId)) return; // чужі чати ігноруємо

  if (text.startsWith('/')) {
    // Команди, адресовані іншим ботам (напр. /start@cargoplus_notify_bot), не наші — мовчимо
    const target = (text.match(/^\/\w+@(\w+)/) || [])[1];
    if (target && target.toLowerCase() !== (env.BOT_USERNAME || 'urbanauto_tracking_bot').toLowerCase()) return;
    return handleCommand(msg, text, ctxKey, env);
  }

  // 1) до якого авто належить повідомлення
  const { vin, lot, title, eventTs, signal, booking, container, orderId, route, captionLabel } = parseInfo(text);
  const photos = msg.photo?.length ? msg.photo : null;
  const photoId = photos ? photos[photos.length - 1].file_id : null;
  const thumbId = photos ? photos[Math.min(1, photos.length - 1)].file_id : null;
  const uid = photos ? photos[photos.length - 1].file_unique_id || null : null; // однакове фото, надіслане двічі, має однаковий uid
  // Є назва етапу (підпис «VIN_Назва» або рядок «Статус: Назва»), але в трекері такого етапу немає → повідомлення пропускаємо
  const statusLabel = (text.match(/Статус:?\s*([^\n]+)/i) || [])[1]?.trim() || null;
  const label = captionLabel || statusLabel;
  const tagged = /#\s*(?:етап|этап|stage)?\s*[1-9]\b/i.test(text);
  const unknownStage = !!label && !tagged && !detectStage(signal);
  const skipKey = `skip:${chatId}:${msg.message_thread_id || 0}`;
  // фото без підпису (продовження альбому) після пропущеного етапу — теж пропускаємо, щоб не потрапили в попередній етап
  if (photoId && !text && !unknownStage) {
    const sk = await env.DB.prepare('SELECT code FROM ctx WHERE key = ?1').bind(skipKey).first();
    if (sk && Date.now() - Number(sk.code) < 10 * 60 * 1000) return;
  }
  let code = null, groupEvent = null, created = false;

  // Спершу шукаємо вже існуючу картку (VIN → номер замовлення CargoPlus → лот): нову створюємо лише якщо такої немає
  if (vin) code = (await env.DB.prepare('SELECT code FROM cars WHERE vin = ?1').bind(vin).first())?.code;
  if (!code && orderId) code = (await env.DB.prepare('SELECT code FROM cars WHERE order_id = ?1').bind(orderId).first())?.code;
  if (!code && lot) code = (await env.DB.prepare('SELECT code FROM cars WHERE lot = ?1').bind(lot).first())?.code;
  if (!code && (vin || lot) && !unknownStage) {
    ({ code, created } = await createCar(env, { vin, lot, orderId, title: title || (vin ? `VIN ${vin}` : `Лот ${lot}`) }));
  }
  if (code && !created) {
    // дозаповнюємо відсутні дані існуючої картки (VIN/лот/номер замовлення), нічого не перезаписуючи
    await env.DB.prepare('UPDATE cars SET vin = COALESCE(vin, ?1), lot = COALESCE(lot, ?2), order_id = COALESCE(order_id, ?3) WHERE code = ?4')
      .bind(vin || null, lot || null, orderId, code).run().catch(() => {}); // UNIQUE(vin) може збігтися з іншою карткою — тоді просто пропускаємо
  }
  if (!code && msg.media_group_id) {
    groupEvent = await env.DB.prepare('SELECT code, stage FROM events WHERE group_id = ?1 AND chat_id = ?2 LIMIT 1').bind(msg.media_group_id, chatId).first();
    code = groupEvent?.code;
  }
  if (!code && msg.reply_to_message) {
    code = (await env.DB.prepare('SELECT code FROM events WHERE chat_id = ?1 AND msg_id = ?2').bind(chatId, msg.reply_to_message.message_id).first())?.code;
  }
  if (!code) code = (await env.DB.prepare('SELECT code FROM ctx WHERE key = ?1').bind(ctxKey).first())?.code;
  if (!code && photoId && !unknownStage) code = await bufferPhoto(env, msg, chatId, ctxKey, photoId, thumbId, uid);
  if (unknownStage) {
    // пропускаємо: нічого не зберігаємо (окрім букінга/контейнера/маршруту, якщо вони є), пишемо в групу, що такого етапу немає
    await env.DB.prepare('INSERT INTO ctx (key, code) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET code = ?2').bind(skipKey, String(Date.now())).run();
    if (code) {
      if (booking) await env.DB.prepare('UPDATE cars SET booking = ?1 WHERE code = ?2').bind(booking, code).run();
      if (container) await env.DB.prepare('UPDATE cars SET container = ?1 WHERE code = ?2').bind(container, code).run();
      if (route) await env.DB.prepare('UPDATE cars SET route = ?1 WHERE code = ?2').bind(route, code).run();
    }
    const car = code ? await env.DB.prepare('SELECT title, vin FROM cars WHERE code = ?1').bind(code).first() : null;
    await reply(env, msg, [`⚠️ Етапу «${label}» у трекері немає — повідомлення пропущено.`, car ? `🚗 ${car.title}${car.vin ? ` (VIN ${car.vin})` : ''}` : null,
      'Доступні етапи: ' + STAGES.map((st) => `${st.id}. ${st.title}`).join('; ')].filter(Boolean).join('\n'));
    return;
  }
  if (!code) return; // не знаємо, чиє авто — ігноруємо
  await env.DB.prepare('INSERT INTO ctx (key, code) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET code = ?2').bind(ctxKey, code).run();
  // назва з повідомлення краща за заглушку «VIN …»
  if (title) await env.DB.prepare("UPDATE cars SET title = ?1 WHERE code = ?2 AND (title LIKE 'VIN %' OR title LIKE 'Лот %')").bind(title, code).run();
  // букінг (номер/текст після слова «Букінг» або «Booking»)
  if (booking) await env.DB.prepare('UPDATE cars SET booking = ?1 WHERE code = ?2').bind(booking, code).run();
  if (container) await env.DB.prepare('UPDATE cars SET container = ?1 WHERE code = ?2').bind(container, code).run();
  if (route) await env.DB.prepare('UPDATE cars SET route = ?1 WHERE code = ?2').bind(route, code).run();

  // 2) який етап
  let stage = detectStage(signal) || groupEvent?.stage;
  if (detectStage(signal)) await env.DB.prepare('DELETE FROM ctx WHERE key = ?1').bind(skipKey).run(); // відомий етап — пропуск закінчено
  if (!stage && photoId) {
    // фото без підпису (наступні альбоми) — в етап останнього фото-альбому цього авто: продовження альбому належить йому,
    // а не статусу з окремого тексту. Якщо фото-альбомів ще немає — тримаємо в буфері до підписаного альбому.
    stage = (await env.DB.prepare('SELECT stage FROM events WHERE code = ?1 AND photo_id IS NOT NULL ORDER BY id DESC LIMIT 1').bind(code).first())?.stage;
    if (!stage) return void await bufferPhoto(env, msg, chatId, ctxKey, photoId, thumbId, uid);
  }

  // дата: з тексту («Розформування контейнера: 20.11.2026»), інакше — час повідомлення (для пересланих — оригіналу)
  const ts = eventTs || (msg.forward_origin?.date || msg.date) * 1000;
  let added = false;
  if (stage) {
    // те саме фото в цьому ЕТАПІ цього авто вже є (переслали двічі) — не дублюємо. Те саме зображення в іншому етапі — окремий запис
    const dup = uid ? await env.DB.prepare('SELECT 1 AS x FROM events WHERE code = ?1 AND uid = ?2 AND stage = ?3').bind(code, uid, stage).first() : null;
    if (!dup) {
      const r = await env.DB.prepare('INSERT OR IGNORE INTO events (code, stage, photo_id, thumb_id, uid, ts, chat_id, msg_id, group_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)')
        .bind(code, stage, photoId, thumbId, uid, ts, chatId, msg.message_id, msg.media_group_id || null).run();
      added = !!r.meta?.changes;
    }
    // Повідомлення з VIN/лотом «забирає» фото, що прийшли трохи раніше й чекали в буфері (пересилання йде паралельно)
    if ((vin || lot) && photoId) { // забирає лише підписаний альбом: фото належать його етапу, а не статусу з окремого тексту
      await env.DB.prepare("UPDATE events SET code = ?1, stage = ?2 WHERE code = '' AND chat_id = ?3 AND recv >= ?4")
        .bind(code, stage, chatId, Date.now() - 10 * 60 * 1000).run();
      await dedupePhotos(env, code);
    }
  }

  // 3) сповіщення в чат: що саме додано. Фото-альбом без підпису мовчки дописується в етап (щоб не було десятків відповідей).
  const silentPhoto = photoId && msg.media_group_id && !text;
  if (silentPhoto) return;
  const info = booking || container || route;
  if (!stage && !info && !created && !(vin || lot)) return;
  if (stage && !added && !created && !info) return; // дубль того, що вже збережено
  await notify(env, msg, { code, created, stage, ts, booking, container, route, photoId, unrecognized: !stage && !info && (vin || lot) });
}

const fmtDate = (ts) => new Date(ts).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' });

async function notify(env, msg, { code, created, stage, ts, booking, container, route, photoId, unrecognized }) {
  const car = await env.DB.prepare('SELECT title, vin, lot, booking FROM cars WHERE code = ?1').bind(code).first();
  const lines = [created ? '🆕 Створено картку авто' : '✅ Додано в трекер', `🚗 ${car.title}`];
  if (car.vin) lines.push(`VIN: ${car.vin}`);
  if (stage) {
    lines.push(`📍 Етап ${stage}/${STAGES.length}: ${STAGES[stage - 1].title}`);
    // Пізнє фото ранішого етапу лише підвантажується в свій етап — поточний етап авто не змінюється
    const cur = (await env.DB.prepare('SELECT MAX(stage) AS m FROM events WHERE code = ?1 AND ts <= ?2').bind(code, Date.now()).first())?.m || 0;
    if (cur > stage) lines.push(`↩️ Додано до раніших етапів, поточний етап не змінено: ${cur}/${STAGES.length} (${STAGES[cur - 1].title})`);
    lines.push(`📅 ${ts > Date.now() ? 'заплановано на ' : ''}${fmtDate(ts)}`);
    if (photoId) {
      const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE code = ?1 AND stage = ?2 AND photo_id IS NOT NULL').bind(code, stage).first())?.n;
      lines.push(`📷 Фото в етапі: ${n}`);
    }
  }
  if (route) lines.push(`🧭 Маршрут: ${route}`);
  if (container) lines.push(`📦 Контейнер: ${container}`);
  if (booking) lines.push(`🗒️ Букінг: ${booking}`);
  if (unrecognized) lines.push('⚠️ Етап у повідомленні не розпізнано — додайте вручну: /stage 1…' + STAGES.length);
  lines.push(`🔗 ${clientLink(env, code)}`);
  await reply(env, msg, lines.join('\n'));
}

// Прибирає дублі фото в межах етапу однієї картки (однакові file_unique_id) — лишається найраніше збережене
async function dedupePhotos(env, code) {
  await env.DB.prepare('DELETE FROM events WHERE code = ?1 AND uid IS NOT NULL AND id NOT IN (SELECT MIN(id) FROM events WHERE code = ?1 AND uid IS NOT NULL GROUP BY uid, stage)').bind(code).run();
}

// Фото без підпису прийшло раніше, ніж ми дізналися, чиє авто: зберігаємо в буфері (code = '').
// Після вставки перевіряємо контекст ще раз — він міг з'явитися, поки ми писали в базу.
async function bufferPhoto(env, msg, chatId, ctxKey, photoId, thumbId, uid) {
  const ts = (msg.forward_origin?.date || msg.date) * 1000;
  await env.DB.prepare("INSERT OR IGNORE INTO events (code, stage, photo_id, thumb_id, uid, ts, chat_id, msg_id, group_id, recv) VALUES ('',0,?1,?2,?8,?3,?4,?5,?6,?7)")
    .bind(photoId, thumbId, ts, chatId, msg.message_id, msg.media_group_id || null, Date.now(), uid).run();
  const code = (await env.DB.prepare('SELECT code FROM ctx WHERE key = ?1').bind(ctxKey).first())?.code;
  if (!code) return null;
  const stage = (await env.DB.prepare("SELECT stage FROM events WHERE code = ?1 AND photo_id IS NOT NULL ORDER BY id DESC LIMIT 1").bind(code).first())?.stage;
  // У авто ще немає жодного фото-етапу — лишаємо в буфері, його забере підписаний альбом
  if (stage) {
    await env.DB.prepare("UPDATE events SET code = ?1, stage = ?2 WHERE code = '' AND chat_id = ?3 AND msg_id = ?4").bind(code, stage, chatId, msg.message_id).run();
    await dedupePhotos(env, code);
  }
  return null; // фото вже збережено; далі обробляти нічого
}

function detectStage(text) {
  const tag = text.match(/#\s*(?:етап|этап|stage)?\s*([1-9])\b/i);
  if (tag && +tag[1] <= STAGES.length) return +tag[1];
  // Якщо є «Статус: …» — вирішує він; інакше шукаємо слова в усьому тексті
  const status = (text.match(/Статус:?\s*([^\n]+)/i) || [])[1];
  const hay = status || text;
  let best = 0;
  for (const s of STAGES) if (s.re.test(hay)) best = s.id; // при кількох збігах — найдальший етап
  return best;
}

async function createCar(env, { vin, lot, orderId, title }) {
  const code = newCode();
  const r = await env.DB.prepare('INSERT OR IGNORE INTO cars (code, vin, lot, order_id, title, created_at) VALUES (?1,?2,?3,?4,?5,?6)')
    .bind(code, vin || null, lot || null, orderId || null, title, Date.now()).run();
  if (!r.meta?.changes) {
    // паралельне повідомлення з тим самим VIN уже створило картку — беремо її
    const row = vin ? await env.DB.prepare('SELECT code FROM cars WHERE vin = ?1').bind(vin).first() : null;
    if (row) return { code: row.code, created: false };
    throw new Error('createCar: insert ignored, car not found');
  }
  return { code, created: true };
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
      'Команди:\n/car VIN Назва авто — створити/перейменувати авто\n/link — посилання для клієнта\n/stage N — вручну додати етап (1–6)\n/undo — видалити останню подію\n/id — chat_id групи\n\n' +
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
      const c = await createCar(env, { vin, lot: (arg.match(LOT_RE) || [])[1], title });
      code = c.code;
      await reply(env, msg, `✅ Створено картку авто «${title}»\nПосилання для клієнта: ${clientLink(env, code)}`);
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
    if (!(n >= 1 && n <= STAGES.length)) return await reply(env, msg, `Формат: /stage 1…${STAGES.length}`);
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
