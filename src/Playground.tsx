import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PhysicsEngine,
  type EngineStats,
  type RapierApi,
  type SavedScene,
  type SingularityState,
} from './engine/PhysicsEngine'
import {
  GRAVITY_PRESETS,
  MAX_BODIES,
  gravityValue,
  type GravityId,
  type InteractionMode,
  type ShapeKind,
  type SingularityType,
} from './engine/constants'
import { AudioManager } from './engine/audio'
import { haptics } from './engine/haptics'
import { DEFAULT_THEME, THEMES, isThemeId, peekColorIndex, type ThemeId } from './engine/themes'
import { usePersistentState } from './hooks/usePersistentState'
import { Hud } from './components/Hud'
import { ControlDeck, type DrawerTab } from './components/ControlDeck'
import { SettingsDrawer, type SlotMeta } from './components/SettingsDrawer'
import { PhotoModal } from './components/PhotoModal'

export interface PlaygroundProps {
  rapier: RapierApi
}

const isGravityId = (v: unknown): v is GravityId => GRAVITY_PRESETS.some((p) => p.id === v)
const isUnit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1
const isMode = (v: unknown): v is InteractionMode => v === 'interact' || v === 'camera' || v === 'slice'
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

/**
 * Control deck height (48px + 60px rows, gaps and padding) plus its bottom gap.
 * On short landscape screens the deck collapses to a single 60px strip.
 */
const TOOLBAR_OFFSET = 'calc(max(env(safe-area-inset-bottom), 12px) + var(--deck-h, 136px))'

const MODE_TOASTS: Record<InteractionMode, string> = {
  interact: 'Grab · drag shapes to fling them',
  camera: 'Camera · drag to orbit, pinch to zoom',
  slice: 'Slice · swipe across shapes to cut them',
}

const SINGULARITY_NAMES: Record<SingularityType, string> = {
  blackhole: 'black hole',
  repulsor: 'repulsor',
}

const SLOT_COUNT = 3
const slotKey = (slot: number) => `pp.scene.${slot}`

function readSlots(): (SlotMeta | null)[] {
  return Array.from({ length: SLOT_COUNT }, (_, i) => {
    try {
      const raw = localStorage.getItem(slotKey(i + 1))
      if (!raw) return null
      const scene = JSON.parse(raw) as SavedScene
      return { slot: i + 1, count: scene.bodies.length, savedAt: scene.savedAt }
    } catch {
      return null
    }
  })
}

