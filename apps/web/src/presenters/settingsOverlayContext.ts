import { createContext, useContext } from "react"

export type SettingsTarget = {
  readonly section: "account" | "sessions" | "credentials" | "team"
  readonly teamSlug?: string
}

export const SettingsOverlayContext = createContext<{
  readonly target: SettingsTarget
  readonly openSettings: (target?: SettingsTarget) => void
  readonly closeSettings: () => void
}>({ target: { section: "account" }, openSettings: () => {}, closeSettings: () => {} })

export const useSettingsOverlay = () => useContext(SettingsOverlayContext)
