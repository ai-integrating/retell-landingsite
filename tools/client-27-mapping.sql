-- PREPARED ONLY. DEVELOPMENT database only. Never execute against production.
-- Expect exactly one returned row; zero means STOP and investigate, not retry
-- with relaxed conditions. Never changes scheduler_agent_id or external KV.
UPDATE clients
SET agent_id = 'agent_67e9dc0ab56576c4b9d3264eaa'
WHERE id = 27
  AND config_client_id = 'lets-go-6659962517436476386'
  AND agent_id IS NULL
  AND scheduler_agent_id = 'agent_67e9dc0ab56576c4b9d3264eaa'
  AND is_active = TRUE
  AND portal_access_disabled = FALSE
  AND EXISTS (
    SELECT 1 FROM business_agent_sync s
    WHERE s.client_id = clients.id AND s.saved_revision = 1
      AND s.snapshot_hash = '3e00e84bdd3c34f944ce3a15bba4dd18a59d5520f09d9a6a531335f39a2f278c'
  )
RETURNING id, agent_id, scheduler_agent_id;
