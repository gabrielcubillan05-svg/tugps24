import {
  THREE, GLTFLoader, DRACOLoader, TilesRenderer, GoogleCloudAuthPlugin, GLTFExtensionsPlugin, ReorientationPlugin, TileCompressionPlugin,
} from '/vendor/three-tiles/three-tiles.js';
import { createModelKit } from '/js/demo-3d-models.js';
import { sunPosition, phaseFor, describeWeather, fetchWeather, RainLayer } from '/js/demo-3d-env.js';

const maplibregl = window.maplibregl;
maplibregl.setWorkerUrl('/vendor/maplibre-gl-4.7.1/maplibre-gl-csp-worker.js');

// ───────────────────────── geografía ─────────────────────────
// Cada ciudad trae sus lugares, la geocerca de la casa, los CAI de la demo y la ruta de cada
// vehículo. Se elige con ?ciudad=medellin; sin parámetro queda Riohacha.
const CITIES = {
  riohacha: {
    name: 'Riohacha', lat: 11.5385, lng: -72.9135, elev: 5,
    // Centro, aeropuerto y Viva Wajiira son coordenadas publicadas; el resto sale de la cuadrícula
    // de calles (paralelas al mar) y carreras. Las rutas se ajustan a las vías reales con OSRM.
    places: {
      casa: { ll: [-72.9128, 11.5398], name: 'la casa' },
      padilla: { ll: [-72.9069, 11.5444], name: 'el Parque Almirante Padilla' },
      muelle: { ll: [-72.9052, 11.5457], name: 'el Muelle Turístico' },
      calle15: { ll: [-72.9044, 11.5362], name: 'la Calle 15 con Carrera 5' },
      terminal: { ll: [-72.9122, 11.5352], name: 'la Terminal de Transportes' },
      viva: { ll: [-72.9209, 11.5362], name: 'el C.C. Viva Wajiira' },
      hospital: { ll: [-72.9174, 11.5381], name: 'el Hospital Nuestra Señora de los Remedios' },
      aeropuerto: { ll: [-72.9258, 11.5264], name: 'el Aeropuerto Almirante Padilla' },
      sur: { ll: [-72.9109, 11.5266], name: 'el sur de la ciudad' },
    },
    fence: [
      [-72.915, 11.5382], [-72.911, 11.538], [-72.9102, 11.54], [-72.9112, 11.5416],
      [-72.914, 11.5418], [-72.9154, 11.5401], [-72.915, 11.5382],
    ],
    cai: [
      { ll: [-72.9085, 11.5432], name: 'CAI Centro · demo' },
      { ll: [-72.919, 11.535], name: 'CAI Viva · demo' },
      { ll: [-72.914, 11.533], name: 'CAI Terminal · demo' },
    ],
    routes: {
      main: ['casa', 'padilla', 'muelle', 'calle15', 'terminal', 'viva', 'aeropuerto', 'hospital', 'casa'],
      moto: ['padilla', 'terminal', 'sur', 'hospital', 'padilla'],
      truck: ['aeropuerto', 'viva', 'terminal', 'calle15', 'viva', 'aeropuerto'],
      van: ['sur', 'hospital', 'padilla', 'muelle', 'terminal', 'sur'],
    },
  },
  medellin: {
    name: 'Medellín', lat: 6.2245, lng: -75.5745, elev: 1500,
    // Lleras, Botero, estadio, Olaya Herrera, Santafé, El Tesoro, Pueblito Paisa y Explora son
    // coordenadas publicadas; Alpujarra, Unicentro, EAFIT y el Parque de El Poblado son aproximadas.
    places: {
      casa: { ll: [-75.5677, 6.2097], name: 'la casa, junto al Parque Lleras' },
      poblado: { ll: [-75.571, 6.21], name: 'el Parque de El Poblado' },
      santafe: { ll: [-75.5792, 6.1969], name: 'el C.C. Santafé' },
      tesoro: { ll: [-75.5593, 6.1975], name: 'El Tesoro Parque Comercial' },
      eafit: { ll: [-75.5784, 6.2001], name: 'la Universidad EAFIT' },
      olaya: { ll: [-75.5903, 6.2197], name: 'el Aeropuerto Olaya Herrera' },
      pueblito: { ll: [-75.5803, 6.2362], name: 'el Pueblito Paisa' },
      unicentro: { ll: [-75.5876, 6.241], name: 'Unicentro Medellín' },
      estadio: { ll: [-75.5902, 6.2568], name: 'el Estadio Atanasio Girardot' },
      alpujarra: { ll: [-75.5755, 6.2445], name: 'La Alpujarra' },
      botero: { ll: [-75.5683, 6.2519], name: 'la Plaza Botero' },
      explora: { ll: [-75.5658, 6.2698], name: 'el Parque Explora' },
    },
    fence: [
      [-75.5702, 6.2078], [-75.5655, 6.2075], [-75.5648, 6.2098], [-75.5658, 6.2118],
      [-75.5692, 6.2121], [-75.5706, 6.21], [-75.5702, 6.2078],
    ],
    cai: [
      { ll: [-75.5668, 6.2085], name: 'CAI Lleras · demo' },
      { ll: [-75.5695, 6.2505], name: 'CAI Botero · demo' },
      { ll: [-75.588, 6.2545], name: 'CAI Estadio · demo' },
    ],
    routes: {
      main: ['casa', 'poblado', 'santafe', 'olaya', 'pueblito', 'unicentro', 'estadio', 'alpujarra', 'poblado', 'casa'],
      moto: ['botero', 'alpujarra', 'explora', 'botero'],
      truck: ['olaya', 'santafe', 'tesoro', 'poblado', 'olaya'],
      van: ['estadio', 'unicentro', 'pueblito', 'alpujarra', 'estadio'],
    },
  },
};
const CITY_KEY = (() => {
  const q = (new URLSearchParams(location.search).get('ciudad') || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return CITIES[q] ? q : 'riohacha';
})();
const CITY = CITIES[CITY_KEY];
const ORIGIN = { lng: CITY.lng, lat: CITY.lat };
const RAD = Math.PI / 180;
const M_PER_DEG = 111319.49;
const MX = M_PER_DEG * Math.cos(ORIGIN.lat * RAD);
const MY = M_PER_DEG;
const toXY = ([lng, lat]) => [(lng - ORIGIN.lng) * MX, (lat - ORIGIN.lat) * MY];
const toLL = ([x, y]) => [ORIGIN.lng + x / MX, ORIGIN.lat + y / MY];

const PLACES = CITY.places;
const PLACE_LIST = Object.values(PLACES).map((p) => ({ ...p, xy: toXY(p.ll) }));
const FENCE = { name: 'Zona segura · Casa', ring: CITY.fence };
// Puntos de policía ficticios, solo para la simulación de robo.
const CAI = CITY.cai;

const FLEET = [
  { id: 'main', role: 'Mi carro', name: 'Mazda 2 Sedán', short: 'Mazda 2', plate: 'ABC-123', kind: 'sedan', slug: 'mazda2-sedan', length: 4.34, icon: '🚗', color: 0x8e0f1c, cruise: 48, start: 0 },
  { id: 'moto', role: 'Mensajería', name: 'Bajaj Boxer CT100', short: 'moto de mensajería', plate: 'XYZ-45A', kind: 'moto', slug: 'bajaj-boxer', length: 1.95, icon: '🏍️', color: 0xb91c1c, cruise: 42, start: 0.35 },
  { id: 'truck', role: 'Reparto', name: 'Chevrolet NHR', short: 'camión de reparto', plate: 'TRK-908', kind: 'truck', slug: 'chevrolet-nhr', length: 5.6, icon: '🚚', color: 0xf3f4f6, cruise: 36, start: 0.2 },
  { id: 'van', role: 'Ruta escolar', name: 'Toyota Hiace', short: 'van escolar', plate: 'VAN-321', kind: 'van', slug: 'toyota-hiace', length: 5.38, icon: '🚐', color: 0xf2b705, cruise: 38, start: 0.6 },
].map((d) => ({ ...d, city: CITY.name, stops: CITY.routes[d.id] }));

// ───────────────────────── rutas ─────────────────────────
function densify(lls, step = 25) {
  const out = [];
  for (let i = 0; i < lls.length - 1; i++) {
    const [a, b] = [toXY(lls[i]), toXY(lls[i + 1])];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) out.push(toLL([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]));
  }
  out.push(lls[lls.length - 1]);
  return out;
}

