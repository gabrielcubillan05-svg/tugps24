if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/interno-sw.js', { scope: '/interno/' }).catch(function () {});
  });
}
