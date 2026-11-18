# Nitro Rush

Neon night-city arcade racer for Android, built with Three.js and Capacitor.

## Install on your phone
Open the latest **Release** on this repo from your phone, download `NitroRush.apk` and install it (allow "install unknown apps" for your browser when asked).

## Controls
- Hold **left / right** side of the screen to steer (or switch to **tilt** in Settings)
- **Swipe up** or tap **NITRO** to boost
- Pass cars closely for **near misses** (fills nitro)
- Ram cars while boosting for **takedowns** (trucks will wreck you)
- Hit the ramps and steer in the air for a **barrel roll**

## Develop
```
npm install
npm run dev        # play in browser (keyboard: arrows + space)
npm run build && npx cap sync android
```
Every push to `main` builds a new APK with GitHub Actions and publishes it as a release.

## Credits
- Ferrari 458 Italia model by vicent091036 (Sketchfab, CC BY 4.0), from the three.js examples (`mrdoob/three.js/examples/models/gltf/ferrari.glb`). Also used, simplified, as a traffic/rival car.
- Traffic cars (sedan, sports sedan, taxi, police, SUVs, van, pickups, delivery/box truck, garbage truck): **Kenney Car Kit** by Kenney (https://kenney.nl/assets/car-kit), CC0 1.0, taken from the npm package `@netforge/asset-library-files` 0.2.0 (https://www.npmjs.com/package/@netforge/asset-library-files, its NOTICE lists the Kenney Car Kit as CC0). Recoloured, re-proportioned and re-materialed.
- "Car Concept" by Eric Chadwick, © Darmstadt Graphics Group GmbH (based on a CC0 model by Unity Fan), CC BY 4.0, from Khronos glTF Sample Assets (https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept). Simplified, textures removed.
- City, road, billboards (fictional brands), music and sound are generated in code.

`public/models/traffic.glb` is produced by `tools/build-traffic.mjs` (gltf-transform + meshoptimizer; see the header of that file).
