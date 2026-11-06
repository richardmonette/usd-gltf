# usd-gltf

Convert between [OpenUSD](https://openusd.org/) and [glTF](https://www.khronos.org/gltf/) (`.glb`, or `.gltf` with embedded or external files) in both directions, in pure JavaScript with no dependencies. Runs in Node and the browser, [live demo](https://richardmonette.github.io/usd-gltf/examples/). Reads and writes all three USD encodings: text `.usda`, binary crate `.usdc`, and the `.usdz` package.

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

glTF to USD writes `UsdPreviewSurface` materials, UsdSkel skins and blend shapes, time sampled animation, variant sets for material variants and multiple animations, cameras and lights. glTF features that `UsdPreviewSurface` can't express (transmission, sheen, iridescence, ...) are kept in the material's `customData`, so converting back to glTF is lossless. Primitives of a mesh that share their vertex data become one USD Mesh with a GeomSubset per primitive, and each Mesh keeps only the vertices it uses, so vertex data is never repeated per primitive.

glTF compression: meshopt (`EXT_meshopt_compression`, `KHR_meshopt_compression`), `KHR_mesh_quantization` and Draco (`KHR_draco_mesh_compression`, see below) are decoded. KTX2 textures (`KHR_texture_basisu`) are not: an asset that requires them fails with an error naming the extension, and when they are optional the PNG or JPEG fallback is used.

### Draco

usd-gltf doesn't bundle a Draco decoder; it loads Google's only when a file is Draco compressed, and uses the uncompressed fallback without loading anything when a file has one.

- **Node:** install [`draco3d`](https://www.npmjs.com/package/draco3d) alongside, an optional peer dependency, and Draco files just work: `npm install draco3d`.
- **Browsers:** the decoder (about 250 KB) is fetched from Google's CDN, `www.gstatic.com/draco/versioned/decoders/1.5.7/`, pinned to that version and checked against its SHA-256 before it runs. This needs a secure context, and a Content Security Policy that allows the fetch, `unsafe-eval` and WebAssembly.
- **Your own:** pass a decoder module as `dracoDecoder` to use a self hosted copy, or where the CDN isn't allowed:

```js
import draco3d from 'draco3d';
const usdz = await glbToUSD( glb, { dracoDecoder: await draco3d.createDecoderModule() } );
```

## Limits

Input size alone doesn't bound how much memory a conversion needs: an accessor can declare millions of vertices with no data behind them, and compressed geometry and images expand when decoded. Both directions take opt-in limits:

```js
const usdz = await glbToUSD( glb, {
	maxDecodedBytes: 512 * 2 ** 20, // decoded data held during the conversion
	maxOutputBytes: 256 * 2 ** 20, // any output buffer: the layer, the usdz or glb, as it grows
	signal: AbortSignal.timeout( 30000 ), // cancellation
} );
```

- `maxDecodedBytes` counts, before each allocation: glTF accessors (including ones without a bufferView) and meshopt decoding; USD crate arrays, compressed sections and zip entries; images, from the size in their header; and the arrays written into the converted USD layer, so data referenced many times is counted every time it is written. It is not a limit on the whole process's memory: the input, its parsed JSON or USD text, and other transient copies aren't counted.
- `maxOutputBytes` is checked as the usdc, usda and glb writers grow and before the final usdz or glb buffer is allocated.
- `signal` is checked between prims, nodes, meshes, materials and layers. A cancelled conversion rejects with the signal's reason and returns nothing. To stop work that is in a single long step, run the conversion in a worker and terminate it.

Going over a limit rejects with a `ConversionLimitError` whose `stage`, `resource` (`'decoded'` or `'output'`), `limit` and `attempted` say what was too big; it never includes input data or file names. Without limits nothing changes. Sizes that can't be right (an accessor reading past its bufferView, a count too big to allocate, a zip entry inflating past its stated size) are rejected whatever the limits.

## Conformance

Current status:

- All 18 USD files in Apple's AR Quick Look gallery convert to GLB. Per mesh triangle counts and world space bounds at the start, middle and end of each animation match OpenUSD with skinning baked, and the Khronos glTF Validator reports no errors. (The gallery's three `.reality` files are RealityKit's format, not USD.)
- All 150 Khronos glTF sample models convert to USDZ that OpenUSD's validators accept with no errors or warnings, with geometry matching the source at several animation times, and convert back to glTF with identical materials, material variants and animations. Each model is checked as `.gltf`, and also as `.glb` (120 models), embedded `.gltf` (32 models) and Draco compressed (16 models) where the sample set has those versions: 318 conversions in all.

The acceptance corpora are every model in [Apple's AR Quick Look gallery](https://developer.apple.com/augmented-reality/quick-look/) and every model in the [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets). Conversions are checked against Pixar's OpenUSD (`usd-core`) and the Khronos glTF Validator: per mesh triangle counts and world space bounds at several animation times, with skinning baked by OpenUSD, must match.

To run it locally (needs Python with `pip install usd-core`, in a `.venv` here or on `PATH`):

```
npm run fetch-corpus
npm run conformance
```

The [Conformance workflow](.github/workflows/conformance.yml) runs the same check in CI.

## License

MIT
