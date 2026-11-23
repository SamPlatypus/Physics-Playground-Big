import { Atom, Check, Gem, Recycle, Snowflake, Trash2, Volume2, VolumeX, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { TapButton } from './TapButton'

interface Props {
  fps: number
  bodies: number
  debris: number
  max: number
  muted: boolean
  onMute: () => void
  frozen: boolean
  onFreeze: () => void
  onClear: () => void
}

function fpsTone(fps: number): string {
  if (fps >= 55) return 'text-lime'
  if (fps >= 40) return 'text-amber'
  return 'text-danger'
}

interface IconButtonProps {
  label: string
  onTap: () => void
  pressed?: boolean
  tone?: 'neutral' | 'danger' | 'ok' | 'ice'
  children: ReactNode
}

/**
 * 32 px HUD icon button. The visible chip stays compact so the HUD fits one row
 * on 360 px screens; a transparent ::before extends the touch target to 44 px.
 */
function HudIconButton({ label, onTap, pressed, tone = 'neutral', children }: IconButtonProps) {
  const tones = {
    neutral: pressed ? 'border-neon/60 bg-neon/15 text-neon' : 'border-white/10 bg-panel-2/80 text-ink',
    danger: 'border-danger/45 bg-danger/10 text-danger',
    ok: 'animate-pulse-ring border-lime/60 bg-lime/15 text-lime',
    ice: pressed
      ? 'border-[#9fe8ff]/70 bg-[#9fe8ff]/20 text-[#c8f3ff] shadow-[0_0_14px_-2px_rgb(159_232_255/0.8)]'
      : 'border-white/10 bg-panel-2/80 text-ink',
  }
  return (
    <TapButton
      onTap={onTap}
      aria-label={label}
      aria-pressed={pressed}
      className={`relative grid size-8 shrink-0 place-items-center rounded-lg border transition-colors before:absolute before:-inset-1.5 before:content-[''] active:scale-90 ${tones[tone]}`}
    >
      {children}
    </TapButton>
  )
}

/**
 * Single-row HUD (never wraps, even at 360 px or on a short landscape screen):
 * a compact `FPS • count/150` badge on the left, Mute / Freeze / Clear on the right.
 */
export function Hud({ fps, bodies, debris, max, muted, onMute, frozen, onFreeze, onClear }: Props) {
  const [cleared, setCleared] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const handleClear = () => {
    onClear()
    setCleared(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCleared(false), 1100)
  }

  const fill = Math.min(1, bodies / max)
  const atCap = bodies >= max
  const MuteIcon: LucideIcon = muted ? VolumeX : Volume2

  return (
    <header
      className="pointer-events-none absolute inset-x-0 top-0 z-20 px-3"
      style={{ paddingTop: 'max(env(safe-area-inset-top), 10px)' }}
    >
      <div className="hud-panel pointer-events-auto relative flex h-12 flex-nowrap items-center gap-2 overflow-hidden rounded-2xl pr-2 pl-2.5 whitespace-nowrap">
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden font-mono text-xs font-semibold tabular-nums"
          aria-label={`${fps} frames per second, ${bodies} of ${max} bodies`}
        >
          <Atom className="size-4 shrink-0 text-neon" strokeWidth={1.9} />
          <span className={fpsTone(fps)}>{fps || '--'}</span>
          <span className="text-[10px] tracking-wider text-ink-dim">FPS</span>
          <span className="text-ink-dim">•</span>
          <span className="text-ink">
            {bodies}
            <span className="text-ink-dim">/{max}</span>
          </span>
          {debris > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-plasma" aria-label={`${debris} of them debris`}>
              <Gem className="size-2.5" strokeWidth={2.4} />
              {debris}
            </span>
          )}
          {atCap && (
            <Recycle
              className="size-3.5 shrink-0 text-amber"
              strokeWidth={2.4}
              aria-label="At capacity: oldest resting bodies are recycled"
            />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <HudIconButton label="Mute sound" pressed={muted} onTap={onMute}>
            <MuteIcon className="size-4" strokeWidth={2} />
          </HudIconButton>
          <HudIconButton label="Freeze physics" pressed={frozen} tone="ice" onTap={onFreeze}>
            <Snowflake className="size-4" strokeWidth={2} />
          </HudIconButton>
          <HudIconButton label="Clear all bodies" tone={cleared ? 'ok' : 'danger'} onTap={handleClear}>
            {cleared ? <Check className="size-4" strokeWidth={2.6} /> : <Trash2 className="size-4" strokeWidth={2} />}
            <span className="sr-only">{cleared ? 'Cleared' : 'Clear'}</span>
          </HudIconButton>
        </div>

        <span className="pointer-events-none absolute inset-x-3 bottom-0 h-[2px] overflow-hidden rounded-full bg-ink-dim/15">
          <span
            className={`block h-full transition-[width] duration-200 ${atCap ? 'bg-amber' : fill > 0.8 ? 'bg-plasma' : 'bg-neon'}`}
            style={{ width: `${fill * 100}%` }}
          />
        </span>
      </div>
    </header>
  )
}
