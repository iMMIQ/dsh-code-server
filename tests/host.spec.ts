import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { authorizeWorkspacePath, defaultCodeServerExecutable, openCodeServerArgs } from '../src/index.ts'

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
