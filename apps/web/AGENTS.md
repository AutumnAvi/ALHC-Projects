<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# apps/web

The Next.js app of the ALHC Projects monorepo. The architecture source of truth is the repository root's
`AGENTS.md` (`../../AGENTS.md`); see `docs/design/monorepo.md` for what lives here and what lives in
`packages/core`. This file exists so `next dev`, run in this folder, finds its own block above and leaves
the tree clean.
