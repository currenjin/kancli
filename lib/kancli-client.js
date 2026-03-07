class KancliClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || "http://localhost:3000").replace(/\/$/, "");
  }

  async request(path, options = {}) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
    } catch (err) {
      throw new Error(`fetch failed (server unreachable: ${this.baseUrl}). run 'kancli up' first.`);
    }

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = payload?.error || `${res.status} ${res.statusText}`;
      throw new Error(message);
    }
    return payload;
  }

  health() {
    return this.request("/health");
  }

  status() {
    return this.request("/api/tickets");
  }

  configGet() {
    return this.request("/api/config");
  }

  configSet(payload) {
    return this.request("/api/config", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    });
  }

  scanSkills(projectPath) {
    return this.request(`/api/skills?projectPath=${encodeURIComponent(projectPath)}`);
  }

  add(jiraTicket) {
    return this.request("/api/tickets", {
      method: "POST",
      body: JSON.stringify({ jiraTicket }),
    });
  }

  ticketLog(ticketId) {
    return this.request(`/api/tickets/${ticketId}/log`);
  }

  answer(ticketId, payload) {
    return this.request(`/api/tickets/${ticketId}/actions/resolve`, {
      method: "POST",
      body: JSON.stringify(payload || {}),
    });
  }

  next(ticketId) {
    return this.request(`/api/tickets/${ticketId}/next`, { method: "POST" });
  }

  stop(ticketId) {
    return this.request(`/api/tickets/${ticketId}/stop`, { method: "POST" });
  }
}

module.exports = { KancliClient };
