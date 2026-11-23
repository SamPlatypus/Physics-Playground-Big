import {
  Activity,
  ArrowUpFromLine,
  Camera,
  ChevronDown,
  CircleOff,
  Disc3,
  Download,
  Earth,
  Hammer,
  Moon,
  Mountain,
  Radiation,
  Rocket,
  RotateCcw,
  Save,
  ShieldCheck,
  Upload,
  Vibrate,
  VibrateOff,
  type LucideIcon,
} from 'lucide-react'
import { useRef, type CSSProperties, type ReactNode, type Ref } from 'react'
import { GRAVITY_PRESETS, type GravityId, type SingularityType } from '../engine/constants'
import { THEMES, THEME_ORDER, type ThemeId } from '../engine/themes'
import type { DrawerTab } from './ControlDeck'
import { TapButton } from './TapButton'

export interface SlotMeta {
  slot: number
  count: number
  savedAt: number
}

interface Props {
  tab: DrawerTab | null
  onTab: (tab: DrawerTab) => void
  onClose: () => void
  bottom: string
  sectionRef?: Ref<HTMLElement>
  // Forces
  gravity: GravityId
  onGravity: (id: GravityId) => void
  singularity: SingularityType | null
  singularityPlaced: boolean
  onSingularity: (type: SingularityType | null) => void
  destructible: boolean
  onDestructible: (on: boolean) => void
  onTremor: () => void
  tremorActive: boolean
  frozen: boolean
  // Environment
  theme: ThemeId
  onTheme: (id: ThemeId) => void
  restitution: number
  onRestitution: (value: number) => void
  friction: number
  onFriction: (value: number) => void
  // Tools
  slots: (SlotMeta | null)[]
  onSave: (slot: number) => void
  onLoad: (slot: number) => void
  onPhoto: () => void
  hapticsOn: boolean
  hapticsSupported: boolean
  onHaptics: (on: boolean) => void
  onResetCamera: () => void
}

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'forces', label: 'Forces' },
  { id: 'environment', label: 'Environment' },
  { id: 'tools', label: 'Tools' },
]

const SINGULARITY_OPTIONS: { id: SingularityType | null; label: string; Icon: LucideIcon; violet?: boolean }[] = [
  { id: null, label: 'None', Icon: CircleOff },
  { id: 'blackhole', label: 'Black hole', Icon: Disc3, violet: true },
  { id: 'repulsor', label: 'Repulsor', Icon: Radiation },
]

const GRAVITY_ICONS: Record<GravityId, LucideIcon> = {
  earth: Earth,
  moon: Moon,
  mars: Mountain,
  zero: Rocket,
  inverted: ArrowUpFromLine,
}

const ACTIVE = 'border-neon/60 bg-neon/15 text-neon shadow-[0_0_18px_-6px_var(--color-neon)]'
const IDLE = 'border-white/6 bg-panel-2/70 text-ink'

