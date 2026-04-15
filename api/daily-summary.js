// /api/bergie.js
const { kv } = require("@vercel/kv");
const { google } = require("googleapis");
const crypto = require("crypto");

const DEFAULT_SUMMARY_TAB_NAME =
  process.env.DAILY_SUMMARY_TAB_NAME || "Call Summaries";

const MAX_ROWS_TO_READ = Number(process.env.DAILY_SUMMARY_MAX_ROWS || 25);
const LOCK_TTL_SECONDS = Number(process.env.BERGIE_LOCK_TTL_SECONDS || 8);

const TAB_NAMES = {
  inventory: "Live Inventory",
  orders: "Order Log",
  pricing: "Market Pricing",
  shipping: "Shipping Queue",
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
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
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

function getAvailabilityValue(row) {
  return (
    pickField(row, [
      "availableforsale",
      "availableforsaleyesno",
      "availableforsal",
      "available",
      "forsale",
      "saleavailable",
    ]) || ""
  );
}

function isAvailableForSale(row) {
  const value = normalizeText(getAvailabilityValue(row));
  return (
    value === "yes" ||
    value === "true" ||
    value === "available" ||
    value === "y" ||
    value === "1"
  );
}

function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function nowTimestamp() {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const timePart = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${datePart} ${timePart}`;
}

function makeId(prefix = "id") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function makeLotId(species) {
  const key = normalizeKey(species || "item") || "item";
  return `lot_${nowIsoDate()}_${key}_${crypto.randomBytes(3).toString("hex")}`;
}

function getClientInventoryIndexKey(clientId) {
  return `bergie:client:${clientId}:inventory:index`;
}

function getInventoryLotKey(clientId, lotId) {
  return `bergie:client:${clientId}:inventory:lot:${lotId}`;
}

function getProductIndexKey(clientId, speciesKey) {
  return `bergie:client:${clientId}:inventory:product:${speciesKey}`;
}

function getOrderKey(clientId, orderId) {
  return `bergie:client:${clientId}:order:${orderId}`;
}

function getLockKey(clientId, speciesKey) {
  return `bergie:client:${clientId}:lock:${speciesKey}`;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return [value];
}

function clean(value) {
  return String(value || "").trim();
}

function normalizeShippingDestination(value) {
  const v = clean(value);
  return v.toLowerCase() === "pickup" ? "pickup" : v;
}

async function readSheetRows(spreadsheetId, preferredTabName) {
  const sheets = await getSheetsClient();

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
  });

  const availableTabs =
    meta.data.sheets?.map((s) => s.properties?.title).filter(Boolean) || [];

  let selectedTab = preferredTabName;

  if (!availableTabs.includes(selectedTab)) {
    const normalizedPreferred = normalizeKey(preferredTabName);
    selectedTab =
      availableTabs.find((tab) => normalizeKey(tab) === normalizedPreferred) ||
      availableTabs.find((tab) =>
        normalizeKey(tab).includes(normalizedPreferred)
      ) ||
      availableTabs[0];
  }

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

  const target = normalizeKey(species);

  return (
    rows.find((row) => {
      const value = normalizeKey(
        pickField(row, ["speciessize", "species", "item", "product"])
      );
      return value === target;
    }) ||
    rows.find((row) => {
      const value = normalizeKey(
        pickField(row, ["speciessize", "species", "item", "product"])
      );
      return value.includes(target) || target.includes(value);
    })
  );
}

async function appendOrderRow(spreadsheetId, values) {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${TAB_NAMES.orders}!A:J`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [values],
    },
  });
}

async function appendShippingRow(spreadsheetId, values) {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${TAB_NAMES.shipping}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [values],
    },
  });
}

