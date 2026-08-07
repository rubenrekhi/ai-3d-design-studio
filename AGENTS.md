# ai-3d-design-studio

"Cursor for 3D" — a person and an AI agent build 3D assets and environments together.

**`ARCHITECTURE.md` is the design authority.** Read it before proposing structural changes. It is a
design document: most of it is not implemented yet.

## Layout

```text
apps/web/          Next.js — UI, API, orchestration, storage
apps/agent/        the harness — a 3D coding agent, runs in a Vercel Sandbox in prod
packages/shared/   zod schemas + types for the wire protocol only
```

## Hard rules

**1. Runtime dependencies go per-package, never at the workspace root.**

```bash
pnpm add -Dw <pkg>                        # shared dev tooling ONLY
pnpm add <pkg> --filter @repo/<name>      # anything imported at runtime
```

Node resolution walks up parent directories, so a package installed at the root is importable from
_every_ package. Put `@supabase/supabase-js` at the root and `apps/agent` can import it — the harness
boundary is gone and nothing catches it. Per-package installs make the boundary a fact about
`node_modules`, not a promise in a document.

Add a dependency when the first line of code imports it, not in anticipation.

**2. `apps/web` never imports `apps/agent`.** It imports `@vercel/sandbox` to launch microVMs. The
agent is a program that runs elsewhere, not a library. Test: delete `apps/web` and the agent still
builds and runs.

**3. The harness is domain-aware and product-ignorant.** It knows 3D scene building; it knows nothing
about sessions, users, versions, or storage. No network clients in `apps/agent` except the model SDK.
If the words "version", "session", or "project" appear in its types, something leaked.

**4. `packages/shared` holds schemas and types only.** No runtime logic. Anything heavy added there
lands in both the web bundle and the agent image.

**5. A comment needs a reason to exist.** Default to none. Write one only where the code is genuinely
surprising to someone reading it — a non-obvious constraint, a workaround for external behavior, an
ordering that looks wrong but isn't.

Never write: restatements of what the line already says, decision logs or changelogs ("generated
by X", "changed to fix Y"), section banners, or narration of an edit that was just made. Git history
records changes; `ARCHITECTURE.md` records decisions. Code does not.

If code needs a comment to be understood, first try fixing the naming or structure instead.

## Toolchain

- **pnpm** workspace, Node **24.x** (`nvm use` reads `.nvmrc`). Corepack is deliberately not used.
- `.nvmrc` pins the exact dev version; `engines.node` uses the `24.x` range because Vercel rolls
  minors itself and ignores `.nvmrc`.
- Run everything from the repo root: `pnpm web` (Next dev server), `pnpm agent` (harness in watch
  mode), `pnpm build`, `pnpm typecheck`, `pnpm format`.

## This is NOT the Next.js you know

`apps/web` runs **Next.js 16.3.0**, which has breaking changes — APIs, conventions, and file
structure may all differ from your training data. Read the relevant guide in
`apps/web/node_modules/next/dist/docs/` before writing any Next code. Heed deprecation notices. Do
not rely on remembered App Router patterns or on blog posts.

`next dev` writes and re-adds an equivalent block to `apps/web/AGENTS.md`. Removing it from a diff
only re-creates the uncommitted change; committing it with your work keeps the tree clean.
