import { createElement as h, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react"
import { Box, Text, useInput, usePaste, useWindowSize } from "ink"
import { Select, MultiSelect, ThemeProvider } from "@inkjs/ui"
import stringWidth from "string-width"
import type { DirectorySuggestion } from "@atape/application"
import { cliVersion } from "../version.ts"
import { cassette, controlsTheme, terminalTheme } from "./theme.ts"
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

type ProjectBrowserState = {
  query: string
  searching: boolean
  actions: boolean
  focused: string | undefined
  actionIndex: number
  start: number
}
type BrowserBinding = {
  browser: ProjectBrowserState
  setBrowser: Dispatch<SetStateAction<ProjectBrowserState>>
}

export const ExperienceView = ({ presenter }: { presenter: ExperiencePresenter }) => {
  const screen = useSyncExternalStore(presenter.subscribe, presenter.getSnapshot)
  // This unfinished navigation belongs to the mounted experience, not a page.
  const [browser, setBrowser] = useState<ProjectBrowserState>({ query: "", searching: false, actions: false, focused: undefined, actionIndex: 0, start: 0 })
  useInput((input, key) => {
    if (key.ctrl && input === "c") presenter.close()
    else if (screen.layout === "projects") return
    else if (key.escape) presenter.back()
    else if (input === "q" && screen.kind === "menu") presenter.close()
  })
  // Pasting into menus must never act like Enter or Space.
  usePaste(() => {})
  return h(ThemeProvider, { theme: controlsTheme, children: h(ScreenView, { key: screen.revision, screen, presenter, browser, setBrowser }) })
}
const ScreenView = ({ screen, presenter, browser, setBrowser }: { screen: Screen; presenter: ExperiencePresenter } & BrowserBinding) => {
  const window = useWindowSize()
  const width = Math.max(1, window.columns - 2)
  const rows = Math.max(8, window.rows)
  const welcome = screen.layout === "welcome" && width >= 62 && rows >= 22
  const [detailPage, setDetailPage] = useState(0)
  const details = linesWithin(welcome ? [] : [...(screen.notice && screen.layout !== "projects" ? [screen.notice] : []), ...(screen.refreshError ? [screen.refreshError] : []), ...screen.details], width)
  const detailCapacity = Math.max(1, Math.min(screen.layout === "projects" ? 3 : screen.title === "Review and connect" ? 12 : 7, rows - (screen.pathInput ? 10 : 8)))
  const pages = Math.max(1, Math.ceil(details.length / detailCapacity))
  const page = Math.min(detailPage, pages - 1)
  const shown = details.slice(page * detailCapacity, (page + 1) * detailCapacity)
  useInput((_input, key) => {
    if (key.pageDown) setDetailPage(value => Math.min(value + 1, pages - 1))
    if (key.pageUp) setDetailPage(value => Math.max(0, value - 1))
  })
  const options = screen.options?.map(option => ({ ...option, label: safeTerminalText(option.label) })) ?? []
  const available = rows - shown.length - (welcome ? 13 : 4) - (pages > 1 ? 1 : 0)
  const optionCount = Math.max(1, Math.min(7, available - 1))
  return h(Box, { flexDirection: "column", width: window.columns },
    h(Text, { bold: true, color: terminalTheme.accent, wrap: "truncate-end" }, `ATape · ${safeTerminalText(screen.kind === "busy" ? screen.context ?? screen.title : screen.title)}${screen.refreshing ? " · Refreshing…" : screen.layout === "projects" && screen.notice ? ` · ${safeTerminalText(screen.notice)}` : ""}`),
    welcome ? h(Welcome, { width }) : null,
    ...shown.map((line, index) => h(Text, { key: index, dimColor: true }, line || " ")),
    pages > 1 ? h(Text, { color: "yellow" }, `Details ${page + 1}/${pages} · PgUp/PgDn`) : null,
    h(Box, { marginTop: 1, flexDirection: "column" },
      screen.layout === "projects" ? h(ProjectBrowser, { screen, presenter, width, browser, setBrowser, capacity: Math.max(1, available - 5) })
      : screen.kind === "input" ? h(TextEditor, {
        initial: screen.initial ?? "", suggestions: screen.suggestions ?? [], width,
        pathInput: Boolean(screen.pathInput), loading: Boolean(screen.directoriesLoading), capacity: Math.max(1, Math.min(5, available - 3)),
        onChange: screen.pathInput ? presenter.pathChanged : () => {}, onSubmit: presenter.submit
      }) : screen.kind === "sources" ? h(MultiSelect, { options, defaultValue: [...screen.selected ?? []], visibleOptionCount: optionCount, onSubmit: presenter.submit })
        : screen.kind === "menu" ? h(Select, { options, visibleOptionCount: optionCount, onChange: presenter.submit })
        : h(Text, { color: terminalTheme.accent, wrap: "truncate-end" }, `${screen.title}…`)),
    screen.layout === "projects" ? null : h(Text, { dimColor: true, wrap: "truncate-end" }, screen.kind === "sources"
      ? "↑↓ Move · Space Select · Enter Continue · Esc Back · Ctrl+C Exit"
      : screen.pathInput ? "↑↓ Choose · Enter Select · Tab Edit path"
      : screen.kind === "input" ? "Enter Continue · Esc Back · Ctrl+C Exit"
      : screen.kind === "busy" ? "Esc Cancel · Ctrl+C Exit"
      : "↑↓ Move · Enter Select · Esc Back · q Exit")
  )
}

const Welcome = ({ width }: { width: number }) => h(Box, {
  borderStyle: "round", borderColor: terminalTheme.border, width, paddingX: 1, marginTop: 1
}, h(Box, { width: 28, flexDirection: "column", alignItems: "center" },
  h(Text, { color: terminalTheme.accent }, cassette.join("\n")),
  h(Text, { dimColor: true }, `v${cliVersion}`)),
h(Box, { flexGrow: 1, flexBasis: 0, flexDirection: "column", justifyContent: "center", paddingLeft: 2 },
  h(Text, { color: terminalTheme.accent, bold: true }, "Your conversations, together."),
  h(Text, null, " "),
  h(Text, null, "Connect a project. Choose your sources."),
  h(Text, { dimColor: true }, "Review once, then keep your history in sync.")))

const ProjectBrowser = ({ screen, presenter, width, capacity, browser, setBrowser }: { screen: Screen; presenter: ExperiencePresenter; width: number; capacity: number } & BrowserBinding) => {
  const { query, searching, actions, focused, actionIndex } = browser
  const update = (change: Partial<ProjectBrowserState>) => setBrowser(value => ({ ...value, ...change }))
  const setQuery = (change: (value: string) => string) => setBrowser(value => ({ ...value, query: change(value.query), start: 0 }))
  const options = (screen.options ?? []).filter(option => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const found = options.findIndex(option => option.value === (focused ?? screen.focusedProject))
  const index = Math.max(0, found)
  const selected = options[index]
  const globalActions = screen.actions ?? []
  const selectedAction = Math.min(actionIndex, Math.max(0, globalActions.length - 1))
  const focus = (index: number) => {
    const option = options[index]
    update({ focused: option?.value, start: Math.max(0, Math.min(index, Math.max(start, index - capacity + 1))) })
    if (option) presenter.focusProject(option.value)
  }
  usePaste(text => { if (searching) setQuery(value => (value + cleanInput(text)).slice(0, 256)) })
  useInput((input, key) => {
    if (key.ctrl || key.meta) return
    if (key.escape) {
      if (searching || query) update({ searching: false, query: "", start: 0 })
      else if (actions) update({ actions: false })
      else presenter.back()
      return
    }
    if (key.tab) { update({ actions: !actions, searching: false }); return }
    if (key.upArrow || key.downArrow || actions && (key.leftArrow || key.rightArrow)) {
      const delta = key.upArrow || key.leftArrow ? -1 : 1
      if (actions) update({ actionIndex: Math.max(0, Math.min(globalActions.length - 1, selectedAction + delta)) })
      else focus(Math.max(0, Math.min(options.length - 1, index + delta)))
      return
    }
    if (key.return) {
      if (actions) { if (globalActions[selectedAction]) presenter.submit(globalActions[selectedAction]!.value) }
      else if (selected) { update({ focused: selected.value, searching: false, start }); presenter.focusProject(selected.value); presenter.submit(selected.value) }
      return
    }
    if (searching) {
      if (key.backspace || key.delete) setQuery(value => characters(value).slice(0, -1).join(""))
      else setQuery(value => (value + cleanInput(input)).slice(0, 256))
    } else if (input === "/") update({ searching: true, actions: false })
    else if (input === "q") presenter.close()
  })
  const start = Math.max(0, Math.min(index, Math.max(Math.min(browser.start, Math.max(0, options.length - capacity)), index - capacity + 1)))
  return h(Box, { flexDirection: "column" },
    h(Text, { dimColor: !searching, ...(searching ? { color: terminalTheme.accent } : {}), wrap: "truncate-end" }, searching || query ? `/ ${safeTerminalText(query)}${searching ? "▌" : ""}` : `${options.length} projects · / to search`),
    ...(options.length ? options.slice(start, start + capacity).map(option => {
      const project = screen.projects?.find(project => project.value === option.value)
      const active = !actions && selected?.value === option.value
      const color = active ? { color: terminalTheme.accent } : {}
      return project ? h(Box, { key: option.value },
        h(Text, color, active ? "› " : "  "),
        h(Box, { width: Math.max(8, Math.floor(width * 0.28)), paddingRight: 1 }, h(Text, { ...color, bold: active, wrap: "truncate-end" }, safeTerminalText(project.name))),
        ...(width >= 70 ? [h(Box, { key: "sources", width: Math.floor(width * 0.23), paddingRight: 1 }, h(Text, { dimColor: !active, ...color, wrap: "truncate-end" }, safeTerminalText(project.sources)))] : []),
        h(Box, { flexGrow: 1, flexBasis: 0 }, h(Text, { ...color, wrap: "truncate-end" }, project.status)))
        : h(Text, { key: option.value, ...color, wrap: "truncate-end" }, `${active ? "›" : " "} ${safeTerminalText(option.label)}`)
    }) : [h(Text, { key: "empty", dimColor: true }, "No matching projects. Esc clears search.")]),
    options.length > capacity ? h(Text, { dimColor: true }, `${index + 1}/${options.length} · ↑↓ More`) : null,
    h(Box, { marginTop: 1 }, h(Text, { wrap: "truncate-end" }, ...globalActions.map((action, i) => h(Text, {
      key: action.value, ...(actions && i === selectedAction ? { color: terminalTheme.accent } : {}),
      bold: actions && i === selectedAction, dimColor: !actions
    }, `${i ? "  ·  " : ""}${actions && i === selectedAction ? "› " : ""}${action.label}`)))),
    // The focused action remains readable even when the action bar is truncated.
    h(Text, { dimColor: true, wrap: "truncate-end" }, actions ? `Actions: ${globalActions[selectedAction]?.label} · ←→ Choose · Enter Run · Tab Projects` : (width < 60 ? "↑↓ Enter Open · / Find · Tab Actions" : "↑↓ Choose · Enter Open · / Search · Tab Actions · q Exit")))
}

const TextEditor = ({ initial, suggestions, width, pathInput, loading, capacity, onChange, onSubmit }: {
  initial: string; suggestions: ReadonlyArray<DirectorySuggestion>; width: number; pathInput: boolean; loading: boolean; capacity: number
  onChange: (value: string) => void; onSubmit: (value: string) => void
}) => {
  const [edit, setEdit] = useState(() => ({ value: cleanInput(initial), cursor: characters(cleanInput(initial)).length }))
  // -2 edits the path; -1 is the explicit Use current directory action.
  const [candidate, setCandidate] = useState(-1)
  const current = useRef(edit)
  const update = (value: string, cursor: number) => { setCandidate(-2); current.current = { value, cursor }; setEdit(current.current); onChange(value) }
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
    if (key.return) {
      if (!pathInput || candidate === -1) onSubmit(edit.value)
      else {
        if (candidate >= 0) {
          const path = suggestions[candidate]?.path
          if (!path) return
          update(path, characters(path).length)
        }
        setCandidate(-1)
      }
      return
    }
    if (pathInput && (key.upArrow || key.downArrow)) {
      setCandidate(value => Math.max(-2, Math.min(Math.max(0, suggestions.length - 1), value + (key.upArrow ? -1 : 1))))
      return
    }
    if (key.tab) {
      if (pathInput) setCandidate(value => value === -2 ? -1 : -2)
      return
    }
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
  const first = Math.max(0, candidate - capacity + 1)
  return h(Box, { flexDirection: "column" },
    h(Text, null, "> ", start ? "…" : "", chars.slice(start, edit.cursor).join(""), h(Text, { inverse: !pathInput || candidate === -2 }, chars[edit.cursor] || " "), tail),
    pathInput ? h(Box, { flexDirection: "column" },
      h(Text, { ...(candidate === -1 ? { color: terminalTheme.accent, bold: true } : {}), wrap: "truncate-end" }, `${candidate === -1 ? "›" : " "} Use current directory`),
      ...(suggestions.length === 0 ? [h(Text, { key: "directory-status", dimColor: true, wrap: "truncate-end" }, loading ? "Loading folders…" : "No matching folders · Tab to edit path")] : []),
      ...suggestions.slice(first, first + capacity).map((suggestion, i) => h(Text, {
        key: suggestion.path, ...(first + i === candidate ? { color: terminalTheme.accent } : {}), wrap: "truncate-middle"
      }, `${first + i === candidate ? "›" : " "} ${suggestion.parent ? "../ · " : ""}${safeTerminalText(suggestion.path)}${suggestion.git ? " [Git]" : ""}`))) : null)

}
