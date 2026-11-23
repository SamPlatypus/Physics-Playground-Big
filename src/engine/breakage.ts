import * as THREE from 'three'
import { FRACTURE_MAX_PIECES, FRACTURE_MIN_PIECES, SLICE_MAX_OFFSET } from './constants'
import { formLocalBounds, formVolume, makeForm, type Form } from './forms'

/**
 * Pure geometry for breaking bodies apart. Children are described in the
 * parent's local frame; the engine maps them into the world, splits the parent's
 * mass by volume, and hands out velocities.
 */
export interface ChildLayout {
  form: Form
  /** Child body origin in the parent's local frame. */
  pos: THREE.Vector3
  /** Child orientation relative to the parent. */
  quat: THREE.Quaternion
  volume: number
  /** Unit direction (parent-local) the child is pushed along when it separates. */
  push: THREE.Vector3
}

const _min = new THREE.Vector3()
const _max = new THREE.Vector3()
const _yAxis = new THREE.Vector3(0, 1, 0)

/** Well-spread unit directions for 4, 5 and 6 pieces (tetrahedron, bipyramid, octahedron). */
const PIECE_DIRECTIONS: Record<number, THREE.Vector3[]> = {
  4: [
    new THREE.Vector3(1, 1, 1),
    new THREE.Vector3(-1, -1, 1),
    new THREE.Vector3(-1, 1, -1),
    new THREE.Vector3(1, -1, -1),
  ].map((v) => v.normalize()),
  5: [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-0.5, 0, 0.866),
    new THREE.Vector3(-0.5, 0, -0.866),
  ],
  6: [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ],
}

/**
 * Shatter layout: 4–6 faceted shards spread through the parent's volume. Shards
 * are sized from the parent's smallest half-extent so they start (nearly)
 * non-overlapping, which keeps Rapier from resolving a violent interpenetration.
 */
export function fractureLayout(parent: Form, random = Math.random): ChildLayout[] {
  const count = FRACTURE_MIN_PIECES + Math.floor(random() * (FRACTURE_MAX_PIECES - FRACTURE_MIN_PIECES + 1))
  formLocalBounds(parent, _min, _max)
  const centre = _min.clone().add(_max).multiplyScalar(0.5)
  const half = _max.clone().sub(_min).multiplyScalar(0.5)
  const base = Math.min(half.x, half.y, half.z) * 0.62 * Math.cbrt(4 / count)
  const spin = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2),
  )

  return PIECE_DIRECTIONS[count].map((dir) => {
    const d = dir.clone().applyQuaternion(spin)
    const pos = centre.clone().add(new THREE.Vector3(d.x * half.x, d.y * half.y, d.z * half.z).multiplyScalar(0.48))
    const jitter = () => base * (0.78 + random() * 0.44)
    const form = makeForm('shard', jitter(), jitter(), jitter())
    const quat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2),
    )
    return { form, pos, quat, volume: formVolume(form), push: d }
  })
}

/**
 * Bisect a form with a plane (parent-local normal `n` through point `p`).
 * Only pristine cubes, spheres and cylinders can be sliced; returns null otherwise.
 *
 *  - cube     → two rectangular prisms along the local axis nearest the cut normal,
 *               split where the plane crosses that axis (clamped off the edges)
 *  - sphere   → two hemispheres split exactly by the cut plane through the centre
 *  - cylinder → two shorter cylinders when cut across its axis, or two
 *               half-cylinders when cut lengthwise (through the axis)
 */
export function sliceLayout(parent: Form, n: THREE.Vector3, p: THREE.Vector3): [ChildLayout, ChildLayout] | null {
  const { x, y } = parent.d
  const gap = 0.004

  if (parent.type === 'cube') {
    const h = x
    const axis = nearestAxis(n)
    const nk = n.getComponent(axis)
    // Where the plane crosses the axis line through the centre: n·(t·e_k − p) = 0.
    let t = Math.abs(nk) > 1e-4 ? n.dot(p) / nk : 0
    t = THREE.MathUtils.clamp(t, -SLICE_MAX_OFFSET * h, SLICE_MAX_OFFSET * h)
    const e = new THREE.Vector3().setComponent(axis, 1)
    const lowHalf = (t + h) / 2
    const highHalf = (h - t) / 2
    const mk = (halfLen: number, centreT: number, sign: number): ChildLayout => {
      const d = new THREE.Vector3(h, h, h).setComponent(axis, halfLen)
      const form = makeForm('box', d.x, d.y, d.z)
      return {
        form,
        pos: e.clone().multiplyScalar(centreT + sign * gap),
        quat: new THREE.Quaternion(),
        volume: formVolume(form),
        push: e.clone().multiplyScalar(sign),
      }
    }
    return [mk(lowHalf, (-h + t) / 2, -1), mk(highHalf, (t + h) / 2, 1)]
  }

  if (parent.type === 'sphere') {
    const r = x
    const up = n.clone().normalize()
    const mk = (dir: THREE.Vector3): ChildLayout => {
      const form = makeForm('hemisphere', r)
      return {
        form,
        pos: dir.clone().multiplyScalar(gap),
        quat: new THREE.Quaternion().setFromUnitVectors(_yAxis, dir),
        volume: formVolume(form),
        push: dir.clone(),
      }
    }
    return [mk(up), mk(up.clone().negate())]
  }

  if (parent.type === 'cylinder') {
    const r = x
    const hh = y
    if (nearestAxis(n) === 1) {
      // Across the axis: two shorter cylinders.
      let t = Math.abs(n.y) > 1e-4 ? n.dot(p) / n.y : 0
      t = THREE.MathUtils.clamp(t, -SLICE_MAX_OFFSET * hh, SLICE_MAX_OFFSET * hh)
      const mk = (halfLen: number, centreY: number, sign: number): ChildLayout => {
        const form = makeForm('cylinder', r, halfLen, r)
        return {
          form,
          pos: new THREE.Vector3(0, centreY + sign * gap, 0),
          quat: new THREE.Quaternion(),
          volume: formVolume(form),
          push: new THREE.Vector3(0, sign, 0),
        }
      }
      return [mk((t + hh) / 2, (-hh + t) / 2, -1), mk((hh - t) / 2, (t + hh) / 2, 1)]
    }
    // Lengthwise: two half-cylinders, split through the axis along the cut's
    // horizontal direction (the cylinder is symmetric about its axis).
    const dir = new THREE.Vector3(n.x, 0, n.z)
    if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0)
    dir.normalize()
    // Rotation about Y that maps the half-cylinder's +X face direction onto `dir`.
    const phi = Math.atan2(-dir.z, dir.x)
    const mk = (angle: number, sign: number): ChildLayout => {
      const form = makeForm('halfcyl', r, hh, r)
      return {
        form,
        pos: dir.clone().multiplyScalar(sign * gap),
        quat: new THREE.Quaternion().setFromAxisAngle(_yAxis, angle),
        volume: formVolume(form),
        push: dir.clone().multiplyScalar(sign),
      }
    }
    return [mk(phi, 1), mk(phi + Math.PI, -1)]
  }

  return null
}

function nearestAxis(n: THREE.Vector3): 0 | 1 | 2 {
  const ax = Math.abs(n.x)
  const ay = Math.abs(n.y)
  const az = Math.abs(n.z)
  if (ax >= ay && ax >= az) return 0
  return ay >= az ? 1 : 2
}
