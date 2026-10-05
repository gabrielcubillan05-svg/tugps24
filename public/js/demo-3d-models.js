// Vehículos 3D de la demo. Cada referencia se arma con su silueta lateral real (largo, alto,
// distancia entre ejes) y su placa colombiana. Si en /models/manifest.json aparece un .glb para
// esa referencia (un modelo comprado), ese reemplaza al procedural sin tocar el código.

export function createModelKit(THREE, GLTFLoader, DRACOLoader) {
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.45, ...o });
  const GLASS = std(0x0b1622, { roughness: 0.06, metalness: 0.95 });
  const TIRE = std(0x121212, { roughness: 0.92, metalness: 0 });
  const RIM = std(0xc7ccd3, { roughness: 0.25, metalness: 0.9 });
  const BLACK = std(0x15171b, { roughness: 0.6, metalness: 0.2 });
  const CHROME = std(0xdfe3ea, { roughness: 0.15, metalness: 1 });

  function profile(points, width, material, bevel = 0.06) {
    const shape = new THREE.Shape(points.map(([s, y]) => new THREE.Vector2(s, y)));
    const depth = Math.max(0.01, width - 2 * bevel);
    const geo = new THREE.ExtrudeGeometry(shape, {
      // El bisel redondea los costados sin engordar la silueta más de 2 cm, para que placas y luces
      // puestas sobre el perfil queden por fuera de la carrocería.
      depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: Math.min(0.02, bevel), bevelSegments: 3, curveSegments: 8,
    });
    geo.translate(0, 0, -depth / 2);
    geo.rotateY(-Math.PI / 2);
    return new THREE.Mesh(geo, material);
  }

  // Borde inferior con los pasos de rueda recortados, de atrás hacia adelante.
  function underside(rear, front, axles, r, y = 0.3) {
    const pts = [[rear, y]];
    for (const a of [...axles].sort((p, q) => q - p)) {
      const steps = 10;
      for (let i = 0; i <= steps; i++) {
        const t = Math.PI * (i / steps);
        pts.push([a + r * Math.cos(t), y + 0.02 + r * Math.sin(t)]);
      }
    }
    pts.push([front, y]);
    return pts;
  }

  function box(w, h, l, m, x, y, z) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m);
    mesh.position.set(x, y, z);
    return mesh;
  }

  function wheel(r, w, x, z) {
    const g = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 24), TIRE);
    tire.rotation.z = Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.012, 18), RIM);
    rim.rotation.z = Math.PI / 2;
    g.add(tire, rim);
    g.position.set(x, r, z);
    return g;
  }

  const textures = new Map();
  function canvasTexture(key, w, h, draw) {
    if (textures.has(key)) return textures.get(key);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    textures.set(key, tex);
    return tex;
  }

  // Placa colombiana de servicio particular: fondo amarillo, letras negras y ciudad abajo.
  function plate(text, city, w = 0.34, h = 0.165) {
    const tex = canvasTexture('plate:' + text, 512, 248, (ctx, W, H) => {
      ctx.fillStyle = '#f5c400';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 10;
      ctx.strokeRect(6, 6, W - 12, H - 12);
      ctx.fillStyle = '#111';
      ctx.textAlign = 'center';
      ctx.font = 'bold 140px "IBM Plex Mono", monospace';
      ctx.fillText(text.replace('-', ' '), W / 2, 160);
      ctx.font = 'bold 38px "Poppins", sans-serif';
      ctx.fillText(city.toUpperCase(), W / 2, 222);
    });
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
  }

  function sideText(key, text, bg, fg, w, h) {
    const tex = canvasTexture(key, 1024, Math.round((1024 * h) / w), (ctx, W, H) => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.round(H * 0.62)}px "Poppins", sans-serif`;
      ctx.fillText(text, W / 2, H / 2 + 4);
    });
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 });
  }

  function attachPlates(g, def, frontZ, frontY, rearZ, rearY, w, h) {
    const f = plate(def.plate, def.city, w, h);
    f.position.set(0, frontY, frontZ - 0.004);
    f.rotation.y = Math.PI;
    const r = plate(def.plate, def.city, w, h);
    r.position.set(0, rearY, rearZ + 0.004);
    if (frontZ !== null) g.add(f);
    g.add(r);
  }

  const lightMats = () => ({
    head: new THREE.MeshStandardMaterial({ color: 0xfff6dc, emissive: 0xfff6dc, emissiveIntensity: 2 }),
    tail: new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff2a2a, emissiveIntensity: 1.6 }),
  });

  const BUILDERS = {
    // Mazda 2 sedán: 4,34 m de largo, 1,70 m de ancho, 1,47 m de alto, 2,57 m entre ejes.
    sedan(def, body, L) {
      const W = 1.7;
      const paint = std(def.color, { roughness: 0.22, metalness: 0.6 });
      const lower = [
        ...underside(2.06, -2.0, [1.24, -1.33], 0.36),
        [-2.14, 0.34], [-2.19, 0.56], [-2.12, 0.73], [-1.9, 0.82], [-0.92, 0.95],
        [1.46, 0.99], [1.66, 1.06], [2.1, 1.03], [2.19, 0.88], [2.19, 0.4],
      ];
      body.add(profile(lower, W, paint, 0.09));
      body.add(profile([[-0.92, 0.94], [-0.2, 1.4], [0.82, 1.42], [1.6, 1.05], [1.46, 0.98]], W - 0.2, GLASS, 0.04));
      body.add(profile([[-0.22, 1.39], [0.82, 1.41], [0.84, 1.47], [-0.16, 1.46]], W - 0.26, paint, 0.03));
      body.add(box(W - 0.17, 0.44, 0.09, paint, 0, 1.18, 0.3));
      body.add(box(0.78, 0.17, 0.04, BLACK, 0, 0.5, -2.22));
      body.add(box(0.5, 0.03, 0.03, CHROME, 0, 0.6, -2.235));
      for (const x of [-0.9, 0.9]) body.add(box(0.1, 0.1, 0.2, paint, x, 1.02, -0.78));
      for (const x of [-0.87, 0.87]) for (const z of [-1.33, 1.24]) body.add(wheel(0.31, 0.2, x, z));
      return { W, lights: [[0.42, 0.09, 0.16, 0.6, 0.71, -2.12], [0.38, 0.11, 0.05, 0.62, 0.96, 2.205]], plates: [-2.225, 0.36, 2.225, 0.66, 0.34, 0.165] };
    },
    // Chevrolet NHR con furgón: cabina corta y caja cerrada, ruedas dobles atrás.
    truck(def, body) {
      const W = 1.86;
      const cab = std(0xf3f4f6, { roughness: 0.35, metalness: 0.3 });
      body.add(profile([[-1.55, 0.6], [-2.95, 0.6], [-2.97, 1.3], [-2.88, 2.02], [-2.64, 2.36], [-1.58, 2.38]], W, cab, 0.08));
      body.add(profile([[-2.99, 1.42], [-2.9, 2.0], [-2.66, 2.32], [-2.6, 2.26], [-2.84, 1.98], [-2.92, 1.42]], W - 0.14, GLASS, 0.02));
      for (const x of [-0.94, 0.94]) body.add(box(0.02, 0.55, 0.85, GLASS, x, 1.9, -2.15));
      const boxMat = std(0xffffff, { roughness: 0.5, metalness: 0.1 });
      body.add(box(2.02, 2.2, 3.95, boxMat, 0, 1.95, 0.55));
      const logo = sideText('nhr-side', 'TuGPS24 · Reparto', '#ffffff', '#ff7a1a', 3.3, 0.55);
      for (const x of [-1.016, 1.016]) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 0.55), logo);
        p.position.set(x, 2.1, 0.55);
        p.rotation.y = x > 0 ? Math.PI / 2 : -Math.PI / 2;
        body.add(p);
      }
      body.add(box(0.95, 0.22, 5.3, BLACK, 0, 0.62, -0.25));
      body.add(box(1.9, 0.22, 0.12, BLACK, 0, 0.6, -3.0));
      for (const x of [-0.82, 0.82]) body.add(wheel(0.38, 0.24, x, -2.2));
      for (const x of [-0.95, -0.7, 0.7, 0.95]) body.add(wheel(0.38, 0.22, x, 1.35));
      return { W, lights: [[0.34, 0.16, 0.06, 0.72, 0.95, -3.0], [0.22, 0.2, 0.05, 0.85, 0.9, 2.55]], plates: [-3.07, 0.6, 2.53, 0.9, 0.34, 0.165] };
    },
    // Toyota Hiace escolar: 5,38 m, techo alto, amarilla con franja negra "ESCOLAR".
    van(def, body) {
      const W = 1.88;
      const paint = std(def.color, { roughness: 0.3, metalness: 0.35 });
      const outline = [
        ...underside(2.5, -2.55, [1.46, -1.75], 0.37, 0.34),
        [-2.68, 0.38], [-2.7, 0.8], [-2.56, 1.06], [-2.08, 1.24], [-1.38, 2.22], [2.55, 2.26], [2.69, 2.1], [2.69, 0.42],
      ];
      body.add(profile(outline, W, paint, 0.08));
      body.add(profile([[-2.1, 1.27], [-1.4, 2.17], [2.48, 2.17], [2.52, 1.45], [-1.98, 1.4]], W + 0.012, GLASS, 0));
      const band = sideText('hiace-escolar', 'ESCOLAR', '#111111', '#f5c400', 2.6, 0.34);
      for (const x of [-(W / 2 + 0.013), W / 2 + 0.013]) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.34), band);
        p.position.set(x, 1.08, 0.35);
        p.rotation.y = x > 0 ? Math.PI / 2 : -Math.PI / 2;
        body.add(p);
      }
      const back = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.26), band);
      back.position.set(0, 1.62, 2.72);
      body.add(back);
      body.add(box(1.1, 0.2, 0.05, BLACK, 0, 0.62, -2.73));
      for (const x of [-0.86, 0.86]) for (const z of [-1.75, 1.46]) body.add(wheel(0.33, 0.22, x, z));
      return { W, lights: [[0.38, 0.14, 0.06, 0.7, 0.86, -2.7], [0.18, 0.4, 0.05, 0.86, 1.05, 2.715]], plates: [-2.745, 0.44, 2.725, 0.62, 0.34, 0.165] };
    },
    // Bajaj Boxer CT 100 de mensajería, con baúl de domicilios atrás.
    moto(def, body) {
      const paint = std(def.color, { roughness: 0.25, metalness: 0.5 });
      body.add(box(0.12, 0.12, 1.2, BLACK, 0, 0.62, 0));
      body.add(profile([[-0.42, 0.78], [-0.2, 0.98], [0.12, 0.95], [0.18, 0.8]], 0.3, paint, 0.05));
      body.add(box(0.26, 0.09, 0.62, BLACK, 0, 0.93, 0.42));
      body.add(box(0.2, 0.3, 0.35, BLACK, 0, 0.52, 0.0));
      body.add(box(0.04, 0.55, 0.04, CHROME, 0, 0.88, -0.66));
      body.add(box(0.7, 0.03, 0.03, CHROME, 0, 1.12, -0.6));
      const box2 = std(0xd62828, { roughness: 0.5, metalness: 0.1 });
      body.add(box(0.48, 0.44, 0.42, box2, 0, 1.26, 0.82));
      const rider = std(0x1f2a44, { roughness: 0.8, metalness: 0 });
      body.add(box(0.42, 0.6, 0.3, rider, 0, 1.33, 0.32));
      for (const x of [-0.24, 0.24]) {
        body.add(box(0.12, 0.12, 0.62, rider, x, 1.42, -0.12));
        body.add(box(0.14, 0.5, 0.14, rider, x, 0.82, 0.05));
      }
      const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), paint);
      helmet.position.set(0, 1.78, 0.26);
      helmet.scale.set(1, 1, 1.15);
      body.add(helmet);
      body.add(box(0.2, 0.08, 0.05, GLASS, 0, 1.76, 0.1));
      body.add(wheel(0.3, 0.09, 0, -0.66));
      body.add(wheel(0.3, 0.1, 0, 0.66));
      return { W: 0.7, lights: [[0.16, 0.14, 0.06, 0, 0.98, -0.74], [0.14, 0.06, 0.05, 0, 0.9, 1.05]], plates: [null, 0, 1.05, 0.62, 0.2, 0.15], single: true };
    },
  };

  function lightCone() {
    const tex = canvasTexture('cone', 256, 512, (ctx, W, H) => {
      const g = ctx.createRadialGradient(W / 2, H, 10, W / 2, H, H);
      g.addColorStop(0, 'rgba(255,240,200,0.9)');
      g.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(W / 2 - 18, H);
      ctx.lineTo(0, 0);
      ctx.lineTo(W, 0);
      ctx.lineTo(W / 2 + 18, H);
      ctx.fill();
    });
    return new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  }

  function buildVehicle(def) {
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    const spec = BUILDERS[def.kind](def, body);
    const L = def.length;
    const { head, tail } = lightMats();
    const [hl, tl] = spec.lights;
    const xs = (x) => (spec.single ? [0] : [-x, x]);
    for (const x of xs(hl[3])) body.add(box(hl[0], hl[1], hl[2], head, x, hl[4], hl[5]));
    for (const x of xs(tl[3])) body.add(box(tl[0], tl[1], tl[2], tail, x, tl[4], tl[5]));
    const [fz, fy, rz, ry, pw, ph] = spec.plates;
    attachPlates(body, def, fz, fy, rz, ry, pw, ph);

    const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.38, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(spec.W * 0.62, L * 0.56, 1);
    shadow.position.y = 0.03;
    g.add(shadow);

    const coneMat = lightCone();
    const cone = new THREE.Mesh(new THREE.PlaneGeometry(spec.single ? 4 : 7, 16), coneMat);
    cone.rotation.x = -Math.PI / 2;
    cone.position.set(0, 0.05, -L / 2 - 8);
    g.add(cone);

    // El anillo y la columna de luz son lo que se ve desde la vista de torre, donde el modelo es diminuto.
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(L * 0.62, L * 0.72, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    g.add(ring);
    const discMat = new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.1, depthWrite: false });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(L * 0.62, 48), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.04;
    g.add(disc);
    const beamMat = new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(L * 0.08, L * 0.08, 60, 10, 1, true), beamMat);
    beam.position.y = 30;
    g.add(beam);

    const bar = new THREE.Group();
    const redL = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 3 });
    const blueL = new THREE.MeshStandardMaterial({ color: 0x2060ff, emissive: 0x2060ff, emissiveIntensity: 3 });
    const top = { truck: 2.45, van: 2.32, moto: 1.98, sedan: 1.52 }[def.kind];
    const z = { truck: -2.1, van: -1.0, moto: 0.26, sedan: 0.3 }[def.kind];
    const r = box(0.42, 0.12, 0.22, redL, -0.24, top, z);
    const b = box(0.42, 0.12, 0.22, blueL, 0.24, top, z);
    bar.add(r, b);
    bar.visible = false;
    g.add(bar);

    g.traverse((o) => { o.frustumCulled = false; });
    return { group: g, body, head, tail, ringMat, discMat, beamMat, coneMat, bar, red: r, blue: b, L };
  }

  let loader = null;
  function getLoader() {
    if (loader) return loader;
    const draco = new DRACOLoader();
    draco.setDecoderPath('/vendor/three-tiles/draco/');
    loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    return loader;
  }

  async function loadManifest() {
    try {
      const res = await fetch('/models/manifest.json', { cache: 'no-cache' });
      return (await res.json())?.modelos || {};
    } catch {
      return {};
    }
  }

  // Ajusta el .glb al largo real de la referencia, lo apoya en el piso y lo deja mirando al frente (-Z).
  async function applyGlb(model, def, entry) {
    const gltf = await getLoader().loadAsync('/models/' + entry.archivo);
    const scene = gltf.scene;
    scene.rotation.y = ((entry.rotacionY || 0) * Math.PI) / 180;
    scene.updateMatrixWorld(true);
    const box3 = new THREE.Box3().setFromObject(scene);
    const size = box3.getSize(new THREE.Vector3());
    const s = def.length / Math.max(size.x, size.z);
    scene.scale.multiplyScalar(s);
    scene.updateMatrixWorld(true);
    box3.setFromObject(scene);
    const c = box3.getCenter(new THREE.Vector3());
    scene.position.set(-c.x, -box3.min.y, -c.z);
    scene.traverse((o) => { o.frustumCulled = false; });
    model.body.visible = false;
    model.group.add(scene);
  }

  return { buildVehicle, loadManifest, applyGlb };
}
