# Zenos Runtime Security

## Supported deployment

Zenos Runtime v0.2 is designed for one active process on a trusted Linux VPS, bound to loopback and exposed only through a configured reverse proxy or trusted local clients.

Production must configure at least one of:

- `ZENOS_RUNTIME_API_KEY`
- `ETLA_MASTER_SECRET`

The service refuses unauthenticated production operation.

## Authentication methods

### Dedicated Runtime API key

Use for trusted local operators and simple service integrations:

```text
Authorization: Bearer <ZENOS_RUNTIME_API_KEY>
```

The Zenos Memory API key is not accepted as a Runtime credential.

### Scoped bearer token

Administrators can mint a short-lived `zrt2` token through `/api/runtime/token`. Tokens include:

- subject/client identity;
- operation scopes;
- issue and expiry times;
- a unique token nonce;
- HMAC-SHA256 integrity.

A token scoped to `runtime:read` cannot call `runtime:run` or mutate model settings.

### HMAC v2

Trusted service clients should sign the exact request envelope:

```text
v2
<timestamp milliseconds>
<unique nonce>
<HTTP method>
<path plus query>
<SHA-256 request body>
<operation scope>
<client identity>
```

Required headers:

```text
x-etla-timestamp
x-etla-nonce
x-etla-body-sha256
x-etla-signature
x-etla-scope
x-etla-client
```

The nonce is transactionally persisted and rejected if replayed. The timestamp must be inside the configured skew window. Production systemd disables legacy path-only HMAC.

## Route scopes

- `runtime:read`
- `runtime:route`
- `runtime:run`
- `runtime:session`
- `runtime:worker`
- `runtime:models`
- `runtime:metrics`
- `runtime:admin`
- `*` for trusted administration only

## Secret handling

- Runtime API responses never return configured model keys.
- Structured logs redact credential-shaped strings and sensitive field names.
- Zenos Memory recall requests explicitly exclude secret memories.
- Runtime does not store raw credentials in session or route-event metadata.
- `.env.local`, Hermes model configuration, and SQLite state must remain outside public artifacts.
- Per-session model configuration files are written atomically with mode `0600`.

## Request protections

Operational routes enforce:

- authentication and operation scope;
- token-bucket rate limiting;
- maximum body sizes;
- strict Zod schemas;
- non-cacheable responses;
- request IDs;
- idempotency for pipeline runs;
- model timeout, retry, response-size, and circuit-breaker limits.

## Action safety

Runtime does not itself run shell commands, deploy services, or edit repositories. It governs model output and external worker events. Critical action requests:

- route through premium Host, Verifier, and Boss policy;
- are marked as requiring approval;
- cannot be represented as completed merely because a model produced text;
- remain advisory unless the calling integration separately performs an authorized action.

## Persistence boundary

SQLite WAL protects single-node state transitions. It is not a distributed consensus system. Do not run multiple writable Runtime replicas against copied local databases. A multi-node deployment requires a shared transactional database and distributed nonce, rate-limit, idempotency, and queue infrastructure.

## Reporting

When reporting a vulnerability, include:

- affected endpoint and version;
- reproducible request shape with secrets removed;
- expected and observed behavior;
- impact;
- relevant request ID or redacted log line.

Never include live credentials, private model prompts, or user memory content in a public issue.
