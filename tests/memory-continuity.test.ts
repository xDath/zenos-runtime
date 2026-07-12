import test from 'node:test';
import assert from 'node:assert/strict';
import { compactMemoryHandoff } from '../app/lib/zenos-memory-client';
import {
  createRuntimeSession,
  getRuntimeSession,
  reconcileStaleRuntimeSessions,
} from '../app/lib/zenos-runtime-three-agent';
import { getRuntimeStore, resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

test.beforeEach(() => {
  resetRuntimeStoreForTests(':memory:');
});

test('Memory handoff sends a bounded DAG compaction contract and returns coverage metadata', async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    baseUrl: process.env.ZENOS_MEMORY_BASE_URL,
    apiKey: process.env.ZENOS_MEMORY_API_KEY,
    disabled: process.env.ZENOS_RUNTIME_DISABLE_MEMORY,
    handoffDisabled: process.env.ZENOS_RUNTIME_DISABLE_MEMORY_HANDOFF,
  };
  process.env.ZENOS_MEMORY_BASE_URL = 'http://memory.test';
  process.env.ZENOS_MEMORY_API_KEY = 'test-memory-key';
  delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY;
  delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY_HANDOFF;

  let observedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'http://memory.test/api/memory/compact');
    observedBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return Response.json({
      success: true,
      compact: {
        id: 'memory-handoff-1',
        type: 'insight',
        content: '## Current Goal\nKeep Host continuity while reducing the working set.',
        metadata: { confidence: 0.92 },
      },
      coverage: {
        goal: true,
        decisions: true,
        pendingWork: true,
        questions: true,
        artifacts: true,
        complete: true,
      },
      strategy: 'llm-structured-v2',
    });
  };

  try {
    const result = await compactMemoryHandoff({
      sessionId: 'continuity-test-session',
      conversationId: 'turn-1',
      approxTokens: 190_000,
      inputMaxChars: 240_000,
      maxChars: 10_000,
      messages: [
        { role: 'user', content: 'Build a safe Host context handoff.' },
        { role: 'assistant', content: 'We will preserve goals and decisions.' },
        { role: 'tool', content: 'Tests passed.', name: 'terminal' },
        { role: 'user', content: 'Apply it now.' },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.value?.coverage?.complete, true);
    assert.match(result.value?.context || '', /structured handoff/i);
    assert.equal(observedBody?.mode, 'dag');
    assert.equal(observedBody?.input_max_chars, 240_000);
    assert.equal(observedBody?.max_chars, 10_000);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.baseUrl === undefined) delete process.env.ZENOS_MEMORY_BASE_URL;
    else process.env.ZENOS_MEMORY_BASE_URL = previous.baseUrl;
    if (previous.apiKey === undefined) delete process.env.ZENOS_MEMORY_API_KEY;
    else process.env.ZENOS_MEMORY_API_KEY = previous.apiKey;
    if (previous.disabled === undefined) delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY;
    else process.env.ZENOS_RUNTIME_DISABLE_MEMORY = previous.disabled;
    if (previous.handoffDisabled === undefined) delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY_HANDOFF;
    else process.env.ZENOS_RUNTIME_DISABLE_MEMORY_HANDOFF = previous.handoffDisabled;
  }
});

test('stale active Runtime sessions are cancelled while fresh sessions stay active', () => {
  const stale = createRuntimeSession({ request: 'stale task' }, { sessionId: 'stale-session' });
  const fresh = createRuntimeSession({ request: 'fresh task' }, { sessionId: 'fresh-session' });
  const store = getRuntimeStore();
  store.saveSession({
    ...stale,
    status: 'working',
    updatedAt: '2026-07-12T00:00:00.000Z',
    version: stale.version + 1,
  });
  store.saveSession({
    ...fresh,
    status: 'working',
    updatedAt: '2026-07-12T11:55:00.000Z',
    version: fresh.version + 1,
  });

  const result = reconcileStaleRuntimeSessions({
    staleAfterMs: 30 * 60_000,
    nowMs: Date.parse('2026-07-12T12:00:00.000Z'),
  });

  assert.deepEqual(result.sessionIds, ['stale-session']);
  assert.equal(getRuntimeSession('stale-session')?.status, 'cancelled');
  assert.equal(getRuntimeSession('fresh-session')?.status, 'working');
});
