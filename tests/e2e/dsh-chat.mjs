/**
 * TEST B — full stack: native chat surfaces against a live DSH session.
 *
 * The workbench chat (bare message -> default participant -> host /chat SSE
 * -> session -> mock LLM) and the Ctrl+I inline chat (selection context)
 * must both deliver the sentinel to the session log and stream the mock
 * reply back into the widget.
 *
 *   node tests/e2e/dsh-chat.mjs --runtime <launcher> --harness <dsh checkout>
 */
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { parseArgs, portsFor, repoRoot } from './lib/args.mjs'
import { makeBaseDir, startDshStack } from './lib/dsh-stack.mjs'
import {
  chatInput,
  check,
  focusEditor,
  openEditor,
  openInlineChat,
  openWorkbench,
  runPaletteCommand,
  submitWithRetry,
  waitFor,
} from './lib/workbench.mjs'

const opts = parseArgs(process.argv.slice(2), { requireHarness: true })
const ports = portsFor(opts.portBase)
const runId = randomUUID().slice(0, 8)
const CHAT_SENTINEL = `E2ECHAT-${runId}`
const INLINE_SENTINEL = `E2EINLINE-${runId}`

const base = await makeBaseDir()
const stack = await startDshStack({
  harnessDir: opts.harness,
  pluginDir: repoRoot,
  runtimeBin: opts.runtime,
  baseDir: base,
  ports,
  outDir: opts.outDir,
  activationSentinel: `E2EACT-${runId}`,
  // The chat-view turn must run a real tool first, proving tool calls surface
  // in the chat stream instead of silence until the closing text.
  toolCallMarker: new RegExp(CHAT_SENTINEL),
})

