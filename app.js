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

map.on("load", async () => {
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
  document.getElementById("summary").textContent =
    `${m.completeness}/5 reachable by ${activeMode}. Worst: ${m.binding_function}.`;
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
