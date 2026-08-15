/**
 * Ambient surface of the DSH host package this plugin imports at runtime.
 * The harness resolves these from the profile's shared `node_modules`; the
 * shapes below are the duck-typed subset `src/index.ts` uses. The upstream
 * invariants are asserted by `tests/dsh-compat.spec.ts`.
 */
declare module '@deepseek-ai/dsh-llm' {
  /** Input subset of the harness `createUserMessage` factory. */
  export interface NewUserMessageInput {
    content: { type: 'text'; text: string }[]
    source: { kind: 'user' }
  }
  /** Create one identified, frozen user-role message for `agent.followup`. */
  export function createUserMessage(input: NewUserMessageInput): unknown
}
