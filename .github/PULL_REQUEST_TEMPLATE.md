## Context

Part of #X <!-- every PR references at least one issue. Use "Resolves: #X" instead only if merging this PR finishes it. -->
Stack: <!-- e.g. "2 of 4 — builds on #12". Delete this line if the PR is standalone. -->

## Description

<!-- Brief description of the change and why it's needed. Each PR should be short and contain a single logical change. -->

## Screenshots

<!-- Include for UI changes in apps/web (before/after, GIF, or video). Write "N/A" if not applicable. -->

## How to Test

<!-- Steps to verify this works locally. -->
<!-- Additionally list out test cases added as part of this PR. Write a short, concise, simple to understand sentence for each test relaying what functionality/edgecase/piece that test is testing.-->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
- [ ] `pnpm format` run (no diff)
- [ ] Runtime deps added per-package (`pnpm add <pkg> --filter @repo/<name>`), never at the workspace root
- [ ] No `apps/web` → `apps/agent` imports
- [ ] No "session", "user", "version", or "project" concepts leaked into `apps/agent` types
- [ ] `packages/shared` still holds only schemas/types, no runtime logic
- [ ] No secrets or `.env` values committed
- [ ] If stacked: this layer is independently reviewable and `pnpm typecheck` passes at this layer, not just at the top of the stack
