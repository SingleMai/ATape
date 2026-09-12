import { createElement as h, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react"
import { Box, Text, useInput, usePaste, useWindowSize } from "ink"
import { Select, MultiSelect, ThemeProvider } from "@inkjs/ui"
import stringWidth from "string-width"
import type { DirectorySuggestion } from "@atape/application"
import { cliVersion } from "../version.ts"
import { cassette, compactCassette, inlineCassette, controlsTheme, terminalTheme } from "./theme.ts"
import { ExperiencePresenter, safeTerminalText, type Screen } from "./presenter.ts"
import { t } from "../i18n/index.ts"

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

const terminalCell = (value: string, width: number) => {
  const safe = safeTerminalText(value)
  let cell = ""
  for (const character of characters(safe)) {
    if (stringWidth(cell + character) > width) break
    cell += character
  }
  if (stringWidth(cell) < stringWidth(safe) && width > 0) {
    while (cell && stringWidth(cell) > width - 1) cell = characters(cell).slice(0, -1).join("")
    cell += "…"
  }
  return cell + " ".repeat(Math.max(0, width - stringWidth(cell)))
}

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
  const projectBackdrop = useRef<Screen | undefined>(undefined)
  if (screen.layout === "projects") projectBackdrop.current = screen
  const modalBackdrop = screen.pathInput ? projectBackdrop.current : undefined
  // This unfinished navigation belongs to the mounted experience, not a page.
  const [browser, setBrowser] = useState<ProjectBrowserState>({ query: "", searching: false, actions: false, focused: undefined, actionIndex: 0, start: 0 })
  useInput((input, key) => {
    if (key.ctrl && input === "c") presenter.close()
    else if (screen.layout === "projects") return
    else if (key.escape && !screen.pathInput) presenter.back()
    else if (input === "r" && screen.refreshable) presenter.refresh()
    else if (input === "q" && screen.kind === "menu") presenter.close()
  })
  // Pasting into menus must never act like Enter or Space.
  usePaste(() => {})
  return h(ThemeProvider, { theme: controlsTheme, children: h(ScreenView, {
    key: screen.revision, screen, presenter, browser, setBrowser, ...(modalBackdrop ? { modalBackdrop } : {})
  }) })
}
const ScreenView = ({ screen, presenter, browser, setBrowser, modalBackdrop }: {
  screen: Screen; presenter: ExperiencePresenter; modalBackdrop?: Screen
} & BrowserBinding) => {
  const window = useWindowSize()
  const width = Math.max(1, window.columns - 4)
  const rows = Math.max(8, window.rows)
  const shellScreen = modalBackdrop ?? screen
  const projectShell = shellScreen.layout === "projects"
  const brand = shellScreen.layout === "welcome" && width >= 62 && rows >= 28 ? "full"
    : shellScreen.layout === "welcome" && width >= 36 && rows >= 18 ? "compact" : "inline"
  const headerHeight = brand === "full" ? cassette.length : brand === "compact" ? compactCassette.length : 1
  const navigationHeight = projectShell ? 1 : 0
  const contentRows = rows - headerHeight - navigationHeight - 3
  const [detailPage, setDetailPage] = useState(0)
  const details = linesWithin([...(shellScreen.notice && shellScreen.layout !== "projects" ? [shellScreen.notice] : []), ...(shellScreen.refreshError ? [shellScreen.refreshError] : []), ...shellScreen.details], width)
  const detailCapacity = Math.max(1, Math.min(projectShell ? 3 : shellScreen.title === t("cli.review.title", "Review and connect") ? 12 : 7, contentRows - (screen.pathInput ? 10 : 8)))
  const pages = Math.max(1, Math.ceil(details.length / detailCapacity))
  const page = Math.min(detailPage, pages - 1)
  const shown = details.slice(page * detailCapacity, (page + 1) * detailCapacity)
  useInput((_input, key) => {
    if (key.pageDown) setDetailPage(value => Math.min(value + 1, pages - 1))
    if (key.pageUp) setDetailPage(value => Math.max(0, value - 1))
  })
  const options = screen.options?.map(option => ({ ...option, label: safeTerminalText(option.label) })) ?? []
  const available = contentRows - shown.length - (pages > 1 ? 1 : 0)
  const optionCount = Math.max(1, Math.min(7, available - 1))
  const refreshControl = screen.refreshable ? t("cli.view.controls.refresh", " · r Refresh") : ""
  const backControl = screen.exitOnBack ? t("cli.view.exit", "Exit") : t("cli.view.back", "Back")
  const title = `${safeTerminalText(shellScreen.kind === "busy" ? shellScreen.context ?? shellScreen.title : shellScreen.title)}${shellScreen.refreshing ? t("cli.view.refreshing", " · Refreshing…") : shellScreen.layout === "projects" && shellScreen.notice ? ` · ${safeTerminalText(shellScreen.notice)}` : ""}`
  const footer = modalBackdrop ? t("cli.view.addProjectFooter", "↑↓ Select · Enter Add · Esc Close")
    : screen.layout === "projects" ? projectFooter(screen, browser, width)
    : screen.kind === "sources" ? t("cli.view.controls.sources", "↑↓ Move · Space Select · Enter Save · Esc Back · Ctrl+C Exit")
    : screen.pathInput ? t("cli.view.controls.path", "↑↓ Choose · Enter Select · Tab Edit path")
    : screen.kind === "input" ? t("cli.view.controls.input", "Enter Continue · Esc Back · Ctrl+C Exit")
    : screen.kind === "busy" ? t("cli.view.controls.busy", "Esc Cancel · Ctrl+C Exit")
    : t("cli.view.controls.menu", "↑↓ Move · Enter Select{refresh} · Esc {back} · q Exit", { refresh: refreshControl, back: backControl })
  return h(Box, { flexDirection: "column", width: window.columns, height: rows, paddingX: 1 },
    h(BrandHeader, { mode: brand, title }),
    projectShell ? h(ProjectNavigation, { screen: shellScreen, browser, width }) : null,
    h(Box, { flexDirection: "column", flexGrow: 1, borderStyle: "single", borderColor: terminalTheme.border, paddingX: 1, position: "relative" },
      ...shown.map((line, index) => h(Text, { key: index, dimColor: true, wrap: "truncate-end" }, line || " ")),
      pages > 1 ? h(Text, { color: "yellow" }, t("cli.view.pagination", "Details {page}/{pages} · PgUp/PgDn", { page: page + 1, pages })) : null,
      projectShell ? h(ProjectBrowser, { screen: shellScreen, presenter, width, browser, setBrowser, capacity: Math.max(1, available - 2), interactive: !modalBackdrop, muted: Boolean(modalBackdrop) })
      : screen.kind === "input" ? h(TextEditor, {
        initial: screen.initial ?? "", suggestions: screen.suggestions ?? [], width,
        pathInput: Boolean(screen.pathInput), loading: Boolean(screen.directoriesLoading), capacity: Math.max(1, Math.min(5, available - 3)),
        onChange: screen.pathInput ? presenter.pathChanged : () => {}, onSubmit: presenter.submit, onBack: presenter.back
      }) : screen.kind === "sources" ? h(MultiSelect, { options, defaultValue: [...screen.selected ?? []], visibleOptionCount: optionCount, onSubmit: presenter.submit })
        : screen.kind === "menu" ? h(Select, { options, visibleOptionCount: optionCount, onChange: presenter.submit })
        : h(Text, { color: terminalTheme.accent, wrap: "truncate-end" }, `${screen.title}…`),
      modalBackdrop ? h(AddProjectModal, { screen, presenter, width, rows: contentRows }) : null),
    h(Text, { dimColor: true, wrap: "truncate-end" }, footer)
  )
}

