// Downloads the Australian Food Composition Database (FSANZ AFCD) nutrient profiles at build time
// and writes a compact per-100g list to web/afcd.json: [[name, kcal, protein, carbs, fat], ...].
// Never fails the build: on any problem it writes an empty list and the app hides the search.
import { writeFileSync, existsSync, readFileSync } from "node:fs"
import XLSX from "xlsx"

const URL = process.env.AFCD_URL || "https://www.foodstandards.gov.au/sites/default/files/2025-12/AFCD%20Release%203%20-%20Nutrient%20profiles.xlsx"
const OUT = "web/afcd.json"
const r1 = n => Math.round(n * 10) / 10
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

async function main() {
  const res = await fetch(URL, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error("download " + res.status)
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" })
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null })
    const hi = rows.findIndex(r => r && r.some(c => /food name/i.test(String(c || ""))))
    if (hi < 0) continue
    const H = rows[hi].map(c => String(c || "").replace(/\s+/g, " ").trim())
    const col = (...res) => { for (const re of res) { const i = H.findIndex(h => re.test(h)); if (i >= 0) return i } return -1 }
    const iName = col(/^food name/i)
    const iKj = col(/energy.*with dietary fibre.*\(kj\)/i, /^energy.*\(kj\)/i)
    const iP = col(/^protein/i)
    const iF = col(/^fat,? total/i, /^total fat/i)
    const iC = col(/available carbohydrate, with sugar alcohols/i, /available carbohydrate/i, /^carbohydrate/i)
    const iFib = col(/^total dietary fibre/i, /dietary fibre/i), iSug = col(/^total sugars/i, /^sugars/i), iSat = col(/saturated fatty acids.*\(g\)/i, /saturated fat.*\(g\)/i), iNa = col(/^sodium.*\(mg\)/i, /^sodium/i)
    const opt = i => r => i < 0 || r[i] == null || r[i] === "" ? null : num(r[i])
    const gFib = opt(iFib), gSug = opt(iSug), gSat = opt(iSat), gNa = opt(iNa)
    if ([iName, iKj, iP, iF, iC].some(i => i < 0)) { console.log("AFCD: columns not found in", sn, { iName, iKj, iP, iF, iC }); continue }
    const list = []
    for (const r of rows.slice(hi + 1)) {
      if (!r || !r[iName]) continue
      const x = (g, f) => { const v = g(r); return v == null ? null : f(v) }
      list.push([String(r[iName]).trim(), Math.round(num(r[iKj]) / 4.184), r1(num(r[iP])), r1(num(r[iC])), r1(num(r[iF])), x(gFib, r1), x(gSug, r1), x(gSat, r1), x(gNa, Math.round)])
    }
    if (list.length < 100) { console.log("AFCD: too few rows in", sn, list.length); continue }
    writeFileSync(OUT, JSON.stringify(list))
    console.log(`AFCD: wrote ${list.length} foods from sheet "${sn}"`)
    return
  }
  throw new Error("no usable sheet")
}

main().catch(e => {
  console.log("AFCD: skipped (" + (e && e.message) + "). Food search will use saved foods only.")
  if (!existsSync(OUT) || readFileSync(OUT, "utf8").length < 10) writeFileSync(OUT, "[]")
})
