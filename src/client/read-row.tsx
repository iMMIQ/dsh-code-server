/**
 * Cloned DSH read tool row (ui-tool's `read-row.tsx` at the pinned commit
 * 47f9438), shadow-registered over the keyed `tool.call.toolview` "read" cell
 * at priority -1 (lowest renders). The clone adds one behavior: the summary
 * path link carries the line the read window started at (`path:line`), so the
 * workbench reveals that line instead of line 1. Everything else matches the
 * upstream row so the visual result is unchanged. Divergence is asserted by
 * tests/dsh-compat.spec.ts.
 */
import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  IconBrowseOutline16, IconChevronDownOutline14, IconInspectOutline12, ReadBlock, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DrawerController } from './controller.ts'
import type { ToolCallBlock, ToolRowState } from './bash-model.ts'
import { readCardModel, readRowModel, resolveWorkspacePath } from './read-model.ts'

type Translate = (key: string, params?: Record<string, unknown>) => string

/** Props the keyed toolview render site composes for this entry. */
export interface ReadRowProps {
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

/** Content lines the chat row's read body shows before collapsing the middle. */
const CHAT_READ_MAX_LINES = 8

const FALLBACK = {
  running: 'Running',
  failed: 'Failed',
  stopped: 'Stopped',
}

function leadingFor(state: ToolRowState) {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    // Running keeps the icon — the row sweep carries the in-flight signal.
    default: return <IconBrowseOutline16 size={16} />
  }
}

/** Visually hidden status — StateDot is aria-hidden; AT needs a text label. */
function stateStatus(state: ToolRowState, t: Translate | undefined): string | null {
  switch (state) {
    case 'running': return t?.('row.running') ?? FALLBACK.running
    case 'error': return t?.('row.failed') ?? FALLBACK.failed
    case 'stopped': return t?.('row.stopped') ?? FALLBACK.stopped
    default: return null
  }
}

export function ReadRow({ callId, toolName, block, cwd, inspect, t, controller }: ReadRowProps) {
  void toolName
  const model = readRowModel(block, cwd, callId)
  const card = readCardModel(block, cwd)
  const status = stateStatus(model.state, t)
  const [expanded, setExpanded] = useState(false)
  const expandable = model.body !== null || model.output !== null || card !== null
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
  // The path link opens the file at the read window's first line; the host
  // /open route's same-origin shape is unchanged (controller.openFile splits
  // the :line suffix back into structured fields before posting).
  const openRead = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (model.filePath === undefined) return
    void controller.openFile(`${resolveWorkspacePath(cwd, model.filePath)}:${String(model.line)}`)
  }
  // Keep Enter/Space on the focused path link from bubbling to the row's
  // keydown handler, which would preventDefault() the key and toggle expand
  // instead of activating the link.
  const fileLinkKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }
  const leading = open
    ? <IconChevronDownOutline14 className="dcs-br-chevron" />
    : expandable
      ? (
        <>
          <span className="dcs-br-icon-idle">{leadingFor(model.state)}</span>
          <IconChevronDownOutline14 className="dcs-br-chevron dcs-br-chevron-hover" />
        </>
      )
      : leadingFor(model.state)
  return (
    <div className="dcs-br-card" data-variant="read" data-state={model.state}>
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
        {/* A failure's first line replaces the summary wholesale — error
            prose is not a path, so no open-file affordance on an error row. */}
        {failureLine !== null
          ? <span className="dcs-br-summary dcs-br-error-summary">{failureLine}</span>
          : model.filePath !== undefined
            ? (
              <button
                type="button"
                className="dcs-br-file-link"
                title={model.filePath}
                onClick={openRead}
                onKeyDown={fileLinkKeyDown}
              >
                {model.summary}
              </button>
            )
            : <span className="dcs-br-summary">{model.summary}</span>}
      </div>
      {open && (
        <div className="dcs-br-body-wrap">
          {card !== null
            ? (
              <ReadBlock
                label={card.label}
                lines={card.lines}
                totalLines={card.totalLines}
                lang={card.lang}
                maxLines={CHAT_READ_MAX_LINES}
                className="dcs-br-read"
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
                    <span className="dcs-br-io-text" data-error={model.state === 'error' || undefined}>{model.output}</span>
                  </div>
                )}
              </div>
            )}
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
