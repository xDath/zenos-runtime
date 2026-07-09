import { runtimeReadinessReport } from './lib/zenos-runtime';
import { getRuntimeModelConfigSummary } from './lib/zenos-runtime-executor';

const pillars = [
  {
    name: 'Host / Middleman',
    tier: 'medium tier',
    copy: 'User-facing traffic controller that routes work, supervises events, and keeps Boss tokens low.',
  },
  {
    name: 'Worker Pool',
    tier: 'cheap tier',
    copy: 'High-volume extraction, browsing, summaries, code briefs, and evidence gathering under strict schemas.',
  },
  {
    name: 'Boss Agent',
    tier: 'premium tier',
    copy: 'Rare escalation judge that receives compact packets for security, deploy, ambiguity, and high-risk calls.',
  },
];

const flow = ['Gate request', 'Dispatch workers', 'Stream events', 'Quality gate', 'Escalate Boss', 'Host final'];

export default function Home() {
  const readiness = runtimeReadinessReport();
  const modelConfig = getRuntimeModelConfigSummary();
  const passedChecks = readiness.checks.filter((check) => check.passed).length;

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Local-first agent runtime</p>
          <h1>Zenos Runtime makes cheap workers useful without trusting them.</h1>
          <p className="lede">
            A three-agent control plane for Hermes/Codex: medium Host supervises, cheap Workers grind through
            context, and premium Boss only wakes up for high-risk judgment.
          </p>
          <div className="hero-actions" aria-label="Runtime commands">
            <code>node scripts/zenos-runtime-gate.mjs &quot;fix bug di repo ini&quot;</code>
            <span>Serious work is gated. Simple chat stays fast.</span>
          </div>
        </div>
        <aside className="status-console" aria-label="Runtime status">
          <div className="console-bar">
            <span />
            <span />
            <span />
          </div>
          <p>runtime.status</p>
          <strong>{readiness.status}</strong>
          <dl>
            <div>
              <dt>checks</dt>
              <dd>{passedChecks}/{readiness.checks.length}</dd>
            </div>
            <div>
              <dt>host</dt>
              <dd>{modelConfig.hostModel || 'not configured'}</dd>
            </div>
            <div>
              <dt>endpoint</dt>
              <dd>/api/runtime/*</dd>
            </div>
          </dl>
        </aside>
      </section>

      <section className="agent-grid" aria-label="Agent roles">
        {pillars.map((pillar, index) => (
          <article className="agent-card" key={pillar.name}>
            <div className="agent-index">0{index + 1}</div>
            <p>{pillar.tier}</p>
            <h2>{pillar.name}</h2>
            <span>{pillar.copy}</span>
          </article>
        ))}
      </section>

      <section className="flow-panel">
        <div>
          <p className="eyebrow">Supervision loop</p>
          <h2>Live worker events, compact Boss packets, no raw context dump.</h2>
        </div>
        <ol>
          {flow.map((step) => <li key={step}>{step}</li>)}
        </ol>
      </section>

      <section className="endpoint-panel">
        <div>
          <p className="eyebrow">Production v1 surface</p>
          <h2>Runtime APIs</h2>
        </div>
        <ul>
          {readiness.requiredOperationalEndpoints.map((endpoint) => <li key={endpoint}>{endpoint}</li>)}
        </ul>
      </section>
    </main>
  );
}
