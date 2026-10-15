import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { pythonHas } from "../helpers.js"
import {
  makeKernelManager,
  makePythonService,
  type PythonServiceShape
} from "../../src/services/PythonService.js"
import { makeExecutionImpl } from "../../src/services/NotebookExecutionService.js"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import type { RunRequest, RunResponse } from "../../src/domain/execution.js"

const HELPER = path.resolve("python", "ipynb_runner.py")
const READY = pythonHas("nbformat") && pythonHas("nbclient") && pythonHas("ipykernel")
const describeIf = (cond: boolean, name: string, fn: () => void): void => {
  if (cond) describe(name, fn)
  else describe.skip(name, fn)
}

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

const makeManager = (dir: string) =>
  makeKernelManager({
    pythonPath: "python",
    helperPath: HELPER,
    workingDirectory: dir,
    defaultTimeoutMs: 60_000
  })

const writeNotebook = (file: string, cells: ReadonlyArray<string>): void => {
  fs.writeFileSync(
    file,
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
        language_info: { name: "python" }
      },
      cells: cells.map((source, i) => ({
        cell_type: "code",
        id: `cell-${i}`,
        metadata: {},
        execution_count: null,
        outputs: [],
        source
      }))
    })
  )
}

const request = (file: string, overrides: Partial<RunRequest> = {}): RunRequest => ({
  filePath: file,
  mode: "all",
  timeoutMs: 60_000,
  save: false,
  maxOutputChars: 4_000,
  ...overrides
})

const stdoutOf = (response: RunResponse, cellIndex: number): string =>
  response.outputs.find((o) => o.cellIndex === cellIndex)?.stdout ?? ""

