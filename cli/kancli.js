#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { KancliClient } = require("../lib/kancli-client");
const { renderBoard, toHumanActionLabel } = require("../lib/kancli-board");

const BASE_URL = process.env.KANCLI_SERVER_URL || process.env.DEVFLOW_SERVER_URL || "http://localhost:3000";
const PID_FILE = path.join(os.homedir(), ".kancli", "kancli-server.pid");
const client = new KancliClient(BASE_URL);

function printHelp() {
  console.log(`kancli - terminal-first runtime control\n\nUsage:\n  kancli up (or: kc up)\n  kancli down\n  kancli restart\n  kancli init [projectPath] [--auto]\n  kancli board\n  kancli add <ticket>\n  kancli answer <ticket> <option|text>\n  kancli next <ticket>\n  kancli stop <ticket>\n  kancli delete <ticket>\n  kancli status\n  kancli pending\n  kancli uninstall [--yes]\n\nQuick start:\n  kancli up   # 서버 없으면 자동 기동\n  kc init .\n  kc board\n\nEnvironment:\n  KANCLI_SERVER_URL (default: http://localhost:3000)\n  KANCLI_INSTALL_DIR (default: ~/.kancli)\n  KANCLI_BIN_DIR (default: ~/.local/bin)`);
}

function parseTicketId(value) {
  const ticketId = String(value || "").trim();
  if (!ticketId) throw new Error("ticket id is required");
  return ticketId;
}

function resolveProjectPath(inputPath) {
  const raw = String(inputPath || ".").trim() || ".";
  const absolute = path.resolve(process.cwd(), raw);

  // If user points to a subdirectory, automatically lift to git root when possible.
  let current = absolute;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return absolute;
}

function summarizeTicket(t) {
  const skill = t.currentSkill || "-";
  const pending = t.pendingAction ? `pending=${t.pendingAction.type}` : "pending=-";
  return `#${t.id} ${t.jiraTicket} | ${t.status} | skill=${skill} | step=${t.currentStep ?? "-"} | ${pending}`;
}

function extractQuestionFromLog(log) {
  const text = String(log || "");
  if (!text.trim()) return "";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Prefer explicit AskUserQuestion related lines
  const askIdx = lines.findLastIndex((l) => /AskUserQuestion|명령을 입력해 주세요|다음 명령을 선택하세요|Answer questions\?/i.test(l));
  if (askIdx >= 0) {
    const slice = lines.slice(askIdx, Math.min(lines.length, askIdx + 6));
    return slice.join(" ");
  }

  // Fallback: last line with command candidates
  const cmdIdx = lines.findLastIndex((l) => /\bgo\b|\bcommit\b|\brefactor\b/i.test(l));
  if (cmdIdx >= 0) return lines[cmdIdx];

  return lines.slice(-3).join(" ");
}

