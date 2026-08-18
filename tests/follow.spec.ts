import { describe, expect, it, vi } from 'vitest'
import {
  currentWorkspaceFolder, installWorkspaceFollow,
  type FollowSessionsSnapshot, type FollowSnapshotPort, type FollowWorkspacesSnapshot,
} from '../src/client/follow.ts'

function snapshotPort<T>(initial: T): FollowSnapshotPort<T> & {
  set(value: T): void
  touch(): void
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: fn => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set: next => {
      value = next
      for (const fn of listeners) fn()
    },
    touch: () => {
      for (const fn of listeners) fn()
    },
  }
}

const workspacesOf = (rows: { path: string; sessionIds: string[] }[]): FollowWorkspacesSnapshot =>
  ({ items: rows })

describe('current workspace derivation', () => {
  it('returns the workspace owning the selected session', () => {
    const workspaces = workspacesOf([
      { path: '/ws/alpha', sessionIds: ['s1', 's2'] },
      { path: '/ws/beta', sessionIds: ['s3'] },
    ])
    expect(currentWorkspaceFolder({ current: 's3' }, workspaces)).toBe('/ws/beta')
    expect(currentWorkspaceFolder({ current: 's1' }, workspaces)).toBe('/ws/alpha')
  })

  it('returns null without a selection or for an unaccounted session', () => {
    const workspaces = workspacesOf([{ path: '/ws/alpha', sessionIds: ['s1'] }])
    expect(currentWorkspaceFolder({}, workspaces)).toBeNull()
    expect(currentWorkspaceFolder({ current: 'sX' }, workspaces)).toBeNull()
    expect(currentWorkspaceFolder({ current: 's1' }, {})).toBeNull()
  })
})

describe('workspace following installer', () => {
  it('fires once at install when a folder is already derivable', () => {
    const sessions = snapshotPort<FollowSessionsSnapshot>({ current: 's1' })
    const workspaces = snapshotPort<FollowWorkspacesSnapshot>(
      workspacesOf([{ path: '/ws/alpha', sessionIds: ['s1'] }]),
    )
    const follow = vi.fn()
    installWorkspaceFollow({ sessions, workspaces }, follow)
    expect(follow).toHaveBeenCalledTimes(1)
    expect(follow).toHaveBeenCalledWith('/ws/alpha')
  })

  it('fires on session switches and settles on the owning workspace', () => {
    const sessions = snapshotPort<FollowSessionsSnapshot>({ current: undefined })
    const workspaces = snapshotPort<FollowWorkspacesSnapshot>(workspacesOf([
      { path: '/ws/alpha', sessionIds: ['s1'] },
      { path: '/ws/beta', sessionIds: ['s2'] },
    ]))
    const follow = vi.fn()
    installWorkspaceFollow({ sessions, workspaces }, follow)
    expect(follow).not.toHaveBeenCalled()

    sessions.set({ current: 's1' })
    expect(follow).toHaveBeenCalledWith('/ws/alpha')
    sessions.set({ current: 's2' })
    expect(follow).toHaveBeenCalledWith('/ws/beta')
    workspaces.touch()
    expect(follow).toHaveBeenCalledTimes(2)
  })

  it('keeps the last folder when the selection becomes unaccounted', () => {
    const sessions = snapshotPort<FollowSessionsSnapshot>({ current: 's1' })
    const workspaces = snapshotPort<FollowWorkspacesSnapshot>(workspacesOf([
      { path: '/ws/alpha', sessionIds: ['s1'] },
      { path: '/ws/beta', sessionIds: ['s2'] },
    ]))
    const follow = vi.fn()
    installWorkspaceFollow({ sessions, workspaces }, follow)
    sessions.set({ current: 's-new' })
    sessions.set({ current: undefined })
    expect(follow).toHaveBeenCalledTimes(1)
    // Returning to the same workspace re-derives the same folder — no re-fire.
    sessions.set({ current: 's1' })
    expect(follow).toHaveBeenCalledTimes(1)
    // A different workspace after the gap still fires.
    sessions.set({ current: 's2' })
    expect(follow).toHaveBeenCalledTimes(2)
    expect(follow).toHaveBeenLastCalledWith('/ws/beta')
  })

  it('stops delivering after disposal', () => {
    const sessions = snapshotPort<FollowSessionsSnapshot>({ current: 's1' })
    const workspaces = snapshotPort<FollowWorkspacesSnapshot>(workspacesOf([
      { path: '/ws/alpha', sessionIds: ['s1'] },
      { path: '/ws/beta', sessionIds: ['s2'] },
    ]))
    const follow = vi.fn()
    const dispose = installWorkspaceFollow({ sessions, workspaces }, follow)
    dispose()
    sessions.set({ current: 's2' })
    expect(follow).toHaveBeenCalledTimes(1)
  })
})
