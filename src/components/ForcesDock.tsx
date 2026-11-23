import {
  ArrowUpFromLine,
  ChevronDown,
  CircleOff,
  Disc3,
  Earth,
  Hammer,
  Moon,
  Mountain,
  Radiation,
  Rocket,
  RotateCcw,
  ShieldCheck,
  Vibrate,
  VibrateOff,
  type LucideIcon,
} from 'lucide-react'
import { useRef, type CSSProperties, type Ref } from 'react'
import { GRAVITY_PRESETS, type GravityId, type SingularityType } from '../engine/constants'
import { TapButton } from './TapButton'

interface Props {
  open: boolean
  onClose: () => void
  gravity: GravityId
  onGravity: (id: GravityId) => void
  restitution: number
  onRestitution: (value: number) => void
  friction: number
  onFriction: (value: number) => void
  hapticsOn: boolean
  hapticsSupported: boolean
  onHaptics: (on: boolean) => void
  onResetCamera: () => void
  singularity: SingularityType | null
  singularityPlaced: boolean
  onSingularity: (type: SingularityType | null) => void
  destructible: boolean
  onDestructible: (on: boolean) => void
  bottom: string
  sectionRef?: Ref<HTMLElement>
}

const SINGULARITY_OPTIONS: { id: SingularityType | null; label: string; Icon: LucideIcon; accent: string }[] = [
  { id: null, label: 'None', Icon: CircleOff, accent: 'neon' },
  { id: 'blackhole', label: 'Black hole', Icon: Disc3, accent: 'violet' },
  { id: 'repulsor', label: 'Repulsor', Icon: Radiation, accent: 'neon' },
]

const GRAVITY_ICONS: Record<GravityId, LucideIcon> = {
  earth: Earth,
  moon: Moon,
  mars: Mountain,
  zero: Rocket,
  inverted: ArrowUpFromLine,
}

