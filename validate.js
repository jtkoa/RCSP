// Usage: put real addresses (one per line) in demo-addresses.txt, then run: npm run validate
// Only properties that the live county lookup resolves to exactly one non-condo record are saved to demo-properties.json.
const fs = require("fs"), { lookup, property } = require("./server.js");
(async () => {
  const lines = fs.readFileSync("demo-addresses.txt", "utf8").split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#"));
  const out = [];
  for (const a of lines) {
    try {
      const m = (await lookup(a)).matches.filter(x => !x.condo);
      if (m.length !== 1) { console.log(`SKIP  ${a}  (${m.length} matches; be more specific)`); continue; }
      const p = await property(m[0].folio);
      if (!p) { console.log(`SKIP  ${a}  (no parcel record)`); continue; }
      if (p.pieces.municipality !== "ok") { console.log(`SKIP  ${a}  (jurisdiction lookup failed)`); continue; }
      if (p.municipality) { console.log(`SKIP  ${a}  (inside ${p.municipality}, not unincorporated)`); continue; }
      console.log(`OK    ${p.address}  folio ${p.folio}  land use: ${p.landUse || "?"}  zoning: ${p.zoning.map(z => z.zone).join(", ") || "?"}  lot: ${p.lotAreaSqFt} sq ft`);
      out.push({ folio: p.folio, address: p.address, landUse: p.landUse, zoning: p.zoning.map(z => z.zone).join(", "), validatedAt: p.retrieved });
    } catch (e) { console.log(`ERROR ${a}: ${e.message}`); }
  }
  fs.writeFileSync("demo-properties.json", JSON.stringify(out, null, 2));
  console.log(`Saved ${out.length} validated propert${out.length === 1 ? "y" : "ies"} to demo-properties.json. Review land use yourself: RCSP does not decide ADU suitability.`);
})();
