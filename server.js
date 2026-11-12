/**
 * ร้อย3 — ช่องทางแจ้งปัญหา / ข้อเสนอแนะ (ไม่ระบุตัวตน)
 * Self-hosted version — ย้ายมาจาก Google Apps Script (ดู reference-Code.gs)
 *
 * Node.js 22 เท่านั้น ไม่มี dependency ภายนอก (ใช้ node:http + node:sqlite ในตัว)
 *   ข้อมูล  → /data/r3.db (SQLite)
 *   ไฟล์แนบ → /data/images/<id>.jpg|png|mp4|mov  (+ <id>.thumb.jpg = ภาพตัวอย่างของวิดีโอ)
 *
 * Environment (.env): ดู .env.example
 *
 * คำสั่งเสริม:
 *   node server.js set-password <รหัสใหม่>   ตั้งรหัสผ่านผู้ดูแล
 *   node server.js test-line                ส่งการ์ดทดสอบเข้า LINE
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { execFile } = require('node:child_process');

const env = process.env;
const APP = {
  NAME: 'ร้อย3',
  PORT: Number(env.PORT) || 3000,
  APP_URL: String(env.APP_URL || '').replace(/\/+$/, ''),   // เช่น https://message.songnam.xyz
  DATA_DIR: env.DATA_DIR || path.join(__dirname, 'data'),
  SESSION_SEC: (Number(env.SESSION_HOURS) || 12) * 3600,
  MAX_PER_10MIN: Number(env.MAX_PER_10MIN) || 30,          // กันสแปม (ทั้งระบบ)
  MAX_IMAGES: 4,
  MAX_IMG_BYTES: 1024 * 1024,
  MAX_VIDEOS: 2,                                          // นับรวมในไฟล์แนบ MAX_IMAGES
  MAX_VIDEO_BYTES: (Number(env.MAX_VIDEO_MB) || 50) * 1024 * 1024,
  // true  = รูปเปิดดูได้ด้วยลิงก์ (สุ่มยาว เดาไม่ได้) → LINE ดึงไปแสดงในกลุ่มได้
  // false = รูปดูได้เฉพาะผู้ดูแลที่ล็อกอิน — LINE ได้แค่ข้อความ "มีรูปแนบ"
  LINE_IMAGES: env.LINE_IMAGES !== 'false',
  // LINE Login (ช่อง LINE Login แยกจากช่อง Messaging API — ควรอยู่ใต้ Provider เดียวกัน)
  LOGIN_ID: env.LINE_LOGIN_CHANNEL_ID || '',
  LOGIN_SECRET: env.LINE_LOGIN_CHANNEL_SECRET || '',
  STUDENT_SESSION_SEC: (Number(env.STUDENT_SESSION_DAYS) || 30) * 86400,
  LOGO: env.LOGO_URL || 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQL5X0x24LvhYIn564hFTIOJUnA68EriiiZGaNFlFj1LA&s=10'
};
const IMG_DIR = path.join(APP.DATA_DIR, 'images');
const VIEWS = path.join(__dirname, 'views');
const ID_RE = /^[\w-]{20,64}$/;

/* ───────────────────────── Database ───────────────────────── */

