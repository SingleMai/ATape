import type { RawObject, SessionRawArchive } from "@atape/domain"
import { Badge, Button, Eyebrow } from "@atape/ui"
import { useEffect, useRef, useState } from "react"
import type { LoadableView } from "../presenters/memoryPresenter"
import { useRawContentPresenter } from "../presenters/rawPresenter"
import { t } from "../i18n"

type Props = {
  readonly state: LoadableView<SessionRawArchive>
  readonly onClose: () => void
  readonly onRetry: () => void
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return t("raw.bytes", "{value} B", { value: bytes })
  if (bytes < 1024 * 1024) return t("raw.kibibytes", "{value} KiB", { value: (bytes / 1024).toFixed(1) })
  return t("raw.mebibytes", "{value} MiB", { value: (bytes / 1024 / 1024).toFixed(1) })
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
    return <div className="raw-content-state" aria-live="polite">{t("raw.openingPage", "Opening a bounded Raw page…")}</div>
  }
  if (presenter.state._tag === "Failed") {
    return (
      <div className="raw-content-state raw-content-error" role="alert">
        <strong>{t("raw.contentUnavailable", "Raw content is unavailable")}</strong>
        <span>{t(presenter.state.messageKey)}</span>
        {presenter.state.retryable && <Button onClick={presenter.reload}>{t("common.tryAgain", "Try again")}</Button>}
      </div>
    )
  }

  const { page, text } = presenter.state.value
  return (
    <section className="raw-content" aria-labelledby="raw-content-heading">
      <header className="raw-content-toolbar">
        <div>
          <strong id="raw-content-heading">{t("raw.capturedBytes", "Captured bytes")}</strong>
          <small>{page.finalized ? t("raw.totalFinalized", "{size} total · finalized", { size: formatBytes(page.sizeBytes) }) : t("raw.totalAppending", "{size} total · still appending", { size: formatBytes(page.sizeBytes) })}</small>
        </div>
        <label>
          <span>{t("raw.generation", "Generation")}</span>
          <select
            value={generation}
            onChange={(event) => chooseGeneration(Number(event.currentTarget.value))}
          >
            {Array.from({ length: object.generationCount }, (_, index) => index + 1).map((value) => (
              <option key={value} value={value}>{value === object.currentGeneration ? t("raw.currentGeneration", "{generation} · current", { generation: value }) : value}</option>
            ))}
          </select>
        </label>
      </header>

      <pre className="raw-code" tabIndex={0}>{text || t("raw.emptySource", "(empty finalized source)")}</pre>

      <footer className="raw-page-controls">
        <span>{t("raw.pageInfo", "Page {page} · at most 4 chunks loaded", { page: cursors.length })}</span>
        <div>
          <Button
            variant="ghost"
            disabled={cursors.length === 1}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            {t("common.previous", "Previous")}
          </Button>
          <Button
            disabled={!page.nextCursor}
            onClick={() => page.nextCursor && setCursors((current) => [...current, page.nextCursor!])}
          >
            {t("raw.nextPage", "Next page")}
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
      <button className="raw-drawer-backdrop" type="button" aria-label={t("raw.closeSource", "Close Raw source")} onClick={onClose} />
      <aside ref={drawer} className="raw-drawer" role="dialog" aria-modal="true" aria-labelledby="raw-drawer-title">
        <header className="raw-drawer-heading">
          <div>
            <Eyebrow>{t("raw.separateArchive", "Separate archive")}</Eyebrow>
            <h2 id="raw-drawer-title">{t("raw.source", "Raw source")}</h2>
          </div>
          <button
            ref={closeButton}
            className="atape-button atape-button--ghost"
            type="button"
            aria-label={t("raw.closeSource", "Close Raw source")}
            onClick={onClose}
          >
            {t("raw.close", "Close")}
          </button>
        </header>

        {state._tag === "Loading" && (
          <div className="raw-drawer-state" aria-live="polite">{t("raw.fetchingManifest", "Fetching the Raw manifest…")}</div>
        )}
        {state._tag === "Failed" && (
          <div className="raw-drawer-state raw-content-error" role="alert">
            <strong>{t("raw.manifestUnavailable", "Raw manifest is unavailable")}</strong>
            <span>{t(state.messageKey)}</span>
            {state.retryable && <Button onClick={onRetry}>{t("common.tryAgain", "Try again")}</Button>}
          </div>
        )}
        {state._tag === "Ready" && objects.length === 0 && (
          <div className="raw-drawer-state">
            <strong>{t("raw.noSourceTitle", "No Raw source was captured for this Session.")}</strong>
            <span>{t("raw.noSourceBody", "The Canonical conversation remains available above the source archive.")}</span>
          </div>
        )}
        {state._tag === "Ready" && selected && (
          <>
            <div className="raw-redaction-note">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>{t("raw.redactionTitle", "Client-side secret redaction applied")}</strong>
                <small>{t("raw.redactionBody", "Raw is fetched only for this drawer. It is not part of the Canonical conversation or Search index.")}</small>
              </div>
            </div>
            {objects.length > 1 && (
              <div className="raw-object-picker" role="list" aria-label={t("raw.sourceFiles", "Raw source files")}>
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
            <section className="raw-object-card" aria-label={t("raw.sourceMetadata", "Raw source metadata")}>
              <div>
                <strong>{selected.sourceName}</strong>
                <small>{selected.mediaType}</small>
              </div>
              <div className="raw-object-badges">
                <Badge>{t("raw.adapterBadge", "{adapter} · {version}", { adapter: selected.adapterId, version: selected.adapterVersion })}</Badge>
                <Badge tone="accent">{t("raw.generationBadge", "generation {current} / {total}", { current: selected.currentGeneration, total: selected.generationCount })}</Badge>
                <Badge tone={selected.currentFinalized ? "success" : "warning"}>
                  {selected.currentFinalized ? t("raw.finalized", "finalized") : t("raw.appending", "appending")}
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
