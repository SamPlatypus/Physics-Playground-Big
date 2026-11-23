/** Shapes the player can spawn from the toolbar. */
export type ShapeKind = 'cube' | 'sphere' | 'cylinder' | 'nitro'
/** Physical "personality" class; sliced halves keep their parent's, fracture debris are 'shard'. */
export type MaterialClass = ShapeKind | 'shard'
export type InteractionMode = 'interact' | 'camera' | 'slice'
export type SingularityType = 'blackhole' | 'repulsor'

/** Hard ceiling on live rigid bodies (debris included). Past it, the oldest resting debris is recycled first. */
export const MAX_BODIES = 150

/** Interior dimensions of the glass containment box, in metres. */
export const ARENA = {
  halfX: 4,
  halfZ: 4,
  height: 8,
  wallThickness: 1,
} as const

/** Fixed simulation step; rendering interpolates between steps for high-refresh screens. */
export const FIXED_DT = 1 / 60
export const MAX_SUBSTEPS = 4

/**
 * Sleep thresholds (in the spirit of cannon-es' sleepSpeedLimit / sleepTimeLimit).
 * Rapier sleeps each contact island on its own (its per-body thresholds aren't
 * exposed in the JS bindings). On top of that, once every awake body has stayed
 * under these limits for SLEEP_TIME_LIMIT, the engine puts them all to sleep at
 * once, so a settled scene drops out of the solver quickly.
 */
export const SLEEP_SPEED_LIMIT = 0.12 // m/s
export const SLEEP_ANGULAR_LIMIT = 0.25 // rad/s
export const SLEEP_TIME_LIMIT = 0.6 // seconds the whole scene must stay below both limits
/** Rolling resistance only kicks in below this speed, so throws and fast rolls are untouched. */
export const ROLLING_RESISTANCE_MAX_SPEED = 1.2 // m/s

/** Contact acceleration (force / mass) that counts as a "high-speed" impact. ≈ 3–4 m/s hit. */
export const IMPACT_ACCEL_THRESHOLD = 260

/** Drag / fling tuning. */
export const DRAG_MAX_SPEED = 32 // m/s the kinematic body may travel toward the finger
export const THROW_MAX_SPEED = 26 // m/s cap on release velocity
export const THROW_SAMPLE_WINDOW_MS = 80 // finger history used to estimate the release velocity
export const FLING_HAPTIC_SPEED = 2.5 // m/s needed for a release to count as a fling

// ---------------------------------------------------------------------------
// Fracture & debris
// ---------------------------------------------------------------------------

/**
 * Impact kinetic energy per kilogram (normal component, J/kg) that shatters an
 * unbroken shape: ½·v² ≥ 55 ⇔ v ≳ 10.5 m/s — a hard throw or a fall of ~6 m on Earth.
 */
export const FRACTURE_ENERGY_PER_KG = 55
export const FRACTURE_MIN_PIECES = 4
export const FRACTURE_MAX_PIECES = 6
/** Modest outward scatter given to each fragment on top of the parent's velocity. */
export const FRACTURE_SCATTER_SPEED = 2.4 // m/s
/** Fractures are spread over steps so a big blast can't spike a single frame. */
export const MAX_FRACTURES_PER_STEP = 2
/** Freshly spawned bodies shrug off their first landing (otherwise every drop-in would shatter). */
export const SPAWN_GRACE_SECONDS = 3
export const FIRST_IMPACT_GRACE_SECONDS = 0.35

export const DEBRIS_SLOW_SPEED = 0.1 // m/s
export const DEBRIS_SLOW_SECONDS = 2 // despawn after staying under DEBRIS_SLOW_SPEED this long
export const DEBRIS_REST_SPEED = 0.5 // m/s: "resting" (settled but maybe still jittering)
export const DEBRIS_REST_SECONDS = 4 // despawn after resting this long
export const DEBRIS_MAX_LIFETIME = 12 // s: safety net (zero-G debris never comes to rest)
export const DEBRIS_FADE_SECONDS = 0.45

// ---------------------------------------------------------------------------
// Laser slicing
// ---------------------------------------------------------------------------

/** Separation speed given to each half along the cut normal. */
export const SLICE_SEPARATION_SPEED = 1.3 // m/s
/** Minimum swipe segment (CSS px) evaluated as a blade stroke. */
export const SLICE_SEGMENT_PX = 8
/** Off-centre cuts are clamped so neither half is a sliver. */
export const SLICE_MAX_OFFSET = 0.6 // fraction of the half-extent

// ---------------------------------------------------------------------------
// Nitro
// ---------------------------------------------------------------------------

/** Impact energy per kg that sets a Nitro block off (≈ 6.6 m/s hit). */
export const NITRO_TRIGGER_ENERGY_PER_KG = 22
export const BLAST_RADIUS = 3.6 // m: knock-back and chain-reaction reach
export const BLAST_MAX_SPEED = 15 // m/s velocity change at the epicentre
export const BLAST_FRACTURE_RADIUS = 2.2 // m: breakables this close shatter
/**
 * Chain-reaction stagger: a Nitro block set off by another blast waits this many
 * physics steps, and queued blasts are kept at least this far apart, so a cluster
 * rolls off as a wave instead of all detonating in one frame.
 * 4 steps × 16.7 ms = 66.7 ms — inside the 60–80 ms window.
 */
export const CHAIN_DELAY_STEPS = 4
export const EXPLOSION_FX_SECONDS = 0.5

// ---------------------------------------------------------------------------
// Singularities
// ---------------------------------------------------------------------------

