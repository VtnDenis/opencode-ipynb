import { z } from "zod"
import { tool } from "../v1compat.js"
import { Effect } from "effect"
import type { ToolContext } from "../v1compat.js"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"
import { DEFAULT_MAX_EXPORT_CHARS } from "../utils/limits.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  format: z
    .enum(["markdown", "python", "summary", "html"])
    .describe("Export format: markdown, python, html (standalone document), or summary"),
  includeOutputs: z
    .boolean()
    .optional()
    .describe(
      "Include cell outputs: markdown/python/summary default to false, html defaults to true (a standalone document without outputs is rarely useful)"
    ),
  includeErrors: z
    .boolean()
    .optional()
    .default(true)
    .describe("For markdown/html: include error tracebacks (default: true)"),
  outputPath: z
    .string()
    .optional()
    .describe("Optional path to write the export to. If omitted, returns content in the tool output.")
}

export const ipynbExportTool = tool({
  description:
    "Export a Jupyter Notebook to markdown, python, html, or a textual summary. The html format is a standalone document (inline styles, images as data: URIs, no external resources). Optionally write the result to a file (after permission).",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      const includeOutputs = input.includeOutputs ?? (input.format === "html")
      const result = await Effect.runPromise(
        services.export.export(input.filePath, {
          format: input.format,
          includeOutputs,
          includeErrors: input.includeErrors ?? true,
          outputPath: input.outputPath,
          maxExportChars: DEFAULT_MAX_EXPORT_CHARS
        })
      )
      const head = result.writtenTo
        ? `Exported ${result.cellCount} cells from \`${result.displayPath}\` to \`${result.writtenTo}\` (${result.format}).`
        : `Exported ${result.cellCount} cells from \`${result.displayPath}\` as ${result.format} (no file written).`
      const body = input.outputPath ? `${head}\n\n(File written successfully.)` : `${head}\n\n${result.rendered}`
      return {
        title: `Export ${input.filePath} as ${input.format}`,
        output: body,
        metadata: {
          filePath: result.absPath,
          format: result.format,
          cellCount: result.cellCount,
          writtenTo: result.writtenTo,
          length: result.rendered.length
        }
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `Export ${input.filePath} as ${input.format} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
