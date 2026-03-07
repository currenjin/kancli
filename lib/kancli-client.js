const http = require("http");
const https = require("https");

class KancliClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || "http://localhost:3000").replace(/\/$/, "");
  }

  async request(path, options = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    const transport = url.protocol === "https:" ? https : http;
    const body = options.body;

    const reqOptions = {
      method: options.method || "GET",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    };

    const payloadText = await new Promise((resolve, reject) => {
      const req = transport.request(reqOptions, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          const statusCode = res.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            try {
              const parsed = data ? JSON.parse(data) : {};
              const message = parsed?.error || `${statusCode} ${res.statusMessage || "request failed"}`;
              reject(new Error(message));
            } catch {
              reject(new Error(`${statusCode} ${res.statusMessage || "request failed"}`));
            }
            return;
          }
          resolve(data);
        });
      });

      req.on("error", (err) => {
        reject(new Error(`fetch failed (server unreachable: ${this.baseUrl}). run 'kancli up' first.`));
      });

      if (body !== undefined) req.write(body);
      req.end();
    });

    try {
      return payloadText ? JSON.parse(payloadText) : {};
    } catch {
      return {};
    }
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
