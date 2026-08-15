// Ask DSH & Fix DSH — ship the active editor's file, selection, or reported
// problems to the DeepSeek Harness agent session that owns the enclosing
// workspace. The endpoint and bearer token arrive through DSH_ASK_ENDPOINT /
// DSH_ASK_TOKEN, which the dsh-code-server host plugin injects into the
// code-server process env.
'use strict'

const vscode = require('vscode')
const { composePrompt, composeFixPrompt, composeTerminalPrompt } = require('./prompt')

async function deliver(label, prompt, file) {
  const endpoint = process.env.DSH_ASK_ENDPOINT
  const token = process.env.DSH_ASK_TOKEN
  if (endpoint === undefined || token === undefined) {
    const message = `${label} is unavailable: the dsh-code-server plugin did not provide an endpoint.`
    vscode.window.showErrorMessage(message)
    return
  }
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-ask-token': token },
      body: JSON.stringify({ text: prompt, file }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (reason) {
    vscode.window.showErrorMessage(`${label}: request failed (${String(reason && reason.message ? reason.message : reason)})`)
    return
  }
  let body = {}
  try { body = await response.json() } catch { /* error paths below cover it */ }
  if (!response.ok) {
    vscode.window.showErrorMessage(`${label}: ${String(body.error || `HTTP ${String(response.status)}`)}`)
    return
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 13) : 'session'
  vscode.window.setStatusBarMessage(`Sent to DSH (${sessionId}…)`, 5000)
}

/** Flatten a vscode.Diagnostic into the plain row shape prompt.js formats. */
function toRow(document, diagnostic) {
  const code = diagnostic.code !== null && typeof diagnostic.code === 'object'
    ? diagnostic.code.value
    : diagnostic.code
  return {
    line: diagnostic.range.start.line + 1,
    message: diagnostic.message,
    source: diagnostic.source,
    code,
    text: document.lineAt(diagnostic.range.start.line).text,
  }
}

/** Diagnostics of a document, narrowed to those overlapping `range` when given. */
function diagnosticsWithin(uri, range) {
  const all = vscode.languages.getDiagnostics(uri)
  if (range === undefined) return all
  return all.filter(d => d.range.intersection(range) !== undefined)
}

/**
 * Quick-fix entry covering both invocation paths: the editor lightbulb /
 * Ctrl+. menu and the Problems panel marker context menu (VS Code injects a
 * marker's code actions into its right-click menu, passing the marker range).
 */
class FixCodeActionProvider {
  provideCodeActions(document, range) {
    const diagnostics = diagnosticsWithin(document.uri, range)
    if (diagnostics.length === 0) return []
    const action = new vscode.CodeAction(
      `Fix with DSH (${String(diagnostics.length)})`,
      vscode.CodeActionKind.QuickFix,
    )
    action.command = { command: 'dsh.fixAt', title: 'Fix with DSH', arguments: [document.uri, range] }
    return [action]
  }
}

async function fixDiagnostics(document, diagnostics) {
  const rows = diagnostics.map(d => toRow(document, d))
  const prompt = composeFixPrompt(document.uri.fsPath, document.languageId, rows)
  await deliver('Fix DSH', prompt, document.uri.fsPath)
}

function activate(context) {
  const ask = vscode.commands.registerCommand('dsh.ask', async () => {
    const editor = vscode.window.activeTextEditor
    if (editor === undefined) {
      vscode.window.showWarningMessage('Ask DSH: open a file in the editor first.')
      return
    }
    const hasSelection = !editor.selection.isEmpty
    const question = await vscode.window.showInputBox({
      prompt: hasSelection ? 'Ask DSH about the current selection' : 'Ask DSH about this file',
      placeHolder: 'Your question for the DSH agent',
      ignoreFocusOut: true,
    })
    if (question === undefined) return
    const prompt = composePrompt(question || 'Please review this.', editor.document, editor.selection)
    await deliver('Ask DSH', prompt, editor.document.uri.fsPath)
  })

  const fixFile = vscode.commands.registerCommand('dsh.fixFile', async () => {
    const editor = vscode.window.activeTextEditor
    if (editor === undefined) {
      vscode.window.showWarningMessage('Fix DSH: open a file in the editor first.')
      return
    }
    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
    if (diagnostics.length === 0) {
      vscode.window.showInformationMessage('Fix DSH: no problems reported in this file.')
      return
    }
    await fixDiagnostics(editor.document, diagnostics)
  })

  // Internal command driven by the code action; diagnostics are recomputed at
  // click time so edits made after the menu opened are still accounted for.
  const fixAt = vscode.commands.registerCommand('dsh.fixAt', async (uri, range) => {
    const document = await vscode.workspace.openTextDocument(uri)
    const diagnostics = diagnosticsWithin(uri, range)
    if (diagnostics.length === 0) {
      vscode.window.showInformationMessage('Fix DSH: no problems reported at this location.')
      return
    }
    await fixDiagnostics(document, diagnostics)
  })

  const provider = vscode.languages.registerCodeActionsProvider(
    { pattern: '**/*' },
    new FixCodeActionProvider(),
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
  )

  // Terminal.selection is a proposed API; this workbench (dsh's vscode fork)
  // enables proposed APIs for all extensions, and there is no stable
  // equivalent for reading what the user highlighted in xterm.
  const explainTerminal = vscode.commands.registerCommand('dsh.explainTerminal', async () => {
    const terminal = vscode.window.activeTerminal
    if (terminal === undefined) {
      vscode.window.showWarningMessage('Explain DSH: focus a terminal first.')
      return
    }
    const selection = terminal.selection
    if (typeof selection !== 'string' || selection.trim() === '') {
      vscode.window.showInformationMessage(
        'Explain DSH: select the terminal output to explain first (right-click → Select All).',
      )
      return
    }
    const prompt = composeTerminalPrompt(terminal.name, selection)
    await deliver('Explain DSH', prompt, undefined)
  })

  context.subscriptions.push(ask, fixFile, fixAt, provider, explainTerminal)
}

module.exports = { activate }
