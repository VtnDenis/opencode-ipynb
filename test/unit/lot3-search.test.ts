import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import type { ToolContext } from "@opencode-ai/plugin"
import { makePathService, makeNotebookFileService } from "../../src/services/index.js"
import { makeSearchImpl } from "../../src/services/NotebookSearchService.js"
import { NotebookValidationError } from "../../src/domain/errors.js"

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

const buildSearch = (directory: string, worktree: string) => {
  const pathSvc = makePathService({
    directory,
    worktree,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService()
  return makeSearchImpl(pathSvc, fileSvc)
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

const SEARCH_CELLS: ReadonlyArray<unknown> = [
  { cell_type: "markdown", metadata: {}, source: "# Title\n\nfind me here.\n" },
  {
    cell_type: "code",
    execution_count: 1,
    metadata: {},
    outputs: [
      { output_type: "stream", name: "stdout", text: "hello\nFIND ME in output\n" },
      {
        output_type: "error",
        ename: "ValueError",
        evalue: "boom",
        traceback: ["Traceback (most recent call last)", "ValueError: boom"]
      }
    ],
    source: "print('find me')\n# Find me again\n"
  },
  { cell_type: "raw", metadata: {}, source: "raw find me" }
]

const withTmpDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-search-"))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("NotebookSearchService > source search", () => {
  it("finds literal text case-insensitively by default with cell, type, location and line", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "search.ipynb", SEARCH_CELLS)
      const search = buildSearch(dir, dir)
      const result = await runOrThrow(search.search(file, { query: "find me" }))

      expect(result.scope).toBe("source")
      expect(result.regex).toBe(false)
      expect(result.caseSensitive).toBe(false)
      expect(result.totalMatches).toBe(4)
      expect(result.truncated).toBe(false)
      expect(result.matches.map((m) => [m.cellIndex, m.cellType, m.location, m.line])).toEqual([
        [0, "markdown", "source", 3],
        [1, "code", "source", 1],
        [1, "code", "source", 2],
        [2, "raw", "source", 1]
      ])
      expect(result.matches[0]?.snippet).toBe("find me here.")
      expect(result.matches[1]?.snippet).toBe("print('find me')")
    })
  })

  it("honors caseSensitive=true", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "search.ipynb", SEARCH_CELLS)
      const search = buildSearch(dir, dir)

      const insensitive = await runOrThrow(search.search(file, { query: "FIND ME" }))
      expect(insensitive.totalMatches).toBe(4)

      const sensitive = await runOrThrow(
        search.search(file, { query: "FIND ME", caseSensitive: true })
      )
      expect(sensitive.totalMatches).toBe(0)
      expect(sensitive.matches).toEqual([])
    })
  })

  it("treats the query as literal text when regex=false", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "search.ipynb", SEARCH_CELLS)
      const search = buildSearch(dir, dir)
      const literal = await runOrThrow(search.search(file, { query: "f.nd me" }))
      expect(literal.totalMatches).toBe(0)
    })
  })

  it("supports regex=true", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "search.ipynb", SEARCH_CELLS)
      const search = buildSearch(dir, dir)
      const result = await runOrThrow(
        search.search(file, { query: "f.nd me", regex: true })
      )
      expect(result.regex).toBe(true)
      expect(result.totalMatches).toBe(4)
    })
  })

  it("returns a structured NotebookValidation error for an invalid regex", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "search.ipynb", SEARCH_CELLS)
      const search = buildSearch(dir, dir)
      const error = await Effect.runPromise(
        search.search(file, { query: "(", regex: true }).pipe(Effect.flip)
      )
      expect(error).toBeInstanceOf(NotebookValidationError)
      expect(error.message).toContain("invalid search regex")
    })
  })

  it("returns a structured error for an empty query", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "search.ipynb", SEARCH_CELLS)
      const search = buildSearch(dir, dir)
      const error = await Effect.runPromise(
        search.search(file, { query: "" }).pipe(Effect.flip)
      )
      expect(error).toBeInstanceOf(NotebookValidationError)
      expect(error.message).toContain("must not be empty")
    })
  })
})

