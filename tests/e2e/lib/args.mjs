/**
 * Shared CLI parsing for the e2e scripts.
 *
 * Every machine-specific input is a flag or an environment variable; nothing
 * user-specific is baked in. `--runtime` is the packaged runtime's launcher
 * binary, `--harness` a DeepSeek Harness checkout whose CLI builds a web
 * profile (only needed by the full-stack tests).
 */
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')

export function parseArgs(argv, { requireHarness }) {
  const opts = {
    runtime: process.env.DSH_E2E_RUNTIME,
    harness: process.env.DSH_E2E_HARNESS,
    portBase: Number(process.env.DSH_E2E_PORT_BASE ?? 3100),
    outDir: process.env.DSH_E2E_OUT ?? join(repoRoot, 'tests', 'e2e', '.artifacts', scriptName()),
    keep: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--runtime') opts.runtime = argv[++i]
    else if (a === '--harness') opts.harness = argv[++i]
    else if (a === '--port-base') opts.portBase = Number(argv[++i])
    else if (a === '--out') opts.outDir = argv[++i]
    else if (a === '--keep') opts.keep = true
    else throw new Error(`unknown e2e flag: ${a}`)
  }
  if (!opts.runtime) throw new Error('--runtime (or DSH_E2E_RUNTIME) is required: path to the packaged dsh-code-server runtime launcher')
  if (requireHarness && !opts.harness) {
    throw new Error('--harness (or DSH_E2E_HARNESS) is required: path to a DeepSeek Harness checkout')
  }
  mkdirSync(opts.outDir, { recursive: true })
  return opts
}

function scriptName() {
  const self = process.argv[1] ?? 'e2e'
  return basename(self, '.mjs')
}

/** Distinct ports for the DSH host, the code-server sidecar and the mock LLM. */
export function portsFor(portBase) {
  return { dsh: portBase, sidecar: portBase + 1, llm: portBase + 2, runtime: portBase + 3 }
}
