export default {
  locales: ["en", "zh-CN"],
  input: ["src/**/*.{ts,tsx}"],
  output: "src/i18n/$LOCALE.json",
  keySeparator: false,
  namespaceSeparator: false,
  pluralSeparator: false,
  defaultNamespace: "translation",
  lexers: { ts: ["JavascriptLexer"], tsx: ["JavascriptLexer"] },
  sort: true,
  createOldCatalogs: false,
  keepRemoved: true,
  resetDefaultValueLocale: "en",
  verbose: true
}
