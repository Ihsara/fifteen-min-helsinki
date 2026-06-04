// The 15-Minute Helsinki — dark canvas poster. Pure render helpers + (later) the app.
"use strict";

// Equirectangular fit of a lon/lat bbox into a w×h canvas, cos(lat) x-correction, Y flip.
function makeProjection(bbox, w, h, margin) {
  const m = margin || 10;
  const latMid = (bbox.minY + bbox.maxY) / 2;
  const kx = Math.cos(latMid * Math.PI / 180);
  const dataW = (bbox.maxX - bbox.minX) * kx, dataH = (bbox.maxY - bbox.minY);
  const aW = w - 2 * m, aH = h - 2 * m;
  const s = Math.min(aW / dataW, aH / dataH);
  const offX = m + (aW - dataW * s) / 2, offY = m + (aH - dataH * s) / 2;
  return {
    s, kx,
    fn: (x, y) => [offX + (x - bbox.minX) * kx * s, offY + (bbox.maxY - y) * s],
  };
}

// Pointy-top hexagon vertices around (cx,cy) with radius r.
function hexVertices(cx, cy, r) {
  const v = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 90);
    v.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return v;
}

// Nearest cell (by precomputed _px/_py) within `maxDist` px of (mx,my), else null.
function pickCell(cells, mx, my, maxDist) {
  let best = null, bd = maxDist * maxDist;
  for (const c of cells) {
    const dx = c._px - mx, dy = c._py - my, d = dx * dx + dy * dy;
    if (d <= bd) { bd = d; best = c; }
  }
  return best;
}

// ---------- constants ----------
const FUNCTIONS = ["working", "supplying", "caring", "learning", "enjoying"];
const RAMP = ["#0c1116", "#123038", "#1f5e57", "#3f8e63", "#8fc659", "#f4e36b"];
const GLOW = { 4: { col: "143,198,89", a: 0.32 }, 5: { col: "244,227,107", a: 0.55 } };
const SEA = "#0e1a24", LAND = "#070a0d", COAST = "rgba(120,160,180,0.25)";
const NET = { rail: "rgba(111,211,230,0.55)", tram: "rgba(230,154,111,0.5)", bus: "rgba(255,138,61,0.6)" };

let activeMode = "walk", showFullNet = false;
let cells = [], bbox = null, proj = null, R = 8;
let water = null, rail = null, tram = null, trunkbus = null;
// The render-test harness loads this file without a #map canvas; guard so the
// pure helpers above stay loadable in isolation (canvas/ctx/boot only run in the app).
const canvas = document.getElementById("map");
const ctx = canvas && canvas.getContext("2d");

// ---------- geojson walkers ----------
function eachPolyRing(geo, cb) {
  const walk = g => { if (!g) return;
    if (g.type === "Polygon") cb(g.coordinates);
    else if (g.type === "MultiPolygon") g.coordinates.forEach(cb);
    else if (g.type === "GeometryCollection") g.geometries.forEach(walk); };
  (geo.features ? geo.features.map(f => f.geometry) : [geo.geometry || geo]).forEach(walk);
}
function eachLine(geo, cb) {
  const walk = g => { if (!g) return;
    if (g.type === "LineString") cb(g.coordinates);
    else if (g.type === "MultiLineString") g.coordinates.forEach(cb);
    else if (g.type === "GeometryCollection") g.geometries.forEach(walk); };
  (geo.features ? geo.features.map(f => f.geometry) : [geo.geometry || geo]).forEach(walk);
}

// ---------- sizing ----------
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  proj = makeProjection(bbox, w, h, 12);
  const c = cells[Math.floor(cells.length / 2)];
  const [x0, y0] = proj.fn(c.ring[0][0], c.ring[0][1]);
  const [x1, y1] = proj.fn(c.ring[1][0], c.ring[1][1]);
  R = Math.hypot(x1 - x0, y1 - y0) * 0.82;
  for (const cell of cells) { const [px, py] = proj.fn(cell.cx, cell.cy); cell._px = px; cell._py = py; }
}

