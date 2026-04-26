const { kv } = require("@vercel/kv");
const { google } = require("googleapis");

const DEFAULT_TAB_NAME = process.env.DAILY_SUMMARY_TAB_NAME || "Daily_Memory";

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function getGoogleAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  const privateKey = String(creds.private_key)
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .trim();

  return new google.auth.JWT(
    creds.client_email,
    null,
    privateKey,
    ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  );
}

function getArgs(body) {
  if (!body || typeof body !== "object") return {};
  if (body.args && typeof body.args === "object") return body.args;
  return {};
}

function getAgentId(req) {
  const body = req.body || {};
  const args = getArgs(body);

  const possibleAgentId =
    clean(body?.call?.agent_id) ||
    clean(args.agent_id) ||
    clean(body.agent_id) ||
    clean(body?.data?.agent_id) ||
    clean(body?.CallAgentId) ||
    clean(req.headers?.["x-agent-id"]) ||
    clean(req.headers?.agentid);

  if (!possibleAgentId) return "";
  if (possibleAgentId.includes("{{") || possibleAgentId.includes("}}")) return "";

  return possibleAgentId;
}

async function readSheetRows(spreadsheetId, tabName) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });

  const availableTabs =
    meta.data.sheets?.map((s) => s.properties?.title).filter(Boolean) || [];

  if (!availableTabs.includes(tabName)) {
    throw new Error(`Tab "${tabName}" not found. Available tabs: ${availableTabs.join(", ")}`);
  }

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:Z`,
  });

  const values = resp.data.values || [];

  if (!values.length) {
    return { tabName, rows: [] };
  }

  const headers = values[0].map((h) => clean(h));
  const bodyRows = values.slice(1);

  const rows = bodyRows.map((row) => {
    const obj = {};
    headers.forEach((header, i) => {
      obj[header || `column_${i + 1}`] = row[i] ?? "";
    });
    return obj;
  });

  return { tabName, rows };
}

function getTodayDateString() {
  const today = new Date();
  return today.toLocaleDateString("en-US");
}

function findTodaySummary(rows) {
  const today = getTodayDateString();

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];

    const date = clean(row["Date"] || row["date"]);
    const summary = clean(row["summary_text"] || row["Summary"] || row["summary"]);

    if (!date) continue;

    if (date === today || date.includes(today)) {
      return summary;
    }
  }

  return "";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST.",
    });
  }

  try {
    const agentId = getAgentId(req);

    if (!agentId) {
      return res.status(400).json({
        summary: "I couldn't find the agent ID for this call.",
        execution_message: "Alright, let me check that.",
        error: "Missing agent_id",
      });
    }

    const clientId = await kv.get(`agent:${agentId}:client`);
    const sheetId = clientId
      ? await kv.get(`client:${clientId}:sheet`)
      : null;

    if (!clientId || !sheetId) {
      return res.status(404).json({
        summary: "I couldn't find the sheet setup for this client yet.",
        execution_message: "Alright, let me check that.",
        error: "Missing KV mapping",
        debug: {
          agentId,
          clientId,
          sheetId,
          expectedAgentClientKey: `agent:${agentId}:client`,
          expectedClientSheetKey: clientId
            ? `client:${clientId}:sheet`
            : null,
        },
      });
    }

    const { tabName, rows } = await readSheetRows(sheetId, DEFAULT_TAB_NAME);

    const summary = findTodaySummary(rows);

    return res.status(200).json({
      summary: summary || "I couldn’t find a daily summary for today yet.",
      execution_message: "Alright, here’s what came in today.",
      debug: {
        agentId,
        clientId,
        sheetId,
        tabName,
        rowCount: rows.length,
      },
    });
  } catch (error) {
    console.error("read-daily-summary error:", error);

    return res.status(500).json({
      summary: "",
      execution_message: "I’m sorry, I couldn’t read the daily summary right now.",
      error: "Failed to generate summary",
      details: error?.message || "Unknown error",
    });
  }
};
