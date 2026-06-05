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

// The five scored destination needs, in canonical order. Declared here (above the
// pure helpers that use it) so standHereSentence can reuse it instead of re-listing.
const FUNCTIONS = ["working", "supplying", "caring", "learning", "enjoying"];
// Human labels for each need, used to build the "stand here" sentence.
const HUMAN = { working:"work", supplying:"shops", caring:"care", learning:"learning", enjoying:"a park" };

// Pure: build the "stand here" sentence + per-need list for one cell & mode.
// Returns {lead, detail, items:[{fn,label,minutes,reachable,justOver}]}.
// Reachable = minutes != null && <= 15; justOver = 15 < minutes <= 18.
function standHereSentence(cell, mode) {
  const m = cell.modes[mode];
  const items = FUNCTIONS.map(fn => {
    const mins = m.min[fn];
    const reachable = mins != null && mins <= 15;
    return { fn, label: mins == null ? "—" : Math.round(mins) + " min",
      minutes: mins, reachable, justOver: mins != null && mins > 15 && mins <= 18 };
  });
  const reached = items.filter(i => i.reachable).map(i => HUMAN[i.fn]);
  const verb = mode === "walk" ? "walk" : mode === "bike" ? "bike" : mode === "transit" ? "ride transit" : "drive";
  if (m.completeness === FUNCTIONS.length) {
    return { lead: `From here you can ${verb} to all five daily needs in 15 minutes.`, detail: "", items };
  }
  const list = reached.length === 0 ? "almost nothing"
    : reached.length === 1 ? reached[0]
    : reached.slice(0, -1).join(", ") + " and " + reached[reached.length - 1];
  const bf = m.binding_function, bMin = m.min[bf];
  // Overshoot is computed from the raw value and rounded UP, so a 15.4-min need reads
  // "1 minute too far" rather than a self-contradictory "0 minutes too far".
  const over = bMin == null ? null : Math.max(1, Math.ceil(bMin - 15));
  const lead = `From here you can ${verb} to ${list} in 15 minutes.`;
  const detail = bMin == null
    ? `The nearest ${HUMAN[bf]} is out of reach entirely.`
    : `The nearest ${HUMAN[bf]} is ${Math.round(bMin)} — ${over} minute${over === 1 ? "" : "s"} too far.`;
  return { lead, detail, items };
}

// Story step 3 palette: colour an incomplete cell by its farthest (binding) need.
const BIND_COLOR = { working:"#a78bfa", supplying:"#6fd3e6", caring:"#ff8a6b", learning:"#8fc659", enjoying:"#f4e36b" };
function bindingColor(cell, mode) {
  const m = cell.modes[mode];
  if (m.completeness === 5) return "#2a3a30";
  return BIND_COLOR[m.binding_function] || "#2a3a30";
}

// ---------- constants ----------
const RAMP = ["#0c1116", "#123038", "#1f5e57", "#3f8e63", "#8fc659", "#f4e36b"];
const GLOW = { 4: { col: "143,198,89", a: 0.32 }, 5: { col: "244,227,107", a: 0.55 } };
const SEA = "#0e1a24", LAND = "#070a0d", COAST = "rgba(120,160,180,0.25)";
const NET = { rail: "rgba(111,211,230,0.55)", tram: "rgba(230,154,111,0.5)", bus: "rgba(255,138,61,0.6)" };

let activeMode = "walk", showFullNet = false;
let phase = "story", step = 0;            // phase: "story" | "explore"; step: 0..4
let origin = null;                         // chosen cell in explore mode
const STEPS = 5;
// per-step map emphasis: forced mode + render style
const STEP_VIEW = [
  { mode: "walk", style: "glow" },         // 0 hook
  { mode: "bike", style: "glow" },         // 1 bloom
  { mode: "walk", style: "binding" },      // 2 scarcity recolour
  { mode: "walk", style: "glow" },         // 3 hand-off
  { mode: "walk", style: "explore" },      // 4 free explore (phase flips to explore on enter)
];
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
function drawCells(hoverCell, style) {
  for (const c of cells) {
    const comp = c.modes[activeMode].completeness;
    ctx.beginPath();
    hexVertices(c._px, c._py, R).forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath();
    ctx.fillStyle = style === "binding" ? bindingColor(c, activeMode) : RAMP[comp];
    ctx.fill();
    if (c === hoverCell) { ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1.5; ctx.stroke(); }
    if (c === origin) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
  }
}
function drawReachRing() {
  if (!origin) return;
  // schematic ~15-min reach: radius scales with mode (walk small → car large). NOT a routed isochrone.
  const mult = { walk: 1, bike: 2.2, transit: 2.6, car: 3.4 }[activeMode] || 1;
  const rad = R * 7 * mult;
  ctx.save(); ctx.strokeStyle = "rgba(111,211,230,0.55)"; ctx.lineWidth = 1.4; ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.arc(origin._px, origin._py, rad, 0, 7); ctx.stroke(); ctx.restore();
}
function draw(hoverCell) {
  const style = phase === "explore" ? "explore" : STEP_VIEW[step].style;
  ctx.fillStyle = LAND; ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  drawWater();
  drawNetworkLines(rail, NET.rail, 1.6);
  drawNetworkLines(tram, NET.tram, 1.2);
  if (showFullNet && trunkbus) drawNetworkLines(trunkbus, NET.bus, 1.3);
  if (style !== "binding") drawGlow();
  drawCells(hoverCell, style);
  if (style === "explore") drawReachRing();
}

