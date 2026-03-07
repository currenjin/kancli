function safe(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function pad(value, width) {
  const text = safe(value, "");
  return text.length >= width ? text.slice(0, width - 1) + "…" : text.padEnd(width, " ");
}

const GENERIC_PROMPT_RE = /^(입력이 필요합니다|응답이 필요합니다|명령을 선택하세요|pending action|selection|text)\.?$/i;

function extractQuestionFromLog(log) {
  const text = String(log || "");
  if (!text.trim()) return "";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Prefer explicit AskUserQuestion related lines
  const askIdx = lines.findLastIndex((l) => /AskUserQuestion|명령을 입력해 주세요|다음 명령을 선택하세요|Answer questions\?/i.test(l));
  if (askIdx >= 0) {
    const slice = lines.slice(askIdx, Math.min(lines.length, askIdx + 6));
    return slice.join("\n");
  }

  // Look for lines ending with ?
  const questionIdx = lines.findLastIndex((l) => /\?\s*$/.test(l));
  if (questionIdx >= 0) {
    const start = Math.max(0, questionIdx - 2);
    return lines.slice(start, questionIdx + 1).join("\n");
  }

  // Fallback: last meaningful lines (skip exit/completion markers)
  const meaningful = lines.filter((l) => !/^---\s*(완료|에러)/.test(l) && !/^\s*$/.test(l));
  return meaningful.slice(-3).join("\n");
}

function resolvePrompt(t) {
  const prompt = safe(t.pendingAction?.prompt, "");
  if (prompt && !GENERIC_PROMPT_RE.test(prompt)) return prompt;
  const fromLog = extractQuestionFromLog(t.log);
  return fromLog || prompt || safe(t.pendingAction?.type, "pending");
}

function toHumanActionLabel(option, index) {
  const label = safe(option?.label, "").trim();
  if (label && label !== "-") return label;
  const id = safe(option?.id, "").trim();
  if (id && id !== "-") return id.replace(/[_-]+/g, " ");
  return `Option ${index + 1}`;
}

function renderTicketCard(t) {
  const line1 = `#${t.id} ${safe(t.jiraTicket)}`;
  const line2 = `${safe(t.status)} | step:${safe(t.currentStep)}`;
  const pending = t.pendingAction ? `Q: ${resolvePrompt(t)}` : null;
  return [line1, line2, pending].filter(Boolean);
}

function renderBoard(data, options = {}) {
  const pendingCursor = Number.isInteger(options.pendingCursor) ? options.pendingCursor : 0;
  const focus = options.focus || "pending"; // "pending" | "tickets"
  const ticketCursor = Number.isInteger(options.ticketCursor) ? options.ticketCursor : -1;
  const columns = Array.isArray(data.pipelineColumns) && data.pipelineColumns.length
    ? data.pipelineColumns
    : (data.pipeline || []).map((skill, idx) => ({ id: `skill:${idx}`, name: skill, skill }));

  const bySkill = new Map(columns.map((c) => [c.skill, []]));
  const done = [];
  const pendingQuestions = [];
  const allTickets = [];

  for (const t of data.tickets || []) {
    if (t.pendingAction) pendingQuestions.push(t);
    if (t.isDone || t.status === "done") {
      done.push(t);
    } else {
      const skill = t.currentSkill;
      if (bySkill.has(skill)) bySkill.get(skill).push(t);
    }
    allTickets.push(t);
  }

  const out = [];
  out.push("KANCLI LIVE BOARD");
  out.push(`queue=${data.queue?.length || 0} running=${data.running?.length || 0}`);
  if (options.updatedAt) out.push(`last update: ${new Date(options.updatedAt).toLocaleTimeString()}`);
  out.push("");

  for (const col of columns) {
    out.push(`== ${col.name} ==`);
    const tickets = bySkill.get(col.skill) || [];
    if (!tickets.length) {
      out.push("  (empty)");
      out.push("");
      continue;
    }
    for (const t of tickets) {
      const isCursor = focus === "tickets" && ticketCursor >= 0 && allTickets[ticketCursor]?.id === t.id;
      const prefix = isCursor ? "> " : "  ";
      const card = renderTicketCard(t);
      out.push(`${prefix}${pad(card[0], 60)}`);
      for (const line of card.slice(1)) out.push(`    ${pad(line, 58)}`);
      out.push("");
    }
  }

  out.push("== Done ==");
  if (!done.length) out.push("  (none)");
  for (const t of done.slice(0, 20)) {
    const isCursor = focus === "tickets" && ticketCursor >= 0 && allTickets[ticketCursor]?.id === t.id;
    const prefix = isCursor ? "> " : "  ";
    out.push(`${prefix}#${t.id} ${safe(t.jiraTicket)} (${t.status})`);
  }
  out.push("");

  out.push("== Pending Questions ==");
  if (!pendingQuestions.length) out.push("  (none)");
  for (let i = 0; i < pendingQuestions.length; i += 1) {
    const t = pendingQuestions[i];
    const prompt = resolvePrompt(t);
    const mark = (focus === "pending" && i === pendingCursor) ? ">" : " ";
    out.push(` ${mark} ${i + 1}. #${t.id} ${safe(t.jiraTicket)}`);
    for (const line of prompt.split("\n").slice(0, 4)) {
      out.push(`     ${line}`);
    }
  }

  out.push("");
  const focusLabel = focus === "tickets" ? "[TICKETS]" : "[PENDING]";
  out.push(`${focusLabel} Tab: switch focus | ↑/↓: move | Enter: action | n: next | s: stop | d: delete | a: add | r: refresh | q: quit`);

  return out.join("\n");
}

function getAllTickets(data) {
  return (data.tickets || []).slice();
}

module.exports = { renderBoard, getAllTickets, toHumanActionLabel, extractQuestionFromLog, resolvePrompt };