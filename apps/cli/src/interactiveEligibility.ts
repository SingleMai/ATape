import type { ParsedCLI } from "./commands.ts"

export const requestsGuidedExperience = (cli: ParsedCLI) =>
  (cli.positionals.length === 0 || cli.positionals[0] === "setup" && cli.positionals.length <= 2) &&
  Object.keys(cli.options).every(key => key === "instance" || key === "noBrowser" || key === "lang")

export const supportsInteractiveExperience = (
  environment: NodeJS.ProcessEnv = process.env,
  stdin = process.stdin.isTTY,
  stdout = process.stdout.isTTY,
  platform: NodeJS.Platform = process.platform
) => Boolean(stdin && stdout && environment.TERM !== "dumb" &&
  !environment.CI && !environment.CONTINUOUS_INTEGRATION && !environment.BUILD_NUMBER &&
  (platform === "darwin" || platform === "linux"))
