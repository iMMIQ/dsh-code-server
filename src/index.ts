import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { realpath, mkdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

interface HostContext {
  logger: {
    info(message: string): void
    warn(error: Error): void
  }
  workspaceRegistry: {
    list(): readonly { path: string }[]
  }
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
    }): () => void
  }
  effect(effect: () => void | (() => void | Promise<void>), label: string): void
}

const STATUS_PATH = '/dsh-code-server/status'
const OPEN_PATH = '/dsh-code-server/open'
const MAX_BODY_BYTES = 8 * 1024

export interface Config {
  executable?: string
  host?: '127.0.0.1'
  port?: number
  userDataDir?: string
  extensionsDir?: string
  startupTimeoutMs?: number
}

interface ResolvedConfig {
  executable: string
  host: '127.0.0.1'
  port: number
  userDataDir: string
  extensionsDir: string
  startupTimeoutMs: number
}

type SidecarState =
  | { phase: 'starting' }
  | { phase: 'ready' }
  | { phase: 'error'; message: string }
  | { phase: 'stopped' }

interface OpenRequest {
  path: string
  line: number
  column: number
}

interface BundledRuntimeDescriptor {
  platform?: unknown
  arch?: unknown
  version?: unknown
}

const BUNDLED_RUNTIME_DIR = fileURLToPath(new URL('../vendor/code-server/', import.meta.url))
const BUNDLED_RUNTIME_LAUNCHER = fileURLToPath(new URL('../bin/dsh-code-server-runtime', import.meta.url))
const BUNDLED_CODE_SERVER_VERSION = '4.132.0-dsh.1'

/** Prefer the platform-specific runtime shipped in a full release package. */
export function defaultCodeServerExecutable(runtimeDir = BUNDLED_RUNTIME_DIR): string {
  const executable = join(runtimeDir, 'bin', 'code-server')
  if (!existsSync(executable)) return 'code-server'

  const descriptorPath = join(runtimeDir, 'dsh-runtime.json')
  let descriptor: BundledRuntimeDescriptor
  try {
    descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as BundledRuntimeDescriptor
  } catch (reason) {
    throw new Error(`dsh-code-server: bundled runtime metadata is unreadable: ${messageOf(reason)}`)
  }
  if (descriptor.platform !== process.platform || descriptor.arch !== process.arch) {
    throw new Error(
      `dsh-code-server: bundled code-server targets ${String(descriptor.platform)}/${String(descriptor.arch)}, `
      + `but this host is ${process.platform}/${process.arch}`,
    )
  }
  if (descriptor.version !== BUNDLED_CODE_SERVER_VERSION) {
    throw new Error(
      `dsh-code-server: bundled runtime version is ${String(descriptor.version)}, `
      + `expected ${BUNDLED_CODE_SERVER_VERSION}`,
    )
  }
  if (!existsSync(BUNDLED_RUNTIME_LAUNCHER)) {
    throw new Error('dsh-code-server: bundled runtime launcher is missing')
  }
  return BUNDLED_RUNTIME_LAUNCHER
}

/** Cordis service dependencies used by the host half. */
export const inject = ['webServer', 'workspaceRegistry']

/**
 * The bundled runtime ships without lib/node, so run it on the node that is
 * already hosting DSH. All native modules in the runtime are N-API, which
 * keeps them loadable across supported node majors.
 */
function codeServerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NODE_EXEC_PATH: process.execPath }
}

function resolveConfig(config: Config = {}): ResolvedConfig {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const userDataDir = config.userDataDir ?? join(dshHome, 'code-server', 'user-data')
  const port = config.port ?? 3081
  const startupTimeoutMs = config.startupTimeoutMs ?? 20_000
  if (config.host !== undefined && config.host !== '127.0.0.1') {
    throw new Error('dsh-code-server: only the 127.0.0.1 bind is supported')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`dsh-code-server: invalid port ${String(port)}`)
  }
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1_000 || startupTimeoutMs > 120_000) {
    throw new Error(`dsh-code-server: invalid startupTimeoutMs ${String(startupTimeoutMs)}`)
  }
  return {
    executable: config.executable ?? defaultCodeServerExecutable(),
    host: '127.0.0.1',
    port,
    userDataDir,
    extensionsDir: config.extensionsDir ?? join(userDataDir, 'extensions'),
    startupTimeoutMs,
  }
}

/** Arguments shared by the long-running server and one-shot open command. */
export function commonCodeServerArgs(config: Pick<ResolvedConfig, 'userDataDir' | 'extensionsDir'>): string[] {
  return ['--user-data-dir', config.userDataDir, '--extensions-dir', config.extensionsDir]
}

/** Build the one-shot IPC command without going through a shell. */
export function openCodeServerArgs(
  config: Pick<ResolvedConfig, 'userDataDir' | 'extensionsDir'>,
  request: OpenRequest,
): string[] {
  return [...commonCodeServerArgs(config), '--reuse-window', `${request.path}:${request.line}:${request.column}`]
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Strict same-origin check for the mutating localhost control endpoint. */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return false
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' || parsed.host !== host) return false
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin'
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body must be valid JSON')
  }
}

function parseOpenRequest(value: unknown): OpenRequest {
  if (typeof value !== 'object' || value === null) throw new Error('request body must be an object')
  const row = value as Record<string, unknown>
  if (typeof row.path !== 'string' || !isAbsolute(row.path)) throw new Error('path must be absolute')
  const line = row.line ?? 1
  const column = row.column ?? 1
  if (!Number.isInteger(line) || (line as number) < 1 || (line as number) > 10_000_000) {
    throw new Error('line must be a positive integer')
  }
  if (!Number.isInteger(column) || (column as number) < 1 || (column as number) > 1_000_000) {
    throw new Error('column must be a positive integer')
  }
  return { path: row.path, line: line as number, column: column as number }
}