fs.mkdirSync(IMG_DIR, { recursive: true });
const db = new DatabaseSync(path.join(APP.DATA_DIR, 'r3.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS reports (
    id      TEXT PRIMARY KEY,
    ts      INTEGER NOT NULL,          -- epoch ms
    type    TEXT NOT NULL,             -- 'แจ้งปัญหา' | 'ข้อเสนอแนะ'
    detail  TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    images  TEXT NOT NULL DEFAULT ''   -- image ids คั่นด้วย ,
  );
  CREATE INDEX IF NOT EXISTS reports_ts ON reports(ts);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS line_log (
    ts INTEGER NOT NULL, source_type TEXT, source_id TEXT, event_type TEXT, text TEXT, note TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS students (
    user_id    TEXT PRIMARY KEY,       -- LINE userId (sub)
    name       TEXT NOT NULL DEFAULT '',
    picture    TEXT NOT NULL DEFAULT '',
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS student_sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL
  );
  -- ข้อความ LINE ที่บอทส่ง (การ์ด / ข้อความส่งต่อ) → เรื่องไหน  ใช้จับคู่เวลามีคน "ตอบกลับ" (quote) ข้อความนั้น
  CREATE TABLE IF NOT EXISTS line_msgs (msg_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, ts INTEGER NOT NULL);
  -- บทสนทนาต่อเรื่อง: dir = 'teacher' (ครูฝึก → นักเรียน) | 'student' (นักเรียน → ครูฝึก)
  CREATE TABLE IF NOT EXISTS replies (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id TEXT NOT NULL,
    ts        INTEGER NOT NULL,
    dir       TEXT NOT NULL,
    text      TEXT NOT NULL,
    by_name   TEXT NOT NULL DEFAULT '',
    via       TEXT NOT NULL DEFAULT '',      -- 'line' | 'admin'
    delivered INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS replies_report ON replies(report_id, ts);
`);
// อัปเกรดตาราง reports: เก็บผู้ส่ง (ชื่อ/รูป ณ เวลาที่ส่ง)
{
  const cols = db.prepare('PRAGMA table_info(reports)').all().map(c => c.name);
  for (const c of ['user_id', 'user_name', 'user_picture']) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE reports ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
  }
}

const setting = {
  get: k => (db.prepare('SELECT v FROM settings WHERE k = ?').get(k) || {}).v,
  set: (k, v) => db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v)
};

// SALT: ใช้ค่าเดิมจาก Apps Script (ใน .env) เพื่อให้รหัสผ่านผู้ดูแลเดิมยังใช้ได้
const SALT = env.SALT || setting.get('SALT') || (() => { const s = crypto.randomUUID(); setting.set('SALT', s); return s; })();
const adminHash = () => setting.get('ADMIN_HASH') || env.ADMIN_HASH || '';

/* ───────────────────────── Helpers ───────────────────────── */

/** เหมือน hash_() ใน Apps Script: base64(SHA-256(SALT + password)) */
const hash = s => crypto.createHash('sha256').update(SALT + s, 'utf8').digest('base64');
const sign = s => crypto.createHmac('sha256', SALT).update(s, 'utf8').digest('base64url').slice(0, 32);
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

class UserError extends Error {}   // ข้อความนี้แสดงให้ผู้ใช้เห็นได้
const fail = m => { throw new UserError(m); };

function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

/** dd/MM/yyyy HH:mm ตามเวลาไทย (UTC+7 ไม่มี DST) */
function fmt(ms) {
  const d = new Date(ms + 7 * 3600 * 1000), p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function newReportId() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let s = 'R3-';
    for (let i = 0; i < 6; i++) s += a[crypto.randomInt(a.length)];
    if (!db.prepare('SELECT 1 FROM reports WHERE id = ?').get(s)) return s;
  }
}

/** ตัวนับแบบหน้าต่าง 10 นาที (แทน CacheService) */
const counters = new Map();
function throttle(name, max, msg) {
  const k = name + '_' + Math.floor(Date.now() / 600000);
  const n = counters.get(k) || 0;
  if (n >= max) fail(msg || 'ขณะนี้มีการส่งเรื่องจำนวนมาก กรุณาลองใหม่ในอีกสักครู่');
  counters.set(k, n + 1);
}
setInterval(() => {
  const now = Math.floor(Date.now() / 600000);
  for (const k of counters.keys()) if (Number(k.split('_').pop()) < now - 2) counters.delete(k);
}, 600000).unref();

/* ── นักเรียน: session ผ่าน cookie (HttpOnly) หลังล็อกอิน LINE ── */
const COOKIE = 'r3s';
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const secureFlag = () => APP.APP_URL.startsWith('https:') ? '; Secure' : '';
const cookieSet = (name, val, maxAge) => `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureFlag()}`;

function studentFromReq(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const row = db.prepare(`SELECT s.user_id, s.expires, st.name, st.picture FROM student_sessions s
                          JOIN students st ON st.user_id = s.user_id WHERE s.token = ?`).get(t);
  if (!row || row.expires < Date.now()) return null;
  return { userId: row.user_id, name: row.name, picture: row.picture };
}
const requireStudent = ctx => ctx.student || fail('LOGIN_REQUIRED');

function auth(token) {
  const t = String(token || '');
  const row = t && db.prepare('SELECT expires FROM sessions WHERE token = ?').get(t);
  if (!row || row.expires < Date.now()) fail('SESSION_EXPIRED');
}

/* ───────────────────────── Images ───────────────────────── */

function imgPath(id) {
  if (!ID_RE.test(id)) return null;
  for (const ext of ['jpg', 'png', 'mp4', 'mov']) {
    const p = path.join(IMG_DIR, id + '.' + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const isVideo = p => /\.(mp4|mov)$/.test(p || '');
const thumbFile = id => path.join(IMG_DIR, id + '.thumb.jpg');
const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

/** ตรวจ header ไฟล์วิดีโอ → 'mp4' | 'mov' | 'webm' | '' */
function videoExt(head) {
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1A45DFA3) return 'webm';   // Matroska/WebM
  if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') return '';   // ISO BMFF
  return head.toString('latin1', 8, 12) === 'qt  ' ? 'mov' : 'mp4';
}

/* ───── แปลงวิดีโอ (ffmpeg) ─────
 * อัปโหลด → เก็บเป็น <id>.orig → แปลงเบื้องหลังเป็น <id>.mp4 (H.264 + AAC, ด้านยาว ≤1280, faststart)
 *   + ภาพตัวอย่าง <id>.thumb.jpg  แล้วลบไฟล์ต้นฉบับ
 * ทำทีละไฟล์ (ไม่ให้แย่ง CPU กับระบบอื่นบนเซิร์ฟเวอร์) — ถ้าแปลงไม่ได้ ใช้ไฟล์เดิม (mp4/mov) แทน */
const jobs = new Map();          // id → Promise (กำลังแปลง/รอคิว)
let ffQueue = Promise.resolve();
const VIDEO_MAX_SEC = Number(env.VIDEO_MAX_SEC) || 180;

const ff = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, _o, stderr) => err ? reject(new Error(String(stderr || err.message).slice(-500))) : resolve());
});

async function transcode(id, src, ext) {
  const out = path.join(IMG_DIR, id + '.mp4');
  const tmp = path.join(IMG_DIR, id + '.tmp.mp4');
  const t0 = Date.now();
  try {
    await ff(['-i', src, '-t', String(VIDEO_MAX_SEC),
      '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',          // ตัด metadata (GPS/รุ่นกล้อง)
      '-vf', "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))',fps=fps='min(source_fps,30)',format=yuv420p",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-profile:v', 'high', '-threads', '4',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', '+faststart', tmp], 10 * 60 * 1000);
    fs.renameSync(tmp, out);
    console.log(`video ${id}: แปลงเสร็จ ${(fs.statSync(src).size / 1048576).toFixed(1)}MB → ${(fs.statSync(out).size / 1048576).toFixed(1)}MB (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (ext === 'webm') { console.error(`video ${id}: แปลงไม่สำเร็จ (webm ใช้ต้นฉบับไม่ได้):`, e.message); fs.rmSync(src, { force: true }); return; }
    console.error(`video ${id}: แปลงไม่สำเร็จ ใช้ไฟล์ต้นฉบับแทน:`, e.message);
    fs.renameSync(src, path.join(IMG_DIR, id + '.' + ext));
    return;
  }
  fs.rmSync(src, { force: true });
  try {
    await ff(['-ss', '0.5', '-i', out, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '4', thumbFile(id)], 60 * 1000);
  } catch (e) {
    try { await ff(['-i', out, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '4', thumbFile(id)], 60 * 1000); }
    catch (e2) { console.warn(`video ${id}: สร้างภาพตัวอย่างไม่ได้`); }
  }
}

function queueTranscode(id, src, ext) {
  const job = ffQueue.then(() => transcode(id, src, ext)).catch(e => console.error('transcode:', e)).finally(() => jobs.delete(id));
  ffQueue = job;
  jobs.set(id, job);
  return job;
}

/** รอให้วิดีโอในรายการแปลงเสร็จ (สูงสุด maxMs) */
const waitVideos = (ids, maxMs) => Promise.race([
  Promise.all((ids || []).map(id => jobs.get(id)).filter(Boolean)),
  new Promise(r => setTimeout(r, maxMs))
]);

/** id นี้เป็นวิดีโอไหม (รวมที่กำลังแปลง) */
const isVideoId = id => jobs.has(id) || isVideo(imgPath(id));

/** base64 → { bytes, mime } ตรวจ magic bytes จริง */
function decodeImage(b64) {
  const s = String(b64 || '').replace(/^data:[^,]*,/, '');
  if (!s) fail('รูปภาพไม่ถูกต้อง');
  if (s.length > APP.MAX_IMG_BYTES * 1.4) fail('รูปภาพมีขนาดใหญ่เกินไป');
  const bytes = Buffer.from(s, 'base64');
  if (!bytes.length) fail('รูปภาพไม่ถูกต้อง');
  if (bytes.length > APP.MAX_IMG_BYTES) fail('รูปภาพมีขนาดใหญ่เกินไป');
  let mime = '';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) mime = 'image/jpeg';
  else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) mime = 'image/png';
  if (!mime) fail('รูปภาพต้องเป็นไฟล์ JPG / PNG');
  return { bytes, mime };
}

function verifyUpload(u) {
  u = u || {};
  const id = String(u.id || ''), shared = u.shared === true, t = Number(u.t) || 0;
  const ok = ID_RE.test(id) && Date.now() - t < 12 * 3600 * 1000 &&
             safeEq(String(u.sig || ''), sign([id, shared ? 1 : 0, t].join('|'))) && (imgPath(id) || jobs.has(id));
  if (!ok) fail('รูปแนบไม่ถูกต้องหรือหมดอายุ — กรุณาลบรูปแล้วแนบใหม่');
  return { id, shared };
}

/** ลบรูปที่อัปโหลดแล้วไม่ได้ผูกกับเรื่องใด (เก่ากว่า 24 ชม.) + session ที่หมดอายุ */
function cleanup() {
  const used = new Set(db.prepare("SELECT images FROM reports WHERE images <> ''").all()
    .flatMap(r => r.images.split(',')).map(s => s.trim()).filter(Boolean));
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(IMG_DIR)) {
    const p = path.join(IMG_DIR, f);
    try {
      if (!used.has(f.split('.')[0]) && !jobs.has(f.split('.')[0]) && fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
    } catch (e) { /* ignore */ }
  }
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('DELETE FROM student_sessions WHERE expires < ?').run(Date.now());
  if (removed) console.log('cleanup: ลบไฟล์แนบที่ไม่ได้ใช้ ' + removed + ' ไฟล์');
}

const imgUrl = id => APP.APP_URL + '/i/' + id;
/** รูปสำหรับแสดงผล: รูปเอง หรือภาพตัวอย่างของวิดีโอ */
const previewUrl = id => isVideo(imgPath(id)) ? imgUrl(id) + '/t' : imgUrl(id);

/* ───────────────────────── API (google.script.run) ───────────────────────── */

const loginFails = new Map();   // ip → { n, until }

