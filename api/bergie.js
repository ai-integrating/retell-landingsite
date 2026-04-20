const crypto = require("crypto");
const { google } = require("googleapis");

/* =======================
   ✅ FILLET YIELD (NEW)
======================= */
const FILLET_YIELD = {
  scallops: 1.0,
  cod: 0.45,
  haddock: 0.42,
  skate: 0.6,
  tuna: 0.5
};

function getYieldPercent(speciesKey) {
  return FILLET_YIELD[speciesKey] ?? 1.0;
}

/* =======================
   EXISTING CONFIG
======================= */

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

/* =======================
   HELPERS
======================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getKvClient() {
  if (cachedKvClient) return cachedKvClient;

  try {
    const { kv } = require("@vercel/kv");
    cachedKvClient = kv;
  } catch {
    cachedKvClient = {
      async get(key) {
        return inMemoryKvStore.has(key) ? inMemoryKvStore.get(key) : null;
      },
      async set(key, value) {
        inMemoryKvStore.set(key, value);
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

function clean(v) {
  return v == null ? "" : String(v).trim();
}

function normalizeKey(v) {
  return clean(v).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function safeNumber(v) {
  const n = Number(v);
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

/* =======================
   HANDLER
======================= */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const kv = getKvClient();
    const body = req.body || {};
    const args = body.args || body;

    const action = clean(args.action).toLowerCase();

    const clientId = clean(args.client_id) || "default";
    const species = clean(args.species);
    const speciesKey = normalizeKey(species);
    const quantityLbs = safeNumber(args.quantity_lbs);
    const pricePerPound = safeNumber(args.price_per_pound);

    /* =======================
       ✅ SET INVENTORY (UPDATED)
    ======================= */
    if (action === "set_inventory") {
      const yieldPercent = getYieldPercent(speciesKey);
      const sellableLbs = quantityLbs * yieldPercent;

      const lot = {
        id: makeId("lot"),
        species,
        species_key: speciesKey,

        raw_quantity_lbs: quantityLbs,
        yield_percent: yieldPercent,

        quantity_lbs: sellableLbs,
        starting_quantity_lbs: sellableLbs,

        price_per_pound: pricePerPound,
        created_at: nowTimestamp(),
      };

      const key = getInventoryKey(clientId, speciesKey);
      const existing = (await kv.get(key)) || [];

      existing.push(lot);
      await kv.set(key, existing);

      return res.json({
        ok: true,
        summary: `${species}: ${quantityLbs} lbs → ${sellableLbs} sellable`,
        data: lot,
      });
    }

    /* =======================
       ✅ SET INVENTORY BULK (UPDATED)
    ======================= */
    if (action === "set_inventory_bulk") {
      const entries = args.entries || [];

      for (const entry of entries) {
        const s = clean(entry.species);
        const sk = normalizeKey(s);
        const raw = safeNumber(entry.quantity_lbs);

        const yieldPercent = getYieldPercent(sk);
        const sellableLbs = raw * yieldPercent;

        const lot = {
          id: makeId("lot"),
          species: s,
          species_key: sk,

          raw_quantity_lbs: raw,
          yield_percent: yieldPercent,

          quantity_lbs: sellableLbs,
          starting_quantity_lbs: sellableLbs,

          price_per_pound: safeNumber(entry.price_per_pound),
          created_at: nowTimestamp(),
        };

        const key = getInventoryKey(clientId, sk);
        const existing = (await kv.get(key)) || [];

        existing.push(lot);
        await kv.set(key, existing);
      }

      return res.json({ ok: true, summary: "Bulk inventory updated" });
    }

    /* =======================
       CHECK INVENTORY
    ======================= */
    if (action === "check_inventory") {
      const lots = (await kv.get(getInventoryKey(clientId, speciesKey))) || [];

      const total = lots.reduce(
        (sum, lot) => sum + safeNumber(lot.quantity_lbs),
        0
      );

      return res.json({
        ok: true,
        species,
        total_available_lbs: total,
      });
    }

    /* =======================
       PLACE ORDER (UNCHANGED)
    ======================= */
    if (action === "place_order") {
      const key = getInventoryKey(clientId, speciesKey);
      const lots = (await kv.get(key)) || [];

      let remaining = quantityLbs;

      for (const lot of lots) {
        if (remaining <= 0) break;

        const available = safeNumber(lot.quantity_lbs);
        const deduct = Math.min(available, remaining);

        lot.quantity_lbs = available - deduct;
        remaining -= deduct;
      }

      await kv.set(key, lots);

      return res.json({
        ok: true,
        summary: "Order placed",
      });
    }

    return res.json({ ok: false, error: "Invalid action" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
