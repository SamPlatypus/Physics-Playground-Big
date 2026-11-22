import { useCallback, useEffect, useRef, useState } from 'react'
import { PhysicsEngine, type EngineStats, type RapierApi } from './engine/PhysicsEngine'
import {
  GRAVITY_PRESETS,
  MAX_BODIES,
  gravityValue,
  type GravityId,
  type InteractionMode,
  type ShapeKind,
} from './engine/constants'
import { haptics } from './engine/haptics'
import { peekNextColorCss } from './engine/palette'
import { usePersistentState } from './hooks/usePersistentState'
import { Hud } from './components/Hud'
import { ModeSwitch } from './components/ModeSwitch'
import { SpawnToolbar } from './components/SpawnToolbar'
import { EnvironmentDock } from './components/EnvironmentDock'

export interface PlaygroundProps {
  rapier: RapierApi
}

const isGravityId = (v: unknown): v is GravityId => GRAVITY_PRESETS.some((p) => p.id === v)
const isUnit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1
const isMode = (v: unknown): v is InteractionMode => v === 'interact' || v === 'camera'
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

/** Toolbar height (66px buttons + 12px padding) plus its bottom gap. */
const TOOLBAR_OFFSET = 'calc(max(env(safe-area-inset-bottom), 12px) + 90px)'

