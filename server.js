const http = require("node:http");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createRedlineState, evaluateRedline } = require("./lib/redline");

const PORT = Number(process.env.PORT || 3000);
const CONFIG_FILE = process.env.KANCLI_CONFIG_FILE || path.join(__dirname, "kancli-config.json");
const DB_FILE = process.env.KANCLI_DB_FILE || path.join(__dirname, "data", "kancli-db.json");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const WORKTREE_DIR = ".kancli-worktrees";
const DEFAULT_ALLOWED_TOOLS = "Read,Write,Edit,Glob,Grep,Bash,Agent";
const MAX_WORKERS = 3;
const PENDING_ACTION_TTL_MS = Number(process.env.KANCLI_PENDING_ACTION_TTL_MS || 15 * 60 * 1000);

const TASK_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  WAITING: "waiting",
  BLOCKED: "blocked",
  DONE: "done",
  HALTED: "halted",
};

let config = {
  projectPath: "",
  pipeline: [],
  approvalPolicy: { defaultMode: "auto", steps: {} },
  failurePolicy: { retryBudget: 2, allowFallbackStep: true, fallbackStepIndex: 0 },
  wipLimits: {},
  wipPolicy: { mode: "warn" },
  interactionMode: "interactive",
};
const tickets = {};
const queue = [];
const running = new Set();
const workerSlots = Array.from({ length: MAX_WORKERS }, (_, idx) => ({ slot: idx + 1, ticketId: null }));
let nextId = 1;
const timelineEvents = [];
const sseClients = new Set();
const metrics = {
  startedAt: Date.now(),
  ticketsCreated: 0,
  stepsStarted: 0,
  stepsCompleted: 0,
  stepErrors: 0,
  redlineHalts: 0,
  pendingActionsExpired: 0,
  sseEventsEmitted: 0,
};

function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const backupPath = `${file}.bak`;
  fs.copyFileSync(file, backupPath);
  return backupPath;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const serialized = JSON.stringify(data, null, 2);
  const tempPath = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tempPath, "w");
  try {
    fs.writeSync(fd, serialized, 0, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) backupFile(file);
  fs.renameSync(tempPath, file);
}

function loadJsonWithRecovery(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    const corruptPath = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, corruptPath); } catch {}
    const backupPath = `${file}.bak`;
    if (fs.existsSync(backupPath)) {
      try {
        const recovered = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
        writeJsonAtomic(file, recovered);
        return recovered;
      } catch {}
    }
    return fallback;
  }
}

function normalizeMode(mode) {
  return mode === "manual" ? "manual" : "auto";
}

function normalizeInteractionMode(mode) {
  return mode === "forbid" ? "forbid" : "interactive";
}

function loadConfig() {
  const loaded = loadJsonWithRecovery(CONFIG_FILE, { projectPath: "", pipeline: [] });
  if (loaded && typeof loaded === "object") {
    config = {
      projectPath: typeof loaded.projectPath === "string" ? loaded.projectPath : "",
      pipeline: Array.isArray(loaded.pipeline) ? loaded.pipeline.filter((s) => typeof s === "string" && s.trim()) : [],
      approvalPolicy: {
        defaultMode: normalizeMode(loaded.approvalPolicy?.defaultMode),
        steps: loaded.approvalPolicy?.steps && typeof loaded.approvalPolicy.steps === "object" ? loaded.approvalPolicy.steps : {},
      },
      failurePolicy: {
        retryBudget: Number.isInteger(loaded.failurePolicy?.retryBudget) ? Math.max(0, loaded.failurePolicy.retryBudget) : 2,
        allowFallbackStep: loaded.failurePolicy?.allowFallbackStep !== false,
        fallbackStepIndex: Number.isInteger(loaded.failurePolicy?.fallbackStepIndex) ? Math.max(0, loaded.failurePolicy.fallbackStepIndex) : 0,
      },
      wipLimits: loaded.wipLimits && typeof loaded.wipLimits === "object" ? loaded.wipLimits : {},
      wipPolicy: { mode: loaded.wipPolicy?.mode === "enforce" ? "enforce" : "warn" },
      interactionMode: normalizeInteractionMode(loaded.interactionMode),
    };
  }
}

function saveConfig() {
  writeJsonAtomic(CONFIG_FILE, config);
}

function repairDbState(parsed) {
  const safe = parsed && typeof parsed === "object" ? parsed : {};
  const safeTickets = Array.isArray(safe.tickets) ? safe.tickets.filter((t) => t && typeof t.id === "string") : [];
  const ticketIds = new Set(safeTickets.map((t) => t.id));
  const safeQueue = Array.isArray(safe.queue) ? safe.queue.filter((id) => typeof id === "string" && ticketIds.has(id)) : [];
  const safeNextId = Number.isInteger(safe.nextId) && safe.nextId > 0 ? safe.nextId : 1;
  return { nextId: safeNextId, queue: safeQueue, tickets: safeTickets };
}

function loadDb() {
  const loaded = loadJsonWithRecovery(DB_FILE, { nextId: 1, queue: [], tickets: [], timelineEvents: [] });
  const parsed = repairDbState(loaded);
  nextId = parsed.nextId;
  queue.push(...parsed.queue.filter((id) => !tickets[id]));
  if (Array.isArray(loaded.timelineEvents)) timelineEvents.push(...loaded.timelineEvents.filter((e) => e && typeof e === "object"));

  for (const t of parsed.tickets) {
    tickets[t.id] = {
      ...t,
      approvals: t.approvals || {},
      failure: t.failure || { retryUsedByStep: {} },
      createdAt: t.createdAt || Date.now(),
      updatedAt: t.updatedAt || Date.now(),
      proc: null,
    };
    if (tickets[t.id].pendingAction && !tickets[t.id].pendingAction.createdAt) {
      tickets[t.id].pendingAction = createPendingAction(
        tickets[t.id].pendingAction.type,
        tickets[t.id].pendingAction.prompt,
        tickets[t.id].pendingAction.options,
        tickets[t.id].pendingAction.metadata
      );
    }
    if (tickets[t.id].status === TASK_STATUS.RUNNING) tickets[t.id].status = TASK_STATUS.BLOCKED;
    // Ensure WAITING tickets always have a pendingAction
    if (["review", "awaiting_input", "waiting"].includes(tickets[t.id].status)) {
      tickets[t.id].status = TASK_STATUS.WAITING;
      if (!tickets[t.id].pendingAction) {
        tickets[t.id].pendingAction = createPendingAction(
          "hybrid", "", [],
          { reason: "migrated_from_legacy", source: "step_exit", allowText: true }
        );
      }
    }
  }

  const maxTicketId = Math.max(0, ...Object.keys(tickets).map((id) => Number(id) || 0));
  if (nextId <= maxTicketId) nextId = maxTicketId + 1;
}

