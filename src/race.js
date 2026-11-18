// Race mode: closed spline circuits with AI rivals, laps, positions, traffic, ramps and drifting.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));

const HALF = 8.5;              // half road width (matches road texture: 17 m)
const WALL = 8.75;             // guard-rail offset
const LANES = [-5.4, -1.8, 1.8, 5.4];
const TOP = 74;                // base top speed m/s (~266 km/h)
const BOOST = 38;
const RAMP_L = 11, RAMP_H = 1.7, RAMP_W = 3.3;

export const TRACKS = [
  {
    id: 'downtown', name: 'Neon Downtown', laps: 2, sub: 'Night · city circuit',
    theme: { fog: 0x1a0d33, top: 0x040210, density: 0.0042 },
    pts: [[0, 0], [0, -420], [40, -560], [180, -640], [380, -640], [500, -560], [520, -420], [420, -300], [420, -170], [560, -60], [580, 120], [460, 240], [240, 250], [90, 180], [20, 100]],
    ramps: [0.12, 0.62],
  },
  {
    id: 'harbor', name: 'Sunset Harbor', laps: 2, sub: 'Dusk · fast sweepers',
    theme: { fog: 0x4a1f3c, top: 0x150a35, density: 0.0036 },
    pts: [[0, 0], [0, -300], [-60, -450], [-220, -520], [-420, -480], [-520, -340], [-480, -180], [-330, -120], [-300, 40], [-420, 170], [-380, 330], [-200, 380], [-60, 300], [0, 160]],
    ramps: [0.08, 0.45, 0.8],
  },
  {
    id: 'skyline', name: 'Skyline Rush', laps: 3, sub: 'Midnight · hairpins',
    theme: { fog: 0x0b1a33, top: 0x01030b, density: 0.0046 },
    pts: [[0, 0], [0, -500], [-30, -650], [-150, -720], [-300, -680], [-340, -540], [-250, -430], [-260, -300], [-400, -220], [-420, -60], [-300, 40], [-130, 10], [-60, 100], [-120, 240], [-60, 360], [60, 330], [40, 160]],
    ramps: [0.1, 0.55],
  },
];
export const REWARDS = [450, 300, 200, 120, 80, 50];
const RIVALS = [
  { name: 'VEGA', color: 0x0a3cff, skill: 1.05 },
  { name: 'KORA', color: 0xe8e8ee, skill: 1.03 },
  { name: 'RAZOR', color: 0xff7a00, skill: 1.01 },
  { name: 'NOVA', color: 0x101014, skill: 0.985 },
  { name: 'BLAZE', color: 0x18c050, skill: 0.96 },
];

// ---------------------------------------------------------------- track geometry
function buildTrack(def) {
  const curve = new THREE.CatmullRomCurve3(def.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
  const L = curve.getLength(), N = Math.round(L / 2), ds = L / N;
  const P = curve.getSpacedPoints(N);
  const px = new Float32Array(N), pz = new Float32Array(N), tx = new Float32Array(N), tz = new Float32Array(N), k = new Float32Array(N);
  for (let i = 0; i < N; i++) { px[i] = P[i].x; pz[i] = P[i].z; }
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N, b = (i + 1) % N;
    const dx = px[b] - px[a], dz = pz[b] - pz[a], l = Math.hypot(dx, dz);
    tx[i] = dx / l; tz[i] = dz / l;
  }
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) { const j = (i + 1) % N; raw[i] = (tz[i] * tx[j] - tx[i] * tz[j]) / ds; }
  for (let i = 0; i < N; i++) { let sum = 0; for (let o = -6; o <= 6; o++) sum += raw[(i + o + N) % N]; k[i] = sum / 13; }
  const tr = { def, curve, L, N, ds, px, pz, tx, tz, k };
  tr.sample = (s, o) => {
    const sm = ((s % L) + L) % L, f = sm / ds, i = Math.floor(f) % N, j = (i + 1) % N, a = f - Math.floor(f);
    o.x = px[i] + (px[j] - px[i]) * a; o.z = pz[i] + (pz[j] - pz[i]) * a;
    let x = tx[i] + (tx[j] - tx[i]) * a, z = tz[i] + (tz[j] - tz[i]) * a; const l = Math.hypot(x, z) || 1; x /= l; z /= l;
    o.tx = x; o.tz = z; o.rx = -z; o.rz = x; o.k = k[i] + (k[j] - k[i]) * a; o.yaw = Math.atan2(-x, -z);
    return o;
  };
  // min distance from a point to the centreline (coarse)
  tr.clearance = (x, z) => { let m = 1e9; for (let i = 0; i < N; i += 2) { const d = (px[i] - x) ** 2 + (pz[i] - z) ** 2; if (d < m) m = d; } return Math.sqrt(m); };
  return tr;
}

function ribbon(tr, o1, y1, o2, y2, period) {
  const { N, ds, px, pz, tx, tz, L } = tr;
  const vs = L / Math.max(1, Math.round(L / period));
  const pos = new Float32Array((N + 1) * 6), uv = new Float32Array((N + 1) * 4), idx = [];
  for (let i = 0; i <= N; i++) {
    const j = i % N, rx = -tz[j], rz = tx[j];
    pos.set([px[j] + rx * o1, y1, pz[j] + rz * o1, px[j] + rx * o2, y2, pz[j] + rz * o2], i * 6);
    uv.set([0, (i * ds) / vs, 1, (i * ds) / vs], i * 4);
    if (i < N) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function textTex(lines, color, w = 512, h = 128, bg = '#07040e') {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.strokeStyle = color; g.lineWidth = 6; g.strokeRect(5, 5, w - 10, h - 10);
  g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `italic 900 ${Math.floor(h * 0.55)}px system-ui, sans-serif`; g.fillText(lines, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function checkerTex() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64; const g = c.getContext('2d');
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#eee'; g.fillRect(x * 16, y * 16, 16, 16); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------------------------------------------------------------- rivals from the player's car model
function buildCarTemplate(model) {
  model.updateMatrixWorld(true);
  const inv = model.matrixWorld.clone().invert();
  const groups = new Map(); let shadow = null; let bodyMat = null;
  const m = new THREE.Matrix4();
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material.blending === THREE.MultiplyBlending) { shadow = o; return; }
    let g = o.geometry.clone(); m.multiplyMatrices(inv, o.matrixWorld); g.applyMatrix4(m);
    if (g.index) g = g.toNonIndexed();
    for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(a)) g.deleteAttribute(a);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    const key = o.material.uuid;
    if (!groups.has(key)) groups.set(key, { mat: o.material, geos: [] });
    groups.get(key).geos.push(g);
    if (o.name === 'body') bodyMat = o.material;
  });
  const parts = [...groups.values()].map(({ mat, geos }) => ({ mat, geo: mergeGeometries(geos), isBody: mat === bodyMat }));
  return { parts, shadow, bodyMat };
}
function makeCarFromTemplate(tpl, color) {
  const g = new THREE.Group();
  let paint = null;
  for (const p of tpl.parts) {
    let mat = p.mat;
    if (p.isBody) { mat = p.mat.clone(); mat.color.setHex(color); paint = mat; }
    g.add(new THREE.Mesh(p.geo, mat));
  }
  if (tpl.shadow) { const s = new THREE.Mesh(tpl.shadow.geometry, tpl.shadow.material); s.rotation.copy(tpl.shadow.rotation); s.position.copy(tpl.shadow.position); s.renderOrder = 2; g.add(s); }
  g.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  return { g, paint };
}

