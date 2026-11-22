/**
 * Lightweight wrapper around navigator.vibrate.
 *
 * - Silently no-ops where the Vibration API is missing (iOS, most desktops).
 * - Skips calls before the page has had a user gesture, which Chrome would
 *   otherwise block with a console intervention warning.
 * - Collision rumble is rate-limited so piles of impacts never buzz continuously.
 */

const RUMBLE_MIN_INTERVAL_MS = 120

type VibrateNavigator = Navigator & {
  userActivation?: { hasBeenActive: boolean }
}

const nav: VibrateNavigator | undefined = typeof navigator === 'undefined' ? undefined : navigator

export const hapticsSupported = !!nav && typeof nav.vibrate === 'function'

let enabled = true
let lastRumbleAt = -Infinity

function buzz(ms: number): boolean {
  if (!enabled || !hapticsSupported || !nav) return false
  // Before any user gesture Chrome rejects vibrate(); don't spam warnings.
  if (nav.userActivation && !nav.userActivation.hasBeenActive) return false
  try {
    return nav.vibrate(ms)
  } catch {
    return false
  }
}

export const haptics = {
  get supported() {
    return hapticsSupported
  },
  get enabled() {
    return enabled
  },
  setEnabled(value: boolean) {
    enabled = value
    if (!value && hapticsSupported) {
      try {
        nav?.vibrate(0)
      } catch {
        /* ignore */
      }
    }
  },
  /** 10 ms — a shape was spawned. */
  tick: () => buzz(10),
  /** 15 ms — an object was grabbed. */
  tap: () => buzz(15),
  /** 30 ms — an object was flung. */
  fling: () => buzz(30),
  /** 20 ms — high-speed impact against the floor or a wall. Max once per 120 ms. */
  rumble(now: number = performance.now()): boolean {
    if (now - lastRumbleAt < RUMBLE_MIN_INTERVAL_MS) return false
    lastRumbleAt = now
    return buzz(20)
  },
}