const API = {
  async submitReport(ctx, form) {
    const me = requireStudent(ctx);
    form = form || {};
    if (form.website) return { ok: true };   // honeypot
    const r = {
      type: form.type === 'suggestion' ? 'ข้อเสนอแนะ' : 'แจ้งปัญหา',
      detail: clean(form.detail, 3000),
      contact: clean(form.contact, 120)
    };
    if (r.detail.length < 5) fail('กรุณาอธิบายรายละเอียดอย่างน้อย 5 ตัวอักษร');

    const raw = Array.isArray(form.images) ? form.images : [];
    if (raw.length > APP.MAX_IMAGES) fail('แนบไฟล์ได้สูงสุด ' + APP.MAX_IMAGES + ' ไฟล์');
    const ups = raw.map(verifyUpload).filter((u, i, a) => a.findIndex(x => x.id === u.id) === i);
    if (ups.filter(u => isVideoId(u.id)).length > APP.MAX_VIDEOS) fail('แนบวิดีโอได้สูงสุด ' + APP.MAX_VIDEOS + ' คลิป');

    throttle('rate', APP.MAX_PER_10MIN);
    r.id = newReportId();
    r.time = Date.now();
    r.images = ups.map(u => u.id);
    r.lineImages = ups.filter(u => u.shared).map(u => u.id);
    r.sender = me;
    db.prepare(`INSERT INTO reports (id, ts, type, detail, contact, images, user_id, user_name, user_picture)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.time, r.type, r.detail, r.contact, r.images.join(','), me.userId, me.name, me.picture);

    // ส่ง LINE เบื้องหลัง — ผู้ใช้ไม่ต้องรอ
    notifyLine(r).catch(err => console.error('LINE notify failed:', err));
    return { ok: true };
  },

  async uploadImage(ctx, b64) {
    requireStudent(ctx);
    throttle('up', APP.MAX_PER_10MIN * APP.MAX_IMAGES);
    const b = decodeImage(b64);
    const id = crypto.randomBytes(24).toString('base64url');   // 32 ตัวอักษร เดาไม่ได้
    fs.writeFileSync(path.join(IMG_DIR, id + (b.mime === 'image/png' ? '.png' : '.jpg')), b.bytes);
    const shared = APP.LINE_IMAGES, t = Date.now();
    return { id, shared, t, sig: sign([id, shared ? 1 : 0, t].join('|')) };
  },

  /** ภาพตัวอย่างของวิดีโอ (เบราว์เซอร์จับเฟรมแรกให้) — ไม่บังคับ */
  async uploadThumb(ctx, up, b64) {
    requireStudent(ctx);
    const u = verifyUpload(up);
    if (!isVideoId(u.id)) fail('ไฟล์นี้ไม่ใช่วิดีโอ');
    const b = decodeImage(b64);
    if (b.mime !== 'image/jpeg') fail('ภาพตัวอย่างต้องเป็น JPG');
    // ใช้ชั่วคราวระหว่างแปลง — ffmpeg สร้างภาพตัวอย่างใหม่ทับเมื่อแปลงเสร็จ
    if (!fs.existsSync(thumbFile(u.id))) fs.writeFileSync(thumbFile(u.id), b.bytes);
    return true;
  },

  async adminLogin(ctx, password) {
    const now = Date.now();
    const f = loginFails.get(ctx.ip) || { n: 0, until: 0 };
    if (f.until > now) fail('ใส่รหัสผิดหลายครั้งเกินไป กรุณารอ 15 นาที');
    const stored = adminHash();
    if (!stored) fail('ยังไม่ได้ตั้งรหัสผ่านผู้ดูแล (node server.js set-password ...)');
    if (!safeEq(hash(String(password || '')), stored)) {
      f.n++;
      if (f.n >= 10) { f.n = 0; f.until = now + 15 * 60 * 1000; }
      loginFails.set(ctx.ip, f);
      await new Promise(r => setTimeout(r, 800));
      fail('รหัสผ่านไม่ถูกต้อง');
    }
    loginFails.delete(ctx.ip);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, expires) VALUES (?, ?)').run(token, now + APP.SESSION_SEC * 1000);
    return token;
  },

  async adminLogout(ctx, token) {
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
    return true;
  },

  async getReports(ctx, token) {
    auth(token);
    const thread = new Map();
    for (const m of db.prepare('SELECT * FROM replies ORDER BY ts').all()) {
      if (!thread.has(m.report_id)) thread.set(m.report_id, []);
      thread.get(m.report_id).push({ dir: m.dir, text: m.text, by: m.by_name, via: m.via, time: fmt(m.ts), delivered: !!m.delivered });
    }
    const items = db.prepare('SELECT * FROM reports ORDER BY ts DESC').all().map(v => ({
      replies: thread.get(v.id) || [],
      id: v.id,
      timestamp: fmt(v.ts),
      ts: v.ts,
      type: v.type,
      detail: v.detail,
      contact: v.contact,
      images: v.images.split(',').map(s => s.trim()).filter(Boolean),
      videos: v.images.split(',').map(s => s.trim()).filter(id => id && isVideoId(id)),
      sender: v.user_id ? { name: v.user_name, picture: v.user_picture } : null
    }));
    return { items };
  },

  async getImage(ctx, token, fileId) {
    auth(token);
    const p = imgPath(String(fileId || ''));
    if (!p || isVideo(p)) fail('ไม่พบรูปภาพ (อาจถูกลบไปแล้ว)');
    return 'data:' + (p.endsWith('.png') ? 'image/png' : 'image/jpeg') + ';base64,' + fs.readFileSync(p).toString('base64');
  },

  /** แอปที่ติดตั้ง: แลกรหัส 6 หลัก (ได้หลังล็อกอิน LINE) เป็น session */
  async pwaRedeem(ctx, code) {
    throttle('pwa_' + ctx.ip, 10, 'ลองหลายครั้งเกินไป กรุณารอสักครู่');
    throttle('pwa_all', 300, 'ลองหลายครั้งเกินไป กรุณารอสักครู่');   // กันเดารหัสจากหลาย IP
    const c = String(code || '').replace(/\D/g, '');
    const hit = pwaCodes.get(c);
    pwaCodes.delete(c);
    if (!hit || hit.exp < Date.now()) fail('รหัสไม่ถูกต้องหรือหมดอายุ — กรุณาเข้าสู่ระบบด้วย LINE ใหม่');
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO student_sessions (token, user_id, expires) VALUES (?, ?, ?)')
      .run(token, hit.userId, Date.now() + APP.STUDENT_SESSION_SEC * 1000);
    ctx.cookies.push(cookieSet(COOKIE, token, APP.STUDENT_SESSION_SEC));
    return true;
  },

  /** ผู้ดูแลตอบกลับนักเรียนจากหน้าเว็บ */
  async adminReply(ctx, token, reportId, text) {
    auth(token);
    const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(String(reportId || ''));
    if (!r) fail('ไม่พบเรื่องนี้');
    const t = clean(text, 2000);
    if (!t) fail('กรุณาพิมพ์ข้อความ');
    const res = await sendToStudent(r, t, 'ผู้ดูแลระบบ', 'admin');
    if (!res.ok) fail(res.reason);
    return true;
  }
};

/* ───────────────────────── LINE ───────────────────────── */

const LINE_TOKEN = env.LINE_TOKEN || '';
const LINE_TO = String(env.LINE_TO || '').split(',').map(s => s.trim()).filter(Boolean);

async function notifyLine(r) {
  if (!LINE_TOKEN || !LINE_TO.length) { console.warn('LINE ยังไม่ได้ตั้งค่า (LINE_TOKEN / LINE_TO)'); return; }
  await waitVideos(r.lineImages, 8 * 60 * 1000);   // การ์ดต้องใช้ไฟล์ MP4 ที่แปลงเสร็จแล้ว
  if (!APP.APP_URL) console.warn('APP_URL ยังไม่ได้ตั้ง — การ์ดจะไม่มีปุ่ม/รูป');
  // openExternalBrowser=1 → LINE เปิดด้วยเบราว์เซอร์ปกติของเครื่อง
  const adminUrl = APP.APP_URL ? APP.APP_URL + '/admin?openExternalBrowser=1' : '';
  const pics = APP.APP_URL ? (r.lineImages || []).filter(id => imgPath(id)).slice(0, 4) : [];
  const vids = pics.filter(id => isVideo(imgPath(id)));
  const imgMsg = id => ({ type: 'image', originalContentUrl: imgUrl(id), previewImageUrl: imgUrl(id) });
  // วิดีโออยู่ในการ์ดเท่านั้น (ภาพตัวอย่าง + ▶ แตะเพื่อเล่น) — ไม่ส่งเป็นข้อความแยก

  const flex = [flexCard(r, adminUrl, pics)];
  const plain = [{ type: 'text', text: plainText(r, adminUrl, pics.length) }]
    .concat(pics.filter(id => !vids.includes(id)).map(imgMsg));

  for (const to of LINE_TO) {
    let res = await linePush(to, flex);
    if (res.status !== 200) {
      console.warn('LINE ' + to + ' → ส่งการ์ดไม่สำเร็จ ลองส่งแบบข้อความ');
      res = await linePush(to, plain);
      if (res.status !== 200 && pics.length) {
        res = await linePush(to, [{ type: 'text', text: plainText(r, adminUrl, 0) + '\n\n(ส่งรูปไม่สำเร็จ — ดูรูปได้ในหน้าผู้ดูแล)' }]);
      }
    }
    if (!r.noMap) mapMsgs(res.ids, r.id);   // ครูฝึก "ตอบกลับ" การ์ด/รูปนี้ → ส่งถึงนักเรียน
  }
}

/* ───────────────────────── สนทนา ครูฝึก ↔ นักเรียน ───────────────────────── */

const LINE_SECRET = env.LINE_CHANNEL_SECRET || '';   // Channel secret ของช่อง Messaging API (ไม่ใช่ LINE Login)
const CHAT_DAYS = Number(env.CHAT_DAYS) || 14;      // นักเรียนพิมพ์ในแชต → ส่งต่อไปเรื่องล่าสุดที่ยังคุยภายในกี่วัน

const mapMsgs = (ids, reportId) => {
  const ins = db.prepare('INSERT OR IGNORE INTO line_msgs (msg_id, report_id, ts) VALUES (?, ?, ?)');
  for (const id of ids || []) ins.run(String(id), reportId, Date.now());
};
const reportByMsg = id => {
  const m = id && db.prepare('SELECT report_id FROM line_msgs WHERE msg_id = ?').get(String(id));
  return m ? db.prepare('SELECT * FROM reports WHERE id = ?').get(m.report_id) : null;
};
const addReply = (reportId, dir, text, by, via, delivered) =>
  db.prepare('INSERT INTO replies (report_id, ts, dir, text, by_name, via, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(reportId, Date.now(), dir, text, by || '', via, delivered ? 1 : 0);
const short = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

/** ส่งข้อความครูฝึกถึงนักเรียน (แชต 1:1 กับบอท) — คืน { ok, reason } */
async function sendToStudent(r, text, byName, via) {
  if (!r.user_id) return { ok: false, reason: 'เรื่องนี้ส่งมาก่อนมีระบบเข้าสู่ระบบ จึงตอบกลับนักเรียนไม่ได้' };
  const msg = '💬 ครูฝึกตอบกลับเรื่องที่ท่านแจ้ง\n' +
              '📝 ' + short(r.detail, 80) + '\n\n' + text + '\n\n' +
              '— พิมพ์ข้อความในแชตนี้เพื่อตอบกลับครูฝึก';
  const res = await linePush(r.user_id, [{ type: 'text', text: msg.slice(0, 5000) }]);
  const ok = res.status === 200;
  addReply(r.id, 'teacher', text, byName, via, ok);
  if (ok) { mapMsgs(res.ids, r.id); return { ok: true }; }
  return {
    ok: false,
    reason: res.status === 403 || res.status === 400
      ? 'ส่งไม่ถึงนักเรียน — นักเรียนยังไม่ได้เพิ่มบอทเป็นเพื่อน หรือบล็อกบอทอยู่'
      : 'ส่งไม่สำเร็จ (LINE ' + res.status + ') กรุณาลองใหม่'
  };
}

/** ส่งต่อข้อความนักเรียนเข้ากลุ่มครูฝึก */
async function forwardToTeachers(r, text) {
  const msg = '💬 นักเรียนตอบกลับ · ' + r.id + '\n' +
              '👤 ' + (r.user_name || '(ไม่มีชื่อ)') + '\n' +
              '📝 เรื่อง: ' + short(r.detail, 60) + '\n\n' + text + '\n\n' +
              '↩️ แตะค้างที่ข้อความนี้ → ตอบกลับ เพื่อคุยต่อ';
  let ok = false;
  for (const to of LINE_TO) {
    const res = await linePush(to, [{ type: 'text', text: msg.slice(0, 5000) }]);
    if (res.status === 200) { ok = true; mapMsgs(res.ids, r.id); }
  }
  addReply(r.id, 'student', text, r.user_name, 'line', ok);
  return ok;
}

const memberName = async (groupId, userId) => {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`,
      { headers: { Authorization: 'Bearer ' + LINE_TOKEN }, signal: AbortSignal.timeout(8000) });
    return res.ok ? clean((await res.json()).displayName, 100) : '';
  } catch (e) { return ''; }
};

