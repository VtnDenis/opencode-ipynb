import { fileURLToPath } from "node:url"
import * as path from "node:path"

// Embedded skill registered in plugin.ts: teaches agents to use the ipynb_*
// tools instead of raw read/edit/shell on notebook JSON. SKILL.md at the
// plugin root carries the same content for humans / file-based skill setups.
const here = path.dirname(fileURLToPath(import.meta.url))
const skillPath = path.resolve(here, "..", "SKILL.md")

const content = `# Jupyter notebooks (.ipynb)

Always use the \`ipynb_*\` tools to read, edit, and run \`.ipynb\` files. Never use the built-in \`read\`, \`edit\`, \`write\`, \`patch\`, \`grep\`, or shell commands (\`cat\`, \`sed\`, ...) on notebook JSON: it is large, noisy, and a hand edit can corrupt the file.

## Workflow

1. \`ipynb_inspect\` first: kernel, cell table (first line of each cell), output/error stats.
2. \`ipynb_read\` for the cells you need; add \`includeOutputs: true\` only when the output matters, \`includeImages: true\` to see plots.
3. Edit with \`ipynb_edit\` (single cell, returns a diff), \`ipynb_cell_insert\`, \`ipynb_cell_delete\`, \`ipynb_cell_move\`. Outputs are cleared automatically when code source changes.
4. Run with \`ipynb_run\`: \`mode\` is \`cell\`, \`range\`, \`from\`, or \`all\`. The warm kernel keeps Python state between calls; \`restart: true\` gives a clean kernel (use it for a full \`all\` validation). Read stdout/stderr/traceback from the result and fix failures before moving on.
5. \`ipynb_outputs\` inspects outputs (\`list\`, \`read\`, \`read_error\`) and clears them (\`clear_cell\`, \`clear_all\`).
6. \`ipynb_search\` finds cells by text/regex in sources or outputs. \`ipynb_clean\` before committing; \`ipynb_export\` to produce markdown/python/html.

## Rules

- Cell indexes are 0-based and shift after insert/delete: re-check with \`ipynb_inspect\` or \`ipynb_read\` instead of assuming.
- After fixing an early cell, rerun with \`mode: "from"\` (or \`all\`, with \`restart: true\` for a clean validation) so downstream cells see the change.
- A failing run still persists outputs and traceback: read them before editing further.
- Keep context small: don't dump whole notebooks; read cell ranges and avoid \`includeOutputs\` unless needed.
- If execution reports a missing Python package, install it in the interpreter configured for the plugin (\`ipynb_doctor\` shows which one).
- \`ipynb_doctor\` diagnoses the environment; \`ipynb_repro\` summarizes reproducibility.
`

export const IPYNB_SKILL = {
  id: "ipynb",
  name: "Jupyter notebooks (.ipynb)",
  description:
    "Use for any work on Jupyter Notebook (.ipynb) files: inspect, read, edit, run cells, inspect outputs, search, clean, export. Always prefer the ipynb_* tools over raw read/edit/shell on notebook JSON.",
  autoinvoke: true,
  path: skillPath,
  content
} as const
