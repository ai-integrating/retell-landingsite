const { fail } = require("./refinement-section");
const LIMITS = Object.freeze({ deadlineMs: 120000, requestRetries: 3, scanRetries: 20,
  initialBackoffMs: 500, maxBackoffMs: 8000 });
function createScan(clock = {}) {
  const now = clock.now || (() => performance.now());
  return { now, wallNow: clock.wallNow || Date.now, random: clock.random || Math.random,
    sleep: clock.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    deadline: now() + LIMITS.deadlineMs, retries: 0 };
}
function retryAfter(headers, wallNow) {
  const raw = headers?.get?.("retry-after") ?? headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw == null || String(raw).trim() === "") return 0;
  const text = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - wallNow()) : 0;
}
function permitted(method, url) {
  const p = new URL(url).pathname;
  return (method === "post" && p === "/v2/list-agents") ||
    (method === "get" && /^\/(list-agent-versions|get-agent|get-chat-agent)\/[\w-]+$/.test(p));
}
async function read(axios, method, url, options, scan) {
  const retryable = permitted(method, url);
  for (let attempt = 0; ; attempt++) {
    const remaining = scan.deadline - scan.now();
    if (remaining <= 0) fail(503, "OWNERSHIP_SCAN_DEADLINE");
    const controller = new AbortController();
    const config = { ...options, timeout: Math.min(options?.timeout || remaining, remaining),
      signal: options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal };
    let timer;
    try {
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const e = Error("OWNERSHIP_SCAN_DEADLINE"); e.status = 503; e.code = e.message; reject(e);
        }, remaining);
      });
      const result = await Promise.race([
        method === "post" ? axios.post(url, {}, config) : axios.get(url, config), expired,
      ]);
      if (scan.now() >= scan.deadline) fail(503, "OWNERSHIP_SCAN_DEADLINE");
      return result;
    } catch (error) {
      if (scan.now() >= scan.deadline || controller.signal.aborted) fail(503, "OWNERSHIP_SCAN_DEADLINE");
      if (!retryable || options?.signal?.aborted ||
        (error.response?.status ?? error.status) !== 429) throw error;
      if (attempt >= LIMITS.requestRetries || scan.retries >= LIMITS.scanRetries)
        fail(503, "OWNERSHIP_RATE_LIMIT_EXHAUSTED");
      const cap = Math.min(LIMITS.maxBackoffMs, LIMITS.initialBackoffMs * 2 ** attempt);
      const backoff = cap * (0.5 + scan.random() * 0.5);
      const delay = Math.max(backoff, retryAfter(error.response?.headers ?? error.headers, scan.wallNow));
      if (!Number.isFinite(delay) || delay >= scan.deadline - scan.now()) fail(503, "OWNERSHIP_SCAN_DEADLINE");
      scan.retries++;
      clearTimeout(timer);
      await scan.sleep(delay);
    } finally { clearTimeout(timer); }
  }
}
module.exports = { createScan, read, LIMITS, retryAfter };
