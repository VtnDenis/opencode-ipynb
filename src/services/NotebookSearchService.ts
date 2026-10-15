import { Context, Effect } from "effect"
import {
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  PathOutsideWorktreeError
} from "../domain/errors.js"
import { NotebookFileService, type NotebookFileServiceShape } from "./NotebookFileService.js"
import { PathService, type PathServiceShape } from "./PathService.js"
import { cellSource } from "../domain/notebook.js"
import { detectOutputKind } from "../domain/output.js"
import { isImageMime } from "../utils/mime.js"
import { truncatePreview } from "../utils/truncate.js"
import type { CellRaw, CodeCellRaw } from "../domain/cell.js"

export type SearchScope = "source" | "outputs" | "both"

export type SearchLocation = "source" | "output"

export type SearchCellType = "code" | "markdown" | "raw"

export interface SearchRequest {
  readonly query: string
  readonly regex?: boolean | undefined
  readonly caseSensitive?: boolean | undefined
  readonly scope?: SearchScope | undefined
  readonly maxResults?: number | undefined
}

export interface SearchMatch {
  readonly cellIndex: number
  readonly cellType: SearchCellType
  readonly location: SearchLocation
  readonly line: number
  readonly snippet: string
}

export interface SearchResult {
  readonly displayPath: string
  readonly absPath: string
  readonly query: string
  readonly scope: SearchScope
  readonly regex: boolean
  readonly caseSensitive: boolean
  readonly matches: ReadonlyArray<SearchMatch>
  readonly totalMatches: number
  readonly truncated: boolean
  readonly maxResults: number
  readonly totalCells: number
}

export interface NotebookSearchServiceShape {
  readonly search: (
    filePath: string,
    request: SearchRequest
  ) => Effect.Effect<
    SearchResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | PathOutsideWorktreeError
  >
}

export class NotebookSearchService extends Context.Tag("@ipynb/NotebookSearchService")<
  NotebookSearchService,
  NotebookSearchServiceShape
>() {}

export const DEFAULT_MAX_SEARCH_RESULTS = 50
export const MAX_SEARCH_RESULTS = 200

const SEARCH_SNIPPET_CHARS = 160

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const compilePattern = (options: {
  readonly query: string
  readonly regex: boolean
  readonly caseSensitive: boolean
  readonly filePath: string
}): Effect.Effect<RegExp, NotebookValidationError> =>
  Effect.try({
    try: () =>
      new RegExp(
        options.regex ? options.query : escapeRegExp(options.query),
        options.caseSensitive ? "g" : "gi"
      ),
    catch: (err) =>
      new NotebookValidationError({
        message: `invalid search regex: ${err instanceof Error ? err.message : String(err)}`,
        filePath: options.filePath,
        issues: [`query: ${options.query}`]
      })
  })

const outputTextToString = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).join("") : String(value ?? "")

const snippetAt = (text: string, index: number): string => {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1
  const newlineAt = text.indexOf("\n", index)
  const lineEnd = newlineAt === -1 ? text.length : newlineAt
  const line = text.slice(lineStart, lineEnd)
  return truncatePreview(line, SEARCH_SNIPPET_CHARS).replace(/\n/g, " ")
}

interface SearchAccumulator {
  readonly matches: SearchMatch[]
  total: number
}

const searchInText = (
  acc: SearchAccumulator,
  text: string,
  context: { cellIndex: number; cellType: SearchCellType; location: SearchLocation },
  pattern: RegExp,
  maxResults: number
): void => {
  pattern.lastIndex = 0
  let counted = 0
  let line = 1
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const index = match.index
    for (let i = counted; i < index; i++) {
      if (text.charCodeAt(i) === 10) {
        line++
      }
    }
    counted = index
    acc.total++
    if (acc.matches.length < maxResults) {
      acc.matches.push({
        cellIndex: context.cellIndex,
        cellType: context.cellType,
        location: context.location,
        line,
        snippet: snippetAt(text, index)
      })
    }
    if (match[0].length === 0) {
      // Zero-length match (e.g. `a*`): advance so the loop terminates.
      pattern.lastIndex++
    }
  }
}

