import type { RawObject, SessionRawArchive } from "@atape/domain"
import { Badge, Button, Eyebrow } from "@atape/ui"
import { useEffect, useRef, useState } from "react"
import type { LoadableView } from "../presenters/memoryPresenter"
import { useRawContentPresenter } from "../presenters/rawPresenter"

type Props = {
  readonly state: LoadableView<SessionRawArchive>
  readonly onClose: () => void
  readonly onRetry: () => void
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

const RawContentPane = ({ object }: { readonly object: RawObject }) => {
  const [generation, setGeneration] = useState(object.currentGeneration)
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([""])
  const cursor = cursors.at(-1) ?? ""
  const presenter = useRawContentPresenter(object.objectId, generation, cursor)

  const chooseGeneration = (next: number) => {
    setGeneration(next)
    setCursors([""])
  }

  if (presenter.state._tag === "Loading") {
    return <div className="raw-content-state" aria-live="polite">Opening a bounded Raw page…</div>
  }
  if (presenter.state._tag === "Failed") {
    return (
      <div className="raw-content-state raw-content-error" role="alert">
        <strong>Raw content is unavailable</strong>
        <span>{presenter.state.message}</span>
        {presenter.state.retryable && <Button onClick={presenter.reload}>Try again</Button>}
      </div>
    )
  }

  const { page, text } = presenter.state.value
  return (
    <section className="raw-content" aria-labelledby="raw-content-heading">
      <header className="raw-content-toolbar">
        <div>
          <strong id="raw-content-heading">Captured bytes</strong>
          <small>{formatBytes(page.sizeBytes)} total · {page.finalized ? "finalized" : "still appending"}</small>
        </div>
        <label>
          <span>Generation</span>
          <select
            value={generation}
            onChange={(event) => chooseGeneration(Number(event.currentTarget.value))}
          >
            {Array.from({ length: object.generationCount }, (_, index) => index + 1).map((value) => (
              <option key={value} value={value}>{value}{value === object.currentGeneration ? " · current" : ""}</option>
            ))}
          </select>
        </label>
      </header>

      <pre className="raw-code" tabIndex={0}>{text || "(empty finalized source)"}</pre>

      <footer className="raw-page-controls">
        <span>Page {cursors.length} · at most 4 chunks loaded</span>
        <div>
          <Button
            variant="ghost"
            disabled={cursors.length === 1}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            disabled={!page.nextCursor}
            onClick={() => page.nextCursor && setCursors((current) => [...current, page.nextCursor!])}
          >
            Next page
          </Button>
        </div>
      </footer>
    </section>
  )
}

export const RawDrawer = ({ state, onClose, onRetry }: Props) => {
  const closeButton = useRef<HTMLButtonElement>(null)
  const drawer = useRef<HTMLElement>(null)
  const [selectedObjectId, setSelectedObjectId] = useState("")

  useEffect(() => {
    const previouslyFocused = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    closeButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
        return
      }
      if (event.key !== "Tab" || drawer.current === null) return
      const focusable = [...drawer.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"
      )]
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || !drawer.current.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = previousOverflow
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [onClose])

  const objects = state._tag === "Ready" ? state.value.objects : []
  const selected = objects.find((object) => object.objectId === selectedObjectId) ?? objects[0]

  return (
    <div className="raw-drawer-layer">
      <button className="raw-drawer-backdrop" type="button" aria-label="Close Raw source" onClick={onClose} />
      <aside ref={drawer} className="raw-drawer" role="dialog" aria-modal="true" aria-labelledby="raw-drawer-title">
        <header className="raw-drawer-heading">
          <div>
            <Eyebrow>Separate archive</Eyebrow>
            <h2 id="raw-drawer-title">Raw source</h2>
          </div>
          <button
            ref={closeButton}
            className="atape-button atape-button--ghost"
            type="button"
            aria-label="Close Raw source"
            onClick={onClose}
          >
            Close
          </button>
        </header>

        {state._tag === "Loading" && (
          <div className="raw-drawer-state" aria-live="polite">Fetching the Raw manifest…</div>
        )}
        {state._tag === "Failed" && (
          <div className="raw-drawer-state raw-content-error" role="alert">
            <strong>Raw manifest is unavailable</strong>
            <span>{state.message}</span>
            {state.retryable && <Button onClick={onRetry}>Try again</Button>}
          </div>
        )}
        {state._tag === "Ready" && objects.length === 0 && (
          <div className="raw-drawer-state">
            <strong>No Raw source was captured for this Session.</strong>
            <span>The Canonical conversation remains available above the source archive.</span>
          </div>
        )}
        {state._tag === "Ready" && selected && (
          <>
            <div className="raw-redaction-note">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>Client-side secret redaction applied</strong>
                <small>Raw is fetched only for this drawer. It is not part of the Canonical conversation or Search index.</small>
              </div>
            </div>
            {objects.length > 1 && (
              <div className="raw-object-picker" role="list" aria-label="Raw source files">
                {objects.map((object) => (
                  <button
                    key={object.objectId}
                    type="button"
                    className={object.objectId === selected.objectId ? "current" : ""}
                    onClick={() => setSelectedObjectId(object.objectId)}
                  >
                    {object.sourceName}
                  </button>
                ))}
              </div>
            )}
            <section className="raw-object-card" aria-label="Raw source metadata">
              <div>
                <strong>{selected.sourceName}</strong>
                <small>{selected.mediaType}</small>
              </div>
              <div className="raw-object-badges">
                <Badge>{selected.adapterId} · {selected.adapterVersion}</Badge>
                <Badge tone="accent">generation {selected.currentGeneration} / {selected.generationCount}</Badge>
                <Badge tone={selected.currentFinalized ? "success" : "warning"}>
                  {selected.currentFinalized ? "finalized" : "appending"}
                </Badge>
              </div>
            </section>
            <RawContentPane key={selected.objectId} object={selected} />
          </>
        )}
      </aside>
    </div>
  )
}
