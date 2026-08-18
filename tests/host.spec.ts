import { mkdtemp, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKBENCH_SETTINGS, chatCaptureStep, containingWorkspaceRoot, defaultCodeServerExecutable,
  installAskExtension, openCodeServerArgs, openFolderArgs, parseAskRequest, pickLiveSession,
  purgeCopilotExtensions, resolveAskWorkspace, resolveOpenPath, seedWorkbenchSettings,
  summarizeToolResult, tokensEqual,
} from '../src/index.ts'

describe('host boundary', () => {
  it('falls back to PATH when the package has no bundled runtime', () => {
    expect(defaultCodeServerExecutable('/path/that/does/not/exist')).toBe('code-server')
  })

  it('rejects a full package built for another platform', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'dsh-code-server-runtime-'))
    await mkdir(join(runtime, 'bin'))
    await Promise.all([
      writeFile(join(runtime, 'bin', 'code-server'), ''),
      writeFile(join(runtime, 'dsh-runtime.json'), JSON.stringify({
        platform: process.platform === 'linux' ? 'darwin' : 'linux',
        arch: process.arch,
        version: '4.132.0-dsh.1',
      })),
    ])
    expect(() => defaultCodeServerExecutable(runtime)).toThrow('targets')
  })

  it('builds an argv-only reuse-window command', () => {
    expect(openCodeServerArgs(
      { userDataDir: '/state/user data', extensionsDir: '/state/extensions' },
      { path: '/workspace/a file.ts', line: 8, column: 3 },
    )).toEqual([
      '--user-data-dir', '/state/user data',
      '--extensions-dir', '/state/extensions',
      '--disable-workspace-trust',
      '--reuse-window', '/workspace/a file.ts:8:3',
    ])
  })

  it('builds a bare folder-switch command without a line suffix', () => {
    expect(openFolderArgs(
      { userDataDir: '/state/user data', extensionsDir: '/state/extensions' },
      '/workspaces/project b',
    )).toEqual([
      '--user-data-dir', '/state/user data',
      '--extensions-dir', '/state/extensions',
      '--disable-workspace-trust',
      '--reuse-window', '/workspaces/project b',
    ])
  })

  it('finds the longest registered root containing the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-server-'))
    const nested = join(root, 'nested')
    const deep = join(nested, 'deep.ts')
    const top = join(root, 'top.ts')
    await mkdir(nested)
    await Promise.all([writeFile(deep, ''), writeFile(top, '')])
    expect(await containingWorkspaceRoot(deep, [root, nested])).toBe(await realpath(nested))
    expect(await containingWorkspaceRoot(deep, [nested, root])).toBe(await realpath(nested))
    expect(await containingWorkspaceRoot(top, [root, nested])).toBe(await realpath(root))
  })

  it('maps outside files and vanished roots to no owning workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-server-'))
    const other = await mkdtemp(join(tmpdir(), 'dsh-code-server-'))
    const file = join(root, 'a.ts')
    await writeFile(file, '')
    expect(await containingWorkspaceRoot(file, [other])).toBeUndefined()
    expect(await containingWorkspaceRoot(file, [join(root, 'vanished')])).toBeUndefined()
  })

})

describe('open path resolution', () => {
  it('accepts existing paths anywhere on the machine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-server-'))
    const workspace = join(root, 'work')
    const inside = join(workspace, 'a.ts')
    const outside = join(root, 'outside.ts')
    const scratch = join(root, 'scratch', 'note.md')
    await mkdir(workspace)
    await writeFile(inside, '')
    await writeFile(outside, '')
    await mkdir(dirname(scratch))
    await writeFile(scratch, 'x')
    await expect(resolveOpenPath(inside)).resolves.toBe(await realpath(inside))
    await expect(resolveOpenPath(outside)).resolves.toBe(await realpath(outside))
    await expect(resolveOpenPath(scratch)).resolves.toBe(await realpath(scratch))
  })

  it('resolves symlinks to their canonical target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-server-'))
    const target = join(root, 'real.log')
    const link = join(root, 'link.log')
    await Promise.all([writeFile(target, 'x'), symlink(target, link)])
    await expect(resolveOpenPath(link)).resolves.toBe(await realpath(target))
  })

  it('rejects paths that do not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-server-'))
    await expect(resolveOpenPath(join(root, 'missing.ts'))).rejects.toThrow('does not exist')
  })
})

