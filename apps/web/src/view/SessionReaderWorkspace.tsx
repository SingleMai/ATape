import type { ConversationPageRequest } from "@atape/application"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { Group, Panel, Separator, usePanelCallbackRef } from "react-resizable-panels"
import { useConversationPresenter } from "../presenters/memoryPresenter"
import { SessionReaderView, type SessionReaderProps } from "./SessionReaderView"

type Props = Omit<SessionReaderProps, "onOpenThread" | "embedded"> & {
  readonly sessionId: string
}
type ThreadTab = { readonly id: string; readonly label: string }

// Only ephemeral reading state lives here. The existing Effect presenter owns
// each thread's remote data, refresh workflow, and subscription lifetime.
export function SessionReaderWorkspace({ sessionId, ...reader }: Props) {
  const [tabs, setTabs] = useState<ReadonlyArray<ThreadTab>>([])
  const [active, setActive] = useState<string>()
  const [phase, setPhase] = useState<"closed" | "opening" | "open" | "closing">("closed")
  const [vertical, setVertical] = useState(() => window.matchMedia("(max-width: 1100px)").matches)
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  const [sidePanel, sidePanelRef] = usePanelCallbackRef()
  const sideElement = useRef<HTMLDivElement>(null)
  const size = useRef({ horizontal: 48, vertical: 52 })
  const expanded = phase === "opening" || phase === "open"
  const direction = vertical ? "vertical" : "horizontal"

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 1100px)")
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => { setVertical(compact.matches); setReducedMotion(motion.matches) }
    compact.addEventListener("change", update)
    motion.addEventListener("change", update)
    return () => { compact.removeEventListener("change", update); motion.removeEventListener("change", update) }
  }, [])

  // The library owns geometry and input handling. CSS animates its flex layout;
  // mounted tabs are released only after the closing transition has finished.
  useLayoutEffect(() => {
    if (!sidePanel) return
    if (expanded) sidePanel.resize(`${size.current[direction]}%`)
    else sidePanel.collapse()
    if (reducedMotion) {
      setPhase(expanded ? "open" : "closed")
      if (!expanded) { setTabs([]); setActive(undefined) }
    }
  }, [sidePanel, expanded, direction, reducedMotion])

  useLayoutEffect(() => {
    if (phase !== "opening" && phase !== "closing") return
    // A reversal before the first paint may have no size delta, so the browser
    // will not dispatch transitionend. Finish that case on the next frame.
    const frame = requestAnimationFrame(() => {
      if (sideElement.current?.getAnimations().some(animation => animation.playState === "running")) return
      setPhase(phase === "opening" ? "open" : "closed")
      if (phase === "closing") { setTabs([]); setActive(undefined) }
    })
    return () => cancelAnimationFrame(frame)
  }, [phase])
  const main = useRef<HTMLDivElement>(null)
  const tablist = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const focusTab = useRef(false)
  const workspaceId = useId()
  useLayoutEffect(() => {
    const element = main.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      element.style.setProperty("--reader-top", `${rect.top}px`)
      element.style.setProperty("--reader-height", `${rect.height}px`)
      element.style.setProperty("--reader-right", `${window.innerWidth - rect.right}px`)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener("resize", measure)
    measure()
    return () => { observer.disconnect(); window.removeEventListener("resize", measure) }
  }, [])
  const mainThread = reader.state._tag === "Ready" ? reader.state.value.thread.id : undefined

  useLayoutEffect(() => {
    if (focusTab.current) {
      tablist.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
      focusTab.current = false
    }
  }, [active, tabs])

  const returnToMain = () => {
    const target = opener.current?.isConnected ? opener.current : main.current
    target?.focus({ preventScroll: true })
  }
  const openThread = (id: string, label = "Thread") => {
    if (id === mainThread) { returnToMain(); return }
    if (main.current?.contains(document.activeElement)) opener.current = document.activeElement as HTMLElement
    setTabs(previous => previous.some(tab => tab.id === id) ? previous : [...previous, { id, label }])
    if (id === active) {
      tablist.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
    } else focusTab.current = true
    setActive(id)
    if (!expanded) setPhase("opening")
  }
  const closeTab = (id: string) => {
    const index = tabs.findIndex(tab => tab.id === id)
    const remaining = tabs.filter(tab => tab.id !== id)
    if (remaining.length === 0) {
      setPhase("closing")
      returnToMain()
    } else {
      setTabs(remaining)
      if (active === id) setActive(remaining[Math.min(index, remaining.length - 1)]!.id)
      focusTab.current = true
    }
  }

  return <Group className="session-reader-workspace" orientation={direction} data-direction={direction}
    data-split={phase !== "closed"} data-motion={phase} disabled={phase !== "open"}
    onLayoutChanged={(layout, meta) => {
      if (!meta.isUserInteraction) return
      const next = layout[`${workspaceId}-children`]
      if (next === undefined) return
      if (next === 0) {
        setPhase("closed"); setTabs([]); setActive(undefined); returnToMain()
      } else size.current[direction] = next
    }}>
    <Panel id={`${workspaceId}-main`} defaultSize="100%" minSize="30%" style={{ overflow: "hidden" }}>
      <div className="session-main-reader" ref={main} tabIndex={-1}>
        <div className="session-main-content"><SessionReaderView {...reader} onOpenThread={openThread} /></div>
      </div>
    </Panel>
    <Separator className="thread-separator" aria-label="Resize child conversations"
      style={{ flexBasis: 7, display: phase === "closed" ? "none" : undefined }} />
    <Panel id={`${workspaceId}-children`} panelRef={sidePanelRef} elementRef={sideElement} defaultSize="0%" minSize="28%"
      maxSize="70%" collapsible style={{ overflow: "hidden" }}
      onTransitionEnd={event => {
        if (event.target !== event.currentTarget || event.propertyName !== "flex-grow") return
        if (phase === "closing") { setPhase("closed"); setTabs([]); setActive(undefined) }
        else if (phase === "opening") setPhase("open")
      }}>
      <aside className="thread-sidebar" aria-label="Child conversations" inert={!expanded} aria-hidden={!expanded}>
        <header className="thread-sidebar-toolbar">
          <div className="thread-tabs" role="tablist" aria-label="Child conversation tabs" ref={tablist}
            onKeyDown={event => {
              if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return
              const index = tabs.findIndex(tab => tab.id === active)
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
                event.key === "ArrowRight" ? (index + 1) % tabs.length :
                event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : undefined
              if (next !== undefined) {
                event.preventDefault(); focusTab.current = true; setActive(tabs[next]!.id)
              } else if (event.key === "Delete" && active) {
                event.preventDefault(); closeTab(active)
              }
            }}>
            {tabs.map(tab => <div className="thread-tab" key={tab.id} data-active={active === tab.id} role="presentation">
              <button type="button" role="tab" id={`${workspaceId}-tab-${tab.id}`}
                aria-controls={`${workspaceId}-panel-${tab.id}`} aria-selected={active === tab.id}
                tabIndex={active === tab.id ? 0 : -1} title={tab.label}
                onClick={() => setActive(tab.id)}>{tab.label}</button>
              <button type="button" className="thread-tab-close" aria-label={`Close ${tab.label} tab`}
                onClick={() => closeTab(tab.id)}>×</button>
            </div>)}
          </div>
          <button type="button" className="quiet-icon" aria-label="Close side panel" onClick={() => {
            setPhase("closing"); returnToMain()
          }}>×</button>
        </header>
        {tabs.map(tab => <div key={tab.id} className="thread-tab-panel" role="tabpanel"
          id={`${workspaceId}-panel-${tab.id}`} aria-labelledby={`${workspaceId}-tab-${tab.id}`}
          hidden={active !== tab.id} tabIndex={0}>
          <ChildReader sessionId={sessionId} threadId={tab.id} projectName={reader.projectName}
            onOpenThread={openThread} onBack={() => closeTab(tab.id)} onOpenRaw={reader.onOpenRaw} />
        </div>)}
      </aside>
    </Panel>
  </Group>
}

function ChildReader({ sessionId, threadId, ...props }: Pick<SessionReaderProps,
  "projectName" | "onOpenThread" | "onBack" | "onOpenRaw"> & { readonly sessionId: string; readonly threadId: string }) {
  const [page, setPage] = useState<ConversationPageRequest>({})
  const restart = () => setPage({})
  const presenter = useConversationPresenter(sessionId, threadId, page, restart)
  return <SessionReaderView {...props} state={presenter.state} refresh={presenter.refresh}
    onRetry={presenter.reload} onNextPage={(head, after) => setPage({ head, after })}
    {...(page.after ? { onFirstPage: restart } : {})} embedded />
}