async function handleEvent(ev) {
  const s = ev.source || {};
  const msg = ev.message || {};
  const reply = text => ev.replyToken && lineReply(ev.replyToken, [{ type: 'text', text }]);
  const formUrl = APP.APP_URL ? APP.APP_URL + '/?openExternalBrowser=1' : '';

  // ── ในกลุ่มครูฝึก: ตอบกลับ (quote) การ์ดหรือข้อความที่บอทส่ง → ส่งถึงนักเรียน
  if (ev.type === 'message' && s.type === 'group' && LINE_TO.includes(s.groupId)) {
    if (msg.type !== 'text' || !msg.quotedMessageId) return;
    const r = reportByMsg(msg.quotedMessageId);
    if (!r) return;   // quote ข้อความอื่นที่ไม่ใช่ของบอท — ไม่สนใจ
    const text = clean(msg.text, 2000);
    if (!text) return;
    const by = s.userId ? await memberName(s.groupId, s.userId) : '';
    const res = await sendToStudent(r, text, by, 'line');
    return reply(res.ok ? '✅ ส่งถึงนักเรียนแล้ว (' + r.id + ')' : '⚠️ ' + res.reason + ' (' + r.id + ')');
  }

  // ── แชต 1:1 นักเรียน ↔ บอท
  if (s.type === 'user' && s.userId) {
    if (ev.type === 'follow') {
      return reply('สวัสดีครับ 🙏 นี่คือบอทของ ' + APP.NAME + '\nแจ้งปัญหา/ข้อเสนอแนะได้ที่: ' + formUrl +
                   '\n\nเมื่อครูฝึกตอบกลับ ข้อความจะส่งมาที่แชตนี้ และท่านพิมพ์ตอบกลับในแชตนี้ได้เลย');
    }
    if (ev.type !== 'message') return;
    if (msg.type !== 'text') return reply('ขณะนี้ส่งถึงครูฝึกได้เฉพาะข้อความตัวอักษร (รูปภาพแนบได้ในหน้าแจ้งเรื่อง)');
    const text = clean(msg.text, 2000);
    if (!text) return;

    // เรื่องไหน: quote ข้อความบอท → เรื่องนั้น  /  ไม่ quote → เรื่องล่าสุดที่ยังมีการคุยภายใน CHAT_DAYS วัน
    let r = reportByMsg(msg.quotedMessageId);
    if (r && r.user_id !== s.userId) r = null;
    if (!r) {
      r = db.prepare(`SELECT r.*, MAX(r.ts, COALESCE((SELECT MAX(ts) FROM replies WHERE report_id = r.id), 0)) last
                      FROM reports r WHERE r.user_id = ? ORDER BY last DESC LIMIT 1`).get(s.userId);
      if (r && r.last < Date.now() - CHAT_DAYS * 86400000) r = null;
    }
    if (!r) return reply('ยังไม่มีเรื่องที่ท่านแจ้งเข้ามา\nแจ้งปัญหา/ข้อเสนอแนะได้ที่: ' + formUrl);

    try { throttle('chat_' + s.userId, 20, 'x'); } catch (e) { return reply('ส่งข้อความถี่เกินไป กรุณารอสักครู่'); }
    const ok = await forwardToTeachers(r, text);
    return reply(ok ? '✅ ส่งถึงครูฝึกแล้ว' : '⚠️ ส่งไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
  }
}

/** การ์ด Flex Message (bubble) — คัดลอกจาก flexCard_() เดิม */
function flexCard(r, adminUrl, picIds) {
  const pics = (picIds || []).slice(0, 4);
  const isIssue = r.type === 'แจ้งปัญหา';
  const C = {
    main: isIssue ? '#A4552A' : '#2A4F8F',
    soft: isIssue ? '#F8EBE2' : '#E7EEF9',
    navy: '#1C2C4C', text: '#1D2433', muted: '#8A8F9C', gold: '#C9A23A', line: '#E4DFD3'
  };
  const label = isIssue ? '🔧 แจ้งปัญหา' : '💡 ข้อเสนอแนะ';
  const detail = r.detail.length > 600 ? r.detail.slice(0, 600) + '…' : r.detail;
  const nImg = (r.images || []).length;

  const row = (k, v) => ({
    type: 'box', layout: 'baseline', spacing: 'md',
    contents: [
      { type: 'text', text: k, size: 'sm', color: C.muted, flex: 3 },
      { type: 'text', text: String(v), size: 'sm', color: C.text, flex: 7, wrap: true }
    ]
  });
  const rows = [];
  if (r.sender) {
    // ผู้แจ้ง: รูปโปรไฟล์ LINE (วงกลม) + ชื่อ LINE
    const who = [];
    if (/^https:\/\//.test(r.sender.picture || '')) {
      who.push({
        type: 'box', layout: 'vertical', width: '36px', height: '36px', cornerRadius: '18px', flex: 0,
        contents: [{ type: 'image', url: r.sender.picture, size: 'full', aspectMode: 'cover', aspectRatio: '1:1' }]
      });
    }
    who.push({
      type: 'box', layout: 'vertical', flex: 1, justifyContent: 'center',
      contents: [
        { type: 'text', text: 'ผู้แจ้ง', size: 'xxs', color: C.muted },
        { type: 'text', text: r.sender.name || '(ไม่มีชื่อ)', size: 'md', color: C.text, weight: 'bold', wrap: true }
      ]
    });
    rows.push({ type: 'box', layout: 'horizontal', spacing: 'md', alignItems: 'center', margin: 'none', contents: who });
  }
  rows.push(row('รหัส', r.id), row('เวลา', fmt(r.time || Date.now())));
  if (r.contact) rows.push(row('ติดต่อกลับ', r.contact));
  else if (!r.sender) rows.push(row('ผู้แจ้ง', 'ไม่ระบุตัวตน'));
  if (nImg) rows.push(row('ไฟล์แนบ', mediaCount(r.images) + (pics.length < nImg ? ' (ดูครบในหน้าผู้ดูแล)' : '')));

  const bubble = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: C.main, paddingAll: '16px', spacing: 'xs',
      contents: [
        { type: 'text', text: APP.NAME + ' · ฝ่ายไอที', size: 'xs', color: '#FFFFFFCC', weight: 'bold' },
        { type: 'text', text: label, size: 'xl', color: '#FFFFFF', weight: 'bold' }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
      contents: [
        {
          type: 'box', layout: 'vertical', backgroundColor: C.soft, cornerRadius: '10px', paddingAll: '12px',
          contents: [{ type: 'text', text: detail, size: 'md', color: C.text, wrap: true }]
        },
        { type: 'separator', color: C.line, margin: 'md' },
        { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md', contents: rows }
      ].concat(r.sender ? [{
        type: 'text', text: '↩️ แตะค้างที่การ์ดนี้ → ตอบกลับ เพื่อส่งข้อความถึงนักเรียน',
        size: 'xs', color: C.muted, wrap: true, margin: 'lg'
      }] : [])
    }
  };

  const hero = galleryHero(pics);
  if (hero) bubble.hero = hero;

  if (adminUrl) {
    bubble.footer = {
      type: 'box', layout: 'vertical', paddingAll: '12px',
      contents: [{
        type: 'button', style: 'primary', color: C.navy, height: 'sm',
        action: { type: 'uri', label: 'เปิดดูในหน้าผู้ดูแล', uri: adminUrl }
      }]
    };
    bubble.styles = { footer: { separator: true, separatorColor: C.line } };
  }

  return { type: 'flex', altText: (label + ': ' + r.detail).slice(0, 380), contents: bubble };
}

/** ส่วนภาพบนการ์ด — 1: เต็มกว้าง, 2: ซ้าย|ขวา, 3: ใหญ่ซ้าย+เล็กขวา 2, 4: ตาราง 2×2 */
function galleryHero(ids) {
  if (!ids.length) return null;
  const GAP = '2px';
  const tile = (id, ratio) => {
    const img = {
      type: 'image', url: previewUrl(id), size: 'full', aspectMode: 'cover', aspectRatio: ratio,
      action: { type: 'uri', uri: imgUrl(id) }
    };
    if (!isVideo(imgPath(id))) return img;
    // วิดีโอ: ภาพตัวอย่าง + ปุ่ม ▶ ตรงกลาง — แตะแล้วเปิดเล่นวิดีโอ
    return {
      type: 'box', layout: 'vertical', paddingAll: '0px', action: { type: 'uri', uri: imgUrl(id) },
      contents: [img, {
        type: 'box', layout: 'vertical', position: 'absolute', offsetTop: '0px', offsetBottom: '0px',
        offsetStart: '0px', offsetEnd: '0px', justifyContent: 'center', alignItems: 'center',
        contents: [{
          type: 'box', layout: 'vertical', width: '48px', height: '48px', cornerRadius: '24px',
          backgroundColor: '#000000AA', justifyContent: 'center', alignItems: 'center',
          contents: [{ type: 'text', text: '▶', color: '#FFFFFF', size: 'xl', align: 'center', offsetStart: '2px' }]
        }]
      }]
    };
  };
  const col = contents => ({ type: 'box', layout: 'vertical', flex: 1, spacing: GAP, contents });
  const rowBox = contents => ({ type: 'box', layout: 'horizontal', spacing: GAP, contents });

  if (ids.length === 1) return tile(ids[0], '20:13');

  let grid;
  if (ids.length === 2) {
    grid = rowBox([col([tile(ids[0], '1:1')]), col([tile(ids[1], '1:1')])]);
  } else if (ids.length === 3) {
    grid = rowBox([col([tile(ids[0], '1:1')]), col([tile(ids[1], '2:1'), tile(ids[2], '2:1')])]);
  } else {
    grid = {
      type: 'box', layout: 'vertical', spacing: GAP,
      contents: [
        rowBox([col([tile(ids[0], '4:3')]), col([tile(ids[1], '4:3')])]),
        rowBox([col([tile(ids[2], '4:3')]), col([tile(ids[3], '4:3')])])
      ]
    };
  }
  return {
    type: 'box', layout: 'vertical', paddingAll: '0px', backgroundColor: '#FFFFFF',
    contents: [
      grid,
      {
        type: 'box', layout: 'vertical', position: 'absolute', offsetTop: '10px', offsetEnd: '10px',
        backgroundColor: '#1C2C4CCC', cornerRadius: '20px',
        paddingTop: '3px', paddingBottom: '3px', paddingStart: '10px', paddingEnd: '10px',
        contents: [{ type: 'text', text: (ids.some(id => isVideo(imgPath(id))) ? '📎 ' : '📷 ') + mediaCount(ids), size: 'xs', color: '#FFFFFF', weight: 'bold' }]
      }
    ]
  };
}

/** "2 รูป · 1 วิดีโอ" */
function mediaCount(ids) {
  const nV = (ids || []).filter(id => isVideo(imgPath(id))).length, nI = (ids || []).length - nV;
  return [nI ? nI + ' รูป' : '', nV ? nV + ' วิดีโอ' : ''].filter(Boolean).join(' · ');
}

function plainText(r, adminUrl, nSent) {
  const head = r.type === 'แจ้งปัญหา' ? '🔧 มีการแจ้งปัญหา' : '💡 มีข้อเสนอแนะ';
  const detail = r.detail.length > 1000 ? r.detail.slice(0, 1000) + '…' : r.detail;
  const nImg = (r.images || []).length;
  const lines = [head + ': ' + detail, ''];
  if (r.sender) lines.push('ผู้แจ้ง: ' + (r.sender.name || '(ไม่มีชื่อ)'));
  lines.push('รหัส: ' + r.id);
  if (r.contact) lines.push('ติดต่อกลับ: ' + r.contact);
  if (nImg) lines.push('📎 ไฟล์แนบ ' + mediaCount(r.images) + (nSent < nImg ? ' (ดูได้ในหน้าผู้ดูแล)' : ''));
  if (adminUrl) lines.push('', 'ดูรายการทั้งหมด: ' + adminUrl);
  return lines.join('\n');
}

/** push → { status, ids } — ids = message id ที่ LINE สร้าง (ใช้จับคู่ตอนมีคนตอบกลับข้อความนั้น) */
async function linePush(to, messages) {
  return lineCall('push', { to, messages }, to);
}
/** reply ด้วย replyToken (ฟรี ไม่นับโควตาข้อความ) */
async function lineReply(replyToken, messages) {
  return lineCall('reply', { replyToken, messages }, 'reply');
}
async function lineCall(kind, payload, label) {
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/' + kind, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.text();
    if (res.status !== 200) { console.error('LINE ' + label + ' → ' + res.status + ' ' + body); return { status: res.status, ids: [] }; }
    let ids = [];
    try { ids = (JSON.parse(body).sentMessages || []).map(m => m.id); } catch (e) { /* ignore */ }
    console.log('LINE ' + label + ' → OK (' + payload.messages.length + ' ข้อความ)');
    return { status: 200, ids };
  } catch (e) {
    console.error('LINE ' + label + ' → ' + e);
    return { status: 0, ids: [] };
  }
}

