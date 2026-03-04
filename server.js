const http = require("node:http");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createRedlineState, evaluateRedline } = require("./lib/redline");

const PORT = Number(process.env.PORT || 3000);
const CONFIG_FILE = process.env.DEVFLOW_CONFIG_FILE || path.join(__dirname, "devflow-config.json");
const DB_FILE = process.env.DEVFLOW_DB_FILE || path.join(__dirname, "data", "devflow-db.json");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const WORKTREE_DIR = ".devflow-worktrees";
const DEFAULT_ALLOWED_TOOLS = "Read,Write,Edit,Glob,Grep,Bash,Agent";
const MAX_WORKERS = 3;
const PENDING_ACTION_TTL_MS = Number(process.env.DEVFLOW_PENDING_ACTION_TTL_MS || 15 * 60 * 1000);

const TASK_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  AWAITING_INPUT: "awaiting_input",
  REVIEW: "review",
  BLOCKED: "blocked",
  DONE: "done",
  HALTED: "halted",
};

let config = { projectPath: "", pipeline: [] };
const tickets = {};
const queue = [];
const running = new Set();
let nextId = 1;
const sseClients = new Set();

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

function loadConfig() {
  const loaded = loadJsonWithRecovery(CONFIG_FILE, { projectPath: "", pipeline: [] });
  if (loaded && typeof loaded === "object") {
    config = {
      projectPath: typeof loaded.projectPath === "string" ? loaded.projectPath : "",
      pipeline: Array.isArray(loaded.pipeline) ? loaded.pipeline.filter((s) => typeof s === "string" && s.trim()) : [],
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
  const parsed = repairDbState(loadJsonWithRecovery(DB_FILE, { nextId: 1, queue: [], tickets: [] }));
  nextId = parsed.nextId;
  queue.push(...parsed.queue.filter((id) => !tickets[id]));

  for (const t of parsed.tickets) {
    tickets[t.id] = { ...t, proc: null };
    if (tickets[t.id].pendingAction && !tickets[t.id].pendingAction.createdAt) {
      tickets[t.id].pendingAction = createPendingAction(
        tickets[t.id].pendingAction.type,
        tickets[t.id].pendingAction.prompt,
        tickets[t.id].pendingAction.options,
        tickets[t.id].pendingAction.metadata
      );
    }
    if (tickets[t.id].status === TASK_STATUS.RUNNING) tickets[t.id].status = TASK_STATUS.BLOCKED;
  }

  const maxTicketId = Math.max(0, ...Object.keys(tickets).map((id) => Number(id) || 0));
  if (nextId <= maxTicketId) nextId = maxTicketId + 1;
}

function saveDb() {
  const data = {
    nextId,
    queue,
    tickets: Object.values(tickets).map(({ proc, ...rest }) => rest),
  };
  writeJsonAtomic(DB_FILE, data);
}

function scanSkills(projectPath) {
  const skillsDir = path.join(projectPath, ".claude", "skills");
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => fs.existsSync(path.join(skillsDir, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort();
}

function createWorktree(jiraTicket) {
  const worktreeBase = path.join(config.projectPath, WORKTREE_DIR);
  if (!fs.existsSync(worktreeBase)) fs.mkdirSync(worktreeBase, { recursive: true });

  const safeName = jiraTicket.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
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
  if (!option || typeof option !== "object") return null;
  const id = typeof option.id === "string" && option.id.trim() ? option.id.trim() : `option_${index + 1}`;
  const label = typeof option.label === "string" && option.label.trim() ? option.label.trim() : id;
  return { id, label, payload: option.payload && typeof option.payload === "object" ? option.payload : {} };
}

function createPendingAction(type, prompt, options = [], metadata = {}) {
  const normalizedType = typeof type === "string" && type.trim() ? type.trim() : "selection";
  const normalizedPrompt = typeof prompt === "string" && prompt.trim() ? prompt.trim() : "입력이 필요합니다.";
  const normalizedOptions = Array.isArray(options)
    ? options.map((option, idx) => normalizePendingActionOption(option, idx)).filter(Boolean)
    : [];
  const now = Date.now();
  return {
    type: normalizedType,
    prompt: normalizedPrompt,
    options: normalizedOptions,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    createdAt: now,
    expiresAt: now + PENDING_ACTION_TTL_MS,
  };
}

function isPendingActionExpired(pendingAction) {
  if (!pendingAction) return false;
  if (typeof pendingAction.expiresAt !== "number") return false;
  return Date.now() > pendingAction.expiresAt;
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
  const lines = ticket.log.split("\n").slice(-80);
  const commitLine = [...lines].reverse().find((l) => /\b[0-9a-f]{7,40}\b/.test(l) || /^commit\s+/i.test(l));
  const issueLine = [...lines].reverse().find((l) => /(error|fail|blocked|issue)/i.test(l));
  ticket.summary = {
    latestCommit: commitLine || "-",
    issue: issueLine || "-",
    nextAction: ticket.pendingAction?.prompt || (ticket.status === TASK_STATUS.REVIEW ? "review and advance" : "-"),
  };
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch {}
  }
}

function emitEvent(event, payload = {}) {
  broadcast(event, { timestamp: Date.now(), ...payload });
}

function emitTicket(ticket) {
  updateSummary(ticket);
  saveDb();
  broadcast("ticket", sanitizeTicket(ticket));
  emitEvent("task_lifecycle", { ticketId: ticket.id, status: ticket.status, currentStep: ticket.currentStep });
}

function resolveEventPendingAction(ev) {
  const src = ev?.event || ev?.data || ev;
  const pending = src?.pendingAction || src?.pending_action || src?.action;
  if (!pending || typeof pending !== "object") return null;
  return createPendingAction(
    pending.type || "selection",
    pending.prompt || pending.message || "입력이 필요합니다.",
    pending.options || pending.choices || [],
    pending.metadata || {}
  );
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

function applyRedline(ticket, input = {}) {
  const result = evaluateRedline(ticket.redline, input);
  ticket.redline = result.state;
  if (!result.halted || ticket.status === TASK_STATUS.HALTED) return;

  ticket.status = TASK_STATUS.HALTED;
  emitEvent("redline_event", { ticketId: ticket.id, reason: result.reason, kind: "halt" });
  ticket.pendingAction = createPendingAction(
    "selection",
    `Redline halt: ${result.reason}`,
    [
      { id: "retry", label: "현재 단계 재시도", payload: { rerunCurrentStep: true } },
      { id: "halt", label: "중단 유지", payload: { halt: true } },
    ],
    { reason: result.reason, source: "redline" }
  );
}

function expireStalePendingAction(ticket) {
  if (!ticket?.pendingAction || !isPendingActionExpired(ticket.pendingAction)) return false;
  ticket.status = TASK_STATUS.BLOCKED;
  ticket.pendingAction = createPendingAction(
    "selection",
    "이전 액션 요청이 만료되었습니다. 현재 단계를 다시 시도하거나 중단을 유지하세요.",
    [
      { id: "retry", label: "현재 단계 재시도", payload: { rerunCurrentStep: true } },
      { id: "halt", label: "중단 유지", payload: { halt: true } }
    ],
    { reason: "stale_action_expired", source: "runtime_validation" }
  );
  return true;
}

function processText(ticket, text) {
  if (!text) return;
  ticket.log += text;
  applyRedline(ticket, { text });
}

function processContentBlocks(ticket, blocks) {
  for (const b of blocks || []) {
    if (b.type === "text") processText(ticket, b.text);
    else if (b.type === "tool_use") processText(ticket, `\n> [${b.name}]\n`);
    else if (b.type === "tool_result" && b.content) {
      const text = typeof b.content === "string" ? b.content : "";
      processText(ticket, text.length > 500 ? `${text.substring(0, 500)}...\n` : `${text}\n`);
    } else if (["pending_action", "action_request", "action"].includes(b.type)) {
      const pa = resolveEventPendingAction({ event: b });
      if (pa) {
        ticket.pendingAction = pa;
        emitEvent("step_event", { ticketId: ticket.id, currentStep: ticket.currentStep, kind: "pending_action", pendingActionType: pa.type });
      }
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
  if (pa) {
    ticket.pendingAction = pa;
    emitEvent("step_event", { ticketId: ticket.id, currentStep: ticket.currentStep, kind: "pending_action", pendingActionType: pa.type });
  }

  const artifact = resolveEventArtifact(ev);
  if (artifact) addArtifact(ticket, artifact);

  if (typeof ev.signal === "string") applyRedline(ticket, { signal: ev.signal });
  if (typeof ev.message === "string") processText(ticket, `${ev.message}\n`);
  if (typeof ev.log === "string") processText(ticket, `${ev.log}\n`);
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
  ticket.pendingAction = null;
  ticket.log = "";
  running.add(id);
  emitEvent("step_event", { ticketId: ticket.id, currentStep: ticket.currentStep, kind: "step_started" });
  emitTicket(ticket);

  const resolutionPrompt = resolutionToPrompt(options.resolution);
  const prompt = resolutionPrompt ? `/${skill} ${ticket.jiraTicket}\n${resolutionPrompt}` : `/${skill} ${ticket.jiraTicket}`;

  const env = { ...process.env, DEVFLOW_ALLOWED_TOOLS: DEFAULT_ALLOWED_TOOLS };
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
    ticket.proc = null;
    emitEvent("step_event", { ticketId: ticket.id, currentStep: ticket.currentStep, kind: "step_completed", exitCode: code });
    processText(ticket, `\n\n--- 완료 (exit ${code}) ---`);

    if (ticket.status === TASK_STATUS.HALTED) {
      emitTicket(ticket);
      schedule();
      return;
    }

    if (!ticket.pendingAction && code !== 0) ticket.status = TASK_STATUS.BLOCKED;
    else if (!ticket.pendingAction) ticket.status = TASK_STATUS.REVIEW;
    else ticket.status = TASK_STATUS.AWAITING_INPUT;

    emitTicket(ticket);
    schedule();
  });

  proc.on("error", (err) => {
    running.delete(id);
    ticket.proc = null;
    emitEvent("step_event", { ticketId: ticket.id, currentStep: ticket.currentStep, kind: "step_error", error: err.message });
    processText(ticket, `\n\n--- 에러: ${err.message} ---`);
    ticket.status = TASK_STATUS.BLOCKED;
    ticket.pendingAction = createPendingAction(
      "selection",
      "실행 중 오류가 발생했습니다.",
      [{ id: "retry", label: "현재 단계 재시도", payload: { rerunCurrentStep: true } }, { id: "halt", label: "중단", payload: { halt: true } }],
      { reason: "process_error" }
    );
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

function addTicket(jiraTicket) {
  const id = String(nextId++);
  const { worktreePath, branchName } = createWorktree(jiraTicket);
  const t = {
    id,
    jiraTicket,
    branchName,
    worktreePath,
    currentStep: 0,
    status: TASK_STATUS.QUEUED,
    log: "",
    pendingAction: null,
    artifacts: [],
    redline: createRedlineState(),
    summary: { latestCommit: "-", issue: "-", nextAction: "-" },
    createdAt: Date.now(),
    proc: null,
  };
  tickets[id] = t;
  queue.push(id);
  emitTicket(t);
  schedule();
  return t;
}

function moveToNextStep(id) {
  const t = tickets[id];
  if (!t) return { error: "not found", code: 404 };
  if (![TASK_STATUS.REVIEW, TASK_STATUS.AWAITING_INPUT, TASK_STATUS.BLOCKED, TASK_STATUS.HALTED].includes(t.status)) {
    return { error: "다음 단계로 진행할 수 없는 상태입니다.", code: 400 };
  }

  const next = t.currentStep + 1;
  if (next >= config.pipeline.length) {
    t.status = TASK_STATUS.DONE;
    t.pendingAction = null;
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

  if (typeof payload.actionId !== "string" || !payload.actionId.trim()) {
    return { error: "actionId는 필수 문자열입니다." };
  }

  const actionId = payload.actionId.trim();
  const selected = pending.options?.find((o) => o.id === actionId) || null;
  const builtin = ["retry", "halt", "advance"];

  if (!selected && !builtin.includes(actionId)) {
    return { error: `알 수 없는 actionId: ${actionId}` };
  }

  if (payload.metadata !== undefined && (typeof payload.metadata !== "object" || Array.isArray(payload.metadata))) {
    return { error: "metadata는 객체여야 합니다." };
  }

  return { actionId, selected, metadata: payload.metadata || {}, input: typeof payload.input === "string" ? payload.input : "" };
}

function resolvePendingAction(ticket, payload = {}) {
  const pending = ticket.pendingAction;
  if (!pending) return { error: "대기 중인 액션이 없습니다.", code: 400 };

  const validated = validateActionResolutionPayload(payload, pending);
  if (validated.error) {
    if (validated.stale) expireStalePendingAction(ticket);
    return { error: validated.error, code: 400 };
  }

  const mergedPayload = { ...(validated.selected?.payload || {}), ...(validated.metadata || {}) };

  if (validated.actionId === "advance" || mergedPayload.advance) return moveToNextStep(ticket.id);
  if (validated.actionId === "retry" || mergedPayload.rerunCurrentStep) {
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

function sanitizeTicket(t) {
  if (!t || !t.id) return t;
  const { proc, ...rest } = t;
  return rest;
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
    const list = Object.values(tickets).sort((a, b) => b.createdAt - a.createdAt).map(sanitizeTicket);
    return json(res, { pipeline: config.pipeline, queue, running: Array.from(running), tickets: list });
  }

  if (url.pathname === "/api/tickets" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      if (!config.projectPath || config.pipeline.length === 0) return json(res, { error: "프로젝트 경로와 파이프라인을 먼저 설정하세요." }, 400);
      try {
        const { jiraTicket } = JSON.parse(body || "{}");
        const ticket = addTicket(jiraTicket);
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
      if (![TASK_STATUS.AWAITING_INPUT, TASK_STATUS.BLOCKED, TASK_STATUS.REVIEW, TASK_STATUS.HALTED].includes(t.status)) {
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
    t.status = TASK_STATUS.HALTED;
    t.pendingAction = createPendingAction("selection", "작업이 중지되었습니다.", [
      { id: "retry", label: "현재 단계 재시도", payload: { rerunCurrentStep: true } },
      { id: "advance", label: "다음 단계로 진행", payload: { advance: true } },
      { id: "halt", label: "중단 유지", payload: { halt: true } },
    ], { reason: "stopped_by_user" });
    emitTicket(t);
    schedule();
    return json(res, sanitizeTicket(t));
  }

  const deleteMatch = url.pathname.match(/^\/api\/tickets\/(\d+)$/);
  if (deleteMatch && req.method === "DELETE") {
    const t = tickets[deleteMatch[1]];
    if (!t) return json(res, { error: "not found" }, 404);
    if (t.proc) t.proc.kill("SIGTERM");
    running.delete(t.id);
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
    console.log(`DevFlow running on http://localhost:${PORT}`);
    console.log(`Project: ${config.projectPath || "(not set)"}`);
    console.log(`Pipeline: ${config.pipeline.length ? config.pipeline.join(" → ") : "(not set)"}`);
  });
}

module.exports = {
  createPendingAction,
  isPendingActionExpired,
  validateActionResolutionPayload,
  expireStalePendingAction,
  writeJsonAtomic,
  loadJsonWithRecovery,
  repairDbState,
  planDispatch,
};
