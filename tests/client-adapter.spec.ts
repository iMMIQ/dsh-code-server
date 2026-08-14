import { describe, expect, it, vi } from 'vitest'
import { installOpenPathAdapter, type OpenPathPort } from '../src/client/controller.ts'

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
