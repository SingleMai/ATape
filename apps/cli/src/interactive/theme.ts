import { defaultTheme, extendTheme } from "@inkjs/ui"

// Terminal color Adapter for the cozy-island semantic palette. Keep the user's
// terminal background; Ink handles monochrome output when color is unavailable.
export const terminalTheme = {
  accent: "#54c8ad",
  border: "#237f70"
} as const

const selection = { styles: {
  focusIndicator: () => ({ color: terminalTheme.accent }),
  selectedIndicator: () => ({ color: terminalTheme.accent }),
  label: ({ isFocused, isSelected }: { isFocused: boolean; isSelected: boolean }) =>
    isFocused || isSelected ? { color: terminalTheme.accent, bold: isFocused } : {}
} }
export const controlsTheme = extendTheme(defaultTheme, { components: { Select: selection, MultiSelect: selection } })

// Each character holds two square pixels. Single-color cassette, no bitmap asset.
export const cassette = [
  "  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ",
  " █   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄   █ ",
  " █    ▄▄        ▄▄    █ ",
  " █   █  █▄▄▄▄▄▄█  █   █ ",
  " █    ▀▀        ▀▀    █ ",
  " █     ▄▀▀▀▀▀▀▀▀▄     █ ",
  "  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  "
] as const
