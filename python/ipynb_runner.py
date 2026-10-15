"""Real notebook runner for the opencode-ipynb plugin (v0.3 + v0.4 + v1.0).

Reads a JSON request from stdin and writes a JSON response to stdout. Modes:

- ``cell`` / ``range`` / ``all`` / ``from``: execute notebook cells via
  ``nbformat`` + ``nbclient.NotebookClient`` and return a per-cell summary.
- ``env``: read the notebook's kernelspec / language_info, dump the
  current Python interpreter version + executable + platform, and run
  ``pip freeze --local``. Does NOT require nbformat / nbclient.
- ``serve`` (v1.0, warm-kernel mode): enter a long-lived loop. The first
  request carries ``filePath`` (and optional ``kernel`` / ``timeoutMs``);
  subsequent requests are normal ``cell`` / ``all`` / ``range`` / ``from``
  / ``env`` requests. Each request has an integer ``id``; the response
  echoes the same ``id``. The request ``{"id": N, "mode": "shutdown"}``
  triggers a clean kernel teardown and exit 0.

The plugin does NOT install Python dependencies. The wrapper (TypeScript)
verifies the interpreter and the four required deps before spawning this
script for the execution modes; if anything is missing it returns a clear
error without ever calling us. We re-check here defensively so a wrong
venv still produces a structured error instead of a traceback.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import traceback
from typing import Any, Dict, Iterable, List, Optional


PROBE_DEPS = ("nbformat", "nbclient", "jupyter_client", "ipykernel")

# Image payloads are inlined as base64 in the response so the TS side can
# forward them to the model as attachments. Both bounds are per response:
# a single oversized image is omitted, and only the first
# ``MAX_IMAGES_PER_RESPONSE`` images carry their payload.
IMAGE_MIMES = (
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/svg+xml",
    "image/webp",
)
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGES_PER_RESPONSE = 10


def _read_request() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("empty stdin; expected JSON request")
    return json.loads(raw)


def _read_first_request() -> Dict[str, Any]:
    """Read the first line of stdin. Used by the main dispatcher to decide
    between one-shot and serve mode without consuming the rest of stdin.
    """
    line = sys.stdin.readline()
    if not line:
        raise ValueError("empty stdin; expected JSON request")
    line = line.strip()
    if not line:
        raise ValueError("empty first line; expected JSON request")
    return json.loads(line)


def _read_request_line() -> Dict[str, Any]:
    """Read a single JSON line from stdin (used by the serve loop)."""
    line = sys.stdin.readline()
    if not line:
        raise EOFError("stdin closed")
    line = line.strip()
    if not line:
        raise ValueError("empty request line")
    return json.loads(line)


def _write_response(response: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(response))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _read_notebook_raw(file_path: str) -> Dict[str, Any]:
    """Read the notebook JSON without going through nbformat. Used by the
    ``env`` mode which does not need to validate cells or imports.
    """
    with open(file_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError("notebook root must be a JSON object")
    return data


def _run_pip_freeze(python_executable: str, timeout_s: int = 30) -> List[str]:
    """Run ``pip freeze --local`` and return a list of ``package==version`` strings."""
    raw = subprocess.check_output(
        [python_executable, "-m", "pip", "freeze", "--local"],
        stderr=subprocess.PIPE,
        timeout=timeout_s,
    )
    text = raw.decode("utf-8", errors="replace")
    return [line.strip() for line in text.splitlines() if line.strip()]


def _build_env_report(
    file_path: str,
    started: float,
) -> Dict[str, Any]:
    """Build the env report for the ``env`` mode. Returns a response dict
    in the standard shape (may be a success or error response).
    """
    try:
        nb = _read_notebook_raw(file_path)
    except FileNotFoundError as exc:
        return _error_response(
            None,
            started,
            "PythonRunnerError",
            "FileNotFoundError",
            f"Notebook not found: {file_path}",
            -1,
        )
    except json.JSONDecodeError as exc:
        return _error_response(
            None,
            started,
            "PythonRunnerError",
            "JSONDecodeError",
            f"Notebook is not valid JSON ({file_path}): {exc.msg} at line {exc.lineno} col {exc.colno}",
            -1,
        )
    except Exception as exc:
        return _error_response(
            None,
            started,
            "PythonRunnerError",
            type(exc).__name__,
            f"Failed to read notebook {file_path}: {exc}",
            -1,
            traceback.format_exception(exc),
        )

    kernel_display_name: Optional[str] = None
    kernel_name: Optional[str] = None
    language: Optional[str] = None
    metadata = nb.get("metadata") or {}
    if isinstance(metadata, dict):
        ks = metadata.get("kernelspec") or {}
        if isinstance(ks, dict):
            dn = ks.get("display_name")
            if isinstance(dn, str):
                kernel_display_name = dn
            kn = ks.get("name")
            if isinstance(kn, str):
                kernel_name = kn
        li = metadata.get("language_info") or {}
        if isinstance(li, dict):
            ln = li.get("name")
            if isinstance(ln, str):
                language = ln

    python_executable = sys.executable
    try:
        pip_freeze = _run_pip_freeze(python_executable)
    except subprocess.TimeoutExpired as exc:
        return _error_response(
            None,
            started,
            "PythonRunnerError",
            "TimeoutExpired",
            f"`pip freeze --local` timed out after {exc.timeout}s",
            -1,
        )
    except Exception as exc:
        return _error_response(
            None,
            started,
            "PythonRunnerError",
            type(exc).__name__,
            f"Failed to run `pip freeze --local`: {exc}",
            -1,
            traceback.format_exception(exc),
        )

    return {
        "success": True,
        "executedCells": [],
        "durationMs": int((time.time() - started) * 1000),
        "outputs": [],
        "env": {
            "kernelDisplayName": kernel_display_name,
            "kernelName": kernel_name,
            "language": language,
            "pythonVersion": sys.version.split()[0],
            "pythonExecutable": python_executable,
            "platform": sys.platform,
            "pipFreeze": pip_freeze,
        },
    }


def _validate_request(req: Dict[str, Any]) -> None:
    required = {"filePath", "mode"}
    missing = required - req.keys()
    if missing:
        raise ValueError(f"missing required fields: {sorted(missing)}")
    if req["mode"] not in {"cell", "range", "all", "from", "env", "serve"}:
        raise ValueError(f"invalid mode: {req['mode']!r}")


def _select_cell_indexes(req: Dict[str, Any], total: int) -> List[int]:
    """Return the cell indexes (across the WHOLE notebook) the caller wants to run."""
    mode = req["mode"]
    if total <= 0:
        return []
    if mode == "all":
        return list(range(total))
    if mode == "cell":
        idx = req.get("cellIndex")
        if not isinstance(idx, int):
            raise ValueError("mode='cell' requires integer cellIndex")
        if idx < 0 or idx >= total:
            raise ValueError(
                f"cellIndex {idx} out of range (notebook has {total} cells)"
            )
        return [idx]
    if mode == "range":
        start = req.get("start")
        end = req.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            raise ValueError("mode='range' requires integer start and end")
        if start < 0 or end < 0 or start > end:
            raise ValueError(f"invalid range start={start} end={end}")
        return list(range(start, min(end, total - 1) + 1))
    if mode == "from":
        idx = req.get("cellIndex")
        if not isinstance(idx, int):
            raise ValueError("mode='from' requires integer cellIndex")
        if idx < 0 or idx >= total:
            raise ValueError(
                f"cellIndex {idx} out of range (notebook has {total} cells)"
            )
        return list(range(idx, total))
    raise ValueError(f"unsupported mode: {mode!r}")


def _encode_image_value(mime: str, value: str) -> "tuple[Optional[str], int]":
    """Return (base64_payload_or_None, size_in_bytes).

    Jupyter stores PNG/JPEG/GIF/WebP payloads as base64 text and SVG as raw
    XML text. The wire format is always base64, so SVG is encoded here.
    """
    if mime == "image/svg+xml":
        raw = value.encode("utf-8", errors="replace")
        return base64.b64encode(raw).decode("ascii"), len(raw)
    # base64 text: 4 chars -> 3 bytes, minus the padding.
    padding = 2 if value.endswith("==") else (1 if value.endswith("=") else 0)
    return value, max(0, (len(value) * 3) // 4 - padding)


def _summarize_output(
    out: Dict[str, Any], image_state: Optional[Dict[str, int]] = None
) -> Dict[str, Any]:
    """Translate one Jupyter output into the plugin's CellExecutionSummary shape."""
    ot = out.get("output_type")
    summary: Dict[str, Any] = {}
    if ot == "stream":
        name = out.get("name") or "stdout"
        text = out.get("text")
        if isinstance(text, list):
            text = "".join(str(t) for t in text)
        if name == "stderr":
            summary["stderr"] = str(text or "")
        else:
            summary["stdout"] = str(text or "")
        return summary
    if ot == "error":
        ename = str(out.get("ename") or "Error")
        evalue = str(out.get("evalue") or "")
        tb = out.get("traceback")
        if not isinstance(tb, list):
            tb = []
        summary.setdefault("errors", []).append(
            {"ename": ename, "evalue": evalue, "traceback": [str(t) for t in tb]}
        )
        return summary
    if ot in ("execute_result", "display_data"):
        data = out.get("data") or {}
        if isinstance(data, dict):
            if "text/plain" in data:
                plain = data["text/plain"]
                if isinstance(plain, list):
                    plain = "".join(str(t) for t in plain)
                summary["resultPreview"] = str(plain)
            for mime, value in data.items():
                base_mime = str(mime).split(";", 1)[0].strip().lower()
                if base_mime not in IMAGE_MIMES:
                    continue
                entry: Dict[str, Any] = {}
                encoded: Optional[str] = None
                size_bytes = 0
                if isinstance(value, str):
                    encoded, size_bytes = _encode_image_value(base_mime, value)
                entry["mime"] = str(mime)
                entry["sizeBytes"] = size_bytes
                budget = (
                    image_state.get("remaining", 0)
                    if image_state is not None
                    else MAX_IMAGES_PER_RESPONSE
                )
                if encoded is not None and size_bytes > MAX_IMAGE_BYTES:
                    entry["notice"] = (
                        f"omitted: image payload is {size_bytes} bytes, above the "
                        f"{MAX_IMAGE_BYTES}-byte limit"
                    )
                elif encoded is not None and budget <= 0:
                    entry["notice"] = (
                        f"omitted: only the first {MAX_IMAGES_PER_RESPONSE} images "
                        "of a response carry their payload"
                    )
                elif encoded is not None:
                    entry["base64"] = encoded
                    if image_state is not None:
                        image_state["remaining"] = budget - 1
                else:
                    entry["notice"] = "omitted: unsupported image payload type"
                summary.setdefault("displayData", []).append(entry)
    return summary


