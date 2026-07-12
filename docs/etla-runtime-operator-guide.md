# Etla Runtime Operator Guide

This guide covers model assignment, autonomous coding approval, and execution monitoring.

## Role model assignment

Etla Runtime has four independently configurable model slots:

| Role | Responsibility | Recommended model behavior |
| --- | --- | --- |
| Host | User-facing synthesis and final explanation | Strong instruction following and Indonesian quality |
| Worker | Planning, repository inspection, patch generation, and bounded revisions | Strong coding and structured JSON reliability |
| Verifier | Independent answer and evidence quality gate | Reliable critique, grounding, and consistency |
| Boss | Rare high-risk or unresolved judgment | Premium reasoning; low call frequency |

Run the interactive setup wizard:

```bash
cd /root/openclaw-projects/zenos-runtime
npm run runtime:setup
```

The default slot aliases are:

```text
Host     = grok
Worker   = build
Verifier = grok
Boss     = codex
Provider = etla-router
```

Set one slot directly:

```bash
npm run runtime:config -- role host grok --provider etla-router
npm run runtime:config -- role worker build --provider etla-router
npm run runtime:config -- role verifier grok --provider etla-router
npm run runtime:config -- role boss codex --provider etla-router
```

Inspect effective configuration without exposing API keys:

```bash
npm run runtime:config -- show
npm run runtime:config -- doctor
npm run runtime:config -- secure
```

Legacy aliases remain supported:

```bash
npm run runtime:config -- /hmodel grok
npm run runtime:config -- /wmodel build
npm run runtime:config -- /vmodel grok
npm run runtime:config -- /bmodel codex
```

Global configuration is stored with mode `0600` at:

```text
/root/.hermes/profiles/zenos/zenos-runtime.json
```

Configuration precedence is:

```text
built-in
→ environment
→ global Runtime config
→ per-session config
→ inline request override
```

A new Runtime run reads the latest file configuration. A service restart is only needed after changing service-level environment variables.

## Autonomous coding behavior

For coding and debugging requests with `workspaceRoot`, Runtime prepares repository intelligence automatically.

`autonomousCoding` defaults to `true`, but mutation remains approval-gated:

```json
{
  "request": "fix the TypeScript bug and validate it",
  "intent": "mutate",
  "hasFiles": true,
  "hasCodeChangeIntent": true,
  "workspaceRoot": "/absolute/repository/path",
  "autonomousCoding": true,
  "approvalGranted": true
}
```

Without `approvalGranted`, Runtime may plan, search, and inspect, but it must stop before `repo.patch`.

The bounded loop is:

```text
Host opens task
→ Worker produces structured plan
→ deterministic repo.read/repo.search
→ Worker produces exact replacement patch
→ repo.patch
→ minimal-patch policy
→ targeted validation
→ failure-specific bounded revision
→ full validation
→ remote-required boundary for full build
→ Host execution receipt
```

Full builds are never forced on the VPS. `build.run` returns `remote_required` until the GitHub remote dispatcher is implemented.

## Monitoring real execution

Watch the newest session:

```bash
npm run runtime:watch
```

Watch a specific session:

```bash
npm run runtime:watch -- <session-id>
```

Print one snapshot and exit:

```bash
npm run runtime:watch -- <session-id> --once
```

The watcher reads persisted SQLite records and reports:

- active Host, Worker, Verifier, and Boss models;
- session status and token counters;
- role progress events;
- tool names and statuses;
- coding task phase;
- changed files;
- targeted/full validation state;
- remote validation boundary.

The Runtime homepage on port `3090` also shows safe model configuration and recent persisted execution status. It never displays API keys.

The session SSE endpoint now emits individual `activity` events in addition to full session snapshots:

```text
GET /api/runtime/stream/:sessionId
```

Every coding response can include a deterministic Runtime execution receipt showing:

```text
Host model and call count
Worker model and call count
Verifier verdict
Boss invoked or skipped
real tools called and their statuses
coding task state and changed-file count
```

The receipt is assembled from persisted model/tool evidence, not from model self-reporting.
