// /api/bergie.js
const { kv } = require("@vercel/kv");
const { google } = require("googleapis");
const crypto = require("crypto");

const DEFAULT_SUMMARY_TAB_NAME =
  process.env.DAILY_SUMMARY_TAB_NAME || "Call Summaries";

const MAX_ROWS_TO_READ = Number(process.env.DAILY_SUMMARY_MAX_ROWS || 25);
const LOCK_TTL_SECONDS = Number(process.env.BERGIE_LOCK_TTL_SECONDS || 8);
const IDEMPOTENCY_TTL_SECONDS = Number(
  process.env.BERGIE_IDEMPOTENCY_TTL_SECONDS || 60 * 60 * 24
);
const IDEMPOTENCY_SCHEMA_VERSION =
  process.env.BERGIE_IDEMPOTENCY_SCHEMA_VERSION || "v2";

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
@@ -125,64 +130,96 @@ function nowTimestamp() {
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

function getOrderIdempotencyKey(clientId, requestKey) {
  return `bergie:client:${clientId}:order:idempotency:${IDEMPOTENCY_SCHEMA_VERSION}:${requestKey}`;
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

function buildOrderIdempotencySignature(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function formatAvailableInventoryText(inventory = []) {
  if (!Array.isArray(inventory) || !inventory.length) return "None";
  return inventory
    .map((item) => `${item.species}: ${item.quantity_lbs} lbs`)
    .join("\n");
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
@@ -451,50 +488,80 @@ async function releaseLock(lockKey, token) {
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

async function getSellableInventorySummary(clientId, limit = 10) {
  const lots = await getAllInventoryLots(clientId);
  const totalsBySpeciesKey = new Map();

  for (const lot of lots) {
    if (lot.active === false) continue;
    const remaining = safeNumber(lot.remaining_quantity_lbs);
    if (remaining <= 0) continue;

    const speciesKey = normalizeKey(lot.species);
    if (!speciesKey) continue;

    const existing = totalsBySpeciesKey.get(speciesKey) || {
      species: lot.species,
      quantity_lbs: 0,
    };

    existing.quantity_lbs += remaining;
    totalsBySpeciesKey.set(speciesKey, existing);
  }

  return Array.from(totalsBySpeciesKey.values())
    .map((item) => ({
      species: item.species,
      quantity_lbs: Number(item.quantity_lbs.toFixed(2)),
    }))
    .sort((a, b) => b.quantity_lbs - a.quantity_lbs)
    .slice(0, limit);
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
@@ -823,146 +890,331 @@ module.exports = async function handler(req, res) {
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
      const idempotencyKey = parseIdempotencyKey(args, body);
      const idempotencyKvKey = idempotencyKey
        ? getOrderIdempotencyKey(clientId, idempotencyKey)
        : null;
      const idempotencyToken = idempotencyKey ? makeId("idem") : null;
      const idempotencySignature = buildOrderIdempotencySignature({
        action,
        buyer_name: buyerName,
        seller_name: sellerName,
        species,
        quantity_lbs: quantityLbs,
        shipping_destination: shippingDestination,
        notes,
      });

      if (quantityLbs <= 0) {
        return res.status(200).json({
          summary: "The quantity needs to be a valid number greater than zero.",
          execution_message: "One moment while I log this order.",
        });
      }
      const sendPlaceOrderResponse = async (statusCode, payload, options = {}) => {
        const shouldPersist = options.persist !== false;

        if (idempotencyKvKey && shouldPersist) {
          await kv.set(
            idempotencyKvKey,
            {
              state: "completed",
              status_code: statusCode,
              response: payload,
              signature: idempotencySignature,
              completed_at: nowTimestamp(),
            },
            { ex: IDEMPOTENCY_TTL_SECONDS }
          );
        }

        return res.status(statusCode).json(payload);
      };

      const availableLots = await getAvailableInventoryForSpecies(clientId, species);
      if (!availableLots.length) {
        return res.status(200).json({
          summary: `I could not place the order because ${species} is not available in live inventory.`,
          execution_message: "One moment while I log this order.",
          debug: { clientId, sheetId, species },
        });
      if (idempotencyKvKey) {
        const claimed = await kv.set(
          idempotencyKvKey,
          {
            state: "processing",
            token: idempotencyToken,
            signature: idempotencySignature,
            created_at: nowTimestamp(),
          },
          {
            nx: true,
            ex: IDEMPOTENCY_TTL_SECONDS,
          }
        );

        if (!(claimed === "OK" || claimed === true)) {
          let existing = await kv.get(idempotencyKvKey);

          if (
            existing?.signature &&
            existing.signature !== idempotencySignature
          ) {
            return res.status(409).json({
              summary:
                "This idempotency key was already used for a different order request.",
              execution_message: "One moment while I log this order.",
              idempotency_key: idempotencyKey,
            });
          }

          if (existing?.state === "processing") {
            for (let i = 0; i < 10; i += 1) {
              await sleep(120);
              existing = await kv.get(idempotencyKvKey);
              if (existing?.state === "completed") break;
            }
          }

          if (existing?.state === "completed" && existing.response) {
            const replayResponse = { ...existing.response };

            const needsInventoryBackfill = !Array.isArray(
              replayResponse?.data?.available_inventory
            );
            const needsInventoryTextBackfill =
              !replayResponse.available_inventory_text ||
              typeof replayResponse.available_inventory_text !== "string";

            if (needsInventoryBackfill || needsInventoryTextBackfill) {
              const availableInventory = await getSellableInventorySummary(clientId);
              replayResponse.data = {
                ...(replayResponse.data || {}),
                available_inventory: availableInventory,
              };
              replayResponse.available_inventory = availableInventory;
              replayResponse.available_inventory_count = availableInventory.length;
              replayResponse.available_inventory_text =
                formatAvailableInventoryText(availableInventory);

              await kv.set(
                idempotencyKvKey,
                {
                  ...existing,
                  state: "completed",
                  response: replayResponse,
                  completed_at: nowTimestamp(),
                },
                { ex: IDEMPOTENCY_TTL_SECONDS }
              );
            }

            return res.status(existing.status_code || 200).json({
              ...replayResponse,
              idempotent_replay: true,
              idempotency_key: idempotencyKey,
            });
          }

          return res.status(409).json({
            summary:
              "This order request is already being processed. Please wait a moment and retry.",
            execution_message: "One moment while I log this order.",
            idempotency_key: idempotencyKey,
          });
        }
      }

      const speciesName = availableLots[0].species;

      const deduction = await deductInventory(clientId, species, quantityLbs);
      try {
        if (!species || !buyerName || !quantityLbs || !shippingDestination) {
          return sendPlaceOrderResponse(200, {
            summary:
              "To place the order, I still need the buyer name, seafood item, quantity in pounds, and shipping destination.",
            execution_message: "One moment while I log this order.",
          });
        }

      if (!deduction.ok) {
        return res.status(200).json({
          summary: `There are only ${deduction.total_available} pounds of ${speciesName} available, so I could not log an order for ${quantityLbs} pounds.`,
        if (quantityLbs <= 0) {
          return sendPlaceOrderResponse(200, {
            summary: "The quantity needs to be a valid number greater than zero.",
            execution_message: "One moment while I log this order.",
          });
        }

        const availableLots = await getAvailableInventoryForSpecies(clientId, species);
        if (!availableLots.length) {
          const availableInventory = await getSellableInventorySummary(clientId);
          return sendPlaceOrderResponse(200, {
            summary: `I could not place the order because ${species} is not available in live inventory.`,
            execution_message: "One moment while I log this order.",
            available_inventory: availableInventory,
            available_inventory_count: availableInventory.length,
            available_inventory_text:
              formatAvailableInventoryText(availableInventory),
            data: {
              inventory_status: "none",
              insufficient_inventory: true,
              partial_inventory_available: false,
              requested_quantity_lbs: quantityLbs,
              available_quantity_lbs: 0,
              suggested_quantity_lbs: 0,
              suggested_follow_up_action: "check_other_inventory",
              available_inventory: availableInventory,
            },
            debug: { clientId, sheetId, species },
          });
        }

        const speciesName = availableLots[0].species;

        const deduction = await deductInventory(clientId, species, quantityLbs);

        if (!deduction.ok) {
          const remainingLbs = Number(deduction.total_available || 0);
          const hasRemainder = remainingLbs > 0;
          const availableInventory = await getSellableInventorySummary(clientId);
          const summary = hasRemainder
            ? `There are only ${remainingLbs} pounds of ${speciesName} left. Would you like me to place the order for ${remainingLbs} pounds instead?`
            : `There is no ${speciesName} left right now, so I could not log an order for ${quantityLbs} pounds.`;

          return sendPlaceOrderResponse(200, {
            summary,
            execution_message: "One moment while I log this order.",
            available_inventory: availableInventory,
            available_inventory_count: availableInventory.length,
            available_inventory_text:
              formatAvailableInventoryText(availableInventory),
            data: {
              inventory_status: hasRemainder ? "partial" : "none",
              insufficient_inventory: true,
              partial_inventory_available: hasRemainder,
              requested_quantity_lbs: quantityLbs,
              available_quantity_lbs: remainingLbs,
              suggested_quantity_lbs: hasRemainder ? remainingLbs : 0,
              suggested_follow_up_action: hasRemainder
                ? "offer_available_quantity"
                : "check_other_inventory",
              available_inventory: availableInventory,
            },
            debug: {
              clientId,
              sheetId,
              species,
              requested_quantity_lbs: quantityLbs,
              available_quantity_lbs: remainingLbs,
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
        const availableInventory = await getSellableInventorySummary(clientId);

        return sendPlaceOrderResponse(200, {
          summary: `The order has been logged for ${buyerName}: ${quantityLbs} pounds of ${speciesName}, average price ${avgPrice} per pound, total ${order.total_price}, shipping to ${shippingDestination}. Status is Pending.`,
          execution_message: "One moment while I log this order.",
          available_inventory: availableInventory,
          available_inventory_count: availableInventory.length,
          available_inventory_text: formatAvailableInventoryText(availableInventory),
          data: {
            ...order,
            inventory_status: "fulfilled",
            insufficient_inventory: false,
            partial_inventory_available: false,
            requested_quantity_lbs: quantityLbs,
            available_quantity_lbs: quantityLbs,
            suggested_quantity_lbs: quantityLbs,
            available_inventory: availableInventory,
          },
          debug: {
            clientId,
            sheetId,
            species,
            available: deduction.total_available,
            deducted_from_lots: deduction.used_lots,
            total_remaining_after: deduction.total_remaining_after,
          },
        });
      } catch (placeOrderError) {
        if (idempotencyKvKey && idempotencyToken) {
          const state = await kv.get(idempotencyKvKey);
          if (state?.state === "processing" && state?.token === idempotencyToken) {
            await kv.del(idempotencyKvKey);
          }
        }

        throw placeOrderError;
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
