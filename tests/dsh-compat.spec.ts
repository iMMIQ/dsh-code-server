import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const DSH_ROOT = resolve(import.meta.dirname, '../../deepseek-harness')

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
})