// ---------- panel ----------
function showPanel(c) {
  const s = standHereSentence(c, activeMode);
  document.getElementById("lead").textContent = s.lead;
  document.getElementById("detail").textContent = s.detail;
  const ul = document.getElementById("functions"); ul.innerHTML = "";
  for (const it of s.items) {
    const li = document.createElement("li");
    if (!it.reachable) li.className = it.justOver ? "just-over" : "miss";
    li.innerHTML = `<span>${HUMAN[it.fn]}</span><span>${it.label} ${it.reachable ? "✓" : "✗"}</span>`;
    ul.appendChild(li);
  }
  document.getElementById("panel").hidden = false;
}

// ---------- story controller ----------
// The guided story is steps 0..3; step 4 IS the live explore view (its copy is an
// intro hint shown until the first cell is tapped). STORY_STEPS = how many of the
// five sections are story-navigated with Back/Next.
const STORY_STEPS = 4;
function syncChrome() {
  document.body.dataset.phase = phase;
  document.body.dataset.step = String(step);
  const v = STEP_VIEW[step];
  activeMode = phase === "explore" ? activeMode : v.mode;
  // show only the current section; in explore, show the step-4 intro until a cell is picked
  const shown = phase === "explore" ? (origin ? -1 : 4) : step;
  document.querySelectorAll(".story-step").forEach(sec => {
    sec.hidden = Number(sec.dataset.step) !== shown;
  });
  // legends: gradient for glow/explore, binding legend for step 2
  const binding = phase === "story" && v.style === "binding";
  document.getElementById("legend").hidden = binding;
  document.getElementById("bind-legend").hidden = !binding;
  document.getElementById("net-key").hidden = phase !== "explore";
  // mode pills reflect the (forced or chosen) active mode
  document.querySelectorAll("#modes button").forEach(b => b.classList.toggle("active", b.dataset.mode === activeMode));
  // story nav enable/disable (only meaningful in story phase)
  const prev = document.getElementById("prev"), next = document.getElementById("next");
  if (prev) prev.disabled = step === 0;
  if (next) next.textContent = step === STORY_STEPS - 1 ? "Explore →" : "Next →";
  document.getElementById("replay").hidden = phase !== "explore";
}
function goStep(n) {
  step = Math.max(0, Math.min(STORY_STEPS - 1, n));
  phase = "story"; origin = null;
  showFullNet = false;                       // don't bleed the explore net toggle back into the story
  const nf = document.getElementById("net-full"); if (nf) nf.checked = false;
  document.getElementById("panel").hidden = true;
  syncChrome(); draw();
}
function goExplore() {
  phase = "explore"; step = 4; activeMode = "walk"; origin = null;
  document.getElementById("panel").hidden = true;
  syncChrome(); draw();
}
function replay() { goStep(0); }

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
  const busRow0 = document.querySelector("#net-key .k-bus-row");
  if (!trunkbus && busRow0) busRow0.remove();

  resize();
  syncChrome(); draw();

  // mode pills (explore only; story forces the mode, so guard in JS not just CSS)
  document.querySelectorAll("#modes button").forEach(btn => btn.onclick = () => {
    if (phase !== "explore") return;
    activeMode = btn.dataset.mode;
    document.querySelectorAll("#modes button").forEach(b => b.classList.toggle("active", b === btn));
    if (origin) showPanel(origin);
    draw();
  });

  // story navigation
  document.getElementById("next").onclick = () => step === STORY_STEPS - 1 ? goExplore() : goStep(step + 1);
  document.getElementById("prev").onclick = () => goStep(step - 1);
  document.getElementById("skip-map").onclick = goExplore;
  document.getElementById("replay").onclick = replay;
  window.addEventListener("keydown", e => {
    if (phase !== "story") return;
    if (e.key === "ArrowRight") document.getElementById("next").click();
    if (e.key === "ArrowLeft") document.getElementById("prev").click();
  });
  // desktop scroll advances the story (wheel), throttled by a small lock
  let wheelLock = false;
  window.addEventListener("wheel", e => {
    if (phase !== "story" || wheelLock) return;
    wheelLock = true; setTimeout(() => wheelLock = false, 450);
    if (e.deltaY > 0) document.getElementById("next").click();
    else if (e.deltaY < 0 && step > 0) document.getElementById("prev").click();
  }, { passive: true });

  // network toggle
  const busRow2 = document.querySelector("#net-key .k-bus-row");
  document.getElementById("net-full").onchange = e => {
    showFullNet = e.target.checked;
    if (trunkbus && busRow2) busRow2.hidden = !showFullNet;
    draw();
  };

  // explore interaction: hover highlight + click sets origin
  canvas.onmousemove = e => {
    if (phase !== "explore") return;
    const r = canvas.getBoundingClientRect();
    const hit = pickCell(cells, e.clientX - r.left, e.clientY - r.top, R);
    canvas.style.cursor = hit ? "pointer" : "default"; draw(hit);
  };
  canvas.onclick = e => {
    if (phase !== "explore") return;
    const r = canvas.getBoundingClientRect();
    const hit = pickCell(cells, e.clientX - r.left, e.clientY - r.top, R);
    if (hit) { origin = hit; showPanel(hit); syncChrome(); draw(); }  // syncChrome hides the step-4 intro
  };
  document.getElementById("close-panel").onclick = () => { origin = null; document.getElementById("panel").hidden = true; syncChrome(); draw(); };
  window.addEventListener("resize", () => { resize(); draw(); });
}

// Only boot the app when the page actually has the map canvas (not in the helper test harness).
if (canvas) {
  const mt = document.getElementById("method-toggle"), md = document.getElementById("method");
  mt.onclick = () => { const open = md.open = !md.open; mt.setAttribute("aria-expanded", String(open)); mt.textContent = open ? "How this works ▴" : "How this works ▾"; };
  boot();
}
