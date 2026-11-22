import { CloudOff, RefreshCw, X } from 'lucide-react'
import { useEffect } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

/** Tells the player when the app is cached for offline use, and offers updates. */
export function PwaPrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      console.warn('Service worker registration failed', error)
    },
  })

  useEffect(() => {
    if (!offlineReady) return
    const t = window.setTimeout(() => setOfflineReady(false), 3800)
    return () => window.clearTimeout(t)
  }, [offlineReady, setOfflineReady])

  if (!offlineReady && !needRefresh) return null

  return (
    <div
      role="status"
      className="hud-panel animate-toast fixed left-1/2 z-40 flex max-w-[calc(100vw-32px)] items-center gap-3 rounded-xl py-2 pr-2 pl-3.5 text-sm"
      style={{ top: 'calc(max(env(safe-area-inset-top), 10px) + 118px)' }}
    >
      {needRefresh ? (
        <>
          <RefreshCw className="size-4 shrink-0 text-neon" />
          <span className="text-ink">New version ready</span>
          <button
            type="button"
            onClick={() => void updateServiceWorker(true)}
            className="h-9 rounded-lg bg-neon/15 px-3 text-xs font-semibold tracking-wider text-neon uppercase active:scale-95"
          >
            Reload
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNeedRefresh(false)}
            className="grid size-9 place-items-center rounded-lg text-ink-dim active:scale-95"
          >
            <X className="size-4" />
          </button>
        </>
      ) : (
        <>
          <CloudOff className="size-4 shrink-0 text-lime" />
          <span className="pr-2 text-ink">Ready to play offline</span>
        </>
      )}
    </div>
  )
}
