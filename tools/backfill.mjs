// Імпорт історії групи в трекер (одноразово або повторно — дублів не буде).
//
// Telegram не дає боту читати історію групи напряму, тому кожне повідомлення (за номером) пересилається
// ботом власнику в особистий чат — у відповіді Telegram повертає повний вміст разом з file_id фото — і
// одразу видаляється. Далі повідомлення передається воркеру як звичайне оновлення (без сповіщень у групу).
// Дублі відсікає UNIQUE(chat_id, msg_id), тому повторний запуск безпечний.
//
// Запуск:  node tools/backfill.mjs [від] [до]
//   потрібні BOT_TOKEN і WEBHOOK_SECRET (беруться з worker/.secrets.env), GROUP_ID, OWNER_ID, WORKER_URL.
import fs from 'node:fs';

const env = Object.fromEntries(fs.readFileSync(new URL('../worker/.secrets.env', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BOT_TOKEN = env.BOT_TOKEN, SECRET = env.WEBHOOK_SECRET;
const WORKER = process.env.WORKER_URL || 'https://urban-auto-tracking.urbanauto66.workers.dev';
const GROUP = Number(process.env.GROUP_ID || -1004492547641);   // група з авто
const OWNER = Number(process.env.OWNER_ID || 602387747);        // особистий чат власника (сюди тимчасово пересилаємо)
const BOT_ID = Number(BOT_TOKEN.split(':')[0]);
const from = +process.argv[2] || 1, to = +process.argv[3] || 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tg(method, body) {
  for (;;) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.ok) return j.result;
    if (j.error_code === 429) { await sleep((j.parameters?.retry_after || 5) * 1000 + 500); continue; }
    return { error: j.description };
  }
}

let ok = 0, skipped = 0, missing = 0, miss = 0;
for (let id = from; id <= to; id++) {
  const f = await tg('forwardMessage', { chat_id: OWNER, from_chat_id: GROUP, message_id: id });
  if (f.error) { missing++; miss++; if (miss > 30 && id > 300) break; continue; }
  miss = 0;
  await tg('deleteMessage', { chat_id: OWNER, message_id: f.message_id });          // прибираємо тимчасову копію

  const origin = f.forward_origin || {};
  const senderId = origin.sender_user?.id;
  const text = f.text || f.caption || '';
  // пропускаємо власні повідомлення бота та набране вручну власником (команди, тести); пересилання власника мають origin = CargoPlus
  if (senderId === BOT_ID || senderId === OWNER || text.startsWith('/')) { skipped++; continue; }

  const update = {
    update_id: 8_000_000 + id, backfill: true,
    message: {
      message_id: id, date: origin.date || f.date, chat: { id: GROUP, type: 'supergroup' },
      from: { id: senderId || 0, is_bot: true }, text: f.text, caption: f.caption, photo: f.photo,
      media_group_id: f.media_group_id, forward_origin: { date: origin.date || f.date },
    },
  };
  const r = await fetch(`${WORKER}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify(update) });
  if (r.status !== 200) console.log('worker', id, r.status);
  ok++;
  if (id % 25 === 0) console.log(`… id ${id}: передано ${ok}, пропущено ${skipped}, відсутні ${missing}`);
  await sleep(300);
}
console.log(`Готово: передано воркеру ${ok}, пропущено ${skipped}, відсутні/службові ${missing}`);
