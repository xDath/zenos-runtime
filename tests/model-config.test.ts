import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeModelSlots } from '../app/lib/zenos-runtime-model-config';

test('model-slot merging preserves defaults when a higher-priority source is unset', () => {
  const merged = mergeModelSlots(
    { hostModel: 'host-default', workerModel: 'worker-default' },
    { hostModel: undefined, workerModel: 'worker-override' },
  );

  assert.equal(merged.hostModel, 'host-default');
  assert.equal(merged.workerModel, 'worker-override');
});
