// RCSP live server: serves the page and proxies Miami-Dade Property Appraiser GIS (ArcGIS REST). Node 18+, no dependencies.
const http = require("http"), fs = require("fs"), path = require("path");
const B = "https://gisfs.miamidade.gov/mdarcgis/rest/services/MD_PA_PropertySearch/MapServer";
// Layers (verified in the service directory): 8 GeoProp (FOLIO, address, zipcode), 6 PaParcel (FOLIO, TRUE_SITE_ADDR, geometry),
// 4 Zone_poly_U (ZONE, ZONE_DESC), 2 MunicipalityCoastal_poly (NAME), 16 Zoning Land Use (existing land use, DESCR)
const SUF = { STREET: "ST", AVENUE: "AVE", ROAD: "RD", DRIVE: "DR", COURT: "CT", LANE: "LN", BOULEVARD: "BLVD", TERRACE: "TER", PLACE: "PL", HIGHWAY: "HWY", CIRCLE: "CIR", NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", NORTHWEST: "NW", NORTHEAST: "NE", SOUTHWEST: "SW", SOUTHEAST: "SE" };

async function q(layer, params) {
  const u = new URL(`${B}/${layer}/query`);
  u.search = new URLSearchParams({ f: "json", ...params });
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("County service HTTP " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "County service error");
  return j.features || [];
}

function parse(raw) {
  const s = String(raw || "").trim();
  const digits = s.replace(/[-\s]/g, "");
  if (/^\d{13}$/.test(digits)) return { folio: digits };
  const zip = (s.match(/\b(33\d{3})\b/) || [])[1];
  const toks = s.split(",")[0].toUpperCase().replace(/[^A-Z0-9 -]/g, " ").split(/\s+/).filter(Boolean)
    .filter(t => t !== "FL" && t !== "FLORIDA" && !/^33\d{3}$/.test(t))
    .map(t => SUF[t] || t.replace(/^(\d+)(ST|ND|RD|TH)$/, "$1"));
  if (!toks.length || !/^\d+$/.test(toks[0])) return { error: "needs_number" };
  return { hn: toks[0], rest: toks.slice(1), zip };
}

async function lookup(raw) {
  const p = parse(raw);
  if (p.error) return { matches: [], hint: p.error };
  const cols = "FOLIO,address,zipcode,condoflg,subunit";
  let feats = [];
  if (p.folio) feats = await q(8, { where: `FOLIO='${p.folio}'`, outFields: cols, returnGeometry: "false", resultRecordCount: "15" });
  else {
    // try all street tokens first, then drop trailing tokens (e.g. a city name typed without a comma)
    for (let n = p.rest.length; n >= 1 && !feats.length; n--) {
      const w = [`UPPER(address) LIKE '${p.hn} %'`, ...p.rest.slice(0, n).map(t => `UPPER(address) LIKE '%${t}%'`)];
      if (p.zip) w.push(`zipcode=${Number(p.zip)}`);
      feats = await q(8, { where: w.join(" AND "), outFields: cols, returnGeometry: "false", resultRecordCount: "15" });
    }
  }
  const seen = new Set(), matches = [];
  for (const f of feats) {
    const a = f.attributes;
    if (seen.has(a.FOLIO)) continue;
    seen.add(a.FOLIO);
    matches.push({ folio: a.FOLIO, address: [a.address, a.subunit].filter(Boolean).join(" "), zip: a.zipcode, condo: a.condoflg === "Y" });
  }
  return { matches };
}

function centroid(r) {
  let A = 0, x = 0, y = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const c = r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    A += c; x += (r[i][0] + r[i + 1][0]) * c; y += (r[i][1] + r[i + 1][1]) * c;
  }
  return A ? [x / (3 * A), y / (3 * A)] : r[0];
}

async function property(folio) {
  if (!/^\d{13}$/.test(folio)) throw Object.assign(new Error("Folio must be 13 digits"), { code: "bad" });
  const f = await q(6, { where: `FOLIO='${folio}'`, outFields: "*", returnGeometry: "true", outSR: "4326" });
  if (!f.length) return null;
  const a = f[0].attributes, rings = (f[0].geometry && f[0].geometry.rings) || [];
  const [lon, lat] = rings.length ? centroid(rings[0]) : [null, null];
  const latFt = 364567, lonFt = latFt * Math.cos((lat * Math.PI) / 180);
  const ringsFt = rings.map(r => r.map(([x, y]) => [+((x - lon) * lonFt).toFixed(1), +((y - lat) * latFt).toFixed(1)]));
  const areaCalc = Math.abs(ringsFt.reduce((s, r) => s + r.slice(0, -1).reduce((t, p, i) => t + p[0] * r[i + 1][1] - r[i + 1][0] * p[1], 0) / 2, 0));
  const k = Object.keys(a).find(x => /STArea/i.test(x));
  const areaGis = k && a[k] ? Number(a[k]) : null;
  const pt = { geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects", returnGeometry: "false" };
  const [z, m, lu] = await Promise.allSettled([
    q(4, { ...pt, outFields: "ZONE,ZONE_DESC,MUNC,OVLY" }), q(2, { ...pt, outFields: "NAME,MUNICID" }), q(16, { ...pt, outFields: "LU,DESCR" })]);
  const st = x => (x.status === "fulfilled" ? "ok" : "error");
  const zones = z.status === "fulfilled" ? [...new Map(z.value.map(x => [x.attributes.ZONE, { zone: x.attributes.ZONE, desc: x.attributes.ZONE_DESC }])).values()] : [];
  return {
    folio, address: a.TRUE_SITE_ADDR, condo: a.CONDO_FLAG === "Y", parentFolio: a.PARENT_FOLIO || null,
    lotAreaSqFt: Math.round(areaGis || areaCalc) || null, areaCalcSqFt: Math.round(areaCalc), areaFromGis: !!areaGis,
    areaConflict: !!areaGis && areaCalc > 0 && Math.abs(areaGis - areaCalc) / areaCalc > 0.15,
    lat, lon, ringsFt, zoning: zones,
    municipality: m.status === "fulfilled" && m.value.length ? m.value[0].attributes.NAME : null,
    landUse: lu.status === "fulfilled" && lu.value.length ? lu.value[0].attributes.DESCR : null,
    pieces: { zoning: st(z), municipality: st(m), landUse: st(lu) }, retrieved: new Date().toISOString(), source: B
  };
}

async function ai(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 1200, messages: [{ role: "user", content: prompt }] }) });
  if (!r.ok) throw new Error("AI HTTP " + r.status);
  return (await r.json()).content.map(c => c.text || "").join("");
}

const send = (res, code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html"))); }
    if (u.pathname === "/api/lookup") return send(res, 200, await lookup(u.searchParams.get("q")));
    if (u.pathname === "/api/property") { const p = await property(u.searchParams.get("folio") || ""); return p ? send(res, 200, p) : send(res, 404, { code: "none" }); }
    if (u.pathname === "/api/demos") { const f = path.join(__dirname, "demo-properties.json"); return send(res, 200, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []); }
    if (u.pathname === "/api/ai" && req.method === "POST") {
      let b = ""; for await (const c of req) b += c;
      const t = await ai(JSON.parse(b).prompt);
      return t === null ? send(res, 501, { code: "no_key" }) : send(res, 200, { text: t });
    }
    send(res, 404, { code: "nf" });
  } catch (e) { send(res, e.code === "bad" ? 400 : 502, { code: "upstream", error: e.message }); }
});
if (require.main === module) { const P = process.env.PORT || 3000; server.listen(P, () => console.log("RCSP on http://localhost:" + P)); }
module.exports = { parse, lookup, property };
