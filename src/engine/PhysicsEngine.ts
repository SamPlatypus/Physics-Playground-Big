import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type * as RAPIER from '@dimforge/rapier3d-compat'
import {
  ARENA,
  BLAST_FRACTURE_RADIUS,
  BLAST_MAX_SPEED,
  BLAST_RADIUS,
  CHAIN_DELAY_STEPS,
  DEBRIS_FADE_SECONDS,
  DEBRIS_MAX_LIFETIME,
  DEBRIS_REST_SECONDS,
  DEBRIS_REST_SPEED,
  DEBRIS_SLOW_SECONDS,
  DEBRIS_SLOW_SPEED,
  DRAG_MAX_SPEED,
  FIRST_IMPACT_GRACE_SECONDS,
  FIXED_DT,
  FLING_HAPTIC_SPEED,
  FRACTURE_ENERGY_PER_KG,
  FRACTURE_SCATTER_SPEED,
  IMPACT_ACCEL_THRESHOLD,
  MATERIAL_SPECS,
  MAX_BODIES,
  MAX_FRACTURES_PER_STEP,
  MAX_SUBSTEPS,
  NITRO_TRIGGER_ENERGY_PER_KG,
  ROLLING_RESISTANCE_MAX_SPEED,
  SINGULARITY,
  SLEEP_ANGULAR_LIMIT,
  SLEEP_SPEED_LIMIT,
  SLEEP_TIME_LIMIT,
  SLICE_SEGMENT_PX,
  SLICE_SEPARATION_SPEED,
  SPAWN_GRACE_SECONDS,
  THROW_MAX_SPEED,
  THROW_SAMPLE_WINDOW_MS,
  materialFriction,
  materialRestitution,
  type InteractionMode,
  type MaterialClass,
  type ShapeKind,
  type SingularityType,
} from './constants'
import { fractureLayout, sliceLayout } from './breakage'
import { Explosions, ImpactRings, LaserOverlay, SingularityFx } from './effects'
import {
  CUBE_FORM,
  CYLINDER_FORM,
  FORM_TYPES,
  NITRO_FORM,
  SPHERE_FORM,
  createColliderDesc,
  createFormGeometries,
  formBoundingRadius,
  formVisualScale,
  formVolume,
  type Form,
  type FormType,
} from './forms'
import { haptics } from './haptics'
import {
  createFloorMaterial,
  createGlassMaterial,
  createOuterGroundMaterial,
  createShapeMaterial,
} from './materials'
import { createNitroMaterial, type NitroMaterial } from './nitro'
import { nextSpawnColor } from './palette'

export type RapierApi = typeof RAPIER

export interface EngineStats {
  fps: number
  bodies: number
  debris: number
  max: number
}

export interface SingularityState {
  /** Type that is placed, or armed and waiting for a tap. */
  type: SingularityType | null
  placed: boolean
}

export interface EngineOptions {
  gravity: number
  restitution: number
  friction: number
  mode: InteractionMode
  destructible: boolean
  onStats?: (stats: EngineStats) => void
  onDragChange?: (dragging: boolean) => void
  onSingularityChange?: (state: SingularityState) => void
}

interface PhysObject {
  id: number
  form: Form
  material: MaterialClass
  body: RAPIER.RigidBody | null
  collider: RAPIER.Collider | null
  mass: number
  color: THREE.Color
  /** Per-instance scale mapping the bucket geometry onto this body's form. */
  scale: THREE.Vector3
  /** Bounding radius around the body origin. */
  radius: number
  prevPos: THREE.Vector3
  currPos: THREE.Vector3
  prevQuat: THREE.Quaternion
  currQuat: THREE.Quaternion
  settled: boolean
  /** 0 → 1 pop-in animation progress. */
  spawnT: number
  /** null while alive; 0 → 1 shrink-out progress once despawned. */
  dieT: number | null
  /** Debris fade (darken + shrink) instead of the plain shrink. */
  fadeOut: boolean
  lastImpactAt: number
  highlighted: boolean
  /** Fracture shard: no contact-force events, never fractures or slices again. */
  isDebris: boolean
  /** Product of a laser cut: can't be sliced again. */
  isSliced: boolean
  isNitro: boolean
  /** Impacts before this sim time never break / detonate the body. */
  graceUntil: number
  /** Spawn grace ends shortly after the first impact (the landing). */
  awaitingFirstImpact: boolean
  /** 1 → 0 glow on fresh laser cuts. */
  heat: number
  bornAt: number
  debrisSlow: number
  debrisRest: number
  pendingFracture: boolean
  /** Nitro detonation queued. */
  armed: boolean
  inField: boolean
  inCore: boolean
}

interface BodyInit {
  form: Form
  material: MaterialClass
  pos: THREE.Vector3
  quat: THREE.Quaternion
  linvel?: THREE.Vector3
  angvel?: THREE.Vector3
  /** Explicit mass (fragments / halves split their parent's); otherwise density × volume. */
  mass?: number
  color: THREE.Color
  isDebris?: boolean
  isSliced?: boolean
  popIn?: boolean
  /** 'spawn' = protected until shortly after the first landing; a number = seconds of protection. */
  grace?: 'spawn' | number
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

interface SliceState {
  pointerId: number
  lastX: number
  lastY: number
  cut: Set<number>
}

interface SingularityGesture {
  pointerId: number
  startX: number
  startY: number
  startTime: number
  moved: boolean
  placing: boolean
}

interface Singularity {
  type: SingularityType
  pos: THREE.Vector3
  pulseT: number
}

interface ArenaSurface {
  normal: THREE.Vector3
  /** Which world axis the surface is perpendicular to and where it sits. */
  axis: 'x' | 'y' | 'z'
  coord: number
}

export interface DetonationRecord {
  id: number
  step: number
  time: number
}

const POP_IN_SECONDS = 0.22
const SHRINK_OUT_SECONDS = 0.26
const HEAT_SECONDS = 0.9
const PICK_RINGS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [14, 8],
  [28, 12],
]
const STEP_TIMING_SAMPLES = 240

// Scratch objects reused every frame so the hot loop doesn't allocate.
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q1 = new THREE.Quaternion()
const _m1 = new THREE.Matrix4()
const _scale = new THREE.Vector3()
const _ndc = new THREE.Vector2()
const _white = new THREE.Color('#ffffff')
const _hot = new THREE.Color('#ff8a3a')
const _void = new THREE.Color('#03050a')
const _tmpColor = new THREE.Color()
const _up = new THREE.Vector3(0, 1, 0)

function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

