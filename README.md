# usd-gltf

Convert between [OpenUSD](https://openusd.org/) and [glTF](https://www.khronos.org/gltf/) in both directions, in pure JavaScript with no dependencies. Runs in Node and the browser, [live demo](https://richardmonette.github.io/usd-gltf/examples/). Reads and writes all three USD encodings: text `.usda`, binary crate `.usdc`, and the `.usdz` package.

> Work in progress, not yet published to npm.

```
npm install usd-gltf
```

```js
import { usdToGLB, glbToUSD } from 'usd-gltf';

const glb = await usdToGLB( usdzBytes );
const usdz = await glbToUSD( glbBytes ); // or { format: 'usda' } / { format: 'usdc' }
```

Files that reference other files (a `.gltf` with `.bin` and textures, or a `.usda` with sublayers and references) need a `resolver` that returns the bytes for a relative path:

```js
const usdz = await glbToUSD( gltfBytes, { resolver: ( uri ) => readFile( join( dir, uri ) ) } );
```

```
npx usd-gltf model.usdz model.glb
npx usd-gltf model.glb model.usdz
```

## What converts

USD to glTF composes the stage first (sublayers, references, payloads, inherits, specializes, variant sets) and then converts:

- Xform hierarchies, every xformOp type, animated transforms, up axis and `metersPerUnit`
- Meshes with any primvar interpolation, indexed primvars, GeomSubsets, holes and left handed orientation; Points, BasisCurves and the intrinsic shapes
- `UsdPreviewSurface` networks and MaterialX graphs built from `ND_UsdPreviewSurface`, `ND_standard_surface` and `ND_open_pbr_surface`, with textures repacked when glTF needs a different channel layout
- UsdSkel skeletons, skinning and blend shapes
- Material variant sets as `KHR_materials_variants`, animation variant sets as separate glTF animations
- Cameras, UsdLux lights as `KHR_lights_punctual`, PointInstancers

glTF to USD writes `UsdPreviewSurface` materials, UsdSkel skins and blend shapes, time sampled animation, variant sets for material variants and multiple animations, cameras and lights. glTF features that `UsdPreviewSurface` can't express (transmission, sheen, iridescence, ...) are kept in the material's `customData`, so converting back to glTF is lossless.

## Conformance

Current status:

- All 18 USD files in Apple's AR Quick Look gallery convert to GLB. Per mesh triangle counts and world space bounds at the start, middle and end of each animation match OpenUSD with skinning baked, and the Khronos glTF Validator reports no errors. (The gallery's three `.reality` files are RealityKit's format, not USD.)
- All 150 Khronos glTF sample models convert to USDZ that OpenUSD's validators accept with no errors or warnings, with geometry matching the source at several animation times, and convert back to glTF with identical materials, material variants and animations.

The acceptance corpora are every model in [Apple's AR Quick Look gallery](https://developer.apple.com/augmented-reality/quick-look/) and every model in the [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets). Conversions are checked against Pixar's OpenUSD (`usd-core`) and the Khronos glTF Validator: per mesh triangle counts and world space bounds at several animation times, with skinning baked by OpenUSD, must match.

```
node scripts/fetch-corpus.js
```

## License

MIT
