import { homedir } from "node:os"
import { ProjectLocator, ProjectLocatorError } from "@atape/application"
import { execFile } from "node:child_process"
import { stat, realpath } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { Effect, Layer } from "effect"

export const makeProjectLocatorLayer = () => Layer.succeed(ProjectLocator, ProjectLocator.of({
  locate: (inputPath, preference) => Effect.tryPromise({
    try: async (signal) => {
      const expanded = inputPath === "~" || inputPath.startsWith("~/") ? homedir() + inputPath.slice(1) : inputPath
      const requested = await realpath(resolve(expanded))
      const metadata = await stat(requested)
      if (!metadata.isDirectory()) {
        throw locatedFailure("not_directory", requested, `${requested} is not a directory.`)
      }
      const gitRoot = await findGitRoot(requested, signal)
      if (preference === "directory" && gitRoot !== undefined) {
        throw locatedFailure("not_git", requested, "This directory belongs to a Git repository. Run setup without --type directory to connect the repository.")
      }
      if (gitRoot === undefined) {
        if (preference === "git") {
          throw locatedFailure("not_git", requested, `${requested} is not inside a Git worktree.`)
        }
        return { path: requested, name: basename(requested), type: "directory" as const }
      }
      const root = await realpath(gitRoot)
      const repositoryRemote = await findGitRemote(root, signal)
      return {
        path: root,
        name: basename(root),
        type: "git" as const,
        ...(repositoryRemote === undefined ? {} : { repositoryRemote })
      }
    },
    catch: (cause) => {
      if (cause instanceof ProjectLocatorError) return cause
      if (hasCode(cause, "ENOENT")) {
        return new ProjectLocatorError({
          reason: "missing", path: inputPath, message: `${inputPath} does not exist.`
        })
      }
      return new ProjectLocatorError({
        reason: "io", path: inputPath, message: errorMessage(`Could not inspect ${inputPath}`, cause)
      })
    }
  })
}))

const findGitRoot = (path: string, signal: AbortSignal): Promise<string | undefined> => new Promise((resolveResult, reject) => {
  execFile("git", ["-C", path, "rev-parse", "--show-toplevel"], {
    signal,
    env: gitEnvironment(),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  }, (error, stdout, stderr) => {
    if (error === null) {
      resolveResult(stdout.trim())
      return
    }
    if (String(error.code) === "128" && stderr.includes("not a git repository")) resolveResult(undefined)
    else reject(error)
  })
})

const findGitRemote = (path: string, signal: AbortSignal): Promise<string | undefined> => new Promise((resolveResult, reject) => {
  execFile("git", ["-C", path, "config", "--get", "remote.origin.url"], {
    signal,
    env: gitEnvironment(),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  }, (error, stdout) => {
    if (error === null) {
      const remote = stdout.trim()
      resolveResult(remote === "" || /[\r\n\0]/.test(remote) ? undefined : remote)
      return
    }
    if (String(error.code) === "1") resolveResult(undefined)
    else reject(error)
  })
})

const gitEnvironment = () => {
  const environment = { ...process.env, LC_ALL: "C" }
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete (environment as NodeJS.ProcessEnv)[name]
  return environment
}

const locatedFailure = (
  reason: "not_directory" | "not_git",
  path: string,
  message: string
) => new ProjectLocatorError({ reason, path, message })

const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code

const errorMessage = (prefix: string, cause: unknown) =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`
