// Every figure the launch story (and any follow-up) cites, from the same
// shape() the widget and facility pages use, so print and tool agree.
// Run the morning a story publishes, after the latest Monday update:
//   cd widget; npm run figures
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addressCase, addressKey, fmtDate, fmtNum, shape, smartTitle, titleCase } from "../src/ledger.js";

const data = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "data");
const read = (name) => JSON.parse(readFileSync(join(data, name), "utf8"));
const db = shape(read("facilities.json"), read("surveys.json"), read("enrichment.json"),
  read("wayback.json"), read("geocodes.json"));
const F = db.facilities;
const S = F.flatMap((f) => f.surveys);
const sum = (xs, fn) => xs.reduce((n, x) => n + fn(x), 0);
const money = (n) => `$${fmtNum(n)}`;
const pct = (a, b) => `${Math.round((100 * a) / b)}%`;
const has = (s, label) => s.enr.sanctions.includes(label);

const enforced = F.filter((f) => f.enforcementCount);
const out = [];
const row = (...cells) => out.push(`| ${cells.join(" | ")} |`);

out.push(`# Care Ledger figures, data as of ${fmtDate(db.lastUpdated)}`, "");
out.push(`- Facilities: ${F.length} (${F.filter((f) => f.closed).length} closed)`);
out.push(`- Enforcement actions: ${sum(F, (f) => f.enforcementCount)}`);
out.push(`- Fines assessed: ${money(sum(F, (f) => f.fineTotal))} (accruing letters at their amount so far)`);
out.push(`- Facilities with an enforcement action: ${enforced.length} of ${F.length} (${pct(enforced.length, F.length)})`);
out.push(`- Inspections: ${S.length}; ${S.filter((s) => s.hasEnforcement).length} led to an enforcement action`);
out.push(`- Complaints substantiated (page-one summaries): ${sum(S, (s) => s.enr.substantiated)}`);
const bans = S.filter((s) => has(s, "Admissions ban"));
const ext = S.filter((s) => has(s, "Admissions ban extended"));
out.push(`- Admissions bans: ${bans.length} new, ${ext.length} extensions, at ` +
  `${new Set([...bans, ...ext].map((s) => s.license)).size} facilities`);
out.push(`- Revocations: ${S.filter((s) => has(s, "Revocation")).length}`);
const held = S.filter((s) => s.expired_from_state);
out.push(`- Records no longer listed by the state: ${held.length} (${held.filter((s) => s.hasEnforcement).length} with enforcement actions)`);
const revised = S.filter((s) => s.revision).length;
out.push(`- Documents the state replaced: on ${revised} ${revised === 1 ? "inspection" : "inspections"}`, "");

out.push("## By county", "");
row("County", "Facilities", "With enforcement", "Share", "Enforcement actions", "Fines assessed");
row("---", "---", "---", "---", "---", "---");
const counties = db.counties
  .map((c) => {
    const fs = F.filter((f) => f.county === c);
    const e = fs.filter((f) => f.enforcementCount).length;
    return { c, n: fs.length, e, actions: sum(fs, (f) => f.enforcementCount), fines: sum(fs, (f) => f.fineTotal) };
  })
  .sort((a, b) => b.fines - a.fines);
for (const r of counties) row(titleCase(r.c), r.n, r.e, pct(r.e, r.n), r.actions, money(r.fines));
out.push("");

out.push("## Largest fine totals", "");
for (const f of [...F].sort((a, b) => b.fineTotal - a.fineTotal).slice(0, 5)) {
  out.push(`- ${smartTitle(f.name)} (${titleCase(f.city)}): ${money(f.fineTotal)} over ` +
    `${f.enforcementCount} enforcement actions${f.closed ? ", closed" : ""}`);
}
out.push("");

out.push("## What inspectors cite (facilities cited at least once)", "");
const cats = {};
for (const s of S) for (const c of s.enr.citations) {
  const r = (cats[c.category] ||= { fac: new Set(), n: 0 });
  r.fac.add(s.license);
  r.n++;
}
for (const [k, v] of Object.entries(cats).sort((a, b) => b[1].fac.size - a[1].fac.size)) {
  out.push(`- ${k}: ${v.fac.size} facilities, ${v.n} citations`);
}
out.push("");

out.push("## Operators with the most enforcement actions (state roster name)", "");
const ops = {};
for (const f of F) if (f.corporate_name) {
  const r = (ops[f.corporate_name] ||= { n: 0, a: 0, fines: 0 });
  r.n++;
  r.a += f.enforcementCount;
  r.fines += f.fineTotal;
}
for (const [k, v] of Object.entries(ops).sort((a, b) => b[1].a - a[1].a).slice(0, 6)) {
  out.push(`- ${smartTitle(k)}: ${v.n} facilities, ${v.a} enforcement actions, ${money(v.fines)}`);
}
out.push("");

out.push("## Same address: a closed facility and a newer license", "");
const byAddr = {};
for (const f of F) (byAddr[addressKey(f)] ||= []).push(f);
for (const group of Object.values(byAddr)) {
  if (group.length < 2 || !group.some((f) => f.closed)) continue;
  out.push("- " + group
    .map((f) => `${smartTitle(f.name)} (${f.license}${f.closed ? `, closed ${fmtDate(f.date_closed) || "date unknown"}` : ""})`)
    .join(" · ") + ` — ${addressCase(group[0].address.replace(/\s+/g, " "))}, ${titleCase(group[0].city)}`);
}

console.log(out.join("\n"));
