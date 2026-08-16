// Ask, Fix & Chat DSH — ship the active editor's file, selection, or reported
// problems to the DeepSeek Harness agent session that owns the enclosing
// workspace. The endpoint and bearer token arrive through DSH_ASK_ENDPOINT /
// DSH_CHAT_ENDPOINT / DSH_ASK_TOKEN, which the dsh-code-server host plugin
// injects into the code-server process env. The chat participant routes bare
// messages (no @mention needed) and streams the session's reply back.
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

/**
 * POST to the host's /chat route and yield the session's streamed events:
 * {type:'delta',text} assistant text pieces, {type:'tool',callId,name,arguments}
 * tool invocations the agent made mid-turn, {type:'toolResult',callId,isError,summary}
 * their outcomes. The stream ends on {done} or {error}.
 */
async function* dshChatStream(prompt, file, token) {
  const response = await fetch(process.env.DSH_CHAT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-ask-token': token },
    body: JSON.stringify({ text: prompt, file }),
  })
  if (!response.ok) {
    let detail = `HTTP ${String(response.status)}`
    try { detail = (await response.json()).error || detail } catch { /* keep status */ }
    throw new Error(detail)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      let payload
      try { payload = JSON.parse(line.slice(6)) } catch { continue }
      if (typeof payload.error === 'string') throw new Error(payload.error)
      if (payload.done === true) return
      if (payload.tool !== undefined
        && typeof payload.tool.callId === 'string'
        && typeof payload.tool.name === 'string'
        && typeof payload.tool.arguments === 'string') {
        yield { type: 'tool', callId: payload.tool.callId, name: payload.tool.name, arguments: payload.tool.arguments }
      } else if (payload.toolResult !== undefined && typeof payload.toolResult.callId === 'string') {
        yield {
          type: 'toolResult',
          callId: payload.toolResult.callId,
          isError: payload.toolResult.isError === true,
          summary: typeof payload.toolResult.summary === 'string' ? payload.toolResult.summary : '',
        }
      } else if (typeof payload.delta === 'string' && payload.delta !== '') {
        yield { type: 'delta', text: payload.delta }
      }
    }
  }
}

/** Single-line, bounded, backtick-safe inline-code argument for chat markdown. */
function inlineCode(value) {
  const collapsed = String(value).replace(/\s+/g, ' ').trim()
  const bounded = collapsed.length <= 160 ? collapsed : `${collapsed.slice(0, 160)}…`
  return `\`${bounded.replace(/`/g, "'")}\``
}

/** Pick the headline argument of a tool call: the file/command it acts on. */
function toolHeadline(rawArguments) {
  let display = rawArguments
  try {
    const parsed = JSON.parse(rawArguments)
    if (parsed !== null && typeof parsed === 'object') {
      const preferred = ['file_path', 'path', 'cmd', 'command', 'script', 'pattern', 'query', 'url']
      const key = preferred.find(k => typeof parsed[k] === 'string' && parsed[k] !== '')
      display = key !== undefined ? parsed[key] : JSON.stringify(parsed)
    }
  } catch { /* arguments are the model's raw, possibly unparsable JSON; show as-is */ }
  return display
}

/** File argument of a tool call, when it has one — becomes a clickable anchor. */
function toolPath(rawArguments) {
  try {
    const parsed = JSON.parse(rawArguments)
    if (parsed !== null && typeof parsed === 'object') {
      const preferred = ['file_path', 'path']
      const key = preferred.find(k => typeof parsed[k] === 'string' && parsed[k] !== '')
      const line = typeof parsed.line === 'number' ? parsed.line : (typeof parsed.start_line === 'number' ? parsed.start_line : undefined)
      return { value: key === undefined ? undefined : parsed[key], line }
    }
  } catch { /* not JSON: no file anchor */ }
  return { value: undefined, line: undefined }
}

/** Resolve a tool's file argument against the workspace for an anchor chip. */
function toolAnchor(path) {
  if (path === undefined || path.value === undefined) return undefined
  if (vscode.workspace.workspaceFolders === undefined || vscode.workspace.workspaceFolders.length === 0) return undefined
  try {
    const uri = path.value.startsWith('/')
      ? vscode.Uri.file(path.value)
      : vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, path.value)
    const line = typeof path.line === 'number' && path.line >= 1 ? path.line - 1 : 0
    return new vscode.Location(uri, new vscode.Position(line, 0))
  } catch { /* unusable path: skip the anchor */ }
  return undefined
}

