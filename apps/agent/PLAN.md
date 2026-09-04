# Agent implementation plan

Scope: `apps/agent` only. Nothing here needs `apps/web` to exist.

`ARCHITECTURE.md` at the repo root is the design authority. This file is the order to build it in.

## Dependency map

```text
P1 pi wire-up ──┐
                ├──→ P4 tools ──→ P5 build guard ──┬──→ P7 commit hook ──→ P9 protocol
P2 Blender ─────┘                                  └──→ P8 image lifecycle       │
     │                                                                           │
     └──→ P6 agent image                                       P10 subagents ←───┘

P3 hashing ────────────────────────────────────────────→ P7
```

| Wave | Phases     | Parallel                           |
| ---- | ---------- | ---------------------------------- |
| 1    | P1, P2, P3 | All three. No shared files.        |
| 2    | P4         | —                                  |
| 3    | P5, P6     | Yes. P6 needs only P2.             |
| 4    | P7, P8     | Yes, but both edit `extension.ts`. |
| 5    | P9         | —                                  |
| 6    | P10        | — Optional. Nothing depends on it. |

Wave 1 is the one worth splitting across parallel workspaces. P1 touches pi and no Blender, P2
touches Blender and no pi, P3 touches neither.

---

## Wave 1

### P1 — pi wire-up · ~half day

- [x] Add the dependency, pinned exact: `@earendil-works/pi-coding-agent@0.83.0`
- [x] Replace the placeholder `cli.ts` with `createStudioAgent()`
- [x] Set pi's session directory to `<workdir>/.pi` **explicitly**, so conversations live in the
      workspace and pi creates new ones there
- [x] Resolve the agent home: `--workdir` beats `--home` beats `STUDIO_AGENT_HOME` beats
      `~/.studio-agent`
- [x] `--project <name>` resolves to `<home>/projects/<name>/workspace`, created if absent
- [x] Validate `<name>` against `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$` before it becomes a
      path
- [x] No custom tools, no prompt override, no extension yet

**Verify.** `pnpm agent --project t1`, hold a conversation, then confirm a `<timestamp>_<id>.jsonl`
appears under `~/.studio-agent/projects/t1/workspace/.pi/` and grows. Quit, rerun with the same name,
and confirm you land in a **new** conversation with the same workspace. Then `/resume` inside the TUI
and confirm it lists the first one and nothing from any other project.

That check is the point of the phase, and `/resume` is the sharp end of it. Pi's selector lists
`SessionManager.list(cwd, sessionDir)`, so if the directory override did not take, it shows the
machine's sessions instead of this project's. Pi defaults to `~/.pi/agent/sessions/<encoded-cwd>/`,
and every later phase assumes conversations sit inside the workspace instead.

Do not resolve paths relative to the process. `pnpm agent` runs with the working directory set to
`apps/agent`, not the repository root, so a relative default lands somewhere surprising and stays
hidden.

**Why first.** If pi's SDK does not behave as documented, every later phase rests on it. Find out in
half a day.

### P2 — Blender bridge · ~1 day

- [x] `src/blender.ts`, with no pi import anywhere in it
- [x] `runBlender(workdir, opts) → { ok, stdout, stderr, durationMs }`
- [x] Resolve the binary from `BLENDER_PATH`, falling back to the macOS app bundle path
- [x] Invoke `blender --background --python-exit-code 1 --python scene.py`
- [x] Timeout with a hard kill
- [x] Decide the **scene contract**: `scene.py` writes `scene.glb` into the workdir
- [x] Decide whether a bpy helper module ships in the image, or the agent writes raw bpy

**Decided.**

- **`ok` cannot trust Blender's exit code.** Under `--background --python`, Blender exits `0` even on a
  `SyntaxError` or an unhandled exception. `--python-exit-code 1` turns a Python failure into a nonzero
  exit; that flag is the only reason `ok` can mean "the build succeeded." Verified on 4.5.11 LTS.
