import * as THREE from 'three'

/**
 * Nitro block look, generated on a canvas (no image assets, works offline):
 * yellow/black hazard stripes framing a dark plate with a red reactor core.
 * The core alone is the emissive map, so pulsing emissiveIntensity makes only
 * the core throb.
 */
function drawFace(ctx: CanvasRenderingContext2D, size: number, emissiveOnly: boolean): void {
  const band = size * 0.16
  ctx.fillStyle = emissiveOnly ? '#000000' : '#16181f'
  ctx.fillRect(0, 0, size, size)

  if (!emissiveOnly) {
    // Hazard frame: diagonal stripes clipped to the outer band.
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, size, size)
    ctx.rect(band, band, size - band * 2, size - band * 2)
    ctx.clip('evenodd')
    ctx.fillStyle = '#ffc21a'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = '#111111'
    const stripe = size / 10
    for (let i = -size; i < size * 2; i += stripe * 2) {
      ctx.beginPath()
      ctx.moveTo(i, 0)
      ctx.lineTo(i + stripe, 0)
      ctx.lineTo(i + stripe - size, size)
      ctx.lineTo(i - size, size)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
    // Inner bevel line.
    ctx.strokeStyle = '#3a3f4b'
    ctx.lineWidth = size * 0.012
    ctx.strokeRect(band, band, size - band * 2, size - band * 2)
  }

  // Reactor core.
  const c = size / 2
  const grad = ctx.createRadialGradient(c, c, 0, c, c, size * 0.24)
  grad.addColorStop(0, '#fff1e0')
  grad.addColorStop(0.25, '#ff4a3a')
  grad.addColorStop(0.7, '#a3000f')
  grad.addColorStop(1, emissiveOnly ? '#000000' : '#16181f')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(c, c, size * 0.24, 0, Math.PI * 2)
  ctx.fill()
  if (!emissiveOnly) {
    ctx.strokeStyle = '#ff5a4a'
    ctx.lineWidth = size * 0.014
    ctx.beginPath()
    ctx.arc(c, c, size * 0.27, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function canvasTexture(emissiveOnly: boolean): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) drawFace(ctx, size, emissiveOnly)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

export interface NitroMaterial {
  material: THREE.MeshStandardMaterial
  textures: THREE.Texture[]
  /** Advance the core pulse; `armed` makes it strobe while a detonation is queued. */
  update(time: number, armed: boolean): void
}

export function createNitroMaterial(): NitroMaterial {
  const map = canvasTexture(false)
  const emissiveMap = canvasTexture(true)
  const material = new THREE.MeshStandardMaterial({
    map,
    emissiveMap,
    emissive: new THREE.Color('#ff2a1a'),
    emissiveIntensity: 1.4,
    roughness: 0.55,
    metalness: 0.2,
  })
  return {
    material,
    textures: [map, emissiveMap],
    update(time, armed) {
      const rate = armed ? 22 : 4.2
      const s = Math.sin(time * rate) * 0.5 + 0.5
      material.emissiveIntensity = armed ? 1.6 + 3.2 * s : 0.9 + 1.5 * s * s
    },
  }
}
