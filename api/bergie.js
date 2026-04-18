const crypto = require("crypto");
const { google } = require("googleapis");

const IDEMPOTENCY_TTL_SECONDS = Number(
  process.env.BERGIE_IDEMPOTENCY_TTL_SECONDS || 60 * 60 * 24
);

const LOCK_TTL_SECONDS = Number(
  process.env.BERGIE_LOCK_TTL_SECONDS || 15
);

const LOCK_WAIT_MS = Number(
  process.env.BERGIE_LOCK_WAIT_MS || 2500
);

const LOCK_RETRY_MS = Number(
  process.env.BERGIE_LOCK_RETRY_MS || 120
);

const IDEMPOTENCY_SCHEMA_VERSION =
  process.env.BERGIE_IDEMPOTENCY_SCHEMA_VERSION || "v3";

let cachedKvClient = null;
const inMemoryKvStore = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getKvClient() {
  if (cachedKvClient) return cachedKvClient;

  try {
    const { kv } = require("@vercel/kv");
    cachedKvClient = kv;
  } catch (error) {
    console.warn(
      "bergie: @vercel/kv not available, using temporary in-memory KV fallback."
    );

    cachedKvClient = {
      async get(key) {
        return inMemoryKvStore.has(key) ? inMemoryKvStore.get(key) : null;
      },
      async set(key, value, options = {}) {
        inMemoryKvStore.set(key, value);

        if (options?.ex) {
          setTimeout(() => {
            inMemoryKvStore.delete(key);
          }, options.ex * 1000).unref?.();
        }

        return "OK";
      },
      async del(key) {
        inMemoryKvStore.delete(key);
        return 1;
      },
    };
  }

  return cachedKvClient;
}

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^_+|_+$/g, "");
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeSheetValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value).trim();
}

function nowTimestamp() {
  return new Date().toISOString();
}

function makeId(prefix = "id") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function getInventoryKey(clientId, speciesKey) {
  return `bergie:client:${clientId}:inventory:${speciesKey}`;
}

function getInventoryLockKey(clientId, speciesKey) {
  return `bergie:client:${clientId}:inventory_lock:${speciesKey}`;
}

function getOrderKey(clientId, orderId) {
  return `bergie:client:${clientId}:order:${orderId}`;
}

function getOrderIdempotencyKey(clientId, requestKey) {
  return `bergie:client:${clientId}:order:idempotency:${IDEMPOTENCY_SCHEMA_VERSION}:${requestKey}`;
}

function parseIdempotencyKey(args, body) {
  return (
    clean(args.idempotency_key) ||
    clean(body.args_idempotency_key) ||
    clean(body.idempotency_key) ||
    clean(args.jotform_submission_id) ||
    clean(body.args_jotform_submission_id) ||
    clean(body.jotform_submission_id) ||
    clean(args.zap_run_id) ||
    clean(body.args_zap_run_id) ||
    clean(body.zap_run_id)
  );
}

function getArgs(reqBody) {
  if (!reqBody || typeof reqBody !== "object") return {};
  const args = reqBody.args;
  if (args && typeof args === "object") return args;
  return reqBody;
}

async function resolveClientId(kv, clientId, agentId) {
  const directClientId = clean(clientId);
  if (directClientId) return directClientId;

  const mappedClientId = clean(
    agentId ? await kv.get(`agent:${agentId}:client`) : ""
  );
  if (mappedClientId) return mappedClientId;

  return "default";
}

async function acquireLock(kv, lockKey, ownerId) {
  const started = Date.now();

  while (Date.now() - started < LOCK_WAIT_MS) {
    const existing = await kv.get(lockKey);

    if (!existing) {
      await kv.set(
        lockKey,
        { owner_id: ownerId, acquired_at: nowTimestamp() },
        { ex: LOCK_TTL_SECONDS }
      );

      const confirm = await kv.get(lockKey);
      if (confirm?.owner_id === ownerId) return true;
    }

    await sleep(LOCK_RETRY_MS);
  }

  return false;
}

async function releaseLock(kv, lockKey, ownerId) {
  try {
    const current = await kv.get(lockKey);
    if (current?.owner_id === ownerId) {
      await kv.del(lockKey);
    }
  } catch (error) {
    console.warn("failed to release lock", error);
  }
}

function getGoogleAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getClientSheetConfig(kv, clientId, agentId) {
  const resolvedClientId = await resolveClientId(kv, clientId, agentId);

  let raw =
    (await kv.get(`client:${resolvedClientId}:sheet`)) ||
    (await kv.get(`client:${resolvedClientId}:config`));

  if (!raw) return null;

  if (typeof raw === "string") {
    const trimmed = raw.trim();

    if (trimmed.startsWith("{")) {
      try {
        raw = JSON.parse(trimmed);
      } catch (error) {
        console.error("Invalid JSON in client sheet config:", {
          clientId: resolvedClientId,
          raw,
        });
        return null;
      }
    } else {
      return {
        clientId: resolvedClientId,
        spreadsheetId: trimmed,
        inventoryLogTab: "Inventory_Log",
        liveInventoryTab: "Live Inventory",
      };
    }
  }

  return {
    clientId: resolvedClientId,
    spreadsheetId: clean(raw.spreadsheet_id || raw.sheet_id),
    inventoryLogTab: clean(raw.inventory_log_tab || "Inventory_Log"),
    liveInventoryTab: clean(raw.live_inventory_tab || "Live Inventory"),
  };
}

async function appendInventoryLogs(kv, { clientId, agentId, rows }) {
  const cfg = await getClientSheetConfig(kv, clientId, agentId);

  if (!cfg?.spreadsheetId) {
    console.warn("No spreadsheet config found for client/agent", {
      clientId,
      agentId,
    });
    return;
  }

  const safeRows = (rows || []).map((row) =>
    (row || []).map((cell) => safeSheetValue(cell))
  );

  if (!safeRows.length) return;

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  console.log("appendInventoryLogs config:", cfg);
  console.log("appendInventoryLogs rows:", safeRows);

  await sheets.spreadsheets.values.append({
    spreadsheetId: cfg.spreadsheetId,
    // UPDATED: Using sheet name only for more reliable appending
    range: cfg.inventoryLogTab,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: safeRows,
    },
  });
}

async function appendLiveInventoryLot(kv, { clientId, agentId, lot }) {
  const cfg = await getClientSheetConfig(kv, clientId, agentId);

  if (!cfg?.spreadsheetId) {
    console.warn("No spreadsheet config found for live inventory append", {
      clientId,
      agentId,
    });
    return;
  }

  const row = [[
    safeSheetValue(lot.id),
    safeSheetValue(lot.species),
    safeSheetValue(lot.species_key),
    safeNumber(lot.price_per_pound),
    safeNumber(lot.starting_quantity_lbs),
    safeNumber(lot.quantity_lbs),
    safeNumber(lot.quantity_lbs) > 0 ? "Yes" : "No",
    safeSheetValue(lot.port),
    safeSheetValue(lot.status || "Fresh"),
    safeSheetValue(lot.updated_at || lot.created_at || nowTimestamp()),
  ]];

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  console.log("appendLiveInventoryLot config:", cfg);
  console.log("appendLiveInventoryLot row:", row);

  await sheets.spreadsheets.values.append({
    spreadsheetId: cfg.spreadsheetId,
    // UPDATED: Using sheet name only for more reliable appending
    range: cfg.liveInventoryTab,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: row,
    },
  });
}

