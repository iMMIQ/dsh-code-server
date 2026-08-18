export interface DrawerSnapshot {
  open: boolean
  docked: boolean
  phase: 'idle' | 'loading' | 'ready' | 'error'
  ideUrl: string | null
  workspacePath: string | null
  currentPath: string | null
  error: string | null
  width: number
}

interface StatusResponse {
  phase?: unknown
  ideUrl?: unknown
  workspacePath?: unknown
  message?: unknown
}

interface OpenResponse {
  error?: unknown
  folder?: unknown
}

const STATUS_PATH = '/dsh-code-server/status'
const OPEN_PATH = '/dsh-code-server/open'
const WIDTH_KEY = 'dsh-code-server.drawer-width'
const DOCKED_KEY = 'dsh-code-server.docked'

function initialWidth(): number {
  const stored = Number.parseInt(localStorage.getItem(WIDTH_KEY) ?? '', 10)
  return Number.isFinite(stored) ? Math.min(1_200, Math.max(420, stored)) : 720
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export class DrawerController {
  private snapshot: DrawerSnapshot = {
    open: false,
    docked: localStorage.getItem(DOCKED_KEY) !== 'false',
    phase: 'idle',
    ideUrl: null,
    workspacePath: null,
    currentPath: null,
    error: null,
    width: initialWidth(),
  }

  private readonly listeners = new Set<() => void>()
  private statusRequest: Promise<void> | null = null
  private followToken = 0
  private readonly frameReloadWaiters = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): DrawerSnapshot => this.snapshot

  private update(patch: Partial<DrawerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  setOpen(open: boolean): void {
    this.update({ open })
    if (open) void this.refresh()
  }

  setDocked(docked: boolean): void {
    localStorage.setItem(DOCKED_KEY, String(docked))
    this.update({ docked })
  }

  setWidth(width: number): void {
    const value = Math.min(1_200, Math.max(420, Math.round(width)))
    localStorage.setItem(WIDTH_KEY, String(value))
    this.update({ width: value })
  }

  refresh(force = false): Promise<void> {
    if (!force && this.statusRequest !== null) return this.statusRequest
    this.update({ phase: 'loading', error: null })
    const request = fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
      .then(async response => {
        const body = await response.json() as StatusResponse
        if (!response.ok) throw new Error(`status request failed (${String(response.status)})`)
        const ideUrl = typeof body.ideUrl === 'string' ? body.ideUrl : null
        const workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath : null
        // The status root is only the fallback for the very first workbench
        // load; once following has picked a folder, that bookkeeping wins.
        const effectiveWorkspacePath = this.snapshot.workspacePath ?? workspacePath
        if (body.phase === 'error') throw new Error(typeof body.message === 'string' ? body.message : 'code-server failed')
        if (body.phase !== 'ready' || ideUrl === null) {
          this.update({ phase: 'loading', ideUrl, workspacePath: effectiveWorkspacePath })
          window.setTimeout(() => { void this.refresh(true) }, 500)
          return
        }
        this.update({ phase: 'ready', ideUrl, workspacePath: effectiveWorkspacePath, error: null })
        // Do not create a no-folder Workbench: code-server registers that as
        // an empty editor session, and reuse-window can fail while scanning it.
        if (effectiveWorkspacePath === null) window.setTimeout(() => { void this.refresh(true) }, 1_000)
      })
      .catch(reason => { this.update({ phase: 'error', error: errorMessage(reason) }) })
      .finally(() => { if (this.statusRequest === request) this.statusRequest = null })
    this.statusRequest = request
    return request
  }

  async openFile(path: string): Promise<void> {
    this.update({ open: true, currentPath: path, error: null })
    await this.refresh()
    try {
      const response = await fetch(OPEN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(openTarget(path)),
      })
      const body = await response.json() as OpenResponse
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `open failed (${String(response.status)})`)
      // The host steers the workbench to the file's owning workspace first;
      // mirror that switch so later comparisons know which folder is showing.
      if (typeof body.folder === 'string' && body.folder !== this.snapshot.workspacePath) {
        this.update({ workspacePath: body.folder })
      }
    } catch (reason) {
      this.update({ phase: 'error', error: errorMessage(reason) })
      throw reason
    }
  }

  /**
   * Point the workbench at the workspace of the conversation the user is
   * looking at. A no-op when that folder already shows; otherwise a bare
   * folder open the host maps onto a same-window switch. Best-effort by
   * design — a failure here never surfaces as a drawer error.
   */
  async followWorkspace(folder: string): Promise<void> {
    if (this.snapshot.workspacePath === folder) return
    this.update({ workspacePath: folder, currentPath: folder })
    if (!(await this.waitForReady())) return
    // The workbench silently drops pipe opens for the first seconds after
    // its page loads (the CLI pipe answers, the command chain is not wired
    // yet), and following fires exactly then. Re-issue the switch until the
    // workbench frame actually navigates — its load event is the only
    // client-visible signal — with a token so a newer follow supersedes
    // stale rounds. A landed switch makes later rounds no-ops (reusing the
    // shown folder never reloads the workbench).
    const token = ++this.followToken
    for (let round = 0; round < 5; round++) {
      if (token !== this.followToken) return
      const reloaded = this.waitForFrameReload(10_000)
      if (!(await this.postOpen(folder))) return
      if (await reloaded) return
    }
  }

  /** One best-effort open POST; false means "stop following". */
  private async postOpen(path: string): Promise<boolean> {
    try {
      const response = await fetch(OPEN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(openTarget(path)),
      })
      if (!response.ok) return false
      const body = await response.json() as OpenResponse
      if (typeof body.folder === 'string' && body.folder !== this.snapshot.workspacePath) {
        this.update({ workspacePath: body.folder })
      }
      return true
    } catch {
      return false
    }
  }

  /** Poll the sidecar status until the workbench is usable (bounded). */
  private async waitForReady(deadlineMs = 30_000): Promise<boolean> {
    void this.refresh()
    const start = Date.now()
    while (Date.now() - start < deadlineMs) {
      if (this.snapshot.phase === 'error') {
        this.update({ phase: 'loading', error: null })
        void this.refresh(true)
      }
      if (this.snapshot.phase === 'ready') return true
      await new Promise(resolve => { window.setTimeout(resolve, 1_000) })
    }
    return this.snapshot.phase === 'ready'
  }

  /** Resolve waiting follow rounds when the workbench frame navigates. */
  noteFrameReload(): void {
    const waiters = [...this.frameReloadWaiters]
    this.frameReloadWaiters.clear()
    for (const waiter of waiters) waiter()
  }

  private waitForFrameReload(timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const waiter = (): void => {
        cleanup()
        resolve(true)
      }
      const timer = window.setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeoutMs)
      const cleanup = (): void => {
        window.clearTimeout(timer)
        this.frameReloadWaiters.delete(waiter)
      }
      this.frameReloadWaiters.add(waiter)
    })
  }
}

