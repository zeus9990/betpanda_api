// Cloudflare Pages Function
// File location: functions/api/items.js
// Available at: https://yoursite.pages.dev/api/items
//
// Usage:
//   GET /api/items?platform=discord&start_date=2026-01-01&end_date=2026-01-31
//
//   platform     required, must be "discord" or "telegram"
//   start_date   required, format YYYY-MM-DD
//   end_date     required, format YYYY-MM-DD (inclusive)
//
// ----------------------------------------------------------------------------
// SETUP REQUIRED
// ----------------------------------------------------------------------------
// 1. Install the driver in your Pages project:
//      npm install mongodb
//
// 2. Enable Node.js compatibility for this project. Cloudflare Pages -> your
//    project -> Settings -> Functions -> Compatibility flags -> add "nodejs_compat"
//    for both Production and Preview. Compatibility date must be 2024-09-23 or later.
//
// 3. Add your MongoDB connection string as a secret env var:
//    Settings -> Environment variables -> MONGODB_URI (encrypt it)
//    Use the STANDARD (non-SRV) connection string from Atlas if you hit DNS/SRV
//    lookup issues with mongodb+srv://. Atlas gives you this as an alternate
//    format under "Connect" -> "Drivers" -> "See full connection string".
//
// 4. Set MONGODB_DATABASE and MONGODB_COLLECTION as regular env vars.
//
// 5. This is already matched to your schema: "date" is stored as a plain
//    "YYYY-MM-DD" string (not a Mongo Date type), and "platform" is a string
//    ("discord" or "telegram"). No changes needed here.
// ----------------------------------------------------------------------------

import { MongoClient } from "mongodb";

const DATE_FIELD = "date";
const VALID_PLATFORMS = ["discord", "telegram"];
const MAX_LIMIT = 500;

// Cache the client across invocations of the same warm isolate so we don't
// reconnect on every request. This is a module-level variable, so it persists
// as long as the Worker isolate stays warm (not guaranteed across all requests).
let cachedClient = null;

async function getClient(env) {
  if (cachedClient) return cachedClient;

  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  cachedClient = client;
  return client;
}

function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const platform = url.searchParams.get("platform");
    const startDate = url.searchParams.get("start_date");
    const endDate = url.searchParams.get("end_date");
    const limitParam = url.searchParams.get("limit");

    // --- Validation ---
    const errors = [];

    if (!platform || !VALID_PLATFORMS.includes(platform.toLowerCase())) {
      errors.push(`platform is required and must be one of: ${VALID_PLATFORMS.join(", ")}`);
    }
    if (!startDate || !isValidDateString(startDate)) {
      errors.push("start_date is required and must be in YYYY-MM-DD format");
    }
    if (!endDate || !isValidDateString(endDate)) {
      errors.push("end_date is required and must be in YYYY-MM-DD format");
    }
    if (startDate && endDate && isValidDateString(startDate) && isValidDateString(endDate) && startDate > endDate) {
      errors.push("start_date must be before or equal to end_date");
    }

    if (errors.length > 0) {
      return new Response(JSON.stringify({ errors }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 100, MAX_LIMIT) : 100;

    // date is stored as a plain "YYYY-MM-DD" string in your documents, so we
    // compare directly against the strings (ISO date strings sort correctly
    // as plain text, no need to convert to a Date object).
    const filter = {
      platform: platform.toLowerCase(),
      [DATE_FIELD]: { $gte: startDate, $lte: endDate },
    };

    // --- Query MongoDB ---
    const client = await getClient(env);
    const db = client.db(env.MONGODB_DATABASE);
    const collection = db.collection(env.MONGODB_COLLECTION);

    const documents = await collection
      .find(filter)
      .sort({ [DATE_FIELD]: -1 })
      .limit(limit)
      .toArray();

    return new Response(JSON.stringify(documents), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}