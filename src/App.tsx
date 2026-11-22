import { useCallback, useEffect, useState, type ComponentType } from 'react'
import type { RapierApi } from './engine/PhysicsEngine'
import type { PlaygroundProps } from './Playground'
import { LoadingScreen } from './components/LoadingScreen'
import { PwaPrompt } from './components/PwaPrompt'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; rapier: RapierApi; Playground: ComponentType<PlaygroundProps> }
  | { status: 'error'; message: string }

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * Boot sequence. The Rapier WASM runtime must be fully initialised
 * (`await RAPIER.init()`) before any World is created, so the simulation is only
 * mounted once both the physics module and the 3D bundle have loaded.
 */
export default function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (!hasWebGL()) {
      setState({
        status: 'error',
        message: 'WebGL is unavailable on this device or browser, so the 3D arena cannot start.',
      })
      return
    }
    setState({ status: 'loading' })
    Promise.all([
      import('@dimforge/rapier3d-compat').then(async (RAPIER) => {
        await RAPIER.init()
        return RAPIER
      }),
      import('./Playground'),
    ])
      .then(([rapier, mod]) => {
        if (!cancelled) setState({ status: 'ready', rapier, Playground: mod.default })
      })
      .catch((err: unknown) => {
        console.error('Physics boot failed', err)
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'The physics engine failed to initialise.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-void">
      {state.status === 'ready' && <state.Playground rapier={state.rapier} />}
      <LoadingScreen
        visible={state.status !== 'ready'}
        error={state.status === 'error' ? state.message : null}
        onRetry={retry}
      />
      <PwaPrompt />
    </div>
  )
}
