import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type * as RAPIER from '@dimforge/rapier3d-compat'
import { CUBE_BEVEL, CUBE_SIZE, CYLINDER_HALF_HEIGHT, CYLINDER_RADIUS, SPHERE_RADIUS } from './constants'

/**
 * Every rigid body is one of these convex forms. Each form renders through its
 * own InstancedMesh ("bucket"), with per-instance scale supplying the size, so
 * fragments and sliced halves of any size still cost one draw call per form.
 *
 * Local-frame conventions (the body origin is the local origin):
 *  - cube / nitro   rounded cube of CUBE_SIZE, centred
 *  - box            cuboid with half extents (x, y, z), centred           (sliced cube halves)
 *  - sphere         radius x, centred
 *  - cylinder       radius x, half height y, axis = local Y, centred      (also short sliced pieces)
 *  - hemisphere     radius x, flat face on y = 0, dome toward +Y          (sliced sphere halves)
 *  - halfcyl        radius x, half height y, flat face on x = 0, toward +X (lengthwise cylinder halves)
 *  - shard          icosahedron scaled by (x, y, z)                        (fracture debris)
 */
export type FormType = 'cube' | 'nitro' | 'box' | 'sphere' | 'cylinder' | 'hemisphere' | 'halfcyl' | 'shard'

export const FORM_TYPES: readonly FormType[] = [
  'cube',
  'nitro',
  'box',
  'sphere',
  'cylinder',
  'hemisphere',
  'halfcyl',
  'shard',
]

export interface Form {
  type: FormType
  /** Dimensions; meaning per type is documented above. */
  d: THREE.Vector3
}

export function makeForm(type: FormType, x = 0, y = x, z = x): Form {
  return { type, d: new THREE.Vector3(x, y, z) }
}

export const CUBE_FORM = (): Form => makeForm('cube', CUBE_SIZE / 2)
export const NITRO_FORM = (): Form => makeForm('nitro', CUBE_SIZE / 2)
export const SPHERE_FORM = (): Form => makeForm('sphere', SPHERE_RADIUS)
export const CYLINDER_FORM = (): Form => makeForm('cylinder', CYLINDER_RADIUS, CYLINDER_HALF_HEIGHT, CYLINDER_RADIUS)

/** Volume of the unit icosahedron (circumradius 1). */
const ICOSAHEDRON_VOLUME = 2.5362

export function formVolume(f: Form): number {
  const { x, y, z } = f.d
  switch (f.type) {
    case 'cube':
    case 'nitro':
      return CUBE_SIZE ** 3
    case 'box':
      return 8 * x * y * z
    case 'sphere':
      return (4 / 3) * Math.PI * x ** 3
    case 'cylinder':
      return Math.PI * x * x * 2 * y
    case 'hemisphere':
      return (2 / 3) * Math.PI * x ** 3
    case 'halfcyl':
      return Math.PI * x * x * y // half of π r² · 2h
    case 'shard':
      return ICOSAHEDRON_VOLUME * x * y * z
  }
}

/** Local-space AABB of the form (min / max corners). */
export function formLocalBounds(f: Form, outMin: THREE.Vector3, outMax: THREE.Vector3): void {
  const { x, y, z } = f.d
  switch (f.type) {
    case 'hemisphere':
      outMin.set(-x, 0, -x)
      outMax.set(x, x, x)
      return
    case 'halfcyl':
      outMin.set(0, -y, -x)
      outMax.set(x, y, x)
      return
    case 'sphere':
      outMin.set(-x, -x, -x)
      outMax.set(x, x, x)
      return
    case 'cylinder':
      outMin.set(-x, -y, -x)
      outMax.set(x, y, x)
      return
    default:
      outMin.set(-x, -y, -z)
      outMax.set(x, y, z)
  }
}

/** Radius of a sphere around the body origin that contains the whole form. */
export function formBoundingRadius(f: Form): number {
  const { x, y, z } = f.d
  switch (f.type) {
    case 'cube':
    case 'nitro':
    case 'box':
      return Math.hypot(x, y, z)
    case 'sphere':
    case 'hemisphere':
      return x
    case 'cylinder':
    case 'halfcyl':
      return Math.hypot(x, y)
    case 'shard':
      return Math.max(x, y, z)
  }
}

/** Per-instance scale that maps the bucket's base geometry onto this form. */
export function formVisualScale(f: Form, out: THREE.Vector3): THREE.Vector3 {
  const { x, y, z } = f.d
  switch (f.type) {
    case 'cube':
    case 'nitro':
      return out.set(1, 1, 1)
    case 'sphere':
    case 'hemisphere':
      return out.set(x, x, x)
    case 'cylinder':
    case 'halfcyl':
      return out.set(x, y, x)
    default:
      return out.set(x, y, z)
  }
}

