import { getStore } from "@netlify/blobs";

const STORE_NAME = "forever-drawing-wall";
const MAX_STROKES_PER_LOAD = 2500;
const MAX_POINTS = 900;
const MAX_BODY_BYTES = 180_000;

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
      return await loadDrawing(store);
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

async function loadDrawing(store) {
  const { blobs } = await store.list({ prefix: "strokes/" });
  const keys = blobs
    .map((blob) => blob.key)
    .sort()
    .slice(-MAX_STROKES_PER_LOAD);
  const strokes = [];

  await Promise.all(
    keys.map(async (key) => {
      const value = await store.get(key, { type: "json" });
      if (value) strokes.push(value);
    })
  );

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

  const payload = JSON.parse(text);
  const stroke = normalizeStroke(payload);
  const key = `strokes/${stroke.createdAt}-${crypto.randomUUID()}.json`;

  await store.set(key, JSON.stringify(stroke), {
    metadata: { createdAt: stroke.createdAt }
  });

  return json({ ok: true, key, createdAt: stroke.createdAt }, 201);
}

function normalizeStroke(payload) {
  const tool = pick(payload.tool, ["brush", "rainbow", "spray", "stamp", "eraser"], "brush");
  const color = typeof payload.color === "string" && /^#[0-9a-f]{6}$/i.test(payload.color)
    ? payload.color
    : "#111111";
  const size = clamp(Number(payload.size), 2, 80, 12);
  const stamp = pick(payload.stamp, ["star", "heart", "flower", "spark", "moon"], "star");
  const points = Array.isArray(payload.points)
    ? payload.points.slice(0, MAX_POINTS).map(normalizePoint).filter(Boolean)
    : [];

  if (tool !== "stamp" && points.length < 2) {
    throw new Error("A stroke needs at least two points.");
  }

  if (tool === "stamp" && points.length < 1) {
    throw new Error("A stamp needs a point.");
  }

  return {
    tool,
    color,
    size,
    stamp,
    points,
    createdAt: Date.now()
  };
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

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
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