describe('ask route helpers', () => {
  it('validates ask bodies', () => {
    expect(parseAskRequest({ text: 'why does this fail?', file: '/ws/a.ts' }))
      .toEqual({ text: 'why does this fail?', file: '/ws/a.ts' })
    expect(parseAskRequest({ text: 'no file' })).toEqual({ text: 'no file', file: undefined })
    expect(() => parseAskRequest({})).toThrow('non-empty')
    expect(() => parseAskRequest({ text: '   ' })).toThrow('non-empty')
    expect(() => parseAskRequest({ text: 'x'.repeat(32_001) })).toThrow('at most')
    expect(() => parseAskRequest({ text: 'ok', file: 'relative/path.ts' })).toThrow('absolute')
  })

  it('compares ask tokens without accepting mismatches', () => {
    expect(tokensEqual('secret', 'secret')).toBe(true)
    expect(tokensEqual('secret', 'other')).toBe(false)
    expect(tokensEqual('secret', 'secret ')).toBe(false)
    expect(tokensEqual('secret', undefined)).toBe(false)
    expect(tokensEqual('secret', '')).toBe(false)
  })

  it('resolves the workspace containing the anchor file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-server-'))
    const [alpha, beta] = [join(root, 'alpha'), join(root, 'beta')]
    await Promise.all([mkdir(alpha), mkdir(beta)])
    const file = join(alpha, 'deep', 'a.ts')
    await mkdir(dirname(file))
    await writeFile(file, '')
    const workspaces = [{ path: beta, sessionIds: ['s-beta'] }, { path: alpha, sessionIds: ['s-alpha'] }]
    await expect(resolveAskWorkspace(file, workspaces)).resolves.toBe(workspaces[1])
    const stranger = join(root, 'stranger.ts')
    await writeFile(stranger, '')
    await expect(resolveAskWorkspace(stranger, workspaces)).rejects.toThrow('outside')
  })

  it('picks the newest session with a live agent', () => {
    const live = (id: string) => (id === 'old' || id === 'older' ? { id, followup: () => {} } : undefined)
    const workspace = { path: '/ws', sessionIds: ['old', 'dead', 'older'] }
    const newest = pickLiveSession(workspace, live)
    expect(newest?.id).toBe('older')
    expect(pickLiveSession({ path: '/ws', sessionIds: ['dead'] }, live)).toBeUndefined()
    expect(pickLiveSession({ path: '/ws' }, live)).toBeUndefined()
  })

  it('stages the workbench extension and replaces stale versions', async () => {
    const source = new URL('../extension/', import.meta.url).pathname
    const extensionsDir = await mkdtemp(join(tmpdir(), 'dsh-cs-ext-'))
    const stale = join(extensionsDir, 'immiq.dsh-ask-0.0.1')
    await mkdir(stale)
    await writeFile(join(stale, 'old.txt'), '')
    // A stale registry row pointing at the removed dir plus an unrelated entry.
    await writeFile(join(extensionsDir, 'extensions.json'), JSON.stringify([
      { identifier: { id: 'immiq.dsh-ask' }, version: '0.0.1', relativeLocation: 'immiq.dsh-ask-0.0.1' },
      { identifier: { id: 'other.publisher-ext' }, version: '1.0.0', relativeLocation: 'other.publisher-ext-1.0.0' },
    ]))
    const target = await installAskExtension(extensionsDir, source)
    expect(target).toMatch(/immiq\.dsh-ask-/)
    const { readdir, readFile: read } = await import('node:fs/promises')
    const versioned = expect.arrayContaining(['extensions.json', target.split('/').pop()])
    expect(await readdir(extensionsDir)).toEqual(versioned)
    const manifest = JSON.parse(await read(join(target, 'package.json'), 'utf8')) as { main: string }
    expect(manifest.main).toBe('./extension.js')
    expect(await read(join(target, 'extension.js'), 'utf8')).toContain('dsh.ask')
    const registry = JSON.parse(await read(join(extensionsDir, 'extensions.json'), 'utf8')) as {
      identifier: { id: string }
      version?: string
      relativeLocation?: string
    }[]
    expect(registry.map(row => row.identifier.id)).toEqual(['other.publisher-ext', 'immiq.dsh-ask'])
    const ours = registry.find(row => row.identifier.id === 'immiq.dsh-ask')
    expect(ours?.version).toBe(manifest.version)
    expect(ours?.relativeLocation).toBe(target.split('/').pop())
  })
})