function inferCommandOptionsFromText(text) {
  const source = String(text || "");
  if (!source.trim()) return [];
  const out = [];
  const add = (id) => {
    const v = String(id || "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,40}$/.test(v)) return;
    if (!out.find((o) => o.id === v)) out.push({ id: v, label: v });
  };

  for (const m of source.matchAll(/`([^`\n]{1,40})`/g)) add(m[1]);
  for (const m of source.matchAll(/\*\*([^*\n]{1,40})\*\*/g)) add(m[1]);

  if (!out.length) {
    const lower = source.toLowerCase();
    ["go", "commit", "refactor", "approve", "reject", "retry", "fallback", "advance", "halt"].forEach((cmd) => {
      if (new RegExp(`\\b${cmd}\\b`).test(lower)) add(cmd);
    });
  }

  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureServerUp() {
  try {
    return await client.health();
  } catch {
    const serverPath = path.join(__dirname, "..", "server.js");
    const logPath = path.join(os.homedir(), ".kancli", "kancli-up.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const out = fs.openSync(logPath, "a");

    const child = spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: ["ignore", out, out],
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        PORT: process.env.PORT || "3000",
      },
    });
    fs.writeFileSync(PID_FILE, String(child.pid));
    child.unref();

    for (let i = 0; i < 20; i += 1) {
      await sleep(250);
      try {
        return await client.health();
      } catch {}
    }

    throw new Error(`failed to start local server. check log: ${logPath}`);
  }
}

async function commandUp() {
  const health = await ensureServerUp();
  const status = await client.status();
  console.log(`kancli connected: ${BASE_URL}`);
  console.log(`server ok=${health.ok} uptime=${health.uptimeSec}s queue=${health.queueDepth} running=${health.running}`);
  console.log(`pipeline: ${(status.pipeline || []).join(" -> ") || "(not set)"}`);
}

async function commandBoard() {
  const status = await client.status();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(renderBoard(status, { updatedAt: Date.now() }));
    return;
  }

  let board = status;
  let pendingCursor = 0;
  let mode = "board"; // board | selection | text
  let message = "";
  let selectedOption = 0;
  let inputBuffer = "";
  let activeTicket = null;
  let quit = false;
  let isSubmitting = false;
  let refreshTimer = null;
  let closeSse = null;

  const getPending = () => (board.tickets || []).filter((t) => t.pendingAction);

  const resetPromptState = () => {
    mode = "board";
    activeTicket = null;
    selectedOption = 0;
    inputBuffer = "";
  };

  const draw = () => {
    process.stdout.write("\x1Bc");
    process.stdout.write(`${renderBoard(board, { pendingCursor, updatedAt: Date.now() })}\n`);

    const pending = getPending();
    if (mode !== "board" && activeTicket) {
      const action = activeTicket.pendingAction || {};
      process.stdout.write("\n--- answer panel ---\n");
      process.stdout.write(`#${activeTicket.id} ${activeTicket.jiraTicket}\n`);
      process.stdout.write(`${action.prompt || action.type || "pending action"}\n`);
      if ((action.options || []).length) {
        process.stdout.write("\nselect option (↑/↓ or number, Enter submit, Esc cancel):\n");
        (action.options || []).forEach((opt, idx) => {
          const mark = idx === selectedOption ? ">" : " ";
          process.stdout.write(` ${mark} ${idx + 1}. ${toHumanActionLabel(opt, idx)}\n`);
        });
      } else {
        process.stdout.write("\ntext input (Enter submit, Esc cancel):\n");
        process.stdout.write(`> ${inputBuffer}\n`);
      }
    } else if (pending.length) {
      process.stdout.write(`\nEnter로 #${pending[Math.min(pendingCursor, pending.length - 1)]?.id} 응답 패널 열기\n`);
    }

    if (message) process.stdout.write(`\n${message}\n`);
    if (isSubmitting) process.stdout.write("\nsubmitting...\n");
  };

  const refresh = async (hint = "") => {
    try {
      board = await client.status();
      const pending = getPending();
      if (!pending.length) {
        pendingCursor = 0;
        if (mode !== "board") {
          message = "pending action resolved.";
          resetPromptState();
        }
      } else {
        pendingCursor = Math.min(pendingCursor, pending.length - 1);
        if (mode !== "board" && activeTicket) {
          const matched = pending.find((p) => String(p.id) === String(activeTicket.id));
          if (matched) activeTicket = matched;
          else {
            message = "selected pending action disappeared.";
            resetPromptState();
          }
        }
      }
      if (hint) message = hint;
    } catch (err) {
      message = `refresh failed: ${err.message}`;
    }
    draw();
  };

  const openPendingPanel = async () => {
    const pending = getPending();
    if (!pending.length) {
      message = "no pending actions.";
      draw();
      return;
    }
    activeTicket = pending[Math.min(pendingCursor, pending.length - 1)];
    selectedOption = 0;
    inputBuffer = "";

    const pa = activeTicket.pendingAction || {};
    const isGenericPrompt = !pa.prompt || /^(입력이 필요합니다|응답이 필요합니다)\.?$/.test(pa.prompt);
    const needsInference = (pa.type === "selection" && !(pa.options || []).length) || isGenericPrompt;
    if (needsInference) {
      try {
        const detail = await client.ticketLog(activeTicket.id);
        const inferredPrompt = extractQuestionFromLog(detail.log || "");
        const inferredOptions = inferCommandOptionsFromText(inferredPrompt);
        activeTicket = {
          ...activeTicket,
          pendingAction: {
            ...pa,
            prompt: isGenericPrompt ? (inferredPrompt || pa.prompt) : pa.prompt,
            options: inferredOptions.length ? inferredOptions : (pa.options || []),
          },
        };
      } catch {}
    }

    const textTypes = ["text", "input", "free_text"];
    const effective = activeTicket.pendingAction || pa;
    mode = ((effective.options || []).length && !textTypes.includes(effective.type)) ? "selection" : "text";
    message = "";
    draw();
  };

  const submitCurrent = async () => {
    if (!activeTicket || isSubmitting) return;
    const action = activeTicket.pendingAction || {};
    const payload = { metadata: { source: "kancli-board" } };
    if ((action.options || []).length) {
      const chosen = action.options[selectedOption];
      if (!chosen?.id) {
        message = "invalid selection.";
        draw();
        return;
      }
      payload.actionId = chosen.id;
      payload.input = chosen.id;
    } else {
      if (!inputBuffer.trim()) {
        message = "text input is required.";
        draw();
        return;
      }
      payload.input = inputBuffer;
      if (action.type === "selection") {
        // fallback for selection prompts where runtime did not provide explicit option list
        payload.actionId = inputBuffer.trim();
      }
    }

    isSubmitting = true;
    draw();
    try {
      await client.answer(activeTicket.id, payload);
      message = `submitted answer for #${activeTicket.id}`;
      resetPromptState();
      await refresh();
    } catch (err) {
      message = `submit failed: ${err.message}`;
      draw();
    } finally {
      isSubmitting = false;
      draw();
    }
  };

  const cleanup = () => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (closeSse) closeSse();
    process.stdin.removeListener("keypress", onKeypress);
    process.stdout.write("\x1B[?25h");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\n");
  };

  const onKeypress = async (str, key = {}) => {
    if (key.ctrl && key.name === "c") {
      quit = true;
      cleanup();
      return;
    }
    if (mode === "board") {
      const pending = getPending();
      if (key.name === "q") {
        quit = true;
        cleanup();
        return;
      }
      if (key.name === "up" && pending.length) pendingCursor = Math.max(0, pendingCursor - 1);
      else if (key.name === "down" && pending.length) pendingCursor = Math.min(pending.length - 1, pendingCursor + 1);
      else if (key.name === "return") await openPendingPanel();
      else if (key.name === "r") await refresh("manual refresh");
      else if (/^[1-9]$/.test(str || "") && pending.length) {
        const idx = Number(str) - 1;
        if (idx >= 0 && idx < pending.length) {
          pendingCursor = idx;
          await openPendingPanel();
          return;
        }
      }
      draw();
      return;
    }

    if (key.name === "escape") {
      resetPromptState();
      message = "answer cancelled.";
      draw();
      return;
    }

    if (mode === "selection") {
      const options = activeTicket?.pendingAction?.options || [];
      if (!options.length) {
        mode = "text";
        draw();
        return;
      }
      if (key.name === "up") selectedOption = Math.max(0, selectedOption - 1);
      else if (key.name === "down") selectedOption = Math.min(options.length - 1, selectedOption + 1);
      else if (key.name === "return") await submitCurrent();
      else if (/^[1-9]$/.test(str || "")) {
        const idx = Number(str) - 1;
        if (idx >= 0 && idx < options.length) selectedOption = idx;
      }
      draw();
      return;
    }

    if (mode === "text") {
      if (key.name === "return") await submitCurrent();
      else if (key.name === "backspace") inputBuffer = inputBuffer.slice(0, -1);
      else if (!key.ctrl && !key.meta && str) inputBuffer += str;
      draw();
    }
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1B[?25l");
  process.stdin.on("keypress", onKeypress);

  closeSse = client.subscribeEvents(async () => {
    if (quit) return;
    await refresh();
  }, () => {});
  refreshTimer = setInterval(() => {
    if (!quit) refresh();
  }, 5000);

  await refresh();

  while (!quit) {
    await sleep(200);
  }
}

function renderSkillPicker(list, cursor) {
  process.stdout.write("\x1Bc");
  console.log("kancli init - skill pipeline picker");
  console.log("↑/↓: 이동  ←/→: 순서 변경  Space: 선택  Enter: 저장  q: 취소\n");
  list.forEach((item, idx) => {
    const cur = idx === cursor ? ">" : " ";
    const sel = item.selected ? "[x]" : "[ ]";
    console.log(`${cur} ${sel} ${item.name}`);
  });
}

async function pickSkillsInteractive(skills) {
  if (!skills.length) return [];
  if (!process.stdin.isTTY) return skills;

  const list = skills.map((name) => ({ name, selected: true }));
  let cursor = 0;

  return new Promise((resolve, reject) => {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKeypress);
      process.stdout.write("\n");
    };

    const finish = (ok) => {
      const selected = list.filter((x) => x.selected).map((x) => x.name);
      cleanup();
      if (!ok) return reject(new Error("init cancelled"));
      resolve(selected);
    };

    const onKeypress = (_str, key = {}) => {
      if (key.name === "up") cursor = Math.max(0, cursor - 1);
      else if (key.name === "down") cursor = Math.min(list.length - 1, cursor + 1);
      else if (key.name === "left") {
        if (cursor > 0) {
          [list[cursor - 1], list[cursor]] = [list[cursor], list[cursor - 1]];
          cursor -= 1;
        }
      } else if (key.name === "right") {
        if (cursor < list.length - 1) {
          [list[cursor + 1], list[cursor]] = [list[cursor], list[cursor + 1]];
          cursor += 1;
        }
      } else if (key.name === "space") list[cursor].selected = !list[cursor].selected;
      else if (key.name === "return") return finish(true);
      else if (key.name === "q" || (key.ctrl && key.name === "c")) return finish(false);
      renderSkillPicker(list, cursor);
    };

    process.stdin.on("keypress", onKeypress);
    renderSkillPicker(list, cursor);
  });
}

