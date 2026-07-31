// Cloudflare Worker entry point
// File location: src/index.js
//
// This single file IS the whole Worker. Routing is done manually by checking
// the request URL's pathname, instead of the functions/ folder convention
// used by Cloudflare Pages.

const DATE_FIELD = "date";
const VALID_PLATFORMS = ["discord", "telegram"];
const MAX_LIMIT = 500;

// Cache the client across requests handled by the same warm isolate.
let cachedClient = null;

async function getClient(env) {
  if (cachedClient) return cachedClient;
  // Imported here (not at top of file) because bson's ObjectId does a
  // random-byte generation during module load, which Workers only allow
  // inside a request handler, not at global/top-level script init.
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  cachedClient = client;
  return client;
}

function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
}

async function handleStats(request, env) {
  try {
    const url = new URL(request.url);
    const platform = url.searchParams.get("platform");
    const startDate = url.searchParams.get("start_date");
    const endDate = url.searchParams.get("end_date");
    const limitParam = url.searchParams.get("limit");

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

    const filter = {
      platform: platform.toLowerCase(),
      [DATE_FIELD]: { $gte: startDate, $lte: endDate },
    };

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/stats") {
      return handleStats(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};