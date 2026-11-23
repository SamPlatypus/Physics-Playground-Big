import { useRef, type ButtonHTMLAttributes, type PointerEvent as ReactPointerEvent } from 'react'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  onTap: () => void
}

const TAP_SLOP_PX = 12
const TAP_MAX_MS = 700
const DEDUPE_MS = 600

/**
 * A button that acts on a clean pointer tap (down + up on the same pointer,
 * within a small slop) instead of waiting for the browser's synthesized click.
 * Chrome can drop that click when a tap lands right after a fast swipe on the
 * arena (it treats the tap as stopping the previous gesture), which made HUD
 * buttons feel dead mid-game. `click` still works for keyboards and screen
 * readers, de-duplicated so a normal tap never fires twice.
 */
export function TapButton({ onTap, onPointerDown, onPointerUp, onPointerCancel, type = 'button', ...rest }: Props) {
  const down = useRef<{ id: number; x: number; y: number; t: number } | null>(null)
  const firedAt = useRef(-Infinity)

  return (
    <button
      {...rest}
      type={type}
      onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
        onPointerDown?.(e)
        if (e.pointerType === 'mouse' && e.button !== 0) return
        down.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp }
      }}
      onPointerUp={(e: ReactPointerEvent<HTMLButtonElement>) => {
        onPointerUp?.(e)
        const d = down.current
        down.current = null
        if (!d || d.id !== e.pointerId || rest.disabled) return
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP_PX || e.timeStamp - d.t > TAP_MAX_MS) return
        firedAt.current = e.timeStamp
        onTap()
      }}
      onPointerCancel={(e: ReactPointerEvent<HTMLButtonElement>) => {
        onPointerCancel?.(e)
        down.current = null
      }}
      onClick={(e) => {
        if (e.timeStamp - firedAt.current < DEDUPE_MS) return
        onTap()
      }}
    />
  )
}