- **Scene contract.** `runBlender` runs with `cwd` at the workdir and the script path resolved against
  it, so `scene.py`'s relative `export_scene.gltf(filepath="scene.glb")` lands in the workdir.
  `opts.script` defaults to `scene.py`; `inspect_scene` (P4) reuses the same primitive with a render
  script.
- **Raw bpy, no helper module in v1.** `scene.py` is the asset (invariant 5) and stays self-contained.
  The glTF export is one teachable line. Add a helper only if the model later drifts on export
  settings — it is a pure addition when it is needed.

**Verify.** Three cases, none of which involve a model:

1. A hand-written cube `scene.py` produces `scene.glb` over 1 KB.
2. A syntax error returns `ok: false` with stderr worth reading.
3. An infinite loop is killed at the timeout.

**Why it carries the risk.** Everything downstream assumes builds are fast and their failures are
legible. Both assumptions are cheap to test now and expensive to discover later.

### P3 — workspace hashing · ~half day

- [ ] `src/manifest.ts` — `hashTree(workdir)`, `diff(a, b)`
- [ ] The exclusion list: `.pi/`, render output
- [ ] Add vitest — this is the first code worth unit-testing

**Verify.** Temp directory, hash, mutate, hash, assert created / modified / deleted. Add one test
asserting `.pi/` never appears in a manifest.

That exclusion is load-bearing. `materialize()` deletes anything absent from the manifest, so if the
two lists ever drift, a reconcile erases the conversation.

---

## Wave 2

### P4 — tools and the first real loop · ~1 day

- [x] `run_blender` — wrap P2 with `defineTool`
- [x] `inspect_scene` — camera position, angle, framing → render → image content
- [x] `preview_asset` — build one `assets/<name>.py` alone → contact sheet
- [x] Keep the render plain geometry, not Cycles, so output stays rebuildable from the GLB
- [x] A minimal system prompt. Do not polish it yet.

**Decided.**

- **`preview_asset` builds one asset module alone and shows it from four sides.** It answers "is
  this well made"; `inspect_scene(framing: "Chair")` answers "does this sit right in the room". The
  sheet is four image blocks in one result at 400×300, not a composited grid —
  `AgentToolResult.content` is `(TextContent | ImageContent)[]`, so that costs the same ~640 tokens
  and needs no pixel work.
- **The asset contract is `build()`, and the harness supplies the rest.** `assets/<name>.py` defines
  `build()`, callable with no arguments, which creates objects in whatever scene is open and neither
  resets nor exports. The preview script imports the module, calls it in an empty scene, exports,
  then renders that export — so the agent judges what `scene.py` will actually get. An
  `if __name__ == "__main__"` block in every asset would have been boilerplate the model must
  remember, with a scratch export path hardcoded in its own source.
- **`scene.py` needs `sys.path.insert(0, dirname(abspath(__file__)))`.** Verified on 4.5.11: Blender
  puts neither the cwd nor the script's directory on `sys.path`, so without it an `assets` import
  fails with `No module named 'assets'`. The prompt teaches it; the preview script does it itself.
- **`__pycache__` is excluded at any depth.** Importing an asset makes Python write bytecode beside
  it, which is derivable and churns on every build. Blender ignores `PYTHONDONTWRITEBYTECODE`
  (it sets `Py_IgnoreEnvironmentFlag`), so the manifest is the only lever. That split
  `EXCLUDED_ROOT_DIRS` from `EXCLUDED_DIRS` in `packages/shared`.
- **`inspect_scene` takes `azimuth`, `elevation`, and `framing`.** The camera orbits what it frames,
  points at it, and computes its own distance from the bounding sphere, so the agent picks a
  direction rather than a position — the only form it can pick well, never having seen the scene.
  All three fit in one line of stub text. `ARCHITECTURE.md` 7.4 has the table.
- **It renders `scene.glb`, not the live scene**, at 800×600 through Workbench. That is what keeps
  7.5 true: the image is the stored GLB seen from three numbers, so the browser rebuilds it and
  nothing is saved. Workbench needs no lights of its own, and its material colours come through the
  glTF import intact.
