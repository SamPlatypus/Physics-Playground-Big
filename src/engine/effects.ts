import * as THREE from 'three'
import { EXPLOSION_FX_SECONDS, SINGULARITY, type SingularityType } from './constants'

/**
 * Pooled visual effects. Everything here is allocated once up front and reused,
 * so effects never trigger GC or shader compiles mid-game.
 */

const _zAxis = new THREE.Vector3(0, 0, 1)
const _white = new THREE.Color('#ffffff')

// ---------------------------------------------------------------------------
// Impact shockwave rings (floor / wall hits)
// ---------------------------------------------------------------------------

const RING_SECONDS = 0.5

export class ImpactRings {
  private readonly rings: { mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; t: number; scale: number }[] =
    []
  private cursor = 0
  private readonly geometry = new THREE.RingGeometry(0.55, 0.68, 48)

  constructor(scene: THREE.Scene, count = 8) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: '#8af6ff',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      })
      const mesh = new THREE.Mesh(this.geometry, mat)
      mesh.visible = false
      scene.add(mesh)
      this.rings.push({ mesh, t: 1, scale: 1 })
    }
  }

  spawn(position: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, scale: number): void {
    const ring = this.rings[this.cursor]
    this.cursor = (this.cursor + 1) % this.rings.length
    ring.mesh.position.copy(position)
    ring.mesh.quaternion.setFromUnitVectors(_zAxis, normal)
    ring.mesh.material.color.copy(color).lerp(_white, 0.45)
    ring.scale = scale
    ring.t = 0
    ring.mesh.visible = true
  }

  /** Returns true while any ring is still animating. */
  update(dt: number): boolean {
    let active = false
    for (const ring of this.rings) {
      if (ring.t >= 1) continue
      ring.t = Math.min(1, ring.t + dt / RING_SECONDS)
      const k = 1 - Math.pow(1 - ring.t, 3)
      ring.mesh.scale.setScalar(ring.scale * (0.35 + 1.4 * k))
      ring.mesh.material.opacity = 0.75 * (1 - ring.t)
      ring.mesh.visible = ring.t < 1
      active = true
    }
    return active
  }

  dispose(): void {
    this.geometry.dispose()
    for (const r of this.rings) r.mesh.material.dispose()
  }
}

// ---------------------------------------------------------------------------
// Explosions: fireball + hot core + smoke puff + one shared flash light
// ---------------------------------------------------------------------------

/**
 * Soft volumetric-looking ball: bright where the surface faces the camera,
 * fading to nothing at the silhouette, so blasts and smoke read as glowing
 * puffs instead of flat discs. Not tone-mapped, so fire stays saturated.
 */
function softBallMaterial(additive: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: 0 },
      uCore: { value: new THREE.Color('#ffffff') },
      uEdge: { value: new THREE.Color('#ffffff') },
      uSoft: { value: additive ? 1.3 : 0.8 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform vec3 uCore;
      uniform vec3 uEdge;
      uniform float uSoft;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float f = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        float a = uOpacity * pow(f, uSoft);
        vec3 col = mix(uEdge, uCore, pow(f, 2.5));
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    toneMapped: false,
  })
}

/** Icosphere with baked random lumps: a fireball silhouette rather than a perfect ball. */
function lumpyBall(detail: number, amount: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, detail)
  const pos = geo.attributes.position as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    // Deterministic pseudo-noise from direction, so shared vertices move together.
    const n = Math.sin(v.x * 5.1 + v.y * 3.7) * Math.cos(v.z * 4.3 - v.x * 2.1) * Math.sin(v.y * 6.2 + v.z * 1.9)
    v.multiplyScalar(1 + n * amount)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  geo.computeVertexNormals()
  return geo
}

type SoftBall = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>

interface Blast {
  fire: SoftBall
  core: SoftBall
  smoke: SoftBall
  origin: THREE.Vector3
  radius: number
  t: number
}

const FIRE_HOT = new THREE.Color('#fff0b8')
const FIRE_MID = new THREE.Color('#ff8a1e')
const FIRE_END = new THREE.Color('#c41d0c')
const _fireEdge = new THREE.Color()

export class Explosions {
  private readonly blasts: Blast[] = []
  private readonly geometry = lumpyBall(3, 0.16)
  private readonly smokeGeometry = lumpyBall(2, 0.22)
  private readonly light = new THREE.PointLight('#ff8a3a', 0, 12, 1.6)
  private cursor = 0
  private lightT = 1

