# Changelog

## 0.3.1

- Draco data that doesn't match its accessors rejects with a `DracoMismatchError`. Its `kind` says whether the vertex count, index count, component count, component type, attribute id or a shared accessor disagrees, and its fields give the mesh, primitive, semantic, accessor, and declared and decoded values. ([#4](https://github.com/richardmonette/usd-gltf/issues/4))
- An opt-in `recoverDracoCounts` option converts files whose Draco counts disagree with their accessors. It uses the decoded counts and reports them through `log`, but only when nothing else depends on the declared counts and the decoded positions match the declared bounds. ([#4](https://github.com/richardmonette/usd-gltf/issues/4))
- Draco indices too large for the accessor's component type are an error; they used to wrap around silently. So are Draco indices past the decoded vertex count.
- Two Draco primitives decoding one accessor to different data is an error. Previously the last one decoded won.

## 0.3.0

- Draco compressed glTF (`KHR_draco_mesh_compression`) converts. The decoder is loaded only when a file needs it: the `draco3d` package in Node, an optional peer dependency, or Google's CDN build in browsers, pinned to version 1.5.7 and checked against its SHA-256 before it runs. A `dracoDecoder` option takes your own.
- Conformance includes the 16 Draco compressed Khronos sample models (318 conversions).

## 0.2.0

- glTF assets that require an extension the converter can't honour, such as Draco (`KHR_draco_mesh_compression`) or KTX2 textures (`KHR_texture_basisu`), are rejected with an error naming it, instead of converting zero-filled geometry. Optional Draco and KTX2 use their uncompressed fallbacks. ([#3](https://github.com/richardmonette/usd-gltf/issues/3))
- glTF primitives that share vertex data become one USD Mesh with a GeomSubset per primitive, and each USD Mesh keeps only the vertices it references, so vertex data is no longer written once per primitive. The usdc writer stores identical arrays once. ([#1](https://github.com/richardmonette/usd-gltf/issues/1))
- Sparse accessors read the wrong bytes when a resolver returned a Node `Buffer` (its `slice()` shares memory). Found by the new bounds checks.
- Opt-in `maxDecodedBytes`, `maxOutputBytes` and `signal` options on the conversion functions, with a `ConversionLimitError`. Accessors, bufferViews, sparse data, usdc counts, zip entries and inflate output are bounds checked before allocating, whatever the limits. ([#2](https://github.com/richardmonette/usd-gltf/issues/2))
- Conformance checks every Khronos sample model as `.glb` and embedded `.gltf` too, not just `.gltf` (302 conversions).
- GLB round trip tests in the regular test suite, using a generated model, so they run without the corpora.

## 0.1.0

- USD to glTF and glTF to USD in pure JavaScript, in Node and browsers: usda, usdc and usdz input and output, USD composition (sublayers, references, payloads, inherits, specializes, variant sets), meshes, UsdPreviewSurface and MaterialX preview materials, UsdSkel skinning and blend shapes, animation, material and animation variants, cameras, lights and point instancers.
- glTF to USD keeps what UsdPreviewSurface can't express in the material's `customData`, so converting back is lossless, including `KHR_animation_pointer` animations and `KHR_materials_variants`.
- Decoders for PNG, JPEG, WebP and meshopt compressed glTF buffers, with the platform image decoder used in browsers.
- Conformance with every Apple AR Quick Look gallery model and every Khronos glTF sample model, checked against OpenUSD and the Khronos glTF Validator (`npm run conformance`).
- TypeScript declarations.

## 0.0.1

- Name reserved on npm.
