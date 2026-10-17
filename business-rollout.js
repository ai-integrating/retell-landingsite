// No request field or environment override can expand this reviewed scope.
const BUSINESS_SECTION_PILOT_ENABLED = false;
const PILOT = Object.freeze({
  clientId: "lets-go-6659962517436476386",
  agentId: "agent_67e9dc0ab56576c4b9d3264eaa",
  llmId: "llm_4b9754f0d31810c67f2d4354c105",
});
function pilotMatches(body) {
  return body?.client_id === PILOT.clientId && body?.agent_id === PILOT.agentId;
}
module.exports = { BUSINESS_SECTION_PILOT_ENABLED, PILOT, pilotMatches };
