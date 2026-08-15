import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  authorizeOpenPath, authorizeSpillPath, authorizeWorkspacePath,
  defaultCodeServerExecutable, openCodeServerArgs,
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
