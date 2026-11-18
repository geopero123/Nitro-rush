import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Sound } from './audio.js';
import { loadTraffic, poolModels, buildCar, repaint, setCarEnvironment } from './cars.js';
import { createCity, makeRoadMaterial, makeSidewalkMaterial, makeStreetlightParts, makeBuildingGeometry, getCityResources } from './city.js';
import { createRoadReflection, markReflective, createSmoke, createDebris, createFlameMaterial } from './fx.js';
import { haptic, initNative, exitApp, isNative } from './native.js';
import { createRace, TRACKS, REWARDS, ordinal, fmtTime } from './race.js';

// ---------------------------------------------------------------- helpers
const rand = (a, b) => a + Math.random() * (b - a);
const irand = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
const $ = (id) => document.getElementById(id);
const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);

// ---------------------------------------------------------------- save data
const SAVE_KEY = 'nitroRush.v1';
const save = { best: 0, coins: 0, owned: ['rosso', 'nero'], paint: 'rosso', controls: 'touch', sound: true, music: true, quality: 'high', played: 0 };
try { Object.assign(save, JSON.parse(localStorage.getItem(SAVE_KEY) || '{}')); } catch (e) { /* ignore */ }
if (!Array.isArray(save.owned)) save.owned = ['rosso', 'nero'];
for (const k of ['best', 'coins', 'played']) if (!Number.isFinite(save[k])) save[k] = 0;
const persist = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* ignore */ } };

const PAINTS = [
  { id: 'rosso', name: 'Rosso Corsa', color: 0xa00000, price: 0 },
  { id: 'nero', name: 'Nero Daytona', color: 0x060608, price: 0 },
  { id: 'bianco', name: 'Pearl White', color: 0xe6e6ea, price: 300 },
  { id: 'blu', name: 'Electric Blue', color: 0x0634ff, price: 800 },
  { id: 'lime', name: 'Toxic Lime', color: 0x55ee00, price: 1500 },
  { id: 'viola', name: 'Midnight Purple', color: 0x34085e, price: 2500 },
  { id: 'arancio', name: 'Sunset Orange', color: 0xff4a00, price: 3200 },
  { id: 'oro', name: 'Liquid Gold', color: 0xb88a1e, price: 4500 },
];

// ---------------------------------------------------------------- constants
const LANES = [-5.4, -1.8, 1.8, 5.4];
const ROAD_HALF = 7.2;
const ROAD_W = 17;
const PERIOD = 12;
const VIEW_AHEAD = 440;
const BEHIND = 40;

// ---------------------------------------------------------------- renderer
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const FOG = new THREE.Color(0x1a0d33);
scene.background = FOG;
scene.fog = new THREE.FogExp2(FOG, 0.0058);

