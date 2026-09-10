import {
  DEFAULT_LOCALE,
  createTranslator,
  resolveLocale,
  type Locale,
  type MessageKey,
  type MessageParams,
  type Translator
} from "@atape/i18n"
import en from "./en.json"
import zhCN from "./zh-CN.json"

export type WebCatalog = typeof en
export type WebMessageKey = MessageKey<WebCatalog>
export type WebTranslator = Translator<WebCatalog>

const catalogs = { en, "zh-CN": zhCN } as const

let active: WebTranslator = createTranslator({ locale: DEFAULT_LOCALE, catalogs })

export const initializeWebI18n = (locale: Locale): void => {
  active = createTranslator({ locale, catalogs })
}

export const currentLocale = (): Locale => active.locale

export const setWebLocale = (locale: Locale): void => {
  localStorage.setItem("atape.locale", locale)
}

export const t = (key: WebMessageKey, defaultValue?: string, params?: MessageParams): string =>
  active.t(key, defaultValue, params)

export const hasWebMessage = (key: string): key is WebMessageKey =>
  Object.prototype.hasOwnProperty.call(en, key)

export const formatDate = (value: Date | number, options?: Intl.DateTimeFormatOptions): string =>
  active.formatDate(value, options)

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
  active.formatNumber(value, options)

export const resolveWebLocale = (): Locale =>
  resolveLocale([
    typeof localStorage === "undefined" ? undefined : localStorage.getItem("atape.locale"),
    typeof navigator === "undefined" ? undefined : navigator.language
  ])
