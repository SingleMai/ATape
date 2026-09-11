import type { LocalProject } from "@atape/domain"
import { Effect } from "effect"
import { inspectClient } from "./clientManagement.ts"
import { ProjectSetupGateway } from "./projectSetup.ts"
import { CLIExperienceError } from "./cliSetupPlatform.ts"
import { startManagedCollector, stopManagedCollector } from "./collectorDaemon.ts"

export const currentProject = Effect.fn("CLIExperience.currentProject")(function*(expected: LocalProject) {
  const config = yield* inspectClient()
  const project = config.projects.find(item => item.instanceOrigin === expected.instanceOrigin && item.id === expected.id)
  if (!project || project.userId !== expected.userId || project.teamId !== expected.teamId || project.createdAt !== expected.createdAt) {
    return yield* changed("This Project's local registration changed. Refresh the Project list.")
  }
  return project
})
export const verifyProjectAccount = Effect.fn("CLIExperience.verifyAccount")(function*(project: LocalProject) {
  const gateway = yield* ProjectSetupGateway
  const workspace = yield* gateway.loadWorkspace(project.instanceOrigin).pipe(Effect.mapError(error =>
    error.reason === "unauthenticated"
      ? new CLIExperienceError({ reason: "unauthenticated", message: error.message, instanceOrigin: project.instanceOrigin })
      : error))
  if (workspace.user.id !== project.userId || !workspace.teams.some(team => team.id === project.teamId) ||
    !workspace.projects.some(item => item.id === project.id && item.teamId === project.teamId && item.state === "active")) {
    return yield* new CLIExperienceError({ reason: "changed", instanceOrigin: project.instanceOrigin,
      message: `Sign in to ${project.instanceOrigin} with the account that connected ${project.name} and ensure it still belongs to your Team.` })
  }
})
// Start is global. Verify every enabled registration before resuming after login.
export const startExperienceCollector = Effect.fn("CLIExperience.start")(function*() {
  const config = yield* inspectClient()
  for (const project of config.projects.filter(project => project.adapterIds.length > 0)) yield* verifyProjectAccount(project)
  return yield* startManagedCollector()
})
export const stopExperienceCollector = stopManagedCollector

const changed = (message: string) => new CLIExperienceError({ reason: "changed", message })
