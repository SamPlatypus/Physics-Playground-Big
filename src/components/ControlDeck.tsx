import { Bomb, Box, Circle, Cylinder, Hand, Rotate3d, Slice, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { InteractionMode, ShapeKind } from '../engine/constants'
import { TapButton } from './TapButton'

interface Props {
  mode: InteractionMode
  onMode: (mode: InteractionMode) => void
  onSpawn: (kind: ShapeKind) => void
  nextColor: string
  dockOpen: boolean
  onToggleDock: () => void
  gravityLabel: string
}

const MODES: { id: InteractionMode; label: string; Icon: LucideIcon; active: string }[] = [
  {
    id: 'interact',
    label: 'Grab',
    Icon: Hand,
    active: 'bg-neon/18 text-neon shadow-[inset_0_0_0_1px_rgb(56_225_255/0.55),0_0_16px_-4px_rgb(56_225_255/0.7)]',
  },
  {
    id: 'camera',
    label: 'Camera',
    Icon: Rotate3d,
    active: 'bg-neon/18 text-neon shadow-[inset_0_0_0_1px_rgb(56_225_255/0.55),0_0_16px_-4px_rgb(56_225_255/0.7)]',
  },
  {
    id: 'slice',
    label: 'Slice',
    Icon: Slice,
    active: 'bg-plasma/18 text-plasma shadow-[inset_0_0_0_1px_rgb(255_90_216/0.6),0_0_16px_-4px_rgb(255_90_216/0.8)]',
  },
]

const SHAPES: { kind: ShapeKind; label: string; Icon: LucideIcon }[] = [
  { kind: 'cube', label: 'Cube', Icon: Box },
  { kind: 'sphere', label: 'Sphere', Icon: Circle },
  { kind: 'cylinder', label: 'Cylinder', Icon: Cylinder },
  { kind: 'nitro', label: 'Nitro', Icon: Bomb },
]

const HOLD_DELAY_MS = 380
const HOLD_INTERVAL_MS = 110

/**
 * Bottom control deck, two thumb-height rows:
 *   1. touch tool (Grab / Camera / Slice) + the Forces dock toggle
 *   2. quick spawner (Cube / Sphere / Cylinder / Nitro) — tap for one, hold to keep spawning
 */
export function ControlDeck({ mode, onMode, onSpawn, nextColor, dockOpen, onToggleDock, gravityLabel }: Props) {
  const holdTimer = useRef<number | undefined>(undefined)
  const repeatTimer = useRef<number | undefined>(undefined)

  const stopHold = () => {
    window.clearTimeout(holdTimer.current)
    window.clearInterval(repeatTimer.current)
    holdTimer.current = undefined
    repeatTimer.current = undefined
  }
  useEffect(() => stopHold, [])

  const startHold = (kind: ShapeKind) => {
    stopHold()
    onSpawn(kind)
    holdTimer.current = window.setTimeout(() => {
      repeatTimer.current = window.setInterval(() => onSpawn(kind), HOLD_INTERVAL_MS)
    }, HOLD_DELAY_MS)
  }

  return (
    <nav
      aria-label="Tools and spawner"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-3"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}
    >
      {/* Two rows on phones; one strip on short landscape screens. */}
      <div className="hud-panel pointer-events-auto flex flex-col gap-1.5 rounded-[20px] p-1.5 [@media(max-height:500px)]:flex-row">
        {/* Row 1: touch tool + forces */}
        <div className="flex gap-1.5 [@media(max-height:500px)]:flex-1">
          <div
            role="radiogroup"
            aria-label="Touch tool"
            className="flex flex-1 gap-1 rounded-2xl border border-white/5 bg-panel-2/70 p-1"
          >
            {MODES.map(({ id, label, Icon, active }) => {
              const on = mode === id
              return (
                <TapButton
                  key={id}
                  role="radio"
                  aria-checked={on}
                  onTap={() => onMode(id)}
                  className={`flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl text-[11px] font-bold tracking-[0.1em] uppercase transition-colors active:scale-95 ${
                    on ? active : 'text-ink-dim'
                  }`}
                >
                  <Icon className="size-4 shrink-0" strokeWidth={on ? 2.3 : 1.9} />
                  <span className="truncate">{label}</span>
                </TapButton>
              )
            })}
          </div>
          <TapButton
            onTap={onToggleDock}
            aria-expanded={dockOpen}
            aria-controls="forces-dock"
            aria-label="Forces and environment settings"
            className={`flex h-12 w-[76px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-2xl border transition-colors active:scale-95 ${
              dockOpen ? 'border-neon/50 bg-neon/15 text-neon' : 'border-white/5 bg-panel-2/80 text-ink'
            }`}
          >
            <SlidersHorizontal className="size-4" strokeWidth={1.9} />
            <span className="max-w-full truncate px-1 text-[10px] font-bold tracking-[0.08em] uppercase">
              {gravityLabel}
            </span>
          </TapButton>
        </div>

        {/* Row 2: quick spawner */}
        <div className="flex gap-1.5 [@media(max-height:500px)]:flex-1">
          {SHAPES.map(({ kind, label, Icon }) => {
            const nitro = kind === 'nitro'
            const tint = nitro ? '#ff4a3a' : nextColor
            return (
              <button
                key={kind}
                type="button"
                aria-label={`Spawn ${label}`}
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse' && e.button !== 0) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  startHold(kind)
                }}
                onPointerUp={stopHold}
                onPointerCancel={stopHold}
                onLostPointerCapture={stopHold}
                onClick={(e) => {
                  // Keyboard activation (detail 0); pointer presses already spawned on down.
                  if (e.detail === 0) onSpawn(kind)
                }}
                onContextMenu={(e) => e.preventDefault()}
                className={`relative flex h-[60px] min-w-0 flex-1 flex-col [@media(max-height:500px)]:h-12 items-center justify-center gap-1 overflow-hidden rounded-2xl border bg-panel-2/80 transition-[transform,background-color] duration-75 active:scale-[0.94] ${
                  nitro ? 'border-amber/25 active:bg-danger/15' : 'border-white/5 active:bg-neon/12'
                }`}
              >
                {nitro && <span aria-hidden className="hazard-stripes absolute inset-x-0 top-0 h-1.5 opacity-80" />}
                <Icon
                  className="size-[22px] transition-colors"
                  strokeWidth={1.8}
                  style={{ color: tint, filter: `drop-shadow(0 0 6px ${tint})` }}
                />
                <span className="max-w-full truncate px-0.5 text-[10px] font-bold tracking-[0.06em] text-ink uppercase">
                  {label}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
