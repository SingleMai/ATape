import { build } from "esbuild"
import { fileURLToPath } from "node:url"

await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/index.ts"], outfile: "dist/index.js",
  bundle: true, platform: "node", format: "esm", target: "node24",
  legalComments: "eof", logLevel: "info"
})
