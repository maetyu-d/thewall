const canvas = document.querySelector("#wall");
const ctx = canvas.getContext("2d");
const statusEl = document.querySelector("#status");
const sizeInput = document.querySelector("#size");

const state = {
  tool: "brush",
  color: "#111111",
  stamp: "star",
  size: Number(sizeInput.value),
  drawing: false,
  current: [],
  strokes: [],
  newest: 0,
  saving: 0,
  canvasWidth: 1,
  canvasHeight: 1
};

const api = "/api/drawing";
const rainbowColors = ["#ff3864", "#ff8c1a", "#ffd500", "#37c871", "#1e9bff", "#8b5cf6"];

setupControls();
resizeCanvas();
await loadWall();
setInterval(loadWall, 15000);

window.addEventListener("resize", () => {
  resizeCanvas();
  redrawAll();
});

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  const point = getPoint(event);

  if (state.tool === "stamp") {
    const stroke = makeStroke([point]);
    drawStroke(stroke);
    saveStroke(stroke);
    return;
  }

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
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tool = button.dataset.tool;
      setActive("[data-tool]", button);
    });
  });

  document.querySelectorAll("[data-color]").forEach((button) => {
    button.addEventListener("click", () => {
      state.color = button.dataset.color;
      setActive("[data-color]", button);
    });
  });

  document.querySelectorAll("[data-stamp]").forEach((button) => {
    button.addEventListener("click", () => {
      state.stamp = button.dataset.stamp;
      state.tool = "stamp";
      setActive("[data-stamp]", button);
      setActive("[data-tool]", document.querySelector('[data-tool="stamp"]'));
    });
  });

  sizeInput.addEventListener("input", () => {
    state.size = Number(sizeInput.value);
  });
}

async function loadWall() {
  try {
    const response = await fetch(api, { cache: "no-store" });
    if (!response.ok) throw new Error("Load failed");
    const data = await response.json();
    const incoming = Array.isArray(data.strokes) ? data.strokes : [];

    if (incoming.length !== state.strokes.length || data.newest !== state.newest) {
      state.strokes = incoming;
      state.newest = data.newest || 0;
      redrawAll();
    }

    setStatus(state.saving ? "Saving..." : `${data.total || incoming.length} saved marks on the wall`, true);
  } catch {
    setStatus("Offline preview: drawing works, saving starts on Netlify.", false);
  }
}

async function saveStroke(stroke) {
  state.saving += 1;
  setStatus("Saving...", false);

  try {
    const response = await fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stroke)
    });
    if (!response.ok) throw new Error("Save failed");
    state.strokes.push(stroke);
    setStatus("Saved for the next visitor.", true);
  } catch {
    setStatus("That mark stayed local, but did not save.", false);
  } finally {
    state.saving -= 1;
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
    tool: state.tool,
    color: state.color,
    size: state.size,
    stamp: state.stamp,
    points
  };
}

function redrawAll() {
  ctx.clearRect(0, 0, state.canvasWidth, state.canvasHeight);
  for (const stroke of state.strokes) drawStroke(stroke);
}

function drawStroke(stroke) {
  if (!stroke?.points?.length) return;

  if (stroke.tool === "stamp") {
    drawStamp(stroke.points[0], stroke);
    return;
  }

  for (let index = 1; index < stroke.points.length; index += 1) {
    drawSegment(stroke.points[index - 1], stroke.points[index], stroke, index);
  }
}

function drawSegment(from, to, stroke, index = 0) {
  const start = scalePoint(from);
  const end = scalePoint(to);

  if (stroke.tool === "spray") {
    spray(to, stroke, index);
    return;
  }

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = stroke.size;
  ctx.strokeStyle = stroke.tool === "eraser" ? "#fffef8" : stroke.color;

  if (stroke.tool === "rainbow") {
    ctx.strokeStyle = rainbowColors[index % rainbowColors.length];
  }

  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.restore();
}

function spray(point, stroke, segmentIndex) {
  const scaled = scalePoint(point);
  const dots = Math.max(8, Math.round(stroke.size * 0.85));
  ctx.save();
  ctx.fillStyle = stroke.color;
  for (let index = 0; index < dots; index += 1) {
    const seed = (point.x * 1009) + (point.y * 9176) + (segmentIndex * 37) + index;
    const angle = randomUnit(seed) * Math.PI * 2;
    const radius = randomUnit(seed + 19) * stroke.size;
    ctx.globalAlpha = 0.28 + randomUnit(seed + 41) * 0.46;
    ctx.beginPath();
    ctx.arc(scaled.x + Math.cos(angle) * radius, scaled.y + Math.sin(angle) * radius, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function randomUnit(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function drawStamp(point, stroke) {
  const scaled = scalePoint(point);
  const symbol = {
    star: "★",
    heart: "♥",
    flower: "✿",
    spark: "✦",
    moon: "☾"
  }[stroke.stamp] || "★";

  ctx.save();
  ctx.fillStyle = stroke.color;
  ctx.strokeStyle = "#151515";
  ctx.lineWidth = Math.max(2, stroke.size / 10);
  ctx.font = `900 ${stroke.size * 1.9}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeText(symbol, scaled.x, scaled.y);
  ctx.fillText(symbol, scaled.x, scaled.y);
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
