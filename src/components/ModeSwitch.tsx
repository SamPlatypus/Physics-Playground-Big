import { Hand, Rotate3d } from 'lucide-react'
import type { InteractionMode } from '../engine/constants'

interface Props {
  mode: InteractionMode
  onChange: (mode: InteractionMode) => void
  hidden: boolean
  bottom: string
}

const OPTIONS: { id: InteractionMode; label: string; Icon: typeof Hand }[] = [
  { id: 'interact', label: 'Grab', Icon: Hand },
  { id: 'camera', label: 'Orbit', Icon: Rotate3d },
]

/** Floating thumb-reach toggle between grabbing bodies and orbiting the camera. */
export function ModeSwitch({ mode, onChange, hidden, bottom }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Touch mode"
      className={`hud-panel absolute right-3 z-20 flex flex-col gap-1 rounded-2xl p-1 transition-all duration-200 ${
        hidden ? 'pointer-events-none translate-x-3 opacity-0' : 'opacity-100'
      }`}
      style={{ bottom }}
    >
      {OPTIONS.map(({ id, label, Icon }) => {
        const active = mode === id
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(id)}
            className={`flex size-[54px] flex-col items-center justify-center gap-1 rounded-xl transition-colors active:scale-95 ${
              active
                ? 'bg-neon/18 text-neon shadow-[inset_0_0_0_1px_rgb(56_225_255/0.55),0_0_18px_-4px_rgb(56_225_255/0.7)]'
                : 'text-ink-dim'
            }`}
          >
            <Icon className="size-5" strokeWidth={active ? 2.2 : 1.8} />
            <span className="text-[9px] font-bold tracking-[0.16em] uppercase">{label}</span>
          </button>
        )
      })}
    </div>
  )
}
