import { existsSync, globSync, readFileSync, statSync } from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { fromMarkdown } from "mdast-util-from-markdown"
import GithubSlugger from "github-slugger"

const repository = fileURLToPath(new URL("../", import.meta.url))
const patterns = ["AGENTS.md", "README.md", "docs/**/*.md", "apps/*/README.md", "adapters/*/README.md", "packages/*/README.md"]
const walk = (node, visit) => { visit(node); for (const child of node.children ?? []) walk(child, visit) }
const textOf = node => node.type === "html" ? "" : node.value ?? node.alt ?? (node.children ?? []).map(textOf).join("")

// One repository-facing Interface: check references and navigation without
// fetching external sites or executing any command found in a document.
export function checkDocs(root = repository) {
  root = resolve(root)
  const errors = [], documents = new Map(), packageScripts = new Map()
  const local = file => relative(root, file).split(sep).join("/")
  const parse = file => {
    if (documents.has(file)) return documents.get(file)
    const tree = fromMarkdown(readFileSync(file, "utf8")), slugger = new GithubSlugger()
    const anchors = new Set(), links = [], commands = [], definitions = new Map()
    walk(tree, node => {
      if (node.type === "definition") definitions.set(node.identifier, node.url)
      if (node.type === "heading") anchors.add(slugger.slug(textOf(node)))
      if (node.type === "html") for (const match of node.value.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) anchors.add(match[1])
    })
    walk(tree, node => {
      if (["link", "image"].includes(node.type)) links.push({ url: node.url, line: node.position.start.line })
      if (["linkReference", "imageReference"].includes(node.type) && definitions.has(node.identifier)) {
        links.push({ url: definitions.get(node.identifier), line: node.position.start.line })
      }
      if (node.type === "inlineCode" || node.type === "code" && ["sh", "bash", "shell", "zsh"].includes(node.lang)) commands.push(node.value)
    })
    const result = { anchors, links, commands }
    documents.set(file, result)
    return result
  }
  for (const file of globSync(["package.json", "apps/*/package.json", "packages/*/package.json", "adapters/*/package.json"], { cwd: root })) {
    const data = JSON.parse(readFileSync(resolve(root, file), "utf8"))
    packageScripts.set(data.name, data.scripts ?? {})
    if (file === "package.json") packageScripts.set("root", data.scripts ?? {})
  }
  const files = globSync(patterns, { cwd: root }).sort().map(file => resolve(root, file))
  let linkCount = 0, commandCount = 0
  for (const file of files) {
    const doc = parse(file)
    for (const { url, line } of doc.links) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) continue
      linkCount++
      const [pathAndQuery, fragment] = url.split("#", 2)
      let path, anchor
      try { path = decodeURIComponent(pathAndQuery.split("?", 1)[0]); anchor = fragment === undefined ? undefined : decodeURIComponent(fragment) }
      catch { errors.push(`${local(file)}:${line}: invalid URL encoding ${url}`); continue }
      const target = path ? resolve(path.startsWith("/") ? root : dirname(file), path.replace(/^\//, "")) : file
      if (!target.startsWith(root + sep) && target !== root || !existsSync(target)) {
        errors.push(`${local(file)}:${line}: missing or out-of-repository target ${url}`)
      } else if (anchor && target.endsWith(".md") && statSync(target).isFile() && !parse(target).anchors.has(anchor)) {
        errors.push(`${local(file)}:${line}: missing heading ${url}`)
      }
    }
    // Historical commands are evidence, not an executable recommendation for
    // today's checkout. Still check their links and anchors above.
    if (/^docs\/(?:releases|architecture\/adr)\//.test(local(file)) ||
      local(file) === "docs/cli/production-terminal-validation.md") continue
    for (const command of doc.commands) for (const match of command.matchAll(/(?:^|\n|&&\s*)\s*pnpm\s+(?:--filter\s+(@[\w/-]+)\s+)?([\w:.-]+)/g)) {
      const [, pkg, script] = match
      if (["install", "add", "exec", "dlx", "pack", "run", "config", "update"].includes(script) || script.startsWith("-")) continue
      commandCount++
      if (!Object.hasOwn(packageScripts.get(pkg ?? "root") ?? {}, script)) errors.push(`${local(file)}: unknown pnpm script ${pkg ?? "root"} ${script}`)
    }
  }
  const indexPath = resolve(root, "docs/README.md"), adrIndexPath = resolve(root, "docs/architecture/adr/README.md")
  for (const path of [indexPath, adrIndexPath]) if (!existsSync(path)) errors.push(`Missing documentation index ${local(path)}`)
  const indexedTargets = path => existsSync(path) ? parse(path).links.map(link => resolve(dirname(path), link.url.split("#", 1)[0])) : []
  const guideTargets = new Set(indexedTargets(indexPath)), adrTargets = indexedTargets(adrIndexPath), adrNumbers = new Set()
  for (const file of files) {
    const path = local(file)
    if (/^docs\/architecture\/adr\/\d{4}-.+\.md$/.test(path)) {
      const number = path.match(/\/(\d{4})-/)[1]
      if (adrNumbers.has(number)) errors.push(`${path}: duplicate ADR number ${number}`)
      adrNumbers.add(number)
      if (adrTargets.filter(target => target === file).length !== 1) errors.push(`${path}: expected exactly one entry in the ADR index`)
    } else if (path.startsWith("docs/") && !/^docs\/(?:releases|architecture\/adr)\//.test(path) &&
      file !== indexPath && !guideTargets.has(file)) errors.push(`${path}: missing from docs/README.md`)
  }
  return { files: files.length, links: linkCount, commands: commandCount, errors }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkDocs()
  if (result.errors.length) { console.error(result.errors.join("\n")); process.exitCode = 1 }
  else console.log(`Documentation verified: ${result.files} Markdown files, ${result.links} local links, ${result.commands} command references and complete indexes.`)
}
