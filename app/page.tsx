import { getRuntimeModelConfigSummary } from './lib/zenos-runtime-executor';
import { getRuntimeStore } from './lib/zenos-runtime-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const agents = [
  {
    role: 'Host',
    signal: 'SYNTHESIS',
    model: 'Session-configurable',
    copy: 'Owns the user-facing judgment loop, consumes evidence-grade context, revises failed drafts, and never pretends a tool ran when no source was supplied.',
  },
  {
    role: 'Worker',
    signal: 'BOUNDED WORK',
    model: 'Cheap / standard tier',
    copy: 'Chunks large context, extracts claims with evidence, records uncertainty, and can run as a managed worker or an external leased worker.',
  },
  {
    role: 'Verifier',
    signal: 'QUALITY GATE',
    model: 'Independent tier',
    copy: 'Checks instruction following, grounding, secrets, action safety, and validation. Revise means a real revision; escalate means a real escalation.',
  },
  {
    role: 'Boss',
    signal: 'RARE ESCALATION',
    model: 'Premium tier',
    copy: 'Receives compact escalation packets for critical risk and unresolved ambiguity instead of wasting premium context on routine work.',
  },
];

const guarantees = [
  ['Durable state', 'SQLite WAL, transactions, integrity checks, persisted runs, leases, events, nonces, and idempotency.'],
  ['Bound auth', 'Scoped tokens plus HMAC v2 over body hash, path, nonce, client identity, and operation scope.'],
  ['Real control flow', 'Worker execution, Host revisions, Verifier re-checks, Boss delegation, blocking, and user-input pauses.'],
  ['Operational proof', 'Typecheck, lint, unit/integration tests, routing regression suite, smoke test, readiness probes, and metrics.'],
];

const endpoints = [
  'POST /api/runtime/run',
  'POST /api/runtime/route',
  'POST /api/runtime/session',
  'POST /api/runtime/dispatch',
  'POST /api/runtime/boss-review',
  'GET /api/runtime/runs/:runId',
  'GET /api/runtime/stream/:sessionId',
  'GET /api/runtime/readiness',
  'GET /api/runtime/metrics',
  'POST /api/runtime/token',
];

export default function Home() {
  const config = getRuntimeModelConfigSummary();
  const roles = config.roles as Record<string, {
    model: string;
    provider: string;
    baseUrl: string;
    hasApiKey: boolean;
    transport: string;
  }>;
  const sessions = getRuntimeStore().listSessions(6);
  return (
    <main className="shell">
      <nav className="topbar" aria-label="Zenos Runtime identity">
        <span className="wordmark"><i /> ZENOS RUNTIME</span>
        <span className="version">CONTROL PLANE · V0.5</span>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Judgment stays expensive. Context grinding does not.</p>
          <h1>Four minds.<br /><em>One governed answer.</em></h1>
          <p className="lede">
            Zenos Runtime is a durable orchestration layer for Hermes and 9Router. It separates supervision,
            bounded work, independent verification, and premium escalation—then proves every transition in state.
          </p>
          <div className="hero-badges">
            <span>SQLite WAL</span>
            <span>Body-bound HMAC</span>
            <span>Revision loop</span>
            <span>Per-session models</span>
          </div>
        </div>

        <aside className="status-console" aria-label="Runtime architecture summary">
          <div className="console-bar"><span /><span /><span /></div>
          <p className="terminal-label">zenos.runtime / architecture</p>
          <div className="orbit" aria-hidden="true">
            <span className="orbit-core">Z</span>
            <span className="orbit-node node-host">H</span>
            <span className="orbit-node node-worker">W</span>
            <span className="orbit-node node-verifier">V</span>
            <span className="orbit-node node-boss">B</span>
          </div>
          <dl>
            <div><dt>policy</dt><dd>intent + risk aware</dd></div>
            <div><dt>state</dt><dd>transactional</dd></div>
            <div><dt>failure</dt><dd>fail-closed</dd></div>
          </dl>
        </aside>
      </section>

      <section className="runtime-console" aria-label="Runtime model configuration and recent activity">
        <div className="runtime-console-heading">
          <div>
            <p className="eyebrow">Live control surface</p>
            <h2>Know who ran.<br />Know what passed.</h2>
          </div>
          <div className="setup-command">
            <span>Interactive model setup</span>
            <code>npm run runtime:setup</code>
            <span>Watch latest session</span>
            <code>npm run runtime:watch</code>
          </div>
        </div>

        <div className="model-slot-grid">
          {(['host', 'worker', 'verifier', 'boss'] as const).map((role) => {
            const current = roles[role];
            return (
              <article key={role} className="model-slot">
                <header><span>{role}</span><strong>{current?.transport || 'unknown'}</strong></header>
                <h3>{current?.model || 'not configured'}</h3>
                <dl>
                  <div><dt>provider</dt><dd>{current?.provider || 'default'}</dd></div>
                  <div><dt>base URL</dt><dd>{current?.baseUrl || 'Hermes CLI'}</dd></div>
                  <div><dt>credential</dt><dd>{current?.hasApiKey ? 'configured' : 'Hermes-managed'}</dd></div>
                </dl>
              </article>
            );
          })}
        </div>

        <div className="activity-ledger">
          <div className="ledger-title">
            <h3>Recent execution ledger</h3>
            <p>Refresh this page for persisted updates, or use <code>runtime:watch</code> for a one-second event feed.</p>
          </div>
          <div className="ledger-list">
            {sessions.length ? sessions.map((session) => {
              const latest = session.events.at(-1);
              return (
                <article key={session.sessionId}>
                  <div>
                    <strong>{session.status}</strong>
                    <span>{session.sessionId}</span>
                  </div>
                  <p>{latest?.summary || 'No role/tool event recorded yet.'}</p>
                  <small>{session.updatedAt} · calls {session.budget.modelCallsUsed}</small>
                </article>
              );
            }) : <p className="empty-ledger">No Runtime sessions have been recorded yet.</p>}
          </div>
        </div>
      </section>

      <section className="agent-grid" aria-label="Agent roles">
        {agents.map((agent, index) => (
          <article className="agent-card" key={agent.role}>
            <header><span>0{index + 1}</span><small>{agent.signal}</small></header>
            <h2>{agent.role}</h2>
            <p>{agent.copy}</p>
            <footer>{roles[agent.role.toLowerCase()]?.model || agent.model}</footer>
          </article>
        ))}
      </section>

      <section className="control-panel">
        <div className="section-heading">
          <p className="eyebrow">Production contract</p>
          <h2>Not agent theatre.<br />A state machine with teeth.</h2>
        </div>
        <div className="guarantee-list">
          {guarantees.map(([title, copy], index) => (
            <article key={title}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <div><h3>{title}</h3><p>{copy}</p></div>
            </article>
          ))}
        </div>
      </section>

      <section className="endpoint-panel">
        <div>
          <p className="eyebrow">Protected surface</p>
          <h2>Small API.<br />Strict semantics.</h2>
          <p className="panel-copy">Every operational route is scoped, rate-limited, request-traced, and non-cacheable.</p>
        </div>
        <ul>{endpoints.map((endpoint) => <li key={endpoint}>{endpoint}</li>)}</ul>
      </section>

      <footer className="site-footer">
        <span>ZENOS / HERMES / 9ROUTER</span>
        <span>HOST → WORKER → VERIFIER → BOSS</span>
      </footer>
    </main>
  );
}
