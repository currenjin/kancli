const http = require("node:http");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 3000;
const CONFIG_FILE = path.join(__dirname, "devflow-config.json");
const WORKTREE_DIR = ".devflow-worktrees";

// Tools to auto-approve per skill type
const SKILL_ALLOWED_TOOLS = {
  "jira-to-plan": "Read,Write,Edit,Glob,Grep,Bash,Agent",
  "augmented-coding": "Read,Write,Edit,Glob,Grep,Bash,Agent,NotebookEdit",
  "push-pr": "Read,Glob,Grep,Bash,Agent",
  "planning-to-jira": "Read,Write,Edit,Glob,Grep,Bash,Agent",
};
const DEFAULT_ALLOWED_TOOLS = "Read,Write,Edit,Glob,Grep,Bash,Agent";

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

  // If worktree already exists, reuse it
  if (fs.existsSync(worktreePath)) {
    return { worktreePath, branchName };
  }

  try {
    // Create worktree with new branch from current HEAD
    execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
      cwd: config.projectPath,
      stdio: "pipe",
    });
  } catch (err) {
    // Branch might already exist — try without -b
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

function addTicket(jiraTicket) {
  const id = String(nextId++);
  const firstSkill = config.pipeline[0];

  // Create worktree for this ticket
  const { worktreePath, branchName } = createWorktree(jiraTicket);

  tickets[id] = {
    id,
    jiraTicket,
    branchName,
    worktreePath,
    currentStep: 0,
    status: firstSkill === "augmented-coding" ? "awaiting-action" : "running",
    log: "",
    planFile: null,
    planContent: null,
    proc: null,
    createdAt: Date.now(),
  };

  // If first step is jira-to-plan, check if plan already exists
  if (firstSkill === "jira-to-plan") {
    detectPlanFile(tickets[id]);
    if (tickets[id].planFile) {
      tickets[id].status = "review-plan";
      tickets[id].log = `기존 plan 파일 발견: ${tickets[id].planFile}\n내용을 확인하고 진행 여부를 선택하세요.`;
      return tickets[id];
    }
    runStep(id);
  } else if (firstSkill !== "augmented-coding") {
    runStep(id);
  }
  return tickets[id];
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

function runStep(id, options = {}) {
  const ticket = tickets[id];
  if (!ticket) return;

  const skill = config.pipeline[ticket.currentStep];
  ticket.status = "running";
  ticket.log = "";

  // Build prompt
  let prompt;
  if (skill === "augmented-coding" && options.action) {
    const planFile = options.planFile || ticket.planFile || `${ticket.jiraTicket}-plan.md`;
    prompt = `/${skill} plan 파일: ${planFile} action: ${options.action} ticket: ${ticket.jiraTicket}`;
  } else {
    prompt = `/${skill} ${ticket.jiraTicket}`;
  }

  const allowedTools = SKILL_ALLOWED_TOOLS[skill] || DEFAULT_ALLOWED_TOOLS;

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  // Run in ticket's worktree directory
  const cwd = ticket.worktreePath;

  const proc = spawn(
    "claude",
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
        const ev = JSON.parse(line);
        if (ev.type === "assistant" && ev.message?.content) {
          for (const b of ev.message.content) {
            if (b.type === "text") ticket.log += b.text;
            else if (b.type === "tool_use") {
              const summary = toolInputSummary(b.name, b.input);
              ticket.log += `\n> [${b.name}] ${summary}\n`;
            }
          }
        } else if (ev.type === "user" && ev.message?.content) {
          for (const b of ev.message.content) {
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
            }
          }
        } else if (ev.type === "result" && ev.result) {
          ticket.log += "\n" + ev.result;
        }
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

    if (skill === "jira-to-plan") {
      detectPlanFile(ticket);
    }

    ticket.status = (skill === "augmented-coding") ? "awaiting-action" : "review";
  });

  proc.on("error", (err) => {
    ticket.proc = null;
    ticket.log += `\n\n--- 에러: ${err.message} ---`;
    ticket.status = (skill === "augmented-coding") ? "awaiting-action" : "review";
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
  }
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // Serve HTML
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    return;
  }

  // --- Config APIs ---
  if (url.pathname === "/api/config" && req.method === "GET") {
    json(res, { ...config, availableSkills: config.projectPath ? scanSkills(config.projectPath) : [] });
    return;
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const data = JSON.parse(body);
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

  // --- Plan APIs ---
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

  // --- Ticket APIs ---
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
        const { jiraTicket } = JSON.parse(body);
        const ticket = addTicket(jiraTicket);
        json(res, sanitizeTicket(ticket), 201);
      } catch (err) {
        json(res, { error: err.message }, 500);
      }
    });
    return;
  }

  // Ticket log
  const logMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/log$/);
  if (logMatch && req.method === "GET") {
    const t = tickets[logMatch[1]];
    if (!t) { json(res, { error: "not found" }, 404); return; }
    json(res, {
      status: t.status, currentStep: t.currentStep, log: t.log,
      planFile: t.planFile, planContent: t.planContent,
      branchName: t.branchName, worktreePath: t.worktreePath,
    });
    return;
  }

  // Ticket action (augmented-coding: go/commit/refactor)
  const actionMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/action$/);
  if (actionMatch && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const t = tickets[actionMatch[1]];
      if (!t) { json(res, { error: "not found" }, 404); return; }

      const currentSkill = config.pipeline[t.currentStep];
      if (currentSkill !== "augmented-coding") {
        json(res, { error: "현재 augmented-coding 단계가 아닙니다." }, 400);
        return;
      }
      if (t.status !== "awaiting-action" && t.status !== "review") {
        json(res, { error: "액션을 선택할 수 있는 상태가 아닙니다." }, 400);
        return;
      }

      const { action, planFile } = JSON.parse(body);
      if (!["go", "commit", "refactor"].includes(action)) {
        json(res, { error: "유효하지 않은 액션입니다." }, 400);
        return;
      }

      runStep(t.id, { action, planFile });
      json(res, sanitizeTicket(t));
    });
    return;
  }

  // Next step
  const nextMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/next$/);
  if (nextMatch && req.method === "POST") {
    const t = tickets[nextMatch[1]];
    if (!t) { json(res, { error: "not found" }, 404); return; }
    if (t.status !== "review" && t.status !== "awaiting-action" && t.status !== "review-plan") {
      json(res, { error: "다음 단계로 진행할 수 없는 상태입니다." }, 400);
      return;
    }

    const next = t.currentStep + 1;
    if (next >= config.pipeline.length) {
      t.status = "done";
      json(res, sanitizeTicket(t));
      return;
    }

    t.currentStep = next;
    const nextSkill = config.pipeline[next];

    if (nextSkill === "augmented-coding") {
      t.status = "awaiting-action";
      t.log = "";
      json(res, sanitizeTicket(t));
    } else {
      runStep(t.id);
      json(res, sanitizeTicket(t));
    }
    return;
  }

  // Stop running ticket
  const stopMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/stop$/);
  if (stopMatch && req.method === "POST") {
    const t = tickets[stopMatch[1]];
    if (!t) { json(res, { error: "not found" }, 404); return; }
    if (t.proc) {
      t.proc.kill("SIGTERM");
      t.proc = null;
      t.log += "\n\n--- 사용자에 의해 중지됨 ---";
      const skill = config.pipeline[t.currentStep];
      t.status = (skill === "augmented-coding") ? "awaiting-action" : "review";
    }
    json(res, sanitizeTicket(t));
    return;
  }

  // Skip plan (use existing plan) — review-plan → next step
  const skipPlanMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/skip-plan$/);
  if (skipPlanMatch && req.method === "POST") {
    const t = tickets[skipPlanMatch[1]];
    if (!t) { json(res, { error: "not found" }, 404); return; }
    if (t.status !== "review-plan") {
      json(res, { error: "review-plan 상태가 아닙니다." }, 400);
      return;
    }
    // Move to next step (same logic as /next)
    const next = t.currentStep + 1;
    if (next >= config.pipeline.length) {
      t.status = "done";
      json(res, sanitizeTicket(t));
      return;
    }
    t.currentStep = next;
    const nextSkill = config.pipeline[next];
    if (nextSkill === "augmented-coding") {
      t.status = "awaiting-action";
      t.log = "";
    } else {
      runStep(t.id);
    }
    json(res, sanitizeTicket(t));
    return;
  }

  // Re-run plan (overwrite existing plan)
  const rerunPlanMatch = url.pathname.match(/^\/api\/tickets\/(\d+)\/rerun-plan$/);
  if (rerunPlanMatch && req.method === "POST") {
    const t = tickets[rerunPlanMatch[1]];
    if (!t) { json(res, { error: "not found" }, 404); return; }
    if (t.status !== "review-plan") {
      json(res, { error: "review-plan 상태가 아닙니다." }, 400);
      return;
    }
    runStep(t.id);
    json(res, sanitizeTicket(t));
    return;
  }

  // Delete ticket (cleanup worktree, kill process if running)
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
