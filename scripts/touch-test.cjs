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
  const DRAWER_LABELS = { forces: 'Forces drawer', environment: 'Environment drawer', tools: 'Tools drawer' }
  const openDrawer = async (name) => {
    const sel = `button[aria-label="${DRAWER_LABELS[name]}"]`
    if ((await page.getAttribute(sel, 'aria-expanded')) !== 'true') await page.tap(sel)
    await sleep(350)
  }
  const closeDrawer = async () => {
    if (await page.locator('#settings-drawer[aria-hidden="false"]').count()) {
      await page.tap('button[aria-label="Close drawer"]')
      await sleep(300)
    }
  }

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

  // ---- Forces / Environment drawers: gravity + sliders ----
  await openDrawer('forces')
  await sleep(400)
  await page.screenshot({ path: path.join(OUT, '06-dock.png') })
  await page.tap('button[role="radio"]:has-text("Inverted")')
  await sleep(2500)
  s = await snap()
  const avgY = s.bodies.reduce((a, b) => a + b.pos[1], 0) / s.bodies.length
  check('inverted gravity: bodies fall upward', s.gravity > 9 && avgY > 4.5, `g=${s.gravity} avgY=${avgY.toFixed(2)}`)
  await page.screenshot({ path: path.join(OUT, '07-inverted.png') })

  // Slider: set restitution to 1 by keyboard/fill (Environment drawer).
  await page.tap('button[role="tab"]:has-text("Environment")')
  await sleep(250)
  await page.locator('#restitution').fill('1')
  await page.locator('#friction').fill('0')
  await sleep(100)
  s = await snap()
  const sph = s.bodies.find((b) => b.material === 'sphere')
  const cube = s.bodies.find((b) => b.material === 'cube')
  check('restitution slider applies live', sph.restitution === 1 && cube.restitution > 0.6, `sphere ${sph.restitution} cube ${cube.restitution}`)
  check('friction slider applies live', s.bodies.every((b) => b.friction === 0), `${cube.friction}`)

  await page.tap('button[role="tab"]:has-text("Forces")')
  await sleep(250)
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
  const dockTop = await page.evaluate(() => document.getElementById('settings-drawer').getBoundingClientRect().top)
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
  await closeDrawer()
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
  await openDrawer('environment')
  await page.locator('#restitution').fill('0.35')
  await page.locator('#friction').fill('0.6')
  await closeDrawer()
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
  await openDrawer('forces')
  await page.tap('button[aria-label="Destructible objects"]')
  await closeDrawer()
  await sleep(300)
  await page.evaluate(() => window.__playground.debugSpawnAt('cube', 0, 7.2, 0))
  await sleep(2500)
  s = await snap()
  check('fracture: Destructible Off — high drop does not shatter', !s.destructible && s.bodies.length === 1 && !s.bodies[0].isDebris)
  await openDrawer('forces')
  await page.tap('button[aria-label="Destructible objects"]')
  await closeDrawer()
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
  await openDrawer('forces')
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

  // Put it back in the middle and let it gather the bodies, then switch to repulsor in place.
  await page.evaluate(() => {
    const e = window.__playground
    e.singularity.pos.set(0, 2.4, 0)
    e.singularityFx.setPosition(e.singularity.pos)
  })
  await sleep(2000)
  // Switch to repulsor in place: bodies are flung outward.
  await openDrawer('forces')
  await sleep(300)
  await page.tap('button[role="radio"]:has-text("Repulsor")')
  await closeDrawer()
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
  // p95 is the budget that matters for 60 fps; the max only guards against real stalls
  // (a single GC pause in headless software rendering shouldn't fail the run).
  check('nitro crowd: physics step p95 well inside a 60 fps frame, no multi-frame stall', s.stepMs.p95 < 8 && s.stepMs.max < 33, `p95 ${s.stepMs.p95.toFixed(2)} ms, max ${s.stepMs.max.toFixed(2)} ms`)
  await page.screenshot({ path: path.join(OUT, '28-crowd-aftermath.png') })
  await page.tap('button[aria-label="Clear all bodies"]')
  await page.tap('button[role="radio"]:has-text("Grab")')
  await sleep(400)


  // =====================================================================
  // Phase 3A: audio, tremor, palettes, freeze, taxidermy, photo, HUD
  // =====================================================================
  const aud = () =>
    page.evaluate(() => ({
      state: window.__audio.state,
      muted: window.__audio.muted,
      stats: { ...window.__audio.stats },
      compressor: window.__audio.hasCompressor,
      log: window.__audio.log.slice(-60),
    }))
  const clearArena = async () => {
    await page.tap('button[aria-label="Clear all bodies"]')
    await sleep(400)
  }
  // Photo / frame analysis in the page: PNG signature, decoded size and pixel variety.
  const analysePng = (srcExpr) =>
    page.evaluate(async (srcExpr) => {
      const blob = srcExpr === 'engine' ? await window.__playground.capturePhoto() : await (await fetch(document.querySelector(srcExpr).src)).blob()
      if (!blob) return null
      const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer())
      const bmp = await createImageBitmap(blob)
      const oc = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = oc.getContext('2d')
      ctx.drawImage(bmp, 0, 0)
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      let n = 0, sum = 0, sum2 = 0, dark = 0
      for (let y = 0; y < bmp.height; y += 9) for (let x = 0; x < bmp.width; x += 9) {
        const i = (y * bmp.width + x) * 4
        const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
        n++; sum += l; sum2 += l * l; if (l < 6) dark++
      }
      const mean = sum / n
      const canvas = document.querySelector('canvas.playground-canvas')
      return {
        type: blob.type, size: blob.size,
        signature: Array.from(head).join(','),
        width: bmp.width, height: bmp.height, canvasW: canvas.width, canvasH: canvas.height,
        mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), darkFrac: dark / n,
      }
    }, srcExpr)
  const PNG_SIG = '137,80,78,71,13,10,26,10'

  await closeDrawer()
  await page.tap('button[role="radio"]:has-text("Grab")')
  await clearArena()

  // ---- 1. Audio manager ----
  let a = await aud()
  check('audio: AudioContext created on first touch, running, with master compressor', a.state === 'running' && a.compressor, `state=${a.state}`)
  await page.evaluate(() => (window.__audio.log.length = 0))
  await page.evaluate(() => window.__playground.debugSpawnAt('cube', 0, 6, 0))
  await sleep(2600)
  a = await aud()
  const coll = a.log.filter((e) => e.kind === 'collision')
  const pent = (f) => [0, 2, 4, 7, 9].includes(((Math.round(12 * Math.log2(f / 130.81)) % 12) + 12) % 12)
  check('audio: a dropped cube produces voiced collision tones on the pentatonic scale', coll.length >= 1 && coll.every((e) => e.voiced && pent(e.freq)), coll.map((e) => `${e.value.toFixed(1)}N·s→${e.freq.toFixed(0)}Hz`).join(' '))
  const pitch = await page.evaluate(async () => {
    const A = window.__audio
    A.collision(30, 1.2, 'cube')
    const heavy = A.log[A.log.length - 1]
    await new Promise((r) => setTimeout(r, 60))
    A.collision(1.2, 0.15, 'cube')
    const light = A.log[A.log.length - 1]
    return { heavy: heavy.freq, light: light.freq }
  })
  check('audio: heavy hits are lower-pitched than light hits', pitch.heavy < 262 && pitch.light > 500, `heavy ${pitch.heavy.toFixed(0)} Hz, light ${pitch.light.toFixed(0)} Hz`)
  const flood = await page.evaluate(() => {
    const A = window.__audio
    const stolenBefore = A.stats.voicesStolen
    let maxActive = 0
    for (let i = 0; i < 30; i++) {
      A.explosion(i % 4)
      maxActive = Math.max(maxActive, A.stats.activeVoices)
    }
    return { maxActive, stolen: A.stats.voicesStolen - stolenBefore }
  })
  check('audio: polyphony capped at 8 voices with LRU stealing', flood.maxActive <= 8 && flood.stolen >= 22, `max active ${flood.maxActive}, stolen ${flood.stolen}`)
  await sleep(1800)
  a = await aud()
  check('audio: every transient node is disconnected after it ends (no graph leak)', a.stats.activeVoices === 0 && a.stats.nodesCreated === a.stats.nodesDisconnected, `created ${a.stats.nodesCreated}, disconnected ${a.stats.nodesDisconnected}`)
  await page.tap('button[aria-label="Mute sound"]')
  await sleep(150)
  const muteState = await page.evaluate(async () => {
    const A = window.__audio
    await new Promise((r) => setTimeout(r, 60))
    A.collision(12, 1, 'cube')
    return { muted: A.muted, stored: localStorage.getItem('pp.muted'), voiced: A.log[A.log.length - 1].voiced, pressed: document.querySelector('button[aria-label="Mute sound"]').getAttribute('aria-pressed') }
  })
  check('audio: Mute silences new sounds and persists in localStorage', muteState.muted && muteState.stored === 'true' && !muteState.voiced && muteState.pressed === 'true', JSON.stringify(muteState))
  await page.tap('button[aria-label="Mute sound"]')
  await sleep(150)
  const unmute = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 60))
    window.__audio.collision(12, 1, 'cube')
    return { stored: localStorage.getItem('pp.muted'), voiced: window.__audio.log[window.__audio.log.length - 1].voiced }
  })
  check('audio: Unmute restores sound', unmute.stored === 'false' && unmute.voiced, JSON.stringify(unmute))

  // ---- 2. Tremor ----
  await clearArena()
  await page.evaluate(() => {
    for (let i = 0; i < 8; i++) window.__playground.debugSpawnAt(['cube', 'sphere', 'cylinder'][i % 3], -2.4 + (i % 4) * 1.6, 0.65, i < 4 ? -1 : 1)
  })
  w = await waitFor((x) => x.bodies.length === 8 && x.bodies.every((b) => b.sleeping), 15000)
  check('tremor: setup — 8 bodies resting asleep', w.s.bodies.every((b) => b.sleeping))
  await page.evaluate(() => {
    const proto = Object.getPrototypeOf(window.__playground.alive[0].body)
    window.__wakeCount = 0
    window.__origWake = proto.wakeUp
    proto.wakeUp = function () {
      window.__wakeCount++
      return window.__origWake.call(this)
    }
  })
  await resetVib()
  await openDrawer('forces')
  const simBefore = (await snap()).simTime
  await page.tap('button[aria-label="Tremor"]')
  s = await snap()
  const wakes = await page.evaluate(() => window.__wakeCount)
  check('tremor: button wakes every body (body.wakeUp) before shaking', s.tremor !== null && s.tremorWoken === 8 && wakes >= 8 && s.bodies.every((b) => !b.sleeping), `woken ${s.tremorWoken}, wakeUp calls ${wakes}`)
  let maxGx = 0
  for (let i = 0; i < 8; i++) {
    await sleep(70)
    const x = await snap()
    maxGx = Math.max(maxGx, Math.abs(x.worldGravity[0]))
  }
  check('tremor: horizontal gravity oscillates (|g_x| up to ~6 m/s²)', maxGx > 2 && maxGx <= 6.01, `max |g_x| ${maxGx.toFixed(2)}`)
  w = await waitFor((x) => x.tremor === null, 6000)
  const tremorSim = w.s.lastTremor && w.s.lastTremor.end !== null ? w.s.lastTremor.end - w.s.lastTremor.start : Infinity
  void simBefore
  check('tremor: settles within 1.5 s and restores gravity', w.s.tremor === null && tremorSim <= 1.5 && w.s.worldGravity[0] === 0 && w.s.worldGravity[2] === 0 && Math.abs(w.s.worldGravity[1] + 9.81) < 1e-6, `${tremorSim.toFixed(2)} s sim, g=${w.s.worldGravity.map((v) => v.toFixed(2))}`)
  const tv = await vibs()
  check('tremor: haptic pattern [40,60,40,80,50] repeated', tv.some((v) => Array.isArray(v.p) && v.p.slice(0, 5).join(',') === '40,60,40,80,50' && v.p.length > 5))
  check('tremor: rumble synth plays', (await aud()).log.some((e) => e.kind === 'tremor' && e.voiced))
  await page.evaluate(() => (Object.getPrototypeOf(window.__playground.alive[0].body).wakeUp = window.__origWake))
  await closeDrawer()
  await sleep(300)
  await page.evaluate(() => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 24, y: 3, z: 0 }, interval: 16 })))
  s = await snap()
  check('tremor: a >18 m/s² shake (devicemotion) also triggers it', s.tremor !== null)
  await waitFor((x) => x.tremor === null, 6000)

  // ---- 3. Palettes ----
  const vBefore = (await snap()).instanceColorVersions
  await openDrawer('environment')
  await page.tap('button[aria-label="Neon Synth theme"]')
  await sleep(400)
  s = await snap()
  const neon = await page.evaluate(() => ({
    shapes: ['#ff2bd6', '#2de2ff', '#b6ff2e', '#9b5cff', '#ff7a2f', '#ffe14d', '#3dffb1', '#ff4f7a'],
    dataTheme: document.documentElement.dataset.theme,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--color-neon').trim(),
  }))
  const bumped = ['cube', 'sphere', 'cylinder'].every((t) => s.instanceColorVersions[t] > vBefore[t])
  const recoloured = s.bodies.filter((b) => !b.isNitro && !b.isDebris).every((b) => b.color === neon.shapes[b.colorIndex % 8])
  check('palette: switching theme rewrites instance colours (instanceColor.needsUpdate)', s.theme === 'neon' && bumped && recoloured, `versions ${JSON.stringify(vBefore)} → ${JSON.stringify(s.instanceColorVersions)}`)
  check('palette: UI accent follows the theme', neon.dataTheme === 'neon' && neon.accent.toLowerCase() === '#ff3ddc', `${neon.dataTheme} ${neon.accent}`)
  const neonShot = await analysePng('engine')
  check('palette: arena still renders after the switch (non-blank frame)', neonShot && neonShot.std > 8 && neonShot.darkFrac < 0.95, neonShot && `std ${neonShot.std.toFixed(1)}, mean ${neonShot.mean.toFixed(0)}`)
  await page.screenshot({ path: path.join(OUT, '30-theme-neon.png') })
  for (const t of ['Pastel Clay', 'Blueprint', 'Industrial']) {
    await page.tap(`button[aria-label="${t} theme"]`)
    await sleep(250)
  }
  check('palette: theme choice persists', (await page.evaluate(() => localStorage.getItem('pp.theme'))) === '"industrial"')
  await closeDrawer()

  // ---- 4. Freeze ----
  await page.evaluate(() => {
    const e = window.__playground
    e.placeSingularity('blackhole', e.camera.position.clone().set(0, 2.4, 0))
  })
  await sleep(300)
  check('freeze: setup — black-hole drone playing', (await aud()).stats.droneActive)
  await page.tap('button[aria-label="Freeze physics"]')
  await sleep(100)
  s = await snap()
  a = await aud()
  const frozenStep = s.stepCount
  check('freeze: HUD toggle freezes and silences voices + drone', s.frozen && a.stats.activeVoices === 0 && !a.stats.droneActive)
  await sleep(900)
  const s2f = await snap()
  check('freeze: world.step() suspended while the render loop keeps running', s2f.stepCount === frozenStep && s2f.fps > 0, `steps ${frozenStep} → ${s2f.stepCount}, fps ${s2f.fps}`)
  const camF = s2f.camera
  const fb = s2f.bodies[0]
  await swipe(fb.screen[0], fb.screen[1], fb.screen[0] + 140, fb.screen[1] + 10, 10)
  await sleep(500)
  const s3f = await snap()
  check('freeze: OrbitControls stay responsive (swipe orbits, no grab)', !s3f.dragging && JSON.stringify(s3f.camera) !== JSON.stringify(camF) && s3f.stepCount === frozenStep)
  await page.tap('button[aria-label="Freeze physics"]')
  await sleep(600)
  s = await snap()
  check('freeze: unfreeze resumes stepping and the drone', !s.frozen && s.stepCount > frozenStep + 10 && (await aud()).stats.droneActive)
  await page.evaluate(() => window.__playground.setSingularity(null))
  await sleep(200)
  check('freeze: dismissing the singularity stops its drone', !(await aud()).stats.droneActive)
  await page.evaluate(() => window.__playground.resetCamera())

  // ---- 5. Save / load (digital taxidermy) ----
  await clearArena()
  await page.evaluate(() => {
    const e = window.__playground
    e.debugSpawnAt('cube', 0, 0.48, 0)
    e.debugSpawnAt('sphere', -2, 0.5, 0.5)
    e.debugSpawnAt('cylinder', 2, 0.6, 0.5)
  })
  await sleep(1500)
  await page.tap('button[role="radio"]:has-text("Slice")')
  s = await snap()
  const cubeB = s.bodies.find((b) => b.form === 'cube')
  await swipe(cubeB.screen[0] - 60, cubeB.screen[1] - 70, cubeB.screen[0] + 8, cubeB.screen[1] + 70, 12)
  await page.tap('button[role="radio"]:has-text("Grab")')
  await page.evaluate(() => {
    const e = window.__playground
    e.fracture(e.alive.find((o) => o.form.type === 'sphere'))
  })
  await sleep(300)
  s = await snap()
  const liveCount = s.bodies.filter((b) => !b.isDebris).length
  check('save: setup — two sliced halves, a cylinder and live debris', s.bodies.filter((b) => b.isSliced).length === 2 && s.bodies.some((b) => b.isDebris), s.bodies.map((b) => b.form).join(','))
  await openDrawer('tools')
  await page.tap('button[aria-label="Save to slot 1"]')
  await sleep(200)
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pp.scene.1')))
  const keysOk = saved.bodies.every((b) => ['type', 'dimensions', 'scale', 'isSliced', 'position', 'rotation', 'colorIndex'].every((k) => k in b))
  const halvesSaved = saved.bodies.filter((b) => b.isSliced)
  check('save: debris excluded, only permanent shapes serialised', saved.bodies.length === liveCount && !saved.bodies.some((b) => b.type === 'shard'), `${saved.bodies.length} saved of ${s.bodies.length} live (${s.bodies.length - liveCount} debris)`)
  check('save: payload records type, dimensions, scale, isSliced, position, rotation, colorIndex', keysOk)
  check('save: sliced halves keep their cut dimensions', halvesSaved.length === 2 && halvesSaved.every((b) => b.type === 'box' && Math.min(...b.dimensions) < 0.47), JSON.stringify(halvesSaved.map((b) => b.dimensions.map((d) => +d.toFixed(3)))))
  const metaText = await page.locator('[data-testid="slot-1-meta"]').innerText()
  check('save: slot list shows the saved scene', /3 shapes/.test(metaText), metaText)
  await closeDrawer()
  await clearArena()
  await openDrawer('tools')
  await page.tap('button[aria-label="Load slot 1"]')
  await sleep(400)
  s = await snap()
  const match = saved.bodies.every((sb) =>
    s.bodies.some((b) => b.form === sb.type && b.isSliced === sb.isSliced && b.dims.every((d, i) => Math.abs(d - sb.dimensions[i]) < 1e-6) && b.pos.every((p, i) => Math.abs(p - sb.position[i]) < 1e-4)),
  )
  check('load: restores the same shapes, cut geometry and positions', s.bodies.length === saved.bodies.length && match)
  check('load: restored frozen with zero velocity', s.frozen && s.bodies.every((b) => Math.hypot(...b.vel) < 1e-6))
  await page.tap('button[aria-label="Freeze physics"]')
  await sleep(1200)
  s = await snap()
  check('load: stays stable after unfreezing', s.bodies.length === saved.bodies.length && s.bodies.every(inArena) && s.bodies.every((b) => Math.hypot(...b.vel) < 1.5) && s.bodies.filter((b) => b.isSliced).length === 2)

  // ---- 6. Photo mode ----
  await openDrawer('tools')
  await page.tap('button[aria-label="Take snapshot"]')
  await page.waitForSelector('[role="dialog"][aria-label="Snapshot preview"] img', { timeout: 5000 })
  await sleep(300)
  await page.screenshot({ path: path.join(OUT, '31-photo-modal.png') })
  const shot = await analysePng('[data-testid="snapshot-image"]')
  check('photo: produces a valid PNG blob', shot && shot.type === 'image/png' && shot.signature === PNG_SIG && shot.size > 20000, shot && `${(shot.size / 1024).toFixed(0)} KB ${shot.width}×${shot.height}`)
  check('photo: full-resolution, non-blank, non-black frame', shot && shot.width === shot.canvasW && shot.height === shot.canvasH && shot.std > 8 && shot.darkFrac < 0.9, shot && `std ${shot.std.toFixed(1)}, dark ${(shot.darkFrac * 100).toFixed(0)}%`)
  check('photo: preview offers a PNG download', (await page.getAttribute('[role="dialog"] a[download]', 'download'))?.endsWith('.png'))
  await page.tap('button[aria-label="Close snapshot"]')
  await sleep(200)
  check('photo: preview closes', (await page.locator('[role="dialog"][aria-label="Snapshot preview"]').count()) === 0)
  await closeDrawer()
  await clearArena()

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


  // ---- 7. HUD stays one row on narrow / short screens; stub audio without Web Audio ----
  for (const vp of [
    { name: '360x740 portrait', width: 360, height: 740 },
    { name: '740x360 landscape', width: 740, height: 360 },
  ]) {
    const ctx2 = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    const p2 = await ctx2.newPage()
    await p2.goto(URL)
    await p2.waitForFunction(() => !!window.__playground, null, { timeout: 60000 })
    // Worst case for width: 150/150 with a debris count and the recycle icon showing.
    await p2.evaluate(() => {
      const e = window.__playground
      const kinds = ['cube', 'sphere', 'cylinder']
      for (let i = 0; i < 150; i++) e.spawn(kinds[i % 3])
      e.fracture(e.alive[e.alive.length - 1])
    })
    await sleep(800)
    const hud = await p2.evaluate(() => {
      const panel = document.querySelector('header .hud-panel')
      const r = panel.getBoundingClientRect()
      const items = [...panel.querySelectorAll(':scope > div, :scope > div > button')].map((el) => el.getBoundingClientRect())
      const badge = panel.querySelector(':scope > div')
      const buttons = [...panel.querySelectorAll('button')].map((b) => b.getBoundingClientRect())
      return {
        height: r.height,
        oneRow: items.every((b) => b.top >= r.top - 1 && b.bottom <= r.bottom + 1),
        sameLine: buttons.every((b) => Math.abs(b.top - buttons[0].top) < 1),
        buttons: buttons.length,
        buttonSize: buttons.map((b) => Math.round(b.width)),
        clipped: badge.scrollWidth > badge.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
        text: badge.innerText.replace(/\s+/g, ' '),
      }
    })
    check(`HUD: single row, no wrap at ${vp.name}`, hud.height <= 50 && hud.oneRow && hud.sameLine && hud.buttons === 3 && !hud.clipped && !hud.pageOverflow, JSON.stringify(hud))
    await p2.screenshot({ path: path.join(OUT, `32-hud-${vp.width}x${vp.height}.png`) })
    await ctx2.close()
  }

  const ctx3 = await browser.newContext({ ...devices['Pixel 7'] })
  await ctx3.addInitScript(() => {
    delete window.AudioContext
    delete window.webkitAudioContext
  })
  const p3 = await ctx3.newPage()
  const stubErrors = []
  p3.on('pageerror', (e) => stubErrors.push(String(e)))
  await p3.goto(URL)
  await p3.waitForFunction(() => !!window.__playground, null, { timeout: 60000 })
  await p3.tap('button[aria-label="Spawn Cube"]')
  await p3.tap('button[aria-label="Mute sound"]')
  await sleep(2500)
  const stub = await p3.evaluate(() => ({ state: window.__audio.state, events: window.__audio.log.map((e) => e.kind), bodies: window.__playground.bodyCount }))
  check('audio: without Web Audio the manager runs as a stub, no errors', stub.state === 'stub' && stub.bodies === 1 && stubErrors.length === 0, JSON.stringify(stub) + stubErrors.join(' | '))
  await ctx3.close()

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(2)
})
