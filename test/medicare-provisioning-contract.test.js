const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const source = fs.readFileSync(require.resolve("../api/provision.js"), "utf8");

// Offline source-contract checks: these are NOT end-to-end Retell simulations.
test("Medicare package selection is exact and isolated from ordinary agents", () => {
  assert.match(source, /const MEDICARE_PACKAGE = "medicare premium scheduler"/);
  assert.match(source, /const isMedicare = subscription === MEDICARE_PACKAGE/);
  assert.match(source, /const config = isMedicare\s*\? AI_EMPLOYEES\["ava — ai scheduler"\]/);
});
test("Medicare creates a conversation flow while regular agents retain LLM provisioning", () => {
  assert.match(source, /if \(isMedicare\) \{\s*if \(!conversationFlowId\) \{\s*conversationFlowId = await createMedicareFlow/);
  assert.match(source, /\} else \{\s*templateTools =\s*await getTemplateLlmTools/);
  assert.match(source, /response_engine: isMedicare \? \{\s*type: "conversation-flow",\s*conversation_flow_id: conversationFlowId,\s*\} : \{\s*type:\s*"retell-llm",\s*llm_id: llmId/);
});
test("Conversation Flow identity survives intermediate and agent-created records", () => {
  assert.match(source, /conversationFlowId = record\?\.conversation_flow_id \|\| null/);
  assert.match(source, /record = await saveProvisionRecord\(idemKey, \{\s*\.\.\.record,\s*conversation_flow_id: conversationFlowId/);
  assert.match(source, /\.\.\.\(isMedicare \? \{ conversation_flow_id: conversationFlowId \} : \{\}\),\s*status:\s*"agent_created"/);
});
test("existing completed jobs and agent IDs are reused", () => {
  assert.match(source, /if \(record\?\.status === "completed"\)/);
  assert.match(source, /let agentId =\s*record\?\.agent_id \|\| null/);
  assert.match(source, /if \(!agentId\) \{/);
});
