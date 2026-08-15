/**
 * Boot the full DSH stack for an e2e run, entirely from flags:
 *
 *   mock LLM ── baseURL redirect ──> dsh web (harness CLI)
 *                                    └─ dsh-code-server plugin
 *                                       └─ code-server sidecar (packaged runtime)
 *
 * The workspace and its live session are created through the public HTTP API
 * (`workspace.create`, `session.create`, `workspace.insertSessionBefore`,
 * `session.prompt`) so no first-run UI automation is needed. The activation
 * prompt proves the model path (mock LLM answers it) before the browser even
 * opens.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlm } from './mock-llm.mjs'

export const fakeApiKey = 'e2e-mock-not-a-real-key'

/** The five-error TypeScript fixture used across the suite. */
export const brokenTs = `export function greet(name: string) {
  return \`Hello, \${nam}!\`
}
export const count: number = "not a number";
export function late() {
  greet(42);
  return 1;
}
`

const waitMs = ms => new Promise(r => setTimeout(r, ms))

async function poll(label, timeoutMs, fn) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value !== undefined && value !== false) return { ok: true, value, elapsed: Date.now() - start }
    if (Date.now() - start > timeoutMs) {
      console.log(`[wait] ${label}: TIMEOUT after ${String(Date.now() - start)}ms`)
      return { ok: false, elapsed: Date.now() - start }
    }
    await waitMs(1500)
  }
}

/** Decompress a session log; empty string when missing or unreadable. */
export function zstdCat(path) {
  const r = spawnSync('zstd', ['-dc', path], { maxBuffer: 256 * 1024 * 1024 })
  return r.status === 0 ? r.stdout.toString() : ''
}