async function updateLiveInventoryRowsById(kv, { clientId, agentId, lots }) {
  if (!Array.isArray(lots) || !lots.length) return;

  const cfg = await getClientSheetConfig(kv, clientId, agentId);

  if (!cfg?.spreadsheetId) {
    console.warn("No spreadsheet config found for live inventory update", {
      clientId,
      agentId,
    });
    return;
  }

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId: cfg.spreadsheetId,
    range: `${cfg.liveInventoryTab}!A:J`,
  });

  const rows = getRes.data.values || [];
  if (!rows.length) return;

  const rowMap = new Map();
  for (let i = 1; i < rows.length; i++) {
    const rowId = clean(rows[i][0]);
    if (rowId) rowMap.set(rowId, i + 1);
  }

  for (const lot of lots) {
    const sheetRow = rowMap.get(clean(lot.id));
    if (!sheetRow) continue;

    const updateRow = [[
      safeNumber(lot.quantity_lbs),
      safeNumber(lot.quantity_lbs) > 0 ? "Yes" : "No",
      safeSheetValue(lot.port),
      safeSheetValue(lot.status || "Fresh"),
      safeSheetValue(lot.updated_at || nowTimestamp()),
    ]];

    console.log("updateLiveInventoryRowsById config:", cfg);
    console.log("updateLiveInventoryRowsById row:", {
      sheetRow,
      values: updateRow,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: cfg.spreadsheetId,
      range: `${cfg.liveInventoryTab}!F${sheetRow}:J${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: updateRow,
      },
    });
  }
}

function ensureLotsArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return [
    {
      id: clean(value.id) || makeId("lot"),
      species: clean(value.species),
      species_key: clean(value.species_key),
      quantity_lbs: safeNumber(value.quantity_lbs),
      starting_quantity_lbs: safeNumber(
        value.starting_quantity_lbs || value.quantity_lbs
      ),
      price_per_pound: safeNumber(value.price_per_pound),
      port: clean(value.port),
      status: clean(value.status),
      created_at: clean(value.created_at) || nowTimestamp(),
      updated_at: clean(value.updated_at) || nowTimestamp(),
      seller_name: clean(value.seller_name),
    },
  ];
}

function summarizeLots(lots) {
  const safeLots = ensureLotsArray(lots);
  return {
    total_available_lbs: safeLots.reduce(
      (sum, lot) => sum + safeNumber(lot.quantity_lbs),
      0
    ),
    lots_count: safeLots.length,
    price_per_pound:
      safeLots.length === 1 ? safeNumber(safeLots[0].price_per_pound) : 0,
    port: safeLots.length === 1 ? clean(safeLots[0].port) : "",
    status: safeLots.length === 1 ? clean(safeLots[0].status) : "",
    updated_at:
      safeLots.length > 0
        ? safeLots
            .map((lot) => clean(lot.updated_at || lot.created_at))
            .sort()
            .slice(-1)[0]
        : "",
  };
}

module.exports = async function handler(req, res) {
  console.log("RAW BODY:", req.body);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const kv = getKvClient();
    const body = req.body || {};
    const args = getArgs(body);
    const action = clean(args.action || body.action).toLowerCase();

    if (!action) {
      console.error("Missing action field:", body);
      return res.status(400).json({ ok: false, error: "Missing action" });
    }

    const rawClientId = clean(args.client_id || body.client_id || "");
    const agentId = clean(
      args.agent_id || body.agent_id || body?.call?.agent_id || ""
    );
    const clientId = await resolveClientId(kv, rawClientId, agentId);

    const species = clean(args.species || body.species);
    const speciesKey = normalizeKey(species);
    const buyerName = clean(args.buyer_name || body.buyer_name);
    const sellerName = clean(args.seller_name || body.seller_name || "AI");
    const shippingDestination = clean(
      args.shipping_destination || body.shipping_destination
    );
    const quantityLbs = safeNumber(args.quantity_lbs || body.quantity_lbs);

    if (action === "set_inventory_bulk") {
      const rawEntries = Array.isArray(args.entries)
        ? args.entries
        : Array.isArray(body.entries)
        ? body.entries
        : [];

      if (!rawEntries.length) {
        return res.status(200).json({
          ok: false,
          action: "set_inventory_bulk",
          summary: "No inventory entries were provided.",
          data: { updated_count: 0 },
        });
      }

      const results = [];

      for (const entry of rawEntries) {
        const entrySpecies = clean(entry?.species);
        const entrySpeciesKey = normalizeKey(entrySpecies);
        const entryQuantityLbs = safeNumber(entry?.quantity_lbs);
        const entryPricePerPound = safeNumber(entry?.price_per_pound);
        const entryPort = clean(entry?.port);
        const entryStatus = clean(entry?.status);

        if (!entrySpeciesKey) {
          results.push({
            ok: false,
            species: entrySpecies || "",
            summary: "Skipped entry with missing species.",
          });
          continue;
        }

        const inventoryKey = getInventoryKey(clientId, entrySpeciesKey);
        const existingLots = ensureLotsArray(await kv.get(inventoryKey));

        const lot = {
          id: makeId("lot"),
          species: entrySpecies,
          species_key: entrySpeciesKey,
          quantity_lbs: entryQuantityLbs,
          starting_quantity_lbs: entryQuantityLbs,
          price_per_pound: entryPricePerPound,
          port: entryPort,
          status: entryStatus || "Fresh",
          created_at: nowTimestamp(),
          updated_at: nowTimestamp(),
          seller_name: sellerName,
        };

        existingLots.push(lot);
        await kv.set(inventoryKey, existingLots);

        await appendLiveInventoryLot(kv, {
          clientId,
          agentId,
          lot,
        });

        results.push({
          ok: true,
          id: lot.id,
          species: lot.species,
          species_key: lot.species_key,
          quantity_lbs: lot.quantity_lbs,
          price_per_pound: lot.price_per_pound,
          port: lot.port,
          status: lot.status,
        });
      }

      const updatedCount = results.filter((r) => r.ok).length;
      const skippedCount = results.length - updatedCount;

      const successfulRows = results
        .filter((r) => r.ok)
        .map((r) => [
          nowTimestamp(),
          clientId,
          r.species,
          r.quantity_lbs,
          r.price_per_pound,
          r.port || "",
          sellerName,
        ]);

      if (successfulRows.length) {
        await appendInventoryLogs(kv, {
          clientId,
          agentId,
          rows: successfulRows,
        });
      }

      return res.status(200).json({
        ok: true,
        action: "set_inventory_bulk",
        summary: `Processed ${results.length} inventory entries. Updated ${updatedCount}. Skipped ${skippedCount}.`,
        data: {
          updated_count: updatedCount,
          skipped_count: skippedCount,
          results,
        },
      });
    }

    if (action === "set_inventory") {
      if (!speciesKey) {
        return res.status(200).json({
          ok: false,
          action: "set_inventory",
          summary: "Missing species.",
        });
      }

      const pricePerPound = safeNumber(
        args.price_per_pound || body.price_per_pound
      );
      const port = clean(args.port || body.port);
      const status = clean(args.status || body.status);

      const inventoryKey = getInventoryKey(clientId, speciesKey);
      const existingLots = ensureLotsArray(await kv.get(inventoryKey));

      const lot = {
        id: makeId("lot"),
        species,
        species_key: speciesKey,
        quantity_lbs: quantityLbs,
        starting_quantity_lbs: quantityLbs,
        price_per_pound: pricePerPound,
        port,
        status: status || "Fresh",
        created_at: nowTimestamp(),
        updated_at: nowTimestamp(),
        seller_name: sellerName,
      };

      existingLots.push(lot);
      await kv.set(inventoryKey, existingLots);

      await appendLiveInventoryLot(kv, {
        clientId,
        agentId,
        lot,
      });

      await appendInventoryLogs(kv, {
        clientId,
        agentId,
        rows: [
          [
            nowTimestamp(),
            clientId,
            species,
            quantityLbs,
            pricePerPound,
            port,
            sellerName,
          ],
        ],
      });

      return res.status(200).json({
        ok: true,
        action: "set_inventory",
        summary: `${species} inventory lot added: ${quantityLbs} lbs at ${pricePerPound} per pound.`,
        data: lot,
      });
    }

    if (action === "check_inventory") {
      if (!speciesKey) {
        return res.status(200).json({
          ok: false,
          action: "check_inventory",
          summary: "Missing species.",
          data: {
            species,
            total_available_lbs: 0,
            price_per_pound: 0,
            lots_count: 0,
          },
        });
      }

      const lots = ensureLotsArray(
        await kv.get(getInventoryKey(clientId, speciesKey))
      );
      const summary = summarizeLots(lots);

      return res.status(200).json({
        ok: true,
        action: "check_inventory",
        data: {
          species,
          ...summary,
        },
      });
    }

    if (action === "place_order") {
      if (!speciesKey) {
        return res.status(200).json({
          ok: false,
          action: "place_order",
          summary: "Missing species.",
        });
      }

      if (!buyerName) {
        return res.status(200).json({
          ok: false,
          action: "place_order",
          summary: "Missing buyer name.",
        });
      }

      if (!shippingDestination) {
        return res.status(200).json({
          ok: false,
          action: "place_order",
          summary: "Missing shipping destination.",
        });
      }

      if (!quantityLbs || quantityLbs <= 0) {
        return res.status(200).json({
          ok: false,
          action: "place_order",
          summary: "Missing or invalid quantity.",
        });
      }

      const requestIdempotencyKey = parseIdempotencyKey(args, body);

      if (requestIdempotencyKey) {
        const idemKey = getOrderIdempotencyKey(clientId, requestIdempotencyKey);
        const existing = await kv.get(idemKey);

        if (existing?.response) {
          return res.status(200).json(existing.response);
        }
      }

      const inventoryKey = getInventoryKey(clientId, speciesKey);
      const lockKey = getInventoryLockKey(clientId, speciesKey);
      const lockId = makeId("lock");

      const locked = await acquireLock(kv, lockKey, lockId);

      if (!locked) {
        return res.status(200).json({
          ok: false,
          action: "place_order",
          summary: "Inventory busy, try again",
        });
      }

      try {
        const lots = ensureLotsArray(await kv.get(inventoryKey)).sort((a, b) => {
          const aTime = new Date(a.created_at || 0).getTime();
          const bTime = new Date(b.created_at || 0).getTime();
          return aTime - bTime;
        });

        const totalAvailable = lots.reduce(
          (sum, lot) => sum + safeNumber(lot.quantity_lbs),
          0
        );

        if (totalAvailable < quantityLbs) {
          return res.status(200).json({
            ok: false,
            action: "place_order",
            summary: "Not enough inventory",
            data: {
              available_quantity_lbs: totalAvailable,
              requested_quantity_lbs: quantityLbs,
              inventory_status: totalAvailable > 0 ? "partial" : "none",
              insufficient_inventory: true,
            },
          });
        }

        let remainingToFill = quantityLbs;
        const consumedLots = [];

        for (const lot of lots) {
          if (remainingToFill <= 0) break;

          const available = safeNumber(lot.quantity_lbs);
          if (available <= 0) continue;

          const deduction = Math.min(available, remainingToFill);
          lot.quantity_lbs = available - deduction;
          lot.updated_at = nowTimestamp();

          remainingToFill -= deduction;
          consumedLots.push({
            id: lot.id,
            species: lot.species,
            species_key: lot.species_key,
            deducted_lbs: deduction,
            remaining_lbs: lot.quantity_lbs,
            price_per_pound: safeNumber(lot.price_per_pound),
          });
        }

        await kv.set(inventoryKey, lots);

        await updateLiveInventoryRowsById(kv, {
          clientId,
          agentId,
          lots,
        });

        const remainingInventory = lots.reduce(
          (sum, lot) => sum + safeNumber(lot.quantity_lbs),
          0
        );

        const order = {
          order_id: makeId("order"),
          buyer_name: buyerName,
          species,
          species_key: speciesKey,
          quantity_lbs: quantityLbs,
          shipping_destination: shippingDestination,
          seller_name: sellerName,
          client_id: clientId,
          agent_id: agentId,
          created_at: nowTimestamp(),
          fulfilled_from_lots: consumedLots,
        };

        await kv.set(getOrderKey(clientId, order.order_id), order);

        const response = {
          ok: true,
          action: "place_order",
          summary: "Order placed",
          data: {
            ...order,
            remaining_inventory_lbs: remainingInventory,
            inventory_status: "fulfilled",
          },
        };

        if (requestIdempotencyKey) {
          await kv.set(
            getOrderIdempotencyKey(clientId, requestIdempotencyKey),
            { response },
            { ex: IDEMPOTENCY_TTL_SECONDS }
          );
        }

        return res.status(200).json(response);
      } finally {
        await releaseLock(kv, lockKey, lockId);
      }
    }

    return res.status(400).json({
      ok: false,
      error: "Invalid action",
      action,
    });
  } catch (error) {
    console.error("bergie error:", error);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: error?.message || "Unknown error",
    });
  }
};