function saveDb() {
  const data = {
    nextId,
    queue,
    timelineEvents,
    tickets: Object.values(tickets).map(({ proc, ...rest }) => rest),
  };
  writeJsonAtomic(DB_FILE, data);
}

function scanSkills(projectPath) {
  const skillsDir = path.join(projectPath, ".claude", "skills");
  if (!fs.existsSync(skillsDir)) return [];

  const found = [];

  function walk(dir, rel = "") {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const hasSkillFile = entries.some((e) => e.isFile() && /^skill\.md$/i.test(e.name));
    if (hasSkillFile) {
      const normalized = rel.replace(/^\/+/, "");
      if (normalized) found.push(normalized);
      return;
    }

    for (const entry of entries) {
      if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      walk(path.join(dir, entry.name), childRel);
    }
  }

  walk(skillsDir, "");
  return [...new Set(found)].sort();
}

function createWorktree(title) {
  const worktreeBase = path.join(config.projectPath, WORKTREE_DIR);
  if (!fs.existsSync(worktreeBase)) fs.mkdirSync(worktreeBase, { recursive: true });

  const safeName = title.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  const branchName = `feat/${safeName}`;
  const worktreePath = path.join(worktreeBase, safeName);

  if (fs.existsSync(worktreePath)) return { worktreePath, branchName };

  try {
    execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, { cwd: config.projectPath, stdio: "pipe" });
  } catch {
    execSync(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: config.projectPath, stdio: "pipe" });
  }

  return { worktreePath, branchName };
}

function removeWorktree(worktreePath) {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: config.projectPath, stdio: "pipe" });
  } catch {}
}

function normalizePendingActionOption(option, index) {
  if (!option) return null;
  if (typeof option === "string") {
    const v = option.trim();
    return v ? { id: v, label: v, payload: {} } : null;
  }
  if (typeof option !== "object") return null;
  const id = typeof option.id === "string" && option.id.trim() ? option.id.trim() : `option_${index + 1}`;
  const label = typeof option.label === "string" && option.label.trim() ? option.label.trim()
    : typeof option.description === "string" && option.description.trim() ? option.description.trim()
    : id;
  return { id, label, payload: option.payload && typeof option.payload === "object" ? option.payload : {} };
}

function normalizePendingAction(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  // Reject objects that have no meaningful pending action fields
  const hasPrompt = typeof raw.prompt === "string" && raw.prompt.trim();
  const hasMessage = typeof raw.message === "string" && raw.message.trim();
  const hasType = typeof raw.type === "string" && raw.type.trim();
  const hasOptions = Array.isArray(raw.options) && raw.options.length > 0;
  if (!hasPrompt && !hasMessage && !hasType && !hasOptions) return null;
  return createPendingAction(
    raw.type,
    raw.prompt || raw.message,
    raw.options || raw.choices,
    raw.metadata,
    {
      inputMode: raw.inputMode || raw.input_mode,
      validation: raw.validation,
      createdAt: raw.createdAt,
      expiresAt: raw.expiresAt,
    }
  );
}

function createPendingAction(type, prompt, options = [], metadata = {}, schema = {}) {
  const normalizedType = typeof type === "string" && type.trim() ? type.trim() : "selection";
  const normalizedPrompt = typeof prompt === "string" && prompt.trim() ? prompt.trim() : "입력이 필요합니다.";
  const normalizedOptions = Array.isArray(options)
    ? options.map((option, idx) => normalizePendingActionOption(option, idx)).filter(Boolean)
    : [];
  const now = Date.now();
  const createdAt = typeof schema.createdAt === "number" ? schema.createdAt : now;
  const expiresAt = typeof schema.expiresAt === "number" ? schema.expiresAt : createdAt + PENDING_ACTION_TTL_MS;
  const normalized = {
    type: normalizedType,
    prompt: normalizedPrompt,
    options: normalizedOptions,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    createdAt,
    expiresAt,
  };
  if (typeof schema.inputMode === "string" && schema.inputMode.trim()) normalized.inputMode = schema.inputMode.trim();
  if (schema.validation && typeof schema.validation === "object" && !Array.isArray(schema.validation)) normalized.validation = schema.validation;
  return normalized;
}

function isPendingActionExpired(pendingAction) {
  if (!pendingAction) return false;
  if (typeof pendingAction.expiresAt !== "number") return false;
  return Date.now() > pendingAction.expiresAt;
}

function getSkillWipLimit(skill) {
  const raw = config.wipLimits?.[`skill:${skill}`] ?? config.wipLimits?.[skill];
  return Number.isInteger(raw) ? raw : null;
}

function canEnterStep(stepIndex, ticketId = null) {
  const skill = config.pipeline[stepIndex];
  if (!skill) return { ok: false, reason: "유효하지 않은 단계입니다." };
  const limit = getSkillWipLimit(skill);
  if (config.wipPolicy?.mode !== "enforce" || !Number.isInteger(limit)) return { ok: true };
  const activeCount = Object.values(tickets).filter((t) => {
    if (!t || t.id === ticketId || t.status === TASK_STATUS.DONE) return false;
    return t.currentStep === stepIndex;
  }).length;
  if (activeCount >= limit) return { ok: false, reason: `${skill} 단계 WIP(${limit}) 초과` };
  return { ok: true };
}

function assignWorkerSlot(ticketId) {
  const slot = workerSlots.find((s) => !s.ticketId);
  if (!slot) return null;
  slot.ticketId = ticketId;
  return slot.slot;
}

function releaseWorkerSlot(ticketId) {
  const slot = workerSlots.find((s) => s.ticketId === ticketId);
  if (slot) slot.ticketId = null;
}

function getApprovalMode(ticket) {
  const skill = config.pipeline[ticket.currentStep];
  if (!skill) return "auto";
  return normalizeMode(config.approvalPolicy?.steps?.[skill] || config.approvalPolicy?.defaultMode || "auto");
}

function getInteractionMode() {
  return normalizeInteractionMode(config.interactionMode);
}

function isLegacyPendingAction(pendingAction) {
  const source = pendingAction?.metadata?.source;
  return source === "approval_gate" || source === "recovery";
}

function applyPendingActionPolicy(ticket, origin = "runtime") {
  if (!ticket?.pendingAction) return;
  const interactiveAllowed = getInteractionMode() === "interactive" || isLegacyPendingAction(ticket.pendingAction) || origin === "approval_gate";
  if (interactiveAllowed) {
    ticket.status = TASK_STATUS.WAITING;
    return;
  }
  const blockedReason = "interaction_mode_forbid";
  ticket.status = TASK_STATUS.BLOCKED;
  ticket.pendingAction = createRecoveryPendingAction(
    ticket,
    blockedReason,
    "대화형 입력이 비활성화되어 있습니다. interactionMode를 interactive로 변경하거나 retry/fallback/다음 단계/중단 중 선택하세요."
  );
}

