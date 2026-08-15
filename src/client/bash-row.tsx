/**
 * Cloned DSH bash tool row (ui-tool's `bash-sample.tsx` at the pinned commit
 * 47f9438), shadow-registered over the keyed `tool.call.toolview` "bash" cell
 * at priority -1 (lowest renders). The clone adds one behavior: when the
 * terminal output carries a spill marker, an "Open full output" pill posts the
 * spill file to the host `/open` route, which opens it in the embedded
 * workbench. Everything else matches the upstream row so the visual result is
 * unchanged. Divergence is asserted by tests/dsh-compat.spec.ts.
 */
import { useState, type KeyboardEvent } from 'react'
import {
  IconApiOutline14, IconChevronDownOutline14, IconInspectOutline12, StateDot, TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DrawerController } from './controller.ts'
import {
  bashRowModel, spillPaths, terminalCardModel, terminalFailed,
  type ToolCallBlock, type ToolRowState,
} from './bash-model.ts'

type Translate = (key: string, params?: Record<string, unknown>) => string

/** Props the keyed toolview render site composes for this entry. */
export interface BashRowProps {
  callId: string
  toolName: string
  block: ToolCallBlock
  cwd?: string | undefined
  inspect?: (() => void) | undefined
  /** Locale seat injected when the registration's locale namespace resolves. */
  t?: Translate | undefined
  /** Closure-injected by the registration in client/index.tsx. */
  controller: DrawerController
}

const FALLBACK = {
  running: 'Running…',
  failed: 'Failed',
  stopped: 'Stopped',
}

function leadingFor(state: ToolRowState) {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    // Running keeps the icon — the row sweep carries the in-flight signal.
    default: return <IconApiOutline14 size={14} />
  }
}

/** Visually hidden status — StateDot is aria-hidden; AT needs a text label. */
function stateStatus(state: ToolRowState, t: Translate | undefined): string | null {
  switch (state) {
    case 'running': return t?.('bash.running') ?? FALLBACK.running
    case 'error': return t?.('bash.failed') ?? FALLBACK.failed
    case 'stopped': return t?.('bash.stopped') ?? FALLBACK.stopped
    default: return null
  }
}

function terminalLabels(t: Translate | undefined) {
  return {
    signal: (signal: string) => t?.('terminal.signal', { signal }) ?? `killed by ${signal}`,
    exitCode: (code: number) => t?.('terminal.exitCode', { code }) ?? `exit ${String(code)}`,
    running: t?.('terminal.running') ?? 'Running',
    failed: t?.('terminal.failed') ?? 'Failed',
    done: t?.('terminal.done') ?? 'Done',
    copy: t?.('copy') ?? 'Copy',
    copied: t?.('copied') ?? 'Copied',
    noOutput: t?.('terminal.noOutput') ?? 'no output',
    collapseAria: t?.('terminal.collapseAria') ?? 'Collapse',
    collapse: t?.('collapse') ?? 'Collapse',
    expandAria: (hidden: number) => t?.('terminal.expandAria', { n: hidden }) ?? `Expand ${String(hidden)} hidden lines`,
    expand: (hidden: number) => t?.('terminal.expandRest', { n: hidden }) ?? `Expand ${String(hidden)} hidden lines`,
  }
}

export function BashRow({ toolName, block, cwd, inspect, t, controller }: BashRowProps) {
  void toolName
  const model = bashRowModel(block)
  const terminal = terminalCardModel(block, cwd)
  // A failing exit status is the terminal card's own error signal (the call
  // itself settles isError:false), surfaced as the row's red state dot.
  const state = model.state === 'ok' && terminal !== null && terminalFailed(terminal)
    ? 'error'
    : model.state
  const status = stateStatus(state, t)
  const [expanded, setExpanded] = useState(false)
  // Execution failures (for example cancellation before the process reports a
  // terminal result) use the generic presenter. Keep their recorded args and
  // full error reachable instead of collapsing the row to the first line.
  const genericError = terminal === null
    && model.state === 'error'
    && (model.body !== null || model.output !== null)
  const expandable = terminal !== null || genericError
  const open = expanded && expandable
  const failureLine = model.state === 'error' ? model.errorSummary : null
  const toggleExpand = () => {
    setExpanded(v => !v)
  }
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggleExpand()
  }
  // The spill marker rides the terminal card's output (foreground) or the
  // flattened result text (generic error / background acknowledgement).
  const spills = open ? spillPaths(terminal?.card.output ?? model.output) : []
  const leading = open
    ? <IconChevronDownOutline14 className="dcs-br-chevron" />
    : expandable
      ? (
        <>
          <span className="dcs-br-icon-idle">{leadingFor(state)}</span>
          <IconChevronDownOutline14 className="dcs-br-chevron dcs-br-chevron-hover" />
        </>
      )
      : leadingFor(state)
  return (
    <div className="dcs-br-card" data-variant="bash" data-state={state}>
      <div
        className="dcs-br-root"
        data-expandable={expandable || undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? toggleExpand : undefined}
        onKeyDown={expandable ? toggleFromKeyboard : undefined}
      >
        <span className="dcs-br-leading">{leading}</span>
        {status !== null && <span className="dcs-br-vh">{status}</span>}
        <span className="dcs-br-title">{model.title}</span>
        <span className="dcs-br-sep" aria-hidden />
        {/* The terminal presenter's description is the contractual
            above-card summary; a failure's first line outranks both. */}
        <span className={failureLine !== null ? 'dcs-br-summary dcs-br-error-summary' : 'dcs-br-summary'}>
          {failureLine ?? terminal?.description ?? model.summary}
        </span>
      </div>
      {open && (
        <div className="dcs-br-body-wrap">
          {terminal !== null
            ? (
              <TerminalBlock
                command={terminal.card.command}
                cwd={terminal.card.cwd}
                output={terminal.card.output}
                exitCode={terminal.card.exitCode}
                signal={terminal.card.signal}
                running={terminal.card.running}
                maxLines={Infinity}
                labels={terminalLabels(t)}
                className="dcs-br-terminal"
              />
            )
            : (
              <div className="dcs-br-io-card">
                {model.body !== null && (
                  <div className="dcs-br-io-section">
                    <span className="dcs-br-io-label">IN</span>
                    <span className="dcs-br-io-text">{model.body}</span>
                  </div>
                )}
                {model.body !== null && model.output !== null && (
                  <span className="dcs-br-io-divider" aria-hidden />
                )}
                {model.output !== null && (
                  <div className="dcs-br-io-section">
                    <span className="dcs-br-io-label">OUT</span>
                    <span className="dcs-br-io-text" data-error>{model.output}</span>
                  </div>
                )}
              </div>
            )}
          {spills.map(path => (
            <button
              key={path}
              type="button"
              className="dcs-br-open-output"
              title={path}
              onClick={() => { void controller.openFile(path) }}
            >
              <IconInspectOutline12 />
              {spills.length > 1 ? `Open full output (${path.split('/').pop() ?? path})` : 'Open full output'}
            </button>
          ))}
          {inspect !== undefined && (
            <button type="button" className="dcs-br-inspect" onClick={inspect}>
              <IconInspectOutline12 />
              Inspect
            </button>
          )}
        </div>
      )}
    </div>
  )
}
