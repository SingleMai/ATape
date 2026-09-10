import i18next from "i18next"
import ICU from "i18next-icu"
import { DEFAULT_LOCALE, type Locale } from "./locale.ts"

export type Catalog = Readonly<Record<string, string>>

export type MessageKey<TCatalog extends Catalog> = keyof TCatalog & string

export type MessageParams = Readonly<Record<string, string | number>>

export type Catalogs<TCatalog extends Catalog> = { readonly en: TCatalog } & Partial<Record<Locale, TCatalog>>

export type Translator<TCatalog extends Catalog> = {
  readonly locale: Locale
  readonly t: (key: MessageKey<TCatalog>, defaultValue?: string, params?: MessageParams) => string
  readonly has: (key: string) => key is MessageKey<TCatalog>
  readonly formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string
}

const buildResources = <TCatalog extends Catalog>(catalogs: Catalogs<TCatalog>) =>
  Object.fromEntries(
    Object.entries(catalogs).map(([locale, catalog]) => [locale, { translation: catalog }])
  )

export const createTranslator = <TCatalog extends Catalog>(input: {
  readonly locale: Locale
  readonly catalogs: Catalogs<TCatalog>
  readonly fallbackLocale?: Locale
}): Translator<TCatalog> => {
  const instance = i18next.createInstance()
  void instance.use(ICU).init({
    lng: input.locale,
    fallbackLng: input.fallbackLocale ?? DEFAULT_LOCALE,
    resources: buildResources(input.catalogs),
    initAsync: false,
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false }
  })

  const source = input.catalogs.en

  return {
    locale: input.locale,
    t: (key, defaultValue, params) => {
      const options = { ...(defaultValue === undefined ? {} : { defaultValue }), ...(params ?? {}) }
      return instance.t(key, options) as string
    },
    has: (key): key is MessageKey<TCatalog> => Object.prototype.hasOwnProperty.call(source, key),
    formatDate: (value, options) => new Intl.DateTimeFormat(input.locale, options).format(value),
    formatNumber: (value, options) => new Intl.NumberFormat(input.locale, options).format(value)
  }
}