async function upsertInventorySheet(spreadsheetId, inventoryItems) {
  const sheets = await getSheetsClient();

  const header = [
    "Lot ID",
    "Species / Size",
    "Species Key",
    "Price Per Pound",
    "Starting Pounds",
    "Pounds Available",
    "Available For Sale",
    "Port",
    "Status",
    "Last Updated",
  ];

  const rows = inventoryItems.map((item) => [
    item.lot_id,
    item.species,
    item.species_key,
    item.price_per_pound,
    item.starting_quantity_lbs,
    item.remaining_quantity_lbs,
    item.remaining_quantity_lbs > 0 ? "Yes" : "No",
    item.port || "",
    item.status || "Fresh",
    item.last_updated || nowTimestamp(),
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB_NAMES.inventory}!A:J`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [header, ...rows],
    },
  });
}

async function acquireLock(lockKey) {
  const token = makeId("lock");
  const started = Date.now();

  while (Date.now() - started < LOCK_TTL_SECONDS * 1000) {
    const result = await kv.set(lockKey, token, {
      nx: true,
      ex: LOCK_TTL_SECONDS,
    });

    if (result === "OK" || result === true) {
      return token;
    }

    await sleep(120);
  }

  throw new Error("Could not acquire inventory lock in time");
}

async function releaseLock(lockKey, token) {
  try {
    const current = await kv.get(lockKey);
    if (current === token) {
      await kv.del(lockKey);
    }
  } catch (err) {
    console.error("releaseLock error:", err);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAllInventoryLots(clientId) {
  const lotIds = (await kv.get(getClientInventoryIndexKey(clientId))) || [];
  const uniqueLotIds = Array.from(new Set(toArray(lotIds)));

  if (!uniqueLotIds.length) return [];

  const lots = await Promise.all(
    uniqueLotIds.map((lotId) => kv.get(getInventoryLotKey(clientId, lotId)))
  );

  return lots.filter(Boolean).sort((a, b) => {
    return String(a.species || "").localeCompare(String(b.species || ""));
  });
}

async function syncInventoryToSheet(sheetId, clientId) {
  const lots = await getAllInventoryLots(clientId);
  await upsertInventorySheet(sheetId, lots);
  return lots;
}

async function storeInventoryLot(clientId, lot) {
  const lotKey = getInventoryLotKey(clientId, lot.lot_id);
  const inventoryIndexKey = getClientInventoryIndexKey(clientId);
  const productIndexKey = getProductIndexKey(clientId, lot.species_key);

  await kv.set(lotKey, lot);

  const allLotIds = (await kv.get(inventoryIndexKey)) || [];
  const productLotIds = (await kv.get(productIndexKey)) || [];

  const nextAll = Array.from(new Set([...toArray(allLotIds), lot.lot_id]));
  const nextProduct = Array.from(
    new Set([...toArray(productLotIds), lot.lot_id])
  );

  await kv.set(inventoryIndexKey, nextAll);
  await kv.set(productIndexKey, nextProduct);

  return lot;
}

async function loadInventoryIntoKV(clientId, entries) {
  const createdLots = [];

  for (const entry of entries) {
    const species =
      entry.species ||
      entry.item ||
      entry.product ||
      entry.species_size ||
      entry.speciesSize ||
      "";

    const speciesKey = normalizeKey(species);
    const quantity = safeNumber(
      entry.quantity_lbs || entry.quantity || entry.pounds || entry.lbs
    );
    const price = safeNumber(
      entry.price_per_pound || entry.price || entry.price_per_lb
    );
    const port = entry.port || entry.location || "";
    const status = entry.status || "Fresh";

    if (!species || !speciesKey || quantity <= 0) {
      continue;
    }

    const lot = {
      lot_id: makeLotId(species),
      species,
      species_key: speciesKey,
      price_per_pound: price,
      starting_quantity_lbs: quantity,
      remaining_quantity_lbs: quantity,
      port,
      status,
      created_at: nowTimestamp(),
      last_updated: nowTimestamp(),
      active: true,
    };

    await storeInventoryLot(clientId, lot);
    createdLots.push(lot);
  }

  return createdLots;
}

async function getAvailableInventoryForSpecies(clientId, species) {
  const speciesKey = normalizeKey(species);
  if (!speciesKey) return [];

  const lotIds = (await kv.get(getProductIndexKey(clientId, speciesKey))) || [];
  const lots = await Promise.all(
    toArray(lotIds).map((lotId) => kv.get(getInventoryLotKey(clientId, lotId)))
  );

  return lots
    .filter(Boolean)
    .filter(
      (lot) =>
        lot.active !== false && safeNumber(lot.remaining_quantity_lbs) > 0
    )
    .sort((a, b) => safeNumber(a.price_per_pound) - safeNumber(b.price_per_pound));
}

async function deductInventory(clientId, species, requestedQty) {
  const speciesKey = normalizeKey(species);
  const lockKey = getLockKey(clientId, speciesKey);
  const lockToken = await acquireLock(lockKey);

  try {
    const availableLots = await getAvailableInventoryForSpecies(clientId, species);

    const totalAvailable = availableLots.reduce(
      (sum, lot) => sum + safeNumber(lot.remaining_quantity_lbs),
      0
    );

    if (requestedQty > totalAvailable) {
      return {
        ok: false,
        species_key: speciesKey,
        total_available: totalAvailable,
        used_lots: [],
      };
    }

    let remainingToDeduct = requestedQty;
    const usedLots = [];

    for (const lot of availableLots) {
      if (remainingToDeduct <= 0) break;

      const remaining = safeNumber(lot.remaining_quantity_lbs);
      if (remaining <= 0) continue;

      const deduction = Math.min(remaining, remainingToDeduct);
      const nextRemaining = remaining - deduction;

      const updatedLot = {
        ...lot,
        remaining_quantity_lbs: nextRemaining,
        last_updated: nowTimestamp(),
        active: nextRemaining > 0,
      };

      await kv.set(getInventoryLotKey(clientId, lot.lot_id), updatedLot);

      usedLots.push({
        lot_id: lot.lot_id,
        species: lot.species,
        deducted_lbs: deduction,
        price_per_pound: lot.price_per_pound,
        remaining_after: nextRemaining,
      });

      remainingToDeduct -= deduction;
    }

    return {
      ok: true,
      species_key: speciesKey,
      total_available_before: totalAvailable,
      total_remaining_after: totalAvailable - requestedQty,
      used_lots: usedLots,
    };
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

async function getClientContext(agentId) {
  const clientId = await kv.get(`agent:${agentId}:client`);
  const sheetId = clientId ? await kv.get(`client:${clientId}:sheet`) : null;
  return { clientId, sheetId };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST",
    });
  }

  try {
    console.log("bergie body:", req.body);
    console.log("bergie headers:", req.headers);

    const agentId =
      req.body?.call?.agent_id ||
      req.body?.agent_id ||
      req.body?.data?.agent_id ||
      req.body?.CallAgentId ||
      req.headers?.agentid ||
      null;

    const body = req.body || {};
    const args = body.args || {};

    const action =
      clean(args.action) ||
      clean(body.args_action) ||
      clean(body.action);

    const species =
      clean(args.species) ||
      clean(body.args_species) ||
      clean(body.species);

    const buyerName =
      clean(args.buyer_name) ||
      clean(body.args_buyer_name) ||
      clean(body.buyer_name);

    const quantityLbs = safeNumber(
      args.quantity_lbs ??
        body.args_quantity_lbs ??
        body.quantity_lbs
    );

    const shippingDestination = normalizeShippingDestination(
      args.shipping_destination ||
        body.args_shipping_destination ||
        body.shipping_destination
    );

    const sellerName =
      clean(args.seller_name) ||
      clean(body.args_seller_name) ||
      clean(body.seller_name) ||
      "AI";

    const notes =
      clean(args.notes) ||
      clean(body.args_notes) ||
      clean(body.notes);

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

    const { clientId, sheetId } = await getClientContext(agentId);

    if (!clientId || !sheetId) {
      return res.status(404).json({
        summary: "I couldn't find the sheet setup for this client yet.",
        execution_message: "One moment while I check the setup.",
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

    if (action === "load_inventory") {
      const entries = Array.isArray(args.entries) ? args.entries : [];

      if (!entries.length) {
        return res.status(200).json({
          summary:
            "To load inventory, I need a list of seafood entries with species, pounds, and price.",
          execution_message: "One moment while I load today's inventory.",
        });
      }

      const createdLots = await loadInventoryIntoKV(clientId, entries);
      const currentLots = await syncInventoryToSheet(sheetId, clientId);

      const loadedSummary = createdLots.length
        ? createdLots
            .map(
              (lot) =>
                `${lot.species} (${lot.starting_quantity_lbs} lbs at ${lot.price_per_pound}/lb)`
            )
            .join(", ")
        : "No valid inventory entries were loaded.";

      return res.status(200).json({
        summary: `Today's inventory has been loaded. ${loadedSummary}.`,
        execution_message: "One moment while I load today's inventory.",
        data: {
          created_count: createdLots.length,
          active_inventory_count: currentLots.length,
          created_lots: createdLots,
        },
        debug: {
          clientId,
          sheetId,
        },
      });
    }

    if (action === "get_inventory") {
      const inventorySpecies = species;
      const lots = await getAllInventoryLots(clientId);

      if (!lots.length) {
        return res.status(200).json({
          summary: "The live inventory is empty right now.",
          execution_message: "One moment while I check inventory.",
          debug: { clientId, sheetId, rowCount: 0 },
        });
      }

      if (!inventorySpecies) {
        const availableItems = lots
          .filter((lot) => safeNumber(lot.remaining_quantity_lbs) > 0)
          .map((lot) => {
            return `${lot.species} (${lot.remaining_quantity_lbs} pounds available at ${lot.price_per_pound} per pound)`;
          });

        const summary = availableItems.length
          ? `Today we have ${availableItems.join(", ")}.`
          : "I do not see any seafood available for sale right now.";

        return res.status(200).json({
          summary,
          execution_message: "One moment while I check inventory.",
          data: {
            inventory: lots,
          },
          debug: { clientId, sheetId, rowCount: lots.length },
        });
      }

      const speciesLots = await getAvailableInventoryForSpecies(
        clientId,
        inventorySpecies
      );

      if (!speciesLots.length) {
        return res.status(200).json({
          summary: `I could not find available inventory for ${inventorySpecies}.`,
          execution_message: "One moment while I check inventory.",
          debug: { clientId, sheetId, species: inventorySpecies },
        });
      }

      const totalAvailable = speciesLots.reduce(
        (sum, lot) => sum + safeNumber(lot.remaining_quantity_lbs),
        0
      );

      const firstLot = speciesLots[0];
      const summary = `${firstLot.species} is available for sale. There are ${totalAvailable} pounds available starting at ${firstLot.price_per_pound} per pound.`;

      return res.status(200).json({
        summary,
        execution_message: "One moment while I check inventory.",
        data: {
          species: firstLot.species,
          total_available_lbs: totalAvailable,
          lots: speciesLots,
        },
        debug: { clientId, sheetId, species: inventorySpecies },
      });
    }

    if (action === "place_order") {
      if (!species || !buyerName || !quantityLbs || !shippingDestination) {
        return res.status(200).json({
          summary:
            "To place the order, I still need the buyer name, seafood item, quantity in pounds, and shipping destination.",
          execution_message: "One moment while I log this order.",
        });
      }

      if (quantityLbs <= 0) {
        return res.status(200).json({
          summary: "The quantity needs to be a valid number greater than zero.",
          execution_message: "One moment while I log this order.",
        });
      }

      const availableLots = await getAvailableInventoryForSpecies(clientId, species);
      if (!availableLots.length) {
        return res.status(200).json({
          summary: `I could not place the order because ${species} is not available in live inventory.`,
          execution_message: "One moment while I log this order.",
          debug: { clientId, sheetId, species },
        });
      }

      const speciesName = availableLots[0].species;

      const deduction = await deductInventory(clientId, species, quantityLbs);

      if (!deduction.ok) {
        return res.status(200).json({
          summary: `There are only ${deduction.total_available} pounds of ${speciesName} available, so I could not log an order for ${quantityLbs} pounds.`,
          execution_message: "One moment while I log this order.",
          debug: {
            clientId,
            sheetId,
            species,
            available: deduction.total_available,
          },
        });
      }

      const weightedTotal = deduction.used_lots.reduce(
        (sum, lot) =>
          sum + safeNumber(lot.deducted_lbs) * safeNumber(lot.price_per_pound),
        0
      );
      const avgPrice =
        quantityLbs > 0 ? Number((weightedTotal / quantityLbs).toFixed(2)) : 0;

      const orderId = makeId("order");
      const order = {
        order_id: orderId,
        timestamp: nowTimestamp(),
        buyer_name: buyerName,
        seller_name: sellerName,
        species: speciesName,
        species_key: deduction.species_key,
        quantity_lbs: quantityLbs,
        average_price_per_pound: avgPrice,
        total_price: Number(weightedTotal.toFixed(2)),
        shipping_destination: shippingDestination,
        status: "Pending",
        notes,
        used_lots: deduction.used_lots,
      };

      await kv.set(getOrderKey(clientId, orderId), order);

      await appendOrderRow(sheetId, [
        order.timestamp,
        order.order_id,
        order.buyer_name,
        order.seller_name,
        order.species,
        order.quantity_lbs,
        order.average_price_per_pound,
        order.total_price,
        order.shipping_destination,
        order.status,
      ]);

      await appendShippingRow(sheetId, [
        order.timestamp,
        order.order_id,
        order.buyer_name,
        order.species,
        order.quantity_lbs,
        order.shipping_destination,
        order.status,
        order.notes,
      ]);

      await syncInventoryToSheet(sheetId, clientId);

      return res.status(200).json({
        summary: `The order has been logged for ${buyerName}: ${quantityLbs} pounds of ${speciesName}, average price ${avgPrice} per pound, total ${order.total_price}, shipping to ${shippingDestination}. Status is Pending.`,
        execution_message: "One moment while I log this order.",
        data: order,
        debug: {
          clientId,
          sheetId,
          deducted_from_lots: deduction.used_lots,
          total_remaining_after: deduction.total_remaining_after,
        },
      });
    }

    return res.status(400).json({
      error: `Unsupported action: ${action}`,
      summary: "",
    });
  } catch (error) {
    console.error("bergie error:", error);

    return res.status(500).json({
      summary: "",
      error: "Failed to process request",
      details: error?.message || "Unknown error",
    });
  }
};
