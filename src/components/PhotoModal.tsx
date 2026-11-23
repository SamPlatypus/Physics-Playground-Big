import { Download, Share2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { TapButton } from './TapButton'

interface Props {
  blob: Blob
  onClose: () => void
}

/** Preview of a Photo Mode snapshot with Download and (where supported) Share. */
export function PhotoModal({ blob, onClose }: Props) {
  // Created inside the effect so StrictMode's mount → unmount → mount cycle can't
  // revoke the URL the <img> is about to use.
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])

  const filename = useMemo(() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `physics-playground-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`
  }, [])

  const file = useMemo(() => new File([blob], filename, { type: 'image/png' }), [blob, filename])
  const canShare = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Snapshot preview"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <img
        src={url ?? undefined}
        alt="Snapshot of the arena"
        data-testid="snapshot-image"
        className="max-h-[68dvh] max-w-full rounded-2xl border border-white/10 object-contain shadow-2xl"
      />
      <div className="flex w-full max-w-sm gap-2">
        <a
          href={url ?? undefined}
          download={filename}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-neon/50 bg-neon/15 text-xs font-bold tracking-[0.12em] text-neon uppercase active:scale-95"
        >
          <Download className="size-4" /> Download
        </a>
        {canShare && (
          <TapButton
            onTap={() => void navigator.share({ files: [file], title: 'Physics Playground' }).catch(() => undefined)}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-panel-2/90 text-xs font-bold tracking-[0.12em] text-ink uppercase active:scale-95"
          >
            <Share2 className="size-4" /> Share
          </TapButton>
        )}
        <TapButton
          onTap={onClose}
          aria-label="Close snapshot"
          className="grid size-12 shrink-0 place-items-center rounded-xl border border-white/10 bg-panel-2/90 text-ink active:scale-95"
        >
          <X className="size-5" />
        </TapButton>
      </div>
      <p className="font-mono text-[10px] text-ink-dim">
        PNG · {(blob.size / 1024).toFixed(0)} KB
      </p>
    </div>
  )
}
