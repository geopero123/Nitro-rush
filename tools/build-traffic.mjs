// Build public/models/traffic.glb: Kenney Car Kit (CC0) + simplified Ferrari 458 (CC BY 4.0)
// Each car -> one node with up to 5 child meshes named by slot: paint, glass, misc (vertex colours), tail, head.
// All cars face -Z, sit on y=0, centred on x/z, real-world metres.
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, meshopt, prune, dedup, quantize } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

await MeshoptDecoder.ready; await MeshoptEncoder.ready; await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
});
const KDIR = '/tmp/nr-tools/';
const OUT = process.argv[2] || '/tmp/nr-tools/traffic.glb';

// palette of the Kenney colormap (512x512): sample centre of each 32x128 cell
const pal = await sharp(KDIR + 'colormap.png').raw().toBuffer({ resolveWithObject: true });
function cellColor(cx, cy) {
  const x = cx * 32 + 16, y = cy * 128 + 64, i = (y * pal.info.width + x) * pal.info.channels;
  return new THREE.Color().setRGB(pal.data[i] / 255, pal.data[i + 1] / 255, pal.data[i + 2] / 255, THREE.SRGBColorSpace);
}
const hex = (h) => new THREE.Color(h); // linear from sRGB hex (three converts)

// default slot rules by palette cell (col,row)
function defaultSlot(c, r) {
  if (r === 3 && c <= 1) return 'glass';
  if (r === 3 && (c === 4 || c === 5)) return 'tail';
  if (r === 3 && (c === 2 || c === 3)) return 'head';
  return null;
}
const MISC_REMAP = {
  '5,2': 0x0d0d0f, '4,2': 0x0d0d0f, '2,2': 0x1a1b1f, '3,2': 0x1a1b1f, '8,2': 0x202226, '9,2': 0x202226,
  '6,2': 0x24262b, '7,2': 0x24262b, '10,2': 0xaab0ba, '11,2': 0xaab0ba,
};

const KENNEY = [
  // name, kind, length, width, height-scale, paint cells override, misc overrides
  { name: 'sedan', kind: 'sedan', L: 4.75, W: 1.86 },
  { name: 'sedan_sports', kind: 'sedan', L: 4.6, W: 1.9 },
  { name: 'taxi', kind: 'sedan', L: 4.8, W: 1.86, fixedPaint: true },
  { name: 'police_car', kind: 'sedan', L: 4.9, W: 1.9, fixedPaint: true, paint: [], remap: { '13,2': 0xe8e8ec } },
  { name: 'suv', kind: 'suv', L: 4.8, W: 1.98, paint: ['7,2', '7,1'] },
  { name: 'suv_luxury', kind: 'suv', L: 5.0, W: 2.0 },
  { name: 'van', kind: 'suv', L: 5.1, W: 2.0 },
  { name: 'delivery_van', kind: 'suv', L: 5.6, W: 2.1, remap: { '7,2': 0xd8dade } },
  { name: 'truck', kind: 'suv', L: 5.4, W: 2.02 },
  { name: 'truck_flat', kind: 'suv', L: 5.4, W: 2.02, paint: ['13,2'] },
  { name: 'box_truck', src: 'delivery_van', kind: 'truck', L: 7.6, W: 2.5, remap: { '7,2': 0xd8dade } },
  { name: 'garbage_truck', kind: 'truck', L: 8.2, W: 2.5, remap: { '7,2': 0xb9bdc4 } },
];

const out = new Document();
const buf = out.createBuffer();
const oscene = out.createScene('traffic');
const meta = {};

function makeMesh(name, slots) {
  const node = out.createNode(name);
  for (const [slot, d] of Object.entries(slots)) {
    if (!d.pos.length) continue;
    const prim = out.createPrimitive()
      .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(new Float32Array(d.pos)).setBuffer(buf))
      .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(new Float32Array(d.nor)).setBuffer(buf));
    if (slot === 'misc') prim.setAttribute('COLOR_0', out.createAccessor().setType('VEC3').setArray(new Float32Array(d.col)).setBuffer(buf));
    prim.setMaterial(MATS[slot]);
    const mesh = out.createMesh(name + '_' + slot).addPrimitive(prim);
    node.addChild(out.createNode(slot).setMesh(mesh));
  }
  oscene.addChild(node);
  return node;
}
const MATS = Object.fromEntries(['paint', 'glass', 'misc', 'tail', 'head'].map((s) => [s, out.createMaterial(s)]));
const newSlots = () => Object.fromEntries(['paint', 'glass', 'misc', 'tail', 'head'].map((s) => [s, { pos: [], nor: [], col: [] }]));

