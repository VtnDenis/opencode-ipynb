import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import type { ToolContext } from "@opencode-ai/plugin"
import {
  makePathService,
  makeNotebookFileService,
  makeDiffService,
  makePermissionService
} from "../../src/services/index.js"
import { makeEditImpl } from "../../src/services/NotebookEditService.js"

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

const buildEdit = (directory: string, worktree: string) => {
  const pathSvc = makePathService({
    directory,
    worktree,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService()
  const diffSvc = makeDiffService()
  const permSvc = makePermissionService(makeFakeContext(directory, worktree))
  return makeEditImpl(pathSvc, fileSvc, diffSvc, permSvc)
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

const readCells = (file: string): Array<Record<string, unknown>> => {
  const nb = JSON.parse(fs.readFileSync(file, "utf8")) as {
    cells: Array<Record<string, unknown>>
  }
  return nb.cells
}

const codeCell = (): Record<string, unknown> => ({
  cell_type: "code",
  id: "cell-code",
  execution_count: 7,
  metadata: { collapsed: true },
  outputs: [{ output_type: "stream", name: "stdout", text: "42\n" }],
  source: "print(42)\n"
})

const markdownCell = (): Record<string, unknown> => ({
  cell_type: "markdown",
  id: "cell-md",
  metadata: { tags: ["old"], keep: 1 },
  source: "# Hello\n"
})

const withTmpNotebook = async (
  cells: ReadonlyArray<unknown>,
  fn: (dir: string, file: string) => Promise<void>
): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-edit-convert-"))
  try {
    const file = writeNotebook(dir, "nb.ipynb", cells)
    await fn(dir, file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("NotebookEditService > cell type conversion", () => {
  it("converts code -> markdown and drops outputs and execution_count", async () => {
    await withTmpNotebook([codeCell()], async (dir, file) => {
      const edit = buildEdit(dir, dir)
      const result = await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "print(42)\n", cellType: "markdown" })
      )

      expect(result.converted).toBe(true)
      expect(result.cellType).toBe("markdown")
      expect(result.previousCellType).toBe("code")
      expect(result.clearedOutputs).toBe(true)

      const written = readCells(file)[0]
      if (!written) throw new Error("missing cell")
      expect(written["cell_type"]).toBe("markdown")
      expect("outputs" in written).toBe(false)
      expect("execution_count" in written).toBe(false)
      expect(written["id"]).toBe("cell-code")
      expect(written["source"]).toBe("print(42)\n")
      expect(written["metadata"]).toEqual({ collapsed: true })
    })
  })

  it("converts code -> raw even with clearOutputs='never' (conversion always clears)", async () => {
    await withTmpNotebook([codeCell()], async (dir, file) => {
      const edit = buildEdit(dir, dir)
      const result = await runOrThrow(
        edit.editCell(file, {
          cellIndex: 0,
          source: "print(42)\n",
          cellType: "raw",
          clearOutputs: "never"
        })
      )

      expect(result.converted).toBe(true)
      expect(result.clearedOutputs).toBe(true)
      const written = readCells(file)[0]
      if (!written) throw new Error("missing cell")
      expect(written["cell_type"]).toBe("raw")
      expect("outputs" in written).toBe(false)
      expect("execution_count" in written).toBe(false)
    })
  })

  it("converts markdown -> code with empty outputs and null execution_count", async () => {
    await withTmpNotebook([markdownCell()], async (dir, file) => {
      const edit = buildEdit(dir, dir)
      const result = await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "# Hello\n", cellType: "code" })
      )

      expect(result.converted).toBe(true)
      expect(result.cellType).toBe("code")
      expect(result.previousCellType).toBe("markdown")
      const written = readCells(file)[0]
      if (!written) throw new Error("missing cell")
      expect(written["cell_type"]).toBe("code")
      expect(written["outputs"]).toEqual([])
      expect(written["execution_count"]).toBeNull()
      expect(written["id"]).toBe("cell-md")
    })
  })

  it("keeps outputs when cellType matches the current type (no conversion)", async () => {
    await withTmpNotebook([codeCell()], async (dir, file) => {
      const edit = buildEdit(dir, dir)
      const result = await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "print(42)\n", cellType: "code" })
      )

      expect(result.converted).toBe(false)
      expect(result.clearedOutputs).toBe(false)
      const written = readCells(file)[0]
      if (!written) throw new Error("missing cell")
      expect((written["outputs"] as unknown[]).length).toBe(1)
      expect(written["execution_count"]).toBe(7)
    })
  })

  it("still clears outputs on a same-type code edit with source changes (clearOutputs=auto)", async () => {
    await withTmpNotebook([codeCell()], async (dir, file) => {
      const edit = buildEdit(dir, dir)
      const result = await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "print(43)\n" })
      )
      expect(result.converted).toBe(false)
      expect(result.clearedOutputs).toBe(true)
      const written = readCells(file)[0]
      if (!written) throw new Error("missing cell")
      expect(written["outputs"]).toEqual([])
      expect(written["execution_count"]).toBeNull()
    })
  })
})

