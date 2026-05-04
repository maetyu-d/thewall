const canvas = document.querySelector("#wall");
const ctx = canvas.getContext("2d");
const statusEl = document.querySelector("#status");
const sizeInput = document.querySelector("#size");
const eraseButton = document.querySelector("#erase");

const api = "/api/drawing";
const paperColor = "#fffef8";
const maxBatchSize = 12;
const requestTimeout = 10000;

const state = {
  tool: "brush",
  color: "#111111",
  size: Number(sizeInput.value),
  drawing: false,
  current: [],
  preview: null,
  layers: [],
  layerImages: new Map(),
  strokes: [],
  pending: loadPendingStrokes(),
  compacted: 0,
  newest: 0,
  saving: 0,
  loading: false,
  retryTimer: null,
  refreshTimer: null,
  canvasWidth: 1,
  canvasHeight: 1
};

setupControls();
resizeCanvas();
await loadWall();
queuePendingRetry(600);
scheduleRefresh();

window.addEventListener("resize", () => {
  resizeCanvas();
  redrawAll();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    loadWall();
    queuePendingRetry(100);
  } else {
    flushPendingWithBeacon();
  }
});

window.addEventListener("online", () => {
  loadWall();
  queuePendingRetry(100);
});

window.addEventListener("pagehide", flushPendingWithBeacon);

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  const point = getPoint(event);
  state.drawing = true;
  state.current = [point];
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.drawing) return;
  const point = getPoint(event);
  const previous = state.current.at(-1);
  if (state.tool === "brush" || state.tool === "eraser") {
    state.current.push(point);
    drawSegment(previous, point, makeStroke(state.current), state.current.length - 1);
  } else {
    state.current = [state.current[0], point];
    state.preview = makeShapeStroke(state.current[0], point);
    redrawAll();
    drawStroke(state.preview);
  }
});

canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);

function setupControls() {
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tool = button.dataset.tool;
      eraseButton.classList.remove("active");
      eraseButton.setAttribute("aria-pressed", "false");
      setActive("[data-tool]", button);
    });
  });

  document.querySelectorAll("[data-color]").forEach((button) => {
    button.addEventListener("click", () => {
      state.color = button.dataset.color;
      setActive("[data-color]", button);
    });
  });

  sizeInput.addEventListener("input", () => {
    state.size = Number(sizeInput.value);
  });

  eraseButton.addEventListener("click", () => {
    const erasing = state.tool !== "eraser";
    state.tool = erasing ? "eraser" : "brush";
    eraseButton.classList.toggle("active", erasing);
    eraseButton.setAttribute("aria-pressed", String(erasing));
    setActive("[data-tool]", erasing ? null : document.querySelector('[data-tool="brush"]'));
  });
}

