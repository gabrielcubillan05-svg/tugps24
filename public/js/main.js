document.addEventListener('DOMContentLoaded', function () {

  // ---------- Theme toggle ----------
  try {
    const root = document.documentElement;
    const themeToggle = document.getElementById('themeToggle');
    const savedTheme = localStorage.getItem('tugps24-theme');
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    if (savedTheme) { root.setAttribute('data-theme', savedTheme); }
    else if (prefersLight) { root.setAttribute('data-theme', 'light'); }
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        root.setAttribute('data-theme', next);
        localStorage.setItem('tugps24-theme', next);
      });
    }
  } catch (e) { console.error('theme toggle error', e); }

  // ---------- Contador de visitas (footer) ----------
  try {
    const visitCounter = document.getElementById('visitCounter');
    if (visitCounter) {
      fetch('/api/visits').then((res) => res.json()).then((data) => {
        if (data && typeof data.count === 'number') {
          visitCounter.textContent = '· ' + data.count.toLocaleString('es-CO') + ' visitas';
        }
      }).catch(() => {});
    }
  } catch (e) { console.error('contador visitas error', e); }

  // ---------- Consola del hero: actividades en vivo, con hora real ----------
  try {
    const consoleLog = document.getElementById('consoleLog');
    if (consoleLog) {
      const ACTIVITIES = [
        'Bloqueo remoto de motor activado — orden confirmada',
        'Apagado remoto ejecutado — vehículo inmovilizado',
        'Llamada de monitoreo realizada — cliente contactado',
        'Encendido programado activado — horario configurado',
        'Alarma de salida de geocerca — verificando con el cliente',
        'Cerco geográfico verificado — sin novedad',
        'Reporte de recorrido generado — enviado al cliente',
        'Recuperación coordinada con autoridades — en curso',
        'Exceso de velocidad detectado — alerta enviada',
        'Apagado programado ejecutado — motor en reposo',
      ];

      function fmtTime(d) {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
      }

      function pickActivity(excludeText) {
        let text = excludeText;
        while (text === excludeText) {
          text = ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)];
        }
        return text;
      }

      let entries = [
        { date: new Date(Date.now() - 14000), text: ACTIVITIES[0] },
        { date: new Date(Date.now() - 151000), text: pickActivity(ACTIVITIES[0]) },
        { date: new Date(Date.now() - 399000), text: 'Recuperación coordinada con autoridades — en curso' },
      ];

      function render() {
        consoleLog.innerHTML = entries.map((e) =>
          `<li><time>${fmtTime(e.date)}</time><span class="ok">${e.text}</span></li>`
        ).join('');
      }
      render();

      setInterval(() => {
        const text = pickActivity(entries[0].text);
        entries.unshift({ date: new Date(), text });
        entries = entries.slice(0, 3);
        render();
      }, 6000);
    }
  } catch (e) { console.error('consola hero error', e); }

  // ---------- Formulario de contacto -> envía por WhatsApp con los datos precargados ----------
  try {
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
      contactForm.addEventListener('submit', function (e) {
        e.preventDefault();

        const website = document.getElementById('website');
        if (website && website.value.trim()) {
          return; // campo trampa lleno -> es un bot, no hacemos nada
        }

        const nombre = document.getElementById('nombre').value.trim();
        const ciudad = document.getElementById('ciudad').value;
        const telefono = document.getElementById('telefono').value.trim();

        if (!nombre || !telefono) {
          alert('Por favor completa tu nombre y número de WhatsApp.');
          return;
        }

        const mensaje =
          'Hola, quiero cotizar la instalación de un GPS.\n' +
          'Nombre: ' + nombre + '\n' +
          'Sucursal más cercana: ' + ciudad + '\n' +
          'Mi WhatsApp: ' + telefono;

        const url = 'https://wa.me/573116105725?text=' + encodeURIComponent(mensaje);
        window.open(url, '_blank', 'noopener');

        const btn = contactForm.querySelector('button[type="submit"]');
        if (btn) {
          const original = btn.textContent;
          btn.textContent = '¡Listo! Revisa WhatsApp';
          btn.disabled = true;
          setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 4000);
        }
      });
    }
  } catch (e) { console.error('contact form error', e); }

  // ---------- Encuesta: próxima sucursal — resultados en vivo compartidos (via /api/survey propio) ----------
  try {
    const SURVEY_CITIES = [
      { key: 'Bogota', label: 'Bogotá' },
      { key: 'Cali', label: 'Cali' },
      { key: 'Cucuta', label: 'Cúcuta' },
      { key: 'Cartagena', label: 'Cartagena' },
      { key: 'Pereira', label: 'Pereira' },
      { key: 'Otra', label: 'Otra ciudad' },
    ];
    const surveyOptions = document.getElementById('surveyOptions');
    const surveyThanks = document.getElementById('surveyThanks');
    const surveyBars = document.getElementById('surveyBars');
    const surveyTotalTop = document.getElementById('surveyTotalTop');
    const votedKey = 'tugps24-voted-city';

    if (surveyOptions && surveyThanks && surveyBars && surveyTotalTop) {

      function renderResults(counts) {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        surveyTotalTop.textContent = total + (total === 1 ? ' voto' : ' votos');
        const maxCount = Math.max(1, ...Object.values(counts));
        surveyBars.innerHTML = SURVEY_CITIES.map(c => {
          const n = counts[c.key] || 0;
          const pct = total > 0 ? Math.round((n / total) * 100) : 0;
          const isWinner = n === maxCount && n > 0;
          return '<div class="result-row' + (isWinner ? ' is-winner' : '') + '">' +
            '<span class="r-label">' + c.label + '</span>' +
            '<div class="r-track"><div class="r-fill" style="width:' + pct + '%"></div></div>' +
            '<span class="r-pct">' + n + ' · ' + pct + '%</span>' +
            '</div>';
        }).join('');
      }

      async function fetchCounts() {
        try {
          const res = await fetch('/api/survey');
          const data = await res.json();
          const counts = {};
          SURVEY_CITIES.forEach(c => { counts[c.key] = Number(data[c.key]) || 0; });
          return counts;
        } catch (e) {
          const counts = {};
          SURVEY_CITIES.forEach(c => { counts[c.key] = 0; });
          return counts;
        }
      }

      async function loadResults() {
        try {
          const counts = await fetchCounts();
          renderResults(counts);
        } catch (e) {
          renderResults({});
        }
        const already = localStorage.getItem(votedKey);
        if (already) {
          surveyOptions.querySelectorAll('.survey-opt').forEach(o => {
            if (o.getAttribute('data-city') === already) o.classList.add('picked');
          });
          surveyThanks.classList.add('show');
        }
      }
      loadResults();

      surveyOptions.querySelectorAll('.survey-opt').forEach(opt => {
        opt.addEventListener('click', async () => {
          if (localStorage.getItem(votedKey)) return; // ya votó desde este navegador
          const city = opt.getAttribute('data-city');
          surveyOptions.querySelectorAll('.survey-opt').forEach(o => o.classList.remove('picked'));
          opt.classList.add('picked');
          surveyThanks.classList.add('show');
          localStorage.setItem(votedKey, city);
          try {
            const res = await fetch('/api/survey', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ city }),
            });
            const data = await res.json();
            const counts = {};
            SURVEY_CITIES.forEach(c => { counts[c.key] = Number(data[c.key]) || 0; });
            renderResults(counts);
          } catch (e) { /* si falla la red, el voto local ya quedó marcado */ }
        });
      });
    }
  } catch (e) { console.error('encuesta error', e); }

  // ---------- Carrusel de fotos por sucursal ----------
  try {
    document.querySelectorAll('.branch-photo-carousel').forEach((carousel) => {
      const imgs = carousel.querySelectorAll('.branch-photo');
      const dots = carousel.querySelectorAll('.carousel-dots span');
      let index = 0;

      function show(next) {
        imgs[index].classList.remove('active');
        dots[index] && dots[index].classList.remove('active');
        index = (next + imgs.length) % imgs.length;
        imgs[index].classList.add('active');
        dots[index] && dots[index].classList.add('active');
      }

      const prevBtn = carousel.querySelector('.carousel-arrow.prev');
      const nextBtn = carousel.querySelector('.carousel-arrow.next');
      if (prevBtn) prevBtn.addEventListener('click', () => show(index - 1));
      if (nextBtn) nextBtn.addEventListener('click', () => show(index + 1));
      dots.forEach((dot, i) => dot.addEventListener('click', () => show(i)));
    });
  } catch (e) { console.error('carrusel sucursales error', e); }

  // ---------- Galerías con scroll horizontal (recuperaciones, central de monitoreo) ----------
  try {
    document.querySelectorAll('.recovery-gallery').forEach((gallery) => {
      const track = gallery.querySelector('.recovery-track');
      if (!track) return;
      const page = () => track.clientWidth * 0.92;
      const prevBtn = gallery.querySelector('.recovery-arrow.prev');
      const nextBtn = gallery.querySelector('.recovery-arrow.next');
      if (prevBtn) prevBtn.addEventListener('click', () => track.scrollBy({ left: -page(), behavior: 'smooth' }));
      if (nextBtn) nextBtn.addEventListener('click', () => track.scrollBy({ left: page(), behavior: 'smooth' }));
    });
  } catch (e) { console.error('galería carrusel error', e); }

  // ---------- Lightbox: ampliar fotos y reproducir videos en grande ----------
  try {
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightboxImg');
    const lightboxVideo = document.getElementById('lightboxVideo');
    const lightboxClose = document.getElementById('lightboxClose');

    function closeLightbox() {
      lightbox.classList.remove('open');
      lightboxVideo.pause();
      lightboxVideo.removeAttribute('src');
      lightboxVideo.load();
      lightboxVideo.style.display = 'none';
      lightboxImg.style.display = 'none';
    }

    function openLightboxImage(src, alt) {
      lightboxImg.src = src;
      lightboxImg.alt = alt || '';
      lightboxImg.style.display = 'block';
      lightboxVideo.style.display = 'none';
      lightbox.classList.add('open');
    }

    function openLightboxVideo(src) {
      lightboxVideo.src = src;
      lightboxVideo.style.display = 'block';
      lightboxImg.style.display = 'none';
      lightbox.classList.add('open');
      lightboxVideo.play().catch(() => {});
    }

    document.querySelectorAll('img.recovery-card, .central-media-grid > img').forEach((img) => {
      img.addEventListener('click', () => openLightboxImage(img.getAttribute('src'), img.getAttribute('alt')));
    });

    document.querySelectorAll('.video-card').forEach((card) => {
      card.addEventListener('click', () => openLightboxVideo(card.getAttribute('data-video-src')));
    });

    lightboxClose.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
  } catch (e) { console.error('lightbox error', e); }

  // ---------- Scroll reveal ----------
  try {
    const revealEls = document.querySelectorAll('.reveal');
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: .15 });
    revealEls.forEach(el => io.observe(el));
  } catch (e) { console.error('reveal error', e); }

  // ---------- Animated count-up for stats ----------
  try {
    function animateCount(el) {
      const target = parseInt(el.getAttribute('data-count'), 10);
      const duration = 1400;
      const start = performance.now();
      function step(now) {
        const p = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(eased * target).toLocaleString('es-CO');
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }
    const countEls = document.querySelectorAll('[data-count]');
    const countIO = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { animateCount(e.target); countIO.unobserve(e.target); }
      });
    }, { threshold: .4 });
    countEls.forEach(el => countIO.observe(el));
  } catch (e) { console.error('count-up error', e); }

});
