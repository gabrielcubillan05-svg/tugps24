import * as THREE from '/vendor/three-0.160.0/three.module.min.js';

const maplibregl = window.maplibregl;
maplibregl.setWorkerUrl('/vendor/maplibre-gl-4.7.1/maplibre-gl-csp-worker.js');

// ───────────────────────── geografía ─────────────────────────
const ORIGIN = { lng: -74.075, lat: 4.66 };
const M_PER_DEG = 111319.49;
const MX = M_PER_DEG * Math.cos((ORIGIN.lat * Math.PI) / 180);
const MY = M_PER_DEG;
const toXY = ([lng, lat]) => [(lng - ORIGIN.lng) * MX, (lat - ORIGIN.lat) * MY];
const toLL = ([x, y]) => [ORIGIN.lng + x / MX, ORIGIN.lat + y / MY];

const PLACES = {
  parque93: { ll: [-74.0484, 4.6766], name: 'el Parque de la 93' },
  andino: { ll: [-74.0527, 4.6669], name: 'el Centro Andino' },
  calle72: { ll: [-74.0563, 4.6553], name: 'la Calle 72 con Séptima' },
  campin: { ll: [-74.0773, 4.6459], name: 'el Estadio El Campín' },
  calle100: { ll: [-74.0554, 4.6866], name: 'la Calle 100 con Autopista' },
  unicentro: { ll: [-74.0416, 4.7022], name: 'Unicentro' },
  usaquen: { ll: [-74.0308, 4.6949], name: 'Usaquén' },
  plazaBolivar: { ll: [-74.076, 4.5981], name: 'la Plaza de Bolívar' },
  colpatria: { ll: [-74.0703, 4.6107], name: 'la Torre Colpatria' },
  unal: { ll: [-74.084, 4.6381], name: 'la Universidad Nacional' },
  simonBolivar: { ll: [-74.0939, 4.6584], name: 'el Parque Simón Bolívar' },
  salitre: { ll: [-74.1095, 4.6526], name: 'Salitre Plaza' },
  eldorado: { ll: [-74.1469, 4.7016], name: 'el Aeropuerto El Dorado' },
};
const PLACE_LIST = Object.values(PLACES).map((p) => ({ ...p, xy: toXY(p.ll) }));

const FENCE = {
  name: 'Zona segura · Casa',
  ring: [
    [-74.0578, 4.6655], [-74.0551, 4.6628], [-74.0478, 4.6636], [-74.0447, 4.6702],
    [-74.0452, 4.6795], [-74.0512, 4.6812], [-74.0566, 4.6745], [-74.0578, 4.6655],
  ],
};

// Puntos de policía ficticios, solo para la simulación de robo.
const CAI = [
  { ll: [-74.0592, 4.6578], name: 'CAI Chapinero · demo' },
  { ll: [-74.0447, 4.6985], name: 'CAI Unicentro · demo' },
  { ll: [-74.0735, 4.6492], name: 'CAI Galerías · demo' },
];

const FLEET = [
  { id: 'main', name: 'Mi carro', plate: 'ABC-123', kind: 'sedan', icon: '🚗', color: 0xff7a1a, cruise: 52, start: 0,
    stops: ['parque93', 'andino', 'calle72', 'campin', 'calle100', 'unicentro', 'usaquen', 'parque93'] },
  { id: 'moto', name: 'Moto mensajería', plate: 'XYZ-45A', kind: 'moto', icon: '🏍️', color: 0x38e1ff, cruise: 46, start: 0.35,
    stops: ['plazaBolivar', 'colpatria', 'unal', 'campin', 'colpatria', 'plazaBolivar'] },
  { id: 'truck', name: 'Camión reparto', plate: 'TRK-908', kind: 'truck', icon: '🚚', color: 0xf2ede2, cruise: 40, start: 0.2,
    stops: ['eldorado', 'salitre', 'simonBolivar', 'unal', 'salitre', 'eldorado'] },
  { id: 'van', name: 'Van escolar', plate: 'VAN-321', kind: 'van', icon: '🚐', color: 0xffc23d, cruise: 42, start: 0.6,
    stops: ['unicentro', 'usaquen', 'parque93', 'calle100', 'unicentro'] },
];

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
const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.35, ...o });
const GLASS = mat(0x0d1a2b, { roughness: 0.1, metalness: 0.9 });
const TIRE = mat(0x111111, { roughness: 0.9, metalness: 0 });

