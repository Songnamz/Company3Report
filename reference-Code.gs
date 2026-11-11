/**
 * ร้อย3 — ช่องทางแจ้งปัญหา / ข้อเสนอแนะ ถึงฝ่ายไอที (ไม่ระบุตัวตน)
 * Google Apps Script (bound to a Google Sheet) + LINE Messaging API
 *
 * Script Properties ที่ใช้:
 *   LINE_TOKEN       – Channel access token (long-lived) ของ LINE Official Account
 *   LINE_TO          – groupId / userId ที่จะส่งแจ้งเตือน (หลายค่าคั่นด้วย ,)
 *   APP_URL          – URL ของ Web App (…/exec) ใช้ทำลิงก์ในข้อความ LINE
 *   ADMIN_HASH, SALT – ระบบสร้างเอง (ห้ามแก้)
 *   IMAGE_FOLDER_ID  – ระบบสร้างเอง: โฟลเดอร์ Google Drive ที่เก็บรูปแนบ
 */

const APP = {
  NAME: 'ร้อย3',
  SHEET: 'Reports',
  LINE_LOG: 'LineLog',
  SESSION_SEC: 6 * 60 * 60,   // อายุ session ผู้ดูแล (สูงสุด 6 ชม. ตามข้อจำกัด CacheService)
  MAX_PER_10MIN: 30,          // กันสแปม: รับได้ไม่เกินกี่เรื่องต่อ 10 นาที (ทั้งระบบ)

  // ── รูปแนบ ──
  IMG_FOLDER: 'ร้อย3 · รูปแนบ',  // ชื่อโฟลเดอร์ใน Drive (สร้างอัตโนมัติตอนรัน setup)
  MAX_IMAGES: 4,                 // สูงสุดกี่รูปต่อเรื่อง (LINE ส่งได้ 5 ข้อความ/ครั้ง = ข้อความ 1 + รูป 4)
  MAX_IMG_BYTES: 1024 * 1024,    // ขนาดสูงสุดต่อรูปหลังย่อ (LINE preview จำกัด 1 MB)
  // true  = เปิดลิงก์รูปเป็น "ทุกคนที่มีลิงก์ดูได้" เพื่อให้ LINE ดึงรูปไปแสดงในกลุ่มได้
  // false = รูปเป็นส่วนตัวใน Drive เท่านั้น — LINE จะได้แค่ข้อความ "มีรูปแนบ" ให้ไปดูในหน้าผู้ดูแล
  LINE_IMAGES: true,

  // โลโก้ (แนะนำ: อัปโหลดรูปไว้ที่โฮสต์ของตัวเอง แล้วใส่ URL ที่นี่ — ลิงก์ gstatic อาจหมดอายุได้)
  LOGO: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQL5X0x24LvhYIn564hFTIOJUnA68EriiiZGaNFlFj1LA&s=10'
};

const HEADERS = ['ID', 'Timestamp', 'Type', 'Detail', 'Contact', 'Images'];
const COL = HEADERS.reduce((o, h, i) => (o[h] = i, o), {});

/* ───────────────────────── Web routes ───────────────────────── */

function doGet(e) {
  const isAdmin = e && e.parameter && e.parameter.page === 'admin';
  const t = HtmlService.createTemplateFromFile(isAdmin ? 'Admin' : 'Index');
  t.logo = PropertiesService.getScriptProperties().getProperty('LOGO_URL') || APP.LOGO;
  return t.evaluate()
    .setTitle(isAdmin ? APP.NAME + ' · ผู้ดูแล' : APP.NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** LINE webhook — ใช้แค่ตอนติดตั้ง เพื่อเก็บ groupId ลงชีต LineLog */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const lg = SpreadsheetApp.getActive().getSheetByName(APP.LINE_LOG);
    if (lg && lg.getLastRow() < 200) {
      (body.events || []).forEach(ev => {
        const s = ev.source || {};
        const text = ev.message && ev.message.text ? String(ev.message.text).slice(0, 100) : '';
        lg.appendRow([new Date(), s.type || '', s.groupId || s.roomId || s.userId || '',
                      ev.type || '', safeCell_(text)]);
      });
    }
  } catch (err) { /* ignore */ }
  return ContentService.createTextOutput('OK');
}

/* ───────────────────────── Setup (รันจาก editor) ───────────────────────── */

