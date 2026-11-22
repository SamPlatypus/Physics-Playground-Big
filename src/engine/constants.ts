export type ShapeKind = 'cube' | 'sphere' | 'cylinder'
export type InteractionMode = 'interact' | 'camera'

/** Hard ceiling on live rigid bodies. Spawning past it recycles the oldest resting body. */
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

/**
 * Per-shape physical character. The global restitution / friction sliders are
 * scaled by these so each shape keeps its personality at any slider setting.
 */
export interface ShapeSpec {
  label: string
  density: number
  linearDamping: number
  angularDamping: number
  restitutionScale: number
  frictionScale: number
  /** Bounding radius, used to keep dragged bodies inside the glass. */
  boundingRadius: number
  /**
   * Rolling resistance (1/s at friction 1), applied only to slow bodies touching
   * the floor. Rapier has no rolling friction, so without it a sphere or a
   * cylinder on its side would roll indefinitely and never sleep.
   */
  rollingResistance: number
}

export const SHAPE_SPECS: Record<ShapeKind, ShapeSpec> = {
  // Heavy-ish, damped rotation, damped bounce: settles flat and stacks well.
  cube: {
    label: 'Cube',
    density: 1.0,
    linearDamping: 0.05,
    angularDamping: 0.35,
    restitutionScale: 0.7,
    frictionScale: 1.0,
    boundingRadius: 0.8,
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
    boundingRadius: 0.5,
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
    boundingRadius: 0.72,
    rollingResistance: 0.9,
  },
}

export const CUBE_SIZE = 0.95
export const CUBE_BEVEL = 0.07
export const SPHERE_RADIUS = 0.5
export const CYLINDER_RADIUS = 0.36
export const CYLINDER_HALF_HEIGHT = 0.6

export function shapeRestitution(kind: ShapeKind, slider: number): number {
  return Math.min(1, Math.max(0, slider * SHAPE_SPECS[kind].restitutionScale))
}

export function shapeFriction(kind: ShapeKind, slider: number): number {
  return Math.min(1, Math.max(0, slider * SHAPE_SPECS[kind].frictionScale))
}
