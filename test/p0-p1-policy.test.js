const test = require('node:test');
const assert = require('node:assert/strict');

const { createPendingAction, validateActionResolutionPayload, createRecoveryPendingAction, sanitizeTicket } = require('../server');

test('manual approval action payload is accepted', () => {
  const pending = createPendingAction('approval', 'approve?', [
    { id: 'approve', label: '승인' },
    { id: 'reject', label: '반려' },
  ]);

  const ok = validateActionResolutionPayload({ actionId: 'approve' }, pending);
  assert.equal(ok.actionId, 'approve');
});

test('failure recovery action includes fallback/halt and escalation metadata', () => {
  const ticket = { currentStep: 1, failure: { retryUsedByStep: { 1: 2 } } };
  const pending = createRecoveryPendingAction(ticket, 'redline_halt', 'recover');
  const ids = pending.options.map((o) => o.id);
  assert.ok(ids.includes('fallback'));
  assert.ok(ids.includes('halt'));
  assert.equal(pending.metadata.source, 'recovery');
  assert.equal(pending.metadata.escalation.reason, 'redline_halt');
});

test('sanitizeTicket marks stale and blocked priority', () => {
  const oldTs = Date.now() - 31 * 60 * 1000;
  const t = sanitizeTicket({
    id: '1',
    status: 'blocked',
    currentStep: 0,
    createdAt: oldTs,
    updatedAt: oldTs,
    pendingAction: { metadata: { escalation: { retryRemaining: 0 } } },
  }, ['analyze']);

  assert.equal(t.isStale, true);
  assert.equal(t.blockedPriority, 'critical');
  assert.equal(t.isPinnedBlocked, true);
});