function box(w, h, l, m, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m);
  mesh.position.set(x, y, z);
  return mesh;
}
function wheel(r, w, x, z) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 18), TIRE);
  mesh.rotation.z = Math.PI / 2;
  mesh.position.set(x, r, z);
  return mesh;
}

function buildVehicle(veh) {
  const g = new THREE.Group();
  const body = mat(veh.color);
  const head = new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xfff4d6, emissiveIntensity: 2 });
  const tail = new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff2a2a, emissiveIntensity: 1.6 });
  const lights = [];
  const addLight = (m) => { lights.push(m); g.add(m); };
  let L = 4.5;
  if (veh.kind === 'sedan') {
    g.add(box(1.84, 0.62, 4.5, body, 0, 0.62, 0));
    g.add(box(1.62, 0.55, 2.3, GLASS, 0, 1.2, 0.25));
    g.add(box(1.58, 0.07, 1.95, body, 0, 1.5, 0.3));
    for (const x of [-0.88, 0.88]) for (const z of [-1.45, 1.4]) g.add(wheel(0.34, 0.26, x, z));
    for (const x of [-0.62, 0.62]) { addLight(box(0.42, 0.12, 0.06, head, x, 0.72, -2.26)); addLight(box(0.42, 0.12, 0.06, tail, x, 0.78, 2.26)); }
  } else if (veh.kind === 'moto') {
    L = 2;
    g.add(box(0.34, 0.45, 1.8, body, 0, 0.72, 0));
    g.add(box(0.46, 0.7, 0.4, mat(0x1f2937), 0, 1.3, 0.12));
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), body);
    helmet.position.set(0, 1.82, 0.08);
    g.add(helmet);
    g.add(box(0.5, 0.42, 0.42, mat(0x111827), 0, 1.05, 0.85));
    for (const z of [-0.72, 0.72]) g.add(wheel(0.32, 0.12, 0, z));
    addLight(box(0.16, 0.12, 0.06, head, 0, 0.95, -0.92));
    addLight(box(0.16, 0.08, 0.06, tail, 0, 0.9, 1.08));
  } else if (veh.kind === 'truck') {
    L = 8.5;
    g.add(box(2.3, 2.3, 1.9, mat(0x2563eb), 0, 1.55, -3.2));
    g.add(box(2.0, 0.8, 0.08, GLASS, 0, 2.05, -4.16));
    g.add(box(2.5, 2.9, 6.2, body, 0, 2.05, 0.9));
    g.add(box(2.4, 0.3, 8.2, mat(0x1f2937), 0, 0.55, -0.1));
    for (const x of [-1.05, 1.05]) for (const z of [-3.2, 1.6, 2.9]) g.add(wheel(0.5, 0.35, x, z));
    for (const x of [-0.85, 0.85]) { addLight(box(0.4, 0.2, 0.06, head, x, 0.95, -4.18)); addLight(box(0.3, 0.2, 0.06, tail, x, 0.9, 4.02)); }
  } else {
    L = 5.2;
    g.add(box(1.95, 1.75, 5.2, body, 0, 1.25, 0));
    g.add(box(1.97, 0.6, 3.6, GLASS, 0, 1.62, 0.5));
    g.add(box(1.7, 0.7, 0.06, GLASS, 0, 1.55, -2.62));
    for (const x of [-0.92, 0.92]) for (const z of [-1.7, 1.7]) g.add(wheel(0.36, 0.28, x, z));
    for (const x of [-0.7, 0.7]) { addLight(box(0.36, 0.14, 0.06, head, x, 0.85, -2.62)); addLight(box(0.3, 0.2, 0.06, tail, x, 1.0, 2.62)); }
  }

  // El anillo y la columna de luz son lo que se ve desde la vista de torre, donde el modelo es diminuto.
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(L * 0.62, L * 0.75, 48), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  g.add(ring);
  const discMat = new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.16, depthWrite: false });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(L * 0.62, 48), discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.05;
  g.add(disc);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(L * 0.08, L * 0.08, 60, 10, 1, true), beamMat);
  beam.position.y = 30;
  g.add(beam);

  const bar = new THREE.Group();
  const redL = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 3 });
  const blueL = new THREE.MeshStandardMaterial({ color: 0x2060ff, emissive: 0x2060ff, emissiveIntensity: 3 });
  const top = veh.kind === 'truck' ? 3.6 : veh.kind === 'van' ? 2.2 : veh.kind === 'moto' ? 2.1 : 1.6;
  const r = box(0.5, 0.14, 0.26, redL, -0.3, top, 0.2);
  const b = box(0.5, 0.14, 0.26, blueL, 0.3, top, 0.2);
  bar.add(r, b);
  bar.visible = false;
  g.add(bar);

  g.traverse((o) => { o.frustumCulled = false; });
  return { group: g, lights, head, tail, ringMat, discMat, beamMat, bar, red: r, blue: b, L };
}

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
  center: [-74.3, 4.4],
  zoom: 5.2,
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
  theme: (() => {
    const h = Number(new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }).format(new Date()));
    return h >= 6 && h < 18 ? 'dia' : 'noche';
  })(),
};

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
  return `<div class="pl">${v.def.icon} ${v.def.name} · ${v.def.plate}</div>
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
  if (app.replay) t = `Repetición del día: a las <b>${replayClock(app.replay.t)}</b> tu ${v.def.name.toLowerCase()} iba a <b>${Math.round(app.replay.sample.v * KMH)} km/h</b> ${near}.`;
  else if (s.theft && !s.engineCut) t = `🚨 Movimiento sin autorización a <b>${kmh} km/h</b> ${near}. Lo sigo en vivo y el CAI más cercano ya está marcado. Puedes <b>apagar el motor</b> desde aquí.`;
  else if (s.engineCut && s.v === 0) t = `Motor apagado a distancia. <b>${v.def.plate}</b> está inmovilizado ${near}. Para encenderlo de nuevo usa <b>Reactivar motor</b>.`;
  else if (s.engineCut) t = `Orden de apagado recibida: el vehículo baja la velocidad de forma segura (${kmh} km/h).`;
  else if (kmh > OVER_KMH) t = `Ojo: <b>${v.def.plate}</b> va a <b>${kmh} km/h</b> ${near}, por encima del límite urbano de 60.`;
  else if (s.stopTimer > 0) t = `<b>${v.def.plate}</b> está detenido ${near}, con el motor encendido. Parece un semáforo.`;
  else t = `Tu <b>${v.def.name.toLowerCase()}</b> va a <b>${kmh} km/h</b> ${near}. Hoy lleva <b>${fmt1.format(s.odo / 1000)} km</b> recorridos.`;
  $('gpsitoText').innerHTML = t;
}

// ───────────────────────── capa 3D ─────────────────────────
const three = {};
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
    const fill = new THREE.DirectionalLight(0xff9a50, 0.8);
    fill.position.set(-80, 40, -60);
    three.scene.add(fill);
    three.root = new THREE.Group();
    three.scene.add(three.root);
    three.fx = makeFx(three.root);
    three.renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
    three.renderer.autoClear = false;
    for (const v of app.vehicles) three.root.add(v.model.group);
    applyTheme(app.theme);
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
    three.renderer.resetState();
    three.renderer.render(three.scene, three.camera);
    map.triggerRepaint();
  },
};

function updateModel(v, k, t) {
  const s = v.state, m = v.model;
  const [x, y] = toXY(v.ll);
  m.group.position.set(x, 0, -y);
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
  m.head.emissiveIntensity = on ? 2 : 0;
  m.tail.emissiveIntensity = on ? (s.v < 2 ? 3 : 1.4) : 0;
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
  app.ghostMarker = new maplibregl.Marker({ element: gl, anchor: 'bottom', offset: [0, -30] }).setLngLat(PLACES.parque93.ll).addTo(map);

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
    app.fenceFlashing = true;
  } else if (app.fenceFlashing) {
    app.fenceFlashing = false;
    map.setPaintProperty('fence-wall', 'fill-extrusion-color', '#38e1ff');
    map.setPaintProperty('fence-wall', 'fill-extrusion-opacity', 0.32);
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
  $('gpsitoText').textContent = 'Calculando rutas por las calles de Bogotá…';
  const routes = await Promise.all(FLEET.map((f) => fetchRoute(f.stops.map((k) => PLACES[k].ll))));
  app.vehicles = FLEET.map((def, i) => {
    const route = buildRoute(routes[i], 1000 + i * 77);
    const state = newState(def, route);
    const ll = toLL(posAt(route, state.d));
    const hud = document.createElement('div');
    hud.className = 'hud';
    const v = { def, id: def.id, route, state, ll, model: buildVehicle(def), hud };
    v.marker = new maplibregl.Marker({ element: hud, anchor: 'bottom', offset: [0, -34] }).setLngLat(ll).addTo(map);
    hud.addEventListener('click', () => select(v));
    v.inFence = def.id === 'main' ? pointInRing(ll, FENCE.ring) : null;
    return v;
  });

  const list = $('fleetList');
  for (const v of app.vehicles) {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" data-id="${v.id}"><span class="ico">${v.def.icon}</span><span class="name">${v.def.name}<span class="plate">${v.def.plate}</span></span><span class="spd">0</span></button>`;
    li.querySelector('button').addEventListener('click', () => select(v));
    v.listSpeed = li.querySelector('.spd');
    list.append(li);
  }

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
  }
  three.fx?.update(dt);
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

