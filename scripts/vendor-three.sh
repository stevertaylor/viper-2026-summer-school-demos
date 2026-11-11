#!/usr/bin/env bash
# Vendor Three.js (pinned 0.160.0) so every demo runs with ZERO internet access
# (USB stick, lecture-hall WiFi outage). Run once, from anywhere:
#
#     bash scripts/vendor-three.sh
#
# What it does, in order (aborts before touching any demo if a step fails):
#   1. downloads three.module.js + every addon the five demos import, plus those
#      addons' own transitive imports, into vendor/three-0.160.0/
#   2. verifies the import closure: every relative import inside the vendored
#      files must exist on disk, and the only bare specifier may be 'three'
#   3. flips each demo's <script type="importmap"> from unpkg.com to ../vendor/
#
# Idempotent (safe to re-run). To revert: git checkout -- '*/index.html' && rm -rf vendor/
# Note: sed -i '' below is the macOS/BSD form.
set -euo pipefail
cd "$(dirname "$0")/.."

V=0.160.0
BASE="https://unpkg.com/three@${V}"
DEST="vendor/three-${V}"

# Everything the five demos import (verified against their <script type="module">
# headers), plus the addons' transitive imports:
#   all demos:        OrbitControls, EffectComposer, RenderPass, UnrealBloomPass
#   pulsar-gw:        + TransformControls, OutputPass
#   gw-binary-primer: + OutputPass
#   geodesic-delay:   + Line2, LineGeometry, LineMaterial (→ LineSegments2, LineSegmentsGeometry)
#   shared/gfx.js:    Pass (FullScreenQuad), Line2, LineSegments2, LineGeometry, LineSegmentsGeometry,
#                     LineMaterial, EffectComposer, RenderPass, UnrealBloomPass — all listed below
#   transitive:       ShaderPass, MaskPass, Pass (postprocessing internals);
#                     CopyShader, LuminosityHighPassShader, OutputShader
FILES="
build/three.module.js
LICENSE
examples/jsm/controls/OrbitControls.js
examples/jsm/controls/TransformControls.js
examples/jsm/postprocessing/EffectComposer.js
examples/jsm/postprocessing/RenderPass.js
examples/jsm/postprocessing/ShaderPass.js
examples/jsm/postprocessing/MaskPass.js
examples/jsm/postprocessing/Pass.js
examples/jsm/postprocessing/UnrealBloomPass.js
examples/jsm/postprocessing/OutputPass.js
examples/jsm/shaders/CopyShader.js
examples/jsm/shaders/LuminosityHighPassShader.js
examples/jsm/shaders/OutputShader.js
examples/jsm/lines/Line2.js
examples/jsm/lines/LineSegments2.js
examples/jsm/lines/LineGeometry.js
examples/jsm/lines/LineSegmentsGeometry.js
examples/jsm/lines/LineMaterial.js
"

echo "Downloading three@${V} into ${DEST}/ ..."
for f in $FILES; do
  out="${DEST}/$(echo "$f" | sed -e 's#^build/##' -e 's#^examples/jsm/#jsm/#')"
  mkdir -p "$(dirname "$out")"
  curl -fsSL "${BASE}/${f}" -o "$out"
  echo "  + $out"
done

echo "Verifying import closure ..."
fail=0
for js in $(find "$DEST/jsm" -name '*.js'); do
  dir=$(dirname "$js")
  for spec in $(grep -oE "from ['\"][^'\"]+['\"]" "$js" | sed -E "s/from ['\"]([^'\"]+)['\"]/\1/"); do
    case "$spec" in
      three) ;;                                  # bare specifier — resolved by the importmap
      ./*|../*)
        if [ ! -f "$dir/$spec" ]; then echo "  MISSING: $js imports $spec"; fail=1; fi ;;
      *) echo "  UNEXPECTED bare import '$spec' in $js"; fail=1 ;;
    esac
  done
done
if [ "$fail" -ne 0 ]; then
  echo "Closure incomplete — add the missing file(s) to FILES and re-run. No demo was modified."
  exit 1
fi
echo "  closure complete."

echo "Rewriting importmaps (CDN -> ../vendor/) ..."
for d in gw-binary-primer geodesic-delay-demo pulsar-gw-demo hellings-downs-demo binary-minidisk-photometry; do
  sed -i '' \
    -e "s#https://unpkg.com/three@${V}/build/three.module.js#../vendor/three-${V}/three.module.js#" \
    -e "s#https://unpkg.com/three@${V}/examples/jsm/#../vendor/three-${V}/jsm/#" \
    "${d}/index.html"
  echo "  + ${d}/index.html"
done

echo
echo "Done. Smoke-test locally from the repo root (file:// will NOT work — ES modules):"
echo "    python3 -m http.server 8000     # then open http://localhost:8000/"
echo "Then commit vendor/ + the five index.html files to deploy."
