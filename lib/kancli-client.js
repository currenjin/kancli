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

  subscribeEvents(onEvent, onError) {
    const ac = new AbortController();

    (async () => {
      let res;
      try {
        res = await fetch(`${this.baseUrl}/api/events`, {
          method: "GET",
          headers: { Accept: "text/event-stream" },
          signal: ac.signal,
        });
      } catch (err) {
        if (!ac.signal.aborted) onError?.(err);
        return;
      }

      if (!res.ok || !res.body) {
        onError?.(new Error(`sse failed: ${res.status} ${res.statusText}`));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let eventData = "";

      const flushEvent = () => {
        const raw = eventData.trim();
        if (!raw) return;
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch {}
        onEvent?.({ event: eventName || "message", data: parsed });
      };

      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line) {
              flushEvent();
              eventName = "message";
              eventData = "";
              continue;
            }
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) eventData += `${line.slice(5).trim()}\n`;
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) onError?.(err);
      }
    })();

    return () => ac.abort();
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

  remove(ticketId) {
    return this.request(`/api/tickets/${ticketId}`, { method: "DELETE" });
  }
}

module.exports = { KancliClient };
