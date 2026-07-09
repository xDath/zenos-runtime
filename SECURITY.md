# Security Policy

Zenos Runtime is designed to be safe as a public orchestration repository while keeping credentials and runtime data private.

## Public Repository Policy

This repository must not contain production secrets, API keys, OAuth refresh tokens, service account JSON, private keys, or deployment tokens.

Safe files may include:

- source code
- sanitized templates
- documentation
- endpoint descriptions
- architecture diagrams
- placeholder environment variables

Unsafe files must remain untracked:

- `.env*`
- `.vercel/`
- `.next/`
- `node_modules/`
- private key files
- local token files

## Runtime Secrets

Production secrets must live in the deployment environment.

Common variables:

```text
ETLA_MASTER_SECRET
ZENOS_LLM_BASE_URL
ZENOS_LLM_API_KEY
ZENOS_HOST_MODEL
ZENOS_WORKER_MODEL
ZENOS_VERIFIER_MODEL
ZENOS_MEMORY_BASE_URL
ZENOS_MEMORY_API_KEY
```

## Protected APIs

Operational runtime endpoints require Etla HMAC signatures or the configured API key. Public endpoints expose only safe service metadata.

Public endpoints:

```text
GET /
GET /api/health
```

Protected endpoints:

```text
POST /api/runtime/route
POST /api/runtime/run
POST /api/runtime/route-event
GET  /api/runtime/eval
GET  /api/runtime/readiness
```

## Before Making The Repository Public

Run:

```bash
git grep -nE 'sk-|vcp_|ghp_|GOCSPX-|private_key|BEGIN PRIVATE KEY|shirinka' || true
```

Expected result: no real secrets. Placeholder values are acceptable if clearly redacted.