// La geometría se pide al router público de OSRM para que el carro vaya por calles reales;
// si no responde, la ruta en línea recta deja la demo funcionando igual.
async function fetchRoute(lls) {
  const key = 'demo3d-route:' + lls.map((p) => p.join(',')).join(';');
  try {
    const cached = localStorage.getItem(key);
    if (cached) return JSON.parse(cached);
  } catch {}
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const coords = lls.map((p) => p.join(',')).join(';');
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`, { signal: ctrl.signal });
    const data = await res.json();
    const line = data?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(line) || line.length < 2) throw new Error('sin ruta');
    try { localStorage.setItem(key, JSON.stringify(line)); } catch {}
    return line;
  } catch {
    return densify(lls);
  } finally {
    clearTimeout(timer);
  }
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function buildRoute(lls, seed) {
  const pts = [];
  for (const ll of lls) {
    const p = toXY(ll);
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.5) pts.push(p);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const len = cum[cum.length - 1];
  const rnd = seeded(seed);
  const stops = [];
  for (let d = 350 + rnd() * 400; d < len - 100; d += 480 + rnd() * 700) stops.push({ d, dur: 5 + rnd() * 10 });
  return { pts, cum, len, stops };
}

function posAt(route, d) {
  const { pts, cum, len } = route;
  d = ((d % len) + len) % len;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const t = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t];
}

function headingAt(route, d, span = 6) {
  const a = posAt(route, d - span), b = posAt(route, d + span);
  return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
}

const angDiff = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

function sampleRange(route, d0, d1, step = 12) {
  const out = [];
  for (let d = d0; d < d1; d += step) out.push(toLL(posAt(route, d)));
  out.push(toLL(posAt(route, d1)));
  return out;
}

// ───────────────────────── simulación ─────────────────────────
const KMH = 3.6;
const OVER_KMH = 60;

function newState(v, route) {
  const d = v.start * route.len;
  return {
    d, v: 0, stopTimer: 0, stopIdx: route.stops.findIndex((s) => s.d > d),
    engineCut: false, theft: false, odo: 0, fuel: 72 - v.start * 10, heading: headingAt(route, d),
  };
}

function targetSpeed(veh, route, s) {
  const ph = veh.cruise;
  const wave = 0.7 + 0.55 * (0.5 + 0.5 * Math.sin(s.d / 520 + ph)) * (0.6 + 0.4 * Math.sin(s.d / 1300 + ph * 2));
  let t = (veh.cruise * wave) / KMH;
  if (s.theft) t *= 1.45;
  const turn = Math.abs(angDiff(headingAt(route, s.d + 8), headingAt(route, s.d + 40)));
  if (turn > 40) t = Math.min(t, (s.theft ? 30 : 20) / KMH);
  if (!s.theft && s.stopIdx >= 0) {
    const ds = route.stops[s.stopIdx].d - s.d;
    if (ds >= 0) t = Math.min(t, Math.sqrt(2 * 2.4 * Math.max(0, ds - 1.5)));
  }
  return t;
}

function step(veh, route, s, dt) {
  if (s.engineCut) {
    s.v = Math.max(0, s.v - 3 * dt);
  } else if (s.stopTimer > 0) {
    s.stopTimer -= dt;
    s.v = 0;
    if (s.stopTimer <= 0) s.stopIdx = s.stopIdx + 1 < route.stops.length ? s.stopIdx + 1 : -1;
  } else {
    const t = targetSpeed(veh, route, s);
    s.v += Math.max(-3.5 * dt, Math.min(2.2 * dt, t - s.v));
    if (s.stopIdx >= 0) {
      const ds = route.stops[s.stopIdx].d - s.d;
      if (s.theft && ds < 0) s.stopIdx = s.stopIdx + 1 < route.stops.length ? s.stopIdx + 1 : -1;
      else if (!s.theft && ds < 2 && s.v < 1.2) { s.v = 0; s.stopTimer = route.stops[s.stopIdx].dur; }
    }
  }
  const dd = s.v * dt;
  s.d += dd;
  s.odo += dd;
  s.fuel = Math.max(4, s.fuel - dd * 0.00012);
  if (s.d >= route.len) {
    s.d -= route.len;
    s.stopIdx = route.stops.length ? 0 : -1;
  }
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ───────────────────────── modelos 3D ─────────────────────────
const kit = createModelKit(THREE, GLTFLoader, DRACOLoader);

function makeFx(scene) {
  const list = [];
  return {
    wave(x, z, color = 0x38e1ff) {
      const g = new THREE.Group();
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(1.2, 4, 400, 24, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      );
      beam.position.y = 200;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1, 64),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.2;
      g.add(beam, ring);
      g.position.set(x, 0, z);
      g.traverse((o) => { o.frustumCulled = false; });
      scene.add(g);
      list.push({ g, beam, ring, t: 0 });
    },
    update(dt) {
      for (let i = list.length - 1; i >= 0; i--) {
        const f = list[i];
        f.t += dt;
        const p = f.t / 2.2;
        f.beam.material.opacity = Math.max(0, 0.75 * (1 - p));
        f.beam.scale.set(1 + p * 2, 1, 1 + p * 2);
        f.ring.scale.setScalar(1 + p * 80);
        f.ring.material.opacity = Math.max(0, 0.9 * (1 - p));
        if (p >= 1) { scene.remove(f.g); list.splice(i, 1); }
      }
    },
  };
}

// ───────────────────────── mapa ─────────────────────────
const ROAD_MAJOR = ['motorway', 'trunk', 'primary', 'secondary'];
const STYLE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: { omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0a0d16' } },
    { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': '#0d1c17' } },
    { id: 'green', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood']]], paint: { 'fill-color': '#0d1a15' } },
    { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#0a1d33' } },
    { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['tertiary', 'minor', 'service']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1b2234', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, 0.6, 20, 28] } },
    { id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ROAD_MAJOR]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#283249', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 11, 1, 20, 60] } },
    { id: 'road-glow', type: 'line', source: 'omt', 'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
      paint: { 'line-color': '#ff7a1a', 'line-opacity': 0.22, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 18, 2] } },
    { id: 'buildings', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 13,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#141a29', 30, '#1c2640', 100, '#2b3d66'],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.9,
      } },
    { id: 'road-labels', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 15,
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11 },
      paint: { 'text-color': '#7d8597', 'text-halo-color': '#0a0d16', 'text-halo-width': 1.4 } },
    { id: 'place-labels', type: 'symbol', source: 'omt', 'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'quarter']]],
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-transform': 'uppercase', 'text-letter-spacing': 0.12 },
      paint: { 'text-color': '#5b6478', 'text-halo-color': '#0a0d16', 'text-halo-width': 1.4 } },
  ],
};

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE,
  center: [-73.6, 7.2],
  zoom: 5,
  pitch: 0,
  bearing: 0,
  maxPitch: 85,
  maxZoom: 22,
  antialias: true,
  preserveDrawingBuffer: true,
  attributionControl: { compact: true },
});

// ───────────────────────── interfaz ─────────────────────────
const $ = (id) => document.getElementById(id);
const fmt1 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const clockFmt = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const speedColor = (kmh, on) => (!on ? 0x6b7280 : kmh < 40 ? 0x3ddc84 : kmh <= OVER_KMH ? 0xffc23d : 0xff4545);
const speedCss = (kmh, on) => '#' + speedColor(kmh, on).toString(16).padStart(6, '0');

function toast(html, kind = '', ms = 4500) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = html;
  $('toasts').prepend(el);
  while ($('toasts').children.length > 3) $('toasts').lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 500); }, ms);
}

function nearestPlace(xy) {
  let best = PLACE_LIST[0], bd = Infinity;
  for (const p of PLACE_LIST) {
    const d = Math.hypot(p.xy[0] - xy[0], p.xy[1] - xy[1]);
    if (d < bd) { bd = d; best = p; }
  }
  return { place: best, dist: bd };
}

function nearText(xy) {
  const { place, dist } = nearestPlace(xy);
  return dist < 1200 ? `cerca de <b>${place.name}</b>` : `a ${fmt1.format(dist / 1000)} km de <b>${place.name}</b>`;
}

const app = {
  vehicles: [],
  selected: null,
  cam: 'dron',
  camBearing: 0,
  replay: null,
  simTime: 0,
  recording: null,
  env: { timeMode: 'auto', weatherMode: 'real', weather: null, sun: null, phase: 'dia', lights: 0, tint: [1, 1, 1] },
  photo: false,
  gkey: '',
};

// La clave de Google va en la variable PUBLIC_GOOGLE_MAPS_KEY de Vercel; para probar sin desplegar
// también se acepta ?gkey=... una vez y queda guardada en este navegador.
{
  const qs = new URLSearchParams(location.search);
  let key = qs.get('gkey') || document.body.dataset.gkey || '';
  try {
    if (qs.get('gkey')) localStorage.setItem('demo3d-gkey', key);
    else if (!key) key = localStorage.getItem('demo3d-gkey') || '';
  } catch {}
  app.gkey = key;
  app.photo = !!key && qs.get('foto') !== '0';
}

function setCam(mode) {
  app.cam = mode;
  document.querySelectorAll('.cams button').forEach((b) => b.classList.toggle('on', b.dataset.cam === mode));
  if (mode === 'torre') {
    const b = new maplibregl.LngLatBounds();
    for (const v of app.vehicles) b.extend(v.ll);
    const narrow = window.innerWidth < 760;
    const padding = narrow ? { top: 80, bottom: 260, left: 30, right: 80 } : { top: 120, bottom: 160, left: 300, right: 120 };
    app.flyLock = performance.now() + 1900;
    map.fitBounds(b, { padding, pitch: 55, bearing: map.getBearing(), duration: 1800, maxZoom: 15 });
  } else if (mode !== 'libre' && app.selected) {
    app.camBearing = app.selected.state.heading;
    app.flyLock = performance.now() + 1500;
    map.easeTo({ ...camFor(mode, app.selected), duration: 1500 });
  }
}

function camFor(mode, v) {
  const h = app.camBearing;
  if (mode === 'conductor') {
    // A zoom 21 la cámara queda ~47 m detrás del centro; con el centro 14 m adelante el carro
    // queda en primer plano. Con más distancia el carro termina detrás de la cámara.
    const ahead = posAt(v.route, (app.replay?.v === v ? app.replay.sample.d : v.state.d) + 14);
    return { center: toLL(ahead), zoom: 21, pitch: 80, bearing: h };
  }
  if (mode === 'replay') return { center: v.ll, zoom: 17.2, pitch: 62, bearing: h };
  return { center: v.ll, zoom: 19, pitch: 63, bearing: h };
}

function select(v) {
  app.selected = v;
  document.querySelectorAll('#fleetList button').forEach((b) => b.classList.toggle('on', b.dataset.id === v.id));
  for (const o of app.vehicles) o.hud.classList.toggle('main', o === v);
  syncActionButtons();
  if (app.cam === 'libre' || app.cam === 'torre') setCam('dron');
  else setCam(app.cam);
  narrate(true);
}

function syncActionButtons() {
  const s = app.selected.state;
  const cut = $('btnCut');
  cut.textContent = s.engineCut ? '▶ Reactivar motor' : '⏻ Apagar motor';
  cut.className = s.engineCut ? 'ok' : 'danger';
  $('btnTheft').textContent = s.theft ? '✔ Terminar simulación' : '🚨 Simular robo';
}

function hudHtml(v) {
  const s = v.state;
  const kmh = Math.round(s.v * KMH);
  const on = !(s.engineCut && s.v === 0);
  const color = speedCss(kmh, on);
  if (v !== app.selected) return `<span class="pl">${v.def.icon} ${v.def.plate}</span><span class="sp" style="color:${color}">${on ? kmh + ' km/h' : 'OFF'}</span>`;
  const status = s.theft && !s.engineCut ? '<span class="st" style="color:#ff4545">⚠ MOVIMIENTO NO AUTORIZADO</span>'
    : s.engineCut ? `<span class="st" style="color:#9ca3af">⏻ ${s.v > 0 ? 'DETENIENDO…' : 'APAGADO REMOTO'}</span>`
    : kmh > OVER_KMH ? '<span class="st" style="color:#ff4545">▲ EXCESO DE VELOCIDAD</span>'
    : s.stopTimer > 0 ? '<span class="st" style="color:#ffc23d">■ DETENIDO · MOTOR ENCENDIDO</span>'
    : '<span class="st" style="color:#3ddc84">● EN MOVIMIENTO</span>';
  const batt = on ? 13.8 + Math.sin(app.simTime * 0.7) * 0.08 : 12.5;
  return `<div class="pl">${v.def.icon} ${v.def.role} · ${v.def.plate}</div><div class="md">${v.def.name}</div>
    <div class="big" style="color:${color}">${on ? kmh : 0}<small>km/h</small></div>
    <div class="rows"><span>Encendido</span><b>${on ? 'Sí' : 'No'}</b><span>Batería</span><b>${fmt1.format(batt)} V</b>
    <span>Combustible</span><b>${Math.round(s.fuel)} %</b><span>Hoy</span><b>${fmt1.format(s.odo / 1000)} km</b>
    <span>Rumbo</span><b>${Math.round((s.heading + 360) % 360)}°</b><span>Reporte GPS</span><b>hace ${Math.floor(app.simTime % 10)} s</b></div>${status}`;
}

let lastNarr = 0;
function narrate(force = false) {
  const now = performance.now();
  if (!force && now - lastNarr < 6000) return;
  lastNarr = now;
  const v = app.selected;
  if (!v) return;
  const s = v.state;
  const kmh = Math.round(s.v * KMH);
  const near = nearText(toXY(v.ll));
  let t;
  if (app.replay) t = `Repetición del día: a las <b>${replayClock(app.replay.t)}</b> tu ${v.def.short} iba a <b>${Math.round(app.replay.sample.v * KMH)} km/h</b> ${near}.`;
  else if (s.theft && !s.engineCut) t = `🚨 Movimiento sin autorización a <b>${kmh} km/h</b> ${near}. Lo sigo en vivo y el CAI más cercano ya está marcado. Puedes <b>apagar el motor</b> desde aquí.`;
  else if (s.engineCut && s.v === 0) t = `Motor apagado a distancia. <b>${v.def.plate}</b> está inmovilizado ${near}. Para encenderlo de nuevo usa <b>Reactivar motor</b>.`;
  else if (s.engineCut) t = `Orden de apagado recibida: el vehículo baja la velocidad de forma segura (${kmh} km/h).`;
  else if (kmh > OVER_KMH) t = `Ojo: <b>${v.def.plate}</b> va a <b>${kmh} km/h</b> ${near}, por encima del límite urbano de 60.`;
  else if (s.stopTimer > 0) t = `<b>${v.def.plate}</b> está detenido ${near}, con el motor encendido. Parece un semáforo.`;
  else t = `Tu <b>${v.def.short}</b> va a <b>${kmh} km/h</b> ${near}. Hoy lleva <b>${fmt1.format(s.odo / 1000)} km</b> recorridos.`;
  $('gpsitoText').innerHTML = t;
}

// ───────────────────────── capa 3D ─────────────────────────
const three = {};
const DOWN = new THREE.Vector3(0, -1, 0);
const vehicleLayer = {
  id: 'vehicles-3d',
  type: 'custom',
  renderingMode: '3d',
  onAdd(m, gl) {
    three.camera = new THREE.Camera();
    three.scene = new THREE.Scene();
    three.ambient = new THREE.AmbientLight(0xb8c4ff, 1.1);
    three.scene.add(three.ambient);
    three.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    three.sun.position.set(60, 120, 40);
    three.scene.add(three.sun);
    three.fill = new THREE.DirectionalLight(0xff9a50, 0.6);
    three.fill.position.set(-80, 40, -60);
    three.scene.add(three.fill);
    three.root = new THREE.Group();
    three.scene.add(three.root);
    three.fx = makeFx(three.root);
    three.renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
    three.renderer.autoClear = false;
    three.lodCam = new THREE.PerspectiveCamera(36.87, 1, 1, 100000);
    three.ray = new THREE.Raycaster();
    three.ray.firstHitOnly = true;
    for (const v of app.vehicles) three.root.add(v.model.group);
    three.fence = buildFenceMesh();
    three.root.add(three.fence);
    if (app.gkey) setupTiles();
    applyEnv();
  },
  render(gl, matrix) {
    // El origen de la escena se mueve al centro de la vista en cada cuadro: con un origen fijo
    // a kilómetros, la precisión de 32 bits de la GPU corría el carro varios metros a zoom alto.
    const c = map.getCenter();
    const o = maplibregl.MercatorCoordinate.fromLngLat(c, 0);
    const sc = o.meterInMercatorCoordinateUnits();
    const origin = new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).scale(new THREE.Vector3(sc, -sc, sc)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    const [ox, oy] = toXY([c.lng, c.lat]);
    three.root.position.set(-ox, 0, oy);
    three.root.updateMatrixWorld(true);
    three.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(origin);
    if (three.tiles && app.photo) {
      syncLodCamera(c.lat);
      three.tiles.update();
      groundTick();
    }
    three.renderer.resetState();
    three.renderer.render(three.scene, three.camera);
    map.triggerRepaint();
  },
};

// ───────────────────────── ciudad fotorrealista (Google 3D Tiles) ─────────────────────────
// MapLibre sigue mandando la cámara; esta cámara paralela solo le dice a la librería de teselas
// desde dónde se mira, para que pida el nivel de detalle correcto.
function syncLodCamera(lat) {
  const tr = map.transform;
  const canvas = map.getCanvas();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const mpp = (40075016.686 * Math.cos(lat * RAD)) / tr.worldSize;
  const D = tr.cameraToCenterDistance * mpp;
  const p = map.getPitch() * RAD, b = map.getBearing() * RAD;
  const cam = three.lodCam;
  cam.position.set(-Math.sin(b) * D * Math.sin(p), D * Math.cos(p), Math.cos(b) * D * Math.sin(p));
  cam.rotation.set(-(Math.PI / 2 - p), -b, 0, 'YXZ');
  cam.fov = tr.fov;
  cam.aspect = w / h;
  cam.near = Math.max(0.5, D / 100);
  cam.far = D * 60 + 30000;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  three.tiles.setResolution(cam, w, h);
}

function setupTiles() {
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: app.gkey, autoRefreshToken: true }));
  const draco = new DRACOLoader();
  draco.setDecoderPath('/vendor/three-tiles/draco/');
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new ReorientationPlugin({ lat: ORIGIN.lat * RAD, lon: ORIGIN.lng * RAD, height: CITY.elev, recenter: true }));
  // El plugin de Google pone 20 (pensado para ver la ciudad de lejos); con la cámara a nivel de calle
  // se nota borroso, y la sesión se cobra igual sin importar cuántas teselas se pidan.
  tiles.errorTarget = 12;
  tiles.setCamera(three.lodCam);
  tiles.addEventListener('load-model', ({ scene }) => tintTiles(scene));
  tiles.addEventListener('load-error', (e) => {
    if (e.tile) return;
    toast('No se pudo cargar la ciudad fotorrealista (revisa la clave de Google y que la Map Tiles API esté activa). Sigo con el mapa normal.', 'red', 9000);
    setPhoto(false);
    three.tiles = null;
  });
  // La librería orienta la ciudad con X al oeste y Z al norte; la escena usa X al este y Z al sur.
  const holder = new THREE.Group();
  holder.rotation.y = Math.PI;
  holder.add(tiles.group);
  three.root.add(holder);
  three.tiles = tiles;
  three.tilesHolder = holder;
  setPhoto(app.photo);
}

let groundIdx = 0;
function groundAt(wx, wz) {
  three.ray.set(new THREE.Vector3(wx, 4000, wz), DOWN);
  const hit = three.ray.intersectObject(three.tiles.group, true)[0];
  return hit ? hit.point.y : null;
}

// Un rayo por cuadro, por turnos: el centro de la vista (para que el piso real quede en la altura 0
// del mapa y las líneas dibujadas coincidan) y cada vehículo (para apoyarlo sobre la calle).
function groundTick() {
  const n = app.vehicles.length + 1;
  groundIdx = (groundIdx + 1) % n;
  if (groundIdx === 0) {
    const h = groundAt(0, 0);
    if (h !== null && Math.abs(h) < 400) {
      three.tilesHolder.position.y -= h * 0.5;
      three.tilesHolder.updateMatrixWorld(true);
      // Las alturas de los vehículos se midieron con el piso anterior: se corren lo mismo.
      for (const v of app.vehicles) v.groundY -= h * 0.5;
    }
    return;
  }
  const v = app.vehicles[groundIdx - 1];
  const p = v.model.group.position;
  const h = groundAt(p.x + three.root.position.x, p.z + three.root.position.z);
  if (h === null || Math.abs(h) > 400) return;
  // Un salto de más de 6 m hacia arriba entre dos lecturas suele ser un techo o un árbol, no la
  // calle: se ignora. Las pendientes reales suben de a poco y sí pasan.
  if (!v.groundSet) { v.groundY = h; v.groundSet = true; } else if (h < v.groundY + 6) v.groundY += (h - v.groundY) * 0.5;
}

function tintTiles(obj) {
  const t = app.env.tint;
  obj.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) if (m.color) m.color.setRGB(t[0], t[1], t[2]);
  });
}

const VECTOR_LAYERS = ['park', 'green', 'water', 'road-minor', 'road-major', 'road-glow', 'buildings', 'road-labels', 'place-labels'];
const OVERLAY_LAYERS = ['fence-line', 'trail-glow', 'trail', 'future'];

function setPhoto(on) {
  app.photo = on && !!three.tiles;
  const vis = app.photo ? 'none' : 'visible';
  for (const id of [...VECTOR_LAYERS, 'fence-floor', 'fence-wall']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  // Sobre la ciudad real las líneas se dibujan encima de todo; si quedaran debajo, el piso las taparía.
  for (const id of OVERLAY_LAYERS) if (map.getLayer(id)) map.moveLayer(id, app.photo ? undefined : 'vehicles-3d');
  if (three.tiles) three.tiles.group.visible = app.photo;
  if (three.fence) three.fence.visible = app.photo;
  if (!app.photo) for (const v of app.vehicles) { v.groundY = 0; v.groundSet = false; }
  $('btnPhoto').classList.toggle('on', app.photo);
  $('btnPhoto').innerHTML = app.photo ? '🌍<span> Ciudad real</span>' : '🗺️<span> Mapa</span>';
  $('gattr').hidden = !app.photo;
  applyEnv();
}

function buildFenceMesh() {
  const pts = FENCE.ring.map(toXY);
  const pos = [];
  // Más bajo y tenue que el del mapa normal: sobre la ciudad real, con el carro saliendo de casa,
  // un muro alto lo tapaba en la vista de dron.
  const H = 22;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    pos.push(ax, 0, -ay, bx, 0, -by, bx, H, -by, ax, 0, -ay, bx, H, -by, ax, H, -ay);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mat = new THREE.MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

function updateModel(v, k, t) {
  const s = v.state, m = v.model;
  const [x, y] = toXY(v.ll);
  m.group.position.set(x, app.photo ? v.groundY : 0, -y);
  m.group.rotation.y = (-s.heading * Math.PI) / 180;
  m.group.scale.setScalar(k);
  const kmh = s.v * KMH;
  const on = !(s.engineCut && s.v === 0);
  const c = speedColor(kmh, on);
  m.ringMat.color.setHex(s.theft && !s.engineCut ? (Math.sin(t * 12) > 0 ? 0xff2020 : 0x2060ff) : c);
  m.discMat.color.setHex(c);
  const pulse = kmh > OVER_KMH && on ? 0.5 + 0.5 * Math.sin(t * 9) : 1;
  m.ringMat.opacity = 0.35 + 0.55 * pulse;
  m.beamMat.color.setHex(c);
  m.beamMat.opacity = Math.min(0.5, Math.max(0, (k - 4) / 20));
  const night = app.env.lights;
  m.head.emissiveIntensity = on ? 1.2 + night * 2.5 : 0;
  m.tail.emissiveIntensity = on ? (s.v < 2 ? 3 : 1.2 + night) : 0;
  m.coneMat.opacity = on ? night * 0.85 : 0;
  m.bar.visible = s.theft;
  if (s.theft) {
    const f = Math.sin(t * 14) > 0;
    m.red.material.emissiveIntensity = f ? 4 : 0.2;
    m.blue.material.emissiveIntensity = f ? 0.2 : 4;
  }
}

// ───────────────────────── capas de mapa propias ─────────────────────────
function insetRing(ring, meters) {
  const xy = ring.map(toXY);
  const n = xy.length - 1;
  const cx = xy.slice(0, n).reduce((a, p) => a + p[0], 0) / n;
  const cy = xy.slice(0, n).reduce((a, p) => a + p[1], 0) / n;
  return xy.map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy);
    const f = (d - meters) / d;
    return toLL([cx + (x - cx) * f, cy + (y - cy) * f]);
  });
}

function addOverlays() {
  const inner = insetRing(FENCE.ring, 7).reverse();
  map.addSource('fence', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [FENCE.ring] } } });
  map.addSource('fence-wall', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [FENCE.ring, inner] } } });
  map.addLayer({ id: 'fence-floor', type: 'fill', source: 'fence', paint: { 'fill-color': '#38e1ff', 'fill-opacity': 0.06 } }, 'buildings');
  map.addLayer({ id: 'fence-line', type: 'line', source: 'fence', paint: { 'line-color': '#38e1ff', 'line-width': 2, 'line-blur': 1 } }, 'buildings');
  map.addLayer({ id: 'fence-wall', type: 'fill-extrusion', source: 'fence-wall',
    paint: { 'fill-extrusion-color': '#38e1ff', 'fill-extrusion-height': 55, 'fill-extrusion-opacity': 0.32 } });

  map.addSource('trail', { type: 'geojson', lineMetrics: true, data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'trail-glow', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ff7a1a', 'line-width': 14, 'line-blur': 10, 'line-opacity': 0.45 } });
  map.addLayer({ id: 'trail', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': 4, 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, 'rgba(255,122,26,0)', 0.6, 'rgba(255,122,26,0.7)', 1, '#ffd29e'] } });

  map.addSource('future', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'future', type: 'line', source: 'future', layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#38e1ff', 'line-width': 3, 'line-dasharray': [1.2, 1.6], 'line-opacity': 0.9 } });
  const gl = document.createElement('div');
  gl.className = 'ghost-label';
  gl.hidden = true;
  app.ghostLabel = gl;
  app.ghostMarker = new maplibregl.Marker({ element: gl, anchor: 'bottom', offset: [0, -30] }).setLngLat(PLACES.casa.ll).addTo(map);

  const el = document.createElement('div');
  el.className = 'fence-label';
  el.textContent = FENCE.name;
  const top = FENCE.ring.reduce((a, p) => (p[1] > a[1] ? p : a));
  new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(top).addTo(map);
}

let fenceFlashUntil = 0;
function flashFence(color) {
  fenceFlashUntil = performance.now() + 1800;
  app.fenceFlashColor = color;
}

function updateFenceFlash(now) {
  if (!map.getLayer('fence-wall')) return;
  if (now < fenceFlashUntil) {
    const on = Math.floor((fenceFlashUntil - now) / 200) % 2 === 0;
    map.setPaintProperty('fence-wall', 'fill-extrusion-color', on ? app.fenceFlashColor : '#ffffff');
    map.setPaintProperty('fence-wall', 'fill-extrusion-opacity', 0.6);
    three.fence?.material.color.set(on ? app.fenceFlashColor : '#ffffff');
    if (three.fence) three.fence.material.opacity = 0.45;
    app.fenceFlashing = true;
  } else if (app.fenceFlashing) {
    app.fenceFlashing = false;
    map.setPaintProperty('fence-wall', 'fill-extrusion-color', '#38e1ff');
    map.setPaintProperty('fence-wall', 'fill-extrusion-opacity', 0.32);
    three.fence?.material.color.set('#38e1ff');
    if (three.fence) three.fence.material.opacity = 0.16;
  }
}

let caiMarkers = [];
function showCai(on) {
  for (const m of caiMarkers) m.remove();
  caiMarkers = [];
  if (!on) return;
  for (const c of CAI) {
    const el = document.createElement('div');
    el.className = 'poi';
    el.textContent = '🚓 ' + c.name;
    caiMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(c.ll).addTo(map));
  }
}

// ───────────────────────── repetición del día ─────────────────────────
const START_MIN = 7 * 60 + 30;
function replayClock(t) {
  const m = START_MIN + Math.floor(t / 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function buildDay(v) {
  const s = newState({ ...v.def, start: 0 }, v.route);
  const samples = [];
  const events = [];
  let t = 0, stoppedFor = 0, wasOver = false, wasIn = pointInRing(toLL(posAt(v.route, 0)), FENCE.ring);
  while (s.odo < v.route.len - 2 && t < 4 * 3600) {
    step(v.def, v.route, s, 0.5);
    t += 0.5;
    if (t % 2 === 0) samples.push({ t, d: s.odo, v: s.v });
    stoppedFor = s.v === 0 ? stoppedFor + 0.5 : 0;
    if (stoppedFor === 4) events.push({ t, type: 'stop' });
    const over = s.v * KMH > OVER_KMH;
    if (over && !wasOver) events.push({ t, type: 'speed' });
    wasOver = over;
    if (v.def.id === 'main') {
      const isIn = pointInRing(toLL(posAt(v.route, s.odo)), FENCE.ring);
      if (isIn !== wasIn) events.push({ t, type: 'fence' });
      wasIn = isIn;
    }
  }
  return { samples, events, dur: t };
}

function openReplay() {
  const v = app.selected;
  v.day ||= buildDay(v);
  app.replay = { v, t: 0, playing: true, sample: v.day.samples[0] };
  document.body.classList.add('replaying');
  $('replay').hidden = false;
  $('livePill').className = 'live-pill replay';
  $('liveText').textContent = 'REPETICIÓN';
  const ev = $('replayEvents');
  ev.innerHTML = '';
  for (const e of v.day.events) {
    const i = document.createElement('i');
    i.className = e.type;
    i.style.left = (e.t / v.day.dur) * 100 + '%';
    i.title = { stop: 'Parada', speed: 'Exceso de velocidad', fence: 'Cruce de geocerca' }[e.type] + ' · ' + replayClock(e.t);
    ev.append(i);
  }
  const counts = v.day.events.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
  toast(`🎬 Recorrido de hoy de <b>${v.def.plate}</b>: ${fmt1.format(v.route.len / 1000)} km, ${counts.stop || 0} paradas, ${counts.speed || 0} excesos de velocidad.`, 'cyan', 6000);
  app.prevCam = app.cam;
  app.camBearing = headingAt(v.route, 0);
  setCamButtons(null);
  map.easeTo({ ...camFor('replay', v), duration: 1200 });
  app.flyLock = performance.now() + 1200;
  $('replayPlay').textContent = '❚❚';
}

function closeReplay() {
  app.replay = null;
  document.body.classList.remove('replaying');
  $('replay').hidden = true;
  setLivePill();
  setCam(app.prevCam === 'libre' ? 'dron' : app.prevCam || 'dron');
}

function setCamButtons(mode) {
  document.querySelectorAll('.cams button').forEach((b) => b.classList.toggle('on', b.dataset.cam === mode));
}

function setLivePill() {
  const alarm = app.vehicles.some((v) => v.state.theft);
  $('livePill').className = 'live-pill' + (alarm ? ' alarm' : '');
  $('liveText').textContent = alarm ? 'ALERTA DE ROBO' : 'EN VIVO';
  $('vignette').classList.toggle('on', alarm);
}

function sampleAt(day, t) {
  const i = Math.min(day.samples.length - 1, Math.max(0, Math.floor(t / 2) - 1));
  return day.samples[i];
}

// ───────────────────────── grabación de clips ─────────────────────────
function pickMime() {
  for (const m of ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm']) if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  return '';
}

async function onRecord() {
  const btn = $('btnRecord');
  if (app.clip) {
    const file = app.clip;
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Mi vehículo en TuGPS24 3D' }); return; } catch {}
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return;
  }
  if (app.recording) return;
  const mime = pickMime();
  if (!mime || !map.getCanvas().captureStream) { toast('Este navegador no permite grabar el mapa.', 'red'); return; }
  const rec = new MediaRecorder(map.getCanvas().captureStream(30), { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    app.clip = new File(chunks, `tugps24-3d-${app.selected.def.plate}.${ext}`, { type: mime.split(';')[0] });
    app.recording = null;
    btn.className = 'ok';
    btn.textContent = '📤 Compartir clip';
    toast('Clip listo: compártelo por WhatsApp o descárgalo.', 'green');
    setTimeout(() => { app.clip = null; btn.className = ''; btn.textContent = '⏺ Grabar clip'; }, 60000);
  };
  app.recording = rec;
  rec.start();
  btn.className = 'rec';
  let left = 12;
  btn.textContent = `● Grabando ${left}s`;
  const iv = setInterval(() => {
    left--;
    btn.textContent = `● Grabando ${left}s`;
    if (left <= 0) { clearInterval(iv); rec.stop(); }
  }, 1000);
}

// ───────────────────────── arranque ─────────────────────────
async function init() {
  $('gpsitoText').textContent = `Calculando rutas por las calles de ${CITY.name}…`;
  $('introCity').textContent = CITY.name;
  document.title = `TuGPS24 3D · ${CITY.name}`;
  const routes = await Promise.all(FLEET.map((f) => fetchRoute(f.stops.map((k) => PLACES[k].ll))));
  app.vehicles = FLEET.map((def, i) => {
    const route = buildRoute(routes[i], 1000 + i * 77);
    const state = newState(def, route);
    const ll = toLL(posAt(route, state.d));
    const hud = document.createElement('div');
    hud.className = 'hud';
    const v = { def, id: def.id, route, state, ll, model: kit.buildVehicle(def), hud, groundY: 0 };
    v.marker = new maplibregl.Marker({ element: hud, anchor: 'bottom', offset: [0, -34] }).setLngLat(ll).addTo(map);
    hud.addEventListener('click', () => select(v));
    v.inFence = def.id === 'main' ? pointInRing(ll, FENCE.ring) : null;
    return v;
  });

  const list = $('fleetList');
  for (const v of app.vehicles) {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" data-id="${v.id}"><span class="ico">${v.def.icon}</span><span class="name">${v.def.role}<span class="plate">${v.def.plate} · ${v.def.name}</span></span><span class="spd">0</span></button>`;
    li.querySelector('button').addEventListener('click', () => select(v));
    v.listSpeed = li.querySelector('.spd');
    list.append(li);
  }

  app.rain = new RainLayer($('rain'), lightning);
  updateSun();
  refreshWeather();
  setInterval(refreshWeather, 10 * 60 * 1000);
  setInterval(updateSun, 60 * 1000);
  kit.loadManifest().then((models) => {
    for (const v of app.vehicles) {
      const entry = models[v.def.slug];
      if (entry?.archivo) kit.applyGlb(v.model, v.def, entry).catch(() => {});
    }
  });

  let started = false;
  const ready = () => {
    if (started) return;
    started = true;
    addOverlays();
    map.addLayer(vehicleLayer);
    select(app.vehicles[0]);
    requestAnimationFrame(loop);
    if (new URLSearchParams(location.search).has('presentacion')) runShow();
    else intro();
  };
  // Se espera solo al estilo y no a las teselas: si el servidor de mapas falla, la flota sigue visible.
  if (map.style?._loaded) ready();
  else map.once('style.load', ready);
}

