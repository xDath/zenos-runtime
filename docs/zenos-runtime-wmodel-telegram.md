# `/wmodel` Telegram Contract

`/wmodel` manages model slots per Runtime session by default.

## Main Menu

When user sends `/wmodel`, Hermes/Telegram should call:

```text
GET /api/runtime/models?sessionId=<current-runtime-session-id>
```

Render inline buttons:

```text
Host: <hostModel>
Worker: <workerModel>
Boss: <bossModel>
Verifier: <verifierModel>
SAVE
```

## Slot Selection

When user taps `Host`, `Worker`, `Boss`, or `Verifier`:

1. Store selected slot in callback state.
2. Show the existing `/model` provider/model picker UI.
3. When a model is selected, update draft state only.
4. Return to the main four-slot menu.

## Save

When user taps `SAVE`, call:

```text
POST /api/runtime/models?sessionId=<current-runtime-session-id>
```

Body:

```json
{
  "hostModel": "...",
  "hostProvider": "...",
  "workerModel": "...",
  "workerProvider": "...",
  "bossModel": "...",
  "bossProvider": "...",
  "verifierModel": "...",
  "verifierProvider": "..."
}
```

The Runtime persists session overrides and applies them over global defaults.

## Scope Rules

- Default scope is **per session**.
- Global defaults are changed only when the client explicitly calls without `sessionId` or uses CLI `--global`.
- Session overrides are stored separately under the Runtime session model store.

## CLI Equivalent

Show current session models:

```bash
ZENOS_RUNTIME_SESSION_ID=<sessionId> npm run wmodel
```

Update current session models:

```bash
npm run wmodel -- --session <sessionId> "host:grok --provider etla; worker:gemini --provider etla; boss:gpt --provider openai; verifier:gpt --provider openai"
```

Update global defaults:

```bash
npm run wmodel -- --global "host:grok --provider etla; worker:gemini --provider etla; boss:gpt --provider openai; verifier:gpt --provider openai"
```
