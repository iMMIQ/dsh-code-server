/**
 * TEST A — runtime-only settings persistence (no DSH involved).
 *
 * Boots the packaged runtime directly and guards the two regressions that
 * once shipped: settings written in the browser must land in the server-side
 * `User/settings.json` (not `Machine/`, not browser-only storage), and after
 * a reload they must apply (font size renders). Also proves workspace trust
 * is off (no Restricted Mode banner) and the TypeScript language features
 * still produce diagnostics — both broke together once before.
 *
 *   node tests/e2e/runtime-settings.mjs --runtime <path-to-runtime-launcher>
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { parseArgs, portsFor } from './lib/args.mjs'
import { brokenTs } from './lib/dsh-stack.mjs'
import { check, focusEditor, runPaletteCommand } from './lib/workbench.mjs'

const opts = parseArgs(process.argv.slice(2), { requireHarness: false })
const ports = portsFor(opts.portBase)
const base = await mkdtemp(join(tmpdir(), 'dsh-e2e-rt-'))
const ws = join(base, 'ws')
const ud = join(base, 'user-data')
const ext = join(base, 'extensions')
await mkdir(ws, { recursive: true })
await writeFile(join(ws, 'broken.ts'), brokenTs)

const runtime = spawn(opts.runtime, [
  '--user-data-dir', ud,
  '--extensions-dir', ext,
  '--bind-addr', `127.0.0.1:${String(ports.runtime)}`,
  '--auth', 'none',
  '--disable-workspace-trust',
  '--disable-telemetry',
  '--disable-update-check',
], { env: { ...process.env, NODE_EXEC_PATH: process.execPath }, stdio: ['ignore', 'pipe', 'pipe'] })
let runtimeLog = ''
runtime.stdout.on('data', d => { runtimeLog += d })
runtime.stderr.on('data', d => { runtimeLog += d })

const read = p => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return '(absent)'
  }
}
const waitMs = ms => new Promise(r => setTimeout(r, ms))
async function waitUntil(fn, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true
    await waitMs(1500)
  }
  console.log(`[wait] ${label}: TIMEOUT`)
  return false
}

let failed = false
try {
  const url = `http://127.0.0.1:${String(ports.runtime)}`
  const up = await waitUntil(async () => {
    try {
      return (await fetch(url)).ok
    } catch {
      return false
    }
  }, 60_000, 'runtime boot')
  await check('runtime boots and serves the workbench', up, null, opts.outDir)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  try {
    await page.goto(`${url}/?folder=${ws}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.explorer-folders-view .monaco-list-row', { timeout: 60_000 })
    await page.waitForTimeout(5000)
    await page.screenshot({ path: `${opts.outDir}/a1-workbench.png` })

    // Workspace trust is off: no Restricted Mode banner may appear.
    const banner = await page.getByText('Restricted Mode', { exact: false }).count()
    await check('workspace trust disabled (no Restricted Mode banner)', banner === 0, page, opts.outDir, 'a2-trust-banner.png')

    // TS language features alive: the fixture must produce error squiggles.
    await page.getByText('broken.ts', { exact: false }).first().dblclick({ timeout: 10_000 })
    await page.waitForSelector('.view-lines', { timeout: 20_000 })
    const squiggles = await waitUntil(
      () => page.locator('.squiggly-error').count().then(n => n > 0),
      90_000,
      'TS diagnostics',
    )
    await check('TypeScript diagnostics render (extension host not excluded)', squiggles, page, opts.outDir, 'a3-no-squiggles.png')
    await page.screenshot({ path: `${opts.outDir}/a4-squiggles.png` })

    // Write a setting through the browser and confirm it lands in User/settings.json.
    await runPaletteCommand(page, 'Preferences: Open User Settings (JSON)')
    await page.waitForSelector('.view-lines', { timeout: 20_000 })
    await page.waitForTimeout(3000)
    // Native edit context: focus is already in the editor after the palette.
    // Replace the whole document: appending after the closing brace would
    // produce invalid JSON that silently never applies after a reload.
    await page.keyboard.press('Control+a')
    await page.keyboard.type('{\n  "editor.fontSize": 17\n}')
    await page.keyboard.press('Control+s')
    await page.waitForTimeout(3000)
    const userSettings = read(join(ud, 'User', 'settings.json'))
    const machineSettings = read(join(ud, 'Machine', 'settings.json'))
    await check('browser settings write lands in User/settings.json', userSettings.includes('"editor.fontSize": 17'), page, opts.outDir, 'a5-write.png')
    await check('Machine/settings.json is never created', machineSettings === '(absent)', null, opts.outDir)

    // Reload: the file must round-trip and actually apply to the editor.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.monaco-workbench', { timeout: 60_000 })
    await page.waitForTimeout(6000)
    await runPaletteCommand(page, 'Preferences: Open User Settings (JSON)')
    await page.waitForSelector('.view-lines', { timeout: 20_000 })
    await page.waitForTimeout(3000)
    await check('settings editor focused after reload', await focusEditor(page), page, opts.outDir, 'a6-reload.png')
    const fontSize = await page.evaluate(() => {
      const el = document.querySelector('.monaco-editor.focused .view-lines')
      return el ? getComputedStyle(el).fontSize : '(none)'
    })
    await check('fontSize round-trips after reload (17px)', fontSize === '17px', page, opts.outDir, 'a7-font.png')
    await page.screenshot({ path: `${opts.outDir}/a8-done.png` })
  } finally {
    await browser.close()
  }
  console.log('RESULT: PASS')
} catch (err) {
  failed = true
  console.log(`RESULT: FAIL\n${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  runtime.kill('SIGTERM')
  await waitMs(1000)
  spawnSync('fuser', ['-k', `${String(ports.runtime)}/tcp`], { stdio: 'ignore' })
  if (!opts.keep && !failed) {
    const { rmSync } = await import('node:fs')
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  } else if (failed) {
    console.log(`runtime log tail:\n${runtimeLog.slice(-3000)}`)
    console.log(`kept test tree for debugging: ${base}`)
  }
}
