const http = require("node:http");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const CONFIG_FILE = process.env.DEVFLOW_CONFIG_FILE || path.join(__dirname, "devflow-config.json");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const WORKTREE_DIR = ".devflow-worktrees";

const DEFAULT_ALLOWED_TOOLS = "Read,Write,Edit,Glob,Grep,Bash,Agent";
const SKILL_ALLOWED_TOOLS = {
  "jira-to-plan": "Read,Write,Edit,Glob,Grep,Bash,Agent",
  "augmented-coding": "Read,Write,Edit,Glob,Grep,Bash,Agent,NotebookEdit",
  "push-pr": "Read,Glob,Grep,Bash,Agent",
  "planning-to-jira": "Read,Write,Edit,Glob,Grep,Bash,Agent",
};

const TASK_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  AWAITING_INPUT: "awaiting_input",
  REVIEW: "review",
  BLOCKED: "blocked",
  DONE: "done",
  HALTED: "halted",
};

// --- Config ---
let config = { projectPath: "", pipeline: [] };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
}

function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function scanSkills(projectPath) {
  const skillsDir = path.join(projectPath, ".claude", "skills");
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => fs.existsSync(path.join(skillsDir, d.name, "SKILL.md")))
    .map(d => d.name)
    .sort();
}

function listPlanFiles(basePath) {
  const dir = basePath || config.projectPath;
  const planDir = path.join(dir, ".claude", "skills", "augmented-coding");
  if (!fs.existsSync(planDir)) return [];
  return fs.readdirSync(planDir)
    .filter(f => f.endsWith("-plan.md"))
    .map(f => {
      const stat = fs.statSync(path.join(planDir, f));
      return { filename: f, modifiedAt: stat.mtimeMs };
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function readPlanFile(filename, basePath) {
  const dir = basePath || config.projectPath;
  const planPath = path.join(dir, ".claude", "skills", "augmented-coding", filename);
  if (!fs.existsSync(planPath)) return null;
  return fs.readFileSync(planPath, "utf-8");
}

loadConfig();

// --- Worktree management ---
function createWorktree(jiraTicket) {
  const worktreeBase = path.join(config.projectPath, WORKTREE_DIR);
  if (!fs.existsSync(worktreeBase)) {
    fs.mkdirSync(worktreeBase, { recursive: true });
  }

  const safeName = jiraTicket.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  const branchName = `feat/${safeName}`;
  const worktreePath = path.join(worktreeBase, safeName);

  if (fs.existsSync(worktreePath)) {
    return { worktreePath, branchName };
  }

  try {
    execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
      cwd: config.projectPath,
      stdio: "pipe",
    });
  } catch {
    try {
      execSync(`git worktree add "${worktreePath}" "${branchName}"`, {
        cwd: config.projectPath,
        stdio: "pipe",
      });
    } catch (err2) {
      throw new Error(`worktree 생성 실패: ${err2.message}`);
    }
  }

  return { worktreePath, branchName };
}

function removeWorktree(worktreePath) {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: config.projectPath,
      stdio: "pipe",
    });
  } catch {}
}

// --- In-memory store ---
const tickets = {};
let nextId = 1;

function createPendingAction(type, prompt, options = [], metadata = {}) {
  return {
    type,
    prompt,
    options: Array.isArray(options) ? options : [],
    metadata: metadata || {},
  };
}

function setPendingAction(ticket, pendingAction) {
  ticket.pendingAction = pendingAction || null;
  ticket.status = pendingAction ? TASK_STATUS.AWAITING_INPUT : ticket.status;
}

function addArtifact(ticket, artifact) {
  if (!artifact) return;
  const normalized = {
    type: artifact.type || "artifact",
    name: artifact.name || artifact.path || artifact.filename || "unnamed",
    path: artifact.path || null,
    url: artifact.url || null,
    contentType: artifact.contentType || artifact.mimeType || null,
    size: artifact.size || null,
    metadata: artifact.metadata || {},
    createdAt: Date.now(),
  };
  ticket.artifacts.push(normalized);
}