const camera = new THREE.PerspectiveCamera(66, 1, 0.1, 1200);
camera.position.set(0, 2.2, 6.5);
scene.add(camera);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.72, 0.42, 0.95);
composer.addPass(bloom);
// Radial speed blur: 6 taps + one extra pair of reads for chromatic aberration (was 24 reads).
// Disabled entirely when idle and on LOW quality; the vignette lives in CSS (#vignette) so toggling is seamless.
const speedPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, strength: { value: 0 }, ca: { value: 0 }, center: { value: new THREE.Vector2(0.5, 0.42) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float strength; uniform float ca; uniform vec2 center; varying vec2 vUv;
    void main(){
      vec2 d = vUv - center; float l = length(d);
      float s = strength * smoothstep(0.12, 0.75, l);
      vec3 c0 = texture2D(tDiffuse, vUv).rgb;
      vec3 c = c0;
      for (int i = 1; i < 6; i++) c += texture2D(tDiffuse, vUv - d * s * (float(i) / 5.0)).rgb;
      c /= 6.0;
      float k = smoothstep(0.2, 0.8, l);
      c.r += (texture2D(tDiffuse, vUv - d * ca).r - c0.r) * k;
      c.b += (texture2D(tDiffuse, vUv + d * ca).b - c0.b) * k;
      gl_FragColor = vec4(c, 1.0);
    }`,
});
speedPass.enabled = false;
composer.addPass(speedPass);
composer.addPass(new OutputPass());
const refl = createRoadReflection(renderer, scene, camera);
const smoke = createSmoke(scene), debris = createDebris(scene);
const flameShader = createFlameMaterial();

function applyQuality() {
  const hi = save.quality === 'high';
  const pr = Math.min(window.devicePixelRatio || 1, hi ? 1.6 : 1.0);
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
  bloom.enabled = hi;
  city.setQuality(hi);
  refl.setEnabled(hi);
  resize();
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.resolution.set(w / 2, h / 2);
  refl.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- textures
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAX_ANISO;
  return t;
}
const glowTex = canvasTex(128, 128, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
const streakTex = canvasTex(64, 256, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  const gx = g.createLinearGradient(0, 0, w, 0);
  gx.addColorStop(0, 'rgba(0,0,0,1)'); gx.addColorStop(0.5, 'rgba(0,0,0,0)'); gx.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out'; g.fillStyle = gx; g.fillRect(0, 0, w, h);
});

const chevronTex = canvasTex(256, 512, (g, w, h) => {
  g.fillStyle = '#120a18'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#ff8a1f'; g.lineWidth = 26; g.lineCap = 'round'; g.lineJoin = 'round';
  for (let i = 0; i < 4; i++) { const y = h - 60 - i * 120; g.beginPath(); g.moveTo(40, y + 60); g.lineTo(w / 2, y); g.lineTo(w - 40, y + 60); g.stroke(); }
  g.fillStyle = '#22e6ff'; g.fillRect(0, 0, 14, h); g.fillRect(w - 14, 0, 14, h);
});

const skylineTex = canvasTex(2048, 256, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  const glow = g.createLinearGradient(0, h, 0, h * 0.3);
  glow.addColorStop(0, 'rgba(255,60,160,0.55)'); glow.addColorStop(1, 'rgba(255,60,160,0)');
  let x = 0;
  while (x < w) {
    const bw = rand(18, 70), bh = rand(30, 220);
    g.fillStyle = '#100820'; g.fillRect(x, h - bh, bw, bh);
    for (let wy = h - bh + 6; wy < h - 4; wy += 7) for (let wx = x + 3; wx < x + bw - 3; wx += 6)
      if (Math.random() < 0.18) { g.fillStyle = Math.random() < 0.5 ? 'rgba(255,200,120,0.8)' : 'rgba(140,220,255,0.7)'; g.fillRect(wx, wy, 2, 2); }
    if (bh > 170 && Math.random() < 0.5) { g.fillStyle = '#ff3355'; g.fillRect(x + bw / 2 - 2, h - bh - 6, 4, 4); }
    x += bw + rand(-6, 4);
  }
  g.globalCompositeOperation = 'destination-over'; g.fillStyle = glow; g.fillRect(0, 0, w, h);
});

// ---------------------------------------------------------------- environment (reflections)
function makeEnvironment() {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ color: 0x0d0820, side: THREE.BackSide })));
  const strip = (color, k, w, h, x, y, z, ry = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: hdr(color, k), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.rotation.y = ry; m.lookAt(0, y, 0); s.add(m);
  };
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2, r = 30;
    strip(pick([0xff2e88, 0x22e6ff, 0xffb060, 0x9a5cff, 0xffffff]), rand(1, 3), rand(2, 6), rand(6, 22), Math.cos(a) * r, rand(2, 14), Math.sin(a) * r);
  }
  const top = new THREE.Mesh(new THREE.PlaneGeometry(60, 3), new THREE.MeshBasicMaterial({ color: hdr(0xfff0dd, 2.5) }));
  top.position.y = 24; top.rotation.x = Math.PI / 2; s.add(top);
  const gnd = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshBasicMaterial({ color: 0x050308 }));
  gnd.rotation.x = -Math.PI / 2; gnd.position.y = -2; s.add(gnd);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0.035).texture;
  pm.dispose();
  return tex;
}
scene.environment = makeEnvironment();
scene.environmentIntensity = 1.0;

// ---------------------------------------------------------------- lights & sky
scene.add(new THREE.HemisphereLight(0x5a4aa0, 0x120818, 0.6));
const moon = new THREE.DirectionalLight(0x9db4ff, 0.6); moon.position.set(-30, 60, -20); scene.add(moon);

const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { fogCol: { value: FOG }, top: { value: new THREE.Color(0x040210) } },
  vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `
    uniform vec3 fogCol; uniform vec3 top; varying vec3 vDir;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec3 d = normalize(vDir); float h = d.y;
      vec3 c = mix(fogCol, top, smoothstep(0.0, 0.5, h));
      c += vec3(0.5, 0.1, 0.35) * exp(-abs(h) * 10.0) * 0.35;
      vec2 st = d.xz / (d.y + 0.25) * 140.0;
      float s = step(0.9965, hash(floor(st))) * smoothstep(0.12, 0.5, h);
      c += s * 0.9;
      gl_FragColor = vec4(c, 1.0);
    }`,
}));
sky.renderOrder = -10;
scene.add(sky); markReflective(sky);

const skyline = new THREE.Mesh(new THREE.PlaneGeometry(2200, 260), new THREE.MeshBasicMaterial({ map: skylineTex, transparent: true, fog: false, depthWrite: false }));
skyline.position.set(0, 110, -640); skyline.renderOrder = -5;
scene.add(skyline);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 1100), new THREE.MeshStandardMaterial({ color: 0x07060b, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.set(0, -0.05, -450);
scene.add(ground);

// shared city-kit materials (also handed to race mode)
const KIT = {
  roadMat: makeRoadMaterial({ lanes: LANES, roadHalf: ROAD_HALF, roadW: ROAD_W, maxAniso: MAX_ANISO }),
  walkMat: makeSidewalkMaterial(MAX_ANISO),
  res: getCityResources(MAX_ANISO),
};
// ---------------------------------------------------------------- scrolling road (period 12m)
const scroller = new THREE.Group();
scene.add(scroller);
const TRACK_LEN = VIEW_AHEAD + BEHIND + PERIOD * 2; // multiple of 12
{
  const roadMat = KIT.roadMat;
  roadMat.map.repeat.set(1, TRACK_LEN / PERIOD); roadMat.roughnessMap.repeat.set(1, TRACK_LEN / PERIOD);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, TRACK_LEN), roadMat);
  road.rotation.x = -Math.PI / 2; road.position.z = BEHIND + PERIOD - TRACK_LEN / 2;
  scroller.add(road);
  refl.patchRoad(road.material);

  const walkMat = KIT.walkMat;
  walkMat.map.repeat.set(1, TRACK_LEN / PERIOD);
  for (const side of [-1, 1]) {
    const walk = new THREE.Mesh(new THREE.PlaneGeometry(6, TRACK_LEN), walkMat);
    walk.rotation.x = -Math.PI / 2; walk.position.set(side * 11.5, 0.2, road.position.z); scroller.add(walk);
    const curb = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, TRACK_LEN), new THREE.MeshStandardMaterial({ color: 0x3a3842, roughness: 0.7 }));
    curb.position.set(side * 8.55, 0.1, road.position.z); scroller.add(curb);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.35, TRACK_LEN), new THREE.MeshStandardMaterial({ color: 0x8890a0, metalness: 0.9, roughness: 0.3 }));
    rail.position.set(side * 8.75, 0.75, road.position.z); scroller.add(rail);
    const neon = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, TRACK_LEN), new THREE.MeshBasicMaterial({ color: side < 0 ? hdr(0xff2e88, 3.5) : hdr(0x22e6ff, 3.5) }));
    neon.position.set(side * 8.68, 0.95, road.position.z); scroller.add(neon); markReflective(neon);
  }
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.9, 0.14), new THREE.MeshStandardMaterial({ color: 0x555a66, metalness: 0.8, roughness: 0.4 }), 2 * Math.ceil(TRACK_LEN / 3));
  const m4 = new THREE.Matrix4(); let k = 0;
  for (let z = BEHIND + PERIOD; z > BEHIND + PERIOD - TRACK_LEN; z -= 3) for (const side of [-1, 1]) { m4.makeTranslation(side * 8.82, 0.45, z); posts.setMatrixAt(k++, m4); }
  posts.count = k; scroller.add(posts);
}

// ---------------------------------------------------------------- streetlights (period 36m)
const LAMP_P = 36;
const lamps = new THREE.Group();
scene.add(lamps);
{
  const { poleGeo, headGeo, poleMat, headMat } = makeStreetlightParts();
  const poolGeo = new THREE.PlaneGeometry(7, 14).rotateX(-Math.PI / 2);
  const n = Math.ceil((VIEW_AHEAD + BEHIND) / LAMP_P) + 2;
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, n * 2);
  const heads = new THREE.InstancedMesh(headGeo, headMat, n * 2);
  const pools = new THREE.InstancedMesh(poolGeo, new THREE.MeshBasicMaterial({ map: glowTex, color: new THREE.Color(0xffa860).multiplyScalar(0.45), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), n * 2);
  const o = new THREE.Object3D(); let k = 0;
  for (let i = -1; i < n - 1; i++) for (const side of [-1, 1]) {
    const z = -i * LAMP_P + (side > 0 ? LAMP_P / 2 : 0);
    o.position.set(side * 9.6, 0, z); o.rotation.set(0, side > 0 ? 0 : Math.PI, 0); o.updateMatrix();
    poles.setMatrixAt(k, o.matrix); heads.setMatrixAt(k, o.matrix);
    o.position.set(side * 6.2, 0.02, z); o.rotation.set(0, 0, 0); o.updateMatrix(); pools.setMatrixAt(k, o.matrix);
    k++;
  }
  lamps.add(poles, heads, pools);
  markReflective(heads);
}

// ---------------------------------------------------------------- city (buildings, billboards, gantries, overpasses, palms)
const city = createCity(scene, { VIEW_AHEAD, BEHIND, maxAniso: MAX_ANISO });
const { buildings, cursor } = city;
city.facadeMat.envMap = scene.environment; city.facadeMat.envMapIntensity = 0.35; // explicit envMap so the intensity applies

// ---------------------------------------------------------------- traffic cars (models in cars.js)
const streakMat = new THREE.MeshBasicMaterial({ map: streakTex, color: new THREE.Color(0.8, 0.05, 0.05), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
const streakGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.03, 0.5);

const traffic = [];
function addTraffic(kind, n) {
  for (const M of poolModels(kind, n)) {
    const T = { kind, halfW: M.halfW, halfL: M.halfL, height: M.height };
    const { g, body } = buildCar(M);
    const st = new THREE.Group(); for (const sx of [-1, 1]) { const m = new THREE.Mesh(streakGeo, streakMat); m.scale.set(0.5, 1, kind === 'truck' ? 4.5 : 3.5); m.position.x = sx * T.halfW * 0.65; st.add(m); } st.position.z = T.halfL; g.add(st);
    g.visible = false; scene.add(g);
    traffic.push({ g, body, T, model: M, lane: 0, baseSpeed: 0, active: false, D: 0, x: 0, speed: 0, dead: false, passed: false, scraped: false, vy: 0, vx: 0, y: 0, av: new THREE.Vector3(), sway: Math.random() * 10 });
  }
}

// a standalone civilian car for race mode (same glTF models as endless traffic)
function makeCivilian(kind) {
  const M = pick(poolModels(kind, 12));
  const T = { kind, halfW: M.halfW, halfL: M.halfL, height: M.height };
  const { g, body } = buildCar(M);
  const streak = new THREE.Group(); for (const sx of [-1, 1]) { const m = new THREE.Mesh(streakGeo, streakMat); m.scale.set(0.5, 1, kind === 'truck' ? 4.5 : 3.5); m.position.x = sx * T.halfW * 0.65; streak.add(m); } streak.position.z = T.halfL; g.add(streak);
  const self = { model: M, body };
  return { g, T, streak, repaint: () => repaint(self) };
}

// ---------------------------------------------------------------- coins / ramps / particles
const coinGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.12, 22).rotateX(Math.PI / 2);
const coinMat = new THREE.MeshStandardMaterial({ color: 0xffc23d, metalness: 1, roughness: 0.25, emissive: 0xffa000, emissiveIntensity: 0.9 });
const coins = [];
for (let i = 0; i < 40; i++) { const m = new THREE.Mesh(coinGeo, coinMat); m.visible = false; scene.add(m); coins.push({ m, active: false, D: 0, x: 0 }); }

const RAMP_L = 11, RAMP_H = 1.7, RAMP_W = 3.3;
const ramps = [];
{
  const topLen = Math.hypot(RAMP_L, RAMP_H), a = Math.atan2(RAMP_H, RAMP_L);
  const topMat = new THREE.MeshBasicMaterial({ map: chevronTex, color: new THREE.Color(1.8, 1.8, 1.8) });
  const sideShape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(RAMP_L, RAMP_H), new THREE.Vector2(RAMP_L, 0)]);
  const sideGeo = new THREE.ExtrudeGeometry(sideShape, { depth: 0.12, bevelEnabled: false }).rotateY(Math.PI / 2);
  const sideMat = new THREE.MeshBasicMaterial({ color: hdr(0x22e6ff, 2.5) });
  for (let i = 0; i < 3; i++) {
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.PlaneGeometry(RAMP_W, topLen), topMat);
    top.rotation.x = -Math.PI / 2 + a; top.position.set(0, RAMP_H / 2, -RAMP_L / 2); g.add(top);
    for (const s of [-1, 1]) { const sd = new THREE.Mesh(sideGeo, sideMat); sd.position.x = s * RAMP_W / 2 - (s > 0 ? 0 : 0.12); g.add(sd); }
    const back = new THREE.Mesh(new THREE.PlaneGeometry(RAMP_W, RAMP_H), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    back.position.set(0, RAMP_H / 2, -RAMP_L); g.add(back);
    g.visible = false; scene.add(g);
    ramps.push({ g, active: false, D: 0, x: 0, lane: 0 });
  }
}

const SPARKS = 260;
const sparkMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.05, 0.4), new THREE.MeshBasicMaterial({ color: hdr(0xffa040, 6), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), SPARKS);
sparkMesh.frustumCulled = false; scene.add(sparkMesh);
const sparks = Array.from({ length: SPARKS }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0 }));
let sparkIdx = 0;
const dummy = new THREE.Object3D();
function emitSparks(x, y, z, n, spread = 1, vz = 0) {
  for (let i = 0; i < n; i++) {
    const s = sparks[sparkIdx]; sparkIdx = (sparkIdx + 1) % SPARKS;
    s.p.set(x, y, z); s.v.set(rand(-6, 6) * spread, rand(1, 7), rand(-4, 8) + vz); s.life = rand(0.3, 0.8);
  }
}
let sparksIdle = false;
function updateSparks(dt) {
  // skip the 260 lookAt/updateMatrix calls when no spark is alive (instances already zero-scaled)
  if (sparksIdle && !sparks.some((s) => s.life > 0)) return;
  sparksIdle = !sparks.some((s) => s.life > 0);
  for (let i = 0; i < SPARKS; i++) {
    const s = sparks[i];
    if (s.life > 0) {
      s.life -= dt; s.v.y -= 18 * dt; s.p.addScaledVector(s.v, dt);
      if (s.p.y < 0.02) { s.p.y = 0.02; s.v.y *= -0.35; s.v.x *= 0.7; }
      dummy.position.copy(s.p); dummy.lookAt(s.p.x + s.v.x, s.p.y + s.v.y, s.p.z + s.v.z);
      const k = Math.max(0, s.life) * 1.6; dummy.scale.set(k, k, k * (1 + s.v.length() * 0.08));
    } else dummy.scale.set(0, 0, 0);
    dummy.updateMatrix(); sparkMesh.setMatrixAt(i, dummy.matrix);
  }
  sparkMesh.instanceMatrix.needsUpdate = true;
}

// speed lines (camera-attached)
const LINES = 44;
const lineMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.018, 0.018, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.6, 0.75), blending: THREE.AdditiveBlending, transparent: true, opacity: 0, depthWrite: false, fog: false }), LINES);
lineMesh.frustumCulled = false; camera.add(lineMesh);
const lines = Array.from({ length: LINES }, () => { const a = Math.random() * Math.PI * 2, r = rand(4.5, 11); return { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.6, z: rand(-90, 0) }; });

// ---------------------------------------------------------------- player car
const player = {
  group: new THREE.Group(), body: new THREE.Group(), model: null, wheels: [], frontWheels: [], bodyMat: null,
  halfW: 0.95, halfL: 2.25, x: 0, vx: 0, y: 0, vy: 0, speed: 0, nitro: 0, boosting: false,
  air: false, roll: 0, rolling: false, rollDir: 0, rollT: 0, rollDur: 1, pitch: 0, onRamp: null,
  flames: [], tail: null, spin: new THREE.Vector3(), wreckRot: new THREE.Euler(),
};
player.group.add(player.body);
scene.add(player.group);
const headlight = new THREE.SpotLight(0xfff2e0, 110, 80, 0.42, 0.55, 1.6);
headlight.position.set(0, 0.8, -1.8); headlight.target.position.set(0, 0, -30);
player.group.add(headlight, headlight.target);
{
  const tail = new THREE.Group();
  const tm = new THREE.MeshBasicMaterial({ map: streakTex, color: new THREE.Color(0.9, 0.05, 0.05), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  for (const x of [-0.62, 0.62]) { const m = new THREE.Mesh(streakGeo, tm); m.scale.set(0.45, 1, 3.2); m.position.x = x; tail.add(m); }
  tail.position.z = 2.2; player.group.add(tail); player.tail = tail;
  const flameMat = flameShader;
  const coreMat = flameShader;
  const fg = new THREE.ConeGeometry(0.11, 1.0, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.7);
  for (const x of [-0.22, 0.22]) {
    const f = new THREE.Mesh(fg, flameMat), c = new THREE.Mesh(fg, coreMat); c.scale.set(0.5, 0.5, 0.55);
    const grp = new THREE.Group(); grp.add(f, c); grp.position.set(x, 0.42, 2.2); grp.visible = false;
    player.group.add(grp); player.flames.push(grp);
  }
}
function setPaint(id) {
  const p = PAINTS.find((q) => q.id === id) || PAINTS[0];
  if (player.bodyMat) player.bodyMat.color.setHex(p.color);
}

async function loadCar(onProgress) {
  const draco = new DRACOLoader(); draco.setDecoderPath('./draco/');
  const loader = new GLTFLoader(); loader.setDRACOLoader(draco);
  const gltf = await loader.loadAsync('./models/ferrari.glb', (e) => { if (e.total) onProgress(e.loaded / e.total); });
  const model = gltf.scene.children[0];
  player.bodyMat = new THREE.MeshPhysicalMaterial({ color: 0xa00000, metalness: 0.9, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.6 });
  const detailsMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 1, roughness: 0.35 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x080810, metalness: 0.3, roughness: 0.02, transparent: true, opacity: 0.7, envMapIntensity: 2 });
  const get = (n) => model.getObjectByName(n);
  get('body').material = player.bodyMat;
  for (const m of [player.bodyMat, detailsMat, glassMat]) m.envMap = scene.environment; // so envMapIntensity applies
  ['rim_fl', 'rim_fr', 'rim_rr', 'rim_rl', 'trim'].forEach((n) => { const o = get(n); if (o) o.material = detailsMat; });
  get('glass').material = glassMat;
  const tl = get('lights_red'); if (tl) tl.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ color: hdr(0xff1010, 6) }); });
  const hl = get('lights'); if (hl) hl.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ color: hdr(0xfff4e8, 4) }); });
  player.wheels = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].map(get);
  player.frontWheels = [player.wheels[0], player.wheels[1]];
  for (const w of player.frontWheels) w.rotation.order = 'YXZ';
  const ao = await new THREE.TextureLoader().loadAsync('./models/ferrari_ao.png');
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.655 * 4, 1.3 * 4), new THREE.MeshBasicMaterial({ map: ao, blending: THREE.MultiplyBlending, toneMapped: false, transparent: true, premultipliedAlpha: true }));
  shadow.rotation.x = -Math.PI / 2; shadow.renderOrder = 2; model.add(shadow);
  model.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  // the glTF model already faces -Z (our forward direction)
  player.body.add(model);
  player.model = model;
  const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
  player.halfW = size.x / 2 * 0.92; player.halfL = size.z / 2 * 0.93;
  const rear = box.max.z; // rear is +z
  for (const f of player.flames) f.position.z = rear - 0.05;
  player.tail.position.z = rear - 0.2;
  setPaint(save.paint);
}

// ---------------------------------------------------------------- game state
const sound = new Sound();
sound.sfxOn = save.sound; sound.musicOn = save.music;

const G = {
  state: 'loading', mode: 'endless', distance: 0, score: 0, coins: 0, near: 0, takedowns: 0, topSpeed: 0,
  combo: 0, comboT: 0, timeScale: 1, slowT: 0, shake: 0, flash: 0, t: 0, nextRowD: 0, nextCoinD: 0, nextRampD: 0,
  countdown: 0, crashT: 0, camAngle: 0, menuSpeed: 26,
};
const input = { left: 0, right: 0, steer: 0, tilt: 0, keys: new Set() };
let cdTimer = 0, hintTimer = 0;

function difficulty() { return clamp(G.distance / 9000, 0, 1); }
function cruiseSpeed() { return 60 + Math.min(24, G.distance / 350); }

function resetWorld() {
  // Buildings store absolute D; shift them (and the recycle cursor) with the distance reset,
  // otherwise after a run / menu idle the whole city sits far ahead and the road is empty.
  const off = G.distance;
  for (const b of buildings) b.D -= off;
  cursor['-1'] -= off; cursor['1'] -= off;
  G.distance = 0; G.score = 0; G.coins = 0; G.near = 0; G.takedowns = 0; G.topSpeed = 0;
  G.combo = 0; G.comboT = 0; G.timeScale = 1; G.slowT = 0; G.shake = 0; G.flash = 0; G.crashT = 0;
  G.nextRowD = 140; G.nextCoinD = 120; G.nextRampD = rand(500, 700);
  Object.assign(player, { x: 0, vx: 0, y: 0, vy: 0, speed: 0, nitro: 0.35, boosting: false, air: false, roll: 0, rolling: false, rollT: 0, pitch: 0, onRamp: null, wallSound: 0 });
  input.steer = 0;
  clearTimeout(cdTimer); cdEl.innerHTML = '';
  clearTimeout(hintTimer); $('hint').classList.remove('show');
  $('popups').innerHTML = '';
  player.group.rotation.set(0, 0, 0); player.body.rotation.set(0, 0, 0); player.group.position.set(0, 0, 0);
  for (const t of traffic) { t.active = false; t.g.visible = false; }
  for (const c of coins) { c.active = false; c.m.visible = false; }
  for (const r of ramps) { r.active = false; r.g.visible = false; }
  for (const s of sparks) s.life = 0;
  smoke.clear(); debris.clear();
}

// ---------------------------------------------------------------- spawning
function freeCar(kind) { const f = traffic.filter((t) => !t.active && t.T.kind === kind); return f[Math.floor(Math.random() * f.length)]; }
const laneBusy = (li, D, range) => traffic.some((t) => t.active && !t.dead && t.lane === li && Math.abs(t.D - D) < range);
function spawnRow(D) {
  const d = difficulty();
  const maxCars = d < 0.15 ? 1 : d < 0.45 ? 2 : 3;
  // never close the last free lane: count lanes already occupied around this D (earlier rows / slow cars)
  const busy = [0, 1, 2, 3].filter((li) => laneBusy(li, D, 26)).length;
  const count = Math.min(irand(1, maxCars), 3 - busy);
  if (count <= 0) return;
  const lanes = [0, 1, 2, 3].filter((li) => !laneBusy(li, D, 26)).sort(() => Math.random() - 0.5).slice(0, count);
  const rowSpeed = rand(19, 31);
  for (const li of lanes) {
    if (ramps.some((r) => r.active && r.lane === li && D > r.D - 160 && D < r.D + 30)) continue;
    const kind = Math.random() < 0.14 + d * 0.08 ? 'truck' : Math.random() < 0.4 ? 'suv' : 'sedan';
    const t = freeCar(kind) || freeCar('sedan');
    if (!t) continue;
    t.active = true; t.dead = false; t.passed = false; t.scraped = false; t.lane = li;
    t.D = D + rand(-4, 4); t.x = LANES[li] + rand(-0.25, 0.25); t.speed = t.baseSpeed = rowSpeed * rand(0.95, 1.05) * (kind === 'truck' ? 0.85 : 1);
    t.y = 0; t.vy = 0; t.vx = 0; t.g.rotation.set(0, 0, 0);
    repaint(t);
    t.g.children[3].visible = true;
    t.g.visible = true;
  }
}
function spawnCoins(base) {
  const li = irand(0, 3);
  for (let i = 0; i < 6; i++) {
    const c = coins.find((q) => !q.active); if (!c) return;
    c.active = true; c.D = base + i * 6; c.x = LANES[li]; c.m.visible = true; c.m.position.set(c.x, 1.0, 0);
  }
}
function spawnRamp(D) {
  const r = ramps.find((q) => !q.active); if (!r) return;
  const free = [0, 1, 2, 3].filter((li) => !traffic.some((t) => t.active && Math.abs(t.x - LANES[li]) < 2 && t.D - G.distance > 120));
  if (!free.length) return;
  r.lane = pick(free); r.x = LANES[r.lane]; r.D = D; r.active = true; r.g.visible = true; r.g.position.x = r.x;
}

// ---------------------------------------------------------------- events
function popup(text, cls, extra = '') {
  const el = document.createElement('div');
  el.className = 'pop ' + cls; el.innerHTML = text + (extra ? `<small>${extra}</small>` : '');
  const box = $('popups'); box.prepend(el);
  while (box.children.length > 3) box.lastChild.remove();
  setTimeout(() => el.remove(), 1150);
}
function addCombo() { G.combo = Math.min(G.combo + 1, 10); G.comboT = 3.2; }
function mult() { return 1 + G.combo * 0.5; }

function nearMiss(t, dx) {
  addCombo(); G.near++;
  const pts = Math.round(150 * mult());
  G.score += pts; player.nitro = Math.min(1, player.nitro + 0.11);
  popup('NEAR MISS', 'near', `+${pts}`);
  sound.whoosh(dx > 0 ? -0.8 : 0.8); haptic('light');
}
function takedown(t, dx) {
  t.dead = true; addCombo(); G.takedowns++;
  const pts = Math.round(500 * mult());
  G.score += pts; player.nitro = Math.min(1, player.nitro + 0.25);
  t.vx = (dx > 0 ? -1 : 1) * rand(6, 11); t.vy = rand(7, 11);
  t.av.set(rand(-4, 4), rand(-3, 3), (dx > 0 ? 1 : -1) * rand(4, 8));
  t.speed = player.speed * 0.95;
  t.g.children[3].visible = false;
  emitSparks(t.x, 0.6, 0, 45, 1.5, 4);
  debris.burst(t.x, 0.7, -(t.D - G.distance), 26, t.body.material && t.body.material.color ? t.body.material.color : new THREE.Color(0.8, 0.8, 0.8), 4); smoke.emit(t.x, 0.5, -(t.D - G.distance), 8, 3);
  popup('TAKEDOWN!', 'take', `+${pts}`);
  slowmo(0.35, 0.5); G.shake = 0.9; G.flash = 0.35;
  sound.takedown(); haptic('heavy');
  player.speed *= 0.93;
}
function scrape(t, dir, px, dt) {
  player.x += dir * (px + 0.05); player.vx = dir * 7;
  // full speed penalty once per car; grinding along it costs a frame-rate independent amount
  if (!t.scraped) { t.scraped = true; player.speed *= 0.88; sound.scrape(); haptic('medium'); G.combo = 0; }
  else player.speed *= 1 - dt * 1.5;
  emitSparks(player.x - dir * player.halfW, 0.5, 0, 14, 0.6, 6); G.shake = Math.max(G.shake, 0.35);
}
function slowmo(scale, time) { G.timeScale = scale; G.slowT = time; }

function wreck(t) {
  if (G.state !== 'playing') return;
  G.state = 'crashing'; G.crashT = 0;
  player.boosting = false;
  player.vy = 8; player.air = true;
  player.spin.set(rand(-2, 2), rand(-5, 5), rand(4, 8) * (Math.random() < 0.5 ? -1 : 1));
  if (t) { t.dead = true; t.vy = 4; t.vx = rand(-3, 3); t.av.set(rand(-2, 2), rand(-2, 2), rand(-2, 2)); t.speed = player.speed * 0.8; t.g.children[3].visible = false; }
  emitSparks(player.x, 0.6, -2, 70, 1.8, -2);
  slowmo(0.3, 1.6); G.shake = 1.4; G.flash = 0.6;
  sound.crash(); haptic('heavy'); setTimeout(() => haptic('heavy'), 120);
  setHud(false);
}

function activateNitro() {
  if (G.state !== 'playing' || player.boosting || player.nitro < 0.2 || player.wrecked) return;
  player.boosting = true; sound.nitro(); haptic('medium'); G.shake = Math.max(G.shake, 0.4);
}

// ---------------------------------------------------------------- update
const tmpV = new THREE.Vector3();
function updateWorld(dt) {
  // road & lamps scroll
  scroller.position.z = G.distance % PERIOD;
  lamps.position.z = G.distance % LAMP_P;
  city.update(G.distance, G.t);
}

function readSteer(dt) {
  let s = input.right - input.left;
  if (input.keys.has('ArrowLeft') || input.keys.has('a')) s -= 1;
  if (input.keys.has('ArrowRight') || input.keys.has('d')) s += 1;
  if (save.controls === 'tilt') s = clamp(s + input.tilt, -1, 1);
  input.steer = damp(input.steer, clamp(s, -1, 1), 14, dt);
  return input.steer;
}
function updatePlaying(dt) {
  const P = player;
  readSteer(dt);

  const steerSpeed = 15 + P.speed * 0.09;
  P.vx = damp(P.vx, input.steer * steerSpeed, P.air ? 2 : 9, dt);
  P.x += P.vx * dt;
  const wall = ROAD_HALF + 0.9 - P.halfW;
  if (Math.abs(P.x) > wall) {
    const dir = -Math.sign(P.x); P.x = -dir * wall; P.vx = dir * 4; P.speed *= 1 - dt * 1.2;
    if (Math.random() < 0.7) emitSparks(P.x - dir * P.halfW, 0.4, rand(-1, 1), 3, 0.4, 5);
    G.shake = Math.max(G.shake, 0.15);
    if (!P.wallSound) { sound.scrape(); haptic('light'); P.wallSound = 0.25; G.combo = 0; }
  }
  if (P.wallSound) P.wallSound = Math.max(0, P.wallSound - dt);

  // speed & nitro
  if (P.boosting) { P.nitro -= dt * 0.24; if (P.nitro <= 0) { P.nitro = 0; P.boosting = false; } }
  else P.nitro = Math.min(1, P.nitro + dt * 0.012);
  const target = cruiseSpeed() + (P.boosting ? 40 : 0);
  P.speed = P.speed < target ? Math.min(target, P.speed + (P.boosting ? 34 : 12) * dt) : Math.max(target, P.speed - 18 * dt);
  G.distance += P.speed * dt;
  G.topSpeed = Math.max(G.topSpeed, P.speed);
  G.score += P.speed * dt * 0.6 * mult();

  // combo decay
  if (G.comboT > 0) { G.comboT -= dt; if (G.comboT <= 0) G.combo = 0; }

  // ramps
  for (const r of ramps) {
    if (!r.active) continue;
    const rel = r.D - G.distance;
    r.g.position.z = -rel;
    if (rel < -BEHIND) { r.active = false; r.g.visible = false; continue; }
    if (!P.air && Math.abs(P.x - r.x) < RAMP_W / 2 + 0.3) {
      const prog = -rel / RAMP_L;
      if (prog >= 0 && prog <= 1) { P.onRamp = r; P.y = prog * RAMP_H; }
      else if (prog > 1 && P.onRamp === r) {
        P.onRamp = null; P.air = true; P.vy = P.speed * (RAMP_H / RAMP_L) * 0.95; P.y = RAMP_H;
        sound.ramp(); haptic('light');
      }
    } else if (P.onRamp === r) { P.onRamp = null; P.air = P.y > 0.05; P.vy = 0; }
  }
  if (!P.onRamp && !P.air && P.y > 0) P.y = 0;
  if (P.air) {
    P.vy -= 24 * dt; P.y += P.vy * dt;
    // barrel roll
    if (!P.rolling && Math.abs(input.steer) > 0.55 && P.y > 0.6) {
      const remain = (P.vy + Math.sqrt(Math.max(0, P.vy * P.vy + 2 * 24 * P.y))) / 24;
      if (remain > 0.45) { P.rolling = true; P.rollDir = Math.sign(input.steer); P.rollT = 0; P.rollDur = remain * 0.9; }
    }
    if (P.rolling) { P.rollT += dt; const k = clamp(P.rollT / P.rollDur, 0, 1); P.roll = -P.rollDir * Math.PI * 2 * (k * k * (3 - 2 * k)); }
    if (P.y <= 0) {
      P.y = 0; P.air = false; sound.land(); haptic('medium'); G.shake = Math.max(G.shake, 0.5);
      emitSparks(P.x, 0.1, 1.5, 18, 1, 6);
      smoke.emit(P.x, 0.25, 1.6, 12, 5);
      if (P.rolling) {
        addCombo(); const pts = Math.round(800 * mult()); G.score += pts; P.nitro = 1;
        popup('BARREL ROLL!', 'roll', `+${pts}`);
      }
      P.rolling = false; P.roll = 0;
    }
  }

  // traffic
  const d = difficulty();
  // spawn at the scheduled absolute D (not distance+330), so catch-up spawns at race start don't stack on one spot
  if (G.distance + 330 > G.nextRowD) { spawnRow(G.nextRowD); G.nextRowD += rand(1, 1.25) * (72 - d * 34); }
  if (G.distance + 330 > G.nextCoinD) { spawnCoins(G.nextCoinD); G.nextCoinD += rand(170, 260); }
  if (G.distance + 330 > G.nextRampD) { spawnRamp(G.nextRampD); G.nextRampD += rand(650, 1000); }
  trafficAI(dt);

  for (const t of traffic) {
    if (!t.active) continue;
    updateTrafficCar(t, dt);
    if (!t.active || t.dead) continue;
    const rel = t.D - G.distance;
    if (Math.abs(rel) > 9) continue;
    const dx = P.x - t.x, sumW = P.halfW + t.T.halfW, sumL = P.halfL + t.T.halfL;
    if (Math.abs(dx) < sumW - 0.08 && Math.abs(rel) < sumL - 0.1 && P.y < t.T.height - 0.3) {
      const px = sumW - Math.abs(dx);
      // swept test: if we already overlapped lengthwise last step, contact came from the side (scrape);
      // otherwise it's a rear-end (wreck) unless it only clipped a corner. Frame-rate independent.
      const prevRel = rel + (P.speed - t.speed) * dt;
      const fromSide = Math.abs(prevRel) < sumL - 0.1 || px < 0.4;
      if (P.boosting && t.T.kind !== 'truck') takedown(t, dx);
      else if (fromSide) scrape(t, Math.sign(dx) || 1, px, dt);
      else wreck(t);
      if (G.state !== 'playing') return;
    }
    if (!t.passed && rel < 0) {
      t.passed = true;
      if (!t.scraped && Math.abs(dx) < sumW + 1.25 && P.y < 2) nearMiss(t, dx);
    }
  }

  // coins
  for (const c of coins) {
    if (!c.active) continue;
    const rel = c.D - G.distance; c.m.position.z = -rel; c.m.rotation.y = G.t * 4 + c.D;
    if (rel < -BEHIND) { c.active = false; c.m.visible = false; continue; }
    if (Math.abs(rel) < 2.4 && Math.abs(P.x - c.x) < 1.7 && P.y < 2.5) {
      c.active = false; c.m.visible = false; G.coins++; G.score += 25; sound.coin();
    }
  }
}

// Car-following (no driving through each other in a lane) + wall breaker (rows with different
// speeds drifting together into a 4-lane block: the rearmost car of the block backs off).
function trafficAI(dt) {
  for (const t of traffic) {
    if (!t.active || t.dead) continue;
    let target = t.baseSpeed, lanes = 1 << t.lane, rearmost = true;
    for (const o of traffic) {
      if (o === t || !o.active || o.dead) continue;
      const gap = o.D - t.D, minGap = t.T.halfL + o.T.halfL;
      if (o.lane === t.lane && gap > 0 && gap < minGap + 8) target = Math.min(target, gap < minGap + 2 ? o.speed - 3 : o.speed);
      if (Math.abs(gap) < minGap + 12) { lanes |= 1 << o.lane; if (gap < 0) rearmost = false; }
    }
    if (lanes === 15 && rearmost && t.D - G.distance > 15) target = Math.min(target, t.baseSpeed - 6);
    t.speed = damp(t.speed, Math.max(8, target), 4, dt);
  }
}

function updateTrafficCar(t, dt) {
  if (t.dead) {
    t.speed = Math.max(0, t.speed - 22 * dt);
    t.vy -= 24 * dt; t.y += t.vy * dt; t.x += t.vx * dt;
    t.g.rotation.x += t.av.x * dt; t.g.rotation.y += t.av.y * dt; t.g.rotation.z += t.av.z * dt;
    if (t.y < 0) { t.y = 0; t.vy = Math.abs(t.vy) > 3 ? -t.vy * 0.3 : 0; t.av.multiplyScalar(0.55); t.vx *= 0.6; if (Math.abs(t.vy) > 1) emitSparks(t.x, 0.2, -(t.D - G.distance), 10); }
  } else {
    t.sway += dt;
    t.x += Math.sin(t.sway * 0.7) * 0.15 * dt;
  }
  t.D += t.speed * dt;
  const rel = t.D - G.distance;
  if (rel < -BEHIND - 10 || rel > 520) { t.active = false; t.g.visible = false; return; }
  t.g.position.set(t.x, t.y, -rel);
}

// camera
const camLook = new THREE.Vector3();
function updateCamera(dt, realDt) {
  const P = player;
  if (G.state === 'playing' || G.state === 'countdown') {
    const boostK = P.boosting ? 1 : 0;
    camera.position.x = damp(camera.position.x, P.x * 0.78, 6, realDt);
    camera.position.y = damp(camera.position.y, 2.05 + P.y * 0.55, 5, realDt);
    camera.position.z = damp(camera.position.z, 6.3 - boostK * 0.9, 3, realDt);
    camLook.set(P.x * 0.92, 0.95 + P.y * 0.7, -12);
    camera.lookAt(camLook);
    camera.rotateZ(-P.vx * 0.0035);
    const fov = 64 + clamp((P.speed - 50) / 60, 0, 1) * 8 + boostK * 13;
    camera.fov = damp(camera.fov, fov, 4, realDt);
  } else if (G.state === 'paused') {
    // keep the gameplay camera frozen (it used to swing into the menu orbit and snap back on resume)
  } else if (G.state === 'crashing' || G.state === 'over') {
    G.camAngle += realDt * 0.5;
    const cx = P.group.position.x, cy = Math.max(0.5, P.group.position.y);
    tmpV.set(cx + Math.sin(G.camAngle) * 9, 3.2, Math.cos(G.camAngle) * 9 + 2);
    camera.position.lerp(tmpV, 1 - Math.exp(-realDt * 2.5));
    camera.lookAt(cx, cy, 0);
    camera.fov = damp(camera.fov, 55, 3, realDt);
  } else {
    // menu / garage orbit
    const garage = G.state === 'garage';
    G.camAngle += realDt * (garage ? 0.22 : 0.12);
    const r = garage ? 6.2 : 7.4, a = G.camAngle;
    const ox = garage ? 1.9 : 0;
    tmpV.set(Math.sin(a) * r + ox, garage ? 1.6 : 2.1, Math.cos(a) * r);
    camera.position.lerp(tmpV, 1 - Math.exp(-realDt * 2));
    camera.lookAt(ox, 0.65, 0);
    camera.fov = damp(camera.fov, garage ? 50 : 55, 3, realDt);
  }
  if (G.shake > 0) {
    const k = G.shake * G.shake * 0.28;
    camera.position.x += rand(-k, k); camera.position.y += rand(-k, k) * 0.6;
    G.shake = Math.max(0, G.shake - realDt * 1.8);
  }
  camera.updateProjectionMatrix();
  sky.position.copy(camera.position);
}

function updatePlayerVisual(dt) {
  const P = player;
  if (G.state === 'crashing' || G.state === 'over') {
    P.vy -= 22 * dt; P.y += P.vy * dt;
    if (P.y < 0) { P.y = 0; P.vy = Math.abs(P.vy) > 2 ? -P.vy * 0.35 : 0; P.spin.multiplyScalar(0.5); if (Math.abs(P.vy) > 1) { emitSparks(P.x, 0.2, 0, 20); sound.land(); } }
    P.speed = Math.max(0, P.speed - 30 * dt); G.distance += P.speed * dt;
    P.x += P.spin.y * dt * 0.6;
    P.group.rotation.x += P.spin.x * dt; P.group.rotation.y += P.spin.y * dt; P.group.rotation.z += P.spin.z * dt;
    P.group.position.set(P.x, P.y, 0);
  } else {
    P.group.position.set(P.x, P.y, 0);
    const yaw = -P.vx * 0.014;
    P.group.rotation.set(0, yaw, 0);
    const targetPitch = P.onRamp ? Math.atan2(RAMP_H, RAMP_L) : P.air ? clamp(P.vy / Math.max(P.speed, 1), -0.25, 0.3) : 0;
    P.pitch = damp(P.pitch, targetPitch, 10, dt);
    P.body.rotation.set(P.pitch, 0, P.roll + P.vx * 0.006);
  }
  for (const w of P.wheels) if (w) w.rotation.x -= P.speed * dt / 0.34;
  for (const w of P.frontWheels) if (w) w.rotation.y = -input.steer * 0.35;
  P.tail.visible = P.speed > 8 && G.state !== 'crashing';
  const boost = P.boosting && G.state === 'playing';
  for (const f of P.flames) { f.visible = boost; if (boost) { const k = rand(0.8, 1.25); f.scale.set(k, k, rand(0.8, 1.5)); } }
}

// ---------------------------------------------------------------- HUD
const hud = {
  score: $('h-score'), mult: $('h-mult'), coins: $('h-coins'), dist: $('h-dist'), speed: $('h-speed'),
  nitro: $('h-nitro'), ring: $('nitro-ring'), btn: $('btn-nitro'), root: $('hud'),
};
function setHud(show) { hud.root.classList.toggle('show', show); }
const hudCache = {};
const setText = (k, el, v) => { if (hudCache[k] !== v) { hudCache[k] = v; el.textContent = v; } };
function updateHud() {
  const P = player;
  setText('score', hud.score, Math.floor(G.score).toLocaleString());
  setText('mult', hud.mult, G.combo > 0 ? `x${mult().toFixed(1)}` : '');
  setText('coins', hud.coins, String(G.coins));
  setText('dist', hud.dist, (G.distance / 1000).toFixed(1) + ' km');
  setText('speed', hud.speed, String(Math.round(P.speed * 3.6)));
  const n = (P.nitro * 100).toFixed(1);
  if (hudCache.nitro !== n) { hudCache.nitro = n; hud.nitro.style.width = n + '%'; hud.ring.style.strokeDashoffset = (276.5 * (1 - P.nitro)).toFixed(1); }
  hud.btn.classList.toggle('ready', P.nitro >= 0.2 && !P.boosting);
  hud.root.classList.toggle('boost', P.boosting);
}

// ---------------------------------------------------------------- screens
const screens = ['loading', 'menu', 'garage', 'settings', 'pause', 'over', 'tracks', 'results'];
function show(name) { for (const s of screens) $(s).classList.toggle('show', s === name); }

function goMenu(reset = true) {
  if (G.mode === 'race') { race.exit(); G.mode = 'endless'; reset = true; }
  G.state = 'menu'; if (reset) resetWorld(); player.speed = G.menuSpeed;
  setHud(false); show('menu');
  $('m-best').textContent = save.best.toLocaleString(); $('m-coins').textContent = save.coins.toLocaleString();
}
function startRace() {
  if (G.state !== 'menu' && G.state !== 'over') return;
  sound.init(); sound.click();
  resetWorld(); G.state = 'countdown'; G.countdown = 3.4; G.lastCd = 4;
  player.speed = 0; show(null); setHud(true);
  camera.position.set(0, 3.2, 9);
  const hint = $('hint'); if (save.played < 3) { hint.classList.add('show'); hintTimer = setTimeout(() => hint.classList.remove('show'), 5000); }
  save.played++; persist();
}
function gameOver() {
  G.state = 'over';
  const score = Math.floor(G.score), bonus = Math.floor(score / 1000);
  const earned = G.coins + bonus;
  const isBest = score > save.best;
  if (isBest) save.best = score;
  save.coins += earned; persist();
  $('o-score').textContent = score.toLocaleString();
  $('o-best').textContent = isBest ? '★ NEW BEST ★' : `BEST ${save.best.toLocaleString()}`;
  $('o-dist').textContent = (G.distance / 1000).toFixed(2) + ' km';
  $('o-top').textContent = Math.round(G.topSpeed * 3.6) + ' km/h';
  $('o-near').textContent = G.near; $('o-take').textContent = G.takedowns;
  $('o-coins').textContent = `+${earned}`;
  show('over');
}
function pauseGame() {
  if (G.state !== 'playing' && G.state !== 'countdown') return;
  G.prevState = G.state; G.state = 'paused'; show('pause'); sound.engine(0, false, false); sound.suspend();
  releaseInput();
}
function resumeGame() { if (G.state !== 'paused') return; sound.resume(); G.state = G.prevState; show(null); }

// garage
let gSel = save.paint;
function renderGarage() {
  const box = $('swatches'); box.innerHTML = '';
  for (const p of PAINTS) {
    const el = document.createElement('div');
    el.className = 'sw' + (p.id === gSel ? ' sel' : '');
    const c = new THREE.Color(p.color);
    el.style.background = `radial-gradient(circle at 35% 30%, #fff8, #${c.getHexString()} 45%, #000 120%)`;
    if (!save.owned.includes(p.id)) el.innerHTML = `<span class="lock">${p.price}</span>`;
    el.onclick = () => { gSel = p.id; setPaint(p.id); sound.click(); renderGarage(); };
    box.appendChild(el);
  }
  const p = PAINTS.find((q) => q.id === gSel);
  $('paint-name').textContent = p.name;
  const owned = save.owned.includes(p.id), btn = $('btn-buy');
  btn.classList.remove('disabled');
  if (owned) btn.textContent = save.paint === p.id ? 'EQUIPPED' : 'EQUIP';
  else { btn.textContent = `BUY ${p.price}`; if (save.coins < p.price) btn.classList.add('disabled'); }
  $('g-coins').textContent = save.coins.toLocaleString();
}
function openGarage() { if (G.state !== 'menu') return; sound.init(); sound.click(); G.state = 'garage'; gSel = save.paint; player.speed = 0; renderGarage(); show('garage'); }
function closeGarage() { if (G.state !== 'garage') return; setPaint(save.paint); goMenu(false); }
$('btn-buy').onclick = () => {
  const p = PAINTS.find((q) => q.id === gSel);
  if (save.owned.includes(p.id)) { save.paint = p.id; sound.click(); }
  else if (save.coins >= p.price) { save.coins -= p.price; save.owned.push(p.id); save.paint = p.id; sound.coin(); haptic('medium'); }
  persist(); renderGarage();
};

