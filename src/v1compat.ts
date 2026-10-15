import { z } from "zod"

// Local V1-compatible tool types, decoupled from `@opencode-ai/plugin`
// (V1 SDK). The business logic in tools/ and services/ keeps using these
// shapes; src/plugin.ts adapts them to the V2 API (`@opencode/plugin`).

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  /** Current project directory for this session. */
  directory: string
  /** Project worktree root for this session. */
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Promise<void>
}

export type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: { [key: string]: any }
}

export type ToolAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: { [key: string]: any }
      attachments?: ToolAttachment[]
    }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}

export type ToolDefinition = ReturnType<typeof tool>