def _merge_summaries(target: Dict[str, Any], addition: Dict[str, Any]) -> None:
    """Merge a per-output summary into the per-cell accumulator."""
    for key, value in addition.items():
        if key in ("stdout", "stderr", "resultPreview"):
            target[key] = (target.get(key, "") or "") + (value or "")
        elif key == "displayData":
            target.setdefault("displayData", []).extend(value)
        elif key == "errors":
            target.setdefault("errors", []).extend(value)


def _build_cell_summary(
    cell_index: int,
    cell: Dict[str, Any],
    status: str,
    max_output_chars: int,
    duration_ms: int,
    image_state: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "cellIndex": cell_index,
        "status": status,
        "durationMs": duration_ms,
    }
    if "execution_count" in cell:
        ec = cell.get("execution_count")
        if ec is not None:
            summary["executionCount"] = int(ec)
    raw_outputs = list(cell.get("outputs", []) or [])
    if raw_outputs:
        summary["rawOutputs"] = raw_outputs
    for out in raw_outputs:
        addition = _summarize_output(out, image_state)
        _merge_summaries(summary, addition)
    if "errors" in summary and summary["errors"]:
        summary["status"] = "error"
    for key in ("stdout", "stderr", "resultPreview"):
        if key in summary and len(summary[key]) > max_output_chars:
            summary[key] = summary[key][:max_output_chars] + (
                f"\n... (truncated, use maxOutputChars to increase)"
            )
    return summary