// settings
function renderSettings() {
  $('opt-controls').textContent = save.controls === 'tilt' ? 'TILT' : 'TOUCH';
  $('opt-sound').textContent = save.sound ? 'ON' : 'OFF';
  $('opt-music').textContent = save.music ? 'ON' : 'OFF';
  $('opt-quality').textContent = save.quality === 'high' ? 'HIGH' : 'LOW';
}
$('opt-controls').onclick = () => { save.controls = save.controls === 'tilt' ? 'touch' : 'tilt'; persist(); renderSettings(); sound.click(); };
$('opt-sound').onclick = () => { save.sound = !save.sound; sound.setSfx(save.sound); persist(); renderSettings(); sound.click(); };
$('opt-music').onclick = () => { save.music = !save.music; sound.setMusic(save.music); persist(); renderSettings(); sound.click(); };
$('opt-quality').onclick = () => { save.quality = save.quality === 'high' ? 'low' : 'high'; applyQuality(); persist(); renderSettings(); sound.click(); };

$('btn-play').onclick = startRace;
$('btn-retry').onclick = startRace;
$('btn-menu').onclick = () => { if (G.state !== 'over') return; sound.click(); goMenu(); };
$('btn-garage').onclick = openGarage;
$('btn-garage-back').onclick = () => { sound.click(); closeGarage(); };
$('btn-settings').onclick = () => { sound.init(); sound.click(); renderSettings(); show('settings'); };
$('btn-settings-back').onclick = () => { sound.click(); show('menu'); };
$('btn-pause').onclick = (e) => { e.stopPropagation(); pauseGame(); };
$('btn-resume').onclick = () => { sound.click(); resumeGame(); };
$('btn-quit').onclick = () => { if (G.state !== 'paused') return; sound.resume(); sound.click(); goMenu(); };

