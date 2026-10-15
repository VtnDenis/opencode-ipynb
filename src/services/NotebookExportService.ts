import { Context, Effect } from "effect"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import {
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  NotebookWriteError,
  PathOutsideWorktreeError,
  PermissionDeniedError
} from "../domain/errors.js"
import { NotebookFileService, type NotebookFileServiceShape } from "./NotebookFileService.js"
import { PathService, type PathServiceShape } from "./PathService.js"
import { PermissionService, type PermissionServiceShape } from "./PermissionService.js"
import { cellSource, type NotebookRaw } from "../domain/notebook.js"
import { formatNotebookAsMarkdown, formatNotebookAsPython } from "../format/diff.js"
import { truncate } from "../utils/truncate.js"
import { DEFAULT_MAX_EXPORT_CHARS } from "../utils/limits.js"
import { formatOutputs } from "../format/outputs.js"
import { detectOutputKind } from "../domain/output.js"
import { estimateBase64Bytes, humanBytes, isImageMime } from "../utils/mime.js"
import { stripAnsi } from "../utils/ansi.js"
import type { CodeCellRaw } from "../domain/cell.js"

export type ExportFormat = "markdown" | "python" | "summary" | "html"

export interface ExportOptions {
  readonly format: ExportFormat
  readonly includeOutputs: boolean
  readonly includeErrors: boolean
  readonly outputPath: string | undefined
  readonly maxExportChars: number
}

export interface ExportResult {
  readonly displayPath: string
  readonly absPath: string
  readonly format: ExportFormat
  readonly writtenTo: string | undefined
  readonly rendered: string
  readonly cellCount: number
  readonly frontMatter?: string | undefined
}

export interface NotebookExportServiceShape {
  readonly export: (
    filePath: string,
    options: ExportOptions
  ) => Effect.Effect<
    ExportResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
}

export class NotebookExportService extends Context.Tag("@ipynb/NotebookExportService")<
  NotebookExportService,
  NotebookExportServiceShape
>() {}

const yamlScalar = (s: string): string =>
  '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'

const buildFrontMatter = (params: {
  readonly displayPath: string
  readonly notebook: NotebookRaw
}): string => {
  const meta = params.notebook.metadata
  const kernelSpec = meta.kernelspec
  const kernel = kernelSpec?.display_name ?? kernelSpec?.name ?? "unknown"
  const language = meta.language_info?.name ?? "unknown"
  const allCells = params.notebook.cells
  const codeCells = allCells.filter((c) => c.cell_type === "code").length
  const markdownCells = allCells.filter((c) => c.cell_type === "markdown").length
  const rawCells = allCells.filter((c) => c.cell_type === "raw").length
  const lines = [
    "---",
    `source: ${yamlScalar(params.displayPath)}`,
    `kernel: ${yamlScalar(kernel)}`,
    `language: ${yamlScalar(language)}`,
    `cells: ${allCells.length}`,
    `code_cells: ${codeCells}`,
    `markdown_cells: ${markdownCells}`,
    `raw_cells: ${rawCells}`,
    "---"
  ]
  return lines.join("\n")
}

type SummaryCell = {
  readonly index: number
  readonly cell_type: "code" | "markdown" | "raw"
  readonly source: string
  readonly execution_count: number | null
  readonly output_count: number
}

const truncateFirstLine = (source: string, max = 120): string => {
  const first = source.split("\n")[0] ?? ""
  if (first.length <= max) return first
  return first.slice(0, max) + "..."
}

