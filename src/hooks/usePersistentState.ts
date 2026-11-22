import { useEffect, useState } from 'react'

/**
 * useState mirrored to localStorage. Storage can be missing or throw (private
 * mode, blocked site data), so every access is guarded and the app still works
 * with plain in-memory state.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  validate?: (value: unknown) => value is T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return initial
      const parsed: unknown = JSON.parse(raw)
      if (validate && !validate(parsed)) return initial
      return parsed as T
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* storage unavailable: keep in-memory only */
    }
  }, [key, value])

  return [value, setValue]
}
