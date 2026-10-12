
// Mimics GeoLibre's loader: fetch entry text -> Blob -> import(blobUrl).
const out = document.getElementById("out");
try {
  const src = await (await fetch("../dist/smoke.js")).text();
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const m = await import(url);
  URL.revokeObjectURL(url);
  const h = await m.getDuckDbInline({ wasmUrl: new URL("../dist/duckdb-eh.wasm", location.href).href });
  await h.exec(`CREATE TABLE detectors_sim(oid INT, eid VARCHAR, t_start_min INT, dur_min INT, flow DOUBLE);
    CREATE TABLE detectors_obs(detector_id VARCHAR, t_start_min INT, dur_min INT, flow DOUBLE);
    INSERT INTO detectors_sim VALUES (1,'A',0,60,1100),(2,'B',0,60,500);
    INSERT INTO detectors_obs VALUES ('A',0,60,1000),('B',0,60,1000);`);
  await m.installViews(h, { only: ["det"] });
  const rows = await h.query("SELECT detector_id, geh, status FROM v_det_validation ORDER BY 1");
  const sum = await h.query("SELECT n, rmse, pct_geh_lt5 FROM v_det_summary");
  const svg = m.scatterSvg([1000, 1000], [1100, 500], { trend: null });
  out.textContent = "OK " + JSON.stringify({ rows, sum, svgLen: svg.length });
} catch (e) { out.textContent = "FAIL " + (e && e.stack || e); }