function setup() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(APP.SHEET) || ss.insertSheet(APP.SHEET);
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const current = sh.getLastRow() ? sh.getRange(1, 1, 1, lastCol).getValues()[0].join('|') : '';
  if (current !== HEADERS.join('|')) {
    if (current === HEADERS.slice(0, -1).join('|')) {
      // อัปเกรดจากเวอร์ชันก่อน (ยังไม่มีคอลัมน์ Images) — เพิ่มคอลัมน์ให้ ข้อมูลเดิมไม่หาย
      sh.getRange(1, HEADERS.length).setValue('Images').setFontWeight('bold');
    } else if (sh.getLastRow() > 1) {
      throw new Error('ชีต ' + APP.SHEET + ' มีข้อมูลรูปแบบเก่าอยู่ — ลบหรือเปลี่ยนชื่อแท็บนี้ก่อน แล้วรัน setup ใหม่');
    } else {
      sh.clear();
      sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }
  const lg = ss.getSheetByName(APP.LINE_LOG) || ss.insertSheet(APP.LINE_LOG);
  if (lg.getLastRow() === 0) lg.appendRow(['Timestamp', 'SourceType', 'SourceId', 'EventType', 'Text']);

  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('SALT')) p.setProperty('SALT', Utilities.getUuid());
  const folder = folder_();   // สร้างโฟลเดอร์รูป + ขอสิทธิ์ Drive
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'cleanupImages')) {
    ScriptApp.newTrigger('cleanupImages').timeBased().everyDays(1).atHour(3).create();
  }
  Logger.log('Setup เรียบร้อย — โฟลเดอร์รูป: ' + folder.getUrl());
}

function setAdminPassword() {
  const NEW_PASSWORD = 'CHANGE_ME'; // ← ใส่รหัสใหม่ แล้วกด Run จากนั้นเปลี่ยนกลับเป็น CHANGE_ME
  if (NEW_PASSWORD === 'CHANGE_ME' || NEW_PASSWORD.length < 3) {
    throw new Error('กรุณาตั้งรหัสผ่านอย่างน้อย 3 ตัวอักษรในตัวแปร NEW_PASSWORD ก่อน');
  }
  setup();
  PropertiesService.getScriptProperties().setProperty('ADMIN_HASH', hash_(NEW_PASSWORD));
  Logger.log('ตั้งรหัสผ่านผู้ดูแลแล้ว — อย่าลืมเปลี่ยน NEW_PASSWORD กลับเป็น CHANGE_ME');
}

function testLine() {
  notifyLine_({
    id: 'R3-TEST00', type: 'แจ้งปัญหา', time: new Date(),
    detail: 'ถ้าเห็นการ์ดนี้ แปลว่าระบบแจ้งเตือนใช้งานได้ ✅', contact: '',
    images: [], lineImages: []
  });
}

/** ทดสอบการ์ดแบบแกลเลอรี — ใช้รูปในโฟลเดอร์รูปแนบสูงสุด 4 รูป (ต้องเคยมีคนส่งรูปมาแล้ว) */
function testLineWithImage() {
  const files = folder_().getFiles();
  const ids = [];
  while (files.hasNext() && ids.length < 4) ids.push(files.next().getId());
  if (!ids.length) throw new Error('ยังไม่มีรูปในโฟลเดอร์ — ลองส่งเรื่องพร้อมรูปจากหน้าเว็บก่อน');
  notifyLine_({
    id: 'R3-TEST01', type: 'ข้อเสนอแนะ', time: new Date(),
    detail: 'ทดสอบการ์ดแบบมีรูปภาพ 📷\nบรรทัดที่สองของรายละเอียด', contact: '081-234-5678',
    images: ids, lineImages: ids
  });
}

/* ───────────────────────── Public API (ไม่ต้องล็อกอิน) ───────────────────────── */

