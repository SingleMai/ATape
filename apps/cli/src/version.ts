declare const __ATAPE_CLI_VERSION__: string

export const cliVersion = typeof __ATAPE_CLI_VERSION__ === "string"
  ? __ATAPE_CLI_VERSION__
  : "development"
