(function () {
  var root = document.documentElement;
  var saved = localStorage.getItem('tugps24-theme');
  var prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  if (saved) root.setAttribute('data-theme', saved);
  else if (prefersLight) root.setAttribute('data-theme', 'light');

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      localStorage.setItem('tugps24-theme', next);
    });
  });
})();