function createBackwardCompatibleAction(skill, ticket) {
  if (skill !== "augmented-coding") return null;
  return createPendingAction(
    "selection",
    "다음 실행 액션을 선택하세요.",
    [
      { id: "go", label: "go", payload: { action: "go", planFile: ticket.planFile || null } },
      { id: "commit", label: "commit", payload: { action: "commit", planFile: ticket.planFile || null } },
      { id: "refactor", label: "refactor", payload: { action: "refactor", planFile: ticket.planFile || null } },
      { id: "advance", label: "다음 단계로 진행", payload: { advance: true } },
    ],
    { source: "compat.augmented-coding" }
  );
}

function addTicket(jiraTicket) {
  const id = String(nextId++);
  const firstSkill = config.pipeline[0];
  const { worktreePath, branchName } = createWorktree(jiraTicket);

  tickets[id] = {
    id,
    jiraTicket,
    branchName,
    worktreePath,
    currentStep: 0,
    status: TASK_STATUS.QUEUED,
    log: "",
    planFile: null,
    planContent: null,
    pendingAction: null,
    artifacts: [],
    proc: null,
    createdAt: Date.now(),
  };

  const ticket = tickets[id];

  if (firstSkill === "jira-to-plan") {
    detectPlanFile(ticket);
    if (ticket.planFile) {
      setPendingAction(ticket, createPendingAction(
        "selection",
        `기존 plan 파일(${ticket.planFile})이 발견되었습니다. 어떻게 진행할까요?`,
        [
          { id: "use-existing-plan", label: "기존 Plan 사용 후 다음 단계", payload: { advance: true } },
          { id: "rerun-plan", label: "Plan 다시 생성", payload: { rerunCurrentStep: true } },
        ],
        { reason: "existing_plan_detected", planFile: ticket.planFile }
      ));
      ticket.log = `기존 plan 파일 발견: ${ticket.planFile}\n내용을 확인하고 진행 여부를 선택하세요.`;
      return ticket;
    }
  }

  if (firstSkill) runStep(id);
  return ticket;
}

function toolInputSummary(name, input) {
  if (!input) return "";
  if (name === "Read") return input.file_path || "";
  if (name === "Write") return input.file_path || "";
  if (name === "Edit") return input.file_path || "";
  if (name === "Glob") return input.pattern || "";
  if (name === "Grep") return input.pattern || "";
  if (name === "Bash") return (input.command || "").substring(0, 80);
  if (name === "Agent") return (input.prompt || "").substring(0, 60);
  return "";
}

function resolutionToPrompt(resolution, ticket) {
  if (!resolution) return "";
  if (resolution.option?.payload?.action) {
    const planFile = resolution.option.payload.planFile || ticket.planFile || `${ticket.jiraTicket}-plan.md`;
    return `action: ${resolution.option.payload.action} plan 파일: ${planFile}`;
  }

  const lines = ["[runtime action resolution]"];
  if (resolution.actionId) lines.push(`actionId: ${resolution.actionId}`);
  if (resolution.input) lines.push(`input: ${resolution.input}`);
  if (resolution.option) lines.push(`option: ${JSON.stringify(resolution.option)}`);
  if (resolution.metadata) lines.push(`metadata: ${JSON.stringify(resolution.metadata)}`);
  return lines.join("\n");
}