def _error_response(
    req: Optional[Dict[str, Any]],
    started: float,
    kind: str,
    ename: str,
    evalue: str,
    cell_index: int,
    traceback_lines: Optional[Iterable[str]] = None,
    request_id: Optional[int] = None,
) -> Dict[str, Any]:
    response: Dict[str, Any] = {
        "success": False,
        "executedCells": [],
        "durationMs": int((time.time() - started) * 1000),
        "saved": False,
        "outputs": [],
        "error": {
            "kind": kind,
            "cellIndex": cell_index,
            "ename": ename,
            "evalue": evalue,
            "traceback": list(traceback_lines or []),
        },
    }
    if request_id is not None:
        response["id"] = request_id
    return response


def _resolve_kernel_name(req: Dict[str, Any], nb: Any) -> Optional[str]:
    kernel = req.get("kernel")
    if kernel:
        return kernel
    if nb is not None and hasattr(nb, "metadata"):
        ks = nb.metadata.get("kernelspec") or {}
        if isinstance(ks, dict):
            kn = ks.get("name")
            if isinstance(kn, str):
                return kn
    return None


def _cell_source(cell: Dict[str, Any]) -> str:
    src = cell.get("source", "")
    if isinstance(src, list):
        src = "".join(src)
    return src if isinstance(src, str) else ""


