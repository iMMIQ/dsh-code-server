/**
 * Minimal derivation layer for the cloned read tool row: the read-variant
 * slice of ui-tool's `toolRowModel` at the pinned DSH commit, the
 * `readCardModel` clone, and the landing-line derivation this clone adds (the
 * reason the clone exists). Duck-typed against DSH 47f9438; the invariants
 * that matter are asserted by tests/dsh-compat.spec.ts and
 * tests/read-model.spec.ts.
 */
import type { ToolCallBlock, ToolRowState } from './bash-model.ts'

/** Settled read result view the read tool declares (`card: 'read'`). */
export interface ReadResultView {
  card: 'read'
  title?: string | null
  path: string
  lines: readonly { number: number; text: string }[]
  totalLines: number
  lang?: string
}

/** The ReadBlock material the cloned row's expanded body draws. */
export interface ReadCardModel {
  label: string
  lines: { number: number; text: string }[]
  totalLines: number
  lang: string | undefined
}

/** Read-row model: the shared row fields plus the workbench landing line. */
export interface ReadRowModel {
  title: string
  summary: string
  /** Filesystem path from args (`path`/`file_path`); absent for URL reads. */
  filePath: string | undefined
  body: string | null
  output: string | null
  errorSummary: string | null
  state: ToolRowState
  /** 1-based line the workbench reveals when the summary path link opens. */
  line: number
}

function argsRawOf(block: ToolCallBlock): string {
  return ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
}

function parseArgs(argsRaw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/**
 * Resolve a workspace-relative path into the absolute spelling the host /open
 * route authorizes (clone of DSH's `resolveWorkspacePath`; this plugin is
 * POSIX-only, so only the rooted-at-/ branch matters).
 */
export function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (path.startsWith('/')) return path
  if (cwd === undefined || cwd === '') return path
  const base = cwd.replace(/\/+$/, '')
  const rel = path.replace(/^\/+/, '')
  return `${base}/${rel}`
}

/**
 * Strip the workspace root from a workspace-rooted absolute path (display
 * only; clone of DSH's `relativizeToCwd` for the POSIX spellings).
 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/\/+$/, '')
  if (text.startsWith(`${root}/`)) return text.slice(root.length + 1)
  return text
}

/** Read-summary key preference (args-derived), mirroring upstream. */
const SUMMARY_KEYS = ['path', 'file_path', 'url'] as const
/** Path keys only — never `url` (a URL read has no workspace file to open). */
const FILE_PATH_KEYS = ['path', 'file_path'] as const

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * The read card is result-side only: a running read has no result view and a
 * settled one whose result view is not a `card: 'read'` (an error result, a
 * non-envelope body) keeps the generic IN/OUT body. The label is the view's
 * replacement title when the tool supplied one, otherwise the read path
 * relativized to the session workspace. Lines are copied out of the frozen
 * snapshot so the card never holds a reference into the runtime's cache.
 */
export function readCardModel(block: ToolCallBlock, sessionCwd?: string): ReadCardModel | null {
  if (!('kind' in block)) return null
  const result = block.resultView?.card === 'read' ? block.resultView as ReadResultView : null
  if (result === null) return null
  return {
    label: result.title ?? relativizeToCwd(result.path, sessionCwd),
    lines: result.lines.map(line => ({ number: line.number, text: line.text })),
    totalLines: result.totalLines,
    lang: result.lang,
  }
}

/**
 * The 1-based line the workbench should reveal. Priority: the read window's
 * first line (the settled result carries each line's file line number, so a
 * windowed read lands where the agent was looking), then the call args'
 * `offset` (a running read's intended window), then line 1.
 */
export function landingLine(block: ToolCallBlock, card: ReadCardModel | null): number {
  const first = card?.lines[0]?.number
  if (typeof first === 'number' && Number.isInteger(first) && first >= 1) return first
  const args = parseArgs(argsRawOf(block))
  const offset = args?.offset
  if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 1) return offset
  return 1
}

/**
 * Derive the read row model from a frozen call slice (the read-variant slice
 * of upstream `toolRowModel`: summary from `path`/`file_path`/`url`, filePath
 * from the path keys only, pretty-printed args as the IN body, flattened
 * result text as the OUT body with its first line as the error summary).
 */
export function readRowModel(
  block: ToolCallBlock,
  cwd: string | undefined,
  callId: string,
): ReadRowModel {
  const done = 'kind' in block
  const argsRaw = argsRawOf(block)
  const state: ToolRowState = !done
    ? 'running'
    : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
  const args = parseArgs(argsRaw)
  let summary: string
  if (args === null) {
    summary = firstLine(argsRaw)
  } else {
    const picked = pickString(args, SUMMARY_KEYS)
    summary = picked !== undefined
      ? firstLine(picked)
      : firstLine((Object.values(args).find(v => typeof v === 'string' && v !== '') as string | undefined) ?? argsRaw)
  }
  const filePath = args === null ? undefined : pickString(args, FILE_PATH_KEYS)
  const body = argsRaw === '' ? null
    : args === null ? argsRaw
      : JSON.stringify(args, null, 2)
  const outputParts: string[] = []
  if (done) {
    for (const part of block.content) {
      outputParts.push(part.type === 'text' ? part.text ?? '' : JSON.stringify(part, null, 2))
    }
    if (outputParts.length === 0 && block.error !== undefined) outputParts.push(`${block.error.name}: ${block.error.code}`)
  }
  const output = done ? (outputParts.join('\n') || null) : null
  return {
    title: 'Read',
    summary: argsRaw === '' ? callId : relativizeToCwd(summary, cwd),
    filePath: filePath === undefined ? undefined : firstLine(filePath),
    body,
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
    line: landingLine(block, readCardModel(block, cwd)),
  }
}
