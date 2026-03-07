#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { KancliClient } = require("../lib/kancli-client");
const { renderBoard } = require("../lib/kancli-board");

const BASE_URL = process.env.KANCLI_SERVER_URL || process.env.DEVFLOW_SERVER_URL || "http://localhost:3000";
const PID_FILE = path.join(os.homedir(), ".kancli", "kancli-server.pid");
const client = new KancliClient(BASE_URL);

function printHelp() {
  console.log(`kancli - terminal-first runtime control\n\nUsage:\n  kancli up\n  kancli down\n  kancli restart\n  kancli init [projectPath] [--auto]\n  kancli board\n  kancli add <ticket>\n  kancli answer <ticket> <option|text>\n  kancli next <ticket>\n  kancli stop <ticket>\n  kancli delete <ticket>\n  kancli status\n  kancli uninstall [--yes]\n\nQuick start:\n  kancli up   # 서버 없으면 자동 기동\n  kancli init .\n  kancli board\n\nEnvironment:\n  KANCLI_SERVER_URL (default: http://localhost:3000)\n  KANCLI_INSTALL_DIR (default: ~/.kancli)\n  KANCLI_BIN_DIR (default: ~/.local/bin)`);
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
  console.log(renderBoard(status));
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

  const option = (action.options || []).find((opt) => {
    if (!opt) return false;
    const id = String(opt.id || "").toLowerCase();
    const label = String(opt.label || "").toLowerCase();
    return answerText.toLowerCase() === id || answerText.toLowerCase() === label;
  });

  const payload = option
    ? { actionId: option.id, metadata: { source: "kancli" } }
    : { input: answerText, metadata: { source: "kancli" } };

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

  if (fs.existsSync(binPath)) fs.rmSync(binPath, { force: true });
  if (fs.existsSync(installDir)) fs.rmSync(installDir, { recursive: true, force: true });

  console.log(`uninstalled kancli`);
  console.log(`removed: ${installDir}`);
  console.log(`removed: ${binPath}`);
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
