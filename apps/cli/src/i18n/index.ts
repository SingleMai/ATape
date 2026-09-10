import {
  DEFAULT_LOCALE,
  createTranslator,
  resolveLocale,
  type Locale,
  type MessageKey,
  type MessageParams,
  type Translator
} from "@atape/i18n"
import en from "./en.json" with { type: "json" }
import zhCN from "./zh-CN.json" with { type: "json" }

export type CliCatalog = typeof en
export type CliMessageKey = MessageKey<CliCatalog>
export type CliTranslator = Translator<CliCatalog>

const catalogs = { en, "zh-CN": zhCN }

let active: CliTranslator = createTranslator({ locale: DEFAULT_LOCALE, catalogs })

export const initializeCliI18n = (locale: Locale): void => {
  active = createTranslator({ locale, catalogs })
}

export const currentCliLocale = (): Locale => active.locale

export const t = (key: CliMessageKey, defaultValue?: string, params?: MessageParams): string =>
  active.t(key, defaultValue, params)

export const hasCliMessage = (key: string): key is CliMessageKey =>
  Object.prototype.hasOwnProperty.call(en, key)

export const formatDate = (value: Date | number, options?: Intl.DateTimeFormatOptions): string =>
  active.formatDate(value, options)

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
  active.formatNumber(value, options)

export const resolveCliLocale = (input: {
  readonly flag?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly config?: string
}): Locale =>
  resolveLocale([
    input.flag,
    input.environment?.ATAPE_LANG,
    input.config,
    input.environment?.LANG,
    input.environment?.LC_ALL
  ])
