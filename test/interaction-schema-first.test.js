const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveEventPendingAction,
  createUnknownInteractionFallbackPendingAction,
  runtimeIndicatesUserQuestion,
} = require('../server');

test('resolveEventPendingAction normalizes schema contract fields', () => {
  const pending = resolveEventPendingAction({
    event: {
      pending_action: {
        type: 'input',
        prompt: '의견을 입력하세요',
        options: [{ id: 'submit', label: '제출', payload: { submit: true } }],
        metadata: { source: 'runtime' },
        input_mode: 'free_text',
        validation: { minLength: 3 },
      },
    },
  });

  assert.equal(pending.type, 'input');
  assert.equal(pending.prompt, '의견을 입력하세요');
  assert.equal(pending.options[0].id, 'submit');
  assert.equal(pending.metadata.source, 'runtime');
  assert.equal(pending.inputMode, 'free_text');
  assert.equal(pending.validation.minLength, 3);
});

test('unknown interaction fallback pending action is generic free-text schema', () => {
  const fallback = createUnknownInteractionFallbackPendingAction();
  assert.equal(fallback.type, 'text');
  assert.equal(fallback.prompt, '응답이 필요합니다.');
  assert.equal(fallback.metadata.reason, 'unknown_interaction');
  assert.equal(fallback.inputMode, 'free_text');
  assert.equal(fallback.options[0].id, 'submit_text');
});

test('runtimeIndicatesUserQuestion detects generic question signals without language-specific parser', () => {
  assert.equal(runtimeIndicatesUserQuestion({ needsResponse: true }), true);
  assert.equal(runtimeIndicatesUserQuestion({ stopReason: 'awaiting_user_input' }), true);
  assert.equal(runtimeIndicatesUserQuestion({ message: 'Can you confirm this change?' }), true);
  assert.equal(runtimeIndicatesUserQuestion({ message: 'processing logs only' }), false);
});
