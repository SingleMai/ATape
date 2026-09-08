import { createElement as h, useRef, useState, useSyncExternalStore } from "react"
import { Box, Text, useInput, usePaste, useStdout } from "ink"
import { Select, MultiSelect } from "@inkjs/ui"
import stringWidth from "string-width"
import { ExperiencePresenter, safeTerminalText, type Screen } from "./presenter.ts"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const characters = (value: string) => [...segmenter.segment(value)].map(part => part.segment)
const cleanInput = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
const linesWithin = (values: ReadonlyArray<string>, width: number) => values.flatMap(value => {
  const lines: string[] = []
  let line = ""
  for (const character of characters(safeTerminalText(value))) {
    if (stringWidth(line + character) > width && line !== "") { lines.push(line); line = "" }
    line += character
  }
  lines.push(line)
  return lines
})

export const ExperienceView = ({ presenter }: { presenter: ExperiencePresenter }) => {
  const screen = useSyncExternalStore(presenter.subscribe, presenter.getSnapshot)
  useInput((input, key) => {
    if (key.ctrl && input === "c") presenter.close()
    else if (key.escape) presenter.back()
    else if (input === "q" && screen.kind === "menu") presenter.close()
  })
  // Pasting into menus must never act like Enter or Space.
  usePaste(() => {})
  return h(ScreenView, { key: screen.revision, screen, presenter })
}
const ScreenView = ({ screen, presenter }: { screen: Screen; presenter: ExperiencePresenter }) => {
  const { stdout } = useStdout()
  const width = Math.max(12, (stdout.columns || 80) - 2)
  const rows = Math.max(8, stdout.rows || 24)
  const [detailPage, setDetailPage] = useState(0)
  const details = linesWithin([...screen.details, ...(screen.refreshError ? [screen.refreshError] : [])], width)
  const detailCapacity = Math.max(1, Math.min(10, rows - 8))
  const pages = Math.max(1, Math.ceil(details.length / detailCapacity))
  const page = Math.min(detailPage, pages - 1)
  const shown = details.slice(page * detailCapacity, (page + 1) * detailCapacity)
  useInput((_input, key) => {
    if (key.pageDown) setDetailPage(value => Math.min(value + 1, pages - 1))
    if (key.pageUp) setDetailPage(value => Math.max(0, value - 1))
  })
  const options = screen.options?.map(option => ({ ...option, label: safeTerminalText(option.label) })) ?? []
  const optionCount = Math.max(1, Math.min(7, rows - shown.length - 5 - (pages > 1 ? 1 : 0)))
  return h(Box, { flexDirection: "column", width: stdout.columns || 80 },
    h(Text, { bold: true, color: "cyan", wrap: "truncate-end" }, `ATape · ${safeTerminalText(screen.title)}`),
    ...shown.map((line, index) => h(Text, { key: index, dimColor: true }, line || " ")),
    pages > 1 ? h(Text, { color: "yellow" }, `Details ${page + 1}/${pages} · PgUp/PgDn`) : null,
    screen.kind === "input" ? h(TextEditor, {
      initial: screen.initial ?? "", suggestions: screen.suggestions ?? [], width,
      onChange: screen.pathInput ? presenter.pathChanged : () => {}, onSubmit: presenter.submit
    }) : screen.kind === "sources" ? h(MultiSelect, { options, defaultValue: [...screen.selected ?? []], visibleOptionCount: optionCount, onSubmit: presenter.submit })
      : screen.kind === "menu" ? h(Select, { options, visibleOptionCount: optionCount, onChange: presenter.submit })
      : h(Text, { color: "green" }, "Working…"),
    h(Text, { dimColor: true, wrap: "truncate-end" }, screen.kind === "sources"
      ? "↑↓ Move · Space Select · Enter Continue · Esc Back · Ctrl+C Exit"
      : screen.kind === "input" ? "Enter Continue · Tab Complete · Esc Back · Ctrl+C Exit"
      : screen.kind === "busy" ? "Esc Cancel · Ctrl+C Exit"
      : "↑↓ Move · Enter Select · Esc Back · q Exit")
  )
}

const TextEditor = ({ initial, suggestions, width, onChange, onSubmit }: {
  initial: string; suggestions: ReadonlyArray<string>; width: number
  onChange: (value: string) => void; onSubmit: (value: string) => void
}) => {
  const [edit, setEdit] = useState(() => ({ value: cleanInput(initial), cursor: characters(cleanInput(initial)).length }))
  const current = useRef(edit)
  const update = (value: string, cursor: number) => { current.current = { value, cursor }; setEdit(current.current); onChange(value) }
  const move = (cursor: number) => { current.current = { ...current.current, cursor }; setEdit(current.current) }
  const insert = (text: string) => {
    const edit = current.current
    const chars = characters(edit.value)
    const clean = cleanInput(text)
    const value = chars.slice(0, edit.cursor).join("") + clean + chars.slice(edit.cursor).join("")
    if (value.length <= 4096) update(value, edit.cursor + characters(clean).length)
  }
  usePaste(insert)
  useInput((input, key) => {
    const edit = current.current
    const chars = characters(edit.value)
    if (key.escape || key.ctrl && input === "c") return
    if (key.return) { onSubmit(edit.value); return }
    if (key.tab) { if (suggestions[0]) update(suggestions[0], characters(suggestions[0]).length); return }
    if (key.leftArrow) return move(Math.max(0, edit.cursor - 1))
    if (key.rightArrow) return move(Math.min(chars.length, edit.cursor + 1))
    if (key.home || key.ctrl && input === "a") return move(0)
    if (key.end || key.ctrl && input === "e") return move(chars.length)
    if (key.ctrl && input === "u") return update(chars.slice(edit.cursor).join(""), 0)
    if (key.ctrl && input === "k") return update(chars.slice(0, edit.cursor).join(""), edit.cursor)
    if (key.backspace || key.delete) {
      const index = key.backspace ? edit.cursor - 1 : edit.cursor
      if (index >= 0 && index < chars.length) { chars.splice(index, 1); update(chars.join(""), Math.max(0, index)) }
      return
    }
    if (!key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.pageDown && !key.pageUp) insert(input)
  })
  const chars = characters(edit.value)
  let start = 0
  while (start < edit.cursor && stringWidth(chars.slice(start, edit.cursor + 1).join("")) > width - 4) start++
  let tail = chars.slice(edit.cursor + 1).join("")
  while (tail && stringWidth(chars.slice(start, edit.cursor + 1).join("") + tail) > width - 4) tail = characters(tail).slice(0, -1).join("")
  return h(Text, null, "> ", start ? "…" : "", chars.slice(start, edit.cursor).join(""),
    h(Text, { inverse: true }, chars[edit.cursor] || " "), tail)
}