- **The render script is written into `.renders/` on each call**, because the agent bundles to one
  file and Blender needs a real path. The directory is already excluded from manifests, so the
  script, its parameters, and the PNG are never committed.
- **Scratch files are named for the tool call and deleted afterwards.** Fixed names would have two
  concurrent renders read each other's parameters, and the failure is silent — both calls return one
  call's image rather than erroring. The script finds its parameters by swapping its own extension,
  so it stays a constant. Nothing is parallel yet; P4 is where the collision would be built in.
  Only the GLB the preview built is scratch: on the `inspect_scene` path it is `scene.glb`, which the
  manifest tracks and the rest of the run depends on.
- **No `bash`.** The tool list is an allowlist. `bash` is the one tool that would let the model run
  Blender out of the harness's sight and take invariant 7 with it.
- **`run_blender` takes no parameters.** `scene.py` is the scene, and a script parameter would build
  GLBs at paths `inspect_scene` cannot look at.

**Verify.** "Make a red cube on a plane" produces `scene.glb`. Then break it deliberately: point
`BLENDER_PATH` at nothing and confirm the tool returns an error the model can read, rather than
crashing the process.

For the asset half, ask for something built from a module and confirm the workspace hashes to
`scene.py`, `scene.glb`, and `assets/*.py` — and nothing else.

**Milestone.** This is a working 3D coding agent in a terminal. Everything after it is about
connecting to the product.

---

## Wave 3

### P5 — extension scaffold and build guard · ~half day

- [ ] `src/extension.ts` exporting `studioExtension(onCommit)`
- [ ] `agent_end` → run Blender → on failure, inject the error and let the loop continue

```ts
pi.sendMessage(
  { customType: 'build-error', content: build.stderr, display: true },
  { deliverAs: 'followUp', triggerTurn: true },
)
```

**Verify** without depending on the model to write bad code. Pre-write a broken `scene.py`, prompt
something trivial such as "say hi", then assert:

- the guard fires and the agent receives the error
- `agent_settled` fires exactly once, and only after the build is green
- the injected message is not attributed to the user

### P6 — agent image · ~1 day · parallel with P5

- [ ] Dockerfile with Blender baked in
- [ ] Build context at the repo root, so `packages/shared` is present as real files
- [ ] esbuild bundles to a single `dist/agent.js`

**Verify.** `docker run --rm agent:dev blender --version`, then run the bundled agent against a
mounted workdir and confirm a build works inside the container.

---

## Wave 4

Both phases add hooks to the file P5 created. Different hooks, no logical overlap, but the same
file — coordinate or sequence them if running parallel workspaces.

### P7 — commit hook · ~half day

- [ ] `agent_start` → manifest A
- [ ] `agent_settled` → manifest B → `onCommit(diff(A, B), workdir)`
- [ ] Read `stopReason` from the last assistant message to tell success from failure

**Verify.** Pass a logging `onCommit`. Assert it fires once per run with the right change set, and
that a killed run commits nothing.

### P8 — image lifecycle · ~half day

- [ ] Snapshot the entry index at `agent_start`
- [ ] `context` hook stubs images from earlier runs
- [ ] Stub text carries the `inspect_scene` parameters

**Verify.** Three inspections in run 1, then start run 2. Dump what `context` returns and assert
run-1 images are stubs while run-2 images are intact. Compare token counts.

---

## Wave 5

### P9 — protocol and CLI · ~1 day

The command line half depends only on P1 and shipped with it. The protocol half is what waits for
P7: the events worth emitting are tool calls, build results, and commits, so writing the schema
before those exist means guessing at shapes and revising `packages/shared` once per phase.

- [x] `--session <id>` — resolve against `<workdir>/.pi/` with `SessionManager.list()`, matching an ID
      or a prefix, and reporting the candidates when a prefix is ambiguous
- [x] Reject `--session` without `--project` or `--workdir`
- [x] Pass the resolved file to `createStudioAgent({ workdir, sessionFile })`
- [x] The no-flag scaffolding flow
- [x] Fall back to the usage error when stdin is not a TTY
- [ ] Emit JSONL events from `session.subscribe()`
- [ ] Zod schemas in `packages/shared`

