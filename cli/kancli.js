#!/usr/bin/env node

const { KancliClient } = require("../lib/kancli-client");
const { renderBoard } = require("../lib/kancli-board");

const BASE_URL = process.env.KANCLI_SERVER_URL || process.env.DEVFLOW_SERVER_URL || "http://localhost:3000";
const client = new KancliClient(BASE_URL);

function printHelp() {
  console.log(`kancli - terminal-first runtime control\n\nUsage:\n  kancli up\n  kancli init [projectPath]\n  kancli board\n  kancli add <ticket>\n  kancli answer <ticket> <option|text>\n  kancli next <ticket>\n  kancli stop <ticket>\n  kancli status\n\nEnvironment:\n  KANCLI_SERVER_URL (default: http://localhost:3000)`);
}

function parseTicketId(value) {
  const ticketId = String(value || "").trim();
  if (!ticketId) throw new Error("ticket id is required");
  return ticketId;
}

function summarizeTicket(t) {
  const skill = t.currentSkill || "-";
  const pending = t.pendingAction ? `pending=${t.pendingAction.type}` : "pending=-";
  return `#${t.id} ${t.jiraTicket} | ${t.status} | skill=${skill} | step=${t.currentStep ?? "-"} | ${pending}`;
}

async function commandUp() {
  const health = await client.health();
  const status = await client.status();
  console.log(`kancli connected: ${BASE_URL}`);
  console.log(`server ok=${health.ok} uptime=${health.uptimeSec}s queue=${health.queueDepth} running=${health.running}`);
  console.log(`pipeline: ${(status.pipeline || []).join(" -> ") || "(not set)"}`);
}

async function commandBoard() {
  const status = await client.status();
  console.log(renderBoard(status));
}

async function commandInit(argv) {
  const projectPath = argv[0] || process.cwd();
  const skillResp = await client.scanSkills(projectPath);
  const skills = skillResp.skills || [];
  await client.configSet({ projectPath, pipeline: skills });
  console.log(`initialized project: ${projectPath}`);
  console.log(`detected skills: ${skills.length ? skills.join(' -> ') : '(none)'}`);
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

async function commandStatus() {
  const status = await client.status();
  console.log(`pipeline: ${(status.pipeline || []).join(" -> ") || "(not set)"}`);
  console.log(`queue=${status.queue?.length || 0} running=${status.running?.length || 0}`);
  for (const t of status.tickets || []) console.log(`- ${summarizeTicket(t)}`);
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    process.exit(0);
  }

  const commands = {
    up: () => commandUp(),
    init: () => commandInit(argv),
    board: () => commandBoard(),
    add: () => commandAdd(argv),
    answer: () => commandAnswer(argv),
    next: () => commandNext(argv),
    stop: () => commandStop(argv),
    status: () => commandStatus(),
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
