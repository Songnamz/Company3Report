/* ร้อย3 service worker
 * - หน้าเว็บ: ดึงจากเซิร์ฟเวอร์ก่อนเสมอ (สถานะล็อกอิน/ข้อมูลต้องสดใหม่) — ออฟไลน์ → หน้า offline
 * - ไฟล์คงที่ (โลโก้ ไอคอน สคริปต์): ใช้จาก cache แล้วอัปเดตเบื้องหลัง
 * - API / ล็อกอิน / รูปแนบ / webhook: ไม่ยุ่งเลย */
const VERSION = 'r3-v4';
const SHELL = ['/offline.html', '/logo.jpg', '/gas-shim.js', '/pwa.js', '/icons/icon-192.png'];
const STATIC = /^\/(logo\.jpg|favicon\.ico|gas-shim\.js|pwa\.js|offline\.html|icons\/.+)$/;
const BYPASS = /^\/(api\/|auth\/|login|logout|webhook|i\/|upload\/|sw\.js)/;

self.addEventListener('install', e => {
  // ทีละไฟล์ — ถ้าไฟล์ใดโหลดไม่ได้ (เช่น Cloudflare challenge) ก็ยังติดตั้งได้
  e.waitUntil(caches.open(VERSION)
    .then(c => Promise.all(SHELL.map(u => fetch(u, { credentials: 'same-origin' })
      .then(r => r.ok ? c.put(u, r) : null).catch(() => null))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || BYPASS.test(url.pathname)) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  if (STATIC.test(url.pathname)) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
