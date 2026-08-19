# Architecture

> **Status: design, not implementation.** No part of this document is built yet. It records decisions
> so that nobody must make them twice. Update it when reality changes.

A person and an agent build 3D assets and environments together. The person describes a change. The
agent writes Python, runs Blender, and inspects the result. The person sees the new scene in a live
3D viewer. "Cursor for 3D."

---

## 1. Terms

Use these words with these meanings. Do not use synonyms.

| Term            | Meaning                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| **Turn**        | One call to the model, plus the tool calls in its reply.                         |
| **Run**         | One user message, from start until the agent stops. A run contains many turns.   |
| **Settle**      | The end of a run. No retry, no compaction, and no queued message remains.        |
| **Harness**     | The program that runs the agent. Knows 3D. Knows nothing about the product.      |
| **Product**     | `apps/web`. Knows users, projects, sessions, and versions.                       |
| **Workspace**   | The directory the agent works in. Also called `workdir`.                         |
| **Agent home**  | Machine-level directory holding every mode A session. Default `~/.studio-agent`. |
| **Blob**        | One file, stored under the SHA-256 hash of its content.                          |
| **Manifest**    | A list of paths. Each path points to a blob hash.                                |
| **Version**     | One manifest, plus metadata. Created at the end of a successful run.             |
| **Session**     | One conversation. Holds many runs and produces many versions.                    |
| **Materialize** | Make a workspace match a manifest. Writes files and deletes files.               |
| **Reconcile**   | Materialize the workspace to the last committed manifest.                        |
| **Compaction**  | Pi replaces old messages with a summary when the context gets full.              |
| **Strip**       | Delete image blocks when writing the conversation to durable storage.            |
| **Stub**        | Short text that replaces an image in the model's view of the conversation.       |

---

## 2. Invariants

1. **The harness knows 3D and does not know the product.** It knows how to build good scenes. It does
   not know about users, projects, versions, or storage.
2. **The harness holds no state the product cannot see.** It produces files in the workspace and one
   conversation document. Both leave through `onCommit`.
3. **The workspace holds current state only.** Version history lives in the store. The conversation
   document is the one exception. Section 9.2 excludes it from manifests to keep it a working copy.
4. **Durable storage is the source of truth.** Any sandbox filesystem can be destroyed and rebuilt.
5. **Code is the asset.** `scene.py` and `assets/*.py` define the scene. The GLB is a build output. We
   store the GLB as well, but source is what must never be lost.
6. **One user message produces one version.** Builds during a run update the viewer. They are not
   committed.
7. **A committed version always builds.** The harness does not settle a run on a broken build.
8. **No credential outlives a run.** Use signed URLs and per-session tokens only.

---

## 3. System overview

```text
┌─────────────────────────── Browser ────────────────────────────┐
│ React + Three.js viewer, chat, version strip                   │
└───────────────┬──────────────────────▲─────────────────────────┘
                │ prompts, actions     │ event stream, GLB
┌───────────────▼──────────────────────┴─────────────────────────┐
│ apps/web — the product                                         │
│ · auth, projects, sessions                                     │
│ · reconciles the workspace before each run                     │
│ · launches the agent over a transport                          │
│ · owns versions, manifests, and all database writes            │
└───────────────┬──────────────────────▲─────────────────────────┘
                │ spawn, user message  │ JSONL events on stdout
┌───────────────▼──────────────────────┴─────────────────────────┐
│ apps/agent — the harness (pi + prompt + tools + 1 extension)   │
│ · pi owns the agent loop, sessions, and compaction             │
│ · file tools, restricted to the workspace                      │
│ · run_blender, inspect_scene, preview_asset                    │
│ · studioExtension: build guard, hashing, onCommit              │
└───────────────┬────────────────────────────────────────────────┘
                │ onCommit(changed, workdir)
┌───────────────▼────────────────────────────────────────────────┐
│ Store adapter — chosen by the caller, never by the harness     │
│ absent in mode A. Supabase in modes B and C, local or hosted.  │
│ Storage holds blobs. Postgres holds metadata.                  │
└────────────────────────────────────────────────────────────────┘
```

---

## 4. Repository layout

```text
ai-3d-design-studio/
├── pnpm-workspace.yaml     a workspace sees only packages below it
├── .nvmrc                  the development Node version
├── apps/
│   ├── web/                Next.js — UI, API, orchestration, storage
│   └── agent/              the harness — runs in a sandbox in production
└── packages/
    └── shared/             schemas and types for the wire protocol only
```