def _exception_error_entry(exc: BaseException) -> Dict[str, Any]:
    """Build an ``errors[]`` entry from an execution exception.

    nbclient's ``CellExecutionError`` carries the kernel ``ename``/``evalue``
    and a formatted traceback, so we prefer those over the generic
    ``type(exc).__name__`` / ``str(exc)`` fallback.
    """
    ename = getattr(exc, "ename", None)
    if not isinstance(ename, str) or not ename:
        ename = type(exc).__name__
    evalue = getattr(exc, "evalue", None)
    if not isinstance(evalue, str):
        evalue = str(exc)
    tb = getattr(exc, "traceback", None)
    if isinstance(tb, str):
        tb_lines = tb.splitlines()
    elif isinstance(tb, (list, tuple)):
        tb_lines = [str(line) for line in tb]
    else:
        tb_lines = traceback.format_exception(exc)
    return {"ename": ename, "evalue": evalue, "traceback": tb_lines}


def _merge_error_entry(summary: Dict[str, Any], entry: Dict[str, Any]) -> None:
    """Add the exception-derived error to a cell summary, unless the cell's
    own outputs already recorded the same failure (avoid duplicates)."""
    errors = summary.setdefault("errors", [])
    for existing in errors:
        if (
            existing.get("ename") == entry["ename"]
            and existing.get("evalue") == entry["evalue"]
        ):
            summary["status"] = "error"
            return
    errors.append(entry)
    summary["status"] = "error"


def _failing_cell_index(
    exc: BaseException,
    current_index: Optional[int],
    target_code_cells: List[int],
    nb: Any,
) -> int:
    """Best-effort cell index for the exception. ``current_index`` is tracked
    by the execution loop and is the most reliable signal."""
    if isinstance(current_index, int) and current_index in target_code_cells:
        return current_index
    idx = getattr(exc, "cell_index", None)
    if isinstance(idx, int) and idx in target_code_cells:
        return idx
    msg = str(exc)
    for candidate in target_code_cells:
        src = _cell_source(nb.cells[candidate])
        if src and src.strip() in msg:
            return candidate
    return target_code_cells[0] if target_code_cells else -1


