import { getStore } from "@netlify/blobs";

const STORE_NAME = "forever-drawing-wall";
const MAX_STROKES_PER_LOAD = 8000;
const MAX_POINTS = 900;
const MAX_BODY_BYTES = 900_000;
const MAX_BATCH_STROKES = 24;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default async (request) => {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const store = getStore(STORE_NAME);

    if (request.method === "GET") {
      return await loadDrawing(store, request);
    }

    if (request.method === "POST") {
      return await saveStroke(request, store);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error(error);
    return json({ error: "The drawing wall had trouble saving that mark." }, 500);
  }
};

async function loadDrawing(store, request) {
  const since = Number(new URL(request.url).searchParams.get("since")) || 0;
  const { blobs } = await store.list({ prefix: "strokes/" });
  const keys = blobs
    .map((blob) => blob.key)
    .sort()
    .filter((key) => shouldFetchKey(key, since))
    .slice(-MAX_STROKES_PER_LOAD);

  const results = await Promise.allSettled(
    keys.map((key) => store.get(key, { consistency: "strong", type: "json" }))
  );
  const strokes = results
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value)
    .filter((stroke) => isSupportedSavedStroke(stroke))
    .filter((stroke) => !since || Number(stroke.createdAt) > since);

  strokes.sort((a, b) => a.createdAt - b.createdAt);
  return json({
    strokes,
    total: blobs.length,
    newest: strokes.at(-1)?.createdAt ?? 0
  });
}

async function saveStroke(request, store) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return json({ error: "That stroke is too large." }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return json({ error: "That mark was not valid JSON." }, 400);
  }

  const payloads = Array.isArray(payload.strokes) ? payload.strokes.slice(0, MAX_BATCH_STROKES) : [payload];
  const saved = [];
  const failed = [];

  for (const item of payloads) {
    try {
      const stroke = normalizeStroke(item);
      const key = `strokes/${stroke.createdAt}-${stroke.id}.json`;

      await store.setJSON(key, stroke, {
        metadata: { createdAt: stroke.createdAt }
      });

      saved.push({ key, id: stroke.id, createdAt: stroke.createdAt });
    } catch (error) {
      failed.push({ error: error.message || "Invalid stroke" });
    }
  }

  if (!saved.length) {
    return json({ ok: false, saved, failed }, 400);
  }

  return json({ ok: failed.length === 0, saved, failed }, failed.length ? 207 : 201);
}

function normalizeStroke(payload) {
  const id = typeof payload.id === "string" && /^[0-9a-f-]{20,80}$/i.test(payload.id)
    ? payload.id
    : crypto.randomUUID();
  if (!["brush", "eraser"].includes(payload.tool)) {
    throw new Error("Unsupported drawing tool.");
  }

  const tool = payload.tool;
  const color = typeof payload.color === "string" && /^#[0-9a-f]{6}$/i.test(payload.color)
    ? payload.color
    : "#111111";
  const size = clamp(Number(payload.size), 2, 80, 12);
  const points = Array.isArray(payload.points)
    ? payload.points.slice(0, MAX_POINTS).map(normalizePoint).filter(Boolean)
    : [];

  if (points.length < 2) {
    throw new Error("A stroke needs at least two points.");
  }

  return {
    id,
    tool,
    color,
    size,
    points,
    createdAt: clamp(Number(payload.createdAt), 1_700_000_000_000, Date.now() + 86_400_000, Date.now()),
    receivedAt: Date.now()
  };
}

function shouldFetchKey(key, since) {
  if (!since) return true;
  const match = key.match(/^strokes\/(\d{13})-/);
  return !match || Number(match[1]) > since;
}

function isSupportedSavedStroke(stroke) {
  return stroke
    && ["brush", "eraser"].includes(stroke.tool)
    && Array.isArray(stroke.points)
    && stroke.points.length > 1;
}

function normalizePoint(point) {
  if (!point || typeof point !== "object") return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: clamp(x, 0, 1, 0),
    y: clamp(y, 0, 1, 0)
  };
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(jsonHeaders)
  });
}

function corsHeaders(extra = {}) {
  return {
    ...extra,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}
