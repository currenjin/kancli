// ANSI helpers
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  bgGray: "\x1b[48;5;236m",
  bgBlue: "\x1b[44m",
  inverse: "\x1b[7m",
};

const STATUS_STYLE = {
  running:        { symbol: "\u25cf", color: c.green,   label: "running" },
  queued:         { symbol: "\u25cb", color: c.gray,    label: "queued" },
  awaiting_input: { symbol: "\u25cf", color: c.yellow,  label: "awaiting" },
  review:         { symbol: "\u25cf", color: c.cyan,    label: "review" },
  blocked:        { symbol: "\u25a0", color: c.red,     label: "blocked" },
  halted:         { symbol: "\u25a0", color: c.red,     label: "halted" },
  done:           { symbol: "\u2713", color: c.green,   label: "done" },
};

function statusBadge(status) {
  const s = STATUS_STYLE[status] || { symbol: "?", color: c.gray, label: status || "unknown" };
  return `${s.color}${s.symbol} ${s.label}${c.reset}`;
}

function safe(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(str) {
  return stripAnsi(str).length;
}

function padVisible(str, width) {
  const vlen = visibleLength(str);
  if (vlen >= width) return str;
  return str + " ".repeat(width - vlen);
}

function truncVisible(str, width) {
  const plain = stripAnsi(str);
  if (plain.length <= width) return str;
  let visible = 0;
  let i = 0;
  const raw = str;
  let result = "";
  while (i < raw.length && visible < width - 1) {
    if (raw[i] === "\x1b") {
      const end = raw.indexOf("m", i);
      if (end >= 0) { result += raw.slice(i, end + 1); i = end + 1; continue; }
    }
    result += raw[i];
    visible++;
    i++;
  }
  return result + "\u2026" + c.reset;
}

const GENERIC_PROMPT_RE = /^(입력이 필요합니다|응답이 필요합니다|명령을 선택하세요|pending action|selection|text)\.?$/i;

function extractQuestionFromLog(log) {
  const text = String(log || "");
  if (!text.trim()) return "";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const askIdx = lines.findLastIndex((l) => /AskUserQuestion|명령을 입력해 주세요|다음 명령을 선택하세요|Answer questions\?/i.test(l));
  if (askIdx >= 0) {
    const slice = lines.slice(askIdx, Math.min(lines.length, askIdx + 6));
    return slice.join("\n");
  }
  const questionIdx = lines.findLastIndex((l) => /\?\s*$/.test(l));
  if (questionIdx >= 0) {
    const start = Math.max(0, questionIdx - 2);
    return lines.slice(start, questionIdx + 1).join("\n");
  }
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

// Box drawing
const BOX = { tl: "\u250c", tr: "\u2510", bl: "\u2514", br: "\u2518", h: "\u2500", v: "\u2502" };

function boxLine(content, width, color) {
  const padded = padVisible(content, width);
  const truncated = truncVisible(padded, width);
  return `${color || ""}${BOX.v}${c.reset} ${truncated} ${color || ""}${BOX.v}${c.reset}`;
}

function boxTop(width, color) {
  return `${color || ""}${BOX.tl}${BOX.h.repeat(width + 2)}${BOX.tr}${c.reset}`;
}

function boxBottom(width, color) {
  return `${color || ""}${BOX.bl}${BOX.h.repeat(width + 2)}${BOX.br}${c.reset}`;
}

function renderTicketCard(t, cardWidth, isCursor) {
  const s = STATUS_STYLE[t.status] || STATUS_STYLE.queued;
  const borderColor = isCursor ? c.cyan + c.bold : c.dim;
  const lines = [];
  const w = cardWidth;

  lines.push(isCursor
    ? `${c.cyan}${c.bold}${BOX.tl}${BOX.h.repeat(w + 2)}${BOX.tr}${c.reset}`
    : boxTop(w, borderColor));

  const title = `${c.bold}#${t.id}${c.reset} ${safe(t.jiraTicket)}`;
  const badge = statusBadge(t.status);
  const titleLine = `${title}  ${badge}`;
  lines.push(boxLine(titleLine, w, borderColor));

  const step = `${c.dim}step ${safe(t.currentStep)}${c.reset}`;
  lines.push(boxLine(step, w, borderColor));

  if (t.pendingAction) {
    const prompt = resolvePrompt(t);
    const firstLine = prompt.split("\n")[0];
    const qLine = `${c.yellow}? ${truncVisible(firstLine, w - 2)}${c.reset}`;
    lines.push(boxLine(qLine, w, borderColor));
  }

  lines.push(isCursor
    ? `${c.cyan}${c.bold}${BOX.bl}${BOX.h.repeat(w + 2)}${BOX.br}${c.reset}`
    : boxBottom(w, borderColor));

  return lines;
}

function hline(width, label) {
  if (!label) return `${c.dim}${BOX.h.repeat(width)}${c.reset}`;
  const lbl = ` ${label} `;
  const remaining = Math.max(0, width - lbl.length - 2);
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${c.dim}${BOX.h.repeat(left + 1)}${c.reset}${c.bold}${lbl}${c.reset}${c.dim}${BOX.h.repeat(right + 1)}${c.reset}`;
}

function renderBoard(data, options = {}) {
  const pendingCursor = Number.isInteger(options.pendingCursor) ? options.pendingCursor : 0;
  const focus = options.focus || "pending";
  const ticketCursor = Number.isInteger(options.ticketCursor) ? options.ticketCursor : -1;
  const termWidth = Math.min(process.stdout.columns || 80, 120);
  const cardWidth = Math.max(30, termWidth - 8);

  const columns = Array.isArray(data.pipelineColumns) && data.pipelineColumns.length
    ? data.pipelineColumns
    : (data.pipeline || []).map((skill, idx) => ({ id: `skill:${idx}`, name: skill, skill }));

  const bySkill = new Map(columns.map((cc) => [cc.skill, []]));
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

  const queueCount = data.queue?.length || 0;
  const runningCount = data.running?.length || 0;
  const out = [];

  // Header
  out.push("");
  out.push(`  ${c.bold}${c.cyan}KANCLI${c.reset}${c.dim} LIVE BOARD${c.reset}`);
  const stats = [
    `${c.green}\u25cf ${runningCount} running${c.reset}`,
    `${c.gray}\u25cb ${queueCount} queued${c.reset}`,
    `${c.yellow}\u25cf ${pendingQuestions.length} pending${c.reset}`,
    `${c.green}\u2713 ${done.length} done${c.reset}`,
  ];
  out.push(`  ${stats.join(`${c.dim}  |  ${c.reset}`)}`);
  if (options.updatedAt) out.push(`  ${c.dim}${new Date(options.updatedAt).toLocaleTimeString()}${c.reset}`);
  out.push("");

  // Pipeline columns
  for (const col of columns) {
    out.push(hline(termWidth - 2, col.name));
    const tickets = bySkill.get(col.skill) || [];
    if (!tickets.length) {
      out.push(`  ${c.dim}(empty)${c.reset}`);
      out.push("");
      continue;
    }
    for (const t of tickets) {
      const isCursor = focus === "tickets" && ticketCursor >= 0 && allTickets[ticketCursor]?.id === t.id;
      const prefix = isCursor ? `${c.cyan}\u25b6${c.reset} ` : "  ";
      const card = renderTicketCard(t, cardWidth, isCursor);
      for (const line of card) out.push(`${prefix}${line}`);
    }
    out.push("");
  }

  // Done
  if (done.length) {
    out.push(hline(termWidth - 2, `Done (${done.length})`));
    for (const t of done.slice(0, 10)) {
      const isCursor = focus === "tickets" && ticketCursor >= 0 && allTickets[ticketCursor]?.id === t.id;
      const prefix = isCursor ? `${c.cyan}\u25b6${c.reset} ` : "  ";
      out.push(`${prefix}${c.green}\u2713${c.reset} ${c.dim}#${t.id}${c.reset} ${safe(t.jiraTicket)}`);
    }
    out.push("");
  }

  // Pending Questions
  out.push(hline(termWidth - 2, `Pending (${pendingQuestions.length})`));
  if (!pendingQuestions.length) {
    out.push(`  ${c.dim}(no pending questions)${c.reset}`);
  } else {
    for (let i = 0; i < pendingQuestions.length; i += 1) {
      const t = pendingQuestions[i];
      const prompt = resolvePrompt(t);
      const firstLine = prompt.split("\n")[0];
      const isActive = focus === "pending" && i === pendingCursor;
      if (isActive) {
        out.push(`  ${c.cyan}${c.bold}\u25b6 ${i + 1}.${c.reset} ${c.bold}#${t.id}${c.reset} ${safe(t.jiraTicket)}`);
        out.push(`    ${c.yellow}? ${firstLine}${c.reset}`);
      } else {
        out.push(`  ${c.dim}  ${i + 1}.${c.reset} ${c.dim}#${t.id}${c.reset} ${safe(t.jiraTicket)}`);
        out.push(`    ${c.dim}? ${firstLine}${c.reset}`);
      }
    }
  }
  out.push("");

  // Footer
  const focusLabel = focus === "tickets"
    ? `${c.inverse} TICKETS ${c.reset}  ${c.dim}PENDING${c.reset}`
    : `${c.dim}TICKETS${c.reset}  ${c.inverse} PENDING ${c.reset}`;
  out.push(`  ${focusLabel}${c.dim}  Tab: switch${c.reset}`);

  const k = (char, rest) => `${c.reset}${c.bold}${char}${c.reset}${c.dim}${rest}${c.reset}`;
  const keys = focus === "tickets"
    ? `${c.dim}\u2191\u2193 move  ${k("n","ext")}  ${k("s","top")}  ${k("d","elete")}  ${k("a","dd")}  ${c.dim}Enter answer  ${k("r","efresh")}  ${k("q","uit")}`
    : `${c.dim}\u2191\u2193 move  1-9 jump  ${c.dim}Enter answer  ${k("n","ext")}  ${k("s","top")}  ${k("d","elete")}  ${k("a","dd")}  ${k("r","efresh")}  ${k("q","uit")}`;
  out.push(`  ${keys}`);

  return out.join("\n");
}

function getAllTickets(data) {
  return (data.tickets || []).slice();
}

module.exports = { renderBoard, getAllTickets, toHumanActionLabel, extractQuestionFromLog, resolvePrompt };
