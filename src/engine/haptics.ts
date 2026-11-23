/**
 * Lightweight wrapper around navigator.vibrate.
 *
 * - Silently no-ops where the Vibration API is missing (iOS, most desktops).
 * - Skips calls before the page has had a user gesture, which Chrome would
 *   otherwise block with a console intervention warning.
 * - Collision rumble is rate-limited so piles of impacts never buzz continuously.
 */

const RUMBLE_MIN_INTERVAL_MS = 120
const EXPLOSION_MIN_INTERVAL_MS = 200
/** After an explosion pattern starts, collision rumbles stay quiet so they don't cut it short. */
const EXPLOSION_QUIET_MS = 260
const EXPLOSION_PATTERN = [40, 30, 80]
/** Repeated over the 1.2 s quake. */
const TREMOR_PATTERN = [40, 60, 40, 80, 50]

type VibrateNavigator = Navigator & {
  userActivation?: { hasBeenActive: boolean }
}

const nav: VibrateNavigator | undefined = typeof navigator === 'undefined' ? undefined : navigator

export const hapticsSupported = !!nav && typeof nav.vibrate === 'function'

let enabled = true
let lastRumbleAt = -Infinity
let lastExplosionAt = -Infinity

function buzz(ms: number | number[]): boolean {
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
  /** 15 ms — the laser severed an object (one per severed object). */
  slice: () => buzz(15),
  /** 20 ms — high-speed impact against the floor or a wall. Max once per 120 ms. */
  rumble(now: number = performance.now()): boolean {
    if (now - lastRumbleAt < RUMBLE_MIN_INTERVAL_MS) return false
    if (now - lastExplosionAt < EXPLOSION_QUIET_MS) return false
    lastRumbleAt = now
    return buzz(20)
  },
  /** [40, 60, 40, 80, 50] repeated through the ~1.2 s tremor. */
  tremor: () => buzz([...TREMOR_PATTERN, 0, ...TREMOR_PATTERN, 0, ...TREMOR_PATTERN, 0, ...TREMOR_PATTERN]),
  /**
   * [40, 30, 80] — a Nitro detonation. Throttled to once per 200 ms so a rolling
   * chain reaction doesn't keep restarting (and stalling) the vibration motor.
   */
  explosion(now: number = performance.now()): boolean {
    if (now - lastExplosionAt < EXPLOSION_MIN_INTERVAL_MS) return false
    lastExplosionAt = now
    return buzz(EXPLOSION_PATTERN)
  },
}