// ---------------------------------------------------------------- input
const touches = new Map();
function releaseInput() { touches.clear(); input.left = input.right = 0; input.keys.clear(); mouseDown = false; }
window.addEventListener('blur', releaseInput);
function isUi(el) { return el && el.closest && el.closest('button, .panel, .screen.show'); }
function recountTouches() {
  let l = 0, r = 0;
  for (const t of touches.values()) if (!t.ui) { if (t.x < window.innerWidth / 2) l = 1; else r = 1; }
  input.left = l; input.right = r;
}
window.addEventListener('touchstart', (e) => {
  if (G.state !== 'paused') sound.init(); // don't un-suspend audio under the pause menu
  for (const t of e.changedTouches) touches.set(t.identifier, { x: t.clientX, y0: t.clientY, t0: performance.now(), ui: !!isUi(t.target), swiped: false });
  recountTouches();
}, { passive: true });
window.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) {
    const s = touches.get(t.identifier); if (!s) continue;
    s.x = t.clientX;
    if (!s.ui && !s.swiped && s.y0 - t.clientY > 45 && performance.now() - s.t0 < 500) { s.swiped = true; activateNitro(); }
  }
  recountTouches();
}, { passive: true });
const endTouch = (e) => { for (const t of e.changedTouches) touches.delete(t.identifier); recountTouches(); };
window.addEventListener('touchend', endTouch, { passive: true });
for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) window.addEventListener(ev, () => { if (G.state !== 'paused') sound.init(); }, { passive: true, capture: true });
window.addEventListener('touchcancel', endTouch, { passive: true });
let mouseDown = false;
const nitroBtn = $('btn-nitro');
nitroBtn.addEventListener('touchstart', (e) => { e.preventDefault(); activateNitro(); }, { passive: false });
nitroBtn.addEventListener('mousedown', activateNitro);
// mouse fallback (desktop testing)
canvas.addEventListener('mousedown', (e) => { mouseDown = true; input.left = e.clientX < window.innerWidth / 2 ? 1 : 0; input.right = 1 - input.left; });
window.addEventListener('mouseup', () => { if (mouseDown) { mouseDown = false; input.left = input.right = 0; } });
window.addEventListener('keydown', (e) => {
  input.keys.add(e.key);
  if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w') activateNitro();
  if (e.key === 'p' || e.key === 'Escape') G.state === 'paused' ? resumeGame() : pauseGame();
});
window.addEventListener('keyup', (e) => input.keys.delete(e.key));
// tilt
window.addEventListener('devicemotion', (e) => {
  const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
  const ang = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * Math.PI / 180;
  // gravity in screen coords (x right, y up) for the current rotation; works for both landscape angles (90/270)
  const sx = a.x * Math.cos(ang) - a.y * Math.sin(ang);
  const sy = a.x * Math.sin(ang) + a.y * Math.cos(ang);
  // roll angle of the screen like a steering wheel; atan2 keeps sensitivity constant whether the phone
  // is held upright or tipped back toward flat (the old sx/4.2 needed > 90 deg of roll when held flat-ish)
  const roll = Math.atan2(-sx, Math.max(sy, 2.5));
  const v = roll / 0.42; // ~24 deg = full lock
  input.tilt = Math.abs(v) < 0.08 ? 0 : clamp((v - Math.sign(v) * 0.08) / 0.92, -1, 1);
});

