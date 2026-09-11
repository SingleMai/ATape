import { CLIExperienceError } from "./cliSetupPlatform.ts"
import { ProjectSetupError, ProjectSetupGatewayError } from "./projectSetup.ts"
import { CollectorConfigurationError } from "./collectorContracts.ts"

export type ClientRecoveryAction =
  | { readonly kind: "retry" | "review" }
  | { readonly kind: "sign_in"; readonly instanceOrigin?: string }
  | { readonly kind: "update_tool"; readonly adapterId: string }

/** Presentation renders these intents without interpreting arbitrary error fields. */
export const describeClientFailure = (error: unknown): {
  readonly message: string
  readonly actions: ReadonlyArray<ClientRecoveryAction>
} => {
  const actions: ClientRecoveryAction[] = []
  let review = false
  if (error instanceof CLIExperienceError) {
    if (error.reason === "upgrade" && error.adapterId) actions.push({ kind: "update_tool", adapterId: error.adapterId })
    if (error.reason === "unauthenticated" || error.reason === "changed" && error.instanceOrigin) {
      actions.push({ kind: "sign_in", ...(error.instanceOrigin ? { instanceOrigin: error.instanceOrigin } : {}) })
    }
    review = error.reason === "changed" && !error.instanceOrigin
  } else if ((error instanceof ProjectSetupGatewayError || error instanceof CollectorConfigurationError) && error.reason === "unauthenticated") {
    actions.push({ kind: "sign_in" })
  } else if (error instanceof ProjectSetupError) {
    review = error.reason === "changed"
  }
  actions.push({ kind: review ? "review" : "retry" })
  return { message: error instanceof Error ? error.message : String(error), actions }
}