function contains(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel))
}

/** Resolve symlinks and reject targets outside every registered DSH workspace. */
export async function authorizeWorkspacePath(path: string, workspaceRoots: readonly string[]): Promise<string> {
  const target = await realpath(path)
  const roots = await Promise.all(workspaceRoots.map(root => realpath(root)))
  if (!roots.some(root => contains(root, target))) {
    throw new Error('path is outside the registered DSH workspaces')
  }
  return target
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

class CodeServerSidecar {
  private child: ChildProcess | undefined
  private state: SidecarState = { phase: 'stopped' }
  private startPromise: Promise<void> | undefined
  private stopping = false

  constructor(private readonly ctx: HostContext, private readonly config: ResolvedConfig) {}

  get snapshot(): SidecarState {
    return this.state
  }

  start(initialWorkspace: string | undefined): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise
    this.state = { phase: 'starting' }
    this.startPromise = this.startInner(initialWorkspace).catch((reason: unknown) => {
      this.state = { phase: 'error', message: messageOf(reason) }
      this.ctx.logger.warn(new Error(`dsh-code-server: ${messageOf(reason)}`))
      throw reason
    })
    return this.startPromise
  }

  private async startInner(initialWorkspace: string | undefined): Promise<void> {
    await Promise.all([mkdir(this.config.userDataDir, { recursive: true }), mkdir(this.config.extensionsDir, { recursive: true })])
    const args = [
      ...commonCodeServerArgs(this.config),
      '--bind-addr', `${this.config.host}:${String(this.config.port)}`,
      '--auth', 'none',
      '--disable-telemetry',
      '--disable-update-check',
      ...(initialWorkspace === undefined ? [] : [initialWorkspace]),
    ]
    const child = spawn(this.config.executable, args, { stdio: ['ignore', 'ignore', 'pipe'], env: codeServerEnv() })
    this.child = child
    child.once('error', () => {
      if (this.child === child) this.child = undefined
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text !== '') this.ctx.logger.info(`code-server: ${text}`)
    })
    child.once('exit', (code, signal) => {
      this.child = undefined
      if (!this.stopping) {
        this.state = { phase: 'error', message: `code-server exited (${code ?? signal ?? 'unknown'})` }
      }
    })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      const deadline = Date.now() + this.config.startupTimeoutMs
      const probe = async (): Promise<void> => {
        if (this.child !== child) {
          reject(new Error('code-server exited before becoming ready'))
          return
        }
        try {
          const response = await fetch(`http://${this.config.host}:${String(this.config.port)}/healthz`, {
            signal: AbortSignal.timeout(1_000),
          })
          if (response.ok) {
            resolve()
            return
          }
        } catch {
          // Expected while code-server is binding and initializing VS Code.
        }
        if (Date.now() >= deadline) {
          reject(new Error(`code-server did not become ready within ${String(this.config.startupTimeoutMs)}ms`))
          return
        }
        setTimeout(() => { void probe() }, 200)
      }
      void probe()
    })
    this.state = { phase: 'ready' }
  }

  async open(request: OpenRequest): Promise<void> {
    await this.startPromise
    if (this.state.phase !== 'ready') throw new Error('code-server is not ready')
    const child = spawn(this.config.executable, openCodeServerArgs(this.config, request), {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: codeServerEnv(),
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    const code = await waitForExit(child)
    if (code !== 0) throw new Error(stderr.trim() || `code-server open command exited with ${String(code)}`)
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (child === undefined) {
      this.state = { phase: 'stopped' }
      return
    }
    if (child.exitCode !== null) {
      this.child = undefined
      this.state = { phase: 'stopped' }
      return
    }
    child.kill('SIGTERM')
    const exited = waitForExit(child).then(() => true, () => true)
    const graceful = await Promise.race([
      exited,
      new Promise<false>(resolve => setTimeout(() => resolve(false), 3_000)),
    ])
    if (!graceful && child.exitCode === null) child.kill('SIGKILL')
    this.state = { phase: 'stopped' }
  }
}

/** Mount the loopback sidecar and DSH-origin control endpoints. */
export function apply(ctx: HostContext, rawConfig: Config = {}): void {
  const config = resolveConfig(rawConfig)
  const roots = (): string[] => ctx.workspaceRegistry.list().map(workspace => workspace.path)
  const sidecar = new CodeServerSidecar(ctx, config)
  void sidecar.start(roots()[0]).catch(() => {})

  ctx.effect(() => {
    const disposeStatus = ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const state = sidecar.snapshot
        sendJson(res, 200, {
          ...state,
          ideUrl: `http://${config.host}:${String(config.port)}`,
          workspacePath: roots()[0] ?? null,
        })
      },
    })
    const disposeOpen = ctx.webServer.register({
      kind: 'exact',
      path: OPEN_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (!isSameOriginRequest(req)) {
          sendJson(res, 403, { error: 'same-origin request required' })
          return
        }
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { error: 'application/json required' })
          return
        }
        try {
          const parsed = parseOpenRequest(await readJson(req))
          const path = await authorizeWorkspacePath(parsed.path, roots())
          await sidecar.open({ ...parsed, path })
          sendJson(res, 200, { ok: true, path })
        } catch (reason) {
          sendJson(res, 400, { error: messageOf(reason) })
        }
      },
    })
    return async () => {
      disposeOpen()
      disposeStatus()
      await sidecar.stop()
    }
  }, 'dsh-code-server: sidecar and control routes')
}