const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  return predicate()
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describeIf(READY, "lot2 > warm serve loop", () => {
  it("re-reads the notebook from disk (fresh source) while keeping the kernel state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-serve-"))
    const file = path.join(dir, "fresh.ipynb")
    const mgr = makeManager(dir)
    try {
      writeNotebook(file, ["STAMP = 'v1'\nprint('cell0 defines', STAMP)", "print('cell1 sees', STAMP)"])
      const r1 = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0 }))
      )
      expect(r1.success).toBe(true)
      expect(stdoutOf(r1, 0)).toContain("cell0 defines v1")
      const pid = mgr.list()[0]?.pid ?? -1
      expect(pid).toBeGreaterThan(0)

      // Edit the file on disk: cell 0 now defines STAMP='v2'.
      writeNotebook(file, ["STAMP = 'v2'\nprint('cell0 defines', STAMP)", "print('cell1 sees', STAMP)"])

      // Warm state survives: cell 1 still sees the value defined by the
      // first request (v1) because the kernel was not restarted.
      const r2 = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 1 }))
      )
      expect(stdoutOf(r2, 1)).toContain("cell1 sees v1")

      // Fresh source wins: re-running cell 0 executes the NEW source.
      const r3 = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0 }))
      )
      expect(stdoutOf(r3, 0)).toContain("cell0 defines v2")

      // `from` and `range` now share that warm kernel too.
      const r4 = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "from", cellIndex: 0 }))
      )
      expect(r4.success).toBe(true)
      expect(r4.executedCells).toEqual([0, 1])
      expect(stdoutOf(r4, 0)).toContain("cell0 defines v2")
      expect(stdoutOf(r4, 1)).toContain("cell1 sees v2")

      const r5 = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "range", start: 0, end: 1 }))
      )
      expect(r5.success).toBe(true)
      expect(r5.executedCells).toEqual([0, 1])

      // Same helper process for every request.
      expect(mgr.list()[0]?.pid).toBe(pid)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it("returns cell errors with outputs and keeps the kernel alive", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-serve-err-"))
    const file = path.join(dir, "failing.ipynb")
    const mgr = makeManager(dir)
    try {
      writeNotebook(file, ["x = 1\nprint('ok')", "raise ValueError('served boom')"])
      const r1 = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "all" }))
      )
      expect(r1.success).toBe(false)
      expect(r1.executedCells).toEqual([0, 1])
      expect(r1.error?.cellIndex).toBe(1)
      expect(r1.error?.ename).toBe("ValueError")
      const failing = r1.outputs.find((o) => o.cellIndex === 1)
      expect(failing?.status).toBe("error")
      expect(failing?.errors?.[0]?.ename).toBe("ValueError")
      expect(failing?.errors?.[0]?.evalue).toContain("served boom")
      expect((failing?.errors?.[0]?.traceback.length ?? 0)).toBeGreaterThan(0)

      // The kernel survived the cell error.
      expect(mgr.isRunning(file)).toBe(true)
      const r2 = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0 }))
      )
      expect(r2.success).toBe(true)
      expect(stdoutOf(r2, 0)).toContain("ok")
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it("reports notebook read errors without killing the kernel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-serve-read-"))
    const file = path.join(dir, "broken.ipynb")
    const mgr = makeManager(dir)
    try {
      writeNotebook(file, ["print('before')"])
      const ok = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0 }))
      )
      expect(ok.success).toBe(true)

      // Corrupt the notebook on disk, then run again.
      fs.writeFileSync(file, "{not json")
      const broken = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0 }))
      )
      expect(broken.success).toBe(false)
      expect(broken.error?.evalue ?? "").toContain("Failed to read notebook")
      expect(mgr.isRunning(file)).toBe(true)

      // Restore the file: the warm kernel still works.
      writeNotebook(file, ["print('after')"])
      const after = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0 }))
      )
      expect(after.success).toBe(true)
      expect(stdoutOf(after, 0)).toContain("after")
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it("rejects a kernel switch mid-session instead of silently using the warm one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-serve-kernel-"))
    const file = path.join(dir, "k.ipynb")
    const mgr = makeManager(dir)
    try {
      writeNotebook(file, ["print('hi')"])
      await Effect.runPromise(mgr.execute(file, request(file, { mode: "cell", cellIndex: 0 })))
      const other = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0, kernel: "bash" }))
      )
      expect(other.success).toBe(false)
      expect(other.error?.evalue ?? "").toContain("does not match the warm kernel")
      expect(mgr.isRunning(file)).toBe(true)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it("returns cell timeouts as data and keeps the kernel usable (no cascade)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-warm-celltimeout-"))
    const file = path.join(dir, "slow.ipynb")
    const mgr = makeManager(dir)
    try {
      writeNotebook(file, ["import time\ntime.sleep(30)\nprint('never')"])
      // nbclient's per-cell timeout is max(1, floor(timeoutMs/1000)) seconds,
      // so the helper (not the TS watchdog) reports the timeout here.
      const r1 = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0, timeoutMs: 1_500 }))
      )
      expect(r1.success).toBe(false)
      expect(r1.error?.ename).toBe("CellTimeoutError")
      const failing = r1.outputs.find((o) => o.cellIndex === 0)
      expect(failing?.status).toBe("error")
      expect((failing?.errors ?? []).length).toBeGreaterThan(0)

      // The kernel was interrupted (SIGINT), not left executing the sleep:
      // the next run must answer instead of queueing behind it.
      expect(mgr.isRunning(file)).toBe(true)
      writeNotebook(file, ["print('kernel is usable')"])
      const r2 = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0 }))
      )
      expect(r2.success).toBe(true)
      expect(stdoutOf(r2, 0)).toContain("kernel is usable")
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it("kills the unresponsive kernel on watchdog timeout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-warm-watchdog-"))
    const file = path.join(dir, "slow.ipynb")
    const fakeHelper = path.join(dir, "fake_helper.py")
    const helperPidFile = path.join(dir, "helper.pid")
    // Handshake once, then never answer: the only way out is the TS watchdog.
    fs.writeFileSync(
      fakeHelper,
      [
        "import json, os, sys, time",
        "sys.stdin.readline()",
        'sys.stdout.write(json.dumps({"ready": True, "pid": os.getpid()}) + "\\n")',
        "sys.stdout.flush()",
        'with open(os.environ["IPYNB_TEST_HELPER_PID_FILE"], "w") as fh:',
        "    fh.write(str(os.getpid()))",
        "time.sleep(300)"
      ].join("\n")
    )
    process.env.IPYNB_TEST_HELPER_PID_FILE = helperPidFile
    writeNotebook(file, ["print('x')"])
    const mgr = makeKernelManager({
      pythonPath: "python",
      helperPath: fakeHelper,
      workingDirectory: dir,
      defaultTimeoutMs: 60_000
    })
    try {
      const exit = await Effect.runPromiseExit(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0, timeoutMs: 1_200 }))
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const cause = exit.cause
        expect(cause._tag).toBe("Fail")
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string; message?: string }
          expect(err._tag).toBe("PythonRunner")
          expect(err.message ?? "").toContain("timed out")
        }
      }
      // The kernel was removed from the manager...
      expect(mgr.isRunning(file)).toBe(false)
      // ...and the helper process is actually gone (SIGTERM after shutdown).
      const pidReady = await waitUntil(() => {
        try {
          return fs.readFileSync(helperPidFile, "utf8").trim().length > 0
        } catch {
          return false
        }
      }, 5_000)
      expect(pidReady).toBe(true)
      const helperPid = Number.parseInt(fs.readFileSync(helperPidFile, "utf8").trim(), 10)
      const dead = await waitUntil(() => !isAlive(helperPid), 8_000)
      expect(dead).toBe(true)
    } finally {
      delete process.env.IPYNB_TEST_HELPER_PID_FILE
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it("kills the busy kernel on abort so the next run starts clean", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-warm-abort-"))
    const file = path.join(dir, "slow.ipynb")
    const mgr = makeManager(dir)
    const controller = new AbortController()
    try {
      writeNotebook(file, ["import time\ntime.sleep(30)\nprint('never')"])
      setTimeout(() => controller.abort(), 1_200)
      const exit = await Effect.runPromiseExit(
        mgr.execute(
          file,
          request(file, { mode: "cell", cellIndex: 0 }),
          undefined,
          { abortSignal: controller.signal }
        )
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const cause = exit.cause
        expect(cause._tag).toBe("Fail")
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string; message?: string }
          expect(err._tag).toBe("PythonRunner")
          expect(err.message ?? "").toContain("aborted")
        }
      }
      expect(mgr.isRunning(file)).toBe(false)
      writeNotebook(file, ["print('after abort')"])
      const r2 = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0 }))
      )
      expect(r2.success).toBe(true)
      expect(stdoutOf(r2, 0)).toContain("after abort")
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it("bounds image payloads per response (10 images max, 5 MB each)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-images-"))
    const file = path.join(dir, "images.ipynb")
    const mgr = makeManager(dir)
    const png1x1 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    try {
      writeNotebook(file, [
        `import base64\nfrom IPython.display import Image, display\nPNG = base64.b64decode('${png1x1}')\nfor _ in range(12):\n    display(Image(data=PNG, format='png'))`,
        `from IPython.display import SVG, display\ndisplay(SVG("<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>"))`,
        `from IPython.display import SVG, display\ndisplay(SVG('<svg xmlns="http://www.w3.org/2000/svg">' + 'x' * 6000000 + '</svg>'))`
      ])

      const many = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 0 }))
      )
      const display = many.outputs[0]?.displayData ?? []
      expect(display.length).toBe(12)
      const withPayload = display.filter((d) => d.base64 !== undefined)
      expect(withPayload.length).toBe(10)
      const omitted = display.filter((d) => d.base64 === undefined)
      expect(omitted.length).toBe(2)
      for (const d of omitted) {
        expect(d.notice ?? "").toContain("first 10 images")
      }
      expect(withPayload[0]?.base64).toBe(png1x1)

      // (per-response budget resets between requests)
      const svg = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 1 }))
      )
      const svgDisplay = svg.outputs[0]?.displayData ?? []
      expect(svgDisplay[0]?.mime).toBe("image/svg+xml")
      expect(svgDisplay[0]?.base64).toBeDefined()
      const decoded = Buffer.from(svgDisplay[0]?.base64 ?? "", "base64").toString("utf8")
      expect(decoded).toContain("<svg")

      const huge = await Effect.runPromise(
        mgr.execute(file, request(file, { mode: "cell", cellIndex: 2 }))
      )
      const hugeDisplay = huge.outputs[0]?.displayData ?? []
      expect(hugeDisplay[0]?.base64).toBeUndefined()
      expect(hugeDisplay[0]?.notice ?? "").toContain("above the")
      expect(hugeDisplay[0]?.sizeBytes ?? 0).toBeGreaterThan(5 * 1024 * 1024)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})

