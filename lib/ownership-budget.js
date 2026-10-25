const { AsyncLocalStorage } = require("node:async_hooks");
const context = new AsyncLocalStorage();
const HANDLER_MS = 60000, RESERVE_MS = 20000, MARGIN_MS = 2000;
const now = () => performance.now();
// Absolute caller deadlines only shorten the server limit. Never trust a caller
// to extend it. Missing headers use the shortest supported portal timeout.
function handler(fn) {
  return (req, res) => {
    const raw = req.headers?.["x-request-deadline-ms"];
    const value = Number(raw);
    const remaining = raw === undefined ? HANDLER_MS :
      Number.isFinite(value) && value > 0 ? Math.max(0, value - Date.now()) : 0;
    return run({ now, requestDeadline: now() + Math.min(HANDLER_MS, remaining) - MARGIN_MS }, () => fn(req, res));
  };
}
function run(budget, work) { return context.run(budget, work); }
function lease(value, work) {
  return run({ ...context.getStore(), lease: value }, work);
}
function scanDeadline(clock) {
  const b = context.getStore();
  if (!b) return Infinity;
  const clockNow = b.now || now;
  const remaining = Math.min(b.requestDeadline ?? Infinity,
    b.lease?.deadline ?? Infinity) - clockNow() - RESERVE_MS;
  return clock() + remaining;
}
module.exports = { handler, run, lease, scanDeadline, HANDLER_MS, RESERVE_MS, MARGIN_MS };
