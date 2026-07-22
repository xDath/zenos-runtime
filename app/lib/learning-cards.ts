import * as crypto from 'node:crypto';
import { z } from 'zod';

export const LearningCardEvidenceSchema = z.object({
  source: z.enum(['tool', 'user', 'test', 'commit', 'runtime']),
  ref: z.string().trim().min(1).max(1_000),
  hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const LearningCardSchema = z.object({
  type: z.enum(['preference', 'decision', 'procedure', 'failure', 'project_state']),
  claim: z.string().trim().min(1).max(4_000),
  evidence: z.array(LearningCardEvidenceSchema).min(1).max(32),
  confidence: z.number().min(0).max(1),
  verification: z.enum(['user_confirmed', 'test_passed', 'tool_observed', 'unverified']),
  validFrom: z.string().datetime(),
  validTo: z.string().datetime().optional(),
  supersedes: z.array(z.string().trim().min(1).max(500)).max(64).optional(),
});

export type LearningCard = z.infer<typeof LearningCardSchema>;

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function clean(value: string | undefined, max = 4_000): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function buildRuntimeLearningCard(input: {
  runId: string;
  objective: string;
  taskType: string;
  verdict: 'success' | 'failed' | 'blocked' | 'revised';
  deterministicValidation?: 'passed' | 'failed' | 'unknown';
  toolSummary?: string;
  decisions?: string[];
  failures?: string[];
  artifacts?: string[];
  validFrom?: string;
}): LearningCard {
  const objective = clean(input.objective, 2_000);
  const toolSummary = clean(input.toolSummary, 3_000);
  const decisions = (input.decisions || []).map((item) => clean(item, 800)).filter(Boolean);
  const failures = (input.failures || []).map((item) => clean(item, 800)).filter(Boolean);
  const artifacts = (input.artifacts || []).map((item) => clean(item, 1_000)).filter(Boolean);
  const testPassed = input.verdict === 'success' && input.deterministicValidation === 'passed';
  const toolObserved = Boolean(toolSummary || artifacts.length || input.deterministicValidation === 'failed');
  const type: LearningCard['type'] = testPassed
    ? 'procedure'
    : input.verdict === 'failed'
      ? 'failure'
      : 'project_state';
  const verification: LearningCard['verification'] = testPassed
    ? 'test_passed'
    : toolObserved
      ? 'tool_observed'
      : 'unverified';
  const claim = type === 'procedure'
    ? `For ${input.taskType}, the validated approach completed: ${toolSummary || decisions[0] || objective}`
    : type === 'failure'
      ? `For ${input.taskType}, the observed failure was: ${failures[0] || toolSummary || objective}`
      : `Project state for ${input.taskType}: ${decisions[0] || failures[0] || objective}`;
  const evidence: LearningCard['evidence'] = [{
    source: 'runtime',
    ref: `runtime-run:${input.runId}`,
    hash: hash(JSON.stringify({
      objective,
      taskType: input.taskType,
      verdict: input.verdict,
      deterministicValidation: input.deterministicValidation || 'unknown',
    })),
  }];
  if (input.deterministicValidation && input.deterministicValidation !== 'unknown') {
    evidence.push({
      source: 'test',
      ref: `runtime-run:${input.runId}:deterministic-validation:${input.deterministicValidation}`,
      hash: hash(`${input.runId}:${input.deterministicValidation}:${toolSummary}`),
    });
  }
  if (toolSummary) {
    evidence.push({ source: 'tool', ref: `runtime-run:${input.runId}:tool-summary`, hash: hash(toolSummary) });
  }
  for (const artifact of artifacts.slice(0, 8)) {
    evidence.push({ source: 'commit', ref: artifact, hash: hash(artifact) });
  }
  return LearningCardSchema.parse({
    type,
    claim: claim.slice(0, 4_000),
    evidence,
    confidence: verification === 'test_passed' ? 0.94 : verification === 'tool_observed' ? 0.82 : 0.45,
    verification,
    validFrom: input.validFrom || new Date().toISOString(),
  });
}

export function buildVerifiedLearningCard(input: {
  type: LearningCard['type'];
  claim: string;
  evidence: LearningCard['evidence'];
  verification: Exclude<LearningCard['verification'], 'unverified'>;
  confidence?: number;
  validFrom?: string;
  validTo?: string;
  supersedes?: string[];
}): LearningCard {
  const defaultConfidence: Record<Exclude<LearningCard['verification'], 'unverified'>, number> = {
    user_confirmed: 0.98,
    test_passed: 0.94,
    tool_observed: 0.84,
  };
  if (input.type === 'preference' && input.verification !== 'user_confirmed') {
    throw new Error('Preference cards require direct user confirmation');
  }
  if (input.type === 'procedure' && input.verification !== 'test_passed') {
    throw new Error('Procedure cards require deterministic test evidence');
  }
  if (input.type === 'decision' && !input.evidence.some((item) => item.source === 'user' || item.source === 'commit' || item.source === 'runtime')) {
    throw new Error('Decision cards require user, commit, or Runtime decision evidence');
  }
  return LearningCardSchema.parse({
    type: input.type,
    claim: clean(input.claim, 4_000),
    evidence: input.evidence,
    confidence: input.confidence ?? defaultConfidence[input.verification],
    verification: input.verification,
    validFrom: input.validFrom || new Date().toISOString(),
    validTo: input.validTo,
    supersedes: input.supersedes,
  });
}

export function renderLearningCard(card: LearningCard): string {
  return [
    `Learning card: ${card.type}`,
    `Claim: ${card.claim}`,
    `Verification: ${card.verification}`,
    `Confidence: ${card.confidence.toFixed(2)}`,
    `Valid from: ${card.validFrom}`,
    ...card.evidence.map((item) => `Evidence: ${item.source}:${item.ref}${item.hash ? `#${item.hash}` : ''}`),
  ].join('\n');
}
