// /api/daily-summary.js
const { kv } = require("@vercel/kv");
const { google } = require("googleapis");

const DEFAULT_TAB_NAME = process.env.DAILY_SUMMARY_TAB_NAME || "Call Summaries";
const MAX_ROWS_TO_READ = Number(process.env.DAILY_SUMMARY_MAX_ROWS || 25);

// 🔥 FIXED AUTH FUNCTION
function getGoogleAuth() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    throw new Error("Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY");
  }

  // 🔑 normalize the key (THIS FIXES YOUR ERROR)
  privateKey = privateKey
    .replace(/^"(.*)"$/s, "$1")   // remove accidental wrapping quotes
    .replace(/\\n/g, "\n")        // handle escaped newlines
    .trim();

  return new google.auth.JWT(
    clientEmail,
    null,
    privateKey,
    ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  );
}

async function readSheetRows(spreadsheetId, tabName) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
  });

  const availableTabs =
    meta.data.sheets?.map((s) => s.properties?.title).filter(Boolean) || [];

  const selectedTab = availableTabs.includes(tabName)
    ? tabName
    : availableTabs[0];

  if (!selectedTab) {
    throw new Error("No tabs found in spreadsheet");
  }

  const range = `${selectedTab}!A:Z`;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const values = resp.data.values || [];
  if (!values.length) {
    return { tabName: selectedTab, rows: [] };
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

  return { tabName: selectedTab, rows };
}

function pickField(row, candidates) {
  for (const key of Object.keys(row)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const candidate of candidates) {
      if (normalized === candidate) return row[key];
    }
  }
  return "";
}

function summarizeRows(rows, clientId) {
  if (!rows.length) {
    return `I found the sheet for client ${clientId}, but there are no call summary rows yet.`;
  }

  const recent = rows.slice(-MAX_ROWS_TO_READ);

  let urgentCount = 0;
  let callbackCount = 0;
  let bookingCount = 0;
  let totalCalls = recent.length;

  const notable = [];

  for (const row of recent) {
    const urgent =
      String(
        pickField(row, [
          "urgent",
          "isurgent",
          "urgentmatter",
          "needsurgentattention",
        ]) || ""
      ).toLowerCase() === "true";

    const callback =
      String(
        pickField(row, [
          "callbackneeded",
          "needscallback",
          "callbackrequested",
          "callneeded",
        ]) || ""
      ).toLowerCase() === "true";

    const booking =
      String(
        pickField(row, [
          "needsbooking",
          "bookingrequested",
          "appointmentrequested",
          "bookappointment",
        ]) || ""
      ).toLowerCase() === "true";

    if (urgent) urgentCount += 1;
    if (callback) callbackCount += 1;
    if (booking) bookingCount += 1;

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
      notable.push({
        caller,
        reason,
        urgent,
        callback,
        booking,
      });
    }
  }

  let summary = `I reviewed the latest ${totalCalls} call summaries for client ${clientId}. `;

  if (!urgentCount && !callbackCount && !bookingCount) {
    summary +=
      "There are no urgent issues, callback requests, or booking requests in the most recent entries.";
    return summary;
  }

  summary += `There ${
    urgentCount === 1 ? "was" : "were"
  } ${urgentCount} urgent ${
    urgentCount === 1 ? "issue" : "issues"
  }, ${callbackCount} callback ${
    callbackCount === 1 ? "request" : "requests"
  }, and ${bookingCount} booking ${
    bookingCount === 1 ? "request" : "requests"
  }.`; 

  if (notable.length) {
    const top = notable.slice(-3).reverse();
    const details = top.map((item) => {
      const flags = [];
      if (item.urgent) flags.push("urgent");
      if (item.callback) flags.push("callback needed");
      if (item.booking) flags.push("booking requested");

      const reasonText = item.reason ? ` Reason: ${item.reason}.` : "";
      return `${item.caller}: ${flags.join(", ")}.${reasonText}`;
    });

    summary += ` Most recent notable items: ${details.join(" ")}`;
  }

  return summary;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST",
    });
  }

  try {
    console.log("daily-summary body:", req.body);
    console.log("daily-summary headers:", req.headers);

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
      });
    }

    const clientId = await kv.get(`agent:${agentId}:client`);
    const sheetId = clientId
      ? await kv.get(`client:${clientId}:sheet`)
      : null;

    console.log("KV lookup:", { agentId, clientId, sheetId });

    if (!clientId || !sheetId) {
      return res.status(404).json({
        summary: "I couldn't find the sheet setup for this client yet.",
        execution_message: "Sure thing, one moment while I read my notes.",
      });
    }

    const { tabName, rows } = await readSheetRows(sheetId, DEFAULT_TAB_NAME);

    console.log("daily-summary rows found:", {
      agentId,
      clientId,
      sheetId,
      tabName,
      rowCount: rows.length,
    });

    const summary = summarizeRows(rows, clientId);

    return res.status(200).json({
      summary,
      execution_message: "Sure thing, one moment while I read my notes.",
      debug: {
        clientId,
        sheetId,
        tabName,
        rowCount: rows.length,
      },
    });
  } catch (error) {
    console.error("daily-summary error:", error);

    return res.status(500).json({
      summary: "",
      error: "Failed to generate summary",
    });
  }
};