describe("NotebookEditService > tags", () => {
  it("replaces metadata.tags with the provided list", async () => {
    await withTmpNotebook([markdownCell()], async (dir, file) => {
      const edit = buildEdit(dir, dir)
      const result = await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "# Hello\n", tags: ["a", "b"] })
      )
      expect(result.tags).toEqual(["a", "b"])
      const written = readCells(file)[0]
      if (!written) throw new Error("missing cell")
      expect(written["metadata"]).toEqual({ tags: ["a", "b"], keep: 1 })
    })
  })

  it("removes the tags key entirely when tags=[]", async () => {
    await withTmpNotebook([markdownCell()], async (dir, file) => {
      const edit = buildEdit(dir, dir)
      const result = await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "# Hello\n", tags: [] })
      )
      expect(result.tags).toEqual([])
      const written = readCells(file)[0]
      if (!written) throw new Error("missing cell")
      const metadata = written["metadata"] as Record<string, unknown>
      expect("tags" in metadata).toBe(false)
      expect(metadata["keep"]).toBe(1)
    })
  })

  it("leaves metadata untouched when tags is not provided", async () => {
    await withTmpNotebook([markdownCell()], async (dir, file) => {
      const edit = buildEdit(dir, dir)
      const result = await runOrThrow(edit.editCell(file, { cellIndex: 0, source: "# Hi\n" }))
      expect(result.tags).toBeUndefined()
      const written = readCells(file)[0]
      if (!written) throw new Error("missing cell")
      expect(written["metadata"]).toEqual({ tags: ["old"], keep: 1 })
    })
  })

  it("combines conversion and tags", async () => {
    await withTmpNotebook([codeCell()], async (dir, file) => {
      const edit = buildEdit(dir, dir)
      const result = await runOrThrow(
        edit.editCell(file, {
          cellIndex: 0,
          source: "print(42)\n",
          cellType: "markdown",
          tags: ["converted"]
        })
      )
      expect(result.converted).toBe(true)
      const written = readCells(file)[0]
      if (!written) throw new Error("missing cell")
      expect(written["metadata"]).toEqual({ collapsed: true, tags: ["converted"] })
    })
  })
})

describe("ipynb_edit tool > conversion and tags rendering", () => {
  it("mentions the conversion and the tags in the rendered output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-edit-tool-"))
    try {
      const file = writeNotebook(dir, "nb.ipynb", [codeCell()])
      const ipynbEditTool = (await import("../../src/tools/edit.js")).ipynbEditTool
      const result = (await ipynbEditTool.execute(
        {
          filePath: file,
          cellIndex: 0,
          source: "print(42)\n",
          clearOutputs: "auto",
          cellType: "markdown",
          tags: ["a", "b"]
        },
        makeFakeContext(dir, dir)
      )) as { output: string; metadata?: Record<string, unknown> }

      expect(result.output).toContain("Converted: code → markdown")
      expect(result.output).toContain("Tags: a, b")
      expect(result.output).toContain("Outputs cleared: yes")
      expect(result.metadata).toMatchObject({
        converted: true,
        cellType: "markdown",
        previousCellType: "code",
        tags: ["a", "b"]
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not claim a conversion when cellType is omitted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-edit-tool-"))
    try {
      const file = writeNotebook(dir, "nb.ipynb", [markdownCell()])
      const ipynbEditTool = (await import("../../src/tools/edit.js")).ipynbEditTool
      const result = (await ipynbEditTool.execute(
        {
          filePath: file,
          cellIndex: 0,
          source: "# New\n",
          clearOutputs: "auto",
          cellType: undefined,
          tags: undefined
        },
        makeFakeContext(dir, dir)
      )) as { output: string }

      expect(result.output).not.toContain("Converted:")
      expect(result.output).not.toContain("Tags:")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
