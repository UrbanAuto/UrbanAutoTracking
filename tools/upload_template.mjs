// Завантажує Word-шаблон договору в базу D1 (kv.contract_template, base64) — шаблон НЕ потрапляє в репозиторій.
// Запуск:  node tools/upload_template.mjs "Договір/Шаблон договору (виправлений).docx"
import fs from 'node:fs'; import { execFileSync } from 'node:child_process'; import os from 'node:os'; import path from 'node:path';
const file = process.argv[2];
if (!file) { console.error('Вкажіть шлях до .docx'); process.exit(1); }
const b64 = fs.readFileSync(file).toString('base64');
const sql = path.join(os.tmpdir(), 'tpl_' + Date.now() + '.sql');
fs.writeFileSync(sql, `INSERT INTO kv (k, v) VALUES ('contract_template', '${b64}') ON CONFLICT(k) DO UPDATE SET v = excluded.v;\n`);
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'urban-auto-tracking', '--remote', `--file=${sql}`], { cwd: new URL('../worker/', import.meta.url).pathname, stdio: 'inherit' });
  console.log(`Шаблон завантажено (${Math.round(b64.length / 1024)} КБ base64).`);
} finally { fs.rmSync(sql, { force: true }); }
