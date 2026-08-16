/**
 * OpenAI-compatible mock LLM for end-to-end tests.
 *
 * Serves the `/chat/completions` SSE shape the DeepSeek adapter expects and
 * records every request body so tests can assert on what the agent actually
 * sent (selection text, diagnostics, sentinel markers). Replies carry a
 * `MOCK-REPLY-<n>` marker that downstream assertions look for in the session
 * log and the chat widgets.
 *
 * `toolCall: { match, name, arguments }` makes the model request one tool
 * invocation instead of replying in text the first time a request's last user
 * message matches `match` (a non-global RegExp). The agent executes the tool,
 * sends its result back, and that follow-up request gets the usual text reply —
 * exercising the tool/call + tool/result path through the chat stream.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'

export function startMockLlm({ port, logFile, toolCall }) {
  let n = 0
  let awaitingToolResult = false
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => {
      body += c
    })
    req.on('end', () => {
      n += 1
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = null
      }
      const lastUserText = parsed?.messages?.filter(m => m.role === 'user').at(-1)?.content
      try {
        appendFileSync(
          logFile,
          `${JSON.stringify({
            n,
            url: req.url,
            model: parsed?.model,
            lastUserText: typeof lastUserText === 'string' ? lastUserText.slice(-2000) : undefined,
          })}\n`,
        )
      } catch {
        // The request log is best-effort; assertions that need it re-check.
      }
      if (req.url !== '/chat/completions' || req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const chunk = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const requestToolCall = toolCall !== undefined && !awaitingToolResult
        && toolCall.match instanceof RegExp
        && toolCall.match.test(String(lastUserText ?? ''))
      if (requestToolCall) {
        awaitingToolResult = true
        chunk({ id: `mock-${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
        chunk({
          id: `mock-${n}`,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: `call_mock_${n}`,
                type: 'function',
                function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
              }],
            },
            finish_reason: null,
          }],
        })
        chunk({ id: `mock-${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      awaitingToolResult = false
      const reply = `MOCK-REPLY-${n}: CHANNEL-OK`
      chunk({ id: `mock-${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      chunk({ id: `mock-${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })
      chunk({ id: `mock-${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port,
        close: () => server.close(),
        /** Number of /chat/completions requests served so far. */
        get requests() {
          return n
        },
        /** Concatenated request log; empty string until the first request. */
        requestLog() {
          try {
            return readFileSync(logFile, 'utf8')
          } catch {
            return ''
          }
        },
      }),
    )
  })
}
