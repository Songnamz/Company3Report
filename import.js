/**
 * นำเข้าข้อมูลเดิมจาก Google Sheet (แท็บ Reports → ดาวน์โหลดเป็น CSV)
 *   node import.js data/import-reports.csv
 *
 * - เวลาในชีตเป็นรูปแบบ M/d/yyyy H:mm:ss (เวลาไทย)
 * - รูปแนบดาวน์โหลดจากลิงก์สาธารณะของ Drive แล้วเก็บไว้ที่ data/images/<driveId>.jpg|png
 * - รันซ้ำได้: เรื่องที่มีอยู่แล้ว (ID ซ้ำ) จะถูกข้าม
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const IMG_DIR = path.join(DATA_DIR, 'images');
const file = process.argv[2];
if (!file) { console.error('usage: node import.js <reports.csv>'); process.exit(1); }

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(Boolean));
}

/** "11/5/2026 20:07:28" (M/d/yyyy, เวลาไทย) → epoch ms */
function parseTs(s) {
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error('อ่านเวลาไม่ได้: ' + s);
  let y = +m[3]; if (y > 2400) y -= 543;   // ปี พ.ศ.
  return Date.UTC(y, m[1] - 1, +m[2], m[4] - 7, +m[5], +(m[6] || 0));
}

async function fetchImage(id) {
  for (const ext of ['jpg', 'png']) if (fs.existsSync(path.join(IMG_DIR, id + '.' + ext))) return true;
  const res = await fetch('https://lh3.googleusercontent.com/d/' + encodeURIComponent(id) + '=s0', { redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  let ext = '';
  if (buf[0] === 0xFF && buf[1] === 0xD8) ext = 'jpg';
  else if (buf[0] === 0x89 && buf[1] === 0x50) ext = 'png';
  if (res.status !== 200 || !ext) { console.warn('  ✗ ดาวน์โหลดรูป ' + id + ' ไม่ได้ (' + res.status + ')'); return false; }
  fs.writeFileSync(path.join(IMG_DIR, id + '.' + ext), buf);
  console.log('  ✓ รูป ' + id + ' (' + Math.round(buf.length / 1024) + ' KB)');
  return true;
}

(async () => {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  // ให้ server.js สร้างตารางก่อน: รันเซิร์ฟเวอร์อย่างน้อยหนึ่งครั้ง หรือสร้างตรงนี้
  const db = new DatabaseSync(path.join(DATA_DIR, 'r3.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL,
           detail TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', images TEXT NOT NULL DEFAULT '')`);

  const [head, ...rows] = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const col = n => head.findIndex(h => h.trim().toLowerCase() === n);
  const C = { id: col('id'), ts: col('timestamp'), type: col('type'), detail: col('detail'),
              contact: col('contact'), images: Math.max(col('images'), col('photos')) };
  if (C.id < 0 || C.ts < 0 || C.detail < 0) throw new Error('หัวตารางไม่ถูกต้อง: ' + head.join(','));

  const ins = db.prepare('INSERT OR IGNORE INTO reports (id, ts, type, detail, contact, images) VALUES (?, ?, ?, ?, ?, ?)');
  let added = 0;
  for (const r of rows) {
    const id = r[C.id].trim();
    if (!id) continue;
    const imgs = C.images >= 0 ? r[C.images].split(',').map(s => s.trim()).filter(Boolean) : [];
    console.log(id);
    const ok = [];
    for (const img of imgs) if (await fetchImage(img)) ok.push(img);
    const type = r[C.type].trim() === 'แจ้งปัญหา' ? 'แจ้งปัญหา' : 'ข้อเสนอแนะ';
    const res = ins.run(id, parseTs(r[C.ts]), type, r[C.detail], (r[C.contact] || '').trim(), ok.join(','));
    added += Number(res.changes);
  }
  console.log(`นำเข้าแล้ว ${added} เรื่อง (ข้าม ${rows.length - added} เรื่องที่มีอยู่แล้ว)`);
  db.close();
})().catch(e => { console.error(e); process.exit(1); });
