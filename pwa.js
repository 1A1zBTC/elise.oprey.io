/* PWA glue: register the service worker, and on the launcher offer an
   "Install" button when the browser says the app is installable. */
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* ignore */ });
    });
  }

  // Only the launcher (root page) shows the install button.
  var path = location.pathname;
  var onLauncher = path === '/' || path === '/index.html';
  if (!onLauncher) return;

  var deferred = null;
  function makeBtn() {
    var b = document.createElement('button');
    b.id = 'pwa-install';
    b.textContent = '📲 Install app';
    b.style.cssText = 'position:fixed;z-index:9999;left:50%;bottom:18px;transform:translateX(-50%);' +
      'font-family:Nunito,system-ui,sans-serif;font-weight:800;font-size:0.95rem;color:#fff;' +
      'background:#e94560;border:none;border-radius:14px;padding:12px 20px;cursor:pointer;' +
      'box-shadow:0 6px 0 #b22a44,0 10px 24px rgba(0,0,0,0.4);';
    b.addEventListener('click', function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () { deferred = null; b.remove(); });
    });
    return b;
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    if (!document.getElementById('pwa-install')) document.body.appendChild(makeBtn());
  });
  window.addEventListener('appinstalled', function () {
    var b = document.getElementById('pwa-install'); if (b) b.remove();
  });
})();
