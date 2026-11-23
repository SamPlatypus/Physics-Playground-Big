// End-to-end touch test against the dev server, emulating an Android phone (Pixel 7).
//
//   npm run dev            # in one terminal
//   npm run test:touch     # in another (needs Playwright + Chromium available)
//
// Drives real CDP touch events: spawning, grab / drag / fling, the OrbitControls
// safeguard, both gesture modes, the 150-body cap, gravity presets, material
// sliders, Clear All and the haptics calls (navigator.vibrate is stubbed to record).
// The dev build exposes the engine as window.__playground for introspection.
const { chromium, devices } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')

const URL = process.argv[2] || 'http://localhost:5173/'
const OUT = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'playground-touch-test')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

;(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  await context.addInitScript(() => {
    window.__vib = []
    navigator.vibrate = (p) => {
      window.__vib.push({ p, t: performance.now() })
      return true
    }
    try {
      localStorage.clear()
    } catch {}
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`)
  })

  await page.goto(URL)
  // Loading spinner should be visible first (or already gone if instant).
  await page.waitForFunction(() => !!window.__playground, null, { timeout: 60000 })
  await sleep(800)
  await page.screenshot({ path: path.join(OUT, '01-empty.png') })
  const snap = () => page.evaluate(() => window.__playground.debugSnapshot())

  const cdp = await context.newCDPSession(page)
  // `ts` (seconds since epoch) pins the event timestamp. Headless SwiftShader can stall a
  // CDP call for a whole slow frame, which would otherwise turn a fast flick into
  // "move, hold still, lift" from the page's point of view.
  const touch = async (type, x, y, ts) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 6, radiusY: 6, force: 1 }],
      ...(ts ? { timestamp: ts } : {}),
    })
  }


  // Tap spawn buttons with real taps.
  await page.tap('button[aria-label="Spawn Cube"]')
  await sleep(150)
  await page.tap('button[aria-label="Spawn Sphere"]')
  await sleep(150)
  await page.tap('button[aria-label="Spawn Cylinder"]')
  await sleep(150)
  let s = await snap()
  check('spawn buttons create bodies', s.bodies.length === 3, `${s.bodies.length} bodies`)
  let vib = await page.evaluate(() => window.__vib.map((v) => v.p))
  check('spawn haptic tick 10ms', vib.filter((p) => p === 10).length >= 3, JSON.stringify(vib))
  const hudText = await page.locator('header').innerText()
  check('HUD shows body count "3 / 150"', /3\s*\/\s*150/.test(hudText), hudText.replace(/\n/g, ' | '))

  const t0 = Date.now()
  do {
    await sleep(500)
    s = await snap()
  } while (!s.bodies.every((b) => b.sleeping) && Date.now() - t0 < 15000)
  await page.screenshot({ path: path.join(OUT, '02-three-bodies.png') })
  check('resting bodies fall asleep', s.bodies.every((b) => b.sleeping), `after ${((Date.now() - t0) / 1000).toFixed(1)}s ` + JSON.stringify(s.bodies.map((b) => b.sleeping)))
  check('bodies landed on floor', s.bodies.every((b) => b.pos[1] < 1.2), JSON.stringify(s.bodies.map((b) => b.pos[1].toFixed(2))))

  // ---- Grab + fling in interact mode ----
  const target = s.bodies[0]
  const [sx, sy] = target.screen
  await page.evaluate(() => (window.__vib.length = 0))
  await touch('touchStart', sx, sy)
  await sleep(60)
  s = await snap()
  const grabbed = s.bodies.find((b) => b.id === target.id)
  check('touch on body grabs it (kinematic)', s.dragging && grabbed.kinematic, `dragging=${s.dragging} kinematic=${grabbed.kinematic}`)
  check('OrbitControls disabled while grabbed', s.controlsEnabled === false)
  const camBefore = s.camera
  // Drag upward, then fling up-and-sideways quickly.
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', sx, sy - i * 12)
    await sleep(16)
  }
  await sleep(120)
  s = await snap()
  const lifted = s.bodies.find((b) => b.id === target.id)
  check('dragged body follows finger (physics position moved up)', lifted.pos[1] > target.pos[1] + 0.8, `y ${target.pos[1].toFixed(2)} -> ${lifted.pos[1].toFixed(2)}`)
  check('camera did not move during drag', JSON.stringify(s.camera) === JSON.stringify(camBefore))
  const flick0 = Date.now() / 1000
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', sx + i * 10, sy - 120 - i * 9, flick0 + i * 0.016)
    await sleep(16)
  }
  await touch('touchEnd', 0, 0, flick0 + 7 * 0.016)
  await sleep(30)
  s = await snap()
  const flung = s.bodies.find((b) => b.id === target.id)
  // A hard enough throw can hit the glass and shatter within a frame or two — also a valid outcome.
  const shattered = !flung && s.bodies.some((b) => b.isDebris)
  const speed = flung ? Math.hypot(...flung.vel) : NaN
  check('release returns body to dynamic', shattered || (!flung.kinematic && !s.dragging))
  check('release applies throw velocity', shattered || speed > 4, shattered ? 'thrown into the glass and shattered' : `speed ${speed.toFixed(2)} m/s vel=${flung.vel.map((v) => v.toFixed(2))}`)
  check('OrbitControls re-enabled on lift', s.controlsEnabled === true)
  vib = await page.evaluate(() => window.__vib.map((v) => v.p))
  check('grab haptic 15ms + fling haptic 30ms', vib.includes(15) && vib.includes(30), JSON.stringify(vib))
  await sleep(1500)
  vib = await page.evaluate(() => window.__vib.map((v) => v.p))
  check('collision rumble 20ms after fling impact', vib.includes(20), JSON.stringify(vib))
  const rumbleTimes = await page.evaluate(() => window.__vib.filter((v) => v.p === 20).map((v) => v.t))
  const minGap = rumbleTimes.slice(1).reduce((m, t, i) => Math.min(m, t - rumbleTimes[i]), Infinity)
  check('rumble rate limited ≥120ms', rumbleTimes.length < 2 || minGap >= 119, `${rumbleTimes.length} rumbles, min gap ${minGap.toFixed?.(0)}`)
  await page.screenshot({ path: path.join(OUT, '03-after-fling.png') })

  // ---- Touch on empty space in interact mode shouldn't orbit ----
  s = await snap()
  const cam0 = s.camera
  await touch('touchStart', 60, 330)
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', 60 + i * 20, 330)
    await sleep(16)
  }
  await touch('touchEnd', 0, 0)
  await sleep(400)
  s = await snap()
  check('interact mode: empty-space swipe does not orbit', JSON.stringify(s.camera) === JSON.stringify(cam0))

  // ---- Camera mode: swipe orbits, does not grab ----
  await page.tap('button[role="radio"][aria-checked="false"]:has-text("Camera")')
  await sleep(300)
  s = await snap()
  check('mode switch to camera', s.mode === 'camera')
  const b0 = s.bodies[1]
  await touch('touchStart', b0.screen[0], b0.screen[1])
  await sleep(40)
  const s2 = await snap()
  check('camera mode: touching body does not grab', !s2.dragging)
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', b0.screen[0] + i * 15, b0.screen[1])
    await sleep(16)
  }
  await touch('touchEnd', 0, 0)
  await sleep(600)
  s = await snap()
  check('camera mode: swipe orbits camera', JSON.stringify(s.camera) !== JSON.stringify(cam0), JSON.stringify(s.camera.map((v) => v.toFixed(2))))
  await page.screenshot({ path: path.join(OUT, '04-orbited.png') })
  await page.tap('button[role="radio"]:has-text("Grab")')
  await sleep(200)

  // ---- Body cap and recycling ----
  await page.evaluate(() => {
    const e = window.__playground
    const kinds = ['cube', 'sphere', 'cylinder']
    for (let i = 0; i < 170; i++) e.spawn(kinds[i % 3])
  })
  await sleep(300)
  s = await snap()
  check('body cap enforced at 150', s.bodies.length === 150, `${s.bodies.length}`)
  const hud2 = await page.locator('header').innerText()
  check('HUD shows 150 / 150 and recycling icon', /150\s*\/\s*150/.test(hud2) && (await page.locator('header [aria-label*="recycled"]').count()) === 1, hud2.replace(/\n/g, ' | '))
  await sleep(4000)
  await page.screenshot({ path: path.join(OUT, '05-full.png') })
  const fpsText = await page.locator('header').innerText()
  console.log('HUD at cap:', fpsText.replace(/\n/g, ' | '))

  // ---- Environment dock: gravity + sliders ----
  await page.tap('button[aria-label="Forces and environment settings"]')
  await sleep(400)
  await page.screenshot({ path: path.join(OUT, '06-dock.png') })
  await page.tap('button[role="radio"]:has-text("Inverted")')
  await sleep(2500)
  s = await snap()
  const avgY = s.bodies.reduce((a, b) => a + b.pos[1], 0) / s.bodies.length
  check('inverted gravity: bodies fall upward', s.gravity > 9 && avgY > 4.5, `g=${s.gravity} avgY=${avgY.toFixed(2)}`)
  await page.screenshot({ path: path.join(OUT, '07-inverted.png') })

  // Slider: set restitution to 1 by keyboard/fill.
  await page.locator('#restitution').fill('1')
  await page.locator('#friction').fill('0')
  await sleep(100)
  s = await snap()
  const sph = s.bodies.find((b) => b.material === 'sphere')
  const cube = s.bodies.find((b) => b.material === 'cube')
  check('restitution slider applies live', sph.restitution === 1 && cube.restitution > 0.6, `sphere ${sph.restitution} cube ${cube.restitution}`)
  check('friction slider applies live', s.bodies.every((b) => b.friction === 0), `${cube.friction}`)

  await page.tap('button[role="radio"]:has-text("Zero-G")')
  await sleep(1500)
  s = await snap()
  check('zero-G applied', s.gravity === 0)
  await page.screenshot({ path: path.join(OUT, '08-zero-g.png') })
  await page.tap('button[role="radio"]:has-text("Moon")')
  await sleep(300)
  s = await snap()
  check('moon gravity applied', Math.abs(s.gravity + 1.62) < 1e-6, `${s.gravity}`)
  await page.tap('button[role="radio"]:has-text("Earth")')
  await sleep(4000)
  await page.screenshot({ path: path.join(OUT, '08b-dock-framed.png') })
  // Grab a body that is visible above the open dock: picking must respect the shifted view.
  s = await snap()
  const dockTop = await page.evaluate(() => document.getElementById('forces-dock').getBoundingClientRect().top)
  const visible = s.bodies.filter((b) => b.screen[1] > 120 && b.screen[1] < dockTop - 30 && b.screen[0] > 30 && b.screen[0] < 380)
  if (visible.length) {
    // Prefer a body at rest: a falling one can move out from under the finger before the touch lands.
    const vb = visible.filter((b) => b.sleeping).pop() ?? visible[visible.length - 1]
    await touch('touchStart', vb.screen[0], vb.screen[1])
    await sleep(60)
    const sd = await snap()
    check('grab works with dock open (framed view)', sd.dragging, `picked at ${vb.screen.map((v) => v.toFixed(0))}`)
    await touch('touchEnd', 0, 0)
    await sleep(100)
  } else {
    check('grab works with dock open (framed view)', false, 'no visible body above dock')
  }
  await page.tap('button[aria-label="Close forces settings"]')
  await sleep(300)

  // ---- Clear all ----
  await page.tap('button[aria-label="Clear all bodies"]')
  await sleep(120)
  await page.screenshot({ path: path.join(OUT, '09-clear-flash.png') })
  s = await snap()
  check('Clear All empties the arena', s.bodies.length === 0)
  const clearLabel = await page.locator('button[aria-label="Clear all bodies"]').innerText()
  check('Clear button shows confirmation', /cleared/i.test(clearLabel), clearLabel)
  await sleep(1200)


  // =====================================================================
  // Phase 2
  // =====================================================================
  // Keep synthetic strokes on screen (a shape near a wall can project close to the edge).
  const vw = await page.evaluate(() => window.innerWidth)
  const cx_ = (x) => Math.min(vw - 4, Math.max(4, x))
  const swipe = async (x0, y0, x1, y1, steps = 12) => {
    x0 = cx_(x0)
    x1 = cx_(x1)
    await touch('touchStart', x0, y0)
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps)
      await sleep(16)
    }
    await touch('touchEnd', 0, 0)
  }
  const waitFor = async (pred, timeoutMs) => {
    const t0 = Date.now()
    let snapNow = await snap()
    while (!pred(snapNow) && Date.now() - t0 < timeoutMs) {
      await sleep(250)
      snapNow = await snap()
    }
    return { s: snapNow, ms: Date.now() - t0 }
  }
  const inArena = (b) => b.pos.every(Number.isFinite) && Math.abs(b.pos[0]) < 4.2 && Math.abs(b.pos[2]) < 4.2 && b.pos[1] > -0.2 && b.pos[1] < 8.2
  const vibs = () => page.evaluate(() => window.__vib.map((v) => ({ p: v.p, t: v.t })))
  const resetVib = () => page.evaluate(() => (window.__vib.length = 0))

  // Back to default materials (Phase 1 left the arena on frictionless "superball" settings).
  await page.tap('button[aria-label="Forces and environment settings"]')
  await sleep(300)
  await page.locator('#restitution').fill('0.35')
  await page.locator('#friction').fill('0.6')
  await page.tap('button[aria-label="Close forces settings"]')
  await sleep(300)

  // ---- 1. Laser slice: a swipe bisects a cube into two rigid bodies ----
  await page.tap('button[role="radio"]:has-text("Grab")')
  await page.tap('button[aria-label="Spawn Cube"]')
  let w = await waitFor((x) => x.bodies.length === 1 && x.bodies[0].sleeping, 15000)
  const parent = w.s.bodies[0]
  await page.tap('button[role="radio"]:has-text("Slice")')
  await sleep(250)
  s = await snap()
  check('slice: Slice tool selectable from the bottom deck', s.mode === 'slice')
  await resetVib()
  const [px, py] = parent.screen
  const sx0 = cx_(px - 120)
  const sx1 = cx_(px + 120)
  await touch('touchStart', sx0, py - 25)
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', sx0 + ((sx1 - sx0) * i) / 12, py - 25 + (i * 25) / 12)
    await sleep(16)
  }
  await page.screenshot({ path: path.join(OUT, '20-laser-mid-swipe.png') })
  for (let i = 7; i <= 12; i++) {
    await touch('touchMove', sx0 + ((sx1 - sx0) * i) / 12, py - 25 + (i * 25) / 12)
    await sleep(16)
  }
  await touch('touchEnd', 0, 0)
  await sleep(350)
  s = await snap()
  const halves = s.bodies
  check(
    'slice: swipe bisects the cube into two rigid bodies',
    halves.length === 2 && halves.every((b) => b.isSliced && b.form === 'box'),
    halves.map((b) => `${b.form}${b.isSliced ? '*' : ''}`).join(','),
  )
  const massSum = halves.reduce((a, b) => a + b.mass, 0)
  check('slice: halves split the parent mass', Math.abs(massSum - parent.mass) < 1e-3, `${parent.mass.toFixed(3)} → ${halves.map((b) => b.mass.toFixed(3)).join(' + ')}`)
  check('slice: 15 ms haptic on the severed object', (await vibs()).some((v) => v.p === 15))
  check('slice: tool releases the touch (camera controls back)', !s.slicing && s.controlsEnabled)
  await page.screenshot({ path: path.join(OUT, '21-sliced-cube.png') })
  await sleep(1500)
  s = await snap()
  for (const h of s.bodies) {
    await swipe(h.screen[0] - 90, h.screen[1] + 5, h.screen[0] + 90, h.screen[1] - 5, 10)
    await sleep(150)
  }
  s = await snap()
  check('slice: sliced halves cannot be sliced again', s.bodies.length === 2, `${s.bodies.length} bodies`)

  // Sphere → hemispheres, cylinder → halves, in one stroke.
  await page.tap('button[aria-label="Clear all bodies"]')
  w = await waitFor((x) => x.bodies.length === 0, 1500)
  check('Clear All right after slicing swipes (tap not swallowed)', w.s.bodies.length === 0, `bodies=${w.s.bodies.length}`)
  await page.evaluate(() => {
    window.__playground.debugSpawnAt('sphere', -1.2, 0.5, 0)
    window.__playground.debugSpawnAt('cylinder', 1.2, 0.6, 0)
  })
  await sleep(1200)
  s = await snap()
  const a0 = s.bodies[0].screen
  const a1 = s.bodies[1].screen
  await swipe(a0[0] - 70, a0[1] - 4, a1[0] + 70, a1[1] + 4, 16)
  await sleep(400)
  s = await snap()
  const forms = s.bodies.map((b) => b.form).sort().join(',')
  check('slice: sphere → 2 hemispheres, cylinder → 2 convex halves', s.bodies.length === 4 && s.bodies.filter((b) => b.form === 'hemisphere').length === 2 && s.bodies.every((b) => b.isSliced), forms)
  check('slice: bodies stay finite and inside the arena', s.bodies.every(inArena))
  await page.screenshot({ path: path.join(OUT, '22-sliced-sphere-cylinder.png') })

  // ---- 2. High-altitude drop fractures into debris, which then despawns ----
  await page.tap('button[aria-label="Clear all bodies"]')
  await page.tap('button[role="radio"]:has-text("Grab")')
  await sleep(300)
  await page.tap('button[aria-label="Spawn Cube"]')
  w = await waitFor((x) => x.bodies.length === 1 && x.bodies[0].sleeping, 15000)
  check('fracture: a normal spawn landing does not shatter (spawn grace)', w.s.bodies.length === 1 && !w.s.bodies[0].isDebris)
  const drop = w.s.bodies[0]
  let [gx, gy] = drop.screen
  await touch('touchStart', gx, gy)
  for (let i = 1; i <= 40; i++) {
    gy -= 14
    await touch('touchMove', gx, gy)
    await sleep(16)
  }
  await sleep(400) // hold still at the ceiling so the release throws nothing
  s = await snap()
  const liftY = s.bodies[0].pos[1]
  await touch('touchEnd', 0, 0)
  w = await waitFor((x) => x.bodies.some((b) => b.isDebris), 6000)
  const debris = w.s.bodies.filter((b) => b.isDebris)
  check(
    'fracture: drop from the ceiling shatters into 4–6 debris',
    debris.length >= 4 && debris.length <= 6 && w.s.bodies.length === debris.length,
    `lifted to y=${liftY.toFixed(2)}, ${debris.length} debris, peak impact ${Math.max(0, ...w.s.impacts.map((i) => i.energyPerKg)).toFixed(1)} J/kg`,
  )
  check('fracture: debris have contact-force events disabled', debris.every((b) => b.activeEvents === 0), JSON.stringify(debris.map((b) => b.activeEvents)))
  check('fracture: debris carry the parent mass', Math.abs(debris.reduce((a, b) => a + b.mass, 0) - drop.mass) < 1e-3)
  await sleep(120)
  await page.screenshot({ path: path.join(OUT, '23-shattered.png') })
  const hudDebris = await page.locator('header [aria-label*="debris"]').count()
  check('fracture: HUD shows debris count', hudDebris === 1)
  const simAtShatter = w.s.simTime
  w = await waitFor((x) => x.bodies.length === 0, 30000)
  check('fracture: resting debris fade out and despawn', w.s.bodies.length === 0, `after ${(w.s.simTime - simAtShatter).toFixed(1)} s sim`)

  // Destructible toggle off: the same drop survives.
  await page.tap('button[aria-label="Forces and environment settings"]')
  await sleep(300)
  await page.tap('button[aria-label="Destructible objects"]')
  await page.tap('button[aria-label="Close forces settings"]')
  await sleep(300)
  await page.evaluate(() => window.__playground.debugSpawnAt('cube', 0, 7.2, 0))
  await sleep(2500)
  s = await snap()
  check('fracture: Destructible Off — high drop does not shatter', !s.destructible && s.bodies.length === 1 && !s.bodies[0].isDebris)
  await page.tap('button[aria-label="Forces and environment settings"]')
  await sleep(300)
  await page.tap('button[aria-label="Destructible objects"]')
  await page.tap('button[aria-label="Close forces settings"]')
  await page.tap('button[aria-label="Clear all bodies"]')
  await sleep(400)

  // ---- 3. Black hole: pulls bodies in, nothing exceeds the speed clamp ----
  await page.evaluate(() => {
    const e = window.__playground
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2
      e.debugSpawnAt(['cube', 'sphere', 'cylinder'][i % 3], Math.cos(a) * 2.9, 0.65, Math.sin(a) * 2.9)
    }
  })
  await sleep(1500)
  await page.tap('button[aria-label="Forces and environment settings"]')
  await sleep(300)
  await page.tap('button[role="radio"]:has-text("Black hole")')
  await sleep(400)
  s = await snap()
  check('black hole: choosing it arms placement and closes the dock', s.armedSingularity === 'blackhole' && !s.singularity)
  const [cx, cy] = await page.evaluate(() => window.__playground.debugProject(0, 2.4, 0))
  await touch('touchStart', cx, cy)
  await touch('touchEnd', 0, 0)
  await sleep(100)
  s = await snap()
  check('black hole: tap places exactly one singularity', s.singularity?.type === 'blackhole' && Math.hypot(s.singularity.pos[0], s.singularity.pos[2]) < 0.5, JSON.stringify(s.singularity?.pos.map((v) => +v.toFixed(2))))
  const centre = s.singularity.pos
  const meanDist = (x) => x.bodies.reduce((acc, b) => acc + Math.hypot(b.pos[0] - centre[0], b.pos[1] - centre[1], b.pos[2] - centre[2]), 0) / Math.max(1, x.bodies.length)
  const d0 = meanDist(s)
  let maxSeen = 0
  let allInside = true
  for (let i = 0; i < 16; i++) {
    await sleep(250)
    const x = await snap()
    for (const b of x.bodies) maxSeen = Math.max(maxSeen, Math.hypot(...b.vel))
    allInside = allInside && x.bodies.every(inArena)
  }
  s = await snap()
  const d1 = meanDist(s)
  check('black hole: pulls bodies toward its centre', d1 < d0 * 0.6, `mean distance ${d0.toFixed(2)} → ${d1.toFixed(2)} m`)
  check('black hole: no body exceeds the 12 m/s escape clamp', maxSeen <= 12.05 && s.fieldMaxSpeed <= 12.0001, `max sampled ${maxSeen.toFixed(2)} m/s, engine max ${s.fieldMaxSpeed.toFixed(2)}`)
  check('black hole: everything stays inside the arena', allInside)
  await page.screenshot({ path: path.join(OUT, '24-black-hole.png') })

  // Drag to move.
  let [hx, hy] = s.singularity.screen
  await swipe(hx, hy, hx + 60, hy + 30, 6)
  await sleep(200)
  s = await snap()
  check('singularity: drag the core to move it', s.singularity && Math.hypot(s.singularity.pos[0] - centre[0], s.singularity.pos[2] - centre[2]) > 0.3, JSON.stringify(s.singularity?.pos.map((v) => +v.toFixed(2))))

  // Switch to repulsor in place: bodies are flung outward.
  await page.tap('button[aria-label="Forces and environment settings"]')
  await sleep(300)
  await page.tap('button[role="radio"]:has-text("Repulsor")')
  await page.tap('button[aria-label="Close forces settings"]')
  const rc = (await snap()).singularity.pos
  const meanFrom = (x, c) => x.bodies.reduce((acc, b) => acc + Math.hypot(b.pos[0] - c[0], b.pos[1] - c[1], b.pos[2] - c[2]), 0) / Math.max(1, x.bodies.length)
  const r0 = meanFrom(await snap(), rc)
  let repMax = 0
  for (let i = 0; i < 10; i++) {
    await sleep(250)
    const x = await snap()
    for (const b of x.bodies) repMax = Math.max(repMax, Math.hypot(...b.vel))
  }
  s = await snap()
  const r1 = meanFrom(s, rc)
  check('repulsor: replaces the black hole (max one) and flings bodies outward', s.singularity?.type === 'repulsor' && r1 > r0 + 0.5, `mean distance ${r0.toFixed(2)} → ${r1.toFixed(2)} m, max speed ${repMax.toFixed(2)}`)
  await page.screenshot({ path: path.join(OUT, '25-repulsor.png') })
  ;[hx, hy] = s.singularity.screen
  await touch('touchStart', hx, hy)
  await sleep(60)
  await touch('touchEnd', 0, 0)
  await sleep(200)
  s = await snap()
  check('singularity: tapping the core dismisses it', s.singularity === null && s.armedSingularity === null)

  // ---- 4. Nitro: a row of 3 detonates as a staggered chain reaction ----
  await page.tap('button[aria-label="Clear all bodies"]')
  await sleep(400)
  await page.tap('button[aria-label="Spawn Nitro"]')
  w = await waitFor((x) => x.bodies.length === 1 && x.bodies[0].sleeping, 15000)
  check('nitro: spawns from the toolbar and survives its landing', w.s.bodies.length === 1 && w.s.bodies[0].isNitro && w.s.detonations.length === 0)
  await page.screenshot({ path: path.join(OUT, '26-nitro.png') })
  await page.tap('button[aria-label="Clear all bodies"]')
  await sleep(400)
  const ids = await page.evaluate(() => [-1.5, 0, 1.5].map((x) => window.__playground.debugSpawnAt('nitro', x, 0.48, 0.6)))
  await sleep(800)
  s = await snap()
  const first = s.bodies.find((b) => b.id === ids[0])
  await resetVib()
  const stepsBefore = s.stepCount
  await page.tap('button[role="radio"]:has-text("Slice")')
  await swipe(first.screen[0], first.screen[1] - 70, first.screen[0] + 6, first.screen[1] + 70, 10)
  await sleep(50)
  await page.screenshot({ path: path.join(OUT, '27-chain-reaction.png') })
  w = await waitFor((x) => x.detonations.length >= 3 && x.pendingDetonations === 0, 8000)
  const log = w.s.detonations
  const gaps = log.slice(1).map((d, i) => (d.time - log[i].time) * 1000)
  check('nitro: laser contact sets off the first block', log.length >= 1 && log[0].id === ids[0])
  check('nitro: chain reaction detonates all 3', log.length === 3, `${log.length} detonations`)
  check(
    'nitro: detonations staggered 60–80 ms apart, never in the same frame',
    gaps.length === 2 && gaps.every((g) => g >= 60 && g <= 80) && new Set(log.map((d) => d.step)).size === log.length,
    `gaps ${gaps.map((g) => g.toFixed(1)).join(', ')} ms`,
  )
  const v = await vibs()
  const booms = v.filter((x) => Array.isArray(x.p) && x.p.join(',') === '40,30,80')
  const boomGap = booms.slice(1).reduce((m, b, i) => Math.min(m, b.t - booms[i].t), Infinity)
  check('nitro: explosion haptic [40,30,80], throttled to ≥200 ms apart', booms.length >= 1 && (booms.length === 1 || boomGap >= 199), `${booms.length} pattern(s) for ${log.length} blasts`)
  await sleep(700)
  s = await snap()
  check('nitro: blast visuals cleared after 500 ms', s.explosionsActive === 0)
  check('nitro: simulation stable afterwards', s.bodies.every(inArena) && s.stepCount > stepsBefore + 60, `${s.stepCount - stepsBefore} steps`)
  check('nitro: physics step within a 60 fps budget', s.stepMs.p95 < 8 && s.stepMs.max < 16.7, `p95 ${s.stepMs.p95.toFixed(2)} ms, max ${s.stepMs.max.toFixed(2)} ms`)

  // Stress: a longer chain inside a crowd of breakables (fractures are rate-limited per step).
  await page.tap('button[aria-label="Clear all bodies"]')
  await sleep(400)
  const crowd = await page.evaluate(() => {
    const e = window.__playground
    const row = []
    for (let i = 0; i < 5; i++) row.push(e.debugSpawnAt('nitro', -2.8 + i * 1.4, 0.48, 0))
    for (let i = 0; i < 40; i++) e.debugSpawnAt(['cube', 'sphere', 'cylinder'][i % 3], -3 + (i % 8) * 0.85, 0.7 + Math.floor(i / 16) * 1.1, i % 16 < 8 ? 1.3 : -1.3)
    return row
  })
  await sleep(1500)
  const sBefore = await snap()
  await page.evaluate((id) => window.__playground.debugDetonate(id), crowd[0])
  w = await waitFor((x) => x.detonations.length >= 5 && x.pendingDetonations === 0, 10000)
  await sleep(1500)
  s = await snap()
  const crowdLog = s.detonations.filter((d) => crowd.includes(d.id))
  const crowdGaps = crowdLog.slice(1).map((d, i) => (d.time - crowdLog[i].time) * 1000)
  check('nitro crowd: 5-block chain rolls through with ≥60 ms spacing', crowdLog.length === 5 && crowdGaps.every((g) => g >= 60), `gaps ${crowdGaps.map((g) => g.toFixed(0)).join(', ')} ms`)
  check('nitro crowd: body cap respected and all bodies finite', s.bodies.length <= 150 && s.bodies.every(inArena), `${sBefore.bodies.length} → ${s.bodies.length} bodies, ${s.bodies.filter((b) => b.isDebris).length} debris`)
  check('nitro crowd: worst physics step stays under one 60 fps frame', s.stepMs.max < 16.7, `p95 ${s.stepMs.p95.toFixed(2)} ms, max ${s.stepMs.max.toFixed(2)} ms`)
  await page.screenshot({ path: path.join(OUT, '28-crowd-aftermath.png') })
  await page.tap('button[aria-label="Clear all bodies"]')
  await page.tap('button[role="radio"]:has-text("Grab")')
  await sleep(400)

  // ---- Viewport: no page scroll / overscroll ----
  const css = await page.evaluate(() => ({
    canvasTouch: getComputedStyle(document.querySelector('canvas')).touchAction,
    bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
    htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
    scrollH: document.documentElement.scrollHeight,
    innerH: window.innerHeight,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }))
  check('canvas touch-action none', css.canvasTouch === 'none', JSON.stringify(css))
  check('overscroll-behavior none', css.bodyOverscroll === 'none' && css.htmlOverscroll === 'none')
  check('no page overflow', css.scrollH <= css.innerH && css.scrollW <= css.innerW)

  console.log(`Screenshots: ${OUT}`)
  const relevantErrors = errors.filter((e) => !/GPU stall|swiftshader|Automatic fallback|WebGL.*performance/i.test(e))
  check('no page errors / warnings', relevantErrors.length === 0, relevantErrors.slice(0, 5).join(' || '))

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(2)
})
