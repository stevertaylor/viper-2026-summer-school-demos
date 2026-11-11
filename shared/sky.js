/* =====================================================================
 *  shared/sky.js — the real sky, at infinity
 *
 *  Two layers, both in J2000 equatorial coordinates:
 *   1. Diffuse sky: NASA/GSFC SVS "Deep Star Maps 2020" (Hipparcos-2 +
 *      Tycho-2 + Gaia DR2, 1.7e9 stars), plate carrée, stored asinh-encoded
 *      in 8 bits (see scripts/build_sky.py) and decoded here to linear
 *      radiance, so it enters the HDR pipeline like any other light.
 *      Stellar cores are clipped in the map; bright stars come from (2).
 *   2. Point stars: Yale Bright Star Catalog (9096 stars, V ≲ 6.5).
 *      Colour  = the sRGB chromaticity of a blackbody at the star's
 *                effective temperature, T(B−V) from Ballesteros (2012,
 *                EPL 97, 34008), integrated against the CIE 1931 2°
 *                colour-matching functions (Wyman, Sloan & Shirley 2013
 *                multi-lobe fit, <1% error) → XYZ → linear sRGB (D65).
 *      Brightness: the true flux range (Sirius/V=6.5 ≈ 1600×) cannot be
 *                shown on a display, so displayed energy E = F^½ (a stated
 *                display stretch, NOT physics); the sprite diameter grows
 *                as E^0.35 and the peak is set so the sprite's integrated
 *                light stays ∝ E even when the diameter is clamped.
 *      No twinkling: scintillation is an atmospheric effect, and these
 *      scenes are in space.
 *
 *  Both layers are drawn "at infinity": the vertex shader drops the view
 *  translation and pins depth to the far plane, so there is no parallax
 *  and no dependence on the camera's far distance.
 *
 *  Frames.  Object space of the sky group is equatorial (x̂ → RA 0h on the
 *  equator, ẑ → north celestial pole).  The group's rotation maps it into
 *  the scene:
 *    'equatorial'  NCP → scene +Y,  vernal equinox → +X
 *    'ecliptic'    ecliptic north pole → scene +Y, vernal equinox → +X
 *                  (so an Earth tilted by the obliquity ε = 23.439° points
 *                   its spin axis at the real NCP, near Polaris)
 *  sky.dir(raDeg, decDeg) and sky.pole always use the group's CURRENT
 *  rotation, so anything placed with them stays registered with the stars.
 * ===================================================================== */
import * as THREE from 'three';
import { BSC5_COUNT, BSC5_B64 } from './sky/bsc5.js';
import { NG15 } from './sky/ng15.js';
import { reducedMotion } from './gfx.js';

export const OBLIQUITY_J2000 = THREE.MathUtils.degToRad(23.4392811);   // IAU 2006, at J2000
const L0 = 0.006, LCLIP = 0.25;                                       // must match build_sky.py

/* ---------- blackbody colour ---------- */
function cieXYZbar(l) {   // Wyman, Sloan & Shirley (2013), JCGT 2(2), multi-lobe Gaussian fit
  const g = (x, m, s1, s2) => { const t = (x - m) / (x < m ? s1 : s2); return Math.exp(-0.5 * t * t); };
  return [
    1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2),
    0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1),
    1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8),
  ];
}
const C2 = 1.438776877e-2;   // second radiation constant hc/k [m K]
/** linear-sRGB colour of a blackbody at temperature T [K], normalised to luminance Y = 1 */
export function blackbodyRGB(T) {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 5) {
    const lm = l * 1e-9, B = 1 / (lm ** 5 * (Math.exp(C2 / (lm * T)) - 1));
    const [x, y, z] = cieXYZbar(l); X += B * x; Y += B * y; Z += B * z;
  }
  X /= Y; Z /= Y; Y = 1;
  const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  const b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [Math.max(r, 0), Math.max(g, 0), Math.max(b, 0)];
}
/** Ballesteros (2012) effective temperature from B−V */
export const bvToTeff = bv => 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));

// 128-entry LUT in log T, 1500 K … 40000 K
const LUT_N = 128, LT0 = Math.log(1500), LT1 = Math.log(40000);
const LUT = Array.from({ length: LUT_N }, (_, i) => blackbodyRGB(Math.exp(LT0 + (LT1 - LT0) * i / (LUT_N - 1))));
function bbLookup(T, out) {
  const f = THREE.MathUtils.clamp((Math.log(T) - LT0) / (LT1 - LT0), 0, 1) * (LUT_N - 1);
  const i = Math.min(LUT_N - 2, Math.floor(f)), w = f - i, a = LUT[i], b = LUT[i + 1];
  out[0] = a[0] + (b[0] - a[0]) * w; out[1] = a[1] + (b[1] - a[1]) * w; out[2] = a[2] + (b[2] - a[2]) * w;
  return out;
}

