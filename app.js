const canvas = document.querySelector("#wall");
const ctx = canvas.getContext("2d");
const statusEl = document.querySelector("#status");
const sizeInput = document.querySelector("#size");
const eraseButton = document.querySelector("#erase");

const state = {
  tool: "brush",
  color: "#111111",
  size: Number(sizeInput.value),
  drawing: false,
  current: [],
  strokes: [],
  pending: loadPendingStrokes(),
  newest: 0,
  saving: 0,
  loading: false,
  retryTimer: null,
  refreshTimer: null,
  canvasWidth: 1,
  canvasHeight: 1
};

const api = "/api/drawing";

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
  }
});

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
  state.current.push(point);
  drawSegment(previous, point, makeStroke(state.current), state.current.length - 1);
});

canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);

function setupControls() {
  document.querySelectorAll("[data-color]").forEach((button) => {
    button.addEventListener("click", () => {
      state.color = button.dataset.color;
      state.tool = "brush";
      eraseButton.classList.remove("active");
      eraseButton.setAttribute("aria-pressed", "false");
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
  });
}

async function loadWall() {
  if (state.loading) return;
  state.loading = true;

  try {
    const response = await fetch(`${api}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Load failed");
    const data = await response.json();
    const incoming = Array.isArray(data.strokes) ? data.strokes : [];
    const merged = mergeStrokes(incoming, state.strokes, state.pending);
    const newest = Math.max(0, ...merged.map((stroke) => stroke.createdAt || 0));

    if (hasStrokeChanges(merged, state.strokes) || newest !== state.newest) {
      state.strokes = merged;
      state.newest = newest;
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
    for (const stroke of [...state.pending]) {
      const response = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stroke)
      });

      if (!response.ok) throw new Error("Save failed");
      const saved = await response.json();
      markSaved(stroke.id, saved);
    }

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

  if (state.current.length > 1) {
    saveStroke(makeStroke(simplifyPoints(state.current)));
  }

  state.current = [];
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

function redrawAll() {
  ctx.clearRect(0, 0, state.canvasWidth, state.canvasHeight);
  for (const stroke of state.strokes) drawStroke(stroke);
}

function drawStroke(stroke) {
  if (!stroke?.points?.length) return;

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
  ctx.strokeStyle = stroke.tool === "eraser" ? "#fffef8" : stroke.color;

  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.restore();
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

function addPending(stroke) {
  if (!state.pending.some((pending) => pending.id === stroke.id)) {
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
  state.retryTimer = setTimeout(flushPending, delay);
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
    return Array.isArray(strokes) ? strokes : [];
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
