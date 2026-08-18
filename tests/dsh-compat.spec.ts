import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const DSH_ROOT = resolve(import.meta.dirname, '../../deepseek-harness')
const FORK_ROOT = resolve(import.meta.dirname, '../third_party/code-server')

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

  it('still declares the keyed toolview slot our bash row shadows', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/client/ui-tool/src/client/apply.ts'), 'utf8')
    expect(source).toContain("'tool.call.toolview': { kind: 'keyed', scope: 'session' }")
  })

  it('still registers the upstream bash row at the default priority', async () => {
    const source = await readFile(
      resolve(DSH_ROOT, 'packages/client/ui-tool/src/client/tool/toolviews/bash-sample.tsx'),
      'utf8',
    )
    expect(source).toContain("ctx.slots.register({ name: 'tool.call.toolview', key: 'bash', locale: NS }, BashRow)")
  })

  it('still shares ui-primitives into the loader module table', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/client/web/src/seed.ts'), 'utf8')
    expect(source).toContain("import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'")
    expect(source).toContain("'@deepseek-ai/dsh-client-ui-primitives': UiPrimitives")
  })

  it('still renders truncation markers with the embedded spill path', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/shell/tool-bash/src/render.ts'), 'utf8')
    expect(source).toContain('[output truncated; full output: ')
    expect(source).toContain('[some output was dropped from memory; full output: ')
  })

  it('still spills to a dsh-subprocess directory under the OS temp dir', async () => {
    const source = await readFile(
      resolve(DSH_ROOT, 'packages/subprocess/subprocess-local/src/spawn.ts'),
      'utf8',
    )
    expect(source).toContain("mkdtempSync(join(tmpdir(), 'dsh-subprocess-'))")
  })

  it('still exposes the listening port on the webServer service', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/host/webserver/src/index.ts'), 'utf8')
    expect(source).toContain('get port(): number')
    expect(source).toMatch(/this\.listenedPort = \(this\.server\.address\(\) as AddressInfo\)\.port/)
  })

  it('still lists sessionIds on every workspace entity', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/workspace/workspace/src/entity.ts'), 'utf8')
    expect(source).toMatch(/get sessionIds\(\): readonly SessionId\[\]/)
  })

  it('still serves the agent registry with followup delivery', async () => {
    const registry = await readFile(resolve(DSH_ROOT, 'packages/core/agent/src/index.ts'), 'utf8')
    expect(registry).toContain('export class AgentRegistry extends Service')
    expect(registry).toMatch(/async create\(options: CreateAgentOptions\): Promise<AgentHandle>/)
    const runtime = await readFile(resolve(DSH_ROOT, 'packages/core/agent/src/runtime-types.ts'), 'utf8')
    expect(runtime).toMatch(/followup\(message: UserMessage\): void/)
  })

  it('still creates user messages with a plain user source', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/llm/llm/src/message.ts'), 'utf8')
    expect(source).toContain('user: { kind: \'user\' }')
    expect(source).toMatch(/export function createUserMessage/)
  })

  it('still registers the upstream read row at the default priority', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/client/ui-tool/src/client/tool/toolviews/read-row.tsx'), 'utf8')
    expect(source).toContain("ctx.slots.register({ name: 'tool.call.toolview', key: 'read', locale: NS }, ReadRow)")
  })

  it('still numbers the read result view lines off the file', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/client/ui-tool/src/client/tool/models/read-card-model.ts'), 'utf8')
    expect(source).toContain("const lines: ReadBlockLine[] = result.lines.map(line => ({ number: line.number, text: line.text }))")
    expect(source).toContain('label: result.title ?? relativizeToCwd(result.path, sessionCwd)')
  })

  it('still derives the read summary and file path from the path keys', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/client/ui-tool/src/client/tool/models/tool-call-model.ts'), 'utf8')
    expect(source).toContain("read: ['path', 'file_path', 'url']")
    expect(source).toContain("const FILE_PATH_KEYS = ['path', 'file_path'] as const")
    expect(source).toContain("new Set(['read', 'write', 'edit'])")
  })

  it('still exposes the 1-based read offset our landing line falls back to', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/fs/tool-fs/src/read.ts'), 'utf8')
    expect(source).toContain("offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' }")
  })

  it('still resolves workspace-relative open targets against the session cwd', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/client/runtime/src/client/workspaces/path.ts'), 'utf8')
    expect(source).toContain('export function resolveWorkspacePath(cwd: string | undefined, path: string): string')
    expect(source).toContain('return path')
    expect(source).toContain('return `${base}/${rel}`')
  })

  it('still provides the sessions service the follower injects', async () => {
    const source = await readFile(resolve(DSH_ROOT, 'packages/client/runtime/src/client/sessions/service.ts'), 'utf8')
    expect(source).toContain("rootCtx.reflect.provide('sessions', this, undefined)")
    expect(source).toContain('current: SessionId | undefined')
  })

  it('still exposes the workspaces list snapshot with session accounting', async () => {
    const contract = await readFile(
      resolve(DSH_ROOT, 'packages/client/runtime/src/client/contract/workspaces.ts'),
      'utf8',
    )
    expect(contract).toContain('readonly list: ObservableSnapshot<WorkspaceListState>')
    const view = await readFile(resolve(DSH_ROOT, 'packages/host/apiproxy/src/api/workspace.ts'), 'utf8')
    expect(view).toContain('sessionIds: SessionId[]')
    expect(view).toMatch(/\/\*\* Canonical directory path \(host-side realpath canon\)\. \*\/\n  path: string/)
  })
})

describe('code-server fork 4.132.0-dsh.5 workspace-switch seam', () => {
  it('still maps CLI directory args onto folderURIs', async () => {
    const source = await readFile(resolve(FORK_ROOT, 'src/node/main.ts'), 'utf8')
    expect(source).toContain('if (await isDirectory(fp)) {')
    expect(source).toContain('pipeArgs.folderURIs.push(fp)')
  })

  it('still no-ops a same-folder reuse-window switch', async () => {
    const source = await readFile(resolve(FORK_ROOT, 'lib/vscode/src/vs/code/browser/workbench/workbench.ts'), 'utf8')
    expect(source).toContain('if (options?.reuse && !options.payload && this.isSame(this.workspace, workspace))')
  })

  it('still reports unconnected reuse-window opens as the retryable no-instance error', async () => {
    const source = await readFile(resolve(FORK_ROOT, 'src/node/cli.ts'), 'utf8')
    expect(source).toContain('No opened code-server instances found')
  })
})