async function loadWall() {
  if (state.loading) return;
  state.loading = true;

  try {
    const params = new URLSearchParams({ t: String(Date.now()) });
    const response = await fetchWithTimeout(`${api}?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Load failed");
    const data = await response.json();
    const incoming = Array.isArray(data.strokes) ? data.strokes : [];
    const incomingLayers = Array.isArray(data.layers) ? data.layers : [];
    const compacted = Number(data.compacted) || 0;
    const baseStrokes = compacted > state.compacted ? [] : state.strokes;
    const merged = mergeStrokes(incoming, baseStrokes, state.pending);
    const newest = Math.max(0, ...merged.map((stroke) => stroke.createdAt || 0));
    const layersChanged = hasLayerChanges(incomingLayers, state.layers);

    if (layersChanged) {
      await loadLayerImages(incomingLayers);
      state.layers = incomingLayers;
    }

    if (layersChanged || hasStrokeChanges(merged, state.strokes) || newest !== state.newest || compacted !== state.compacted) {
      state.strokes = merged;
      state.newest = newest;
      state.compacted = compacted;
      redrawAll();
    }

    const pendingLabel = state.pending.length ? `, ${state.pending.length} still retrying` : "";
    setStatus(state.saving ? "Saving..." : `${data.total || incoming.length} saved marks on the wall${pendingLabel}`, true);
    if (state.pending.length) queuePendingRetry();
  } catch {
    state.strokes = mergeStrokes(state.strokes, state.pending);
    redrawAll();
    setStatus("Connection wobble: your marks are queued here and will retry.", false);
    queuePendingRetry();
  } finally {
    state.loading = false;
    scheduleRefresh();
  }
}

async function saveStroke(stroke) {
  const localStroke = {
    ...stroke,
    id: stroke.id || crypto.randomUUID(),
    createdAt: stroke.createdAt || Date.now(),
    attempts: stroke.attempts || 0
  };

  addPending(localStroke);
  state.strokes = mergeStrokes(state.strokes, [localStroke]);
  redrawAll();
  queuePendingRetry(20);
}

async function flushPending() {
  if (!state.pending.length || state.saving) return;

  state.saving += 1;
  setStatus("Saving...", false);

  try {
    const batch = state.pending.slice(0, maxBatchSize);
    const response = await fetchWithTimeout(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strokes: batch })
    });

    if (!response.ok) throw new Error("Save failed");
    const result = await response.json();
    for (const saved of normalizeSavedResults(result)) {
      markSaved(saved.id, saved);
    }

    if (result.failed?.length) throw new Error("Some marks failed");
    setStatus("Saved for the next visitor.", true);
    await loadWall();
  } catch {
    bumpPendingAttempts();
    setStatus("Still trying to save. Your marks remain on this screen.", false);
    queuePendingRetry();
  } finally {
    state.saving -= 1;
    if (state.pending.length) queuePendingRetry();
  }
}

function finishStroke() {
  if (!state.drawing) return;
  state.drawing = false;

  const stroke = state.preview || makeStroke(simplifyPoints(state.current));
  if (stroke.points.length > 1) {
    saveStroke(stroke);
  }

  state.current = [];
  state.preview = null;
}

function makeStroke(points) {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    tool: state.tool,
    color: state.color,
    size: state.size,
    points
  };
}

function makeShapeStroke(start, end) {
  const tool = state.tool;
  if (tool === "line") return { ...makeStroke([start, end]), tool: "line" };

  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);

  if (tool === "rect") {
    return {
      ...makeStroke([
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
        { x: left, y: top }
      ]),
      tool: "rect"
    };
  }

  const points = [];
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const radiusX = Math.max(0.001, (right - left) / 2);
  const radiusY = Math.max(0.001, (bottom - top) / 2);
  for (let index = 0; index <= 48; index += 1) {
    const angle = (index / 48) * Math.PI * 2;
    points.push({
      x: centerX + Math.cos(angle) * radiusX,
      y: centerY + Math.sin(angle) * radiusY
    });
  }
  return { ...makeStroke(points), tool: "ellipse" };
}

function redrawAll() {
  ctx.clearRect(0, 0, state.canvasWidth, state.canvasHeight);
  for (const layer of state.layers) {
    const image = state.layerImages.get(layer.key);
    if (image) ctx.drawImage(image, 0, 0, state.canvasWidth, state.canvasHeight);
  }
  for (const stroke of state.strokes) drawStroke(stroke);
}

function drawStroke(stroke) {
  if (!stroke?.points?.length) return;
  if (!isDrawableTool(stroke.tool)) return;

  for (let index = 1; index < stroke.points.length; index += 1) {
    drawSegment(stroke.points[index - 1], stroke.points[index], stroke, index);
  }
}

function drawSegment(from, to, stroke, index = 0) {
  const start = scalePoint(from);
  const end = scalePoint(to);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = stroke.size;
  ctx.strokeStyle = stroke.tool === "eraser" ? paperColor : getStrokeColor(stroke, index);

  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.restore();
}

function getStrokeColor(stroke, index) {
  return stroke.color;
}

function getPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height
  };
}

function scalePoint(point) {
  return {
    x: point.x * state.canvasWidth,
    y: point.y * state.canvasHeight
  };
}

function simplifyPoints(points) {
  const simplified = [];
  let previous = null;
  for (const point of points) {
    if (!previous || distance(previous, point) > 0.0025) {
      simplified.push(point);
      previous = point;
    }
  }
  return simplified.slice(0, 900);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  state.canvasWidth = rect.width;
  state.canvasHeight = rect.height;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function setActive(selector, activeButton) {
  document.querySelectorAll(selector).forEach((button) => {
    button.classList.toggle("active", button === activeButton);
  });
}

function setStatus(message, fade) {
  statusEl.textContent = message;
  statusEl.classList.remove("hide");
  if (fade) {
    clearTimeout(setStatus.timer);
    setStatus.timer = setTimeout(() => statusEl.classList.add("hide"), 1600);
  }
}

function mergeStrokes(...groups) {
  const byId = new Map();

  for (const group of groups) {
    for (const stroke of group || []) {
      if (!stroke?.points?.length) continue;
      if (!isDrawableTool(stroke.tool)) continue;
      const key = stroke.id || `${stroke.createdAt}-${stroke.tool}-${stroke.points[0].x}-${stroke.points[0].y}`;
      byId.set(key, { ...byId.get(key), ...stroke, id: key });
    }
  }

  return [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function hasStrokeChanges(next, current) {
  if (next.length !== current.length) return true;
  return next.some((stroke, index) => stroke.id !== current[index]?.id || stroke.createdAt !== current[index]?.createdAt);
}

function hasLayerChanges(next, current) {
  if (next.length !== current.length) return true;
  return next.some((layer, index) => layer.key !== current[index]?.key);
}

function addPending(stroke) {
  if (isSupportedStroke(stroke) && !state.pending.some((pending) => pending.id === stroke.id)) {
    state.pending.push(stroke);
    savePendingStrokes();
  }
}

function markSaved(id, saved) {
  state.pending = state.pending.filter((stroke) => stroke.id !== id);
  state.strokes = state.strokes.map((stroke) => {
    if (stroke.id !== id) return stroke;
    return {
      ...stroke,
      id: saved.id || stroke.id,
      createdAt: saved.createdAt || stroke.createdAt
    };
  });
  savePendingStrokes();
}

function bumpPendingAttempts() {
  state.pending = state.pending.map((stroke) => ({
    ...stroke,
    attempts: (stroke.attempts || 0) + 1
  }));
  savePendingStrokes();
}

function queuePendingRetry(delay = 2500) {
  clearTimeout(state.retryTimer);
  const attempts = Math.max(0, ...state.pending.map((stroke) => stroke.attempts || 0));
  const backoff = state.pending.length ? Math.min(30000, delay * (2 ** Math.min(attempts, 4))) : delay;
  state.retryTimer = setTimeout(flushPending, backoff);
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  const delay = document.hidden ? 15000 : 2500;
  state.refreshTimer = setTimeout(loadWall, delay);
}

function loadPendingStrokes() {
  try {
    const value = localStorage.getItem("forever-doodle-pending");
    const strokes = JSON.parse(value || "[]");
    return Array.isArray(strokes) ? strokes.filter(isSupportedStroke) : [];
  } catch {
    return [];
  }
}

function savePendingStrokes() {
  try {
    localStorage.setItem("forever-doodle-pending", JSON.stringify(state.pending.slice(-200)));
  } catch {
    // The in-memory queue still protects marks for this visit.
  }
}

function normalizeSavedResults(result) {
  if (Array.isArray(result.saved)) return result.saved;
  if (result.id) return [result];
  return [];
}

async function loadLayerImages(layers) {
  await Promise.all(layers.map(loadLayerImage));
}

async function loadLayerImage(layer) {
  if (state.layerImages.has(layer.key)) return;

  await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      state.layerImages.set(layer.key, image);
      resolve();
    };
    image.onerror = reject;
    image.src = layer.url;
  });
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function flushPendingWithBeacon() {
  if (!state.pending.length || !navigator.sendBeacon) return;

  const batch = state.pending.slice(0, Math.min(8, maxBatchSize));
  const body = JSON.stringify({ strokes: batch });
  const sent = navigator.sendBeacon(api, new Blob([body], { type: "application/json" }));
  if (sent) {
    setTimeout(() => {
      loadWall();
      queuePendingRetry(500);
    }, 1200);
  }
}

function isSupportedStroke(stroke) {
  return stroke
    && isDrawableTool(stroke.tool)
    && Array.isArray(stroke.points)
    && stroke.points.length > 1;
}

function isDrawableTool(tool) {
  return ["brush", "eraser", "line", "rect", "ellipse"].includes(tool);
}
