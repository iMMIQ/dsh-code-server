/**
 * Pinned-subset declarations for the DSH web client modules this plugin may
 * require (they are platform seed words in the module loader's static table —
 * see deepseek-harness packages/client/web/src/seed.ts at the pinned commit).
 * Only the surfaces the bash-row clone touches are declared; the shapes track
 * DSH 47f9438 and are re-asserted by tests/dsh-compat.spec.ts.
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react'

  export interface TerminalBlockLabels {
    signal: (signal: string) => string
    exitCode: (code: number) => string
    running: string
    failed: string
    done: string
    copy: string
    copied: string
    noOutput: string
    collapseAria: string
    collapse: string
    expandAria: (hidden: number) => string
    expand: (hidden: number) => string
  }

  export interface TerminalBlockProps {
    command: string
    cwd?: string | undefined
    output?: string | undefined
    exitCode?: number | undefined
    signal?: string | undefined
    running?: boolean | undefined
    maxLines?: number | undefined
    labels?: TerminalBlockLabels | undefined
    className?: string | undefined
  }

  export function TerminalBlock(props: TerminalBlockProps & { children?: ReactNode }): JSX.Element

  export interface ReadBlockLine {
    number: number
    text: string
  }

  export interface ReadBlockProps {
    label?: string | undefined
    lines: readonly ReadBlockLine[]
    totalLines: number
    lang?: string | undefined
    maxLines?: number | undefined
    className?: string | undefined
  }

  export function ReadBlock(props: ReadBlockProps & { children?: ReactNode }): JSX.Element

  export function StateDot(props: { state: 'error' | 'warning' | 'ok' | string; size?: number }): JSX.Element

  export function IconApiOutline14(props: { size?: number; className?: string }): JSX.Element
  export function IconBrowseOutline16(props: { size?: number; className?: string }): JSX.Element
  export function IconChevronDownOutline14(props: { size?: number; className?: string }): JSX.Element
  export function IconInspectOutline12(props: { size?: number; className?: string }): JSX.Element
}