Rules:

- `packages/shared` holds schemas and types. It holds no runtime logic. A heavy dependency there lands
  in both the web bundle and the agent image.
- **`apps/web` never imports `apps/agent`.** It imports `@vercel/sandbox` to start microVMs. The agent
  is a program that runs elsewhere. It is not a library.
- Test for the rule above: delete `apps/web`. The agent must still build and run.

---

## 5. The harness

The runtime is [pi](https://github.com/earendil-works/pi), package
`@earendil-works/pi-coding-agent`. We use its SDK. We do not start its CLI as a subprocess.

`apps/agent` supplies a system prompt, three tools, and one extension. It does not implement an agent
loop.

### 5.1 What pi gives us

| Capability                           | Note                                           |
| ------------------------------------ | ---------------------------------------------- |
| Agent loop and tool dispatch         | —                                              |
| File tools (`read`, `write`, `edit`) | Restricted to the workspace                    |
| Conversation storage                 | Append-only JSONL, a tree with `id`/`parentId` |
| Branching and forking                | Any entry can become the new leaf              |
| Compaction                           | On by default. See 10.1.                       |
| Events and hooks                     | See 5.4                                        |
| A terminal UI                        | Development only. See 5.6.                     |

### 5.2 Depending on pi

- **Pin exact versions.** Pi is before 1.0 and releases often. It has already changed npm scope once,
  from `@mariozechner/*` to `@earendil-works/*`. The old packages are deprecated.
- **Pi is heavy.** `pi-ai` carries every provider SDK, including AWS Bedrock. `pi-coding-agent` adds a
  terminal UI, a WASM image library, and a syntax highlighter. All of it lands in the agent image.
  Boundary rule 1 (section 5.5) allows this, because these are all model SDKs. Know that the rule
  permits a large surface.
- **Pi has no permission system.** It runs with the permissions of its process. Its own documentation
  recommends containers. In production the agent runs only inside a microVM, so this is satisfied. In
  local development the agent gets the developer's own permissions. Do not extend that model to
  anything with more than one user.

### 5.3 Boundary

| The harness does this                           | The product does this                         |
| ----------------------------------------------- | --------------------------------------------- |
| Runs the agent loop and dispatches tools        | Owns sessions, users, and projects            |
| Restricts file tools to the workspace           | Decides where the workspace is                |
| `run_blender`, `inspect_scene`, `preview_asset` | Puts the workspace in the correct state first |
| Holds the 3D system prompt                      | Owns versions, manifests, blobs, and Postgres |
| Emits events                                    | Selects the transport                         |
| Diffs its own workspace                         | Interprets that diff                          |

The product reconciles the workspace. The harness receives a directory that is already correct. The
harness never reconciles anything.

### 5.4 Configuration

`apps/agent` exports one function.

```ts
export async function createStudioAgent(opts: {
  workdir: string
  model?: Model
  onCommit?: (changed: ChangedFiles, workdir: string) => Promise<void>
}) {
  // The conversation lives inside the workspace, and the workspace is the cwd —
  // never the process cwd, which is `apps/agent` under `pnpm agent`.
  const sessionManager = SessionManager.open(
    `${opts.workdir}/.pi/session.jsonl`,
    undefined,
    opts.workdir,
  )

  // Pi builds the session and its cwd-bound services together, in a factory the
  // runtime reuses each time it swaps the session (/new, /resume, /fork).
  const build = async ({ cwd, agentDir, sessionManager }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        systemPrompt: SCENE_BUILDER_PROMPT,
        extensionFactories: [studioExtension(opts.onCommit)],
      },
    })
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      model: opts.model,
      customTools: [runBlender, inspectScene, previewAsset],
    })
    return { ...created, services, diagnostics: services.diagnostics }
  }

  return createAgentSessionRuntime(build, {
    cwd: opts.workdir,
    agentDir: getAgentDir(),
    sessionManager,
  })
}
```

`createStudioAgent` returns pi's runtime, not a bare session. The terminal UI (`pnpm agent`) is pi's
`InteractiveMode`, and it takes only a runtime — the object that owns the session and can swap it for
`/new`, `/resume`, and `/fork`. Pi builds bare sessions and runtimes on separate paths and offers no
way to wrap one in the other, so the harness builds the runtime. It is a superset: a product caller
reads its session as `runtime.session`.

`studioExtension` is the only product seam. It owns the build guard, hashes the workspace, and calls
`onCommit`. Pi does everything else.

`onCommit` is optional. Without it you get a working 3D agent in a terminal. That is the fastest
development loop and the target for integration tests.

The product reads events with `runtime.session.subscribe()`. It intercepts tool calls with
`pi.on('tool_call')`, which can block a call and not only observe it.

`run_blender` is built into the harness. The harness must guarantee a working build at the end of a
run, and it cannot guarantee that through a tool it does not control.

### 5.5 Rules that protect the boundary

1. The harness contains no network clients except model SDKs. All other bytes leave through
   `onCommit`.
2. The harness uses no product words. Its vocabulary is `workdir`, `turn`, `tool`, and `message`.
   Pi's own `session` is generic conversation state and is allowed. If `version` or `project` appears
   in `apps/agent`, something has leaked.
3. Extend pi with tools and extensions. Never patch or fork it. If a requirement seems to need a
   fork, it belongs in `studioExtension`.
4. `onCommit` is awaited and its errors propagate. The harness has no fallback. A failed commit is the
   product's problem.

### 5.6 The terminal UI

`@earendil-works/pi-tui` renders images inline with the Kitty and iTerm2 graphics protocols. Therefore
`pnpm agent` can show each render in the terminal.

This is for development only. The product UI is the Next.js app, which reads `session.subscribe()`.
Make no product decision to suit the terminal UI.

---

## 6. The build guard

Invariant 7 is enforced in the extension. Pi is not modified.

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

Two points control this design:

- **Use `sendMessage`, not `sendUserMessage`.** A message with a `customType` enters the model's
  context but is not attributed to the person. A failed build must never look like a user request.
- **`agent_settled` waits for queued messages.** It fires only when no retry, no compaction, and no
  follow-up remains. The queued follow-up above therefore delays it. The commit runs once per run,
  after the build is good.

---

## 7. Context and images

### 7.1 The problem

Pi removes nothing from context. It has no image limit and no image eviction. Images stay until
compaction removes them by age, and compaction starts only near the context limit.

Pi also stores images as inline base64 in the conversation, with no option to do otherwise. A 3D
agent makes a render on every build. Without action, every render is sent to the model on every
request for the life of the session.

### 7.2 The rule

**Remove images at the end of a run, not at the end of a turn.** During a run the agent must see what
it just built. After the run settles, and before the next user message, each render becomes a stub:

```text
[render — scene.glb from above at v7. Re-run inspect_scene to look again.]
```

The agent keeps the reasoning trail. It knows that it looked, and at what. It does not pay for the
pixels again. A stub costs about 20 tokens. An image costs about 1500.

### 7.3 The mechanism

Pi's `context` event fires before every model call and receives a deep copy of the messages.

```ts
let runStart = 0
pi.on('agent_start', (_e, ctx) => {
  runStart = ctx.sessionManager.getEntries().length
})
pi.on('context', async (event) => ({
  messages: stubImagesBefore(event.messages, runStart),
}))
```

The snapshot at `agent_start` makes the boundary a run and not a turn. Messages from the current run
keep their images. Earlier messages get stubs.

The `context` event does not change the stored session. History stays complete, the UI can show every
render, and rewind is unaffected. Only the model's view is reduced.

### 7.4 `inspect_scene`

The agent can always get a new image. `inspect_scene` takes a camera position, an angle, and a
framing. It returns a screenshot of that view.

Its output is never permanent in context. That is the intent: a cheap repeated tool call is better
than a permanent image in the context window.

Its parameters are not decided yet. Two constraints are decided:

- It must be callable again, not remembered.
- Its parameters must fit in the stub text. The stub is the agent's only remaining handle on a view it
  can no longer see.

### 7.5 Images are never stored

We do not save agent images anywhere. Not as blobs, not in a version, not in the conversation.

They are derivable. Every version stores `scene.glb`. A camera view of a scene is that GLB rendered
from a position, and the browser already does that in the Three.js viewer. Saving the screenshot
would save something we can rebuild from something we already save. Section 9.3 forbids that.

This is also why the stub must carry the tool's parameters. The stub is not only a placeholder for
the model. It is the recipe. `[render — scene.glb from above at v7]` plus the stored GLB for v7
rebuilds the exact view, in the browser, on demand.

Two mechanisms, at two different points:

| Mechanism | Where           | Purpose                                 | Effect on the file        |
| --------- | --------------- | --------------------------------------- | ------------------------- |
| **Stub**  | `context` event | Keep old images out of the model's view | None. Deep copy only.     |
| **Strip** | The sync step   | Keep base64 out of durable storage      | Image blocks are dropped. |

The stub solves token cost. The strip solves storage cost. They are independent, and section 11.3
shows that one mode uses only the first.

**Constraint on `inspect_scene`.** This holds only while the tool's output can be rebuilt from the
GLB and the tool's own parameters. A camera view of the geometry qualifies. A Cycles render with
Blender-only lighting, a wireframe, or a UV layout does not. If the tool ever must return one of
those, store that specific output as a deliberate exception. Do not build a general pipeline for it.

---

## 8. One run

### 8.1 Sequence

```text
1. The product reconciles the workspace to the last committed manifest.
     Safe to repeat. Runs at the START of every run. A crashed process cannot
     clean up after itself, so this is never a failure handler.
2. The product starts the harness over a transport.
3. The extension hashes the workspace           →  manifest A.
4. Pi runs the agent loop: edit source, run Blender, inspect, repeat.
     Each good build swaps the GLB in the viewer. Nothing is committed.
5. agent_end → the build guard runs. On failure it queues a follow-up
     message and the loop continues, which delays settle.
6. agent_settled → the extension hashes the workspace  →  manifest B.
7. onCommit(diff(A, B), workdir) uploads changed blobs, strips image blocks
     out of the conversation, then posts the manifest and the stripped
     conversation together.  Mode A has no onCommit and stops at step 6.
8. The API writes sessions.history and version_files, then the versions row LAST.
```

The commit binds to `agent_settled` and not to `agent_end`. After `agent_end`, pi can still retry,
compact and retry, or drain queued messages. Each of those would produce a version too early.

### 8.2 Failure

Committing a version and saving the conversation are separate operations with different rules.

|                   | Run succeeded | Run failed |
| ----------------- | ------------- | ---------- |
| Version and files | commit        | nothing    |
| Conversation      | save          | save       |

Invariant 7 protects the scene. It says nothing about the conversation, which is a log and not
versioned state. A failed exchange belongs in the log. Without it, the person reloads the page and
their own message has disappeared with the error.

A failed run loses nothing while the sandbox lives. Pi appends to `.pi/session.jsonl` as messages
happen. The file stays on disk and the next run reads it. Data is lost only if the sandbox itself
dies, and then the workspace is gone as well and we restore from the last version.

`agent_settled` is emitted from a `finally` block. It fires on errors, on aborts, and on token
exhaustion. That is why it serves both rows of the table. Two consequences:

- It carries no result. To choose a row, read the `stopReason` of the last assistant message
  (`"error"` or `"aborted"`). Do not assume that settle means success.
- It does not fire if the run never started. A prompt rejected before start emits neither
  `agent_start` nor `agent_settled`. Handle that case at the `prompt()` call site.

Step 1 of the next run restores the workspace to the last good version. No partial scene is ever
visible.

### 8.3 Commit order

Write blobs, then `version_files`, then `versions`. This order is required.

An orphaned blob is garbage and can be collected later. A version row that points at a missing blob
is corruption that the person sees.

---

## 9. Storage

### 9.1 Manifest

A manifest lists every included file in the workspace with its content hash.

```json
{
  "scene.py": { "hash": "a3f2…", "size": 4021 },
  "assets/chair.py": { "hash": "b91c…", "size": 1877 },
  "scene.glb": { "hash": "7d4e…", "size": 41203994 }
}
```

A diff of two manifests gives created, modified, and deleted files. Nothing depends on the agent
reporting its own work. Files that Blender writes as a side effect are caught in the same way as
files a tool wrote.

Blobs are stored at `sessions/<id>/blobs/<sha256>`. A version is a set of path-to-hash pointers.
Therefore unchanged files are never uploaded twice, and a repeated upload is harmless.

The manifest supports three operations. That is its value:

- fill a new sandbox
- restore a version the person selected
- reconcile the workspace at the start of a run

```text
materialize(workspace, manifest):
  for each path in manifest:                    write blob if hash differs
  for each path not in manifest, not excluded:  delete
```

**`materialize()` and the hasher must share one exclusion list.** They are inverses. If the lists
differ, the result is destructive and not merely wasteful.

Example: `.pi/` is excluded from the manifest. A delete pass that does not also exclude it erases the
conversation on every reconcile. That happens at the start of every run, in a sandbox that persists by
default.

### 9.2 What the manifest excludes

Hashing does not cover every file under the workspace. Two categories are skipped:

- **`.pi/`** — the conversation working copy. It is durable state, but it is one growing document that
  syncs to `sessions.history`. It is not snapshotted per version. Hashing it would put a full copy of
  the conversation in every version. A 5 MB session across 50 versions is 250 MB of near-duplicates.
- **Temporary render output** — contact sheets and `inspect_scene` screenshots. These are large and
  can be made again.

This is why a rewind moves two things. `materialize()` restores files. A branch to
`versions.entry_id` restores the conversation. Neither can do the other's work.

Everything else is included by default. An exclusion list fails safe in this direction: a forgotten
exclusion costs storage, but a forgotten inclusion silently loses a file the agent wrote.

### 9.3 What a version stores

| Artifact                       | Stored | Reason                                   |
| ------------------------------ | ------ | ---------------------------------------- |
| `scene.py`, `assets/*.py`      | Yes    | Kilobytes, and must never be lost.       |
| `scene.glb`                    | Yes    | Needed for speed and for accuracy.       |
| `stats.json`                   | Yes    | Small. Shown without reading the GLB.    |
| Full-resolution contact sheets | No     | Agent context. Large. Can be made again. |
| Anything that can be derived   | No     | —                                        |

**Why store the GLB instead of building it again?** Three reasons:

- **Speed.** Browsing versions must feel instant. Booting a sandbox and running Blender is not.
- **Accuracy.** A rebuild months later under a newer Blender is not the scene the person saw.
- **Cost.** Storage is paid once. Compute is paid on every view.

Rebuilding stays available as a repair path if a blob is ever lost.

### 9.4 Conversation storage

The conversation is a `jsonb` column, not a blob.

Pi's session is already a tree, and every branch is in the same document. A rewind is a pointer move
inside that document, not a restored copy. Therefore there is one conversation document per session
that grows over time. There are no per-version snapshots. That removes the usual reason to use object
storage, and `jsonb` adds transactional writes with the version row and SQL over the history.

**This works only if images are stripped first.** Postgres rewrites an entire `jsonb` value on every
update. An untouched pi session reaches tens of megabytes of base64, so every save would rewrite every
render ever taken, for data that nothing queries.

So the sync step deletes image blocks and keeps the stubs. Base64 never reaches Postgres.

Pi's session file is append-only, so we cannot remove the bytes after pi writes them. We do not try.
The file in the workspace keeps its images and dies with the sandbox. The durable copy is the stripped
one. That difference is intended: the working copy is disposable, the durable copy is not.

### 9.5 Data model

```sql
projects(id, user_id, name, sandbox_name, created_at)
sessions(id, project_id, history jsonb, pi_session_id, created_at, updated_at)
versions(id, session_id, n, entry_id, parent_version_id, image_tag, created_at)
version_files(version_id, path, blob_hash, size)
```

- There is no `messages` table. `sessions.history` is the pi session document and the source of truth.
  Anything the UI needs for a list, such as a title or a message count, is derived from it. Never
  write the same fact twice.
- `versions.entry_id` is the pi session entry at which the version was committed. It makes a rewind a
  branch instead of a restore, and it keeps the two trees aligned.
- `versions.image_tag` records the container image that built the version. It cannot be added later,
  and it is the only way a future rebuild can use the original Blender.
- `projects.sandbox_name` joins the database to `Sandbox.getOrCreate({ name })`.

---

## 10. Preview and rewind

Selecting a version is not restoring it. Selecting a version loads that version's stored `scene.glb`
into the viewer. It changes nothing else — no workspace change, no conversation change.

Rewinding is a second, explicit action. It moves two things together:

1. `materialize()` for the workspace.
2. A branch to `versions.entry_id` for the conversation.

Preview is cheap only because the GLB is stored. That is a second benefit of the decision in 9.3.

### 10.1 Compaction does not break the anchor

Pi's sessions are append-only. Compaction appends a summary entry and moves the leaf. It never
deletes, changes, or renumbers earlier entries. Entry IDs are permanent for the life of the session
file, so `versions.entry_id` stays valid after any number of compactions.

A branch to an entry from before a compaction restores the **full, uncompacted** history. Pi rebuilds
context by walking from the new leaf to the root, and the compaction entry is a descendant that is not
on that path. A rewind therefore does not inherit a summary the person did not ask for.

The cost is context, not correctness. Replaying full history can start compaction again at once. That
is a token budget question at rewind time.

Two narrow cases can still invalidate an ID. Neither applies to us:

- Legacy **v1** session files get new IDs during migration. We will never have one.
- Pi's newer harness makes internal IDs of the form `${compactionId}:retained:N`. These never exist in
  a session. Never store one. `versions.entry_id` must only hold an ID read back from a real entry.

---

## 11. Environments

There are three modes. They differ along independent axes: whether a product exists, where the store
points, and where the agent process runs.

|                | A — agent alone            | B — product, local           | C — production              |
| -------------- | -------------------------- | ---------------------------- | --------------------------- |
| Started by     | `pnpm agent`               | the product                  | the product                 |
| Transport      | direct call                | `child_process.spawn`        | `sandbox.runCommand`        |
| `onCommit`     | none                       | `SupabaseCommitHook`         | `SupabaseCommitHook`        |
| Workspace      | `<agent home>/sessions/…`  | product-chosen path          | `/vercel/sandbox/workspace` |
| Blobs          | none                       | local Supabase Storage       | Supabase Storage            |
| Metadata       | none                       | local Postgres               | Postgres                    |
| Conversation   | the file, and nothing else | synced to `sessions.history` | synced, same code           |
| Agent delivery | built bundle               | built bundle                 | OCI image from VCR          |

**B and C run the same code.** They differ by connection string and transport. That is the point of
mode B: the real commit path, the real schema, and the real storage API, on a laptop. `supabase start`
provides Postgres and Storage in containers.

**Mode A has no store at all.** No `onCommit`, therefore no versions, no manifests, and no blobs. It
keeps a workspace in the agent home (11.2) and nothing else. It answers one question: can the agent
build the scene?

**There is one store implementation.** Do not add a file-backed stand-in for local work. A second
implementation would have to be maintained, would never be the one that ships, and would drift from
the real one with nothing to detect it. Mode B keeps the commit path exercised against the real
thing.

`workdir` reaches the harness as an absolute path. `createStudioAgent()` never computes it, never
defaults it, and never infers it from the process. The caller decides, and 11.2 covers what the mode
A caller decides.

### 11.1 The entry point

The entry point is ours. It is not `pi --mode rpc`. It wraps `createStudioAgent()` and emits the
protocol in `packages/shared`. Pi's RPC mode is a usable fallback, but the SDK keeps tool
registration, the build guard, and the commit hook in one process.

In mode A the same entry point is also the caller, so it resolves the workspace path itself. That
makes `cli.ts` a thin product: it may know about homes, slugs, and sessions. The harness beneath it
may not.

### 11.2 The agent home

Mode A keeps its state on the machine, not in a repository.

```text
~/.studio-agent/            override: --home, or STUDIO_AGENT_HOME
  sessions/
    <slug>/
      workspace/            the agent's directory, same shape as the sandbox
        scene.py
        assets/*.py
        scene.glb
        .pi/session.jsonl   conversation, inside the workspace on purpose
```

Precedence is `--workdir` (an absolute path, which bypasses the home entirely), then `--home`, then
`STUDIO_AGENT_HOME`, then the default.

**Sessions are flat, with no namespace per repository.** A coding agent works on your checkout, so it
must group sessions by project. This agent does not. Its workspace is a scratch directory that it
owns, and the scene inside it is the project. The repository you launched from is not part of the
identity of a session, so any session resumes from anywhere.

`<slug>` is human-readable, from `--session <slug>`. You retype it every time you resume, and there
is no session picker to browse instead.

**One home per machine, shared by every checkout and every worktree.** A new Conductor workspace
reaches every past session with nothing copied into it.

The risk that comes with sharing: two workspaces can open the **same** session at once and write the
same `.pi/session.jsonl`. Different slugs never collide, so this needs a lock rather than separate
directories. Pi already depends on `proper-lockfile`; confirm what it protects before relying on it.

Resolve the home from the home directory, never from the process working directory. `pnpm agent` runs
with its working directory set to `apps/agent`, so a relative default lands somewhere surprising and
stays hidden.

### 11.3 Image stripping across the modes

Stripping happens where the conversation crosses into durable storage. Mode A has no such crossing,
so mode A strips nothing. Its session file keeps its images.

Three things make that safe:

- **Token cost is handled elsewhere.** The `context` stub (section 7.3) works on a deep copy before
  every model call. It is independent of storage, so mode A does not re-send old renders either.
- **The disk cost is small and disposable.** A screenshot is a few hundred kilobytes after base64.
  Nothing in the agent home is tracked. Delete the session directory to reclaim it.
- **The strip code stays exercised.** Mode B syncs to real Postgres, so the path runs during ordinary
  development.

Do not give mode A a stripped copy for the sake of symmetry. That is the second store implementation
that section 11 forbids.

### 11.4 Override pi's session directory

Pi writes sessions to `~/.pi/agent/sessions/` by default. That is outside the workspace. The manifest
would not see it, and a new sandbox would start with no memory.

Set it explicitly, with `SessionManager.open(path)` in the SDK, or with `--session-dir` or
`PI_CODING_AGENT_SESSION_DIR` on the CLI.

Set `agentDir` explicitly as well. It holds configuration and not state, but if it is left implicit it
differs between local and sandbox without warning.

### 11.5 Resuming a session

What a resume means depends on the mode.

**Mode A** resumes with `--session <slug>`. The workspace stays on disk in the agent home between
runs, so there is nothing to restore. Resolve the slug, point `SessionManager` at
`<workdir>/.pi/session.jsonl`, and start. The same slug from any checkout reaches the same session.

**Modes B and C** must restore two things, because the workspace may be gone:

```text
1. Read the latest manifest from the store.
2. Materialize the workspace from blobs.   ← product step, BEFORE pi starts
3. Point SessionManager at <workdir>/.pi/session.jsonl.
4. Call createAgentSession().
```

The order is required. Pi's tools resolve paths against `cwd` when they are constructed. If you
materialize after pi starts, the agent reasons about files that changed under it.

Steps 1 and 2 are identical in B and C. Only the connection string differs. Running mode B regularly
is what keeps that path working.

---

## 12. Sandbox delivery

The agent ships as a custom OCI image in the Vercel Container Registry. Build it with
`docker buildx --platform linux/amd64`. Reference it as `Sandbox.create({ image: 'agent:v1' })`.
Blender and the toolchain are in the image. Nothing installs at run time.

Git is not how the agent arrives. A git clone would put a git credential inside an untrusted VM.
Cloning stays available later for a user's own asset repository.

Three facts about Vercel Sandbox:

- `ENTRYPOINT` and `CMD` are ignored for custom images. Start processes with `runCommand()`.
- The default session timeout is 5 minutes. Set it explicitly.
- Sandboxes persist by default. `Sandbox.getOrCreate({ name: 'project-<id>' })` resumes a user's
  filesystem across sessions.

---

## 13. Build and packaging

Nothing in production knows what a pnpm workspace is. Both deployables resolve the workspace during
their build and emit something self-contained. No symlink ever ships.

**The agent.** Its Dockerfile uses the repository root as the build context
(`docker build -f apps/agent/Dockerfile .`), so `packages/shared` is present as real files. esbuild
then follows the symlink and inlines shared code into one `dist/agent.js`. Only that file is copied
into the runtime stage. The final image has no `packages/shared` and no `node_modules`.

**The web app.** Vercel installs from the workspace root, and Next.js output tracing copies shared
code into the deployment.

**If a dependency ships a native `.node` binary that cannot be bundled**, use
`pnpm deploy --filter @repo/agent /out`. It produces a flat directory with real copies.

Dangling symlinks appear only if something skips this step, for example by uploading raw
`apps/agent/` source into a sandbox. Local development therefore ships the built bundle and not raw
source, so local and production cannot differ on this point.

---

## 14. Credentials

- The service role key never enters a sandbox.
- The agent receives short-lived signed upload URLs, scoped to one project prefix.
- The agent receives one per-session callback token.
- Blobs go directly to storage. **Metadata always goes through the API**, which owns every database
  write.

Sandbox egress is billed and ingress is free. Therefore download freely and upload only what changed.

---

## 15. Toolchain

- **pnpm**, not npm. Strict resolution, a shared store, and faster installs.
- **No Corepack.** Node no longer bundles it, and it solves a team synchronization problem that a solo
  project does not have. pnpm is installed standalone. `packageManager` is set by hand because Vercel
  reads it.
- **One `.nvmrc` at the repository root.**
- TypeScript strict, plus `noUncheckedIndexedAccess`. Prettier with the Tailwind plugin. Environment
  variables validated with zod at build time.
- Vercel: root directory `apps/web`, with "include files outside root" enabled.

### 15.1 Where dependencies go

**Runtime dependencies go in one package. Never at the workspace root.**

```bash
pnpm add -Dw <pkg>                      # shared development tools ONLY
pnpm add <pkg> --filter @repo/<name>    # anything imported at run time
```

This is not tidiness. It is what makes invariant 1 enforceable. Node resolution walks up parent
directories, so a package at the root is importable from every package. Put `@supabase/supabase-js` at
the root and `apps/agent` can import it. The boundary is then gone and nothing detects it.

Per-package installs make "the agent has no storage client" a fact about `apps/agent/node_modules`.

Add a dependency when the first line of code imports it. Do not add it in advance.

### 15.2 Each package has its own `node_modules`

pnpm writes real files once into `node_modules/.pnpm` at the root. It then symlinks into each package
only the dependencies that package declared.

```text
node_modules/.pnpm/            real files, one copy per package@version
apps/web/node_modules/         symlinks: next, react, @vercel/sandbox, @repo/shared
apps/agent/node_modules/       symlinks: pi, @repo/shared
```

`apps/agent` cannot import `next`, because `next` is not in its `node_modules`. Two packages can even
depend on different major versions of one library, because `.pnpm` holds both.

What is shared is one install: one resolution pass, one lockfile, one interpreter. Only **native
modules** care about the interpreter, because node-gyp compiles against the Node ABI at install time.
Pure JavaScript packages are unaffected.

### 15.3 Node versions

One development Node version per repository. `nvm` works at the shell level, and one root
`pnpm install` runs under one interpreter. Therefore `apps/web` and `apps/agent` cannot install under
different versions.

Their production runtimes are independent:

|                      | Controlled by                                        | Currently  |
| -------------------- | ---------------------------------------------------- | ---------- |
| Development machine  | root `.nvmrc`                                        | `v24.19.0` |
| `apps/web` in prod   | Vercel project setting, overridden by `engines.node` | 24.x       |
| `apps/agent` in prod | `FROM node:XX` in its Dockerfile                     | —          |

Declare `engines` in every `package.json`, so that a mismatch fails loudly.

**The development pin is Node 24 LTS because Vercel stops there.** As of 2026-08, Vercel builds and
functions offer only 24.x (default), 22.x, and 20.x. Version 20.x is disabled on 2026-10-01.
Development on 26 would target a runtime that `apps/web` cannot deploy to.

Three traps:

- **Vercel ignores `.nvmrc`.** It reads the project setting, overridden by `engines.node` (`"24.x"`).
  The root `.nvmrc` affects local development only. That is why `engines` is load-bearing.
- **Vercel Sandbox is a different runtime from builds and functions.** It does offer Node 26
  (`Sandbox.create({ runtime: "node26" })`, `@vercel/sandbox` 1.10.2 or later). That flag applies to
  stock sandboxes. Our agent ships as a custom image, so its `FROM node:XX` wins and the agent can
  move to 26 on its own.
- **Vercel rolls minor and patch versions inside a major.** An exact `.nvmrc` will therefore fall
  behind the build image. That is expected.

If a native dependency ever forces a split development version, treat that as a signal that the agent
may need its own repository.

---

## 16. Open questions

- Whether a project has one session or many.
- The parameters of `inspect_scene`, limited by having to fit in one line of stub text.
- Whether to keep compaction on. It is on by default (`compaction.enabled`, `keepRecentTokens: 20000`)
  and it is safe for rewind, but it summarizes away detail the agent may need on a long scene. Turning
  it off means reaching the context limit instead.
- Garbage collection for orphaned blobs. They accumulate. A sweep is needed eventually.
- Retention: whether old versions ever drop their GLB and fall back to rebuilding on demand.
- Turborepo. Not needed yet. Add it when builds get slow.
- Whether the studio ever points at a user's own git repository of assets.