// ---------------------------------------------------------------------------
// Render geometry (one base geometry per bucket)
// ---------------------------------------------------------------------------

export function createFormGeometries(): Record<FormType, THREE.BufferGeometry> {
  const cube = new RoundedBoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE, 2, CUBE_BEVEL)
  const nitro = new RoundedBoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE, 2, CUBE_BEVEL)
  // Unit-half-extent box with a small bevel so the cut edges catch the light.
  const box = new RoundedBoxGeometry(2, 2, 2, 1, 0.07)
  const sphere = new THREE.SphereGeometry(1, 28, 18)
  const cylinder = new THREE.CylinderGeometry(1, 1, 2, 28, 1)

  const dome = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2)
  const cap = new THREE.CircleGeometry(1, 28)
  cap.rotateX(Math.PI / 2) // face −Y
  const hemisphere = mergeGeometries([dome, cap])!
  dome.dispose()
  cap.dispose()

  // thetaStart 0, length π → x = sin θ ≥ 0: the half on the +X side.
  const shell = new THREE.CylinderGeometry(1, 1, 2, 18, 1, false, 0, Math.PI)
  const flat = new THREE.PlaneGeometry(2, 2)
  flat.rotateY(-Math.PI / 2) // face −X, spanning z ∈ [−1, 1], y ∈ [−1, 1]
  const halfcyl = mergeGeometries([shell, flat])!
  shell.dispose()
  flat.dispose()

  // Faceted rock: the icosahedron's flat normals read as broken shards.
  const shard = new THREE.IcosahedronGeometry(1, 0)

  return { cube, nitro, box, sphere, cylinder, hemisphere, halfcyl, shard }
}

// ---------------------------------------------------------------------------
// Colliders
// ---------------------------------------------------------------------------

/** Low-resolution hull point sets (unit size), scaled per body. */
const HULL_POINTS: Partial<Record<FormType, Float32Array>> = (() => {
  const hemi: number[] = [0, 1, 0]
  for (let ring = 0; ring <= 3; ring++) {
    const phi = (ring / 3) * (Math.PI / 2) // 0 = equator … π/2 = pole
    const y = Math.sin(phi)
    const r = Math.cos(phi)
    if (r < 1e-3) continue
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      hemi.push(Math.cos(a) * r, y, Math.sin(a) * r)
    }
  }
  const half: number[] = []
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI
    for (const y of [-1, 1]) half.push(Math.sin(a), y, Math.cos(a))
  }
  const ico = new THREE.IcosahedronGeometry(1, 0)
  ico.deleteAttribute('normal')
  ico.deleteAttribute('uv')
  const shard = Array.from(ico.attributes.position.array as Float32Array)
  ico.dispose()
  return {
    hemisphere: new Float32Array(hemi),
    halfcyl: new Float32Array(half),
    shard: new Float32Array(shard),
  }
})()

function scaledHull(type: FormType, sx: number, sy: number, sz: number): Float32Array {
  const src = HULL_POINTS[type]!
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i] * sx
    out[i + 1] = src[i + 1] * sy
    out[i + 2] = src[i + 2] * sz
  }
  return out
}

export function createColliderDesc(R: typeof RAPIER, f: Form): RAPIER.ColliderDesc {
  const { x, y, z } = f.d
  switch (f.type) {
    case 'cube':
    case 'nitro': {
      const h = CUBE_SIZE / 2 - CUBE_BEVEL
      return R.ColliderDesc.roundCuboid(h, h, h, CUBE_BEVEL)
    }
    case 'box':
      return R.ColliderDesc.cuboid(x, y, z)
    case 'sphere':
      return R.ColliderDesc.ball(x)
    case 'cylinder':
      return R.ColliderDesc.cylinder(y, x)
    case 'hemisphere':
      return R.ColliderDesc.convexHull(scaledHull('hemisphere', x, x, x)) ?? R.ColliderDesc.ball(x * 0.6)
    case 'halfcyl':
      return R.ColliderDesc.convexHull(scaledHull('halfcyl', x, y, x)) ?? R.ColliderDesc.cuboid(x / 2, y, x)
    case 'shard':
      return R.ColliderDesc.convexHull(scaledHull('shard', x, y, z)) ?? R.ColliderDesc.ball(Math.min(x, y, z))
  }
}
