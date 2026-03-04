function createRedlineState() {
  return {
    repeatedTestFailureCount: 0,
    lastSignal: null,
    haltedReason: null,
  };
}

function detectSignalsFromText(text = "") {
  const t = String(text);
  return {
    testFailed: /(tests? failed|failing tests?|\bFAIL\b)/i.test(t),
    testPassed: /(all tests passed|0 failed|\bPASS\b)/i.test(t),
    planViolation: /(PLAN_VIOLATION|plan-violation signal)/i.test(t),
    invalidPlan: /(INVALID_PLAN|invalid-plan signal)/i.test(t),
  };
}

function evaluateRedline(state, input = {}) {
  const s = state || createRedlineState();
  const text = input.text || "";
  const explicitSignal = input.signal || null;
  const detected = detectSignalsFromText(text);

  if (detected.testFailed) s.repeatedTestFailureCount += 1;
  if (detected.testPassed) s.repeatedTestFailureCount = 0;

  if (explicitSignal === "plan_violation" || detected.planViolation) {
    s.lastSignal = "plan_violation";
    s.haltedReason = "plan-violation signal";
    return { halted: true, reason: s.haltedReason, state: s };
  }

  if (explicitSignal === "invalid_plan" || detected.invalidPlan) {
    s.lastSignal = "invalid_plan";
    s.haltedReason = "invalid-plan signal";
    return { halted: true, reason: s.haltedReason, state: s };
  }

  if (s.repeatedTestFailureCount >= 3) {
    s.lastSignal = "repeated_test_failures";
    s.haltedReason = "repeated test failures";
    return { halted: true, reason: s.haltedReason, state: s };
  }

  return { halted: false, state: s };
}

module.exports = {
  createRedlineState,
  evaluateRedline,
};
