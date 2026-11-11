# VIPER 2026 Summer School — Interactive Demos

A set of self-contained, browser-based demos on pulsar timing and
gravitational waves, built for the [VIPER](https://as.vanderbilt.edu/viper/)
summer school. Everything is static HTML — no install, no server, no build step.

**Live site:** https://stevertaylor.github.io/viper-2026-summer-school-demos/

## The demos

| Demo | Topic |
|------|-------|
| **Gravitational Waves from Compact Binaries** | A primer on gravitational waves — watch a binary radiate a two-armed wave at the speed of light, stretch a ring of test masses in the plus and cross polarizations, and tune the chirp mass, frequency, and distance. |
| **Why the Quadrupole?** | Try to radiate with a pulsing star (monopole) or a shaken mass (dipole) — conservation laws silence you. Live multipole meters show why gravitational radiation begins at the quadrupole. |
| **Pulse Delays Along the Geodesic** | Integrate the metric perturbation along a photon's geodesic and watch the whole path collapse to the Earth term and the pulsar term. |
| **Pulsar Timing & Gravitational Waves** | A passing GW from a supermassive black-hole binary nudges a pulsar's pulse arrival times — drag the pulsar and source in 3D and watch the timing residual respond. |
| **Cross-Correlating Pulsars** | Cross-correlate pulsar pairs across a sky of GW sources until they collapse onto the Hellings & Downs curve — the fingerprint of a GW background. |
| **Binary Black-Hole Light Curves** | A supermassive black-hole binary feeding through two minidisks inside a circumbinary disk flickers like a clock — disentangle relativistic Doppler boosting, self-lensing flares, and accretion modulation. |

## Structure

```
index.html                  ← the hub (landing page + iframe launcher)
pulsar-gw-demo/index.html
hellings-downs-demo/index.html
geodesic-delay-demo/index.html
binary-minidisk-photometry/index.html
gw-binary-primer/index.html
why-the-quadrupole/index.html
shared/gfx.js               ← rendering pipeline shared by all demos (see below)
shared/sky.js               ← the real sky: diffuse star map + Bright Star Catalog, at infinity
shared/sky/                 ← sky data (milkyway.jpg, bsc5.js, ng15.js) — built, committed
scripts/build_sky.py        ← rebuilds shared/sky/ from the public catalogs
scripts/vendor-three.sh     ← one-shot: bundle Three.js locally (already run — see vendor/)
vendor/three-0.160.0/       ← vendored Three.js + addons; the demos' importmaps point here
```

## Shared rendering

Every demo imports `shared/gfx.js` and `shared/sky.js` (plain ES modules, no build):

- **HDR pipeline.** The scene is rendered into a 4× MSAA half-float target, then
  bloom, then a finish pass that applies exposure, ACES tone mapping, the sRGB
  transfer, a cos⁴ lens vignette and ±1 LSB dither. (The canvas's own `antialias`
  flag has no effect once you render through an `EffectComposer`, and without an
  output pass three r160 shows linear values as if they were sRGB.)
- **Adaptive resolution.** If the smoothed frame time stays above ~22 ms the pixel
  ratio steps down (2 → 1.75 → … → 1). `__gfx.pixelRatio` in the console shows the
  current value.
- **Fat lines** (`FatLine`, `FatSegments`): anti-aliased, constant pixel width,
  updated in place each frame.
- **Camera flights** orbit the target with C²-smooth easing; the OS
  *reduce motion* setting turns flights into cuts and disables auto-rotation.
- **The real sky**, J2000: NASA/GSFC SVS *Deep Star Maps 2020* (Hipparcos-2,
  Tycho-2, Gaia DR2; credit NASA/Goddard Space Flight Center Scientific
  Visualization Studio, Gaia DR2: ESA/Gaia/DPAC) for the diffuse light, plus the
  9096 stars of the Yale Bright Star Catalog as point sources coloured by the
  blackbody chromaticity of T_eff(B−V). Displayed star brightness is a stated
  display stretch (√flux), not photometry. NANOGrav 15-yr pulsar positions
  (ATNF Pulsar Catalogue) are in `shared/sky/ng15.js`.

Sky assets total ~1.5 MB and are fetched once (cached across demos). To rebuild
them, see the docstring of `scripts/build_sky.py`.

The hub hosts exactly one demo in an `<iframe>` at a time and tears it down on
exit, so only one WebGL context / animation loop is ever live — memory and CPU
stay flat.

## Adding a new demo

1. Drop a self-contained `new-demo/index.html` into the repo.
2. Add **one** entry to the `DEMOS` array in the root `index.html`:

   ```js
   {
     id:'new-demo',
     title:'My New Demo',
     tag:'Short label',
     accent:'#5ec8e6',
     path:'new-demo/index.html',
     blurb:'One or two sentences describing it.'
   },
   ```

3. Commit and push. It's live in ~30 s.

Keep each demo a single `index.html`. The only external dependency is Three.js,
loaded through each demo's `<script type="importmap">` — either from the pinned
CDN (`https://unpkg.com/three@0.160.0/…`) or, after running the vendor script
below, from the local `../vendor/` copy. If you must add another CDN resource,
use **HTTPS** (the site is served over HTTPS; `http://` is blocked as mixed
content) — or better, vendor it.

## Offline / USB use (no internet)

Three.js (pinned 0.160.0) and every addon the demos use are **vendored in
`vendor/`**, and each demo's importmap points there — nothing is fetched from a
CDN, so the site runs with zero internet access (USB stick, flaky lecture-hall
WiFi) and the live site is immune to CDN hiccups.

To serve offline, copy the repo anywhere and run a one-line server from its
root (ES modules don't load over `file://`, so double-clicking `index.html`
won't work):

```bash
python3 -m http.server 8000     # then open http://localhost:8000/
```

`scripts/vendor-three.sh` is the script that set this up (download → verify the
import closure → rewrite the importmaps). It's idempotent; re-run it only if
you bump the Three.js version pin.

## Local preview

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

(Opening `index.html` directly via `file://` can break the iframes in some
browsers — use the local server.)
