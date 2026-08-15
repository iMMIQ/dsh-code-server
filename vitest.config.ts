import { defineProject } from 'vitest/config'

// The host half imports DSH's user-message factory from the profile's shared
// node_modules at runtime; unit tests substitute a passthrough stub.
export default defineProject({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-llm': new URL('./tests/stubs/dsh-llm.ts', import.meta.url).pathname,
    },
  },
})
