import { runtimeReadinessReport } from './lib/zenos-runtime';
import { getRuntimeModelConfigSummary } from './lib/zenos-runtime-executor';

export default function Home() {
  const readiness = runtimeReadinessReport();
  const modelConfig = getRuntimeModelConfigSummary();

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Zenos Runtime</p>
        <h1>Routing, workers, verifier, and host synthesis without living inside Memory.</h1>
        <p className="lede">
          Runtime is the orchestration layer. Zenos Memory remains the durable context backend.
        </p>
      </section>

      <section className="grid">
        <article className="card">
          <span>Readiness</span>
          <strong>{readiness.status}</strong>
          <p>{readiness.checks.filter((check) => check.passed).length}/{readiness.checks.length} checks passing</p>
        </article>
        <article className="card">
          <span>Host model</span>
          <strong>{modelConfig.hostModel || 'not configured'}</strong>
          <p>{modelConfig.baseUrl || 'no base URL detected'}</p>
        </article>
        <article className="card">
          <span>Namespace</span>
          <strong>/api/runtime/*</strong>
          <p>Memory route namespace is no longer used for Runtime APIs.</p>
        </article>
      </section>

      <section className="panel">
        <h2>Operational endpoints</h2>
        <ul>
          {readiness.requiredOperationalEndpoints.map((endpoint) => <li key={endpoint}>{endpoint}</li>)}
        </ul>
      </section>
    </main>
  );
}
