import type { ParsedCLI } from "./commandInput.ts"

export const requestsGuidedExperience = (cli: ParsedCLI): cli is Extract<ParsedCLI, { readonly kind: "interactive" }> =>
  cli.kind === "interactive"

export const supportsInteractiveExperience = (
  environment: NodeJS.ProcessEnv = process.env,
  stdin = process.stdin.isTTY,
  stdout = process.stdout.isTTY,
  platform: NodeJS.Platform = process.platform
) => Boolean(stdin && stdout && environment.TERM !== "dumb" &&
  !environment.CI && !environment.CONTINUOUS_INTEGRATION && !environment.BUILD_NUMBER &&
  (platform === "darwin" || platform === "linux"))