describe('workbench settings seeding', () => {
  it('creates the settings file with the defaults when absent', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-cs-ud-'))
    const applied = await seedWorkbenchSettings(userDataDir)
    expect(applied).toEqual(Object.keys(DEFAULT_WORKBENCH_SETTINGS))
    expect(DEFAULT_WORKBENCH_SETTINGS['chat.editor.localAgent.enabled']).toBe(false)
    expect(DEFAULT_WORKBENCH_SETTINGS['workbench.secondarySideBar.defaultVisibility']).toBe('hidden')
    const settings = JSON.parse(await readFile(join(userDataDir, 'User', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings).toEqual(DEFAULT_WORKBENCH_SETTINGS)
  })

  it('adds missing keys while keeping explicit user values untouched', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-cs-ud-'))
    const settingsPath = join(userDataDir, 'User', 'settings.json')
    await mkdir(dirname(settingsPath))
    await writeFile(settingsPath, `${JSON.stringify({
      'chat.editor.localAgent.enabled': true, // an explicit user choice must win
      'editor.fontSize': 13,
    }, undefined, '\t')}\n`)
    const applied = await seedWorkbenchSettings(userDataDir, {
      'chat.editor.localAgent.enabled': false,
      'workbench.colorTheme': 'Default Dark Modern',
    })
    expect(applied).toEqual(['workbench.colorTheme'])
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    expect(settings).toEqual({
      'chat.editor.localAgent.enabled': true,
      'editor.fontSize': 13,
      'workbench.colorTheme': 'Default Dark Modern',
    })
  })

  it('leaves an unparsable settings file untouched', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-cs-ud-'))
    const settingsPath = join(userDataDir, 'User', 'settings.json')
    await mkdir(dirname(settingsPath))
    await writeFile(settingsPath, '// hand-written comment\n{"editor.fontSize": 12}')
    expect(await seedWorkbenchSettings(userDataDir)).toEqual([])
    expect(await readFile(settingsPath, 'utf8')).toContain('hand-written comment')
  })
})

