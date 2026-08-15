/**
 * TEST C — full stack: the Ask / Fix workbench commands.
 *
 * `DSH: Ask About This Selection` must deliver the editor selection to the
 * session, and `DSH: Fix Problems in This File` must deliver the composed
 * diagnostics (all five fixture errors, with their TS codes). Both are
 * asserted in the session log AND in the mock LLM request log — proving the
 * full plugin route -> followup -> conversation-model chain.
 *
 *   node tests/e2e/dsh-commands.mjs --runtime <launcher> --harness <dsh checkout>
 */
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { parseArgs, portsFor, repoRoot } from './lib/args.mjs'
import { makeBaseDir, startDshStack } from './lib/dsh-stack.mjs'
import { check, focusEditor, openEditor, openWorkbench, runPaletteCommand, selectLine, waitFor } from './lib/workbench.mjs'

const opts = parseArgs(process.argv.slice(2), { requireHarness: true })
const ports = portsFor(opts.portBase)
const runId = randomUUID().slice(0, 8)
const ASK_SENTINEL = `E2EASK-${runId}`

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

    // Wait for TS diagnostics: the fix command composes from them.
    const squiggles = await waitFor(
      () => page.locator('.squiggly-error').count().then(n => n > 0),
      90_000,
      'TS diagnostics',
    )
    await check('TypeScript diagnostics available', squiggles.ok, page, opts.outDir, 'c0-no-squiggles.png')

    // ---- Ask: selection rides along ----
    await check('editor focused', await focusEditor(page), page, opts.outDir, 'c1-focus.png')
    await selectLine(page, 2)
    await page.waitForTimeout(500)
    await runPaletteCommand(page, 'DSH: Ask About This Selection')
    await page.waitForTimeout(500)
    // The palette command prompts for the question: a quick-input box with
    // the DSH placeholder opens (distinct from the palette's own input).
    const askBox = page.locator('.quick-input-widget input[placeholder*="DSH agent"]')
    await askBox.waitFor({ timeout: 10_000 })
    await check('ask input box opens', (await askBox.count()) > 0, page, opts.outDir, 'c2-askbox.png')
    await page.keyboard.type(`${ASK_SENTINEL} 为什么这一行报错？`)
    await page.waitForTimeout(500)
    await page.keyboard.press('Enter')

    const askDelivered = () => {
      const log = stack.sessionLogText()
      const i = log.lastIndexOf(ASK_SENTINEL)
      return i >= 0 && log.slice(i).includes('nam')
    }
    const askSent = await waitFor(askDelivered, 60_000, 'ask delivered')
    await check('ask selection + question reach the session', askSent.ok, page, opts.outDir, 'c3-ask-sent.png')
    const askAnswered = await waitFor(() => {
      const log = stack.sessionLogText()
      const i = log.lastIndexOf(ASK_SENTINEL)
      return i >= 0 && /MOCK-REPLY-\d+/.test(log.slice(i)) && log.slice(i).includes('turn/end')
    }, 120_000, 'ask reply')
    await check('mock LLM answered the ask turn', askAnswered.ok, page, opts.outDir, 'c4-ask-reply.png')
    await check('ask turn reached the conversation model', stack.llmRequestLog().includes(ASK_SENTINEL), null, opts.outDir)

    // ---- Fix: sends immediately with the composed diagnostics ----
    await check('editor refocused for fix', await focusEditor(page), page, opts.outDir, 'c5-focus.png')
    const logBeforeFix = stack.sessionLogText().length
    await runPaletteCommand(page, 'DSH: Fix Problems in This File')
    // The fix prompt is a fixed composition (no input box): identify it by
    // its opening line plus the fixture's diagnostic codes.
    const FIX_MARK = 'Fix the problems reported in this file'
    const fixDelivered = () => {
      const log = stack.sessionLogText()
      const i = log.indexOf(FIX_MARK, logBeforeFix)
      if (i < 0) return false
      const rest = log.slice(i)
      // The fixture's TS codes must all be composed in.
      return ['TS2552', 'TS2322', 'TS2345', 'TS6133'].every(code => rest.includes(code))
    }
    let seenToasts = ''
    const fixSent = await waitFor(() => {
      const log = stack.sessionLogText()
      const i = log.indexOf(FIX_MARK, logBeforeFix)
      if (i >= 0) return true
      // capture any notification while waiting (they auto-dismiss)
      return page
        .evaluate(() => {
          const area = document.querySelector('.notifications-area')
          return area ? (area.textContent ?? '').trim() : ''
        })
        .then(t => {
          if (t !== '') seenToasts = t
          return false
        })
    }, 60_000, 'fix delivered')
    if (seenToasts !== '') console.log(`[fix] notification seen: ${seenToasts.slice(0, 300)}`)
    await check('fix composes all fixture diagnostics into the session', fixSent.ok, page, opts.outDir, 'c6-fix-sent.png')
    const fixAnswered = await waitFor(() => {
      const log = stack.sessionLogText()
      const i = log.indexOf(FIX_MARK, logBeforeFix)
      return i >= 0 && /MOCK-REPLY-\d+/.test(log.slice(i)) && log.slice(i).includes('turn/end')
    }, 120_000, 'fix reply')
    await check('mock LLM answered the fix turn', fixAnswered.ok, page, opts.outDir, 'c7-fix-reply.png')
    await page.screenshot({ path: `${opts.outDir}/c8-done.png` })
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
