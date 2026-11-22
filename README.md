# Physics Playground

A mobile-first, offline-ready 3D rigid-body sandbox tuned for Android phones. Spawn cubes, spheres and cylinders into a glass arena, grab and fling them with a finger, and switch gravity between Earth, Moon, Mars, zero-G and inverted.

**Stack:** React 19 · Tailwind CSS 4 · Lucide icons · Three.js · [Rapier](https://rapier.rs) (`@dimforge/rapier3d-compat`, WASM) · Vite + `vite-plugin-pwa`

```bash
npm install
npm run dev        # http://localhost:5173 (also exposed on your LAN for testing on a phone)
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/ (service worker active, so offline mode can be tested)
```

To try it on an Android phone, open the dev server's network URL in Chrome. For the full offline/PWA experience, deploy `dist/` to any static HTTPS host and use **Add to Home screen**. The build uses a relative base, so a sub-folder path such as GitHub Pages works too.

## Features

| Area | What it does |
| --- | --- |
| **Boot** | `await RAPIER.init()` runs behind a loading spinner, and the simulation only mounts once the WASM runtime and the 3D bundle are both ready. A WebGL check and a retry path cover failures. |
| **Arena** | 8 × 8 × 8 m glass box: lit floor with an anti-aliased glowing grid, fresnel glass walls and ceiling (the ceiling contains inverted gravity), a neon edge frame, and one shadow-casting directional light. |
| **HUD** | Live FPS (colour-coded), `bodies / 150` with a fill bar and a recycle icon at the cap, and an instant **Clear** button that flashes a confirmation sweep. |
| **Gestures** | A floating **Grab / Orbit** toggle. *Grab* (default): one finger grabs, drags and flings bodies, and two-finger pinch zooms. *Orbit*: one finger orbits, and pinch zooms. |
| **Spawner** | Cube / Sphere / Cylinder buttons. Tap to spawn one, or press and hold to keep spawning. Colours walk the hue wheel by the golden angle, so neighbours stay distinct, and the button icons preview the next colour. |
| **Environment dock** | Slide-up drawer with gravity presets (−9.81, −1.62, −3.71, 0, +9.81 m/s²), a restitution slider (dead thud → superball) and a friction slider (ice glide → high grip). All changes apply live. While it's open, the 3D view slides and zooms into the uncovered area, and picking still lines up. |
| **Haptics** | `navigator.vibrate`: 10 ms spawn tick, 15 ms grab tap, 30 ms fling, and a 20 ms collision rumble on fast floor/wall impacts, limited to one every 120 ms. It no-ops where unsupported and can be toggled in the dock. |
| **Offline** | A Workbox service worker precaches everything (about 5 MB, mostly Rapier's inlined WASM). Updates prompt instead of auto-reloading, so a running simulation is never wiped. |
| **Persistence** | Gravity, sliders, mode and the haptics toggle are remembered in `localStorage`. If storage is unavailable the app still works, with in-memory settings. |

## How the key safeguards work

All physics and rendering live in `src/engine/PhysicsEngine.ts`, outside React. React talks to it through a few methods and a stats callback that fires about twice a second, so nothing in the 60 fps path re-renders React.

- **Fixed-step physics with interpolation.** Rapier steps at a fixed 1/60 s (at most 4 substeps per frame). Rendering interpolates between the last two physics states, so 90 and 120 Hz Android screens stay smooth.
- **Camera interference safeguard.** The engine's `pointerdown` listener is registered before `OrbitControls`, in the capture phase. On a hit it sets `controls.enabled = false` and stops propagation before OrbitControls ever sees the touch. Controls are re-enabled when the finger lifts (`pointerup`, `pointercancel` or `lostpointercapture`).
- **Collider sync safeguard.** A grabbed body is switched to `KinematicPositionBased`, and each physics step calls `setNextKinematicTranslation()` toward the finger's point on a camera-facing drag plane. Meshes only ever copy transforms out of Rapier. The target is clamped inside the glass and the step speed is capped, so a fast swipe can't tunnel the body through a pile.
- **Throw.** The finger's path on the drag plane is recorded from every coalesced pointer event, before clamping, so a swipe that pins the body against the glass still throws it into the glass. On release, the velocity over the last 80 ms (with the release moment as the final sample, so a finger that stopped first throws nothing) becomes an impulse `J = m·v` (capped at 26 m/s), plus a little tumble in the direction of travel.
- **Fat-finger picking.** Rapier `castRay` runs from the touch point first, then from rings of rays 14 px and 28 px around it, so small or distant bodies are still easy to grab.
- **Body cap.** At 150 live bodies, a new spawn recycles the oldest sleeping body (or the oldest at all if none is asleep). It shrinks out, and its neighbours are woken so the pile resettles.
- **Sleeping.** Rapier sleeps each contact island on its own. On top of that, the engine applies explicit thresholds (`SLEEP_SPEED_LIMIT` 0.12 m/s, `SLEEP_ANGULAR_LIMIT` 0.25 rad/s, `SLEEP_TIME_LIMIT` 0.6 s). Once every awake body has stayed under them, the whole scene is put to sleep at once.
  - Forcing individual bodies to sleep inside a moving pile was tried and rejected: frozen bodies hovered when their support moved away, and some were squeezed out through the walls.
  - A settled pile of 150 drops to about 0.07 ms per physics step.
- **Rolling resistance.** Rapier has none, so slow spheres and cylinders lying on the floor get a small damping term, scaled by the friction slider (so "ice" still glides). Without it they roll for a very long time and never sleep.
- **Rendering budget.**
  - Three `InstancedMesh`es (one per shape) give 3 draw calls for every body.
  - The shadow map is only re-rendered when something moved, and frames are skipped entirely when nothing changed.
  - Pixel ratio is capped at 2, with no MSAA on high-DPI screens. It also steps down automatically if FPS stays under 45.
- **Viewport.** `100dvh`, `overscroll-behavior: none` and a `position: fixed` body; `touch-action: none` on the canvas; no pinch-zoom of the page; long-press menus and text selection disabled; safe-area insets respected.

Physics character per shape lives in `src/engine/constants.ts`:

- **Cube:** heaviest and most damped, so it settles and stacks well.
- **Sphere:** light, low damping, with its bounce scaled ×1.3, so it rolls and hops.
- **Cylinder:** tall enough to stand as a column or domino, and rolls when it tips over.

## Project layout

```
src/
  App.tsx                 boot sequence: WebGL check → RAPIER.init() + lazy 3D bundle → Playground
  Playground.tsx          wires engine ⇄ UI, persisted settings, hints, toasts, dock framing
  engine/
    PhysicsEngine.ts      Three.js scene, Rapier world, loop, picking, drag/fling, recycling
    constants.ts          arena size, body cap, sleep/throw tuning, gravity presets, shape specs
    materials.ts          shader patches: neon shapes, grid floor, fresnel glass
    haptics.ts            navigator.vibrate wrapper with rate-limited collision rumble
    palette.ts            golden-angle neon colour assignment
  components/             Hud, ModeSwitch, SpawnToolbar, EnvironmentDock, LoadingScreen, PwaPrompt
scripts/
  touch-test.cjs          end-to-end Android touch test (Playwright)
  generate-icons.mjs      renders public/favicon.svg into the PWA PNG icons
```

## Testing

`npm run test:touch` drives the dev server in an emulated Pixel 7 using real touch events over the Chrome DevTools Protocol. Start `npm run dev` first. It needs Playwright with Chromium available to Node (`npm i -D playwright && npx playwright install chromium` if you don't have it).

The script checks 33 behaviours:

- spawning, plus the HUD count and the haptic durations
- grab → kinematic → fling velocity, and the camera staying still during a drag
- `controls.enabled` toggling at grab and release
- the collision rumble's rate limit
- both gesture modes
- the 150 cap and recycling
- every gravity preset, and the sliders applying live
- picking while the dock is open
- Clear All
- the overscroll and touch-action rules
- a clean console

The headless browser renders with SwiftShader on the CPU, so the FPS it reports says nothing about real phones. On a 2.1 GHz Xeon, one physics step for 150 colliding bodies costs about 1.5 ms, and about 0.07 ms once the pile has gone to sleep.
