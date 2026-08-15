// Pure prompt composers shared by the workbench commands. This module must
// not import vscode so unit tests can exercise the formatting directly.
'use strict'

/** Selections larger than this are summarized instead of inlined. */
const MAX_SELECTION_CHARS = 8000
/** More diagnostics than this are dropped with a note instead of listed. */
const MAX_FIX_DIAGNOSTICS = 50
/** Terminal selections larger than this keep head and tail halves only. */
const MAX_TERMINAL_CHARS = 12_000
/** Per-diagnostic truncation, keeping the whole prompt well under the /ask cap. */
const MAX_FIX_MESSAGE_CHARS = 300
const MAX_FIX_LINE_CHARS = 200

function composePrompt(question, document, selection) {
  const lines = selection.isEmpty
    ? undefined
    : `${selection.start.line + 1}-${selection.end.line + 1}`
  const header = lines === undefined
    ? `File: ${document.uri.fsPath} (${document.languageId})`
    : `File: ${document.uri.fsPath} (lines ${lines}, ${document.languageId})`
  let selectionBlock = ''
  if (!selection.isEmpty) {
    const text = document.getText(selection)
    if (text.length <= MAX_SELECTION_CHARS) {
      selectionBlock = `\n\n\`\`\`${document.languageId}\n${text}\n\`\`\``
    } else {
      selectionBlock = `\n\n(selection is ${String(text.length)} characters; open the file to see it)`
    }
  }
  return `${question}\n\n${header}${selectionBlock}`
}

/**
 * One flattened diagnostic as the workbench command layer sees it:
 * 1-based line, message, optional source/code, and the offending line text.
 */
function formatDiagnosticRow(d) {
  const origin = d.source === undefined || d.source === null
    ? ''
    : d.code === undefined || d.code === null ? d.source : `${d.source} ${String(d.code)}`
  const clip = (text, cap) => (text.length > cap ? `${text.slice(0, cap)}…` : text)
  const message = clip(d.message, MAX_FIX_MESSAGE_CHARS)
  const line = clip(d.text, MAX_FIX_LINE_CHARS)
  return `- Ln ${String(d.line)}${origin ? ` [${origin}]` : ''}: ${message}\n  > ${line}`
}

/**
 * Compose the Fix prompt. Unlike Ask (explain), Fix instructs the agent to
 * edit the file directly — the DSH session already has workspace write access.
 */
function composeFixPrompt(file, languageId, diagnostics) {
  const listed = diagnostics.slice(0, MAX_FIX_DIAGNOSTICS).map(formatDiagnosticRow)
  const dropped = diagnostics.length - listed.length
  if (dropped > 0) {
    listed.push(`- (${String(dropped)} more problems not listed)`)
  }
  return [
    'Fix the problems reported in this file. Edit the file directly — you have write access to the workspace.',
    '',
    `File: ${file} (${languageId})`,
    '',
    'Diagnostics reported by the editor:',
    ...listed,
    '',
    'Resolve every listed problem with minimal edits and keep the rest of the file intact.',
  ].join('\n')
}

/**
 * Compose the terminal-explain prompt. Oversized captures keep the head and
 * tail halves — command output usually fails at either end, and the /ask body
 * cap is far below full scrollback.
 */
function composeTerminalPrompt(terminalName, text) {
  const origin = terminalName === undefined || terminalName === ''
    ? ''
    : ` from "${terminalName}"`
  let block = text
  if (text.length > MAX_TERMINAL_CHARS) {
    const half = Math.floor(MAX_TERMINAL_CHARS / 2)
    block = `${text.slice(0, half)}\n… (${String(text.length - MAX_TERMINAL_CHARS)} characters omitted) …\n${text.slice(-half)}`
  }
  return [
    `Explain this terminal output${origin}: what happened, and if it failed, why and how to fix it.`,
    '',
    '```',
    block,
    '```',
  ].join('\n')
}

module.exports = { composePrompt, composeFixPrompt, composeTerminalPrompt }
