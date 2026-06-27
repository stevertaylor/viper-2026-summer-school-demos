# VIPER 2026 Summer School — Interactive Demos

A set of self-contained, browser-based demos on pulsar timing and
gravitational waves, built for the [VIPER](https://as.vanderbilt.edu/viper/)
summer school. Everything is static HTML — no install, no server, no build step.

**Live site:** https://stevertaylor.github.io/viper-2026-summer-school-demos/

## The demos

| Demo | Topic |
|------|-------|
| **Pulsar Timing & Gravitational Waves** | A passing GW from a supermassive black-hole binary nudges a pulsar's pulse arrival times — drag the pulsar and source in 3D and watch the timing residual respond. |
| **Cross-Correlating Pulsars** | Cross-correlate pulsar pairs across a sky of GW sources until they collapse onto the Hellings & Downs curve — the fingerprint of a GW background. |
| **Pulse Delays Along the Geodesic** | Integrate the metric perturbation along a photon's geodesic and watch the whole path collapse to the Earth term and the pulsar term. |
| **Binary Black-Hole Light Curves** | A supermassive black-hole binary feeding through two minidisks inside a circumbinary disk flickers like a clock — disentangle relativistic Doppler boosting, self-lensing flares, and accretion modulation. |

## Structure

```
index.html                  ← the hub (landing page + iframe launcher)
pulsar-gw-demo/index.html
hellings-downs-demo/index.html
geodesic-delay-demo/index.html
binary-minidisk-photometry/index.html
```

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

Keep each demo a single self-contained `index.html` and use **HTTPS** for any
CDN resources (the site is served over HTTPS; `http://` resources are blocked
as mixed content).

## Local preview

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

(Opening `index.html` directly via `file://` can break the iframes in some
browsers — use the local server.)