**Verify.** Pipe stdout to a file. Assert every line parses as JSON and validates against the schema.

Split records on `\n` only. Node's `readline` also splits on U+2028 and U+2029, which are legal
inside JSON strings, so it is not safe for this protocol.

Then verify the two axes hold together: run twice against one `--project` with no `--session`, and
confirm two files in `.pi/` and one workspace. Resume the first by ID and confirm `/resume` in the TUI
lists both. `ARCHITECTURE.md` 11.1 has the full flag table and the flow.

---

## Wave 6

### P10 — asset subagents · ~1 day · optional

Nothing depends on this. It is the one phase the product could ship without, and it is here because
P4 built the half the agent already uses alone.

- [ ] A `spawn_asset_builder` tool registered by `studioExtension`
- [ ] Build subagents in-process, never as a spawned `pi`
- [ ] A narrower asset-builder prompt and tool set
- [ ] `executionMode: 'parallel'` on the tool, so several assets are shaped at once

**Why it waits for P5 and P7.** Asset modules multiply the ways a scene can break, and the build
guard is what makes invariant 7 true. Subagents also sit inside one run, so P7 still sees one user
message and writes one version — that composes only once P7 exists to check it against.

**In-process is not a preference.** Pi's own `subagent/` example spawns a separate `pi` process per
task, which would get pi's default prompt and tools rather than ours — an agent outside the harness,
with no `run_blender` and no build guard. Build them on `createAgentSessionFromServices` with
`SessionManager.inMemory(workdir)` instead, an asset-builder prompt, and a tool set of
`read`/`write`/`edit` plus `preview_asset`. No `run_blender`: a subagent has no business building the
whole scene.

**Why it is worth doing at all.** 7.1's problem, from the other end. A subagent's dozen contact
sheets never enter the parent's context; the parent gets back one line naming the module and its
`build()` signature, and pays for that instead of the pixels.

**Verify.** Two assets built at once, then assert the parent's conversation holds no image from
either, and that `.renders/` is empty afterwards. The scratch-file naming P4 settled is what makes
the parallel case safe; this is the phase that first depends on it.

---

## Decisions this plan will force

**`onCommit`'s signature is incomplete** (P7). `ARCHITECTURE.md` gives `(changed, workdir)`, but
invariant 2 says the conversation also leaves through `onCommit`, and the run sequence has it posting
the conversation. Stripping images means parsing pi's message format, which is harness knowledge, so
the harness should strip and pass the conversation through. Likely becomes
`({ changed, conversation, workdir })`.

**The exclusion list needs a home** (P3). The hasher lives here; `materialize()` lives in `apps/web`;
the two must never drift. `packages/shared` is schemas and types only, but a `const` array of globs
is data rather than runtime logic, so it probably belongs there. Decide deliberately.

## Deferred

Compaction tuning, TUI customization, VCR push. None block the critical path, and the first is
cheaper to decide after watching the agent run for a while.

### Asset subagents

`preview_asset` shipped in P4, which is the half of this the agent uses alone. Parallel subagents
building an asset each is the other half, and it waits for P5 and P7: asset modules multiply the ways
a scene can break, and the build guard is what makes invariant 7 true.

- **They must be built in-process.** Pi's own `subagent/` example spawns a separate `pi` process per
  task, which would get pi's default prompt and tools rather than ours — an agent outside the
  harness. Build them on `createAgentSessionFromServices` with `SessionManager.inMemory(workdir)`, an
  asset-builder prompt, and a tool set of `read`/`write`/`edit` plus `preview_asset` — no
  `run_blender`, since a subagent has no business building the whole scene.
- **The payoff is 7.1's problem.** A subagent's dozen contact sheets never enter the parent's
  context; it gets back one line naming the module and its `build()` signature.
- **Turning on `executionMode: 'parallel'` is what makes this real**, and the scratch-file naming
  P4 settled is what makes that safe.
