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
  const touch = async (type, x, y) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 6, radiusY: 6, force: 1 }],
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
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', sx + i * 30, sy - 120 - i * 25)
    await sleep(16)
  }
  await touch('touchEnd', 0, 0)
  await sleep(30)
  s = await snap()
  const flung = s.bodies.find((b) => b.id === target.id)
  const speed = Math.hypot(...flung.vel)
  check('release returns body to dynamic', !flung.kinematic && !s.dragging)
  check('release applies throw velocity', speed > 4, `speed ${speed.toFixed(2)} m/s vel=${flung.vel.map((v) => v.toFixed(2))}`)
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
  await page.tap('button[role="radio"][aria-checked="false"]:has-text("Orbit")')
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
  await page.tap('button[aria-label="Gravity and environment settings"]')
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
  const sph = s.bodies.find((b) => b.kind === 'sphere')
  const cube = s.bodies.find((b) => b.kind === 'cube')
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
  const dockTop = await page.evaluate(() => document.getElementById('environment-dock').getBoundingClientRect().top)
  const visible = s.bodies.filter((b) => b.screen[1] > 120 && b.screen[1] < dockTop - 30 && b.screen[0] > 30 && b.screen[0] < 380)
  if (visible.length) {
    const vb = visible[visible.length - 1]
    await touch('touchStart', vb.screen[0], vb.screen[1])
    await sleep(60)
    const sd = await snap()
    check('grab works with dock open (framed view)', sd.dragging, `picked at ${vb.screen.map((v) => v.toFixed(0))}`)
    await touch('touchEnd', 0, 0)
    await sleep(100)
  } else {
    check('grab works with dock open (framed view)', false, 'no visible body above dock')
  }
  await page.tap('button[aria-label="Close environment settings"]')
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
