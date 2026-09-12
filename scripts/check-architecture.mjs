import { existsSync, globSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isBuiltin } from "node:module"
import { API } from "typescript/unstable/sync"
import { SyntaxKind as K } from "typescript/unstable/ast"

const repository = fileURLToPath(new URL("../", import.meta.url))
const sourceExtension = /\.[cm]?[jt]sx?$/
const testFile = /(?:^|\/)(?:fixtures|__tests__)(?:\/|$)|\.(?:test|spec|e2e|d)\.[cm]?[jt]sx?$/
const inside = (file, directory) => file.startsWith(`${directory}/`)

// The pinned TS compiler parses imports, re-exports, import types and dynamic
// imports. Regexes here classify paths; they never parse source text.
export function checkArchitecture(root = repository) {
  root = realpathSync(root)
  const local = path => relative(root, path).replaceAll("\\", "/")
  const packages = new Map()
  for (const file of globSync(["packages/*/package.json", "apps/*/package.json", "adapters/*/package.json"], { cwd: root })) {
    const metadata = JSON.parse(readFileSync(resolve(root, file), "utf8"))
    packages.set(metadata.name, { directory: dirname(file), exports: metadata.exports })
  }
  const directories = [...packages.values()].map(p => p.directory).filter(directory =>
    ["apps/cli", "apps/web"].includes(directory) || directory.startsWith("adapters/") ||
    ["packages/application", "packages/domain", "packages/ui", "packages/adapter-catalog", "packages/i18n"].includes(directory))
  const api = new API({ cwd: root })
  const errors = [], graph = new Map()
  try {
    const projects = directories.map(d => resolve(root, d, "tsconfig.json")).filter(existsSync)
    if (!projects.length) throw new Error("No governed TypeScript projects were found.")
    const snapshot = api.updateSnapshot({ openProjects: projects })
    const sources = new Map()
    for (const project of snapshot.getProjects()) {
      for (const path of project.program.getSourceFileNames()) {
        const file = local(path)
        if (!directories.some(d => inside(file, `${d}/src`)) || !sourceExtension.test(file) || testFile.test(file)) continue
        if (sources.has(file)) continue
        const diagnostics = project.program.getSyntacticDiagnostics(path)
        if (diagnostics.length) errors.push(`${file}: could not parse source (${diagnostics.length} diagnostics)`)
        const source = project.program.getSourceFile(path)
        if (!source) throw new Error(`Compiler did not return ${file}`)
        sources.set(file, source)
      }
    }
    // Detect a newly added file even if its tsconfig accidentally excludes it.
    for (const directory of directories) for (const file of globSync(`${directory}/src/**/*.{ts,tsx,mts,cts}`, { cwd: root })) {
      if (!testFile.test(file) && !sources.has(file)) errors.push(`${file}: production source is not covered by its tsconfig`)
    }
    const resolveSource = (from, specifier) => {
      let path
      if (specifier.startsWith(".") || isAbsolute(specifier)) path = resolve(root, dirname(from), specifier)
      else {
        const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]
        const pkg = packages.get(packageName)
        if (!pkg) return undefined
        const subpath = `.${specifier.slice(packageName.length)}`
        const entry = typeof pkg.exports === "string" && subpath === "." ? pkg.exports : pkg.exports?.[subpath]
        if (typeof entry !== "string") { errors.push(`${from}: unresolved workspace export ${specifier}`); return undefined }
        path = resolve(root, pkg.directory, entry)
      }
      const candidates = [path, `${path}.ts`, `${path}.tsx`, resolve(path, "index.ts"), resolve(path, "index.tsx")]
      if (/\.[cm]?js$/.test(path)) candidates.push(path.replace(/\.[cm]?js$/, ".ts"))
      const target = candidates.find(candidate => existsSync(candidate) && /\.[^/]+$/.test(candidate))
      if (!target) { errors.push(`${from}: unresolved local import ${specifier}`); return undefined }
      return local(realpathSync(target))
    }
    for (const [file, source] of sources) {
      const edges = new Set()
      graph.set(file, edges)
      const add = (specifier, runtime) => {
        const target = resolveSource(file, specifier)
        const violation = boundaryViolation(file, specifier, target)
        if (violation) errors.push(`${file} -> ${specifier}: ${violation}`)
        if (target && testFile.test(target)) errors.push(`${file} -> ${specifier}: production must not import test fixtures`)
        if (runtime && target && sources.has(target)) edges.add(target)
      }
      const visit = node => {
        if (node.kind === K.ImportDeclaration) {
          const clause = node.importClause, bindings = clause?.namedBindings
          const onlyNamedTypes = bindings?.kind === K.NamedImports && bindings.elements.length > 0 &&
            bindings.elements.every(element => element.isTypeOnly) && !clause.name
          add(node.moduleSpecifier.text, !clause?.isTypeOnly && !onlyNamedTypes)
        } else if (node.kind === K.ExportDeclaration && node.moduleSpecifier) {
          const clause = node.exportClause
          const onlyNamedTypes = clause?.kind === K.NamedExports && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly)
          add(node.moduleSpecifier.text, !node.isTypeOnly && !onlyNamedTypes)
        } else if (node.kind === K.ImportType && node.argument?.literal?.text) {
          add(node.argument.literal.text, false)
        } else if (node.kind === K.ImportEqualsDeclaration && node.moduleReference?.expression?.text) {
          add(node.moduleReference.expression.text, !node.isTypeOnly)
        } else if (node.kind === K.CallExpression && (node.expression.kind === K.ImportKeyword ||
          node.expression.kind === K.Identifier && node.expression.text === "require")) {
          const argument = node.arguments[0]
          if (argument?.kind === K.StringLiteral || argument?.kind === K.NoSubstitutionTemplateLiteral) add(argument.text, true)
          else if (file !== "apps/cli/src/runtime/adapterHost.ts") errors.push(`${file}: computed module loading is only allowed at the Adapter Host Seam`)
        }
        node.forEachChild(visit)
      }
      visit(source)
    }
    const active = new Set(), complete = new Set(), stack = []
    const visitGraph = file => {
      if (active.has(file)) { errors.push(`Runtime cycle: ${[...stack.slice(stack.indexOf(file)), file].join(" -> ")}`); return }
      if (complete.has(file)) return
      active.add(file); stack.push(file)
      for (const target of graph.get(file) ?? []) visitGraph(target)
      stack.pop(); active.delete(file); complete.add(file)
    }
    for (const file of graph.keys()) visitGraph(file)
    return { files: sources.size, errors: [...new Set(errors)] }
  } finally { api.close() }
}

