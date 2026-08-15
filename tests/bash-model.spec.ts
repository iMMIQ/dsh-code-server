import { describe, expect, it } from 'vitest'
import {
  bashRowModel, spillPaths, terminalCardModel, terminalFailed,
} from '../src/client/bash-model.ts'

const TRUNCATED_OUTPUT = [
  '…tail…',
  '19999',
  '20000',
  '',
  '[output truncated; full output: /tmp/dsh-subprocess-ed5SDP/dsh-subprocess-3715340-1-228034bfbc57-stdout.log]',
].join('\n')

describe('spill path extraction', () => {
  it('extracts the path from a foreground truncation marker', () => {
    expect(spillPaths(TRUNCATED_OUTPUT)).toEqual([
      '/tmp/dsh-subprocess-ed5SDP/dsh-subprocess-3715340-1-228034bfbc57-stdout.log',
    ])
  })

  it('extracts comma-separated paths from a background dropped-output marker', () => {
    const text = 'delta\n[some output was dropped from memory; full output: /tmp/dsh-subprocess-a/out.log, /tmp/dsh-subprocess-a/err.log]'
    expect(spillPaths(text)).toEqual(['/tmp/dsh-subprocess-a/out.log', '/tmp/dsh-subprocess-a/err.log'])
  })

  it('deduplicates and tolerates stderr sections with their own marker', () => {
    const text = `${TRUNCATED_OUTPUT}\n[stderr]\nwarn\n[output truncated; full output: /tmp/dsh-subprocess-b/err.log]\n[exit code: 1]`
    expect(spillPaths(text)).toEqual([
      '/tmp/dsh-subprocess-ed5SDP/dsh-subprocess-3715340-1-228034bfbc57-stdout.log',
      '/tmp/dsh-subprocess-b/err.log',
    ])
  })

  it('returns empty for absent, untruncated, or placeholder text', () => {
    expect(spillPaths(undefined)).toEqual([])
    expect(spillPaths(null)).toEqual([])
    expect(spillPaths('plain output\nexit 0')).toEqual([])
    expect(spillPaths('[output truncated; full output: (unavailable)]')).toEqual([])
  })
})

describe('terminal card model', () => {
  it('derives a settled terminal card from the call and result views', () => {
    const model = terminalCardModel({
      kind: 'tool-result',
      callId: 'c1',
      call: { argsRaw: JSON.stringify({ command: 'seq 1 20000', description: 'Count to twenty thousand' }) },
      callView: { card: 'terminal', title: 'seq 1 20000', description: 'Count to twenty thousand', cwd: undefined },
      resultView: { card: 'terminal', title: null, output: TRUNCATED_OUTPUT, exitCode: 0, signal: undefined },
      content: [],
      isError: false,
    }, '/workspace/proj')
    expect(model).not.toBeNull()
    expect(model?.card.command).toBe('seq 1 20000')
    expect(model?.card.cwd).toBe('/workspace/proj')
    expect(model?.card.running).toBe(false)
    expect(terminalFailed(model!)).toBe(false)
  })

  it('marks non-zero exits and signals as failed', () => {
    const base = {
      kind: 'tool-result',
      callId: 'c1',
      call: null,
      callView: null,
      content: [],
      isError: false,
    }
    const exited = terminalCardModel({ ...base, resultView: { card: 'terminal', output: 'x', exitCode: 2 } })
    expect(terminalFailed(exited!)).toBe(true)
    const signalled = terminalCardModel({ ...base, resultView: { card: 'terminal', output: 'x', exitCode: 0, signal: 'SIGKILL' } })
    expect(terminalFailed(signalled!)).toBe(true)
  })

  it('returns null for a settled non-terminal result view', () => {
    const model = terminalCardModel({
      kind: 'tool-result',
      callId: 'c1',
      call: null,
      callView: null,
      resultView: { card: 'generic' },
      content: [{ type: 'text', text: '```console\nboom\n```' }],
      isError: true,
      error: { code: 'spawn', name: 'Error' },
    })
    expect(model).toBeNull()
  })

  it('derives a running terminal card without output', () => {
    const model = terminalCardModel({
      callId: 'c1',
      toolName: 'bash',
      argsRaw: JSON.stringify({ command: 'sleep 5', description: 'Sleep' }),
      callView: { card: 'terminal', title: 'sleep 5', description: 'Sleep', cwd: 'sub/dir' },
    }, '/workspace/proj')
    expect(model?.card.running).toBe(true)
    expect(model?.card.cwd).toBe('/workspace/proj/sub/dir')
    expect(model?.card.output).toBeUndefined()
  })
})

describe('bash row model', () => {
  it('summarizes from the description, then the command, then raw args', () => {
    const args = JSON.stringify({ command: 'seq 1 20000 > /dev/null && seq 1 20000', description: 'Count twice' })
    const model = bashRowModel({
      callId: 'c1',
      toolName: 'bash',
      argsRaw: args,
      callView: { card: 'terminal', title: 'seq…', description: 'Count twice' },
    })
    expect(model.state).toBe('running')
    expect(model.summary).toBe('Count twice')
    expect(model.title).toBe('Bash')
    expect(model.output).toBeNull()
  })

  it('flattens settled error content and reports the first line', () => {
    const model = bashRowModel({
      kind: 'tool-result',
      callId: 'c1',
      call: { argsRaw: JSON.stringify({ command: 'x', description: 'Explode' }) },
      callView: { card: 'terminal', title: 'x', description: 'Explode' },
      resultView: { card: 'generic' },
      content: [{ type: 'text', text: 'first line of failure\nsecond' }],
      isError: true,
      error: { code: 'exec', name: 'Error' },
    })
    expect(model.state).toBe('error')
    expect(model.output).toBe('first line of failure\nsecond')
    expect(model.errorSummary).toBe('first line of failure')
  })

  it('reports interrupted calls as stopped', () => {
    const model = bashRowModel({
      kind: 'tool-result',
      callId: 'c1',
      call: null,
      callView: null,
      resultView: null,
      content: [],
      isError: true,
      error: { code: 'interrupted', name: 'Abort' },
    })
    expect(model.state).toBe('stopped')
  })
})
