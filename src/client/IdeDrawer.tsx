import {
  useEffect, useMemo, useRef, useSyncExternalStore,
  type CSSProperties, type PointerEvent as ReactPointerEvent,
} from 'react'
import type { DrawerController } from './controller.ts'

export interface IdeDrawerProps {
  controller: DrawerController
}

function workbenchUrl(ideUrl: string, workspacePath: string | null): string {
  const url = new URL('/', ideUrl)
  if (workspacePath !== null) url.searchParams.set('folder', workspacePath)
  return url.toString()
}

export function IdeDrawer({ controller }: IdeDrawerProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const src = useMemo(
    () => state.ideUrl === null || state.workspacePath === null
      ? null
      : workbenchUrl(state.ideUrl, state.workspacePath),
    [state.ideUrl, state.workspacePath],
  )

  useEffect(() => { void controller.refresh() }, [controller])

  useEffect(() => {
    const frame = rootRef.current?.closest('[data-shell-overlay]')?.parentElement
    if (frame === null || frame === undefined) return
    frame.classList.toggle('dcs-host-docked', state.open && state.docked)
    frame.style.setProperty('--dcs-dock-width', `${String(state.width)}px`)
    return () => {
      frame.classList.remove('dcs-host-docked')
      frame.style.removeProperty('--dcs-dock-width')
    }
  }, [state.docked, state.open, state.width])

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = state.width
    const move = (next: PointerEvent) => { controller.setWidth(startWidth + startX - next.clientX) }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
  }

  return (
    <div
      ref={rootRef}
      className="dcs-root"
      data-open={String(state.open)}
      data-docked={String(state.docked)}
      style={{ '--dcs-width': `${String(state.width)}px` } as CSSProperties}
    >
      {!state.open && (
        <button className="dcs-launcher" type="button" title="Open editor" aria-label="Open editor" onClick={() => { controller.setOpen(true) }}>
          {'</>'}
        </button>
      )}
      <section className="dcs-drawer" aria-label="Code editor">
        <div className="dcs-resize" role="separator" aria-label="Resize editor" aria-orientation="vertical" onPointerDown={beginResize} />
        <header className="dcs-toolbar">
          <span className="dcs-title">VS Code</span>
          {state.currentPath !== null && <span className="dcs-path" title={state.currentPath}>{state.currentPath}</span>}
          <button
            className="dcs-mode"
            data-docked={String(state.docked)}
            type="button"
            title={state.docked ? 'Float over conversation' : 'Dock beside conversation'}
            aria-label={state.docked ? 'Float over conversation' : 'Dock beside conversation'}
            onClick={() => { controller.setDocked(!state.docked) }}
          />
          <button className="dcs-close" type="button" title="Close editor" aria-label="Close editor" onClick={() => { controller.setOpen(false) }} />
        </header>
        <div className="dcs-body">
          {src !== null && <iframe className="dcs-frame" src={src} title="VS Code Workbench" allow="clipboard-read; clipboard-write" />}
          {state.phase !== 'ready' && (
            <div className="dcs-state" role={state.phase === 'error' ? 'alert' : 'status'}>
              <span>{state.phase === 'error' ? (state.error ?? 'code-server unavailable') : 'Starting code-server...'}</span>
              {state.phase === 'error' && <button type="button" onClick={() => { void controller.refresh(true) }}>Retry</button>}
            </div>
          )}
          {state.phase === 'ready' && state.workspacePath === null && (
            <div className="dcs-state" role="status">
              <span>Choose a DSH workspace first.</span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
