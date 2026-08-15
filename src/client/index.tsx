import { DrawerController, installOpenPathAdapter } from './controller.ts'
import { IdeDrawer } from './IdeDrawer.tsx'
import { BashRow, type BashRowProps } from './bash-row.tsx'
import { installStyles } from './styles.ts'

interface BrowserContext {
  workspaces: { openPath(path: string): Promise<void> }
  effect(effect: () => () => void, label: string): void
  slots: {
    inject(name: string, setup: () => (() => void) | Iterable<() => void>): () => void
    register(
      options: { name: string; id: string; order: number; inject: () => { controller: DrawerController } },
      component: typeof IdeDrawer,
    ): () => void
    register(
      options: { name: string; key: string; priority?: number; locale?: string },
      component: (props: Omit<BashRowProps, 'controller'>) => JSX.Element,
    ): () => void
  }
}

/** Browser services required by the overlay and compatibility adapter. */
export const inject = ['slots', 'workspaces']

/** Register the embedded workbench and intercept DSH's existing file opener. */
export function apply(ctx: BrowserContext): void {
  const controller = new DrawerController()
  ctx.effect(() => {
    const disposeStyles = installStyles()
    const disposeAdapter = installOpenPathAdapter(ctx.workspaces, path => controller.openFile(path))
    return () => {
      disposeAdapter()
      disposeStyles()
    }
  }, 'dsh-code-server: openPath adapter')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-code-server',
    order: 100,
    inject: () => ({ controller }),
  }, IdeDrawer))
  // Shadow DSH's own bash tool row (default priority 0; lowest renders) with
  // the clone that adds the "Open full output" pill for truncated output. The
  // inject callback defers until ui-tool declares the keyed slot; the
  // controller reaches the row through the closure, not the slot inject face.
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'bash',
    priority: -1,
    locale: 'conversation',
  }, (props: Omit<BashRowProps, 'controller'>) => <BashRow {...props} controller={controller} />))
}