export default function Playground({ rapier }: PlaygroundProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const engineRef = useRef<PhysicsEngine | null>(null)

  const [gravity, setGravity] = usePersistentState<GravityId>('pp.gravity', 'earth', isGravityId)
  const [restitution, setRestitution] = usePersistentState('pp.restitution', 0.35, isUnit)
  const [friction, setFriction] = usePersistentState('pp.friction', 0.6, isUnit)
  const [mode, setMode] = usePersistentState<InteractionMode>('pp.mode', 'interact', isMode)
  const [hapticsOn, setHapticsOn] = usePersistentState('pp.haptics', true, isBool)
  const [hasGrabbed, setHasGrabbed] = usePersistentState('pp.hasGrabbed', false, isBool)
  const [destructible, setDestructible] = usePersistentState('pp.destructible', true, isBool)
  const [theme, setTheme] = usePersistentState<ThemeId>('pp.theme', DEFAULT_THEME, isThemeId)
  const [muted, setMuted] = usePersistentState('pp.muted', false, isBool)

  // One audio manager for the app's lifetime; the AudioContext itself is created on first touch.
  const [audio] = useState(() => new AudioManager(muted))

  const [stats, setStats] = useState<EngineStats>({ fps: 0, bodies: 0, debris: 0, max: MAX_BODIES })
  const [singularity, setSingularity] = useState<SingularityState>({ type: null, placed: false })
  const [drawer, setDrawer] = useState<DrawerTab | null>(null)
  const [frozen, setFrozen] = useState(false)
  const [tremorActive, setTremorActive] = useState(false)
  const [slots, setSlots] = useState(readSlots)
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [, setColorTick] = useState(0)
  const [flashKey, setFlashKey] = useState(0)
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null)
  const [dragging, setDragging] = useState(false)

  // Latest settings, read once when the engine boots (later changes go through setters).
  const initial = useRef({ gravity, restitution, friction, mode, destructible, theme })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const s = initial.current
    const engine = new PhysicsEngine(rapier, host, {
      gravity: gravityValue(s.gravity),
      restitution: s.restitution,
      friction: s.friction,
      mode: s.mode,
      destructible: s.destructible,
      theme: s.theme,
      audio,
      onStats: (next) =>
        setStats((prev) =>
          prev.fps === next.fps && prev.bodies === next.bodies && prev.debris === next.debris && prev.max === next.max
            ? prev
            : next,
        ),
      onSingularityChange: setSingularity,
      onFrozenChange: setFrozen,
      onTremorChange: setTremorActive,
      onDragChange: (d) => {
        setDragging(d)
        if (d) setHasGrabbed(true)
      },
    })
    engineRef.current = engine
    if (import.meta.env.DEV) {
      const w = window as unknown as { __playground?: PhysicsEngine; __audio?: AudioManager }
      w.__playground = engine
      w.__audio = audio
    }
    return () => {
      engine.dispose()
      engineRef.current = null
    }
  }, [rapier, audio, setHasGrabbed])

  // Web Audio may only start after a user gesture: unlock (or resume) on touches and keys.
  useEffect(() => {
    const unlock = () => audio.unlock()
    window.addEventListener('pointerdown', unlock, true)
    window.addEventListener('keydown', unlock, true)
    return () => {
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
    }
  }, [audio])

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
    engineRef.current?.setDestructible(destructible)
  }, [destructible])
  useEffect(() => {
    haptics.setEnabled(hapticsOn)
  }, [hapticsOn])
  useEffect(() => {
    audio.setMuted(muted)
  }, [audio, muted])
  useEffect(() => {
    engineRef.current?.setTheme(theme)
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES[theme].background)
  }, [theme])

  // While a drawer is open, slide/zoom the arena into the area it leaves uncovered:
  // the strip above it on phones, or the space beside it on wide/landscape screens.
  useEffect(() => {
    const engine = engineRef.current
    const sheet = drawerRef.current
    const root = rootRef.current
    if (!engine) return
    if (!drawer || !sheet || !root) {
      engine.setFocusRect(null)
      return
    }
    const update = () => {
      const width = root.clientWidth
      const top = (root.querySelector('header')?.getBoundingClientRect().bottom ?? 70) + 6
      const side = sheet.offsetLeft > width * 0.3
      const toolbarTop = root.querySelector('nav')?.getBoundingClientRect().top ?? root.clientHeight
      engine.setFocusRect(
        side
          ? { left: 0, top, right: sheet.offsetLeft - 6, bottom: toolbarTop - 6 }
          : { left: 0, top, right: width, bottom: sheet.offsetTop - 6 },
      )
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(sheet)
    ro.observe(root)
    return () => ro.disconnect()
  }, [drawer])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 1900)
    return () => window.clearTimeout(t)
  }, [toast])

  const showToast = useCallback((text: string) => setToast({ key: Date.now(), text }), [])

  const spawn = useCallback((kind: ShapeKind) => {
    engineRef.current?.spawn(kind)
    setColorTick((n) => n + 1) // refresh the next-colour preview on the spawn buttons
  }, [])

  const clearAll = useCallback(() => {
    engineRef.current?.clearAll()
    haptics.tick()
    setFlashKey((k) => k + 1)
  }, [])

  const toggleFreeze = useCallback(() => {
    const engine = engineRef.current
    if (!engine) return
    const next = !engine.isFrozen
    engine.setFrozen(next)
    haptics.tick()
    showToast(next ? 'Frozen · orbit, pinch and pan around the moment' : 'Physics resumed')
  }, [showToast])

  const changeMode = useCallback(
    (next: InteractionMode) => {
      setMode(next)
      showToast(MODE_TOASTS[next])
    },
    [setMode, showToast],
  )

  const chooseSingularity = useCallback(
    (type: SingularityType | null) => {
      engineRef.current?.setSingularity(type)
      // Arming a new one: get the drawer out of the way so the arena can be tapped.
      if (type && !singularity.placed) {
        setDrawer(null)
        showToast(`Tap the arena to place the ${SINGULARITY_NAMES[type]}`)
      }
    },
    [singularity.placed, showToast],
  )

  const changeGravity = useCallback(
    (id: GravityId) => {
      setGravity(id)
      haptics.tick()
    },
    [setGravity],
  )

  const tremor = useCallback(() => {
    if (engineRef.current?.triggerTremor()) showToast('Earthquake!')
  }, [showToast])

  const saveSlot = useCallback(
    (slot: number) => {
      const engine = engineRef.current
      if (!engine) return
      const scene = engine.serializeScene()
      try {
        localStorage.setItem(slotKey(slot), JSON.stringify(scene))
        showToast(`Saved ${scene.bodies.length} shapes to slot ${slot}`)
      } catch {
        showToast('Could not save: storage is unavailable or full')
      }
      setSlots(readSlots())
      haptics.tick()
    },
    [showToast],
  )

  const loadSlot = useCallback(
    (slot: number) => {
      const engine = engineRef.current
      if (!engine) return
      try {
        const raw = localStorage.getItem(slotKey(slot))
        if (!raw) return
        const n = engine.loadScene(JSON.parse(raw) as SavedScene)
        setDrawer(null)
        showToast(`Restored ${n} shapes · frozen — tap ❄ to resume`)
      } catch {
        showToast('That save could not be read')
      }
      haptics.tick()
    },
    [showToast],
  )

  const takePhoto = useCallback(async () => {
    const engine = engineRef.current
    if (!engine) return
    const blob = await engine.capturePhoto()
    if (blob && blob.size > 0) setPhoto(blob)
    else showToast('Snapshot failed on this device')
  }, [showToast])

  const toggleDrawer = useCallback((tab: DrawerTab) => setDrawer((cur) => (cur === tab ? null : tab)), [])

  const nextColor = THEMES[theme].shapes[peekColorIndex()]

  let hint: string | null = null
  if (singularity.type && !singularity.placed) hint = `Tap inside the arena to place the ${SINGULARITY_NAMES[singularity.type]}`
  else if (stats.bodies === 0) hint = 'Tap a shape below to spawn it'
  else if (!hasGrabbed && mode === 'interact' && !drawer && !frozen) hint = 'Touch & drag a shape — let go to fling'

  return (
    <div ref={rootRef} className="absolute inset-0">
      <div ref={hostRef} className="absolute inset-0" />

      {frozen && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[5] bg-[radial-gradient(ellipse_at_center,transparent_55%,rgb(159_232_255/0.16))] shadow-[inset_0_0_0_2px_rgb(159_232_255/0.25)]"
        />
      )}

      {flashKey > 0 && (
        <div key={flashKey} className="pointer-events-none absolute inset-0 z-10" aria-hidden>
          <div className="animate-clear-flash absolute inset-0 bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-neon)_28%,transparent),transparent_70%)]" />
          <div className="animate-clear-sweep absolute inset-x-0 top-0 h-[3px] bg-neon shadow-[0_0_24px_6px_color-mix(in_srgb,var(--color-neon)_55%,transparent)]" />
        </div>
      )}

      <Hud
        fps={stats.fps}
        bodies={stats.bodies}
        debris={stats.debris}
        max={stats.max}
        muted={muted}
        onMute={() => setMuted((m) => !m)}
        frozen={frozen}
        onFreeze={toggleFreeze}
        onClear={clearAll}
      />

      {frozen && (
        <div
          className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 rounded-full border border-[#9fe8ff]/40 bg-panel/85 px-3 py-1 text-[10px] font-bold tracking-[0.18em] whitespace-nowrap text-[#c8f3ff] uppercase"
          style={{ top: 'calc(max(env(safe-area-inset-top), 10px) + 56px)' }}
        >
          Frozen · drag to orbit
        </div>
      )}

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
          className="hud-panel animate-toast pointer-events-none absolute left-1/2 z-20 max-w-[calc(100vw-32px)] truncate rounded-xl px-4 py-2.5 text-xs font-semibold tracking-[0.08em] whitespace-nowrap text-ink"
          style={{ top: 'calc(max(env(safe-area-inset-top), 10px) + 84px)' }}
        >
          {toast.text}
        </div>
      )}

      <SettingsDrawer
        tab={drawer}
        onTab={setDrawer}
        onClose={() => setDrawer(null)}
        bottom={TOOLBAR_OFFSET}
        sectionRef={drawerRef}
        gravity={gravity}
        onGravity={changeGravity}
        singularity={singularity.type}
        singularityPlaced={singularity.placed}
        onSingularity={chooseSingularity}
        destructible={destructible}
        onDestructible={setDestructible}
        onTremor={tremor}
        tremorActive={tremorActive}
        frozen={frozen}
        theme={theme}
        onTheme={setTheme}
        restitution={restitution}
        onRestitution={setRestitution}
        friction={friction}
        onFriction={setFriction}
        slots={slots}
        onSave={saveSlot}
        onLoad={loadSlot}
        onPhoto={() => void takePhoto()}
        hapticsOn={hapticsOn}
        hapticsSupported={haptics.supported}
        onHaptics={setHapticsOn}
        onResetCamera={() => engineRef.current?.resetCamera()}
      />

      <ControlDeck
        mode={mode}
        onMode={changeMode}
        onSpawn={spawn}
        nextColor={nextColor}
        drawer={drawer}
        onDrawer={toggleDrawer}
      />

      {photo && <PhotoModal blob={photo} onClose={() => setPhoto(null)} />}
    </div>
  )
}