function submitReport(form) {
  form = form || {};
  if (form.website) return { ok: true };   // honeypot: บอทกรอกช่องที่ซ่อนไว้

  const r = {
    type: form.type === 'suggestion' ? 'ข้อเสนอแนะ' : 'แจ้งปัญหา',
    detail: clean_(form.detail, 3000),
    contact: clean_(form.contact, 120)
  };
  if (r.detail.length < 5) throw new Error('กรุณาอธิบายรายละเอียดอย่างน้อย 5 ตัวอักษร');

  // รูปถูกอัปโหลดล่วงหน้าแล้วผ่าน uploadImage() — ที่นี่แค่ตรวจลายเซ็นว่าเป็นไฟล์ที่ระบบออกให้จริง
  const raw = Array.isArray(form.images) ? form.images : [];
  if (raw.length > APP.MAX_IMAGES) throw new Error('แนบรูปได้สูงสุด ' + APP.MAX_IMAGES + ' รูป');
  const ups = raw.map(verifyUpload_).filter((u, i, a) => a.findIndex(x => x.id === u.id) === i);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { throttle_('rate', APP.MAX_PER_10MIN); } finally { lock.releaseLock(); }

  r.id = newId_();
  r.images = ups.map(u => u.id);
  r.lineImages = ups.filter(u => u.shared).map(u => u.id);

  r.time = new Date();
  lock.waitLock(10000);
  try {
    sheet_().appendRow([r.id, r.time, r.type, r.detail, r.contact, r.images.join(',')].map(safeCell_));
  } finally {
    lock.releaseLock();
  }

  try { notifyLine_(r); } catch (err) { console.error('LINE notify failed: ' + err); }
  return { ok: true };
}

/**
 * อัปโหลดรูปทีละรูป — หน้าเว็บเรียกทันทีที่ผู้ใช้เลือกรูป (ทำงานเบื้องหลังระหว่างพิมพ์รายละเอียด)
 * คืน { id, shared, t, sig } — sig คือลายเซ็น HMAC กันคนแอบส่ง fileId อื่นมาผูกกับเรื่อง
 * รูปที่อัปโหลดแล้วแต่ไม่ได้ส่งเรื่อง จะถูกลบโดย cleanupImages() (รันทุกคืน)
 */
function uploadImage(b64) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { throttle_('up', APP.MAX_PER_10MIN * APP.MAX_IMAGES); } finally { lock.releaseLock(); }

  const b = decodeImage_(b64, -1);
  const ext = b.mime === 'image/png' ? 'png' : 'jpg';
  const name = 'R3_' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss') +
               '_' + Utilities.getUuid().slice(0, 6) + '.' + ext;
  const file = folder_().createFile(Utilities.newBlob(b.bytes, b.mime, name));

  let shared = false;
  if (APP.LINE_IMAGES) {
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      shared = true;
    } catch (e) {
      console.warn('เปิดลิงก์รูปไม่ได้ (อาจถูกจำกัดโดยนโยบาย Workspace): ' + e);
    }
  }
  const id = file.getId(), t = Date.now();
  return { id: id, shared: shared, t: t, sig: sign_([id, shared ? 1 : 0, t].join('|')) };
}

/* ───────────────────────── Admin API (ต้องล็อกอิน) ───────────────────────── */

function adminLogin(password) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('login_fails') || 0);
  if (fails >= 10) throw new Error('ใส่รหัสผิดหลายครั้งเกินไป กรุณารอ 15 นาที');

  const stored = PropertiesService.getScriptProperties().getProperty('ADMIN_HASH');
  if (!stored) throw new Error('ยังไม่ได้ตั้งรหัสผ่านผู้ดูแล (รัน setAdminPassword ใน editor)');

  if (hash_(String(password || '')) !== stored) {
    cache.put('login_fails', String(fails + 1), 900);
    Utilities.sleep(800);
    throw new Error('รหัสผ่านไม่ถูกต้อง');
  }
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  cache.put('sess_' + token, '1', APP.SESSION_SEC);
  return token;
}

function adminLogout(token) {
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return true;
}

function getReports(token) {
  auth_(token);
  const sh = sheet_();
  const n = sh.getLastRow() - 1;
  const items = n < 1 ? [] : sh.getRange(2, 1, n, HEADERS.length).getValues()
    .filter(v => v[COL.ID])
    .map(rowToObj_)
    .reverse();
  return { items: items };
}

