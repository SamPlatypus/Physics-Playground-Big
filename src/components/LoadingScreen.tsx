import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

interface Props {
  visible: boolean
  error: string | null
  onRetry: () => void
}

export function LoadingScreen({ visible, error, onRetry }: Props) {
  // Keep mounted briefly after ready so it can fade out instead of popping.
  const [mounted, setMounted] = useState(visible)
  useEffect(() => {
    if (visible) {
      setMounted(true)
      return
    }
    const t = window.setTimeout(() => setMounted(false), 450)
    return () => window.clearTimeout(t)
  }, [visible])

  if (!mounted) return null

  return (
    <div
      className={`absolute inset-0 z-50 flex flex-col items-center justify-center bg-void transition-opacity duration-400 ${
        visible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="scanlines pointer-events-none absolute inset-0 opacity-60" />
      {error ? (
        <div className="hud-panel relative mx-6 flex max-w-sm flex-col items-center gap-4 rounded-2xl px-6 py-7 text-center">
          <AlertTriangle className="size-9 text-amber" strokeWidth={1.6} />
          <div>
            <p className="text-base font-semibold tracking-wide text-ink">Couldn’t start the simulation</p>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">{error}</p>
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="flex h-12 items-center gap-2 rounded-xl border border-neon/40 bg-neon/10 px-5 text-sm font-semibold tracking-wider text-neon uppercase active:scale-95"
          >
            <RefreshCw className="size-4" /> Retry
          </button>
        </div>
      ) : (
        <div className="relative flex flex-col items-center">
          <div className="relative size-20">
            <div className="animate-spin-slow absolute inset-0 rounded-full border-2 border-transparent border-t-neon border-r-neon/40" />
            <div className="animate-spin-rev absolute inset-3 rounded-full border-2 border-transparent border-b-plasma border-l-plasma/40" />
            <div className="absolute inset-[34px] rounded-full bg-neon shadow-[0_0_16px_4px_color-mix(in_srgb,var(--color-neon)_60%,transparent)]" />
          </div>
          <p className="mt-7 text-sm font-semibold tracking-[0.28em] text-ink uppercase">Initializing</p>
          <p className="mt-1.5 font-mono text-[11px] tracking-wider text-ink-dim">physics core · rapier wasm</p>
        </div>
      )}
    </div>
  )
}