const buildSummary = (notebook: NotebookRaw): string => {
  const cells: SummaryCell[] = notebook.cells.map((cell, index) => {
    if (cell.cell_type === "code") {
      return {
        index,
        cell_type: "code",
        source: cellSource(cell),
        execution_count: cell.execution_count,
        output_count: cell.outputs.length
      }
    }
    return {
      index,
      cell_type: cell.cell_type,
      source: cellSource(cell),
      execution_count: null,
      output_count: 0
    }
  })

  const code = cells.filter((c) => c.cell_type === "code")
  const md = cells.filter((c) => c.cell_type === "markdown")
  const raw = cells.filter((c) => c.cell_type === "raw")

  const sortByIndex = (arr: SummaryCell[]): SummaryCell[] =>
    [...arr].sort((a, b) => a.index - b.index)

  const lines: string[] = []
  lines.push("# Notebook Summary")
  lines.push("")
  lines.push("## Counts")
  lines.push(`- total: ${cells.length}`)
  lines.push(`- code: ${code.length}`)
  lines.push(`- markdown: ${md.length}`)
  lines.push(`- raw: ${raw.length}`)
  lines.push("")

  if (code.length > 0) {
    lines.push("## Code cells")
    for (const c of sortByIndex(code)) {
      const first = truncateFirstLine(c.source)
      const exec = c.execution_count === null ? "null" : String(c.execution_count)
      lines.push(`- [${c.index}] | ${first} | exec=${exec} | outputs=${c.output_count}`)
    }
    lines.push("")
  }

  if (md.length > 0) {
    lines.push("## Markdown cells")
    for (const c of sortByIndex(md)) {
      const first = truncateFirstLine(c.source)
      lines.push(`- [${c.index}] | ${first}`)
    }
    lines.push("")
  }

  if (raw.length > 0) {
    lines.push("## Raw cells")
    for (const c of sortByIndex(raw)) {
      const first = truncateFirstLine(c.source)
      lines.push(`- [${c.index}] | ${first}`)
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

/**
 * Standalone HTML export: no external resources (inline <style>, base64 data:
 * URIs for images). Markdown is rendered with a deliberately small subset
 * (headings, lists, bold/italic, inline code, fenced blocks) and everything is
 * HTML-escaped. Raw HTML from notebook outputs is never inlined.
 */
const HTML_MAX_INLINE_IMAGE_BYTES = 1_000_000
const HTML_MAX_OUTPUT_CHARS = 2_000
const HTML_MAX_TRACEBACK_CHARS = 4_000

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

const renderInlineMarkdown = (escaped: string): string => {
  // Inline code wins over bold/italic, so stash code spans first.
  const codeSpans: string[] = []
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(code)
    return `\u0000${codeSpans.length - 1}\u0000`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>")
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => `<code>${codeSpans[Number(idx)] ?? ""}</code>`)
  return out
}

const renderMarkdownHtml = (source: string): string => {
  const lines = source.split("\n")
  const out: string[] = []
  let list: "ul" | "ol" | null = null
  const closeList = (): void => {
    if (list !== null) {
      out.push(`</${list}>`)
      list = null
    }
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    if (/^\s*```/.test(line)) {
      closeList()
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "")
        i++
      }
      if (i < lines.length) {
        i++ // skip the closing fence
      }
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1]?.length ?? 1
      out.push(`<h${level}>${renderInlineMarkdown(escapeHtml(heading[2] ?? ""))}</h${level}>`)
      i++
      continue
    }
    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (unordered || ordered) {
      const kind: "ul" | "ol" = unordered ? "ul" : "ol"
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${renderInlineMarkdown(escapeHtml((unordered ?? ordered)?.[1] ?? ""))}</li>`)
      i++
      continue
    }
    if (line.trim().length === 0) {
      closeList()
      i++
      continue
    }
    closeList()
    out.push(`<p>${renderInlineMarkdown(escapeHtml(line))}</p>`)
    i++
  }
  closeList()
  return out.join("\n")
}

const outputTextToString = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).join("") : String(value ?? "")