// ---------- draw ----------
function drawWater() {
  if (!water) return;
  ctx.fillStyle = SEA; ctx.strokeStyle = COAST; ctx.lineWidth = 0.7;
  eachPolyRing(water, poly => {
    ctx.beginPath();
    poly.forEach(ring => ring.forEach(([x, y], i) => { const [px, py] = proj.fn(x, y); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }));
    ctx.fill("evenodd"); ctx.stroke();
  });
}
function drawNetworkLines(geo, color, w) {
  if (!geo) return; ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  eachLine(geo, ln => ln.forEach(([x, y], i) => { const [px, py] = proj.fn(x, y); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }));
  ctx.stroke();
}
function drawGlow() {
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (const c of cells) {
    const comp = c.modes[activeMode].completeness;
    if (comp < 4) continue;
    const g = GLOW[comp], rad = R * 3.2;
    const grad = ctx.createRadialGradient(c._px, c._py, 0, c._px, c._py, rad);
    grad.addColorStop(0, `rgba(${g.col},${g.a})`); grad.addColorStop(1, `rgba(${g.col},0)`);
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(c._px, c._py, rad, 0, 7); ctx.fill();
  }
  ctx.restore();
}
function drawCells(hoverCell) {
  for (const c of cells) {
    const comp = c.modes[activeMode].completeness;
    ctx.beginPath();
    hexVertices(c._px, c._py, R).forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath(); ctx.fillStyle = RAMP[comp]; ctx.fill();
    if (c === hoverCell) { ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
}
function draw(hoverCell) {
  ctx.fillStyle = LAND; ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  drawWater();
  drawNetworkLines(rail, NET.rail, 1.6);
  drawNetworkLines(tram, NET.tram, 1.2);
  if (showFullNet && trunkbus) drawNetworkLines(trunkbus, NET.bus, 1.3);
  drawGlow();
  drawCells(hoverCell);
}

// ---------- panel ----------
function showPanel(c) {
  const m = c.modes[activeMode];
  document.getElementById("cell-id").textContent = c.cell_id;
  document.getElementById("summary").textContent = m.completeness === FUNCTIONS.length
    ? `${m.completeness}/5 reachable by ${activeMode}. All needs met.`
    : `${m.completeness}/5 reachable by ${activeMode}. Missing first: ${m.binding_function}.`;
  const ul = document.getElementById("functions"); ul.innerHTML = "";
  for (const fn of FUNCTIONS) {
    const mins = m.min[fn], reachable = mins != null && mins <= 15;
    const li = document.createElement("li"); if (!reachable) li.className = "miss";
    li.innerHTML = `<span>${fn}</span><span>${mins == null ? "—" : Math.round(mins) + " min"} ${reachable ? "✓" : "✗"}</span>`;
    ul.appendChild(li);
  }
  document.getElementById("panel").hidden = false;
}

// ---------- load + wire ----------
async function boot() {
  let grid;
  try {
    const res = await fetch("scored_grid.min.geojson");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    grid = await res.json();
  } catch (err) {
    // The grid is the one essential file; without it there's nothing to show.
    // Size the canvas to its CSS box first (resize() never ran on this path).
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w; canvas.height = h;
    ctx.fillStyle = LAND; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#9aa0ad"; ctx.font = "14px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Could not load the map data.", w / 2, h / 2);
    console.error("scored_grid.min.geojson failed to load:", err);
    return;
  }
  const opt = async f => { try { const r = await fetch(f); return r.ok ? await r.json() : null; } catch { return null; } };
  [water, rail, tram, trunkbus] = await Promise.all([
    opt("coastline.min.geojson"), opt("rail.min.geojson"), opt("tram.min.geojson"), opt("trunkbus.min.geojson"),
  ]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  cells = grid.features.map(f => {
    const ring = f.geometry.coordinates[0]; let cx = 0, cy = 0;
    for (const [x, y] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; cx += x; cy += y; }
    return { ring, cx: cx / ring.length, cy: cy / ring.length, cell_id: f.properties.cell_id, modes: f.properties.modes };
  });
  bbox = { minX, minY, maxX, maxY };

  // The trunk-bus legend row only makes sense once the toggle reveals trunk buses,
  // and only if the data was actually baked. Drop it entirely when absent; otherwise
  // reveal it together with the "show full network" toggle below.
  const busRow = document.querySelector("#net-key .k-bus-row");
  if (!trunkbus) busRow.remove();

  resize(); draw();

  document.querySelectorAll("#modes button").forEach(btn => btn.onclick = () => {
    activeMode = btn.dataset.mode;
    document.querySelectorAll("#modes button").forEach(b => b.classList.toggle("active", b === btn));
    draw();
  });
  // The rail/tram spine is always drawn, so the key is always shown. The trunk-bus
  // row stays hidden until the toggle is on (and only exists if trunkbus loaded).
  const netKey = document.getElementById("net-key");
  netKey.hidden = false;
  document.getElementById("net-full").onchange = e => {
    showFullNet = e.target.checked;
    if (trunkbus) busRow.hidden = !showFullNet;
    draw();
  };

  canvas.onmousemove = e => {
    const r = canvas.getBoundingClientRect();
    const hit = pickCell(cells, e.clientX - r.left, e.clientY - r.top, R);
    canvas.style.cursor = hit ? "pointer" : "default"; draw(hit);
  };
  canvas.onclick = e => {
    const r = canvas.getBoundingClientRect();
    const hit = pickCell(cells, e.clientX - r.left, e.clientY - r.top, R);
    if (hit) showPanel(hit);
  };
  document.getElementById("close-panel").onclick = () => document.getElementById("panel").hidden = true;
  window.addEventListener("resize", () => { resize(); draw(); });
}

// Only boot the app when the page actually has the map canvas (not in the helper test harness).
if (canvas) {
  const mt = document.getElementById("method-toggle"), md = document.getElementById("method");
  mt.onclick = () => { const open = md.open = !md.open; mt.setAttribute("aria-expanded", String(open)); mt.textContent = open ? "How this works ▴" : "How this works ▾"; };
  boot();
}