  constructor(scene: THREE.Scene, count = 6) {
    // The flash light always exists (intensity 0 at rest) so adding it never
    // changes the light count and forces every material to recompile.
    scene.add(this.light)
    for (let i = 0; i < count; i++) {
      const fire = new THREE.Mesh(this.geometry, softBallMaterial(true))
      const core = new THREE.Mesh(this.geometry, softBallMaterial(true))
      core.material.uniforms.uCore.value.set('#ffffff')
      core.material.uniforms.uEdge.value.copy(FIRE_HOT)
      const smoke = new THREE.Mesh(this.smokeGeometry, softBallMaterial(false))
      smoke.material.uniforms.uCore.value.set('#3a3a42')
      smoke.material.uniforms.uEdge.value.set('#15151a')
      for (const m of [fire, core, smoke]) {
        m.visible = false
        m.frustumCulled = false
        scene.add(m)
      }
      fire.renderOrder = 6
      core.renderOrder = 7
      smoke.renderOrder = 5
      this.blasts.push({ fire, core, smoke, origin: new THREE.Vector3(), radius: 1, t: 1 })
    }
  }

  spawn(position: THREE.Vector3, radius: number): void {
    const b = this.blasts[this.cursor]
    this.cursor = (this.cursor + 1) % this.blasts.length
    b.origin.copy(position)
    b.radius = radius
    b.t = 0
    b.fire.rotation.set(Math.random() * 6, Math.random() * 6, 0)
    b.smoke.rotation.set(Math.random() * 6, Math.random() * 6, 0)
    for (const m of [b.fire, b.core, b.smoke]) {
      m.position.copy(position)
      m.visible = true
    }
    this.light.position.copy(position)
    this.lightT = 0
  }

  get activeCount(): number {
    let n = 0
    for (const b of this.blasts) if (b.t < 1) n++
    return n
  }

  /** Returns true while anything is visible. Every blast is fully cleared after EXPLOSION_FX_SECONDS. */
  update(dt: number): boolean {
    let active = false
    for (const b of this.blasts) {
      if (b.t >= 1) continue
      b.t = Math.min(1, b.t + dt / EXPLOSION_FX_SECONDS)
      const t = b.t
      const grow = 1 - Math.pow(1 - t, 3)
      b.fire.scale.setScalar(b.radius * (0.25 + 0.75 * grow))
      b.fire.rotation.y += dt * 0.8
      const fu = b.fire.material.uniforms
      fu.uOpacity.value = Math.pow(1 - t, 1.3) * 1.2
      fu.uCore.value.copy(t < 0.35 ? FIRE_HOT : FIRE_MID)
      _fireEdge.copy(FIRE_MID).lerp(FIRE_END, Math.min(1, t * 1.4))
      fu.uEdge.value.copy(_fireEdge)
      b.core.scale.setScalar(b.radius * 0.5 * (0.35 + 0.65 * Math.min(1, t * 3)))
      b.core.material.uniforms.uOpacity.value = Math.max(0, 1 - t * 2.4) * 1.4
      const s = Math.max(0, (t - 0.1) / 0.9)
      b.smoke.scale.setScalar(b.radius * (0.4 + 0.55 * s))
      b.smoke.position.set(b.origin.x, b.origin.y + s * 1.1, b.origin.z)
      b.smoke.material.uniforms.uOpacity.value = 0.55 * Math.sin(Math.PI * s)
      const done = t >= 1
      b.fire.visible = b.core.visible = b.smoke.visible = !done
      active = true
    }
    if (this.lightT < 1) {
      this.lightT = Math.min(1, this.lightT + dt / (EXPLOSION_FX_SECONDS * 0.7))
      this.light.intensity = 90 * Math.pow(1 - this.lightT, 2)
      active = true
    } else {
      this.light.intensity = 0
    }
    return active
  }

  clear(): void {
    for (const b of this.blasts) {
      b.t = 1
      b.fire.visible = b.core.visible = b.smoke.visible = false
    }
    this.lightT = 1
    this.light.intensity = 0
  }

  dispose(): void {
    this.geometry.dispose()
    this.smokeGeometry.dispose()
    for (const b of this.blasts) {
      b.fire.material.dispose()
      b.core.material.dispose()
      b.smoke.material.dispose()
    }
  }
}

// ---------------------------------------------------------------------------
// Laser slicing overlay: a 2D canvas over the WebGL canvas (pointer-events: none)
// ---------------------------------------------------------------------------

interface TrailPoint {
  x: number
  y: number
  t: number
}

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
}

const TRAIL_MS = 240
const MAX_SPARKS = 180

