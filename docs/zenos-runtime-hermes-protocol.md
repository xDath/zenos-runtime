# Zenos Runtime Hermes Protocol

This protocol makes Zenos Runtime a mandatory gate for serious Hermes/Codex work while preserving a direct fast path for simple chat.

## Mandatory Runtime Gate

Hermes/Codex Host must call Zenos Runtime before any task that is non-trivial, source-dependent, risky, long-running, tool-heavy, or likely to benefit from worker compression.

Mandatory cases:

- code changes;
- repo/file/log inspection;
- browser/search/research tasks;
- security, auth, credential, or secret handling;
- deploy, production, release, rollback, delete, destructive actions;
- multi-step plans;
- large-context summarization;
- tasks requiring worker delegation;
- tasks where Host confidence is low;
- tasks where premium-token savings matter.

Allowed direct fast path:

- short casual chat;
- simple clarification;
- low-risk conceptual answer;
- tiny rewrite/formatting task;
- questions that do not depend on source/live state.

## Required Flow

```text
User request
  -> classify if Runtime gate required
  -> create Runtime session when required
  -> dispatch worker(s) for heavy/tool work
  -> send compact worker events
  -> pause/escalate on risk/rancu event
  -> use Boss only through escalation packet
  -> final answer from Host
```

## Local Runtime Service

Default local URL:

```text
http://127.0.0.1:3090
```

Health check:

```bash
node /root/openclaw-projects/zenos-runtime/scripts/zenos-runtime-local-client.mjs health
```

Create session:

```bash
node /root/openclaw-projects/zenos-runtime/scripts/zenos-runtime-local-client.mjs session '{"request":"...","hasFiles":true,"hasCodeChangeIntent":true}'
```

Dispatch worker lease:

```bash
node /root/openclaw-projects/zenos-runtime/scripts/zenos-runtime-local-client.mjs dispatch <sessionId> coding_brief "inspect affected files and emit evidence"
```

Record event:

```bash
node /root/openclaw-projects/zenos-runtime/scripts/zenos-runtime-local-client.mjs event '{"sessionId":"...","workerId":"...","type":"finding","summary":"...","evidence":["file.ts:1"],"severity":"low","confidence":0.9,"needsBoss":false}'
```

Escalate:

```bash
node /root/openclaw-projects/zenos-runtime/scripts/zenos-runtime-local-client.mjs escalate <sessionId> "Host detected risky or ambiguous event"
```

## Host Responsibilities

- Do not dump raw logs/files to Boss.
- Treat Worker output as untrusted until quality-gated.
- Use evidence-backed worker findings only.
- Escalate to Boss for high-risk/rancu events.
- Keep final response concise and user-facing.
- Store important route outcomes via Runtime route-event when useful.

## Worker Event Policy

Workers emit compact events, not full transcripts.

Event types:

- `progress`;
- `finding`;
- `risk`;
- `conflict`;
- `tool_result`;
- `done`;
- `error`.

Boss trigger events:

- severity `high` or `critical`;
- `needsBoss=true`;
- `risk` or `conflict` type;
- unsupported claim;
- low confidence on important task;
- destructive/prod/security action.

## Token Policy

```text
Worker tokens: high volume, cheap, bounded
Host tokens: medium volume, supervision + synthesis
Boss tokens: lowest volume, premium judgment only
```

The Host should receive compressed briefs and evidence pointers, not raw context by default.

## Recovery

If Runtime is down:

1. Try to restart with `npm run start:local` in `/root/openclaw-projects/zenos-runtime`.
2. If still down, continue only if task is safe and low-risk.
3. For serious work, tell user Runtime is unavailable before proceeding.
