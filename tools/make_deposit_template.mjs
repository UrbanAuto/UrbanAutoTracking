// Робить з готової квитанції на страховий депозит (xlsx) шаблон з мітками {{...}} для бота.
// Запуск:  node tools/make_deposit_template.mjs "Договір/Страховий депозит Газа Ярослав Васильович (1).xlsx" "Договір/Шаблон квитанції (депозит).xlsx"
// Далі шаблон кладеться в базу:  node tools/upload_template.mjs "Договір/Шаблон квитанції (депозит).xlsx" deposit_template
import fs from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from '../worker/node_modules/fflate/esm/browser.js';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error('Потрібно: <вихідна квитанція.xlsx> <шаблон.xlsx>'); process.exit(1); }
const files = unzipSync(new Uint8Array(fs.readFileSync(src)));

let sst = strFromU8(files['xl/sharedStrings.xml']);
const swap = (from, to) => {                                   // кожен текст має зустрітися в таблиці рядків рівно один раз
  const n = sst.split(`<t>${from}</t>`).length - 1;
  if (n !== 1) throw new Error(`«${from}»: знайдено ${n} разів, очікувався 1`);
  sst = sst.replace(`<t>${from}</t>`, `<t>${to}</t>`);
};
swap('Газа Ярослав Васильович', '{{CLIENT_NAME}}');
swap('Оплата згідно договору №0655 від 13.11.2026', 'Оплата згідно договору №{{CONTRACT_NO4}} від {{CONTRACT_DATE}}');
swap('Квитанція № 40/9', 'Квитанція № {{RECEIPT_NO}}');
swap('від  19 Листопада 2026 г.', 'від {{RECEIPT_DATE_LONG}}');
swap("4500(Чотири тисячі п'ятсот) грн 00коп.)", '{{AMOUNT}} ({{AMOUNT_WORDS}}) грн {{KOP}} коп.');
swap("Всього: 4500(Чотири тисячі п'ятсот грн 00коп.) без ПДВ", 'Всього: {{AMOUNT}} ({{AMOUNT_WORDS}}) грн {{KOP}} коп., без ПДВ');
files['xl/sharedStrings.xml'] = strToU8(sst);

let sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
for (const [from, to] of [['<v>46343.0</v>', '<v>{{PAY_SERIAL}}</v>'], ['<v>4500.0</v>', '<v>{{AMOUNT_NUM}}</v>']]) {
  if (sheet.split(from).length !== 2) throw new Error(`У аркуші не знайдено рівно одне ${from}`);
  sheet = sheet.replace(from, to);
}
// косметика друку: без сітки, ширша колонка B, вищі рядки для адреси й призначення, копійки в сумі «ВСЬОГО»
const edit = (from, to) => { if (sheet.split(from).length !== 2) throw new Error(`У аркуші не знайдено рівно одне ${from}`); sheet = sheet.replace(from, to); };
edit('<printOptions gridLines="1" horizontalCentered="1"/>', '<printOptions horizontalCentered="1"/>');
edit('<col customWidth="1" min="2" max="2" width="12.63"/>', '<col customWidth="1" min="2" max="2" width="17"/>');
edit('<row r="6">', '<row r="6" ht="30" customHeight="1">');
edit('<row r="20">', '<row r="20" ht="30" customHeight="1">');
files['xl/worksheets/sheet1.xml'] = strToU8(sheet);

let styles = strFromU8(files['xl/styles.xml']);
const xf60 = '<xf borderId="40" fillId="0" fontId="3" numFmtId="0" xfId="0" applyAlignment="1" applyBorder="1" applyFont="1">';
if (styles.split(xf60).length !== 2) throw new Error('Не знайдено стиль комірки суми');
files['xl/styles.xml'] = strToU8(styles.replace(xf60, xf60.replace('numFmtId="0"', 'numFmtId="2" applyNumberFormat="1"')));

fs.writeFileSync(dst, zipSync(files, { level: 6 }));
console.log('Шаблон квитанції збережено:', dst);
