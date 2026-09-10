import { describe, expect, it } from "vitest"
import { matchLocale, resolveLocale } from "./locale.ts"
import { createTranslator } from "./translator.ts"

const en = {
  "greet": "Hello {name}",
  "files": "{count, plural, one {# file} other {# files}}",
  "problems.not_found": "The resource was not found."
} as const

describe("locale resolution", () => {
  it("matches exact locales and language prefixes", () => {
    expect(matchLocale("en")).toBe("en")
    expect(matchLocale("en-US")).toBe("en")
    expect(matchLocale("zh-CN")).toBe("zh-CN")
    expect(matchLocale("zh-Hans-CN")).toBe("zh-CN")
    expect(matchLocale("fr")).toBeUndefined()
  })

  it("falls back to the default locale for unknown candidates", () => {
    expect(resolveLocale(["fr", "de-DE"])).toBe("en")
    expect(resolveLocale([null, "zh-TW"])).toBe("zh-CN")
  })
})

describe("createTranslator", () => {
  it("interpolates and pluralizes ICU messages", () => {
    const translator = createTranslator({ locale: "en", catalogs: { en } })
    expect(translator.t("greet", "Hello {name}", { name: "Ada" })).toBe("Hello Ada")
    expect(translator.t("files", "{count, plural, one {# file} other {# files}}", { count: 1 })).toBe("1 file")
    expect(translator.t("files", "{count, plural, one {# file} other {# files}}", { count: 3 })).toBe("3 files")
  })

  it("falls back to English when a locale catalog is absent", () => {
    const translator = createTranslator({ locale: "zh-CN", catalogs: { en } })
    expect(translator.t("problems.not_found", "The resource was not found.")).toBe("The resource was not found.")
  })

  it("reports catalog membership without consulting fallbacks", () => {
    const translator = createTranslator({ locale: "en", catalogs: { en } })
    expect(translator.has("problems.not_found")).toBe(true)
    expect(translator.has("problems.unknown")).toBe(false)
  })

  it("formats dates and numbers with the active locale", () => {
    const translator = createTranslator({ locale: "en", catalogs: { en } })
    expect(translator.formatNumber(1234.5, { maximumFractionDigits: 1 })).toBe("1,234.5")
    expect(translator.formatDate(0, { timeZone: "UTC", year: "numeric" })).toBe("1970")
  })
})