let failed = false
try {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await openWorkbench(browser, stack.sidecarUrl, stack.ws)
    await openEditor(page, 'broken.ts')

    // The bundled extension auto-installed into the sidecar: its palette
    // commands must appear in the command list.
    await page.keyboard.press('Control+Shift+P')
    await page.waitForSelector('.quick-input-widget input', { timeout: 10_000 })
    await page.keyboard.type('DSH:')
    await page.waitForTimeout(1500)
    const dshRows = await page.locator('.quick-input-list .monaco-list-row').count()
    await check('DSH extension active in the sidecar (palette commands listed)', dshRows > 0, page, opts.outDir, 'b0-ext.png')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)

    // ---- Chat view: bare message routes to the default participant ----
    await runPaletteCommand(page, 'Chat: Focus on Chat View')
    await page.waitForTimeout(4000)
    await page.screenshot({ path: `${opts.outDir}/b1-chat-view.png` })
    const input = chatInput(page)
    await check('chat input present', (await input.count()) > 0, page, opts.outDir, 'b1-chat-view.png')

    const delivered = () => stack.sessionLogText().includes(CHAT_SENTINEL)
    const sent = await submitWithRetry(page, input, `${CHAT_SENTINEL} 这个文件有哪些 TypeScript 错误？`, delivered)
    await check('chat message reaches the DSH session', sent, page, opts.outDir, 'b2-chat-sent.png')

    const answered = () => {
      const log = stack.sessionLogText()
      const i = log.lastIndexOf(CHAT_SENTINEL)
      return i >= 0 && /MOCK-REPLY-\d+/.test(log.slice(i))
    }
    const reply = await waitFor(answered, 120_000, 'chat reply')
    await check('mock LLM answered the chat turn', reply.ok, page, opts.outDir, 'b3-chat-reply.png')

    // The turn's opening read of the fixture must surface in the session log
    // (tool/call + tool/result events) — the mock only replies in text after
    // the tool result comes back.
    const turnLog = () => stack.sessionLogText().slice(stack.sessionLogText().lastIndexOf(CHAT_SENTINEL))
    await check(
      'chat turn executes a tool call (session log)',
      (() => { const rest = turnLog(); return rest.includes('"type":"tool/call"') && rest.includes('"name":"read"') && rest.includes('"type":"tool/result"') })(),
      page,
      opts.outDir,
      'b3b-tool-log.png',
    )

    await page.waitForTimeout(3000)
    const widgetText = await page.evaluate(() => {
      const el = document.querySelector('.interactive-session, .chat-view')
      return el ? (el.textContent ?? '') : ''
    })
    await check('chat widget renders the streamed reply', /MOCK-REPLY-\d+/.test(widgetText), page, opts.outDir, 'b4-chat-widget.png')
    await check(
      'chat widget renders the durable tool result row',
      /✓\s*read\b/.test(widgetText) && widgetText.includes('broken.ts') && /·\s*\d+ms/.test(widgetText),
      page,
      opts.outDir,
      'b4b-tool-row.png',
    )
    // The file argument of the tool row is a clickable anchor chip.
    const anchors = await page.evaluate(() => document.querySelectorAll('.chat-inline-anchor-widget').length)
    await check('tool result row carries a clickable file chip', anchors > 0, page, opts.outDir, 'b4c-anchor.png')
    await page.screenshot({ path: `${opts.outDir}/b5-chat-done.png` })

    // ---- Ctrl+I inline chat: selection context rides along ----
    // Same page, with the Chat view still open: the inline zone is an
    // independent surface, and this ordering is the regression guard for the
    // suspicion that using the Chat view kills Ctrl+I (it did not — that
    // earlier reading was a placeholder-based selector matching the Chat
    // view's own input, see workbench.mjs).
    await check('editor refocused for inline chat', await focusEditor(page), page, opts.outDir, 'b6-focus.png')
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Shift+End')

    const box = await openInlineChat(page)
    await check('Ctrl+I inline chat zone opens (Chat view still open)', box !== null, page, opts.outDir, 'b7-inline-fail.png')
    await page.screenshot({ path: `${opts.outDir}/b8-inline-widget.png` })

    const inlineDelivered = () => {
      const log = stack.sessionLogText()
      const i = log.lastIndexOf(INLINE_SENTINEL)
      // The selection context must ride along: the fixture's line 2 text.
      return i >= 0 && log.slice(i).includes('nam')
    }
    const inlineSent = await submitWithRetry(page, box, `${INLINE_SENTINEL} 解释这一行`, inlineDelivered)
    await check('inline message (with selection) reaches the session', inlineSent, page, opts.outDir, 'b9-inline-sent.png')

    const inlineAnswered = () => {
      const log = stack.sessionLogText()
      const i = log.lastIndexOf(INLINE_SENTINEL)
      return i >= 0 && /MOCK-REPLY-\d+/.test(log.slice(i)) && log.slice(i).includes('turn/end')
    }
    const inlineReply = await waitFor(inlineAnswered, 120_000, 'inline reply')
    await check('mock LLM answered the inline turn', inlineReply.ok, page, opts.outDir, 'b10-inline-reply.png')
    await page.waitForTimeout(2000)
    // The fork's zone filter renders plain-text replies in place (upstream
    // only shows pending-confirmation responses, which left ask-mode turns
    // silent), so the streamed answer must be visible inside the zone.
    const zoneState = await page.evaluate(() => {
      const zone = document.querySelector('.inline-chat-2')
      if (zone === null) return { alive: false, text: '', inputText: '' }
      const input = zone.querySelector('[role="textbox"]')
      return { alive: true, text: zone.textContent ?? '', inputText: input ? (input.textContent ?? '') : '' }
    })
    await check(
      'inline zone renders the streamed reply',
      zoneState.alive && /MOCK-REPLY-\d+/.test(zoneState.text),
      page,
      opts.outDir,
      'b11-inline-widget.png',
    )
    await check(
      'inline zone cleared the submitted input',
      !zoneState.inputText.includes(INLINE_SENTINEL),
      page,
      opts.outDir,
      'b11b-inline-input.png',
    )
    await page.screenshot({ path: `${opts.outDir}/b12-inline-done.png` })
  } finally {
    await browser.close()
  }
  console.log('RESULT: PASS')
} catch (err) {
  failed = true
  console.log(`RESULT: FAIL\n${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  await stack.stop()
  if (failed || opts.keep) console.log(`kept test tree: ${base}`)
}