def _build_failure_response(
    req: Dict[str, Any],
    started: float,
    exc: BaseException,
    nb: Any,
    executed_code_cells: List[int],
    image_state: Dict[str, int],
    cell_durations_ms: Optional[Dict[int, int]] = None,
    request_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Build the response for a failed cell execution.

    Unlike the previous behaviour (``outputs: []`` + an error envelope), this
    exposes the summaries of every cell executed up to and including the
    failing one, with ``status: "error"`` and a merged ``errors[]`` entry
    built from the exception. That lets the TypeScript side persist the
    failure into the notebook exactly like Jupyter would.
    """
    failure = _exception_error_entry(exc)
    durations = cell_durations_ms or {}
    max_output_chars = int(req.get("maxOutputChars", 12_000))
    failing_index = executed_code_cells[-1] if executed_code_cells else -1
    outputs: List[Dict[str, Any]] = []
    for idx in executed_code_cells:
        summary = _build_cell_summary(
            cell_index=idx,
            cell=nb.cells[idx],
            status="ok",
            max_output_chars=max_output_chars,
            duration_ms=durations.get(idx, 0),
            image_state=image_state,
        )
        if idx == failing_index:
            _merge_error_entry(summary, failure)
        outputs.append(summary)
    response: Dict[str, Any] = {
        "success": False,
        "executedCells": list(executed_code_cells),
        "durationMs": int((time.time() - started) * 1000),
        "saved": False,
        "outputs": outputs,
        "error": {
            "kind": "CellExecutionError",
            "cellIndex": failing_index,
            "ename": failure["ename"],
            "evalue": failure["evalue"],
            "traceback": list(failure["traceback"]),
        },
    }
    if request_id is not None:
        response["id"] = request_id
    return response


def _run_nbclient(
    req: Dict[str, Any],
    nb: Any,
    file_path: str,
    started: float,
) -> Dict[str, Any]:
    """Run the request through nbclient (one-shot / cold path).

    The notebook object is mutated in place (outputs are populated); the
    caller decides whether to save the result.
    """
    from nbclient import NotebookClient  # type: ignore

    try:
        cell_indexes = _select_cell_indexes(req, len(nb.cells))
    except Exception as exc:
        return _error_response(
            req,
            started,
            "PythonRunnerError",
            type(exc).__name__,
            str(exc),
            -1,
        )

    if not cell_indexes:
        return {
            "success": True,
            "executedCells": [],
            "durationMs": int((time.time() - started) * 1000),
            "saved": False,
            "outputs": [],
        }

    target_code_cells: List[int] = []
    for i in cell_indexes:
        if nb.cells[i].get("cell_type") == "code":
            target_code_cells.append(i)

    timeout_s = max(1, int(req.get("timeoutMs", 120_000) / 1000))
    kernel_name = _resolve_kernel_name(req, nb) or "python3"
    max_output_chars = int(req.get("maxOutputChars", 12_000))
    image_state: Dict[str, int] = {"remaining": MAX_IMAGES_PER_RESPONSE}
    executed_code_cells: List[int] = []
    current_index: Optional[int] = None
    try:
        client = NotebookClient(
            nb,
            timeout=timeout_s,
            kernel_name=kernel_name,
            resources={
                "metadata": {"path": os.path.dirname(os.path.abspath(file_path)) or "."}
            },
        )
        # nbclient 0.11's `execute(cells=...)` accidentally leaks the kwarg
        # into the kernel subprocess Popen call. Execute the selected cells
        # explicitly so mode=cell/range/from never runs cells outside the
        # requested slice.
        with client.setup_kernel():
            for idx in target_code_cells:
                current_index = idx
                client.execute_cell(nb.cells[idx], idx)
                executed_code_cells.append(idx)
                current_index = None
    except Exception as exc:
        failing = _failing_cell_index(exc, current_index, target_code_cells, nb)
        if failing in target_code_cells and failing not in executed_code_cells:
            executed_code_cells.append(failing)
        return _build_failure_response(
            req, started, exc, nb, executed_code_cells, image_state
        )

    outputs: List[Dict[str, Any]] = []
    for i in cell_indexes:
        cell = nb.cells[i]
        if cell.get("cell_type") != "code":
            continue
        outputs.append(
            _build_cell_summary(
                cell_index=i,
                cell=cell,
                status="ok",
                max_output_chars=max_output_chars,
                duration_ms=0,
                image_state=image_state,
            )
        )

    return {
        "success": True,
        "executedCells": cell_indexes,
        "durationMs": int((time.time() - started) * 1000),
        "saved": False,
        "outputs": outputs,
    }


def _run_serve_request(
    req: Dict[str, Any],
    client: Any,
    file_path: str,
    warm_kernel_name: Optional[str],
) -> Dict[str, Any]:
    """Process one request inside the serve loop, using the already-warm
    kernel.

    The notebook is re-read from disk on every request so an ``ipynb_edit``
    between two calls is picked up without restarting the kernel. Cell
    execution errors and notebook read errors are returned to the caller as
    structured responses; the kernel is kept alive in both cases.
    """
    started = time.time()
    req_id = req.get("id") if isinstance(req.get("id"), int) else None

    # ``env`` does not need the kernel; handle it before touching nbclient.
    if req.get("mode") == "env":
        response = _build_env_report(req.get("filePath", file_path), started)
        if req_id is not None:
            response["id"] = req_id
        return response

    # Validate the request up front so the caller gets a structured error
    # (not a traceback) on malformed input. The serve loop already knows
    # the filePath (from the init), so we inject it when the request
    # omits it — keep the wire format terse for the hot path.
    if "filePath" not in req and isinstance(file_path, str):
        req["filePath"] = file_path
    try:
        _validate_request(req)
    except Exception as exc:
        return _error_response(
            req,
            started,
            "PythonRunnerError",
            type(exc).__name__,
            str(exc),
            -1,
            request_id=req_id,
        )

    if req["mode"] == "serve":
        return _error_response(
            req,
            started,
            "PythonRunnerError",
            "InvalidRequest",
            "mode='serve' is only valid as the first request of a session",
            -1,
            request_id=req_id,
        )

    # A warm kernel cannot be swapped in the middle of a session; report the
    # mismatch instead of silently running on the wrong kernel.
    requested_kernel = req.get("kernel")
    if (
        isinstance(requested_kernel, str)
        and requested_kernel
        and isinstance(warm_kernel_name, str)
        and warm_kernel_name
        and requested_kernel != warm_kernel_name
    ):
        return _error_response(
            req,
            started,
            "PythonRunnerError",
            "InvalidRequest",
            (
                f"kernel {requested_kernel!r} does not match the warm kernel "
                f"{warm_kernel_name!r}; restart the kernel to switch kernels"
            ),
            -1,
            request_id=req_id,
        )

    # Fresh read on every request: the file may have been edited since the
    # kernel was started. A read/parse failure is reported as a structured
    # error and does NOT kill the warm kernel.
    try:
        import nbformat  # type: ignore

        nb = nbformat.read(req["filePath"], as_version=4)
    except Exception as exc:
        return _error_response(
            req,
            started,
            "PythonRunnerError",
            type(exc).__name__,
            f"Failed to read notebook {req['filePath']}: {exc}",
            -1,
            traceback.format_exception(exc),
            request_id=req_id,
        )

    # Point the client at the freshly read notebook so output handlers
    # (widgets, display updates, coalescing) operate on these cells.
    client.nb = nb

    try:
        cell_indexes = _select_cell_indexes(req, len(nb.cells))
    except Exception as exc:
        return _error_response(
            req,
            started,
            "PythonRunnerError",
            type(exc).__name__,
            str(exc),
            -1,
            request_id=req_id,
        )

    if not cell_indexes:
        response = {
            "success": True,
            "executedCells": [],
            "durationMs": int((time.time() - started) * 1000),
            "outputs": [],
        }
        if req_id is not None:
            response["id"] = req_id
        return response

    target_code_cells: List[int] = []
    for i in cell_indexes:
        if nb.cells[i].get("cell_type") == "code":
            target_code_cells.append(i)

    if not target_code_cells:
        response = {
            "success": True,
            "executedCells": cell_indexes,
            "durationMs": int((time.time() - started) * 1000),
            "outputs": [],
        }
        if req_id is not None:
            response["id"] = req_id
        return response

    max_output_chars = int(req.get("maxOutputChars", 12_000))
    image_state: Dict[str, int] = {"remaining": MAX_IMAGES_PER_RESPONSE}
    # Per-cell durations: capture start/end around each `execute_cell` call so
    # the `cell_duration_ms` field reflects what actually happened, not the
    # batch total attributed to the first cell.
    cell_durations_ms: Dict[int, int] = {}
    executed_code_cells: List[int] = []
    current_index: Optional[int] = None
    try:
        # Run each target cell through the existing kernel via execute_cell.
        # We pass the kernel client explicitly so the kernel stays warm.
        for idx in target_code_cells:
            cell = nb.cells[idx]
            current_index = idx
            cell_start = time.monotonic()
            client.execute_cell(cell, idx)
            cell_durations_ms[idx] = int((time.monotonic() - cell_start) * 1000)
            executed_code_cells.append(idx)
            current_index = None
    except Exception as exc:
        failing = _failing_cell_index(exc, current_index, target_code_cells, nb)
        if failing in target_code_cells and failing not in executed_code_cells:
            executed_code_cells.append(failing)
        return _build_failure_response(
            req,
            started,
            exc,
            nb,
            executed_code_cells,
            image_state,
            cell_durations_ms,
            request_id=req_id,
        )

    outputs: List[Dict[str, Any]] = []
    for i in cell_indexes:
        cell = nb.cells[i]
        if cell.get("cell_type") != "code":
            continue
        outputs.append(
            _build_cell_summary(
                cell_index=i,
                cell=cell,
                status="ok",
                max_output_chars=max_output_chars,
                duration_ms=cell_durations_ms.get(i, 0),
                image_state=image_state,
            )
        )

    response = {
        "success": True,
        "executedCells": cell_indexes,
        "durationMs": int((time.time() - started) * 1000),
        "outputs": outputs,
    }
    if req_id is not None:
        response["id"] = req_id
    return response


def _serve_mode(init_req: Dict[str, Any]) -> int:
    """v1.0 warm-kernel loop. Initializes one kernel and serves NDJSON
    requests until ``{"mode": "shutdown"}`` or EOF on stdin.
    """
    file_path = init_req.get("filePath")
    if not isinstance(file_path, str) or not file_path:
        _write_response(
            _error_response(
                init_req,
                time.time(),
                "PythonRunnerError",
                "InvalidRequest",
                "mode='serve' requires filePath",
                -1,
            )
        )
        return 0

    timeout_s = max(1, int(init_req.get("timeoutMs", 120_000) / 1000))
    kernel_name = init_req.get("kernel")
    if not isinstance(kernel_name, str):
        kernel_name = None

    try:
        import nbformat  # type: ignore
        from nbclient import NotebookClient  # type: ignore
    except ImportError as exc:
        _write_response(
            _error_response(
                init_req,
                time.time(),
                "PythonRunnerError",
                "DependencyError",
                f"Missing Python dependency: {exc.name}",
                -1,
            )
        )
        return 0

    try:
        # Read once at init: the object is used to resolve the kernel name
        # and to construct the client. Every request re-reads the file (see
        # ``_run_serve_request``) so edits are picked up without a restart.
        nb = nbformat.read(file_path, as_version=4)
    except Exception as exc:
        _write_response(
            _error_response(
                init_req,
                time.time(),
                "PythonRunnerError",
                type(exc).__name__,
                f"Failed to read notebook {file_path}: {exc}",
                -1,
                traceback.format_exception(exc),
            )
        )
        return 0

    if kernel_name is None:
        kernel_name = _resolve_kernel_name(init_req, nb) or "python3"

    started = time.time()
    try:
        client = NotebookClient(
            nb,
            timeout=timeout_s,
            kernel_name=kernel_name,
            resources={
                "metadata": {"path": os.path.dirname(os.path.abspath(file_path)) or "."}
            },
            # A timed-out cell must not leave the warm kernel busy forever:
            # interrupt it (SIGINT) and surface a structured CellTimeoutError
            # instead of blocking every following request.
            interrupt_on_timeout=True,
            error_on_timeout={
                "ename": "CellTimeoutError",
                "evalue": f"Cell execution timed out after {timeout_s} seconds",
                "traceback": [],
            },
        )
        # Start the kernel once for the whole serve loop. We deliberately do
        # NOT use ``setup_kernel`` (a context manager) because we want the
        # kernel to outlive the first request — subsequent requests reuse
        # the same kernel client via ``client.execute_cell``.
        client.km = client.create_kernel_manager()
        client.start_new_kernel()
        client.start_new_kernel_client()
    except Exception as exc:
        _write_response(
            _error_response(
                init_req,
                started,
                "PythonRunnerError",
                type(exc).__name__,
                f"Failed to start kernel for {file_path}: {exc}",
                -1,
                traceback.format_exception(exc),
            )
        )
        return 0

    ready_response: Dict[str, Any] = {
        "ready": True,
        "pid": os.getpid(),
        "kernelName": kernel_name,
        "durationMs": int((time.time() - started) * 1000),
    }
    if isinstance(init_req.get("id"), int):
        ready_response["id"] = init_req["id"]
    _write_response(ready_response)

    requests_handled = 0
    try:
        while True:
            try:
                req = _read_request_line()
            except EOFError:
                break
            except ValueError as exc:
                _write_response(
                    _error_response(
                        None,
                        time.time(),
                        "PythonRunnerError",
                        "InvalidJSON",
                        f"could not parse request: {exc}",
                        -1,
                    )
                )
                continue

            if not isinstance(req, dict):
                _write_response(
                    _error_response(
                        None,
                        time.time(),
                        "PythonRunnerError",
                        "InvalidRequest",
                        "request must be a JSON object",
                        -1,
                    )
                )
                continue

            mode = req.get("mode")
            if mode == "shutdown":
                break

            try:
                response = _run_serve_request(req, client, file_path, kernel_name)
            except Exception as exc:
                req_id = req.get("id") if isinstance(req.get("id"), int) else None
                response = _error_response(
                    req,
                    time.time(),
                    "PythonRunnerError",
                    type(exc).__name__,
                    f"unexpected error in serve loop: {exc}",
                    -1,
                    traceback.format_exception(exc),
                    request_id=req_id,
                )

            _write_response(response)
            requests_handled += 1
    except KeyboardInterrupt:
        return 0
    finally:
        try:
            client.shutdown_kernel()
        except Exception:
            pass
        try:
            client.cleanup_kernel()
        except Exception:
            pass
    return 0


def _run() -> int:
    started = time.time()
    try:
        req = _read_first_request()
    except Exception as exc:
        sys.stdout.write(
            json.dumps(
                _error_response(
                    None,
                    started,
                    "PythonRunnerError",
                    type(exc).__name__,
                    str(exc),
                    -1,
                    traceback.format_exception(exc),
                )
            )
        )
        sys.stdout.write("\n")
        return 0

    if isinstance(req, dict) and req.get("mode") == "serve":
        # _serve_mode handles validation itself so it can produce structured
        # errors that include the request id. Any exception falls through to
        # a single error response.
        try:
            return _serve_mode(req)
        except Exception as exc:
            sys.stdout.write(
                json.dumps(
                    _error_response(
                        req,
                        time.time(),
                        "PythonRunnerError",
                        type(exc).__name__,
                        f"failed to start serve mode: {exc}",
                        -1,
                        traceback.format_exception(exc),
                    )
                )
            )
            sys.stdout.write("\n")
            return 0

    try:
        _validate_request(req)
    except Exception as exc:
        sys.stdout.write(
            json.dumps(
                _error_response(
                    req if isinstance(req, dict) else None,
                    started,
                    "PythonRunnerError",
                    type(exc).__name__,
                    str(exc),
                    -1,
                    traceback.format_exception(exc),
                )
            )
        )
        sys.stdout.write("\n")
        return 0

    if req["mode"] == "env":
        try:
            response = _build_env_report(req["filePath"], started)
        except Exception as exc:
            response = _error_response(
                req,
                started,
                "PythonRunnerError",
                type(exc).__name__,
                str(exc),
                -1,
                traceback.format_exception(exc),
            )
        sys.stdout.write(json.dumps(response))
        sys.stdout.write("\n")
        return 0

    try:
        import nbformat  # type: ignore
        from nbclient import NotebookClient  # type: ignore
    except ImportError as exc:
        sys.stdout.write(
            json.dumps(
                _error_response(
                    req,
                    started,
                    "PythonRunnerError",
                    "DependencyError",
                    (
                        f"Missing Python dependency: {exc.name}. Install with "
                        f"`uv pip install nbformat nbclient jupyter_client ipykernel`."
                    ),
                    -1,
                    traceback.format_exception(exc),
                )
            )
        )
        sys.stdout.write("\n")
        return 0

    file_path = req["filePath"]
    try:
        nb = nbformat.read(file_path, as_version=4)
    except Exception as exc:
        sys.stdout.write(
            json.dumps(
                _error_response(
                    req,
                    started,
                    "PythonRunnerError",
                    type(exc).__name__,
                    f"Failed to read notebook {file_path}: {exc}",
                    -1,
                    traceback.format_exception(exc),
                )
            )
        )
        sys.stdout.write("\n")
        return 0

    response = _run_nbclient(req, nb, file_path, started)
    saved = bool(req.get("save", False))
    if saved and response.get("success"):
        try:
            import nbformat  # type: ignore

            nbformat.write(nb, file_path)
            response["saved"] = True
        except Exception as exc:
            sys.stdout.write(
                json.dumps(
                    _error_response(
                        req,
                        started,
                        "PythonRunnerError",
                        type(exc).__name__,
                        f"Failed to save notebook {file_path}: {exc}",
                        -1,
                        traceback.format_exception(exc),
                    )
                )
            )
            sys.stdout.write("\n")
            return 0
    elif saved:
        response["saved"] = False

    sys.stdout.write(json.dumps(response))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(_run())
