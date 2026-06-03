// The 15-Minute Helsinki — static choropleth + per-cell breakdown.
const FUNCTIONS = ["working", "supplying", "caring", "learning", "enjoying"];
// completeness 0..5 -> color ramp (red -> green)
const RAMP = ["#777777", "#d73027", "#fc8d59", "#fee08b", "#d9ef8b", "#1a9850"];
let activeMode = "walk";

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  center: [24.94, 60.19], // Helsinki
  zoom: 10,
});

function colorExpr(mode) {
  // data-driven: read modes[mode].completeness off each feature
  return [
    "step",
    ["get", "completeness", ["get", mode, ["get", "modes"]]],
    RAMP[0], 1, RAMP[1], 2, RAMP[2], 3, RAMP[3], 4, RAMP[4], 5, RAMP[5],
  ];
}

// Legend swatches are generated from RAMP so the key can never drift from the map.
function buildLegend() {
  const scale = document.getElementById("legend-scale");
  scale.innerHTML = "";
  RAMP.forEach((color, i) => {
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = color;
    sw.title = `${i} of 5 needs reachable`;
    scale.appendChild(sw);
  });
}

// "How this works" expander — toggles the <details> and the aria state.
const methodToggle = document.getElementById("method-toggle");
const methodDetails = document.getElementById("method");
methodToggle.onclick = () => {
  const open = methodDetails.open = !methodDetails.open;
  methodToggle.setAttribute("aria-expanded", String(open));
  methodToggle.textContent = open ? "How this works ▴" : "How this works ▾";
};

map.on("load", async () => {
  buildLegend();
  // Lightweight published dataset (rounded minutes, empty cells dropped).
  // The full-precision scored_grid.geojson stays in the repo as source of truth.
  const res = await fetch("scored_grid.min.geojson");
  const data = await res.json();
  map.addSource("grid", { type: "geojson", data });
  map.addLayer({
    id: "cells", type: "fill", source: "grid",
    paint: { "fill-color": colorExpr(activeMode), "fill-opacity": 0.75,
             "fill-outline-color": "rgba(0,0,0,0.15)" },
  });

  document.querySelectorAll("#modes button").forEach((btn) => {
    btn.onclick = () => {
      activeMode = btn.dataset.mode;
      document.querySelectorAll("#modes button").forEach((b) =>
        b.classList.toggle("active", b === btn));
      map.setPaintProperty("cells", "fill-color", colorExpr(activeMode));
    };
  });

  map.on("click", "cells", (e) => showPanel(e.features[0].properties));
  map.on("mouseenter", "cells", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "cells", () => (map.getCanvas().style.cursor = ""));
});

function showPanel(props) {
  // MapLibre serializes nested props to JSON strings — parse modes back.
  const modes = typeof props.modes === "string" ? JSON.parse(props.modes) : props.modes;
  const m = modes[activeMode];
  document.getElementById("cell-id").textContent = props.cell_id;
  // binding_function is the slowest-OR-missing function. It only names a real
  // constraint when something is missing; on a complete (5/5) cell every need is
  // met, so naming a satisfied need "worst" is misleading — say so instead.
  document.getElementById("summary").textContent =
    m.completeness === FUNCTIONS.length
      ? `${m.completeness}/5 reachable by ${activeMode}. All needs met.`
      : `${m.completeness}/5 reachable by ${activeMode}. Missing first: ${m.binding_function}.`;
  const ul = document.getElementById("functions");
  ul.innerHTML = "";
  for (const fn of FUNCTIONS) {
    const mins = m.min[fn];
    const reachable = mins != null && mins <= 15;
    const li = document.createElement("li");
    if (!reachable) li.className = "miss";
    li.innerHTML = `<span>${fn}</span><span>${
      mins == null ? "—" : Math.round(mins) + " min"
    } ${reachable ? "✓" : "✗"}</span>`;
    ul.appendChild(li);
  }
  document.getElementById("panel").hidden = false;
}
document.getElementById("close-panel").onclick = () =>
  (document.getElementById("panel").hidden = true);
