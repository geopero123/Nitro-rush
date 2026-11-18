// Visual effects: wet-road planar reflection (low-res, only bright/emissive things on layer REFLECT),
// tyre smoke, takedown debris, nitro flame shader.
import * as THREE from 'three';

export const REFLECT = 1;
const rand = (a, b) => a + Math.random() * (b - a);

/** enable the reflection layer on an object tree (it stays visible in the main view too) */
export function markReflective(obj) { obj.traverse((o) => o.layers.enable(REFLECT)); }

// ---------------------------------------------------------------- wet road reflection
export function createRoadReflection(renderer, scene, camera) {
  const rt = new THREE.WebGLRenderTarget(256, 128, { type: THREE.HalfFloatType, depthBuffer: true });
  rt.texture.generateMipmaps = false;
  const rcam = new THREE.PerspectiveCamera();
  rcam.layers.set(REFLECT);
  const texMat = new THREE.Matrix4();
  const uniforms = { tRefl: { value: rt.texture }, reflMat: { value: texMat }, reflK: { value: 0 } };
  const camPos = new THREE.Vector3(), look = new THREE.Vector3(), rot = new THREE.Matrix4(), N = new THREE.Vector3(0, 1, 0);
  const clearCol = new THREE.Color(); let enabled = true;
  const pr = [0, 0];

  function patchRoad(mat) {
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 reflMat; varying vec4 vRefl;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvRefl = reflMat * modelMatrix * vec4(transformed, 1.0);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D tRefl; uniform float reflK; varying vec4 vRefl;')
        .replace('#include <opaque_fragment>', `
if (reflK > 0.0) {
  vec2 ruv = vRefl.xy / vRefl.w;
  float wet = clamp(1.0 - roughnessFactor * 1.15, 0.0, 1.0);
  float spread = mix(0.03, 0.008, wet);           // rough asphalt = long blurry streaks, puddles = sharp
  vec3 rc = vec3(0.0);
  rc += texture2D(tRefl, ruv + vec2(0.0, -2.0 * spread)).rgb * 0.12;
  rc += texture2D(tRefl, ruv + vec2(0.0, -1.0 * spread)).rgb * 0.22;
  rc += texture2D(tRefl, ruv).rgb * 0.32;
  rc += texture2D(tRefl, ruv + vec2(0.0, 1.0 * spread)).rgb * 0.22;
  rc += texture2D(tRefl, ruv + vec2(0.0, 2.0 * spread)).rgb * 0.12;
  outgoingLight += rc * reflK * mix(0.28, 0.95, wet);
}
#include <opaque_fragment>`);
    };
    mat.needsUpdate = true;
  }

  function setSize(w, h) { rt.setSize(Math.max(64, Math.round(w / 4)), Math.max(32, Math.round(h / 4))); }

  function render(active = true) {
    if (!enabled || !active) { uniforms.reflK.value = 0; return; }
    uniforms.reflK.value = 0.75;
    camera.updateMatrixWorld();
    camPos.setFromMatrixPosition(camera.matrixWorld);
    rot.extractRotation(camera.matrixWorld);
    look.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    rcam.position.set(camPos.x, -camPos.y, camPos.z);
    rcam.up.set(0, 1, 0).applyMatrix4(rot).reflect(N);
    rcam.lookAt(look.x, -look.y, look.z);
    rcam.far = 260; rcam.near = camera.near;
    rcam.updateMatrixWorld();
    rcam.projectionMatrix.copy(camera.projectionMatrix);
    rcam.projectionMatrix.elements[8] *= -1; rcam.projectionMatrix.elements[12] *= -1;
    texMat.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(rcam.projectionMatrix).multiply(rcam.matrixWorldInverse);
    rcam.projectionMatrixInverse.copy(rcam.projectionMatrix).invert();
    const prevRT = renderer.getRenderTarget(), prevBg = scene.background, prevFog = scene.fog.density;
    renderer.getClearColor(clearCol); const ca = renderer.getClearAlpha();
    scene.background = null; scene.fog.density *= 1.6;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, rcam);
    renderer.setRenderTarget(prevRT); renderer.setClearColor(clearCol, ca);
    scene.background = prevBg; scene.fog.density = prevFog;
  }
  return { patchRoad, render, setSize, setEnabled(v) { enabled = v; if (!v) uniforms.reflK.value = 0; }, rt };
}