async function commandInit(argv) {
  const projectPath = resolveProjectPath(argv[0] || ".");
  const skillResp = await client.scanSkills(projectPath);
  const skills = skillResp.skills || [];
  const nonInteractive = argv.includes("--auto");
  const pipeline = nonInteractive ? skills : await pickSkillsInteractive(skills);
  await client.configSet({ projectPath, pipeline });
  console.log(`initialized project: ${projectPath}`);
  console.log(`pipeline: ${pipeline.length ? pipeline.join(' -> ') : '(none selected)'}`);
}

function commandDown() {
  if (!fs.existsSync(PID_FILE)) {
    console.log(`kancli server pid file not found: ${PID_FILE}`);
    console.log(`if server is still running, stop manually: pkill -f "node.*server.js"`);
    return;
  }

  const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    fs.rmSync(PID_FILE, { force: true });
    throw new Error(`invalid pid file: ${PID_FILE}`);
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`stopped server pid=${pid}`);
  } catch (err) {
    console.log(`failed to stop pid=${pid}: ${err.message}`);
  }

  fs.rmSync(PID_FILE, { force: true });
}

async function commandRestart() {
  commandDown();
  await commandUp();
}

async function commandAdd(argv) {
  const jiraTicket = argv[0];
  if (!jiraTicket) throw new Error("usage: kancli add <ticket>");
  const created = await client.add(jiraTicket);
  console.log(`added ${summarizeTicket(created)}`);
}