function formatG(value: number): string {
  if (value === 0) return '0.00'
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`
}

function SectionHeader({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="hud-label">{title}</span>
      {aside && <span className="truncate text-[11px] text-ink-dim">{aside}</span>}
    </div>
  )
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

function formatTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

// ---------------------------------------------------------------------------

function ForcesPanel(p: Props) {
  const current = GRAVITY_PRESETS.find((g) => g.id === p.gravity) ?? GRAVITY_PRESETS[0]
  return (
    <>
      <SectionHeader
        title="Gravity"
        aside={
          <span className="font-mono">
            g = <span className="font-semibold text-neon">{formatG(current.value)}</span> m/s²
          </span>
        }
      />
      <div role="radiogroup" aria-label="Gravity preset" className="mt-2 grid grid-cols-5 gap-1.5">
        {GRAVITY_PRESETS.map((preset) => {
          const Icon = GRAVITY_ICONS[preset.id]
          const active = preset.id === p.gravity
          return (
            <TapButton
              key={preset.id}
              role="radio"
              aria-checked={active}
              onTap={() => p.onGravity(preset.id)}
              className={`flex h-16 min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl border px-0.5 transition-colors active:scale-95 ${active ? ACTIVE : IDLE}`}
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

      <div className="mt-3.5">
        <SectionHeader
          title="Singularity"
          aside={
            p.singularity
              ? p.singularityPlaced
                ? 'Drag the core to move · tap it to dismiss'
                : 'Tap the arena to place it'
              : 'One at a time'
          }
        />
      </div>
      <div role="radiogroup" aria-label="Singularity" className="mt-2 grid grid-cols-3 gap-1.5">
        {SINGULARITY_OPTIONS.map(({ id, label, Icon, violet }) => {
          const active = p.singularity === id
          const on = violet
            ? 'border-[#b48bff]/70 bg-[#b48bff]/15 text-[#cdb4ff] shadow-[0_0_18px_-6px_rgb(180_139_255/0.9)]'
            : ACTIVE
          return (
            <TapButton
              key={label}
              role="radio"
              aria-checked={active}
              onTap={() => p.onSingularity(id)}
              className={`flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-1 text-[10px] font-bold tracking-[0.06em] uppercase transition-colors active:scale-95 ${active ? on : IDLE}`}
            >
              <Icon className="size-[18px] shrink-0" strokeWidth={1.9} />
              <span className="max-w-full truncate">{label}</span>
            </TapButton>
          )
        })}
      </div>

      <div className="mt-3.5">
        <SectionHeader title="Ground" aside={p.frozen ? 'Unfreeze to quake' : 'Or shake your phone'} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <TapButton
          onTap={p.onTremor}
          disabled={p.frozen || p.tremorActive}
          aria-label="Tremor"
          className={`flex h-12 min-w-0 items-center justify-center gap-1.5 rounded-xl border px-1 text-[11px] font-bold tracking-[0.06em] uppercase transition-colors active:scale-95 disabled:opacity-50 ${
            p.tremorActive ? 'border-amber/60 bg-amber/15 text-amber' : IDLE
          }`}
        >
          <Activity className="size-4 shrink-0" />
          <span className="truncate">{p.tremorActive ? 'Quaking…' : 'Tremor'}</span>
        </TapButton>
        <TapButton
          role="switch"
          aria-checked={p.destructible}
          aria-label="Destructible objects"
          onTap={() => p.onDestructible(!p.destructible)}
          className={`flex h-12 min-w-0 items-center justify-center gap-1.5 rounded-xl border px-1 text-[11px] font-bold tracking-[0.04em] uppercase transition-colors active:scale-95 ${
            p.destructible ? 'border-amber/50 bg-amber/10 text-amber' : 'border-white/6 bg-panel-2/70 text-ink-dim'
          }`}
        >
          {p.destructible ? <Hammer className="size-4 shrink-0" /> : <ShieldCheck className="size-4 shrink-0" />}
          <span className="truncate">{p.destructible ? 'Destructible on' : 'Destructible off'}</span>
        </TapButton>
      </div>
    </>
  )
}

function EnvironmentPanel(p: Props) {
  return (
    <>
      <SectionHeader title="Theme" aside={THEMES[p.theme].blurb} />
      <div role="radiogroup" aria-label="Colour theme" className="mt-2 grid grid-cols-2 gap-2">
        {THEME_ORDER.map((id) => {
          const t = THEMES[id]
          const active = p.theme === id
          return (
            <TapButton
              key={id}
              role="radio"
              aria-checked={active}
              aria-label={`${t.label} theme`}
              onTap={() => p.onTheme(id)}
              className={`flex h-16 min-w-0 items-center gap-2.5 rounded-xl border px-2.5 text-left transition-colors active:scale-[0.97] ${active ? ACTIVE : IDLE}`}
            >
              <span
                aria-hidden
                className="grid size-10 shrink-0 grid-cols-2 gap-0.5 overflow-hidden rounded-lg border border-white/10 p-0.5"
                style={{ background: t.background }}
              >
                {t.shapes.slice(0, 4).map((c) => (
                  <span key={c} className="rounded-[3px]" style={{ background: c }} />
                ))}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-bold tracking-[0.06em] uppercase">{t.label}</span>
                <span className="block truncate text-[10px] text-ink-dim">{t.shapes.length} colours</span>
              </span>
            </TapButton>
          )
        })}
      </div>

      <div className="mt-3.5 space-y-1.5">
        <NeonSlider
          id="restitution"
          label="Restitution · bounciness"
          value={p.restitution}
          onChange={p.onRestitution}
          minLabel="Dead thud"
          maxLabel="Superball"
          accent="#ff5ad8"
        />
        <NeonSlider
          id="friction"
          label="Friction"
          value={p.friction}
          onChange={p.onFriction}
          minLabel="Ice glide"
          maxLabel="High grip"
          accent="#38e1ff"
        />
      </div>
    </>
  )
}

function ToolsPanel(p: Props) {
  return (
    <>
      <TapButton
        onTap={p.onPhoto}
        aria-label="Take snapshot"
        className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-neon/45 bg-neon/12 text-xs font-bold tracking-[0.12em] text-neon uppercase active:scale-[0.98]"
      >
        <Camera className="size-4" /> Snapshot
      </TapButton>

      <div className="mt-3.5">
        <SectionHeader title="Saved scenes" aside="Debris isn't saved · loads frozen" />
      </div>
      <ul className="mt-2 space-y-1.5">
        {p.slots.map((meta, i) => {
          const slot = i + 1
          return (
            <li key={slot} className="flex min-h-12 items-center gap-2 rounded-xl border border-white/6 bg-panel-2/60 py-1 pr-1 pl-3">
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-xs font-bold tracking-[0.08em] text-ink uppercase">Slot {slot}</div>
                <div className="truncate font-mono text-[10px] text-ink-dim" data-testid={`slot-${slot}-meta`}>
                  {meta ? `${meta.count} shapes · ${formatTime(meta.savedAt)}` : 'Empty'}
                </div>
              </div>
              <TapButton
                onTap={() => p.onSave(slot)}
                aria-label={`Save to slot ${slot}`}
                className="flex h-11 min-w-[64px] items-center justify-center gap-1 rounded-lg border border-white/10 bg-panel/80 px-2 text-[11px] font-bold tracking-[0.06em] text-ink uppercase active:scale-95"
              >
                <Save className="size-3.5" /> Save
              </TapButton>
              <TapButton
                onTap={() => p.onLoad(slot)}
                disabled={!meta}
                aria-label={`Load slot ${slot}`}
                className="flex h-11 min-w-[64px] items-center justify-center gap-1 rounded-lg border border-neon/35 bg-neon/10 px-2 text-[11px] font-bold tracking-[0.06em] text-neon uppercase active:scale-95 disabled:border-white/6 disabled:bg-transparent disabled:text-ink-dim/60"
              >
                <Upload className="size-3.5" /> Load
              </TapButton>
            </li>
          )
        })}
      </ul>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <TapButton
          role="switch"
          aria-checked={p.hapticsOn && p.hapticsSupported}
          disabled={!p.hapticsSupported}
          onTap={() => p.onHaptics(!p.hapticsOn)}
          className={`flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border px-1 text-[11px] font-bold tracking-[0.04em] uppercase transition-colors active:scale-95 disabled:opacity-45 ${
            p.hapticsOn && p.hapticsSupported ? 'border-lime/45 bg-lime/10 text-lime' : 'border-white/6 bg-panel-2/70 text-ink-dim'
          }`}
        >
          {p.hapticsOn && p.hapticsSupported ? <Vibrate className="size-4" /> : <VibrateOff className="size-4" />}
          {p.hapticsSupported ? `Haptics ${p.hapticsOn ? 'on' : 'off'}` : 'No haptics'}
        </TapButton>
        <TapButton
          onTap={p.onResetCamera}
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-white/6 bg-panel-2/70 text-[11px] font-bold tracking-[0.08em] text-ink uppercase active:scale-95"
        >
          <RotateCcw className="size-4" /> Reset view
        </TapButton>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[10px] text-ink-dim">
        <Download className="size-3" /> Snapshots open a preview you can download or share.
      </p>
    </>
  )
}

/**
 * Slide-up settings sheet with three drawers (Forces / Environment / Tools).
 * No backdrop: the arena stays live and touchable while values change, and the
 * 3D view reframes into the space the sheet leaves free.
 */
export function SettingsDrawer(props: Props) {
  const { tab, onTab, onClose, bottom, sectionRef } = props
  const open = tab !== null
  const swipe = useRef<{ id: number; y: number } | null>(null)
  const title = TABS.find((t) => t.id === tab)?.label ?? 'Settings'

  return (
    <section
      ref={sectionRef}
      id="settings-drawer"
      aria-label={`${title} drawer`}
      aria-hidden={!open}
      inert={!open}
      className={`hud-panel absolute inset-x-3 z-30 flex flex-col overflow-hidden rounded-[22px] transition-[transform,opacity] duration-250 ease-out sm:left-auto sm:w-[400px] ${
        open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-[calc(100%+24px)] opacity-0'
      }`}
      style={{
        bottom,
        maxHeight: `calc(100dvh - ${bottom} - max(env(safe-area-inset-top), 10px) - 70px)`,
      }}
    >
      <div
        className="flex shrink-0 touch-none flex-col px-3 pt-1.5"
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
        <div className="mx-auto mb-1.5 h-1 w-10 rounded-full bg-ink-dim/40" />
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Drawers" className="flex flex-1 gap-1 rounded-xl border border-white/5 bg-panel-2/70 p-1">
            {TABS.map((t) => {
              const active = t.id === tab
              return (
                <TapButton
                  key={t.id}
                  role="tab"
                  aria-selected={active}
                  onTap={() => onTab(t.id)}
                  className={`h-9 min-w-0 flex-1 truncate rounded-lg px-1 text-[11px] font-bold tracking-[0.08em] uppercase transition-colors ${
                    active ? 'bg-neon/18 text-neon' : 'text-ink-dim'
                  }`}
                >
                  {t.label}
                </TapButton>
              )
            })}
          </div>
          <TapButton
            onTap={onClose}
            aria-label="Close drawer"
            className="grid size-11 shrink-0 place-items-center rounded-xl text-ink-dim active:scale-95 active:text-neon"
          >
            <ChevronDown className="size-5" />
          </TapButton>
        </div>
      </div>

      <div
        role="tabpanel"
        aria-label={title}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-3.5"
        style={{ touchAction: 'pan-y' }}
      >
        {tab === 'forces' && <ForcesPanel {...props} />}
        {tab === 'environment' && <EnvironmentPanel {...props} />}
        {tab === 'tools' && <ToolsPanel {...props} />}
      </div>
    </section>
  )
}