let last = performance.now(), trailAt = 0, listAt = 0, simSpeed = 1;
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  app.simTime += dt * simSpeed;

  for (const v of app.vehicles) {
    if (app.replay?.v === v) continue;
    const wasMoving = v.state.v > 0;
    step(v.def, v.route, v.state, dt * simSpeed);
    const target = headingAt(v.route, v.state.d);
    if (v.state.v > 0.3) v.state.heading += angDiff(v.state.heading, target) * Math.min(1, dt * 6);
    v.ll = toLL(posAt(v.route, v.state.d));
    if (wasMoving && v.state.v === 0 && v.state.engineCut) {
      toast(`⏻ <b>${v.def.plate}</b> inmovilizado. ${v.state.theft ? 'Se avisó a la central y al CAI más cercano.' : 'Motor apagado.'}`, 'green', 6000);
      narrate(true);
    }
    checkEvents(v, now);
  }

  if (app.replay) {
    const r = app.replay;
    if (r.playing) r.t = Math.min(r.v.day.dur, r.t + dt * Number($('replaySpeed').value));
    if (r.t >= r.v.day.dur) { r.playing = false; $('replayPlay').textContent = '▶'; }
    r.sample = sampleAt(r.v.day, r.t);
    const v = r.v;
    v.ll = toLL(posAt(v.route, r.sample.d));
    const target = headingAt(v.route, r.sample.d);
    v.state.heading += angDiff(v.state.heading, target) * Math.min(1, dt * 4);
    $('replaySlider').value = Math.round((r.t / v.day.dur) * 1000);
    $('replayTime').textContent = replayClock(r.t);
    v.replayV = r.sample.v;
  }

  const sel = app.selected;
  const mode = app.replay ? 'replay' : app.cam;
  const zoom = map.getZoom();
  const k = Math.max(1, Math.min(60, 2 ** (20.3 - zoom)));
  for (const v of app.vehicles) {
    const shownV = app.replay?.v === v ? v.replayV : v.state.v;
    const real = v.state.v;
    v.state.v = shownV;
    updateModel(v, k, t);
    v.marker.setLngLat(v.ll);
    const off = v === sel && mode === 'conductor' ? -150 : -34;
    if (v.markerOff !== off) { v.markerOff = off; v.marker.setOffset([0, off]); }
    if (now - listAt > 250) {
      v.hud.innerHTML = hudHtml(v);
      const kmh = Math.round(shownV * KMH);
      const on = !(v.state.engineCut && shownV === 0);
      v.hud.classList.toggle('over', on && kmh > OVER_KMH && !v.state.theft);
      v.hud.classList.toggle('off', !on);
      v.hud.classList.toggle('theft', v.state.theft && !v.state.engineCut);
      v.listSpeed.textContent = on ? kmh : 'OFF';
      v.listSpeed.style.color = speedCss(kmh, on);
    }
    v.state.v = real;
  }
  if (now - listAt > 250) {
    listAt = now;
    $('clock').textContent = clockFmt.format(new Date());
    if (app.photo && three.tiles && now - (app.attrAt || 0) > 2000) {
      app.attrAt = now;
      const txt = three.tiles.getAttributions().filter((a) => a.type === 'string').map((a) => a.value).join(' ');
      $('gattrText').textContent = txt;
    }
  }
  three.fx?.update(dt);
  app.rain?.draw(dt, now);
  updateFenceFlash(now);
  updateFuture(sel, k, now);

  if (now - trailAt > 180 && map.getSource('trail')) {
    trailAt = now;
    const d = app.replay ? app.replay.sample.d : sel.state.d;
    const coords = app.replay ? sampleRange(sel.route, 0, Math.max(1, d), 15) : sampleRange(sel.route, d - 1400, d, 12);
    map.getSource('trail').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
  }

  if (sel && mode !== 'libre' && now > (app.flyLock || 0)) {
    if (mode === 'torre') {
      map.setBearing(map.getBearing() + dt * 3);
    } else {
      const lag = mode === 'conductor' ? 5 : mode === 'replay' ? 1.2 : 2;
      const offset = mode === 'replay' ? Math.sin(t * 0.15) * 25 : 0;
      app.camBearing += angDiff(app.camBearing, sel.state.heading + offset) * Math.min(1, dt * lag);
      map.jumpTo(camFor(mode, sel));
    }
  }
  narrate();
  requestAnimationFrame(loop);
}