describeIf(READY, "lot2 > cold one-shot timeout/abort", () => {
  const buildColdExec = (dir: string, fakeHelper: string) => {
    const pythonSvc: PythonServiceShape = {
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
      findHelper: () => Effect.succeed(fakeHelper),
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
    return makeExecutionImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService(),
      makePermissionService(makeContext(dir)),
      pythonSvc,
      { kernelManager: undefined as never, warmKernel: false, defaultTimeoutMs: 60_000 }
    )
  }

  // The fake helper spawns a grandchild and sleeps forever: the watchdog must
  // kill the WHOLE process group (detached spawn), not only the helper.
  const FAKE_HELPER_SOURCE = `
import os, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
with open(os.environ["IPYNB_TEST_CHILD_PID_FILE"], "w") as fh:
    fh.write(str(child.pid))
sys.stdout.write("helper started")
sys.stdout.flush()
time.sleep(120)
`

  const runFakeHelper = async (
    dir: string,
    fakeHelper: string,
    overrides: { timeoutMs: number; abortSignal?: AbortSignal }
  ) => {
    const file = path.join(dir, "nb.ipynb")
    writeNotebook(file, ["print('x')"])
    const exec = buildColdExec(dir, fakeHelper)
    return Effect.runPromiseExit(
      exec.execute(file, {
        mode: "cell",
        cellIndex: 0,
        start: undefined,
        end: undefined,
        kernel: undefined,
        timeoutMs: overrides.timeoutMs,
        save: false,
        workingDirectory: undefined,
        maxOutputChars: 4_000,
        ...(overrides.abortSignal === undefined ? {} : { abortSignal: overrides.abortSignal })
      })
    )
  }

  const expectChildKilled = async (pidFile: string): Promise<void> => {
    const hasPid = await waitUntil(() => {
      try {
        return fs.readFileSync(pidFile, "utf8").trim().length > 0
      } catch {
        return false
      }
    }, 5_000)
    expect(hasPid).toBe(true)
    const childPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)
    expect(childPid).toBeGreaterThan(0)
    const dead = await waitUntil(() => !isAlive(childPid), 5_000)
    expect(dead).toBe(true)
  }

  it("kills the helper process group on timeout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-cold-timeout-"))
    const fakeHelper = path.join(dir, "fake_helper.py")
    const pidFile = path.join(dir, "child.pid")
    fs.writeFileSync(fakeHelper, FAKE_HELPER_SOURCE)
    process.env.IPYNB_TEST_CHILD_PID_FILE = pidFile
    try {
      const exit = await runFakeHelper(dir, fakeHelper, { timeoutMs: 800 })
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const cause = exit.cause
        expect(cause._tag).toBe("Fail")
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string; message?: string }
          expect(err._tag).toBe("PythonRunner")
          expect(err.message ?? "").toContain("timed out")
        }
      }
      await expectChildKilled(pidFile)
    } finally {
      delete process.env.IPYNB_TEST_CHILD_PID_FILE
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("kills the helper process group on abort", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lot2-cold-abort-"))
    const fakeHelper = path.join(dir, "fake_helper.py")
    const pidFile = path.join(dir, "child.pid")
    fs.writeFileSync(fakeHelper, FAKE_HELPER_SOURCE)
    process.env.IPYNB_TEST_CHILD_PID_FILE = pidFile
    const controller = new AbortController()
    try {
      setTimeout(() => controller.abort(), 500)
      const exit = await runFakeHelper(dir, fakeHelper, {
        timeoutMs: 30_000,
        abortSignal: controller.signal
      })
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const cause = exit.cause
        expect(cause._tag).toBe("Fail")
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string; message?: string }
          expect(err._tag).toBe("PythonRunner")
          expect(err.message ?? "").toContain("aborted")
        }
      }
      await expectChildKilled(pidFile)
    } finally {
      delete process.env.IPYNB_TEST_CHILD_PID_FILE
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