function resolveEventPendingAction(ev) {
  const src = ev?.event || ev?.data || ev;
  const pending = src?.pendingAction || src?.pending_action || src?.action;
  if (!pending || typeof pending !== "object") return null;

  const options = pending.options || pending.choices || [];
  return createPendingAction(
    pending.type || "selection",
    pending.prompt || pending.message || "입력이 필요합니다.",
    options,
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

function processContentBlocks(ticket, blocks) {
  for (const b of blocks || []) {
    if (b.type === "text") {
      ticket.log += b.text;
      continue;
    }

    if (b.type === "tool_use") {
      const summary = toolInputSummary(b.name, b.input);
      ticket.log += `\n> [${b.name}] ${summary}\n`;
      continue;
    }

    if (b.type === "tool_result" && b.content) {
      const text = typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? b.content.filter(c => c.type === "text").map(c => c.text).join("")
          : "";
      if (text) {
        const trimmed = text.length > 500 ? text.substring(0, 500) + "..." : text;
        ticket.log += trimmed + "\n";
      }
      continue;
    }

    if (["pending_action", "action_request", "action"].includes(b.type)) {
      const pending = resolveEventPendingAction({ event: b });
      if (pending) setPendingAction(ticket, pending);
      continue;
    }

    if (["artifact", "output_file", "file"].includes(b.type)) {
      const artifact = resolveEventArtifact({ event: b });
      if (artifact) addArtifact(ticket, artifact);
      continue;
    }
  }
}

function parseStreamEvent(ticket, ev) {
  if (!ev || typeof ev !== "object") return;

  if (ev.type === "assistant" && ev.message?.content) {
    processContentBlocks(ticket, ev.message.content);
    return;
  }

  if (ev.type === "user" && ev.message?.content) {
    processContentBlocks(ticket, ev.message.content);
    return;
  }

  if (ev.type === "result" && ev.result) {
    ticket.log += "\n" + ev.result;
    return;
  }

  if (["event", "action", "artifact", "log"].includes(ev.type)) {
    const pending = resolveEventPendingAction(ev);
    if (pending) setPendingAction(ticket, pending);

    const artifact = resolveEventArtifact(ev);
    if (artifact) addArtifact(ticket, artifact);

    if (typeof ev.message === "string") ticket.log += ev.message + "\n";
    if (typeof ev.log === "string") ticket.log += ev.log + "\n";
  }
}

function runStep(id, options = {}) {
  const ticket = tickets[id];
  if (!ticket) return;

  const skill = config.pipeline[ticket.currentStep];
  ticket.status = TASK_STATUS.RUNNING;
  ticket.pendingAction = null;
  ticket.log = "";

  const resolutionPrompt = resolutionToPrompt(options.resolution, ticket);
  const prompt = resolutionPrompt
    ? `/${skill} ${ticket.jiraTicket}\n${resolutionPrompt}`
    : `/${skill} ${ticket.jiraTicket}`;

  const allowedTools = SKILL_ALLOWED_TOOLS[skill] || DEFAULT_ALLOWED_TOOLS;
  const env = {
    ...process.env,
    DEVFLOW_ALLOWED_TOOLS: allowedTools,
  };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const cwd = ticket.worktreePath;
  const proc = spawn(
    CLAUDE_BIN,
    ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] }
  );

  ticket.proc = proc;
  proc.stdin.end(prompt + "\n");

  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        parseStreamEvent(ticket, JSON.parse(line));
      } catch {
        ticket.log += line + "\n";
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    ticket.log += chunk.toString();
  });

  proc.on("exit", (code) => {
    ticket.proc = null;
    ticket.log += `\n\n--- 완료 (exit ${code}) ---`;

    if (skill === "jira-to-plan") detectPlanFile(ticket);

    if (!ticket.pendingAction && code !== 0) {
      ticket.status = TASK_STATUS.BLOCKED;
      return;
    }

    if (!ticket.pendingAction) {
      const compatAction = createBackwardCompatibleAction(skill, ticket);
      if (compatAction) {
        setPendingAction(ticket, compatAction);
      } else {
        ticket.status = TASK_STATUS.REVIEW;
      }
      return;
    }

    ticket.status = TASK_STATUS.AWAITING_INPUT;
  });

  proc.on("error", (err) => {
    ticket.proc = null;
    ticket.log += `\n\n--- 에러: ${err.message} ---`;
    ticket.status = TASK_STATUS.BLOCKED;
    setPendingAction(ticket, createPendingAction(
      "selection",
      "실행 중 오류가 발생했습니다. 어떻게 진행할까요?",
      [
        { id: "retry", label: "현재 단계 재시도", payload: { rerunCurrentStep: true } },
        { id: "halt", label: "중단", payload: { halt: true } },
      ],
      { reason: "process_error" }
    ));
  });
}

