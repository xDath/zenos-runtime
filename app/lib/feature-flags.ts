function normalizedFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return undefined;
}

export function runtimeFeatureEnabled(name: string, defaultValue = true): boolean {
  return normalizedFlag(process.env[name]) ?? defaultValue;
}

export const RuntimeFeatureFlags = {
  continuityCoordinator(): boolean {
    return runtimeFeatureEnabled('ZENOS_RUNTIME_CONTINUITY_COORDINATOR_ENABLED', true);
  },
  commandJobs(): boolean {
    return runtimeFeatureEnabled('ZENOS_RUNTIME_COMMAND_JOBS_ENABLED', true);
  },
  evidenceFaithfulness(): boolean {
    return runtimeFeatureEnabled('ZENOS_RUNTIME_EVIDENCE_FAITHFULNESS_ENABLED', true);
  },
} as const;