export default function Playground({ rapier }: PlaygroundProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLElement>(null)
  const engineRef = useRef<PhysicsEngine | null>(null)

  const [gravity, setGravity] = usePersistentState<GravityId>('pp.gravity', 'earth', isGravityId)
  const [restitution, setRestitution] = usePersistentState('pp.restitution', 0.35, isUnit)
  const [friction, setFriction] = usePersistentState('pp.friction', 0.6, isUnit)
  const [mode, setMode] = usePersistentState<InteractionMode>('pp.mode', 'interact', isMode)
  const [hapticsOn, setHapticsOn] = usePersistentState('pp.haptics', true, isBool)
  const [hasGrabbed, setHasGrabbed] = usePersistentState('pp.hasGrabbed', false, isBool)

  const [stats, setStats] = useState<EngineStats>({ fps: 0, bodies: 0, max: MAX_BODIES })
  const [dockOpen, setDockOpen] = useState(false)
  const [nextColor, setNextColor] = useState(peekNextColorCss)
  const [flashKey, setFlashKey] = useState(0)
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null)
  const [dragging, setDragging] = useState(false)

  // Latest settings, read once when the engine boots (later changes go through setters).
  const initial = useRef({ gravity, restitution, friction, mode })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const s = initial.current
    const engine = new PhysicsEngine(rapier, host, {
      gravity: gravityValue(s.gravity),
      restitution: s.restitution,
      friction: s.friction,
      mode: s.mode,
      onStats: (next) =>
        setStats((prev) =>
          prev.fps === next.fps && prev.bodies === next.bodies && prev.max === next.max ? prev : next,
        ),
      onDragChange: (d) => {
        setDragging(d)
        if (d) setHasGrabbed(true)
      },
    })
    engineRef.current = engine
    if (import.meta.env.DEV) (window as unknown as { __playground?: PhysicsEngine }).__playground = engine
    return () => {
      engine.dispose()
      engineRef.current = null
    }
  }, [rapier, setHasGrabbed])

  // Real-time environment updates.
  useEffect(() => {
    engineRef.current?.setGravity(gravityValue(gravity))
  }, [gravity])
  useEffect(() => {
    engineRef.current?.setMaterial(restitution, friction)
  }, [restitution, friction])
  useEffect(() => {
    engineRef.current?.setMode(mode)
  }, [mode])
  useEffect(() => {
    haptics.setEnabled(hapticsOn)
  }, [hapticsOn])

  // While the dock is open, slide/zoom the arena into the area it leaves uncovered:
  // the strip above it on phones, or the space beside it on wide/landscape screens.
  useEffect(() => {
    const engine = engineRef.current
    const dock = dockRef.current
    const root = rootRef.current
    if (!engine) return
    if (!dockOpen || !dock || !root) {
      engine.setFocusRect(null)
      return
    }
    const update = () => {
      const width = root.clientWidth
      const top = (root.querySelector('header')?.getBoundingClientRect().bottom ?? 80) + 6
      const sideDock = dock.offsetLeft > width * 0.3
      const toolbarTop = root.querySelector('nav')?.getBoundingClientRect().top ?? root.clientHeight
      engine.setFocusRect(
        sideDock
          ? { left: 0, top, right: dock.offsetLeft - 6, bottom: toolbarTop - 6 }
          : { left: 0, top, right: width, bottom: dock.offsetTop - 6 },
      )
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(dock)
    ro.observe(root)
    return () => ro.disconnect()
  }, [dockOpen])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 1900)
    return () => window.clearTimeout(t)
  }, [toast])

  const showToast = useCallback((text: string) => setToast({ key: Date.now(), text }), [])

  const spawn = useCallback((kind: ShapeKind) => {
    engineRef.current?.spawn(kind)
    setNextColor(peekNextColorCss())
  }, [])

  const clearAll = useCallback(() => {
    engineRef.current?.clearAll()
    haptics.tick()
    setFlashKey((k) => k + 1)
  }, [])

  const changeMode = useCallback(
    (next: InteractionMode) => {
      setMode(next)
      showToast(next === 'camera' ? 'Orbit · drag to rotate, pinch to zoom' : 'Grab · drag shapes to fling them')
    },
    [setMode, showToast],
  )

  const changeGravity = useCallback(
    (id: GravityId) => {
      setGravity(id)
      haptics.tick()
    },
    [setGravity],
  )

  const preset = GRAVITY_PRESETS.find((p) => p.id === gravity) ?? GRAVITY_PRESETS[0]

  let hint: string | null = null
  if (stats.bodies === 0) hint = 'Tap a shape below to spawn it'
  else if (!hasGrabbed && mode === 'interact' && !dockOpen) hint = 'Touch & drag a shape — let go to fling'

  return (
    <div ref={rootRef} className="absolute inset-0">
      <div ref={hostRef} className="absolute inset-0" />

      {flashKey > 0 && (
        <div key={flashKey} className="pointer-events-none absolute inset-0 z-10" aria-hidden>
          <div className="animate-clear-flash absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(56_225_255/0.28),transparent_70%)]" />
          <div className="animate-clear-sweep absolute inset-x-0 top-0 h-[3px] bg-neon shadow-[0_0_24px_6px_rgb(56_225_255/0.55)]" />
        </div>
      )}

      <Hud fps={stats.fps} bodies={stats.bodies} max={stats.max} onClear={clearAll} />

      {hint && !dragging && (
        <div
          className="animate-hint pointer-events-none absolute left-1/2 z-10 rounded-full border border-neon/25 bg-panel/85 px-4 py-2 text-center text-xs font-semibold tracking-[0.08em] whitespace-nowrap text-neon-soft"
          style={{ bottom: `calc(${TOOLBAR_OFFSET} + 14px)` }}
        >
          {hint}
        </div>
      )}

      {toast && (
        <div
          key={toast.key}
          role="status"
          className="hud-panel animate-toast pointer-events-none absolute left-1/2 z-20 rounded-xl px-4 py-2.5 text-xs font-semibold tracking-[0.08em] whitespace-nowrap text-ink"
          style={{ top: 'calc(max(env(safe-area-inset-top), 10px) + 70px)' }}
        >
          {toast.text}
        </div>
      )}

      <ModeSwitch
        mode={mode}
        onChange={changeMode}
        hidden={dockOpen}
        bottom={`calc(${TOOLBAR_OFFSET} + 58px)`}
      />

      <EnvironmentDock
        open={dockOpen}
        onClose={() => setDockOpen(false)}
        gravity={gravity}
        onGravity={changeGravity}
        restitution={restitution}
        onRestitution={setRestitution}
        friction={friction}
        onFriction={setFriction}
        hapticsOn={hapticsOn}
        hapticsSupported={haptics.supported}
        onHaptics={setHapticsOn}
        onResetCamera={() => engineRef.current?.resetCamera()}
        bottom={TOOLBAR_OFFSET}
        sectionRef={dockRef}
      />

      <SpawnToolbar
        onSpawn={spawn}
        nextColor={nextColor}
        dockOpen={dockOpen}
        onToggleDock={() => setDockOpen((o) => !o)}
        gravityLabel={preset.label}
      />
    </div>
  )
}
