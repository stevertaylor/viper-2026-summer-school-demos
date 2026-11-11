/* =====================================================================
 *  shared/gfx.js — rendering infrastructure common to every demo
 *
 *  createPipeline()  HDR post chain:  scene → [MSAA HalfFloat target]
 *                    → bloom → finish (exposure, tone map, sRGB, lens
 *                    vignette, dither) → screen.  Also owns adaptive
 *                    resolution and the fat-line resolution uniform.
 *  FatLine           anti-aliased, constant-pixel-width polyline that can
 *                    be rewritten every frame without reallocating.
 *  CameraFlight      eased camera moves that orbit the target (spherical
 *                    interpolation) instead of cutting straight through it.
 *  reducedMotion     honours the OS "reduce motion" setting.
 *
 *  Why a custom finish pass?  three r160 applies tone mapping and the
 *  linear→sRGB transfer only when drawing to the default framebuffer, so
 *  a composer chain that ends in a bloom pass shows LINEAR values as if
 *  they were sRGB (dark, crushed mid-tones) and ignores the exposure.
 *  The finish pass does exactly what OutputPass does, plus two physically
 *  motivated extras:
 *    • natural vignetting of a thin lens, I ∝ cos⁴θ at field angle θ,
 *      applied to linear radiance (blended in at a modest strength);
 *    • ±1 LSB triangular-PDF dither after the sRGB curve — it removes the
 *      8-bit banding in dark gradients and bloom halos, invisible otherwise.
 * ===================================================================== */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export const reducedMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** With "reduce motion" on, pin OrbitControls.autoRotate to false (idle timers that
 *  re-enable it become no-ops). */
export function respectReducedMotion(controls) {
  if (!reducedMotion) return;
  Object.defineProperty(controls, 'autoRotate', { get: () => false, set: () => {}, configurable: true });
}

/* ---------------------------------------------------------------------
 *  Finish pass
 * ------------------------------------------------------------------- */
const FinishShader = {
  vertexShader: /* glsl */`
    precision highp float;
    uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
    attribute vec3 position; attribute vec2 uv;
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2  uTanHalf;    // (tan(hfov/2), tan(vfov/2))
    uniform float uVignette;   // 0 = off, 1 = full cos^4
    uniform float uDither;     // amplitude in 8-bit LSBs
    uniform float uSeed;
    #include <tonemapping_pars_fragment>
    #include <colorspace_pars_fragment>
    varying vec2 vUv;
    float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031 + uSeed); p3 += dot(p3, p3.yzx + 33.33);
                          return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      // natural vignetting: cos^4(theta), theta = field angle of this pixel
      vec2 t = (vUv * 2.0 - 1.0) * uTanHalf;
      float cos2 = 1.0 / (1.0 + dot(t, t));
      c.rgb *= mix(1.0, cos2 * cos2, uVignette);
      #ifdef LINEAR_TONE_MAPPING
        c.rgb = LinearToneMapping(c.rgb);
      #elif defined(REINHARD_TONE_MAPPING)
        c.rgb = ReinhardToneMapping(c.rgb);
      #elif defined(CINEON_TONE_MAPPING)
        c.rgb = OptimizedCineonToneMapping(c.rgb);
      #elif defined(ACES_FILMIC_TONE_MAPPING)
        c.rgb = ACESFilmicToneMapping(c.rgb);
      #elif defined(AGX_TONE_MAPPING)
        c.rgb = AgXToneMapping(c.rgb);
      #endif
      #ifdef SRGB_TRANSFER
        c = sRGBTransferOETF(c);
      #endif
      // triangular-PDF dither (sum of two uniforms - 1), +/- uDither LSB
      float n = hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 71.7) - 1.0;
      c.rgb += n * uDither / 255.0;
      gl_FragColor = c;
    }`,
};

