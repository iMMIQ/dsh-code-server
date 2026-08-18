/**
 * Workspace following: keep the workbench's folder aligned with the
 * conversation the user is looking at. DSH's sessions service exposes the
 * current selection and the workspaces service accounts every session under
 * a workspace, so the derivation is a pure lookup; the installer turns the
 * two snapshot feeds into one "the folder changed" callback.
 */

/** The `ctx.workspaces.list` snapshot subset the derivation reads. */
export interface FollowWorkspacesSnapshot {
  items?: readonly { path?: unknown; sessionIds?: readonly string[] }[]
}

/** The `ctx.sessions.list` snapshot subset the derivation reads. */
export interface FollowSessionsSnapshot {
  current?: unknown
}

export interface FollowSnapshotPort<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/**
 * The workspace path owning the currently selected session, or null when
 * nothing is selected or the session is unaccounted (new-session view,
 * archived): the caller keeps whatever folder is showing.
 */
export function currentWorkspaceFolder(
  sessions: FollowSessionsSnapshot,
  workspaces: FollowWorkspacesSnapshot,
): string | null {
  if (typeof sessions.current !== 'string') return null
  for (const item of Array.isArray(workspaces.items) ? workspaces.items : []) {
    if (item.sessionIds?.includes(sessions.current) && typeof item.path === 'string') return item.path
  }
  return null
}

/**
 * Call `follow(folder)` whenever the current session's workspace folder
 * changes. Fires once at install when a folder is already derivable, so a
 * late-loading drawer still converges without waiting for the next switch.
 */
export function installWorkspaceFollow(
  ports: {
    sessions: FollowSnapshotPort<FollowSessionsSnapshot>
    workspaces: FollowSnapshotPort<FollowWorkspacesSnapshot>
  },
  follow: (folder: string) => void,
): () => void {
  let last: string | null = null
  const check = (): void => {
    const folder = currentWorkspaceFolder(ports.sessions.getSnapshot(), ports.workspaces.getSnapshot())
    if (folder === null || folder === last) return
    last = folder
    follow(folder)
  }
  const disposeSessions = ports.sessions.subscribe(check)
  const disposeWorkspaces = ports.workspaces.subscribe(check)
  check()
  return () => {
    disposeSessions()
    disposeWorkspaces()
  }
}