/** ส่งรูปให้หน้าผู้ดูแลเป็น data URL — อ่านได้เฉพาะไฟล์ในโฟลเดอร์รูปของระบบเท่านั้น */
function getImage(token, fileId) {
  auth_(token);
  const id = String(fileId || '');
  if (!/^[\w-]{20,}$/.test(id)) throw new Error('รหัสรูปไม่ถูกต้อง');

  let file;
  try { file = DriveApp.getFileById(id); } catch (e) { throw new Error('ไม่พบรูปภาพ (อาจถูกลบไปแล้ว)'); }
  if (file.isTrashed()) throw new Error('ไม่พบรูปภาพ (อาจถูกลบไปแล้ว)');

  const folderId = folder_().getId();
  const parents = file.getParents();
  let inFolder = false;
  while (parents.hasNext()) if (parents.next().getId() === folderId) { inFolder = true; break; }
  if (!inFolder) throw new Error('ไม่พบรูปภาพ');

  const blob = file.getBlob();
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/* ───────────────────────── Images ───────────────────────── */

function folder_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('IMAGE_FOLDER_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* โฟลเดอร์หาย — สร้างใหม่ */ }
  }
  const f = DriveApp.createFolder(APP.IMG_FOLDER);
  p.setProperty('IMAGE_FOLDER_ID', f.getId());
  return f;
}

/** base64 → { bytes, mime } ตรวจ magic bytes จริง (ไม่เชื่อชนิดไฟล์จากฝั่ง browser) */
function decodeImage_(b64, i) {
  const label = i >= 0 ? 'รูปที่ ' + (i + 1) : 'รูปภาพ';
  const s = String(b64 || '').replace(/^data:[^,]*,/, '');
  if (!s) throw new Error(label + ' ไม่ถูกต้อง');
  if (s.length > APP.MAX_IMG_BYTES * 1.4) throw new Error(label + ' มีขนาดใหญ่เกินไป');

  let bytes;
  try { bytes = Utilities.base64Decode(s); } catch (e) { throw new Error(label + ' ไม่ถูกต้อง'); }
  if (bytes.length > APP.MAX_IMG_BYTES) throw new Error(label + ' มีขนาดใหญ่เกินไป');

  const b = k => bytes[k] & 0xFF;
  let mime = '';
  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) mime = 'image/jpeg';
  else if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) mime = 'image/png';
  if (!mime) throw new Error(label + ' ต้องเป็นไฟล์รูปภาพ (JPG / PNG)');

  return { bytes: bytes, mime: mime };
}

/** ตรวจผลอัปโหลดที่หน้าเว็บส่งกลับมา: ลายเซ็นถูกต้อง + ไม่เก่าเกิน 12 ชม. */
function verifyUpload_(u) {
  u = u || {};
  const id = String(u.id || ''), shared = u.shared === true, t = Number(u.t) || 0;
  const ok = /^[\w-]{20,}$/.test(id) &&
             Date.now() - t < 12 * 3600 * 1000 &&
             String(u.sig || '') === sign_([id, shared ? 1 : 0, t].join('|'));
  if (!ok) throw new Error('รูปแนบไม่ถูกต้องหรือหมดอายุ — กรุณาลบรูปแล้วแนบใหม่');
  return { id: id, shared: shared };
}

function sign_(s) {
  const key = PropertiesService.getScriptProperties().getProperty('SALT') || '';
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, key)).slice(0, 32);
}

/**
 * ลบรูปที่อัปโหลดไว้แต่ไม่ได้ถูกผูกกับเรื่องใด (ผู้ใช้กดลบรูป / ปิดหน้าโดยไม่ส่ง) และเก่ากว่า 24 ชม.
 * setup() ตั้ง trigger ให้รันอัตโนมัติทุกคืน ~ตี 3 — รันเองจาก editor ได้เช่นกัน
 */
function cleanupImages() {
  const sh = sheet_();
  const n = sh.getLastRow() - 1;
  const used = new Set(n < 1 ? [] : sh.getRange(2, COL.Images + 1, n, 1).getValues()
    .map(v => String(v[0] || '')).join(',').split(',').map(s => s.trim()).filter(Boolean));
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const files = folder_().getFiles();
  let removed = 0;
  while (files.hasNext()) {
    const f = files.next();
    if (!used.has(f.getId()) && f.getDateCreated().getTime() < cutoff) { f.setTrashed(true); removed++; }
  }
  console.log('cleanupImages: ย้ายรูปที่ไม่ได้ใช้ไปถังขยะ ' + removed + ' ไฟล์');
}

