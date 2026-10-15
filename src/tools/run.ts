import { z } from "zod"
import { tool } from "../v1compat.js"
import { Effect } from "effect"
import type { ToolAttachment, ToolContext } from "../v1compat.js"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"
import { resolveToolOptions } from "./_resolveOptions.js"
import { formatAttachment, pickExtensionForMime } from "../utils/attachments.js"
import { truncateTraceback } from "../services/NotebookExecutionService.js"
import { DEFAULT_MAX_TRACEBACK_CHARS } from "../utils/limits.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  mode: z
    .enum(["cell", "range", "all", "from"])
    .describe(
      "What to execute: 'cell' (single cell by cellIndex), 'range' (start..end), 'all' (every code cell), 'from' (cellIndex to end)"
    ),
  cellIndex: z.number().int().nonnegative().optional().describe("For mode='cell' or 'from'"),
  start: z.number().int().nonnegative().optional().describe("For mode='range'"),
  end: z.number().int().nonnegative().optional().describe("For mode='range'"),
  kernel: z.string().optional().describe("Kernel name to use (default: notebook's kernelspec)"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Timeout in milliseconds (default 120000, from plugin options)"),
  save: z.boolean().optional().default(true).describe("Persist outputs to the notebook (default: true)"),
  restart: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Restart the notebook's Python kernel before executing (fresh state). Only meaningful with the warm kernel enabled; one-shot runs are already fresh. Use it for a clean mode='all' validation."
    ),
  workingDirectory: z.string().optional().describe("Working directory for the Python runner"),
  maxOutputChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of output characters per cell (default 12000, falls back to plugin options.defaultMaxOutputChars)")
}

export const ipynbRunTool = tool({
  description:
    "Execute a cell, range, or full notebook via the Python helper (nbclient in v0.3). The plugin never installs Python dependencies; it only detects them and returns a clear error if anything is missing. Use ipynb_doctor first if you are unsure about the environment.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    const pluginOpts = resolveToolOptions()
    const maxOutputChars = input.maxOutputChars ?? Math.max(12_000, pluginOpts.defaultMaxOutputChars)
    const timeoutMs = input.timeoutMs ?? pluginOpts.defaultTimeoutMs
    try {
      const result = await Effect.runPromise(
        services.execution.execute(input.filePath, {
          mode: input.mode,
          cellIndex: input.cellIndex,
          start: input.start,
          end: input.end,
          kernel: input.kernel,
          timeoutMs,
          save: input.save,
          restart: input.restart,
          workingDirectory: input.workingDirectory,
          maxOutputChars,
          abortSignal: context.abort
        })
      )
      const lines: string[] = []
      const usedWarmKernel =
        pluginOpts.warmKernel && services.kernel.isRunning(result.absPath)
      lines.push(`Executed ${result.executedCells.length} cell(s) in \`${result.displayPath}\` (${result.durationMs}ms).`)
      lines.push(`Saved: ${result.saved}`)
      if (usedWarmKernel) {
        const k = services.kernel.list().find((it) => it.filePath === result.absPath)
        if (k) {
          lines.push(`Kernel: warm pid=${k.pid} requestsHandled=${k.requestsHandled}`)
        }
      }
      const cellError = result.response.success ? undefined : result.response.error
      if (cellError) {
        lines.push("")
        lines.push(
          cellError.cellIndex >= 0
            ? `Execution failed at cell ${cellError.cellIndex}: ${cellError.ename}: ${cellError.evalue}`
            : `Execution failed: ${cellError.ename}: ${cellError.evalue}`
        )
        const traceback = truncateTraceback(cellError.traceback, DEFAULT_MAX_TRACEBACK_CHARS)
        if (traceback.length > 0) {
          lines.push("Traceback:")
          for (const line of traceback.join("\n").split("\n")) {
            lines.push(`  ${line}`)
          }
        }
      }
      lines.push("")
      const attachments: ToolAttachment[] = []
      for (const out of result.response.outputs) {
        lines.push(`- cell [${out.cellIndex}] ${out.status}`)
        // `maxOutputChars` already bounded the values; preview caps are only
        // here to keep the rendered block readable for the model.
        if (out.stdout) lines.push(`  stdout: ${out.stdout.slice(0, 4_000)}`)
        if (out.stderr) lines.push(`  stderr: ${out.stderr.slice(0, 4_000)}`)
        if (out.resultPreview) lines.push(`  result: ${out.resultPreview.slice(0, 4_000)}`)
        if (out.displayData && out.displayData.length > 0) {
          const rendered = out.displayData.map((d, i) => {
            let label = `${d.mime} (${d.sizeBytes} bytes)`
            if (d.base64 !== undefined) {
              const ext = pickExtensionForMime(d.mime)
              attachments.push(
                formatAttachment(
                  d.mime,
                  d.base64,
                  `cell-${out.cellIndex}-image-${i}${ext ? `.${ext}` : ""}`
                )
              )
              label += " [attached]"
            } else if (d.notice !== undefined) {
              label += ` [${d.notice}]`
            }
            return label
          })
          const display = rendered.slice(0, 5).join(", ")
          const suffix = rendered.length > 5 ? `, +${rendered.length - 5} more` : ""
          lines.push(`  display_data: ${display}${suffix}`)
        }
        if (out.errors && out.errors.length > 0) {
          for (const err of out.errors) {
            lines.push(`  error: ${err.ename}: ${err.evalue}`)
          }
        }
      }
      const toolResult: {
        title: string
        output: string
        metadata: Record<string, unknown>
        attachments?: ToolAttachment[]
      } = {
        title: `ipynb_run ${input.mode} on ${input.filePath}`,
        output: lines.join("\n"),
        metadata: {
          filePath: result.absPath,
          executedCells: result.executedCells,
          durationMs: result.durationMs,
          saved: result.saved,
          ...(cellError === undefined
            ? {}
            : {
                error: true,
                failedCellIndex: cellError.cellIndex,
                ename: cellError.ename,
                evalue: cellError.evalue
              })
        }
      }
      if (attachments.length > 0) {
        toolResult.attachments = attachments
      }
      return toolResult
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `ipynb_run ${input.mode} on ${input.filePath} (error)`,
        output: `Error: ${message}\n\nTip: run ipynb_doctor to diagnose the environment.`,
        metadata: { error: true, message }
      }
    }
  }
})
