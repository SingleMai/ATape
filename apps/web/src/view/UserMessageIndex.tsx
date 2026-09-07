import type { CanonicalEvent } from "@atape/domain"
import { Eyebrow } from "@atape/ui"
import { Component, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"

type Props = { readonly prompts: ReadonlyArray<CanonicalEvent>; readonly children: ReactNode }
type Anchor = { readonly id: string; readonly top: number } | null
const elementFor = (id: string) => document.getElementById(`event-${id}`)

// Intervals begin at a prompt and end at the next, even across long responses.
const readingAnchor = (prompts: Props["prompts"]): Anchor => {
  let anchor: Anchor = null
  for (const prompt of prompts) {
    const element = elementFor(prompt.id)
    if (!element) continue
    const top = element.getBoundingClientRect().top
    if (anchor && top > window.innerHeight / 2) break
    anchor = { id: prompt.id, top }
  }
  return anchor
}

// Capture before React changes the DOM; restore the same Canonical anchor and
// screen offset after refresh, including insertions above the reading interval.
export class ConversationReadingFrame extends Component<Props, Record<string, never>, Anchor> {
  getSnapshotBeforeUpdate(previous: Props): Anchor { return readingAnchor(previous.prompts) }
  componentDidUpdate(_previous: Props, _state: Record<string, never>, anchor: Anchor) {
    if (!anchor) return
    const element = elementFor(anchor.id)
    if (element) window.scrollBy({ top: element.getBoundingClientRect().top - anchor.top, behavior: "instant" })
  }
  render() {
    return <>{this.props.children}<UserMessageIndex prompts={this.props.prompts} /></>
  }
}

const summaryOf = (text: string) => text
  .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
  .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, "")
  .replace(/[*_~`]/g, "")
  .replace(/\s+/g, " ").trim() || "User message"
const timeOf = (value: string) => new Intl.DateTimeFormat("en", {
  hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date(value))

function UserMessageIndex({ prompts }: Pick<Props, "prompts">) {
  const [current, setCurrent] = useState(prompts[0]?.id)
  const [open, setOpen] = useState(false)
  const nav = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const mobile = useRef<HTMLButtonElement>(null)
  const animation = useRef(0)
  const glow = useRef<Animation | null>(null)
  const panelId = useId()

  useLayoutEffect(() => {
    let frame = 0
    const update = () => { frame = 0; setCurrent(readingAnchor(prompts)?.id) }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const cancel = () => { cancelAnimationFrame(animation.current); animation.current = 0 }
    update()
    window.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    window.addEventListener("wheel", cancel, { passive: true })
    window.addEventListener("touchstart", cancel, { passive: true })
    window.addEventListener("keydown", cancel)
    const observer = new ResizeObserver(schedule)
    const stream = document.querySelector(".conversation-stream")
    if (stream) observer.observe(stream)
    return () => {
      cancelAnimationFrame(frame)
      cancel()
      glow.current?.cancel()
      observer.disconnect()
      window.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
      window.removeEventListener("wheel", cancel)
      window.removeEventListener("touchstart", cancel)
      window.removeEventListener("keydown", cancel)
    }
  }, [prompts])

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
  }, [current, open])

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
    const start = window.scrollY
    const rect = element.getBoundingClientRect()
    const target = Math.max(0, Math.min(document.documentElement.scrollHeight - window.innerHeight,
      start + rect.top + Math.min(rect.height, window.innerHeight) / 2 - window.innerHeight / 2))
    const started = performance.now()
    const step = (now: number) => {
      const progress = reduced ? 1 : Math.min(1, (now - started) / 200)
      window.scrollTo({ top: start + (target - start) * (1 - (1 - progress) ** 3), behavior: "instant" })
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
  const label = (prompt: CanonicalEvent, index: number) =>
    `${index + 1}. ${timeOf(prompt.occurredAt)} · ${summaryOf(prompt.text)}`

  return (
    <nav className="message-index" aria-label="User messages" ref={nav}
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
      <div className="message-index-rail" ref={rail}>
        {prompts.map((prompt, index) => <button key={prompt.id} type="button"
          aria-label={label(prompt, index)} title={label(prompt, index)} aria-controls={panelId} aria-expanded={open}
          aria-current={prompt.id === current ? "location" : undefined} onClick={() => { setOpen(true); locate(prompt) }}>
          <span className="message-index-dot" aria-hidden="true" />
          <small aria-hidden="true">{prompt.id === current ? index + 1 : ""}</small>
        </button>)}
      </div>
      <button className="message-index-mobile" ref={mobile} type="button" aria-expanded={open}
        aria-controls={panelId} aria-label={`User messages: ${currentIndex + 1} of ${prompts.length}`}
        onClick={() => setOpen(!open)}><span className="message-index-dot" aria-hidden="true" />{currentIndex + 1} / {prompts.length}</button>
      <div className="message-index-panel" id={panelId} inert={!open} data-open={open}>
        <header><Eyebrow>User messages</Eyebrow><button type="button" aria-label="Close user messages" onClick={close}>×</button></header>
        <div className="message-index-list" ref={list}>
          {prompts.map((prompt, index) => <button key={prompt.id} type="button"
            title={label(prompt, index)} aria-label={label(prompt, index)}
            aria-current={prompt.id === current ? "location" : undefined} onClick={() => locate(prompt)}>
            <span className="message-index-number">{String(index + 1).padStart(2, "0")}</span>
            <time dateTime={prompt.occurredAt}>{timeOf(prompt.occurredAt)}</time>
            <span className="message-index-summary">{summaryOf(prompt.text)}</span>
          </button>)}
        </div>
      </div>
    </nav>
  )
}
