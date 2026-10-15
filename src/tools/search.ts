import { z } from "zod"
import { tool } from "../v1compat.js"
import { Effect } from "effect"
import type { ToolContext } from "../v1compat.js"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"
import {
  formatSearchResults,
  DEFAULT_MAX_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS
} from "../services/NotebookSearchService.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  query: z.string().min(1).describe("Text (or regular expression when regex=true) to look for"),
  regex: z
    .boolean()
    .optional()
    .default(false)
    .describe("Treat query as a JavaScript regular expression (default: literal text)"),
  caseSensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Match case-sensitively (default: false)"),
  scope: z
    .enum(["source", "outputs", "both"])
    .optional()
    .default("source")
    .describe("Where to search: cell sources (default), cell outputs, or both"),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum number of matches to return (default ${DEFAULT_MAX_SEARCH_RESULTS}, capped at ${MAX_SEARCH_RESULTS})`
    )
}

export const ipynbSearchTool = tool({
  description:
    "Search a Jupyter Notebook's cell sources and/or outputs and return matching lines with cell indexes and line numbers. Prefer this over ipynb_read when locating code, text, or output lines: it avoids reading whole ranges and keeps context small. Invalid regexes are reported as a structured error.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      const result = await Effect.runPromise(
        services.search.search(input.filePath, {
          query: input.query,
          regex: input.regex ?? false,
          caseSensitive: input.caseSensitive ?? false,
          scope: input.scope ?? "source",
          maxResults: input.maxResults
        })
      )
      return {
        title: `Search ${input.filePath}`,
        output: formatSearchResults(result),
        metadata: {
          filePath: result.absPath,
          displayPath: result.displayPath,
          query: result.query,
          scope: result.scope,
          regex: result.regex,
          caseSensitive: result.caseSensitive,
          totalMatches: result.totalMatches,
          shown: result.matches.length,
          truncated: result.truncated
        }
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `Search ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