function checkEvents(v, now) {
  const s = v.state;
  const kmh = s.v * KMH;
  if (kmh > OVER_KMH && !s.theft && !v.over && now - (v.overAt || 0) > 30000) {
    v.over = true;
    v.overAt = now;
    toast(`▲ <b>${v.def.plate}</b> superó los 60 km/h (${Math.round(kmh)} km/h) ${nearText(toXY(v.ll))}.`, 'red');
  } else if (kmh < OVER_KMH - 3) v.over = false;
  if (v.inFence !== null) {
    const inside = pointInRing(v.ll, FENCE.ring);
    if (inside !== v.inFence) {
      v.inFence = inside;
      flashFence(inside ? '#3ddc84' : '#ff4545');
      toast(`${inside ? '⬇ Entró a' : '⬆ Salió de'} <b>${FENCE.name}</b> · ${v.def.plate} · ${clockFmt.format(new Date()).slice(0, 5)}`, inside ? 'green' : 'cyan');
    }
  }
}

// ───────────────────────── hora y clima reales ─────────────────────────
const PALETTES = {
  noche: {
    bg: ['background-color', '#0a0d16'], park: ['fill-color', '#0d1c17'], green: ['fill-color', '#0d1a15'], water: ['fill-color', '#0a1d33'],
    'road-minor': ['line-color', '#1b2234'], 'road-major': ['line-color', '#283249'], 'road-glow': ['line-opacity', 0.22],
    buildings: ['fill-extrusion-color', ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#141a29', 30, '#1c2640', 100, '#2b3d66']],
    'road-labels': ['text-color', '#7d8597'], 'place-labels': ['text-color', '#5b6478'],
    halo: '#0a0d16',
  },
  dia: {
    bg: ['background-color', '#e6eaf0'], park: ['fill-color', '#cfe5d3'], green: ['fill-color', '#d6e8d4'], water: ['fill-color', '#9cc3e6'],
    'road-minor': ['line-color', '#ffffff'], 'road-major': ['line-color', '#fde7cf'], 'road-glow': ['line-opacity', 0.4],
    buildings: ['fill-extrusion-color', ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#e4e8f0', 30, '#c9d1e0', 100, '#a3b1cb']],
    'road-labels': ['text-color', '#4b5563'], 'place-labels': ['text-color', '#6b7280'],
    halo: '#ffffff',
  },
};

// Luz por momento del día: intensidad de luces, color del sol, tinte de la ciudad real y del cielo.
const PHASES = {
  dia: { palette: 'dia', ambient: 1.9, sun: 2.6, sunColor: 0xffffff, tint: [1, 1, 1], lights: 0, sky: '#8fb8de', icon: '☀️', label: 'Día' },
  atardecer: { palette: 'dia', ambient: 0.95, sun: 1.9, sunColor: 0xffa062, tint: [1, 0.8, 0.66], lights: 0.45, sky: '#d99a78', icon: '🌅', label: 'Atardecer' },
  noche: { palette: 'noche', ambient: 0.55, sun: 0.5, sunColor: 0x8aa2ff, tint: [0.2, 0.25, 0.42], lights: 1, sky: '#0b1220', icon: '🌙', label: 'Noche' },
};
const WEATHER_MODES = ['real', 'rain', 'storm', 'clear'];
const WEATHER_SIM = {
  rain: { icon: '🌧️', text: 'Lluvia', kind: 'rain' },
  storm: { icon: '⛈️', text: 'Tormenta eléctrica', kind: 'storm' },
  clear: { icon: '☀️', text: 'Despejado', kind: 'clear' },
};
const TIME_MODES = ['auto', 'dia', 'atardecer', 'noche'];

function currentPhase() {
  if (app.env.timeMode !== 'auto') return app.env.timeMode;
  return phaseFor(app.env.sun?.elevation ?? 30);
}

function currentWeather() {
  if (app.env.weatherMode !== 'real') return WEATHER_SIM[app.env.weatherMode];
  const w = app.env.weather;
  return w ? describeWeather(w.code) : { icon: '🌤️', text: 'Sin datos de clima', kind: 'clear' };
}

function applyEnv() {
  const phaseName = currentPhase();
  const ph = PHASES[phaseName];
  const wx = currentWeather();
  const wet = wx.kind === 'rain' || wx.kind === 'storm' || wx.kind === 'drizzle';
  const dim = wet ? 0.72 : wx.kind === 'cloudy' || wx.kind === 'fog' ? 0.86 : 1;
  app.env.phase = phaseName;
  app.env.lights = Math.min(1, ph.lights + (wet ? 0.35 : 0));
  app.env.tint = ph.tint.map((c) => c * dim);
  const pal = PALETTES[ph.palette];
  for (const [layer, val] of Object.entries(pal)) {
    if (Array.isArray(val) && map.getLayer(layer)) map.setPaintProperty(layer, val[0], val[1]);
  }
  for (const layer of ['road-labels', 'place-labels']) if (map.getLayer(layer)) map.setPaintProperty(layer, 'text-halo-color', pal.halo);
  if (app.photo && map.getLayer('bg')) map.setPaintProperty('bg', 'background-color', ph.sky);
  if (three.ambient) {
    three.ambient.intensity = ph.ambient * dim;
    three.sun.intensity = ph.sun * dim;
    three.sun.color.setHex(ph.sunColor);
    const sun = app.env.sun;
    if (sun && sun.elevation > -2) {
      const el = Math.max(4, sun.elevation) * RAD, az = sun.azimuth * RAD;
      three.sun.position.set(Math.sin(az) * Math.cos(el) * 100, Math.sin(el) * 100, -Math.cos(az) * Math.cos(el) * 100);
    } else three.sun.position.set(-40, 90, 30);
  }
  if (three.tiles) tintTiles(three.tiles.group);
  document.body.dataset.theme = ph.palette;
  document.body.dataset.phase = phaseName;
  document.body.dataset.weather = wx.kind;
  const tm = app.env.timeMode;
  $('btnTheme').textContent = tm === 'auto' ? `🕒 ${ph.icon}` : ph.icon;
  $('btnTheme').title = tm === 'auto' ? `Hora real de ${CITY.name}: ${ph.label.toLowerCase()} (toca para simular otra hora)` : `${ph.label} simulado (toca para cambiar)`;
  const w = app.env.weather;
  const temp = w && app.env.weatherMode === 'real' ? ` ${Math.round(w.temp)}°` : '';
  $('btnWeather').innerHTML = `${wx.icon}<span>${temp} ${CITY.name}${app.env.weatherMode === 'real' ? '' : ' · simulado'}</span>`;
  $('btnWeather').title = `${wx.text}${w && app.env.weatherMode === 'real' ? ` · humedad ${w.humidity}% · viento ${Math.round(w.wind)} km/h` : ''} (toca para simular otro clima)`;
  const intensity = wx.kind === 'storm' ? 1 : wx.kind === 'rain' ? Math.min(1, 0.55 + (w?.precip || 0) / 6) : wx.kind === 'drizzle' ? 0.25 : 0;
  app.rain?.set(intensity, wx.kind === 'storm', 0.15 + Math.min(0.5, (w?.wind || 12) / 60));
}

function updateSun() {
  const prev = app.env.sun ? phaseFor(app.env.sun.elevation) : null;
  app.env.sun = sunPosition(new Date(), CITY.lat, CITY.lng);
  if (prev !== phaseFor(app.env.sun.elevation)) applyEnv();
}

async function refreshWeather() {
  const w = await fetchWeather(CITY.lat, CITY.lng);
  if (w) app.env.weather = w;
  applyEnv();
}

function lightning() {
  const f = $('flash');
  f.classList.remove('on');
  void f.offsetWidth;
  f.classList.add('on');
}

// ───────────────────────── 4D: dónde estará en 5 minutos ─────────────────────────
const FUTURE_S = 300;

function futureD(v) {
  if (v.state.engineCut) return null;
  return v.state.d + ((v.def.cruise * 0.8) / KMH) * (v.state.theft ? 1.4 : 1) * FUTURE_S;
}

function ensureGhost(def) {
  if (app.ghost?.kind === def.kind) return;
  if (app.ghost) three.root.remove(app.ghost.model.group);
  const model = kit.buildVehicle({ ...def, color: 0x38e1ff });
  model.group.traverse((o) => {
    if (!o.material) return;
    o.material = o.material.clone();
    o.material.transparent = true;
    o.material.opacity = 0.38;
    o.material.depthWrite = false;
    if (o.material.emissive) o.material.emissive.setHex(0x38e1ff);
  });
  model.ringMat = model.group.children.find((o) => o.geometry?.type === 'RingGeometry').material;
  model.ringMat.color.setHex(0x38e1ff);
  model.bar.visible = false;
  model.group.visible = false;
  three.root.add(model.group);
  app.ghost = { kind: def.kind, model };
}

function setFuture(on) {
  app.future = on;
  $('btnFuture').classList.toggle('ok', on);
  if (!on) {
    if (app.ghost) app.ghost.model.group.visible = false;
    if (app.ghostLabel) app.ghostLabel.hidden = true;
    map.getSource('future')?.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  const v = app.selected;
  const d1 = futureD(v);
  if (d1 === null) {
    app.future = false;
    $('btnFuture').classList.remove('ok');
    toast('El vehículo está apagado: no hay recorrido por predecir.', '');
    return;
  }
  ensureGhost(v.def);
  const b = new maplibregl.LngLatBounds();
  for (const p of sampleRange(v.route, v.state.d, d1, 80)) b.extend(p);
  const narrow = window.innerWidth < 760;
  app.cam = 'libre';
  setCamButtons('libre');
  app.flyLock = performance.now() + 2200;
  map.fitBounds(b, { padding: narrow ? { top: 90, bottom: 270, left: 40, right: 80 } : { top: 140, bottom: 170, left: 300, right: 140 }, pitch: 55, bearing: v.state.heading, duration: 2200, maxZoom: 16.5 });
  const eta = clockFmt.format(new Date(Date.now() + FUTURE_S * 1000)).slice(0, 5);
  toast(`🔮 En 5 minutos <b>${v.def.plate}</b> estará ${nearText(posAt(v.route, d1))} (hacia las ${eta}).`, 'cyan', 6000);
}

let futureAt = 0;
function updateFuture(v, k, now) {
  if (!app.future || !app.ghost) return;
  const d1 = app.replay ? null : futureD(v);
  const g = app.ghost.model;
  if (d1 === null) {
    g.group.visible = false;
    app.ghostLabel.hidden = true;
    return;
  }
  const xy = posAt(v.route, d1);
  g.group.visible = true;
  g.group.position.set(xy[0], 0, -xy[1]);
  g.group.rotation.y = (-headingAt(v.route, d1) * Math.PI) / 180;
  g.group.scale.setScalar(k);
  g.ringMat.opacity = 0.5 + 0.4 * Math.sin(now / 250);
  if (now - futureAt < 250) return;
  futureAt = now;
  const ll = toLL(xy);
  app.ghostMarker.setLngLat(ll);
  app.ghostLabel.hidden = false;
  const eta = clockFmt.format(new Date(Date.now() + FUTURE_S * 1000)).slice(0, 5);
  app.ghostLabel.innerHTML = `🔮 En 5 min · ${eta}<small>${nearText(xy).replace(/<\/?b>/g, '')}</small>`;
  map.getSource('future')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: sampleRange(v.route, v.state.d, d1, 25) } });
}