// ---------------------------------------------------------------- tyre smoke (soft billboards)
export function createSmoke(scene, max = 64) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.18)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  const mat = new THREE.MeshBasicMaterial({ map: t, color: 0x8a8296, transparent: true, depthWrite: false, opacity: 1, fog: true });
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, max);
  mesh.frustumCulled = false; mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  scene.add(mesh);
  const P = Array.from({ length: max }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, s: 1 }));
  let idx = 0; const o = new THREE.Object3D(), col = new THREE.Color();
  return {
    emit(x, y, z, n, vz = 0) {
      for (let i = 0; i < n; i++) {
        const q = P[idx]; idx = (idx + 1) % max;
        q.p.set(x + rand(-0.6, 0.6), y, z + rand(-0.3, 0.3)); q.v.set(rand(-1.5, 1.5), rand(0.4, 1.6), vz + rand(2, 7)); q.max = q.life = rand(0.6, 1.2); q.s = rand(0.8, 1.4);
      }
    },
    update(dt, camera) {
      for (let i = 0; i < max; i++) {
        const q = P[i];
        if (q.life > 0) {
          q.life -= dt; q.p.addScaledVector(q.v, dt); q.v.multiplyScalar(1 - dt * 1.5);
          const k = 1 - q.life / q.max;
          o.position.copy(q.p); o.quaternion.copy(camera.quaternion); o.scale.setScalar(q.s * (1 + k * 3));
          col.setScalar(Math.max(0, 1 - k) * 0.9);
        } else { o.scale.setScalar(0); col.setScalar(0); }
        o.updateMatrix(); mesh.setMatrixAt(i, o.matrix); mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
    },
    clear() { for (const q of P) q.life = 0; },
  };
}

// ---------------------------------------------------------------- takedown debris (glass + body shards)
export function createDebris(scene, max = 90) {
  const geo = new THREE.TetrahedronGeometry(0.16);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.3, envMapIntensity: 1.6 });
  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.frustumCulled = false; mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
  scene.add(mesh);
  const P = Array.from({ length: max }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), life: 0, s: 1 }));
  let idx = 0; const o = new THREE.Object3D(), glass = new THREE.Color(0.55, 0.7, 0.85);
  return {
    burst(x, y, z, n, color, vz = 0) {
      for (let i = 0; i < n; i++) {
        const q = P[idx]; mesh.setColorAt(idx, i % 3 === 0 ? glass : color); idx = (idx + 1) % max;
        q.p.set(x + rand(-0.8, 0.8), y + rand(0, 0.8), z + rand(-1, 1)); q.v.set(rand(-7, 7), rand(2, 9), vz + rand(-4, 6));
        q.w.set(rand(-15, 15), rand(-15, 15), rand(-15, 15)); q.life = rand(0.8, 1.6); q.s = rand(0.5, 1.6);
      }
      mesh.instanceColor.needsUpdate = true;
    },
    update(dt) {
      for (let i = 0; i < max; i++) {
        const q = P[i];
        if (q.life > 0) {
          q.life -= dt; q.v.y -= 20 * dt; q.p.addScaledVector(q.v, dt);
          if (q.p.y < 0.05) { q.p.y = 0.05; q.v.y *= -0.3; q.v.x *= 0.6; q.v.z *= 0.6; q.w.multiplyScalar(0.6); }
          q.r.x += q.w.x * dt; q.r.y += q.w.y * dt; q.r.z += q.w.z * dt;
          o.position.copy(q.p); o.rotation.copy(q.r); o.scale.setScalar(q.s * Math.min(1, q.life * 2));
        } else o.scale.setScalar(0);
        o.updateMatrix(); mesh.setMatrixAt(i, o.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    clear() { for (const q of P) q.life = 0; },
  };
}

// ---------------------------------------------------------------- nitro flame (animated shader cone)
export function createFlameMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, power: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float time; uniform float power; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      void main(){
        float along = vUv.y;                 // 1 at the nozzle, 0 at the tip (cone uv)
        float across = abs(vUv.x - 0.5) * 2.0;
        float flick = n(vec2(vUv.x * 6.0, along * 5.0 - time * 28.0));
        float body = smoothstep(0.0, 0.85, along) * (0.55 + 0.6 * flick);
        float core = smoothstep(0.55, 1.0, along);
        vec3 col = mix(vec3(0.15, 0.35, 1.6), vec3(1.4, 1.2, 1.6), core);
        col = mix(col, vec3(1.6, 0.6, 0.15), smoothstep(0.35, 0.0, along) * 0.6);
        gl_FragColor = vec4(col * body * power * (1.0 - across * 0.3), 1.0);
      }`,
  });
}
