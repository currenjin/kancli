function safe(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function pad(value, width) {
  const text = safe(value, "");
  return text.length >= width ? text.slice(0, width - 1) + "…" : text.padEnd(width, " ");
}

function renderTicketCard(t) {
  const line1 = `#${t.id} ${safe(t.jiraTicket)}`;
  const line2 = `${safe(t.status)} | step:${safe(t.currentStep)}`;
  const pending = t.pendingAction ? `Q: ${safe(t.pendingAction.prompt, t.pendingAction.type)}` : null;
  return [line1, line2, pending].filter(Boolean);
}

function renderBoard(data) {
  const columns = Array.isArray(data.pipelineColumns) && data.pipelineColumns.length
    ? data.pipelineColumns
    : (data.pipeline || []).map((skill, idx) => ({ id: `skill:${idx}`, name: skill, skill }));

  const bySkill = new Map(columns.map((c) => [c.skill, []]));
  const done = [];
  const pendingQuestions = [];

  for (const t of data.tickets || []) {
    if (t.pendingAction) pendingQuestions.push(t);
    if (t.isDone || t.status === "done") {
      done.push(t);
      continue;
    }
    const skill = t.currentSkill;
    if (bySkill.has(skill)) bySkill.get(skill).push(t);
  }

  const out = [];
  out.push("KANCLI BOARD");
  out.push(`queue=${data.queue?.length || 0} running=${data.running?.length || 0}`);
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
      const card = renderTicketCard(t);
      out.push(`  ${pad(card[0], 60)}`);
      for (const line of card.slice(1)) out.push(`    ${pad(line, 58)}`);
      out.push("");
    }
  }

  out.push("== Done ==");
  if (!done.length) out.push("  (none)");
  for (const t of done.slice(0, 20)) out.push(`  #${t.id} ${safe(t.jiraTicket)} (${t.status})`);
  out.push("");

  out.push("== Pending Questions ==");
  if (!pendingQuestions.length) out.push("  (none)");
  for (const t of pendingQuestions) {
    const prompt = safe(t.pendingAction?.prompt, t.pendingAction?.type);
    out.push(`  #${t.id} ${safe(t.jiraTicket)} -> ${prompt}`);
  }

  return out.join("\n");
}

module.exports = { renderBoard };