// ───────────────────────── entrada y modo presentación ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function intro() {
  const v = app.selected;
  $('intro').classList.add('on');
  document.body.classList.add('intro-on');
  app.flyLock = performance.now() + 60000;
  map.jumpTo({ center: [-73.6, 7.2], zoom: 5, pitch: 0, bearing: 0 });
  await sleep(900);
  map.flyTo({ center: v.ll, zoom: 13.6, pitch: 55, bearing: -25, duration: 5200, essential: true });
  await sleep(5300);
  $('intro').classList.remove('on');
  document.body.classList.remove('intro-on');
  app.cam = 'dron';
  setCamButtons('dron');
  app.camBearing = v.state.heading;
  map.easeTo({ ...camFor('dron', v), duration: 2600, essential: true });
  await sleep(2600);
  app.flyLock = 0;
}

let show = null;
async function wait(token, ms) {
  await sleep(ms);
  if (show !== token) throw new Error('stop');
}

function caption(i, n, text) {
  const c = $('caption');
  c.hidden = false;
  c.innerHTML = `<small>${i} / ${n}</small><span>${text}</span>`;
  c.classList.remove('in');
  void c.offsetWidth;
  c.classList.add('in');
}

function resetDemo() {
  if (app.replay) closeReplay();
  setFuture(false);
  for (const v of app.vehicles) { v.state.theft = false; v.state.engineCut = false; }
  showCai(false);
  app.env.weatherMode = 'real';
  app.env.timeMode = 'auto';
  applyEnv();
  setLivePill();
  syncActionButtons();
}

