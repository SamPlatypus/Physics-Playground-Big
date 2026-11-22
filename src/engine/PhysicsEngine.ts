import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type * as RAPIER from '@dimforge/rapier3d-compat'
import {
  ARENA,
  CUBE_BEVEL,
  CUBE_SIZE,
  CYLINDER_HALF_HEIGHT,
  CYLINDER_RADIUS,
  DRAG_MAX_SPEED,
  FIXED_DT,
  FLING_HAPTIC_SPEED,
  IMPACT_ACCEL_THRESHOLD,
  MAX_BODIES,
  MAX_SUBSTEPS,
  ROLLING_RESISTANCE_MAX_SPEED,
  SHAPE_SPECS,
  SLEEP_ANGULAR_LIMIT,
  SLEEP_SPEED_LIMIT,
  SLEEP_TIME_LIMIT,
  SPHERE_RADIUS,
  THROW_MAX_SPEED,
  THROW_SAMPLE_WINDOW_MS,
  shapeFriction,
  shapeRestitution,
  type InteractionMode,
  type ShapeKind,
} from './constants'
import { haptics } from './haptics'
import {
  createFloorMaterial,
  createGlassMaterial,
  createOuterGroundMaterial,
  createShapeMaterial,
} from './materials'
import { nextSpawnColor } from './palette'

export type RapierApi = typeof RAPIER

export interface EngineStats {
  fps: number
  bodies: number
  max: number
}

export interface EngineOptions {
  gravity: number
  restitution: number
  friction: number
  mode: InteractionMode
  onStats?: (stats: EngineStats) => void
  onDragChange?: (dragging: boolean) => void
}

interface PhysObject {
  id: number
  kind: ShapeKind
  body: RAPIER.RigidBody | null
  collider: RAPIER.Collider | null
  mass: number
  color: THREE.Color
  prevPos: THREE.Vector3
  currPos: THREE.Vector3
  prevQuat: THREE.Quaternion
  currQuat: THREE.Quaternion
  settled: boolean
  /** 0 → 1 pop-in animation progress. */
  spawnT: number
  /** null while alive; 0 → 1 shrink-out progress once despawned. */
  dieT: number | null
  lastImpactAt: number
  highlighted: boolean
}

/** Finger position on the drag plane (unclamped), stamped with the pointer event time in ms. */
interface DragSample {
  t: number
  p: THREE.Vector3
}

interface DragState {
  obj: PhysObject
  pointerId: number
  plane: THREE.Plane
  offset: THREE.Vector3
  target: THREE.Vector3
  samples: DragSample[]
}

interface ArenaSurface {
  normal: THREE.Vector3
  /** Which world axis the surface is perpendicular to and where it sits. */
  axis: 'x' | 'y' | 'z'
  coord: number
}

interface ImpactRing {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  t: number
  scale: number
}

const SHAPE_KINDS: ShapeKind[] = ['cube', 'sphere', 'cylinder']
const POP_IN_SECONDS = 0.22
const SHRINK_OUT_SECONDS = 0.26
const RING_SECONDS = 0.5
const PICK_RINGS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [14, 8],
  [28, 12],
]

// Scratch objects reused every frame so the hot loop doesn't allocate.
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _q1 = new THREE.Quaternion()
const _m1 = new THREE.Matrix4()
const _scale = new THREE.Vector3()
const _ndc = new THREE.Vector2()
const _white = new THREE.Color('#ffffff')
const _tmpColor = new THREE.Color()
const _zAxis = new THREE.Vector3(0, 0, 1)

function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

/** Fallback mass from density × volume, should the engine not report one yet. */
function analyticMass(kind: ShapeKind): number {
  const density = SHAPE_SPECS[kind].density
  if (kind === 'cube') return density * CUBE_SIZE ** 3
  if (kind === 'sphere') return density * (4 / 3) * Math.PI * SPHERE_RADIUS ** 3
  return density * Math.PI * CYLINDER_RADIUS ** 2 * CYLINDER_HALF_HEIGHT * 2
}

/**
 * Owns the Three.js scene, the Rapier world and the fixed-step loop.
 * React only talks to it through the public methods and the stats callback, so
 * nothing in the 60 fps path triggers a React render.
 */
export class PhysicsEngine {
  private readonly R: RapierApi
  private readonly host: HTMLElement
  private readonly opts: EngineOptions

  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly canvas: HTMLCanvasElement

  private readonly world: RAPIER.World
  private readonly eventQueue: RAPIER.EventQueue
  private readonly ray: RAPIER.Ray
  private readonly raycaster = new THREE.Raycaster()
  private readonly arenaSurfaces = new Map<number, ArenaSurface>()

  private readonly meshes: Record<ShapeKind, THREE.InstancedMesh>
  private readonly visuals: Record<ShapeKind, PhysObject[]> = { cube: [], sphere: [], cylinder: [] }
  private readonly colorDirty: Record<ShapeKind, boolean> = { cube: true, sphere: true, cylinder: true }
  /** Live bodies in spawn order (oldest first). */
  private alive: PhysObject[] = []
  private readonly byCollider = new Map<number, PhysObject>()
  private nextId = 1

  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []

  private readonly dirLight: THREE.DirectionalLight
  private readonly tether: THREE.Group
  private readonly tetherLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
  private readonly rings: ImpactRing[] = []
  private ringCursor = 0

  private mode: InteractionMode
  private gravityY: number
  /** Sign of the most recent non-zero gravity: tells zero-G which way to lift. */
  private gravitySign = -1
  private restitution: number
  private friction: number

  private drag: DragState | null = null
  private readonly activePointers = new Set<number>()

  private rafId = 0
  private lastFrameAt = -1
  private accumulator = 0
  private simTime = 0
  private stepCount = 0
  private disposed = false
  /** How long every awake body has stayed under the sleep thresholds. */
  private calmTime = 0

  private needsRender = true
  private shadowDirty = true
  private animating = false
  /** True while any body was awake on the last physics step (render every frame to interpolate). */
  private hasMotion = false

  /** Screen-space framing: lets the arena slide/zoom into the area left uncovered by the dock. */
  private view = { cx: 0.5, cy: 0.5, zoom: 1 }
  private viewTarget = { cx: 0.5, cy: 0.5, zoom: 1 }

  private fpsFrames = 0
  private fpsWindowStart = 0
  private fps = 0
  private slowWindows = 0
  private pixelRatio: number
  private readonly resizeObserver: ResizeObserver

