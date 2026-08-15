import { describe, expect, it } from 'vitest'
import { composeFixPrompt, composePrompt } from '../extension/prompt.js'

function fakeDocument(text: string, fsPath = '/ws/a.ts', languageId = 'typescript') {
  return {
    uri: { fsPath },
    languageId,
    getText(range?: { start: { line: number; character: number }; end: { line: number; character: number } }) {
      if (range === undefined) return text
      const lines = text.split('\n')
      return lines.slice(range.start.line, range.end.line + 1).join('\n')
    },
  }
}

const selection = (startLine: number, endLine: number) => ({
  isEmpty: startLine > endLine,
  start: { line: startLine, character: 0 },
  end: { line: endLine, character: 0 },
})

describe('composePrompt (ask)', () => {
  it('headers the file without a selection', () => {
    const prompt = composePrompt('why?', fakeDocument('let x'), selection(0, -1))
    expect(prompt).toBe('why?\n\nFile: /ws/a.ts (typescript)')
  })

  it('inlines a bounded selection as a fenced block', () => {
    const prompt = composePrompt('explain', fakeDocument('const a = 1\nconst b = 2'), selection(0, 1))
    expect(prompt).toBe('explain\n\nFile: /ws/a.ts (lines 1-2, typescript)\n\n```typescript\nconst a = 1\nconst b = 2\n```')
  })

  it('summarizes oversized selections instead of inlining', () => {
    const big = 'x'.repeat(9000)
    const prompt = composePrompt('explain', fakeDocument(big), selection(0, 0))
    expect(prompt).toContain('(selection is 9000 characters; open the file to see it)')
    expect(prompt).not.toContain('```typescript\nxxxx')
  })
})

describe('composeFixPrompt (fix)', () => {
  it('lists diagnostics with source, code, and the offending line', () => {
    const prompt = composeFixPrompt('/ws/broken.ts', 'typescript', [
      { line: 2, message: "Cannot find name 'nam'.", source: 'ts', code: 2552, text: '  return `Hello, ${nam}!`' },
      { line: 5, message: "Type 'string' is not assignable to type 'number'.", source: undefined, code: undefined, text: 'const count: number = "not a number";' },
    ])
    expect(prompt).toContain('you have write access to the workspace')
    expect(prompt).toContain('File: /ws/broken.ts (typescript)')
    expect(prompt).toContain("- Ln 2 [ts 2552]: Cannot find name 'nam'.\n  >   return `Hello, ${nam}!`")
    expect(prompt).toContain("- Ln 5: Type 'string' is not assignable to type 'number'.")
    expect(prompt).toContain('minimal edits')
  })

  it('truncates long messages and lines', () => {
    const prompt = composeFixPrompt('/ws/a.ts', 'plaintext', [
      { line: 1, message: 'm'.repeat(400), source: 'ts', code: 1, text: 't'.repeat(300) },
    ])
    expect(prompt).toContain(`${'m'.repeat(300)}…`)
    expect(prompt).toContain(`${'t'.repeat(200)}…`)
  })

  it('caps the listing and notes the dropped remainder', () => {
    const diagnostics = Array.from({ length: 60 }, (_, i) => ({
      line: i + 1, message: `problem ${String(i)}`, source: 'ts', code: 1, text: 'x',
    }))
    const prompt = composeFixPrompt('/ws/a.ts', 'typescript', diagnostics)
    expect(prompt).toContain('- Ln 1 [ts 1]: problem 0')
    expect(prompt).toContain('- Ln 50 [ts 1]: problem 49')
    expect(prompt).not.toContain('problem 50\n')
    expect(prompt).toContain('(10 more problems not listed)')
  })
})
