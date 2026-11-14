// Entry for the three.js build the Home page loads (website/assets/js/vendor/three.min.js).
// Only the classes the hero scene uses are exported, so the published file stays small.
// Rebuild from the repository root after changing this list or upgrading `three`:
//   npx esbuild website/_vendor/three-entry.js --bundle --format=esm --minify \
//     --legal-comments=inline --outfile=website/assets/js/vendor/three.min.js
export {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "three";
