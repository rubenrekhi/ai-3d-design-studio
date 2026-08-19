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

## Shipping work

Formats live in `.github/`: `COMMIT_MESSAGE_TEMPLATE.md`, `PULL_REQUEST_TEMPLATE.md`,
`ISSUE_TEMPLATE.md`.

Ask for a commit, a PR, or a stack and the `pr-wizard` agent runs it — `.claude/agents/pr-wizard/`
is the one place those steps are written down, and running them there keeps diffs and command output
out of the main conversation. An agent with no subagent support reads that file and executes the
steps itself. Either way these hold:

- Stage explicit paths. Never `git add -A` or `git add .`.
- No attribution lines in commits. Never force-push a branch that already exists on the remote.
- Report what was done, including the cut chosen for a stack, rather than asking before doing it.

One commit is one structured change; one PR is one commit; a feature is a stack of them read bottom
to top. Anything longer than a single commit ships as a stack — a lone PR is the 1-of-1 case, not a
different shape. Don't over-split: a layer that can't carry a real `<type>(<scope>): <summary>`, or
that only makes sense once you read the layer above it, belongs to that layer instead.

Cut bottom to top along the seams that already exist: `packages/shared` schemas → `apps/agent`
harness → `apps/web` orchestration → `apps/web` UI. Every layer must pass `pnpm typecheck` on its
own; a layer that only compiles once the layer above lands is a bad cut.

Stacks need GitHub's `gh stack` extension. Conductor displays and merges a stack but never creates
one, and a stack lives in a single workspace — move between its branches with `gh stack up`/`down`,
not by opening a workspace per layer.

## This is NOT the Next.js you know

`apps/web` runs **Next.js 16.3.0**, which has breaking changes — APIs, conventions, and file
structure may all differ from your training data. Read the relevant guide in
`apps/web/node_modules/next/dist/docs/` before writing any Next code. Heed deprecation notices. Do
not rely on remembered App Router patterns or on blog posts.

`next dev` writes and re-adds an equivalent block to `apps/web/AGENTS.md`. Removing it from a diff
only re-creates the uncommitted change; committing it with your work keeps the tree clean.
