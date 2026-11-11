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

  function showBanner(kind) {
    if (standalone || isLineApp || document.getElementById('pwaBanner')) return;
    var until = Number(store.get(DISMISS_KEY) || 0);
    if (until > Date.now()) return;

    var bar = document.createElement('div');
    bar.id = 'pwaBanner'; bar.className = 'pwa-banner'; bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'ติดตั้งแอป');
    var share = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="แชร์"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
    bar.innerHTML =
      '<img src="/icons/icon-192.png" alt="">' +
      '<div class="pwa-text"><b>ติดตั้งแอป ' + (isAdmin ? 'ร้อย3 ผู้ดูแล' : 'ร้อย3') + '</b>' +
      (kind === 'ios'
        ? '<span>แตะ ' + share + ' แล้วเลือก “เพิ่มไปยังหน้าจอโฮม”</span>'
        : '<span>เปิดใช้งานได้เร็ว จากหน้าจอโฮม</span>') +
      '</div>' +
      (kind === 'android' ? '<button type="button" class="pwa-install">ติดตั้ง</button>' : '') +
      '<button type="button" class="pwa-close" aria-label="ปิด">✕</button>';
    document.body.appendChild(bar);
    document.body.classList.add('has-pwa-banner');

    var inst = bar.querySelector('.pwa-install');
    if (inst) inst.addEventListener('click', function () {
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
    // iOS ไม่มีปุ่มติดตั้งอัตโนมัติ → แสดงวิธีเพิ่มไปยังหน้าจอโฮม
    if (isIOS) setTimeout(function () { showBanner('ios'); }, 1200);
  });
})();
