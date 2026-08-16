import { describe, expect, it, vi } from 'vitest'
import { installOpenPathAdapter, openTarget, type OpenPathPort } from '../src/client/controller.ts'

describe('open target parsing', () => {
  it('passes a bare path through with line and column 1', () => {
    expect(openTarget('ws/src/index.ts')).toEqual({ path: 'ws/src/index.ts', line: 1, column: 1 })
  })

  it('splits a path:line suffix', () => {
    expect(openTarget('ws/src/index.ts:42')).toEqual({ path: 'ws/src/index.ts', line: 42, column: 1 })
  })

  it('splits a path:line:col suffix', () => {
    expect(openTarget('ws/src/index.ts:42:7')).toEqual({ path: 'ws/src/index.ts', line: 42, column: 7 })
  })

  it('keeps a path whose trailing segment is not numeric', () => {
    expect(openTarget('ws/v1.2:final')).toEqual({ path: 'ws/v1.2:final', line: 1, column: 1 })
  })
})

describe('DSH openPath compatibility adapter', () => {
  it('intercepts and restores an inherited method without leaving an own property', async () => {
    class Workspaces implements OpenPathPort {
      async openPath(): Promise<void> {}
    }
    const workspaces = new Workspaces()
    const open = vi.fn(async () => {})
    const dispose = installOpenPathAdapter(workspaces, open)
    expect(Object.hasOwn(workspaces, 'openPath')).toBe(true)
    await workspaces.openPath('/workspace/file.ts')
    expect(open).toHaveBeenCalledWith('/workspace/file.ts')
    dispose()
    expect(Object.hasOwn(workspaces, 'openPath')).toBe(false)
    expect(workspaces.openPath).toBe(Workspaces.prototype.openPath)
  })

  it('restores an existing own descriptor exactly', () => {
    const original = async () => {}
    const workspaces = { openPath: original }
    const before = Object.getOwnPropertyDescriptor(workspaces, 'openPath')
    const dispose = installOpenPathAdapter(workspaces, async () => {})
    dispose()
    expect(Object.getOwnPropertyDescriptor(workspaces, 'openPath')).toEqual(before)
  })
})