document.addEventListener('visibilitychange', () => { if (document.hidden) { pauseGame(); sound.suspend(); } else if (G.state !== 'paused') sound.resume(); });
initNative({
  onBack: () => {
    if (G.state === 'playing' || G.state === 'countdown') pauseGame();
    else if (G.state === 'paused') resumeGame();
    else if (G.state === 'crashing') { /* ignore; used to exit the app mid-crash */ }
    else if (G.state === 'garage') closeGarage();
    else if ($('settings').classList.contains('show')) show('menu');
    else if (G.state === 'over' || G.state === 'results' || G.state === 'tracks') goMenu(G.state !== 'tracks');
    else exitApp();
  },
  onPause: () => { pauseGame(); sound.suspend(); },
  onResume: () => { if (G.state !== 'paused') sound.resume(); },
});

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock(); clock.getDelta();
const flashEl = $('flash');
const cdEl = $('countdown');
const SIM = Number(new URLSearchParams(location.search).get('sim') || 1);
function frame() {
  const d0 = Math.min(clock.getDelta(), 0.05);
  for (let i = 0; i < SIM; i++) step(SIM > 1 ? 1 / 30 : d0);
  refl.render(G.mode !== 'race');
  composer.render();
  requestAnimationFrame(frame);
}
function step(realDt) {
  if (G.slowT > 0 && G.state !== 'paused') { G.slowT -= realDt; if (G.slowT <= 0) G.timeScale = 1; }
  const dt = realDt * (G.state === 'paused' ? 0 : G.timeScale);
  G.t += dt;

  if (G.state === 'menu') { player.speed = G.menuSpeed; G.distance += player.speed * dt; }
  else if (G.state === 'garage') { player.speed = damp(player.speed, 0, 3, dt); G.distance += player.speed * dt; }
  else if (G.state === 'countdown') {
    G.countdown -= dt;
    const n = Math.ceil(G.countdown - 0.4);
    if (n !== G.lastCd) {
      G.lastCd = n;
      cdEl.innerHTML = n > 0 ? `<span class="n">${n}</span>` : '<span class="n">GO!</span>';
      sound.beep(n <= 0); if (n <= 0) haptic('medium');
    }
    if (G.countdown <= 0) { G.state = 'playing'; clearTimeout(cdTimer); cdTimer = setTimeout(() => (cdEl.innerHTML = ''), 700); player.speed = 30; }
  } else if (G.state === 'playing') { if (G.mode !== 'race') updatePlaying(dt); }
  else if (G.state === 'crashing') {
    G.crashT += realDt;
    for (const t of traffic) if (t.active) updateTrafficCar(t, dt);
    if (G.crashT > 2.3) gameOver();
  }

  if (G.mode === 'race') {
    if (G.state !== 'paused') { race.step(dt, realDt); updateSparks(dt); }
  } else if (G.state !== 'paused') {
    updateWorld(dt);
    if (G.state !== 'playing' && G.state !== 'crashing') for (const t of traffic) if (t.active) updateTrafficCar(t, dt);
    updatePlayerVisual(dt);
    updateSparks(dt);
    smoke.update(dt, camera); debris.update(dt);
    flameShader.uniforms.time.value = G.t;
  }
  if (G.mode !== 'race') updateCamera(dt, realDt);

  // speed lines & post fx
  const P = player;
  const playing = G.state === 'playing';
  const fxDt = G.state === 'paused' ? 0 : realDt; // freeze speed lines / blur under the pause menu
  const lineK = playing ? clamp((P.speed - 60) / 50, 0, 1) * 0.12 + (P.boosting ? 0.22 : 0) : 0;
  if (fxDt) lineMesh.material.opacity = damp(lineMesh.material.opacity, lineK, 6, fxDt);
  if (lineMesh.material.opacity > 0.01) {
    for (let i = 0; i < LINES; i++) {
      const l = lines[i]; l.z += P.speed * 1.6 * dt;
      if (l.z > 4) { l.z = rand(-100, -60); const a = Math.random() * Math.PI * 2, r = rand(4.5, 11); l.x = Math.cos(a) * r; l.y = Math.sin(a) * r * 0.6; }
      dummy.position.set(l.x, l.y, l.z); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 0.5 + P.speed / 60); dummy.updateMatrix(); lineMesh.setMatrixAt(i, dummy.matrix);
    }
    lineMesh.instanceMatrix.needsUpdate = true;
  }
  const blurT = playing ? clamp((P.speed - 60) / 50, 0, 1) * 0.04 + (P.boosting ? 0.07 : 0) : G.state === 'crashing' ? 0.04 : 0;
  speedPass.uniforms.strength.value = damp(speedPass.uniforms.strength.value, blurT, 5, fxDt);
  speedPass.uniforms.ca.value = speedPass.uniforms.strength.value * 0.06;
  speedPass.enabled = save.quality === 'high' && speedPass.uniforms.strength.value > 0.003;
  if (G.flash > 0) { G.flash = Math.max(0, G.flash - realDt * 1.5); }
  const fo = (G.flash * 0.35).toFixed(3);
  if (fo !== flashEl._o) flashEl.style.opacity = flashEl._o = fo; // avoid per-frame style writes

  sound.engine(P.speed, P.boosting, (playing || G.state === 'countdown' || G.state === 'menu') && G.state !== 'paused' && !!sound.ctx);
  if (playing || G.state === 'countdown') updateHud();
  if (G.mode === 'race' && (playing || G.state === 'countdown')) updateRaceHud();
}

