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

// Reduce an array of raw daily documents into a single aggregated stats object.
function aggregateStats(documents, platform, startDate, endDate) {
  let totalJoined = 0;
  let totalLeft = 0;
  let memberGrowth = 0;
  let totalMessages = 0;
  const activeUserIds = new Set();

  // Docs are sorted by date desc (most recent first), so the first doc
  // encountered gives us the latest total_members for the range.
  let latestTotalMembers = null;

  for (const doc of documents) {
    totalJoined += doc.total_joined || 0;
    totalLeft += doc.total_left || 0;
    memberGrowth += doc.growth || 0;
    totalMessages += doc.total_messages || 0;

    if (Array.isArray(doc.active_user_ids)) {
      for (const id of doc.active_user_ids) activeUserIds.add(id);
    }

    if (latestTotalMembers === null && typeof doc.total_members === "number") {
      latestTotalMembers = doc.total_members;
    }
  }

  const dayCount = documents.length;
  const averageDailyMessages = dayCount > 0
    ? Number((totalMessages / dayCount).toFixed(2))
    : 0;

  return {
    platform,
    start_date: startDate,
    end_date: endDate,
    total_joined: totalJoined,
    total_left: totalLeft,
    member_growth: memberGrowth,
    total_messages: totalMessages,
    average_daily_messages: averageDailyMessages,
    active_members: activeUserIds.size,
    total_members: latestTotalMembers,
  };
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

    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || MAX_LIMIT, MAX_LIMIT) : MAX_LIMIT;

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

    const stats = aggregateStats(documents, platform.toLowerCase(), startDate, endDate);

    return new Response(JSON.stringify(stats), {
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