describe("NotebookSearchService > outputs search", () => {
  it("searches stream and error outputs only when scope includes outputs", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "search.ipynb", SEARCH_CELLS)
      const search = buildSearch(dir, dir)

      const sourceOnly = await runOrThrow(search.search(file, { query: "hello" }))
      expect(sourceOnly.totalMatches).toBe(0)

      const outputsOnly = await runOrThrow(
        search.search(file, { query: "hello", scope: "outputs" })
      )
      expect(outputsOnly.totalMatches).toBe(1)
      expect(outputsOnly.matches[0]?.cellIndex).toBe(1)
      expect(outputsOnly.matches[0]?.cellType).toBe("code")
      expect(outputsOnly.matches[0]?.location).toBe("output")
      expect(outputsOnly.matches[0]?.line).toBe(1)

      const errorText = await runOrThrow(
        search.search(file, { query: "Traceback (most recent call last)", scope: "outputs" })
      )
      expect(errorText.totalMatches).toBe(1)
      expect(errorText.matches[0]?.line).toBe(2)
    })
  })

  it("searches both scopes when scope=both", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "search.ipynb", SEARCH_CELLS)
      const search = buildSearch(dir, dir)
      const result = await runOrThrow(
        search.search(file, { query: "find me", scope: "both" })
      )
      expect(result.scope).toBe("both")
      expect(result.totalMatches).toBe(5)
      const locations = result.matches.map((m) => m.location)
      expect(locations).toContain("output")
      expect(locations).toContain("source")
    })
  })
})

describe("NotebookSearchService > result limits", () => {
  const MANY_MATCHES = (): ReadonlyArray<unknown> => [
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: Array.from({ length: 10 }, (_, i) => `needle ${i}`).join("\n")
    }
  ]

  it("caps the returned matches and reports the truncation", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "many.ipynb", MANY_MATCHES())
      const search = buildSearch(dir, dir)
      const result = await runOrThrow(search.search(file, { query: "needle", maxResults: 3 }))
      expect(result.totalMatches).toBe(10)
      expect(result.matches.length).toBe(3)
      expect(result.truncated).toBe(true)
      expect(result.maxResults).toBe(3)
    })
  })

  it("clamps maxResults to MAX_SEARCH_RESULTS (200)", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "many.ipynb", MANY_MATCHES())
      const search = buildSearch(dir, dir)
      const result = await runOrThrow(search.search(file, { query: "needle", maxResults: 1000 }))
      expect(result.maxResults).toBe(200)
      expect(result.truncated).toBe(false)
      expect(result.totalMatches).toBe(10)
    })
  })

  it("defaults maxResults to 50", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "many.ipynb", MANY_MATCHES())
      const search = buildSearch(dir, dir)
      const result = await runOrThrow(search.search(file, { query: "needle" }))
      expect(result.maxResults).toBe(50)
    })
  })

  it("truncates long snippets to a single bounded line", async () => {
    await withTmpDir(async (dir) => {
      const file = writeNotebook(dir, "long.ipynb", [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: `needle ${"x".repeat(500)}`
        }
      ])
      const search = buildSearch(dir, dir)
      const result = await runOrThrow(search.search(file, { query: "needle" }))
      const snippet = result.matches[0]?.snippet ?? ""
      expect(snippet.length).toBeLessThanOrEqual(160)
      expect(snippet).toContain("(truncated)")
      expect(snippet).not.toContain("\n")
    })
  })
})

describe("ipynb_search tool", () => {
  const importTool = async () => {
    const mod = await import("../../src/tools/search.js")
    return mod.ipynbSearchTool
  }

  const asObject = (r: unknown): { title?: string; output: string; metadata?: Record<string, unknown> } => {
    if (typeof r !== "object" || r === null || !("output" in r)) {
      throw new Error(`expected object tool result, got: ${String(r)}`)
    }
    return r as { title?: string; output: string; metadata?: Record<string, unknown> }
  }

  it("renders matches with a total line and truncation notice", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-search-tool-"))
    try {
      const file = writeNotebook(dir, "search.ipynb", SEARCH_CELLS)
      const ipynbSearchTool = await importTool()
      const result = asObject(
        await ipynbSearchTool.execute(
          {
            filePath: file,
            query: "find me",
            regex: false,
            caseSensitive: false,
            scope: "source",
            maxResults: 2
          },
          makeFakeContext(dir, dir)
        )
      )
      expect(result.output).toContain("Search in")
      expect(result.output).toContain("- cell 0 (markdown, source, line 3): find me here.")
      expect(result.output).toContain("matches: 2 shown / 4 total (truncated)")
      expect(result.output).toContain("use maxResults to increase")
      expect(result.metadata).toMatchObject({
        totalMatches: 4,
        shown: 2,
        truncated: true
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports an invalid regex as an error result instead of throwing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-search-tool-"))
    try {
      const file = writeNotebook(dir, "search.ipynb", SEARCH_CELLS)
      const ipynbSearchTool = await importTool()
      const result = asObject(
        await ipynbSearchTool.execute(
          {
            filePath: file,
            query: "[",
            regex: true,
            caseSensitive: false,
            scope: "source",
            maxResults: 50
          },
          makeFakeContext(dir, dir)
        )
      )
      expect(result.output).toContain("Error")
      expect(result.output).toContain("invalid search regex")
      expect(result.metadata).toEqual({ error: true, message: expect.any(String) })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