describe('copilot residue purge', () => {
  it('removes copilot directories and registry rows, keeping everything else', async () => {
    const extensionsDir = await mkdtemp(join(tmpdir(), 'dsh-cs-ext-'))
    for (const entry of [
      'github.copilot-1.2.3',
      'github.copilot-chat-0.60.0',
      'github.vscode-pull-request-github-1.0.0', // github.* but not copilot
      'immiq.dsh-ask-0.1.6',
    ]) {
      await mkdir(join(extensionsDir, entry))
    }
    // Registry rows carry the real scanner shape; one invalid row aborts the
    // workbench's whole profile scan, so the fixture must stay well-formed.
    const row = (id: string, version: string, dir: string) => ({
      identifier: { id },
      version,
      location: { $mid: 1, path: join(extensionsDir, dir), scheme: 'file' },
      relativeLocation: dir,
    })
    await writeFile(join(extensionsDir, 'extensions.json'), JSON.stringify([
      row('GitHub.copilot-chat', '0.60.0', 'github.copilot-chat-0.60.0'),
      row('immiq.dsh-ask', '0.1.6', 'immiq.dsh-ask-0.1.6'),
    ]))
    const removed = await purgeCopilotExtensions(extensionsDir)
    expect(removed).toEqual(['GitHub.copilot-chat'])
    expect(await readdir(extensionsDir)).toEqual(expect.arrayContaining([
      'extensions.json', 'github.vscode-pull-request-github-1.0.0', 'immiq.dsh-ask-0.1.6',
    ]))
    expect(await readdir(extensionsDir)).not.toContain('github.copilot-1.2.3')
    expect(await readdir(extensionsDir)).not.toContain('github.copilot-chat-0.60.0')
    const registry = JSON.parse(await readFile(join(extensionsDir, 'extensions.json'), 'utf8')) as {
      identifier: { id: string }
    }[]
    expect(registry.map(row => row.identifier.id)).toEqual(['immiq.dsh-ask'])
  })

  it('sweeps unregistered copilot directories and tolerates a broken registry', async () => {
    const extensionsDir = await mkdtemp(join(tmpdir(), 'dsh-cs-ext-'))
    await mkdir(join(extensionsDir, 'github.copilot-1.0.0'))
    await writeFile(join(extensionsDir, 'extensions.json'), 'not json')
    expect(await purgeCopilotExtensions(extensionsDir)).toEqual([])
    expect(await readdir(extensionsDir)).toEqual(['extensions.json'])
    expect(await readFile(join(extensionsDir, 'extensions.json'), 'utf8')).toBe('not json')
  })

  it('never follows a malicious registry location outside the extensions directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cs-ext-root-'))
    const extensionsDir = join(root, 'extensions')
    const outside = join(root, 'keep-me')
    await mkdir(extensionsDir)
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'safe')
    await writeFile(join(extensionsDir, 'extensions.json'), JSON.stringify([{
      identifier: { id: 'GitHub.copilot-chat' },
      version: '0.60.0',
      relativeLocation: '../keep-me',
    }]))

    expect(await purgeCopilotExtensions(extensionsDir)).toEqual(['GitHub.copilot-chat'])
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('safe')
  })
})

