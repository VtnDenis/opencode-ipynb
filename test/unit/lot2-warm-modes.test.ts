import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { NotebookSchema } from "../../src/domain/notebook.js"
import type { NotebookRaw } from "../../src/domain/notebook.js"
import { makeExecutionImpl } from "../../src/services/NotebookExecutionService.js"
import type { ExecutionRequest, ExecutionMode } from "../../src/services/NotebookExecutionService.js"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import type {
  KernelExecuteOptions,
  KernelManagerShape,
  PythonServiceShape
} from "../../src/services/PythonService.js"
import type { RunRequest, RunResponse } from "../../src/domain/execution.js"

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

const buildNotebook = (): NotebookRaw =>
  NotebookSchema.parse({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" }
    },
    cells: [
      { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: "x = 1" },
      { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: "x + 1" }
    ]
  }) as NotebookRaw

const fakePython = (helperPath: string): PythonServiceShape => ({
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
  checkImport: (_pythonPath, module) =>
    Effect.succeed({ name: module, available: true, detail: "ok" }),
  findHelper: () => Effect.succeed(helperPath),
  doctor: () =>
    Effect.succeed({
      selected: undefined,
      candidates: [],
      dependencies: [],
      helperPath: undefined,
      preferUv: true,
      suggestions: []
    })
})

interface KernelCall {
  readonly filePath: string
  readonly request: RunRequest
  readonly options: KernelExecuteOptions | undefined
}

const fakeKernel = (): { manager: KernelManagerShape; calls: KernelCall[]; restarts: string[] } => {
  const calls: KernelCall[] = []
  const restarts: string[] = []
  const manager: KernelManagerShape = {
    execute: (filePath, request, _runtime, options) => {
      calls.push({ filePath, request, options })
      const cellIndex = request.cellIndex ?? 0
      const response: RunResponse = {
        success: true,
        executedCells: [cellIndex],
        durationMs: 4,
        outputs: [{ cellIndex, status: "ok", stdout: "warm-fake-kernel\n" }]
      }
      return Effect.succeed(response)
    },
    isRunning: () => true,
    list: () => [],
    restart: (filePath) => {
      restarts.push(filePath)
      return Effect.void
    },
    shutdown: () => Effect.void,
    disposeAll: () => Effect.void,
    stats: () => ({ liveKernels: 1, totalRequests: 1 })
  }
  return { manager, calls, restarts }
}

const requestFor = (mode: ExecutionMode, cellIndex?: number): ExecutionRequest => ({
  mode,
  cellIndex,
  start: mode === "range" ? 0 : undefined,
  end: mode === "range" ? 1 : undefined,
  kernel: undefined,
  timeoutMs: 30_000,
  save: false,
  workingDirectory: undefined,
  maxOutputChars: 4_000
})

describe("NotebookExecutionService > warm kernel covers every execution mode", () => {
  it("routes cell/range/all/from through the warm kernel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-warm-"))
    const file = path.join(dir, "tiny.ipynb")
    fs.writeFileSync(file, JSON.stringify(buildNotebook()))
    const { manager, calls } = fakeKernel()
    try {
      const exec = makeExecutionImpl(
        makePathService({ directory: dir, worktree: dir, platform: process.platform }),
        makeNotebookFileService(),
        makePermissionService(makeContext(dir)),
        fakePython(path.join(dir, "ipynb_runner.py")),
        { kernelManager: manager, warmKernel: true, defaultTimeoutMs: 30_000 }
      )
      for (const [mode, cellIndex] of [
        ["cell", 0],
        ["range", undefined],
        ["all", undefined],
        ["from", 0]
      ] as ReadonlyArray<[ExecutionMode, number | undefined]>) {
        const result = await Effect.runPromise(exec.execute(file, requestFor(mode, cellIndex)))
        expect(result.response.success).toBe(true)
        expect(result.response.outputs[0]?.stdout).toBe("warm-fake-kernel\n")
      }
      expect(calls.map((c) => c.request.mode)).toEqual(["cell", "range", "all", "from"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("forwards the session abort signal to the kernel manager", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-warm-abort-"))
    const file = path.join(dir, "tiny.ipynb")
    fs.writeFileSync(file, JSON.stringify(buildNotebook()))
    const { manager, calls } = fakeKernel()
    const controller = new AbortController()
    try {
      const exec = makeExecutionImpl(
        makePathService({ directory: dir, worktree: dir, platform: process.platform }),
        makeNotebookFileService(),
        makePermissionService(makeContext(dir)),
        fakePython(path.join(dir, "ipynb_runner.py")),
        { kernelManager: manager, warmKernel: true, defaultTimeoutMs: 30_000 }
      )
      await Effect.runPromise(
        exec.execute(file, { ...requestFor("range"), abortSignal: controller.signal })
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]?.options?.abortSignal).toBe(controller.signal)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("restarts the warm kernel before executing when restart=true", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-restart-"))
    const file = path.join(dir, "tiny.ipynb")
    fs.writeFileSync(file, JSON.stringify(buildNotebook()))
    const { manager, calls, restarts } = fakeKernel()
    try {
      const exec = makeExecutionImpl(
        makePathService({ directory: dir, worktree: dir, platform: process.platform }),
        makeNotebookFileService(),
        makePermissionService(makeContext(dir)),
        fakePython(path.join(dir, "ipynb_runner.py")),
        { kernelManager: manager, warmKernel: true, defaultTimeoutMs: 30_000 }
      )
      await Effect.runPromise(exec.execute(file, { ...requestFor("cell", 0), restart: true }))
      expect(restarts).toEqual([file])
      expect(calls).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not restart the kernel when restart is omitted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-norestart-"))
    const file = path.join(dir, "tiny.ipynb")
    fs.writeFileSync(file, JSON.stringify(buildNotebook()))
    const { manager, calls, restarts } = fakeKernel()
    try {
      const exec = makeExecutionImpl(
        makePathService({ directory: dir, worktree: dir, platform: process.platform }),
        makeNotebookFileService(),
        makePermissionService(makeContext(dir)),
        fakePython(path.join(dir, "ipynb_runner.py")),
        { kernelManager: manager, warmKernel: true, defaultTimeoutMs: 30_000 }
      )
      await Effect.runPromise(exec.execute(file, requestFor("cell", 0)))
      expect(restarts).toEqual([])
      expect(calls).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not touch the kernel when warmKernel is disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-cold-"))
    const file = path.join(dir, "tiny.ipynb")
    fs.writeFileSync(file, JSON.stringify(buildNotebook()))
    const { manager, calls } = fakeKernel()
    try {
      const exec = makeExecutionImpl(
        makePathService({ directory: dir, worktree: dir, platform: process.platform }),
        makeNotebookFileService(),
        makePermissionService(makeContext(dir)),
        fakePython(path.join(dir, "ipynb_runner.py")),
        { kernelManager: manager, warmKernel: false, defaultTimeoutMs: 30_000 }
      )
      // The one-shot helper path cannot be exercised without a real Python
      // runtime; the point here is that the warm kernel is NOT used, so the
      // call fails on the bogus helper path instead of silently going warm.
      const exit = await Effect.runPromiseExit(exec.execute(file, requestFor("range")))
      expect(exit._tag).toBe("Failure")
      expect(calls).toHaveLength(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
