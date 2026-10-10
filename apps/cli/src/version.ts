declare const __ATAPE_CLI_VERSION__: string
declare const __ATAPE_CAPTURE_STATE_CONTRACT__: string

export const cliVersion = typeof __ATAPE_CLI_VERSION__ === "string"
  ? __ATAPE_CLI_VERSION__
  : "development"

// Embedded with the executable. Reading a replaced package.json would let an
// already-running old process impersonate the newly installed runtime.
export const captureStateContract = typeof __ATAPE_CAPTURE_STATE_CONTRACT__ === "string"
  ? __ATAPE_CAPTURE_STATE_CONTRACT__
  : "atape.client.v3-capture.v2"