const BrandHeader = ({ mode, title }: { mode: "full" | "compact" | "inline"; title: string }) => {
  const heading = h(Text, { bold: true, wrap: "truncate-end" }, title)
  if (mode === "inline") return h(Box, null,
    h(Text, { color: terminalTheme.accent, bold: true }, `${inlineCassette} ATape · `),
    h(Box, { flexGrow: 1, flexBasis: 0 }, heading),
    h(Box, { flexShrink: 0 }, h(Text, { dimColor: true }, `v${cliVersion}`)))
  const art = mode === "full" ? cassette : compactCassette
  return h(Box, null,
    h(Box, { flexShrink: 0, marginRight: 2 }, h(Text, { color: terminalTheme.accent }, art.join("\n"))),
    h(Box, { flexDirection: "column", flexGrow: 1, flexBasis: 0 }, heading,
      h(Text, { dimColor: true }, `v${cliVersion}`)))
}

const shortActionLabel = (value: string, fallback: string) => {
  switch (value) {
    case "add": return t("cli.view.nav.add", "Add")
    case "tools": return t("cli.view.nav.tools", "Tools")
    case "settings": return t("cli.view.nav.settings", "Settings")
    case "start": return t("cli.view.nav.start", "Start")
    default: return fallback
  }
}

const ProjectNavigation = ({ screen, browser, width }: { screen: Screen; browser: ProjectBrowserState; width: number }) => {
  const allActions = screen.actions ?? []
  const actions = allActions.filter(action => action.value === "tools" || action.value === "settings")
  const currentAction = allActions[Math.min(browser.actionIndex, Math.max(0, allActions.length - 1))]
  const visible = width < 36 ? [browser.actions && actions.includes(currentAction!) ? currentAction : undefined].filter(action => action !== undefined)
    : actions
  return h(Box, { paddingLeft: 1 },
    h(Text, { backgroundColor: terminalTheme.selection, color: terminalTheme.selectionText, bold: true, underline: true }, ` ${t("cli.view.projectsTab", "Projects")} `),
    ...visible.map(action => {
      const focused = browser.actions && action.value === currentAction?.value
      return h(Text, {
        key: action.value,
        ...(focused ? { backgroundColor: terminalTheme.accent, color: terminalTheme.focusText } : {}),
        bold: focused,
        underline: focused,
        dimColor: !browser.actions
      }, `  ${safeTerminalText(width < 60 ? shortActionLabel(action.value, action.label) : action.label)}`)
    }))
}

