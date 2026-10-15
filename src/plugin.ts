import { Plugin, Skill } from "@opencode/plugin"
import { z } from "zod"
import { ipynbInspectTool } from "./tools/inspect.js"
import { ipynbReadTool } from "./tools/read.js"
import { ipynbEditTool } from "./tools/edit.js"
import { ipynbCellInsertTool } from "./tools/cell_insert.js"
import { ipynbCellDeleteTool } from "./tools/cell_delete.js"
import { ipynbCellMoveTool } from "./tools/cell_move.js"
import { ipynbRunTool } from "./tools/run.js"
import { ipynbOutputsTool } from "./tools/outputs.js"
import { ipynbCleanTool } from "./tools/clean.js"
import { ipynbExportTool } from "./tools/export.js"
import { ipynbDoctorTool } from "./tools/doctor.js"
import { ipynbReproTool } from "./tools/repro.js"
import { ipynbKernelTool } from "./tools/kernel.js"
import { ipynbSearchTool } from "./tools/search.js"
import { parsePluginOptions } from "./plugin-options.js"
import { IPYNB_SKILL } from "./skill-content.js"
import { disposeSharedKernelManager } from "./services/index.js"
import type { ToolContext as V1Context, ToolResult as V1Result, ToolDefinition } from "./v1compat.js"

type V2ToolOptions = {
  readonly permission?: string
}

const toV2Result = (raw: V1Result): { content: ReadonlyArray<{ type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }>; metadata?: Record<string, unknown> } => {
  if (typeof raw === "string") {
    return { content: [{ type: "text" as const, text: raw }] }
  }
  const content: Array<{ type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }> = [
    { type: "text" as const, text: raw.output }
  ]
  for (const att of raw.attachments ?? []) {
    content.push({
      type: "file" as const,
      uri: att.url,
      mime: att.mime,
      ...(att.filename === undefined ? {} : { name: att.filename })
    })
  }
  return {
    content,
    ...(raw.metadata === undefined ? {} : { metadata: raw.metadata })
  }
}

const adapt = (
  name: string,
  v1: ToolDefinition,
  env: { directory: string; worktree: string },
  options?: V2ToolOptions
) => {
  return {
    name,
    description: v1.description,
    // Zod v4 schemas implement StandardSchemaV1, accepted directly as V2 input.
    input: z.object(v1.args),
    ...(options?.permission === undefined ? {} : { options: { permission: options.permission } }),
    execute: async (input: Record<string, unknown>, context: { sessionID: string; agent: string; messageID: string; signal: AbortSignal }) => {
      const v1ctx: V1Context = {
        sessionID: context.sessionID,
        messageID: context.messageID,
        agent: context.agent,
        directory: env.directory,
        worktree: env.worktree,
        abort: context.signal,
        metadata: () => {},
        // V2 Promise tool executors have no interactive ask hook. Writes and
        // executions proceed once the tool call itself is approved; use
        // `permissions` config (actions ipynb_edit / ipynb_run / ...) to
        // allow, ask, or deny per tool.
        ask: async () => {}
      }
      const raw = await v1.execute(input as never, v1ctx)
      return toV2Result(raw)
    }
  }
}

export default Plugin.define({
  id: "opencode-ipynb",
  async setup(ctx) {
    const parsed = parsePluginOptions(ctx.options)
    if (parsed.pythonPath && !process.env.OPENCODE_IPYNB_PYTHON) {
      process.env.OPENCODE_IPYNB_PYTHON = parsed.pythonPath
    }
    if (!process.env.OPENCODE_IPYNB_OPTIONS) {
      process.env.OPENCODE_IPYNB_OPTIONS = JSON.stringify(parsed)
    }
    const env = {
      directory: ctx.location.directory,
      worktree: ctx.location.project.canonical ?? ctx.location.project.directory ?? ctx.location.directory
    }
    await ctx.tool.transform((editor) => {
      editor.add(adapt("ipynb_inspect", ipynbInspectTool, env) as never)
      editor.add(adapt("ipynb_read", ipynbReadTool, env) as never)
      editor.add(adapt("ipynb_edit", ipynbEditTool, env, { permission: "edit" }) as never)
      editor.add(adapt("ipynb_cell_insert", ipynbCellInsertTool, env, { permission: "edit" }) as never)
      editor.add(adapt("ipynb_cell_delete", ipynbCellDeleteTool, env, { permission: "edit" }) as never)
      editor.add(adapt("ipynb_cell_move", ipynbCellMoveTool, env, { permission: "edit" }) as never)
      editor.add(adapt("ipynb_run", ipynbRunTool, env, { permission: "shell" }) as never)
      editor.add(adapt("ipynb_outputs", ipynbOutputsTool, env, { permission: "edit" }) as never)
      editor.add(adapt("ipynb_clean", ipynbCleanTool, env, { permission: "edit" }) as never)
      editor.add(adapt("ipynb_export", ipynbExportTool, env, { permission: "edit" }) as never)
      editor.add(adapt("ipynb_doctor", ipynbDoctorTool, env) as never)
      editor.add(adapt("ipynb_repro", ipynbReproTool, env) as never)
      editor.add(adapt("ipynb_kernel", ipynbKernelTool, env, { permission: "edit" }) as never)
      editor.add(adapt("ipynb_search", ipynbSearchTool, env) as never)
    })
    // Teach agents to use the ipynb_* tools instead of raw read/edit on
    // notebook JSON (SKILL.md at the plugin root mirrors this content).
    await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make(IPYNB_SKILL.id),
        name: Skill.Name.make(IPYNB_SKILL.name),
        description: IPYNB_SKILL.description,
        autoinvoke: IPYNB_SKILL.autoinvoke,
        path: IPYNB_SKILL.path as Skill.Info["path"],
        content: IPYNB_SKILL.content
      })
    })
    return async () => {
      // Kill every live warm kernel so we do not leave zombie Python
      // subprocesses when the OpenCode session ends.
      await disposeSharedKernelManager()
    }
  }
})