// ───────────────────────── día y noche ─────────────────────────
const THEMES = {
  noche: {
    bg: ['background-color', '#0a0d16'], park: ['fill-color', '#0d1c17'], green: ['fill-color', '#0d1a15'], water: ['fill-color', '#0a1d33'],
    'road-minor': ['line-color', '#1b2234'], 'road-major': ['line-color', '#283249'], 'road-glow': ['line-opacity', 0.22],
    buildings: ['fill-extrusion-color', ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#141a29', 30, '#1c2640', 100, '#2b3d66']],
    'road-labels': ['text-color', '#7d8597'], 'place-labels': ['text-color', '#5b6478'],
    halo: '#0a0d16', ambient: 0.9, sun: 1.8,
  },
  dia: {
    bg: ['background-color', '#e6eaf0'], park: ['fill-color', '#cfe5d3'], green: ['fill-color', '#d6e8d4'], water: ['fill-color', '#9cc3e6'],
    'road-minor': ['line-color', '#ffffff'], 'road-major': ['line-color', '#fde7cf'], 'road-glow': ['line-opacity', 0.4],
    buildings: ['fill-extrusion-color', ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#e4e8f0', 30, '#c9d1e0', 100, '#a3b1cb']],
    'road-labels': ['text-color', '#4b5563'], 'place-labels': ['text-color', '#6b7280'],
    halo: '#ffffff', ambient: 1.5, sun: 2.6,
  },
};

function applyTheme(name) {
  app.theme = name;
  const th = THEMES[name];
  for (const [layer, val] of Object.entries(th)) {
    if (Array.isArray(val) && map.getLayer(layer)) map.setPaintProperty(layer, val[0], val[1]);
  }
  for (const layer of ['road-labels', 'place-labels']) if (map.getLayer(layer)) map.setPaintProperty(layer, 'text-halo-color', th.halo);
  if (three.ambient) { three.ambient.intensity = th.ambient; three.sun.intensity = th.sun; }
  document.body.dataset.theme = name;
  $('btnTheme').textContent = name === 'dia' ? '☀️' : '🌙';
  $('btnTheme').title = name === 'dia' ? 'Cambiar a noche' : 'Cambiar a día';
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
  const model = buildVehicle({ ...def, color: 0x38e1ff });
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
  map.jumpTo({ center: [-74.3, 4.4], zoom: 5.2, pitch: 0, bearing: 0 });
  await sleep(900);
  map.flyTo({ center: v.ll, zoom: 13.2, pitch: 50, bearing: -25, duration: 4500, essential: true });
  await sleep(4600);
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
  setLivePill();
  syncActionButtons();
}

const SHOW = [
  { text: 'Del satélite a la calle: así ve cada cliente su vehículo, en la ciudad real.', run: async (tk) => { await intro(); await wait(tk, 1200); } },
  { text: 'Telemetría en vivo sobre el vehículo: velocidad, encendido, batería, combustible y rumbo.', run: (tk) => { setCam('dron'); return wait(tk, 7000); } },
  { text: 'Cámara de conductor: como ir detrás de tu propio carro.', run: (tk) => { setCam('conductor'); return wait(tk, 8000); } },
  { text: '4D · Predicción: dónde estará en 5 minutos y a qué hora.', run: async (tk) => { setFuture(true); await wait(tk, 8500); setFuture(false); } },
  { text: 'Toda la flota de una empresa en una sola mirada, con color por velocidad.', run: (tk) => { setCam('torre'); return wait(tk, 9000); } },
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
  $('btnShow').textContent = '■ Detener';
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
  $('btnShow').textContent = '▶ Presentación';
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
$('btnTheme').addEventListener('click', () => applyTheme(app.theme === 'dia' ? 'noche' : 'dia'));
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