function boundaryViolation(file, specifier, target) {
  if (inside(file, "apps/web")) {
    if (isBuiltin(specifier) || target?.startsWith("apps/cli/") || target?.startsWith("adapters/")) return "Web cannot import Node or provider Implementations"
    if (inside(file, "apps/web/src/view") && target?.startsWith("apps/web/src/runtime/")) return "Web views consume presenter bindings, not Browser Adapters"
    if (inside(file, "apps/web/src/runtime") && (target?.startsWith("apps/web/src/view/") || target?.startsWith("apps/web/src/presenters/"))) return "Browser Adapters cannot depend on Web Presentation"
  }
  if (inside(file, "packages/i18n")) {
    if (target ? !inside(target, "packages/i18n") : !["i18next", "i18next-icu", "intl-messageformat"].includes(specifier)) return "Shared localization cannot depend on application, presentation or platform Implementations"
  }
  if (inside(file, "packages/application")) {
    if (target ? !inside(target, "packages/application") && !inside(target, "packages/domain") && target !== "packages/adapter-catalog/src/index.ts" : specifier !== "effect") {
      return "Application depends only on its own Modules, Domain, core Effect and the pure Adapter catalog"
    }
  }
  if (inside(file, "packages/domain")) {
    if (target ? !inside(target, "packages/domain") : !["effect", "@agentclientprotocol/sdk"].includes(specifier)) return "Domain cannot depend on platform or presentation Implementations"
  }
  if (inside(file, "packages/ui")) {
    if (target ? !inside(target, "packages/ui") : !["react", "react/jsx-runtime"].includes(specifier)) return "UI contains only pure React presentation"
  }
  if (inside(file, "apps/cli") && (target?.startsWith("adapters/") || specifier.startsWith("@atape/adapter-"))) {
    if (!specifier.startsWith("@atape/adapter-catalog")) return "CLI must load provider packages through Adapter Host, not import private Adapter code"
  }
  if (inside(file, "apps/cli/src/runtime") && (target?.startsWith("apps/cli/src/interactive/") || target === "apps/cli/src/commands.ts")) {
    return "Node Implementations cannot depend on CLI Presentation"
  }
  if (inside(file, "adapters") && target?.startsWith("adapters/") && file.split("/")[1] !== target.split("/")[1]) return "Adapters cannot import another provider's private Implementation"
  if (file === "packages/adapter-catalog/src/index.ts" && (target || specifier.startsWith("node:"))) return "The shared catalog entry must remain pure"
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkArchitecture()
  if (result.errors.length) { console.error(result.errors.join("\n")); process.exitCode = 1 }
  else console.log(`Architecture boundaries and runtime cycles verified across ${result.files} production files.`)
}
