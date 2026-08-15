import { defineProject } from 'vitest/config'

// The host half imports DSH's user-message factory from the profile's shared
// node_modules at runtime; unit tests substitute a passthrough stub.
export default defineProject({
  // Keep the checked-out vscode fork subtree (third_party/code-server/lib/vscode)
  // out of test discovery; only tests/ holds our specs.
  test: {
    include: ['tests/**/*.spec.ts'],
  },
  resolve: {
    alias: {
      '@deepseek-ai/dsh-llm': new URL('./tests/stubs/dsh-llm.ts', import.meta.url).pathname,
    },
  },
})
