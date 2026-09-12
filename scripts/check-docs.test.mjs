import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { checkDocs } from "./check-docs.mjs"

const fixture = files => {
  const root = mkdtempSync(join(tmpdir(), "atape-docs-"))
  const defaults = { "package.json": JSON.stringify({ name: "atape", scripts: { check: "test" } }),
    "docs/README.md": "# Docs\n\n[Guide](guide.md)\n", "docs/architecture/adr/README.md": "# Decisions\n",
    "docs/guide.md": "# Guide\n" }
  try {
    for (const [path, content] of Object.entries({ ...defaults, ...files })) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content)
    }
    return checkDocs(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test("parses reference links, images, Unicode/duplicate headings and encoded paths; ignores code examples", () => {
  const result = fixture({
    "README.md": "[one][g]\n\n[g]: docs/guide.md#你好-code-1\n\n![asset](image%20one.svg)\n[explicit](docs/guide.md#named)\n[remote](https://invalid.example)\n\n```md\n[not a link](missing.md)\n```\n",
    "image one.svg": "<svg/>",
    "docs/guide.md": "# 你好 `code`\n\n# 你好 **code**\n\n<a id=\"named\"></a>\n\n`pnpm check`"
  })
  assert.deepEqual(result.errors, [])
  assert.equal(result.commands, 1)
})

test("reports broken links, anchors, scripts and unindexed guides/ADRs", () => {
  const { errors } = fixture({
    "README.md": "[missing](absent.md)\n[anchor](docs/guide.md#absent)\n[escape](../outside.md)\n[bad](%ZZ.md)\n\n`pnpm nonexistent`",
    "docs/new.md": "# New", "docs/architecture/adr/0001-new.md": "# Decision"
  })
  for (const message of ["absent.md", "missing heading", "out-of-repository", "invalid URL encoding", "unknown pnpm script", "missing from docs/README.md", "exactly one entry"]) {
    assert.ok(errors.some(error => error.includes(message)), `${message}: ${errors.join("\n")}`)
  }
})

test("requires one ADR entry and keeps historical commands without exempting historical links", () => {
  const { errors } = fixture({
    "docs/architecture/adr/README.md": "[one](0001-new.md) [duplicate](0001-new.md)",
    "docs/architecture/adr/0001-new.md": "# Decision\n\n`pnpm retired-script`\n[missing](missing.md)",
    "docs/releases/old.md": "# Old\n\n`pnpm retired-script`"
  })
  assert.equal(errors.length, 2)
  assert.ok(errors.some(e => e.includes("exactly one entry")))
  assert.ok(errors.some(e => e.includes("missing.md")))
})

test("rejects reused ADR numbers even when both records are indexed", () => {
  const { errors } = fixture({
    "docs/architecture/adr/README.md": "[one](0001-one.md) [two](0001-two.md)",
    "docs/architecture/adr/0001-one.md": "# One", "docs/architecture/adr/0001-two.md": "# Two"
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /duplicate ADR number 0001/)
})
