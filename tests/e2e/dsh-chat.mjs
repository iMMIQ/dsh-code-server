/**
 * TEST B — full stack: the chat panel is gone, inline chat reaches DSH.
 *
 * The workbench ships without the Chat view (the conversation lives in the
 * DSH web app beside it), so this guards both sides of that decision: the
 * panel must not render on a cold workbench, and the Ctrl+I inline chat must
 * still deliver the sentinel (with selection context) to the session and
 * stream the mock reply — including the tool call the mock makes first —
 * back into the zone.
 *
 *   node tests/e2e/dsh-chat.mjs --runtime <launcher> --harness <dsh checkout>
 */
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { parseArgs, portsFor, repoRoot } from './lib/args.mjs'
import { makeBaseDir, startDshStack } from './lib/dsh-stack.mjs'
import {
  check,
  focusEditor,
  openEditor,
  openInlineChat,
  openWorkbench,
  submitWithRetry,
  waitFor,
} from './lib/workbench.mjs'

const opts = parseArgs(process.argv.slice(2), { requireHarness: true })
const ports = portsFor(opts.portBase)
const runId = randomUUID().slice(0, 8)
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
  // The inline-chat turn must run a real tool first, proving tool calls still
  // surface through the participant's stream instead of silence until the
  // closing text.
  toolCallMarker: new RegExp(INLINE_SENTINEL),
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

    // ---- The Chat panel must not exist: cold workbench, no aux bar ----
    await page.waitForTimeout(3000)
    const panelState = await page.evaluate(() => {
      const aux = document.querySelector('.part.auxiliarybar')
      const auxVisible = aux !== null && aux.getBoundingClientRect().width > 10
      return {
        chatView: document.querySelector('.chat-view, .interactive-session') !== null,
        chatPane: document.getElementById('workbench.panel.chat') !== null,
        auxVisible,
      }
    })
    await page.screenshot({ path: `${opts.outDir}/b1-no-panel.png` })
    await check(
      'chat panel absent (no chat view, no auxiliary bar)',
      !panelState.chatView && !panelState.chatPane && !panelState.auxVisible,
      page,
      opts.outDir,
      'b1-no-panel.png',
    )

    // ---- Ctrl+I inline chat: selection context rides along ----
    await check('editor refocused for inline chat', await focusEditor(page), page, opts.outDir, 'b2-focus.png')
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Shift+End')

    const box = await openInlineChat(page)
    await check('Ctrl+I inline chat zone opens', box !== null, page, opts.outDir, 'b3-inline-fail.png')
    await page.screenshot({ path: `${opts.outDir}/b4-inline-widget.png` })

    const inlineDelivered = () => {
      const log = stack.sessionLogText()
      const i = log.lastIndexOf(INLINE_SENTINEL)
      // The selection context must ride along: the fixture's line 2 text.
      return i >= 0 && log.slice(i).includes('nam')
    }
    const inlineSent = await submitWithRetry(page, box, `${INLINE_SENTINEL} 解释这一行`, inlineDelivered)
    await check('inline message (with selection) reaches the session', inlineSent, page, opts.outDir, 'b5-inline-sent.png')

    const inlineAnswered = () => {
      const log = stack.sessionLogText()
      const i = log.lastIndexOf(INLINE_SENTINEL)
      return i >= 0 && /MOCK-REPLY-\d+/.test(log.slice(i)) && log.slice(i).includes('turn/end')
    }
    const inlineReply = await waitFor(inlineAnswered, 120_000, 'inline reply')
    await check('mock LLM answered the inline turn', inlineReply.ok, page, opts.outDir, 'b6-inline-reply.png')

    // The turn's opening read of the fixture must surface in the session log
    // (tool/call + tool/result events) — the mock only replies in text after
    // the tool result comes back.
    const turnLog = () => stack.sessionLogText().slice(stack.sessionLogText().lastIndexOf(INLINE_SENTINEL))
    await check(
      'inline turn executes a tool call (session log)',
      (() => { const rest = turnLog(); return rest.includes('"type":"tool/call"') && rest.includes('"name":"read"') && rest.includes('"type":"tool/result"') })(),
      page,
      opts.outDir,
      'b6b-tool-log.png',
    )

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
      'b7-inline-widget.png',
    )
    await check(
      'inline zone cleared the submitted input',
      !zoneState.inputText.includes(INLINE_SENTINEL),
      page,
      opts.outDir,
      'b7b-inline-input.png',
    )
    await page.screenshot({ path: `${opts.outDir}/b8-inline-done.png` })
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
