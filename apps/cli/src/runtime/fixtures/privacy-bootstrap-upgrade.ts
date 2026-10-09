// Isolated installed-package acceptance binding for the ordinary manual npm
// upgrade Interface. Version resolution and npm acquisition are controlled by
// its caller; the production Node Adapter owns overlay preservation and install.
import { upgradeCLI } from "@atape/application"
import { Effect } from "effect"
import { defaultNodeClientPaths, makeNodeClientLayer } from "../clientLayers.ts"

const bootstrap = process.env.ATAPE_BOOTSTRAP_ENTRY
if (!bootstrap || process.env.PRIVACY_FIXTURE_BASELINE_VERSION !== "0.5.4") throw new Error("Isolated historical bootstrap metadata is required.")
const result = await Effect.runPromise(upgradeCLI("0.5.4").pipe(Effect.provide(makeNodeClientLayer(defaultNodeClientPaths()))))
if (!result.updated || result.resumed) throw new Error("The stopped historical installation must upgrade without resuming collection.")
process.stdout.write(`${JSON.stringify(result)}\n`)
