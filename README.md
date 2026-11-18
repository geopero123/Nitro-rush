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
Ferrari 458 Italia model by vicent091036 (Sketchfab, CC BY 4.0), from the three.js examples.
