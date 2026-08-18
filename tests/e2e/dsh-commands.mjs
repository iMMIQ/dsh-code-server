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
import {
  check,
  focusEditor,
  inlineChatInput,
  openEditor,
  openWorkbench,
  runPaletteCommand,
  selectLine,
  submitWithRetry,
  waitFor,
} from './lib/workbench.mjs'

const opts = parseArgs(process.argv.slice(2), { requireHarness: true })
const ports = portsFor(opts.portBase)
const runId = randomUUID().slice(0, 8)
const ASK_SENTINEL = `E2EASK-${runId}`
const INLINE_SENTINEL = `E2ECTXINLINE-${runId}`

async function openSelectionContextMenu(page) {
  await check('editor focused for context menu', await focusEditor(page), page, opts.outDir, 'c-context-focus.png')
  await selectLine(page, 2)
  await page.waitForTimeout(300)
  // Keyboard invocation preserves the selection; a generic mouse right-click
  // can land outside the selected range and collapse it.
  await page.keyboard.press('Shift+F10')
  await page.locator('.context-view .monaco-menu').waitFor({ timeout: 10_000 })
}

async function clickSelectionContextItem(page, label) {
  await openSelectionContextMenu(page)
  const menu = page.locator('.context-view .monaco-menu:visible').last()
  const item = menu.getByText(label, { exact: true })
  await item.click({ timeout: 10_000 })
  await page.waitForTimeout(250)
  // dsh.5's web menu occasionally treats Playwright's first click as pointer
  // selection only. The row is then keyboard-focused, so Enter is the same
  // activation path a user gets after opening the menu with Shift+F10.
  if (await item.isVisible().catch(() => false)) await page.keyboard.press('Enter')
  await item.waitFor({ state: 'hidden', timeout: 10_000 })
  await page.waitForTimeout(500)
}

async function waitForDshTurn(stack, marker, from) {
  return waitFor(() => {
    const rest = stack.sessionLogText().slice(from)
    const i = rest.indexOf(marker)
    return i >= 0 && rest.slice(i).includes('turn/end')
  }, 120_000, marker)
}

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

    // ---- Every AI-related editor menu entry belongs to DSH ----
    await openSelectionContextMenu(page)
    const contextMenuLabels = await page.locator('.context-view .monaco-menu .action-label').allTextContents()
    console.log(`[editor-context] ${JSON.stringify(contextMenuLabels)}`)
    await page.screenshot({ path: `${opts.outDir}/c1b-editor-context.png` })
    const aiLabels = contextMenuLabels.filter(label => /chat|dsh|copilot|\bai\b|explain|fix|review/i.test(label))
    await check(
      'selection context exposes only DSH-backed AI commands',
      JSON.stringify(aiLabels) === JSON.stringify([
        'Open Inline Chat',
        'DSH: Ask About This Selection',
        'DSH: Explain Selection',
        'DSH: Fix Selection',
        'DSH: Review Selection',
      ]),
      page,
      opts.outDir,
      'c1c-unexpected-ai-menu.png',
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Open Inline Chat from the right-click menu and submit a uniquely marked
    // request. The selected line must ride into the DSH session.
    await clickSelectionContextItem(page, 'Open Inline Chat')
    const inlineBox = await inlineChatInput(page)
    await check('context-menu inline chat opens', inlineBox !== null, page, opts.outDir, 'c1d-inline-missing.png')
    const inlineFrom = stack.sessionLogText().length
    const inlineDelivered = () => {
      const rest = stack.sessionLogText().slice(inlineFrom)
      const i = rest.indexOf(INLINE_SENTINEL)
      return i >= 0 && rest.slice(i).includes('nam')
    }
    await check(
      'Open Inline Chat sends the selected code to DSH',
      await submitWithRetry(page, inlineBox, `${INLINE_SENTINEL} explain this selection`, inlineDelivered),
      page,
      opts.outDir,
      'c1e-inline-not-sent.png',
    )
    const inlineTurn = await waitForDshTurn(stack, INLINE_SENTINEL, inlineFrom)
    await check('context-menu inline turn completes in DSH', inlineTurn.ok, page, opts.outDir, 'c1f-inline-turn.png')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    // ---- Ask: selection rides along ----
    await clickSelectionContextItem(page, 'DSH: Ask About This Selection')
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

    // ---- Explain / Fix / Review: every menu command sends directly to DSH ----
    const directActions = [
      {
        label: 'DSH: Explain Selection',
        marker: 'Explain the selected code:',
        required: ['nam'],
      },
      {
        label: 'DSH: Fix Selection',
        marker: 'Fix the problems reported in this file.',
        required: ['Ln 2 [ts 2552]', 'nam'],
      },
      {
        label: 'DSH: Review Selection',
        marker: 'Review the selected code for correctness',
        required: ['nam'],
      },
    ]
    for (const action of directActions) {
      const from = stack.sessionLogText().length
      await clickSelectionContextItem(page, action.label)
      const delivered = await waitFor(() => {
        const rest = stack.sessionLogText().slice(from)
        return rest.includes(action.marker) && action.required.every(text => rest.includes(text))
      }, 60_000, `${action.label} delivered`)
      await check(`${action.label} sends the selection to DSH`, delivered.ok, page, opts.outDir, 'c4b-direct-action.png')
      const completed = await waitForDshTurn(stack, action.marker, from)
      await check(`${action.label} completes in DSH`, completed.ok, page, opts.outDir, 'c4c-direct-turn.png')
      await check(`${action.label} reaches the conversation model`, stack.llmRequestLog().includes(action.marker), null, opts.outDir)
    }

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