export class LaserOverlay {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private trail: TrailPoint[] = []
  private readonly sparks: Spark[] = []
  private live = false
  private dirty = false
  private dpr = 1

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'laser-overlay'
    this.canvas.setAttribute('aria-hidden', 'true')
    host.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.dirty = true
  }

  begin(x: number, y: number, now: number): void {
    this.trail = [{ x, y, t: now }]
    this.live = true
  }

  extend(x: number, y: number, now: number): void {
    const last = this.trail[this.trail.length - 1]
    this.trail.push({ x, y, t: now })
    if (this.trail.length > 64) this.trail.shift()
    // A trickle of sparks shed from the beam tip.
    if (last) {
      const dx = x - last.x
      const dy = y - last.y
      const len = Math.hypot(dx, dy) || 1
      this.emit(x, y, 2, -dx / len, -dy / len, 140)
    }
  }

  end(): void {
    this.live = false
  }

  /** Burst of sparks where the beam severed something. */
  burst(x: number, y: number, dirX: number, dirY: number): void {
    this.emit(x, y, 26, dirX, dirY, 420)
    this.emit(x, y, 14, -dirX, -dirY, 320)
  }

  private emit(x: number, y: number, count: number, dirX: number, dirY: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      if (this.sparks.length >= MAX_SPARKS) this.sparks.shift()
      const a = Math.atan2(dirY, dirX) + (Math.random() - 0.5) * 1.6
      const v = speed * (0.35 + Math.random() * 0.8)
      const life = 0.25 + Math.random() * 0.35
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life })
    }
  }

  /** Draws the overlay. Returns true while anything is visible. */
  update(now: number, dt: number): boolean {
    const ctx = this.ctx
    if (!ctx) return false
    if (!this.live) this.trail = this.trail.filter((p) => now - p.t < TRAIL_MS)
    const hasContent = this.trail.length > 1 || this.sparks.length > 0
    if (!hasContent && !this.dirty) return false

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.dirty = hasContent
    if (!hasContent) return false

    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (this.trail.length > 1) {
      const pass = (width: number, color: string) => {
        ctx.lineWidth = width
        for (let i = 1; i < this.trail.length; i++) {
          const a = this.trail[i - 1]
          const b = this.trail[i]
          const age = this.live ? (now - b.t) / (TRAIL_MS * 2) : (now - b.t) / TRAIL_MS
          const alpha = Math.max(0, 1 - age)
          if (alpha <= 0) continue
          ctx.globalAlpha = alpha
          ctx.strokeStyle = color
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }
      pass(18, 'rgba(255, 40, 90, 0.18)')
      pass(8, 'rgba(255, 70, 120, 0.55)')
      pass(2.5, 'rgba(255, 245, 250, 0.95)')
      const tip = this.trail[this.trail.length - 1]
      if (this.live) {
        ctx.globalAlpha = 1
        const g = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 22)
        g.addColorStop(0, 'rgba(255,255,255,0.95)')
        g.addColorStop(0.3, 'rgba(255,80,130,0.6)')
        g.addColorStop(1, 'rgba(255,40,90,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(tip.x, tip.y, 22, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    ctx.lineWidth = 2
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i]
      s.life -= dt
      if (s.life <= 0) {
        this.sparks.splice(i, 1)
        continue
      }
      s.vy += 900 * dt
      s.vx *= 1 - 2.5 * dt
      s.x += s.vx * dt
      s.y += s.vy * dt
      const k = s.life / s.max
      ctx.globalAlpha = k
      ctx.strokeStyle = k > 0.6 ? '#fff6d0' : k > 0.3 ? '#ffb040' : '#ff5a2a'
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(s.x - s.vx * 0.025, s.y - s.vy * 0.025)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    return true
  }

  dispose(): void {
    this.canvas.remove()
  }
}

// ---------------------------------------------------------------------------
// Singularity visuals
// ---------------------------------------------------------------------------

const DISK_VERTEX = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const DISK_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uInner;
  uniform float uOuter;
  uniform vec3 uHot;
  uniform vec3 uCool;
  varying vec2 vPos;
  void main() {
    float r = length(vPos);
    float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);
    float a = atan(vPos.y, vPos.x);
    float arms = sin(a * 3.0 - log(r + 0.05) * 7.0 + uTime * 3.2) * 0.5 + 0.5;
    float fine = sin(a * 11.0 - log(r + 0.05) * 13.0 + uTime * 5.0) * 0.5 + 0.5;
    float body = pow(1.0 - t, 1.8) * smoothstep(0.0, 0.08, t);
    float i = body * (0.3 + 0.55 * arms + 0.15 * fine);
    vec3 col = mix(uCool, uHot, pow(1.0 - t, 2.0));
    gl_FragColor = vec4(col * i * 2.6, i);
  }
