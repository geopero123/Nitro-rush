// Procedural night city: atlas-textured buildings (one shared material, per-window random lighting in the shader),
// storefront ground floors, setbacks, rooftop clutter, billboards, neon, blade signs, background towers,
// sign gantries, overpasses and street palms. Everything recycles by absolute distance D (mesh z = -(D - distance)).
import * as THREE from 'three';
import { markReflective } from './fx.js';

const rand = (a, b) => a + Math.random() * (b - a);
const irand = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function tex(c, srgb = true, aniso = 4) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

// ---------------------------------------------------------------- facade atlas (4x4 cells, 256px each)
// cells 0-7 facade styles (tile = 4 bays x 4 floors = 12m x 14.4m), 8 plain concrete, 9 dark spandrel glass,
// 10-12 storefronts (tile = 12m x ground floor), 13 roof gravel, 14 rooftop machinery, 15 solid light (crowns)
const C = 256, AT = 1024;
const STYLES = [
  { type: 'curtain', wall: '#1d2633', glass: ['#0f1b2c', '#18304a'], mull: '#2b3646' },
  { type: 'curtain', wall: '#172720', glass: ['#0b1c18', '#14352c'], mull: '#253a30' },
  { type: 'punched', wall: '#4b4642', glass: '#0e1015', fw: 0.5, fh: 0.55 },
  { type: 'punched', wall: '#53302a', glass: '#100c0c', fw: 0.4, fh: 0.6, sill: true },
  { type: 'ribbon', wall: '#3b3e46', glass: '#0c1220' },
  { type: 'deco', wall: '#5c5449', glass: '#0f0f12' },
  { type: 'punched', wall: '#8b8e93', glass: '#10151a', fw: 0.64, fh: 0.5 },
  { type: 'curtain', wall: '#1f1f24', glass: ['#08080c', '#15151d'], mull: '#33333a', dense: true },
];
const SHOP_WORDS = ['CAFE', 'PHARMACY', 'SUSHI', 'BOUTIQUE', 'MARKET', 'PIZZA', 'BAR', 'SHOES', 'BANK', 'DELI', 'GYM', 'TECH', 'NOODLES', 'FLOWERS', 'BURGER', 'MOBILE', 'BAKERY', 'RAMEN', 'HOTEL', 'BOOKS'];
const SHOP_COLS = ['#ff3d7f', '#2fe0ff', '#ffb43a', '#9b6bff', '#4dff9a', '#ff5a3a', '#ffffff', '#ffd84a'];

function noise(g, x, y, w, h, n, a, light = false) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = light ? `rgba(255,255,255,${Math.random() * a})` : `rgba(0,0,0,${Math.random() * a})`;
    g.fillRect(x + Math.random() * w, y + Math.random() * h, rand(1, 3), rand(1, 6));
  }
}

