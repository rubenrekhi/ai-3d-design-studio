# Architecture

> **Status: design, not implementation.** Nothing in this document is built yet. It records the
> decisions made before writing code so they don't have to be re-derived. Update it as reality
> diverges.

A person and an AI agent build 3D assets and environments together: describe → generate → inspect in
a live 3D viewer → refine → export. "Cursor for 3D."

## Core invariants

1. **The harness is domain-aware and product-ignorant.** It knows everything about building good 3D
   scenes and nothing about sessions, users, versions, or storage.
2. **The harness owns no state the product cannot see.** Everything it produces is either a file in
   `workdir` or the conversation document, and both leave through `onCommit`.
3. **The workspace is current state only.** No version history inside it — that lives in the store and
   is materialized from manifests. The conversation document is the one exception, and it is excluded
   from manifests precisely so it stays a working copy rather than becoming versioned state.
4. **Durable storage is the source of truth.** The sandbox filesystem is a working copy that can be
   destroyed and rebuilt at any time.
5. **Code is the asset.** `scene.py` and `assets/*.py` define the scene; the GLB is a build output.
   We store the GLB anyway, for latency and fidelity — but source is what must never be lost.
6. **One user message → one version.** Intermediate builds within an agent run update the live viewer
   but are never committed.
7. **A committed version always builds.** The harness will not settle an agent run on a broken build.
8. **The agent never holds a credential that outlives its run.** Signed URLs and per-session tokens
   only.

## System overview

```text
┌─────────────────────────── Browser ────────────────────────────┐
│ React + Three.js viewer, chat, version strip                   │
└───────────────▲──────────────────────┬─────────────────────────┘
                │ HTTP + stream        │ GLB / artifacts
┌───────────────┴──────────────────────▼─────────────────────────┐
│ apps/web  —  Next.js (App Router)                              │
│ · auth, projects, sessions                                     │
│ · reconciles the workspace before each run                     │
│ · launches the agent over a transport                          │
│ · owns versions, manifests, and all DB writes                  │
└───────────────┬────────────────────────────────────────────────┘
                │ AgentTransport (JSONL over stdout)
┌───────────────▼────────────────────────────────────────────────┐
│ apps/agent  —  the harness (pi + a system prompt + tools)      │
│ · pi owns the agent loop, sessions, compaction                 │
│ · file tools, hard-confined to workdir                         │
│ · run_blender, inspect_scene, preview_asset                    │
│ · studioExtension: build guard, hashes workdir, calls onCommit │
└───────────────┬────────────────────────────────────────────────┘
                │ onCommit(changed, workdir)
┌───────────────▼────────────────────────────────────────────────┐
│ Store adapter  —  chosen by the caller, never by the harness    │
│ local:  .localstore/…/blobs + db.json                          │
│ prod:   Supabase Storage (blobs) + Postgres (versions)         │
└────────────────────────────────────────────────────────────────┘
```

## Repository structure

```text
ai-3d-design-studio/
├── pnpm-workspace.yaml        # at the root — a workspace only sees packages beneath it
├── .nvmrc                     # dev-machine Node, one per repo
├── apps/
│   ├── web/                   # Next.js — UI, API, orchestration, storage
│   └── agent/                 # the harness — runs inside a sandbox in prod
└── packages/
    └── shared/                # zod schemas + inferred types for the wire protocol only
```

`packages/shared` holds schemas and types, never runtime logic. The moment it pulls a heavy
dependency, that dependency lands in both the web bundle and the agent image.

**`apps/web` never imports `apps/agent`.** It imports `@vercel/sandbox` to launch microVMs. The agent
is a program that runs elsewhere, not a library. The test: delete `apps/web` and the agent still
builds and runs.

## The agent harness