function setPendingAction(ticket, pendingAction, origin = "runtime") {
  if (!pendingAction) return;
  ticket.pendingAction = pendingAction;
  applyPendingActionPolicy(ticket, origin);
  emitEvent("step_event", { ticketId: ticket.id, currentStep: ticket.currentStep, kind: "pending_action", pendingActionType: pendingAction.type });
  addTimelineEvent({
    ticketId: ticket.id,
    type: "pending_action_shown",
    currentStep: ticket.currentStep,
    pendingActionType: ticket.pendingAction?.type || pendingAction.type,
    prompt: ticket.pendingAction?.prompt || pendingAction.prompt,
    origin,
    interactionMode: getInteractionMode(),
    status: ticket.status,
  });
}

function addTimelineEvent(event) {
  const normalized = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    ...event,
  };
  timelineEvents.push(normalized);
  const over = timelineEvents.length - 2000;
  if (over > 0) timelineEvents.splice(0, over);
  emitEvent("timeline_event", normalized);
}

function buildFailureEscalation(ticket, reason) {
  const step = ticket.currentStep;
  const used = ticket.failure?.retryUsedByStep?.[step] || 0;
  const retryBudget = Math.max(0, Number(config.failurePolicy?.retryBudget || 0));
  const retryRemaining = Math.max(0, retryBudget - used);
  return {
    reason,
    retryBudget,
    retryUsed: used,
    retryRemaining,
    fallbackAllowed: Boolean(config.failurePolicy?.allowFallbackStep),
    fallbackStepIndex: Number.isInteger(config.failurePolicy?.fallbackStepIndex) ? config.failurePolicy.fallbackStepIndex : 0,
  };
}

function createRecoveryPendingAction(ticket, reason, prompt) {
  const escalation = buildFailureEscalation(ticket, reason);
  const options = [];
  if (escalation.retryRemaining > 0) {
    options.push({ id: "retry", label: `현재 단계 재시도 (${escalation.retryRemaining}회 남음)`, payload: { rerunCurrentStep: true } });
  }
  if (escalation.fallbackAllowed) {
    options.push({ id: "fallback", label: `fallback 단계(${escalation.fallbackStepIndex + 1})로 이동`, payload: { fallback: true } });
  }
  options.push({ id: "advance", label: "다음 단계로 진행", payload: { advance: true } });
  options.push({ id: "halt", label: "중단 유지", payload: { halt: true } });

  return createPendingAction("selection", prompt, options, { reason, source: "recovery", escalation });
}

function addArtifact(ticket, artifact) {
  if (!artifact) return;
  const normalized = {
    type: artifact.type || "artifact",
    name: artifact.name || artifact.path || "unnamed",
    path: artifact.path || null,
    url: artifact.url || null,
    contentType: artifact.contentType || null,
    size: artifact.size || null,
    metadata: artifact.metadata || {},
    createdAt: Date.now(),
  };
  ticket.artifacts.push(normalized);
  emitEvent("artifact_added", { ticketId: ticket.id, artifact: normalized });
}

function updateSummary(ticket) {
  const lines = (ticket.log || "").split("\n").slice(-120);
  const reversed = [...lines].reverse();
  const commitLine = reversed.find((l) => /\b[0-9a-f]{7,40}\b/.test(l) || /^commit\s+/i.test(l));
  const diffLine = reversed.find((l) => /(diff --git|\+\+\+\s+b\/|---\s+a\/)/i.test(l));
  const testLine = reversed.find((l) => /(test(s)?\s+(passed|failed)|\bPASS\b|\bFAIL\b|failing tests?)/i.test(l));
  const issueLine = reversed.find((l) => /(error|fail|blocked|issue|exception|timeout)/i.test(l));
  const rootCause = reversed.find((l) => /(because|due to|root cause|원인|dependency|permission|network)/i.test(l));

  const escalation = ticket.pendingAction?.metadata?.escalation;
  const nextAction = ticket.pendingAction?.prompt
    || "-";
  const recommendation = escalation
    ? (escalation.retryRemaining > 0 ? `retry 가능 (${escalation.retryRemaining}회)` : "fallback 또는 halt 권장")
    : nextAction;

  ticket.summary = {
    latestCommit: commitLine || "-",
    latestDiff: diffLine || "-",
    testResult: testLine || "-",
    issue: issueLine || "-",
    rootCause: rootCause || issueLine || "-",
    nextAction,
    recommendation,
  };
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch {}
  }
}

function emitEvent(event, payload = {}) {
  metrics.sseEventsEmitted += 1;
  broadcast(event, { timestamp: Date.now(), ...payload });
}

function emitTicket(ticket) {
  ticket.updatedAt = Date.now();
  updateSummary(ticket);
  saveDb();
  broadcast("ticket", sanitizeTicket(ticket));
  emitEvent("task_lifecycle", { ticketId: ticket.id, status: ticket.status, currentStep: ticket.currentStep });
  addTimelineEvent({
    ticketId: ticket.id,
    type: "ticket_transition",
    status: ticket.status,
    currentStep: ticket.currentStep,
  });
}

function resolveEventPendingAction(ev) {
  const src = ev?.event || ev?.data || ev;
  const pending = src?.pendingAction || src?.pending_action;
  // Only use src.action if it looks like a pending action object (not a string or other type)
  const actionCandidate = !pending && src?.action && typeof src.action === "object" && !Array.isArray(src.action) ? src.action : null;
  return normalizePendingAction(pending || actionCandidate);
}

function resolveEventArtifact(ev) {
  const src = ev?.event || ev?.data || ev;
  const artifact = src?.artifact || src?.output || src?.file;
  if (!artifact || typeof artifact !== "object") return null;
  return {
    type: artifact.type || "artifact",
    name: artifact.name || artifact.filename || artifact.path,
    path: artifact.path,
    url: artifact.url,
    contentType: artifact.contentType || artifact.mimeType,
    size: artifact.size,
    metadata: artifact.metadata || {},
  };
}

function createUnknownInteractionFallbackPendingAction() {
  return createPendingAction(
    "text",
    "응답이 필요합니다.",
    [{ id: "submit_text", label: "응답 제출" }],
    { source: "runtime_fallback", reason: "unknown_interaction" },
    { inputMode: "free_text" }
  );
}

