/**
 * google.script.run → fetch('/api/<fn>')
 * ทำให้หน้า Index.html / Admin.html เดิมจาก Apps Script ใช้งานได้โดยแทบไม่ต้องแก้โค้ด
 *   google.script.run.withSuccessHandler(ok).withFailureHandler(fail).someFn(a, b)
 *   → POST /api/someFn  body: [a, b]   ตอบกลับ { ok: true, result } | { ok: false, error }
 */
(function () {
  function runner(onOk, onFail) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (h) { return runner(h, onFail); };
        if (name === 'withFailureHandler') return function (h) { return runner(onOk, h); };
        if (typeof name !== 'string') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          var fail = function (msg) { if (onFail) onFail(new Error(msg)); };
          fetch('/api/' + encodeURIComponent(name), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args),
            credentials: 'same-origin'
          }).then(function (r) {
            return r.json().catch(function () { return { ok: false, error: 'เซิร์ฟเวอร์ตอบกลับผิดพลาด (' + r.status + ')' }; });
          }).then(function (d) {
            if (d && d.ok) { if (onOk) onOk(d.result); }
            else fail((d && d.error) || 'เกิดข้อผิดพลาด');
          }, function () {
            fail('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
          });
        };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = { run: runner(null, null) };
})();
