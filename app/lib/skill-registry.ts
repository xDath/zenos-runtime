import { z } from 'zod';
import { TaskTypeSchema } from './zenos-runtime';

export const RuntimeSkillSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,95}$/),
  version: z.string().min(1).max(64),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(2_000),
  taskTypes: z.array(TaskTypeSchema).min(1).max(16),
  triggers: z.array(z.string().min(1).max(256)).min(1).max(64),
  requiredContext: z.array(z.string().max(512)).max(32).default([]),
  steps: z.array(z.string().min(1).max(1_000)).min(1).max(32),
  acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(32),
  forbiddenActions: z.array(z.string().min(1).max(1_000)).max(32).default([]),
  preferredTools: z.array(z.string().min(1).max(160)).max(32).default([]),
  compatibleRoles: z.array(z.enum(['worker', 'host', 'verifier', 'boss'])).min(1).max(4),
  enabled: z.boolean().default(true),
});
export type RuntimeSkill = z.infer<typeof RuntimeSkillSchema>;

export type SkillSelection = {
  skill: RuntimeSkill;
  score: number;
  reasons: string[];
};

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length > 2));
}

export class SkillRegistry {
  private readonly skills = new Map<string, RuntimeSkill>();

  register(input: z.input<typeof RuntimeSkillSchema>): RuntimeSkill {
    const skill = RuntimeSkillSchema.parse(input);
    this.skills.set(skill.id, skill);
    return skill;
  }

  get(id: string): RuntimeSkill | undefined {
    return this.skills.get(id);
  }

  list(): RuntimeSkill[] {
    return [...this.skills.values()].filter((skill) => skill.enabled).sort((a, b) => a.id.localeCompare(b.id));
  }

  select(input: { request: string; taskType: z.infer<typeof TaskTypeSchema>; role?: 'worker' | 'host' | 'verifier' | 'boss'; limit?: number }): SkillSelection[] {
    const requestTokens = tokens(input.request);
    return this.list()
      .filter((skill) => skill.taskTypes.includes(input.taskType))
      .filter((skill) => !input.role || skill.compatibleRoles.includes(input.role))
      .map((skill) => {
        const triggerTokens = tokens(skill.triggers.join(' '));
        let overlap = 0;
        for (const token of requestTokens) if (triggerTokens.has(token)) overlap += 1;
        const exact = skill.triggers.some((trigger) => input.request.toLowerCase().includes(trigger.toLowerCase())) ? 1 : 0;
        const score = exact * 0.65 + Math.min(1, overlap / Math.max(1, requestTokens.size)) * 0.35;
        return {
          skill,
          score,
          reasons: [exact ? 'exact-trigger' : 'token-overlap', `task:${input.taskType}`],
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
      .slice(0, Math.max(1, Math.min(input.limit || 3, 3)));
  }
}

export function createDefaultSkillRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register({
    id: 'fix-typescript-bug',
    version: '1.0.0',
    title: 'Fix TypeScript Bug',
    description: 'Reproduce and correct a TypeScript compiler or typing failure with the smallest justified patch.',
    taskTypes: ['debugging', 'coding_change'],
    triggers: ['typescript', 'typecheck', 'tsc', 'type error', 'compile error'],
    requiredContext: ['compiler error', 'affected symbol', 'direct callers', 'related tests'],
    steps: ['Reproduce the original failure.', 'Inspect the affected symbol and direct callers.', 'Apply the smallest type-safe correction.', 'Run targeted tests.', 'Run TypeScript validation.'],
    acceptanceCriteria: ['The original compiler error is gone.', 'Relevant tests pass.', 'No public API regression is introduced.'],
    forbiddenActions: ['Do not enable ignoreBuildErrors.', 'Do not delete failing tests.', 'Do not use broad any casts without evidence.'],
    preferredTools: ['repo.search', 'repo.symbol', 'test.run', 'typecheck.run'],
    compatibleRoles: ['worker', 'host', 'verifier'],
  });
  registry.register({
    id: 'investigate-service',
    version: '1.0.0',
    title: 'Investigate Service Failure',
    description: 'Diagnose a local service using bounded health, process, port, and log evidence.',
    taskTypes: ['debugging', 'deploy_or_destructive_action'],
    triggers: ['service', 'systemd', 'restart loop', 'journalctl', 'port', 'health check'],
    requiredContext: ['service name', 'current status', 'recent logs'],
    steps: ['Inspect service status.', 'Inspect recent bounded logs.', 'Inspect process and port state.', 'Identify the smallest safe correction.', 'Verify readiness after any approved change.'],
    acceptanceCriteria: ['The root cause is evidence-backed.', 'No production action is claimed without approval.', 'Readiness is verified after changes.'],
    forbiddenActions: ['Do not restart production services without approval.', 'Do not expose environment secrets.'],
    preferredTools: ['service.status', 'service.logs', 'port.inspect'],
    compatibleRoles: ['worker', 'host', 'verifier', 'boss'],
  });
  registry.register({
    id: 'review-authentication',
    version: '1.0.0',
    title: 'Review Authentication',
    description: 'Review authentication changes with explicit trust boundaries, expiry, replay, scope, and secret handling checks.',
    taskTypes: ['security_or_secret', 'debugging', 'coding_change'],
    triggers: ['authentication', 'authorization', 'token', 'hmac', 'nonce', 'scope', 'credential'],
    requiredContext: ['trust boundary', 'token format', 'expiry rules', 'scope policy', 'tests'],
    steps: ['Map the authentication flow.', 'Check expiry and replay protection.', 'Check scope enforcement.', 'Check secret handling.', 'Run security-focused validation.'],
    acceptanceCriteria: ['Authentication fails closed.', 'Replay and expiry behavior are tested.', 'Scopes are enforced.', 'No raw secret is persisted or logged.'],
    forbiddenActions: ['Do not weaken authentication for compatibility.', 'Do not log raw tokens or secrets.'],
    preferredTools: ['repo.references', 'test.run', 'secret.scan'],
    compatibleRoles: ['worker', 'host', 'verifier', 'boss'],
  });
  return registry;
}