export const SINGULARITY = {
  /** Placement height (m); the singularity moves on this horizontal plane. */
  height: 2.4,
  /** Bodies farther than this are unaffected. */
  influence: 6.5,
  /** Softening length ε in a = G / (r² + ε²). */
  softening: 1.0,
  /** Event-horizon core radius: heavy damping inside, force tapers to zero at r = 0. */
  core: 0.5,
  // ≈ 1 g of pull 3.4 m out (enough to drag resting bodies off the floor), and
  // never more than G/ε² = 120 m/s² however close a body gets.
  blackHoleG: 120,
  repulsorG: 50,
  /** Tangential share of the black hole's pull, so bodies spiral in rather than plunge. */
  swirl: 0.25,
  /**
   * Accretion drag (1/s) on bodies inside the black hole's field. The swirl alone
   * would keep pumping angular momentum in (bodies end up circling at the speed
   * clamp); this bleeds it off so orbits decay inward toward the damped core.
   */
  accretionDrag: 0.9,
  /** Escape-velocity clamp for any body inside the field. */
  maxSpeed: 12, // m/s
  coreLinearDamping: 6,
  coreAngularDamping: 6,
  /** Repulsor emits a shockwave pulse this often. */
  pulseInterval: 1.3, // s
  pulseSpeed: 10, // m/s velocity change at the epicentre per pulse
  /** Touch radius (CSS px) for grabbing / dismissing the core. */
  touchRadius: 40,
} as const

// ---------------------------------------------------------------------------
// Tremor (earthquake)
// ---------------------------------------------------------------------------

export const TREMOR = {
  duration: 1.2, // s of shaking, envelope included
  frequency: 3.4, // Hz of the horizontal gravity oscillation
  amplitude: 6.0, // m/s²: g_x = sin(2πft) · 6
  attack: 0.12, // s
  release: 0.45, // s of settling decay at the end
  bounces: 4, // small vertical kicks spread over the quake
  bounceSpeed: 1.1, // m/s
  shakeThreshold: 18, // m/s² linear acceleration that counts as a shake
  shakeCooldownMs: 2000,
} as const

// ---------------------------------------------------------------------------
// Gravity presets
// ---------------------------------------------------------------------------

export interface GravityPreset {
  id: 'earth' | 'moon' | 'mars' | 'zero' | 'inverted'
  label: string
  value: number
}

export const GRAVITY_PRESETS: readonly GravityPreset[] = [
  { id: 'earth', label: 'Earth', value: -9.81 },
  { id: 'moon', label: 'Moon', value: -1.62 },
  { id: 'mars', label: 'Mars', value: -3.71 },
  { id: 'zero', label: 'Zero-G', value: 0 },
  { id: 'inverted', label: 'Inverted', value: 9.81 },
] as const

export type GravityId = GravityPreset['id']

export function gravityValue(id: GravityId): number {
  return GRAVITY_PRESETS.find((p) => p.id === id)?.value ?? -9.81
}

// ---------------------------------------------------------------------------
// Per-material character
// ---------------------------------------------------------------------------

/**
 * Per-material physical character. The global restitution / friction sliders are
 * scaled by these so each shape keeps its personality at any slider setting.
 */
export interface MaterialSpec {
  label: string
  density: number
  linearDamping: number
  angularDamping: number
  restitutionScale: number
  frictionScale: number
  /**
   * Rolling resistance (1/s at friction 1), applied only to slow bodies touching
   * the floor. Rapier has no rolling friction, so without it a sphere or a
   * cylinder on its side would roll indefinitely and never sleep.
   */
  rollingResistance: number
}

export const MATERIAL_SPECS: Record<MaterialClass, MaterialSpec> = {
  // Heavy-ish, damped rotation, damped bounce: settles flat and stacks well.
  cube: {
    label: 'Cube',
    density: 1.0,
    linearDamping: 0.05,
    angularDamping: 0.35,
    restitutionScale: 0.7,
    frictionScale: 1.0,
    rollingResistance: 0,
  },
  // Light, low rotational damping, amplified bounce: rolls far and hops.
  sphere: {
    label: 'Sphere',
    density: 0.8,
    linearDamping: 0.04,
    angularDamping: 0.16, // stands in for rolling resistance (Rapier has none)
    restitutionScale: 1.3,
    frictionScale: 0.85,
    rollingResistance: 0.45,
  },
  // Tall enough to stand as a column / domino, round enough to roll on its side.
  cylinder: {
    label: 'Cylinder',
    density: 1.0,
    linearDamping: 0.05,
    angularDamping: 0.12,
    restitutionScale: 0.8,
    frictionScale: 1.0,
    rollingResistance: 0.9,
  },
  // A dense, dead block: it shouldn't bounce around on its own.
  nitro: {
    label: 'Nitro',
    density: 1.2,
    linearDamping: 0.05,
    angularDamping: 0.4,
    restitutionScale: 0.45,
    frictionScale: 1.0,
    rollingResistance: 0,
  },
  // Fracture shards: damped so they settle (and despawn) quickly.
  shard: {
    label: 'Debris',
    density: 1.0,
    linearDamping: 0.12,
    angularDamping: 0.5,
    restitutionScale: 0.5,
    frictionScale: 1.0,
    rollingResistance: 0.8,
  },
}

export const CUBE_SIZE = 0.95
export const CUBE_BEVEL = 0.07
export const SPHERE_RADIUS = 0.5
export const CYLINDER_RADIUS = 0.36
export const CYLINDER_HALF_HEIGHT = 0.6

export function materialRestitution(material: MaterialClass, slider: number): number {
  return Math.min(1, Math.max(0, slider * MATERIAL_SPECS[material].restitutionScale))
}

export function materialFriction(material: MaterialClass, slider: number): number {
  return Math.min(1, Math.max(0, slider * MATERIAL_SPECS[material].frictionScale))
}
