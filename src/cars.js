// Traffic & rival car visuals: real glTF models (Kenney Car Kit CC0 + simplified Ferrari 458 / Khronos CarConcept CC BY 4.0)
// baked offline into public/models/traffic.glb (see tools/build-traffic.mjs). Each car = 5 slot meshes sharing materials:
// paint (recolourable), glass, misc (vertex colours), tail (emissive), head (emissive).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------------------------------------------------------------- materials (shared by every car)
const paint = (c, metal = 0.55, rough = 0.32) => new THREE.MeshStandardMaterial({ color: c, metalness: metal, roughness: rough, envMapIntensity: 1.5 });
export const CIVIL_PAINTS = [0x24262c, 0xb8bcc4, 0x14244e, 0xd9d9dc, 0x5a0d14, 0x0a0a0c, 0x2e3a2c, 0x6b6f78, 0x3b2a1e, 0x8a1010, 0x1c4e8a, 0xe8e2d0].map((c) => paint(c));
export const SPORT_PAINTS = [0xc00000, 0x0434e0, 0xf2c200, 0x0a0a0c, 0xf0f0f2, 0xff5a00, 0x3ad000, 0x7a12c8, 0x00a8c0].map((c) => paint(c, 0.7, 0.24));
export const TRUCK_PAINTS = [0xc8ccd2, 0x2a4b8a, 0x8a1d1d, 0x2c6a3a, 0xd0a020, 0xe8e8ea].map((c) => paint(c, 0.25, 0.5));
const glassMat = new THREE.MeshStandardMaterial({ color: 0x06070b, metalness: 0.6, roughness: 0.06, envMapIntensity: 1.8 });
const miscMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.5, envMapIntensity: 1.1 });
const tailMat = new THREE.MeshBasicMaterial({ color: hdr(0xff1408, 6) });
const headMat = new THREE.MeshBasicMaterial({ color: hdr(0xfff0d8, 3) });
const MATS = { glass: glassMat, misc: miscMat, tail: tailMat, head: headMat };

let glowTex = null;
function getGlowTex() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c); glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
let glowMat = null;

// ---------------------------------------------------------------- models
export const MODELS = {}; // name -> { name, kind, sports, halfW, halfL, height, geos:{slot:geo}, glow:geo, paint }

export async function loadTraffic(url = './models/traffic.glb') {
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  const meta = gltf.scene.userData.cars || {};
  glowMat = new THREE.MeshBasicMaterial({ map: getGlowTex(), color: new THREE.Color(1.6, 0.12, 0.06), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: true });
  for (const node of gltf.scene.children) {
    const m = meta[node.name]; if (!m) continue;
    const geos = {};
    node.updateMatrixWorld(true);
    node.traverse((o) => {
      if (!o.isMesh) return;
      const slot = o.name.split('_')[0];
      const g = o.geometry.clone();
      g.applyMatrix4(new THREE.Matrix4().copy(node.matrixWorld).invert().multiply(o.matrixWorld));
      geos[slot] = g;
    });
    // tail-light glow quads: one per side, merged into a single geometry
    let glow = null;
    if (geos.tail) {
      const pos = geos.tail.attributes.position; const sides = { '-1': new THREE.Box3(), '1': new THREE.Box3() }; const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); if (v.z > 0) sides[v.x < 0 ? '-1' : '1'].expandByPoint(v); }
      const quads = [];
      for (const b of Object.values(sides)) {
        if (b.isEmpty()) continue;
        const c = b.getCenter(new THREE.Vector3());
        const s = m.kind === 'truck' ? 1.0 : 0.85;
        quads.push(new THREE.PlaneGeometry(s, s * 0.7).translate(c.x, c.y, b.max.z + 0.06));
      }
      if (quads.length) glow = mergeQuads(quads);
    }
    const sportScale = node.name === 'concept' ? 0.9 : 1;
    if (sportScale !== 1) { for (const g of Object.values(geos)) g.scale(sportScale, sportScale, sportScale); if (glow) glow.scale(sportScale, sportScale, sportScale); }
    MODELS[node.name] = {
      name: node.name, kind: m.kind, sports: !!m.sports, geos, glow,
      halfW: (m.W * sportScale / 2) * (m.sports ? 0.86 : 0.95), halfL: (m.L * sportScale / 2) * 0.96, height: m.H * sportScale,
      fixedPaint: !geos.paint,
    };
  }
  return MODELS;
}
function mergeQuads(list) {
  const pos = [], uv = [], idx = []; let o = 0;
  for (const q of list) {
    const p = q.attributes.position, u = q.attributes.uv;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); uv.push(u.getX(i), u.getY(i)); }
    for (const i of q.index.array) idx.push(i + o); o += p.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  return g;
}

// pool composition: kind -> [[modelName, weight]]
export const POOL = {
  sedan: [['sedan', 4], ['sedan_sports', 3], ['taxi', 3], ['police_car', 1], ['ferrari', 2], ['concept', 2]],
  suv: [['suv', 3], ['suv_luxury', 2], ['van', 2], ['delivery_van', 1], ['truck', 1], ['truck_flat', 1]],
  truck: [['box_truck', 1], ['garbage_truck', 1]],
};
export function poolModels(kind, n) {
  const list = POOL[kind]; const out = [];
  const total = list.reduce((s, [, w]) => s + w, 0);
  let acc = 0, k = 0;
  for (const [name, w] of list) { acc += w; while (k < Math.round((acc / total) * n)) { out.push(MODELS[name]); k++; } }
  return out.filter(Boolean);
}

/**
 * Build a traffic car group. children order kept compatible with main.js:
 * [0] paint mesh (or empty), [1] misc+glass group, [2] lights group, [3] streak group (added by caller)
 */
export function buildCar(model) {
  const g = new THREE.Group();
  const body = model.geos.paint ? new THREE.Mesh(model.geos.paint, CIVIL_PAINTS[0]) : new THREE.Object3D();
  const rest = new THREE.Group();
  for (const s of ['misc', 'glass']) if (model.geos[s]) rest.add(new THREE.Mesh(model.geos[s], MATS[s]));
  const lights = new THREE.Group();
  for (const s of ['tail', 'head']) if (model.geos[s]) lights.add(new THREE.Mesh(model.geos[s], MATS[s]));
  if (model.glow) { const gm = new THREE.Mesh(model.glow, glowMat); gm.renderOrder = 3; lights.add(gm); }
  g.add(body, rest, lights);
  return { g, body };
}

export function repaint(t) {
  const M = t.model; if (!M || M.fixedPaint) return;
  t.body.material = M.kind === 'truck' ? pick(TRUCK_PAINTS) : M.sports ? pick(SPORT_PAINTS) : pick(CIVIL_PAINTS);
}