class FinishPass extends Pass {
  constructor(camera, { vignette = 0.3, dither = 1.0 } = {}) {
    super();
    this.camera = camera;
    this.uniforms = {
      tDiffuse: { value: null },
      toneMappingExposure: { value: 1 },
      uTanHalf: { value: new THREE.Vector2(1, 1) },
      uVignette: { value: vignette },
      uDither: { value: dither },
      uSeed: { value: 0 },
    };
    this.material = new THREE.RawShaderMaterial({
      name: 'FinishShader', uniforms: this.uniforms,
      vertexShader: FinishShader.vertexShader, fragmentShader: FinishShader.fragmentShader,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this._cs = null; this._tm = null;
    this.animateGrain = !reducedMotion;
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.toneMappingExposure.value = renderer.toneMappingExposure;
    const cam = this.camera;
    if (cam && cam.isPerspectiveCamera) {
      const tv = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / (cam.zoom || 1);
      u.uTanHalf.value.set(tv * cam.aspect, tv);
    }
    if (this.animateGrain) u.uSeed.value = (u.uSeed.value + 0.6180339887) % 1;
    if (this._cs !== renderer.outputColorSpace || this._tm !== renderer.toneMapping) {
      this._cs = renderer.outputColorSpace; this._tm = renderer.toneMapping;
      const d = {};
      if (THREE.ColorManagement.getTransfer(this._cs) === THREE.SRGBTransfer) d.SRGB_TRANSFER = '';
      const tm = this._tm;
      if (tm === THREE.LinearToneMapping) d.LINEAR_TONE_MAPPING = '';
      else if (tm === THREE.ReinhardToneMapping) d.REINHARD_TONE_MAPPING = '';
      else if (tm === THREE.CineonToneMapping) d.CINEON_TONE_MAPPING = '';
      else if (tm === THREE.ACESFilmicToneMapping) d.ACES_FILMIC_TONE_MAPPING = '';
      else if (tm === THREE.AgXToneMapping) d.AGX_TONE_MAPPING = '';
      this.material.defines = d; this.material.needsUpdate = true;
    }
    if (this.renderToScreen) { renderer.setRenderTarget(null); this.fsQuad.render(renderer); }
    else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
      this.fsQuad.render(renderer);
    }
  }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

/* ---------------------------------------------------------------------
 *  MSAA scene pass: draw into a multisampled target, let WebGL2 resolve it,
 *  copy the resolved image into the composer's (single-sample) read buffer.
 * ------------------------------------------------------------------- */
class MSAARenderPass extends Pass {
  constructor(scene, camera, samples) {
    super();
    this.scene = scene; this.camera = camera; this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples });
    this.target.texture.name = 'pipeline.msaa';
    this.copy = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      // NaN/Inf guard: with MSAA, partially covered pixels are shaded with extrapolated varyings,
      // so e.g. pow(negative, p) in any scene shader can yield NaN — and the bloom blur would
      // smear one such pixel into a black rectangle. Zero non-finite samples before bloom.
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
        void main(){ vec4 c = texture2D(tDiffuse, vUv);
          if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
          gl_FragColor = max(c, 0.0); }`,
      blending: THREE.NoBlending, depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.copy);
  }
  setSize(w, h) { this.target.setSize(w, h); }
  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.copy.uniforms.tDiffuse.value = this.target.texture;     // resolved on unbind
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.fsQuad.render(renderer);
  }
  dispose() { this.target.dispose(); this.copy.dispose(); this.fsQuad.dispose(); }
}

/* ---------------------------------------------------------------------
 *  Fat-line resolution registry (LineMaterial needs the viewport in px)
 * ------------------------------------------------------------------- */
const _lineMats = new Set();
const _cssSize = new THREE.Vector2(innerWidth, innerHeight);
export function trackLineMaterial(mat) {
  _lineMats.add(mat); mat.resolution.copy(_cssSize); return mat;
}

/* ---------------------------------------------------------------------
 *  createPipeline
 * ------------------------------------------------------------------- */
/**
 * @param {object} o
 *   renderer, scene, camera   required
 *   bloom: [strength, radius, threshold]   (UnrealBloomPass args; threshold on LINEAR luminance)
 *   vignette  cos^4 vignetting blend, 0..1  (default 0.3)
 *   dither    LSB amplitude                 (default 1.0)
 *   msaa      samples for the scene target  (default 4; 0 disables)
 *   adaptive  drop pixel ratio under sustained load (default true)
 *   maxPixelRatio (default min(devicePixelRatio, 2))
 */
export function createPipeline(o) {
  const { renderer, scene, camera } = o;
  const maxPR = o.maxPixelRatio ?? Math.min(devicePixelRatio || 1, 2);
  renderer.setPixelRatio(maxPR);

  const canMSAA = renderer.capabilities.isWebGL2 &&
    (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
  const samples = canMSAA ? (o.msaa ?? 4) : 0;
  // Only the SCENE draw is multisampled. The composer's ping-pong targets are single-sample:
  // UnrealBloomPass composites additively back into its read buffer, so an MSAA composer
  // target would make bloom (and every later pass) pay 4-sample bandwidth at full resolution.
  const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
  rt.texture.name = 'pipeline.rt1';
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(maxPR);           // a supplied target resets the composer's ratio to 1

  const renderPass = samples ? new MSAARenderPass(scene, camera, samples) : new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const [bs, br, bt] = o.bloom ?? [0.75, 0.6, 0.82];
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), bs, br, bt);
  composer.addPass(bloom);
  const finish = new FinishPass(camera, { vignette: o.vignette ?? 0.3, dither: o.dither ?? 1.0 });
  composer.addPass(finish);

  // ---- adaptive resolution (with hysteresis and cautious recovery) ----
  // rAF intervals are vsync-quantised, so "too slow" is easy to detect but headroom is not.
  // Drop one rung when the smoothed frame time stays above 22 ms (< ~45 fps). Single hitches
  // (>100 ms) and the warm-up after load / tab switch are ignored. After 15 s of comfortable
  // frames (< 18 ms) we probe one rung up; if that rung fails within 4 s it becomes the ceiling,
  // so a transient load (another app, a shader compile) does not cost resolution for good.
  const ladder = [2, 1.75, 1.5, 1.25, 1].filter(p => p <= maxPR + 1e-6);
  if (!ladder.length || ladder[0] < maxPR - 1e-6) ladder.unshift(maxPR);
  let rung = 0, ceiling = 0, ema = 0, nS = 0, last = 0, probeAt = -1e9;
  let warmUntil = performance.now() + 2500, changedAt = performance.now();
  const adaptive = o.adaptive ?? true;
  document.addEventListener('visibilitychange', () => { warmUntil = performance.now() + 1500; ema = 0; nS = 0; last = 0; });
  function adapt(now) {
    if (!adaptive) return;
    const dt = last ? now - last : 0; last = now;
    if (!dt || dt > 100 || now < warmUntil) return;
    ema = ema ? ema + 0.04 * (dt - ema) : dt;
    if (++nS < 45) return;                                     // ~0.75 s of samples first
    if (ema > 22 && rung < ladder.length - 1) {
      if (now - probeAt < 4000) ceiling = rung + 1;            // the probed rung was not sustainable
      rung++; setPR(ladder[rung], now);
    } else if (ema < 18 && rung > ceiling && now - changedAt > 15000) {
      rung--; probeAt = now; setPR(ladder[rung], now);
    }
  }
  function setPR(pr, now) {
    changedAt = now; warmUntil = now + 1000; ema = 0; nS = 0;
    renderer.setPixelRatio(pr);
    composer.setPixelRatio(pr);
  }

  let w = 0, h = 0;
  const api = {
    composer, bloom, finish, renderPass, renderTarget: renderPass.target ?? rt, composerTarget: rt,
    get pixelRatio() { return renderer.getPixelRatio(); },
    get msaa() { return samples; },
    setSize(width, height, updateStyle = true) {
      w = width; h = height;
      renderer.setSize(w, h, updateStyle);
      composer.setSize(w, h);
      _cssSize.set(w, h);
      for (const m of _lineMats) m.resolution.set(w, h);
    },
    render() {
      adapt(performance.now());
      composer.render();
    },
  };
  if (typeof window !== 'undefined') window.__gfx = api;   // debugging: __gfx.pixelRatio, __gfx.msaa
  return api;
}

/* ---------------------------------------------------------------------
 *  FatLine — Line2 with in-place point updates
 * ------------------------------------------------------------------- */
function fatLineMaterial(o) {
  const transparent = (o.opacity ?? 1) < 1 || !!o.additive || !!o.transparent;
  const mat = new LineMaterial({
    color: o.color ?? 0xffffff, linewidth: o.width ?? 1.5,
    transparent, opacity: o.opacity ?? 1,
    dashed: !!o.dashed, dashSize: o.dashSize ?? 0.5, gapSize: o.gapSize ?? 0.3, dashScale: 1,
    depthTest: o.depthTest ?? true, depthWrite: o.depthWrite ?? !transparent,
    worldUnits: false,
  });
  if (o.additive) mat.blending = THREE.AdditiveBlending;
  return trackLineMaterial(mat);
}

/** Disjoint fat segments (replacement for THREE.LineSegments). Same options as FatLine
 *  (no dashes/loop). setSegments(flat) takes 6 numbers per segment: x0 y0 z0 x1 y1 z1. */
export class FatSegments extends LineSegments2 {
  constructor(nSegs, o = {}) {
    const geo = new LineSegmentsGeometry();
    geo.setPositions(new Float32Array(Math.max(nSegs, 1) * 6));
    super(geo, fatLineMaterial({ ...o, dashed: false }));
    this.nSegs = nSegs; this.frustumCulled = false;
    if (o.segments) this.setSegments(o.segments);
  }
  setSegments(flat) {
    const buf = this.geometry.attributes.instanceStart.data;
    const a = buf.array, m = Math.min(a.length, flat.length);
    for (let i = 0; i < m; i++) a[i] = flat[i];
    buf.needsUpdate = true;
    return this;
  }
  get opacity() { return this.material.opacity; }
  set opacity(v) { this.material.opacity = v; }
}

const _p = new THREE.Vector3(), _q = new THREE.Vector3();
export class FatLine extends Line2 {
  /**
   * @param {number} n   number of points (fixed)
   * @param {object} o   color, width (CSS px), opacity, additive, dashed, dashSize, gapSize,
   *                     loop (close the polyline), depthTest, depthWrite, points (initial)
   */
  constructor(n, o = {}) {
    const loop = !!o.loop, m = loop ? n + 1 : n;
    const geo = new LineGeometry();
    geo.setPositions(new Float32Array(Math.max(m, 2) * 3));
    super(geo, fatLineMaterial(o));
    this.n = n; this.loop = loop; this.frustumCulled = false;
    if (this.material.dashed) this.computeLineDistances();
    if (o.points) this.setPoints(o.points);
  }
  /** pts: array of Vector3 (length n) or flat numeric array (length 3n) */
  setPoints(pts) {
    const n = this.n, flat = typeof pts[0] === 'number';
    const buf = this.geometry.attributes.instanceStart.data, a = buf.array;
    const get = (i, out) => flat ? out.set(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]) : out.copy(pts[i]);
    const segs = this.loop ? n : n - 1;
    const p = _p, q = _q;
    for (let s = 0; s < segs; s++) {
      get(s, p); get((s + 1) % n, q);
      a[6 * s] = p.x; a[6 * s + 1] = p.y; a[6 * s + 2] = p.z;
      a[6 * s + 3] = q.x; a[6 * s + 4] = q.y; a[6 * s + 5] = q.z;
    }
    buf.needsUpdate = true;
    if (this.material.dashed) {
      const db = this.geometry.attributes.instanceDistanceStart.data, d = db.array;
      let acc = 0;
      for (let s = 0; s < segs; s++) {
        d[2 * s] = acc;
        acc += Math.hypot(a[6 * s + 3] - a[6 * s], a[6 * s + 4] - a[6 * s + 1], a[6 * s + 5] - a[6 * s + 2]);
        d[2 * s + 1] = acc;
      }
      db.needsUpdate = true;
    }
    return this;
  }
  set color(c) { this.material.color.set(c); }
  get opacity() { return this.material.opacity; }
  set opacity(v) { this.material.opacity = v; }
}

/* ---------------------------------------------------------------------
 *  CameraFlight — orbit-aware eased moves
 * ------------------------------------------------------------------- */
// smootherstep: C2-continuous ease-in-out (zero velocity AND acceleration at both ends)
const smoother = k => k * k * k * (k * (6 * k - 15) + 10);
export class CameraFlight {
  constructor(camera, controls) {
    this.camera = camera; this.controls = controls; this.f = null; this.onDone = null;
    controls.addEventListener('start', () => this.cancel());   // a real grab takes over
  }
  get active() { return !!this.f; }
  cancel() { this.f = null; }
  /** fly to camera position `pos` looking at `tgt` (arrays or Vector3). dur in seconds. */
  to(pos, tgt = [0, 0, 0], dur = 1.2) {
    const P = pos.isVector3 ? pos.clone() : new THREE.Vector3(...pos);
    const T = tgt.isVector3 ? tgt.clone() : new THREE.Vector3(...tgt);
    const t0 = this.controls.target.clone(), p0 = this.camera.position.clone();
    const o0 = p0.clone().sub(t0), o1 = P.clone().sub(T);
    if (reducedMotion || dur <= 0 || o0.lengthSq() < 1e-12 || o1.lengthSq() < 1e-12) {
      this.f = null; this.camera.position.copy(P); this.controls.target.copy(T); this.controls.update();
      this.onDone?.(); return;
    }
    const r0 = o0.length(), r1 = o1.length();
    const q = new THREE.Quaternion().setFromUnitVectors(o0.clone().divideScalar(r0), o1.clone().divideScalar(r1));
    this.f = { e: 0, dur, t0, t1: T, r0, r1, d0: o0.divideScalar(r0), q, qi: new THREE.Quaternion() };
  }
  /** keep the current target, change only the distance */
  toDistance(d, dur = 1.2) {
    const t = this.controls.target, p = this.camera.position.clone().sub(t).setLength(d).add(t);
    this.to(p, t.clone(), dur);
  }
  update(dt) {
    const f = this.f; if (!f) return false;
    f.e = Math.min(1, f.e + dt / f.dur);
    const k = smoother(f.e);
    this.controls.target.lerpVectors(f.t0, f.t1, k);
    f.qi.identity().slerp(f.q, k);
    const r = f.r0 * Math.pow(f.r1 / f.r0, k);               // geometric in radius: constant zoom rate
    this.camera.position.copy(f.d0).applyQuaternion(f.qi).multiplyScalar(r).add(this.controls.target);
    if (f.e >= 1) { this.f = null; this.onDone?.(); }
    return true;
  }
}

