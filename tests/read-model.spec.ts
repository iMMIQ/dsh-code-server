import { describe, expect, it } from 'vitest'
import {
  landingLine, readCardModel, readRowModel, relativizeToCwd, resolveWorkspacePath,
} from '../src/client/read-model.ts'
import type { ToolResultNode } from '../src/client/bash-model.ts'

function settledRead(overrides: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result',
    callId: 'c1',
    call: { argsRaw: JSON.stringify({ file_path: '/workspace/proj/src/a.ts' }) },
    callView: null,
    resultView: {
      card: 'read',
      title: null,
      path: '/workspace/proj/src/a.ts',
      lines: [
        { number: 1, text: 'const a = 1' },
        { number: 2, text: 'const b = 2' },
      ],
      totalLines: 2,
      lang: 'typescript',
    },
    content: [],
    isError: false,
    ...overrides,
  }
}

describe('read card model', () => {
  it('derives the read card with the relativized path label', () => {
    const model = readCardModel(settledRead(), '/workspace/proj')
    expect(model).toEqual({
      label: 'src/a.ts',
      lines: [
        { number: 1, text: 'const a = 1' },
        { number: 2, text: 'const b = 2' },
      ],
      totalLines: 2,
      lang: 'typescript',
    })
  })

  it('prefers the result view replacement title over the path', () => {
    const model = readCardModel(settledRead({
      resultView: {
        card: 'read',
        title: 'Notes',
        path: '/workspace/proj/notes.txt',
        lines: [{ number: 1, text: 'hello' }],
        totalLines: 1,
        lang: 'plaintext',
      },
    }))
    expect(model?.label).toBe('Notes')
  })

  it('returns null while running and for non-read result views', () => {
    expect(readCardModel({
      callId: 'c1',
      toolName: 'read',
      argsRaw: JSON.stringify({ file_path: '/workspace/proj/src/a.ts' }),
      callView: null,
    })).toBeNull()
    expect(readCardModel(settledRead({ resultView: { card: 'generic' } }))).toBeNull()
  })
})

describe('landing line derivation', () => {
  it('lands on the read window first line', () => {
    const block = settledRead({
      call: { argsRaw: JSON.stringify({ file_path: '/workspace/proj/src/a.ts', offset: 40 }) },
      resultView: {
        card: 'read',
        title: null,
        path: '/workspace/proj/src/a.ts',
        lines: [{ number: 40, text: 'line forty' }],
        totalLines: 500,
        lang: 'typescript',
      },
    })
    expect(landingLine(block, readCardModel(block))).toBe(40)
  })

  it('falls back to the args offset for a running read', () => {
    const block = {
      callId: 'c1',
      toolName: 'read',
      argsRaw: JSON.stringify({ file_path: '/workspace/proj/src/a.ts', offset: 77 }),
      callView: null,
    }
    expect(landingLine(block, readCardModel(block))).toBe(77)
  })

  it('falls back to line 1 without a window or offset', () => {
    const block = settledRead({
      call: { argsRaw: JSON.stringify({ file_path: '/workspace/proj/src/a.ts' }) },
    })
    expect(landingLine(block, readCardModel(block))).toBe(1)
    expect(landingLine({
      callId: 'c1',
      toolName: 'read',
      argsRaw: JSON.stringify({ file_path: '/workspace/proj/src/a.ts', offset: 0 }),
      callView: null,
    }, null)).toBe(1)
  })

  it('ignores non-positive and non-integer window starts', () => {
    const block = settledRead({
      call: { argsRaw: JSON.stringify({ file_path: '/workspace/proj/src/a.ts' }) },
      resultView: {
        card: 'read',
        title: null,
        path: '/workspace/proj/src/a.ts',
        lines: [{ number: 0, text: 'anomalous wire data' }],
        totalLines: 1,
        lang: undefined,
      },
    })
    expect(landingLine(block, readCardModel(block))).toBe(1)
  })
})

describe('read row model', () => {
  it('summarizes from path/file_path/url keys and keeps the file path', () => {
    const model = readRowModel(settledRead({
      call: { argsRaw: JSON.stringify({ file_path: '/workspace/proj/src/a.ts' }) },
    }), '/workspace/proj', 'c1')
    expect(model.title).toBe('Read')
    expect(model.summary).toBe('src/a.ts')
    expect(model.filePath).toBe('/workspace/proj/src/a.ts')
    expect(model.state).toBe('ok')
  })

  it('keeps a relative summary unchanged and resolves the open target absolutely', () => {
    const block = settledRead({
      call: { argsRaw: JSON.stringify({ file_path: 'src/rel.ts' }) },
      resultView: {
        card: 'read',
        title: null,
        path: 'src/rel.ts',
        lines: [{ number: 3, text: 'x' }],
        totalLines: 9,
        lang: 'typescript',
      },
    })
    const model = readRowModel(block, undefined, 'c1')
    expect(model.summary).toBe('src/rel.ts')
    expect(resolveWorkspacePath(undefined, 'src/rel.ts')).toBe('src/rel.ts')
    expect(resolveWorkspacePath('/workspace/proj', 'src/rel.ts')).toBe('/workspace/proj/src/rel.ts')
    expect(resolveWorkspacePath('/workspace/proj/', '/abs/kept.ts')).toBe('/abs/kept.ts')
    expect(relativizeToCwd('/workspace/proj/src/a.ts', '/workspace/proj')).toBe('src/a.ts')
    expect(relativizeToCwd('/elsewhere/a.ts', '/workspace/proj')).toBe('/elsewhere/a.ts')
    expect(model.line).toBe(3)
  })

  it('uses the callId when the args are empty and reports error state', () => {
    const model = readRowModel(settledRead({
      call: null,
      resultView: null,
      content: [{ type: 'text', text: 'ENOENT: no such file' }],
      isError: true,
      error: { code: 'not_found', name: 'Error' },
    }), undefined, 'call-9')
    expect(model.summary).toBe('call-9')
    expect(model.state).toBe('error')
    expect(model.errorSummary).toBe('ENOENT: no such file')
    expect(model.filePath).toBeUndefined()
  })

  it('derives the running state with a pretty-printed IN body', () => {
    const model = readRowModel({
      callId: 'c1',
      toolName: 'read',
      argsRaw: JSON.stringify({ file_path: 'src/a.ts', offset: 12 }),
      callView: null,
    }, undefined, 'c1')
    expect(model.state).toBe('running')
    expect(model.body).toBe(JSON.stringify({ file_path: 'src/a.ts', offset: 12 }, null, 2))
    expect(model.output).toBeNull()
    expect(model.line).toBe(12)
  })

  it('reports interrupted calls as stopped', () => {
    const model = readRowModel(settledRead({
      resultView: null,
      error: { code: 'interrupted', name: 'Error' },
    }), undefined, 'c1')
    expect(model.state).toBe('stopped')
  })
})
