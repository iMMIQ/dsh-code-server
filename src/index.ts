import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Live DSH agent handle as used here: identity plus `followup` delivery. */
interface AgentLike {
  readonly id: string
  followup(message: unknown): void
}

/** Session projection carried by `session/event` broadcasts. */
interface SessionLike {
  readonly header: { readonly id: string }
}

/**
 * Narrow `session/event` envelope. Only the fields the chat bridge reads are
 * typed; unknown event types pass through untouched.
 */
interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
}

interface HostContext {
  logger: {
    info(message: string): void
    warn(error: Error): void
  }
  workspaceRegistry: {
    list(): readonly { path: string; sessionIds?: readonly string[] }[]
  }
  webServer: {
    readonly port?: number
    register(route: {
      kind: 'exact'
      path: string
      handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
    }): () => void
  }
  agents: {
    get(id: string): AgentLike | undefined
  }
  /** Subscribe to DSH session broadcasts; returns the unsubscribe function. */
  on(event: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void): () => void
  effect(effect: () => void | (() => void | Promise<void>), label: string): void
}

const STATUS_PATH = '/dsh-code-server/status'
const OPEN_PATH = '/dsh-code-server/open'
const ASK_PATH = '/dsh-code-server/ask'
const CHAT_PATH = '/dsh-code-server/chat'
const ASK_TOKEN_HEADER = 'x-dsh-ask-token'
const MAX_BODY_BYTES = 8 * 1024
/** Ask bodies embed an editor selection, so they get a larger cap than /open. */
const MAX_ASK_BODY_BYTES = 64 * 1024
const MAX_ASK_TEXT_CHARS = 32_000
/** A chat stream spans a full agent turn (tools included); allow generous room. */
const CHAT_STREAM_TIMEOUT_MS = 10 * 60_000

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
// Single source of truth for the bundled runtime version. The packaging
// script, the package.json `dsh.bundledCodeServerVersion` metadata and the
// release smoke tests all derive from (or are pinned against) this constant;
// tests/packaging.spec.ts fails the build when any of them drifts.
const BUNDLED_CODE_SERVER_VERSION = '4.132.0-dsh.6'

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
export const inject = ['webServer', 'workspaceRegistry', 'agents']

/**
 * The bundled runtime ships without lib/node, so run it on the node that is
 * already hosting DSH. All native modules in the runtime are N-API, which
 * keeps them loadable across supported node majors. `extra` carries the
 * per-launch ask-endpoint facts for the bundled workbench extension.
 */
function codeServerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, NODE_EXEC_PATH: process.execPath, ...extra }
}

const ASK_EXTENSION_ID = 'immiq.dsh-ask'
const ASK_EXTENSION_SOURCE = fileURLToPath(new URL('../extension/', import.meta.url))

/**
 * Stage the bundled workbench extension into the extensions dir. Any stale
 * version of the same extension id is removed first so an upgrade replaces
 * rather than accumulates. The server's `extensions.json` scan registry is
 * rewritten in the same pass — it is authoritative, so a directory swap alone
 * would leave the workbench loading the deleted version forever. Runs before
 * each sidecar start.
 */
export async function installAskExtension(extensionsDir: string, source = ASK_EXTENSION_SOURCE): Promise<string> {
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error('dsh-ask extension manifest has no version')
  }
  const prefix = `${ASK_EXTENSION_ID}-`
  for (const entry of await readdir(extensionsDir)) {
    if (entry.startsWith(prefix)) await rm(join(extensionsDir, entry), { recursive: true, force: true })
  }
  const target = join(extensionsDir, `${prefix}${manifest.version}`)
  await cp(source, target, { recursive: true })
  await registerScannedExtension(extensionsDir, manifest.version)
  return target
}

/** Point the authoritative `extensions.json` at the freshly staged copy. */
async function registerScannedExtension(extensionsDir: string, version: string): Promise<void> {
  const registryPath = join(extensionsDir, 'extensions.json')
  let rows: unknown[] = []
  try {
    const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as unknown
    if (Array.isArray(parsed)) rows = parsed
  } catch {
    // Missing or unreadable registry: start a fresh one.
  }
  const kept = rows.filter(row => {
    const id = (row as { identifier?: { id?: unknown } } | null)?.identifier?.id
    return typeof id !== 'string' || id.toLowerCase() !== ASK_EXTENSION_ID.toLowerCase()
  })
  kept.push({
    identifier: { id: ASK_EXTENSION_ID },
    version,
    location: { $mid: 1, path: join(extensionsDir, `${ASK_EXTENSION_ID}-${version}`), scheme: 'file' },
    relativeLocation: `${ASK_EXTENSION_ID}-${version}`,
  })
  await writeFile(registryPath, `${JSON.stringify(kept, undefined, '\t')}\n`)
}

