import type { CanonicalEvent } from "@atape/domain"
import { Eyebrow } from "@atape/ui"
import { fromMarkdown } from "mdast-util-from-markdown"
import { Component, createRef, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { formatDate, t } from "../i18n"

type Props = { readonly prompts: ReadonlyArray<CanonicalEvent>; readonly children: ReactNode; readonly embedded?: boolean }
type Anchor = {
  readonly promptId: string
  readonly promptTop: number
  readonly block: HTMLElement
  readonly blockTop: number
} | null
const elementFor = (id: string, root?: HTMLElement | null) => root
  ? root.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(id)}"]`)
  : document.getElementById(`event-${id}`)
const mainViewport = () => document.querySelector<HTMLElement>(".session-main-reader")
const readingLine = (viewport?: HTMLElement | null) => viewport
  ? viewport.getBoundingClientRect().top + viewport.clientHeight / 2 : window.innerHeight / 2

// Canonical prompts are ordered in the same order as the DOM. Binary search
// keeps scroll work logarithmic, even when a thread has hundreds of prompts.
const readingPrompt = (prompts: Props["prompts"], root?: HTMLElement | null, viewport?: HTMLElement | null): CanonicalEvent | undefined => {
  // A short final exchange may never reach the reading line because scrolling
  // is clamped at the document end. At the bottom, select its visible prompt.
  const last = prompts.at(-1)
  if (last && (viewport ? viewport.scrollTop > 0 && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1 : window.scrollY > 0 && document.documentElement.scrollHeight - window.scrollY - window.innerHeight <= 1)) {
    const element = elementFor(last.id, root)
    if (element && element.getBoundingClientRect().top < (viewport ? viewport.getBoundingClientRect().bottom : window.innerHeight)) return last
  }
  let low = 0
  let high = prompts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const element = elementFor(prompts[middle]!.id, root)
    if (element && element.getBoundingClientRect().top <= readingLine(viewport)) low = middle
    else high = middle - 1
  }
  return prompts[low]
}

const readingAnchor = (prompts: Props["prompts"], root?: HTMLElement | null, viewport?: HTMLElement | null): Anchor => {
  if (root && !root.getClientRects().length) return null
  const prompt = readingPrompt(prompts, root, viewport)
  const element = prompt && elementFor(prompt.id, root)
  if (!prompt || !element) return null
  let block = element
  // Preserve the visible paragraph, not just the prompt above a long response.
  // Hidden Activity blocks have no client rects and cannot become anchors.
  const candidates = element.closest(".narrative-exchange")?.querySelectorAll<HTMLElement>(
    ".narrative-markdown > *, article > header, details > summary"
  ) ?? []
  for (const candidate of candidates) {
    if (!candidate.getClientRects().length) continue
    if (candidate.getBoundingClientRect().top > readingLine(viewport)) break
    block = candidate
  }
  return { promptId: prompt.id, promptTop: element.getBoundingClientRect().top,
    block, blockTop: block.getBoundingClientRect().top }
}

// This presentation Module owns its DOM observation lifetime. React snapshots
// cover refresh commits; ResizeObserver covers later image/font/layout changes.
// Native scroll anchoring is disabled on this subtree to avoid double correction.
export class ConversationReadingFrame extends Component<Props, Record<string, never>, Anchor> {
  private readonly root = createRef<HTMLDivElement>()
  private anchor: Anchor = null
  private observer: ResizeObserver | undefined
  private frame = 0
  private get viewport() { return this.root.current?.closest<HTMLElement>(this.props.embedded ? ".thread-tab-panel" : ".session-main-reader") }
  private snapshot(prompts: Props["prompts"]) { return readingAnchor(prompts, this.root.current, this.viewport) }
  private readonly remember = () => { this.anchor = this.snapshot(this.props.prompts) }
  private readonly scheduleRemember = () => {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.remember() })
  }
  private restore(anchor: Anchor) {
    if (!anchor || !this.root.current?.getClientRects().length) return
    const block = anchor.block.isConnected ? anchor.block : elementFor(anchor.promptId, this.root.current)
    if (!block) return
    const top = anchor.block.isConnected ? anchor.blockTop : anchor.promptTop
    const delta = block.getBoundingClientRect().top - top
    if (Math.abs(delta) > 0.5) (this.viewport ?? window).scrollBy({ top: delta, behavior: "instant" })
  }
  componentDidMount() {
    this.remember();
    (this.viewport ?? window).addEventListener("scroll", this.remember, { passive: true })
    // Resize establishes a new viewport rather than fighting the user's layout.
    window.addEventListener("resize", this.scheduleRemember)
    this.observer = new ResizeObserver(() => {
      if (!this.frame) this.restore(this.anchor)
      this.remember()
    })
    if (this.root.current) this.observer.observe(this.root.current)
  }
  getSnapshotBeforeUpdate(previous: Props): Anchor { return this.snapshot(previous.prompts) }
  componentDidUpdate(_previous: Props, _state: Record<string, never>, anchor: Anchor) {
    this.restore(anchor)
    this.remember()
  }
  componentWillUnmount() {
    this.observer?.disconnect()
    cancelAnimationFrame(this.frame);
    (this.viewport ?? window).removeEventListener("scroll", this.remember)
    window.removeEventListener("resize", this.scheduleRemember)
  }
  render() {
    return <div className="conversation-reading-frame" ref={this.root}>
      {this.props.children}{!this.props.embedded && <UserMessageIndex prompts={this.props.prompts} />}
    </div>
  }
}

