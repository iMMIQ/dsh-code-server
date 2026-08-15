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

    await page.waitForTimeout(3000)
    const widgetText = await page.evaluate(() => {
      const el = document.querySelector('.interactive-session, .chat-view')
      return el ? (el.textContent ?? '') : ''
    })
    await check('chat widget renders the streamed reply', /MOCK-REPLY-\d+/.test(widgetText), page, opts.outDir, 'b4-chat-widget.png')
    await page.screenshot({ path: `${opts.outDir}/b5-chat-done.png` })

    // ---- Ctrl+I inline chat: selection context rides along ----
    // Once the Chat view has been used, its side bar is part of the saved
    // workbench layout and Ctrl+I no longer opens the inline widget (dead in
    // that layout, observed on the official package). Continue in a fresh
    // page2: same workbench server, pristine layout — like a new browser tab.
    await page.close()
    const page2 = await openWorkbench(browser, stack.sidecarUrl, stack.ws)
    await openEditor(page2, 'broken.ts')
    await check('editor refocused for inline chat', await focusEditor(page2), page2, opts.outDir, 'b6-focus.png')
    await page2.keyboard.press('Control+Home')
    await page2.keyboard.press('ArrowDown')
    await page2.keyboard.press('Shift+End')

    const box = await openInlineChat(page2)
    await check('Ctrl+I inline chat widget opens', box !== null, page2, opts.outDir, 'b7-inline-fail.png')
    await page2.screenshot({ path: `${opts.outDir}/b8-inline-widget.png` })

    const inlineDelivered = () => {
      const log = stack.sessionLogText()
      const i = log.lastIndexOf(INLINE_SENTINEL)
      // The selection context must ride along: the fixture's line 2 text.
      return i >= 0 && log.slice(i).includes('nam')
    }
    const inlineSent = await submitWithRetry(page2, box, `${INLINE_SENTINEL} 解释这一行`, inlineDelivered)
    await check('inline message (with selection) reaches the session', inlineSent, page2, opts.outDir, 'b9-inline-sent.png')

    const inlineAnswered = () => {
      const log = stack.sessionLogText()
      const i = log.lastIndexOf(INLINE_SENTINEL)
      return i >= 0 && /MOCK-REPLY-\d+/.test(log.slice(i)) && log.slice(i).includes('turn/end')
    }
    const inlineReply = await waitFor(inlineAnswered, 120_000, 'inline reply')
    await check('mock LLM answered the inline turn', inlineReply.ok, page2, opts.outDir, 'b10-inline-reply.png')
    await page2.waitForTimeout(3000)
    const inlineText = await page2.evaluate(() => (document.body.textContent ?? '').slice(-4000))
    await check('inline widget renders the reply', /MOCK-REPLY-\d+/.test(inlineText), page2, opts.outDir, 'b11-inline-widget.png')
    await page2.screenshot({ path: `${opts.outDir}/b12-inline-done.png` })
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
