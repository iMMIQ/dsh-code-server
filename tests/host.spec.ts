import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  authorizeOpenPath, authorizeSpillPath, authorizeWorkspacePath,
  chatCaptureStep, defaultCodeServerExecutable, installAskExtension, openCodeServerArgs,
  parseAskRequest, pickLiveSession, resolveAskWorkspace, tokensEqual,
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

  it('allows canonical files under a workspace and rejects siblings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-server-'))
    const workspace = join(root, 'work')
    const sibling = join(root, 'other')
    await Promise.all([mkdir(workspace), mkdir(sibling)])
    const inside = join(workspace, 'inside.ts')
    const outside = join(sibling, 'outside.ts')
    await Promise.all([writeFile(inside, ''), writeFile(outside, '')])
    await expect(authorizeWorkspacePath(inside, [workspace])).resolves.toBe(await realpath(inside))
    await expect(authorizeWorkspacePath(outside, [workspace])).rejects.toThrow('outside')
  })
})

describe('output spill authorization', () => {
  it('accepts a regular file inside a dsh-subprocess spill directory', async () => {
    const spillDir = await mkdtemp(join(tmpdir(), 'dsh-subprocess-'))
    const spill = join(spillDir, 'dsh-subprocess-421-1-abc-stdout.log')
    await writeFile(spill, 'full output')
    await expect(authorizeSpillPath(spill)).resolves.toBe(await realpath(spill))
  })

  it('rejects the spill directory itself and non-file entries', async () => {
    const spillDir = await mkdtemp(join(tmpdir(), 'dsh-subprocess-'))
    await expect(authorizeSpillPath(spillDir)).rejects.toThrow('spill file')
    const nested = join(spillDir, 'nested')
    await mkdir(nested)
    await expect(authorizeSpillPath(nested)).rejects.toThrow('spill file')
  })

  it('rejects plain temp files outside the dsh-subprocess prefix', async () => {
    const plain = join(tmpdir(), 'dsh-subprocess-fake-not-a-dir.log')
    await writeFile(plain, 'no')
    await expect(authorizeSpillPath(plain)).rejects.toThrow('spill file')
    const other = await mkdtemp(join(tmpdir(), 'other-tool-'))
    const file = join(other, 'out.log')
    await writeFile(file, 'no')
    await expect(authorizeSpillPath(file)).rejects.toThrow('spill file')
  })

  it('resolves symlinks before the prefix check', async () => {
    const spillDir = await mkdtemp(join(tmpdir(), 'dsh-subprocess-'))
    const secret = join(spillDir, '..', 'dsh-secret.txt')
    await writeFile(secret, 'secret')
    const link = join(spillDir, 'dsh-subprocess-1-1-abc-stdout.log')
    await symlink(secret, link)
    await expect(authorizeSpillPath(link)).rejects.toThrow('spill file')
  })

  it('authorizeOpenPath accepts either workspace files or spill files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-server-'))
    const workspace = join(root, 'work')
    await mkdir(workspace)
    const inside = join(workspace, 'a.ts')
    const spillDir = await mkdtemp(join(tmpdir(), 'dsh-subprocess-'))
    const spill = join(spillDir, 'dsh-subprocess-9-2-def-stderr.log')
    await Promise.all([writeFile(inside, ''), writeFile(spill, '')])
    const outside = join(root, 'b.ts')
    await writeFile(outside, '')
    await expect(authorizeOpenPath(inside, [workspace])).resolves.toBe(await realpath(inside))
    await expect(authorizeOpenPath(spill, [workspace])).resolves.toBe(await realpath(spill))
    await expect(authorizeOpenPath(outside, [workspace])).rejects.toThrow('outside')
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
})