function detectPlanFile(ticket) {
  const planDir = path.join(ticket.worktreePath, ".claude", "skills", "augmented-coding");
  if (!fs.existsSync(planDir)) return;

  const files = fs.readdirSync(planDir).filter(f =>
    f.toLowerCase().startsWith(ticket.jiraTicket.toLowerCase()) && f.endsWith("-plan.md")
  );

  if (files.length > 0) {
    const sorted = files.map(f => ({
      name: f,
      mtime: fs.statSync(path.join(planDir, f)).mtimeMs,
    })).sort((a, b) => b.mtime - a.mtime);

    ticket.planFile = sorted[0].name;
    ticket.planContent = fs.readFileSync(path.join(planDir, sorted[0].name), "utf-8");
    addArtifact(ticket, {
      type: "plan",
      name: ticket.planFile,
      path: path.join(planDir, ticket.planFile),
      contentType: "text/markdown",
      metadata: { generatedBy: "jira-to-plan" },
    });
  }
}

function resolvePendingAction(ticket, payload = {}) {
  const pending = ticket.pendingAction;
  if (!pending) return { error: "대기 중인 액션이 없습니다.", code: 400 };

  const selected = pending.options?.find(o => o.id === payload.actionId) || null;
  const mergedPayload = { ...(selected?.payload || {}), ...(payload.metadata || {}) };

  if (payload.actionId === "advance" || mergedPayload.advance) {
    return moveToNextStep(ticket.id);
  }

  if (payload.actionId === "retry" || mergedPayload.rerunCurrentStep) {
    runStep(ticket.id, {
      resolution: {
        actionId: payload.actionId,
        input: payload.input,
        option: selected,
        metadata: payload.metadata,
      },
    });
    return sanitizeTicket(ticket);
  }

  if (payload.actionId === "halt" || mergedPayload.halt) {
    ticket.status = TASK_STATUS.HALTED;
    ticket.pendingAction = null;
    return sanitizeTicket(ticket);
  }

  runStep(ticket.id, {
    resolution: {
      actionId: payload.actionId,
      input: payload.input,
      option: selected,
      metadata: payload.metadata,
    },
  });
  return sanitizeTicket(ticket);
}

