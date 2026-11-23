# Physics Playground

A mobile-first, offline-ready 3D rigid-body sandbox tuned for Android phones. Spawn cubes, spheres, cylinders and Nitro blocks into a glass arena. Grab and fling them, slice them with a laser, shatter them, drop a black hole into the middle, or set off a chain reaction. Gravity switches between Earth, Moon, Mars, zero-G and inverted.

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
| **HUD** | Live FPS (colour-coded), `bodies / 150` with a fill bar, a debris count, and a recycle icon at the cap. An instant **Clear** button flashes a confirmation sweep. |
| **Control deck** | Two thumb-height rows at the bottom. The top row picks the touch tool (**Grab · Camera · Slice**) and opens **Forces**. The bottom row is the spawner (**Cube · Sphere · Cylinder · Nitro**): tap for one, hold to keep spawning. It fits a 360 px screen without overlap. |
| **Touch tools** | *Grab*: one finger grabs, drags and flings bodies. *Camera*: one finger orbits. *Slice*: one finger draws a laser. Two-finger pinch zooms in every tool. |
| **Shattering** | A hard enough impact (a ~6 m drop, a hard throw, or a nearby blast) shatters a shape into 4–6 faceted debris shards. Toggle it with **Destructible** in the Forces dock. |
| **Laser slicing** | Swipe in Slice mode to cut every shape the beam crosses: cubes become two prisms, spheres two hemispheres, and cylinders two shorter cylinders or two half-cylinders. The beam leaves a glowing trail and sparks. |
| **Singularities** | Pick **Black hole** or **Repulsor** in the Forces dock, then tap the arena to place it. Drag its core to move it; tap the core to dismiss it. Only one can exist at a time. |
| **Nitro** | Hazard-striped blocks with a pulsing reactor core. They detonate on a hard impact, a laser cut, or another blast's shockwave. Neighbours go off as a rolling chain reaction. |
| **Forces dock** | Slide-up drawer with: gravity presets (−9.81, −1.62, −3.71, 0, +9.81 m/s²); the singularity picker; Destructible and Haptics toggles; restitution (dead thud → superball) and friction (ice glide → high grip) sliders. Changes apply live. While the drawer is open, the 3D view slides and zooms into the area left visible, and picking still lines up. |
| **Haptics** | `navigator.vibrate`: 10 ms spawn tick; 15 ms grab and slice taps; 30 ms fling; 20 ms collision rumble (at most once every 120 ms); `[40, 30, 80]` per explosion (at most once every 200 ms). It no-ops where unsupported and can be toggled in the dock. |
| **Offline** | A Workbox service worker precaches everything (about 5 MB, mostly Rapier's inlined WASM). Updates prompt instead of auto-reloading, so a running simulation is never wiped. |
| **Persistence** | Gravity, sliders, touch tool, and the Destructible and Haptics toggles are remembered in `localStorage`. If storage is unavailable the app still works, with in-memory settings. |

## How the key safeguards work

All physics and rendering live in `src/engine/PhysicsEngine.ts`, outside React. React talks to it through a few methods and a stats callback that fires about twice a second, so nothing in the 60 fps path re-renders React.

- **Fixed-step physics with interpolation.** Rapier steps at a fixed 1/60 s (at most 4 substeps per frame). Rendering interpolates between the last two physics states, so 90 and 120 Hz Android screens stay smooth.
- **Camera interference safeguard.** The engine's `pointerdown` listener is registered before `OrbitControls`, in the capture phase. On a hit it sets `controls.enabled = false` and stops propagation before OrbitControls ever sees the touch. Controls are re-enabled when the finger lifts (`pointerup`, `pointercancel` or `lostpointercapture`).
- **Collider sync safeguard.** A grabbed body is switched to `KinematicPositionBased`, and each physics step calls `setNextKinematicTranslation()` toward the finger's point on a camera-facing drag plane. Meshes only ever copy transforms out of Rapier. The target is clamped inside the glass and the step speed is capped, so a fast swipe can't tunnel the body through a pile.
- **Throw.** The finger's path on the drag plane is recorded from every coalesced pointer event, before clamping, so a swipe that pins the body against the glass still throws it into the glass. On release, the velocity over the last 80 ms (with the release moment as the final sample, so a finger that stopped first throws nothing) becomes an impulse `J = m·v` (capped at 26 m/s), plus a little tumble in the direction of travel.
- **Fat-finger picking.** Rapier `castRay` runs from the touch point first, then from rings of rays 14 px and 28 px around it, so small or distant bodies are still easy to grab.
- **Body cap.** Everything counts toward the 150 limit, debris included. When a spawn, fracture or slice needs room, the engine recycles in this order: oldest sleeping debris, oldest debris, oldest sleeping shape, oldest shape. Neighbours of a recycled body are woken so the pile resettles.
- **Sleeping.** Rapier sleeps each contact island on its own. On top of that, the engine applies explicit thresholds (`SLEEP_SPEED_LIMIT` 0.12 m/s, `SLEEP_ANGULAR_LIMIT` 0.25 rad/s, `SLEEP_TIME_LIMIT` 0.6 s). Once every awake body has stayed under them, the whole scene is put to sleep at once.
  - Forcing individual bodies to sleep inside a moving pile was tried and rejected: frozen bodies hovered when their support moved away, and some were squeezed out through the walls.
  - A settled pile of 150 drops to about 0.07 ms per physics step.
- **Rolling resistance.** Rapier has none, so slow spheres and cylinders lying on the floor get a small damping term, scaled by the friction slider (so "ice" still glides). Without it they roll for a very long time and never sleep.
- **Rendering budget.**
  - One `InstancedMesh` per form (8 forms), each sized per instance, so any mix of shapes, halves and debris costs at most 8 draw calls.
  - All effects (impact rings, explosions, the laser overlay, singularity visuals) are allocated once and reused. The explosion light always exists at intensity 0, so a blast never changes the light count and triggers shader recompiles.
  - The shadow map is only re-rendered when something moved, and frames are skipped entirely when nothing changed.
  - Pixel ratio is capped at 2, with no MSAA on high-DPI screens. It also steps down automatically if FPS stays under 45.
- **Viewport.** `100dvh`, `overscroll-behavior: none` and a `position: fixed` body; `touch-action: none` on the canvas; no pinch-zoom of the page; long-press menus and text selection disabled; safe-area insets respected.

## Phase 2 safeguards

- **Fracture trigger.** Contact-force events give the impact impulse J. The engine converts it to the normal approach speed v = J / (m·(1+e)), where e is the restitution, and shatters a body when ½v² ≥ 55 J/kg.
  - Calibrated against drops: the estimate matches ½v² = g·h within about 3%. A 7.2 m drop (64 J/kg) shatters; drops under about 5.6 m don't.
  - Freshly spawned bodies ignore their first landing, so the drop-in from the top of the arena never shatters them.
- **Anti-cascade.**
  - Fragments are tagged `isDebris`, and their colliders have `ActiveEvents.NONE`. They never report contact forces, so they can't flood the event queue or fracture again.
  - Fractures are queued and applied at most 2 per physics step.
  - Each fragment's mass is the parent's mass split by volume. It inherits the parent's v + ω × r plus a modest outward scatter impulse.
- **Debris lifecycle.** A shard fades and despawns once it has stayed below 0.1 m/s for 2 s, or has been resting (below 0.5 m/s) for 4 s. A 12 s lifetime cap catches debris that never settles, such as debris floating in zero-G or skidding on ice. In tests, debris clears 3.7–4.7 s after a shatter.
- **Slicing.**
  - The cut plane is the plane swept by the finger's ray: it contains the eye and both ends of each swipe segment, so the cut lands exactly on the drawn line.
  - Each shape the segment passes over is cut into convex pieces with matching colliders: boxes, cylinders, or convex hulls for hemispheres and half-cylinders. No CSG library is involved.
  - Halves are tagged `isSliced`. They and debris can't be sliced again.
  - Halves split the mass by volume, inherit the parent's motion, and get a separation impulse along the cut normal.
- **Softened singularities.** The pull is a = G / (r² + ε²) with ε = 1 m, so it peaks at G/ε² instead of growing without bound as r → 0.
  - Inside the 0.5 m event-horizon core the force also tapers to zero, and bodies get heavy linear and angular damping.
  - An accretion drag bleeds off the orbital energy the black hole's swirl adds; without it, bodies circled at the speed limit instead of spiralling in.
  - Every body in the field is clamped to 12 m/s.
  - The repulsor pushes continuously and also sends out a shockwave pulse every 1.3 s.
- **Staggered chain reactions.**
  - A blast queues nearby Nitro blocks instead of detonating them in the same frame. Queued blasts are kept at least 4 physics steps apart: 66.7 ms, inside the 60–80 ms window.
  - A cluster therefore rolls off as a wave, and no single frame computes more than one explosion.
  - The explosion haptic is throttled to once every 200 ms, and collision rumbles stay quiet briefly afterwards so they don't cut the pattern short.
  - Each blast's fireball, smoke and flash are cleared after 500 ms.
- **Taps that can't be swallowed.** HUD and dock buttons act on a clean pointer tap rather than waiting for the browser's synthesized `click`. In testing, Chrome sometimes dropped that click when a tap landed about 200 ms after a fast swipe on the arena. `click` still works for keyboards and screen readers, de-duplicated so nothing fires twice.

Physics character per shape lives in `src/engine/constants.ts`:

- **Cube:** heaviest and most damped, so it settles and stacks well.
- **Sphere:** light, low damping, with its bounce scaled ×1.3, so it rolls and hops.
- **Cylinder:** tall enough to stand as a column or domino, and rolls when it tips over.
- **Nitro:** dense and dead, with little bounce.
- **Debris shards:** damped so they settle (and despawn) quickly.

## Project layout

```
src/
  App.tsx                 boot sequence: WebGL check → RAPIER.init() + lazy 3D bundle → Playground
  Playground.tsx          wires engine ⇄ UI, persisted settings, hints, toasts, dock framing
  engine/
    PhysicsEngine.ts      scene, Rapier world, step pipeline, gestures (grab / slice / singularity),
                          fracture, slicing, Nitro, singularity field, recycling
    forms.ts              every body form: render geometry, collider, volume, bounds, instance scale
    breakage.ts           pure geometry: fracture layouts and slice bisection
    effects.ts            pooled impact rings, explosions, laser overlay, singularity visuals
    nitro.ts              canvas-drawn hazard texture + pulsing emissive core
    constants.ts          arena, caps, thresholds and tuning for every system
    materials.ts          shader patches: neon shapes, grid floor, fresnel glass
    haptics.ts            navigator.vibrate wrapper: ticks, rate-limited rumble, throttled blasts
    palette.ts            golden-angle neon colour assignment
  components/             Hud, ControlDeck, ForcesDock, TapButton, LoadingScreen, PwaPrompt
scripts/
  touch-test.cjs          end-to-end Android touch test (Playwright)
  generate-icons.mjs      renders public/favicon.svg into the PWA PNG icons
```

## Testing

`npm run test:touch` drives the dev server in an emulated Pixel 7 using real touch events over the Chrome DevTools Protocol. Start `npm run dev` first. It needs Playwright with Chromium available to Node (`npm i -D playwright && npx playwright install chromium` if you don't have it).

The script checks 68 behaviours.

**Phase 1**

- spawning, plus the HUD count and the haptic durations
- grab → kinematic → fling velocity, and the camera staying still during a drag
- `controls.enabled` toggling at grab and release
- the collision rumble's rate limit
- the touch tools
- the 150 cap and recycling
- every gravity preset, and the sliders applying live
- picking while the dock is open
- Clear All
- the overscroll and touch-action rules
- a clean console

**Slicing**

- a swipe bisects a cube into two `isSliced` prisms that split the parent's mass
- the 15 ms haptic fires
- halves can't be cut again
- one stroke turns a sphere into hemispheres and a cylinder into halves
- Clear still works right after slicing swipes

**Fracture**

- a normal spawn landing survives
- a drop from the ceiling shatters into 4–6 `isDebris` shards, which have contact-force events disabled and carry the parent's mass
- the HUD shows the debris count
- debris fade out and despawn after resting
- Destructible Off prevents shattering

**Singularities**

- choosing one arms placement, and a tap places exactly one
- the black hole pulls bodies in without any body exceeding the 12 m/s clamp
- the core can be dragged
- switching to Repulsor replaces it and flings bodies outward
- tapping the core dismisses it

**Nitro**

- a laser cut sets off a row of 3, which detonates as a chain 66.7 ms apart, never two in the same frame
- one `[40,30,80]` haptic per 200 ms
- blast visuals are cleared after 500 ms
- the physics step stays within budget
- a 5-block chain through a crowd of 40 breakables stays under the cap, finite, and under one 60 fps frame per step

Strokes that must be fast carry explicit event timestamps. Headless SwiftShader can stall a DevTools touch call for a whole slow frame, which would otherwise make a flick look like "move, pause, lift".

The headless browser renders with SwiftShader on the CPU, so the FPS it reports says nothing about real phones. Physics cost is measured separately; see the numbers above.