// ---------------------------------------------------------------- race mode glue
let race = null;
const raceEls = { pos: $('rh-pos'), tot: $('rh-tot'), lap: $('rh-lap'), time: $('rh-time'), map: $('rh-map').getContext('2d') };
let raceHudFrame = 0, raceTrack = 0;
function updateRaceHud() {
  const h = race.hudInfo();
  const pos = String(h.pos), lap = `LAP ${h.lap}/${h.laps}`, tm = fmtTime(h.t);
  if (raceEls.pos._v !== pos) raceEls.pos.textContent = raceEls.pos._v = pos;
  if (raceEls.lap._v !== lap) { if (raceEls.lap._v && h.lap > 1 && h.lap === h.laps) popup('FINAL LAP', 'info'); raceEls.lap.textContent = raceEls.lap._v = lap; }
  if (raceEls.time._v !== tm) raceEls.time.textContent = raceEls.time._v = tm;
  if ((raceHudFrame++ & 1) === 0) race.drawMap(raceEls.map);
}
function setEndlessVisible(v) {
  scroller.visible = lamps.visible = skyline.visible = ground.visible = v;
  for (const b of buildings) b.mesh.visible = v;
  city.setVisible(v);
  if (!v) { for (const t of traffic) t.g.visible = false; for (const c of coins) c.m.visible = false; for (const r of ramps) r.g.visible = false; }
}
const DEFAULT_THEME = { fog: 0x1a0d33, top: 0x040210, density: 0.0058 };
function setTheme(th) {
  th = th || DEFAULT_THEME;
  FOG.set(th.fog); scene.fog.color.set(th.fog); scene.fog.density = th.density;
  sky.material.uniforms.top.value.set(th.top);
}
function raceHud(on, def) {
  hud.root.classList.toggle('race', !!on);
  if (on) { raceEls.tot.textContent = '/6'; raceEls.pos._v = raceEls.lap._v = raceEls.time._v = null; }
}
function trackPreview(def, size) {
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  const curve = new THREE.CatmullRomCurve3(def.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
  const pts = curve.getSpacedPoints(200);
  let a = 1e9, b = -1e9, cc = 1e9, d = -1e9; for (const p of pts) { a = Math.min(a, p.x); b = Math.max(b, p.x); cc = Math.min(cc, p.z); d = Math.max(d, p.z); }
  const sc = (size * 0.8) / Math.max(b - a, d - cc), ox = size / 2 - ((a + b) / 2) * sc, oz = size / 2 - ((cc + d) / 2) * sc;
  g.lineJoin = 'round';
  for (const [w, col] of [[10, 'rgba(255,46,136,0.35)'], [4, '#fff']]) { g.lineWidth = w; g.strokeStyle = col; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x * sc + ox, p.z * sc + oz) : g.moveTo(p.x * sc + ox, p.z * sc + oz))); g.closePath(); g.stroke(); }
  g.fillStyle = '#ffcc33'; g.fillRect(pts[0].x * sc + ox - 5, pts[0].z * sc + oz - 5, 10, 10);
  return { c, len: curve.getLength() };
}
function openTracks() {
  if (G.state !== 'menu' && G.state !== 'results') return;
  sound.init(); sound.click();
  if (G.mode === 'race') goMenu();
  G.state = 'tracks';
  const box = $('track-cards'); box.innerHTML = '';
  TRACKS.forEach((def, i) => {
    const el = document.createElement('div'); el.className = 'tcard';
    const { c, len } = trackPreview(def, 220);
    const best = save.trackBest && save.trackBest[def.id];
    el.append(c);
    el.insertAdjacentHTML('beforeend', `<b>${def.name}</b><small>${def.sub}</small><small>${(len / 1000).toFixed(1)} km · ${def.laps} laps</small><small class="best">${best ? 'BEST ' + fmtTime(best) : '1st: +' + REWARDS[0] + ' coins'}</small>`);
    el.onclick = () => startRaceMode(i);
    box.append(el);
  });
  show('tracks');
}
function startRaceMode(idx) {
  if (G.state !== 'tracks' && G.state !== 'results') return;
  sound.init(); sound.click();
  if (G.mode === 'race') race.exit();
  resetWorld(); G.mode = 'race'; raceTrack = idx;
  show(null); setHud(true);
  race.start(idx);
  G.state = 'countdown'; G.countdown = 3.4; G.lastCd = 4; player.speed = 0; G.topSpeed = 0;
  save.played++; persist();
}
function raceFinished(pos, time, results, takedowns, def) {
  G.state = 'results';
  setHud(false);
  const reward = REWARDS[pos - 1] + takedowns * 20;
  save.coins += reward;
  save.trackBest = save.trackBest || {};
  const prev = save.trackBest[def.id], isBest = pos === 1 && (!prev || time < prev);
  if (isBest || (!prev && pos === 1)) save.trackBest[def.id] = time;
  persist();
  const t = $('r-title'); t.textContent = pos === 1 ? '1ST PLACE!' : `${ordinal(pos).toUpperCase()} PLACE`; t.classList.toggle('win', pos === 1);
  $('r-time').textContent = `${def.name} · ${fmtTime(time)}${isBest ? ' · ★ NEW RECORD' : ''}`;
  $('r-list').innerHTML = results.map((r, i) => `<span>${i + 1}</span><span class="${r.you ? 'you' : ''}">${r.name}</span><span class="${r.you ? 'you' : ''}">${fmtTime(r.t)}</span>`).join('');
  $('r-reward').innerHTML = `<i class="coin"></i> +${reward} coins${takedowns ? ` (incl. ${takedowns} takedown${takedowns > 1 ? 's' : ''})` : ''}`;
  show('results');
}
$('btn-race').onclick = openTracks;
$('btn-tracks-back').onclick = () => { sound.click(); goMenu(false); };
$('btn-r-next').onclick = () => startRaceMode((raceTrack + 1) % TRACKS.length);
$('btn-r-retry').onclick = () => startRaceMode(raceTrack);
$('btn-r-menu').onclick = () => { if (G.state === 'results') { sound.click(); goMenu(); } };