const projectFooter = (screen: Screen, browser: ProjectBrowserState, width: number) => {
  const actions = screen.actions ?? []
  const selected = Math.min(browser.actionIndex, Math.max(0, actions.length - 1))
  if (browser.searching) return t("cli.view.searchFooter", "Type to search · Enter Open · Esc Clear · Ctrl+C Exit")
  if (browser.actions) return t("cli.view.actionsBar", "Actions: {action} · ←→ Choose · Enter Run · Tab Projects", { action: actions[selected]?.label ?? "" })
  return width < 60 ? t("cli.view.hintsNarrow", "n Add · ↑↓ Enter Open · / Find · Tab")
    : t("cli.view.hintsWide", "n Add · ↑↓ Enter Open · / Search · r Refresh · Tab Actions · q Exit")
}

const AddProjectModal = ({ screen, presenter, width, rows }: {
  screen: Screen; presenter: ExperiencePresenter; width: number; rows: number
}) => {
  const modalWidth = Math.max(26, Math.min(58, width - 2))
  const capacity = rows < 12 ? 2 : 4
  const modalHeight = capacity + 6
  return h(Box, {
    position: "absolute",
    top: Math.max(0, Math.floor((rows - modalHeight) / 2)),
    left: Math.max(0, Math.floor((width - modalWidth) / 2) - 1),
    width: modalWidth,
    flexDirection: "column",
    borderStyle: "round",
    borderColor: terminalTheme.accent,
    backgroundColor: terminalTheme.modal,
    paddingX: 1
  },
  h(Text, { bold: true, color: terminalTheme.selectionText }, t("cli.console.addProject", "Add project")),
  h(Text, { dimColor: true }, t("cli.view.projectDirectory", "Project directory")),
  h(TextEditor, {
    initial: screen.initial ?? "", suggestions: screen.suggestions ?? [], width: modalWidth - 4,
    pathInput: true, loading: Boolean(screen.directoriesLoading), capacity, escapeCloses: true,
    onChange: presenter.pathChanged, onSubmit: presenter.submit, onBack: presenter.back
  }))
}