// ---- Kenney
for (const cfg of KENNEY) {
  const doc = await io.read(KDIR + (cfg.src || cfg.name) + '.glb');
  // gather tris with world positions
  const tris = []; // {p:[3 vec3], cell, wheel:center|null}
  const box = new THREE.Box3();
  const cellArea = {};
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    const M = new THREE.Matrix4().fromArray(node.getWorldMatrix());
    const isWheel = /^wheel/.test(node.getName() || '');
    const centre = new THREE.Vector3().setFromMatrixPosition(M);
    for (const p of mesh.listPrimitives()) {
      const pos = p.getAttribute('POSITION'), uv = p.getAttribute('TEXCOORD_0'), idx = p.getIndices();
      const n = idx ? idx.getCount() : pos.getCount(); const a = [], b = [];
      for (let i = 0; i < n; i += 3) {
        let u = 0, v = 0; const P = [];
        for (let k = 0; k < 3; k++) {
          const j = idx ? idx.getScalar(i + k) : i + k;
          uv.getElement(j, b); u += b[0] / 3; v += b[1] / 3;
          pos.getElement(j, a); const q = new THREE.Vector3(a[0], a[1], a[2]).applyMatrix4(M); P.push(q); box.expandByPoint(q);
        }
        const cell = `${Math.floor(u * 16)},${Math.floor(v * 4)}`;
        const area = new THREE.Triangle(...P).getArea();
        cellArea[cell] = (cellArea[cell] || 0) + area;
        tris.push({ P, cell, wheel: isWheel ? centre : null });
      }
    }
  }
  // paint cell(s)
  let paint = cfg.paint;
  if (!paint) {
    const cand = Object.entries(cellArea).filter(([c]) => { const [x, y] = c.split(',').map(Number); return y <= 1; }).sort((a, b) => b[1] - a[1]);
    paint = cand.length ? [cand[0][0]] : [];
  }
  const size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
  const sx = cfg.W / size.x, sz = cfg.L / size.z, sy = sx * 0.97;
  const S = new THREE.Vector3(sx, sy, sz);
  const slots = newSlots();
  const paintSrgb = paint.length ? cellColor(...paint[0].split(',').map(Number)) : null;
  for (const t of tris) {
    const [c, r] = t.cell.split(',').map(Number);
    let slot = defaultSlot(c, r);
    if (!slot) slot = (paint.includes(t.cell) && !cfg.fixedPaint) ? 'paint' : 'misc';
    // transform: base centred, rotated 180deg (Kenney faces +Z -> we want -Z)
    const P = t.P.map((q) => {
      let o;
      if (t.wheel) {
        const wc = t.wheel.clone().sub(ctr).multiply(S); wc.y = t.wheel.y * sy - box.min.y * sy;
        o = q.clone().sub(t.wheel).multiplyScalar(sx).add(new THREE.Vector3(wc.x, wc.y, wc.z));
      } else { o = q.clone().sub(ctr).multiply(S); o.y = (q.y - box.min.y) * sy; }
      o.x = -o.x; o.z = -o.z; return o;
    });
    const nrm = new THREE.Triangle(...P).getNormal(new THREE.Vector3());
    let col = new THREE.Color(1, 1, 1);
    if (slot === 'misc') {
      const rm = (cfg.remap && cfg.remap[t.cell]) ?? MISC_REMAP[t.cell];
      col = rm !== undefined ? hex(rm) : cellColor(c, r);
    }
    const d = slots[slot];
    for (const q of P) { d.pos.push(q.x, q.y, q.z); d.nor.push(nrm.x, nrm.y, nrm.z); d.col.push(col.r, col.g, col.b); }
  }
  makeMesh(cfg.name, slots);
  meta[cfg.name] = { kind: cfg.kind, L: cfg.L, W: cfg.W, H: +(size.y * sy).toFixed(3), paint: paintSrgb && !cfg.fixedPaint ? '#' + paintSrgb.getHexString() : null };
  console.log(cfg.name, 'paint', paint, 'tris', tris.length, 'H', meta[cfg.name].H);
}

