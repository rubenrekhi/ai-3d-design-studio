# Agent implementation plan

Scope: `apps/agent` only. Nothing here needs `apps/web` to exist.

`ARCHITECTURE.md` at the repo root is the design authority. This file is the order to build it in.

## Dependency map

```text
P1 pi wire-up ──┐
                ├──→ P4 tools ──→ P5 build guard ──┬──→ P7 commit hook ──→ P9 protocol
P2 Blender ─────┘                                  └──→ P8 image lifecycle
     │
     └──→ P6 agent image

P3 hashing ────────────────────────────────────────────→ P7
```

| Wave | Phases     | Parallel                           |
| ---- | ---------- | ---------------------------------- |
| 1    | P1, P2, P3 | All three. No shared files.        |
| 2    | P4         | —                                  |
| 3    | P5, P6     | Yes. P6 needs only P2.             |
| 4    | P7, P8     | Yes, but both edit `extension.ts`. |
| 5    | P9         | —                                  |

Wave 1 is the one worth splitting across parallel workspaces. P1 touches pi and no Blender, P2
touches Blender and no pi, P3 touches neither.

---

## Wave 1

### P1 — pi wire-up · ~half day

- [x] Add the dependency, pinned exact: `@earendil-works/pi-coding-agent@0.83.0`
- [x] Replace the placeholder `cli.ts` with `createStudioAgent()`
- [x] Point `SessionManager.open()` at `<workdir>/.pi/session.jsonl`
- [x] Resolve the agent home: `--workdir` beats `--home` beats `STUDIO_AGENT_HOME` beats
      `~/.studio-agent`
- [x] `--session <slug>` resolves to `<home>/sessions/<slug>/workspace`
- [x] No custom tools, no prompt override, no extension yet

**Verify.** `pnpm agent --session t1`, hold a conversation, then confirm
`~/.studio-agent/sessions/t1/workspace/.pi/session.jsonl` exists and grows. Quit, rerun with the same
slug, and confirm the agent remembers the conversation.

That check is the point of the phase. It proves the session directory override works. Pi defaults to
`~/.pi/agent/sessions/`, and every later phase assumes the file sits inside the workspace instead.

Do not resolve paths relative to the process. `pnpm agent` runs with the working directory set to
`apps/agent`, not the repository root, so a relative default lands somewhere surprising and stays
hidden.

**Why first.** If pi's SDK does not behave as documented, every later phase rests on it. Find out in
half a day.

### P2 — Blender bridge · ~1 day

- [ ] `src/blender.ts`, with no pi import anywhere in it
- [ ] `runBlender(workdir, opts) → { ok, stdout, stderr, durationMs }`
- [ ] Resolve the binary from `BLENDER_PATH`, falling back to the macOS app bundle path
- [ ] Invoke `blender --background --python scene.py`
- [ ] Timeout with a hard kill
- [ ] Decide the **scene contract**: `scene.py` writes `scene.glb` into the workdir
- [ ] Decide whether a bpy helper module ships in the image, or the agent writes raw bpy

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

- [ ] `run_blender` — wrap P2 with `defineTool`
- [ ] `inspect_scene` — camera position, angle, framing → render → image content
- [ ] Keep the render plain geometry, not Cycles, so output stays rebuildable from the GLB
- [ ] A minimal system prompt. Do not polish it yet.

**Verify.** "Make a red cube on a plane" produces `scene.glb`. Then break it deliberately: point
`BLENDER_PATH` at nothing and confirm the tool returns an error the model can read, rather than
crashing the process.

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

- [ ] `--workdir` and `--session` flags
- [ ] Emit JSONL events from `session.subscribe()`
- [ ] Zod schemas in `packages/shared`

**Verify.** Pipe stdout to a file. Assert every line parses as JSON and validates against the schema.

Split records on `\n` only. Node's `readline` also splits on U+2028 and U+2029, which are legal
inside JSON strings, so it is not safe for this protocol.

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

**`preview_asset` is unspecified** (P4). It appears in the tools list and the boundary table in
`ARCHITECTURE.md` and is defined nowhere. Either specify it or drop it from v1.

## Deferred

Subagents, compaction tuning, TUI customization, VCR push. None block the critical path, and the
first two are cheaper to decide after watching the agent run for a while.