/* ───────────────────────── LINE Login (OAuth 2.1 + PKCE) ───────────────────────── */

const oauthStates = new Map();   // state → { verifier, nonce, pwa, exp }
const pwaCodes = new Map();      // รหัส 6 หลัก → { userId, exp }  (เข้าสู่ระบบในแอปที่ติดตั้ง)
const loginReady = () => !!(APP.LOGIN_ID && APP.LOGIN_SECRET && APP.APP_URL);
const callbackUrl = () => APP.APP_URL + '/auth/callback';

function startLogin(res, pwa) {
  if (!loginReady()) return send(res, 503, PAGES.loginMissing, { 'Content-Type': 'text/html; charset=utf-8' });
  const now = Date.now();
  for (const [k, v] of oauthStates) if (v.exp < now) oauthStates.delete(k);
  for (const [k, v] of pwaCodes) if (v.exp < now) pwaCodes.delete(k);
  const state = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  oauthStates.set(state, { verifier, nonce, pwa: !!pwa, exp: now + 10 * 60 * 1000 });
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: APP.LOGIN_ID,
    redirect_uri: callbackUrl(),
    state, nonce,
    scope: 'profile openid',
    bot_prompt: 'aggressive',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  });
  send(res, 302, '', {
    Location: 'https://access.line.me/oauth2/v2.1/authorize?' + q,
    // cookie ผูก state กับเบราว์เซอร์นี้ (กันคนอื่นส่งลิงก์ callback มาให้กด)
    'Set-Cookie': cookieSet('r3o', state, 600),
    'Cache-Control': 'no-store'
  });
}