function moveToNextStep(id) {
  const t = tickets[id];
  if (!t) return { error: "not found", code: 404 };

  if (![TASK_STATUS.REVIEW, TASK_STATUS.AWAITING_INPUT, TASK_STATUS.BLOCKED].includes(t.status)) {
    return { error: "다음 단계로 진행할 수 없는 상태입니다.", code: 400 };
  }

  const next = t.currentStep + 1;
  if (next >= config.pipeline.length) {
    t.status = TASK_STATUS.DONE;
    t.pendingAction = null;
    return sanitizeTicket(t);
  }

  t.currentStep = next;
  t.status = TASK_STATUS.QUEUED;
  t.pendingAction = null;
  runStep(t.id);
  return sanitizeTicket(t);
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    return;
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    json(res, { ...config, availableSkills: config.projectPath ? scanSkills(config.projectPath) : [] });
    return;
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
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
    json(res, { skills: projectPath ? scanSkills(projectPath) : [] });
    return;
  }

  if (url.pathname === "/api/plans" && req.method === "GET") {
    json(res, { plans: listPlanFiles() });
    return;
  }

  const planMatch = url.pathname.match(/^\/api\/plans\/(.+)$/);
  if (planMatch && req.method === "GET") {
    const content = readPlanFile(decodeURIComponent(planMatch[1]));
    if (!content) { json(res, { error: "not found" }, 404); return; }
    json(res, { filename: planMatch[1], content });
    return;
  }

  if (url.pathname === "/api/tickets" && req.method === "GET") {
    const list = Object.values(tickets)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ proc, ...rest }) => rest);
    json(res, { pipeline: config.pipeline, tickets: list });
    return;
  }

  if (url.pathname === "/api/tickets" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!config.projectPath || config.pipeline.length === 0) {
        json(res, { error: "프로젝트 경로와 파이프라인을 먼저 설정하세요." }, 400);
        return;
      }
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
    if (!t) { json(res, { error: "not found" }, 404); return; }
    json(res, {
      status: t.status,
      currentStep: t.currentStep,
      log: t.log,
      planFile: t.planFile,
      planContent: t.planContent,
      pendingAction: t.pendingAction,
      artifacts: t.artifacts,
      branchName: t.branchName,
      worktreePath: t.worktreePath,
    });
    return;
  }

  const resolveActionMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/actions\/resolve$/);
  if (resolveActionMatch && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const t = tickets[resolveActionMatch[1]];
      if (!t) { json(res, { error: "not found" }, 404); return; }

      if (![TASK_STATUS.AWAITING_INPUT, TASK_STATUS.BLOCKED, TASK_STATUS.REVIEW].includes(t.status)) {
        json(res, { error: "액션을 처리할 수 있는 상태가 아닙니다." }, 400);
        return;
      }

      const payload = JSON.parse(body || "{}");
      const result = resolvePendingAction(t, payload);
      if (result?.error) {
        json(res, { error: result.error }, result.code || 400);
      } else {
        json(res, result);
      }
    });
    return;
  }

  // Backward-compatible augmented-coding endpoint
  const actionMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/action$/);
  if (actionMatch && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const t = tickets[actionMatch[1]];
      if (!t) { json(res, { error: "not found" }, 404); return; }
      const { action, planFile } = JSON.parse(body || "{}");
      const result = resolvePendingAction(t, {
        actionId: action,
        metadata: { planFile },
      });
      if (result?.error) json(res, { error: result.error }, result.code || 400);
      else json(res, result);
    });
    return;
  }

  const nextMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/next$/);
  if (nextMatch && req.method === "POST") {
    const result = moveToNextStep(nextMatch[1]);
    if (result?.error) json(res, { error: result.error }, result.code || 400);
    else json(res, result);
    return;
  }

  const stopMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/stop$/);
  if (stopMatch && req.method === "POST") {
    const t = tickets[stopMatch[1]];
    if (!t) { json(res, { error: "not found" }, 404); return; }
    if (t.proc) {
      t.proc.kill("SIGTERM");
      t.proc = null;
      t.log += "\n\n--- 사용자에 의해 중지됨 ---";
      t.status = TASK_STATUS.HALTED;
      setPendingAction(t, createPendingAction(
        "selection",
        "작업이 중지되었습니다. 다음 동작을 선택하세요.",
        [
          { id: "retry", label: "현재 단계 재실행", payload: { rerunCurrentStep: true } },
          { id: "advance", label: "다음 단계로 진행", payload: { advance: true } },
          { id: "halt", label: "중단 유지", payload: { halt: true } },
        ],
        { reason: "stopped_by_user" }
      ));
    }
    json(res, sanitizeTicket(t));
    return;
  }

  // Backward compatibility wrappers for old review-plan endpoints
  const skipPlanMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/skip-plan$/);
  if (skipPlanMatch && req.method === "POST") {
    const t = tickets[skipPlanMatch[1]];
    if (!t) { json(res, { error: "not found" }, 404); return; }
    const result = resolvePendingAction(t, { actionId: "use-existing-plan" });
    if (result?.error) json(res, { error: result.error }, result.code || 400);
    else json(res, result);
    return;
  }

  const rerunPlanMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/rerun-plan$/);
  if (rerunPlanMatch && req.method === "POST") {
    const t = tickets[rerunPlanMatch[1]];
    if (!t) { json(res, { error: "not found" }, 404); return; }
    const result = resolvePendingAction(t, { actionId: "rerun-plan" });
    if (result?.error) json(res, { error: result.error }, result.code || 400);
    else json(res, result);
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/tickets\/(\d+)$/);
  if (deleteMatch && req.method === "DELETE") {
    const t = tickets[deleteMatch[1]];
    if (!t) { json(res, { error: "not found" }, 404); return; }
    if (t.proc) {
      t.proc.kill("SIGTERM");
      t.proc = null;
    }
    if (t.worktreePath) removeWorktree(t.worktreePath);
    delete tickets[deleteMatch[1]];
    json(res, { ok: true });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

function sanitizeTicket(t) {
  if (!t || !t.id) return t;
  const { proc, ...rest } = t;
  return rest;
}

function json(res, data, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

server.listen(PORT, () => {
  console.log(`DevFlow running on http://localhost:${PORT}`);
  console.log(`Project: ${config.projectPath || "(not set)"}`);
  console.log(`Pipeline: ${config.pipeline.length ? config.pipeline.join(" → ") : "(not set)"}`);
});
