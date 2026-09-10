export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: Locale = "en"

const normalize = (value: string): string => value.trim().replace(/_/g, "-").toLowerCase()

export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value)

export const matchLocale = (candidate: string | null | undefined): Locale | undefined => {
  if (candidate === null || candidate === undefined) return undefined
  const normalized = normalize(candidate)
  if (normalized === "") return undefined
  for (const locale of SUPPORTED_LOCALES) {
    if (normalize(locale) === normalized) return locale
  }
  const language = normalized.split("-")[0]
  for (const locale of SUPPORTED_LOCALES) {
    if (normalize(locale).split("-")[0] === language) return locale
  }
  return undefined
}

export const resolveLocale = (candidates: ReadonlyArray<string | null | undefined>): Locale => {
  for (const candidate of candidates) {
    const matched = matchLocale(candidate)
    if (matched !== undefined) return matched
  }
  return DEFAULT_LOCALE
}