/** Installed-extension ids the DSH profile must never carry into the workbench. */
const COPILOT_EXTENSION_ID = /^github\.copilot($|-)/i

/**
 * Workbench settings seeded into the user settings on every sidecar start.
 * The native "Local" chat-session target routes bare chat input into the
 * built-in agent host, which the dsh runtime trims away — messages sent there
 * die silently instead of reaching the DSH agent. With the local agent
 * disabled, the chat view and the inline chat fall back to the default
 * participant, which is the DSH participant this plugin installs.
 */
export const DEFAULT_WORKBENCH_SETTINGS: Readonly<Record<string, unknown>> = {
  'chat.editor.localAgent.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
}

/**
 * Merge {@link DEFAULT_WORKBENCH_SETTINGS} into the workbench user settings,
 * creating the file when absent. Missing keys only: a value the user set
 * explicitly always wins. Returns the applied keys; an unparsable (e.g.
 * JSONC-with-comments) file is left untouched so hand-edited settings survive.
 */
export async function seedWorkbenchSettings(
  userDataDir: string,
  settings: Readonly<Record<string, unknown>> = DEFAULT_WORKBENCH_SETTINGS,
): Promise<string[]> {
  const settingsPath = join(userDataDir, 'User', 'settings.json')
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') return []
  }
  const merged = { ...parsed }
  const applied: string[] = []
  for (const [key, value] of Object.entries(settings)) {
    if (!(key in merged)) {
      merged[key] = value
      applied.push(key)
    }
  }
  if (applied.length > 0) {
    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, `${JSON.stringify(merged, undefined, '\t')}\n`)
  }
  return applied
}

/**
 * Delete residual Copilot extensions from the user extensions dir. The dsh
 * runtime builds without them and its open-vsx gallery does not distribute
 * them, so any copy found here is residue from an older runtime or a manual
 * install — left in place, the workbench boots Copilot ahead of the DSH
 * agent. Both the directory and its `extensions.json` registry row go;
 * unregistered directories are matched by their `publisher.name-version`
 * layout. Returns the removed registry ids.
 */