function buildAtlas() {
  const [ca, A] = canvas(AT, AT), [ce, E] = canvas(AT, AT), [cm, M] = canvas(AT / 2, AT / 2);
  A.fillStyle = '#222'; A.fillRect(0, 0, AT, AT);
  E.fillStyle = '#000'; E.fillRect(0, 0, AT, AT);
  M.fillStyle = '#fff'; M.fillRect(0, 0, AT / 2, AT / 2);
  const glassMask = (x, y, w, h, v = 0) => { M.fillStyle = `rgb(${v},${v},${v})`; M.fillRect(x / 2, y / 2, w / 2, h / 2); };
  const cellXY = (i) => [(i % 4) * C, Math.floor(i / 4) * C];

  STYLES.forEach((st, i) => {
    const [ox, oy] = cellXY(i);
    A.fillStyle = st.wall; A.fillRect(ox, oy, C, C);
    noise(A, ox, oy, C, C, 500, 0.12); noise(A, ox, oy, C, C, 200, 0.05, true);
    for (let f = 0; f < 4; f++) for (let b = 0; b < 4; b++) {
      const x = ox + b * 64, y = oy + f * 64;
      // interior light (emissive), shader picks on/off + tint per window
      const interior = (wx, wy, ww, wh, warm) => {
        const gr = E.createLinearGradient(0, wy, 0, wy + wh);
        const top = warm ? [255, 214, 160] : [222, 236, 255];
        gr.addColorStop(0, `rgb(${top})`); gr.addColorStop(0.18, `rgb(${top.map((c) => c * 0.8 | 0)})`); gr.addColorStop(1, `rgb(${top.map((c) => c * 0.38 | 0)})`);
        E.fillStyle = gr; E.fillRect(wx, wy, ww, wh);
        // furniture / people silhouettes
        E.fillStyle = 'rgba(0,0,0,0.55)';
        for (let k = 0; k < 3; k++) if (Math.random() < 0.6) E.fillRect(wx + Math.random() * ww * 0.8, wy + wh * rand(0.55, 0.75), rand(3, ww * 0.35), wh);
        if (Math.random() < 0.35) { E.fillStyle = 'rgba(0,0,0,0.45)'; E.fillRect(wx, wy, ww * rand(0.3, 1), wh * rand(0.2, 0.6)); } // blinds
      };
      if (st.type === 'curtain') {
        const gr = A.createLinearGradient(0, y, 0, y + 64); gr.addColorStop(0, st.glass[1]); gr.addColorStop(1, st.glass[0]);
        A.fillStyle = gr; A.fillRect(x, y, 64, 64); glassMask(x, y, 64, 64, 0);
        interior(x, y + 8, 64, 56, false);
        A.fillStyle = st.mull; E.fillStyle = '#000';
        const step = st.dense ? 16 : 32;
        for (let mx = 0; mx < 64; mx += step) { A.fillRect(x + mx, y, 3, 64); E.fillRect(x + mx, y, 3, 64); glassMask(x + mx, y, 4, 64, 200); }
        A.fillRect(x, y, 64, 8); E.fillRect(x, y, 64, 8); glassMask(x, y, 64, 8, 220);
      } else if (st.type === 'punched') {
        const ww = 64 * st.fw, wh = 64 * st.fh, wx = x + (64 - ww) / 2, wy = y + 64 * 0.22;
        A.fillStyle = 'rgba(0,0,0,0.5)'; A.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
        A.fillStyle = st.glass; A.fillRect(wx, wy, ww, wh); glassMask(wx, wy, ww, wh, 10);
        interior(wx, wy, ww, wh, true);
        A.fillStyle = 'rgba(30,30,34,0.9)'; A.fillRect(wx + ww / 2 - 1, wy, 2, wh); E.fillStyle = '#000'; E.fillRect(wx + ww / 2 - 1, wy, 2, wh);
        if (st.sill) { A.fillStyle = 'rgba(200,190,170,0.5)'; A.fillRect(wx - 4, wy + wh + 2, ww + 8, 3); }
      } else if (st.type === 'ribbon') {
        const wy = y + 18, wh = 36;
        A.fillStyle = st.glass; A.fillRect(x, wy, 64, wh); glassMask(x, wy, 64, wh, 0);
        interior(x, wy, 64, wh, Math.random() < 0.5);
        A.fillStyle = '#2a2d33'; E.fillStyle = '#000'; A.fillRect(x + 30, wy, 3, wh); E.fillRect(x + 30, wy, 3, wh);
      } else if (st.type === 'deco') {
        A.fillStyle = 'rgba(255,240,210,0.12)'; A.fillRect(x, y, 12, 64);
        const wx = x + 18, ww = 36, wy = y + 10, wh = 48;
        A.fillStyle = st.glass; A.fillRect(wx, wy, ww, wh); glassMask(wx, wy, ww, wh, 20);
        interior(wx, wy, ww, wh, true);
        A.fillStyle = '#3d372f'; A.fillRect(wx, wy + wh / 2, ww, 3); E.fillStyle = '#000'; E.fillRect(wx, wy + wh / 2, ww, 3);
      }
    }
  });
  // 8 plain concrete panels
  {
    const [ox, oy] = cellXY(8);
    A.fillStyle = '#4a4a4e'; A.fillRect(ox, oy, C, C); noise(A, ox, oy, C, C, 900, 0.15);
    A.fillStyle = 'rgba(0,0,0,0.35)'; for (let k = 0; k <= 4; k++) { A.fillRect(ox + k * 64, oy, 2, C); A.fillRect(ox, oy + k * 64, C, 2); }
  }
  // 9 dark spandrel glass
  {
    const [ox, oy] = cellXY(9);
    const gr = A.createLinearGradient(0, oy, 0, oy + C); gr.addColorStop(0, '#1a2230'); gr.addColorStop(1, '#0a0d14');
    A.fillStyle = gr; A.fillRect(ox, oy, C, C); glassMask(ox, oy, C, C, 30);
    A.fillStyle = '#2a3240'; for (let k = 0; k < 8; k++) { A.fillRect(ox + k * 32, oy, 2, C); A.fillRect(ox, oy + k * 32, C, 2); }
  }
  // 10-12 storefronts: tile = 12m wide x ground floor; fascia sign band on top, shop glass below
  for (let s = 0; s < 3; s++) {
    const [ox, oy] = cellXY(10 + s);
    A.fillStyle = ['#2c2a2a', '#1c1c22', '#3a332c'][s]; A.fillRect(ox, oy, C, C);
    noise(A, ox, oy, C, C, 300, 0.2);
    for (let shop = 0; shop < 2; shop++) {
      const x = ox + shop * 128, col = pick(SHOP_COLS), word = pick(SHOP_WORDS);
      // fascia sign
      A.fillStyle = '#0d0d10'; A.fillRect(x + 6, oy + 14, 116, 50);
      E.fillStyle = col; E.globalAlpha = 0.18; E.fillRect(x + 6, oy + 14, 116, 50); E.globalAlpha = 1;
      E.fillStyle = col; E.font = `bold ${word.length > 6 ? 22 : 30}px system-ui, sans-serif`; E.textAlign = 'center'; E.textBaseline = 'middle';
      E.fillText(word, x + 64, oy + 40);
      A.fillStyle = col; A.font = E.font; A.textAlign = 'center'; A.textBaseline = 'middle'; A.globalAlpha = 0.6; A.fillText(word, x + 64, oy + 40); A.globalAlpha = 1;
      // awning
      if (Math.random() < 0.5) { A.fillStyle = pick(['#6a1520', '#173a5a', '#1f4a2a', '#4a3a10']); A.fillRect(x + 4, oy + 66, 120, 14); A.fillStyle = 'rgba(255,255,255,0.15)'; for (let k = 0; k < 120; k += 16) A.fillRect(x + 4 + k, oy + 66, 8, 14); }
      // shop window
      const wy = oy + 84, wh = C - 84 - 10;
      A.fillStyle = '#121418'; A.fillRect(x + 8, wy, 112, wh); glassMask(x + 8, wy, 112, wh, 0);
      const warm = Math.random() < 0.7;
      const gr = E.createLinearGradient(0, wy, 0, wy + wh);
      gr.addColorStop(0, warm ? '#fff2d8' : '#e0f2ff'); gr.addColorStop(1, warm ? '#8a6040' : '#4a6a8a');
      E.fillStyle = gr; E.fillRect(x + 8, wy, 112, wh);
      E.fillStyle = 'rgba(0,0,0,0.5)';
      for (let k = 0; k < 6; k++) E.fillRect(x + 10 + Math.random() * 100, wy + wh * rand(0.45, 0.8), rand(6, 18), wh); // shelves / people
      for (let k = 0; k < 4; k++) { E.fillStyle = pick(SHOP_COLS); E.globalAlpha = 0.5; E.fillRect(x + 12 + Math.random() * 96, wy + rand(8, wh * 0.5), rand(6, 14), rand(6, 14)); E.globalAlpha = 1; }
      // mullions + door
      A.fillStyle = '#2a2a30'; E.fillStyle = '#000';
      for (const mx of [8, 44, 84, 118]) { A.fillRect(x + mx, wy, 3, wh); E.fillRect(x + mx, wy, 3, wh); }
      if (Math.random() < 0.6) { E.fillStyle = 'rgba(0,0,0,0.4)'; E.fillRect(x + 50, wy + 10, 30, wh - 10); }
    }
  }
  // 13 roof gravel, 14 machinery
  { const [ox, oy] = cellXY(13); A.fillStyle = '#2b2b30'; A.fillRect(ox, oy, C, C); noise(A, ox, oy, C, C, 3000, 0.3); noise(A, ox, oy, C, C, 1000, 0.08, true); }
  {
    const [ox, oy] = cellXY(14); A.fillStyle = '#55585e'; A.fillRect(ox, oy, C, C);
    A.fillStyle = '#3a3c42'; for (let k = 0; k < C; k += 10) A.fillRect(ox, oy + k, C, 4);
    A.fillStyle = 'rgba(0,0,0,0.4)'; A.fillRect(ox, oy, 4, C); A.fillRect(ox + C - 4, oy, 4, C);
  }
  // 15 solid light
  { const [ox, oy] = cellXY(15); A.fillStyle = '#ffffff'; A.fillRect(ox, oy, C, C); E.fillStyle = '#eaf6ff'; E.fillRect(ox, oy, C, C); }
  const at = tex(ca), et = tex(ce), mt = tex(cm, false);
  for (const t of [at, et, mt]) { t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; }
  return { at, et, mt };
}