async function commandAnswer(argv) {
  const ticketId = parseTicketId(argv[0]);
  const answerText = argv.slice(1).join(" ").trim();
  if (!answerText) throw new Error("usage: kancli answer <ticket> <option|text>");

  const detail = await client.ticketLog(ticketId);
  const action = detail.pendingAction;
  if (!action) throw new Error("no pending action for this ticket");

  let options = (action.options || []).filter(Boolean);
  if (!options.length && action.type === "selection") {
    const inferred = inferCommandOptionsFromText(extractQuestionFromLog(detail.log || ""));
    if (inferred.length) options = inferred;
  }

  let option = options.find((opt) => {
    if (!opt) return false;
    const id = String(opt.id || "").toLowerCase();
    const label = String(opt.label || "").toLowerCase();
    return answerText.toLowerCase() === id || answerText.toLowerCase() === label;
  });

  if (!option && /^[1-9]$/.test(answerText)) {
    const idx = Number(answerText) - 1;
    if (idx >= 0 && idx < options.length) option = options[idx];
  }

  let payload;
  if (option) {
    payload = { actionId: option.id, metadata: { source: "kancli" } };
  } else if (action.type === "selection") {
    // selection type but options may be missing from runtime; treat user text as direct actionId fallback
    payload = { actionId: answerText.trim(), input: answerText, metadata: { source: "kancli" } };
  } else {
    payload = { input: answerText, metadata: { source: "kancli" } };
  }

  const updated = await client.answer(ticketId, payload);
  console.log(`answered ${summarizeTicket(updated.ticket || updated)}`);
}

async function commandNext(argv) {
  const ticketId = parseTicketId(argv[0]);
  const updated = await client.next(ticketId);
  console.log(`next ${summarizeTicket(updated.ticket || updated)}`);
}