// ---------------------------------------------------------------- boot
(async function boot() {
  applyQuality();
  try {
    await loadCar((p) => { $('loadbar').style.width = (p * 80).toFixed(0) + '%'; });
    await loadTraffic(); setCarEnvironment(scene.environment);
    addTraffic('sedan', 18); addTraffic('suv', 10); addTraffic('truck', 6);
  } catch (e) {
    console.error(e); $('loadtext').textContent = 'Failed to load car: ' + e.message; return;
  }
  $('loadbar').style.width = '100%';
  race = createRace({
    scene, camera, sky, player, sound, haptic, G, input, popup, emitSparks, readSteer, hdr,
    slowmo, setEndlessVisible, setTheme, raceHud, onFinish: raceFinished, makeCivilian,
    roadTex: KIT.roadMat.map, roadRough: KIT.roadMat.roughnessMap, walkTex: KIT.walkMat.map, glowTex, chevronTex, skylineTex,
    buildingGeo: (w, h, dep) => makeBuildingGeometry({ w, h, dep }), WIN_MATS: [city.facadeMat], NEON_MATS: KIT.res.NEON_MATS, SIGNS: KIT.res.SIGNS,
  });
  renderer.compile(scene, camera);
  goMenu();
  clock.getDelta();
  requestAnimationFrame(frame);
  window.__G = G; window.__player = player; window.__race = race; window.__traffic = traffic;
  window.__dbg = { traffic, buildings, coins, ramps, cursor, camera, input, city };
})();
