// /api/daily-summary.js
const { kv } = require("@vercel/kv");
const { google } = require("googleapis");

const DEFAULT_SUMMARY_TAB_NAME =
  process.env.DAILY_SUMMARY_TAB_NAME || "Call Summaries";
const MAX_ROWS_TO_READ = Number(process.env.DAILY_SUMMARY_MAX_ROWS || 25);

const TAB_NAMES = {
  inventory: "Live Inventory",
  orders: "Order Log",
  pricing: "Market Pricing",
};

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
  .replace(/\\n/g, "\n")   // 
  .replace(/\r/g, "")
  .trim();

  return new google.auth.JWT(
    creds.client_email,
    null,
    privateKey,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
}

async function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: "v4", auth });
}

function normalizeText(value = "") {
  return String(value).trim().toLowerCase();
}

function normalizeKey(value = "") {
  return normalizeText(value).replace(/[^a-z0-9]/g, "");
}

function safeNumber(value) {
  const cleaned = String(value ?? "").replace(/[^0-9.-]/g, "");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

async function readSheetRows(spreadsheetId, tabName) {
  const sheets = await getSheetsClient();

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

function summarizeRows(rows) {
  if (!rows.length) {
    return "There haven’t been any calls yet today.";
  }

  const recent = rows.slice(-MAX_ROWS_TO_READ);

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

  let summary = `You had ${totalCalls} ${
    totalCalls === 1 ? "call" : "calls"
  } come in recently. `;

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
    summary +=
      "Nothing urgent came up, and there’s nothing that needs follow-up right now.";
    return summary;
  }

  if (urgentCount) {
    summary += `${urgentCount} ${
      urgentCount === 1 ? "call needs" : "calls need"
    } urgent attention. `;
  }

  if (callbackCount) {
    summary += `${callbackCount} ${
      callbackCount === 1 ? "person needs" : "people need"
    } a callback. `;
  }

  if (bookingCount) {
    summary += `${bookingCount} ${
      bookingCount === 1
        ? "booking request was made"
        : "booking requests were made"
    }.`;
  }

  return summary.trim();
}

function findRowMatch(rows, species) {
  if (!species) return null;

  const target = normalizeText(species);

  return (
    rows.find((row) =>
      normalizeText(
        pickField(row, ["speciessize", "species", "item", "product"])
      ) === target
    ) ||
    rows.find((row) =>
      normalizeText(
        pickField(row, ["speciessize", "species", "item", "product"])
      ).includes(target)
    )
  );
}

async function appendOrderRow(spreadsheetId, values) {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${TAB_NAMES.orders}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [values],
    },
  });
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

    const args = req.body?.args || req.body || {};

    // IMPORTANT:
    // Prefer live Retell call metadata first, just like your old working version.
    // Only use args.agent_id as a last fallback.
    const agentId =
      req.body?.call?.agent_id ||
      req.body?.agent_id ||
      req.body?.data?.agent_id ||
      req.body?.CallAgentId ||
      req.headers?.agentid ||
      args.agent_id ||
      null;

    const action = args.action || null;
    const species = args.species || "";
    const buyerName = args.buyer_name || "";
    const quantityLbs = args.quantity_lbs;
    const shippingDestination = args.shipping_destination || "";

    if (!agentId) {
      return res.status(400).json({
        error: "Missing agent_id",
        summary: "",
      });
    }

    if (!action) {
      return res.status(400).json({
        error: "Missing action",
        summary: "",
      });
    }

    const clientId = await kv.get(`agent:${agentId}:client`);
    const sheetId = clientId
      ? await kv.get(`client:${clientId}:sheet`)
      : null;

    console.log("KV lookup:", { agentId, clientId, sheetId, action });

    if (!clientId || !sheetId) {
      return res.status(404).json({
        summary: "I couldn't find the sheet setup for this client yet.",
        execution_message: "Sure thing, one moment while I read my notes.",
      });
    }

    if (action === "get_summary") {
      const { tabName, rows } = await readSheetRows(
        sheetId,
        DEFAULT_SUMMARY_TAB_NAME
      );

      const summary = summarizeRows(rows);

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
    }

    if (action === "get_inventory") {
      const { tabName, rows } = await readSheetRows(sheetId, TAB_NAMES.inventory);

      if (!rows.length) {
        return res.status(200).json({
          summary: "The live inventory sheet is empty right now.",
          execution_message: "One moment while I check inventory.",
          debug: { clientId, sheetId, tabName, rowCount: 0 },
        });
      }

      if (!species) {
        return res.status(200).json({
          summary: "Please specify which seafood item you want me to check.",
          execution_message: "One moment while I check inventory.",
          debug: { clientId, sheetId, tabName, rowCount: rows.length },
        });
      }

      const match = findRowMatch(rows, species);

      if (!match) {
        return res.status(200).json({
          summary: `I could not find ${species} in the live inventory.`,
          execution_message: "One moment while I check inventory.",
          debug: { clientId, sheetId, tabName, rowCount: rows.length },
        });
      }

      const speciesName = pickField(match, ["speciessize", "species", "item"]);
      const poundsAvailable = pickField(match, [
        "poundsavailable",
        "availablelbs",
        "quantityavailable",
      ]);
      const pricePerPound = pickField(match, [
        "priceperpound",
        "price",
        "priceperlb",
      ]);
      const port = pickField(match, ["port", "location"]);
      const status = pickField(match, ["status"]);
      const lastUpdated = pickField(match, ["lastupdated", "updated"]);
      const availableForSale = pickField(match, [
        "availableforsale",
        "forsale",
        "available",
      ]);

      const summary =
        normalizeText(availableForSale) === "yes"
          ? `${speciesName} is available for sale. There are ${poundsAvailable} pounds available at ${pricePerPound} per pound from ${port}. Status is ${status}. Last updated ${lastUpdated}.`
          : `${speciesName} is currently not available for sale. There are ${poundsAvailable} pounds listed. Status is ${status}. Last updated ${lastUpdated}.`;

      return res.status(200).json({
        summary,
        execution_message: "One moment while I check inventory.",
        data: {
          species: speciesName,
          pounds_available: poundsAvailable,
          price_per_pound: pricePerPound,
          port,
          status,
          last_updated: lastUpdated,
          available_for_sale: availableForSale,
        },
        debug: {
          clientId,
          sheetId,
          tabName,
          rowCount: rows.length,
        },
      });
    }

    if (action === "get_market_price") {
      const { tabName, rows } = await readSheetRows(sheetId, TAB_NAMES.pricing);

      if (!rows.length) {
        return res.status(200).json({
          summary: "The market pricing sheet is empty right now.",
          execution_message: "One moment while I check pricing.",
          debug: { clientId, sheetId, tabName, rowCount: 0 },
        });
      }

      if (!species) {
        return res.status(200).json({
          summary: "Please specify which seafood item you want priced.",
          execution_message: "One moment while I check pricing.",
          debug: { clientId, sheetId, tabName, rowCount: rows.length },
        });
      }

      const match = findRowMatch(rows, species);

      if (!match) {
        return res.status(200).json({
          summary: `I could not find market pricing for ${species}.`,
          execution_message: "One moment while I check pricing.",
          debug: { clientId, sheetId, tabName, rowCount: rows.length },
        });
      }

      const speciesName = pickField(match, ["speciessize", "species", "item"]);
      const averagePrice = pickField(match, [
        "averageprice",
        "avgprice",
        "price",
      ]);
      const minimumPrice = pickField(match, ["minimumprice", "minprice"]);
      const maximumPrice = pickField(match, ["maximumprice", "maxprice"]);
      const source = pickField(match, ["source"]);
      const dateUpdated = pickField(match, ["dateupdated", "updated"]);
      const auctionNotes = pickField(match, ["auctionnotes", "notes"]);

      const summary = `${speciesName} has an average market price of ${averagePrice}, with a low of ${minimumPrice} and a high of ${maximumPrice}. Source: ${source}. Updated ${dateUpdated}. Notes: ${
        auctionNotes || "none"
      }.`;

      return res.status(200).json({
        summary,
        execution_message: "One moment while I check pricing.",
        data: {
          species: speciesName,
          average_price: averagePrice,
          minimum_price: minimumPrice,
          maximum_price: maximumPrice,
          source,
          date_updated: dateUpdated,
          auction_notes: auctionNotes,
        },
        debug: {
          clientId,
          sheetId,
          tabName,
          rowCount: rows.length,
        },
      });
    }

    if (action === "place_order") {
      if (!species || !buyerName || !quantityLbs || !shippingDestination) {
        return res.status(400).json({
          summary:
            "To place the order, I still need the buyer name, seafood item, quantity in pounds, and shipping destination.",
          execution_message: "One moment while I log this order.",
        });
      }

      const requestedQty = safeNumber(quantityLbs);

      if (!requestedQty || requestedQty <= 0) {
        return res.status(400).json({
          summary: "The quantity needs to be a valid number greater than zero.",
          execution_message: "One moment while I log this order.",
        });
      }

      const { tabName, rows } = await readSheetRows(sheetId, TAB_NAMES.inventory);

      if (!rows.length) {
        return res.status(200).json({
          summary:
            "I could not place the order because the live inventory sheet is empty.",
          execution_message: "One moment while I log this order.",
          debug: { clientId, sheetId, tabName, rowCount: 0 },
        });
      }

      const match = findRowMatch(rows, species);

      if (!match) {
        return res.status(200).json({
          summary: `I could not place the order because ${species} was not found in live inventory.`,
          execution_message: "One moment while I log this order.",
          debug: { clientId, sheetId, tabName, rowCount: rows.length },
        });
      }

      const speciesName = pickField(match, ["speciessize", "species", "item"]);
      const poundsAvailable = safeNumber(
        pickField(match, [
          "poundsavailable",
          "availablelbs",
          "quantityavailable",
        ])
      );
      const pricePerPoundRaw = pickField(match, [
        "priceperpound",
        "price",
        "priceperlb",
      ]);
      const pricePerPound = safeNumber(pricePerPoundRaw);
      const availableForSale = pickField(match, [
        "availableforsale",
        "forsale",
        "available",
      ]);

      if (normalizeText(availableForSale) !== "yes") {
        return res.status(200).json({
          summary: `${speciesName} is not currently available for sale.`,
          execution_message: "One moment while I log this order.",
          debug: { clientId, sheetId, tabName, rowCount: rows.length },
        });
      }

      if (requestedQty > poundsAvailable) {
        return res.status(200).json({
          summary: `There are only ${poundsAvailable} pounds of ${speciesName} available, so I could not log an order for ${requestedQty} pounds.`,
          execution_message: "One moment while I log this order.",
          debug: { clientId, sheetId, tabName, rowCount: rows.length },
        });
      }

      const totalPrice = requestedQty * pricePerPound;
      const now = new Date();

      const datePart = now.toISOString().slice(0, 10);
      const timePart = now.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: false,
      });
      const timestamp = `${datePart} ${timePart}`;

      await appendOrderRow(sheetId, [
        timestamp,
        buyerName,
        speciesName,
        requestedQty,
        pricePerPound,
        totalPrice,
        shippingDestination,
        "Pending",
      ]);

      return res.status(200).json({
        summary: `The order has been logged for ${buyerName}: ${requestedQty} pounds of ${speciesName} at ${pricePerPoundRaw} per pound, total ${totalPrice}, shipping to ${shippingDestination}. Status is Pending.`,
        execution_message: "One moment while I log this order.",
        data: {
          buyer_name: buyerName,
          species: speciesName,
          quantity_lbs: requestedQty,
          price_per_pound: pricePerPoundRaw,
          total_price: totalPrice,
          shipping_destination: shippingDestination,
          order_status: "Pending",
        },
        debug: {
          clientId,
          sheetId,
          inventoryTab: tabName,
          rowCount: rows.length,
        },
      });
    }

    return res.status(400).json({
      error: `Unsupported action: ${action}`,
      summary: "",
    });
  } catch (error) {
    console.error("daily-summary error:", error);

    return res.status(500).json({
      summary: "",
      error: "Failed to process request",
      details: error?.message || "Unknown error",
    });
  }
};