async function commandStop(argv) {
  const ticketId = parseTicketId(argv[0]);
  const updated = await client.stop(ticketId);
  console.log(`stopped ${summarizeTicket(updated.ticket || updated)}`);
}

async function commandDelete(argv) {
  const ticketId = parseTicketId(argv[0]);
  await client.remove(ticketId);
  console.log(`deleted ticket #${ticketId}`);
}

async function commandStatus() {
  const status = await client.status();
  console.log(`pipeline: ${(status.pipeline || []).join(" -> ") || "(not set)"}`);
  console.log(`queue=${status.queue?.length || 0} running=${status.running?.length || 0}`);
  for (const t of status.tickets || []) console.log(`- ${summarizeTicket(t)}`);
}

async function commandPending() {
  const status = await client.status();
  const pending = (status.tickets || []).filter((t) => t.pendingAction);
  if (!pending.length) {
    console.log("no pending questions/actions");
    return;
  }

  for (const t of pending) {
    const pa = t.pendingAction || {};
    const opts = (pa.options || []).map((o, idx) => ({ id: o?.id, label: toHumanActionLabel(o, idx) })).filter((o) => o.id);

    let prompt = pa.prompt || "";
    if (!prompt || prompt === "입력이 필요합니다." || prompt === "응답이 필요합니다.") {
      try {
        const detail = await client.ticketLog(t.id);
        const inferred = extractQuestionFromLog(detail.log || "");
        if (inferred) prompt = inferred;
      } catch {}
    }

    console.log(`#${t.id} ${t.jiraTicket}`);
    console.log(`  skill: ${t.currentSkill || '-'} | status: ${t.status}`);
    const paType = pa.type || 'selection';
    const noOptionsSelection = paType === 'selection' && !opts.length;
    console.log(`  prompt: ${prompt || pa.prompt || '-'}`);
    console.log(`  options: ${opts.length ? opts.map((o) => `${o.label}(${o.id})`).join(' | ') : (noOptionsSelection ? '(no options provided; type command directly, e.g. go)' : '(text input expected)')}`);
    console.log(`  example: ${opts.length ? `kancli answer ${t.id} "${opts[0].label}"` : (noOptionsSelection ? `kancli answer ${t.id} go` : `kancli answer ${t.id} "your answer"`)}`);
  }
}

function commandUninstall(argv) {
  const yes = argv.includes("--yes");
  if (!yes) {
    console.log("This will remove ~/.kancli and ~/.local/bin/kancli by default.");
    console.log("Run: kancli uninstall --yes");
    return;
  }

  const installDir = process.env.KANCLI_INSTALL_DIR || path.join(os.homedir(), ".kancli");
  const binDir = process.env.KANCLI_BIN_DIR || path.join(os.homedir(), ".local", "bin");
  const binPath = path.join(binDir, "kancli");
  const kcPath = path.join(binDir, "kc");

  if (fs.existsSync(binPath)) fs.rmSync(binPath, { force: true });

  if (fs.existsSync(kcPath)) {
    const kcText = fs.readFileSync(kcPath, "utf8");
    if (kcText.includes("kancli-shim")) fs.rmSync(kcPath, { force: true });
    else console.log(`skip removing kc (not managed by kancli): ${kcPath}`);
  }

  if (fs.existsSync(installDir)) fs.rmSync(installDir, { recursive: true, force: true });

  console.log(`uninstalled kancli`);
  console.log(`removed: ${installDir}`);
  console.log(`removed: ${binPath}`);
  console.log(`removed: ${kcPath} (if managed by kancli)`);
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    process.exit(0);
  }

  const commands = {
    up: () => commandUp(),
    down: () => commandDown(),
    restart: () => commandRestart(),
    init: () => commandInit(argv),
    board: () => commandBoard(),
    add: () => commandAdd(argv),
    answer: () => commandAnswer(argv),
    next: () => commandNext(argv),
    stop: () => commandStop(argv),
    delete: () => commandDelete(argv),
    status: () => commandStatus(),
    pending: () => commandPending(),
    uninstall: () => commandUninstall(argv),
  };

  if (!commands[cmd]) {
    printHelp();
    throw new Error(`unknown command: ${cmd}`);
  }

  await commands[cmd]();
}

main().catch((err) => {
  console.error(`kancli error: ${err.message}`);
  process.exit(1);
});