function spawnForm(kind: ShapeKind): Form {
  switch (kind) {
    case 'cube':
      return CUBE_FORM()
    case 'sphere':
      return SPHERE_FORM()
    case 'cylinder':
      return CYLINDER_FORM()
    case 'nitro':
      return NITRO_FORM()
  }
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? THREE.MathUtils.clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
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

  private readonly meshes: Record<FormType, THREE.InstancedMesh>
  private readonly visuals = {} as Record<FormType, PhysObject[]>
  private readonly colorDirty = {} as Record<FormType, boolean>
  /** Live bodies in spawn order (oldest first). */
  private alive: PhysObject[] = []
  private readonly byCollider = new Map<number, PhysObject>()
  private nextId = 1

  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly textures: THREE.Texture[] = []
  private readonly nitroMaterial: NitroMaterial

  private readonly dirLight: THREE.DirectionalLight
  private readonly tether: THREE.Group
  private readonly tetherLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
  private readonly impactRings: ImpactRings
  private readonly explosions: Explosions
  private readonly laser: LaserOverlay
  private readonly singularityFx: SingularityFx

  private mode: InteractionMode
  private gravityY: number
  /** Sign of the most recent non-zero gravity: tells zero-G which way to lift. */
  private gravitySign = -1
  private restitution: number
  private friction: number
  private destructible: boolean

  private drag: DragState | null = null
  private slice: SliceState | null = null
  private singularity: Singularity | null = null
  private armedSingularity: SingularityType | null = null
  private singularityGesture: SingularityGesture | null = null
  private readonly activePointers = new Set<number>()

  private fractureQueue: PhysObject[] = []
  private detonations: { obj: PhysObject; dueStep: number }[] = []
  private lastScheduledDetonation = -Infinity
  private readonly detonationLog: DetonationRecord[] = []
  /** Recent impact energies (J/kg) for diagnostics and tests. */
  private readonly impactLog: { id: number; energyPerKg: number; time: number }[] = []
  private fieldMaxSpeed = 0

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
  private statsDirty = true

  /** Screen-space framing: lets the arena slide/zoom into the area left uncovered by the dock. */
  private view = { cx: 0.5, cy: 0.5, zoom: 1 }
  private viewTarget = { cx: 0.5, cy: 0.5, zoom: 1 }

  private fpsFrames = 0
  private fpsWindowStart = 0
  private fps = 0
  private slowWindows = 0
  private pixelRatio: number
  private readonly resizeObserver: ResizeObserver
  private readonly stepTimings = new Float32Array(STEP_TIMING_SAMPLES)
  private stepTimingCursor = 0

  constructor(R: RapierApi, host: HTMLElement, opts: EngineOptions) {
    this.R = R
    this.host = host
    this.opts = opts
    this.mode = opts.mode
    this.gravityY = opts.gravity
    if (Math.abs(opts.gravity) > 0.01) this.gravitySign = Math.sign(opts.gravity)
    this.restitution = opts.restitution
    this.friction = opts.friction
    this.destructible = opts.destructible

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

    // ---------- Instanced body meshes: one draw call per form, whatever the body count ----------
    const shapeMaterial = createShapeMaterial()
    this.nitroMaterial = createNitroMaterial()
    this.materials.push(shapeMaterial, this.nitroMaterial.material)
    this.textures.push(...this.nitroMaterial.textures)
    const geometries = createFormGeometries()
    const meshes = {} as Record<FormType, THREE.InstancedMesh>
    for (const type of FORM_TYPES) {
      const geo = geometries[type]
      this.geometries.push(geo)
      const mesh = new THREE.InstancedMesh(
        geo,
        type === 'nitro' ? this.nitroMaterial.material : shapeMaterial,
        MAX_BODIES,
      )
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BODIES * 3), 3)
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.count = 0
      mesh.visible = false
      // Instances roam the whole arena; skip per-mesh frustum culling.
      mesh.frustumCulled = false
      this.scene.add(mesh)
      meshes[type] = mesh
      this.visuals[type] = []
      this.colorDirty[type] = true
    }
    this.meshes = meshes

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
    this.tether.add(new THREE.Mesh(tetherRingGeo, tetherMat))
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)])
    const lineMat = new THREE.LineBasicMaterial({ color: '#7cf3ff', transparent: true, opacity: 0.55, depthWrite: false })
    this.tetherLine = new THREE.Line(lineGeo, lineMat)
    this.tetherLine.frustumCulled = false
    this.tetherLine.visible = false
    this.scene.add(this.tetherLine, this.tether)
    this.geometries.push(tetherRingGeo, lineGeo)
    this.materials.push(tetherMat, lineMat)

    // ---------- Pooled effects ----------
    this.impactRings = new ImpactRings(this.scene)
    this.explosions = new Explosions(this.scene)
    this.singularityFx = new SingularityFx(this.scene)
    this.laser = new LaserOverlay(host)

    // ---------- Physics ----------
    this.world = new R.World({ x: 0, y: this.gravityY, z: 0 })
    this.world.timestep = FIXED_DT
    this.eventQueue = new R.EventQueue(true)
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 })
    this.buildArenaColliders()

    // ---------- Input ----------
    // Our pointer handlers are registered BEFORE OrbitControls and in the capture
    // phase, so a grab / slice / singularity gesture can disable the controls
    // before they ever see the touch.
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
    this.warmUpShaders()
    this.fpsWindowStart = performance.now()
    this.rafId = requestAnimationFrame(this.frame)
    this.emitStats()
  }

  /**
   * Compile every material up front, including pooled effects that start hidden
   * (tether, explosions, singularity, Nitro). Otherwise the first grab, cut or
   * blast stalls the main thread on a shader compile — a visible hitch on phones,
   * during which queued touch moves get merged.
   */
  private warmUpShaders(): void {
    const hidden: THREE.Object3D[] = []
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o)
        o.visible = true
      }
    })
    const restore = () => {
      for (const o of hidden) o.visible = false
    }
    try {
      // Async where the driver can compile in parallel (traversal still happens
      // synchronously, so visibility can be restored right after); otherwise a
      // one-off synchronous compile while the loading screen fades out.
      if (this.renderer.extensions.has('KHR_parallel_shader_compile')) {
        void this.renderer.compileAsync(this.scene, this.camera).catch(() => undefined)
      } else {
        this.renderer.compile(this.scene, this.camera)
      }
    } catch {
      /* compile is an optimisation only */
    }
    restore()
  }

  // =====================================================================
  // Public API
  // =====================================================================

  spawn(kind: ShapeKind): void {
    if (this.disposed) return
    if (!this.ensureCapacity(1)) return
    const g = this.gravityY
    const spread = Math.min(ARENA.halfX, ARENA.halfZ) - 1.2
    const pos = new THREE.Vector3(
      (Math.random() * 2 - 1) * spread,
      // Drop in from the side gravity pulls away from; float in the middle for zero-G.
      g > 0.01 ? 1.2 + Math.random() * 0.8 : g < -0.01 ? ARENA.height - 1.3 - Math.random() * 0.6 : ARENA.height * 0.5,
      (Math.random() * 2 - 1) * spread,
    )
    const quat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI),
    )
    const rnd = () => (Math.random() - 0.5) * 2
    this.createBody({
      form: spawnForm(kind),
      material: kind,
      pos,
      quat,
      angvel: new THREE.Vector3(rnd(), rnd(), rnd()),
      linvel: Math.abs(g) < 0.01 ? new THREE.Vector3(rnd() * 0.75, rnd() * 0.75, rnd() * 0.75) : undefined,
      color: kind === 'nitro' ? new THREE.Color('#ffffff') : nextSpawnColor(),
      popIn: true,
      grace: 'spawn',
    })
    haptics.tick()
  }

  clearAll(): void {
    if (this.drag) this.endDrag(false)
    for (const obj of [...this.alive]) this.despawn(obj, 'shrink')
    this.fractureQueue = []
    this.detonations = []
    this.markActive()
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
      obj.collider.setRestitution(materialRestitution(obj.material, restitution))
      obj.collider.setFriction(materialFriction(obj.material, friction))
      // Resting bodies only notice a friction change (e.g. ice) once they're awake;
      // restitution takes effect on the next impact anyway.
      if (frictionChanged && obj !== this.drag?.obj) obj.body?.wakeUp()
    }
    this.markActive()
  }

  setDestructible(on: boolean): void {
    this.destructible = on
    if (!on) {
      for (const obj of this.fractureQueue) obj.pendingFracture = false
      this.fractureQueue = []
    }
  }

  setMode(mode: InteractionMode): void {
    this.mode = mode
    if (mode !== 'interact' && this.drag) this.endDrag(true)
    if (mode !== 'slice' && this.slice) this.endSlice()
    this.applyModeToControls()
  }

  /**
   * Choose a singularity. With none placed, the type is armed and the next tap
   * in the arena places it; with one placed, it switches type in place (there is
   * never more than one). `null` dismisses it.
   */
  setSingularity(type: SingularityType | null): void {
    if (type === null) {
      this.dismissSingularity()
      return
    }
    if (this.singularity) {
      if (this.singularity.type !== type) {
        this.releaseCore()
        this.singularity.type = type
        this.singularity.pulseT = 0
        this.singularityFx.setType(type)
        this.wakeAll()
      }
      this.armedSingularity = null
    } else {
      this.armedSingularity = type
    }
    this.notifySingularity()
    this.markActive()
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

  // ---------- Test / debug hooks (exposed on window in dev builds only) ----------

  /** Spawn at an exact spot with no spawn grace (for deterministic tests). */
  debugSpawnAt(kind: ShapeKind, x: number, y: number, z: number, yaw = 0): number {
    if (!this.ensureCapacity(1)) return -1
    const obj = this.createBody({
      form: spawnForm(kind),
      material: kind,
      pos: new THREE.Vector3(x, y, z),
      quat: new THREE.Quaternion().setFromAxisAngle(_up, yaw),
      color: kind === 'nitro' ? new THREE.Color('#ffffff') : nextSpawnColor(),
      popIn: true,
      grace: 0,
    })
    return obj.id
  }

  /** Screen (client px) position of a world point. */
  debugProject(x: number, y: number, z: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect()
    const p = new THREE.Vector3(x, y, z).project(this.camera)
    return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height]
  }

  debugDetonate(id: number): boolean {
    const obj = this.alive.find((o) => o.id === id)
    if (!obj?.isNitro) return false
    this.queueDetonation(obj, 0)
    return true
  }

  debugSnapshot() {
    const rect = this.canvas.getBoundingClientRect()
    const toScreen = (v: THREE.Vector3) => {
      const p = v.clone().project(this.camera)
      return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height]
    }
    const timings = Array.from(this.stepTimings).filter((t) => t > 0).sort((a, b) => a - b)
    return {
      controlsEnabled: this.controls.enabled,
      dragging: this.drag !== null,
      slicing: this.slice !== null,
      mode: this.mode,
      gravity: this.gravityY,
      destructible: this.destructible,
      camera: this.camera.position.toArray(),
      simTime: this.simTime,
      stepCount: this.stepCount,
      fps: this.fps,
      stepMs: {
        count: timings.length,
        avg: timings.reduce((a, b) => a + b, 0) / (timings.length || 1),
        p95: timings[Math.floor(timings.length * 0.95)] ?? 0,
        max: timings[timings.length - 1] ?? 0,
      },
      detonations: [...this.detonationLog],
      impacts: [...this.impactLog],
      pendingDetonations: this.detonations.length,
      explosionsActive: this.explosions.activeCount,
      singularity: this.singularity
        ? { type: this.singularity.type, pos: this.singularity.pos.toArray(), screen: toScreen(this.singularity.pos) }
        : null,
      armedSingularity: this.armedSingularity,
      fieldMaxSpeed: this.fieldMaxSpeed,
      bodies: this.alive.map((o) => {
        const v = o.body?.linvel()
        return {
          id: o.id,
          form: o.form.type,
          material: o.material,
          mass: o.mass,
          pos: o.currPos.toArray(),
          screen: toScreen(o.currPos),
          vel: v ? [v.x, v.y, v.z] : [0, 0, 0],
          sleeping: o.body?.isSleeping() ?? false,
          kinematic: o.body?.isKinematic() ?? false,
          restitution: o.collider?.restitution() ?? 0,
          friction: o.collider?.friction() ?? 0,
          isDebris: o.isDebris,
          activeEvents: o.collider?.activeEvents() ?? -1,
          isSliced: o.isSliced,
          isNitro: o.isNitro,
          armed: o.armed,
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
    for (const t of this.textures) t.dispose()
    for (const type of FORM_TYPES) this.meshes[type].dispose()
    this.impactRings.dispose()
    this.explosions.dispose()
    this.singularityFx.dispose()
    this.laser.dispose()
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
  // Bodies: creation, removal, recycling
  // =====================================================================

  private createBody(init: BodyInit): PhysObject {
    const R = this.R
    const spec = MATERIAL_SPECS[init.material]
    const isDebris = !!init.isDebris
    const { pos, quat } = init

    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
      .setLinearDamping(spec.linearDamping)
      .setAngularDamping(spec.angularDamping)
      .setCanSleep(true)
      // Debris are small and slow-ish; skipping CCD keeps big shatters cheap.
      .setCcdEnabled(!isDebris)
    if (init.linvel) bodyDesc.setLinvel(init.linvel.x, init.linvel.y, init.linvel.z)
    if (init.angvel) bodyDesc.setAngvel({ x: init.angvel.x, y: init.angvel.y, z: init.angvel.z })
    const body = this.world.createRigidBody(bodyDesc)

    const colliderDesc = createColliderDesc(R, init.form)
    if (init.mass !== undefined) colliderDesc.setMass(init.mass)
    else colliderDesc.setDensity(spec.density)
    colliderDesc
      .setRestitution(materialRestitution(init.material, this.restitution))
      .setFriction(materialFriction(init.material, this.friction))
      // Combine rules: with the arena at restitution 0 / friction 1, the sliders map 1:1.
      .setRestitutionCombineRule(R.CoefficientCombineRule.Max)
      .setFrictionCombineRule(R.CoefficientCombineRule.Min)
      // Anti-cascade: debris never report contact forces, so they can neither
      // flood the event queue nor be fractured again.
      .setActiveEvents(isDebris ? R.ActiveEvents.NONE : R.ActiveEvents.CONTACT_FORCE_EVENTS)
    const collider = this.world.createCollider(colliderDesc, body)
    const reported = body.mass()
    const mass = reported > 0 ? reported : (init.mass ?? spec.density * formVolume(init.form))
    if (!isDebris) collider.setContactForceEventThreshold(mass * IMPACT_ACCEL_THRESHOLD)

    const grace = init.grace
    const obj: PhysObject = {
      id: this.nextId++,
      form: init.form,
      material: init.material,
      body,
      collider,
      mass,
      color: init.color,
      scale: formVisualScale(init.form, new THREE.Vector3()),
      radius: formBoundingRadius(init.form),
      prevPos: pos.clone(),
      currPos: pos.clone(),
      prevQuat: quat.clone(),
      currQuat: quat.clone(),
      settled: false,
      spawnT: init.popIn ? 0 : 1,
      dieT: null,
      fadeOut: false,
      lastImpactAt: -1,
      highlighted: false,
      isDebris,
      isSliced: !!init.isSliced,
      isNitro: init.form.type === 'nitro',
      graceUntil:
        grace === 'spawn' ? this.simTime + SPAWN_GRACE_SECONDS : typeof grace === 'number' ? this.simTime + grace : 0,
      awaitingFirstImpact: grace === 'spawn',
      heat: 0,
      bornAt: this.simTime,
      debrisSlow: 0,
      debrisRest: 0,
      pendingFracture: false,
      armed: false,
      inField: false,
      inCore: false,
    }
    this.alive.push(obj)
    this.visuals[init.form.type].push(obj)
    this.colorDirty[init.form.type] = true
    this.byCollider.set(collider.handle, obj)
    this.markActive()
    this.statsDirty = true
    return obj
  }

  /**
   * Remove a body from the simulation. Visually it shrinks out ('shrink'),
   * darkens and shrinks ('fade', debris), or disappears at once ('instant', when
   * it is replaced in place by halves / fragments / a blast).
   */
  private despawn(obj: PhysObject, mode: 'shrink' | 'fade' | 'instant'): void {
    if (obj === this.drag?.obj) this.endDrag(false)
    if (obj.collider) this.byCollider.delete(obj.collider.handle)
    if (obj.body) this.world.removeRigidBody(obj.body)
    obj.body = null
    obj.collider = null
    obj.highlighted = false
    obj.inField = false
    obj.inCore = false
    obj.pendingFracture = false
    obj.dieT = mode === 'instant' ? 1 : 0
    obj.fadeOut = mode === 'fade'
    obj.prevPos.copy(obj.currPos)
    obj.prevQuat.copy(obj.currQuat)
    const i = this.alive.indexOf(obj)
    if (i >= 0) this.alive.splice(i, 1)
    this.colorDirty[obj.form.type] = true
    this.markActive()
    this.statsDirty = true
  }

  /**
   * Make room for `extra` new bodies under the 150 cap. Recycling order:
   * oldest sleeping debris → oldest debris → oldest sleeping shape → oldest shape.
   */
  private ensureCapacity(extra: number): boolean {
    while (this.alive.length + extra > MAX_BODIES) {
      if (!this.recycleOne()) return false
    }
    return true
  }

  private recycleOne(): boolean {
    const dragged = this.drag?.obj
    const find = (pred: (o: PhysObject) => boolean) => this.alive.find((o) => o !== dragged && pred(o))
    const victim =
      find((o) => o.isDebris && !!o.body?.isSleeping()) ??
      find((o) => o.isDebris) ??
      find((o) => !!o.body?.isSleeping()) ??
      find(() => true)
    if (!victim) return false
    const where = victim.currPos.clone()
    this.despawn(victim, victim.isDebris ? 'fade' : 'shrink')
    // Wake whatever was resting on it so the pile settles naturally.
    for (const obj of this.alive) {
      if (obj.body && obj.currPos.distanceToSquared(where) < 4) obj.body.wakeUp()
    }
    return true
  }

  private wakeAll(): void {
    for (const obj of this.alive) if (obj.body && obj !== this.drag?.obj) obj.body.wakeUp()
  }

  private readBodyState(obj: PhysObject) {
    const body = obj.body!
    const t = body.translation()
    const r = body.rotation()
    const lv = body.linvel()
    const av = body.angvel()
    return {
      pos: new THREE.Vector3(t.x, t.y, t.z),
      quat: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      linvel: new THREE.Vector3(lv.x, lv.y, lv.z),
      angvel: new THREE.Vector3(av.x, av.y, av.z),
    }
  }

  // =====================================================================
  // Fracture
  // =====================================================================

  /**
   * An impact was registered on `obj`. `impulse` is the contact impulse (N·s) and
   * `e` the combined restitution, so the normal approach speed is J / (m·(1+e))
   * and the impact's kinetic energy per kg is ½·v².
   */
  private noteImpact(obj: PhysObject, impulse: number, e: number): void {
    if (!obj.body || obj.dieT !== null || obj.isDebris || obj === this.drag?.obj) return
    if (obj.awaitingFirstImpact) {
      obj.awaitingFirstImpact = false
      obj.graceUntil = Math.min(obj.graceUntil, this.simTime + FIRST_IMPACT_GRACE_SECONDS)
      return
    }
    if (this.simTime < obj.graceUntil) return
    const v = impulse / (obj.mass * (1 + e))
    const energyPerKg = 0.5 * v * v
    this.impactLog.push({ id: obj.id, energyPerKg, time: this.simTime })
    if (this.impactLog.length > 48) this.impactLog.shift()
    if (obj.isNitro) {
      if (energyPerKg >= NITRO_TRIGGER_ENERGY_PER_KG) this.queueDetonation(obj, 0)
      return
    }
    if (this.destructible && energyPerKg >= FRACTURE_ENERGY_PER_KG) this.queueFracture(obj)
  }

  private queueFracture(obj: PhysObject): void {
    if (obj.pendingFracture || obj.isDebris || obj.isNitro || !obj.body) return
    obj.pendingFracture = true
    this.fractureQueue.push(obj)
  }

  /** Shatter into 4–6 debris shards that share the parent's mass and momentum. */
  private fracture(obj: PhysObject): void {
    if (!obj.body || obj.dieT !== null || obj.isDebris) return
    const parent = this.readBodyState(obj)
    const layout = fractureLayout(obj.form)
    const totalVolume = layout.reduce((s, c) => s + c.volume, 0)
    const parentMass = obj.mass
    const color = obj.color
    this.despawn(obj, 'instant')
    if (!this.ensureCapacity(layout.length)) return

    const toCamera = this.camera.position.clone().sub(parent.pos).normalize()
    this.impactRings.spawn(parent.pos, toCamera, color, 0.9)

    for (const child of layout) {
      const pos = child.pos.clone().applyQuaternion(parent.quat).add(parent.pos)
      const quat = parent.quat.clone().multiply(child.quat)
      const offset = pos.clone().sub(parent.pos)
      // Rigid-body velocity at the fragment's location: v + ω × r.
      const linvel = parent.linvel.clone().add(new THREE.Vector3().crossVectors(parent.angvel, offset))
      const mass = (parentMass * child.volume) / totalVolume
      const shade = color.clone().offsetHSL(0, -0.05, (Math.random() - 0.5) * 0.16)
      const frag = this.createBody({
        form: child.form,
        material: 'shard',
        pos,
        quat,
        linvel,
        angvel: parent.angvel.clone().add(
          new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(8),
        ),
        mass,
        color: shade,
        isDebris: true,
      })
      // Modest outward scatter impulse: J = m · Δv along the shard's direction.
      const push = child.push.clone().applyQuaternion(parent.quat)
      const dv = FRACTURE_SCATTER_SPEED * (0.7 + Math.random() * 0.6)
      frag.body!.applyImpulse({ x: push.x * dv * frag.mass, y: push.y * dv * frag.mass, z: push.z * dv * frag.mass }, true)
    }
  }

  // =====================================================================
  // Slicing
  // =====================================================================

  /** Bisect `obj` with the world plane (normal `n` through `point`). */
  private sliceObject(obj: PhysObject, n: THREE.Vector3, point: THREE.Vector3): boolean {
    if (!obj.body) return false
    const parent = this.readBodyState(obj)
    const inv = parent.quat.clone().invert()
    const nLocal = n.clone().applyQuaternion(inv)
    const pLocal = point.clone().sub(parent.pos).applyQuaternion(inv)
    const layout = sliceLayout(obj.form, nLocal, pLocal)
    if (!layout) return false
    const totalVolume = layout[0].volume + layout[1].volume
    const parentMass = obj.mass
    this.despawn(obj, 'instant')
    if (!this.ensureCapacity(2)) return true

    for (const child of layout) {
      const pos = child.pos.clone().applyQuaternion(parent.quat).add(parent.pos)
      const quat = parent.quat.clone().multiply(child.quat)
      const offset = pos.clone().sub(parent.pos)
      const half = this.createBody({
        form: child.form,
        material: obj.material,
        pos,
        quat,
        // Inherit the parent's motion: v + ω × r, same spin.
        linvel: parent.linvel.clone().add(new THREE.Vector3().crossVectors(parent.angvel, offset)),
        angvel: parent.angvel,
        mass: (parentMass * child.volume) / totalVolume,
        color: obj.color,
        isSliced: true,
        grace: 0.3,
      })
      half.heat = 1
      // Slight separation impulse perpendicular to the cut.
      const push = child.push.clone().applyQuaternion(parent.quat).multiplyScalar(SLICE_SEPARATION_SPEED * half.mass)
      half.body!.applyImpulse({ x: push.x, y: push.y, z: push.z }, true)
    }
    return true
  }

  private startSlice(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    this.slice = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, cut: new Set() }
    this.laser.begin(e.clientX - rect.left, e.clientY - rect.top, performance.now())
  }

  private extendSlice(x: number, y: number): void {
    const s = this.slice
    if (!s) return
    const rect = this.canvas.getBoundingClientRect()
    this.laser.extend(x - rect.left, y - rect.top, performance.now())
    if (Math.hypot(x - s.lastX, y - s.lastY) < SLICE_SEGMENT_PX) return
    this.sliceSegment(s.lastX, s.lastY, x, y, rect)
    s.lastX = x
    s.lastY = y
  }

  private endSlice(): void {
    const s = this.slice
    if (!s) return
    this.slice = null
    this.laser.end()
    try {
      if (this.canvas.hasPointerCapture(s.pointerId)) this.canvas.releasePointerCapture(s.pointerId)
    } catch {
      /* pointer already gone */
    }
    this.applyModeToControls()
  }

  /**
   * One stroke of the blade from screen point A to B. The cutting plane is the
   * plane swept by the finger's ray: it contains the eye and both rays, so the
   * cut lands exactly along the line the player drew.
   */
  private sliceSegment(ax: number, ay: number, bx: number, by: number, rect: DOMRect): void {
    const s = this.slice
    if (!s) return
    const eye = this.camera.position
    const dirA = this.screenRay(ax, ay, rect, new THREE.Vector3())
    const dirB = this.screenRay(bx, by, rect, new THREE.Vector3())
    const n = new THREE.Vector3().crossVectors(dirA, dirB)
    if (n.lengthSq() < 1e-12) return
    n.normalize()
    const screenUp = _v3.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize()
    const sdx = bx - ax
    const sdy = by - ay
    const slen = Math.hypot(sdx, sdy) || 1

    for (const obj of [...this.alive]) {
      if (!obj.body || obj.dieT !== null || obj.isDebris || obj.isSliced || s.cut.has(obj.id)) continue
      if (Math.abs(n.dot(_v1.subVectors(obj.currPos, eye))) > obj.radius * 0.85) continue
      const centre = _v1.copy(obj.currPos).project(this.camera)
      if (centre.z > 1) continue // behind the camera
      const cx = rect.left + ((centre.x + 1) / 2) * rect.width
      const cy = rect.top + ((1 - centre.y) / 2) * rect.height
      const edge = _v2.copy(obj.currPos).addScaledVector(screenUp, obj.radius).project(this.camera)
      const pr = Math.hypot(
        (edge.x - centre.x) * 0.5 * rect.width,
        (edge.y - centre.y) * 0.5 * rect.height,
      )
      if (distToSegment(cx, cy, ax, ay, bx, by) > pr * 0.9) continue

      s.cut.add(obj.id)
      this.laser.burst(cx - rect.left, cy - rect.top, -sdy / slen, sdx / slen)
      haptics.slice()
      if (obj.isNitro) {
        this.queueDetonation(obj, 0)
        continue
      }
      this.sliceObject(obj, n, eye)
    }
  }

  private screenRay(clientX: number, clientY: number, rect: DOMRect, out: THREE.Vector3): THREE.Vector3 {
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    return out.set(_ndc.x, _ndc.y, 0.5).unproject(this.camera).sub(this.camera.position).normalize()
  }

  // =====================================================================
  // Nitro
  // =====================================================================

  private queueDetonation(obj: PhysObject, delaySteps: number): void {
    if (!obj.isNitro || obj.armed || !obj.body) return
    obj.armed = true
    // Keep blasts at least CHAIN_DELAY_STEPS apart: a cluster rolls off as a wave.
    const due = Math.max(this.stepCount + delaySteps, this.lastScheduledDetonation + CHAIN_DELAY_STEPS)
    this.lastScheduledDetonation = due
    this.detonations.push({ obj, dueStep: due })
    this.colorDirty.nitro = true
  }

  private explode(obj: PhysObject): void {
    if (!obj.body) return
    const centre = obj.currPos.clone()
    this.detonationLog.push({ id: obj.id, step: this.stepCount, time: this.simTime })
    if (this.detonationLog.length > 64) this.detonationLog.shift()
    this.despawn(obj, 'instant')
    this.explosions.spawn(centre, BLAST_RADIUS * 0.6)
    haptics.explosion()

    const lift = this.gravityY < -0.01 ? 0.35 : this.gravityY > 0.01 ? -0.35 : 0
    for (const other of [...this.alive]) {
      const body = other.body
      if (!body) continue
      const d = _v1.subVectors(other.currPos, centre)
      const dist = d.length()
      if (dist > BLAST_RADIUS) continue
      // Shockwave sets off neighbouring Nitro — staggered, never in this frame.
      if (other.isNitro) this.queueDetonation(other, CHAIN_DELAY_STEPS)
      if (other === this.drag?.obj) continue
      const k = Math.pow(1 - dist / BLAST_RADIUS, 1.5)
      const dir =
        dist > 1e-3
          ? d.divideScalar(dist)
          : d.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
      dir.y += lift
      dir.normalize()
      const dv = BLAST_MAX_SPEED * k
      body.applyImpulse({ x: dir.x * dv * other.mass, y: dir.y * dv * other.mass, z: dir.z * dv * other.mass }, true)
      const tq = 0.25 * k * other.mass
      body.applyTorqueImpulse(
        { x: (Math.random() - 0.5) * tq, y: (Math.random() - 0.5) * tq, z: (Math.random() - 0.5) * tq },
        true,
      )
      if (this.destructible && !other.isDebris && !other.isNitro && dist < BLAST_FRACTURE_RADIUS) {
        this.queueFracture(other)
      }
    }
    this.markActive()
  }

  // =====================================================================
  // Singularities
  // =====================================================================

  private notifySingularity(): void {
    this.opts.onSingularityChange?.({
      type: this.singularity?.type ?? this.armedSingularity,
      placed: this.singularity !== null,
    })
  }

  private placeSingularity(type: SingularityType, pos: THREE.Vector3): void {
    this.singularity = { type, pos: pos.clone(), pulseT: 0 }
    this.armedSingularity = null
    this.singularityFx.setType(type)
    this.singularityFx.setPosition(this.singularity.pos)
    this.wakeAll()
    this.notifySingularity()
    this.markActive()
  }

  private dismissSingularity(): void {
    this.releaseCore()
    const had = this.singularity !== null
    this.singularity = null
    this.armedSingularity = null
    this.singularityFx.setType(null)
    for (const obj of this.alive) obj.inField = false
    if (had) this.wakeAll()
    this.notifySingularity()
    this.markActive()
  }

  /** Restore normal damping on bodies that were inside the event-horizon core. */
  private releaseCore(): void {
    for (const obj of this.alive) {
      if (!obj.inCore || !obj.body) continue
      const spec = MATERIAL_SPECS[obj.material]
      obj.body.setLinearDamping(spec.linearDamping)
      obj.body.setAngularDamping(spec.angularDamping)
      obj.inCore = false
    }
  }

  /** Point on the singularity's horizontal plane under a screen position (clamped inside the arena). */
  private singularityPoint(clientX: number, clientY: number, out: THREE.Vector3): boolean {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SINGULARITY.height)
    if (!this.pointerToPlane(clientX, clientY, plane, out)) return false
    const m = 0.6
    out.set(
      THREE.MathUtils.clamp(out.x, -ARENA.halfX + m, ARENA.halfX - m),
      SINGULARITY.height,
      THREE.MathUtils.clamp(out.z, -ARENA.halfZ + m, ARENA.halfZ - m),
    )
    return true
  }

  private hitsSingularity(clientX: number, clientY: number): boolean {
    const s = this.singularity
    if (!s) return false
    const rect = this.canvas.getBoundingClientRect()
    const p = _v1.copy(s.pos).project(this.camera)
    const sx = rect.left + ((p.x + 1) / 2) * rect.width
    const sy = rect.top + ((1 - p.y) / 2) * rect.height
    return Math.hypot(clientX - sx, clientY - sy) <= SINGULARITY.touchRadius
  }

  /**
   * Softened inverse-square field, applied as per-step impulses:
   *   a = G / (r² + ε²)   (ε = 1 m, so the pull peaks at G/ε² instead of → ∞)
   * Inside the 0.5 m core the pull also tapers linearly to zero and bodies get
   * heavy linear/angular damping, so anything dragged to the centre settles
   * into a slow orbit rather than oscillating through it at huge speed.
   */
  private applySingularity(): void {
    const s = this.singularity
    if (!s) return
    const isHole = s.type === 'blackhole'
    const G = isHole ? SINGULARITY.blackHoleG : SINGULARITY.repulsorG
    const eps2 = SINGULARITY.softening ** 2
    const infl2 = SINGULARITY.influence ** 2
    // Resting bodies only need waking if the field can actually beat gravity there.
    const wakeAccel = Math.max(0.5, Math.abs(this.gravityY) * 0.5)

    let pulse = false
    if (!isHole) {
      s.pulseT += FIXED_DT
      if (s.pulseT >= SINGULARITY.pulseInterval) {
        s.pulseT = 0
        pulse = true
        this.singularityFx.pulse()
      }
    }

    for (const obj of this.alive) {
      const body = obj.body
      if (!body || obj === this.drag?.obj) continue
      const d = _v1.subVectors(s.pos, obj.currPos)
      const r2 = d.lengthSq()
      if (r2 > infl2) {
        obj.inField = false
        if (obj.inCore) this.exitCore(obj)
        continue
      }
      const r = Math.sqrt(r2)
      let a = G / (r2 + eps2)
      if (r < SINGULARITY.core) a *= r / SINGULARITY.core
      if (body.isSleeping()) {
        if (a < wakeAccel && !pulse) {
          obj.inField = false
          continue
        }
        body.wakeUp()
      }
      obj.inField = true
      const inv = r > 1e-4 ? 1 / r : 0
      const dir = d.multiplyScalar(isHole ? inv : -inv)
      let ix = dir.x * a
      let iy = dir.y * a
      let iz = dir.z * a
      if (isHole && r > 1e-4) {
        // Tangential swirl around the vertical axis: bodies spiral in.
        const sw = a * SINGULARITY.swirl
        ix += dir.z * sw
        iz -= dir.x * sw
      }
      const m = obj.mass * FIXED_DT
      body.applyImpulse({ x: ix * m, y: iy * m, z: iz * m }, true)
      if (pulse) {
        const k = Math.pow(1 - r / SINGULARITY.influence, 2) * SINGULARITY.pulseSpeed * obj.mass
        body.applyImpulse({ x: dir.x * k, y: dir.y * k + 0.15 * k, z: dir.z * k }, true)
      }

      if (isHole && r < SINGULARITY.core && !obj.inCore) {
        obj.inCore = true
        body.setLinearDamping(SINGULARITY.coreLinearDamping)
        body.setAngularDamping(SINGULARITY.coreAngularDamping)
      } else if (obj.inCore && (!isHole || r > SINGULARITY.core * 1.25)) {
        this.exitCore(obj)
      }
    }
  }

  private exitCore(obj: PhysObject): void {
    obj.inCore = false
    if (!obj.body) return
    const spec = MATERIAL_SPECS[obj.material]
    obj.body.setLinearDamping(spec.linearDamping)
    obj.body.setAngularDamping(spec.angularDamping)
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
      const t0 = performance.now()
      this.stepPhysics()
      this.stepTimings[this.stepTimingCursor] = performance.now() - t0
      this.stepTimingCursor = (this.stepTimingCursor + 1) % STEP_TIMING_SAMPLES
      this.accumulator -= FIXED_DT
      steps++
    }
    if (steps === MAX_SUBSTEPS && this.accumulator > FIXED_DT) this.accumulator = FIXED_DT * 0.5

    this.controls.update()
    this.updateFraming(dt)

    // Effects that animate independently of the bodies.
    const time = now / 1000
    let fx = this.impactRings.update(dt)
    fx = this.explosions.update(dt) || fx
    if (this.singularity) {
      this.singularityFx.update(dt, time)
      fx = true
    }
    if (this.visuals.nitro.length > 0) {
      this.nitroMaterial.update(time, this.detonations.length > 0)
      fx = true
    }
    this.laser.update(now, dt)

    if (this.needsRender || this.animating || this.hasMotion || this.drag || fx) {
      this.updateVisuals(this.accumulator / FIXED_DT, dt, time)
      if (this.shadowDirty) {
        this.renderer.shadowMap.needsUpdate = true
        this.shadowDirty = false
      }
      this.renderer.render(this.scene, this.camera)
      this.needsRender = false
    }
    if (this.statsDirty) {
      this.statsDirty = false
      this.emitStats()
    }
  }

  private stepPhysics(): void {
    // 1. Detonations that are due (staggered chain reactions).
    if (this.detonations.length) {
      const due = this.detonations.filter((d) => d.dueStep <= this.stepCount)
      if (due.length) {
        this.detonations = this.detonations.filter((d) => d.dueStep > this.stepCount)
        for (const d of due) this.explode(d.obj)
      }
    }

    // 2. Singularity field.
    this.applySingularity()

    // 3. Drive the grabbed body through the physics engine (kinematic target), never the mesh.
    const drag = this.drag
    if (drag && drag.obj.body) {
      const cur = drag.obj.currPos
      _v1.subVectors(drag.target, cur)
      const maxStep = DRAG_MAX_SPEED * FIXED_DT
      if (_v1.lengthSq() > maxStep * maxStep) _v1.setLength(maxStep)
      _v1.add(cur)
      drag.obj.body.setNextKinematicTranslation({ x: _v1.x, y: _v1.y, z: _v1.z })
    }

    // 4. Step.
    this.world.step(this.eventQueue)
    this.simTime += FIXED_DT
    this.stepCount++

    // 5. Impacts → rumble, rings, fracture / detonation triggers.
    this.eventQueue.drainContactForceEvents((event) => {
      const h1 = event.collider1()
      const h2 = event.collider2()
      const force = event.totalForceMagnitude()
      const impulse = force * FIXED_DT
      const s1 = this.arenaSurfaces.get(h1)
      const s2 = this.arenaSurfaces.get(h2)
      const surface = s1 ?? s2
      if (surface) {
        const obj = this.byCollider.get(s1 ? h2 : h1)
        if (!obj || obj.mass <= 0) return
        if (force / obj.mass >= IMPACT_ACCEL_THRESHOLD && this.simTime - obj.lastImpactAt >= 0.15) {
          obj.lastImpactAt = this.simTime
          haptics.rumble()
          this.spawnImpactRing(obj, surface, force / obj.mass)
        }
        this.noteImpact(obj, impulse, materialRestitution(obj.material, this.restitution))
        return
      }
      const a = this.byCollider.get(h1)
      const b = this.byCollider.get(h2)
      if (!a || !b) return
      const dragged = this.drag?.obj
      if (a === dragged || b === dragged) return // squeezing with a held body isn't an impact
      const e = Math.max(
        materialRestitution(a.material, this.restitution),
        materialRestitution(b.material, this.restitution),
      )
      this.noteImpact(a, impulse, e)
      this.noteImpact(b, impulse, e)
    })

    // 6. A bounded number of fractures per step.
    for (let n = 0; n < MAX_FRACTURES_PER_STEP && this.fractureQueue.length; ) {
      const obj = this.fractureQueue.shift()!
      if (!obj.pendingFracture) continue
      obj.pendingFracture = false
      if (!obj.body || !this.destructible) continue
      this.fracture(obj)
      n++
    }

    // 7. Sync transforms; sleep, rolling resistance, debris lifecycle, speed clamp.
    // Velocity checks run at 12 Hz; that's plenty for sleep and rolling resistance.
    const checkSleep = this.stepCount % 5 === 0
    const checkDt = FIXED_DT * 5
    const hasGravity = Math.abs(this.gravityY) > 0.01
    const field = this.singularity !== null
    const blackHole = this.singularity?.type === 'blackhole'
    const accretionKeep = Math.exp(-SINGULARITY.accretionDrag * FIXED_DT)
    let anyAwake = false
    let allCalm = true
    const expired: PhysObject[] = []
    for (const obj of this.alive) {
      const body = obj.body
      if (!body) continue
      if (obj.isDebris && this.simTime - obj.bornAt > DEBRIS_MAX_LIFETIME) expired.push(obj)
      if (body.isSleeping()) {
        if (!obj.settled) {
          obj.prevPos.copy(obj.currPos)
          obj.prevQuat.copy(obj.currQuat)
          obj.settled = true
          this.shadowDirty = true
          this.needsRender = true
        }
        if (obj.isDebris && checkSleep) {
          obj.debrisSlow += checkDt
          obj.debrisRest += checkDt
          if (obj.debrisSlow >= DEBRIS_SLOW_SECONDS || obj.debrisRest >= DEBRIS_REST_SECONDS) expired.push(obj)
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

      // Inside a singularity's field: accretion drag (black hole) + escape-velocity clamp.
      if (field && obj.inField && obj !== drag?.obj) {
        const lv = body.linvel()
        let sp = Math.hypot(lv.x, lv.y, lv.z)
        let k = blackHole ? accretionKeep : 1
        if (sp * k > SINGULARITY.maxSpeed) k = SINGULARITY.maxSpeed / sp
        if (k < 1) body.setLinvel({ x: lv.x * k, y: lv.y * k, z: lv.z * k }, true)
        sp *= k
        this.fieldMaxSpeed = Math.max(this.fieldMaxSpeed, sp)
      }

      if (!checkSleep || obj === drag?.obj) continue
      const lv = body.linvel()
      const av = body.angvel()
      let lin2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z
      let ang2 = av.x * av.x + av.y * av.y + av.z * av.z

      // Rolling resistance for slow bodies resting on the "down" surface, scaled by
      // the friction slider (ice keeps gliding). Rapier has no rolling friction.
      const spec = MATERIAL_SPECS[obj.material]
      if (hasGravity && spec.rollingResistance > 0 && lin2 < ROLLING_RESISTANCE_MAX_SPEED ** 2) {
        const onDownSurface =
          this.gravityY < 0 ? t.y < obj.radius + 0.06 : t.y > ARENA.height - obj.radius - 0.06
        const k = Math.exp(-spec.rollingResistance * this.friction * checkDt)
        if (onDownSurface && k < 0.9999) {
          body.setLinvel({ x: lv.x * k, y: lv.y, z: lv.z * k }, false)
          body.setAngvel({ x: av.x * k, y: av.y * k, z: av.z * k }, false)
          lin2 *= k * k
          ang2 *= k * k
        }
      }

      // Debris lifecycle: despawn after 2 s below 0.1 m/s, or 4 s of resting.
      if (obj.isDebris) {
        obj.debrisSlow = lin2 < DEBRIS_SLOW_SPEED ** 2 ? obj.debrisSlow + checkDt : 0
        obj.debrisRest = lin2 < DEBRIS_REST_SPEED ** 2 ? obj.debrisRest + checkDt : 0
        if (obj.debrisSlow >= DEBRIS_SLOW_SECONDS || obj.debrisRest >= DEBRIS_REST_SECONDS) expired.push(obj)
      }

      if (lin2 > SLEEP_SPEED_LIMIT ** 2 || ang2 > SLEEP_ANGULAR_LIMIT ** 2) allCalm = false
    }
    for (const obj of expired) if (obj.body) this.despawn(obj, 'fade')

    // 8. Explicit sleep thresholds (sleepSpeedLimit / sleepTimeLimit), applied island-safely.
    // Rapier already sleeps each contact island on its own; forcing individual bodies to
    // sleep inside a moving pile would leave them hovering when their support moves away.
    // So bodies are only forced asleep once *every* awake body has been calm for
    // SLEEP_TIME_LIMIT, which lets a settled scene drop out of the solver quickly.
    if (checkSleep) {
      if (anyAwake && allCalm && hasGravity && !drag && !field && !this.detonations.length) {
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

  private updateVisuals(alpha: number, dt: number, time: number): void {
    let animating = false
    for (const type of FORM_TYPES) {
      const list = this.visuals[type]
      const mesh = this.meshes[type]
      if (list.length === 0 && mesh.count === 0) continue

      // Advance animations and compact finished despawns out of the bucket.
      let write = 0
      let liveColors = false
      for (let i = 0; i < list.length; i++) {
        const obj = list[i]
        if (obj.dieT !== null) {
          obj.dieT += dt / (obj.fadeOut ? DEBRIS_FADE_SECONDS : SHRINK_OUT_SECONDS)
          if (obj.dieT >= 1) continue
          animating = true
          if (obj.fadeOut) liveColors = true
        } else if (obj.spawnT < 1) {
          obj.spawnT = Math.min(1, obj.spawnT + dt / POP_IN_SECONDS)
          animating = true
        }
        if (obj.heat > 0) {
          obj.heat = Math.max(0, obj.heat - dt / HEAT_SECONDS)
          liveColors = true
          animating = true
        }
        if (obj.armed) liveColors = true
        list[write++] = obj
      }
      if (write !== list.length) {
        list.length = write
        this.colorDirty[type] = true // instance indices shifted
        this.shadowDirty = true
      }

      const writeColors = this.colorDirty[type] || liveColors
      for (let i = 0; i < list.length; i++) {
        const obj = list[i]
        let s =
          obj.dieT !== null
            ? obj.fadeOut
              ? 1 - obj.dieT * 0.6
              : 1 - obj.dieT * obj.dieT
            : obj.spawnT < 1
              ? 0.25 + 0.75 * easeOutBack(obj.spawnT)
              : 1
        if (obj.armed) s *= 1.06 + 0.06 * Math.sin(time * 60)
        _v1.lerpVectors(obj.prevPos, obj.currPos, alpha)
        _q1.slerpQuaternions(obj.prevQuat, obj.currQuat, alpha)
        _scale.copy(obj.scale).multiplyScalar(s)
        _m1.compose(_v1, _q1, _scale)
        mesh.setMatrixAt(i, _m1)
        if (writeColors) {
          _tmpColor.copy(obj.color)
          if (obj.heat > 0) _tmpColor.lerp(_hot, obj.heat * 0.75)
          if (obj.armed) _tmpColor.lerp(_white, 0.5 + 0.5 * Math.sin(time * 60))
          if (obj.highlighted) _tmpColor.lerp(_white, 0.4)
          if (obj.fadeOut && obj.dieT !== null) _tmpColor.lerp(_void, obj.dieT)
          mesh.setColorAt(i, _tmpColor)
        }
      }
      mesh.count = list.length
      mesh.visible = list.length > 0
      mesh.instanceMatrix.needsUpdate = true
      if (writeColors && mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true
        this.colorDirty[type] = false
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

    if (animating) this.shadowDirty = true
    this.animating = animating
  }

  private spawnImpactRing(obj: PhysObject, surface: ArenaSurface, strength: number): void {
    _v2.copy(obj.currPos)
    const inset = 0.03
    if (surface.axis === 'x') _v2.x = surface.coord + surface.normal.x * inset
    else if (surface.axis === 'y') _v2.y = surface.coord + surface.normal.y * inset
    else _v2.z = surface.coord + surface.normal.z * inset
    this.impactRings.spawn(_v2, surface.normal, obj.color, THREE.MathUtils.clamp(strength / 700, 0.7, 1.3))
    this.needsRender = true
  }

  private markActive(): void {
    this.needsRender = true
    this.shadowDirty = true
  }

  private emitStats(): void {
    let debris = 0
    for (const o of this.alive) if (o.isDebris) debris++
    this.opts.onStats?.({ fps: this.fps, bodies: this.alive.length, debris, max: MAX_BODIES })
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
        const dir = this.screenRay(clientX + Math.cos(a) * radius, clientY + Math.sin(a) * radius, rect, new THREE.Vector3())
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
    if (obj.inCore) this.exitCore(obj)
    obj.currPos.copy(bodyPos)
    obj.prevPos.copy(bodyPos)
    obj.highlighted = true
    obj.settled = false
    this.colorDirty[obj.form.type] = true

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
    const r = drag.obj.radius
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
    this.colorDirty[obj.form.type] = true

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

  // =====================================================================
  // Input
  // =====================================================================

  /** Take ownership of a touch: OrbitControls never sees it. */
  private claimPointer(e: PointerEvent): void {
    // Camera interference safeguard: disable OrbitControls *before* its own
    // pointerdown handler runs, so the orbit never fights the gesture.
    this.controls.enabled = false
    e.stopImmediatePropagation()
    e.preventDefault()
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    const othersDown = this.activePointers.size > 0
    this.activePointers.add(e.pointerId)
    if (this.drag || this.slice || this.singularityGesture || othersDown) return
    if (e.pointerType === 'mouse' && e.button !== 0) return

    // Singularity gestures take precedence in every mode: drag/tap its core, or place an armed one.
    if (this.singularity && this.hitsSingularity(e.clientX, e.clientY)) {
      this.claimPointer(e)
      this.singularityGesture = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startTime: e.timeStamp,
        moved: false,
        placing: false,
      }
      return
    }
    if (this.armedSingularity) {
      const p = new THREE.Vector3()
      if (this.singularityPoint(e.clientX, e.clientY, p)) {
        this.claimPointer(e)
        this.placeSingularity(this.armedSingularity, p)
        haptics.tap()
        this.singularityGesture = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          startTime: e.timeStamp,
          moved: true,
          placing: true,
        }
      }
      return
    }

    if (this.mode === 'slice') {
      this.claimPointer(e)
      this.startSlice(e)
      return
    }
    if (this.mode !== 'interact') return

    const hit = this.pick(e.clientX, e.clientY)
    if (!hit) return
    this.claimPointer(e)
    this.startDrag(hit.obj, hit.point, e.pointerId, e.timeStamp)
  }

  private onPointerMove = (e: PointerEvent): void => {
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    const samples = events.length ? events : [e]

    if (this.drag && e.pointerId === this.drag.pointerId) {
      e.stopImmediatePropagation()
      // Coalesced events give the full-rate finger path between frames (better throws).
      for (const ce of samples) this.updateDragTarget(ce.clientX, ce.clientY, ce.timeStamp)
      return
    }
    if (this.slice && e.pointerId === this.slice.pointerId) {
      e.stopImmediatePropagation()
      for (const ce of samples) this.extendSlice(ce.clientX, ce.clientY)
      return
    }
    const g = this.singularityGesture
    if (g && e.pointerId === g.pointerId) {
      e.stopImmediatePropagation()
      if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 10) g.moved = true
      if (g.moved && this.singularity) {
        const p = new THREE.Vector3()
        if (this.singularityPoint(e.clientX, e.clientY, p)) {
          this.singularity.pos.copy(p)
          this.singularityFx.setPosition(p)
          this.wakeAll()
          this.needsRender = true
        }
      }
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId)
    if (this.drag && e.pointerId === this.drag.pointerId) {
      e.stopImmediatePropagation()
      // The lift position is the final sample: moves can arrive one frame apart on a
      // slow frame, but pointerup always carries where the finger actually left the glass.
      if (e.type !== 'pointercancel') this.updateDragTarget(e.clientX, e.clientY, e.timeStamp)
      this.endDrag(e.type !== 'pointercancel', e.timeStamp)
      return
    }
    if (this.slice && e.pointerId === this.slice.pointerId) {
      e.stopImmediatePropagation()
      this.endSlice()
      return
    }
    const g = this.singularityGesture
    if (g && e.pointerId === g.pointerId) {
      e.stopImmediatePropagation()
      this.endSingularityGesture(e.type !== 'pointercancel' && !g.moved && !g.placing && e.timeStamp - g.startTime < 350)
    }
  }

  private endSingularityGesture(tapped: boolean): void {
    const g = this.singularityGesture
    if (!g) return
    this.singularityGesture = null
    try {
      if (this.canvas.hasPointerCapture(g.pointerId)) this.canvas.releasePointerCapture(g.pointerId)
    } catch {
      /* ignore */
    }
    // Tapping the core dismisses the singularity.
    if (tapped) {
      this.dismissSingularity()
      haptics.tap()
    }
    this.applyModeToControls()
  }

  private onLostCapture = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.pointerId) {
      this.activePointers.delete(e.pointerId)
      this.endDrag(true, e.timeStamp)
    } else if (this.slice && e.pointerId === this.slice.pointerId) {
      this.activePointers.delete(e.pointerId)
      this.endSlice()
    } else if (this.singularityGesture && e.pointerId === this.singularityGesture.pointerId) {
      this.activePointers.delete(e.pointerId)
      this.endSingularityGesture(false)
    }
  }

  private onGlobalPointerEnd = (e: PointerEvent): void => {
    const owned =
      e.pointerId === this.drag?.pointerId ||
      e.pointerId === this.slice?.pointerId ||
      e.pointerId === this.singularityGesture?.pointerId
    if (!owned) this.activePointers.delete(e.pointerId)
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault()
  }

  private applyModeToControls(): void {
    const camera = this.mode === 'camera'
    // Grab / Slice: one finger is reserved for the tool; two-finger pinch still zooms.
    // Camera: one finger orbits, two-finger pinch zooms.
    this.controls.touches.ONE = camera ? THREE.TOUCH.ROTATE : null
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_PAN
    this.controls.mouseButtons.LEFT = camera ? THREE.MOUSE.ROTATE : null
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE
    this.controls.enabled = !this.drag && !this.slice && !this.singularityGesture
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
    this.laser.resize(w, h, Math.min(window.devicePixelRatio || 1, 2))
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
    this.statsDirty = true

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
      if (this.slice) this.endSlice()
      if (this.singularityGesture) this.endSingularityGesture(false)
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
