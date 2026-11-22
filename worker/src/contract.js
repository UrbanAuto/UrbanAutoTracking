// Договори: бот приймає дані клієнта, підставляє їх у Word-шаблон, конвертує в PDF (CloudConvert) і надсилає назад.
// Шаблон зберігається в D1 (kv.contract_template, base64) — не в репозиторії. Персональні дані шифруються (AES-GCM, CONTRACT_KEY).
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const MALE_A = new Set(['микита', 'лука', 'сава', 'кузьма', 'хома', 'фома', 'ілля', 'гаврила', 'данила', 'мирона']);
const BLANK = '_______________';
const FIELD_NAMES = { name: 'ПІБ', taxId: 'РНОКПП', address: 'Адреса', phone: 'Телефон' };
const DRAFT_TTL = 24 * 3600 * 1000;
const retentionMs = (env) => (+env.CONTRACT_RETENTION_HOURS || 24) * 3600 * 1000;

/* ───────────── розбір даних клієнта ───────────── */
const LABELS = [
  ['name', /^(?:піб|п\.?\s?і\.?\s?б\.?|фіо|ф\.?\s?і\.?\s?о\.?|прізвище(?:,?\s*ім['’ʼ]я(?:,?\s*по\s*батькові)?)?|name)\s*[:\-–—=]\s*(.*)$/i],
  ['taxId', /^(?:рнокпп|ірнокпп|іпн|інн|ідентифікаційний\s+код|податковий\s+номер|код)\s*[:\-–—=]\s*(.*)$/i],
  ['address', /^(?:адреса(?:\s+реєстрації)?|місце\s+реєстрації|address)\s*[:\-–—=]\s*(.*)$/i],
  ['phone', /^(?:тел(?:ефон)?\.?|моб(?:ільний)?\.?|phone)\s*[:\-–—=]\s*(.*)$/i],
];
const NAME_WORD = "[А-ЯІЇЄҐA-Z][а-яіїєґa-z'’ʼ-]+";

export function validTaxId(s) {
  if (!/^\d{10}$/.test(s)) return false;
  const w = [-1, 5, 7, 9, 4, 6, 10, 5, 7];
  let sum = 0; for (let i = 0; i < 9; i++) sum += +s[i] * w[i];
  return (((sum % 11) + 11) % 11) % 10 === +s[9];
}

export function normalizePhone(s) {
  let d = String(s).replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('0')) d = '38' + d;
  if (d.length === 12 && d.startsWith('380')) return '+' + d;
  return null;
}

const capWord = (w) => w.split('-').map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p)).join('-');

const VALIDATORS = {
  name(v) {
    const w = v.replace(/\s+/g, ' ').trim().split(' ');
    if (w.length < 2 || w.length > 4 || !w.every((x) => /^[A-Za-zА-ЯІЇЄҐа-яіїєґ'’ʼ-]{2,}$/.test(x))) return { error: 'потрібно «Прізвище Ім’я По батькові» (літерами)' };
    return { value: w.map(capWord).join(' ') };
  },
  taxId(v) {
    const d = v.replace(/\D/g, '');
    if (d.length !== 10) return { error: 'має бути 10 цифр' };
    if (!validTaxId(d)) return { error: 'не збігається контрольна цифра — перевірте номер' };
    return { value: d };
  },
  address(v) {
    const a = v.replace(/\s+/g, ' ').trim();
    return a.length < 8 || a.length > 250 ? { error: 'надто коротка або задовга адреса' } : { value: a };
  },
  phone(v) {
    const p = normalizePhone(v);
    return p ? { value: p } : { error: 'формат +380XXXXXXXXX або 0XXXXXXXXX' };
  },
};

/** Розбирає повідомлення → { fields, errors, recognized }. Рядки «Поле: значення» мають пріоритет, решту намагаємось розпізнати за виглядом. */
export function parseClientData(text) {
  const raw = {}; let current = null;
  for (const line0 of String(text).split(/\r?\n/)) {
    const line = line0.trim(); if (!line) continue;
    let hit = null;
    for (const [f, re] of LABELS) { const m = line.match(re); if (m) { hit = [f, m[1].trim()]; break; } }
    if (hit) { current = hit[0]; raw[current] = hit[1]; continue; }
    if (current === 'address') { raw.address = (raw.address + ' ' + line).trim(); continue; }   // адреса може займати кілька рядків
    // без підпису: розпізнаємо за виглядом
    const digits = line.replace(/\D/g, '');
    const phoneLike = /^[+\d()\s-]{9,20}$/.test(line) && normalizePhone(line) && (line.startsWith('+') || /[\s()-]/.test(line) || digits.startsWith('0') || digits.length === 12);
    if (phoneLike) raw.phone = line;                                  // РНОКПП ніколи не починається з 0, тому 0XXXXXXXXX — це телефон
    else if (/^\d{10}$/.test(line)) raw.taxId = line;
    else if (new RegExp(`^${NAME_WORD}(?:\\s+${NAME_WORD}){1,3}$`).test(line)) raw.name = line;
    else if (/(?:^|\s)(?:м\.|місто|вул\.|вулиця|просп\.|пров\.|буд\.|обл\.|кв\.)/i.test(line)) raw.address = line;
  }
  const fields = {}, errors = [];
  for (const [f, v] of Object.entries(raw)) {
    if (!v) { errors.push({ field: f, message: 'порожнє значення' }); continue; }
    const r = VALIDATORS[f](v);
    if (r.error) errors.push({ field: f, message: r.error }); else fields[f] = r.value;
  }
  return { fields, errors, recognized: Object.keys(raw).length > 0 };
}

/* ───────────── стать, дата, значення для шаблону ───────────── */
export function detectGender(name) {
  const p = name.split(' '), pat = (p[2] || '').toLowerCase();
  if (/(ович|евич|йович|ич)$/.test(pat)) return 'm';
  if (/(івна|ївна|овна|евна|ічна)$/.test(pat)) return 'f';
  if (p.length >= 2) { const first = p[1].toLowerCase(); if (MALE_A.has(first)) return 'm'; return /[ая]$/.test(first) ? 'f' : 'm'; }
  return null;
}

export function shortName(name) {
  const p = name.split(' ');
  return p[0] + p.slice(1, 3).map((x, i) => (i === 0 ? ' ' : '') + x[0].toUpperCase() + '.').join('');
}

export function kyivDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { day: parts.day, month: MONTHS[+parts.month - 1], year: parts.year };
}

export function buildValues(fields, number, env, now = new Date()) {
  const d = kyivDate(now); const g = fields.name ? detectGender(fields.name) : null;
  return {
    CONTRACT_NO: String(number), DAY: d.day, MONTH: d.month, YEAR: d.year, VALID_UNTIL: env.CONTRACT_VALID_UNTIL || '31.12.2027',
    CLIENT_TITLE: g === 'f' ? 'Громадянка' : g === 'm' ? 'Громадянин' : 'Громадянин(ка)',
    CLIENT_WHICH: g === 'f' ? 'якої' : g === 'm' ? 'якого' : 'якого/якої',
    CLIENT_NAME: fields.name || BLANK, CLIENT_SHORT: fields.name ? shortName(fields.name) : BLANK,
    CLIENT_TAX_ID: fields.taxId || BLANK, CLIENT_ADDRESS: fields.address || BLANK, CLIENT_PHONE: fields.phone || BLANK,
  };
}

/* ───────────── Word-шаблон ───────────── */
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function fillDocx(templateBytes, values) {
  const files = unzipSync(templateBytes);
  let xml = strFromU8(files['word/document.xml']);
  for (const [k, v] of Object.entries(values)) xml = xml.split(`{{${k}}}`).join(xmlEscape(v));
  const left = xml.match(/\{\{[A-Z_]+\}\}/g);
  if (left) throw new Error('Не підставлено мітки: ' + [...new Set(left)].join(', '));
  files['word/document.xml'] = strToU8(xml);
  return zipSync(files, { level: 6 });
}

/* ───────────── шифрування персональних даних ───────────── */
async function aesKey(env) {
  if (!env.CONTRACT_KEY) throw new Error('Не налаштовано CONTRACT_KEY (ключ шифрування)');
  return crypto.subtle.importKey('raw', unb64(env.CONTRACT_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptJson(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), strToU8(JSON.stringify(obj))));
  return b64(iv) + '.' + b64(ct);
}
export async function decryptJson(env, s) {
  const [iv, ct] = s.split('.');
  return JSON.parse(strFromU8(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct)))));
}