function makeFacadeMaterial(atlas) {
  const m = new THREE.MeshStandardMaterial({
    map: atlas.at, emissiveMap: atlas.et, roughnessMap: atlas.mt, emissive: 0xffffff, emissiveIntensity: 0.8,
    roughness: 1, metalness: 0, envMapIntensity: 0.6,
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 cell; varying vec3 vCell; varying vec2 vTile;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvCell = cell; vTile = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vCell; varying vec2 vTile;
float cityHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <map_fragment>', `
vec2 cs = vec2(0.25);
vec2 auv = vCell.xy + (0.004 + fract(vTile) * 0.992) * cs;
vec2 gdx = dFdx(vTile) * cs, gdy = dFdy(vTile) * cs;
diffuseColor *= textureGrad(map, auv, gdx, gdy);`)
      .replace('#include <roughnessmap_fragment>', `
float mk = textureGrad(roughnessMap, auv, gdx, gdy).g;
float roughnessFactor = mix(0.07, 0.92, mk);`)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = mix(0.5, 0.04, mk);')
      .replace('#include <emissivemap_fragment>', `
vec3 em = textureGrad(emissiveMap, auv, gdx, gdy).rgb;
float h = cityHash(floor(vTile * 4.0) + vCell.xy * 37.0);
float lit = vCell.z > 0.5 ? mix(0.75, 1.25, h) : step(0.55, h) * mix(0.25, 1.0, fract(h * 7.13));
vec3 tint = vCell.z > 0.5 ? vec3(1.0) : mix(vec3(1.0, 0.8, 0.55), vec3(0.72, 0.86, 1.0), step(0.55, fract(h * 3.7)));
totalEmissiveRadiance *= em * lit * tint;`);
  };
  return m;
}

// ---------------------------------------------------------------- geometry builder
class GB {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.i = []; }
  quad(a, b, c, d, nrm, uvs, cell) { // a,b,c,d = bl, br, tr, tl
    const o = this.p.length / 3;
    for (const [k, v] of [a, b, c, d].entries()) { this.p.push(...v); this.n.push(...nrm); this.uv.push(...uvs[k]); this.c.push(...cell); }
    this.i.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  // side faces of an axis aligned box + optional top. cells: {side:[u0,v0,kind], top:[..]} tile sizes in metres
  box(x0, x1, y0, y1, z0, z1, side, top, tw = 12, th = 14.4, uo = 0, vo = 0, yBase = y0) {
    const v0 = vo + (y0 - yBase) / th, v1 = vo + (y1 - yBase) / th;
    const face = (bl, br, len, nrm, u) => {
      this.quad([bl[0], y0, bl[1]], [br[0], y0, br[1]], [br[0], y1, br[1]], [bl[0], y1, bl[1]], nrm,
        [[u, v0], [u + len / tw, v0], [u + len / tw, v1], [u, v1]], side);
    };
    const W = z1 - z0, D = x1 - x0;
    face([x0, z1], [x0, z0], W, [-1, 0, 0], uo);
    face([x1, z0], [x1, z1], W, [1, 0, 0], uo + 0.37);
    face([x0, z0], [x1, z0], D, [0, 0, -1], uo + 0.71);
    face([x1, z1], [x0, z1], D, [0, 0, 1], uo + 0.13);
    if (top) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], [[x0 / 8, z1 / 8], [x1 / 8, z1 / 8], [x1 / 8, z0 / 8], [x0 / 8, z0 / 8]], top);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.c.length) g.setAttribute('cell', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}
const cellAttr = (i, kind = 0) => [(i % 4) * 0.25, 1 - (Math.floor(i / 4) + 1) * 0.25, kind];

/**
 * Building geometry (local frame: footprint centred on origin, ground at y=0, x = depth axis, z = width axis).
 * All four sides are textured, so it can be placed with any yaw. Use with getFacadeMaterial().
 * opts: { w, h, dep, style (0-7), shop (0-2), setback (bool), crown (bool), far (bool: random big tower) }
 * Missing values are randomised. geometry.userData = { w, h, dep, tw, td, h1 } (h = roof height, h1 = lower tier top).
 */
export function makeBuildingGeometry(opts = {}) {
  const far = !!opts.far;
  const B = new GB();
  const w = opts.w ?? (far ? rand(18, 34) : rand(12, 30)), dep = opts.dep ?? (far ? rand(18, 30) : rand(12, 22));
  const tall = Math.random() < (far ? 0.7 : 0.28);
  const h = opts.h ?? (tall ? rand(60, far ? 170 : 120) : rand(16, 55));
  const style = opts.style ?? irand(0, 7), uo = irand(0, 40), vo = irand(0, 40);
  const G = 4.8;
  const roof = cellAttr(13), plain = cellAttr(8), mach = cellAttr(14);
  // ground floor shops
  B.box(-dep / 2, dep / 2, 0, G, -w / 2, w / 2, cellAttr(10 + (opts.shop ?? irand(0, 2)), 1), null, 12, G, irand(0, 9), 0);
  B.box(-dep / 2 - 0.25, dep / 2 + 0.25, G, G + 0.6, -w / 2 - 0.25, w / 2 + 0.25, plain, plain, 12, 14.4, 0, 0);
  // tower
  let h1 = h; const inset = 0.35;
  const setback = opts.setback ?? (h > 38 && Math.random() < 0.55);
  if (setback) h1 = h * rand(0.5, 0.75);
  B.box(-dep / 2 + inset, dep / 2 - inset, G + 0.6, h1, -w / 2 + inset, w / 2 - inset, cellAttr(style), roof, 12, 14.4, uo, vo, G + 0.6);
  let top = h1, tw = w - inset * 2, td = dep - inset * 2;
  if (setback) {
    const si = Math.min(rand(2, 4.5), tw / 4, td / 4); tw -= si * 2; td -= si * 2;
    const st2 = Math.random() < 0.6 ? style : irand(0, 7);
    B.box(-td / 2, td / 2, h1, h, -tw / 2, tw / 2, cellAttr(st2), roof, 12, 14.4, uo + 3, vo + 2, h1);
    top = h;
  }
  // parapet / crown
  const crown = opts.crown ?? Math.random() < 0.3;
  B.box(-td / 2 - 0.2, td / 2 + 0.2, top, top + (crown ? 0.5 : 1.0), -tw / 2 - 0.2, tw / 2 + 0.2, crown ? cellAttr(15, 1) : plain, roof, 12, 14.4);
  if (crown) B.box(-td / 2 - 0.2, td / 2 + 0.2, top + 0.5, top + 1.3, -tw / 2 - 0.2, tw / 2 + 0.2, plain, roof, 12, 14.4);
  // rooftop machinery
  for (let k = irand(1, 3); k > 0; k--) {
    const bw = rand(2, Math.min(7, tw * 0.4)), bd = rand(2, Math.min(7, td * 0.4)), bh = rand(1.5, 4.5);
    const cx = rand(-td / 2 + bd / 2 + 0.5, td / 2 - bd / 2 - 0.5), cz = rand(-tw / 2 + bw / 2 + 0.5, tw / 2 - bw / 2 - 0.5);
    B.box(cx - bd / 2, cx + bd / 2, top, top + bh, cz - bw / 2, cz + bw / 2, mach, mach, 4, 4);
  }
  const g = B.geometry();
  g.userData = { w, h: top, dep, tw, td, h1 };
  return g;
}
const buildingGeo = (far) => makeBuildingGeometry({ far });

// ---------------------------------------------------------------- billboards (fictional brands)
const ADS = [
  ['NITRO COLA', '#ff2050', '#3a0010', 'ICE COLD'], ['VOLTA', '#28e0ff', '#001a2e', 'ELECTRIC FUTURE'], ['HYPERION', '#ffb020', '#2a1200', 'WATCHES'],
  ['KAIJU BURGER', '#ffd000', '#b01010', 'OPEN 24H'], ['ZEN-X', '#ffffff', '#4a0aa0', 'MOBILE 5G'], ['AURORA AIR', '#9ff0ff', '#0a2a60', 'FLY NIGHT'],
  ['RUSH FM 99.1', '#ff40c0', '#14001e', 'NON-STOP'], ['OKAMI', '#ff4020', '#0a0a0a', 'STREETWEAR'], ['NEON TIGER', '#40ff90', '#002010', 'ENERGY'],
  ['SKYLINE BANK', '#e0e8ff', '#0c1c40', 'YOUR CITY'], ['TURBO OIL', '#ffcc00', '#202020', 'PERFORMANCE'], ['PIXEL', '#00ffd0', '#101030', 'GAMES'],
  ['MIDNIGHT', '#c080ff', '#100020', 'PERFUME'], ['SOLAR', '#ff8800', '#2a0a00', 'ENERGY'], ['KOI SUSHI', '#ff6080', '#001830', 'DELIVERY'],
];
function buildAdAtlas() {
  const [c, g] = canvas(1024, 512);
  ADS.forEach(([name, fg, bg, sub], i) => {
    const x = (i % 4) * 256, y = Math.floor(i / 4) * 128;
    const gr = g.createLinearGradient(x, y, x + 256, y + 128); gr.addColorStop(0, bg); gr.addColorStop(1, '#000');
    g.fillStyle = gr; g.fillRect(x, y, 256, 128);
    g.globalAlpha = 0.35; g.fillStyle = fg;
    if (i % 3 === 0) { g.beginPath(); g.arc(x + 210, y + 64, 70, 0, Math.PI * 2); g.fill(); }
    else if (i % 3 === 1) { for (let k = 0; k < 5; k++) g.fillRect(x + 150 + k * 22, y, 10, 128); }
    else { g.beginPath(); g.moveTo(x + 140, y + 128); g.lineTo(x + 256, y); g.lineTo(x + 256, y + 128); g.fill(); }
    g.globalAlpha = 1;
    g.fillStyle = fg; g.font = `900 ${name.length > 10 ? 26 : 34}px system-ui, sans-serif`; g.textBaseline = 'middle';
    g.fillText(name, x + 14, y + 54, 228);
    g.fillStyle = '#ffffff'; g.font = '600 15px system-ui, sans-serif'; g.fillText(sub, x + 16, y + 92);
    g.fillStyle = fg; g.fillRect(x + 16, y + 76, 50, 3);
    g.strokeStyle = 'rgba(0,0,0,0.9)'; g.lineWidth = 4; g.strokeRect(x + 2, y + 2, 252, 124);
  });
  g.fillStyle = '#08080a'; g.fillRect(768, 384, 256, 128); // frame cell
  return tex(c);
}
function billboardGeo(ad, roof) {
  const B = new GB();
  const W = roof ? 14 : 10, H = W / 2, u0 = (ad % 4) / 4, v1 = 1 - Math.floor(ad / 4) / 4, v0 = v1 - 0.25;
  const fu = [0.87, 0.12], none = [0, 0, 0];
  B.quad([-W / 2, 0, 0.05], [W / 2, 0, 0.05], [W / 2, H, 0.05], [-W / 2, H, 0.05], [0, 0, 1], [[u0, v0], [u0 + 0.25, v0], [u0 + 0.25, v1], [u0, v1]], none);
  const frame = (x0, x1, y0, y1, z0, z1) => B.box(x0, x1, y0, y1, z0, z1, none, null, 1e6, 1e6, fu[0], fu[1]);
  frame(-W / 2 - 0.3, W / 2 + 0.3, -0.3, 0, -0.5, 0.05); frame(-W / 2 - 0.3, W / 2 + 0.3, H, H + 0.3, -0.5, 0.05);
  frame(-W / 2 - 0.3, -W / 2, 0, H, -0.5, 0.05); frame(W / 2, W / 2 + 0.3, 0, H, -0.5, 0.05);
  frame(-W / 2, W / 2, 0, H, -0.5, -0.4);
  if (roof) for (const x of [-W / 3, W / 3]) frame(x - 0.25, x + 0.25, -4, 0, -0.6, -0.1);
  const g = B.geometry(); g.deleteAttribute('cell'); g.translate(0, roof ? 4 : 0, 0);
  return g;
}

// ---------------------------------------------------------------- small textures
function signTex(text, color) {
  const [c, g] = canvas(96, 64 * text.length + 32);
  g.fillStyle = '#05040a'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = color; g.lineWidth = 5; g.strokeRect(6, 6, c.width - 12, c.height - 12);
  g.fillStyle = color; g.font = 'bold 54px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  [...text].forEach((ch, i) => g.fillText(ch, c.width / 2, 48 + i * 64));
  return tex(c);
}
function concreteTex() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#5a5a5e'; g.fillRect(0, 0, 256, 256); noise(g, 0, 0, 256, 256, 1500, 0.18); noise(g, 0, 0, 256, 256, 400, 0.06, true);
  g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, 126, 256, 3); g.fillRect(126, 0, 3, 256);
  for (let k = 0; k < 14; k++) { g.fillStyle = 'rgba(0,0,0,0.08)'; g.fillRect(Math.random() * 256, 0, rand(2, 8), rand(40, 256)); }
  const t = tex(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
function gantrySignTex() {
  const [c, g] = canvas(1024, 256);
  const signs = [['DOWNTOWN', '2 km', '↑'], ['HARBOR', 'EXIT 14', '↗'], ['AIRPORT', '18 km', '↑'], ['NEON DISTRICT', '1 km', '↖']];
  signs.forEach(([a, b, arrow], i) => {
    const x = i * 256;
    g.fillStyle = i === 3 ? '#0a3a8a' : '#0b6a3c'; g.fillRect(x, 0, 256, 256);
    g.strokeStyle = '#f2f2f2'; g.lineWidth = 6; g.strokeRect(x + 10, 10, 236, 236);
    g.fillStyle = '#f4f4f4'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `bold ${a.length > 9 ? 28 : 38}px system-ui, sans-serif`; g.fillText(a, x + 128, 80);
    g.font = 'bold 34px system-ui, sans-serif'; g.fillText(b, x + 128, 140);
    g.font = 'bold 64px system-ui, sans-serif'; g.fillText(arrow, x + 128, 205);
  });
  return tex(c);
}
function frondTex() {
  const [c, g] = canvas(64, 256);
  g.clearRect(0, 0, 64, 256);
  g.strokeStyle = '#3a5a22'; g.lineWidth = 3; g.beginPath(); g.moveTo(32, 0); g.lineTo(32, 256); g.stroke();
  for (let y = 6; y < 250; y += 7) {
    const L = 30 * Math.sin((y / 256) * Math.PI) + 4;
    g.strokeStyle = `rgb(${40 + Math.random() * 30},${80 + Math.random() * 40},${30 + Math.random() * 20})`; g.lineWidth = 3;
    g.beginPath(); g.moveTo(32, y); g.lineTo(32 - L, y + 10); g.moveTo(32, y); g.lineTo(32 + L, y + 10); g.stroke();
  }
  const t = tex(c); return t;
}

// ---------------------------------------------------------------- the city
// ================================================================ shared resources (lazy, created once)
let RES = null;
/** All shared materials/textures/geometries of the city kit. Call once a renderer exists (anisotropy is optional). */
export function getCityResources(maxAniso = 4) {
  if (RES) return RES;
  const atlas = buildAtlas();
  for (const t of [atlas.at, atlas.et]) t.anisotropy = maxAniso;
  const gSignMat = new THREE.MeshStandardMaterial({ map: gantrySignTex(), emissive: 0xffffff, roughness: 0.6 });
  gSignMat.emissiveMap = gSignMat.map; gSignMat.emissiveIntensity = 0.55;
  RES = {
    atlas,
    facadeMat: makeFacadeMaterial(atlas),
    NEON_MATS: [0xff2e88, 0x22e6ff, 0x9a5cff, 0xffb040, 0x44ff99].map((c) => new THREE.MeshBasicMaterial({ color: hdr(c, 3) })),
    SIGNS: ['HOTEL', 'BAR', 'CLUB', '24H', 'CAFE', 'TAXI', 'ARCADE', 'MOTEL', 'NOODLE', 'NEON', 'DINER', 'OPEN'].map((t) => {
      const col = pick(['#ff2e88', '#22e6ff', '#ffb040', '#b27cff', '#5dff9a']);
      return { text: t, len: t.length, mat: new THREE.MeshBasicMaterial({ map: signTex(t, col), color: new THREE.Color(2.2, 2.2, 2.2) }) };
    }),
    beaconMat: new THREE.MeshBasicMaterial({ color: hdr(0xff2233, 5) }),
    neonGeo: new THREE.BoxGeometry(0.3, 1, 0.3).translate(0, 0.5, 0),
    signGeo: new THREE.PlaneGeometry(1, 1),
    beaconGeo: new THREE.SphereGeometry(0.4, 8, 6),
    adMat: new THREE.MeshBasicMaterial({ map: buildAdAtlas(), color: new THREE.Color(1.25, 1.25, 1.25) }),
    AD_GEOS: { wall: ADS.map((_, i) => billboardGeo(i, false)), roof: ADS.map((_, i) => billboardGeo(i, true)) },
    steelMat: new THREE.MeshStandardMaterial({ color: 0x6a6e78, metalness: 0.8, roughness: 0.4 }),
    gSignMat,
    concMat: new THREE.MeshStandardMaterial({ map: concreteTex(), roughness: 0.9, metalness: 0.05 }),
    stripMats: [0x22e6ff, 0xff2e88, 0xffb040].map((c) => new THREE.MeshBasicMaterial({ color: hdr(c, 3.5) })),
    lampWhite: new THREE.MeshBasicMaterial({ color: hdr(0xfff0d0, 5) }),
  };
  return RES;
}
/** The single shared building material (atlas facades). Set .envMap = scene.environment for envMapIntensity to apply. */
export const getFacadeMaterial = () => getCityResources().facadeMat;
/** A building mesh (local frame as makeBuildingGeometry). Place with mesh.position / mesh.rotation.y. */
export function makeBuilding(opts = {}) { return new THREE.Mesh(opts.geometry || makeBuildingGeometry(opts), getFacadeMaterial()); }
/** Billboard mesh: plane faces +Z, bottom centre at origin (roof=true adds 4 m legs). ad = 0..14 or random. */
export function makeBillboard(ad = irand(0, ADS.length - 1), roof = false) { const R = getCityResources(); return new THREE.Mesh(R.AD_GEOS[roof ? 'roof' : 'wall'][ad % ADS.length], R.adMat); }
/** Vertical neon blade sign (faces +Z), centred on origin. */
export function makeBladeSign(i = irand(0, 11)) {
  const R = getCityResources(), sg = R.SIGNS[i % R.SIGNS.length], m = new THREE.Mesh(R.signGeo, sg.mat);
  const sh = 0.75 * sg.len + 0.4; m.scale.set(1.25, sh * 1.25, 1); m.userData.height = sh * 1.25; return m;
}
/** Neon edge strip, grows up from origin. */
export function makeNeonStrip(height = 20, colorIndex = irand(0, 4)) {
  const R = getCityResources(), m = new THREE.Mesh(R.neonGeo, R.NEON_MATS[colorIndex % R.NEON_MATS.length]); m.scale.y = height; return m;
}
/** Blinking red aircraft beacon; call updateCityLights(t) each frame to blink all beacons. */
export function makeBeacon() { const R = getCityResources(); return new THREE.Mesh(R.beaconGeo, R.beaconMat); }
export function updateCityLights(t) { if (RES) RES.beaconMat.color.setHex(0xff2233).multiplyScalar(Math.sin(t * 3) > 0.6 ? 6 : 0.3); }

export function createCity(scene, { VIEW_AHEAD, BEHIND, maxAniso = 4 }) {
  const { facadeMat, NEON_MATS, SIGNS, beaconMat, neonGeo, signGeo, beaconGeo, adMat, AD_GEOS, stripMats } = getCityResources(maxAniso);
  const NEAR_GEOS = Array.from({ length: 28 }, () => buildingGeo(false));
  const FAR_GEOS = Array.from({ length: 10 }, () => buildingGeo(true));

  const buildings = [];
  const cursor = { '-1': -BEHIND, '1': -BEHIND, '-2': -BEHIND, '2': -BEHIND };
  const avoid = []; // [D0, D1] ranges kept free of near buildings (overpasses)

  function placeBuilding(b) {
    const far = Math.abs(b.side) === 2, s = Math.sign(b.side);
    const geo = pick(far ? FAR_GEOS : NEAR_GEOS), u = geo.userData;
    b.mesh.geometry = geo;
    b.len = u.w;
    let D = cursor[b.side] + (far ? rand(4, 30) : rand(0.5, 6)) + u.w / 2;
    if (!far) for (const [a0, a1] of avoid) if (D + u.w / 2 > a0 && D - u.w / 2 < a1) D = a1 + u.w / 2 + rand(1, 4);
    b.D = D; cursor[b.side] = D + u.w / 2;
    b.mesh.position.x = far ? s * rand(48, 80) : s * (14.6 + u.dep / 2 + rand(0, 3));
    if (far) { b.neon.visible = b.sign.visible = b.ad.visible = false; b.beacon.visible = u.h > 90; b.beacon.position.set(0, u.h + 0.4, 0); return; }
    // neon edge strip on the road-facing corner
    b.neon.visible = Math.random() < 0.4;
    if (b.neon.visible) {
      b.neon.material = pick(NEON_MATS);
      b.neon.scale.y = u.h1 * rand(0.45, 0.95);
      b.neon.position.set(-s * u.dep / 2, 5.4, (Math.random() < 0.5 ? 1 : -1) * u.w / 2);
    }
    // blade sign
    b.sign.visible = Math.random() < 0.4 && u.h > 14;
    if (b.sign.visible) {
      const sg = pick(SIGNS); b.sign.material = sg.mat;
      const sh = 0.75 * sg.len + 0.4;
      b.sign.scale.set(1.25, sh * 1.25, 1);
      b.sign.position.set(-s * (u.dep / 2 + 1.1), rand(6 + sh / 2, Math.max(7 + sh / 2, Math.min(u.h1 - sh, 18))), u.w / 2 - 1.2);
    }
    // billboard: rooftop (angled to the oncoming camera) or wall screen
    b.ad.visible = false;
    if (u.h > 18 && Math.random() < 0.42) {
      const roof = u.h < 50 && Math.random() < 0.6;
      if (roof || u.h1 > 22) {
        b.ad.visible = true;
        b.ad.geometry = pick(roof ? AD_GEOS.roof : AD_GEOS.wall);
        if (roof) { b.ad.position.set(-s * (u.td / 2 - 3), u.h, rand(-u.tw / 4, u.tw / 4)); b.ad.rotation.y = Math.atan2(-s * 0.55, 0.84); }
        else { b.ad.position.set(-s * (u.dep / 2 + 0.6), rand(9, Math.min(u.h1 - 7, 30)), rand(-u.w / 4, u.w / 4)); b.ad.rotation.y = -s * Math.PI / 2; }
      }
    }
    b.beacon.visible = u.h > 58;
    b.beacon.position.set(0, u.h + 0.4, 0);
  }

  for (const side of [-1, 1, -2, 2]) for (let i = 0; i < (Math.abs(side) === 2 ? 12 : 30); i++) {
    const mesh = new THREE.Mesh(NEAR_GEOS[0], facadeMat);
    const neon = new THREE.Mesh(neonGeo, NEON_MATS[0]);
    const sign = new THREE.Mesh(signGeo, SIGNS[0].mat);
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    const ad = new THREE.Mesh(AD_GEOS.wall[0], adMat);
    mesh.add(neon, sign, beacon, ad);
    scene.add(mesh); markReflective(mesh);
    const b = { mesh, neon, sign, beacon, ad, side, D: 0, len: 10 };
    placeBuilding(b);
    buildings.push(b);
  }

  const structures = [];
  for (let i = 0; i < 3; i++) { const m = makeGantry(); m.visible = false; scene.add(m); markReflective(m); structures.push({ g: m, type: 'gantry', active: false, D: 0 }); }
  for (let i = 0; i < 2; i++) { const m = makeOverpass(); m.visible = false; scene.add(m); markReflective(m); structures.push({ g: m, type: 'overpass', active: false, D: 0 }); }
  let nextStructD = 260, lastDist = 0;

  // ------------------------------------------------ palms along the sidewalks (scrolling, period 36m like the lamps)
  const PALM_P = 36;
  const props = new THREE.Group(); scene.add(props);
  {
    const n = Math.ceil((VIEW_AHEAD + BEHIND) / PALM_P) + 2;
    const o = new THREE.Object3D(), mats = [];
    for (let i = -1; i < n - 1; i++) for (const side of [-1, 1]) {
      o.position.set(side * 12.6, 0.2, -i * PALM_P + (side > 0 ? 9 : 27)); o.rotation.set(0, side > 0 ? Math.PI : 0, 0); o.scale.setScalar(rand(0.85, 1.15)); o.updateMatrix();
      mats.push(o.matrix.clone());
    }
    props.add(makePalms(mats));
  }

  function update(distance, t) {
    // distance reset (new run / back to menu): main shifts buildings + near cursors; shift our own state here
    if (distance < lastDist - 30) {
      const off = lastDist - distance;
      cursor['-2'] -= off; cursor['2'] -= off; nextStructD -= off;
      for (const s of structures) s.D -= off;
      for (const a of avoid) { a[0] -= off; a[1] -= off; }
    }
    lastDist = distance;
    // structures
    if (distance + VIEW_AHEAD + 60 > nextStructD) {
      const type = Math.random() < 0.55 ? 'gantry' : 'overpass';
      const s = structures.find((q) => !q.active && q.type === type) || structures.find((q) => !q.active);
      if (s) {
        s.active = true; s.D = nextStructD; s.g.visible = true;
        if (s.type === 'overpass') { avoid.push([s.D - 9, s.D + 9]); s.g.userData.strip.material = pick(stripMats); }
      }
      nextStructD += rand(320, 620);
    }
    for (const s of structures) {
      if (!s.active) continue;
      if (s.D < distance - BEHIND - 20) { s.active = false; s.g.visible = false; continue; }
      s.g.position.z = -(s.D - distance);
    }
    while (avoid.length && avoid[0][1] < distance - BEHIND - 40) avoid.shift();
    // buildings
    for (const b of buildings) {
      if (b.D + b.len / 2 < distance - BEHIND) placeBuilding(b);
      b.mesh.position.z = -(b.D - distance);
    }
    props.position.z = distance % PALM_P;
    beaconMat.color.setHex(0xff2233).multiplyScalar(Math.sin(t * 3) > 0.6 ? 6 : 0.3);
  }

  let hiQ = true, shown = true;
  function setQuality(hi) {
    hiQ = hi;
    for (const b of buildings) if (Math.abs(b.side) === 2) b.mesh.visible = hi && shown;
  }
  /** show/hide the whole straight-highway city (race mode hides it) */
  function setVisible(v) {
    shown = v; props.visible = v;
    for (const st of structures) st.g.visible = v && st.active;
    for (const b of buildings) b.mesh.visible = v && (Math.abs(b.side) !== 2 || hiQ);
  }

  return { buildings, cursor, update, setQuality, setVisible, facadeMat, structures };
}

// ================================================================ structures & props (world-placeable)

const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
function merge(list) { // plain merge of non-indexed boxes
  const geos = list.map((g) => g.index ? g.toNonIndexed() : g);
  let n = 0; for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2); let o = 0;
  for (const g of geos) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); uv.set(g.attributes.uv.array, o * 2); o += g.attributes.position.count; }
  const r = new THREE.BufferGeometry();
  r.setAttribute('position', new THREE.BufferAttribute(pos, 3)); r.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); r.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  r.computeBoundingSphere(); return r;
}
function worldUV(g, s = 0.12) { // box-project UVs in metres
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
    if (ax > 0.5) uv.setXY(i, p.getZ(i) * s, p.getY(i) * s); else if (ay > 0.5) uv.setXY(i, p.getX(i) * s, p.getZ(i) * s); else uv.setXY(i, p.getX(i) * s, p.getY(i) * s);
  }
  return g;
}

/** Overhead sign gantry spanning a road of half-width ~9.4 m (posts at x=±halfSpan), faces +Z, ground at y=0. */
export function makeGantry(halfSpan = 9.4) {
  const { steelMat, gSignMat, lampWhite } = getCityResources();
  const g = new THREE.Group();
  const frame = merge([
    box(0.45, 8.8, 0.45, -halfSpan, 4.4, 0), box(0.45, 8.8, 0.45, halfSpan, 4.4, 0),
    box(halfSpan * 2 + 0.5, 0.35, 0.35, 0, 8.2, 0), box(halfSpan * 2 + 0.5, 0.35, 0.35, 0, 7.0, 0),
    ...Array.from({ length: Math.round(halfSpan * 1.05) }, (_, k, a) => box(0.12, 1.3, 0.12, -halfSpan + 0.8 + k * ((halfSpan * 2 - 1.6) / (Math.round(halfSpan * 1.05) - 1)), 7.6, 0)),
  ]);
  g.add(new THREE.Mesh(frame, steelMat));
  const n = irand(2, 3), xs = n === 2 ? [-3.6, 3.6] : [-5.6, 0, 5.6];
  const panels = [], lights = [];
  xs.forEach((x) => {
    const i = irand(0, 3), p = new THREE.PlaneGeometry(4.6, 2.7).translate(x, 7.6, 0.25);
    const uv = p.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / 4);
    panels.push(p); lights.push(box(3.6, 0.08, 0.2, x, 6.18, 0.4));
  });
  g.add(new THREE.Mesh(merge(panels), gSignMat), new THREE.Mesh(merge(lights), lampWhite));
  return g;
}
/** Concrete overpass crossing the road (deck along X, length = span, pillars at x=±10.6, ±32, ±55), ground y=0. */
export function makeOverpass(span = 150) {
  const { concMat, stripMats, lampWhite } = getCityResources();
  const g = new THREE.Group();
  const deck = worldUV(merge([
    box(span, 1.7, 11, 0, 8.35, 0), box(span, 1.1, 0.35, 0, 9.75, 5.3), box(span, 1.1, 0.35, 0, 9.75, -5.3),
    ...[-10.6, 10.6, -32, 32, -55, 55].filter((x) => Math.abs(x) < span / 2).map((x) => box(1.6, 7.5, 2.4, x, 3.75, 0)),
    ...[-10.6, 10.6, -32, 32, -55, 55].filter((x) => Math.abs(x) < span / 2).map((x) => box(2.4, 0.6, 9, x, 7.2, 0)),
  ]));
  g.add(new THREE.Mesh(deck, concMat));
  const strip = new THREE.Mesh(box(span, 0.14, 0.14, 0, 7.55, 5.55), pick(stripMats));
  const under = new THREE.Mesh(merge([-6, -2, 2, 6].map((x) => box(0.5, 0.06, 7, x, 7.48, 0))), lampWhite);
  g.add(strip, under);
  g.userData.strip = strip;
  return g;
}

/**
 * Wet asphalt road material. Texture spans the full road width in U (u=0 left edge, u=1 right edge, ROAD_W metres)
 * and one 12 m tile in V: for a ribbon road set uv = (across 0..1, distance / 12) and texture repeat (1,1);
 * for a plane set map.repeat / roughnessMap.repeat to (1, length / 12). lanes = lane centre offsets in metres.
 * Roughness map has puddles; patch with fx.createRoadReflection().patchRoad(mat) for planar wet reflections.
 */
export function makeRoadMaterial({ lanes = [-5.4, -1.8, 1.8, 5.4], roadHalf = 7.2, roadW = 17, maxAniso = 4 } = {}) {
  const px = (m) => (m / roadW + 0.5) * 512;
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#1a1920'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 14000; i++) { const v = (18 + Math.random() * 26) | 0; g.fillStyle = `rgb(${v},${v},${v + 5})`; g.fillRect(Math.random() * 512, Math.random() * 512, 1.6, 1.6); }
  for (const lc of lanes) for (const o of [-0.85, 0.85]) { g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(px(lc + o) - 9, 0, 18, 512); }
  g.fillStyle = '#0f0f14'; g.fillRect(0, 0, px(-roadHalf), 512); g.fillRect(px(roadHalf), 0, 512, 512);
  g.fillStyle = '#efe6c8';
  g.fillRect(px(-roadHalf) - 2, 0, 7, 512); g.fillRect(px(roadHalf) - 5, 0, 7, 512);
  for (let i = 0; i < lanes.length - 1; i++) g.fillRect(px((lanes[i] + lanes[i + 1]) / 2) - 3, 0, 6, 512 * 0.36);
  const map = tex(c, true, maxAniso); map.wrapS = map.wrapT = THREE.RepeatWrapping;
  const [cr, r] = canvas(256, 256);
  r.fillStyle = 'rgb(150,150,150)'; r.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, rr = rand(10, 46);
    const gr = r.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, 'rgba(20,20,20,0.95)'); gr.addColorStop(1, 'rgba(20,20,20,0)');
    r.fillStyle = gr; r.beginPath(); r.ellipse(x, y, rr * 0.7, rr * 1.4, 0, 0, Math.PI * 2); r.fill();
  }
  const rough = tex(cr, false, maxAniso); rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshStandardMaterial({ map, roughnessMap: rough, roughness: 1, metalness: 0.05 });
}
/** Paved sidewalk material (one 6 m x 12 m tile per texture repeat). */
export function makeSidewalkMaterial(maxAniso = 4) {
  const [c, g] = canvas(128, 256);
  g.fillStyle = '#26242c'; g.fillRect(0, 0, 128, 256);
  g.strokeStyle = '#18171c'; g.lineWidth = 2;
  for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(0, i * 32); g.lineTo(128, i * 32); g.stroke(); }
  g.beginPath(); g.moveTo(64, 0); g.lineTo(64, 256); g.stroke();
  g.fillStyle = '#3a3842'; g.fillRect(0, 0, 8, 256);
  const t = tex(c, true, maxAniso); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.8 });
}

/** Palm tree parts for instancing: { trunkGeo, frondGeo, trunkMat, frondMat } (origin at trunk base, ~11 m tall). */
let PALM = null;
export function makePalmParts() {
  if (PALM) return PALM;
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.3, 9, 7, 8, true).translate(0, 4.5, 0);
  const tp = trunkGeo.attributes.position;
  for (let i = 0; i < tp.count; i++) { const y = tp.getY(i); tp.setX(i, tp.getX(i) + 0.012 * y * y); }
  trunkGeo.computeVertexNormals();
  const ring = canvas(32, 128); ring[1].fillStyle = '#4a3a2a'; ring[1].fillRect(0, 0, 32, 128);
  for (let y = 0; y < 128; y += 8) { ring[1].fillStyle = '#2a2018'; ring[1].fillRect(0, y, 32, 3); }
  const rt = tex(ring[0]); rt.wrapS = rt.wrapT = THREE.RepeatWrapping; rt.repeat.set(1, 4);
  const trunkMat = new THREE.MeshStandardMaterial({ map: rt, roughness: 0.9 });
  const fr = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + rand(-0.2, 0.2), L = rand(3.6, 4.6), seg = 6;
    const p = new THREE.PlaneGeometry(1.3, L, 1, seg).translate(0, L / 2, 0).rotateX(-Math.PI / 2);
    const pp = p.attributes.position;
    for (let i = 0; i < pp.count; i++) { const r = -pp.getZ(i); pp.setY(i, 0.45 * r - 0.16 * r * r); }
    p.rotateY(-a).translate(0.012 * 81, 9, 0);
    fr.push(p);
  }
  const frondGeo = mergeIndexed(fr); frondGeo.computeVertexNormals();
  const frondMat = new THREE.MeshStandardMaterial({ map: frondTex(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.8, color: 0x7a9a6a });
  PALM = { trunkGeo, frondGeo, trunkMat, frondMat };
  return PALM;
}
/** Instanced palms (2 draw calls) from an array of Matrix4 world transforms. */
export function makePalms(matrices) {
  const P = makePalmParts(), n = matrices.length;
  const trunks = new THREE.InstancedMesh(P.trunkGeo, P.trunkMat, n), fronds = new THREE.InstancedMesh(P.frondGeo, P.frondMat, n);
  matrices.forEach((m, i) => { trunks.setMatrixAt(i, m); fronds.setMatrixAt(i, m); });
  for (const m of [trunks, fronds]) m.frustumCulled = false;
  const g = new THREE.Group(); g.add(trunks, fronds); return g;
}

/** Streetlight parts for instancing: double-sided arm over the road towards -X. { poleGeo, headGeo, poleMat, headMat } */
export function makeStreetlightParts() {
  const pole = new THREE.CylinderGeometry(0.1, 0.16, 9, 8).translate(0, 4.5, 0).toNonIndexed();
  const arm = new THREE.BoxGeometry(2.8, 0.14, 0.14).translate(-1.3, 8.9, 0).toNonIndexed();
  return {
    poleGeo: mergeGeos([pole, arm]),
    headGeo: new THREE.BoxGeometry(1.3, 0.16, 0.5).translate(-2.3, 8.78, 0),
    poleMat: new THREE.MeshStandardMaterial({ color: 0x2a2a33, metalness: 0.7, roughness: 0.5 }),
    headMat: new THREE.MeshBasicMaterial({ color: hdr(0xffc890, 6) }),
  };
}

function mergeIndexed(list) {
  const pos = [], nor = [], uv = [], idx = []; let o = 0;
  for (const g of list) {
    const p = g.attributes.position, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); uv.push(u.getX(i), u.getY(i)); }
    for (const i of g.index.array) idx.push(i + o); o += p.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  return g;
}

function mergeGeos(list) { return merge(list); }
