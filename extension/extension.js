// Ask DSH — ship the active editor's file and selection to the DeepSeek
// Harness agent session that owns the enclosing workspace. The endpoint and
// bearer token arrive through DSH_ASK_ENDPOINT / DSH_ASK_TOKEN, which the
// dsh-code-server host plugin injects into the code-server process env.
'use strict'

const vscode = require('vscode')

/** Selections larger than this are summarized instead of inlined. */
const MAX_SELECTION_CHARS = 8000

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

async function deliver(prompt, file) {
  const endpoint = process.env.DSH_ASK_ENDPOINT
  const token = process.env.DSH_ASK_TOKEN
  if (endpoint === undefined || token === undefined) {
    const message = 'Ask DSH is unavailable: the dsh-code-server plugin did not provide an endpoint.'
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
    vscode.window.showErrorMessage(`Ask DSH: request failed (${String(reason && reason.message ? reason.message : reason)})`)
    return
  }
  let body = {}
  try { body = await response.json() } catch { /* error paths below cover it */ }
  if (!response.ok) {
    vscode.window.showErrorMessage(`Ask DSH: ${String(body.error || `HTTP ${String(response.status)}`)}`)
    return
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 13) : 'session'
  vscode.window.setStatusBarMessage(`Sent to DSH (${sessionId}…)`, 5000)
}

function activate(context) {
  const disposable = vscode.commands.registerCommand('dsh.ask', async () => {
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
    await deliver(prompt, editor.document.uri.fsPath)
  })
  context.subscriptions.push(disposable)
}

module.exports = { activate, composePrompt }