describe('chat turn capture', () => {
  const chunk = (text: string) => ({
    type: 'assistant/chunk',
    data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text } },
  })

  it('streams only the turn that starts after delivery', () => {
    let state = 'armed' as ReturnType<typeof chatCaptureStep>['state']
    // tail of a turn already in flight when the followup landed: ignored
    let step = chatCaptureStep(state, chunk('stale'))
    expect(step.emission).toBeUndefined()
    expect(step.state).toBe('armed')
    state = step.state
    step = chatCaptureStep(state, { type: 'turn/start', data: { turn: 2 } })
    expect(step.state).toBe('capturing')
    state = step.state
    step = chatCaptureStep(state, chunk('hello '))
    expect(step.emission).toEqual({ kind: 'delta', text: 'hello ' })
    // non-text chunks (reasoning, block boundaries) pass silently
    step = chatCaptureStep(state, {
      type: 'assistant/chunk',
      data: { turn: 2, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } },
    })
    expect(step.emission).toBeUndefined()
    step = chatCaptureStep(state, chunk('world'))
    expect(step.emission).toEqual({ kind: 'delta', text: 'world' })
    state = step.state
    step = chatCaptureStep(state, { type: 'turn/end', data: { turn: 2, reason: 'done' } })
    expect(step.emission).toEqual({ kind: 'done' })
    expect(step.state).toBe('done')
    // everything after the captured turn is ignored
    expect(chatCaptureStep('done', chunk('late'))).toEqual({ state: 'done', emission: undefined })
  })

  it('forwards tool calls and results of the captured turn', () => {
    let state = 'armed' as ReturnType<typeof chatCaptureStep>['state']
    state = chatCaptureStep(state, { type: 'turn/start', data: { turn: 4 } }).state
    // tool invocation: raw model arguments forwarded verbatim
    let step = chatCaptureStep(state, {
      type: 'tool/call',
      data: { turn: 4, step: 0, callId: 'call_00_x', name: 'read', arguments: '{"file_path": "broken.ts"}' },
    })
    expect(step.state).toBe('capturing')
    expect(step.emission).toEqual({
      kind: 'tool',
      callId: 'call_00_x',
      name: 'read',
      arguments: '{"file_path": "broken.ts"}',
    })
    // result: first text collapsed to one bounded line, success stays silent-flagged
    step = chatCaptureStep(step.state, {
      type: 'tool/result',
      data: {
        turn: 4,
        step: 0,
        message: {
          source: { kind: 'tool', callId: 'call_00_x' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call_00_x',
            content: [{ type: 'text', text: '<path>broken.ts</path>\n<content>\nline 1\nline 2\n' }],
            isError: false,
          }],
        },
      },
    })
    expect(step.emission).toEqual({
      kind: 'toolResult',
      callId: 'call_00_x',
      isError: false,
      summary: '<path>broken.ts</path> <content> line 1 line 2',
    })
    // a failed result is flagged whether the error is in the content or the envelope
    step = chatCaptureStep(step.state, {
      type: 'tool/result',
      data: {
        turn: 4,
        step: 0,
        message: {
          source: { kind: 'tool', callId: 'call_01_y' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call_01_y',
            content: [{ type: 'text', text: 'boom' }],
            isError: true,
          }],
        },
      },
    })
    expect(step.emission).toMatchObject({ kind: 'toolResult', callId: 'call_01_y', isError: true, summary: 'boom' })
    step = chatCaptureStep(step.state, {
      type: 'tool/result',
      data: {
        turn: 4,
        step: 0,
        error: { name: 'ToolError', code: 'EIO' },
        message: { source: { kind: 'tool', callId: 'call_02_z' }, content: [] },
      },
    })
    expect(step.emission).toMatchObject({ kind: 'toolResult', callId: 'call_02_z', isError: true, summary: '' })
    // the turn keeps streaming after tools and still closes on turn/end
    step = chatCaptureStep(step.state, chunk('after tools'))
    expect(step.emission).toEqual({ kind: 'delta', text: 'after tools' })
    step = chatCaptureStep(step.state, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
    expect(step.emission).toEqual({ kind: 'done' })
  })

  it('ignores malformed tool events without leaving the capturing state', () => {
    let state = 'armed' as ReturnType<typeof chatCaptureStep>['state']
    state = chatCaptureStep(state, { type: 'turn/start', data: { turn: 5 } }).state
    for (const bad of [
      { type: 'tool/call', data: { turn: 5, step: 0, name: 'read' } }, // no callId/arguments
      { type: 'tool/call', data: { turn: 5, step: 0, callId: 7, name: 'read', arguments: '{}' } },
      { type: 'tool/result', data: { turn: 5, step: 0, message: { source: {}, content: [] } } }, // no callId
      { type: 'tool/result', data: undefined },
    ]) {
      const step = chatCaptureStep(state, bad)
      expect(step.emission).toBeUndefined()
      expect(step.state).toBe('capturing')
    }
  })

  it('bounds the tool-result summary to one line', () => {
    expect(summarizeToolResult('a\n\n   b\t\tc')).toBe('a b c')
    const long = 'x'.repeat(500)
    const bounded = summarizeToolResult(long)
    expect(bounded.length).toBe(201)
    expect(bounded.endsWith('…')).toBe(true)
    expect(bounded.slice(0, 200)).toBe(long.slice(0, 200))
  })
})