const outputTexts = (cell: CodeCellRaw): ReadonlyArray<string> => {
  const texts: string[] = []
  for (const out of cell.outputs) {
    const kind = detectOutputKind(out)
    if (kind === "stream") {
      texts.push(outputTextToString(out["text"]))
    } else if (kind === "error") {
      const traceback = Array.isArray(out["traceback"])
        ? (out["traceback"] as ReadonlyArray<string>).join("\n")
        : ""
      const header = `${String(out["ename"] ?? "Error")}: ${String(out["evalue"] ?? "")}`
      texts.push(traceback.length > 0 ? `${header}\n${traceback}` : header)
    } else if (kind === "display_data" || kind === "execute_result") {
      const data = (out["data"] as Record<string, unknown> | undefined) ?? {}
      for (const [mime, value] of Object.entries(data)) {
        if (isImageMime(mime)) {
          continue
        }
        if (typeof value === "string") {
          texts.push(value)
        } else if (Array.isArray(value)) {
          texts.push(value.map(String).join(""))
        } else {
          texts.push(JSON.stringify(value))
        }
      }
    }
  }
  return texts
}

const build = (
  pathSvc: PathServiceShape,
  fileSvc: NotebookFileServiceShape
): NotebookSearchServiceShape => ({
  search: (filePath, request) =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      const query = request.query
      if (query.length === 0) {
        return yield* new NotebookValidationError({
          message: "search query must not be empty",
          filePath: abs,
          issues: ["query"]
        })
      }
      const regex = request.regex ?? false
      const caseSensitive = request.caseSensitive ?? false
      const scope = request.scope ?? "source"
      const rawMaxResults = request.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS
      const maxResults = Number.isFinite(rawMaxResults)
        ? Math.min(Math.max(1, Math.floor(rawMaxResults)), MAX_SEARCH_RESULTS)
        : DEFAULT_MAX_SEARCH_RESULTS
      const pattern = yield* compilePattern({ query, regex, caseSensitive, filePath: abs })
      const notebook = yield* fileSvc.read(abs)
      const acc: SearchAccumulator = { matches: [], total: 0 }
      for (let i = 0; i < notebook.cells.length; i++) {
        const cell = notebook.cells[i] as CellRaw
        if (scope === "source" || scope === "both") {
          searchInText(
            acc,
            cellSource(cell),
            { cellIndex: i, cellType: cell.cell_type, location: "source" },
            pattern,
            maxResults
          )
        }
        if ((scope === "outputs" || scope === "both") && cell.cell_type === "code") {
          for (const text of outputTexts(cell as CodeCellRaw)) {
            searchInText(
              acc,
              text,
              { cellIndex: i, cellType: "code", location: "output" },
              pattern,
              maxResults
            )
          }
        }
      }
      const displayPath = pathSvc.toDisplay(abs)
      return {
        displayPath,
        absPath: abs,
        query,
        scope,
        regex,
        caseSensitive,
        matches: acc.matches,
        totalMatches: acc.total,
        truncated: acc.total > acc.matches.length,
        maxResults,
        totalCells: notebook.cells.length
      }
    })
})

export const formatSearchResults = (result: SearchResult): string => {
  const lines: string[] = []
  lines.push(
    `Search in \`${result.displayPath}\` (query: \`${result.query}\`, scope: ${result.scope}, regex: ${result.regex ? "yes" : "no"}, caseSensitive: ${result.caseSensitive ? "yes" : "no"})`
  )
  lines.push("")
  if (result.matches.length === 0) {
    lines.push("(no matches)")
  } else {
    for (const m of result.matches) {
      lines.push(`- cell ${m.cellIndex} (${m.cellType}, ${m.location}, line ${m.line}): ${m.snippet}`)
    }
  }
  lines.push("")
  lines.push(
    `matches: ${result.matches.length} shown / ${result.totalMatches} total${result.truncated ? " (truncated)" : ""}`
  )
  if (result.truncated) {
    lines.push(`(showing ${result.matches.length} of ${result.totalMatches} matches; use maxResults to increase)`)
  }
  return lines.join("\n")
}

export { build as makeSearchImpl }