function extractQuestionTextFromEvent(ev) {
  const src = ev?.event || ev?.data || ev;
  if (!src || typeof src !== "object") return "";

  for (const field of ["message", "result", "log"]) {
    if (typeof src[field] === "string" && src[field].trim()) {
      const lines = src[field].trim().split(/\r?\n/).filter(Boolean);
      const last = lines.slice(-5).join("\n");
      if (last) return last;
    }
  }

  const content = src.message?.content;
  if (Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i--) {
      if (typeof content[i]?.text === "string" && content[i].text.trim()) {
        const lines = content[i].text.trim().split(/\r?\n/).filter(Boolean);
        return lines.slice(-5).join("\n");
      }
    }
  }

  return "";
}

function hasQuestionSignal(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  return /\?$|\n[^\n]*\?\s*$/.test(text);
}

function inferSelectionFromTextPrompt(text) {
  if (typeof text !== "string" || !text.trim()) return null;

  const out = [];
  const add = (id) => {
    const v = String(id || "").trim();
    if (!/^[a-zA-Z0-9_-]{2,40}$/.test(v)) return;
    if (!out.includes(v)) out.push(v);
  };

  // 1) Backtick style: `go`, `commit`
  for (const m of text.matchAll(/`([^`\n]{1,40})`/g)) add(m[1]);

  // 2) Bold list style: **go**
  if (out.length < 2) {
    for (const m of text.matchAll(/\*\*([^*\n]{1,40})\*\*/g)) add(m[1]);
  }

  // 3) Fallback keyword extraction for common command prompts
  if (out.length < 2) {
    const lower = text.toLowerCase();
    if (/\bgo\b/.test(lower)) add("go");
    if (/\bcommit\b/.test(lower)) add("commit");
    if (/\brefactor\b/.test(lower)) add("refactor");
    if (/\badvance\b/.test(lower)) add("advance");
    if (/\bretry\b/.test(lower)) add("retry");
    if (/\bhalt\b/.test(lower)) add("halt");
  }

  if (out.length < 2) return null;

  const options = out.map((id) => ({ id, label: id }));
  return createPendingAction(
    "selection",
    "명령을 선택하세요",
    options,
    { source: "runtime_text_infer", reason: "inline_command_prompt", inputMode: "selection" }
  );
}

function runtimeIndicatesUserQuestion(ev) {
  const src = ev?.event || ev?.data || ev;
  if (!src || typeof src !== "object") return false;

  if (
    src.requiresUserInput === true
    || src.awaitingUserInput === true
    || src.askUser === true
    || src.needsResponse === true
    || src.needs_input === true
    || src.waiting_for_user === true
  ) return true;

  const stopReason = typeof src.stopReason === "string" ? src.stopReason.toLowerCase() : "";
  if (["awaiting_user_input", "needs_user_input", "ask_user", "question"].includes(stopReason)) return true;

  return false;
}

function applyRedline(ticket, input = {}) {
  const result = evaluateRedline(ticket.redline, input);
  ticket.redline = result.state;
  if (!result.halted || ticket.status === TASK_STATUS.HALTED) return;

  ticket.status = TASK_STATUS.HALTED;
  metrics.redlineHalts += 1;
  emitEvent("redline_event", { ticketId: ticket.id, reason: result.reason, kind: "halt" });
  ticket.pendingAction = createRecoveryPendingAction(
    ticket,
    result.reason,
    `Redline halt: ${result.reason}`
  );
}

function expireStalePendingAction(ticket) {
  if (!ticket?.pendingAction || !isPendingActionExpired(ticket.pendingAction)) return false;
  ticket.status = TASK_STATUS.BLOCKED;
  metrics.pendingActionsExpired += 1;
  ticket.pendingAction = createRecoveryPendingAction(
    ticket,
    "stale_action_expired",
    "이전 액션 요청이 만료되었습니다. 현재 단계를 다시 시도하거나 fallback/다음 단계 진행/중단을 선택하세요."
  );
  return true;
}

function processText(ticket, text) {
  if (!text) return;
  ticket.log += text;
  applyRedline(ticket, { text });
}

function extractOptionsFromPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) return [];
  const out = [];

  // e.g. "- **go** - ..." or "1. **go** - ..." or inline "**go**, **refactor**"
  const boldOption = /\*\*([^*\n]+)\*\*/g;
  let m;
  while ((m = boldOption.exec(prompt)) !== null) {
    const id = String(m[1] || "").trim();
    if (!id || id.length > 30 || /\s{2,}/.test(id)) continue; // skip long/sentence-like bold
    if (!out.find((o) => o.id === id)) out.push({ id, label: id });
  }

  // e.g. "- go - ..." or "1. go - ..."
  if (!out.length) {
    const plainOption = /(?:^|\n)\s*(?:[-*]|\d+[.)])\s*(\S[^-:—\n]*\S|\S)[ \t]*(?:[-:—]|(?=\n)|$)/g;
    while ((m = plainOption.exec(prompt)) !== null) {
      const id = String(m[1] || "").trim();
      if (!id) continue;
      if (!out.find((o) => o.id === id)) out.push({ id, label: id });
    }
  }

  return out;
}

function resolveToolUsePendingAction(block) {
  if (!block || block.type !== "tool_use") return null;
  const name = String(block.name || "");
  if (!name) return null;

  // Generic interactive tool pattern (e.g., AskUserQuestion)
  if (!/ask.?user.?question/i.test(name)) return null;

  const input = (block.input && typeof block.input === "object") ? block.input : {};
  const prompt = String(input.prompt || input.question || input.message || input.text || "응답이 필요합니다.");

  const rawOptions = input.options || input.choices || input.actions || [];
  const options = Array.isArray(rawOptions)
    ? rawOptions.map((o, idx) => {
        if (typeof o === "string") return { id: o, label: o };
        if (o && typeof o === "object") {
          const id = String(o.id || o.value || o.key || o.name || `option_${idx + 1}`);
          return { id, label: String(o.label || o.title || o.description || o.name || id), payload: o.payload || {} };
        }
        return null;
      }).filter(Boolean)
    : [];

  const inferredOptions = options.length ? options : extractOptionsFromPrompt(prompt);

  if (inferredOptions.length) {
    return createPendingAction("selection", prompt, inferredOptions, {
      reason: "tool_user_question",
      source: "tool_use",
      toolName: name,
      inputMode: "selection",
    });
  }

  return createPendingAction("text", prompt, [], {
    reason: "tool_user_question",
    source: "tool_use",
    toolName: name,
    inputMode: "free_text",
  });
}

function processContentBlocks(ticket, blocks) {
  for (const b of blocks || []) {
    if (b.type === "text") processText(ticket, b.text);
    else if (b.type === "tool_use") {
      processText(ticket, `\n> [${b.name}]\n`);
      const pa = resolveToolUsePendingAction(b);
      if (pa) setPendingAction(ticket, pa, "runtime_tool");
    }
    else if (b.type === "tool_result" && b.content) {
      const text = typeof b.content === "string" ? b.content : "";
      processText(ticket, text.length > 500 ? `${text.substring(0, 500)}...\n` : `${text}\n`);
    } else if (["pending_action", "action_request", "action"].includes(b.type)) {
      const pa = resolveEventPendingAction({ event: b });
      if (pa) setPendingAction(ticket, pa, "runtime");
    } else if (["artifact", "output_file", "file"].includes(b.type)) {
      const artifact = resolveEventArtifact({ event: b });
      if (artifact) addArtifact(ticket, artifact);
    }
  }
}

function parseStreamEvent(ticket, ev) {
  if (!ev || typeof ev !== "object") return;
  if (ev.type === "assistant" && ev.message?.content) processContentBlocks(ticket, ev.message.content);
  if (ev.type === "user" && ev.message?.content) processContentBlocks(ticket, ev.message.content);
  if (ev.type === "result" && ev.result) processText(ticket, `\n${ev.result}`);

  const pa = resolveEventPendingAction(ev);
  if (pa) setPendingAction(ticket, pa, "runtime");

  const artifact = resolveEventArtifact(ev);
  if (artifact) addArtifact(ticket, artifact);

  if (typeof ev.signal === "string") applyRedline(ticket, { signal: ev.signal });
  if (typeof ev.message === "string") processText(ticket, `${ev.message}\n`);
  if (typeof ev.log === "string") processText(ticket, `${ev.log}\n`);

  if (!ticket.pendingAction && runtimeIndicatesUserQuestion(ev)) {
    const questionText = extractQuestionTextFromEvent(ev);
    const fallback = createUnknownInteractionFallbackPendingAction();
    if (questionText) fallback.prompt = questionText;
    setPendingAction(ticket, fallback, "runtime_fallback");
  }
}

function resolutionToPrompt(resolution) {
  if (!resolution) return "";
  const lines = ["[runtime action resolution]"];
  if (resolution.actionId) lines.push(`actionId: ${resolution.actionId}`);
  if (resolution.input) lines.push(`input: ${resolution.input}`);
  if (resolution.option) lines.push(`option: ${JSON.stringify(resolution.option)}`);
  if (resolution.metadata) lines.push(`metadata: ${JSON.stringify(resolution.metadata)}`);
  return lines.join("\n");
}

function startStep(id, options = {}) {
  const ticket = tickets[id];
  if (!ticket || ticket.status === TASK_STATUS.HALTED) return;
  const skill = config.pipeline[ticket.currentStep];
  if (!skill) return;

  ticket.status = TASK_STATUS.RUNNING;
  const wip = canEnterStep(ticket.currentStep, ticket.id);
  if (!wip.ok) {
    ticket.status = TASK_STATUS.BLOCKED;
    ticket.pendingAction = createRecoveryPendingAction(ticket, "wip_limit_enforced", `${wip.reason}. 다른 티켓 완료 후 재시도하거나 fallback/다음 단계를 선택하세요.`);
    emitTicket(ticket);
    return;
  }

  ticket.status = TASK_STATUS.RUNNING;
  ticket.pendingAction = null;
  ticket.log = "";
  running.add(id);
  ticket.workerSlot = assignWorkerSlot(id);
  metrics.stepsStarted += 1;
  emitEvent("step_event", { ticketId: ticket.id, currentStep: ticket.currentStep, kind: "step_started" });
  emitTicket(ticket);

  const resolutionPrompt = resolutionToPrompt(options.resolution);
  const prompt = resolutionPrompt ? `/${skill} ${ticket.title}\n${resolutionPrompt}` : `/${skill} ${ticket.title}`;

  const env = { ...process.env, KANCLI_ALLOWED_TOOLS: DEFAULT_ALLOWED_TOOLS };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const proc = spawn(
    CLAUDE_BIN,
    ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
    { cwd: ticket.worktreePath, env, stdio: ["pipe", "pipe", "pipe"] }
  );

  ticket.proc = proc;
  proc.stdin.end(`${prompt}\n`);

  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { parseStreamEvent(ticket, JSON.parse(line)); }
      catch { processText(ticket, `${line}\n`); }
      emitTicket(ticket);
      if (ticket.status === TASK_STATUS.HALTED && ticket.proc) ticket.proc.kill("SIGTERM");
    }
  });

  proc.stderr.on("data", (chunk) => {
    processText(ticket, chunk.toString());
    emitTicket(ticket);
  });

  proc.on("exit", (code) => {
    running.delete(id);
    releaseWorkerSlot(id);
    ticket.workerSlot = null;
    ticket.proc = null;
    emitEvent("step_event", { ticketId: ticket.id, currentStep: ticket.currentStep, kind: "step_completed", exitCode: code });
    metrics.stepsCompleted += 1;
    processText(ticket, `\n\n--- 완료 (exit ${code}) ---`);

    if (ticket.status === TASK_STATUS.HALTED) {
      emitTicket(ticket);
      schedule();
      return;
    }

    if (!ticket.pendingAction && code !== 0) {
      ticket.status = TASK_STATUS.BLOCKED;
      ticket.pendingAction = createRecoveryPendingAction(ticket, "step_exit_nonzero", "실행이 비정상 종료되었습니다. 재시도/fallback/다음 단계 진행/중단 중 선택하세요.");
    } else if (!ticket.pendingAction) {
      const mode = getApprovalMode(ticket);
      ticket.approvals[ticket.currentStep] = {
        mode,
        state: mode === "manual" ? "pending" : "approved",
        updatedAt: Date.now(),
      };
      if (mode === "manual") {
        setPendingAction(ticket, createPendingAction(
          "approval",
          `수동 승인 필요: ${config.pipeline[ticket.currentStep]} 단계 결과를 승인할까요?`,
          [
            { id: "approve", label: "승인", payload: { approve: true } },
            { id: "reject", label: "반려", payload: { reject: true } },
          ],
          { reason: "manual_approval_required", source: "approval_gate", step: ticket.currentStep }
        ), "approval_gate");
      } else {
        setPendingAction(ticket, createPendingAction(
          "hybrid", "", [],
          { reason: "step_completed", source: "step_exit", allowText: true }
        ), "step_exit");
      }
    } else {
      applyPendingActionPolicy(ticket, "runtime");
    }

    emitTicket(ticket);
    schedule();
  });

  proc.on("error", (err) => {
    running.delete(id);
    releaseWorkerSlot(id);
    ticket.workerSlot = null;
    ticket.proc = null;
    emitEvent("step_event", { ticketId: ticket.id, currentStep: ticket.currentStep, kind: "step_error", error: err.message });
    metrics.stepErrors += 1;
    processText(ticket, `\n\n--- 에러: ${err.message} ---`);
    ticket.status = TASK_STATUS.BLOCKED;
    ticket.pendingAction = createRecoveryPendingAction(ticket, "process_error", "실행 중 오류가 발생했습니다. 재시도/fallback/다음 단계 진행/중단 중 선택하세요.");
    emitTicket(ticket);
    schedule();
  });
}

function planDispatch(runningCount, queueIds, maxWorkers = MAX_WORKERS) {
  const availableSlots = Math.max(0, maxWorkers - runningCount);
  return {
    toStart: queueIds.slice(0, availableSlots),
    remaining: queueIds.slice(availableSlots),
  };
}

function schedule() {
  const plan = planDispatch(running.size, queue);
  queue.length = 0;
  queue.push(...plan.remaining);
  for (const id of plan.toStart) {
    const t = tickets[id];
    if (!t) continue;
    startStep(id);
  }
  saveDb();
}

function addTicket(title) {
  const id = String(nextId++);
  const { worktreePath, branchName } = createWorktree(title);
  const t = {
    id,
    title,
    branchName,
    worktreePath,
    currentStep: 0,
    status: TASK_STATUS.QUEUED,
    log: "",
    pendingAction: null,
    artifacts: [],
    workerSlot: null,
    redline: createRedlineState(),
    approvals: {},
    failure: { retryUsedByStep: {} },
    summary: { latestCommit: "-", latestDiff: "-", testResult: "-", issue: "-", rootCause: "-", nextAction: "-", recommendation: "-" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    proc: null,
  };
  tickets[id] = t;
  queue.push(id);
  metrics.ticketsCreated += 1;
  emitTicket(t);
  schedule();
  return t;
}

function moveToNextStep(id) {
  const t = tickets[id];
  if (!t) return { error: "not found", code: 404 };
  if (![TASK_STATUS.WAITING, TASK_STATUS.WAITING, TASK_STATUS.BLOCKED, TASK_STATUS.HALTED].includes(t.status)) {
    return { error: "다음 단계로 진행할 수 없는 상태입니다.", code: 400 };
  }

  const approval = t.approvals?.[t.currentStep];
  if (approval?.mode === "manual" && approval.state !== "approved") {
    return { error: "수동 승인 전에는 다음 단계로 진행할 수 없습니다.", code: 400 };
  }

  const next = t.currentStep + 1;
  if (next >= config.pipeline.length) {
    t.status = TASK_STATUS.DONE;
    t.pendingAction = null;
    emitTicket(t);
    return sanitizeTicket(t);
  }

  const wip = canEnterStep(next, t.id);
  if (!wip.ok) {
    t.status = TASK_STATUS.BLOCKED;
    t.pendingAction = createRecoveryPendingAction(t, "wip_limit_enforced", `${wip.reason}. WIP 제한 해제 또는 티켓 완료 후 다시 진행하세요.`);
    emitTicket(t);
    return sanitizeTicket(t);
  }

  t.currentStep = next;
  t.status = TASK_STATUS.QUEUED;
  t.pendingAction = null;
  queue.push(t.id);
  emitTicket(t);
  schedule();
  return sanitizeTicket(t);
}

function validateActionResolutionPayload(payload, pending) {
  if (!payload || typeof payload !== "object") return { error: "잘못된 요청 본문입니다." };
  if (isPendingActionExpired(pending)) return { error: "요청된 액션이 만료되었습니다.", stale: true };

  if (payload.metadata !== undefined && (typeof payload.metadata !== "object" || Array.isArray(payload.metadata))) {
    return { error: "metadata는 객체여야 합니다." };
  }

  const input = typeof payload.input === "string" ? payload.input.trim() : "";
  if (!input) return { error: "input은 필수입니다." };

  const builtin = ["retry", "halt", "advance", "approve", "reject", "fallback"];
  const selected = (pending.options || []).find((o) => o.id === input) || null;
  const actionId = selected ? selected.id : (builtin.includes(input) ? input : "submit_text");

  return { actionId, selected, metadata: payload.metadata || {}, input };
}

function resolvePendingAction(ticket, payload = {}) {
  const pending = ticket.pendingAction;
  if (!pending) return { error: "대기 중인 액션이 없습니다.", code: 400 };

  const validated = validateActionResolutionPayload(payload, pending);
  if (validated.error) {
    if (validated.stale) expireStalePendingAction(ticket);
    return { error: validated.error, code: 400 };
  }

  if (getInteractionMode() === "forbid" && !isLegacyPendingAction(pending)) {
    ticket.status = TASK_STATUS.BLOCKED;
    ticket.pendingAction = createRecoveryPendingAction(ticket, "interaction_mode_forbid", "interactionMode=forbid 상태입니다. interactive로 전환하거나 복구 액션을 선택하세요.");
    emitTicket(ticket);
    return sanitizeTicket(ticket);
  }

  const mergedPayload = { ...(validated.selected?.payload || {}), ...(validated.metadata || {}) };
  addTimelineEvent({
    ticketId: ticket.id,
    type: "pending_action_submitted",
    currentStep: ticket.currentStep,
    pendingActionType: pending.type,
    actionId: validated.actionId,
    input: validated.input || "",
    metadata: validated.metadata || {},
  });

  if (validated.actionId === "approve" || mergedPayload.approve) {
    ticket.approvals[ticket.currentStep] = { mode: "manual", state: "approved", updatedAt: Date.now() };
    ticket.pendingAction = null;
    return moveToNextStep(ticket.id);
  }
  if (validated.actionId === "reject" || mergedPayload.reject) {
    ticket.approvals[ticket.currentStep] = { mode: "manual", state: "rejected", updatedAt: Date.now() };
    ticket.status = TASK_STATUS.BLOCKED;
    ticket.pendingAction = createRecoveryPendingAction(ticket, "manual_approval_rejected", "승인이 반려되었습니다. 수정 후 재시도/fallback/다음 단계 진행/중단 중 선택하세요.");
    emitTicket(ticket);
    return sanitizeTicket(ticket);
  }
  if (validated.actionId === "advance" || mergedPayload.advance) return moveToNextStep(ticket.id);
  if (validated.actionId === "retry" || mergedPayload.rerunCurrentStep) {
    const step = ticket.currentStep;
    ticket.failure.retryUsedByStep[step] = (ticket.failure.retryUsedByStep[step] || 0) + 1;
    const wip = canEnterStep(ticket.currentStep, ticket.id);
    if (!wip.ok) {
      ticket.status = TASK_STATUS.BLOCKED;
      ticket.pendingAction = createRecoveryPendingAction(ticket, "wip_limit_enforced", `${wip.reason}.`);
      emitTicket(ticket);
      return sanitizeTicket(ticket);
    }
    ticket.status = TASK_STATUS.QUEUED;
    ticket.pendingAction = null;
    queue.push(ticket.id);
    emitTicket(ticket);
    schedule();
    return sanitizeTicket(ticket);
  }
  if (validated.actionId === "fallback" || mergedPayload.fallback) {
    const fallbackStepIndex = Number.isInteger(config.failurePolicy?.fallbackStepIndex) ? config.failurePolicy.fallbackStepIndex : 0;
    ticket.currentStep = Math.max(0, Math.min(fallbackStepIndex, Math.max(0, config.pipeline.length - 1)));
    const wip = canEnterStep(ticket.currentStep, ticket.id);
    if (!wip.ok) {
      ticket.status = TASK_STATUS.BLOCKED;
      ticket.pendingAction = createRecoveryPendingAction(ticket, "wip_limit_enforced", `${wip.reason}.`);
      emitTicket(ticket);
      return sanitizeTicket(ticket);
    }
    ticket.status = TASK_STATUS.QUEUED;
    ticket.pendingAction = null;
    queue.push(ticket.id);
    emitTicket(ticket);
    schedule();
    return sanitizeTicket(ticket);
  }
  if (validated.actionId === "halt" || mergedPayload.halt) {
    ticket.status = TASK_STATUS.HALTED;
    ticket.pendingAction = null;
    emitTicket(ticket);
    return sanitizeTicket(ticket);
  }

  startStep(ticket.id, { resolution: { actionId: validated.actionId, input: validated.input, option: validated.selected, metadata: validated.metadata } });
  emitTicket(ticket);
  return sanitizeTicket(ticket);
}

function getPipelineColumns(pipeline = config.pipeline || []) {
  const skills = Array.isArray(pipeline) ? pipeline : [];
  return skills.map((skill, index) => ({
    id: `skill:${skill}`,
    kind: "skill",
    skill,
    name: skill,
    order: index,
  }));
}

function sanitizeTicket(t, pipeline = config.pipeline || []) {
  if (!t || !t.id) return t;
  const { proc, ...rest } = t;
  const inRange = Number.isInteger(rest.currentStep) && rest.currentStep >= 0 && rest.currentStep < pipeline.length;
  const currentSkill = inRange ? pipeline[rest.currentStep] : null;
  const ageMs = Date.now() - (rest.updatedAt || rest.createdAt || Date.now());
  const isStale = ageMs > 30 * 60 * 1000;
  const escalation = rest.pendingAction?.metadata?.escalation || null;
  // Lazy enrich: derive prompt and options from log at read time
  if (rest.pendingAction && rest.log) {
    const lines = rest.log.split("\n").filter(l => l.trim() && !/^> \[/.test(l.trim()) && !/^--- 완료/.test(l.trim()));
    const lastLines = lines.slice(-3).map(l => l.trim()).join("\n");
    if (lastLines) rest.pendingAction.prompt = lastLines;
    if (!rest.pendingAction.options || !rest.pendingAction.options.length) {
      const fullLog = rest.log;
      const lastAskIdx = fullLog.lastIndexOf("[AskUserQuestion]");
      const logTail = lastAskIdx >= 0 ? fullLog.slice(lastAskIdx) : fullLog.slice(-500);
      const logOptions = extractOptionsFromPrompt(logTail);
      if (logOptions.length) rest.pendingAction.options = logOptions;
    }
  }

  return {
    ...rest,
    currentSkill,
    isDone: rest.status === TASK_STATUS.DONE,
    isStale,
    blockedPriority: rest.status === TASK_STATUS.BLOCKED || rest.status === TASK_STATUS.HALTED
      ? (escalation?.retryRemaining > 0 ? "high" : "critical")
      : null,
    isPinnedBlocked: rest.status === TASK_STATUS.BLOCKED || rest.status === TASK_STATUS.HALTED,
  };
}

function json(res, data, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

loadConfig();
loadDb();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.writeHead(200).end();

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  }

  if (url.pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("event: ping\ndata: {}\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    const statusCounts = Object.values(tickets).reduce((acc, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    }, {});
    return json(res, {
      ok: true,
      uptimeSec: Math.floor((Date.now() - metrics.startedAt) / 1000),
      queueDepth: queue.length,
      running: running.size,
      ticketCount: Object.keys(tickets).length,
      statusCounts,
      metrics,
    });
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    return json(res, { ...config, availableSkills: config.projectPath ? scanSkills(config.projectPath) : [] });
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const data = JSON.parse(body || "{}");
      if (data.projectPath !== undefined) config.projectPath = data.projectPath;
      if (data.pipeline !== undefined) config.pipeline = data.pipeline;
      if (data.approvalPolicy !== undefined) {
        config.approvalPolicy = {
          defaultMode: normalizeMode(data.approvalPolicy?.defaultMode),
          steps: data.approvalPolicy?.steps && typeof data.approvalPolicy.steps === "object" ? data.approvalPolicy.steps : {},
        };
      }
      if (data.failurePolicy !== undefined) {
        config.failurePolicy = {
          retryBudget: Number.isInteger(data.failurePolicy?.retryBudget) ? Math.max(0, data.failurePolicy.retryBudget) : config.failurePolicy.retryBudget,
          allowFallbackStep: data.failurePolicy?.allowFallbackStep !== false,
          fallbackStepIndex: Number.isInteger(data.failurePolicy?.fallbackStepIndex) ? Math.max(0, data.failurePolicy.fallbackStepIndex) : config.failurePolicy.fallbackStepIndex,
        };
      }
      if (data.wipLimits !== undefined && typeof data.wipLimits === "object") config.wipLimits = data.wipLimits;
      if (data.wipPolicy !== undefined) config.wipPolicy = { mode: data.wipPolicy?.mode === "enforce" ? "enforce" : "warn" };
      if (data.interactionMode !== undefined) config.interactionMode = normalizeInteractionMode(data.interactionMode);
      saveConfig();
      json(res, { ...config, availableSkills: config.projectPath ? scanSkills(config.projectPath) : [] });
    });
    return;
  }

  if (url.pathname === "/api/skills" && req.method === "GET") {
    const projectPath = url.searchParams.get("projectPath") || config.projectPath;
    return json(res, { skills: projectPath ? scanSkills(projectPath) : [] });
  }

  if (url.pathname === "/api/tickets" && req.method === "GET") {
    for (const ticket of Object.values(tickets)) {
      if (expireStalePendingAction(ticket)) emitTicket(ticket);
    }
    const pipelineColumns = getPipelineColumns(config.pipeline);
    const list = Object.values(tickets)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((ticket) => sanitizeTicket(ticket, config.pipeline));
    const queueDepth = queue.length;
    const roughEtaMin = queueDepth > 0 ? Math.max(1, Math.ceil((queueDepth / Math.max(1, MAX_WORKERS)) * 5)) : 0;
    const slots = workerSlots.map((slot) => {
      const ticket = slot.ticketId ? tickets[slot.ticketId] : null;
      return {
        slot: slot.slot,
        ticketId: slot.ticketId,
        title: ticket?.title || null,
        currentStep: ticket?.currentStep ?? null,
        currentSkill: ticket?.currentStep != null ? config.pipeline[ticket.currentStep] || null : null,
      };
    });
    return json(res, { pipeline: config.pipeline, pipelineColumns, queue, running: Array.from(running), wipLimits: config.wipLimits || {}, wipPolicy: config.wipPolicy || { mode: "warn" }, workerPool: { maxWorkers: MAX_WORKERS, queueDepth, roughEtaMin, slots }, tickets: list });
  }

  if (url.pathname === "/api/tickets" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      if (!config.projectPath || config.pipeline.length === 0) return json(res, { error: "프로젝트 경로와 파이프라인을 먼저 설정하세요." }, 400);
      try {
        const { title } = JSON.parse(body || "{}");
        const ticket = addTicket(title);
        json(res, sanitizeTicket(ticket), 201);
      } catch (err) {
        json(res, { error: err.message }, 500);
      }
    });
    return;
  }

  const logMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/log$/);
  if (logMatch && req.method === "GET") {
    const t = tickets[logMatch[1]];
    if (!t) return json(res, { error: "not found" }, 404);
    return json(res, sanitizeTicket(t));
  }

  const resolveActionMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/actions\/resolve$/);
  if (resolveActionMatch && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const t = tickets[resolveActionMatch[1]];
      if (!t) return json(res, { error: "not found" }, 404);
      if (expireStalePendingAction(t)) emitTicket(t);
      if (![TASK_STATUS.WAITING, TASK_STATUS.BLOCKED, TASK_STATUS.WAITING, TASK_STATUS.HALTED].includes(t.status)) {
        return json(res, { error: "액션을 처리할 수 있는 상태가 아닙니다." }, 400);
      }
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return json(res, { error: "JSON 파싱 실패" }, 400);
      }
      const result = resolvePendingAction(t, payload);
      if (result?.error) return json(res, { error: result.error }, result.code || 400);
      json(res, result);
    });
    return;
  }

  const nextMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/next$/);
  if (nextMatch && req.method === "POST") {
    const result = moveToNextStep(nextMatch[1]);
    if (result?.error) return json(res, { error: result.error }, result.code || 400);
    return json(res, result);
  }

  const stopMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/stop$/);
  if (stopMatch && req.method === "POST") {
    const t = tickets[stopMatch[1]];
    if (!t) return json(res, { error: "not found" }, 404);
    if (t.proc) t.proc.kill("SIGTERM");
    t.proc = null;
    running.delete(t.id);
    releaseWorkerSlot(t.id);
    t.workerSlot = null;
    t.status = TASK_STATUS.HALTED;
    t.pendingAction = createRecoveryPendingAction(t, "stopped_by_user", "작업이 중지되었습니다. 재시도/fallback/다음 단계 진행/중단 유지를 선택하세요.");
    emitTicket(t);
    schedule();
    return json(res, sanitizeTicket(t));
  }

  const moveStepMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/move-step$/);
  if (moveStepMatch && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const t = tickets[moveStepMatch[1]];
      if (!t) return json(res, { error: "not found" }, 404);
      if (t.status === TASK_STATUS.RUNNING) return json(res, { error: "running 상태에서는 이동할 수 없습니다." }, 400);
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { return json(res, { error: "JSON 파싱 실패" }, 400); }
      const stepIndex = Number(payload.stepIndex);
      const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
      if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= config.pipeline.length) return json(res, { error: "유효한 stepIndex가 필요합니다." }, 400);
      if (!reason) return json(res, { error: "이동 사유(reason)는 필수입니다." }, 400);
      const wip = canEnterStep(stepIndex, t.id);
      if (!wip.ok) return json(res, { error: wip.reason }, 400);
      const fromStep = t.currentStep;
      t.currentStep = stepIndex;
      t.status = TASK_STATUS.QUEUED;
      t.pendingAction = null;
      if (!queue.includes(t.id)) queue.push(t.id);
      addTimelineEvent({
        ticketId: t.id,
        type: "manual_step_override",
        fromStep,
        toStep: stepIndex,
        fromSkill: config.pipeline[fromStep] || null,
        toSkill: config.pipeline[stepIndex] || null,
        reason,
      });
      emitTicket(t);
      schedule();
      return json(res, sanitizeTicket(t));
    });
    return;
  }

  if (url.pathname === "/api/timeline" && req.method === "GET") {
    const ticketId = url.searchParams.get("ticketId");
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
    const filtered = timelineEvents
      .filter((ev) => (!ticketId || ev.ticketId === ticketId) && (!q || JSON.stringify(ev).toLowerCase().includes(q)))
      .slice(-limit)
      .reverse();
    return json(res, { events: filtered });
  }

  const deleteMatch = url.pathname.match(/^\/api\/tickets\/(\d+)$/);
  if (deleteMatch && req.method === "DELETE") {
    const t = tickets[deleteMatch[1]];
    if (!t) return json(res, { error: "not found" }, 404);
    if (t.proc) t.proc.kill("SIGTERM");
    running.delete(t.id);
    releaseWorkerSlot(t.id);
    const qIndex = queue.indexOf(t.id);
    if (qIndex >= 0) queue.splice(qIndex, 1);
    if (t.worktreePath) removeWorktree(t.worktreePath);
    delete tickets[deleteMatch[1]];
    saveDb();
    broadcast("ticket_deleted", { id: deleteMatch[1] });
    return json(res, { ok: true });
  }

  res.writeHead(404);
  res.end("Not found");
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`kancli running on http://localhost:${PORT}`);
    console.log(`Project: ${config.projectPath || "(not set)"}`);
    console.log(`Pipeline: ${config.pipeline.length ? config.pipeline.join(" → ") : "(not set)"}`);
  });
}

module.exports = {
  createPendingAction,
  normalizePendingAction,
  resolveEventPendingAction,
  resolveToolUsePendingAction,
  createUnknownInteractionFallbackPendingAction,
  runtimeIndicatesUserQuestion,
  inferSelectionFromTextPrompt,
  extractOptionsFromPrompt,
  isPendingActionExpired,
  validateActionResolutionPayload,
  expireStalePendingAction,
  writeJsonAtomic,
  loadJsonWithRecovery,
  repairDbState,
  planDispatch,
  createRecoveryPendingAction,
  getPipelineColumns,
  sanitizeTicket,
  canEnterStep,
  getSkillWipLimit,
};