const ProjectBrowser = ({ screen, presenter, width, capacity, browser, setBrowser, interactive = true, muted = false }: {
  screen: Screen; presenter: ExperiencePresenter; width: number; capacity: number; interactive?: boolean; muted?: boolean
} & BrowserBinding) => {
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
  usePaste(text => { if (interactive && searching) setQuery(value => (value + cleanInput(text)).slice(0, 256)) })
  useInput((input, key) => {
    if (!interactive) return
    if (key.ctrl || key.meta) return
    if (key.escape) {
      if (searching || query) update({ searching: false, query: "", start: 0 })
      else if (actions) update({ actions: false })
      else presenter.back()
      return
    }
    if (key.tab) { update({ actions: !actions, searching: false }); return }
    if (key.upArrow && !actions && index === 0) { update({ actions: true, actionIndex: 0 }); return }
    if (key.downArrow && actions) { update({ actions: false }); return }
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
    else if (input === "n") presenter.submit("add")
    else if (input === "q") presenter.close()
    else if (input === "r") presenter.refresh()
  })
  const start = Math.max(0, Math.min(index, Math.max(Math.min(browser.start, Math.max(0, options.length - capacity)), index - capacity + 1)))
  return h(Box, { flexDirection: "column", flexGrow: 1 },
    h(Text, { dimColor: muted || !searching, ...(searching && !muted ? { color: terminalTheme.accent } : {}), wrap: "truncate-end" }, searching || query ? `/ ${safeTerminalText(query)}${searching ? "▌" : ""}` : t("cli.view.projectCount", "{total} projects · / to search", { total: options.length })),
    ...(options.length ? options.slice(start, start + capacity).map(option => {
      const project = screen.projects?.find(project => project.value === option.value)
      const active = !muted && !actions && selected?.value === option.value
      const color = active ? { color: terminalTheme.accent } : {}
      const highlight = active ? { backgroundColor: terminalTheme.selection, color: terminalTheme.selectionText } : {}
      const rowWidth = Math.max(1, width - 2)
      const nameWidth = Math.max(8, Math.floor(width * 0.28))
      const teamWidth = width >= 70 ? Math.floor(width * 0.23) : 0
      const statusWidth = Math.max(1, rowWidth - 2 - nameWidth - teamWidth)
      return project ? h(Text, { key: option.value, ...highlight, dimColor: muted, wrap: "truncate-end" },
        active ? h(Text, { color: terminalTheme.accent }, "▌ ") : "  ",
        h(Text, { bold: active }, terminalCell(project.name, nameWidth)),
        teamWidth ? h(Text, { dimColor: !active }, terminalCell(project.team, teamWidth)) : null,
        terminalCell(project.status, statusWidth))
        : h(Text, { key: option.value, ...color, wrap: "truncate-end" }, `${active ? "›" : " "} ${safeTerminalText(option.label)}`)
    }) : [h(Text, { key: "empty", dimColor: true }, query
      ? t("cli.view.noMatching", "No matching projects. Esc clears search.")
      : t("cli.view.noProjects", "No projects yet. Press n to add your first project."))]),
    options.length > capacity ? h(Text, { dimColor: true }, t("cli.view.more", "{index}/{total} · ↑↓ More", { index: index + 1, total: options.length })) : null)
}

