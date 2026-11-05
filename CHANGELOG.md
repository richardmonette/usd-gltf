# Changelog

## Unreleased

- USD to glTF and glTF to USD in pure JavaScript, in Node and browsers: usda, usdc and usdz input and output, USD composition (sublayers, references, payloads, inherits, specializes, variant sets), meshes, UsdPreviewSurface and MaterialX preview materials, UsdSkel skinning and blend shapes, animation, material and animation variants, cameras, lights and point instancers.
- glTF to USD keeps what UsdPreviewSurface can't express in the material's `customData`, so converting back is lossless, including `KHR_animation_pointer` animations and `KHR_materials_variants`.
- Decoders for PNG, JPEG, WebP and meshopt compressed glTF buffers, with the platform image decoder used in browsers.
- Conformance with every Apple AR Quick Look gallery model and every Khronos glTF sample model, checked against OpenUSD and the Khronos glTF Validator (`npm run conformance`).
- TypeScript declarations.

## 0.0.1

- Name reserved on npm.
