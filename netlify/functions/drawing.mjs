import { getStore } from "@netlify/blobs";
import sharp from "sharp";

const STORE_NAME = "forever-drawing-wall";
const MAX_STROKES_PER_LOAD = 8000;
const MAX_POINTS = 900;
const MAX_BODY_BYTES = 900_000;
const MAX_BATCH_STROKES = 24;
const COMPACT_EVERY = 500;
const RASTER_WIDTH = 1600;
const RASTER_HEIGHT = 1000;
const PAPER_COLOR = "#fffef8";

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
      const url = new URL(request.url);
      if (url.searchParams.has("layer")) {
        return await loadLayer(store, url.searchParams.get("layer"));
      }
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
  await tryEnsureRasterLayers(store);

  const strokeKeys = await listStrokeKeys(store);
  const layers = await listLayerKeys(store);
  const compactedCount = layers.length * COMPACT_EVERY;
  const looseKeys = strokeKeys
    .slice(compactedCount)
    .filter((key) => shouldFetchKey(key, since))
    .slice(-MAX_STROKES_PER_LOAD);

  const results = await Promise.allSettled(
    looseKeys.map((key) => store.get(key, { consistency: "strong", type: "json" }))
  );
  const strokes = results
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value)
    .filter((stroke) => isSupportedSavedStroke(stroke))
    .filter((stroke) => !since || Number(stroke.createdAt) > since);

  strokes.sort((a, b) => a.createdAt - b.createdAt);
  return json({
    layers: layers.map((key) => ({
      key,
      url: `/api/drawing?layer=${encodeURIComponent(key)}`,
      width: RASTER_WIDTH,
      height: RASTER_HEIGHT
    })),
    strokes,
    total: strokeKeys.length,
    compacted: compactedCount,
    newest: strokes.at(-1)?.createdAt ?? 0
  });
}

async function loadLayer(store, key) {
  if (!/^layers\/\d{6}\.png$/.test(key || "")) {
    return json({ error: "Layer not found" }, 404);
  }

  const image = await store.get(key, { consistency: "strong", type: "arrayBuffer" });
  if (!image) {
    return json({ error: "Layer not found" }, 404);
  }

  return new Response(image, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable"
    }
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

  await tryEnsureRasterLayers(store);

  return json({ ok: failed.length === 0, saved, failed }, failed.length ? 207 : 201);
}

async function tryEnsureRasterLayers(store) {
  try {
    await ensureRasterLayers(store);
  } catch (error) {
    console.error("Layer compaction failed", error);
  }
}

async function ensureRasterLayers(store) {
  const strokeKeys = await listStrokeKeys(store);
  const existingLayers = await listLayerKeys(store);
  const completedLayerCount = Math.floor(strokeKeys.length / COMPACT_EVERY);

  for (let index = existingLayers.length; index < completedLayerCount; index += 1) {
    const layerKey = `layers/${String(index + 1).padStart(6, "0")}.png`;
    const batchKeys = strokeKeys.slice(index * COMPACT_EVERY, (index + 1) * COMPACT_EVERY);
    const strokes = await loadStrokeBatch(store, batchKeys);
    if (strokes.length !== COMPACT_EVERY) return;

    const png = await renderLayer(strokes);
    await store.set(layerKey, png, {
      metadata: {
        count: strokes.length,
        from: strokes[0].createdAt,
        to: strokes.at(-1).createdAt,
        width: RASTER_WIDTH,
        height: RASTER_HEIGHT
      }
    });
  }
}

async function loadStrokeBatch(store, keys) {
  const results = await Promise.allSettled(
    keys.map((key) => store.get(key, { consistency: "strong", type: "json" }))
  );

  return results
    .filter((result) => result.status === "fulfilled" && isSupportedSavedStroke(result.value))
    .map((result) => result.value)
    .sort((a, b) => a.createdAt - b.createdAt);
}

async function renderLayer(strokes) {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${RASTER_WIDTH}" height="${RASTER_HEIGHT}" viewBox="0 0 ${RASTER_WIDTH} ${RASTER_HEIGHT}">`,
    `<rect width="100%" height="100%" fill="transparent"/>`,
    ...strokes.map(strokeToSvg),
    "</svg>"
  ].join("");

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
}

function strokeToSvg(stroke) {
  const path = stroke.points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${round(point.x * RASTER_WIDTH)} ${round(point.y * RASTER_HEIGHT)}`)
    .join(" ");
  const color = stroke.tool === "eraser" ? PAPER_COLOR : stroke.color;
  return `<path d="${path}" fill="none" stroke="${escapeAttr(color)}" stroke-width="${stroke.size}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

async function listStrokeKeys(store) {
  const { blobs } = await store.list({ prefix: "strokes/" });
  return blobs
    .map((blob) => blob.key)
    .filter((key) => /^strokes\/\d{13}-[0-9a-f-]{20,80}\.json$/i.test(key))
    .sort();
}

async function listLayerKeys(store) {
  const { blobs } = await store.list({ prefix: "layers/" });
  return blobs
    .map((blob) => blob.key)
    .filter((key) => /^layers\/\d{6}\.png$/.test(key))
    .sort();
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

function round(value) {
  return Math.round(value * 100) / 100;
}

function escapeAttr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
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