// ---------------------------------------------------------------- main factory
export function createRace(ctx) {
  const { scene, camera, player, sound, haptic, G } = ctx;
  const root = new THREE.Group(); root.visible = false; scene.add(root);
  let world = null; // per-track objects (disposed on track change)
  let tr = null, def = null, trackIdx = 0;
  const S = {}, S2 = {};
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const dummy = new THREE.Object3D();

  // shared materials
  const roadTex = ctx.roadTex.clone(); roadTex.repeat.set(1, 1); roadTex.needsUpdate = true;
  const roadRough = ctx.roadRough ? ctx.roadRough.clone() : null; if (roadRough) { roadRough.repeat.set(1, 1); roadRough.needsUpdate = true; }
  const walkTex = ctx.walkTex.clone(); walkTex.repeat.set(1, 1); walkTex.needsUpdate = true;
  const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughnessMap: roadRough, roughness: 1, metalness: 0.05, envMapIntensity: 1.3 });
  const walkMat = new THREE.MeshStandardMaterial({ map: walkTex, roughness: 0.8 });
  const curbMat = new THREE.MeshStandardMaterial({ color: 0x3a3842, roughness: 0.7, side: THREE.DoubleSide });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x8890a0, metalness: 0.9, roughness: 0.3, side: THREE.DoubleSide });
  const neonL = new THREE.MeshBasicMaterial({ color: ctx.hdr(0xff2e88, 3.5), side: THREE.DoubleSide });
  const neonR = new THREE.MeshBasicMaterial({ color: ctx.hdr(0x22e6ff, 3.5), side: THREE.DoubleSide });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x555a66, metalness: 0.8, roughness: 0.4 });
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x07060b, roughness: 1 });
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x1a1a22, metalness: 0.6, roughness: 0.4 });

  // skyline ring around the camera
  const skyTex = ctx.skylineTex.clone(); skyTex.wrapS = THREE.RepeatWrapping; skyTex.repeat.set(3, 1); skyTex.needsUpdate = true;
  const skyRing = new THREE.Mesh(new THREE.CylinderGeometry(850, 850, 260, 48, 1, true), new THREE.MeshBasicMaterial({ map: skyTex, transparent: true, fog: false, depthWrite: false, side: THREE.BackSide }));
  skyRing.position.y = 115; skyRing.renderOrder = -5; root.add(skyRing);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), groundMat); ground.rotation.x = -Math.PI / 2; ground.position.y = -0.06; root.add(ground);

  // drift smoke (additive soft sprites)
  const SMOKE = 120;
  const smokeMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: ctx.glowTex, color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), SMOKE);
  smokeMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SMOKE * 3), 3);
  smokeMesh.frustumCulled = false; root.add(smokeMesh);
  const smoke = Array.from({ length: SMOKE }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, size: 1 }));
  let smokeIdx = 0, smokeAlive = 0;
  function emitSmoke(x, y, z, n, vx = 0, vz = 0, tint = 0.22) {
    for (let i = 0; i < n; i++) {
      const s = smoke[smokeIdx]; smokeIdx = (smokeIdx + 1) % SMOKE;
      s.p.set(x + rand(-0.3, 0.3), y, z + rand(-0.3, 0.3)); s.v.set(vx + rand(-1.5, 1.5), rand(0.6, 1.8), vz + rand(-1.5, 1.5));
      s.max = s.life = rand(0.7, 1.3); s.size = rand(1.2, 2.2); s.tint = tint;
    }
    smokeAlive = 1.4;
  }
  const col = new THREE.Color();
  function updateSmoke(dt) {
    if (smokeAlive <= 0) return; smokeAlive -= dt;
    for (let i = 0; i < SMOKE; i++) {
      const s = smoke[i];
      if (s.life > 0) {
        s.life -= dt; s.p.addScaledVector(s.v, dt); s.v.multiplyScalar(1 - dt * 1.5);
        const k = Math.max(0, s.life / s.max), sz = s.size * (2.4 - k * 1.4);
        dummy.position.copy(s.p); dummy.quaternion.copy(camera.quaternion); dummy.scale.set(sz, sz, sz);
        col.setScalar(s.tint * k);
      } else { dummy.scale.set(0, 0, 0); col.setScalar(0); }
      dummy.updateMatrix(); smokeMesh.setMatrixAt(i, dummy.matrix); smokeMesh.setColorAt(i, col);
    }
    smokeMesh.instanceMatrix.needsUpdate = true; smokeMesh.instanceColor.needsUpdate = true;
  }

  // rivals (built lazily once the car model is loaded)
  let tpl = null;
  const rivals = [];
  function ensureRivals() {
    if (tpl) return;
    tpl = buildCarTemplate(player.model);
    const flameMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.7, 2.2), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    const fg = new THREE.ConeGeometry(0.11, 1.0, 8, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.5);
    for (const r of RIVALS) {
      const { g, paint } = makeCarFromTemplate(tpl, r.color);
      const fl = new THREE.Mesh(fg, flameMat); fl.position.set(0, 0.42, player.halfL + 0.1); fl.visible = false; g.add(fl);
      const body = new THREE.Group(); body.add(g);
      root.add(body);
      rivals.push({ ...r, obj: body, car: g, paint, flame: fl, isRival: true });
    }
  }

  // civilian traffic
  const civs = [];
  function ensureCivs() {
    if (civs.length) return;
    const kinds = ['sedan', 'sedan', 'sedan', 'suv', 'suv', 'sedan', 'suv', 'truck', 'sedan', 'suv', 'truck', 'sedan'];
    for (const kind of kinds) {
      const c = ctx.makeCivilian(kind);
      c.g.visible = false; root.add(c.g);
      civs.push({ ...c, active: false, s: 0, u: 0, speed: 0, dead: false, passed: false, scraped: false, y: 0, vy: 0, vu: 0, av: new THREE.Vector3() });
    }
  }

  // ---------------------------------------------------------------- build a track world
  function buildWorld(idx) {
    if (world) { root.remove(world.group); world.dispose(); }
    def = TRACKS[idx]; trackIdx = idx; tr = buildTrack(def);
    const group = new THREE.Group(); const disposables = [];
    const add = (o) => { group.add(o); if (o.geometry) disposables.push(o.geometry); return o; };

    add(new THREE.Mesh(ribbon(tr, -HALF, 0, HALF, 0, 12), roadMat));
    for (const side of [-1, 1]) {
      const a = side * HALF, b = side * 14;
      add(new THREE.Mesh(ribbon(tr, Math.min(a, b), 0.2, Math.max(a, b), 0.2, 12), walkMat));
      add(new THREE.Mesh(ribbon(tr, side * 8.55, 0, side * 8.55, 0.2, 12), curbMat));
      add(new THREE.Mesh(ribbon(tr, side * WALL, 0.55, side * WALL, 0.95, 12), railMat));
      add(new THREE.Mesh(ribbon(tr, side * (WALL - 0.07), 0.93, side * (WALL - 0.07), 1.0, 12), side < 0 ? neonL : neonR));
    }
    // rail posts
    const nPosts = Math.floor(tr.L / 3) * 2;
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.9, 0.14).translate(0, 0.45, 0), postMat, nPosts);
    let k = 0;
    for (let s = 0; s < tr.L - 1; s += 3) for (const side of [-1, 1]) {
      tr.sample(s, S); dummy.position.set(S.x + S.rx * side * 8.82, 0, S.z + S.rz * side * 8.82); dummy.rotation.set(0, S.yaw, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); posts.setMatrixAt(k++, dummy.matrix);
    }
    posts.count = k; add(posts);

    // streetlights
    const nl = Math.floor(tr.L / 40) * 2;
    const poleGeo = mergeGeometries([new THREE.CylinderGeometry(0.1, 0.16, 9, 8).translate(0, 4.5, 0), new THREE.BoxGeometry(2.8, 0.14, 0.14).translate(-1.3, 8.9, 0)]);
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x2a2a33, metalness: 0.7, roughness: 0.5 }), nl);
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(1.3, 0.16, 0.5).translate(-2.3, 8.78, 0), new THREE.MeshBasicMaterial({ color: ctx.hdr(0xffc890, 6) }), nl);
    const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(7, 14).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: ctx.glowTex, color: new THREE.Color(0xffa860).multiplyScalar(0.45), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), nl);
    k = 0;
    for (let s = 0; s < tr.L - 20; s += 40) for (const side of [-1, 1]) {
      const ss = s + (side > 0 ? 20 : 0); tr.sample(ss, S);
      dummy.position.set(S.x + S.rx * side * 9.6, 0, S.z + S.rz * side * 9.6); dummy.rotation.set(0, S.yaw + (side > 0 ? 0 : Math.PI), 0); dummy.updateMatrix();
      poles.setMatrixAt(k, dummy.matrix); heads.setMatrixAt(k, dummy.matrix);
      dummy.position.set(S.x + S.rx * side * 6.2, 0.03, S.z + S.rz * side * 6.2); dummy.rotation.set(0, S.yaw, 0); dummy.updateMatrix(); pools.setMatrixAt(k, dummy.matrix);
      k++;
    }
    poles.count = heads.count = pools.count = k; add(poles); add(heads); add(pools);

    // buildings: instanced per (geometry, material)
    const variants = [];
    for (let i = 0; i < 10; i++) variants.push(ctx.buildingGeo(rand(10, 24), Math.random() < 0.3 ? rand(55, 110) : rand(16, 50), rand(12, 22)));
    const buckets = new Map(); const placed = [];
    const neonInst = ctx.NEON_MATS.map(() => []), signInst = ctx.SIGNS.map(() => []);
    const tryPlace = (s, side, dist, tall) => {
      const geo = pick(variants), u = geo.userData; tr.sample(s, S);
      const off = dist + u.dep / 2 + rand(0, 3);
      const x = S.x + S.rx * side * off, z = S.z + S.rz * side * off, rad = 0.5 * Math.hypot(u.w, u.dep);
      if (tr.clearance(x, z) < 14.5 + rad * 0.8) return u.w;
      for (const p of placed) if ((p.x - x) ** 2 + (p.z - z) ** 2 < ((p.r + rad) * 0.72) ** 2) return u.w;
      placed.push({ x, z, r: rad });
      const yaw = S.yaw + (side > 0 ? 0 : Math.PI);
      const sy = tall ? rand(1.2, 1.8) : 1;
      dummy.position.set(x, 0, z); dummy.rotation.set(0, yaw, 0); dummy.scale.set(1, sy, 1); dummy.updateMatrix();
      const mi = Math.floor(Math.random() * ctx.WIN_MATS.length), key = variants.indexOf(geo) * 10 + mi;
      if (!buckets.has(key)) buckets.set(key, { geo, mat: ctx.WIN_MATS[mi], ms: [] });
      buckets.get(key).ms.push(dummy.matrix.clone());
      const bm = dummy.matrix.clone();
      // building local: +x points away from road for side>0 (yaw same as track) -> road face at -x
      if (!tall && Math.random() < 0.38) {
        const ni = Math.floor(Math.random() * ctx.NEON_MATS.length);
        const lm = new THREE.Matrix4().compose(new THREE.Vector3(-u.dep / 2, 0, (Math.random() < 0.5 ? 1 : -1) * u.w / 2), new THREE.Quaternion(), new THREE.Vector3(1, u.h * rand(0.45, 0.95), 1));
        neonInst[ni].push(bm.clone().multiply(lm));
      }
      if (!tall && Math.random() < 0.4 && u.h > 12) {
        const si = Math.floor(Math.random() * ctx.SIGNS.length), sg = ctx.SIGNS[si], sh = 0.75 * sg.len + 0.4;
        const lm = new THREE.Matrix4().compose(new THREE.Vector3(-(u.dep / 2 + 1.1), rand(4 + sh / 2, Math.min(u.h - sh, 16)), u.w / 2 - 1.2), new THREE.Quaternion(), new THREE.Vector3(1.25, sh * 1.25, 1));
        signInst[si].push(bm.clone().multiply(lm));
      }
      return u.w;
    };
    for (const side of [-1, 1]) {
      for (let s = 0; s < tr.L;) s += tryPlace(s, side, 15.2, false) + rand(0.5, 6);
      for (let s = 0; s < tr.L;) s += tryPlace(s, side, 42, true) + rand(4, 16);
    }
    const unitGeo = new THREE.BoxGeometry(0.3, 1, 0.3).translate(0, 0.5, 0);
    for (const b of buckets.values()) { const im = new THREE.InstancedMesh(b.geo, b.mat, b.ms.length); b.ms.forEach((m, i) => im.setMatrixAt(i, m)); im.computeBoundingSphere(); group.add(im); }
    neonInst.forEach((ms, i) => { if (!ms.length) return; const im = new THREE.InstancedMesh(unitGeo, ctx.NEON_MATS[i], ms.length); ms.forEach((m, j) => im.setMatrixAt(j, m)); group.add(im); });
    const signGeo = new THREE.PlaneGeometry(1, 1).rotateY(-Math.PI / 2); // face the road (-x local)
    signInst.forEach((ms, i) => { if (!ms.length) return; const im = new THREE.InstancedMesh(signGeo, ctx.SIGNS[i].mat, ms.length); ms.forEach((m, j) => im.setMatrixAt(j, m)); group.add(im); });
    for (const v of variants) disposables.push(v);

    // start/finish gantry + sponsor arches
    const arch = (s, tex, finish) => {
      tr.sample(s, S);
      const g = new THREE.Group(); g.position.set(S.x, 0, S.z); g.rotation.y = S.yaw;
      for (const side of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.8, 9, 0.8), pillarMat); p.position.set(side * 10.2, 4.5, 0); g.add(p); }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(21.2, 2.2, 0.6), pillarMat); beam.position.y = 9.2; g.add(beam);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(19, 2), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(2, 2, 2) }));
      face.position.set(0, 9.2, 0.31); g.add(face);
      const back = face.clone(); back.rotation.y = Math.PI; back.position.z = -0.31; g.add(back);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(21.2, 0.12, 0.7), finish ? neonR : neonL); strip.position.y = 8.05; g.add(strip);
      if (finish) { const line = new THREE.Mesh(new THREE.PlaneGeometry(17, 1.4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: checkerTex(), color: new THREE.Color(1.2, 1.2, 1.2) })); line.position.y = 0.03; g.add(line); }
      group.add(g); return g;
    };
    arch(0, checkerTex(), true);
    ['NITRO RUSH', 'TURBO', 'MAX SPEED', 'NEON GP'].forEach((t, i) => arch(tr.L * (0.2 + i * 0.2) + 7, textTex(t, pick(['#ff2e88', '#22e6ff', '#ffb040'])), false));

    // ramps
    const topLen = Math.hypot(RAMP_L, RAMP_H), ang = Math.atan2(RAMP_H, RAMP_L);
    const rampTop = new THREE.MeshBasicMaterial({ map: ctx.chevronTex, color: new THREE.Color(1.8, 1.8, 1.8) });
    const sideShape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(RAMP_L, RAMP_H), new THREE.Vector2(RAMP_L, 0)]);
    const sideGeo = new THREE.ExtrudeGeometry(sideShape, { depth: 0.12, bevelEnabled: false }).rotateY(Math.PI / 2);
    const rampSide = new THREE.MeshBasicMaterial({ color: ctx.hdr(0x22e6ff, 2.5) });
    const ramps = [];
    for (const f of def.ramps) {
      const s = tr.L * f, lane = Math.floor(Math.random() * 4), u = LANES[lane];
      tr.sample(s, S);
      const g = new THREE.Group(); g.position.set(S.x + S.rx * u, 0, S.z + S.rz * u); g.rotation.y = S.yaw;
      const top = new THREE.Mesh(new THREE.PlaneGeometry(RAMP_W, topLen), rampTop); top.rotation.x = -Math.PI / 2 + ang; top.position.set(0, RAMP_H / 2, -RAMP_L / 2); g.add(top);
      for (const sd of [-1, 1]) { const m = new THREE.Mesh(sideGeo, rampSide); m.position.x = sd * RAMP_W / 2 - (sd > 0 ? 0 : 0.12); g.add(m); }
      group.add(g); ramps.push({ s, u, lane });
    }

    // minimap path
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let i = 0; i < tr.N; i++) { minx = Math.min(minx, tr.px[i]); maxx = Math.max(maxx, tr.px[i]); minz = Math.min(minz, tr.pz[i]); maxz = Math.max(maxz, tr.pz[i]); }
    const span = Math.max(maxx - minx, maxz - minz), sc = 120 / span;
    const map = { sc, ox: 75 - ((minx + maxx) / 2) * sc, oz: 75 - ((minz + maxz) / 2) * sc };
    const mc = document.createElement('canvas'); mc.width = mc.height = 150; const mg = mc.getContext('2d');
    mg.strokeStyle = 'rgba(0,0,0,0.6)'; mg.lineWidth = 9; mg.lineJoin = 'round';
    const path = () => { mg.beginPath(); for (let i = 0; i <= tr.N; i += 3) { const j = i % tr.N; const x = tr.px[j] * sc + map.ox, y = tr.pz[j] * sc + map.oz; i ? mg.lineTo(x, y) : mg.moveTo(x, y); } mg.closePath(); mg.stroke(); };
    path(); mg.strokeStyle = 'rgba(255,255,255,0.85)'; mg.lineWidth = 4; path();
    tr.sample(0, S); mg.fillStyle = '#ffcc33'; mg.fillRect(S.x * sc + map.ox - 4, S.z * sc + map.oz - 4, 8, 8);
    map.base = mc;

    world = { group, ramps, map, dispose: () => disposables.forEach((d) => d.dispose && d.dispose()) };
    root.add(group);
  }

  // ---------------------------------------------------------------- race state
  const R = { t: 0, finished: false, finishT: 0, results: null, wreckT: 0, camA: 0, endT: 0, civTimer: 0, lastPos: 0, lastLap: 0, invuln: 0 };
  const P = player;
  let racers = [];

  function placeOnGrid() {
    const slots = [[-1.8, -8], [1.8, -14], [-5.4, -22], [5.4, -28], [-1.8, -36], [1.8, -42]];
    // player starts 4th on the grid, like Asphalt
    const order = [rivals[0], rivals[1], rivals[2], null, rivals[3], rivals[4]];
    racers = [];
    order.forEach((r, i) => {
      const [u, s] = slots[i];
      const e = r || P;
      Object.assign(e, { s, u, vu: 0, speed: 0, y: 0, vy: 0, air: false, onRamp: null, boosting: false, wreckT: 0, finishT: 0, lane: LANES.indexOf(u), targetU: u, laneT: rand(2, 5), nitroT: rand(3, 8), boostT: 0, drift: 0 });
      if (r) { r.obj.visible = true; r.obj.rotation.set(0, 0, 0); r.car.rotation.set(0, 0, 0); r.flame.visible = false; }
      racers.push(e);
    });
    P.nitro = 0.4; P.boosting = false; P.roll = 0; P.rolling = false; P.pitch = 0; P.wrecked = false;
  }

  function start(idx) {
    ensureRivals(); ensureCivs();
    if (!world || idx !== trackIdx) buildWorld(idx);
    const th = def.theme;
    ctx.setTheme(th);
    root.visible = true; ctx.setEndlessVisible(false);
    placeOnGrid();
    for (const c of civs) { c.active = false; c.g.visible = false; }
    Object.assign(R, { t: 0, finished: false, finishT: 0, results: null, endT: 0, civTimer: 0, invuln: 0, takedowns: 0, drifts: 0, camA: Math.PI * 0.9, driftAcc: 0, driftOn: 0 });
    P.group.rotation.set(0, 0, 0); P.body.rotation.set(0, 0, 0);
    for (let i = 0; i < 6; i++) spawnCiv(true);
    syncVisuals(0);
    tr.sample(P.s, S);
    camera.position.set(S.x + S.tx * 9 + S.rx * 3, 2.4, S.z + S.tz * 9 + S.rz * 3);
    ctx.raceHud(true, def);
  }
  function exit() {
    root.visible = false; ctx.setEndlessVisible(true); ctx.setTheme(null); ctx.raceHud(false);
    P.wrecked = false; P.group.rotation.set(0, 0, 0); P.body.rotation.set(0, 0, 0);
  }

  function spawnCiv(initial) {
    const c = civs.find((q) => !q.active); if (!c) return;
    const lane = Math.floor(Math.random() * 4), u = LANES[lane] + rand(-0.25, 0.25);
    const s = P.s + (initial ? rand(120, 900) : rand(280, 520));
    if (world.ramps.some((r) => r.lane === lane && Math.abs(((s - r.s) % tr.L + tr.L) % tr.L - tr.L / 2) > tr.L / 2 - 60)) return;
    if (civs.some((q) => q.active && Math.abs(q.s - s) < 30 && Math.abs(q.u - u) < 2.5)) return;
    Object.assign(c, { active: true, dead: false, passed: false, scraped: false, s, u, lane, speed: rand(18, 30) * (c.T.kind === 'truck' ? 0.85 : 1), y: 0, vy: 0, vu: 0, deadT: 0 });
    c.g.visible = true; c.g.rotation.set(0, 0, 0); if (c.streak) c.streak.visible = true;
    if (c.repaint) c.repaint();
  }

  const progress = (e) => (e.finishT ? 1e9 - e.finishT : e.s);
  function position() { let p = 1; for (const e of racers) if (e !== P && progress(e) > progress(P)) p++; return p; }

  // ---------------------------------------------------------------- per-frame
  function rampCheck(e, dt) {
    if (e.air) return;
    let on = null;
    for (const r of world.ramps) {
      if (Math.abs(e.u - r.u) > RAMP_W / 2 + 0.3) continue;
      let rel = ((e.s - r.s) % tr.L + tr.L) % tr.L; if (rel > tr.L / 2) rel -= tr.L;
      const prog = rel / RAMP_L;
      if (prog >= 0 && prog <= 1) { on = r; e.y = prog * RAMP_H; }
      else if (prog > 1 && prog < 1.6 && e.onRamp === r) {
        e.onRamp = null; e.air = true; e.vy = e.speed * (RAMP_H / RAMP_L) * 0.95; e.y = RAMP_H;
        if (e === P) { sound.ramp(); haptic('light'); }
        return;
      }
    }
    if (!on && e.onRamp) { e.onRamp = null; if (e.y > 0.05) { e.air = true; e.vy = 0; } }
    e.onRamp = on;
    if (!on && !e.air) e.y = 0;
  }
  function airStep(e, dt, onLand) {
    if (!e.air) return;
    e.vy -= 24 * dt; e.y += e.vy * dt;
    if (e.y <= 0) { e.y = 0; e.air = false; onLand && onLand(); }
  }

  function updatePlayer(dt) {
    if (P.wrecked) {
      R.wreckT -= dt;
      P.vy -= 22 * dt; P.y += P.vy * dt;
      if (P.y < 0) { P.y = 0; P.vy = Math.abs(P.vy) > 2 ? -P.vy * 0.35 : 0; P.spin.multiplyScalar(0.5); }
      P.speed = Math.max(0, P.speed - 35 * dt); P.s += P.speed * dt;
      P.group.rotation.x += P.spin.x * dt; P.group.rotation.z += P.spin.z * dt; P.wreckYaw += P.spin.y * dt;
      if (R.wreckT <= 0) {
        P.wrecked = false; P.y = 0; P.vy = 0; P.speed = 35; P.u = LANES.reduce((a, b) => (Math.abs(b - P.u) < Math.abs(a - P.u) ? b : a));
        P.group.rotation.set(0, 0, 0); R.invuln = 1.6; ctx.popup('BACK IN THE RACE', 'info');
      }
      return;
    }
    const steer = ctx.readSteer(dt);
    tr.sample(P.s, S);
    const steerSpeed = 16 + P.speed * 0.09;
    P.vu = damp(P.vu, steer * steerSpeed, P.air ? 2 : 9, dt);
    const push = P.air ? 0 : S.k * P.speed * P.speed * 0.085;
    P.u += (P.vu + push) * dt;
    const wall = WALL - P.halfW;
    if (Math.abs(P.u) > wall) {
      const dir = -Math.sign(P.u); P.u = -dir * wall; P.vu = dir * 4; P.speed *= 1 - dt * 1.1;
      worldPos(P.s, P.u - dir * P.halfW, tmp);
      if (Math.random() < 0.7) ctx.emitSparks(tmp.x, 0.4, tmp.z, 3, 0.4, 0);
      G.shake = Math.max(G.shake, 0.15);
      if (!P.wallSound) { sound.scrape(); haptic('light'); P.wallSound = 0.25; }
    }
    if (P.wallSound) P.wallSound = Math.max(0, P.wallSound - dt);

    // nitro & speed
    if (P.boosting) { P.nitro -= dt * 0.22; if (P.nitro <= 0) { P.nitro = 0; P.boosting = false; } }
    else P.nitro = Math.min(1, P.nitro + dt * 0.03);
    const target = TOP + (P.boosting ? BOOST : 0);
    P.speed = P.speed < target ? Math.min(target, P.speed + (P.boosting ? 30 : P.speed < 40 ? 22 : 11) * dt) : Math.max(target, P.speed - 16 * dt);
    P.s += P.speed * dt;
    G.topSpeed = Math.max(G.topSpeed, P.speed);

    // drift (visual slide + nitro reward) when cornering hard
    const lat = Math.abs(S.k) * P.speed * P.speed;
    const drifting = !P.air && lat > 38 && P.speed > 45;
    P.drift = damp(P.drift, drifting ? clamp(S.k * P.speed * 0.55, -0.5, 0.5) : 0, 4, dt);
    if (drifting) {
      R.driftAcc += dt; R.driftOn = 0.25; P.nitro = Math.min(1, P.nitro + dt * 0.1);
      if (Math.random() < 0.6) for (const sx of [-0.8, 0.8]) { worldPos(P.s - P.halfL * 0.8, P.u + sx, tmp); emitSmoke(tmp.x, 0.3, tmp.z, 1, -S.tx * 4, -S.tz * 4); }
    } else if (R.driftOn > 0) {
      R.driftOn -= dt;
      if (R.driftOn <= 0 && R.driftAcc > 0.7) { R.drifts++; ctx.popup('DRIFT', 'near', `${R.driftAcc.toFixed(1)}s`); haptic('light'); }
      if (R.driftOn <= 0) R.driftAcc = 0;
    }

    // ramps / air / barrel roll
    rampCheck(P, dt);
    if (P.air && !P.rolling && Math.abs(steer) > 0.55 && P.y > 0.6) {
      const remain = (P.vy + Math.sqrt(Math.max(0, P.vy * P.vy + 2 * 24 * P.y))) / 24;
      if (remain > 0.45) { P.rolling = true; P.rollDir = Math.sign(steer); P.rollT = 0; P.rollDur = remain * 0.9; }
    }
    if (P.rolling) { P.rollT += dt; const kk = clamp(P.rollT / P.rollDur, 0, 1); P.roll = -P.rollDir * Math.PI * 2 * (kk * kk * (3 - 2 * kk)); }
    airStep(P, dt, () => {
      sound.land(); haptic('medium'); G.shake = Math.max(G.shake, 0.5);
      worldPos(P.s, P.u, tmp); emitSmoke(tmp.x, 0.2, tmp.z, 8, 0, 0, 0.3); ctx.emitSparks(tmp.x, 0.1, tmp.z, 14, 1, 0);
      if (P.rolling) { P.nitro = 1; ctx.popup('BARREL ROLL!', 'roll'); }
      P.rolling = false; P.roll = 0;
    });
    if (R.invuln > 0) R.invuln -= dt;
  }

  function wreckPlayer(byBig) {
    if (P.wrecked || R.invuln > 0) return;
    P.wrecked = true; R.wreckT = 2.0; P.boosting = false;
    P.vy = 8; P.spin.set(rand(-2, 2), rand(-5, 5), rand(4, 8) * (Math.random() < 0.5 ? -1 : 1)); P.wreckYaw = 0;
    worldPos(P.s, P.u, tmp); ctx.emitSparks(tmp.x, 0.6, tmp.z, 60, 1.8, 0); emitSmoke(tmp.x, 0.5, tmp.z, 12, 0, 0, 0.3);
    ctx.slowmo(0.3, 1.0); G.shake = 1.3; G.flash = 0.5;
    sound.crash(); haptic('heavy');
    ctx.popup('WRECKED', 'take');
  }

  function updateRival(r, dt) {
    if (r.finishT && R.finished && r.speed < 1) return;
    if (r.wreckT > 0) {
      r.wreckT -= dt; r.vy -= 22 * dt; r.y += r.vy * dt; if (r.y < 0) { r.y = 0; r.vy = Math.abs(r.vy) > 2 ? -r.vy * 0.3 : 0; }
      r.speed = Math.max(0, r.speed - 30 * dt); r.s += r.speed * dt;
      r.car.rotation.x += r.spin.x * dt; r.car.rotation.z += r.spin.z * dt; r.car.rotation.y += r.spin.y * dt;
      if (r.wreckT <= 0) { r.car.rotation.set(0, 0, 0); r.y = 0; r.speed = 30; r.u = LANES[Math.floor(Math.random() * 4)]; r.targetU = r.u; }
      return;
    }
    tr.sample(r.s, S);
    // lane choice: avoid traffic and ramps ahead
    r.laneT -= dt;
    const blocked = (u) => civs.some((c) => c.active && !c.dead && c.s - r.s > 0 && c.s - r.s < 45 && Math.abs(c.u - u) < 2.6)
      || world.ramps.some((rp) => { let d = ((rp.s - r.s) % tr.L + tr.L) % tr.L; return d < 70 && Math.abs(rp.u - u) < 2.5; });
    if (blocked(r.targetU) || r.laneT <= 0) {
      const opts = LANES.filter((u) => !blocked(u)).sort((a, b) => Math.abs(a - r.u) - Math.abs(b - r.u));
      if (opts.length) r.targetU = r.laneT <= 0 && opts.length > 1 && Math.random() < 0.5 ? opts[1] : opts[0];
      r.laneT = rand(2.5, 6);
    }
    r.vu = damp(r.vu, clamp((r.targetU - r.u) * 2.2, -13, 13), 4, dt);
    r.u = clamp(r.u + r.vu * dt, -WALL + 1.1, WALL - 1.1);
    // speed with rubber-banding
    const gap = r.s - P.s;
    let target = TOP * r.skill * (gap > 140 ? 0.9 : gap < -120 ? 1.1 : 1);
    if (r.finishT) target = 25;
    r.nitroT -= dt;
    if (r.nitroT <= 0 && !r.boosting && !r.finishT) { r.boosting = true; r.boostT = rand(1.8, 3.2); r.nitroT = rand(6, 12); }
    if (r.boosting) { target += BOOST * 0.9; r.boostT -= dt; if (r.boostT <= 0) r.boosting = false; }
    r.speed = r.speed < target ? Math.min(target, r.speed + (r.speed < 40 ? 20 : 10) * dt) : Math.max(target, r.speed - 14 * dt);
    if (!G.racing) r.speed = 0;
    r.s += r.speed * dt;
    r.drift = damp(r.drift || 0, clamp(S.k * r.speed * 0.5, -0.45, 0.45), 4, dt);
  }

  function updateCivs(dt) {
    R.civTimer -= dt;
    if (R.civTimer <= 0) { R.civTimer = rand(0.6, 1.4); if (civs.filter((c) => c.active).length < 10) spawnCiv(false); }
    for (const c of civs) {
      if (!c.active) continue;
      if (c.dead) {
        c.deadT += dt; c.vy -= 24 * dt; c.y += c.vy * dt; c.u += c.vu * dt;
        c.g.rotation.x += c.av.x * dt; c.g.rotation.y += c.av.y * dt; c.g.rotation.z += c.av.z * dt;
        if (c.y < 0) { c.y = 0; c.vy = Math.abs(c.vy) > 3 ? -c.vy * 0.3 : 0; c.av.multiplyScalar(0.55); c.vu *= 0.6; }
        c.speed = Math.max(0, c.speed - 22 * dt);
      }
      c.s += c.speed * dt;
      if (c.s < P.s - 80 || c.s > P.s + 1200 || c.deadT > 4) { c.active = false; c.g.visible = false; }
    }
  }

  function knock(c, dirU, speed) {
    c.dead = true; c.vu = dirU * rand(6, 11); c.vy = rand(7, 11); c.av.set(rand(-4, 4), rand(-3, 3), dirU * rand(4, 8)); c.speed = speed * 0.95; c.deadT = 0;
    if (c.streak) c.streak.visible = false;
  }

  function collisions(dt) {
    if (P.wrecked) return;
    // civilians
    for (const c of civs) {
      if (!c.active || c.dead) continue;
      const rel = c.s - P.s; if (Math.abs(rel) > 12) continue;
      const du = P.u - c.u, sumW = P.halfW + c.T.halfW, sumL = P.halfL + c.T.halfL;
      if (Math.abs(du) < sumW - 0.08 && Math.abs(rel) < sumL - 0.1 && P.y < c.T.height - 0.3) {
        const px = sumW - Math.abs(du), pz = sumL - Math.abs(rel);
        if (P.boosting && c.T.kind !== 'truck') {
          knock(c, du > 0 ? -1 : 1, P.speed); R.takedowns++;
          worldPos(c.s, c.u, tmp); ctx.emitSparks(tmp.x, 0.6, tmp.z, 40, 1.5, 0);
          ctx.popup('TAKEDOWN!', 'take'); ctx.slowmo(0.35, 0.45); G.shake = 0.9; G.flash = 0.3; sound.takedown(); haptic('heavy');
          P.nitro = Math.min(1, P.nitro + 0.25); P.speed *= 0.95;
        } else if (px < pz * 0.55 || px < 0.4) {
          const dir = Math.sign(du) || 1; P.u += dir * (px + 0.05); P.vu = dir * 7;
          if (!c.scraped) { c.scraped = true; P.speed *= 0.9; sound.scrape(); haptic('medium'); }
          worldPos(P.s, P.u - dir * P.halfW, tmp); ctx.emitSparks(tmp.x, 0.5, tmp.z, 10, 0.6, 0);
        } else if (R.invuln <= 0) { knock(c, du > 0 ? -1 : 1, c.speed + 5); wreckPlayer(); return; }
      }
      if (!c.passed && rel < 0) {
        c.passed = true;
        if (!c.scraped && Math.abs(du) < sumW + 1.25 && P.y < 2) { P.nitro = Math.min(1, P.nitro + 0.1); ctx.popup('NEAR MISS', 'near'); sound.whoosh(du > 0 ? -0.8 : 0.8); haptic('light'); }
      }
    }
    // rivals
    for (const r of rivals) {
      if (r.wreckT > 0) continue;
      const rel = r.s - P.s; if (Math.abs(rel) > 10) continue;
      const du = P.u - r.u, sumW = P.halfW * 2, sumL = P.halfL * 2;
      if (Math.abs(du) < sumW - 0.1 && Math.abs(rel) < sumL - 0.15 && Math.abs(P.y - r.y) < 1.2) {
        const px = sumW - Math.abs(du), pz = sumL - Math.abs(rel);
        if (P.boosting && rel > 0 && P.speed > r.speed && pz < px * 1.6) {
          r.wreckT = 2.6; r.vy = rand(6, 9); r.spin = new THREE.Vector3(rand(-2, 2), rand(-4, 4), (du > 0 ? 1 : -1) * rand(4, 7)); r.boosting = false; r.flame.visible = false;
          R.takedowns++; worldPos(r.s, r.u, tmp); ctx.emitSparks(tmp.x, 0.6, tmp.z, 50, 1.6, 0); emitSmoke(tmp.x, 0.6, tmp.z, 10, 0, 0, 0.3);
          ctx.popup(`TAKEDOWN ${r.name}!`, 'take'); ctx.slowmo(0.3, 0.6); G.shake = 1; G.flash = 0.35; sound.takedown(); haptic('heavy');
          P.nitro = Math.min(1, P.nitro + 0.35);
        } else {
          // side or rear bump: push apart
          const dir = Math.sign(du) || 1;
          if (px < pz) { P.u += dir * px * 0.6; r.u -= dir * px * 0.4; P.vu = dir * 6; r.vu = -dir * 6; }
          else if (rel > 0) { P.speed = Math.min(P.speed, r.speed * 0.97); P.s = r.s - sumL + 0.15; }
          else { r.speed = Math.min(r.speed, P.speed * 0.97); r.s = P.s - sumL + 0.15; }
          if (!r.bumpT || R.t - r.bumpT > 0.4) { r.bumpT = R.t; sound.scrape(); haptic('medium'); G.shake = Math.max(G.shake, 0.4); worldPos(P.s, (P.u + r.u) / 2, tmp); ctx.emitSparks(tmp.x, 0.5, tmp.z, 16, 0.8, 0); }
        }
      }
    }
  }

  function worldPos(s, u, out) { tr.sample(s, S2); return out.set(S2.x + S2.rx * u, 0, S2.z + S2.rz * u); }

  function placeCar(obj, e, extraYaw, roll, pitch) {
    tr.sample(e.s, S);
    obj.position.set(S.x + S.rx * e.u, e.y, S.z + S.rz * e.u);
    obj.rotation.set(0, S.yaw + extraYaw, 0);
    return S;
  }

  function syncVisuals(dt) {
    // player
    if (P.wrecked) {
      tr.sample(P.s, S); P.group.position.set(S.x + S.rx * P.u, P.y, S.z + S.rz * P.u);
      P.group.rotation.y = S.yaw + P.wreckYaw;
    } else {
      placeCar(P.group, P, -P.vu * 0.014 + P.drift, 0, 0);
      const targetPitch = P.onRamp ? Math.atan2(RAMP_H, RAMP_L) : P.air ? clamp(P.vy / Math.max(P.speed, 1), -0.25, 0.3) : 0;
      P.pitch = damp(P.pitch, targetPitch, 10, dt);
      P.body.rotation.set(P.pitch, 0, P.roll + P.vu * 0.006 - P.drift * 0.08);
    }
    for (const w of P.wheels) if (w) w.rotation.x -= P.speed * dt / 0.34;
    for (const w of P.frontWheels) if (w) w.rotation.y = -(ctx.input.steer || 0) * 0.35 + P.drift * 0.8;
    const boost = P.boosting && !P.wrecked;
    for (const f of P.flames) { f.visible = boost; if (boost) { const kk = rand(0.8, 1.25); f.scale.set(kk, kk, rand(0.8, 1.5)); } }
    P.tail.visible = P.speed > 8 && !P.wrecked;
    // rivals
    for (const r of rivals) {
      placeCar(r.obj, r, (r.wreckT > 0 ? 0 : -r.vu * 0.012 + r.drift), 0, 0);
      if (r.wreckT <= 0) r.car.rotation.set(0, 0, r.vu * 0.006);
      r.flame.visible = r.boosting && r.wreckT <= 0; if (r.flame.visible) r.flame.scale.set(1, 1, rand(0.8, 1.4));
    }
    // civilians
    for (const c of civs) {
      if (!c.active) continue;
      tr.sample(c.s, S);
      c.g.position.set(S.x + S.rx * c.u, c.y, S.z + S.rz * c.u);
      if (!c.dead) c.g.rotation.set(0, S.yaw, 0);
    }
  }

  const camLook = new THREE.Vector3(), camTarget = new THREE.Vector3();
  function updateCamera(dt, realDt) {
    tr.sample(P.s, S);
    const carX = S.x + S.rx * P.u, carZ = S.z + S.rz * P.u;
    if (G.state === 'countdown' && !R.finished) {
      // cinematic swing from the front of the car to behind it
      const k = clamp(1 - (G.countdown - 0.4) / 3.0, 0, 1), a = Math.PI * (1 - k * k * (3 - 2 * k)) * 0.95;
      const back = 7 + (1 - k) * 2, h = 1.4 + k * 0.9;
      const cx = -Math.sin(a), cz = Math.cos(a); // a=0 -> behind (along -tangent)
      camTarget.set(carX + (-S.tx * cz + S.rx * cx) * back, h, carZ + (-S.tz * cz + S.rz * cx) * back);
      camera.position.lerp(camTarget, 1 - Math.exp(-realDt * 5));
      camera.lookAt(carX, 0.8, carZ);
      camera.fov = damp(camera.fov, 60, 3, realDt);
    } else if (P.wrecked || R.finished) {
      R.camA += realDt * 0.6;
      camTarget.set(P.group.position.x + Math.sin(R.camA) * 9, 3.2, P.group.position.z + Math.cos(R.camA) * 9);
      camera.position.lerp(camTarget, 1 - Math.exp(-realDt * 2.5));
      camera.lookAt(P.group.position.x, Math.max(0.5, P.group.position.y), P.group.position.z);
      camera.fov = damp(camera.fov, 55, 3, realDt);
    } else {
      const bk = P.boosting ? 1 : 0, back = 7.2 + bk * 0.8;
      tr.sample(P.s - back, S2);
      camTarget.set(S2.x + S2.rx * P.u * 0.85, 2.15 + P.y * 0.55 - bk * 0.15, S2.z + S2.rz * P.u * 0.85);
      camera.position.x = damp(camera.position.x, camTarget.x, 9, realDt);
      camera.position.z = damp(camera.position.z, camTarget.z, 9, realDt);
      camera.position.y = damp(camera.position.y, camTarget.y, 6, realDt);
      tr.sample(P.s + 14, S2);
      camLook.set(S2.x + S2.rx * P.u * 0.9, 0.95 + P.y * 0.7, S2.z + S2.rz * P.u * 0.9);
      camera.lookAt(camLook);
      camera.rotateZ(-P.vu * 0.003 - P.drift * 0.05);
      const fov = 64 + clamp((P.speed - 50) / 60, 0, 1) * 8 + bk * 13;
      camera.fov = damp(camera.fov, fov, 4, realDt);
    }
    if (G.shake > 0) { const kk = G.shake * G.shake * 0.28; camera.position.x += rand(-kk, kk); camera.position.y += rand(-kk, kk) * 0.6; G.shake = Math.max(0, G.shake - realDt * 1.8); }
    camera.updateProjectionMatrix();
    ctx.sky.position.copy(camera.position);
    skyRing.position.set(camera.position.x, 115, camera.position.z);
  }

  function finishRace() {
    R.finished = true; P.finishT = R.t; P.boosting = false;
    const pos = position();
    // estimate rival finish times
    const total = def.laps * tr.L;
    for (const r of rivals) if (!r.finishT) r.finishT = R.t + Math.max(0.5, (total - r.s) / Math.max(30, TOP * r.skill));
    R.results = racers.map((e) => ({ name: e === P ? 'YOU' : e.name, t: e.finishT, you: e === P })).sort((a, b) => a.t - b.t);
    ctx.slowmo(0.35, 1.4); sound.beep(true); haptic('heavy');
    ctx.popup(pos === 1 ? '1ST PLACE!' : `FINISHED ${ordinal(pos)}`, pos === 1 ? 'roll' : 'take');
    R.endT = 0; R.finalPos = pos;
  }

  function step(dt, realDt) {
    const wasRacing = G.racing;
    G.racing = G.state === 'playing';
    if (G.racing && !wasRacing && R.t === 0) for (const r of rivals) r.speed = 30 + rand(-3, 3);
    if (G.state === 'playing' || (R.finished && G.state !== 'paused')) {
      R.t += R.finished ? 0 : dt;
      if (!R.finished) { updatePlayer(dt); collisions(dt); }
      else { P.speed = Math.max(0, P.speed - 18 * dt); P.s += P.speed * dt; P.boosting = false; }
      for (const r of rivals) {
        const before = r.s; updateRival(r, dt);
        rampCheck(r, dt); airStep(r, dt);
        if (!r.finishT && r.s >= def.laps * tr.L) r.finishT = R.t;
        if (before < 0 && r.s >= 0) { /* crossed start */ }
      }
      updateCivs(dt);
      if (!R.finished && P.s >= def.laps * tr.L) finishRace();
      if (R.finished) { R.endT += realDt; if (R.endT > 3.2 && G.state === 'playing') ctx.onFinish(R.finalPos, R.t, R.results, R.takedowns, def); }
    } else if (G.state === 'countdown') {
      updateCivs(dt);
    }
    syncVisuals(dt);
    updateSmoke(dt);
    updateCamera(dt, realDt);
  }

  // HUD values
  function hudInfo() {
    const lap = clamp(Math.floor(Math.max(0, P.s) / tr.L) + 1, 1, def.laps);
    return { pos: R.finished ? R.finalPos : position(), total: racers.length, lap, laps: def.laps, t: R.t, map: world.map };
  }
  function drawMap(g) {
    const m = world.map; g.clearRect(0, 0, 150, 150); g.drawImage(m.base, 0, 0);
    for (const e of racers) {
      tr.sample(e.s, S); const x = (S.x + S.rx * e.u) * m.sc + m.ox, y = (S.z + S.rz * e.u) * m.sc + m.oz;
      g.beginPath(); g.arc(x, y, e === P ? 5.5 : 4, 0, Math.PI * 2);
      g.fillStyle = e === P ? '#ffffff' : '#' + new THREE.Color(e.color).getHexString(); g.fill();
      if (e === P) { g.lineWidth = 2; g.strokeStyle = '#ff2e88'; g.stroke(); }
    }
  }

  return { start, exit, step, hudInfo, drawMap, get track() { return tr; }, R };
}

export function ordinal(n) { return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); }
export function fmtTime(t) { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(2).padStart(5, '0')}`; }
