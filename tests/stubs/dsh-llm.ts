/** Test stub for the runtime-resolved `@deepseek-ai/dsh-llm` import. */
export function createUserMessage(input: unknown): unknown {
  return { role: 'user', ...input as Record<string, unknown> }
}
