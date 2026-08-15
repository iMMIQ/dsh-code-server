/**
 * Minimal derivation layer for the cloned bash tool row: the row model and
 * terminal-card model the DSH ui-tool package derives from a frozen tool-call
 * slice (`toolRowModel` / `terminalCardModel` at the pinned DSH commit), plus
 * the spill-path extraction this clone adds. Duck-typed against DSH 47f9438;
 * the invariants that matter are asserted by tests/dsh-compat.spec.ts.
 */

/** Call-side render intent the bash tool declares (`card: 'terminal'`). */
export interface TerminalCallView {
  card: 'terminal'
  title: string
  description?: string
  cwd?: string
}

/** Result-side render intent for a settled foreground bash call. */
export interface TerminalResultView {
  card: 'terminal'
  title?: string | null
  output?: string
  exitCode?: number
  signal?: string
}

/** Frozen running-call slice (tool/call seen, tool/result not yet). */
export interface RunningToolCall {
  callId: string
  toolName: string
  argsRaw: string
  callView?: { card: string; title?: string; description?: string; cwd?: string } | null
}

/** Frozen settled-result slice off the conversation snapshot. */
export interface ToolResultNode {
  kind: string
  callId: string
  call?: { argsRaw?: string } | null
  callView?: { card: string; title?: string; description?: string; cwd?: string } | null
  resultView?: { card: string; title?: string | null; output?: string; exitCode?: number; signal?: string } | null
  content: { type: string; text?: string }[]
  isError: boolean
  error?: { code: string; name: string }
}

export type ToolCallBlock = RunningToolCall | ToolResultNode

export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped'

export interface ToolRowModel {
  title: string
  summary: string
  body: string | null
  output: string | null
  errorSummary: string | null
  state: ToolRowState
}

export interface TerminalCardModel {
  card: {
    command: string
    cwd: string | undefined
    output: string | undefined
    exitCode: number | undefined
    signal: string | undefined
    running: boolean
  }
  description: string | undefined
}

/** True when a settled terminal card reports a failing exit or a signal. */
export function terminalFailed(model: TerminalCardModel): boolean {
  const { exitCode, signal, running } = model.card
  return running !== true && ((exitCode !== undefined && exitCode !== 0) || signal !== undefined)
}

/** Resolve `.`/`..` segments the way a filesystem does (display-only). */
function collapseSegments(path: string): string {
  const rooted = path.startsWith('/')
  const kept: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (kept.length > 0 && kept[kept.length - 1] !== '..') kept.pop()
      else kept.push(segment)
      continue
    }
    kept.push(segment)
  }
  const body = kept.join('/')
  if (body === '') return rooted ? '/' : '.'
  return rooted ? `/${body}` : body
}

/**
 * Resolve a terminal view's working directory: absolute stays (normalized), a
 * relative one joins under the session workspace, and an omitted one IS the
 * session workspace. Simplified from the pinned DSH derivation — this plugin
 * does not support Windows path spellings.
 */
function resolveTerminalCwd(viewCwd: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (viewCwd === undefined || viewCwd === '') return sessionCwd
  if (sessionCwd === undefined || sessionCwd === '') return collapseSegments(viewCwd) || '/'
  if (viewCwd.startsWith('/')) return collapseSegments(viewCwd) || '/'
  return collapseSegments(`${sessionCwd.replace(/\/+$/, '')}/${viewCwd}`) || '/'
}

/**
 * Derive the terminal-card props for a tool call, or null when the call is not
 * a terminal card (generic path). Mirrors `terminalCardModel` at the pinned
 * DSH commit: the call side supplies command/cwd, the result side supplies
 * output/exit status, and the result title replaces the pending one.
 */
export function terminalCardModel(block: ToolCallBlock, sessionCwd?: string): TerminalCardModel | null {
  const call = block.callView?.card === 'terminal' ? block.callView : null
  if (!('kind' in block)) {
    if (call === null) return null
    return {
      description: call.description,
      card: {
        command: call.title ?? '',
        cwd: resolveTerminalCwd(call.cwd, sessionCwd),
        output: undefined,
        exitCode: undefined,
        signal: undefined,
        running: true,
      },
    }
  }
  const result = block.resultView?.card === 'terminal' ? block.resultView : null
  if (result === null) return null
  return {
    description: call?.description,
    card: {
      command: result.title ?? call?.title ?? '',
      cwd: call === null ? undefined : resolveTerminalCwd(call.cwd, sessionCwd),
      output: result.output,
      exitCode: result.exitCode,
      signal: result.signal,
      running: false,
    },
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** Flatten a settled result's content blocks to display text. */
function resultText(node: ToolResultNode): string {
  const parts: string[] = []
  for (const block of node.content) {
    if (block.type === 'text') parts.push(block.text ?? '')
    else parts.push(JSON.stringify(block, null, 2))
  }
  if (parts.length === 0 && node.error !== undefined) parts.push(`${node.error.name}: ${node.error.code}`)
  return parts.join('\n')
}

/** Derive the bash row model (title, summary, expandable texts, state). */
export function bashRowModel(block: ToolCallBlock): ToolRowModel {
  const done = 'kind' in block
  const argsRaw = (done ? block.call?.argsRaw : block.argsRaw) ?? ''
  const state: ToolRowState = !done
    ? 'running'
    : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
  let summary: string
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    summary = typeof parsed === 'object' && parsed !== null
      ? firstLine((parsed as Record<string, unknown>).description as string
        ?? (parsed as Record<string, unknown>).command as string
        ?? argsRaw)
      : firstLine(argsRaw)
  } catch {
    summary = firstLine(argsRaw)
  }
  const body = argsRaw === '' ? null
    : (() => {
      try {
        return JSON.stringify(JSON.parse(argsRaw), null, 2)
      } catch {
        return argsRaw
      }
    })()
  const output = done ? (resultText(block) || null) : null
  return {
    title: 'Bash',
    summary: summary === '' ? block.callId : summary,
    body,
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}

/**
 * Spill paths the bash renderer reports when a stream was truncated
 * (`[output truncated; full output: …]`) or a background read dropped bytes
 * (`[some output was dropped from memory; full output: p1, p2]`). Paths are
 * absolute already — the renderer embeds the executor's spill path verbatim —
 * so the renderer's `(unavailable)` placeholder is dropped along with any
 * non-absolute value (this plugin is POSIX-only).
 */
export function spillPaths(text: string | null | undefined): string[] {
  if (text === undefined || text === null || text === '') return []
  const paths = new Set<string>()
  const markers = /\[(?:output truncated|some output was dropped from memory); full output: ([^\]\n]+)\]/g
  for (const match of text.matchAll(markers)) {
    for (const path of match[1].split(',')) {
      const trimmed = path.trim()
      if (trimmed.startsWith('/')) paths.add(trimmed)
    }
  }
  return [...paths]
}
