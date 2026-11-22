import * as THREE from 'three'

/**
 * Golden-angle hue walk: consecutive spawns land far apart on the colour wheel,
 * so neighbours stay distinguishable. High saturation + high lightness gives the
 * pastel-neon look against the dark arena.
 */
const GOLDEN_ANGLE = 137.508
let hue = 188 // start in the cyan family

function hsl(h: number) {
  // Nudge lightness by hue so yellows don't blow out and blues don't sink.
  const l = 0.6 + 0.06 * Math.cos(((h - 230) * Math.PI) / 180)
  return { h, s: 0.92, l }
}

export function peekNextColorCss(): string {
  const c = hsl(hue)
  return `hsl(${c.h.toFixed(0)} ${Math.round(c.s * 100)}% ${Math.round(c.l * 100)}%)`
}

export function nextSpawnColor(): THREE.Color {
  const c = hsl(hue)
  hue = (hue + GOLDEN_ANGLE) % 360
  return new THREE.Color().setHSL(c.h / 360, c.s, c.l, THREE.SRGBColorSpace)
}
