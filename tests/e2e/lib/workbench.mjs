/**
 * Playwright helpers against the code-server workbench, distilled from the
 * experiments that validated these selectors:
 *
 * - the command palette is `.quick-input-widget input`
 * - the chat view input is a monaco textbox labelled "Chat Input"; clicks on
 *   it need `force: true`
 * - the Ctrl+I inline-chat input is a textbox with placeholder "Describe …";
 *   the widget itself is flaky to open, so retry the keypress
 * - this monaco build uses the native edit context (no `.inputarea`
 *   textarea); keyboard typing works once the editor holds focus
 * - measure `.monaco-editor.focused .view-lines` — background editors are
 *   always present at the default font size
 */

export async function openWorkbench(browser, sidecarUrl, ws) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.goto(`${sidecarUrl}/?folder=${ws}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.explorer-folders-view .monaco-list-row', { timeout: 60_000 })
  await page.waitForTimeout(5000)
  return page
}

export async function openEditor(page, fileName) {
  await page.getByText(fileName, { exact: false }).first().dblclick({ timeout: 10_000 })
  await page.waitForSelector('.view-lines', { timeout: 20_000 })
  await page.waitForTimeout(4000)
}

export async function runPaletteCommand(page, command) {
  await page.keyboard.press('Control+Shift+P')
  const input = page.locator('.quick-input-widget input').first()
  await input.waitFor({ timeout: 10_000 })
  await page.keyboard.type(command)
  await page.waitForTimeout(1000)
  // Enter does not always submit on the first press. The palette's input
  // keeps the typed command as its value; a command that opens its own
  // follow-up input (like DSH: Ask) swaps in an empty one — so retry only
  // while the palette itself is still holding the command text.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1500)
    const state = await page.locator('.quick-input-widget input').first().evaluate(el => ({ value: el.value, placeholder: el.placeholder })).catch(() => null)
    if (state === null || state.value !== command) return
  }
  throw new Error(`palette command never submitted: ${command}`)
}

/** True when the editor pane owns keyboard focus. */
export async function editorFocused(page) {
  return page.evaluate(() => {
    const el = document.activeElement
    return !!(el && el.closest && el.closest('.monaco-editor'))
  })
}

/** Click into the editor until it owns focus (first click can be swallowed). */
export async function focusEditor(page) {
  for (let i = 0; i < 6; i++) {
    await page.locator('.view-lines').first().click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(800)
    if (await editorFocused(page)) return true
  }
  return false
}

/** Select the 1-based `line` in the active editor. */
export async function selectLine(page, line) {
  await page.keyboard.press('Control+Home')
  for (let i = 1; i < line; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+End')
}

export function chatInput(page) {
  return page.locator('[role="textbox"][aria-label*="Chat Input"]').first()
}

/**
 * Open the Ctrl+I inline-chat widget, retrying the keypress. The widget is
 * flaky to open on the first press; retries keep the selection intact (a
 * plain editor click would collapse it) and only re-click when the editor
 * actually lost focus.
 */
export async function openInlineChat(page, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    if (!(await editorFocused(page)) && i > 0) {
      await page.locator('.view-lines').first().click({ timeout: 5000 }).catch(() => {})
    }
    await page.keyboard.press('Control+I')
    await page.waitForTimeout(3000)
    const box = page.locator('[role="textbox"][aria-placeholder*="Describe"]').first()
    const n = await page.locator('[role="textbox"][aria-placeholder*="Describe"]').count()
    console.log(`[inline] ctrl+i attempt ${String(i + 1)}: describe-box=${String(n)}`)
    if (n > 0) return box
    await page.keyboard.press('Escape').catch(() => {})
  }
  return null
}

/**
 * Submit text into a chat/inline input: Enter does not always submit on the
 * first press, so retry while the sentinel has not landed in the log.
 */
export async function submitWithRetry(page, box, text, delivered, attempts = 8) {
  await box.click({ timeout: 5000, force: true })
  await page.keyboard.type(text)
  await page.waitForTimeout(1200)
  for (let i = 0; i < attempts; i++) {
    await page.keyboard.press('Enter')
    await new Promise(r => setTimeout(r, 5000))
    if (delivered()) return true
    await box.click({ timeout: 5000, force: true }).catch(() => {})
  }
  return false
}

export async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000))
    if (predicate()) return { ok: true, elapsed: Date.now() - start }
  }
  console.log(`[wait] ${label}: TIMEOUT after ${String(Date.now() - start)}ms`)
  return { ok: false, elapsed: Date.now() - start }
}

/** Assertion helper: logs PASS/FAIL; failures take a screenshot, then throw. */
export async function check(label, ok, page, outDir, shotName) {
  const pass = ok === true
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) {
    if (page && shotName) {
      await page.screenshot({ path: `${outDir}/${shotName}` }).catch(() => {})
    }
    throw new Error(`assertion failed: ${label}`)
  }
}