const SHOW = [
  { text: `Del satélite a las calles de ${CITY.name}: así ve cada cliente su vehículo.`, run: async (tk) => { await intro(); await wait(tk, 1200); } },
  { text: 'Telemetría en vivo sobre el vehículo: velocidad, encendido, batería, combustible y rumbo.', run: (tk) => { setCam('dron'); return wait(tk, 7000); } },
  { text: 'Cámara de conductor: detrás de tu propio Mazda 2, con su color y su placa.', run: (tk) => { setCam('conductor'); return wait(tk, 8000); } },
  { text: '4D · Predicción: dónde estará en 5 minutos y a qué hora.', run: async (tk) => { setFuture(true); await wait(tk, 8500); setFuture(false); } },
  { text: 'Toda la flota de una empresa en una sola mirada, con color por velocidad.', run: (tk) => { setCam('torre'); return wait(tk, 9000); } },
  { text: `Hora y clima reales de ${CITY.name}: si allá llueve, aquí llueve; de noche, el carro va con las luces encendidas.`, run: async (tk) => {
    setCam('dron');
    app.env.weatherMode = 'storm';
    app.env.timeMode = 'noche';
    applyEnv();
    await wait(tk, 9500);
    app.env.weatherMode = 'real';
    app.env.timeMode = 'auto';
    applyEnv();
  } },
  { text: 'Robo: alerta inmediata, cámara de persecución y el CAI más cercano.', run: (tk) => { setTheft(app.selected, true); setCam('dron'); return wait(tk, 8000); } },
  { text: 'Apagado remoto con un toque: frena de forma segura y queda inmovilizado.', run: (tk) => { setEngineCut(app.selected, true); return wait(tk, 9000); } },
  { text: 'El recorrido del día como una película, con paradas y excesos de velocidad marcados.', run: async (tk) => {
    setEngineCut(app.selected, false);
    $('replaySpeed').value = '60';
    openReplay();
    await wait(tk, 13000);
    closeReplay();
  } },
  { text: 'TuGPS24 3D · el siguiente nivel del rastreo satelital.', run: (tk) => { setCam('torre'); return wait(tk, 7000); } },
];