`

/** Canvas texture: a dark centre wrapped in glowing logarithmic spiral arms. */
function spiralTexture(): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const c = size / 2
    const glow = ctx.createRadialGradient(c, c, size * 0.08, c, c, c)
    glow.addColorStop(0, 'rgba(0,0,0,0)')
    glow.addColorStop(0.18, 'rgba(255,170,110,0.55)')
    glow.addColorStop(0.35, 'rgba(150,80,255,0.32)')
    glow.addColorStop(1, 'rgba(60,20,140,0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, size, size)
    ctx.globalCompositeOperation = 'lighter'
    for (let arm = 0; arm < 3; arm++) {
      ctx.beginPath()
      for (let i = 0; i <= 120; i++) {
        const t = i / 120
        const r = size * (0.09 + 0.38 * t)
        const a = arm * ((Math.PI * 2) / 3) + t * 4.2
        const x = c + Math.cos(a) * r
        const y = c + Math.sin(a) * r
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = 'rgba(255,200,150,0.55)'
      ctx.lineWidth = size * 0.035
      ctx.stroke()
      ctx.strokeStyle = 'rgba(190,140,255,0.35)'
      ctx.lineWidth = size * 0.09
      ctx.stroke()
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

interface Wave {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  shell: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  t: number
}

export class SingularityFx {
  readonly group = new THREE.Group()
  private type: SingularityType | null = null
  private readonly blackHole = new THREE.Group()
  private readonly repulsor = new THREE.Group()
  private readonly diskMaterial: THREE.ShaderMaterial
  private readonly horizon: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>
  private readonly halo: THREE.Sprite
  private readonly repulsorCore: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  private readonly repulsorHalo: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  private readonly waves: Wave[] = []
  private readonly marker: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  private readonly stem: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
  private readonly disposables: { dispose(): void }[] = []
  private waveCursor = 0

  constructor(scene: THREE.Scene) {
    this.group.visible = false
    scene.add(this.group)

    // --- Black hole: void core, glowing horizon, spiralling accretion disk ---
    const coreGeo = new THREE.SphereGeometry(SINGULARITY.core * 0.85, 32, 16)
    const coreMat = new THREE.MeshBasicMaterial({ color: '#000000', fog: false })
    this.blackHole.add(new THREE.Mesh(coreGeo, coreMat))
    const horizonGeo = new THREE.TorusGeometry(SINGULARITY.core * 1.08, 0.035, 10, 72)
    horizonGeo.rotateX(Math.PI / 2)
    this.horizon = new THREE.Mesh(
      horizonGeo,
      new THREE.MeshBasicMaterial({ color: '#ffcf8a', transparent: true, blending: THREE.AdditiveBlending, fog: false }),
    )
    this.blackHole.add(this.horizon)
    // Swirling halo: a camera-facing spiral that stays visible through the clump
    // of bodies the black hole gathers around itself.
    const haloTex = spiralTexture()
    const haloMat = new THREE.SpriteMaterial({
      map: haloTex,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      fog: false,
    })
    this.halo = new THREE.Sprite(haloMat)
    this.halo.scale.setScalar(3.4)
    this.halo.renderOrder = 9
    this.blackHole.add(this.halo)
    this.disposables.push(haloTex, haloMat)
    this.horizon.renderOrder = 10
    this.horizon.material.depthTest = false

    const diskGeo = new THREE.RingGeometry(SINGULARITY.core * 1.1, 2.4, 96, 1)
    diskGeo.rotateX(-Math.PI / 2)
    this.diskMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uInner: { value: SINGULARITY.core * 1.1 },
        uOuter: { value: 2.4 },
        uHot: { value: new THREE.Color('#ffb46b') },
        uCool: { value: new THREE.Color('#7a3cff') },
      },
      vertexShader: DISK_VERTEX,
      fragmentShader: DISK_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
    const disk = new THREE.Mesh(diskGeo, this.diskMaterial)
    disk.rotation.x = 0.18 // a slight tilt reads as 3D from any orbit angle
    this.blackHole.add(disk)
    this.disposables.push(coreGeo, coreMat, horizonGeo, this.horizon.material, diskGeo, this.diskMaterial)

    // --- Repulsor: hot core + halo + expanding shockwave rings & shells ---
    const rCoreGeo = new THREE.SphereGeometry(0.22, 24, 12)
    this.repulsorCore = new THREE.Mesh(
      rCoreGeo,
      new THREE.MeshBasicMaterial({ color: '#e8fdff', fog: false }),
    )
    const haloGeo = new THREE.SphereGeometry(0.5, 24, 12)
    this.repulsorHalo = new THREE.Mesh(
      haloGeo,
      new THREE.MeshBasicMaterial({
        color: '#38e1ff',
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    )
    this.repulsor.add(this.repulsorCore, this.repulsorHalo)
    const waveGeo = new THREE.RingGeometry(0.92, 1, 72)
    waveGeo.rotateX(-Math.PI / 2)
    const shellGeo = new THREE.IcosahedronGeometry(1, 3)
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(
        waveGeo,
        new THREE.MeshBasicMaterial({
          color: '#7cf3ff',
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
          fog: false,
        }),
      )
      const shell = new THREE.Mesh(
        shellGeo,
        new THREE.MeshBasicMaterial({
          color: '#38e1ff',
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          wireframe: true,
          fog: false,
        }),
      )
      mesh.visible = shell.visible = false
      this.repulsor.add(mesh, shell)
      this.waves.push({ mesh, shell, t: 1 })
      this.disposables.push(mesh.material, shell.material)
    }
    this.disposables.push(rCoreGeo, this.repulsorCore.material, haloGeo, this.repulsorHalo.material, waveGeo, shellGeo)

    // --- Shared: floor marker + stem so the 3D position is readable ---
    const markerGeo = new THREE.RingGeometry(0.5, 0.6, 48)
    markerGeo.rotateX(-Math.PI / 2)
    this.marker = new THREE.Mesh(
      markerGeo,
      new THREE.MeshBasicMaterial({ color: '#b48bff', transparent: true, opacity: 0.7, depthWrite: false, fog: false }),
    )
    const stemGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)])
    this.stem = new THREE.Line(
      stemGeo,
      new THREE.LineBasicMaterial({ color: '#b48bff', transparent: true, opacity: 0.45, depthWrite: false }),
    )
    this.group.add(this.blackHole, this.repulsor, this.stem)
    scene.add(this.marker)
    this.marker.visible = false
    this.disposables.push(markerGeo, this.marker.material, stemGeo, this.stem.material)
  }

  setType(type: SingularityType | null): void {
    this.type = type
    this.group.visible = type !== null
    this.marker.visible = type !== null
    this.blackHole.visible = type === 'blackhole'
    this.repulsor.visible = type === 'repulsor'
    const tint = type === 'repulsor' ? '#5fe9ff' : '#b48bff'
    this.marker.material.color.set(tint)
    this.stem.material.color.set(tint)
  }

  setPosition(p: THREE.Vector3): void {
    this.group.position.copy(p)
    this.marker.position.set(p.x, 0.02, p.z)
    const pos = this.stem.geometry.attributes.position as THREE.BufferAttribute
    pos.setXYZ(1, 0, -p.y + 0.02, 0)
    pos.needsUpdate = true
  }

  /** Emit one repulsor shockwave (ring + shell) that expands to the field's edge. */
  pulse(): void {
    const w = this.waves[this.waveCursor]
    this.waveCursor = (this.waveCursor + 1) % this.waves.length
    w.t = 0
    w.mesh.visible = w.shell.visible = true
  }

  update(dt: number, time: number): void {
    if (!this.type) return
    if (this.type === 'blackhole') {
      this.diskMaterial.uniforms.uTime.value = time
      this.horizon.material.opacity = 0.75 + 0.25 * Math.sin(time * 5)
      this.blackHole.rotation.y = time * 0.6
      this.halo.material.rotation = -time * 1.4
      this.halo.material.opacity = 0.5 + 0.12 * Math.sin(time * 3)
    } else {
      const s = 1 + 0.12 * Math.sin(time * 8)
      this.repulsorHalo.scale.setScalar(s)
      for (const w of this.waves) {
        if (w.t >= 1) continue
        w.t = Math.min(1, w.t + dt / 0.9)
        const k = 1 - Math.pow(1 - w.t, 2.2)
        const r = 0.4 + k * SINGULARITY.influence * 0.75
        w.mesh.scale.setScalar(r)
        w.shell.scale.setScalar(r * 0.8)
        w.mesh.material.opacity = 0.9 * (1 - w.t)
        w.shell.material.opacity = 0.22 * (1 - w.t)
        w.mesh.visible = w.shell.visible = w.t < 1
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.marker.removeFromParent()
    this.group.removeFromParent()
  }
}