function formatG(value: number): string {
  if (value === 0) return '0.00'
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`
}

interface SliderProps {
  id: string
  label: string
  value: number
  onChange: (v: number) => void
  minLabel: string
  maxLabel: string
  accent: string
}

function NeonSlider({ id, label, value, onChange, minLabel, maxLabel, accent }: SliderProps) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="hud-label">
          {label}
        </label>
        <span className="font-mono text-sm font-semibold tabular-nums" style={{ color: accent }}>
          {value.toFixed(2)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="neon-range"
        style={{ '--fill': `${value * 100}%`, '--accent': accent } as CSSProperties}
      />
      <div className="-mt-1 flex justify-between text-[10px] font-semibold tracking-[0.12em] text-ink-dim uppercase">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
    </div>
  )
}

/**
 * Slide-up "Forces" drawer: gravity presets, singularities, destructibility and
 * material tuning. It deliberately has no backdrop: the arena stays live and
 * touchable while values are adjusted, so changes can be watched as they apply.
 */
export function ForcesDock(props: Props) {
  const {
    open,
    onClose,
    gravity,
    onGravity,
    restitution,
    onRestitution,
    friction,
    onFriction,
    hapticsOn,
    hapticsSupported,
    onHaptics,
    onResetCamera,
    singularity,
    singularityPlaced,
    onSingularity,
    destructible,
    onDestructible,
    bottom,
    sectionRef,
  } = props
  const current = GRAVITY_PRESETS.find((p) => p.id === gravity) ?? GRAVITY_PRESETS[0]

  // Swipe the header down to dismiss.
  const swipe = useRef<{ id: number; y: number } | null>(null)

  return (
    <section
      ref={sectionRef}
      id="forces-dock"
      aria-label="Forces and environment"
      aria-hidden={!open}
      inert={!open}
      className={`hud-panel absolute inset-x-3 z-30 flex flex-col sm:left-auto sm:w-[400px] overflow-hidden rounded-[22px] transition-[transform,opacity] duration-250 ease-out ${
        open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-[calc(100%+24px)] opacity-0'
      }`}
      style={{
        bottom,
        maxHeight: `calc(100dvh - ${bottom} - max(env(safe-area-inset-top), 10px) - 76px)`,
      }}
    >
      <div
        className="flex shrink-0 touch-none items-center gap-3 px-4 pt-1.5"
        onPointerDown={(e) => {
          swipe.current = { id: e.pointerId, y: e.clientY }
        }}
        onPointerMove={(e) => {
          if (swipe.current?.id === e.pointerId && e.clientY - swipe.current.y > 42) {
            swipe.current = null
            onClose()
          }
        }}
        onPointerUp={() => (swipe.current = null)}
        onPointerCancel={() => (swipe.current = null)}
      >
        <div className="flex-1">
          <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-ink-dim/40" />
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold tracking-[0.22em] text-ink uppercase">Forces</h2>
            <TapButton
              onTap={onClose}
              aria-label="Close forces settings"
              className="-mr-2 grid size-10 place-items-center rounded-xl text-ink-dim active:scale-95 active:text-neon"
            >
              <ChevronDown className="size-5" />
            </TapButton>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3.5" style={{ touchAction: 'pan-y' }}>
        {/* Gravity */}
        <div className="flex items-baseline justify-between">
          <span className="hud-label">Gravity</span>
          <span className="font-mono text-xs text-ink-dim">
            g = <span className="font-semibold text-neon">{formatG(current.value)}</span> m/s²
          </span>
        </div>
        <div role="radiogroup" aria-label="Gravity preset" className="mt-2 grid grid-cols-5 gap-1.5">
          {GRAVITY_PRESETS.map((preset) => {
            const Icon = GRAVITY_ICONS[preset.id]
            const active = preset.id === gravity
            return (
              <TapButton
                key={preset.id}
                role="radio"
                aria-checked={active}
                onTap={() => onGravity(preset.id)}
                className={`flex h-[64px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl border px-0.5 transition-colors active:scale-95 ${
                  active
                    ? 'border-neon/60 bg-neon/15 text-neon shadow-[0_0_18px_-6px_rgb(56_225_255/0.8)]'
                    : 'border-white/6 bg-panel-2/70 text-ink'
                }`}
              >
                <Icon className="size-5" strokeWidth={1.8} />
                <span className="w-full truncate text-center text-[10px] font-bold tracking-[0.02em] uppercase">
                  {preset.label}
                </span>
                <span className={`font-mono text-[10px] tabular-nums ${active ? 'text-neon' : 'text-ink-dim'}`}>
                  {formatG(preset.value)}
                </span>
              </TapButton>
            )
          })}
        </div>

        {/* Singularity */}
        <div className="mt-3.5 flex items-baseline justify-between gap-2">
          <span className="hud-label">Singularity</span>
          <span className="truncate text-[11px] text-ink-dim">
            {singularity
              ? singularityPlaced
                ? 'Drag the core to move · tap it to dismiss'
                : 'Tap the arena to place it'
              : 'One at a time'}
          </span>
        </div>
        <div role="radiogroup" aria-label="Singularity" className="mt-2 grid grid-cols-3 gap-1.5">
          {SINGULARITY_OPTIONS.map(({ id, label, Icon, accent }) => {
            const active = singularity === id
            const on =
              accent === 'violet'
                ? 'border-[#b48bff]/70 bg-[#b48bff]/15 text-[#cdb4ff] shadow-[0_0_18px_-6px_rgb(180_139_255/0.9)]'
                : 'border-neon/60 bg-neon/15 text-neon shadow-[0_0_18px_-6px_rgb(56_225_255/0.8)]'
            return (
              <TapButton
                key={label}
                role="radio"
                aria-checked={active}
                onTap={() => onSingularity(id)}
                className={`flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-1 text-[10px] font-bold tracking-[0.06em] uppercase transition-colors active:scale-95 ${
                  active ? on : 'border-white/6 bg-panel-2/70 text-ink'
                }`}
              >
                <Icon className="size-[18px] shrink-0" strokeWidth={1.9} />
                <span className="max-w-full truncate">{label}</span>
              </TapButton>
            )
          })}
        </div>

        {/* Materials */}
        <div className="mt-3.5 space-y-1.5">
          <NeonSlider
            id="restitution"
            label="Restitution · bounciness"
            value={restitution}
            onChange={onRestitution}
            minLabel="Dead thud"
            maxLabel="Superball"
            accent="#ff5ad8"
          />
          <NeonSlider
            id="friction"
            label="Friction"
            value={friction}
            onChange={onFriction}
            minLabel="Ice glide"
            maxLabel="High grip"
            accent="#38e1ff"
          />
        </div>

        {/* Toggles */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <TapButton
            role="switch"
            aria-checked={destructible}
            aria-label="Destructible objects"
            onTap={() => onDestructible(!destructible)}
            className={`flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border px-1 text-[11px] font-bold tracking-[0.04em] uppercase transition-colors active:scale-95 ${
              destructible ? 'border-amber/50 bg-amber/10 text-amber' : 'border-white/6 bg-panel-2/70 text-ink-dim'
            }`}
          >
            {destructible ? <Hammer className="size-4 shrink-0" /> : <ShieldCheck className="size-4 shrink-0" />}
            <span className="truncate">{destructible ? 'Destructible on' : 'Destructible off'}</span>
          </TapButton>
          <TapButton
            role="switch"
            aria-checked={hapticsOn && hapticsSupported}
            disabled={!hapticsSupported}
            onTap={() => onHaptics(!hapticsOn)}
            className={`flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border px-1 text-[11px] font-bold tracking-[0.04em] uppercase transition-colors active:scale-95 disabled:opacity-45 ${
              hapticsOn && hapticsSupported
                ? 'border-lime/45 bg-lime/10 text-lime'
                : 'border-white/6 bg-panel-2/70 text-ink-dim'
            }`}
          >
            {hapticsOn && hapticsSupported ? <Vibrate className="size-4" /> : <VibrateOff className="size-4" />}
            {hapticsSupported ? `Haptics ${hapticsOn ? 'on' : 'off'}` : 'No haptics'}
          </TapButton>
          <TapButton
            onTap={onResetCamera}
            className="col-span-2 flex h-11 items-center justify-center gap-2 rounded-xl border border-white/6 bg-panel-2/70 text-xs font-bold tracking-[0.12em] text-ink uppercase active:scale-95"
          >
            <RotateCcw className="size-4" /> Reset view
          </TapButton>
        </div>
      </div>
    </section>
  )
}