async function runShow() {
  const token = {};
  show = token;
  document.body.classList.add('showing');
  $('btnShow').innerHTML = '■<span> Detener</span>';
  try {
    resetDemo();
    select(app.vehicles[0]);
    for (let i = 0; i < SHOW.length; i++) {
      caption(i + 1, SHOW.length, SHOW[i].text);
      await SHOW[i].run(token);
    }
  } catch (e) {
    if (e.message !== 'stop') console.error(e);
  } finally {
    if (show === token) stopShow();
  }
}

function stopShow() {
  show = null;
  document.body.classList.remove('showing');
  $('btnShow').innerHTML = '▶<span> Presentación</span>';
  $('caption').hidden = true;
  app.flyLock = 0;
  resetDemo();
}

// ───────────────────────── eventos de la interfaz ─────────────────────────
document.querySelectorAll('.cams button').forEach((b) => b.addEventListener('click', () => {
  if (app.replay) closeReplay();
  setCam(b.dataset.cam);
}));

for (const ev of ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart']) {
  map.on(ev, (e) => {
    if (e.originalEvent && !app.replay && app.cam !== 'libre') setCam('libre');
  });
}

function setEngineCut(v, cut) {
  const s = v.state;
  if (s.engineCut === cut) return;
  if (cut) {
    s.engineCut = true;
    const [x, y] = toXY(v.ll);
    three.fx.wave(x, -y, 0x38e1ff);
    setTimeout(() => three.fx.wave(x, -y, 0x38e1ff), 350);
    toast(`📡 Orden de apagado enviada por satélite a <b>${v.def.plate}</b>…`, 'cyan');
  } else {
    s.engineCut = false;
    if (s.theft) { s.theft = false; showCai(false); }
    const [x, y] = toXY(v.ll);
    three.fx.wave(x, -y, 0x3ddc84);
    toast(`▶ Motor de <b>${v.def.plate}</b> reactivado.`, 'green');
  }
  setLivePill();
  syncActionButtons();
  narrate(true);
}

