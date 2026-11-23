import { Atom, Check, Gem, Recycle, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { TapButton } from './TapButton'

interface Props {
  fps: number
  bodies: number
  debris: number
  max: number
  onClear: () => void
}

function fpsTone(fps: number): string {
  if (fps >= 55) return 'text-lime'
  if (fps >= 40) return 'text-amber'
  return 'text-danger'
}

export function Hud({ fps, bodies, debris, max, onClear }: Props) {
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

  return (
    <header
      className="pointer-events-none absolute inset-x-0 top-0 z-20 px-3"
      style={{ paddingTop: 'max(env(safe-area-inset-top), 10px)' }}
    >
      <div className="hud-panel pointer-events-auto flex h-14 items-center gap-2 rounded-2xl pr-1.5 pl-3">
        <div className="flex items-center gap-2 pr-1">
          <Atom className="size-5 text-neon drop-shadow-[0_0_6px_rgb(56_225_255/0.7)]" strokeWidth={1.8} />
          <span className="hidden text-[13px] font-bold tracking-[0.2em] text-ink uppercase min-[480px]:inline">
            Phys<span className="text-neon">Lab</span>
          </span>
        </div>

        <div className="mx-1 h-7 w-px bg-line" />

        <div className="flex min-w-[52px] flex-col leading-none" aria-label={`${fps} frames per second`}>
          <span className="hud-label">FPS</span>
          <span className={`mt-1 font-mono text-[15px] font-semibold tabular-nums ${fpsTone(fps)}`}>
            {fps || '--'}
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col leading-none" aria-label={`${bodies} of ${max} bodies`}>
          <span className="hud-label flex items-center gap-1.5">
            Bodies
            {debris > 0 && (
              <span
                className="flex items-center gap-0.5 font-mono text-[10px] tracking-normal text-plasma"
                aria-label={`${debris} of them debris`}
              >
                <Gem className="size-2.5" strokeWidth={2.4} />
                {debris}
              </span>
            )}
          </span>
          <span className="mt-1 flex items-center gap-1.5 font-mono text-[15px] font-semibold whitespace-nowrap tabular-nums text-ink">
            <span>
              {bodies}
              <span className="text-ink-dim"> / {max}</span>
            </span>
            {atCap && (
              <Recycle
                className="size-3.5 shrink-0 text-amber"
                strokeWidth={2.4}
                aria-label="At capacity: oldest resting bodies are recycled"
              />
            )}
          </span>
          <span className="mt-1.5 block h-[3px] w-full max-w-[120px] overflow-hidden rounded-full bg-ink-dim/20">
            <span
              className={`block h-full rounded-full transition-[width] duration-200 ${
                atCap ? 'bg-amber' : fill > 0.8 ? 'bg-plasma' : 'bg-neon'
              }`}
              style={{ width: `${fill * 100}%` }}
            />
          </span>
        </div>

        <TapButton
          onTap={handleClear}
          aria-label="Clear all bodies"
          className={`flex h-11 shrink-0 items-center gap-1.5 rounded-xl border px-3.5 text-xs font-bold tracking-[0.14em] uppercase transition-colors active:scale-95 ${
            cleared
              ? 'animate-pulse-ring border-lime/60 bg-lime/15 text-lime'
              : 'border-danger/45 bg-danger/10 text-danger'
          }`}
        >
          {cleared ? <Check className="size-4" strokeWidth={2.6} /> : <Trash2 className="size-4" strokeWidth={2} />}
          <span>{cleared ? 'Cleared' : 'Clear'}</span>
        </TapButton>
      </div>
    </header>
  )
}
