import { GatewayHostPlan, GatewayMemoryBrief } from './gateway-contracts';
import { compactHostPlan } from './gateway-planning';
import { RouteDecision, WorkerResult } from './zenos-runtime';
import { BossDecision } from './zenos-runtime-state';
import { truncateToTokenBudget } from './token-economy';

export function compactWorkerBrief(worker?: WorkerResult): string {
  if (!worker) return '';
  const findings = worker.findings.slice(0, 8).map((finding) =>
    `- ${finding.claim} [confidence=${finding.confidence.toFixed(2)}; evidence=${finding.evidence.join(', ') || 'none'}]`,
  );
  return [
    'Worker summary:',
    ...worker.summary.slice(0, 8).map((item) => `- ${item}`),
    findings.length ? 'Evidence-backed findings:' : '',
    ...findings,
    worker.contradictions.length ? `Contradictions: ${worker.contradictions.join('; ')}` : '',
    worker.unknowns.length ? `Unknowns: ${worker.unknowns.join('; ')}` : '',
    worker.needsHostAttention.length ? `Host attention: ${worker.needsHostAttention.join('; ')}` : '',
    `Suggested next step: ${worker.suggestedNextStep}`,
  ].filter(Boolean).join('\n');
}

export function compactBossGuardrails(boss?: BossDecision): string {
  if (!boss) return '';
  return [
    `Boss preflight verdict: ${boss.verdict} (${boss.confidence.toFixed(2)})`,
    `Reason: ${boss.reasoningSummary}`,
    boss.allowedActions.length ? `Allowed actions: ${boss.allowedActions.join('; ')}` : '',
    boss.forbiddenActions.length ? `Forbidden actions: ${boss.forbiddenActions.join('; ')}` : '',
    boss.requiredChanges.length ? `Required changes: ${boss.requiredChanges.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

export function renderHostContext(
  decision: RouteDecision,
  hostPlan: GatewayHostPlan | undefined,
  worker: WorkerResult | undefined,
  boss: BossDecision | undefined,
  memory: GatewayMemoryBrief,
  runId: string,
): string {
  return [
    '[Zenos Runtime native turn brief — internal execution context]',
    `Run: ${runId}`,
    `Route: ${decision.pipelineMode}; task=${decision.taskType}; risk=${decision.risk}`,
    `Roles required: worker=${decision.useWorker}; verifier=${decision.useVerifier}; boss=${decision.useBoss}`,
    compactHostPlan(hostPlan),
    decision.useWorker ? '' : 'Worker skipped by Host orchestration and safety policy.',
    decision.useVerifier ? '' : 'Verifier skipped by Host orchestration and safety policy.',
    decision.useBoss ? '' : 'Boss skipped by Host orchestration and safety policy.',
    `Route reasons: ${decision.reasons.join('; ')}`,
    memory.context ? truncateToTokenBudget(memory.context, 3_000, '\n[MEMORY CONTEXT TRUNCATED]') : '',
    memory.coverage && !memory.coverage.complete
      ? 'Memory handoff coverage is partial. Preserve the recent raw conversation tail and retrieve archived evidence before relying on missing details.'
      : '',
    compactWorkerBrief(worker),
    compactBossGuardrails(boss),
    ['coding_change', 'debugging'].includes(decision.taskType)
      ? 'Coding completion gate: after changing a file, run the relevant deterministic syntax/typecheck/lint/test command. Do not finish the turn while the change is broken or unvalidated. Repair the file or rollback to the last known-good state before giving a final answer.'
      : '',
    'Use this brief as bounded supporting context. Do not claim a tool, file, test, or source was inspected unless Hermes actually inspected it during this turn.',
    'The user-facing response must not reveal raw internal packets unless the user explicitly asks for execution details.',
  ].filter(Boolean).join('\n\n');
}

export function blockedAnswer(reason: string, requiredChanges: string[] = []): string {
  return [
    `Gue belum bisa melanjutkan hasil itu karena Runtime memblokirnya: ${reason}`,
    requiredChanges.length ? `Yang perlu dibereskan dulu: ${requiredChanges.join('; ')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function askUserAnswer(reason: string, requiredChanges: string[] = []): string {
  return [
    `Sebelum lanjut, gue butuh konfirmasi atau detail tambahan: ${reason}`,
    requiredChanges.length ? requiredChanges.join('; ') : '',
  ].filter(Boolean).join('\n\n');
}
