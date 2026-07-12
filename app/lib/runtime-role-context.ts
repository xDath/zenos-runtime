import { WorkerResult, validateWorkerResult } from './zenos-runtime';

export type RuntimeSourceContextInput = {
  request: string;
  memoryContext: string;
  toolContext: string;
  context: string;
};

export function compactSourceContext(input: RuntimeSourceContextInput): string {
  return [
    input.memoryContext ? `Memory context:\n${input.memoryContext}` : '',
    input.toolContext ? `Tool/source context:\n${input.toolContext}` : '',
    input.context ? `Additional context:\n${input.context}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 500_000);
}

export function splitRoleContext(text: string, desiredChunks: number, maxChunkChars = 16_000): string[] {
  if (!text.trim()) return [''];
  const count = Math.min(Math.max(desiredChunks, 1), 6);
  if (text.length <= maxChunkChars || count === 1) return [text.slice(0, maxChunkChars)];
  const target = Math.min(maxChunkChars, Math.ceil(text.length / count));
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length && chunks.length < count) {
    let end = Math.min(text.length, cursor + target);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > cursor + Math.floor(target * 0.6)) end = newline;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  if (cursor < text.length && chunks.length) chunks[chunks.length - 1] += `\n[TRUNCATED ${text.length - cursor} CHARACTERS]`;
  return chunks;
}

export function mergeWorkerResults(results: WorkerResult[], request: string): WorkerResult | undefined {
  if (!results.length) return undefined;
  const unique = (items: string[], max: number): string[] => {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const item of items) {
      const key = item.toLowerCase().replace(/\s+/g, ' ').slice(0, 240);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push(item);
      if (output.length >= max) break;
    }
    return output;
  };
  return validateWorkerResult({
    task: request,
    summary: unique(results.flatMap((result) => result.summary), 12),
    findings: results.flatMap((result) => result.findings).sort((a, b) => b.confidence - a.confidence).slice(0, 20),
    contradictions: unique(results.flatMap((result) => result.contradictions), 10),
    unknowns: unique(results.flatMap((result) => result.unknowns), 10),
    suggestedNextStep: results.find((result) => result.suggestedNextStep)?.suggestedNextStep || 'Host should review the evidence-backed brief.',
    needsHostAttention: unique(results.flatMap((result) => result.needsHostAttention), 12),
    rawContextNeeded: unique(results.flatMap((result) => result.rawContextNeeded), 12),
    sourceCoverage: results.reduce((sum, result) => sum + result.sourceCoverage, 0) / results.length,
  });
}
