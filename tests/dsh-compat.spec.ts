import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const DSH_ROOT = resolve(import.meta.dirname, '../../deepseek-harness')

describe('DeepSeek Harness 47f9438 compatibility seam', () => {
  it('still exposes the inherited string-only workspace opener', async () => {
    const source = await readFile(
      resolve(DSH_ROOT, 'packages/client/runtime/src/client/workspaces/service.ts'),
      'utf8',
    )
    expect(source).toContain('export class WorkspaceRuntime implements IWorkspaces')
    expect(source).toMatch(/async openPath\(path: string\): Promise<void>/)
  })

  it('still routes conversation file clicks through workspaces.openPath', async () => {
    const source = await readFile(
      resolve(DSH_ROOT, 'packages/client/ui-conversation/src/client/apply.ts'),
      'utf8',
    )
    expect(source).toContain('void workspaces.openPath(resolveWorkspacePath(cwd, path))')
  })

  it('still declares the additive root overlay slot', async () => {
    const source = await readFile(
      resolve(DSH_ROOT, 'packages/client/ui-layout/src/client/index.ts'),
      'utf8',
    )
    expect(source).toContain("'shell.overlay': { kind: 'list'; scope: 'root' }")
  })
})