export async function purgeCopilotExtensions(extensionsDir: string): Promise<string[]> {
  const registryPath = join(extensionsDir, 'extensions.json')
  let rows: unknown[] = []
  try {
    const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as unknown
    if (Array.isArray(parsed)) rows = parsed
  } catch {
    // Missing or unreadable registry: the directory sweep below still applies.
  }
  const removed: string[] = []
  const kept: unknown[] = []
  for (const row of rows) {
    const id = (row as { identifier?: { id?: unknown } } | null)?.identifier?.id
    if (typeof id === 'string' && COPILOT_EXTENSION_ID.test(id)) {
      removed.push(id)
      const relativeLocation = (row as { relativeLocation?: unknown } | null)?.relativeLocation
      if (
        typeof relativeLocation === 'string'
        && COPILOT_EXTENSION_ID.test(relativeLocation)
        && !relativeLocation.includes('/')
        && !relativeLocation.includes('\\')
      ) {
        // Scanner locations are direct children. Refusing nested/absolute
        // values also prevents a corrupted registry from escaping this dir.
        await rm(join(extensionsDir, relativeLocation), { recursive: true, force: true }).catch(() => undefined)
      }
    } else {
      kept.push(row)
    }
  }
  for (const entry of await readdir(extensionsDir).catch(() => [] as string[])) {
    if (COPILOT_EXTENSION_ID.test(entry)) {
      await rm(join(extensionsDir, entry), { recursive: true, force: true }).catch(() => undefined)
    }
  }
  if (removed.length > 0) await writeFile(registryPath, `${JSON.stringify(kept, undefined, '\t')}\n`)
  return removed
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

/**
 * Arguments shared by the long-running server and one-shot open command.
 * `--disable-workspace-trust` keeps the workbench out of Restricted Mode:
 * untrusted folders would exclude the builtins that decline untrusted
 * workspaces (typescript-language-features, terminal-suggest, ...) from the
 * extension host entirely, leaving the editor without diagnostics. The
 * workspace is already gated by the user's authenticated DSH session, so the
 * trust fence adds no security here.
 */
export function commonCodeServerArgs(config: Pick<ResolvedConfig, 'userDataDir' | 'extensionsDir'>): string[] {
  return ['--user-data-dir', config.userDataDir, '--extensions-dir', config.extensionsDir, '--disable-workspace-trust']
}

/** Build the one-shot IPC command without going through a shell. */
export function openCodeServerArgs(
  config: Pick<ResolvedConfig, 'userDataDir' | 'extensionsDir'>,
  request: OpenRequest,
): string[] {
  return [...commonCodeServerArgs(config), '--reuse-window', `${request.path}:${request.line}:${request.column}`]
}

/**
 * Build the folder-switch IPC command: a bare directory path. The workbench
 * reuses the window, so the folder already showing is a no-op and any other
 * folder navigates the window there.
 */
export function openFolderArgs(
  config: Pick<ResolvedConfig, 'userDataDir' | 'extensionsDir'>,
  folder: string,
): string[] {
  return [...commonCodeServerArgs(config), '--reuse-window', folder]
}

/**
 * The registered workspace root that canonically contains `path` — the
 * longest match wins when roots nest. Undefined when the path belongs to no
 * workspace (e.g. scratch files under /tmp).
 */
export async function containingWorkspaceRoot(
  path: string,
  workspaceRoots: readonly string[],
): Promise<string | undefined> {
  const target = await realpath(path)
  let best: string | undefined
  for (const root of workspaceRoots) {
    const real = await realpath(root).catch(() => undefined)
    if (real !== undefined && contains(real, target) && (best === undefined || real.length > best.length)) best = real
  }
  return best
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** The CLI's "no connected workbench" failure — retryable by contract. */
function isNoInstanceError(reason: unknown): boolean {
  return /no opened code-server instances found/i.test(messageOf(reason))
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
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

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body is too large')
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

/** A workbench ask request: composed prompt text plus the anchor file. */
export interface AskRequest {
  text: string
  file: string | undefined
}

/** Validate an ask body: non-empty bounded text, optional absolute file. */
export function parseAskRequest(value: unknown): AskRequest {
  if (typeof value !== 'object' || value === null) throw new Error('request body must be an object')
  const row = value as Record<string, unknown>
  if (typeof row.text !== 'string' || row.text.trim() === '') throw new Error('text must be a non-empty string')
  if (row.text.length > MAX_ASK_TEXT_CHARS) throw new Error(`text must be at most ${String(MAX_ASK_TEXT_CHARS)} characters`)
  if (row.file !== undefined && (typeof row.file !== 'string' || !isAbsolute(row.file))) {
    throw new Error('file must be an absolute path')
  }
  return { text: row.text, file: row.file as string | undefined }
}

/** Constant-time presentation check for the ask-route bearer token. */
export function tokensEqual(expected: string, presented: string | undefined): boolean {
  if (typeof presented !== 'string') return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(presented, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Turn-capture state machine for the chat stream. `armed` means the followup
 * has been delivered but its turn has not opened yet; the first `turn/start`
 * after delivery is the turn our message claimed (a busy session finishes its
 * current turn first — its tail is ignored because capture only opens on a
 * turn boundary). `capturing` streams assistant text until the closing
 * `turn/end`; `done` ignores everything.
 */
export type ChatCaptureState = 'armed' | 'capturing' | 'done'

/** What the route should forward to the SSE client after one event. */
export type ChatCaptureEmission =
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; callId: string; name: string; arguments: string }
  | { kind: 'toolResult'; callId: string; isError: boolean; summary: string }
  | { kind: 'done' }

/** Longest single-line tool-result tail forwarded to the chat stream. */
const CHAT_TOOL_SUMMARY_CHARS = 200

/** Collapse a tool-result text to one bounded line for the chat stream. */
export function summarizeToolResult(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= CHAT_TOOL_SUMMARY_CHARS ? collapsed : `${collapsed.slice(0, CHAT_TOOL_SUMMARY_CHARS)}…`
}

/** Narrow a `tool/result` payload into an emission; undefined when malformed. */
function toolResultEmission(data: unknown): ChatCaptureEmission | undefined {
  const row = data as {
    error?: unknown
    message?: { source?: { callId?: unknown }; content?: unknown } | null
  } | null | undefined
  const callId = row?.message?.source?.callId
  if (typeof callId !== 'string' || callId === '') return undefined
  const parts = Array.isArray(row?.message?.content) ? row.message.content : []
  let isError = row?.error !== undefined
  let text = ''
  for (const part of parts) {
    const typed = part as { type?: unknown; isError?: unknown; content?: unknown }
    if (typed?.type !== 'tool-result') continue
    if (typed.isError === true) isError = true
    const inner = Array.isArray(typed.content) ? typed.content : []
    for (const item of inner) {
      const block = item as { type?: unknown; text?: unknown }
      if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '' && text === '') text = block.text
    }
  }
  return { kind: 'toolResult', callId, isError, summary: summarizeToolResult(text) }
}

export function chatCaptureStep(state: ChatCaptureState, event: SessionEventLike): {
  state: ChatCaptureState
  emission: ChatCaptureEmission | undefined
} {
  if (state === 'armed' && event.type === 'turn/start') return { state: 'capturing', emission: undefined }
  if (state === 'capturing') {
    if (event.type === 'assistant/chunk') {
      const chunk = (event.data as { chunk?: unknown } | undefined)?.chunk
      const kind = (chunk as { type?: unknown } | undefined)?.type
      const text = (chunk as { text?: unknown } | undefined)?.text
      if (kind === 'text-delta' && typeof text === 'string' && text !== '') {
        return { state, emission: { kind: 'delta', text } }
      }
      return { state, emission: undefined }
    }
    // Tool traffic within the captured turn: the agent's tool invocations are
    // what a long turn spends its time on, so the chat client renders them as
    // progress rows instead of showing silence until the closing text.
    if (event.type === 'tool/call') {
      const data = event.data as { callId?: unknown; name?: unknown; arguments?: unknown } | undefined
      if (typeof data?.callId === 'string' && typeof data.name === 'string' && typeof data.arguments === 'string') {
        return { state, emission: { kind: 'tool', callId: data.callId, name: data.name, arguments: data.arguments } }
      }
      return { state, emission: undefined }
    }
    if (event.type === 'tool/result') {
      return { state, emission: toolResultEmission(event.data) }
    }
    if (event.type === 'turn/end') return { state: 'done', emission: { kind: 'done' } }
  }
  return { state, emission: undefined }
}

/** Workspace projection subset used to route an ask to its sessions. */
export interface AskWorkspaceLike {
  path: string
  sessionIds?: readonly string[]
}

/** Find the registered workspace that canonically contains `file`. */
export async function resolveAskWorkspace(
  file: string,
  workspaces: readonly AskWorkspaceLike[],
): Promise<AskWorkspaceLike> {
  const target = await realpath(file)
  for (const workspace of workspaces) {
    const root = await realpath(workspace.path)
    if (contains(root, target)) return workspace
  }
  throw new Error('file is outside the registered DSH workspaces')
}

/** Pick the newest session of a workspace that has a live agent. */
export function pickLiveSession(
  workspace: AskWorkspaceLike,
  get: (id: string) => AgentLike | undefined,
): AgentLike | undefined {
  const sessionIds = [...(workspace.sessionIds ?? [])].reverse()
  for (const sessionId of sessionIds) {
    const agent = get(sessionId)
    if (agent !== undefined) return agent
  }
  return undefined
}

function contains(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel))
}

/**
 * Canonicalize an open request target: any existing local path is openable.
 * The sidecar already hands the local user a full IDE over the whole
 * filesystem, so restricting the route's targets would not add real
 * protection — and chat rows legitimately point outside the registered
 * workspaces (DSH output spill, scratch files under /tmp, ...).
 */
export async function resolveOpenPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    throw new Error(`path does not exist: ${path}`)
  }
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

  start(initialWorkspace: string | undefined, extraEnv: Record<string, string> = {}): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise
    this.state = { phase: 'starting' }
    this.startPromise = this.startInner(initialWorkspace, extraEnv).catch((reason: unknown) => {
      this.state = { phase: 'error', message: messageOf(reason) }
      this.ctx.logger.warn(new Error(`dsh-code-server: ${messageOf(reason)}`))
      throw reason
    })
    return this.startPromise
  }

  private async startInner(
    initialWorkspace: string | undefined,
    extraEnv: Record<string, string>,
  ): Promise<void> {
    await Promise.all([mkdir(this.config.userDataDir, { recursive: true }), mkdir(this.config.extensionsDir, { recursive: true })])
    await installAskExtension(this.config.extensionsDir)
    const seeded = await seedWorkbenchSettings(this.config.userDataDir)
    if (seeded.length > 0) this.ctx.logger.info(`dsh-code-server: seeded workbench settings (${seeded.join(', ')})`)
    const purged = await purgeCopilotExtensions(this.config.extensionsDir)
    if (purged.length > 0) {
      this.ctx.logger.warn(new Error(`dsh-code-server: removed residual Copilot extensions (${purged.join(', ')})`))
    }
    const args = [
      ...commonCodeServerArgs(this.config),
      '--bind-addr', `${this.config.host}:${String(this.config.port)}`,
      '--auth', 'none',
      '--disable-telemetry',
      '--disable-update-check',
      ...(initialWorkspace === undefined ? [] : [initialWorkspace]),
    ]
    const child = spawn(this.config.executable, args, { stdio: ['ignore', 'ignore', 'pipe'], env: codeServerEnv(extraEnv) })
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

  /**
   * Open `request` in the workbench, first steering the window's folder to
   * `folder` when one is given. The folder command is a no-op when the window
   * already shows it, so passing the file's owning workspace on every open is
   * what keeps the explorer aligned with the conversation the row came from.
   */
  async open(request: OpenRequest, folder: string | undefined): Promise<void> {
    await this.startPromise
    if (this.state.phase !== 'ready') throw new Error('code-server is not ready')
    if (folder !== undefined) await this.runOpenCommand(openFolderArgs(this.config, folder))
    await this.runOpenCommand(openCodeServerArgs(this.config, request))
  }

  /** Switch the window's folder without opening anything (the follow spelling). */
  async openFolder(folder: string): Promise<void> {
    await this.startPromise
    if (this.state.phase !== 'ready') throw new Error('code-server is not ready')
    await this.runOpenCommand(openFolderArgs(this.config, folder))
  }

  /**
   * Run one IPC open command, retrying across the workbench's reload window.
   * Switching the window's folder reloads the browser page, and until the
   * reloaded workbench re-registers its session the CLI refuses with "no
   * opened code-server instances found" — that failure means "try again
   * later", not "give up".
   */
  private async runOpenCommand(args: string[], attempts = 24, delayMs = 750): Promise<void> {
    let last: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        await this.spawnOpen(args)
        return
      } catch (reason) {
        if (!isNoInstanceError(reason)) throw reason
        last = reason
        await new Promise(resolve => { setTimeout(resolve, delayMs) })
      }
    }
    throw last
  }

  private spawnOpen(args: string[]): Promise<void> {
    const child = spawn(this.config.executable, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: codeServerEnv(),
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    return waitForExit(child).then(code => {
      if (code !== 0) throw new Error(stderr.trim() || `code-server open command exited with ${String(code)}`)
    })
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

  // The workbench extension posts asks back over loopback; a fresh random
  // token per launch gates the route (node fetch sends no Origin header, so
  // the /open same-origin check cannot apply to it). The chat stream route
  // shares the token and origin.
  const askToken = randomUUID()
  const askPort = ctx.webServer.port
  const askEndpoint: Record<string, string> = {}
  if (typeof askPort === 'number' && askPort > 0) {
    askEndpoint.DSH_ASK_ENDPOINT = `http://127.0.0.1:${String(askPort)}${ASK_PATH}`
    askEndpoint.DSH_CHAT_ENDPOINT = `http://127.0.0.1:${String(askPort)}${CHAT_PATH}`
    askEndpoint.DSH_ASK_TOKEN = askToken
  } else {
    ctx.logger.warn(new Error('dsh-code-server: DSH web port unknown; the Ask DSH workbench command will report no endpoint'))
  }
  void sidecar.start(roots()[0], askEndpoint).catch(() => {})

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
          const path = await resolveOpenPath(parsed.path)
          // Keep the workbench's folder aligned with what is opened: a file
          // first steers the window to its owning workspace; a directory
          // request IS the follow spelling the drawer uses when the current
          // session's workspace changes.
          if (await isExistingDirectory(path)) {
            await sidecar.openFolder(path)
            sendJson(res, 200, { ok: true, path, folder: path })
          } else {
            const folder = await containingWorkspaceRoot(path, roots())
            await sidecar.open({ ...parsed, path }, folder)
            sendJson(res, 200, { ok: true, path, folder: folder ?? null })
          }
        } catch (reason) {
          sendJson(res, 400, { error: messageOf(reason) })
        }
      },
    })
    const disposeAsk = ctx.webServer.register({
      kind: 'exact',
      path: ASK_PATH,
      handler: async (req, res) => {
        const header = req.headers[ASK_TOKEN_HEADER]
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (!tokensEqual(askToken, Array.isArray(header) ? header[0] : header)) {
          sendJson(res, 403, { error: 'valid ask token required' })
          return
        }
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { error: 'application/json required' })
          return
        }
        try {
          const parsed = parseAskRequest(await readJson(req, MAX_ASK_BODY_BYTES))
          const workspaces = ctx.workspaceRegistry.list()
          if (workspaces.length === 0) {
            sendJson(res, 400, { error: 'no registered DSH workspace' })
            return
          }
          const workspace = parsed.file === undefined
            ? workspaces[0]
            : await resolveAskWorkspace(parsed.file, workspaces)
          const agent = pickLiveSession(workspace, id => ctx.agents.get(id))
          if (agent === undefined) {
            sendJson(res, 409, {
              error: `no live DSH session for workspace ${workspace.path}; open the session in DSH and retry`,
            })
            return
          }
          agent.followup(createUserMessage({
            content: [{ type: 'text', text: parsed.text }],
            source: { kind: 'user' },
          }))
          ctx.logger.info(`dsh-code-server: ask delivered to session ${agent.id}`)
          sendJson(res, 200, { ok: true, sessionId: agent.id, workspace: workspace.path })
        } catch (reason) {
          sendJson(res, 400, { error: messageOf(reason) })
        }
      },
    })
    // Chat twin of /ask: delivers the same followup but keeps the connection
    // open and streams the session's next assistant turn back as SSE, so the
    // workbench chat participant can render a live reply. Resolution and auth
    // failures are reported as plain JSON before the stream opens.
    const disposeChat = ctx.webServer.register({
      kind: 'exact',
      path: CHAT_PATH,
      handler: async (req, res) => {
        const header = req.headers[ASK_TOKEN_HEADER]
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (!tokensEqual(askToken, Array.isArray(header) ? header[0] : header)) {
          sendJson(res, 403, { error: 'valid ask token required' })
          return
        }
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { error: 'application/json required' })
          return
        }
        let parsed: AskRequest
        let agent: AgentLike
        try {
          parsed = parseAskRequest(await readJson(req, MAX_ASK_BODY_BYTES))
          const workspaces = ctx.workspaceRegistry.list()
          if (workspaces.length === 0) {
            sendJson(res, 400, { error: 'no registered DSH workspace' })
            return
          }
          const workspace = parsed.file === undefined
            ? workspaces[0]
            : await resolveAskWorkspace(parsed.file, workspaces)
          const resolved = pickLiveSession(workspace, id => ctx.agents.get(id))
          if (resolved === undefined) {
            sendJson(res, 409, {
              error: `no live DSH session for workspace ${workspace.path}; open the session in DSH and retry`,
            })
            return
          }
          agent = resolved
        } catch (reason) {
          sendJson(res, 400, { error: messageOf(reason) })
          return
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
        })
        const send = (value: unknown): void => { res.write(`data: ${JSON.stringify(value)}\n\n`) }
        let state: ChatCaptureState = 'armed'
        let closed = false
        const finish = (): void => {
          if (closed) return
          closed = true
          clearTimeout(deadline)
          off()
          res.end()
        }
        const deadline = setTimeout(() => {
          if (!closed) send({ error: 'chat stream timed out' })
          finish()
        }, CHAT_STREAM_TIMEOUT_MS)
        const off = ctx.on('session/event', (session, event) => {
          if (closed || session.header.id !== agent.id) return
          const step = chatCaptureStep(state, event)
          state = step.state
          if (step.emission === undefined) return
          if (step.emission.kind === 'delta') send({ delta: step.emission.text })
          else if (step.emission.kind === 'tool') {
            send({ tool: { callId: step.emission.callId, name: step.emission.name, arguments: step.emission.arguments } })
          } else if (step.emission.kind === 'toolResult') {
            send({
              toolResult: {
                callId: step.emission.callId,
                isError: step.emission.isError,
                summary: step.emission.summary,
              },
            })
          } else {
            send({ done: true })
            finish()
          }
        })
        req.on('close', () => { finish() })
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: parsed.text }],
          source: { kind: 'user' },
        }))
        ctx.logger.info(`dsh-code-server: chat stream opened to session ${agent.id}`)
      },
    })
    return async () => {
      disposeChat()
      disposeAsk()
      disposeOpen()
      disposeStatus()
      await sidecar.stop()
    }
  }, 'dsh-code-server: sidecar and control routes')
}