async function finishLogin(req, res, url) {
  const fail = msg => send(res, 400, PAGES.loginError.replace('{{MSG}}', escHtml(msg)),
    { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': cookieSet('r3o', '', 0) });
  if (url.searchParams.get('error')) return fail('ยกเลิกการเข้าสู่ระบบ');
  const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
  const st = oauthStates.get(state);
  oauthStates.delete(state);
  // cookie r3o ผูก state กับเบราว์เซอร์ที่เริ่มล็อกอิน (กันคนอื่นส่งลิงก์ callback มาให้กด)
  // แอปที่ติดตั้งบน iOS: หน้า LINE Login เปิดใน Safari/แอป LINE ซึ่งไม่มี cookie ของแอป → ไม่มี r3o
  //   กรณีนี้ใช้รหัส 6 หลักแทน (ต้องนำไปพิมพ์ในแอปของตัวเอง) และไม่ตั้ง session ในเบราว์เซอร์นั้น
  const sameBrowser = safeEq(parseCookies(req).r3o || '', state);
  if (!st || st.exp < Date.now() || !code || (!sameBrowser && !st.pwa)) {
    return fail('ลิงก์เข้าสู่ระบบหมดอายุ กรุณาลองใหม่');
  }
  try {
    const tok = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: callbackUrl(),
        client_id: APP.LOGIN_ID, client_secret: APP.LOGIN_SECRET, code_verifier: st.verifier
      }),
      signal: AbortSignal.timeout(15000)
    }).then(r => r.json());
    if (!tok.id_token) throw new Error('token: ' + JSON.stringify(tok));
    // ให้ LINE ตรวจ id_token (ลายเซ็น, อายุ, client_id, nonce) แทนการตรวจ JWT เอง
    const prof = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: tok.id_token, client_id: APP.LOGIN_ID, nonce: st.nonce }),
      signal: AbortSignal.timeout(15000)
    }).then(r => r.json());
    if (!prof.sub) throw new Error('verify: ' + JSON.stringify(prof));

    const now = Date.now();
    const name = clean(prof.name, 100), picture = /^https:\/\//.test(prof.picture || '') ? String(prof.picture) : '';
    db.prepare(`INSERT INTO students (user_id, name, picture, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, picture = excluded.picture, last_seen = excluded.last_seen`)
      .run(prof.sub, name, picture, now, now);
    const token = crypto.randomBytes(32).toString('hex');
    if (sameBrowser) db.prepare('INSERT INTO student_sessions (token, user_id, expires) VALUES (?, ?, ?)')
      .run(token, prof.sub, now + APP.STUDENT_SESSION_SEC * 1000);
    console.log('login: ' + prof.sub + ' (' + name + ')' + (st.pwa ? ' [pwa]' : ''));
    if (st.pwa) {
      // แอปที่ติดตั้ง (โดยเฉพาะ iOS) ไม่ได้ cookie นี้ → ออกรหัส 6 หลักให้นำไปใส่ในแอป
      let code;
      do { code = String(crypto.randomInt(1000000)).padStart(6, '0'); } while (pwaCodes.has(code));
      pwaCodes.set(code, { userId: prof.sub, exp: now + 5 * 60 * 1000 });
      res.writeHead(200, Object.assign({}, BASE_HEADERS, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': sameBrowser ? [cookieSet(COOKIE, token, APP.STUDENT_SESSION_SEC), cookieSet('r3o', '', 0)]
                                  : [cookieSet('r3o', '', 0)],
        'Cache-Control': 'no-store'
      }));
      return res.end(PAGES.loginCode.replace('{{CODE}}', code));
    }
    res.writeHead(302, Object.assign({}, BASE_HEADERS, {
      Location: '/',
      'Set-Cookie': [cookieSet(COOKIE, token, APP.STUDENT_SESSION_SEC), cookieSet('r3o', '', 0)],
      'Cache-Control': 'no-store'
    }));
    res.end();
  } catch (e) {
    console.error('LINE login failed:', e.message);
    fail('เข้าสู่ระบบด้วย LINE ไม่สำเร็จ กรุณาลองใหม่');
  }
}

