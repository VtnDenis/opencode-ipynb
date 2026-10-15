import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import type { ToolContext } from "@opencode-ai/plugin"
import { makePathService } from "../../src/services/PathService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import {
  makeExportImpl,
  formatNotebookAsHtml,
  type ExportOptions
} from "../../src/services/NotebookExportService.js"
import { NotebookSchema, type NotebookRaw } from "../../src/domain/notebook.js"

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

const makeFakeContext = (directory: string, worktree: string): ToolContext =>
  ({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory,
    worktree,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown as ToolContext

const runOrThrow = async <A, E>(
  effect: Effect.Effect<A, E, never>
): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, E, never>)

const buildExport = (directory: string, worktree: string) => {
  const pathSvc = makePathService({
    directory,
    worktree,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService()
  const permSvc = makePermissionService(makeFakeContext(directory, worktree))
  return makeExportImpl(pathSvc, fileSvc, permSvc)
}

const writeNotebook = (dir: string, name: string, notebook: unknown): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify(notebook))
  return file
}

const makeNotebook = (): NotebookRaw =>
  NotebookSchema.parse({
    cells: [
      {
        cell_type: "markdown",
        metadata: {},
        source:
          "# Title\n\nSome **bold**, *italic* and `inline code`.\n\n- one\n- two\n\n```\nprint(1)\n```\n"
      },
      {
        cell_type: "code",
        execution_count: 3,
        metadata: {},
        outputs: [
          { output_type: "stream", name: "stdout", text: "hello pdf\n" },
          { output_type: "display_data", data: { "image/png": TINY_PNG_BASE64 }, metadata: {} },
          {
            output_type: "error",
            ename: "ValueError",
            evalue: "boom",
            traceback: ["Traceback (most recent call last)", "ValueError: boom"]
          }
        ],
        source: "raise ValueError('boom')\n"
      },
      { cell_type: "raw", metadata: {}, source: "raw <content>" }
    ],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" }
    },
    nbformat: 4,
    nbformat_minor: 5
  })

