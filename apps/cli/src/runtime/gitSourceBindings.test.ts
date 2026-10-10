import { GitSourceBindings, type GitBindingScope } from "@atape/application"
import { Effect } from "effect"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeGitSourceBindingsLayer } from "./gitSourceBindings.ts"
import { runtimeWriterFixture } from "./fixtures/runtime-writer-admission.ts"

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
const scope: GitBindingScope = { instanceOrigin: "https://atape.test", userId: "user", id: "project",
  createdAt: "2026-10-10T00:00:00Z", adapterId: "claude" }
const binding = { version: 1 as const, cwd: "/original/checkout", originKey: "origin", remote: "git@github.com:acme/project.git" }

describe("Git source bindings runtime admission through its caller Interface", () => {
  it("refuses a new binding below the floor without creating its directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "atape-binding-admission-")); homes.push(home)
    const f = await runtimeWriterFixture(home), directory = join(f.runtime.home, "bindings")
    await f.raiseFloor()
    await expect(Effect.runPromise(GitSourceBindings.use(store => store.remember(scope, "source", binding))
      .pipe(Effect.provide(makeGitSourceBindingsLayer(directory, f.runtime))))).rejects.toMatchObject({ reason: "io" })
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("leaves the first binding bytes intact and admits new evidence only from the current runtime", async () => {
    const home = await mkdtemp(join(tmpdir(), "atape-binding-admission-")); homes.push(home)
    const f = await runtimeWriterFixture(home), directory = join(f.runtime.home, "bindings")
    const run = <A, E>(program: Effect.Effect<A, E, GitSourceBindings>, runtime = f.runtime) =>
      Effect.runPromise(program.pipe(Effect.provide(makeGitSourceBindingsLayer(directory, runtime))))
    await run(GitSourceBindings.use(store => store.remember(scope, "original", binding)))
    const file = join(directory, (await readdir(directory))[0]!), before = await readFile(file)
    await f.raiseFloor()
    await expect(run(GitSourceBindings.use(store => store.remember(scope, "original", { ...binding, originKey: "replacement" }))))
      .rejects.toMatchObject({ reason: "io" })
    await expect(run(GitSourceBindings.use(store => store.remember(scope, "new", binding))))
      .rejects.toMatchObject({ reason: "io" })
    expect(await readFile(file)).toEqual(before)
    expect(await readdir(directory)).toHaveLength(1)
    expect(await run(GitSourceBindings.use(store => store.read(scope, "original")))).toEqual(binding)
    await run(GitSourceBindings.use(store => store.remember(scope, "new", binding)), f.nextRuntime)
    expect(await readdir(directory)).toHaveLength(2)
  })
})
