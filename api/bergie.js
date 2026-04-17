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
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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

async function appendInventoryLogs(rows) {
  const spreadsheetId = process.env.BERGIE_SPREADSHEET_ID;
  const tabName = process.env.BERGIE_INVENTORY_LOG_TAB || "Inventory_Log";

  if (!spreadsheetId) {
    console.warn("BERGIE_SPREADSHEET_ID missing; skipping sheet append.");
    return;
  }

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A:G`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
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

    const clientId = clean(args.client_id || body.client_id || "default");
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

        const record = {
          species: entrySpecies,
          species_key: entrySpeciesKey,
          quantity_lbs: entryQuantityLbs,
          price_per_pound: entryPricePerPound,
          port: entryPort,
          status: entryStatus,
          updated_at: nowTimestamp(),
          seller_name: sellerName,
        };

        await kv.set(inventoryKey, record);

        results.push({
          ok: true,
          species: entrySpecies,
          species_key: entrySpeciesKey,
          quantity_lbs: entryQuantityLbs,
          price_per_pound: entryPricePerPound,
          port: entryPort,
          status: entryStatus,
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
        await appendInventoryLogs(successfulRows);
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

      const inventoryKey = getInventoryKey(clientId, speciesKey);

      const record = {
        species,
        species_key: speciesKey,
        quantity_lbs: quantityLbs,
        price_per_pound: pricePerPound,
        updated_at: nowTimestamp(),
      };

      await kv.set(inventoryKey, record);

      await appendInventoryLogs([
        [nowTimestamp(), clientId, species, quantityLbs, pricePerPound, "", sellerName],
      ]);

      return res.status(200).json({
        ok: true,
        action: "set_inventory",
        summary: `${species} inventory updated to ${quantityLbs} lbs at ${pricePerPound} per pound.`,
        data: record,
      });
    }

    if (action === "check_inventory") {
      const inventory =
        (await kv.get(getInventoryKey(clientId, speciesKey))) || {};

      return res.status(200).json({
        ok: true,
        action: "check_inventory",
        data: {
          species,
          total_available_lbs: safeNumber(inventory.quantity_lbs),
          price_per_pound: safeNumber(inventory.price_per_pound),
        },
      });
    }

    if (action === "place_order") {
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
          summary: "Inventory busy, try again",
        });
      }

      try {
        const inventory = (await kv.get(inventoryKey)) || {};
        const available = safeNumber(inventory.quantity_lbs);

        if (available < quantityLbs) {
          return res.status(200).json({
            summary: "Not enough inventory",
            data: {
              available_quantity_lbs: available,
              inventory_status: available > 0 ? "partial" : "none",
              insufficient_inventory: true,
            },
          });
        }

        const remaining = available - quantityLbs;

        await kv.set(inventoryKey, {
          ...inventory,
          quantity_lbs: remaining,
        });

        const order = {
          order_id: makeId("order"),
          buyer_name: buyerName,
          species,
          quantity_lbs: quantityLbs,
          shipping_destination: shippingDestination,
          seller_name: sellerName,
          created_at: nowTimestamp(),
        };

        await kv.set(getOrderKey(clientId, order.order_id), order);

        const response = {
          summary: "Order placed",
          data: {
            ...order,
            remaining_inventory_lbs: remaining,
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

    return res.status(400).json({ error: "Invalid action" });
  } catch (error) {
    console.error("bergie error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};