/** URL รูปสาธารณะที่ LINE ดึงไปแสดงได้ (ไฟล์ต้องเปิด "ทุกคนที่มีลิงก์")
 *  ถ้ารูปไม่ขึ้นใน LINE ลองเปลี่ยนเป็น: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1600' */
function imgUrl_(id) {
  return 'https://lh3.googleusercontent.com/d/' + id;
}

/* ───────────────────────── LINE ───────────────────────── */

/**
 * ส่งแจ้งเตือนเป็นการ์ด Flex Message:
 *   [หัวการ์ดสีตามประเภท] → [รูปแรกเป็นภาพปก] → [รายละเอียด + รหัส/เวลา/ติดต่อ/รูป] → [ปุ่มเปิดหน้าผู้ดูแล]
 *   รูปที่ 2–4 ส่งตามเป็นข้อความรูปภาพ (กดดูเต็มจอใน LINE ได้)
 * ถ้า LINE ปฏิเสธการ์ด → ส่งแบบข้อความธรรมดาแทน (สำรองอัตโนมัติ)
 */
function notifyLine_(r) {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty('LINE_TOKEN');
  const targets = (p.getProperty('LINE_TO') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || !targets.length) { console.warn('LINE ยังไม่ได้ตั้งค่า (LINE_TOKEN / LINE_TO)'); return; }

  const base = p.getProperty('APP_URL') || ScriptApp.getService().getUrl();
  // openExternalBrowser=1 → LINE เปิดลิงก์ด้วยเบราว์เซอร์ปกติของเครื่อง (Chrome/Safari) แทน in-app browser
  const adminUrl = base ? base + '?page=admin&openExternalBrowser=1' : '';
  const pics = (r.lineImages || []).slice(0, 4);
  const imgMsg = id => ({ type: 'image', originalContentUrl: imgUrl_(id), previewImageUrl: imgUrl_(id) });

  const flex = [flexCard_(r, adminUrl, pics)];   // รูปทั้งหมดอยู่ในการ์ดเป็นแกลเลอรี
  const plain = [{ type: 'text', text: plainText_(r, adminUrl, pics.length) }].concat(pics.map(imgMsg));

  targets.forEach(to => {
    if (linePush_(token, to, flex) === 200) return;
    console.warn('LINE ' + to + ' → ส่งการ์ดไม่สำเร็จ ลองส่งแบบข้อความ');
    if (linePush_(token, to, plain) === 200 || !pics.length) return;
    linePush_(token, to, [{ type: 'text', text: plainText_(r, adminUrl, 0) + '\n\n(ส่งรูปไม่สำเร็จ — ดูรูปได้ในหน้าผู้ดูแล)' }]);
  });
}

/** การ์ด Flex Message (bubble) — ใช้สีชุดเดียวกับหน้าเว็บ */
function flexCard_(r, adminUrl, picIds) {
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
  const when = r.time instanceof Date ? fmt_(r.time) : fmt_(new Date());

  const row = (k, v) => ({
    type: 'box', layout: 'baseline', spacing: 'md',
    contents: [
      { type: 'text', text: k, size: 'sm', color: C.muted, flex: 3 },
      { type: 'text', text: String(v), size: 'sm', color: C.text, flex: 7, wrap: true }
    ]
  });
  const rows = [row('รหัส', r.id), row('เวลา', when)];
  if (r.contact) rows.push(row('ติดต่อกลับ', r.contact));
  else rows.push(row('ผู้แจ้ง', 'ไม่ระบุตัวตน'));
  if (nImg) rows.push(row('รูปแนบ', nImg + ' รูป' + (pics.length < nImg ? ' (ดูครบในหน้าผู้ดูแล)' : '')));

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
      ]
    }
  };

  const hero = galleryHero_(pics);
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

  return {
    type: 'flex',
    altText: (label + ': ' + r.detail).slice(0, 380),   // ข้อความที่แสดงในแจ้งเตือน / รายการแชต
    contents: bubble
  };
}

/**
 * ส่วนภาพบนการ์ด (hero) — จัดเลย์เอาต์ตามจำนวนรูป แตะรูปไหนก็เปิดรูปนั้นเต็มจอ
 *   1 รูป: ภาพเดียวเต็มกว้าง          2 รูป: ซ้าย | ขวา
 *   3 รูป: ใหญ่ซ้าย + เล็ก 2 รูปขวา     4 รูป: ตาราง 2×2
 * มี 2 รูปขึ้นไป → แสดงป้าย "📷 N รูป" มุมขวาบน
 */
