#!/usr/bin/env node

import { delegateManagedRuntime } from "./runtime/runtimeLauncher.ts"
import { parseCLI } from "./commandInput.ts"

// Preserve the public parser's plain exit-2 response before reading selection
// state. Invalid input never enters bootstrap recovery or update dispatch.
let valid = true
try { parseCLI(process.argv.slice(2)) } catch { valid = false }
const delegated = valid ? await delegateManagedRuntime(process.argv[1] ?? "", process.argv.slice(2)) : undefined
if (delegated === undefined) await import("./main.ts")
else process.exitCode = delegated
