import * as crypto from 'node:crypto';
import { OutcomePassportSchema } from './outcome-ledger';
import { RouteDecision } from './zenos-runtime';
import { RuntimeStore, getRuntimeStore } from './zenos-runtime-store';

export type LowTierRoutingMode = 'off' | 'shadow' | 'canary' | 'enabled';

export type LowTierEvidence = {
  taskType: RouteDecision['taskType'];
  sampleSize: number;
  successRate: number;
  failureRate: number;
  evidenceCoverageRate: number;
  invalidUsageSamples: number;
  feedbackCount: number;
  feedbackAcceptanceRate?: number;
  ready: boolean;
  requirements: string[];
};

export type LowTierRoutingDecision = {
  mode: LowTierRoutingMode;
  eligible: boolean;
  activate: boolean;
  shadowCandidate: boolean;
  reason: string;
  evidence: LowTierEvidence;
};

const ELIGIBLE_TASKS = new Set<RouteDecision['taskType']>([
  'repo_question',
  'coding_change',
  'debugging',
]);

function mode(): LowTierRoutingMode {
  const raw = (process.env.ZENOS_LOW_TIER_FIRST_MODE || 'shadow').trim().toLowerCase();
  return ['off', 'shadow', 'canary', 'enabled'].includes(raw)
    ? raw as LowTierRoutingMode
    : 'shadow';
}

function approvedTaskTypes(): Set<string> {
  return new Set((process.env.ZENOS_LOW_TIER_FIRST_APPROVED_TASKS || 'repo_question,coding_change,debugging')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
}

function latestPassports(store: RuntimeStore, taskType: RouteDecision['taskType']) {
  const latestByRun = new Map<string, ReturnType<typeof OutcomePassportSchema.parse>>();
  for (const record of store.listOutcomes(500, { taskType }).reverse()) {
    const parsed = OutcomePassportSchema.safeParse(record.record);
    if (parsed.success) latestByRun.set(parsed.data.runId, parsed.data);
  }
  return [...latestByRun.values()].filter((passport) => passport.decision.taskType === taskType);
}

export function lowTierEvidenceFor(
  taskType: RouteDecision['taskType'],
  store: RuntimeStore = getRuntimeStore(),
): LowTierEvidence {
  const passports = latestPassports(store, taskType);
  const sampleSize = passports.length;
  const successes = passports.filter((item) => item.verdict === 'success' || item.verdict === 'revised').length;
  const failures = passports.filter((item) => item.verdict === 'failed' || item.verdict === 'blocked').length;
  const evidenceBacked = passports.filter((item) => (item.quality.evidenceCoverage || 0) >= 0.72).length;
  const invalidUsageSamples = passports.reduce(
    (sum, item) => sum + Object.values(item.roleUsage).reduce((roleSum, usage) => roleSum + usage.invalidSamples, 0),
    0,
  );
  const feedback = passports.filter((item) => item.userFeedback?.accepted !== undefined);
  const accepted = feedback.filter((item) => item.userFeedback?.accepted === true).length;
  const successRate = sampleSize ? successes / sampleSize : 0;
  const failureRate = sampleSize ? failures / sampleSize : 0;
  const evidenceCoverageRate = sampleSize ? evidenceBacked / sampleSize : 0;
  const feedbackAcceptanceRate = feedback.length ? accepted / feedback.length : undefined;
  const minimumSamples = Math.max(30, Math.min(Number(process.env.ZENOS_LOW_TIER_MIN_OUTCOMES || 30), 100));
  const ready = sampleSize >= minimumSamples
    && successRate >= 0.9
    && failureRate <= 0.05
    && evidenceCoverageRate >= 0.8
    && invalidUsageSamples === 0
    && (feedback.length === 0 || feedbackAcceptanceRate === undefined || feedbackAcceptanceRate >= 0.85);
  return {
    taskType,
    sampleSize,
    successRate: Number(successRate.toFixed(4)),
    failureRate: Number(failureRate.toFixed(4)),
    evidenceCoverageRate: Number(evidenceCoverageRate.toFixed(4)),
    invalidUsageSamples,
    feedbackCount: feedback.length,
    feedbackAcceptanceRate: feedbackAcceptanceRate === undefined
      ? undefined
      : Number(feedbackAcceptanceRate.toFixed(4)),
    ready,
    requirements: [
      `at least ${minimumSamples} clean outcomes for the task class`,
      'success or validated revision rate at least 90%',
      'blocked/failed rate at most 5%',
      'evidence coverage at least 80%',
      'zero invalid token usage samples',
      'feedback acceptance at least 85% when feedback exists',
      'explicit task-class approval for canary or enabled mode',
    ],
  };
}

function canarySelected(sessionId: string): boolean {
  const percentage = Math.max(1, Math.min(Number(process.env.ZENOS_LOW_TIER_CANARY_PERCENT || 10), 100));
  const bucket = parseInt(crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 8), 16) % 100;
  return bucket < percentage;
}

export function decideLowTierRouting(input: {
  decision: RouteDecision;
  sessionId?: string;
  workspaceAvailable: boolean;
  store?: RuntimeStore;
}): LowTierRoutingDecision {
  const selectedMode = mode();
  const evidence = lowTierEvidenceFor(input.decision.taskType, input.store || getRuntimeStore());
  const eligible = ELIGIBLE_TASKS.has(input.decision.taskType)
    && ['low', 'medium'].includes(input.decision.risk)
    && input.workspaceAvailable
    && input.decision.useTools
    && approvedTaskTypes().has(input.decision.taskType);
  if (!eligible || selectedMode === 'off') {
    return {
      mode: selectedMode,
      eligible,
      activate: false,
      shadowCandidate: false,
      reason: !eligible
        ? 'Task is outside the approved low-tier tool-first boundary'
        : 'Low-tier-first routing is disabled',
      evidence,
    };
  }
  if (selectedMode === 'shadow') {
    return {
      mode: selectedMode,
      eligible: true,
      activate: false,
      shadowCandidate: evidence.ready,
      reason: evidence.ready
        ? 'Evidence threshold passed; route remains shadow-only until explicit canary promotion'
        : 'Collecting task-class outcomes in shadow mode',
      evidence,
    };
  }
  if (selectedMode === 'canary') {
    const selected = evidence.ready && canarySelected(input.sessionId || 'anonymous');
    return {
      mode: selectedMode,
      eligible: true,
      activate: selected,
      shadowCandidate: evidence.ready,
      reason: !evidence.ready
        ? 'Canary blocked because the evidence threshold has not passed'
        : selected
          ? 'Evidence-qualified session selected for the low-tier canary'
          : 'Evidence-qualified session stayed on the control route',
      evidence,
    };
  }
  return {
    mode: selectedMode,
    eligible: true,
    activate: true,
    shadowCandidate: true,
    reason: 'Explicit enabled mode promoted this approved task class to low-tier tool-first execution',
    evidence,
  };
}