function galleryHero_(ids) {
  if (!ids.length) return null;
  const GAP = '2px';
  const tile = (id, ratio) => ({
    type: 'image', url: imgUrl_(id), size: 'full', aspectMode: 'cover', aspectRatio: ratio,
    action: { type: 'uri', uri: imgUrl_(id) }
  });
  const col = (contents) => ({ type: 'box', layout: 'vertical', flex: 1, spacing: GAP, contents: contents });
  const rowBox = (contents) => ({ type: 'box', layout: 'horizontal', spacing: GAP, contents: contents });

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
        contents: [{ type: 'text', text: '📷 ' + ids.length + ' รูป', size: 'xs', color: '#FFFFFF', weight: 'bold' }]
      }
    ]
  };
}

/** ข้อความธรรมดา (ใช้สำรองเมื่อส่งการ์ดไม่ได้) */
function plainText_(r, adminUrl, nSent) {
  const head = r.type === 'แจ้งปัญหา' ? '🔧 มีการแจ้งปัญหา' : '💡 มีข้อเสนอแนะ';
  const detail = r.detail.length > 1000 ? r.detail.slice(0, 1000) + '…' : r.detail;
  const nImg = (r.images || []).length;
  const lines = [head + ': ' + detail, '', 'รหัส: ' + r.id];
  if (r.contact) lines.push('ติดต่อกลับ: ' + r.contact);
  if (nImg) lines.push('📷 แนบรูป ' + nImg + ' รูป' + (nSent < nImg ? ' (ดูได้ในหน้าผู้ดูแล)' : ''));
  if (adminUrl) lines.push('', 'ดูรายการทั้งหมด: ' + adminUrl);
  return lines.join('\n');
}

function linePush_(token, to, messages) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: to, messages: messages }),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) console.error('LINE ' + to + ' → ' + code + ' ' + res.getContentText());
  else console.log('LINE ' + to + ' → OK (' + messages.length + ' ข้อความ)');
  return code;
}

/* ───────────────────────── Helpers ───────────────────────── */

function auth_(token) {
  if (!token || !CacheService.getScriptCache().get('sess_' + token)) throw new Error('SESSION_EXPIRED');
}

function sheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(APP.SHEET);
  if (!sh) throw new Error('ระบบยังไม่ได้ติดตั้ง (รัน setup ใน editor)');
  return sh;
}

function rowToObj_(v) {
  return {
    id: v[COL.ID],
    timestamp: fmt_(v[COL.Timestamp]),
    ts: v[COL.Timestamp] instanceof Date ? v[COL.Timestamp].getTime() : 0,
    type: v[COL.Type],
    detail: String(v[COL.Detail] || ''),
    contact: String(v[COL.Contact] || ''),
    images: String(v[COL.Images] || '').split(',').map(s => s.trim()).filter(Boolean)
  };
}

function clean_(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * บังคับให้ชีตเก็บข้อความเป็น "ข้อความ" เสมอ (ใส่ ' นำหน้า — ไม่แสดงในเซลล์)
 *  - กัน formula injection (ขึ้นต้นด้วย = + - @)
 *  - กันเลข 0 หน้าเบอร์โทรหาย / ถูกแปลงเป็นตัวเลขหรือวันที่ (ขึ้นต้นด้วยตัวเลข เช่น 0922345555, 10/10)
 */
function safeCell_(v) {
  return (typeof v === 'string' && /^[=+\-@\t\r0-9.]/.test(v)) ? "'" + v : v;
}

function hash_(s) {
  const salt = PropertiesService.getScriptProperties().getProperty('SALT') || '';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + s, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function newId_() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += a.charAt(Math.floor(Math.random() * a.length));
  return 'R3-' + s;
}

function throttle_(name, max) {
  const c = CacheService.getScriptCache();
  const k = name + '_' + Math.floor(Date.now() / 600000);
  const n = Number(c.get(k) || 0);
  if (n >= max) throw new Error('ขณะนี้มีการส่งเรื่องจำนวนมาก กรุณาลองใหม่ในอีกสักครู่');
  c.put(k, String(n + 1), 900);
}

function fmt_(d) {
  return d instanceof Date ? Utilities.formatDate(d, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') : String(d || '');
}
