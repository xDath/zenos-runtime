type CounterLabels = Record<string, string | number | boolean | undefined>;

type MetricSnapshot = {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  startedAt: string;
  uptimeSeconds: number;
};

const startedAt = Date.now();
const counters = new Map<string, number>();
const gauges = new Map<string, number>();

function key(name: string, labels: CounterLabels = {}): string {
  const normalized = Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => `${label}=${String(value)}`)
    .join(',');
  return normalized ? `${name}{${normalized}}` : name;
}

export function incrementMetric(name: string, labels: CounterLabels = {}, amount = 1): void {
  const metricKey = key(name, labels);
  counters.set(metricKey, (counters.get(metricKey) || 0) + amount);
}

export function setGauge(name: string, value: number, labels: CounterLabels = {}): void {
  gauges.set(key(name, labels), value);
}

export function observeDuration(name: string, started: number, labels: CounterLabels = {}): number {
  const durationMs = Math.max(0, Date.now() - started);
  incrementMetric(`${name}_count`, labels);
  incrementMetric(`${name}_milliseconds_total`, labels, durationMs);
  return durationMs;
}

export function metricsSnapshot(): MetricSnapshot {
  return {
    counters: Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
    gauges: Object.fromEntries([...gauges.entries()].sort(([a], [b]) => a.localeCompare(b))),
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  };
}

function prometheusName(value: string): string {
  return value.replace(/[^A-Za-z0-9_{}=,.-]/g, '_');
}

export function metricsAsPrometheus(): string {
  const snapshot = metricsSnapshot();
  const lines = [
    '# HELP zenos_runtime_uptime_seconds Process uptime in seconds.',
    '# TYPE zenos_runtime_uptime_seconds gauge',
    `zenos_runtime_uptime_seconds ${snapshot.uptimeSeconds}`,
  ];
  for (const [metric, value] of Object.entries(snapshot.counters)) {
    lines.push(`${prometheusName(metric)} ${value}`);
  }
  for (const [metric, value] of Object.entries(snapshot.gauges)) {
    lines.push(`${prometheusName(metric)} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function resetMetricsForTests(): void {
  counters.clear();
  gauges.clear();
}