export interface OpenPathPort {
  openPath(path: string): Promise<void>
}

/**
 * Split an open target into path + 1-based line/column. Callers hand over
 * bare paths; a trailing `:line` or `:line:col` suffix is honoured when
 * present, so a caller that knows the referenced line can land on it.
 */
export function openTarget(path: string): { path: string; line: number; column: number } {
  // Two anchored shapes, longest first: a greedy single-pass pattern would
  // swallow the line segment of a `path:line:col` target.
  const withColumn = /^(.+):(\d+):(\d+)$/.exec(path)
  if (withColumn !== null) {
    return { path: withColumn[1]!, line: Number.parseInt(withColumn[2]!, 10), column: Number.parseInt(withColumn[3]!, 10) }
  }
  const withLine = /^(.+):(\d+)$/.exec(path)
  if (withLine !== null) {
    return { path: withLine[1]!, line: Number.parseInt(withLine[2]!, 10), column: 1 }
  }
  return { path, line: 1, column: 1 }
}

/**
 * Version-pinned compatibility adapter for DSH 47f9438. It creates one own
 * method and restores the exact previous object shape when disposed.
 */
export function installOpenPathAdapter(port: OpenPathPort, open: (path: string) => Promise<void>): () => void {
  if (typeof port.openPath !== 'function') throw new Error('dsh-code-server: ctx.workspaces.openPath is unavailable')
  const own = Object.getOwnPropertyDescriptor(port, 'openPath')
  if (own === undefined && !Object.isExtensible(port)) {
    throw new Error('dsh-code-server: ctx.workspaces is not extensible')
  }
  if (own !== undefined && own.configurable !== true && own.writable !== true) {
    throw new Error('dsh-code-server: ctx.workspaces.openPath is not writable')
  }
  const patched = (path: string): Promise<void> => open(path)
  Object.defineProperty(port, 'openPath', {
    configurable: true,
    enumerable: own?.enumerable ?? false,
    writable: true,
    value: patched,
  })
  return () => {
    if (port.openPath !== patched) return
    if (own === undefined) delete (port as { openPath?: unknown }).openPath
    else Object.defineProperty(port, 'openPath', own)
  }
}
