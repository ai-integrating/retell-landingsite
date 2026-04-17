const crypto = require("crypto");

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
        {
          owner_id: ownerId,
          acquired_at: nowTimestamp(),
        },
        { ex: LOCK_TTL_SECONDS }
      );

      const confirm = await kv.get(lockKey);
      if (confirm?.owner_id === ownerId) {
        return true;
      }
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
    console.warn("bergie: failed to release lock", error?.message || error);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
      summary: "",
    });
  }

  try {
    const kv = getKvClient();
    const body = req.body || {};
    const args = getArgs(body);
    const action = clean(args.action || body.action).toLowerCase();

    const clientId = clean(args.client_id || body.client_id || "default");
    const species = clean(args.species || body.species);
    const speciesKey = normalizeKey(species);
    const buyerName = clean(args.buyer_name || body.buyer_name);
    const sellerName = clean(args.seller_name || body.seller_name);
    const shippingDestination = clean(
      args.shipping_destination || body.shipping_destination
    );
    const quantityLbs = safeNumber(args.quantity_lbs || body.quantity_lbs);

    if (action === "check_inventory") {
      if (!speciesKey) {
        return res.status(200).json({
          ok: false,
          action: "check_inventory",
          summary: "Please provide the seafood item to check inventory.",
          execution_message: "One moment while I check inventory.",
          data: {
            species: species || "",
            total_available_lbs: 0,
          },
        });
      }

      const inventory =
        (await kv.get(getInventoryKey(clientId, speciesKey))) || {};
      const available = safeNumber(inventory.quantity_lbs);
      const price = safeNumber(inventory.price_per_pound);

      if (available <= 0) {
        return res.status(200).json({
          ok: true,
          action: "check_inventory",
          summary: `${species} is not currently available in live inventory.`,
          execution_message: "One moment while I check inventory.",
          data: {
            species,
            total_available_lbs: 0,
            price_per_pound: price,
            inventory_status: "none",
          },
        });
      }

      return res.status(200).json({
        ok: true,
        action: "check_inventory",
        summary: `${species} is available for sale. There are ${available} pounds available starting at ${price} per pound.`,
        execution_message: "One moment while I check inventory.",
        data: {
          species,
          total_available_lbs: available,
          price_per_pound: price,
          inventory_status: "available",
        },
      });
    }

    if (action === "place_order") {
      if (!species || !buyerName || !quantityLbs || !shippingDestination) {
        return res.status(200).json({
          ok: false,
          action: "place_order",
          summary:
            "To place the order, I still need the buyer name, seafood item, quantity in pounds, and shipping destination.",
          execution_message: "One moment while I log this order.",
        });
      }

      if (quantityLbs <= 0) {
        return res.status(200).json({
          ok: false,
          action: "place_order",
          summary: "The quantity needs to be a valid number greater than zero.",
          execution_message: "One moment while I log this order.",
        });
      }

      const requestIdempotencyKey = parseIdempotencyKey(args, body);
      if (requestIdempotencyKey) {
        const idemKey = getOrderIdempotencyKey(clientId, requestIdempotencyKey);
        const existing = await kv.get(idemKey);

        if (existing?.status === "completed" && existing?.response) {
          return res.status(existing.status_code || 200).json({
            ...existing.response,
            idempotent_replay: true,
            idempotency_key: requestIdempotencyKey,
          });
        }

        if (existing?.status === "processing") {
          return res.status(200).json({
            ok: true,
            action: "place_order",
            summary: "This order request is already being processed.",
            execution_message: "One moment while I log this order.",
            idempotent_replay: true,
            idempotency_key: requestIdempotencyKey,
          });
        }

        await kv.set(
          idemKey,
          {
            status: "processing",
            started_at: nowTimestamp(),
          },
          { ex: IDEMPOTENCY_TTL_SECONDS }
        );
      }

      const inventoryKey = getInventoryKey(clientId, speciesKey);
      const lockKey = getInventoryLockKey(clientId, speciesKey);
      const lockOwnerId = makeId("lock");

      const lockAcquired = await acquireLock(kv, lockKey, lockOwnerId);

      if (!lockAcquired) {
        return res.status(200).json({
          ok: false,
          action: "place_order",
          summary:
            "That item is being updated right now. Please resubmit the order in a moment.",
          execution_message: "One moment while I log this order.",
          data: {
            inventory_status: "busy",
          },
        });
      }

      try {
        const currentInventory = (await kv.get(inventoryKey)) || {
          species,
          quantity_lbs: 0,
          price_per_pound: 0,
        };

        const available = safeNumber(currentInventory.quantity_lbs);

        if (available < quantityLbs) {
          const summary =
            available > 0
              ? `There are only ${available} pounds of ${species} left. Would you like me to place the order for ${available} pounds instead?`
              : `There is no ${species} left right now, so I could not log an order for ${quantityLbs} pounds.`;

          const responsePayload = {
            ok: true,
            action: "place_order",
            summary,
            execution_message: "One moment while I log this order.",
            data: {
              inventory_status: available > 0 ? "partial" : "none",
              insufficient_inventory: true,
              partial_inventory_available: available > 0,
              requested_quantity_lbs: quantityLbs,
              available_quantity_lbs: available,
              suggested_quantity_lbs: available > 0 ? available : 0,
              remaining_inventory_lbs: available,
            },
          };

          if (requestIdempotencyKey) {
            await kv.set(
              getOrderIdempotencyKey(clientId, requestIdempotencyKey),
              {
                status: "completed",
                status_code: 200,
                response: responsePayload,
                completed_at: nowTimestamp(),
              },
              { ex: IDEMPOTENCY_TTL_SECONDS }
            );
          }

          return res.status(200).json(responsePayload);
        }

        const pricePerPound = safeNumber(currentInventory.price_per_pound);
        const totalPrice = Number((quantityLbs * pricePerPound).toFixed(2));
        const remainingInventory = Number((available - quantityLbs).toFixed(2));

        const order = {
          order_id: makeId("order"),
          timestamp: nowTimestamp(),
          buyer_name: buyerName,
          seller_name: sellerName,
          species,
          species_key: speciesKey,
          quantity_lbs: quantityLbs,
          average_price_per_pound: pricePerPound,
          total_price: totalPrice,
          shipping_destination: shippingDestination,
          status: "Pending",
        };

        await kv.set(getOrderKey(clientId, order.order_id), order);

        await kv.set(inventoryKey, {
          ...currentInventory,
          species,
          quantity_lbs: remainingInventory,
          updated_at: nowTimestamp(),
          last_order_id: order.order_id,
        });

        const responsePayload = {
          ok: true,
          action: "place_order",
          summary: `The order has been logged for ${buyerName}: ${quantityLbs} pounds of ${species}, average price ${pricePerPound} per pound, total ${totalPrice}, shipping to ${shippingDestination}. Status is Pending. ${remainingInventory} pounds remain in inventory.`,
          execution_message: "One moment while I log this order.",
          data: {
            ...order,
            inventory_status: "fulfilled",
            insufficient_inventory: false,
            partial_inventory_available: false,
            remaining_inventory_lbs: remainingInventory,
          },
        };

        if (requestIdempotencyKey) {
          await kv.set(
            getOrderIdempotencyKey(clientId, requestIdempotencyKey),
            {
              status: "completed",
              status_code: 200,
              response: responsePayload,
              completed_at: nowTimestamp(),
            },
            { ex: IDEMPOTENCY_TTL_SECONDS }
          );
        }

        return res.status(200).json(responsePayload);
      } finally {
        await releaseLock(kv, lockKey, lockOwnerId);
      }
    }

    return res.status(400).json({
      error: `Unsupported action: ${action || "(missing)"}`,
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