/* ───────────── CloudConvert: docx → pdf ───────────── */
export async function convertToPdf(env, docxBytes) {
  if (!env.CLOUDCONVERT_API_KEY) throw new Error('Не налаштовано CLOUDCONVERT_API_KEY');
  const r = await fetch('https://sync.api.cloudconvert.com/v2/jobs', {
    method: 'POST', headers: { authorization: 'Bearer ' + env.CLOUDCONVERT_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: {
      'import-1': { operation: 'import/base64', file: b64(docxBytes), filename: 'contract.docx' },
      'convert-1': { operation: 'convert', input: 'import-1', input_format: 'docx', output_format: 'pdf' },
      'export-1': { operation: 'export/url', input: 'convert-1' },
    } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`CloudConvert ${r.status}: ${j.message || 'помилка'}`);
  const tasks = j.data?.tasks || [];
  const bad = tasks.find((t) => t.status === 'error');
  if (bad) throw new Error('CloudConvert: ' + (bad.message || bad.code || 'помилка конвертації'));
  const url = tasks.find((t) => t.name === 'export-1')?.result?.files?.[0]?.url;
  if (!url) throw new Error('CloudConvert: файл не отримано (спробуйте /pdf ще раз)');
  const f = await fetch(url);
  if (!f.ok) throw new Error('CloudConvert: не вдалося завантажити PDF');
  return new Uint8Array(await f.arrayBuffer());
}

/* ───────────── Telegram ───────────── */
async function tgJson(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ ok: false }));
}
const say = (env, chatId, text) => tgJson(env, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });

async function sendDocument(env, chatId, bytes, filename, caption, mime) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId)); fd.append('caption', caption.slice(0, 1000));
  fd.append('document', new Blob([bytes], { type: mime }), filename);
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) throw new Error('Telegram sendDocument: ' + (j.description || r.status));
  return j.result?.document?.file_id || null;
}

/* ───────────── робота з договорами ───────────── */
const isAllowed = (msg, env) => msg.chat?.type === 'private' && String(env.CONTRACT_USERS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(String(msg.from?.id));
const CMD = /^\/(договір|договiр|contract|договори|contracts|pdf|завершити|done|delcontract)(?:@\w+)?(?:\s+(.*))?$/is;

async function getTemplate(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'contract_template'").first();
  if (!row) throw new Error('Шаблон договору ще не завантажено в базу (tools/upload_template.mjs)');
  return unb64(row.v);
}

const stamp = (ts) => new Date(ts).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' });

async function loadContract(env, number) {
  const row = await env.DB.prepare('SELECT * FROM contracts WHERE number = ?1').bind(number).first();
  return row ? { ...row, fields: await decryptJson(env, row.data) } : null;
}

async function setDraft(env, chatId, number) {
  if (number == null) return env.DB.prepare('DELETE FROM kv WHERE k = ?1').bind(`cdraft:${chatId}`).run();
  return env.DB.prepare('INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2').bind(`cdraft:${chatId}`, JSON.stringify({ number, ts: Date.now() })).run();
}
async function getDraft(env, chatId) {
  const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?1').bind(`cdraft:${chatId}`).first();
  if (!r) return null; const d = JSON.parse(r.v);
  return Date.now() - d.ts < DRAFT_TTL ? d : null;
}

function statusLines(c) {
  const have = Object.keys(FIELD_NAMES).filter((k) => c.fields[k]), miss = Object.keys(FIELD_NAMES).filter((k) => !c.fields[k]);
  return { have, miss, text: miss.length ? '📝 Не вистачає: ' + miss.map((k) => FIELD_NAMES[k]).join(', ') : '✅ Усі дані внесено — договір готовий до підпису' };
}

/** Створює (або оновлює) PDF і надсилає його. note — текст зверху підпису. */
async function renderAndSend(env, chatId, c, note) {
  await tgJson(env, 'sendChatAction', { chat_id: chatId, action: 'upload_document' });
  const version = c.version + 1;
  const docx = fillDocx(await getTemplate(env), buildValues(c.fields, c.number, env));
  const st = statusLines(c);
  const caption = `${note ? note + '\n' : ''}📎 Договір №${c.number} · версія ${version}\n${st.text}\n🔒 Дані клієнта видаляться з бази за ${+env.CONTRACT_RETENTION_HOURS || 24} год. або після /завершити; PDF лишається в цьому чаті.`;
  let fileId, sentAs = 'pdf';
  try {
    const pdf = await convertToPdf(env, docx);
    fileId = await sendDocument(env, chatId, pdf, `Договір_${c.number}_v${version}.pdf`, caption, 'application/pdf');
  } catch (e) {
    console.error('pdf', String(e).slice(0, 200));
    // PDF не вдалося — не залишаємо без результату: надсилаємо Word і пояснюємо
    sentAs = 'docx';
    fileId = await sendDocument(env, chatId, docx, `Договір_${c.number}_v${version}.docx`, `${caption}\n⚠️ PDF зараз не вдалося створити (${String(e.message || e).slice(0, 120)}). Надсилаю Word. Спробуйте /pdf пізніше.`,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }
  await env.DB.prepare('UPDATE contracts SET version = ?1, last_file_id = ?2, updated_at = ?3 WHERE number = ?4').bind(version, sentAs === 'pdf' ? fileId : null, Date.now(), c.number).run();
}

async function newContract(env, msg) {
  const n = (await env.DB.prepare("UPDATE kv SET v = CAST(v AS INTEGER) + 1 WHERE k = 'contract_counter' RETURNING v").first())?.v;
  if (!n) throw new Error('Не налаштовано лічильник договорів');
  const number = +n;
  await env.DB.prepare('INSERT INTO contracts (number, data, version, owner_id, created_at, updated_at) VALUES (?1,?2,0,?3,?4,?4)').bind(number, await encryptJson(env, {}), String(msg.from.id), Date.now()).run();
  await setDraft(env, msg.chat.id, number);
  return number;
}

const HELP = (n) => `📄 Створено договір №${n} (чернетка).
Надсилайте дані клієнта — можна частинами й у будь-якому порядку:
• ПІБ: Іваненко Іван Іванович
• РНОКПП: 1234567890
• Адреса: м. Київ, вул. Хрещатик, 1, кв. 2
• Телефон: +380501234567
Після кожного повідомлення я оновлю договір і надішлю PDF (нова версія).
/pdf — створити ще раз · /завершити — закінчити · /договори — список`;

/** Повертає true, якщо повідомлення оброблено як договірне. Важка частина виконується у ctx.waitUntil. */
export async function handleContract(msg, env, ctx) {
  const text = (msg.text || '').trim();
  const cmd = text.match(CMD);
  if (cmd && !isAllowed(msg, env)) {
    if (msg.chat?.type !== 'private') await say(env, msg.chat.id, 'Договори створюються лише в особистому чаті з ботом.');
    return true;                                   // чужим — мовчки/відмова, у загальну логіку не віддаємо
  }
  if (!isAllowed(msg, env)) return false;
  const chatId = msg.chat.id;
  const run = (p) => { ctx.waitUntil(p.catch(async (e) => { console.error('contract', String(e).slice(0, 200)); await say(env, chatId, '⚠️ ' + String(e.message || e).slice(0, 300)).catch(() => {}); })); return true; };

  if (cmd) {
    const name = cmd[1].toLowerCase(), arg = (cmd[2] || '').trim();
    if (['договір', 'договiр', 'contract'].includes(name)) {
      if (!arg) return run((async () => { const n = await newContract(env, msg); await say(env, chatId, HELP(n)); })());
      const n = +arg.replace(/\D/g, '');
      return run((async () => {
        const c = await loadContract(env, n);
        if (!c) return void await say(env, chatId, `Договору №${n} не знайдено.`);
        await setDraft(env, chatId, n);
        const st = statusLines(c);
        const gone = c.purged_at ? '\n🔒 Дані клієнта вже видалено з бази — PDF вище лишився в чаті. Для нової версії надішліть усі дані знову.' : '';
        if (c.last_file_id) await tgJson(env, 'sendDocument', { chat_id: chatId, document: c.last_file_id, caption: `📎 Договір №${n} · версія ${c.version}\n${c.purged_at ? '' : st.text + '\n'}Надсилайте нові дані, щоб оновити.${gone}` });
        else await say(env, chatId, `Відкрито договір №${n}. ${c.purged_at ? '' : st.text}\nНадсилайте дані або /pdf.${gone}`);
      })());
    }
    if (name === 'договори' || name === 'contracts') {
      return run((async () => {
        const { results } = await env.DB.prepare('SELECT number, data, version, updated_at, purged_at FROM contracts ORDER BY number DESC LIMIT 10').all();
        if (!results.length) return void await say(env, chatId, 'Договорів ще немає. /договір — створити.');
        const lines = [];
        for (const r of results) { const f = await decryptJson(env, r.data).catch(() => ({})); lines.push(`№${r.number} · ${f.name ? shortName(f.name) : r.purged_at ? '🔒 дані видалено' : '— без ПІБ —'} · v${r.version} · ${stamp(r.updated_at)}`); }
        await say(env, chatId, '📚 Останні договори:\n' + lines.join('\n') + '\n\nВідкрити: /договір 656');
      })());
    }
    if (name === 'завершити' || name === 'done') {
      return run((async () => { const d = await getDraft(env, chatId); await setDraft(env, chatId, null); if (d) await purgeContract(env, d.number); await say(env, chatId, d ? `Готово. Дані клієнта по договору №${d.number} видалено з бази, PDF лишився в цьому чаті. Щоб оновити договір пізніше — /договір ${d.number} і надішліть дані знову.` : 'Активного договору немає.'); })());
    }
    if (name === 'pdf') {
      return run((async () => {
        const d = await getDraft(env, chatId); if (!d) return void await say(env, chatId, 'Немає активного договору. /договір — створити.');
        await renderAndSend(env, chatId, await loadContract(env, d.number), '');
      })());
    }
    if (name === 'delcontract') {
      return run((async () => {
        const [num, ok] = arg.split(/\s+/); const n = +num;
        if (!n) return void await say(env, chatId, 'Формат: /delcontract 656');
        if (!/^(так|yes)$/i.test(ok || '')) return void await say(env, chatId, `Щоб остаточно видалити договір №${n} разом з даними клієнта, надішліть: /delcontract ${n} так`);
        const r = await env.DB.prepare('DELETE FROM contracts WHERE number = ?1').bind(n).run();
        await env.DB.prepare('DELETE FROM kv WHERE k LIKE ?1 AND v LIKE ?2').bind('cdraft:%', `{"number":${n},%`).run();
        await say(env, chatId, r.meta?.changes ? `🗑 Договір №${n} видалено.` : `Договору №${n} не знайдено.`);
      })());
    }
  }

  // звичайне повідомлення: якщо є активна чернетка — це дані клієнта
  if (!text || msg.forward_origin || /cargoplus\.pro|VIN/i.test(text)) return false;
  const d = await getDraft(env, chatId); if (!d) return false;
  const parsed = parseClientData(text);
  if (!parsed.recognized) return false;
  return run((async () => {
    const c = await loadContract(env, d.number);
    if (!c) return void await say(env, chatId, 'Договір не знайдено — створіть новий: /договір');
    if (msg.message_id <= (c.last_msg || 0)) return;                       // повторна доставка того самого повідомлення
    const changed = Object.entries(parsed.fields).filter(([k, v]) => c.fields[k] !== v);
    const lines = [];
    if (changed.length) lines.push('✅ Внесено: ' + changed.map(([k]) => FIELD_NAMES[k]).join(', '));
    for (const e of parsed.errors) lines.push(`⚠️ ${FIELD_NAMES[e.field]}: ${e.message}`);
    c.fields = { ...c.fields, ...parsed.fields };
    await env.DB.prepare('UPDATE contracts SET data = ?1, last_msg = ?2, updated_at = ?3 WHERE number = ?4').bind(await encryptJson(env, c.fields), msg.message_id, Date.now(), c.number).run();
    if (changed.length) await renderAndSend(env, chatId, c, lines.join('\n'));
    else await say(env, chatId, (lines.join('\n') || 'Нічого нового не внесено.') + '\n' + statusLines(c).text);
  })());
}

/* ───────────── адмін-API ───────────── */
export async function adminContracts(env) {
  const { results } = await env.DB.prepare('SELECT number, data, version, owner_id, created_at, updated_at, purged_at FROM contracts ORDER BY number DESC').all();
  const out = [];
  for (const r of results) {
    const f = await decryptJson(env, r.data).catch(() => ({}));
    out.push({ number: r.number, name: f.name || null, phone: f.phone || null, filled: Object.keys(FIELD_NAMES).filter((k) => f[k]).length, total: Object.keys(FIELD_NAMES).length, version: r.version, purged: !!r.purged_at, created_at: r.created_at, updated_at: r.updated_at });
  }
  return out;
}


/* ───────────── видалення персональних даних з бази ───────────── */
// PDF лишається в переписці Telegram; у базі після очищення зберігаються лише номер, версія і file_id останнього файлу.
export async function purgeContract(env, number) {
  const empty = await encryptJson(env, {});
  await env.DB.prepare('UPDATE contracts SET data = ?1, purged_at = ?2 WHERE number = ?3 AND purged_at IS NULL').bind(empty, Date.now(), number).run();
  await env.DB.prepare('DELETE FROM kv WHERE k LIKE ?1 AND v LIKE ?2').bind('cdraft:%', `{"number":${number},%`).run();
}

export async function purgeContracts(env) {
  const cutoff = Date.now() - retentionMs(env);
  const { results } = await env.DB.prepare('SELECT number FROM contracts WHERE purged_at IS NULL AND updated_at < ?1').bind(cutoff).all();
  for (const r of results) await purgeContract(env, r.number);
  return results.length;
}
