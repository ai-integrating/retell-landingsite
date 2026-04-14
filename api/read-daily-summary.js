const { kv } = require("@vercel/kv");
const { google } = require("googleapis");

const DEFAULT_TAB_NAME = process.env.DAILY_SUMMARY_TAB_NAME || "Call Summaries";
const MAX_ROWS_TO_READ = Number(process.env.DAILY_SUMMARY_MAX_ROWS || 25);

function getGoogleAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
  }

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (err) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  if (!creds.client_email || !creds.private_key) {
    throw new Error("Service account JSON missing client_email or private_key");
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

async function readSheetRows(spreadsheetId, tabName) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });

  const availableTabs =
    meta.data.sheets?.map((s) => s.properties?.title).filter(Boolean) || [];

  if (!availableTabs.length) {
    throw new Error("No tabs found in spreadsheet");
  }

  if (!availableTabs.includes(tabName)) {
    throw new Error(
      `Tab "${tabName}" not found in spreadsheet. Available tabs: ${availableTabs.join(", ")}`
    );
  }

  const range = `${tabName}!A:Z`;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const values = resp.data.values || [];
  if (!values.length) {
    return { tabName, rows: [] };
  }

  const headers = values[0].map((h) => String(h || "").trim());
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

function normalizeKey(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pickField(row, candidates) {
  for (const key of Object.keys(row || {})) {
    const normalized = normalizeKey(key);
    for (const candidate of candidates) {
      if (normalized === candidate) return row[key];
    }
  }
  return "";
}

function isTrueLike(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "true" || v === "yes" || v === "1";
}

function isRealCallRow(row) {
  const caller = pickField(row, [
    "callername",
    "name",
    "clientname",
    "customername",
    "fullname",
  ]);

  const reason = pickField(row, [
    "reasonforcall",
    "callreason",
    "summary",
    "notes",
    "message",
    "callsummary",
  ]);

  const phone = pickField(row, [
    "callbacknumber",
    "phonenumber",
    "phone",
    "callerphone",
    "bestnumber",
  ]);

  return Boolean(
    String(caller || "").trim() ||
      String(reason || "").trim() ||
      String(phone || "").trim()
  );
}

function summarizeRows(rows) {
  const realRows = rows.filter(isRealCallRow);

  if (!realRows.length) {
    return "There haven’t been any call summaries yet.";
  }

  const recent = realRows.slice(-MAX_ROWS_TO_READ);

  let urgentCount = 0;
  let callbackCount = 0;
  let bookingCount = 0;

  const totalCalls = recent.length;
  const notable = [];

  for (const row of recent) {
    const urgent = isTrueLike(
      pickField(row, [
        "urgent",
        "isurgent",
        "urgentmatter",
        "needsurgentattention",
        "urgencylevel",
      ])
    );

    const callback = isTrueLike(
      pickField(row, [
        "callbackneeded",
        "needscallback",
        "callbackrequested",
        "callneeded",
      ])
    );

    const booking = isTrueLike(
      pickField(row, [
        "needsbooking",
        "bookingrequested",
        "appointmentrequested",
        "bookappointment",
        "bookingcompleted",
      ])
    );

    if (urgent) urgentCount++;
    if (callback) callbackCount++;
    if (booking) bookingCount++;

    const caller =
      pickField(row, [
        "callername",
        "name",
        "clientname",
        "customername",
        "fullname",
      ]) || "A caller";

    const reason =
      pickField(row, [
        "reasonforcall",
        "callreason",
        "summary",
        "notes",
        "message",
        "callsummary",
      ]) || "";

    if (urgent || callback || booking) {
      notable.push({ caller, reason, urgent, callback, booking });
    }
  }

  let summary = `You had ${totalCalls} ${totalCalls === 1 ? "call" : "calls"} in the most recent summaries. `;

  if (notable.length) {
    const top = notable.slice(-3).reverse();

    const highlights = top.map((item) => {
      const flags = [];
      if (item.urgent) flags.push("urgent");
      if (item.callback) flags.push("needs a callback");
      if (item.booking) flags.push("booking request");

      const reasonText = item.reason ? ` about ${item.reason}` : "";
      return `${item.caller} (${flags.join(", ")})${reasonText}`;
    });

    summary += `A few highlights: ${highlights.join(", ")}. `;
  }

  if (!urgentCount && !callbackCount && !bookingCount) {
    summary += "Nothing urgent came up, and there’s nothing that needs follow-up right now.";
    return summary.trim();
  }

  if (urgentCount) {
    summary += `${urgentCount} ${urgentCount === 1 ? "call needs" : "calls need"} urgent attention. `;
  }

  if (callbackCount) {
    summary += `${callbackCount} ${callbackCount === 1 ? "person needs" : "people need"} a callback. `;
  }

  if (bookingCount) {
    summary += `${bookingCount} ${bookingCount === 1 ? "booking request was made" : "booking requests were made"}.`;
  }

  return summary.trim();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST",
    });
  }

  try {
    console.log("client-daily-summary body:", req.body);
    console.log("client-daily-summary headers:", req.headers);

    const agentId =
      req.body?.call?.agent_id ||
      req.body?.agent_id ||
      req.body?.data?.agent_id ||
      req.body?.CallAgentId ||
      req.headers?.agentid ||
      null;

    if (!agentId) {
      return res.status(400).json({
        error: "Missing agent_id",
        summary: "",
      });
    }

    const clientId = await kv.get(`agent:${agentId}:client`);
    const sheetId = clientId ? await kv.get(`client:${clientId}:sheet`) : null;

    console.log("KV lookup:", { agentId, clientId, sheetId });

    if (!clientId || !sheetId) {
      return res.status(404).json({
        summary: "I couldn't find the sheet setup for this client yet.",
        execution_message: "Sure thing, one moment while I read my notes.",
      });
    }

    const { tabName, rows } = await readSheetRows(sheetId, DEFAULT_TAB_NAME);

    console.log("summary rows found:", {
      agentId,
      clientId,
      sheetId,
      tabName,
      rowCount: rows.length,
    });

    const summary = summarizeRows(rows);

    return res.status(200).json({
      summary,
      execution_message: "Sure thing, one moment while I read my notes.",
      debug: {
        clientId,
        sheetId,
        tabName,
        rowCount: rows.length,
        realRowCount: rows.filter(isRealCallRow).length,
      },
    });
  } catch (error) {
    console.error("client-daily-summary error:", error);

    return res.status(500).json({
      summary: "",
      error: "Failed to generate summary",
      details: error?.message || "Unknown error",
    });
  }
};
