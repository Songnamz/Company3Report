/* ร้อย3 PWA: service worker + ปุ่มติดตั้งแอป + เข้าสู่ระบบในแอปที่ติดตั้งแล้ว */
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }

  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isLineApp = / Line\//i.test(ua);
  var standalone = window.navigator.standalone === true ||
                   (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  var isAdmin = location.pathname.indexOf('/admin') === 0 || /[?&]page=admin/.test(location.search);
  var DISMISS_KEY = 'r3_pwa_dismiss' + (isAdmin ? '_admin' : '');

  /* ───── ในแอปที่ติดตั้งแล้ว: หน้าเข้าสู่ระบบใช้รหัส 6 หลัก ─────
   * iOS เปิดหน้า LINE Login ในหน้าต่างแยกที่ไม่แชร์ cookie กับแอป
   * → หลังล็อกอินเสร็จ ระบบแสดงรหัส 6 หลัก ให้นำมาใส่ในแอป */
  function setupStandaloneLogin() {
    var btn = document.querySelector('a.line-btn');
    var box = document.getElementById('pwaCodeBox');
    if (!btn || !box) return;
    btn.setAttribute('href', '/login?pwa=1');
    box.hidden = false;
    var form = document.getElementById('pwaCodeForm'), input = document.getElementById('pwaCode'),
        err = document.getElementById('pwaCodeErr');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = (input.value || '').replace(/\D/g, '');
      if (code.length !== 6) { err.textContent = 'กรุณาใส่รหัส 6 หลัก'; return; }
      var b = form.querySelector('button'); b.disabled = true; err.textContent = '';
      google.script.run
        .withSuccessHandler(function () { location.replace('/'); })
        .withFailureHandler(function (x) { b.disabled = false; err.textContent = String((x && x.message) || x); })
        .pwaRedeem(code);
    });
    // Android: แอปใช้ cookie ร่วมกับ Chrome → กลับมาที่แอปแล้วโหลดใหม่ก็เข้าสู่ระบบแล้ว
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !input.value) location.reload();
    });
  }

  /* ───── แถบชวนติดตั้งแอป ───── */
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e; showBanner('android');
  });
  window.addEventListener('appinstalled', hideBanner);

  var isIOSChrome = /CriOS|FxiOS|EdgiOS/.test(ua);   // iOS เบราว์เซอร์อื่น: ปุ่มแชร์อยู่มุมขวาบน
  var SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="แชร์"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  var ADD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';

  /** เปิดหน้านี้ด้วยเบราว์เซอร์ปกติ (ออกจากเบราว์เซอร์ในแอป LINE) */
  function openExternal() {
    var u = new URL(location.href);
    u.searchParams.set('openExternalBrowser', '1');
    location.href = u.toString();
  }

  /** iOS: ติดตั้งอัตโนมัติไม่ได้ (Apple ไม่อนุญาต) → แสดงขั้นตอนเพิ่มไปยังหน้าจอโฮม */
  function showIOSGuide() {
    if (document.getElementById('pwaGuide')) return;
    var g = document.createElement('div');
    g.id = 'pwaGuide'; g.className = 'pwa-guide'; g.setAttribute('role', 'dialog'); g.setAttribute('aria-modal', 'true');
    g.setAttribute('aria-label', 'วิธีติดตั้งแอปบน iPhone');
    g.innerHTML =
      '<div class="pwa-sheet">' +
        '<div class="pwa-sheet-head"><img src="/icons/icon-192.png" alt="">' +
          '<b>ติดตั้งแอป ' + (isAdmin ? 'ร้อย3 ผู้ดูแล' : 'ร้อย3') + ' บน iPhone / iPad</b>' +
          '<button type="button" class="pwa-close" aria-label="ปิด">✕</button></div>' +
        '<ol class="pwa-steps">' +
          '<li><span class="pwa-ico">' + SHARE_ICON + '</span><span>แตะปุ่ม <b>แชร์</b> ' +
            (isIOSChrome ? 'ที่มุมขวาบน (ข้างช่องที่อยู่เว็บ)' : 'ที่แถบด้านล่างของ Safari (บน iPad อยู่ด้านบน)') + '</span></li>' +
          '<li><span class="pwa-ico">' + ADD_ICON + '</span><span>เลื่อนลง แล้วเลือก <b>“เพิ่มไปยังหน้าจอโฮม”</b><br><small>(Add to Home Screen)</small></span></li>' +
          '<li><span class="pwa-ico pwa-num">✓</span><span>แตะ <b>“เพิ่ม”</b> มุมขวาบน — ไอคอน ร้อย3 จะอยู่บนหน้าจอโฮม</span></li>' +
        '</ol>' +
        '<button type="button" class="pwa-install pwa-ok">เข้าใจแล้ว</button>' +
      '</div>' +
      (isIOSChrome ? '' : '<div class="pwa-arrow" aria-hidden="true">↓</div>');
    document.body.appendChild(g);
    var close = function () { g.remove(); };
    g.querySelector('.pwa-close').addEventListener('click', close);
    g.querySelector('.pwa-ok').addEventListener('click', close);
    g.addEventListener('click', function (e) { if (e.target === g) close(); });
  }

  function showBanner(kind) {
    if (standalone || document.getElementById('pwaBanner')) return;
    var until = Number(store.get(DISMISS_KEY) || 0);
    if (until > Date.now()) return;

    var bar = document.createElement('div');
    bar.id = 'pwaBanner'; bar.className = 'pwa-banner'; bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'ติดตั้งแอป');
    bar.innerHTML =
      '<img src="/icons/icon-192.png" alt="">' +
      '<div class="pwa-text"><b>ติดตั้งแอป ' + (isAdmin ? 'ร้อย3 ผู้ดูแล' : 'ร้อย3') + '</b>' +
      (kind === 'line'
        ? '<span>ติดตั้งในแอป LINE ไม่ได้ — เปิดใน' + (isIOS ? ' Safari' : 'เบราว์เซอร์') + 'ก่อน</span>'
        : '<span>เปิดใช้งานได้เร็ว จากหน้าจอโฮม</span>') +
      '</div>' +
      '<button type="button" class="pwa-install">' + (kind === 'line' ? (isIOS ? 'เปิดใน Safari' : 'เปิดในเบราว์เซอร์') : 'ติดตั้ง') + '</button>' +
      '<button type="button" class="pwa-close" aria-label="ปิด">✕</button>';
    document.body.appendChild(bar);
    document.body.classList.add('has-pwa-banner');

    var inst = bar.querySelector('.pwa-install');
    if (inst) inst.addEventListener('click', function () {
      if (kind === 'line') return openExternal();
      if (kind === 'ios') return showIOSGuide();
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () { deferred = null; hideBanner(); });
    });
    bar.querySelector('.pwa-close').addEventListener('click', function () {
      store.set(DISMISS_KEY, String(Date.now() + 14 * 86400000));   // ไม่ถามซ้ำ 14 วัน
      hideBanner();
    });
  }
  function hideBanner() {
    var b = document.getElementById('pwaBanner');
    if (b) b.remove();
    document.body.classList.remove('has-pwa-banner');
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (standalone) { setupStandaloneLogin(); return; }
    // ในแอป LINE ติดตั้งไม่ได้ → ชวนเปิดในเบราว์เซอร์ปกติ
    if (isLineApp) return setTimeout(function () { showBanner('line'); }, 1200);
    // iOS ไม่มี beforeinstallprompt → ปุ่ม "ติดตั้ง" เปิดขั้นตอนเพิ่มไปยังหน้าจอโฮม
    if (isIOS) setTimeout(function () { showBanner('ios'); }, 1200);
  });
})();