function setTheft(v, on) {
  const s = v.state;
  if (s.theft === on) return;
  s.theft = on;
  if (s.theft) {
    s.engineCut = false;
    s.stopTimer = 0;
    showCai(true);
    toast(`🚨 <b>ALERTA:</b> ${v.def.plate} se mueve sin autorización. Cámara de persecución activada.`, 'red', 7000);
    if (app.cam !== 'conductor') setCam('dron');
  } else {
    showCai(app.vehicles.some((o) => o.state.theft));
    toast('Simulación de robo terminada.', 'green');
  }
  setLivePill();
  syncActionButtons();
  narrate(true);
}

$('btnCut').addEventListener('click', () => {
  const v = app.selected;
  if (!v.state.engineCut && !confirm(`¿Apagar el motor de ${v.def.plate}? El vehículo frenará de forma segura hasta detenerse.`)) return;
  setEngineCut(v, !v.state.engineCut);
});
$('btnTheft').addEventListener('click', () => setTheft(app.selected, !app.selected.state.theft));
$('btnFuture').addEventListener('click', () => setFuture(!app.future));
$('btnTheme').addEventListener('click', () => {
  const env = app.env;
  env.timeMode = TIME_MODES[(TIME_MODES.indexOf(env.timeMode) + 1) % TIME_MODES.length];
  applyEnv();
  toast(env.timeMode === 'auto' ? `🕒 Hora real de ${CITY.name}: ${PHASES[currentPhase()].label.toLowerCase()}.` : `${PHASES[env.timeMode].icon} Simulando ${PHASES[env.timeMode].label.toLowerCase()}.`, 'cyan', 3000);
});
$('btnWeather').addEventListener('click', () => {
  const env = app.env;
  env.weatherMode = WEATHER_MODES[(WEATHER_MODES.indexOf(env.weatherMode) + 1) % WEATHER_MODES.length];
  applyEnv();
  const wx = currentWeather();
  toast(env.weatherMode === 'real' ? `${wx.icon} Clima real de ${CITY.name}: ${wx.text.toLowerCase()}.` : `${wx.icon} Simulando ${wx.text.toLowerCase()}.`, 'cyan', 3000);
});
$('btnPhoto').addEventListener('click', () => {
  if (!three.tiles) {
    toast('Para la ciudad fotorrealista falta la clave de Google Map Tiles API (variable PUBLIC_GOOGLE_MAPS_KEY o ?gkey= en el enlace).', 'red', 8000);
    return;
  }
  setPhoto(!app.photo);
});
$('btnShow').addEventListener('click', () => {
  if (show) { stopShow(); return; }
  try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch {}
  runShow();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && show) stopShow(); });

$('btnReplay').addEventListener('click', openReplay);
$('replayClose').addEventListener('click', closeReplay);
$('replayPlay').addEventListener('click', () => {
  const r = app.replay;
  if (!r) return;
  if (r.t >= r.v.day.dur) r.t = 0;
  r.playing = !r.playing;
  $('replayPlay').textContent = r.playing ? '❚❚' : '▶';
});
$('replaySlider').addEventListener('input', (e) => {
  const r = app.replay;
  if (!r) return;
  r.t = (Number(e.target.value) / 1000) * r.v.day.dur;
});
$('btnRecord').addEventListener('click', onRecord);

init();