  constructor(R: RapierApi, host: HTMLElement, opts: EngineOptions) {
    this.R = R
    this.host = host
    this.opts = opts
    this.mode = opts.mode
    this.gravityY = opts.gravity
    if (Math.abs(opts.gravity) > 0.01) this.gravitySign = Math.sign(opts.gravity)
    this.restitution = opts.restitution
    this.friction = opts.friction

    // ---------- Renderer ----------
    const dpr = window.devicePixelRatio || 1
    this.pixelRatio = Math.min(dpr, 2)
    this.renderer = new THREE.WebGLRenderer({
      // High-DPI phones already oversample; skip MSAA there to protect the frame budget.
      antialias: dpr < 2,
      powerPreference: 'high-performance',
      stencil: false,
    })
    this.renderer.setPixelRatio(this.pixelRatio)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    // Shadows are only re-rendered when something actually moved.
    this.renderer.shadowMap.autoUpdate = false
    this.canvas = this.renderer.domElement
    this.canvas.className = 'playground-canvas'
    this.canvas.setAttribute('aria-label', '3D physics arena')
    host.appendChild(this.canvas)

    // ---------- Scene ----------
    const bg = new THREE.Color('#03050a')
    this.scene.background = bg
    this.scene.fog = new THREE.Fog(bg, 22, 58)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200)

    this.scene.add(new THREE.HemisphereLight('#9fdcff', '#0a0f1c', 1.15))
    this.dirLight = new THREE.DirectionalLight('#ffffff', 2.4)
    this.dirLight.position.set(5, 14, 7)
    this.dirLight.castShadow = true
    this.dirLight.shadow.mapSize.set(1024, 1024)
    const sc = this.dirLight.shadow.camera
    sc.left = -7
    sc.right = 7
    sc.top = 7
    sc.bottom = -7
    sc.near = 2
    sc.far = 34
    this.dirLight.shadow.bias = -0.0004
    this.dirLight.shadow.normalBias = 0.025
    this.scene.add(this.dirLight)
    const rim = new THREE.DirectionalLight('#5fb8ff', 0.6)
    rim.position.set(-8, 6, -10)
    this.scene.add(rim)

    this.buildArenaVisuals()
    this.buildStarfield()