/* ---------- catalog decode ---------- */
function decodeBSC() {
  const bin = atob(BSC5_B64), dv = new DataView(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
  const out = [];
  for (let i = 0; i < BSC5_COUNT; i++) {
    const o = 8 * i;
    const ra = (dv.getInt16(o, true) + 32768) / 65536 * 360;
    const dec = dv.getInt16(o + 2, true) / 32767 * 90;
    const v = dv.getInt16(o + 4, true) / 1000;
    const bvq = dv.getInt16(o + 6, true);
    out.push({ ra, dec, v, bv: bvq === -32768 ? null : bvq / 1000 });
  }
  return out;
}
/** equatorial unit vector (object space of the sky group) */
export function eqVec(raDeg, decDeg, out = new THREE.Vector3()) {
  const a = THREE.MathUtils.degToRad(raDeg), d = THREE.MathUtils.degToRad(decDeg);
  return out.set(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d));
}

function frameQuaternion(frame) {
  // columns = scene images of the equatorial basis vectors x̂, ŷ, ẑ
  const m = new THREE.Matrix4();
  if (frame === 'ecliptic') {
    const s = Math.sin(OBLIQUITY_J2000), c = Math.cos(OBLIQUITY_J2000);
    m.set(1, 0, 0, 0,
          0, -s, c, 0,
          0, -c, -s, 0,
          0, 0, 0, 1);
  } else {
    m.set(1, 0, 0, 0,
          0, 0, 1, 0,
          0, -1, 0, 0,
          0, 0, 0, 1);
  }
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/* ---------- shaders ---------- */
const AT_INFINITY = /* glsl */`
  vec4 atInfinity(vec3 dir){
    vec4 p = projectionMatrix * vec4(mat3(modelViewMatrix) * dir, 1.0);
    return p.xyww;                         // depth pinned to the far plane
  }`;

const mwVert = /* glsl */`
  varying vec3 vDir;
  ${AT_INFINITY}
  void main(){ vDir = position; gl_Position = atInfinity(position); }`;
const mwFrag = /* glsl */`
  uniform sampler2D map;
  uniform float uGain, uK, uL0;
  varying vec3 vDir;
  const float PI = 3.141592653589793;
  void main(){
    vec3 d = normalize(vDir);
    float ra = atan(d.y, d.x), dec = asin(clamp(d.z, -1.0, 1.0));
    float u = 0.5 - ra / (2.0 * PI);          // map centred on RA 0h, RA increasing to the left
    float v = 0.5 + dec / PI;
    // seam-free derivatives (Tarini): take the u-gradient from whichever of the two
    // parameterisations (cut at RA 0h or at 12h) is continuous at this pixel
    float ua = fract(u), ub = fract(u + 0.5) - 0.5;
    vec2 ga = vec2(dFdx(ua), dFdy(ua)), gb = vec2(dFdx(ub), dFdy(ub));
    vec2 gu = vec2(abs(ga.x) < abs(gb.x) ? ga.x : gb.x, abs(ga.y) < abs(gb.y) ? ga.y : gb.y);
    vec3 E = textureGrad(map, vec2(ua, v), vec2(gu.x, dFdx(v)), vec2(gu.y, dFdy(v))).rgb;
    vec3 L = uL0 * sinh(E * uK);              // exact inverse of the build-time asinh encoding
    gl_FragColor = vec4(L * uGain, 1.0);
  }`;

const starVert = /* glsl */`
  attribute vec3 aCol;
  attribute float aE;
  uniform float uPR, uGain, uSize, uFade;
  varying vec3 vCol;
  ${AT_INFINITY}
  void main(){
    gl_Position = atInfinity(position);
    float d0 = uSize * pow(aE, 0.35);            // natural diameter [CSS px]
    float d  = clamp(d0, 1.8, 10.0);
    gl_PointSize = d * uPR;
    // peak scales so the sprite's integrated light is ∝ aE even when d is clamped
    float I = uGain * uFade * aE * (uSize * uSize) / (d * d);
    vCol = aCol * I;
  }`;
const starFrag = /* glsl */`
  varying vec3 vCol;
  void main(){
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(q, q);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vCol * exp(-4.5 * r2), 1.0);   // Gaussian PSF, ~1/e^2 at the sprite edge
  }`;

/**
 * createSky(scene, opts)
 *   frame      'equatorial' | 'ecliptic'    (default 'equatorial')
 *   rotation   extra THREE.Euler / Quaternion applied after the frame (cosmetic framing)
 *   mwGain     diffuse-sky gain on linear radiance (default 0.55)
 *   starGain   point-star gain (default 0.55)
 *   starSize   sprite diameter of a V = 6.5 star, CSS px (default 1.9)
 *   magLimit   faintest V drawn (default 6.5)
 *   renderer   (optional) for anisotropic filtering of the map
 * returns { group, dir(ra,dec), pole, setFade(f), loaded:Promise }
 */
export function createSky(scene, o = {}) {
  const group = new THREE.Group(); group.name = 'sky';
  group.quaternion.copy(frameQuaternion(o.frame ?? 'equatorial'));
  if (o.rotation) {
    const q = o.rotation.isQuaternion ? o.rotation : new THREE.Quaternion().setFromEuler(o.rotation);
    group.quaternion.premultiply(q);
  }
  scene.add(group);

  // ---- diffuse layer ----
  const mwMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, uGain: { value: 0 }, uK: { value: Math.asinh(LCLIP / L0) }, uL0: { value: L0 } },
    vertexShader: mwVert, fragmentShader: mwFrag,
    side: THREE.BackSide, depthTest: false, depthWrite: false,
    blending: THREE.AdditiveBlending, transparent: false,
  });
  const mw = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), mwMat);
  mw.frustumCulled = false; mw.renderOrder = -1000; mw.visible = false;
  group.add(mw);

  // ---- point stars ----
  const magLimit = o.magLimit ?? 6.5;
  const cat = decodeBSC().filter(s => s.v <= magLimit);
  const n = cat.length, pos = new Float32Array(3 * n), col = new Float32Array(3 * n), E = new Float32Array(n);
  const v3 = new THREE.Vector3(), c3 = [0, 0, 0];
  cat.forEach((s, i) => {
    eqVec(s.ra, s.dec, v3); pos.set([v3.x, v3.y, v3.z], 3 * i);
    bbLookup(bvToTeff(s.bv ?? 0.65), c3); col.set(c3, 3 * i);
    E[i] = Math.pow(10, -0.2 * (s.v - 6.5));      // = (flux / flux_{V=6.5})^{1/2}
  });
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sg.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  sg.setAttribute('aE', new THREE.BufferAttribute(E, 1));
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uPR: { value: 1 }, uGain: { value: o.starGain ?? 0.55 }, uSize: { value: o.starSize ?? 1.9 }, uFade: { value: 1 } },
    vertexShader: starVert, fragmentShader: starFrag,
    depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: false,
  });
  const stars = new THREE.Points(sg, starMat);
  stars.frustumCulled = false; stars.renderOrder = -999;
  stars.onBeforeRender = r => { starMat.uniforms.uPR.value = r.getPixelRatio(); };
  group.add(stars);

  // ---- async map load, fade in ----
  let mwGain = o.mwGain ?? 0.55;
  let fadeStart = 0;
  const loaded = new Promise(res => {
    new THREE.TextureLoader().load(new URL('./sky/milkyway.jpg', import.meta.url).href, tex => {
      tex.colorSpace = THREE.NoColorSpace;            // encoded data, decoded in the shader
      tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
      if (o.renderer) tex.anisotropy = Math.min(8, o.renderer.capabilities.getMaxAnisotropy());
      mwMat.uniforms.map.value = tex; mw.visible = true;
      fadeStart = performance.now(); res(tex);
    }, undefined, () => res(null));
  });
  mw.onBeforeRender = () => {
    const k = reducedMotion ? 1 : Math.min(1, (performance.now() - fadeStart) / 1400);
    mwMat.uniforms.uGain.value = mwGain * k * k * (3 - 2 * k) * api.fade;
  };

  const api = {
    group, mw, stars, loaded, fade: 1,
    /** scene-frame unit vector toward (RA, Dec) in degrees */
    dir(raDeg, decDeg, out = new THREE.Vector3()) { return eqVec(raDeg, decDeg, out).applyQuaternion(group.quaternion); },
    /** north celestial pole in the scene frame */
    get pole() { return new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion); },
    setFade(f) { api.fade = f; starMat.uniforms.uFade.value = f; },
    setGains({ mw: g1, stars: g2 } = {}) {
      if (g1 !== undefined) mwGain = g1;
      if (g2 !== undefined) starMat.uniforms.uGain.value = g2;
    },
  };
  return api;
}

/** The 68 NANOGrav 15-yr pulsars: [{name, ra, dec}] (degrees, J2000) */
export const NANOGRAV_15YR = NG15.map(([name, ra, dec]) => ({ name, ra, dec }));
