import { Box, Circle, Cylinder, SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ShapeKind } from '../engine/constants'

interface Props {
  onSpawn: (kind: ShapeKind) => void
  nextColor: string
  dockOpen: boolean
  onToggleDock: () => void
  gravityLabel: string
}

const SHAPES: { kind: ShapeKind; label: string; Icon: typeof Box }[] = [
  { kind: 'cube', label: 'Cube', Icon: Box },
  { kind: 'sphere', label: 'Sphere', Icon: Circle },
  { kind: 'cylinder', label: 'Cylinder', Icon: Cylinder },
]

const HOLD_DELAY_MS = 380
const HOLD_INTERVAL_MS = 110

/**
 * Thumb-friendly spawner. Tap spawns one; press-and-hold keeps spawning so the
 * arena can be filled quickly (the engine recycles past the body cap).
 */
export function SpawnToolbar({ onSpawn, nextColor, dockOpen, onToggleDock, gravityLabel }: Props) {
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
      aria-label="Spawn shapes"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-3"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}
    >
      <div className="hud-panel pointer-events-auto flex items-stretch gap-1.5 rounded-[20px] p-1.5">
        {SHAPES.map(({ kind, label, Icon }) => (
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
            className="group relative flex h-[66px] flex-1 flex-col items-center justify-center gap-1.5 rounded-2xl border border-white/5 bg-panel-2/80 transition-[transform,background-color] duration-75 active:scale-[0.94] active:bg-neon/12"
          >
            <Icon
              className="size-6 transition-colors"
              strokeWidth={1.8}
              style={{ color: nextColor, filter: `drop-shadow(0 0 6px ${nextColor})` }}
            />
            <span className="text-[11px] font-bold tracking-[0.14em] text-ink uppercase">{label}</span>
          </button>
        ))}

        <div className="my-2 w-px bg-line" />

        <button
          type="button"
          onClick={onToggleDock}
          aria-expanded={dockOpen}
          aria-controls="environment-dock"
          aria-label="Gravity and environment settings"
          className={`flex h-[66px] w-[68px] shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border transition-colors active:scale-[0.94] ${
            dockOpen ? 'border-neon/50 bg-neon/15 text-neon' : 'border-white/5 bg-panel-2/80 text-ink'
          }`}
        >
          <SlidersHorizontal className="size-5" strokeWidth={1.9} />
          <span className="max-w-full truncate px-1 text-[10px] font-bold tracking-[0.1em] uppercase">
            {gravityLabel}
          </span>
        </button>
      </div>
    </nav>
  )
}
