const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveEventPendingAction,
  resolveToolUsePendingAction,
  createUnknownInteractionFallbackPendingAction,
  runtimeIndicatesUserQuestion,
  inferSelectionFromTextPrompt,
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

test('resolveToolUsePendingAction maps AskUserQuestion options from input', () => {
  const pending = resolveToolUsePendingAction({
    type: 'tool_use',
    name: 'AskUserQuestion',
    input: {
      question: '다음 명령을 선택하세요',
      options: ['go', 'refactor', 'commit'],
    },
  });

  assert.equal(pending.type, 'selection');
  assert.deepEqual(pending.options.map(o => o.id), ['go', 'refactor', 'commit']);
});

test('resolveToolUsePendingAction infers options from markdown prompt list', () => {
  const pending = resolveToolUsePendingAction({
    type: 'tool_use',
    name: 'AskUserQuestion',
    input: {
      question: '다음 명령을 선택하세요:\n1. **go** - 진행\n2. **refactor** - 정리\n3. **commit** - 커밋',
    },
  });

  assert.equal(pending.type, 'selection');
  assert.deepEqual(pending.options.map(o => o.id), ['go', 'refactor', 'commit']);
});

test('inferSelectionFromTextPrompt infers command options from inline backticks', () => {
  const pending = inferSelectionFromTextPrompt('명령을 입력해 주세요: `go`, `commit`, `refactor`');
  assert.equal(pending.type, 'selection');
  assert.deepEqual(pending.options.map(o => o.id), ['go', 'commit', 'refactor']);
});
