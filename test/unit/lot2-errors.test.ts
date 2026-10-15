import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import {
  buildPersistedOutputs,
  makeExecutionImpl,
  truncateCellSummary
} from "../../src/services/NotebookExecutionService.js"
import type { CellExecutionSummary, RunResponse } from "../../src/domain/execution.js"
import { RunResponseSchema } from "../../src/domain/execution.js"
import { NotebookSchema } from "../../src/domain/notebook.js"
import type { NotebookRaw } from "../../src/domain/notebook.js"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import type { KernelManagerShape } from "../../src/services/PythonService.js"

const makeContext = (dir: string) =>
  (({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown) as Parameters<typeof makePermissionService>[0]

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"

const summaryWith = (overrides: Partial<CellExecutionSummary> = {}): CellExecutionSummary => ({
  cellIndex: 0,
  status: "ok",
  ...overrides
})

describe("buildPersistedOutputs > image payloads", () => {
  it("persists the real base64 payload when the runner inlined it", () => {
    const out = buildPersistedOutputs(
      summaryWith({ displayData: [{ mime: "image/png", sizeBytes: 24, base64: TINY_PNG_BASE64 }] })
    )
    expect(out).toEqual([
      {
        output_type: "display_data",
        data: { "image/png": TINY_PNG_BASE64 },
        metadata: {}
      }
    ])
  })

  it("keeps the size placeholder when the payload was omitted", () => {
    const out = buildPersistedOutputs(
      summaryWith({
        displayData: [
          { mime: "image/png", sizeBytes: 9_000_000, notice: "omitted: too large" }
        ]
      })
    )
    expect(out).toEqual([
      {
        output_type: "display_data",
        data: { "image/png": "(9000000 bytes, omitted by plugin)" },
        metadata: {}
      }
    ])
  })
})

describe("CellExecutionSummary displayData schema", () => {
  it("accepts optional base64 and notice fields", () => {
    const parsed = RunResponseSchema.safeParse({
      success: false,
      executedCells: [1],
      durationMs: 5,
      outputs: [
        {
          cellIndex: 1,
          status: "error",
          displayData: [
            { mime: "image/png", sizeBytes: 24, base64: TINY_PNG_BASE64 },
            { mime: "image/jpeg", sizeBytes: 8_000_000, notice: "omitted: too large" }
          ],
          errors: [{ ename: "ValueError", evalue: "boom", traceback: ["t"] }]
        }
      ],
      error: {
        kind: "CellExecutionError",
        cellIndex: 1,
        ename: "ValueError",
        evalue: "boom",
        traceback: ["t"]
      }
    })
    expect(parsed.success).toBe(true)
  })

  it("keeps base64 payloads untouched by truncation", () => {
    const summary = summaryWith({
      displayData: [{ mime: "image/png", sizeBytes: 24, base64: TINY_PNG_BASE64 }]
    })
    const out = truncateCellSummary(summary, 10)
    expect(out.displayData?.[0]?.base64).toBe(TINY_PNG_BASE64)
  })
})

const buildNotebook = (): NotebookRaw =>
  NotebookSchema.parse({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" }
    },
    cells: [
      { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: "print('ok')" },
      { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: "raise ValueError('boom')" }
    ]
  }) as NotebookRaw

const failingResponse = (failingSummaryExtra: Record<string, unknown>): RunResponse => ({
  success: false,
  executedCells: [0, 1],
  durationMs: 12,
  outputs: [
    {
      cellIndex: 0,
      status: "ok",
      executionCount: 1,
      stdout: "ok\n"
    },
    {
      cellIndex: 1,
      status: "error",
      executionCount: 2,
      errors: [
        {
          ename: "ValueError",
          evalue: "boom",
          traceback: ["Traceback (most recent call last):", "ValueError: boom"]
        }
      ],
      ...failingSummaryExtra
    }
  ],
  error: {
    kind: "CellExecutionError",
    cellIndex: 1,
    ename: "ValueError",
    evalue: "boom",
    traceback: ["Traceback (most recent call last):", "ValueError: boom"]
  }
})

const kernelReturning = (response: RunResponse): KernelManagerShape => ({
  execute: () => Effect.succeed(response),
  isRunning: () => false,
  list: () => [],
  restart: () => Effect.void,
  shutdown: () => Effect.void,
  disposeAll: () => Effect.void,
  stats: () => ({ liveKernels: 0, totalRequests: 1 })
})

describe("NotebookExecutionService.execute > cell errors are data, not failures", () => {
  const run = async (
    dir: string,
    file: string,
    response: RunResponse,
    save: boolean
  ) => {
    const pythonSvc = {
      probe: () =>
        Effect.succeed({
          pythonPath: "python",
          version: "3.11.0",
          executable: "python",
          from: "path-python" as const
        }),
      candidates: () => Effect.succeed([]),
      checkDependencies: () =>
        Effect.succeed([{ name: "nbclient", available: true, detail: "ok" }]),
      checkImport: (_pythonPath: string, module: string) =>
        Effect.succeed({ name: module, available: true, detail: "ok" }),
      findHelper: () => Effect.succeed(path.join(dir, "ipynb_runner.py")),
      doctor: () =>
        Effect.succeed({
          selected: undefined,
          candidates: [],
          dependencies: [],
          helperPath: undefined,
          preferUv: true,
          suggestions: []
        })
    }
    const exec = makeExecutionImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService(),
      makePermissionService(makeContext(dir)),
      pythonSvc,
      { kernelManager: kernelReturning(response), warmKernel: true, defaultTimeoutMs: 30_000 }
    )
    return Effect.runPromise(
      exec.execute(file, {
        mode: "all",
        cellIndex: undefined,
        start: undefined,
        end: undefined,
        kernel: undefined,
        timeoutMs: 30_000,
        save,
        workingDirectory: undefined,
        maxOutputChars: 4_000
      })
    )
  }

  it("saves the error output built from the summary and reports the failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-err-"))
    const file = path.join(dir, "failing.ipynb")
    fs.writeFileSync(file, JSON.stringify(buildNotebook()))
    try {
      const result = await run(dir, file, failingResponse({}), true)
      expect(result.response.success).toBe(false)
      expect(result.response.error?.cellIndex).toBe(1)
      expect(result.executedCells).toEqual([0, 1])
      expect(result.saved).toBe(true)

      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ execution_count: number | null; outputs: Array<Record<string, unknown>> }>
      }
      const failing = after.cells[1]
      expect(failing?.execution_count).toBe(2)
      expect(failing?.outputs).toEqual([
        {
          output_type: "error",
          ename: "ValueError",
          evalue: "boom",
          traceback: ["Traceback (most recent call last):", "ValueError: boom"]
        }
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("prefers rawOutputs over the synthesized summary when nbclient produced them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-raw-"))
    const file = path.join(dir, "failing.ipynb")
    fs.writeFileSync(file, JSON.stringify(buildNotebook()))
    const rawOutput = {
      output_type: "error",
      ename: "ValueError",
      evalue: "boom",
      traceback: ["raw tb"]
    }
    try {
      const result = await run(dir, file, failingResponse({ rawOutputs: [rawOutput] }), true)
      expect(result.response.success).toBe(false)
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ outputs: Array<Record<string, unknown>> }>
      }
      expect(after.cells[1]?.outputs).toEqual([rawOutput])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not touch the notebook when save=false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-nosave-"))
    const file = path.join(dir, "failing.ipynb")
    const before = JSON.stringify(buildNotebook())
    fs.writeFileSync(file, before)
    try {
      const result = await run(dir, file, failingResponse({}), false)
      expect(result.response.success).toBe(false)
      expect(result.saved).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toBe(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
