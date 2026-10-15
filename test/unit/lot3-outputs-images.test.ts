import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import type { ToolContext } from "@opencode-ai/plugin"
import {
  makePathService,
  makeNotebookFileService,
  makePermissionService,
  makeOutputImpl
} from "../../src/services/index.js"

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

const buildOutput = (directory: string, worktree: string) => {
  const pathSvc = makePathService({
    directory,
    worktree,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService()
  const permSvc = makePermissionService(makeFakeContext(directory, worktree))
  return makeOutputImpl(pathSvc, fileSvc, permSvc)
}

const writeNotebook = (dir: string, name: string, cells: ReadonlyArray<unknown>): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(
    file,
    JSON.stringify({
      cells,
      metadata: {
        kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
        language_info: { name: "python" }
      },
      nbformat: 4,
      nbformat_minor: 5
    })
  )
  return file
}

const imageCell = (imageCount: number): Record<string, unknown> => ({
  cell_type: "code",
  execution_count: 1,
  metadata: {},
  outputs: Array.from({ length: imageCount }, () => ({
    output_type: "display_data",
    data: { "image/png": TINY_PNG_BASE64 },
    metadata: {}
  })),
  source: "plot()"
})

describe("NotebookOutputService > readOutputs images", () => {
  it("returns data: attachments when includeImages=true", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-outputs-img-"))
    try {
      const file = writeNotebook(dir, "img.ipynb", [imageCell(1)])
      const output = buildOutput(dir, dir)
      const result = await runOrThrow(
        output.readOutputs(file, { cellIndex: 0, includeImages: true, maxOutputChars: 6_000 })
      )

      expect(result.attachments.length).toBe(1)
      const att = result.attachments[0]
      expect(att?.type).toBe("file")
      expect(att?.mime).toBe("image/png")
      expect(att?.url.startsWith("data:image/png;base64,")).toBe(true)
      expect(att?.filename).toBe("image.png")
      expect(result.rendered).toContain("attached as image")
      expect(result.rendered).not.toContain(";base64,")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("omits images (with the usual notice) when includeImages=false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-outputs-img-"))
    try {
      const file = writeNotebook(dir, "img.ipynb", [imageCell(1)])
      const output = buildOutput(dir, dir)
      const result = await runOrThrow(
        output.readOutputs(file, { cellIndex: 0, includeImages: false, maxOutputChars: 6_000 })
      )

      expect(result.attachments).toEqual([])
      expect(result.rendered).toContain("omitted by default")
      expect(result.rendered).not.toContain("attached as image")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("caps attachments at DEFAULT_MAX_IMAGE_NOTICE_COUNT (20) with a notice", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-outputs-img-"))
    try {
      const file = writeNotebook(dir, "many.ipynb", [imageCell(21)])
      const output = buildOutput(dir, dir)
      const result = await runOrThrow(
        output.readOutputs(file, { cellIndex: 0, includeImages: true, maxOutputChars: 6_000 })
      )

      expect(result.attachments.length).toBe(20)
      expect(result.rendered).toContain("omitted 1 additional image(s)")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns no attachments for non-code cells", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-outputs-img-"))
    try {
      const file = writeNotebook(dir, "md.ipynb", [
        { cell_type: "markdown", metadata: {}, source: "# title" }
      ])
      const output = buildOutput(dir, dir)
      const result = await runOrThrow(
        output.readOutputs(file, { cellIndex: 0, includeImages: true, maxOutputChars: 6_000 })
      )
      expect(result.attachments).toEqual([])
      expect(result.rendered).toContain("not a code cell")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("ipynb_outputs tool > read with images", () => {
  const importTool = async () => {
    const mod = await import("../../src/tools/outputs.js")
    return mod.ipynbOutputsTool
  }

  it("includes attachments in the tool result when includeImages=true", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-outputs-tool-img-"))
    try {
      const file = writeNotebook(dir, "img.ipynb", [imageCell(1)])
      const ipynbOutputsTool = await importTool()
      const result = (await ipynbOutputsTool.execute(
        {
          filePath: file,
          operation: "read",
          cellIndex: 0,
          offset: undefined,
          limit: undefined,
          includeImages: true,
          maxOutputChars: 6_000
        },
        makeFakeContext(dir, dir)
      )) as {
        output: string
        attachments?: ReadonlyArray<{ mime: string; url: string }>
      }

      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0]?.mime).toBe("image/png")
      expect(result.attachments?.[0]?.url.startsWith("data:image/png;base64,")).toBe(true)
      expect(result.output).toContain("attached as image")
      expect(result.output).not.toContain(";base64,")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not include attachments when includeImages is false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-outputs-tool-img-"))
    try {
      const file = writeNotebook(dir, "img.ipynb", [imageCell(1)])
      const ipynbOutputsTool = await importTool()
      const result = (await ipynbOutputsTool.execute(
        {
          filePath: file,
          operation: "read",
          cellIndex: 0,
          offset: undefined,
          limit: undefined,
          includeImages: false,
          maxOutputChars: 6_000
        },
        makeFakeContext(dir, dir)
      )) as {
        output: string
        attachments?: ReadonlyArray<{ mime: string; url: string }>
      }

      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("omitted by default")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