const renderOutputsHtml = (
  cell: CodeCellRaw,
  options: { readonly includeOutputs: boolean; readonly includeErrors: boolean }
): string => {
  const outputs = options.includeOutputs
    ? options.includeErrors
      ? cell.outputs
      : cell.outputs.filter((out) => detectOutputKind(out) !== "error")
    : options.includeErrors
      ? cell.outputs.filter((out) => detectOutputKind(out) === "error")
      : []
  const blocks: string[] = []
  for (const out of outputs) {
    const kind = detectOutputKind(out)
    if (kind === "stream") {
      const name = String(out["name"] ?? "stdout")
      const text = outputTextToString(out["text"])
      if (text.length === 0) continue
      const t = truncate(text, HTML_MAX_OUTPUT_CHARS, { key: "stream", paramName: "maxOutputChars" })
      blocks.push(
        `<pre class="output ${name === "stderr" ? "stderr" : "stdout"}">${escapeHtml(t.text)}</pre>`
      )
    } else if (kind === "execute_result" || kind === "display_data") {
      const data = (out["data"] as Record<string, unknown> | undefined) ?? {}
      for (const [mime, value] of Object.entries(data)) {
        if (typeof value !== "string") continue
        if (isImageMime(mime)) {
          const safeMime = mime.toLowerCase()
          const bytes = estimateBase64Bytes(value)
          if (bytes > HTML_MAX_INLINE_IMAGE_BYTES) {
            blocks.push(
              `<p class="output omitted">(${escapeHtml(safeMime)}, ${humanBytes(bytes)} omitted from HTML export)</p>`
            )
          } else {
            blocks.push(`<img alt="${escapeHtml(safeMime)}" src="data:${safeMime};base64,${value}">`)
          }
        } else {
          const t = truncate(value, HTML_MAX_OUTPUT_CHARS, { key: "output", paramName: "maxOutputChars" })
          blocks.push(`<pre class="output ${escapeHtml(mime.toLowerCase())}">${escapeHtml(t.text)}</pre>`)
        }
      }
    } else if (kind === "error") {
      const ename = String(out["ename"] ?? "Error")
      const evalue = String(out["evalue"] ?? "")
      const traceback = Array.isArray(out["traceback"])
        ? (out["traceback"] as ReadonlyArray<string>)
        : []
      const cleaned = traceback.map(stripAnsi).join("\n").trim()
      const t = truncate(cleaned, HTML_MAX_TRACEBACK_CHARS, {
        key: "traceback",
        paramName: "maxTracebackChars"
      })
      const tracebackHtml = t.text.length > 0 ? `\n<pre>${escapeHtml(t.text)}</pre>` : ""
      blocks.push(
        `<div class="output error"><p><strong>${escapeHtml(ename)}</strong>: ${escapeHtml(evalue)}</p>${tracebackHtml}</div>`
      )
    }
  }
  if (blocks.length === 0) {
    return ""
  }
  return `<div class="outputs">\n${blocks.join("\n")}\n</div>`
}

const HTML_STYLE = [
  "body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; line-height: 1.5; color: #1f2328; }",
  "section.cell { margin: 1.25rem 0; }",
  "div.badge { color: #59636e; font-family: ui-monospace, monospace; font-size: 0.85rem; }",
  "pre { background: #f6f8fa; border-radius: 6px; padding: 0.75rem; overflow-x: auto; }",
  "pre.stderr, div.error { color: #b00020; }",
  "div.error { border-left: 3px solid #b00020; padding-left: 0.75rem; }",
  "img { max-width: 100%; }",
  "p.output.omitted { color: #59636e; font-style: italic; }"
].join("\n")

