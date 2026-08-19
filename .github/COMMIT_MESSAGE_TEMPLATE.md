# Commit Message Format

```
<type>(<scope>): <short imperative summary>
```

| Segment     | Purpose                                      | Rules                                                          |
| ----------- | -------------------------------------------- | -------------------------------------------------------------- |
| **type**    | Categorises the change                       | lowercase; choose from the list below                          |
| **scope**   | Pin-points where the change lives (optional) | 1-3 words, snakecase, e.g. `web`, `agent`, `shared`, `harness` |
| **summary** | Explains what the commit does                | start with a verb, keep under 72 chars, no period              |

## Allowed `type` keywords

- **feat** – a new user-facing feature
- **fix** – a bug fix
- **docs** – documentation only (README, ARCHITECTURE.md, AGENTS.md)
- **refactor** – code change that neither fixes a bug nor adds a feature
- **test** – adding or updating tests
- **chore** – tooling, build, or maintenance tasks (CI, dependency bumps, formatting)

## Writing guidelines

- Use the present-tense imperative: _add_, _update_, _remove_.
- Limit the first line to 72 characters; wrap additional detail in a body after a blank line.
- Reference issues in the body (`Refs: #12`), not in the summary.
- Avoid generic scopes like _misc_; if nothing fits, omit the scope.

## Examples

```
feat(agent): add scene-graph diff tool
fix(web): handle empty project list on dashboard
docs(architecture): clarify VCR image storage decision
refactor(shared): simplify wire protocol schema
chore(ci): bump Node version to 24
test(agent): add unit tests for harness tool calls
```

## Optional body and footer

```
feat(web): stream agent tool calls to the session view

Subscribe to the agent's tool-call events over the existing
Vercel Sandbox connection and render them incrementally instead
of waiting for the full turn to finish.

Refs: #18
```
