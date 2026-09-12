import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { checkArchitecture } from "./check-architecture.mjs"

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "atape-architecture-"))
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
  for (const directory of ["packages/application", "packages/domain", "apps/cli", "apps/web", "packages/i18n", "adapters/provider"]) {
    write(`${directory}/package.json`, JSON.stringify({ name: `@atape/${directory.split("/")[1]}`, exports: { ".": "./src/index.ts" } }))
    write(`${directory}/tsconfig.json`, JSON.stringify({ compilerOptions: { noEmit: true, module: "ESNext", target: "ESNext" }, include: ["src"] }))
    write(`${directory}/src/index.ts`, "export {}")
  }
  for (const [path, content] of Object.entries(files)) write(path, content)
  try { return checkArchitecture(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test("enforces boundaries for type imports, reexports and dynamic imports", () => {
  const { errors } = fixture({
    "packages/application/src/index.ts": `import type { Platform } from '../../../apps/cli/src/index.ts'; export type { Other } from 'node:fs'; type T = import('node:path').ParsedPath;`,
    "apps/cli/src/index.ts": `export interface Platform {}; export const load = () => import('../../../adapters/provider/src/index.ts');`
  })
  assert.equal(errors.filter(e => e.includes("Application depends")).length, 3)
  assert.ok(errors.some(e => e.includes("private Adapter code")))
})

test("reports runtime cycles but permits type cycles and ignores source-looking strings/comments", () => {
  const safe = fixture({
    "packages/application/src/index.ts": `import type { B } from './b.ts'; export type A = B; const text = "import('./missing.ts')"; // import './missing.ts'`,
    "packages/application/src/b.ts": `import { type A } from './index.ts'; export type B = {a: A};`
  })
  assert.deepEqual(safe.errors, [])
  const unsafe = fixture({
    "packages/application/src/index.ts": `export { b } from './b.ts';`,
    "packages/application/src/b.ts": `export const b = () => import('./index.ts');`
  })
  assert.ok(unsafe.errors.some(e => e.startsWith("Runtime cycle:")))
})

test("does not allow tests, unresolved imports or computed loading to bypass the check", () => {
  const { errors } = fixture({
    "packages/application/src/index.ts": `import './fixtures/fake.ts'; import './missing.ts'; const path = './x'; import(path);`,
    "packages/application/src/fixtures/fake.ts": `export {}`
  })
  assert.ok(errors.some(e => e.includes("test fixtures")))
  assert.ok(errors.some(e => e.includes("unresolved local import")))
  assert.ok(errors.some(e => e.includes("computed module loading")))
})

test("enforces Web and localization ownership without rejecting presenter bindings or assets", () => {
  assert.deepEqual(fixture({
    "apps/web/src/view/page.ts": `import type { View } from '../presenters/page.ts'; import '../style.css';`,
    "apps/web/src/presenters/page.ts": `import '../runtime/gateway.ts'; export interface View {}`,
    "apps/web/src/runtime/gateway.ts": `import '@atape/domain';`,
    "apps/web/src/style.css": `body { color: inherit; }`,
    "packages/i18n/src/index.ts": `import 'i18next'; export {};`
  }).errors, [])
  const { errors } = fixture({
    "apps/web/src/view/page.ts": `export { gateway } from '../runtime/gateway.ts'; import 'node:fs';`,
    "apps/web/src/runtime/gateway.ts": `import type { View } from '../presenters/page.ts'; export const gateway = 1;`,
    "apps/web/src/presenters/page.ts": `export interface View {}`,
    "packages/i18n/src/index.ts": `export * from '../../../apps/web/src/index.ts';`
  })
  for (const message of ["Web views", "Web cannot import Node", "Browser Adapters", "Shared localization"]) assert.ok(errors.some(e => e.includes(message)), message)
})