The runtime is [pi](https://github.com/earendil-works/pi) — `@earendil-works/pi-coding-agent`, driven
through its SDK rather than spawned as a CLI. `apps/agent` supplies a system prompt, the 3D tools, and
one extension; it does not implement an agent loop.

**Vocabulary is pi's.** A _turn_ is one LLM round — a response plus its tool calls. An _agent run_ is
a full user message through to `agent_settled`. Versions are committed per run, never per turn.

### Depending on pi

Pin exact versions, not ranges. Pi is pre-1.0, ships frequently, and has already moved npm scope once
(`@mariozechner/*` → `@earendil-works/*`, the old packages now deprecated). Its own repo pins direct
dependencies exactly for the same reason.

Pi's dependency weight is real and lands in the agent image: `pi-ai` carries every provider SDK
including AWS Bedrock, and `pi-coding-agent` adds a TUI, a wasm image library, and a syntax
highlighter the sandbox will never render. Boundary rule 1 survives this — they are all model SDKs —
but it is worth knowing the rule now permits more surface than it did when it was written.

**Pi ships no permission system.** It runs with the permissions of the process that launched it, and
its own docs point at containerization as the answer. In production that is already true: the agent
only ever runs inside a microVM. The consequence is that running the harness directly against a
developer's machine gives it that machine's permissions, which is acceptable for local dev on one's
own repo and is not a model to extend to anything multi-tenant.

### Boundary

| Harness                                         | Product                                          |
| ----------------------------------------------- | ------------------------------------------------ |
| Agent loop, round limits, tool dispatch         | Sessions, users, projects                        |
| File tools confined to `workdir`                | Deciding where `workdir` is                      |
| `run_blender`, `inspect_scene`, `preview_asset` | Getting the workspace into the right state first |
| 3D system prompt and scene expertise            | Versions, manifests, blobs, Postgres             |
| Emitting turn events                            | Transport selection                              |
| Diffing its own working directory               | Interpreting that diff                           |

Restore and hydrate are **product** responsibilities. The harness receives a directory that is
already correct and never reconciles anything.

### Config

`apps/agent` exports one function. It builds a pi session and returns it; the caller owns everything
outside the workdir.

```ts
export function createStudioAgent(opts: {
  workdir: string
  model: Model
  onCommit?: (changed: ChangedFiles, workdir: string) => Promise<void>
}) {
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => SCENE_BUILDER_PROMPT,
    extensionFactories: [studioExtension(opts.onCommit)],
  })

  return createAgentSession({
    cwd: opts.workdir,
    model: opts.model,
    customTools: [runBlender, inspectScene, previewAsset],
    sessionManager: SessionManager.open(`${opts.workdir}/.pi/session.jsonl`),
    resourceLoader: loader,
  })
}
```

`studioExtension` is the whole product seam — it owns the build guard, hashes the workdir, and calls
`onCommit`. Everything else pi already does.

`onCommit` is optional. Without it you get a working 3D coding agent in a terminal, which is both the
fastest dev loop and the integration-test target.

That terminal is pi's TUI, and `@earendil-works/pi-tui` renders images inline over the Kitty and
iTerm2 graphics protocols — so `pnpm agent` can show the render after each build. It is a dev-loop
affordance only. The product UI is the Next app consuming `session.subscribe()`, and no product
decision should be made to suit the TUI.

The product consumes events with `session.subscribe()` and intercepts calls with `pi.on('tool_call')`,
which can block a call rather than merely observe it.

`run_blender` is **built into the harness**, not injected. The harness guarantees a working build at
the end of a run, and it can't enforce that over a tool it doesn't understand.

### The build guard

Invariant 7 is enforced in an extension, without patching pi:

```ts
pi.on('agent_end', async () => {
  const build = await runBlender()
  if (!build.ok) {
    pi.sendMessage(
      { customType: 'build-error', content: build.stderr, display: true },
      { deliverAs: 'followUp', triggerTurn: true },
    )
  }
})
```

`sendMessage` with a `customType` is a **custom** message, not `sendUserMessage` — it enters LLM
context without being attributed to the user, so a failed build never looks like something the person
asked for.

`agent_settled` fires only once no retry, compaction, or queued follow-up remains, so a pending
follow-up defers it. The commit hook therefore fires exactly once per run, after the build is green.

### Context and image lifecycle

Pi prunes nothing. There is no image eviction and no cap; images stay in context until compaction
cuts them off by age, and compaction only fires near the context limit. Left alone, every render ever
taken is re-sent on every request for the life of the session.

**Images are dropped at the run boundary, not per turn.** Within a run the agent needs to see what it
just built to iterate on it. Once the run settles, and before the next user message, renders from that
run collapse to a text stub:

```text
[render — scene.glb from above at v7. Re-run inspect_scene to look again.]
```

The agent keeps the reasoning trail — it knows it looked, and at what — without re-consuming the
pixels. Roughly twenty tokens instead of fifteen hundred.

The mechanism is pi's `context` event, which fires before each LLM call and receives a deep copy:

```ts
let runStart = 0
pi.on('agent_start', (_e, ctx) => {
  runStart = ctx.sessionManager.getEntries().length
})
pi.on('context', async (event) => ({
  messages: stubImagesBefore(event.messages, runStart),
}))
```

Snapshotting the entry index at `agent_start` is what makes the boundary a _run_ rather than a turn:
messages from the current run keep their images, everything earlier is stubbed.

Because `context` is non-destructive, the session document keeps the real references. History stays
complete, the UI can show every render, and rewind is unaffected — only the model's view is trimmed.

`inspect_scene` is designed against this grain. It takes a camera position, angle, and framing, and
returns a screenshot of that specific view, which means the agent can always get an image back when
it needs one. Nothing about that output is durable in context, and that is the point: a cheap,
repeatable tool call is a better deal than a permanent resident of the context window. Its shape is
not settled yet; what is settled is that it must be re-callable rather than remembered.

Its parameters must round-trip into the stub text. `[render — scene.glb from above at v7]` is the
agent's only remaining handle on a view it can no longer see, so whatever the tool accepts has to be
expressible in that one line.

**Externalization and pruning are one component.** Both intercept the same image at the same point
and differ only in destination: externalization writes a blob and leaves a reference; pruning decides
whether a reference is rehydrated into a real image block for this call. Built separately, the
interception gets written twice and the two drift.

### Subagents

Pi supports subagents both ways, and the choice is about fault isolation, not context. A nested
`createAgentSession()` already has its own message list, system prompt, tool set, model, and `cwd` —
context isolation does not require a separate process.

In-process is the default here: subagents need `run_blender`, which the parent has already
registered, and passing a tool object beats packaging an extension for every child to load. The
subprocess form buys containment — an OOM in a child cannot take down the parent, and abort is a kill
signal rather than a cooperative one.

The binding constraint is neither: Blender is CPU-heavy and spawns regardless of how the agents
themselves are hosted, so fan-out is limited by the sandbox's cores. Parallel asset building is a CPU
budget question, not an architecture one.

Not built yet, and not a v1 requirement. Recorded because it constrains nothing today and would be
expensive to discover was impossible later.

### Rules that keep the boundary from eroding

1. No network clients in the harness except the model SDK. Bytes leave through `onCommit`.
2. No product vocabulary in harness types. Its language is `workdir`, `turn`, `tool`, `message`. Pi's
   own `session` is generic conversation state and does not count; if "version" or "project" appears
   in `apps/agent`, something leaked.
3. Extensibility is tool registration and extensions, never a patched pi. If a requirement seems to
   need a fork, it belongs in `studioExtension`.
4. `onCommit` is awaited and its failures propagate, but the harness has no fallback behavior. A
   failed commit is the product's problem.

## One agent run

```text
1. Product reconciles the workspace to the last committed manifest.
     Idempotent, runs at the START of every run — a crashed process never
     runs its own cleanup, so this is never a failure handler.
2. Product invokes the harness over a transport.
3. Extension hashes the workspace  →  manifest A.
4. Pi's agent loop: edits source, runs Blender, inspects, repeats.
     Each successful build hot-swaps the GLB in the viewer. Nothing is committed.
5. agent_end → the build guard runs. On failure it queues a follow-up and the
     loop continues, deferring settle.
6. agent_settled → extension hashes the workspace → manifest B.
7. onCommit(diff(A, B), workdir) uploads changed blobs, externalizes any new
     images out of .pi/session.jsonl, then posts the manifest and the
     conversation document together.
8. API writes sessions.history and version_files, then the versions row LAST.
```

Steps 3 and 6 are why the commit binds to `agent_settled` rather than `agent_end`: pi may still
auto-retry, auto-compact and retry, or drain queued follow-ups after `agent_end`, and each of those
would produce a version mid-flight.

### On failure

Committing a version and syncing the conversation are **separate operations with different failure
rules**:

|                   | Run succeeded | Run failed |
| ----------------- | ------------- | ---------- |
| Version and files | commit        | nothing    |
| Conversation      | sync          | sync       |

Invariant 7 protects the scene: never create a version pointing at a build that doesn't work. It says
nothing about the conversation, which is a log rather than versioned state. A failed exchange belongs
in it — otherwise the user reloads the page and their own message has vanished along with the error,
leaving a chat that appears never to have happened.

Nothing is actually lost when a run fails and the sandbox survives, because pi appends to
`.pi/session.jsonl` as messages happen rather than flushing at the end. The file is intact on disk;
the next run reads it and continues. The only real loss window is the sandbox itself dying, and at
that point the workspace is gone too and we are restoring from the last version anyway.

`agent_settled` is emitted from a `finally`, so it fires on errors, aborts, and token exhaustion —
which is what makes it the right hook for both rows of that table. Two consequences:

- It carries no outcome payload. To decide between the rows, read the last assistant message's
  `stopReason` (`"error"` / `"aborted"`) rather than assuming settle means success.
- It does not fire if the run never started — a prompt rejected in pre-flight emits neither
  `agent_start` nor `agent_settled`. Anything that must cover "the user asked and nothing happened"
  belongs at the `prompt()` call site, not in the hook.

The next run's step 1 still restores the workspace to the last good version. No partial scene state
is ever visible.

**Commit ordering is not negotiable.** Blobs, then `version_files`, then `versions`. An orphaned blob
is collectable garbage; a version row pointing at a missing blob is corruption a user sees.

## Versions and storage

### Manifest

A manifest is a list of every file in the workspace with its content hash:

```json
{
  "scene.py": { "hash": "a3f2…", "size": 4021 },
  "assets/chair.py": { "hash": "b91c…", "size": 1877 },
  "scene.glb": { "hash": "7d4e…", "size": 41203994 }
}
```

Diffing two manifests yields created / modified / deleted. Nothing depends on the agent reporting
what it did, so Blender's side-effect outputs are caught the same as tool-written files.

Blobs are stored content-addressed at `sessions/<id>/blobs/<sha256>`. A version is a set of
path → hash pointers, so unchanged files are never re-uploaded and uploads are idempotent under
retry.

The manifest is the primitive behind **three** operations, which is its real payoff:

- hydrate a fresh sandbox
- restore a version the user picked
- reconcile the workspace at run start

```text
materialize(workspace, manifest):
  for each path in manifest:                 write blob if hash differs
  for each path not in manifest, not excluded:  delete
```

**`materialize()` and the hasher must share one exclusion list.** They are inverses, and a list that
drifts between them is destructive rather than merely wasteful: `.pi/` is excluded from the manifest,
so a delete pass that does not also exclude it wipes the conversation on every reconcile — at the
start of every run, in a sandbox that is persistent by default.

### What the manifest excludes

Hashing is not "every file under `workdir`". Two categories are skipped, and both matter:

- **`.pi/`** — the conversation working copy. It is durable state, but it is one growing document
  synced to `sessions.history`, not something to snapshot per version. Hashing it would store a full
  copy of the entire conversation in every version's blob set: a 5 MB session across 50 versions is
  250 MB of near-duplicate blobs.
- **Ephemeral render output** — contact sheets and `inspect_scene` screenshots. Regenerable, large,
  and already excluded from what a version stores.

This is why rewind moves two things rather than one. `materialize()` restores files; a branch to
`versions.entry_id` restores conversation. Neither mechanism can do the other's job, and trying to
collapse them into the manifest is what the exclusion prevents.

Everything else is in scope by default. An ignore list that must be opted _out_ of fails safe:
forgetting to add an entry costs storage, while forgetting to add an include would silently lose a
file the agent wrote.

### Preview, then rewind

Browsing a version is **not** restoring it. Selecting a version in the strip loads that version's
stored `scene.glb` into the viewer and touches nothing else — no workspace mutation, no session
change. Rewinding is a second, explicit action.

This is only cheap because the GLB is stored rather than recomputed, which is the payoff for that
decision beyond latency.

Rewinding then moves two things together: `materialize()` for the workspace, and a branch to the pi
session entry recorded on the version row. Conversation and scene rewind as one.

**Compaction does not threaten this anchor.** Pi's sessions are append-only: compaction appends a
summary entry and moves the leaf, and never deletes, mutates, or renumbers what came before. Entry
ids are permanent for the life of the session file, so `versions.entry_id` stays resolvable no matter
how many compactions have run over it.

Better than merely safe: branching to a pre-compaction entry restores the **full, uncompacted**
history, because context is rebuilt by walking from the new leaf to the root and the compaction entry
is a descendant that simply is not on that path. Rewinding does not inherit a summary the user never
asked for.

The cost is context, not correctness — replaying full history can immediately re-trigger compaction.
That is a token budget question at rewind time, not a reason to distrust the anchor.

Two narrow ways an id could still go stale, neither of which applies here: legacy **v1** session files
get renumbered on migration (we will never have one), and pi's newer harness constructs synthetic
`${compactionId}:retained:N` ids internally that never exist in a session. Never bookmark one of
those; `versions.entry_id` must only ever hold an id read back from a real session entry.

### What a version stores

| Artifact                         | Stored                                                    |
| -------------------------------- | --------------------------------------------------------- |
| `scene.py`, `assets/*.py`        | Always. Kilobytes, and the thing that must never be lost. |
| `scene.glb`                      | Always. Latency and fidelity both demand it.              |
| `stats.json`                     | Yes — small, displayed without parsing the GLB.           |
| Full-res contact sheets          | No. Agent context, regenerable, large.                    |
| Anything re-derivable at hydrate | No.                                                       |

**Why not recompute the GLB from source?** Latency (version browsing must feel instant, not
sandbox-boot-plus-Blender slow), drift (a rebuild months later under a newer Blender is not the scene
the user saw), and economics (storage is paid once; compute is billed per view). Recompute stays
available as a _repair_ path if a blob is ever lost.

### Conversation storage

Conversation lives in a `jsonb` column, not a blob. Pi's session file is already a tree — every
branch is in the same document — so rewinding is a pointer move inside it, not a restored copy. There
is one conversation document per session that grows, never N snapshots per version. That removes the
usual reason to reach for object storage, and `jsonb` buys transactional writes with the version row
and SQL over the history.

**This only works because images are externalized first.** Pi embeds images as inline base64
(`ImageContent.data`) with no option to do otherwise. A 3D agent generates a render per build, so an
untouched session reaches tens of megabytes of base64 — and Postgres rewrites an entire `jsonb` value
on every update, meaning each save rewrites every render ever taken, for data nothing queries.

So images are intercepted on the way into the session, written to blob storage, and replaced by a
reference. The session document stays text and stays small.

The same interception fixes a cost problem that has nothing to do with storage: un-externalized
images are re-sent to the model on every request for the life of the session.

### Data model

```sql
projects(id, user_id, name, sandbox_name, created_at)
sessions(id, project_id, history jsonb, pi_session_id, created_at, updated_at)
versions(id, session_id, n, entry_id, parent_version_id, image_tag, created_at)
version_files(version_id, path, blob_hash, size)
```

There is no `messages` table. `sessions.history` is the pi session document and the source of truth;
anything the UI needs for listing (title, message count) is a projection off it, never a dual write.

`versions.entry_id` is the pi session entry a version was committed at. It is what makes rewind a
branch rather than a restore, and it keeps two trees — versions and conversation — in step.

`versions.image_tag` records the VCR image that built each version. It is impossible to backfill and
is the only way a future rebuild can use the Blender that produced the original.

`projects.sandbox_name` is the join between the database and `Sandbox.getOrCreate({ name })`.

## Environments

The harness exposes one CLI entry point that streams JSONL on stdout. Both environments run the same
binary over the same protocol; only the transport differs.

That entry point is **ours**, not `pi --mode rpc`. It wraps `createStudioAgent()` and emits the
protocol in `packages/shared`. Pi's own RPC mode is a viable fallback, but going through the SDK
keeps tool registration, the build guard, and the commit hook in one process instead of split across
a subprocess boundary for no gain.

|                | Local                                 | Production                       |
| -------------- | ------------------------------------- | -------------------------------- |
| Transport      | `child_process.spawn`                 | `sandbox.runCommand`             |
| Workdir        | `.localstore/sessions/<id>/workspace` | `/vercel/sandbox/workspace`      |
| Agent delivery | built bundle, run directly            | custom OCI image from VCR        |
| Blobs          | `.localstore/sessions/<id>/blobs/`    | Supabase Storage via signed URLs |
| Versions       | `db.json`                             | Postgres                         |
| Conversation   | `.pi/session.jsonl`, left in place    | synced to `sessions.history`     |
| Commit hook    | `LocalCommitHook`                     | `SupabaseCommitHook`             |

Conversation is the one row that is not a like-for-like mirror. Locally the session file in the
workspace _is_ the durable copy, so nothing syncs; in production it is a working copy that gets
pushed to Postgres at commit. The externalization step runs in both, or local sessions grow base64
without bound and stop resembling what production does.

```text
.localstore/                    # gitignored
  sessions/<id>/
    workspace/                  # agent cwd — identical shape to the sandbox
      .pi/session.jsonl         # pi conversation state, inside the workdir on purpose
    blobs/<sha256>              # stand-in for object storage
    db.json                     # stand-in for Postgres
```

Local mirrors **both** halves deliberately. If dev only had `workspace/`, the commit path would never
run until deploy, and would rot.

`workdir` is always passed in — never hardcoded, never inferred.

**Pi's session directory must be overridden.** It defaults to `~/.pi/agent/sessions/`, outside the
workdir, where the manifest would not see it and a fresh sandbox would start amnesiac. Set it
explicitly (`SessionManager.open(path)`, or `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` on the
CLI). Same for `agentDir`, which is config rather than state but diverges silently between local and
sandbox if left implicit.

### Resuming a session

`.localstore/sessions/<id>/` is a complete standalone record — workspace, blobs, manifests, and
conversation. `pnpm agent --session <path>` resumes from it:

```text
1. read the latest manifest from db.json
2. materialize the workspace from blobs/     ← product step, BEFORE pi boots
3. point SessionManager at <workdir>/.pi/session.jsonl
4. createAgentSession()
```

Resuming is **two** restores, not one: files and conversation. The ordering is load-bearing — pi's
tools resolve paths against `cwd` when they are constructed, so materializing after boot leaves the
agent reasoning about files that changed underneath it.

Production runs the identical sequence and differs only in step 1–2 reading Supabase instead of
`blobs/`. The resume flag is what keeps that path exercised.

### Sandbox delivery

The agent ships as a custom OCI image in Vercel Container Registry, built with
`docker buildx --platform linux/amd64` and referenced as `Sandbox.create({ image: 'agent:v1' })`.
Blender and the toolchain are baked in; nothing installs at runtime.

Git source is _not_ how the agent gets in — that would put a git credential inside the untrusted VM.
It remains available later for cloning a user's own asset repo.

Notes: `ENTRYPOINT`/`CMD` are ignored for custom images, so start processes with `runCommand()`. The
default session timeout is 5 minutes — set it explicitly. Sandboxes are persistent by default;
`Sandbox.getOrCreate({ name: \`project-<id>\` })` resumes a user's filesystem across sessions.

### The workspace is build-time only

Nothing in production knows what a pnpm workspace is. Both deployables resolve it during their build
and emit something self-contained, so no symlink ever ships.

The agent's Dockerfile takes the **repo root** as its build context
(`docker build -f apps/agent/Dockerfile .`), so `packages/shared` is present as real files. esbuild
then follows the symlink and inlines shared's code into a single `dist/agent.js`, which is the only
thing copied into the runtime stage. There is no `packages/shared` and no `node_modules` in the final
image.

If a dependency ever ships a native `.node` binary that cannot be bundled, use
`pnpm deploy --filter @repo/agent /out`, which produces a flat directory with real copies instead of
symlinks.

`apps/web` resolves the same way: Vercel installs from the workspace root, and Next's output tracing
copies shared's code into the deployment.

The dangling-symlink failure only appears if something skips this step — uploading raw `apps/agent/`
source into a sandbox, for example. This is why local dev ships the **built bundle** rather than raw
source: same resolution as prod, so the two cannot diverge on it.

### Credentials

The service role key never enters a sandbox. The agent gets short-lived signed upload URLs scoped to
one project prefix, plus a per-session callback token. Blobs go direct to storage; **metadata always
goes through the API**, which owns every database write.

Sandbox egress is billed and ingress is free — hydrate freely, upload only what changed.

## Toolchain

- **pnpm**, not npm — strict dependency resolution, shared store, faster installs.
- **Corepack is skipped.** It is no longer bundled with Node, and it solves team version-sync that a
  solo project doesn't have. pnpm is installed standalone; `packageManager` is set by hand because
  Vercel reads it.
- **One `.nvmrc` at the repo root.** See below.
- TypeScript strict, plus `noUncheckedIndexedAccess`. Prettier with the Tailwind plugin. Env vars
  validated with zod at build time.
- Vercel: Root Directory `apps/web`, "include files outside root" enabled. Vercel clones the whole
  repo, installs from the workspace root, and builds in `apps/web`.

### Where dependencies go

**Runtime dependencies go per-package, never at the workspace root.** Shared dev tooling
(`typescript`, `prettier`, `esbuild`, `tsx`) belongs at the root with `pnpm add -Dw`. Anything
imported at runtime belongs to exactly one package via `pnpm add <pkg> --filter @repo/<name>`.

This is not tidiness — it is what makes invariant 1 enforceable. Node resolution walks up parent
directories, so a package installed at the root is importable from _every_ package. Put
`@supabase/supabase-js` at the root and `apps/agent` can import it, and the harness boundary is gone
with nothing to catch it. Per-package installs make "the agent has no storage client" a fact about
`apps/agent/node_modules`, not a promise in a document.

Corollary: add a dependency when the first line of code imports it, not in anticipation.

### Node versions across packages

One dev Node version per repo. `nvm` is shell-level and a single root `pnpm install` runs under one
interpreter, so `apps/web` and `apps/agent` cannot install under different versions.

They do, however, have genuinely independent **production** runtimes, pinned by different mechanisms:

|                      | Controlled by                                             | Currently  |
| -------------------- | --------------------------------------------------------- | ---------- |
| Dev machine          | root `.nvmrc`                                             | `v24.19.0` |
| `apps/web` in prod   | Vercel project Node setting, overridden by `engines.node` | 24.x       |
| `apps/agent` in prod | `FROM node:XX` in its Dockerfile                          | —          |

Declare intent per package with `engines` in each `package.json` so a mismatch fails loudly.

**The dev pin is 24 LTS because Vercel caps there.** As of 2026-08, Vercel builds and functions
offer only **24.x (default), 22.x, and 20.x** — no 26.x — and 20.x is disabled on 2026-10-01.
Developing on 26 locally would mean a runtime `apps/web` cannot deploy to.

Two traps worth writing down:

- **Vercel ignores `.nvmrc`.** It reads the project's Node setting, overridden by `engines.node`
  (`"24.x"`). The root `.nvmrc` is purely a local-dev/nvm pin with no effect on deploys — which is
  precisely why `engines` above is load-bearing rather than decorative.
- **Vercel Sandbox is a separate runtime from builds/functions** and does offer Node 26
  (`Sandbox.create({ runtime: "node26" })`, `@vercel/sandbox` >= 1.10.2). That flag applies to
  stock sandboxes; because the agent ships as a custom OCI image, its `FROM node:XX` wins and the
  agent can move to 26 independently of whatever `apps/web` is capped at.

Vercel auto-rolls minors and patches within a major, so an exact-patch `.nvmrc` will drift behind
the build image. That is expected, not a misconfiguration.

**Each package does get its own `node_modules`.** pnpm writes real files once into
`node_modules/.pnpm` at the root and symlinks into each package the dependencies _that package
declared_:

```text
node_modules/.pnpm/            # real files, one copy per package@version
apps/web/node_modules/         # symlinks: next, react, @vercel/sandbox, @repo/shared
apps/agent/node_modules/       # symlinks: @anthropic-ai/sdk, zod, @repo/shared
```

`apps/agent` cannot import `next` — it isn't in its `node_modules`. Two packages can even depend on
different major versions of the same library; `.pnpm` holds both. Dependency isolation is real.

What is shared is one _install_: one resolution pass, one lockfile, one interpreter running it. Only
**native modules** care about that last part, because node-gyp compiles against the Node ABI at
install time. Pure-JS packages are indifferent.

`nvm use` resolves `.nvmrc` from the current directory upward, so `apps/agent/.nvmrc` does work for a
shell sitting in that directory — but a native module compiled under one ABI will break under
another. If a native dependency ever forces a split dev version, treat that as a signal the agent may
want its own repository.

## Open questions

- Whether sessions are one-per-project or many.
- `inspect_scene`'s parameters, bounded by having to round-trip into one line of stub text.
- Whether to leave compaction on. It is on by default (`compaction.enabled`, `keepRecentTokens: 20000`)
  and is safe for rewind, but it summarizes away detail the agent may need on long scenes. Turning it
  off trades that for hitting the context limit outright.
- Blob garbage collection: orphaned blobs accumulate. Needs a sweep, eventually.
- Retention: whether old versions ever drop their GLB and fall back to rebuild-on-demand.
- Turborepo — not needed yet; add when builds get slow.
- Whether the studio ever points at a user's own git repo of assets.
