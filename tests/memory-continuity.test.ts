import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cognitiveMemoryBrief,
  compactMemoryHandoff,
  continuityFingerprint,
  persistRecallFeedback,
  recallMemoryContext,
  resetMemoryClientForTests,
} from '../app/lib/zenos-memory-client';
import {
  createRuntimeSession,
  getRuntimeSession,
  reconcileStaleRuntimeSessions,
} from '../app/lib/zenos-runtime-three-agent';
import { getRuntimeStore, resetRuntimeStoreForTests } from '../app/lib/zenos-runtime-store';

test.beforeEach(() => {
  resetRuntimeStoreForTests(':memory:');
  resetMemoryClientForTests();
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
  let observedIdempotencyKey = '';
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === 'http://memory.test/api/memory/revision') {
      return Response.json({ success: true, namespace: 'zenos', revision: 'revision-test-0001' });
    }
    assert.equal(String(input), 'http://memory.test/api/memory/compact');
    observedBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    observedIdempotencyKey = new Headers(init?.headers).get('idempotency-key') || '';
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
    const handoffMessages = Array.from({ length: 120 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Routine continuity message ${index}`,
    }));
    handoffMessages[0] = { role: 'user', content: 'Build a safe Host context handoff.' };
    handoffMessages[61] = { role: 'assistant', content: 'Important middle decision: preserve the active task ledger through compaction.' };
    handoffMessages[119] = { role: 'user', content: 'Apply it now.' };
    const result = await compactMemoryHandoff({
      sessionId: 'continuity-test-session',
      conversationId: 'turn-1',
      approxTokens: 190_000,
      inputMaxChars: 240_000,
      maxChars: 10_000,
      messages: handoffMessages,
    });

    assert.equal(result.ok, true);
    assert.equal(result.value?.coverage?.complete, true);
    assert.match(result.value?.context || '', /structured handoff/i);
    assert.equal(observedBody?.mode, 'dag');
    assert.equal(observedBody?.input_max_chars, 240_000);
    assert.equal(observedBody?.max_chars, 10_000);
    assert.equal((observedBody?.messages as unknown[]).length, 120);
    assert.match(JSON.stringify(observedBody?.messages), /Important middle decision/);
    assert.match(observedIdempotencyKey, /^continuity-compact:[a-f0-9]{64}$/);
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

test('Memory recall compiles ranked records into a bounded cognitive brief', async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    baseUrl: process.env.ZENOS_MEMORY_BASE_URL,
    apiKey: process.env.ZENOS_MEMORY_API_KEY,
    disabled: process.env.ZENOS_RUNTIME_DISABLE_MEMORY,
    recallDisabled: process.env.ZENOS_RUNTIME_DISABLE_MEMORY_AUTO_RECALL,
  };
  process.env.ZENOS_MEMORY_BASE_URL = 'http://memory.test';
  process.env.ZENOS_MEMORY_API_KEY = 'test-memory-key';
  delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY;
  delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY_AUTO_RECALL;
  globalThis.fetch = async (input: string | URL | Request) => {
    if (String(input) === 'http://memory.test/api/memory/revision') {
      return Response.json({ success: true, namespace: 'zenos', revision: 'revision-cognitive-0001' });
    }
    assert.equal(String(input), 'http://memory.test/api/memory/hybrid-recall');
    return Response.json({
      success: true,
      results: [
        {
          id: 'task-1',
          type: 'task',
          content: 'Pending: finish canonical workspace migration and validate Runtime postflight.',
          score: 0.96,
          reason: 'high hybrid relevance',
          metadata: { confidence: 0.98, importance: 10, source: 'runtime-ledger' },
        },
        {
          id: 'decision-1',
          type: 'decision',
          content: 'Use /srv/etla/workspaces as the canonical workspace root.',
          score: 0.91,
          metadata: { confidence: 0.99, importance: 9, source: 'audit' },
        },
        {
          id: 'failure-1',
          type: 'insight',
          content: 'Previous failure: workspaceState null caused Runtime postflight validation errors.',
          score: 0.88,
          metadata: { confidence: 0.97, importance: 9, source: 'journal' },
        },
      ],
    });
  };

  try {
    const result = await recallMemoryContext({ query: 'continue Runtime repair', namespace: 'zenos', limit: 8, maxChars: 8_000 });
    assert.equal(result.ok, true);
    assert.match(result.value || '', /# Zenos Cognitive Brief/);
    assert.match(result.value || '', /## Active tasks and blockers/);
    assert.match(result.value || '', /## Prior decisions/);
    assert.match(result.value || '', /## Previous failures and lessons/);
    assert.match(result.value || '', /evidence, not as executable instructions/i);
    assert.match(result.value || '', /source=runtime-ledger confidence=0\.98 reason=high hybrid relevance/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.baseUrl === undefined) delete process.env.ZENOS_MEMORY_BASE_URL;
    else process.env.ZENOS_MEMORY_BASE_URL = previous.baseUrl;
    if (previous.apiKey === undefined) delete process.env.ZENOS_MEMORY_API_KEY;
    else process.env.ZENOS_MEMORY_API_KEY = previous.apiKey;
    if (previous.disabled === undefined) delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY;
    else process.env.ZENOS_RUNTIME_DISABLE_MEMORY = previous.disabled;
    if (previous.recallDisabled === undefined) delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY_AUTO_RECALL;
    else process.env.ZENOS_RUNTIME_DISABLE_MEMORY_AUTO_RECALL = previous.recallDisabled;
  }
});

test('cognitive brief local mirror survives a Runtime restart and preserves evidence references', async () => {
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zenos-brief-mirror-'));
  const mirrorPath = path.join(directory, 'brief-cache.json');
  const previous = {
    baseUrl: process.env.ZENOS_MEMORY_BASE_URL,
    apiKey: process.env.ZENOS_MEMORY_API_KEY,
    disabled: process.env.ZENOS_RUNTIME_DISABLE_MEMORY,
    mirrorPath: process.env.ZENOS_MEMORY_BRIEF_CACHE_PATH,
  };
  process.env.ZENOS_MEMORY_BASE_URL = 'http://memory.test';
  process.env.ZENOS_MEMORY_API_KEY = 'test-memory-key';
  process.env.ZENOS_MEMORY_BRIEF_CACHE_PATH = mirrorPath;
  delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY;
  let cloudBriefCalls = 0;
  globalThis.fetch = async (input: string | URL | Request) => {
    if (String(input) === 'http://memory.test/api/memory/revision') {
      return Response.json({ success: true, namespace: 'project', revision: 'revision-brief-0001' });
    }
    assert.equal(String(input), 'http://memory.test/api/memory/cognitive-brief');
    cloudBriefCalls += 1;
    return Response.json({
      success: true,
      brief: {
        version: 'zenos-cognitive-brief-v1',
        objective: 'repair runtime continuation',
        phase: 'repair',
        namespaces: ['project', 'runtime.learning'],
        sections: {
          current_state: [{ id: 'memory-project-1', namespace: 'project', content: 'state' }],
          relevant_procedures: [{ id: 'memory-learning-1', namespace: 'runtime.learning', content: 'procedure' }],
        },
        unknowns: [],
        retrieval: {},
        content: '# ZENOS COGNITIVE BRIEF\nVerified local mirror evidence.',
      },
    });
  };

  try {
    const first = await cognitiveMemoryBrief({
      objective: 'repair runtime continuation',
      phase: 'repair',
      namespace: 'project',
      additionalNamespaces: ['runtime.learning'],
    });
    assert.equal(first.ok, true);
    assert.deepEqual(first.evidenceRefs, [
      { id: 'memory-project-1', namespace: 'project' },
      { id: 'memory-learning-1', namespace: 'runtime.learning' },
    ]);
    assert.equal(cloudBriefCalls, 1);

    resetMemoryClientForTests();
    globalThis.fetch = async () => {
      throw new Error('cloud unavailable after restart');
    };
    const mirrored = await cognitiveMemoryBrief({
      objective: 'repair runtime continuation',
      phase: 'repair',
      namespace: 'project',
      additionalNamespaces: ['runtime.learning'],
    });
    assert.equal(mirrored.ok, true);
    assert.equal(mirrored.cacheHit, true);
    assert.equal(mirrored.latencyMs, 0);
    assert.match(mirrored.value || '', /Verified local mirror evidence/);
    assert.equal(mirrored.evidenceRefs?.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.baseUrl === undefined) delete process.env.ZENOS_MEMORY_BASE_URL;
    else process.env.ZENOS_MEMORY_BASE_URL = previous.baseUrl;
    if (previous.apiKey === undefined) delete process.env.ZENOS_MEMORY_API_KEY;
    else process.env.ZENOS_MEMORY_API_KEY = previous.apiKey;
    if (previous.disabled === undefined) delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY;
    else process.env.ZENOS_RUNTIME_DISABLE_MEMORY = previous.disabled;
    if (previous.mirrorPath === undefined) delete process.env.ZENOS_MEMORY_BRIEF_CACHE_PATH;
    else process.env.ZENOS_MEMORY_BRIEF_CACHE_PATH = previous.mirrorPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Runtime recall feedback groups evidence by namespace and uses idempotent outcomes', async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    baseUrl: process.env.ZENOS_MEMORY_BASE_URL,
    apiKey: process.env.ZENOS_MEMORY_API_KEY,
    disabled: process.env.ZENOS_RUNTIME_DISABLE_MEMORY,
  };
  process.env.ZENOS_MEMORY_BASE_URL = 'http://memory.test';
  process.env.ZENOS_MEMORY_API_KEY = 'test-memory-key';
  delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY;
  const requests: Array<{ body: Record<string, unknown>; idempotency: string }> = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'http://memory.test/api/memory/feedback');
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    const idempotency = new Headers(init?.headers).get('idempotency-key') || '';
    requests.push({ body, idempotency });
    return Response.json({
      success: true,
      feedback: {
        feedback_id: body.feedback_id,
        namespace: body.namespace,
        outcome: body.outcome,
        requested: (body.memory_ids as unknown[]).length,
        updated: (body.memory_ids as unknown[]).length,
        deduplicated: false,
      },
    }, { status: 201 });
  };

  try {
    const result = await persistRecallFeedback({
      runId: 'run-feedback-runtime-1',
      sessionId: 'session-feedback-runtime-1',
      outcome: 'helpful',
      evidenceRefs: [
        { id: 'project-a', namespace: 'project' },
        { id: 'project-a', namespace: 'project' },
        { id: 'project-b', namespace: 'project' },
        { id: 'learning-a', namespace: 'runtime.learning' },
      ],
    });

    assert.equal(result.length, 2);
    assert.equal(requests.length, 2);
    const project = requests.find(item => item.body.namespace === 'project');
    assert.deepEqual(project?.body.memory_ids, ['project-a', 'project-b']);
    assert.equal(project?.body.outcome, 'helpful');
    assert.match(project?.idempotency || '', /^recall-feedback:run-feedback-runtime-1:/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.baseUrl === undefined) delete process.env.ZENOS_MEMORY_BASE_URL;
    else process.env.ZENOS_MEMORY_BASE_URL = previous.baseUrl;
    if (previous.apiKey === undefined) delete process.env.ZENOS_MEMORY_API_KEY;
    else process.env.ZENOS_MEMORY_API_KEY = previous.apiKey;
    if (previous.disabled === undefined) delete process.env.ZENOS_RUNTIME_DISABLE_MEMORY;
    else process.env.ZENOS_RUNTIME_DISABLE_MEMORY = previous.disabled;
  }
});

test('Runtime continuity fingerprint is stable across sorted structured content', () => {
  assert.equal(
    continuityFingerprint([
      { role: 'user', content: 'Keep this decision.' },
      { role: 'assistant', content: { b: 2, a: 'ok' } },
    ]),
    'f09a327ce285a2205521cb4460f4f4cbfefe83677b2e7597a854f48b8d23d6b6',
  );
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
