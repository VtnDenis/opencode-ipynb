// Root entrypoint for local-directory installs.
//
// OpenCode V2 resolves a configured local plugin directory to
// `<dir>/server` then `<dir>/index` (it does not consult package.json
// `main`/`exports` for local paths), so a package that only ships
// `dist/` is silently skipped. This file forwards to the built bundle.
export { default } from "./dist/index.js"