async function sports(name, file, slotOf, targets) {
  const doc = await io.read(file);
  const slots = newSlots();
  const box = new THREE.Box3();
  // temp doc per slot to simplify: collect raw then simplify through gltf-transform
  const raw = newSlots();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    
    const M = new THREE.Matrix4().fromArray(node.getWorldMatrix());
    const NM = new THREE.Matrix3().getNormalMatrix(M);
    for (const p of mesh.listPrimitives()) {
      const s = slotOf(node.getName() || '', p.getMaterial()?.getName() || ''); if (s === undefined || s === null) continue;
      const pos = p.getAttribute('POSITION'), nor = p.getAttribute('NORMAL'), idx = p.getIndices();
      const n = idx ? idx.getCount() : pos.getCount(); const a = [], b = [];
      const slot = typeof s === 'string' ? s : 'misc';
      const col = typeof s === 'number' ? hex(s) : new THREE.Color(1, 1, 1);
      for (let i = 0; i < n; i++) {
        const j = idx ? idx.getScalar(i) : i;
        pos.getElement(j, a); const q = new THREE.Vector3(...a).applyMatrix4(M); box.expandByPoint(q);
        nor.getElement(j, b); const nn = new THREE.Vector3(...b).applyMatrix3(NM).normalize();
        raw[slot].pos.push(q.x, q.y, q.z); raw[slot].nor.push(nn.x, nn.y, nn.z); raw[slot].col.push(col.r, col.g, col.b);
      }
    }
  }
  const ctr = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  console.log(name, 'raw size', size.toArray().map((v) => v.toFixed(2)));
  // simplify each slot: weld by position, meshopt simplify, creased normals
  for (const [slot, d] of Object.entries(raw)) {
    if (!d.pos.length) continue;
    const map = new Map(), wp = [], wc = [], ind = [];
    for (let i = 0; i < d.pos.length / 3; i++) {
      const k = `${Math.round(d.pos[i*3]*2000)},${Math.round(d.pos[i*3+1]*2000)},${Math.round(d.pos[i*3+2]*2000)}`;
      let id = map.get(k);
      if (id === undefined) { id = wp.length / 3; map.set(k, id); wp.push(d.pos[i*3], d.pos[i*3+1], d.pos[i*3+2]); wc.push(d.col[i*3], d.col[i*3+1], d.col[i*3+2]); }
      ind.push(id);
    }
    const target = targets[slot] * 3;
    const P32 = new Float32Array(wp), I32 = new Uint32Array(ind);
    let [res, err] = MeshoptSimplifier.simplify(I32, P32, 3, Math.min(target, I32.length), 0.02, []);
    if (res.length > target * 1.5) [res] = MeshoptSimplifier.simplifySloppy(I32, P32, 3, null, target, 0.03);
    const g = new THREE.BufferGeometry();
    const op = new Float32Array(res.length * 3), oc = new Float32Array(res.length * 3);
    for (let i = 0; i < res.length; i++) { const v = res[i]; for (let k = 0; k < 3; k++) { op[i*3+k] = wp[v*3+k]; oc[i*3+k] = wc[v*3+k]; } }
    g.setAttribute('position', new THREE.BufferAttribute(op, 3)); g.setAttribute('color', new THREE.BufferAttribute(oc, 3));
    const cg = toCreasedNormals(g, slot === 'misc' ? 0.6 : 0.75);
    const pa = cg.attributes.position, na = cg.attributes.normal, ca = cg.attributes.color;
    for (let i = 0; i < pa.count; i++) {
      slots[slot].pos.push(pa.getX(i) - ctr.x, pa.getY(i) - box.min.y, pa.getZ(i) - ctr.z);
      slots[slot].nor.push(na.getX(i), na.getY(i), na.getZ(i)); slots[slot].col.push(ca.getX(i), ca.getY(i), ca.getZ(i));
    }
    console.log(' ', name, slot, d.pos.length / 9, '->', res.length / 3, 'err', err);
  }
  // orient: headlights must be at -Z
  let hz = 0; const hp = slots.head.pos; for (let i = 2; i < hp.length; i += 3) hz += hp[i];
  if (hz > 0) for (const k of ['pos', 'nor']) for (const d of Object.values(slots)) for (let i = 0; i < d[k].length; i += 3) { d[k][i] = -d[k][i]; d[k][i + 2] = -d[k][i + 2]; }
  makeMesh(name, slots);
  meta[name] = { kind: 'sedan', sports: true, L: +size.z.toFixed(3), W: +size.x.toFixed(3), H: +size.y.toFixed(3), paint: null };
}


const FERRARI = {
  body: 'paint', glass: 'glass', lights_red: 'tail', brakes: 'tail', lights: 'head', leds: 'head',
  plastic_gray: 0x111114, carbon_fibre_trim: 0x16161a, 'carbon fibre': 0x16161a, grills: 0x0b0b0d, tire: 0x0e0e10, wipers: 0x0b0b0d,
  chrome: 0xc8ccd4, metal: 0x8a8e96, wheel: 0x9a9ea6, rim_fl: 0x9a9ea6, rim_fr: 0x9a9ea6, rim_rl: 0x9a9ea6, rim_rr: 0x9a9ea6, brake: 0x3a3a40,
  yellow_trim: 0xd8b000, interior_light: 0x141416, interior_dark: 0x141416,
};
await sports('ferrari', '/home/claude/nr-realism/public/models/ferrari.glb', (n) => FERRARI[n], { paint: 9000, glass: 1200, misc: 7000, tail: 1500, head: 500 });
const CC = { Glass: 'glass', Brakelight: 'tail', Signallight: 'tail', Headlight: 'head', 'Paint 1 Carmine': 'paint', 'Paint 2 Carmine': 0x18181c,
  Tireside: 0x0e0e10, Tiretread: 0x0e0e10, Rim1: 0xb0b4bc, Rim2: 0x2a2a2e, Brake: 0xc01818, Disc: 0x55555a, Mirror: 0x9a9ea6, Mechanical: 0x101012, License: 0xd0d0d0 };
await sports('concept', '/tmp/nr-dl/carconcept/CarConcept.glb', (n, m) => {
  if (/^Interior/.test(n)) return /Seats|Dash|Floor|Mid|Cage/.test(n) ? 0x121214 : null;
  if (/Wipers/.test(n)) return null;
  return CC[m] ?? 0x141416;
}, { paint: 8000, glass: 800, misc: 6000, tail: 400, head: 300 });
oscene.setExtras({ cars: meta });
await out.transform(weld(), dedup(), prune(), quantize({ quantizeNormal: 8, quantizePosition: 14, quantizeColor: 8 }), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
await io.write(OUT, out);
console.log(JSON.stringify(meta));
