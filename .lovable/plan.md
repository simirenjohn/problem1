## Goals
1. Faster/sharper tile loading (pixel build-up feels slow).
2. Flying to a point should land at the highest useful resolution automatically.
3. Audible beep as the user approaches a target coordinate in the GPS compass.
4. Show live GPS accuracy more prominently.

## Changes

### 1. Faster tile rendering — `src/components/map/MapView.tsx`
On every `<TileLayer>`:
- `keepBuffer={4}` (pre-load a wider ring around the viewport)
- `updateWhenIdle={false}` + `updateWhenZooming={false}` (paint tiles progressively but avoid firing during pinch)
- `crossOrigin="anonymous"` and `tileSize={256}`
- Raise the Google hybrid/satellite `maxNativeZoom` from 20 → 21 (Google serves z21 in most areas; Leaflet already upscales cleanly beyond that thanks to `maxZoom={22}`)
- Add a global CSS rule for `.leaflet-tile { image-rendering: -webkit-optimize-contrast; }` in `src/styles.css` so upscaled tiles look crisper instead of blurry.

### 2. Fly-to at maximum resolution
Change `FlyHandler` and `FitHandler` so any fly action (from coordinate list, project fit, GPS "Center", target selection) targets **zoom 21** by default instead of 17. `flyTo` calls in `src/routes/index.tsx` that don't pass a `zoom` will inherit the new default. Existing callers that pass a zoom keep their value.

### 3. Proximity beep + louder accuracy — `src/components/gps/GpsCompass.tsx`
- Add a small WebAudio helper (no asset) that generates a short sine-wave beep. Frequency and repeat interval scale with distance:
  - > 50 m: silent
  - 50–20 m: single beep every 2 s (low pitch, 600 Hz)
  - 20–5 m: beep every 800 ms (900 Hz)
  - 5–1 m: beep every 300 ms (1200 Hz)
  - < 1 m: continuous fast chirp (1500 Hz) + one-shot "arrived" chime
- Trigger on the existing `targetDistance` computation via a `useEffect` timer; unlock the AudioContext on the first user interaction (the "Start tracking" / expand button already provides a user gesture).
- Add a mute/unmute toggle icon in the compass header (volume-on/off), persisted to `localStorage`.
- Promote the accuracy readout: colour-code it (green ≤5 m, amber ≤15 m, red >15 m), and also render the accuracy value on the collapsed floating button as a tiny pill so the user always sees it without expanding.

### 4. No other files change
Business logic, projects, coords, OCR — untouched.

## Technical notes
- Leaflet's `keepBuffer` + `updateWhenIdle=false` is the standard fix for the "grey tiles filling in slowly" symptom; combined with a higher `maxNativeZoom`, deep zooms will fetch real tiles instead of upscaling from z18.
- WebAudio `OscillatorNode` + `GainNode` is enough — no audio file needed, keeping bundle size flat.
- All beep scheduling lives inside `GpsCompass`; cleaned up when tracking stops or the component unmounts.
