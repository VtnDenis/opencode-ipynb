import { Context, Effect } from "effect"
import {
  CellIndexOutOfBoundsError,
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
import { DiffService, type DiffServiceShape } from "./DiffService.js"
import { cellSource, type NotebookRaw } from "../domain/notebook.js"
import type { CellMetadata, CellRaw, CodeCellRaw, MarkdownCellRaw, RawCellRaw } from "../domain/cell.js"
import { firstLine, truncatePreview } from "../utils/truncate.js"
import { unwrapFiberFailure } from "../utils/fiber.js"

export interface EditRequest {
  readonly cellIndex: number
  readonly source: string
  readonly clearOutputs?: "auto" | "always" | "never"
  readonly cellType?: CellType | undefined
  readonly tags?: ReadonlyArray<string> | undefined
}

export interface EditResult {
  readonly displayPath: string
  readonly absPath: string
  readonly cellIndex: number
  readonly cellType: "code" | "markdown" | "raw"
  readonly previousCellType: "code" | "markdown" | "raw"
  readonly converted: boolean
  readonly tags?: ReadonlyArray<string> | undefined
  readonly clearedOutputs: boolean
  readonly diff: string
  readonly oldPreview: string
  readonly newPreview: string
  readonly notebook: NotebookRaw
}

export interface InsertResult {
  readonly displayPath: string
  readonly absPath: string
  readonly cellIndex: number
  readonly cellType: "code" | "markdown" | "raw"
  readonly totalCells: number
  readonly preview: string
}

export interface DeleteResult {
  readonly displayPath: string
  readonly absPath: string
  readonly deletedIndex: number
  readonly deletedType: "code" | "markdown" | "raw"
  readonly deletedPreview: string
  readonly totalCells: number
}

export interface MoveResult {
  readonly displayPath: string
  readonly absPath: string
  readonly fromIndex: number
  readonly toIndex: number
  readonly totalCells: number
}

export type CellType = "code" | "markdown" | "raw"

export type EditCellError =
  | NotebookNotFoundError
  | NotebookParseError
  | NotebookValidationError
  | CellIndexOutOfBoundsError
  | NotebookWriteError
  | PathOutsideWorktreeError
  | PermissionDeniedError

export type InsertCellError = EditCellError
export type DeleteCellError = EditCellError
export type MoveCellError = EditCellError

export interface NotebookEditServiceShape {
  readonly editCell: (
    filePath: string,
    request: EditRequest
  ) => Effect.Effect<
    EditResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
  readonly insertCell: (
    filePath: string,
    cellType: CellType,
    source: string,
    index: number | undefined
  ) => Effect.Effect<
    InsertResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
  readonly deleteCell: (
    filePath: string,
    cellIndex: number
  ) => Effect.Effect<
    DeleteResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
  readonly moveCell: (
    filePath: string,
    fromIndex: number,
    toIndex: number
  ) => Effect.Effect<
    MoveResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
}

export class NotebookEditService extends Context.Tag("@ipynb/NotebookEditService")<
  NotebookEditService,
  NotebookEditServiceShape
>() {}

const buildNewCell = (cellType: CellType, source: string): CellRaw => {
  if (cellType === "code") {
    const cell: CodeCellRaw = {
      cell_type: "code",
      metadata: {},
      execution_count: null,
      source,
      outputs: []
    }
    return cell
  }
  if (cellType === "markdown") {
    const cell: MarkdownCellRaw = {
      cell_type: "markdown",
      metadata: {},
      source
    }
    return cell
  }
  const cell: RawCellRaw = {
    cell_type: "raw",
    metadata: {},
    source
  }
  return cell
}

/**
 * Replace `metadata.tags` when `tags` is provided; an empty array removes the
 * key entirely. Returns the original object otherwise so no-op edits keep the
 * exact same metadata shape.
 */
const applyTags = (
  metadata: CellMetadata,
  tags: ReadonlyArray<string> | undefined
): CellMetadata => {
  if (tags === undefined) {
    return metadata
  }
  const next: CellMetadata = { ...metadata }
  if (tags.length === 0) {
    delete next["tags"]
    return next
  }
  next["tags"] = [...tags]
  return next
}

/**
 * Build a cell of `targetType` keeping the shared nbformat-safe fields (id,
 * metadata, source). Outputs and execution_count cannot survive a type change:
 * code -> markdown/raw drops them, anything -> code starts from the same empty
 * state as a freshly inserted code cell.
 */
const convertCell = (
  cell: CellRaw,
  targetType: CellType,
  source: string,
  metadata: CellMetadata
): CellRaw => {
  const id = cell.id
  const base = {
    metadata,
    source,
    ...(id === undefined ? {} : { id })
  }
  if (targetType === "code") {
    const code: CodeCellRaw = {
      ...base,
      cell_type: "code",
      execution_count: null,
      outputs: []
    }
    return code
  }
  if (targetType === "markdown") {
    const markdown: MarkdownCellRaw = { ...base, cell_type: "markdown" }
    return markdown
  }
  const raw: RawCellRaw = { ...base, cell_type: "raw" }
  return raw
}

const makeEditImpl = (
  pathSvc: PathServiceShape,
  fileSvc: NotebookFileServiceShape,
  diffSvc: DiffServiceShape,
  permSvc: PermissionServiceShape
): NotebookEditServiceShape => {
  const editCell = (
    filePath: string,
    request: EditRequest
  ): Effect.Effect<
    EditResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  > =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      return yield* fileSvc
        .withFileLock(
          abs,
          Effect.gen(function* () {
            const notebook = yield* fileSvc.read(abs)
            const idx = request.cellIndex
            if (idx < 0 || idx >= notebook.cells.length) {
              return yield* new CellIndexOutOfBoundsError({
                message: `requested cell ${idx} but notebook has ${notebook.cells.length} cells`,
                filePath: abs,
                cellIndex: idx,
                total: notebook.cells.length
              })
            }
            const cell = notebook.cells[idx] as CellRaw
            const oldSource = cellSource(cell)
            const newSource = request.source
            const diff = diffSvc.cellDiff(oldSource, newSource)
            const oldPreview = truncatePreview(oldSource, 400)
            const newPreview = truncatePreview(newSource, 400)
            const targetType = request.cellType ?? cell.cell_type
            const converted = targetType !== cell.cell_type
            const mode = request.clearOutputs ?? "auto"
            const clearedByMode =
              mode === "always" ||
              (mode === "auto" && cell.cell_type === "code" && oldSource !== newSource)
            // Converting a code cell drops its outputs/execution_count whatever
            // clearOutputs says; the result reports whether anything was
            // actually discarded.
            const hadOutputs =
              cell.cell_type === "code" &&
              (cell.outputs.length > 0 || cell.execution_count !== null)
            const clearedOutputs = clearedByMode || (converted && hadOutputs)

            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_edit",
              patterns: [abs],
              always: [abs],
              metadata: {
                filePath: abs,
                cellIndex: idx,
                cellType: cell.cell_type,
                targetCellType: targetType,
                converted,
                tags: request.tags,
                oldPreview,
                newPreview,
                diff
              }
            })

            const metadata = applyTags(cell.metadata, request.tags)
            const newCell: CellRaw = converted
              ? convertCell(cell, targetType, newSource, metadata)
              : (() => {
                  if (cell.cell_type === "code") {
                    const code = cell as CodeCellRaw
                    if (clearedOutputs) {
                      return {
                        ...code,
                        source: newSource,
                        metadata,
                        outputs: [],
                        execution_count: null
                      }
                    }
                    return { ...code, source: newSource, metadata }
                  }
                  if (cell.cell_type === "markdown") {
                    const md = cell as MarkdownCellRaw
                    return { ...md, source: newSource, metadata }
                  }
                  const raw = cell as RawCellRaw
                  return { ...raw, source: newSource, metadata }
                })()

            const cells = notebook.cells.slice()
            cells[idx] = newCell
            const newNotebook: NotebookRaw = { ...notebook, cells }

            yield* fileSvc.writeAtomic(abs, newNotebook)

            const displayPath = pathSvc.toDisplay(abs)
            return {
              displayPath,
              absPath: abs,
              cellIndex: idx,
              cellType: targetType,
              previousCellType: cell.cell_type,
              converted,
              tags: request.tags === undefined ? undefined : [...request.tags],
              clearedOutputs,
              diff,
              oldPreview,
              newPreview,
              notebook: newNotebook
            }
          })
        )
        .pipe(
          Effect.mapError(unwrapFiberFailure<EditCellError>)
        )
    })

  const insertCell = (
    filePath: string,
    cellType: CellType,
    source: string,
    index: number | undefined
  ): Effect.Effect<
    InsertResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  > =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      return yield* fileSvc
        .withFileLock(
          abs,
          Effect.gen(function* () {
            const notebook = yield* fileSvc.read(abs)
            const total = notebook.cells.length

            if (index !== undefined && index < 0) {
              return yield* new CellIndexOutOfBoundsError({
                message: `requested cell index ${index} but it must be non-negative`,
                filePath: abs,
                cellIndex: index,
                total
              })
            }

            const targetIdx = index === undefined || index >= total ? total : index
            const newCell = buildNewCell(cellType, source)
            const preview = firstLine(source)

            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_cell_insert",
              patterns: [abs],
              always: [abs],
              metadata: {
                filePath: abs,
                cellType,
                requestedIndex: index,
                cellIndex: targetIdx,
                totalCells: total + 1,
                preview
              }
            })

            const cells = notebook.cells.slice()
            cells.splice(targetIdx, 0, newCell)
            const newNotebook: NotebookRaw = { ...notebook, cells }

            yield* fileSvc.writeAtomic(abs, newNotebook)

            const displayPath = pathSvc.toDisplay(abs)
            return {
              displayPath,
              absPath: abs,
              cellIndex: targetIdx,
              cellType,
              totalCells: total + 1,
              preview
            }
          })
        )
        .pipe(
          Effect.mapError(unwrapFiberFailure<InsertCellError>)
        )
    })

  const deleteCell = (
    filePath: string,
    cellIndex: number
  ): Effect.Effect<
    DeleteResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  > =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      return yield* fileSvc
        .withFileLock(
          abs,
          Effect.gen(function* () {
            const notebook = yield* fileSvc.read(abs)
            const total = notebook.cells.length

            if (cellIndex < 0 || cellIndex >= total) {
              return yield* new CellIndexOutOfBoundsError({
                message: `requested cell ${cellIndex} but notebook has ${total} cells`,
                filePath: abs,
                cellIndex,
                total
              })
            }

            const cell = notebook.cells[cellIndex] as CellRaw
            const cellType = cell.cell_type
            const deletedPreview = truncatePreview(cellSource(cell), 80)

            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_cell_delete",
              patterns: [abs],
              always: [abs],
              metadata: {
                filePath: abs,
                cellIndex,
                cellType,
                deletedPreview,
                totalCells: total - 1
              }
            })

            const cells = notebook.cells.slice()
            cells.splice(cellIndex, 1)
            const newNotebook: NotebookRaw = { ...notebook, cells }

            yield* fileSvc.writeAtomic(abs, newNotebook)

            const displayPath = pathSvc.toDisplay(abs)
            return {
              displayPath,
              absPath: abs,
              deletedIndex: cellIndex,
              deletedType: cellType,
              deletedPreview,
              totalCells: total - 1
            }
          })
        )
        .pipe(
          Effect.mapError(unwrapFiberFailure<DeleteCellError>)
        )
    })

  const moveCell = (
    filePath: string,
    fromIndex: number,
    toIndex: number
  ): Effect.Effect<
    MoveResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  > =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      return yield* fileSvc
        .withFileLock(
          abs,
          Effect.gen(function* () {
            const notebook = yield* fileSvc.read(abs)
            const total = notebook.cells.length

            if (fromIndex < 0 || fromIndex >= total) {
              return yield* new CellIndexOutOfBoundsError({
                message: `requested fromIndex ${fromIndex} but notebook has ${total} cells`,
                filePath: abs,
                cellIndex: fromIndex,
                total
              })
            }

            if (toIndex < 0) {
              return yield* new CellIndexOutOfBoundsError({
                message: `requested toIndex ${toIndex} but it must be non-negative`,
                filePath: abs,
                cellIndex: toIndex,
                total
              })
            }

            const clampedTo = Math.min(toIndex, total - 1)
            const displayPath = pathSvc.toDisplay(abs)

            if (fromIndex === clampedTo) {
              return {
                displayPath,
                absPath: abs,
                fromIndex,
                toIndex: clampedTo,
                totalCells: total
              }
            }

            const cell = notebook.cells[fromIndex] as CellRaw

            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_cell_move",
              patterns: [abs],
              always: [abs],
              metadata: {
                filePath: abs,
                fromIndex,
                toIndex: clampedTo,
                totalCells: total
              }
            })

            const cells = notebook.cells.slice()
            cells.splice(fromIndex, 1)
            cells.splice(clampedTo, 0, cell)
            const newNotebook: NotebookRaw = { ...notebook, cells }

            yield* fileSvc.writeAtomic(abs, newNotebook)

            return {
              displayPath,
              absPath: abs,
              fromIndex,
              toIndex: clampedTo,
              totalCells: total
            }
          })
        )
        .pipe(
          Effect.mapError(unwrapFiberFailure<MoveCellError>)
        )
    })

  return { editCell, insertCell, deleteCell, moveCell }
}

export { makeEditImpl }