type MarkdownNode = {
  readonly type: string
  readonly value?: string
  readonly alt?: string | null | undefined
  readonly children?: ReadonlyArray<MarkdownNode>
}
const plainText = (node: MarkdownNode): string => {
  if (node.type === "definition") return ""
  if (node.type === "break") return " "
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? ""
  if (node.value !== undefined) return node.value
  const separator = ["root", "blockquote", "list", "listItem"].includes(node.type) ? " " : ""
  return node.children?.map(plainText).filter(Boolean).join(separator) ?? ""
}
const summaryOf = (text: string) => plainText(fromMarkdown(text)).replace(/\s+/g, " ").trim() || t("userMessages.fallback", "User message")
const timeOf = (value: string) => formatDate(new Date(value), {
  hour: "2-digit", minute: "2-digit", hour12: false
})

function UserMessageIndex({ prompts }: Pick<Props, "prompts">) {
  const items = useMemo(() => prompts.map((prompt, index) => {
    const summary = summaryOf(prompt.text)
    const time = timeOf(prompt.occurredAt)
    return { prompt, summary, time, label: t("userMessages.itemLabel", "{index}. {time} · {summary}", { index: index + 1, time, summary }) }
  }), [prompts])
  const [current, setCurrent] = useState(prompts[0]?.id)
  const [open, setOpen] = useState(false)
  const [viewport, setViewport] = useState("")
  const nav = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const mobile = useRef<HTMLButtonElement>(null)
  const animation = useRef(0)
  const glow = useRef<Animation | null>(null)
  const panelId = useId()

  useLayoutEffect(() => {
    let frame = 0
    const scrollport = mainViewport()
    const update = () => { frame = 0; setCurrent(readingPrompt(prompts, scrollport, scrollport)?.id) }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const resize = () => {
      setViewport(`${scrollport?.clientWidth ?? window.innerWidth}:${scrollport?.clientHeight ?? window.innerHeight}`)
      schedule()
    }
    const cancel = () => { cancelAnimationFrame(animation.current); animation.current = 0 }
    update()
    const scrollTarget = scrollport ?? window
    scrollTarget.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", resize)
    window.addEventListener("wheel", cancel, { passive: true })
    window.addEventListener("touchstart", cancel, { passive: true })
    window.addEventListener("keydown", cancel)
    const observer = new ResizeObserver(resize)
    const stream = document.querySelector(".conversation-stream")
    if (stream) observer.observe(stream)
    if (scrollport) observer.observe(scrollport)
    return () => {
      cancelAnimationFrame(frame)
      cancel()
      glow.current?.cancel()
      observer.disconnect()
      scrollTarget.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", resize)
      window.removeEventListener("wheel", cancel)
      window.removeEventListener("touchstart", cancel)
      window.removeEventListener("keydown", cancel)
    }
  }, [prompts])

  const positionRailNumber = () => {
    const selected = rail.current?.querySelector<HTMLElement>('[aria-current="location"]')
    if (!selected || !rail.current) return
    const top = selected.offsetTop - rail.current.scrollTop + selected.offsetHeight / 2
    nav.current?.style.setProperty("--message-index-current-top", `${top}px`)
    nav.current?.style.setProperty("--message-index-current-visibility",
      top >= 0 && top <= rail.current.clientHeight ? "visible" : "hidden")
  }

  useLayoutEffect(() => {
    // Scroll only the index viewport; scrollIntoView could move the conversation.
    for (const viewport of [rail.current, open ? list.current : null]) {
      const selected = viewport?.querySelector<HTMLElement>('[aria-current="location"]')
      if (!viewport || !selected) continue
      const top = selected.offsetTop
      if (top < viewport.scrollTop) viewport.scrollTop = top
      else if (top + selected.offsetHeight > viewport.scrollTop + viewport.clientHeight) {
        viewport.scrollTop = top + selected.offsetHeight - viewport.clientHeight
      }
    }
    positionRailNumber()
  }, [current, open, prompts.length, viewport])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !nav.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener("pointerdown", outside)
    return () => document.removeEventListener("pointerdown", outside)
  }, [open])

  if (prompts.length < 2) return null
  const currentIndex = Math.max(0, prompts.findIndex((prompt) => prompt.id === current))
  const close = () => {
    if (window.matchMedia("(max-width: 640px)").matches) mobile.current?.focus()
    else rail.current?.querySelector<HTMLButtonElement>('[aria-current="location"]')?.focus()
    setOpen(false)
  }
  const locate = (prompt: CanonicalEvent) => {
    const element = elementFor(prompt.id)
    if (!element) return
    cancelAnimationFrame(animation.current)
    glow.current?.cancel()
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const scrollport = mainViewport()
    const scrollTarget = scrollport ?? window
    const start = scrollport?.scrollTop ?? window.scrollY
    const height = scrollport?.clientHeight ?? window.innerHeight
    const top = scrollport?.getBoundingClientRect().top ?? 0
    const scrollHeight = scrollport?.scrollHeight ?? document.documentElement.scrollHeight
    const rect = element.getBoundingClientRect()
    const target = Math.max(0, Math.min(scrollHeight - height,
      start + rect.top - top + Math.min(rect.height, height) / 2 - height / 2))
    const started = performance.now()
    const step = (now: number) => {
      const progress = reduced ? 1 : Math.min(1, (now - started) / 200)
      scrollTarget.scrollTo({ top: start + (target - start) * (1 - (1 - progress) ** 3), behavior: "instant" })
      if (progress < 1) animation.current = requestAnimationFrame(step)
      else {
        animation.current = 0
        element.focus({ preventScroll: true })
        setOpen(false)
        if (!reduced) glow.current = element.animate([
          { boxShadow: "0 0 0 5px var(--atape-color-yellow)" },
          { boxShadow: "0 0 0 10px transparent" }
        ], { duration: 700, easing: "ease-out" })
      }
    }
    animation.current = requestAnimationFrame(step)
  }

  return (
    <nav className="message-index" aria-label={t("userMessages.title", "User messages")} ref={nav}
      onMouseEnter={() => { if (window.matchMedia("(hover: hover) and (min-width: 641px)").matches) setOpen(true) }}
      onMouseMove={() => { if (!open && window.matchMedia("(hover: hover) and (min-width: 641px)").matches) setOpen(true) }}
      onMouseLeave={() => { if (!nav.current?.contains(document.activeElement)) setOpen(false) }}
      onFocus={(event) => { if (event.target !== mobile.current) setOpen(true) }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); close() }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          const viewport = (event.target as HTMLElement).closest(".message-index-list, .message-index-rail")
          const buttons = Array.from(viewport?.querySelectorAll<HTMLButtonElement>("button") ?? [])
          if (!buttons.length) return
          event.preventDefault()
          const index = buttons.indexOf(event.target as HTMLButtonElement)
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
            Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
          buttons[next]?.focus()
        }
      }}>
      <span className="message-index-current-number" aria-hidden="true">{currentIndex + 1}</span>
      <div className="message-index-rail" ref={rail} onScroll={positionRailNumber}>
        {items.map(({ prompt, label }) => <button key={prompt.id} type="button"
          aria-label={label} title={label} aria-controls={panelId} aria-expanded={open}
          aria-current={prompt.id === current ? "location" : undefined} onClick={() => { setOpen(true); locate(prompt) }}>
          <span className="message-index-dot" aria-hidden="true" />
        </button>)}
      </div>
      <button className="message-index-mobile" ref={mobile} type="button" aria-expanded={open}
        aria-controls={panelId} aria-label={t("userMessages.position", "User messages: {current} of {total}", { current: currentIndex + 1, total: prompts.length })}
        onClick={() => setOpen(!open)}><span className="message-index-dot" aria-hidden="true" />{currentIndex + 1} / {prompts.length}</button>
      <div className="message-index-panel" id={panelId} inert={!open} data-open={open}>
        <header><Eyebrow>{t("userMessages.title", "User messages")}</Eyebrow><button type="button" aria-label={t("userMessages.close", "Close user messages")} onClick={close}>×</button></header>
        <div className="message-index-list" ref={list}>
          {items.map(({ prompt, label, summary, time }, index) => <button key={prompt.id} type="button"
            title={label} aria-label={label}
            aria-current={prompt.id === current ? "location" : undefined} onClick={() => locate(prompt)}>
            <span className="message-index-number">{String(index + 1).padStart(2, "0")}</span>
            <time dateTime={prompt.occurredAt}>{time}</time>
            <span className="message-index-summary">{summary}</span>
          </button>)}
        </div>
      </div>
    </nav>
  )
}