describe("formatNotebookAsHtml > standalone document", () => {
  it("produces a self-contained document with inline style and no external resources", () => {
    const html = formatNotebookAsHtml({
      notebook: makeNotebook(),
      displayPath: "notebook.ipynb",
      includeOutputs: true,
      includeErrors: true
    })

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
    expect(html).toContain('<html lang="en">')
    expect(html).toContain("</html>")
    expect(html).toContain("<style>")
    expect(html).toContain("<title>notebook.ipynb</title>")
    expect(html).not.toContain("<script")
    expect(html).not.toContain('src="http')
    expect(html).not.toContain("<link ")
  })

  it("renders markdown headings, lists, bold/italic, inline code and fenced blocks", () => {
    const html = formatNotebookAsHtml({
      notebook: makeNotebook(),
      displayPath: "notebook.ipynb",
      includeOutputs: true,
      includeErrors: true
    })

    expect(html).toContain("<h1>Title</h1>")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<em>italic</em>")
    expect(html).toContain("<code>inline code</code>")
    expect(html).toContain("<ul>")
    expect(html).toContain("<li>one</li>")
    expect(html).toContain("<li>two</li>")
    expect(html).toContain("<pre><code>print(1)</code></pre>")
  })

  it("renders code cells with a source block, an execution badge and outputs", () => {
    const html = formatNotebookAsHtml({
      notebook: makeNotebook(),
      displayPath: "notebook.ipynb",
      includeOutputs: true,
      includeErrors: true
    })

    expect(html).toContain(`<pre class="source"><code class="language-python">raise ValueError('boom')`)
    expect(html).toContain('<div class="badge">[3]</div>')
    expect(html).toContain('<pre class="output stdout">hello pdf')
    expect(html).toContain('src="data:image/png;base64,')
    expect(html).toContain("<strong>ValueError</strong>: boom")
    expect(html).toContain("ValueError: boom")
  })

  it("escapes HTML in markdown, raw cells and the document title", () => {
    const notebook = NotebookSchema.parse({
      cells: [
        {
          cell_type: "markdown",
          metadata: {},
          source: '# <script>alert("x & y")</script>\n'
        },
        { cell_type: "raw", metadata: {}, source: "<b>raw</b>" }
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    })
    const html = formatNotebookAsHtml({
      notebook,
      displayPath: "<evil>.ipynb",
      includeOutputs: true,
      includeErrors: true
    })

    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;alert(&quot;x &amp; y&quot;)&lt;/script&gt;")
    expect(html).not.toContain("<b>raw</b>")
    expect(html).toContain("&lt;b&gt;raw&lt;/b&gt;")
    expect(html).toContain("<title>&lt;evil&gt;.ipynb</title>")
  })

  it("honors includeOutputs/includeErrors filtering", () => {
    const noStream = formatNotebookAsHtml({
      notebook: makeNotebook(),
      displayPath: "notebook.ipynb",
      includeOutputs: false,
      includeErrors: true
    })
    expect(noStream).not.toContain("hello pdf")
    expect(noStream).toContain("<strong>ValueError</strong>: boom")

    const nothing = formatNotebookAsHtml({
      notebook: makeNotebook(),
      displayPath: "notebook.ipynb",
      includeOutputs: false,
      includeErrors: false
    })
    expect(nothing).not.toContain("hello pdf")
    expect(nothing).not.toContain("<strong>ValueError</strong>")
    expect(nothing).not.toContain("Traceback (most recent call last)")
  })
})

describe("NotebookExportService > html format", () => {
  const options = (outputPath: string | undefined): ExportOptions => ({
    format: "html",
    includeOutputs: true,
    includeErrors: true,
    outputPath,
    maxExportChars: 1_000_000
  })

  it("exports a standalone HTML document", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-html-"))
    try {
      const file = writeNotebook(dir, "nb.ipynb", makeNotebook())
      const exportSvc = buildExport(dir, dir)
      const result = await runOrThrow(exportSvc.export(file, options(undefined)))

      expect(result.format).toBe("html")
      expect(result.writtenTo).toBeUndefined()
      expect(result.rendered.startsWith("<!DOCTYPE html>")).toBe(true)
      expect(result.rendered).toContain("hello pdf")
      expect(result.rendered).toContain("data:image/png;base64,")
      expect(result.frontMatter).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes the HTML document to outputPath when provided", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-html-"))
    try {
      const file = writeNotebook(dir, "nb.ipynb", makeNotebook())
      const out = path.join(dir, "export.html")
      const exportSvc = buildExport(dir, dir)
      const result = await runOrThrow(exportSvc.export(file, options(out)))

      expect(result.writtenTo).toBe(out)
      const written = fs.readFileSync(out, "utf8")
      expect(written.startsWith("<!DOCTYPE html>")).toBe(true)
      expect(written).toContain("hello pdf")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("defaults includeOutputs to true for html at the tool level", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-html-tool-"))
    try {
      const file = writeNotebook(dir, "nb.ipynb", makeNotebook())
      const ipynbExportTool = (await import("../../src/tools/export.js")).ipynbExportTool
      const result = (await ipynbExportTool.execute(
        {
          filePath: file,
          format: "html",
          includeOutputs: undefined,
          includeErrors: true,
          outputPath: undefined
        },
        makeFakeContext(dir, dir)
      )) as { output: string; metadata?: Record<string, unknown> }

      expect(result.output).toContain("<!DOCTYPE html>")
      expect(result.output).toContain("hello pdf")
      expect(result.metadata).toMatchObject({ format: "html" })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps includeOutputs defaulting to false for markdown at the tool level", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-html-tool-"))
    try {
      const file = writeNotebook(dir, "nb.ipynb", makeNotebook())
      const ipynbExportTool = (await import("../../src/tools/export.js")).ipynbExportTool
      const result = (await ipynbExportTool.execute(
        {
          filePath: file,
          format: "markdown",
          includeOutputs: undefined,
          includeErrors: false,
          outputPath: undefined
        },
        makeFakeContext(dir, dir)
      )) as { output: string }

      expect(result.output).toContain("source:")
      expect(result.output).not.toContain("hello pdf")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