export const formatNotebookAsHtml = (params: {
  readonly notebook: NotebookRaw
  readonly displayPath: string
  readonly includeOutputs: boolean
  readonly includeErrors: boolean
}): string => {
  const sections: string[] = []
  params.notebook.cells.forEach((cell, index) => {
    const source = cellSource(cell)
    if (cell.cell_type === "markdown") {
      sections.push(`<section class="cell markdown" id="cell-${index}">\n${renderMarkdownHtml(source)}\n</section>`)
      return
    }
    if (cell.cell_type === "raw") {
      sections.push(
        `<section class="cell raw" id="cell-${index}">\n<pre>${escapeHtml(source)}</pre>\n</section>`
      )
      return
    }
    const code = cell as CodeCellRaw
    const badge = code.execution_count === null ? "&nbsp;" : `[${code.execution_count}]`
    const outputs = renderOutputsHtml(code, {
      includeOutputs: params.includeOutputs,
      includeErrors: params.includeErrors
    })
    sections.push(
      `<section class="cell code" id="cell-${index}">\n<div class="badge">${badge}</div>\n<pre class="source"><code class="language-python">${escapeHtml(source.replace(/\n$/, ""))}</code></pre>${outputs.length > 0 ? `\n${outputs}` : ""}\n</section>`
    )
  })
  const title = escapeHtml(params.displayPath)
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>\n${HTML_STYLE}\n</style>`,
    "</head>",
    "<body>",
    `<h1>${title}</h1>`,
    ...sections,
    "</body>",
    "</html>",
    ""
  ].join("\n")
}

const makeExportImpl = (
  pathSvc: PathServiceShape,
  fileSvc: NotebookFileServiceShape,
  permSvc: PermissionServiceShape
): NotebookExportServiceShape => ({
  export: (filePath, options) =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      const notebook = yield* fileSvc.read(abs)
      const displayPath = pathSvc.toDisplay(abs)

      const cells = notebook.cells.map((cell) => ({
        cell_type: cell.cell_type,
        source: cellSource(cell)
      }))

      let rendered = ""
      let frontMatter: string | undefined
      if (options.format === "markdown") {
        const renderCellOutputs = options.includeOutputs || options.includeErrors
          ? (idx: number): string | undefined => {
              const c = notebook.cells[idx] as { cell_type: string; outputs?: unknown } | undefined
              if (!c || c.cell_type !== "code") return undefined
              const code = c as unknown as CodeCellRaw
              const outputs = options.includeOutputs
                ? options.includeErrors
                  ? code.outputs
                  : code.outputs.filter((out) => detectOutputKind(out) !== "error")
                : code.outputs.filter((out) => detectOutputKind(out) === "error")
              const section = formatOutputs({ ...code, outputs }, {
                includeImages: false,
                maxOutputChars: 2_000,
                maxTracebackChars: 4_000
              })
              if (!section || section === "(no output)") return undefined
              return section
            }
          : undefined
        rendered = formatNotebookAsMarkdown({
          cells,
          includeOutputs: options.includeOutputs,
          wrapOutputsInDetails: options.includeOutputs === true || options.includeErrors === true,
          renderCellOutputs
        })
        if (!options.includeOutputs) {
          frontMatter = buildFrontMatter({ displayPath, notebook })
          rendered = `${frontMatter}\n\n${rendered}`
        }
      } else if (options.format === "html") {
        rendered = formatNotebookAsHtml({
          notebook,
          displayPath,
          includeOutputs: options.includeOutputs,
          includeErrors: options.includeErrors
        })
      } else if (options.format === "python") {
        rendered = formatNotebookAsPython({ cells })
      } else {
        rendered = buildSummary(notebook)
      }

      const truncated = truncate(rendered, options.maxExportChars, "truncated export")
      const finalRendered = truncated.text

      let writtenTo: string | undefined
      if (options.outputPath) {
        const outAbs = yield* pathSvc.resolve(options.outputPath)
        yield* pathSvc.ensureInsideWorktree(outAbs)
        yield* permSvc.ask({
          kind: "edit",
          action: "ipynb_export_write",
          patterns: [outAbs],
          always: [outAbs],
          metadata: {
            sourceFile: abs,
            outputPath: outAbs,
            format: options.format,
            cellCount: cells.length,
            length: finalRendered.length
          }
        })
        yield* Effect.tryPromise({
          try: async () => {
            await fsp.mkdir(path.dirname(outAbs), { recursive: true })
            await fsp.writeFile(outAbs, finalRendered, "utf8")
          },
          catch: (err) =>
            new NotebookWriteError({
              message: err instanceof Error ? err.message : String(err),
              filePath: outAbs
            })
        })
        writtenTo = pathSvc.toDisplay(outAbs)
      }

      const baseResult = {
        displayPath,
        absPath: abs,
        format: options.format,
        writtenTo,
        rendered: finalRendered,
        cellCount: cells.length
      }
      if (frontMatter !== undefined) {
        return { ...baseResult, frontMatter }
      }
      return baseResult
    })
})

export { makeExportImpl }
export { DEFAULT_MAX_EXPORT_CHARS }