    // ---------- Instanced shape meshes (3 draw calls for up to 450 bodies) ----------
    const shapeMaterial = createShapeMaterial()
    this.materials.push(shapeMaterial)
    const cubeGeo = new RoundedBoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE, 2, CUBE_BEVEL)
    const sphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS, 28, 18)
    const cylGeo = new THREE.CylinderGeometry(CYLINDER_RADIUS, CYLINDER_RADIUS, CYLINDER_HALF_HEIGHT * 2, 28, 1)
    this.geometries.push(cubeGeo, sphereGeo, cylGeo)
    const makeMesh = (geo: THREE.BufferGeometry) => {
      const mesh = new THREE.InstancedMesh(geo, shapeMaterial, MAX_BODIES)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BODIES * 3), 3)
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.count = 0
      // Instances roam the whole arena; skip per-mesh frustum culling.
      mesh.frustumCulled = false
      this.scene.add(mesh)
      return mesh
    }
    this.meshes = { cube: makeMesh(cubeGeo), sphere: makeMesh(sphereGeo), cylinder: makeMesh(cylGeo) }

    // ---------- Drag tether (floor marker + vertical guide) ----------
    this.tether = new THREE.Group()
    this.tether.visible = false
    const tetherRingGeo = new THREE.RingGeometry(0.42, 0.52, 40)
    tetherRingGeo.rotateX(-Math.PI / 2)
    const tetherMat = new THREE.MeshBasicMaterial({
      color: '#7cf3ff',
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: false,
    })
    const tetherRing = new THREE.Mesh(tetherRingGeo, tetherMat)
    tetherRing.name = 'tether-ring'
    this.tether.add(tetherRing)
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)])
    const lineMat = new THREE.LineBasicMaterial({ color: '#7cf3ff', transparent: true, opacity: 0.55, depthWrite: false })
    this.tetherLine = new THREE.Line(lineGeo, lineMat)
    this.tetherLine.frustumCulled = false
    this.scene.add(this.tetherLine)
    this.tetherLine.visible = false
    this.scene.add(this.tether)
    this.geometries.push(tetherRingGeo, lineGeo)
    this.materials.push(tetherMat, lineMat)

    // ---------- Impact shockwave rings ----------
    const ringGeo = new THREE.RingGeometry(0.55, 0.68, 48)
    this.geometries.push(ringGeo)
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: '#8af6ff',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      })
      this.materials.push(mat)
      const mesh = new THREE.Mesh(ringGeo, mat)
      mesh.visible = false
      this.scene.add(mesh)
      this.rings.push({ mesh, t: 1, scale: 1 })
    }

    // ---------- Physics ----------
    this.world = new R.World({ x: 0, y: this.gravityY, z: 0 })
    this.world.timestep = FIXED_DT
    this.eventQueue = new R.EventQueue(true)
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 })
    this.buildArenaColliders()

    // ---------- Input ----------
    // Our pointer handlers are registered BEFORE OrbitControls and in the capture
    // phase, so a grab can disable the controls before they ever see the touch.
    this.canvas.addEventListener('pointerdown', this.onPointerDown, { capture: true })
    this.canvas.addEventListener('pointermove', this.onPointerMove, { capture: true })
    this.canvas.addEventListener('pointerup', this.onPointerUp, { capture: true })
    this.canvas.addEventListener('pointercancel', this.onPointerUp, { capture: true })
    this.canvas.addEventListener('lostpointercapture', this.onLostCapture)
    // Pointers lifted over the HUD never reach the canvas; forget them globally.
    window.addEventListener('pointerup', this.onGlobalPointerEnd, true)
    window.addEventListener('pointercancel', this.onGlobalPointerEnd, true)
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    this.canvas.addEventListener('webglcontextlost', this.onContextLost)
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored)

    this.controls = new OrbitControls(this.camera, this.canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.09
    this.controls.enablePan = false
    this.controls.rotateSpeed = 0.75
    this.controls.zoomSpeed = 0.9
    this.controls.minDistance = 5
    this.controls.maxDistance = 34
    this.controls.maxPolarAngle = Math.PI * 0.49
    this.controls.target.set(0, 2, 0)
    this.controls.addEventListener('change', this.onControlsChange)
    this.applyModeToControls()

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(host)
    this.resize()
    this.resetCamera()

    document.addEventListener('visibilitychange', this.onVisibility)
    this.fpsWindowStart = performance.now()
    this.rafId = requestAnimationFrame(this.frame)
    this.emitStats()
  }

  // =====================================================================
  // Public API
  // =====================================================================

  spawn(kind: ShapeKind): void {
    if (this.disposed) return
    if (this.alive.length >= MAX_BODIES) this.recycleOldest()

    const R = this.R
    const spec = SHAPE_SPECS[kind]
    const g = this.gravityY
    const spread = Math.min(ARENA.halfX, ARENA.halfZ) - 1.2
    const x = (Math.random() * 2 - 1) * spread
    const z = (Math.random() * 2 - 1) * spread
    // Drop in from the side gravity pulls away from; float in the middle for zero-G.
    const y =
      g > 0.01 ? 1.2 + Math.random() * 0.8 : g < -0.01 ? ARENA.height - 1.3 - Math.random() * 0.6 : ARENA.height * 0.5
    const rot = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI),
    )

    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setLinearDamping(spec.linearDamping)
      .setAngularDamping(spec.angularDamping)
      .setCanSleep(true)
      .setCcdEnabled(true)
      .setAngvel({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: (Math.random() - 0.5) * 2 })
    if (Math.abs(g) < 0.01) {
      bodyDesc.setLinvel((Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5)
    }
    const body = this.world.createRigidBody(bodyDesc)

    let colliderDesc: RAPIER.ColliderDesc
    if (kind === 'cube') {
      const h = CUBE_SIZE / 2 - CUBE_BEVEL
      colliderDesc = R.ColliderDesc.roundCuboid(h, h, h, CUBE_BEVEL)
    } else if (kind === 'sphere') {
      colliderDesc = R.ColliderDesc.ball(SPHERE_RADIUS)
    } else {
      colliderDesc = R.ColliderDesc.cylinder(CYLINDER_HALF_HEIGHT, CYLINDER_RADIUS)
    }
    colliderDesc
      .setDensity(spec.density)
      .setRestitution(shapeRestitution(kind, this.restitution))
      .setFriction(shapeFriction(kind, this.friction))
      // Combine rules: with the arena at restitution 0 / friction 1, the sliders map 1:1.
      .setRestitutionCombineRule(R.CoefficientCombineRule.Max)
      .setFrictionCombineRule(R.CoefficientCombineRule.Min)
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
    const collider = this.world.createCollider(colliderDesc, body)
    const mass = body.mass() > 0 ? body.mass() : analyticMass(kind)
    collider.setContactForceEventThreshold(mass * IMPACT_ACCEL_THRESHOLD)

    const pos = new THREE.Vector3(x, y, z)
    const obj: PhysObject = {
      id: this.nextId++,
      kind,
      body,
      collider,
      mass,
      color: nextSpawnColor(),
      prevPos: pos.clone(),
      currPos: pos.clone(),
      prevQuat: rot.clone(),
      currQuat: rot.clone(),
      settled: false,
      spawnT: 0,
      dieT: null,
      lastImpactAt: -1,
      highlighted: false,
    }
    this.alive.push(obj)
    this.visuals[kind].push(obj)
    this.colorDirty[kind] = true
    this.byCollider.set(collider.handle, obj)
    this.markActive()
    haptics.tick()
    this.emitStats()
  }

  clearAll(): void {
    if (this.drag) this.endDrag(false)
    for (const obj of this.alive) this.removeFromPhysics(obj)
    this.alive = []
    this.byCollider.clear()
    this.markActive()
    this.emitStats()
  }

  setGravity(y: number): void {
    const wasZero = Math.abs(this.gravityY) < 0.01
    this.gravityY = y
    this.world.gravity = { x: 0, y, z: 0 }
    const nowZero = Math.abs(y) < 0.01
    for (const obj of this.alive) {
      if (!obj.body || obj === this.drag?.obj) continue
      obj.body.wakeUp()
      // Entering zero-G: a gentle lift so resting bodies visibly drift off the floor.
      if (nowZero && !wasZero) {
        obj.body.applyImpulse(
          {
            x: (Math.random() - 0.5) * 0.8 * obj.mass,
            y: (0.6 + Math.random() * 0.9) * obj.mass * (this.gravitySign < 0 ? 1 : -1),
            z: (Math.random() - 0.5) * 0.8 * obj.mass,
          },
          true,
        )
      }
    }
    if (!nowZero) this.gravitySign = Math.sign(y)
    this.markActive()
  }

  setMaterial(restitution: number, friction: number): void {
    const frictionChanged = friction !== this.friction
    this.restitution = restitution
    this.friction = friction
    for (const obj of this.alive) {
      if (!obj.collider) continue
      obj.collider.setRestitution(shapeRestitution(obj.kind, restitution))
      obj.collider.setFriction(shapeFriction(obj.kind, friction))
      // Resting bodies only notice a friction change (e.g. ice) once they're awake;
      // restitution takes effect on the next impact anyway.
      if (frictionChanged && obj !== this.drag?.obj) obj.body?.wakeUp()
    }
    this.markActive()
  }

  setMode(mode: InteractionMode): void {
    this.mode = mode
    if (mode === 'camera' && this.drag) this.endDrag(true)
    this.applyModeToControls()
  }

  resetCamera(): void {
    const aspect = this.camera.aspect || 1
    const vFov = THREE.MathUtils.degToRad(this.camera.fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)
    const needH = (ARENA.halfX * 1.32) / Math.tan(hFov / 2)
    const needV = (ARENA.height * 0.62) / Math.tan(vFov / 2)
    const dist = THREE.MathUtils.clamp(Math.max(needH, needV), 11, 30)
    const polar = THREE.MathUtils.degToRad(57)
    this.controls.target.set(0, 2, 0)
    this.camera.position.set(0, 2 + Math.cos(polar) * dist, Math.sin(polar) * dist)
    this.controls.maxDistance = Math.max(34, dist * 1.4)
    this.controls.update()
    this.needsRender = true
  }

  /**
   * Frame the arena inside a rectangle of the canvas (CSS px), e.g. the area left
   * uncovered by an open drawer. Pass null to use the full screen again.
   */
  setFocusRect(rect: { left: number; top: number; right: number; bottom: number } | null): void {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    if (!rect) {
      this.viewTarget = { cx: 0.5, cy: 0.5, zoom: 1 }
      return
    }
    const left = THREE.MathUtils.clamp(rect.left, 0, w - 1)
    const right = THREE.MathUtils.clamp(rect.right, left + 1, w)
    const top = THREE.MathUtils.clamp(rect.top, 0, h - 1)
    const bottom = THREE.MathUtils.clamp(rect.bottom, top + 1, h)
    this.viewTarget = {
      cx: (left + right) / 2 / w,
      cy: (top + bottom) / 2 / h,
      zoom: THREE.MathUtils.clamp(Math.min((right - left) / w, (bottom - top) / h), 0.5, 1),
    }
  }

  get bodyCount(): number {
    return this.alive.length
  }

  /** Introspection used by the automated touch tests (exposed on window in dev builds only). */
  debugSnapshot() {
    const rect = this.canvas.getBoundingClientRect()
    return {
      controlsEnabled: this.controls.enabled,
      dragging: this.drag !== null,
      mode: this.mode,
      gravity: this.gravityY,
      camera: this.camera.position.toArray(),
      bodies: this.alive.map((o) => {
        const p = o.currPos.clone().project(this.camera)
        const v = o.body?.linvel()
        return {
          id: o.id,
          kind: o.kind,
          pos: o.currPos.toArray(),
          screen: [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height],
          vel: v ? [v.x, v.y, v.z] : [0, 0, 0],
          sleeping: o.body?.isSleeping() ?? false,
          kinematic: o.body?.isKinematic() ?? false,
          restitution: o.collider?.restitution() ?? 0,
          friction: o.collider?.friction() ?? 0,
        }
      }),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.resizeObserver.disconnect()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown, { capture: true })
    this.canvas.removeEventListener('pointermove', this.onPointerMove, { capture: true })
    this.canvas.removeEventListener('pointerup', this.onPointerUp, { capture: true })
    this.canvas.removeEventListener('pointercancel', this.onPointerUp, { capture: true })
    this.canvas.removeEventListener('lostpointercapture', this.onLostCapture)
    window.removeEventListener('pointerup', this.onGlobalPointerEnd, true)
    window.removeEventListener('pointercancel', this.onGlobalPointerEnd, true)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    this.controls.removeEventListener('change', this.onControlsChange)
    this.controls.dispose()
    for (const g of this.geometries) g.dispose()
    for (const m of this.materials) m.dispose()
    for (const kind of SHAPE_KINDS) this.meshes[kind].dispose()
    this.renderer.dispose()
    this.canvas.remove()
    this.eventQueue.free()
    this.world.free()
  }

  // =====================================================================
  // Scene construction
  // =====================================================================

  private buildArenaVisuals(): void {
    const { halfX, halfZ, height } = ARENA

    const floorGeo = new THREE.PlaneGeometry(halfX * 2, halfZ * 2)
    floorGeo.rotateX(-Math.PI / 2)
    const floorMat = createFloorMaterial(halfX, halfZ)
    const floor = new THREE.Mesh(floorGeo, floorMat)
    floor.receiveShadow = true
    this.scene.add(floor)

    const outerGeo = new THREE.PlaneGeometry(90, 90)
    outerGeo.rotateX(-Math.PI / 2)
    const outerMat = createOuterGroundMaterial()
    const outer = new THREE.Mesh(outerGeo, outerMat)
    outer.position.y = -0.02
    this.scene.add(outer)

    // Glass walls.
    const wallMat = createGlassMaterial({ verticalGradient: true })
    const ceilingMat = createGlassMaterial({ verticalGradient: false })
    ceilingMat.uniforms.uOpacity.value = 0.015
    const wallXGeo = new THREE.PlaneGeometry(halfZ * 2, height)
    const wallZGeo = new THREE.PlaneGeometry(halfX * 2, height)
    const ceilingGeo = new THREE.PlaneGeometry(halfX * 2, halfZ * 2)
    const addPanel = (geo: THREE.PlaneGeometry, mat: THREE.Material, pos: THREE.Vector3, rotY: number, rotX = 0) => {
      const m = new THREE.Mesh(geo, mat)
      m.position.copy(pos)
      m.rotation.set(rotX, rotY, 0)
      m.renderOrder = 2
      this.scene.add(m)
    }
    addPanel(wallXGeo, wallMat, new THREE.Vector3(halfX, height / 2, 0), -Math.PI / 2)
    addPanel(wallXGeo, wallMat, new THREE.Vector3(-halfX, height / 2, 0), Math.PI / 2)
    addPanel(wallZGeo, wallMat, new THREE.Vector3(0, height / 2, halfZ), Math.PI)
    addPanel(wallZGeo, wallMat, new THREE.Vector3(0, height / 2, -halfZ), 0)
    addPanel(ceilingGeo, ceilingMat, new THREE.Vector3(0, height, 0), 0, Math.PI / 2)

    // Glowing frame along the box edges.
    const boxGeo = new THREE.BoxGeometry(halfX * 2, height, halfZ * 2)
    const edgesGeo = new THREE.EdgesGeometry(boxGeo)
    boxGeo.dispose()
    const edgesMat = new THREE.LineBasicMaterial({ color: '#56e3ff', transparent: true, opacity: 0.55 })
    const edges = new THREE.LineSegments(edgesGeo, edgesMat)
    edges.position.y = height / 2
    this.scene.add(edges)

    this.geometries.push(floorGeo, outerGeo, wallXGeo, wallZGeo, ceilingGeo, edgesGeo)
    this.materials.push(floorMat, outerMat, wallMat, ceilingMat, edgesMat)
  }

  private buildStarfield(): void {
    const count = 420
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      // Upper hemisphere shell, well outside the arena.
      const u = Math.random()
      const v = Math.random() * 0.85 + 0.1
      const theta = u * Math.PI * 2
      const phi = Math.acos(v)
      const r = 70 + Math.random() * 30
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      positions[i * 3 + 1] = r * Math.cos(phi) - 6
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      color: '#9fdcff',
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.55,
      fog: false,
      depthWrite: false,
    })
    this.scene.add(new THREE.Points(geo, mat))
    this.geometries.push(geo)
    this.materials.push(mat)
  }

  private buildArenaColliders(): void {
    const R = this.R
    const { halfX, halfZ, height, wallThickness: t } = ARENA
    const ht = t / 2
    const fixed = this.world.createRigidBody(R.RigidBodyDesc.fixed())
    const add = (hx: number, hy: number, hz: number, x: number, y: number, z: number, surface: ArenaSurface) => {
      const desc = R.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(x, y, z)
        .setFriction(1)
        .setRestitution(0)
        .setFrictionCombineRule(R.CoefficientCombineRule.Min)
        .setRestitutionCombineRule(R.CoefficientCombineRule.Max)
        // Never let the arena itself trigger force events (the bodies opt in).
        .setContactForceEventThreshold(1e12)
      const c = this.world.createCollider(desc, fixed)
      this.arenaSurfaces.set(c.handle, surface)
    }
    // Floor & ceiling.
    add(halfX + t, ht, halfZ + t, 0, -ht, 0, { normal: new THREE.Vector3(0, 1, 0), axis: 'y', coord: 0 })
    add(halfX + t, ht, halfZ + t, 0, height + ht, 0, {
      normal: new THREE.Vector3(0, -1, 0),
      axis: 'y',
      coord: height,
    })
    // Walls (taller than the interior so corners are sealed).
    const wy = height / 2
    const why = height / 2 + t
    add(ht, why, halfZ + t, halfX + ht, wy, 0, { normal: new THREE.Vector3(-1, 0, 0), axis: 'x', coord: halfX })
    add(ht, why, halfZ + t, -halfX - ht, wy, 0, { normal: new THREE.Vector3(1, 0, 0), axis: 'x', coord: -halfX })
    add(halfX + t, why, ht, 0, wy, halfZ + ht, { normal: new THREE.Vector3(0, 0, -1), axis: 'z', coord: halfZ })
    add(halfX + t, why, ht, 0, wy, -halfZ - ht, { normal: new THREE.Vector3(0, 0, 1), axis: 'z', coord: -halfZ })
  }

  // =====================================================================
  // Main loop
  // =====================================================================

  private frame = (now: number): void => {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this.frame)

    if (this.lastFrameAt < 0) this.lastFrameAt = now
    // Clamp so a backgrounded tab doesn't come back to a spiral of catch-up steps.
    const dt = Math.min((now - this.lastFrameAt) / 1000, 0.1)
    this.lastFrameAt = now
    this.trackFps(now)

    this.accumulator += dt
    let steps = 0
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.stepPhysics()
      this.accumulator -= FIXED_DT
      steps++
    }
    if (steps === MAX_SUBSTEPS && this.accumulator > FIXED_DT) this.accumulator = FIXED_DT * 0.5

    this.controls.update()
    this.updateFraming(dt)

    if (this.needsRender || this.animating || this.hasMotion || this.drag) {
      this.updateVisuals(this.accumulator / FIXED_DT, dt)
      if (this.shadowDirty) {
        this.renderer.shadowMap.needsUpdate = true
        this.shadowDirty = false
      }
      this.renderer.render(this.scene, this.camera)
      this.needsRender = false
    }
  }

  private stepPhysics(): void {
    const drag = this.drag

    // Drive the grabbed body through the physics engine (kinematic target), never the mesh.
    if (drag && drag.obj.body) {
      const cur = drag.obj.currPos
      _v1.subVectors(drag.target, cur)
      const maxStep = DRAG_MAX_SPEED * FIXED_DT
      if (_v1.lengthSq() > maxStep * maxStep) _v1.setLength(maxStep)
      _v1.add(cur)
      drag.obj.body.setNextKinematicTranslation({ x: _v1.x, y: _v1.y, z: _v1.z })
    }

    this.world.step(this.eventQueue)
    this.simTime += FIXED_DT
    this.stepCount++

    this.eventQueue.drainContactForceEvents((event) => {
      const h1 = event.collider1()
      const h2 = event.collider2()
      const s1 = this.arenaSurfaces.get(h1)
      const s2 = this.arenaSurfaces.get(h2)
      const surface = s1 ?? s2
      if (!surface) return // body-vs-body contacts don't rumble
      const obj = this.byCollider.get(s1 ? h2 : h1)
      if (!obj || obj.mass <= 0) return
      if (event.totalForceMagnitude() / obj.mass < IMPACT_ACCEL_THRESHOLD) return
      if (this.simTime - obj.lastImpactAt < 0.15) return
      obj.lastImpactAt = this.simTime
      haptics.rumble()
      this.spawnImpactRing(obj, surface, event.totalForceMagnitude() / obj.mass)
    })

    // Velocity checks run at 12 Hz; that's plenty for sleep and rolling resistance.
    const checkSleep = this.stepCount % 5 === 0
    const checkDt = FIXED_DT * 5
    const hasGravity = Math.abs(this.gravityY) > 0.01
    let anyAwake = false
    let allCalm = true
    for (const obj of this.alive) {
      const body = obj.body
      if (!body) continue
      if (body.isSleeping()) {
        if (!obj.settled) {
          obj.prevPos.copy(obj.currPos)
          obj.prevQuat.copy(obj.currQuat)
          obj.settled = true
          this.shadowDirty = true
          this.needsRender = true
        }
        continue
      }
      anyAwake = true
      obj.settled = false
      obj.prevPos.copy(obj.currPos)
      obj.prevQuat.copy(obj.currQuat)
      const t = body.translation()
      const r = body.rotation()
      obj.currPos.set(t.x, t.y, t.z)
      obj.currQuat.set(r.x, r.y, r.z, r.w)

      // Safety net: anything that tunnels out of the box is put back inside.
      if (
        Math.abs(t.x) > ARENA.halfX + 2 ||
        Math.abs(t.z) > ARENA.halfZ + 2 ||
        t.y < -2 ||
        t.y > ARENA.height + 2
      ) {
        body.setTranslation({ x: 0, y: ARENA.height * 0.5, z: 0 }, true)
        body.setLinvel({ x: 0, y: 0, z: 0 }, true)
        obj.currPos.set(0, ARENA.height * 0.5, 0)
        obj.prevPos.copy(obj.currPos)
      }

      if (!checkSleep || obj === drag?.obj) continue
      const lv = body.linvel()
      const av = body.angvel()
      let lin2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z
      let ang2 = av.x * av.x + av.y * av.y + av.z * av.z

      // Rolling resistance for slow bodies resting on the "down" surface, scaled by
      // the friction slider (ice keeps gliding). Rapier has no rolling friction.
      const spec = SHAPE_SPECS[obj.kind]
      if (hasGravity && spec.rollingResistance > 0 && lin2 < ROLLING_RESISTANCE_MAX_SPEED ** 2) {
        const onDownSurface =
          this.gravityY < 0 ? t.y < spec.boundingRadius + 0.06 : t.y > ARENA.height - spec.boundingRadius - 0.06
        const k = Math.exp(-spec.rollingResistance * this.friction * checkDt)
        if (onDownSurface && k < 0.9999) {
          body.setLinvel({ x: lv.x * k, y: lv.y, z: lv.z * k }, false)
          body.setAngvel({ x: av.x * k, y: av.y * k, z: av.z * k }, false)
          lin2 *= k * k
          ang2 *= k * k
        }
      }

      if (lin2 > SLEEP_SPEED_LIMIT ** 2 || ang2 > SLEEP_ANGULAR_LIMIT ** 2) allCalm = false
    }

    // Explicit sleep thresholds (sleepSpeedLimit / sleepTimeLimit), applied island-safely.
    // Rapier already sleeps each contact island on its own; forcing individual bodies to
    // sleep inside a moving pile would leave them hovering when their support moves away.
    // So bodies are only forced asleep once *every* awake body has been calm for
    // SLEEP_TIME_LIMIT, which lets a settled scene drop out of the solver quickly.
    if (checkSleep) {
      if (anyAwake && allCalm && hasGravity && !drag) {
        this.calmTime += checkDt
        if (this.calmTime >= SLEEP_TIME_LIMIT) {
          for (const obj of this.alive) {
            if (obj.body && !obj.body.isSleeping()) obj.body.sleep()
          }
          this.calmTime = 0
        }
      } else {
        this.calmTime = 0
      }
    }

    this.hasMotion = anyAwake
    if (anyAwake) {
      this.needsRender = true
      this.shadowDirty = true
    }
  }

  private updateVisuals(alpha: number, dt: number): void {
    let animating = false
    for (const kind of SHAPE_KINDS) {
      const list = this.visuals[kind]
      const mesh = this.meshes[kind]

      // Advance pop-in / shrink-out animations and compact finished despawns out.
      let write = 0
      for (let i = 0; i < list.length; i++) {
        const obj = list[i]
        if (obj.dieT !== null) {
          obj.dieT += dt / SHRINK_OUT_SECONDS
          if (obj.dieT >= 1) continue
          animating = true
        } else if (obj.spawnT < 1) {
          obj.spawnT = Math.min(1, obj.spawnT + dt / POP_IN_SECONDS)
          animating = true
        }
        list[write++] = obj
      }
      if (write !== list.length) {
        list.length = write
        this.colorDirty[kind] = true // instance indices shifted
        this.shadowDirty = true
      }

      const writeColors = this.colorDirty[kind]
      for (let i = 0; i < list.length; i++) {
        const obj = list[i]
        const s =
          obj.dieT !== null
            ? 1 - obj.dieT * obj.dieT
            : obj.spawnT < 1
              ? 0.25 + 0.75 * easeOutBack(obj.spawnT)
              : 1
        _v1.lerpVectors(obj.prevPos, obj.currPos, alpha)
        _q1.slerpQuaternions(obj.prevQuat, obj.currQuat, alpha)
        _scale.setScalar(s)
        _m1.compose(_v1, _q1, _scale)
        mesh.setMatrixAt(i, _m1)
        if (writeColors) {
          _tmpColor.copy(obj.color)
          if (obj.highlighted) _tmpColor.lerp(_white, 0.4)
          mesh.setColorAt(i, _tmpColor)
        }
      }
      mesh.count = list.length
      mesh.instanceMatrix.needsUpdate = true
      if (writeColors && mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true
        this.colorDirty[kind] = false
      }
    }

    // Drag tether follows the interpolated body.
    if (this.drag) {
      const obj = this.drag.obj
      _v1.lerpVectors(obj.prevPos, obj.currPos, alpha)
      this.tether.visible = true
      this.tether.position.set(_v1.x, 0.02, _v1.z)
      const pos = this.tetherLine.geometry.attributes.position as THREE.BufferAttribute
      pos.setXYZ(0, _v1.x, 0.02, _v1.z)
      pos.setXYZ(1, _v1.x, _v1.y, _v1.z)
      pos.needsUpdate = true
      this.tetherLine.visible = true
      animating = true
    } else if (this.tether.visible) {
      this.tether.visible = false
      this.tetherLine.visible = false
      this.needsRender = true
    }

    // Impact rings.
    for (const ring of this.rings) {
      if (ring.t >= 1) continue
      ring.t = Math.min(1, ring.t + dt / RING_SECONDS)
      const k = 1 - Math.pow(1 - ring.t, 3)
      ring.mesh.scale.setScalar(ring.scale * (0.35 + 1.4 * k))
      ring.mesh.material.opacity = 0.75 * (1 - ring.t)
      ring.mesh.visible = ring.t < 1
      animating = true
    }

    if (animating) this.shadowDirty = true
    this.animating = animating
  }

  // =====================================================================
  // Bodies
  // =====================================================================

  private removeFromPhysics(obj: PhysObject): void {
    if (obj.collider) this.byCollider.delete(obj.collider.handle)
    if (obj.body) this.world.removeRigidBody(obj.body)
    obj.body = null
    obj.collider = null
    obj.highlighted = false
    obj.dieT = 0
    obj.prevPos.copy(obj.currPos)
    obj.prevQuat.copy(obj.currQuat)
    this.colorDirty[obj.kind] = true
  }

  /** Called when the cap is hit: recycle the oldest resting body (or the oldest at all). */
  private recycleOldest(): void {
    let victimIndex = -1
    for (let i = 0; i < this.alive.length; i++) {
      const obj = this.alive[i]
      if (obj === this.drag?.obj) continue
      if (obj.body?.isSleeping()) {
        victimIndex = i
        break
      }
    }
    if (victimIndex < 0) {
      victimIndex = this.alive.findIndex((o) => o !== this.drag?.obj)
    }
    if (victimIndex < 0) return
    const [victim] = this.alive.splice(victimIndex, 1)
    // Wake whatever was resting on it so the pile settles naturally.
    this.removeFromPhysics(victim)
    for (const obj of this.alive) {
      if (obj.body && obj.currPos.distanceToSquared(victim.currPos) < 4) obj.body.wakeUp()
    }
  }

  private spawnImpactRing(obj: PhysObject, surface: ArenaSurface, strength: number): void {
    const ring = this.rings[this.ringCursor]
    this.ringCursor = (this.ringCursor + 1) % this.rings.length
    _v2.copy(obj.currPos)
    const inset = 0.03
    if (surface.axis === 'x') _v2.x = surface.coord + surface.normal.x * inset
    else if (surface.axis === 'y') _v2.y = surface.coord + surface.normal.y * inset
    else _v2.z = surface.coord + surface.normal.z * inset
    ring.mesh.position.copy(_v2)
    ring.mesh.quaternion.setFromUnitVectors(_zAxis, surface.normal)
    ring.mesh.material.color.copy(obj.color).lerp(_white, 0.45)
    ring.scale = THREE.MathUtils.clamp(strength / 700, 0.7, 1.3)
    ring.t = 0
    ring.mesh.visible = true
    this.needsRender = true
  }

  private markActive(): void {
    this.needsRender = true
    this.shadowDirty = true
  }

  private emitStats(): void {
    this.opts.onStats?.({ fps: this.fps, bodies: this.alive.length, max: MAX_BODIES })
  }

  // =====================================================================
  // Picking & dragging
  // =====================================================================

  private pick(clientX: number, clientY: number): { obj: PhysObject; point: THREE.Vector3 } | null {
    const R = this.R
    const rect = this.canvas.getBoundingClientRect()
    const origin = this.camera.position
    // Fat-finger assist: centre ray first, then rings of rays around the touch point.
    for (const [radius, count] of PICK_RINGS) {
      let best: { obj: PhysObject; toi: number; dir: THREE.Vector3 } | null = null
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2
        const px = clientX + Math.cos(a) * radius
        const py = clientY + Math.sin(a) * radius
        _ndc.set(((px - rect.left) / rect.width) * 2 - 1, -((py - rect.top) / rect.height) * 2 + 1)
        const dir = new THREE.Vector3(_ndc.x, _ndc.y, 0.5).unproject(this.camera).sub(origin).normalize()
        this.ray.origin = { x: origin.x, y: origin.y, z: origin.z }
        this.ray.dir = { x: dir.x, y: dir.y, z: dir.z }
        const hit = this.world.castRay(
          this.ray,
          200,
          true,
          R.QueryFilterFlags.EXCLUDE_FIXED,
          undefined,
          undefined,
          undefined,
          (c) => this.byCollider.has(c.handle),
        )
        if (!hit) continue
        const obj = this.byCollider.get(hit.collider.handle)
        if (!obj || obj.dieT !== null) continue
        if (!best || hit.timeOfImpact < best.toi) best = { obj, toi: hit.timeOfImpact, dir }
      }
      if (best) {
        const point = origin.clone().addScaledVector(best.dir, best.toi)
        return { obj: best.obj, point }
      }
    }
    return null
  }

  private pointerToPlane(clientX: number, clientY: number, plane: THREE.Plane, out: THREE.Vector3): boolean {
    const rect = this.canvas.getBoundingClientRect()
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    const raycaster = this.raycaster
    raycaster.setFromCamera(_ndc, this.camera)
    return raycaster.ray.intersectPlane(plane, out) !== null
  }

  private startDrag(obj: PhysObject, point: THREE.Vector3, pointerId: number, time: number): void {
    const body = obj.body
    if (!body) return
    const R = this.R
    const t = body.translation()
    const bodyPos = new THREE.Vector3(t.x, t.y, t.z)
    const normal = this.camera.getWorldDirection(new THREE.Vector3()).negate()
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point)

    // Hand the body over to kinematic control: the solver now moves it to our target
    // each step, and it still shoves everything it touches.
    body.setBodyType(R.RigidBodyType.KinematicPositionBased, true)
    obj.currPos.copy(bodyPos)
    obj.prevPos.copy(bodyPos)
    obj.highlighted = true
    obj.settled = false
    this.colorDirty[obj.kind] = true

    this.drag = {
      obj,
      pointerId,
      plane,
      offset: point.clone().sub(bodyPos),
      target: bodyPos.clone(),
      samples: [{ t: time, p: bodyPos.clone() }],
    }
    haptics.tap()
    this.markActive()
    this.opts.onDragChange?.(true)
  }

  private updateDragTarget(clientX: number, clientY: number, time: number): void {
    const drag = this.drag
    if (!drag) return
    if (!this.pointerToPlane(clientX, clientY, drag.plane, _v2)) return
    _v2.sub(drag.offset)
    this.recordDragSample(drag, time, _v2)
    const r = SHAPE_SPECS[drag.obj.kind].boundingRadius
    drag.target.set(
      THREE.MathUtils.clamp(_v2.x, -ARENA.halfX + r, ARENA.halfX - r),
      THREE.MathUtils.clamp(_v2.y, r, ARENA.height - r),
      THREE.MathUtils.clamp(_v2.z, -ARENA.halfZ + r, ARENA.halfZ - r),
    )
  }

  /**
   * Keeps the finger's recent path. Samples are the *unclamped* drag-plane points,
   * so a swipe that drives the body against the glass still throws it into the glass.
   */
  private recordDragSample(drag: DragState, t: number, p: THREE.Vector3): void {
    const samples = drag.samples
    const last = samples[samples.length - 1]
    if (last && t <= last.t) {
      last.p.copy(p)
      return
    }
    samples.push({ t, p: p.clone() })
    // Keep one anchor sample at or before the window start; drop anything older.
    while (samples.length > 2 && t - samples[1].t >= THROW_SAMPLE_WINDOW_MS) samples.shift()
  }

  /**
   * Finger velocity over the last ~80 ms before release (m/s). The release moment
   * itself is the final sample, so a finger that stopped before lifting throws nothing.
   */
  private releaseVelocity(drag: DragState, releaseTime: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0)
    const samples = drag.samples
    const last = samples[samples.length - 1]
    let anchor = samples[0]
    for (const s of samples) {
      if (s.t <= releaseTime - THROW_SAMPLE_WINDOW_MS) anchor = s
      else break
    }
    const dt = (Math.max(releaseTime, last.t) - anchor.t) / 1000
    if (dt > 0.008) out.subVectors(last.p, anchor.p).divideScalar(dt)
    if (out.length() > THROW_MAX_SPEED) out.setLength(THROW_MAX_SPEED)
    return out
  }

  /** Release the grabbed body back to the solver, optionally throwing it. */
  private endDrag(throwIt: boolean, releaseTime: number = performance.now()): void {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    const obj = drag.obj
    obj.highlighted = false
    this.colorDirty[obj.kind] = true

    try {
      if (this.canvas.hasPointerCapture(drag.pointerId)) this.canvas.releasePointerCapture(drag.pointerId)
    } catch {
      /* pointer already gone */
    }

    const body = obj.body
    if (body) {
      const velocity = new THREE.Vector3()
      if (throwIt) this.releaseVelocity(drag, releaseTime, velocity)

      body.setBodyType(this.R.RigidBodyType.Dynamic, true)
      body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      // A little tumble in the direction of travel makes throws feel physical.
      const spin = new THREE.Vector3(velocity.z, 0, -velocity.x).multiplyScalar(0.35)
      if (spin.length() > 9) spin.setLength(9)
      body.setAngvel({ x: spin.x, y: spin.y, z: spin.z }, true)
      // Linear throw impulse: J = m · v.
      const m = obj.mass
      body.applyImpulse({ x: velocity.x * m, y: velocity.y * m, z: velocity.z * m }, true)
      if (velocity.length() >= FLING_HAPTIC_SPEED) haptics.fling()
    }

    // Camera interference safeguard: controls come back the moment the finger lifts.
    this.applyModeToControls()
    this.markActive()
    this.opts.onDragChange?.(false)
  }

  private onPointerDown = (e: PointerEvent): void => {
    const othersDown = this.activePointers.size > 0
    this.activePointers.add(e.pointerId)
    if (this.mode !== 'interact' || this.drag || othersDown) return
    if (e.pointerType === 'mouse' && e.button !== 0) return

    const hit = this.pick(e.clientX, e.clientY)
    if (!hit) return

    // Camera interference safeguard: disable OrbitControls *before* its own
    // pointerdown handler runs, so the orbit never fights the drag.
    this.controls.enabled = false
    e.stopImmediatePropagation()
    e.preventDefault()
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    this.startDrag(hit.obj, hit.point, e.pointerId, e.timeStamp)
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return
    e.stopImmediatePropagation()
    // Coalesced events give the full-rate finger path between frames (better throws).
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    if (events.length) for (const ce of events) this.updateDragTarget(ce.clientX, ce.clientY, ce.timeStamp)
    else this.updateDragTarget(e.clientX, e.clientY, e.timeStamp)
  }

  private onPointerUp = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId)
    if (this.drag && e.pointerId === this.drag.pointerId) {
      e.stopImmediatePropagation()
      this.endDrag(e.type !== 'pointercancel', e.timeStamp)
    }
  }

  private onLostCapture = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.pointerId) {
      this.activePointers.delete(e.pointerId)
      this.endDrag(true, e.timeStamp)
    }
  }

  private onGlobalPointerEnd = (e: PointerEvent): void => {
    if (e.pointerId !== this.drag?.pointerId) this.activePointers.delete(e.pointerId)
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault()
  }

  private applyModeToControls(): void {
    const camera = this.mode === 'camera'
    // Interact: one finger is reserved for grabbing; two-finger pinch still zooms.
    // Camera: one finger orbits, two-finger pinch zooms.
    this.controls.touches.ONE = camera ? THREE.TOUCH.ROTATE : null
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_PAN
    this.controls.mouseButtons.LEFT = camera ? THREE.MOUSE.ROTATE : null
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE
    this.controls.enabled = !this.drag
  }

  private onControlsChange = (): void => {
    this.needsRender = true
  }

  // =====================================================================
  // Housekeeping
  // =====================================================================

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.applyFraming()
    this.needsRender = true
  }

  private updateFraming(dt: number): void {
    const v = this.view
    const t = this.viewTarget
    const settled =
      Math.abs(v.cx - t.cx) < 1e-4 && Math.abs(v.cy - t.cy) < 1e-4 && Math.abs(v.zoom - t.zoom) < 1e-4
    if (settled) {
      if (v.cx !== t.cx || v.cy !== t.cy || v.zoom !== t.zoom) {
        Object.assign(v, t)
        this.applyFraming()
      }
      return
    }
    const k = 1 - Math.exp(-dt * 12)
    v.cx += (t.cx - v.cx) * k
    v.cy += (t.cy - v.cy) * k
    v.zoom += (t.zoom - v.zoom) * k
    this.applyFraming()
  }

  /**
   * Uses a camera view offset so the whole projection (and therefore picking)
   * moves and scales together: the virtual image is zoom × the canvas, with its
   * centre placed at the focus rectangle's centre.
   */
  private applyFraming(): void {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    const { cx, cy, zoom } = this.view
    if (Math.abs(cx - 0.5) < 1e-4 && Math.abs(cy - 0.5) < 1e-4 && Math.abs(zoom - 1) < 1e-4) {
      this.camera.clearViewOffset()
    } else {
      const fullW = w * zoom
      const fullH = h * zoom
      this.camera.setViewOffset(fullW, fullH, fullW / 2 - cx * w, fullH / 2 - cy * h, w, h)
    }
    this.camera.updateProjectionMatrix()
    this.needsRender = true
  }

  private trackFps(now: number): void {
    this.fpsFrames++
    const elapsed = now - this.fpsWindowStart
    if (elapsed < 500) return
    this.fps = Math.round((this.fpsFrames * 1000) / elapsed)
    this.fpsFrames = 0
    this.fpsWindowStart = now
    this.emitStats()

    // Adaptive resolution: if we're consistently missing the budget while the
    // scene is busy, shave the render resolution (never below 1×).
    if (this.fps < 45 && document.visibilityState === 'visible') {
      this.slowWindows++
      if (this.slowWindows >= 4 && this.pixelRatio > 1) {
        this.pixelRatio = Math.max(1, this.pixelRatio - 0.25)
        this.renderer.setPixelRatio(this.pixelRatio)
        this.resize()
        this.slowWindows = 0
      }
    } else {
      this.slowWindows = 0
    }
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      this.lastFrameAt = -1
      this.accumulator = 0
      this.fpsFrames = 0
      this.fpsWindowStart = performance.now()
      this.slowWindows = 0
      this.needsRender = true
    } else {
      this.activePointers.clear()
      if (this.drag) this.endDrag(false)
    }
  }

  private onContextLost = (e: Event): void => {
    e.preventDefault()
    cancelAnimationFrame(this.rafId)
  }

  private onContextRestored = (): void => {
    this.lastFrameAt = -1
    this.needsRender = true
    this.shadowDirty = true
    this.rafId = requestAnimationFrame(this.frame)
  }
}