/** Register the chat participant as the default agent for chat locations. */
function registerChatParticipant(context) {
  // Chat APIs only exist once the workbench ships the restored chat UI; on
  // older trimmed runtimes they are undefined and the commands above still work.
  if (vscode.chat === undefined || vscode.lm === undefined) return

  // Agent-mode chat resolves a language model before invoking the participant.
  // The reply itself never comes from this provider — the participant streams
  // the DSH session's answer — but resolution must succeed, and the default
  // model must live under the vendor the workbench hardcodes.
  try {
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('copilot', {
      provideLanguageModelChatInformation: async () => [{
        vendor: 'copilot',
        id: 'dsh-session',
        family: 'dsh-session',
        version: '1',
        name: 'DSH agent session',
        maxInputTokens: 128000,
        isDefault: true,
        isUserSelectable: true,
        capabilities: { toolCalling: true },
      }],
    }))
  } catch { /* without the provider only agent mode is degraded */ }

  const handler = async (request, chatContext, stream, token) => {
    const endpoint = process.env.DSH_CHAT_ENDPOINT
    const askToken = process.env.DSH_ASK_TOKEN
    if (endpoint === undefined || askToken === undefined) {
      return { errorDetails: { message: 'Chat DSH is unavailable: the dsh-code-server plugin did not provide an endpoint.' } }
    }
    const editor = vscode.window.activeTextEditor
    let prompt
    let file
    if (request.command === 'fix') {
      if (editor === undefined) {
        return { errorDetails: { message: 'Fix DSH: open a file in the editor first.' } }
      }
      const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
      if (diagnostics.length === 0) {
        await stream.markdown('No problems are reported in this file.')
        return {}
      }
      const rows = diagnostics.map(d => toRow(editor.document, d))
      prompt = composeFixPrompt(editor.document.uri.fsPath, editor.document.languageId, rows)
      file = editor.document.uri.fsPath
    } else if (editor !== undefined) {
      prompt = composePrompt(request.prompt || 'Please review this.', editor.document, editor.selection)
      file = editor.document.uri.fsPath
    } else {
      prompt = request.prompt
      if (prompt === undefined || prompt.trim() === '') {
        return { errorDetails: { message: 'Chat DSH: type a question first.' } }
      }
    }
    try {
      // Tool calls render in two stages: a transient spinner row while the
      // tool runs (progress parts hide once later content arrives), then a
      // durable result row with the elapsed time once the outcome lands.
      const tools = new Map()
      for await (const part of dshChatStream(prompt, file, askToken)) {
        if (token.isCancellationRequested) return { errorDetails: { message: 'cancelled' } }
        if (part.type === 'delta') {
          await stream.markdown(part.text)
        } else if (part.type === 'tool') {
          tools.set(part.callId, {
            name: part.name,
            headline: toolHeadline(part.arguments),
            path: toolPath(part.arguments),
            startedAt: Date.now(),
          })
          stream.progress(`⚙ ${part.name} ${toolHeadline(part.arguments)}`)
        } else if (part.type === 'toolResult') {
          const tool = tools.get(part.callId)
            ?? { name: 'tool', headline: '', path: undefined, startedAt: Date.now() }
          const elapsed = `${String(Date.now() - tool.startedAt)}ms`
          if (part.isError) {
            await stream.markdown(`\n\n> ⚠ ${inlineCode(tool.name)} failed after ${elapsed}: ${part.summary}\n\n`)
          } else {
            await stream.markdown(`\n\n✓ ${inlineCode(tool.name)} ${inlineCode(tool.headline)} · ${elapsed}\n\n`)
            const anchor = toolAnchor(tool.path)
            if (anchor !== undefined) stream.anchor(anchor, tool.path.value)
          }
        }
      }
    } catch (reason) {
      return { errorDetails: { message: `Chat DSH: ${String(reason && reason.message ? reason.message : reason)}` } }
    }
    return {}
  }

  try {
    const participant = vscode.chat.createChatParticipant('immiq.dsh', handler)
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.svg')
    context.subscriptions.push(participant)
  } catch { /* participant id clash or degraded runtime: commands still work */ }
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
  registerChatParticipant(context)
}

module.exports = { activate }
