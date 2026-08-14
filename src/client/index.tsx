import { DrawerController, installOpenPathAdapter } from './controller.ts'
import { IdeDrawer } from './IdeDrawer.tsx'
import { installStyles } from './styles.ts'

interface BrowserContext {
  workspaces: { openPath(path: string): Promise<void> }
  effect(effect: () => () => void, label: string): void
  slots: {
    inject(name: string, setup: () => () => void): void
    register(
      options: { name: string; id: string; order: number; inject: () => { controller: DrawerController } },
      component: typeof IdeDrawer,
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
}