/* ───────────────────────── Pages ───────────────────────── */

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// เปลี่ยนทุกครั้งที่แก้ pwa.js → เบราว์เซอร์ไม่ใช้ไฟล์เก่าจาก cache
const PWA_VER = crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'public', 'pwa.js'))).digest('hex').slice(0, 8);
function renderPage(name, title) {
  const styles = fs.readFileSync(path.join(VIEWS, 'Styles.html'), 'utf8');
  const manifest = name === 'Admin' ? '/admin.webmanifest' : '/manifest.webmanifest';
  const head = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n` +
               `  <link rel="icon" type="image/jpeg" href="/logo.jpg">\n` +
               // use-credentials: ส่ง cookie ของ Cloudflare ไปด้วย ไม่งั้นโดนหน้า challenge
               `  <link rel="manifest" href="${manifest}" crossorigin="use-credentials">\n` +
               `  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">\n` +
               `  <meta name="mobile-web-app-capable" content="yes">\n` +
               `  <meta name="apple-mobile-web-app-capable" content="yes">\n` +
               `  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n` +
               `  <meta name="apple-mobile-web-app-title" content="${name === 'Admin' ? 'ร้อย3 ผู้ดูแล' : 'ร้อย3'}">\n` +
               `  <script src="/pwa.js?v=${PWA_VER}" defer></script>\n` +
               `  <title>${escHtml(title)}</title>\n  ${styles}\n  <script src="/gas-shim.js"></script>`;
  return fs.readFileSync(path.join(VIEWS, name + '.html'), 'utf8')
    .replace("<?!= include('Styles'); ?>", () => head)
    .replace(/<\?= logo \?>/g, () => escHtml(APP.LOGO));
}
const loginTpl = renderPage('Login', APP.NAME + ' · เข้าสู่ระบบ');
const PAGES = {
  index: renderPage('Index', APP.NAME),
  admin: renderPage('Admin', APP.NAME + ' · ผู้ดูแล'),
  login: loginTpl.replace('{{MSG}}', ''),
  loginError: loginTpl,   // {{MSG}} แทนที่ตอนแสดงผล
  loginMissing: loginTpl.replace('{{MSG}}', 'ระบบยังไม่ได้ตั้งค่า LINE Login — กรุณาแจ้งผู้ดูแลระบบ'),
  loginCode: renderPage('LoginCode', APP.NAME + ' · รหัสเข้าสู่ระบบ')
};
/** หน้าฟอร์ม + ข้อมูลนักเรียนที่ล็อกอิน (JSON ใน <script> — escape '<' กันปิดแท็ก) */
const indexFor = s => PAGES.index.replace('<!--R3_USER-->', () =>
  '<script>window.R3_USER=' + JSON.stringify({ name: s.name, picture: s.picture }).replace(/</g, '\\u003c') + ';</script>');
const SHIM = fs.readFileSync(path.join(__dirname, 'public', 'gas-shim.js'));
const LOGO_FILE = fs.readFileSync(path.join(__dirname, 'public', 'logo.jpg'));   // ไอคอนแท็บเบราว์เซอร์

/** ไฟล์คงที่ใน public/ (PWA: manifest, service worker, ไอคอน, หน้า offline) */
const STATIC_TYPES = { '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
                       '.png': 'image/png', '.jpg': 'image/jpeg', '.html': 'text/html; charset=utf-8' };
const STATIC = new Map();
for (const f of ['pwa.js', 'sw.js', 'manifest.webmanifest', 'admin.webmanifest', 'offline.html',
                 ...fs.readdirSync(path.join(__dirname, 'public', 'icons')).map(f => 'icons/' + f)]) {
  STATIC.set('/' + f, {
    body: fs.readFileSync(path.join(__dirname, 'public', f)),
    type: STATIC_TYPES[path.extname(f)],
    // sw.js ต้องไม่ถูก cache นาน ไม่งั้นอัปเดตไม่ถึงผู้ใช้
    cache: f === 'sw.js' || f.endsWith('.webmanifest') ? 'no-cache' : 'public, max-age=86400'
  });
}

