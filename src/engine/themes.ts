export type ThemeId = 'industrial' | 'neon' | 'pastel' | 'blueprint'

/**
 * A colour theme for the arena, the bodies and the UI accent. Body colours are
 * stored as indices into `shapes`, so switching theme recolours every live
 * instance and saved scenes stay theme-independent.
 */
export interface Theme {
  id: ThemeId
  label: string
  blurb: string
  background: string
  fogNear: number
  fogFar: number
  floor: string
  floorLine: string
  floorLineStrength: number
  outerGround: string
  outerLine: string
  glass: string
  glassOpacity: number
  edges: string
  edgesOpacity: number
  stars: string
  starsOpacity: number
  hemiSky: string
  hemiGround: string
  hemiIntensity: number
  sunIntensity: number
  rim: string
  /** Shape self-glow and fresnel rim strength. */
  shapeGlow: number
  shapeRim: number
  shapeRoughness: number
  /** Eight shape colours; spawns cycle through them. */
  shapes: readonly string[]
  /** UI accent colours (drive the Tailwind `neon` tokens). */
  accent: string
  accentSoft: string
}

export const THEMES: Record<ThemeId, Theme> = {
  industrial: {
    id: 'industrial',
    label: 'Industrial',
    blurb: 'Charcoal, hazard yellow, safety orange, concrete',
    background: '#15171a',
    fogNear: 24,
    fogFar: 62,
    floor: '#4a4c50',
    floorLine: '#f5b800',
    floorLineStrength: 0.55,
    outerGround: '#1b1d20',
    outerLine: '#5b5340',
    glass: '#ffd24a',
    glassOpacity: 0.025,
    edges: '#f5b800',
    edgesOpacity: 0.6,
    stars: '#8a8a80',
    starsOpacity: 0.25,
    hemiSky: '#e9e4d8',
    hemiGround: '#1c1b19',
    hemiIntensity: 1.25,
    sunIntensity: 2.5,
    rim: '#ffb35c',
    shapeGlow: 0.04,
    shapeRim: 0.22,
    shapeRoughness: 0.62,
    shapes: ['#f5c400', '#ff6a13', '#9ea3a8', '#4f6d8a', '#d94e1f', '#e8e2d0', '#6f7378', '#c79a3b'],
    accent: '#ffc21a',
    accentSoft: '#ffe28a',
  },
  neon: {
    id: 'neon',
    label: 'Neon Synth',
    blurb: 'Dark violet, hot pink, cyan, electric lime',
    background: '#0b0418',
    fogNear: 22,
    fogFar: 58,
    floor: '#231040',
    floorLine: '#ff2bd6',
    floorLineStrength: 0.85,
    outerGround: '#0d0520',
    outerLine: '#7a1fa8',
    glass: '#2de2ff',
    glassOpacity: 0.035,
    edges: '#2de2ff',
    edgesOpacity: 0.7,
    stars: '#d7a8ff',
    starsOpacity: 0.6,
    hemiSky: '#c9a6ff',
    hemiGround: '#14062a',
    hemiIntensity: 1.1,
    sunIntensity: 2.2,
    rim: '#ff4fd8',
    shapeGlow: 0.2,
    shapeRim: 0.65,
    shapeRoughness: 0.32,
    shapes: ['#ff2bd6', '#2de2ff', '#b6ff2e', '#9b5cff', '#ff7a2f', '#ffe14d', '#3dffb1', '#ff4f7a'],
    accent: '#ff3ddc',
    accentSoft: '#ffa8f0',
  },
  pastel: {
    id: 'pastel',
    label: 'Pastel Clay',
    blurb: 'Terracotta, sage, muted peach, soft sky blue',
    background: '#efe5d8',
    fogNear: 26,
    fogFar: 70,
    floor: '#e6d5c2',
    floorLine: '#c8735a',
    floorLineStrength: 0.35,
    outerGround: '#e9dccb',
    outerLine: '#d9b8a0',
    glass: '#ffffff',
    glassOpacity: 0.05,
    edges: '#c8735a',
    edgesOpacity: 0.55,
    stars: '#ffffff',
    starsOpacity: 0,
    hemiSky: '#fff6ea',
    hemiGround: '#a89580',
    hemiIntensity: 1.5,
    sunIntensity: 2.1,
    rim: '#ffd8c0',
    shapeGlow: 0,
    shapeRim: 0.12,
    shapeRoughness: 0.85,
    shapes: ['#d9785d', '#9cb59a', '#f2b49b', '#9ec5e0', '#f1d58a', '#b9a7d6', '#c9a27e', '#e8a0a8'],
    accent: '#e07a5f',
    accentSoft: '#f4c3b2',
  },
  blueprint: {
    id: 'blueprint',
    label: 'Blueprint',
    blurb: 'Navy paper, white grid, wireframe shades',
    background: '#0b2545',
    fogNear: 26,
    fogFar: 66,
    floor: '#123563',
    floorLine: '#ffffff',
    floorLineStrength: 0.7,
    outerGround: '#0d2a50',
    outerLine: '#4d7bb5',
    glass: '#ffffff',
    glassOpacity: 0.03,
    edges: '#ffffff',
    edgesOpacity: 0.8,
    stars: '#cfe0ff',
    starsOpacity: 0.3,
    hemiSky: '#dbe9ff',
    hemiGround: '#0b2545',
    hemiIntensity: 1.2,
    sunIntensity: 2.0,
    rim: '#ffffff',
    shapeGlow: 0.08,
    shapeRim: 1.1,
    shapeRoughness: 0.55,
    shapes: ['#ffffff', '#cfe3ff', '#9cc3ff', '#6fa4ef', '#e8f1ff', '#b4cff5', '#86b0e8', '#dde9fb'],
    accent: '#9cc3ff',
    accentSoft: '#e1edff',
  },
}

export const THEME_ORDER: readonly ThemeId[] = ['industrial', 'neon', 'pastel', 'blueprint']
export const DEFAULT_THEME: ThemeId = 'industrial'

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && v in THEMES
}

/** Spawn colour cycle: stride 3 through 8 colours, so neighbours differ. */
let cursor = 0
export function nextColorIndex(): number {
  const i = (cursor * 3) % 8
  cursor++
  return i
}
export function peekColorIndex(): number {
  return (cursor * 3) % 8
}