/** Locate `session.jsonl.zstd` for a session id by scanning the sessions tree. */
export function findSessionLog(home, sessionId) {
  const sessionsDir = join(home, 'sessions')
  try {
    for (const scope of readdirSync(sessionsDir)) {
      const candidate = join(sessionsDir, scope, sessionId, 'session.jsonl.zstd')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // no sessions dir yet
  }
  return null
}

export async function startDshStack({
  harnessDir,
  pluginDir,
  runtimeBin,
  baseDir,
  ports,
  outDir,
  activationSentinel,
}) {
  const home = join(baseDir, 'dsh-home')
  const ws = join(baseDir, 'ws')
  const profile = join(home, 'profiles', 'e2e')
  await mkdir(profile, { recursive: true })
  await mkdir(ws, { recursive: true })
  await writeFile(join(ws, 'broken.ts'), brokenTs)

  // settings.yaml redirects the DeepSeek adapter at the mock LLM. The fake
  // key only ever lives in the spawned process environment.
  await writeFile(join(home, 'settings.yaml'), `llm-deepseek:\n  baseURL: http://127.0.0.1:${String(ports.llm)}\n`)

  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-e2e',
        private: true,
        dependencies: { 'dsh-code-server': `link:${pluginDir}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-code-server'] } },
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    `- id: dsh-code-server\n  config:\n    executable: ${runtimeBin}\n    host: 127.0.0.1\n    port: ${String(ports.sidecar)}\n    startupTimeoutMs: 60000\n`,
  )

  const llm = await startMockLlm({ port: ports.llm, logFile: join(baseDir, 'llm-requests.jsonl') })

  const cli = join(harnessDir, 'apps', 'cli', 'lib', 'bin.js')
  const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: fakeApiKey }
  const runCli = args =>
    new Promise((resolve, reject) => {
      const p = spawn('node', [cli, ...args], { cwd: baseDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', d => {
        out += d
      })
      p.stderr.on('data', d => {
        out += d
      })
      p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`dsh ${args.join(' ')} failed:\n${out}`))))
      p.on('error', reject)
    })
  await runCli(['plugin', '--profile', 'e2e', 'add', pluginDir])

  const dshLog = []
  const dsh = spawn('node', [cli, '--profile', 'e2e', '--port', String(ports.dsh)], {
    cwd: baseDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  dsh.stdout.on('data', d => dshLog.push(d))
  dsh.stderr.on('data', d => dshLog.push(d))
  const flushDshLog = () => writeFileSync(join(outDir, 'dsh.log'), dshLog.join(''))

  const baseUrl = `http://127.0.0.1:${String(ports.dsh)}`
  const sidecarUrl = `http://127.0.0.1:${String(ports.sidecar)}`

  const up = await poll('dsh web', 90_000, async () => {
    try {
      const res = await fetch(`${baseUrl}/`)
      return res.ok
    } catch {
      return false
    }
  })
  if (!up.ok) {
    flushDshLog()
    // Surface the boot log directly: CI artifact uploads may miss hidden
    // directories, and this failure mode is otherwise undiagnosable.
    console.log(`--- dsh boot log (tail) ---\n${dshLog.join('').slice(-4000)}\n--- end dsh boot log ---`)
    throw new Error(`dsh web did not come up; see ${join(outDir, 'dsh.log')}`)
  }

  let rpcCounter = 0
  const rpc = async (method, payload) => {
    const res = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `e2e-${String(++rpcCounter)}`, method, payload }),
    })
    const body = await res.json()
    if (body?.result?.ok) return body.result.value
    throw new Error(`api ${method} failed: ${JSON.stringify(body).slice(0, 400)}`)
  }

  const { workspace } = await rpc('workspace.create', { path: ws })
  const { sessionId } = await rpc('session.create', { workspaceId: workspace.workspaceId })
  await rpc('workspace.insertSessionBefore', { workspaceId: workspace.workspaceId, sessionId })
  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: activationSentinel }],
  })

  const sessionLogText = () => {
    const p = findSessionLog(home, sessionId)
    return p === null ? '' : zstdCat(p)
  }

  // The activation turn must complete against the mock before we hand control
  // to the browser: it proves the agent is live and registered for the
  // workspace, which is exactly what the /chat route resolves.
  const activated = await poll('activation turn', 60_000, () => {
    const log = sessionLogText()
    const i = log.lastIndexOf(activationSentinel)
    return i >= 0 && log.slice(i).includes('"type":"turn/end"')
  })
  if (!activated.ok) {
    flushDshLog()
    throw new Error(`activation turn never finished; see ${join(outDir, 'dsh.log')}`)
  }

  // Status route: body-aware — the web app answers unknown paths with its SPA
  // fallback, so a bare 200 does not mean the plugin is up.
  const ready = await poll('sidecar ready', 90_000, async () => {
    try {
      const res = await fetch(`${baseUrl}/dsh-code-server/status`)
      if (!res.ok) return false
      const state = await res.json()
      return state.phase === 'ready' && state.workspacePath === ws
    } catch {
      return false
    }
  })
  if (!ready.ok) {
    flushDshLog()
    throw new Error(`sidecar never became ready; see ${join(outDir, 'dsh.log')}`)
  }

  async function stop() {
    llm.close()
    dsh.kill('SIGTERM')
    await waitMs(1500)
    // The sidecar is its own process and can outlive the DSH host; free both
    // ports deterministically. fuser kills by port, so no process-name
    // pattern that could self-match is involved.
    for (const port of [ports.dsh, ports.sidecar]) {
      spawnSync('fuser', ['-k', `${String(port)}/tcp`], { stdio: 'ignore' })
    }
    flushDshLog()
  }

  return {
    home,
    ws,
    sessionId,
    baseUrl,
    sidecarUrl,
    llm,
    sessionLogText,
    llmRequestLog: () => llm.requestLog(),
    stop,
    flushDshLog,
  }
}

/** Allocate the temp tree for one e2e run. */
export async function makeBaseDir() {
  return mkdtemp(join(tmpdir(), 'dsh-e2e-'))
}

export { poll }