const TextEditor = ({ initial, suggestions, width, pathInput, loading, capacity, escapeCloses = false, onChange, onSubmit, onBack }: {
  initial: string; suggestions: ReadonlyArray<DirectorySuggestion>; width: number; pathInput: boolean; loading: boolean; capacity: number
  escapeCloses?: boolean
  onChange: (value: string, query?: string) => void; onSubmit: (value: string) => void; onBack: () => void
}) => {
  const [edit, setEdit] = useState(() => ({ value: cleanInput(initial), cursor: characters(cleanInput(initial)).length }))
  // -2 edits the path; -1 is the explicit Use current directory action.
  const [candidate, setCandidate] = useState(-1)
  const [query, setQuery] = useState<string | undefined>()
  const current = useRef(edit)
  const search = (value: string) => { setQuery(value); setCandidate(0); onChange(current.current.value, value) }
  const update = (value: string, cursor: number) => { setQuery(undefined); setCandidate(-2); current.current = { value, cursor }; setEdit(current.current); onChange(value) }
  const move = (cursor: number) => { current.current = { ...current.current, cursor }; setEdit(current.current) }
  const insert = (text: string) => {
    const edit = current.current
    const chars = characters(edit.value)
    const clean = cleanInput(text)
    if (pathInput && (query !== undefined || candidate !== -2)) {
      if (query === undefined && (clean.startsWith("/") || clean.startsWith("~"))) update(clean, characters(clean).length)
      else search(((query ?? "") + clean).slice(0, 256))
      return
    }
    const value = chars.slice(0, edit.cursor).join("") + clean + chars.slice(edit.cursor).join("")
    if (value.length <= 4096) update(value, edit.cursor + characters(clean).length)
  }
  usePaste(text => {
    const clean = cleanInput(text)
    if (pathInput && (clean.startsWith("/") || clean.startsWith("~"))) update(clean, characters(clean).length)
    else insert(text)
  })
  useInput((input, key) => {
    const edit = current.current
    const chars = characters(edit.value)
    if (key.escape) {
      if (escapeCloses) onBack()
      else if (pathInput && query !== undefined) { setQuery(undefined); setCandidate(-1); onChange(edit.value) }
      else if (pathInput) onBack()
      return
    }
    if (key.ctrl && input === "c") return
    if (key.return) {
      if (!pathInput || candidate === -1 && query === undefined) onSubmit(edit.value)
      else {
        if (candidate >= 0) {
          if (loading) return
          const path = suggestions[candidate]?.path
          if (!path) return
          update(path, characters(path).length)
        }
        setCandidate(-1)
      }
      return
    }
    if (pathInput && (key.upArrow || key.downArrow)) {
      setCandidate(value => Math.max(query === undefined ? -2 : 0, Math.min(Math.max(0, suggestions.length - 1), value + (key.upArrow ? -1 : 1))))
      return
    }
    if (key.tab) {
      if (pathInput) {
        if (query !== undefined) { setQuery(undefined); onChange(edit.value); setCandidate(-2) }
        else setCandidate(value => value === -2 ? -1 : -2)
      }
      return
    }
    if (query !== undefined) {
      if (key.ctrl && input === "u") search("")
      else if (key.backspace || key.delete) search(characters(query).slice(0, -1).join(""))
      else if (!key.ctrl && !key.meta && !key.leftArrow && !key.rightArrow && !key.pageDown && !key.pageUp) insert(input)
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
    pathInput && query !== undefined ? h(Text, { color: terminalTheme.accent, wrap: "truncate-end" }, escapeCloses
      ? t("cli.view.searchModal", "Search: {query}▌", { query: safeTerminalText(query) })
      : t("cli.view.search", "Search: {query}▌ · Esc Clear", { query: safeTerminalText(query) })) : null,
    h(Text, null, "> ", start ? "…" : "", chars.slice(start, edit.cursor).join(""), h(Text, { inverse: !pathInput || candidate === -2 }, chars[edit.cursor] || " "), tail),
    pathInput ? h(Box, { flexDirection: "column" },
      query === undefined ? h(Text, { ...(candidate === -1 ? { color: terminalTheme.accent, bold: true } : {}), wrap: "truncate-end" }, `${candidate === -1 ? "›" : " "} ${t("cli.view.useCurrentDirectory", "Use current directory")}`) : null,
      ...(suggestions.length === 0 ? [h(Text, { key: "directory-status", dimColor: true, wrap: "truncate-end" }, loading
        ? t("cli.view.findingFolders", "Finding folders…")
        : t("cli.view.noFolders", "No matching folders · Paste a path or Tab to edit"))] : []),
      ...suggestions.slice(first, first + capacity).map((suggestion, i) => h(Text, {
        key: suggestion.path, ...(first + i === candidate ? { color: terminalTheme.accent } : {}), wrap: "truncate-middle"
      }, `${first + i === candidate ? "›" : " "} ${suggestion.parent ? "../ · " : ""}${safeTerminalText(suggestion.path)}${suggestion.git ? " [Git]" : ""}`))) : null)

}
