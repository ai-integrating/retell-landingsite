const { fail } = require("./refinement-section");
// No TTL: maintenance cannot silently expire while a human is editing Retell.
const PAUSE = `if redis.call("exists",KEYS[1]) == 1 then return -1 end
local current = redis.call("get",KEYS[2])
if current and current ~= ARGV[1] then return -2 end
redis.call("set",KEYS[2],ARGV[1]); return 1`;
const RESUME = `if redis.call("exists",KEYS[1]) == 1 then return -1 end
if redis.call("get",KEYS[2]) ~= ARGV[1] then return -2 end
redis.call("del",KEYS[2]); return 1`;
async function maintenance(kv, llmId, action, maintenanceId) {
  if (!/^[A-Za-z0-9_-]+$/.test(llmId) ||
      !/^[A-Za-z0-9_-]{16,120}$/.test(maintenanceId) ||
      !["pause", "resume"].includes(action)) fail(400, "INVALID_MAINTENANCE_REQUEST");
  const root = `refinement:v1:llm:${llmId}`;
  if (action === "resume") {
    for (const suffix of ["journal", "publication", "configuration"]) {
      const record = await kv.get(`${root}:${suffix}`);
      if (record && record.status !== "confirmed" && record.status !== "rejected") {
        fail(409, "UNRESOLVED_WRITER");
      }
    }
  }
  const result = await kv.eval(action === "pause" ? PAUSE : RESUME,
    [`${root}:lock`, `${root}:maintenance`], [maintenanceId]);
  if (result === -1) fail(409, "WRITER_IN_FLIGHT");
  if (result !== 1) fail(409, "MAINTENANCE_OWNER_MISMATCH");
  return { ok: true, paused: action === "pause" };
}
module.exports = { maintenance, PAUSE, RESUME };