/* ───────────────────────── HTTP ───────────────────────── */

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY'
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({}, BASE_HEADERS, headers));
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj),
  { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new UserError('ข้อมูลมีขนาดใหญ่เกินไป')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** ส่งวิดีโอแบบรองรับ Range (iPhone/Safari และ LINE ต้องใช้เพื่อเล่น/เลื่อน) */
function sendVideo(req, res, file, cache) {
  const size = fs.statSync(file).size;
  // .mov ส่วนใหญ่เป็น H.264/HEVC ในกล่องแบบเดียวกับ mp4 → ส่งเป็น video/mp4 ให้ Chrome/LINE เล่นได้
  const h = Object.assign({}, BASE_HEADERS, {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': cache, 'X-Robots-Tag': 'noindex'
  });
  const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  let start = 0, end = size - 1, code = 200;
  if (r && (r[1] || r[2])) {
    if (r[1]) { start = Number(r[1]); if (r[2]) end = Math.min(Number(r[2]), size - 1); }
    else start = Math.max(0, size - Number(r[2]));   // bytes=-N
    if (start > end || start >= size) {
      res.writeHead(416, Object.assign(h, { 'Content-Range': 'bytes */' + size })); return res.end();
    }
    code = 206; h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  h['Content-Length'] = end - start + 1;
  res.writeHead(code, h);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

/** อัปโหลดวิดีโอ: body = ไฟล์ดิบ (ไม่ใช่ base64) เขียนลงดิสก์ทีละส่วน ไม่กินแรม */
async function uploadVideo(req, res) {
  const tmp = path.join(IMG_DIR, '.up-' + crypto.randomBytes(8).toString('hex'));
  try {
    const ctx = { ip: clientIp(req), student: studentFromReq(req), cookies: [] };
    requireStudent(ctx);
    throttle('upv', APP.MAX_PER_10MIN * APP.MAX_VIDEOS);
    if (Number(req.headers['content-length'] || 0) > APP.MAX_VIDEO_BYTES) fail('วิดีโอใหญ่เกิน ' + (APP.MAX_VIDEO_BYTES >> 20) + ' MB');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > APP.MAX_VIDEO_BYTES) { req.destroy(); out.destroy(); reject(new UserError('วิดีโอใหญ่เกิน ' + (APP.MAX_VIDEO_BYTES >> 20) + ' MB')); }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
    const fd = fs.openSync(tmp, 'r'), head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd);
    const ext = videoExt(head);
    if (!ext) fail('วิดีโอต้องเป็นไฟล์ MP4 / MOV / WEBM');
    const id = crypto.randomBytes(24).toString('base64url');
    const src = path.join(IMG_DIR, id + '.' + ext + '.orig');
    fs.renameSync(tmp, src);
    queueTranscode(id, src, ext);
    const shared = APP.LINE_IMAGES, t = Date.now();
    return json(res, 200, { ok: true, result: { id, shared, t, sig: sign([id, shared ? 1 : 0, t].join('|')) } });
  } catch (e) {
    fs.rm(tmp, { force: true }, () => {});
    if (e instanceof UserError) return json(res, 200, { ok: false, error: e.message });
    console.error('uploadVideo:', e);
    return json(res, 500, { ok: false, error: 'อัปโหลดวิดีโอไม่สำเร็จ กรุณาลองใหม่' });
  }
}

// nginx ส่ง IP จริงจาก Cloudflare มาใน X-Real-IP
const clientIp = req => String(req.headers['x-real-ip'] || req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (p === '/' || p === '/index.html') {
      const html = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
      if (url.searchParams.get('page') === 'admin') return send(res, 200, PAGES.admin, html);
      const s = studentFromReq(req);
      return send(res, 200, s ? indexFor(s) : PAGES.login, html);
    }
    if (p === '/login') return startLogin(res, url.searchParams.get('pwa') === '1');
    if (p === '/auth/callback') return finishLogin(req, res, url);
    if (p === '/logout') {
      const t = parseCookies(req)[COOKIE];
      if (t) db.prepare('DELETE FROM student_sessions WHERE token = ?').run(t);
      return send(res, 302, '', { Location: '/', 'Set-Cookie': cookieSet(COOKIE, '', 0), 'Cache-Control': 'no-store' });
    }
    if (p === '/admin') {
      return send(res, 200, PAGES.admin, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex'
      });
    }
    if (p === '/gas-shim.js') {
      return send(res, 200, SHIM, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    }
    if (STATIC.has(p)) {
      const f = STATIC.get(p);
      return send(res, 200, f.body, { 'Content-Type': f.type, 'Cache-Control': f.cache });
    }
    if (p === '/logo.jpg' || p === '/favicon.ico') {
      return send(res, 200, LOGO_FILE, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
    }
    if (p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

    const m = p.match(/^\/i\/([\w-]+)(\/t)?$/);
    if (m) {
      let file = imgPath(m[1]);
      if (file && !APP.LINE_IMAGES) {
        try { auth(url.searchParams.get('s')); } catch (e) { return send(res, 403, 'Forbidden'); }
      }
      if (!file) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      const cache = APP.LINE_IMAGES ? 'public, max-age=31536000, immutable' : 'private, max-age=86400';
      if (m[2]) {   // ภาพตัวอย่างวิดีโอ (ไม่มี → โลโก้)
        if (!isVideo(file)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
        const t = thumbFile(m[1]);
        if (!fs.existsSync(t)) return send(res, 200, LOGO_FILE, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300' });
        return send(res, 200, fs.readFileSync(t), { 'Content-Type': 'image/jpeg', 'Cache-Control': cache, 'X-Robots-Tag': 'noindex' });
      }
      if (isVideo(file)) return sendVideo(req, res, file, cache);
      return send(res, 200, fs.readFileSync(file), {
        'Content-Type': MIME[path.extname(file)],
        'Cache-Control': cache,
        'X-Robots-Tag': 'noindex'
      });
    }
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }

  if (req.method === 'POST' && p === '/upload/video') return uploadVideo(req, res);

  if (req.method === 'POST' && p.startsWith('/api/')) {
    const fn = decodeURIComponent(p.slice(5));
    if (!Object.hasOwn(API, fn)) return json(res, 404, { ok: false, error: 'ไม่พบฟังก์ชัน ' + fn });
    try {
      const args = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8') || '[]');
      const ctx = { ip: clientIp(req), student: studentFromReq(req), cookies: [] };
      const result = await API[fn](ctx, ...(Array.isArray(args) ? args : []));
      if (ctx.cookies.length) res.setHeader('Set-Cookie', ctx.cookies);
      return json(res, 200, { ok: true, result: result === undefined ? null : result });
    } catch (e) {
      if (e instanceof UserError) return json(res, 200, { ok: false, error: e.message });
      console.error('API ' + fn + ':', e);
      return json(res, 500, { ok: false, error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' });
    }
  }

  // LINE webhook — บันทึก event + ระบบสนทนาครูฝึก ↔ นักเรียน
  if (req.method === 'POST' && p === '/webhook') {
    let body = {};
    try {
      const raw = await readBody(req, 1024 * 1024);
      if (LINE_SECRET) {
        const sig = crypto.createHmac('sha256', LINE_SECRET).update(raw).digest('base64');
        if (!safeEq(sig, req.headers['x-line-signature'] || '')) return send(res, 401, 'Bad signature');
      }
      body = JSON.parse(raw.toString('utf8') || '{}');
      const count = db.prepare('SELECT COUNT(*) n FROM line_log').get().n;
      if (count < 5000) {
        const ins = db.prepare('INSERT INTO line_log (ts, source_type, source_id, event_type, text) VALUES (?, ?, ?, ?, ?)');
        for (const ev of body.events || []) {
          const s = ev.source || {};
          const text = ev.message && ev.message.text ? String(ev.message.text).slice(0, 100) : '';
          ins.run(Date.now(), s.type || '', s.groupId || s.roomId || s.userId || '', ev.type || '', text);
        }
      }
    } catch (e) { /* ignore */ }
    send(res, 200, 'OK', { 'Content-Type': 'text/plain' });   // ตอบ LINE ทันที แล้วค่อยประมวลผล
    // ไม่มี secret = ปลอม event ได้ → ไม่ทำงานสนทนา (กันคนแอบส่งข้อความในนามครูฝึก)
    if (!LINE_SECRET) { if ((body.events || []).length) console.warn('webhook: ยังไม่ได้ตั้ง LINE_CHANNEL_SECRET — ปิดระบบสนทนา'); return; }
    for (const ev of body.events || []) {
      if (ev.deliveryContext && ev.deliveryContext.isRedelivery) continue;
      handleEvent(ev).catch(e => console.error('webhook event:', e));
    }
    return;
  }

  return send(res, 405, 'Method not allowed');
}

/* ───────────────────────── Main ───────────────────────── */

const cmd = process.argv[2];
if (cmd === 'set-password') {
  const pw = process.argv[3] || '';
  if (pw.length < 3) { console.error('รหัสผ่านต้องยาวอย่างน้อย 3 ตัวอักษร'); process.exit(1); }
  setting.set('ADMIN_HASH', hash(pw));
  db.prepare('DELETE FROM sessions').run();
  console.log('ตั้งรหัสผ่านผู้ดูแลแล้ว (session เดิมทั้งหมดถูกออกจากระบบ)');
} else if (cmd === 'test-line') {
  notifyLine({
    id: 'R3-TEST00', type: 'แจ้งปัญหา', time: Date.now(), noMap: true,
    detail: 'ถ้าเห็นการ์ดนี้ แปลว่าระบบแจ้งเตือนบนเซิร์ฟเวอร์ใหม่ใช้งานได้ ✅', contact: '',
    images: [], lineImages: []
  }).then(() => process.exit(0));
} else {
  cleanup();
  setInterval(cleanup, 6 * 3600 * 1000).unref();
  // วิดีโอที่ค้างแปลง (เซิร์ฟเวอร์รีสตาร์ทระหว่างแปลง) → แปลงต่อ
  for (const f of fs.readdirSync(IMG_DIR)) {
    const m = /^([\w-]+)\.(mp4|mov|webm)\.orig$/.exec(f);
    if (m) { fs.rmSync(path.join(IMG_DIR, m[1] + '.tmp.mp4'), { force: true }); queueTranscode(m[1], path.join(IMG_DIR, f), m[2]); }
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, 'Error'); });
  });
  server.requestTimeout = 60000;
  server.listen(APP.PORT, '0.0.0.0', () => console.log(`${APP.NAME} listening on :${APP.PORT} (APP_URL=${APP.APP_URL || '-'})`));
  const stop = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
