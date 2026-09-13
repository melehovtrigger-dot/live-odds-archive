/**
 * live_collect.mjs — long-running live odds collector built for hosting.
 *
 * The naive "one snapshot per poll with every market" format costs ~100 MB/day,
 * which no host keeps for weeks. This collector instead emits a record only when
 * something actually changed for a match (odds or score), plus a periodic
 * heartbeat so we still see that a match was still being tracked.
 *
 * Config (env):
 *   INTERVAL_SEC    poll interval              (default 30)
 *   OUT_DIR         output directory           (default data/live)
 *   HEARTBEAT_MIN   force a record this often  (default 10)
 *   DURATION_MIN    stop after N minutes, 0 = run forever (default 0)
 *   MAX_MB_PER_DAY  rotate/skip safeguard      (default 200)
 *
 * Output: <OUT_DIR>/YYYY-MM-DD.jsonl, one compact JSON object per line:
 *   {ts,id,sport,t1,t2,k1,k2,score,timer,tb}
 *
 *   node scripts/live_collect.mjs            # run forever (container)
 *   DURATION_MIN=1 node scripts/live_collect.mjs   # smoke test
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DSH_BETTING_DATA || path.resolve(HERE, "data");

const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || 30);
const OUT_DIR = process.env.OUT_DIR || path.join(DATA, "live");
const HEARTBEAT_MIN = Number(process.env.HEARTBEAT_MIN || 10);
const DURATION_MIN = Number(process.env.DURATION_MIN || 0);
const MAX_MB_PER_DAY = Number(process.env.MAX_MB_PER_DAY || 200);
/**
 * ONCE=1 (or --once): do a single poll, persist the change-detection state and
 * exit. This is what makes shared hosting possible — Jino's panel cron runs at
 * most once a minute and each run is a fresh process, so the "has this match
 * changed?" memory has to survive on disk instead of in RAM.
 */
const ONCE = process.env.ONCE === "1" || process.argv.includes("--once");
const STATE_FILE = path.join(OUT_DIR, ".state.json");

const API = "https://line-lb51.bk6bba-resources.com/events/list?lang=ru&scopeMarket=1600";
const HEARTBEAT_MS = HEARTBEAT_MIN * 60_000;

fs.mkdirSync(OUT_DIR, { recursive: true });

/* ------------------------------ helpers ------------------------------ */

const dayFile = (d = new Date()) => path.join(OUT_DIR, `${d.toISOString().slice(0, 10)}.jsonl`);

let bytesToday = (() => {
  try { return fs.statSync(dayFile()).size; } catch { return 0; }
})();
let currentDay = new Date().toISOString().slice(0, 10);

function emit(obj) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== currentDay) { currentDay = day; bytesToday = 0; }   // rolled over
  if (bytesToday > MAX_MB_PER_DAY * 1e6) return;                  // safeguard
  const line = JSON.stringify(obj) + "\n";
  fs.appendFileSync(dayFile(), line);
  bytesToday += Buffer.byteLength(line);
}

function parseTennis(scores) {
  let sets1 = 0, sets2 = 0, games1 = 0, games2 = 0, server = null, inTB = false, p1 = "", p2 = "";
  for (const s of scores ?? []) {
    const arr = Array.isArray(s) ? s : [s];
    const f = arr[0];
    if (!f) continue;
    const t = f.title ? String(f.title) : "";
    if (/сет/i.test(t)) {
      const c = arr[arr.length - 1];
      games1 = Number(c.c1) || 0;
      games2 = Number(c.c2) || 0;
      if (games1 === 6 && games2 === 6) inTB = true;
    } else if (/гейм/i.test(t)) {
      server = f.serve;
      p1 = String(f.c1 ?? ""); p2 = String(f.c2 ?? "");
      if (/тай-брейк/i.test(String(f.comment ?? ""))) inTB = true;
    } else {
      sets1 = Number(f.c1) || 0;
      sets2 = Number(f.c2) || 0;
    }
  }
  return { sets1, sets2, games1, games2, server, inTB, p1, p2, score: `${sets1}-${sets2}/${games1}-${games2}/${p1}-${p2}` };
}

function parseBasketball(scores) {
  let total1 = 0, total2 = 0;
  const quarters = [];
  for (const s of scores ?? []) {
    const arr = Array.isArray(s) ? s : [s];
    for (const o of arr) {
      if (!o || typeof o !== "object") continue;
      const t = o.title ? String(o.title) : "";
      if (/четверть/i.test(t)) quarters.push(`${o.c1}-${o.c2}`);
      else if (t === "") { total1 = Number(o.c1) || 0; total2 = Number(o.c2) || 0; }
    }
  }
  const done = quarters.filter((q) => q !== "0-0").length;
  return { total1, total2, quarter: done, score: `${total1}-${total2}/q${done}` };
}

/* ------------------------------ state ------------------------------ */

const last = new Map();   // matchId -> {sig, emittedAt}
let polls = 0, records = 0, errors = 0;
const started = Date.now();

/** change-detection memory must survive between cron runs */
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const [k, v] of Object.entries(s)) last.set(k, v);
    console.log(`состояние загружено: ${last.size} матчей`);
  } catch { /* first run */ }
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(last)));
  } catch (e) {
    console.error(`не удалось сохранить состояние: ${e.message}`);
  }
}
loadState();

async function poll() {
  const res = await fetch(API, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();

  const ev = {};
  for (const e of j.events ?? []) ev[e.id] = e;
  const odds = {};
  for (const cf of j.customFactors ?? []) {
    const m = {};
    for (const f of cf.factors ?? []) m[f.f] = f.v;
    odds[cf.e] = m;
  }

  const now = Date.now();
  let emitted = 0;

  for (const li of j.liveEventInfos ?? []) {
    const e = ev[li.eventId];
    if (!e) continue;
    const o = odds[li.eventId] ?? {};
    const k1 = Number(o[921]) || null;
    const k2 = Number(o[923]) || null;
    if (!k1 || !k2) continue;                      // no moneyline, nothing to track
    const sport = /basket/i.test(li.scoreFunction) ? "basketball" : /tennis/i.test(li.scoreFunction) ? "tennis" : null;
    if (!sport) continue;

    const sc = sport === "tennis" ? parseTennis(li.scores) : parseBasketball(li.scores);
    const sig = `${k1}|${k2}|${sc.score}`;
    const prev = last.get(li.eventId);
    const changed = !prev || prev.sig !== sig;
    const stale = !prev || now - prev.emittedAt > HEARTBEAT_MS;
    if (!changed && !stale) continue;

    emit({
      ts: new Date(now).toISOString(),
      id: li.eventId,
      sport,
      t1: e.team1, t2: e.team2,
      k1, k2,
      score: sc.score,
      timer: li.timer ?? null,
      tb: sc.inTB ?? false,
      ...(sport === "basketball" ? { q: sc.quarter, tot: sc.total1 + sc.total2 } : {}),
    });
    last.set(li.eventId, { sig, emittedAt: now });
    emitted++;
  }

  polls++;
  records += emitted;
  for (const id of [...last.keys()]) {
    if (!(j.liveEventInfos ?? []).some((li) => li.eventId === id)) last.delete(id);  // match ended
  }
  const mb = (bytesToday / 1e6).toFixed(2);
  console.log(`${new Date().toISOString()} poll #${polls} live=${(j.liveEventInfos ?? []).length} emitted=${emitted} today=${mb}MB`);
}

async function main() {
  console.log(`collector started | interval ${INTERVAL_SEC}s | out ${OUT_DIR} | heartbeat ${HEARTBEAT_MIN}min | ${ONCE ? "SINGLE POLL" : `duration ${DURATION_MIN || "∞"}min`}`);

  if (ONCE) {
    try {
      await poll();
    } catch (err) {
      errors++;
      console.error(`${new Date().toISOString()} poll failed: ${err.message}`);
      saveState();
      process.exit(1);
    }
    saveState();
    console.log(`done | records ${records} | errors ${errors}`);
    return;
  }

  let stop = false;
  const shutdown = () => { stop = true; console.log("shutdown requested, finishing current poll..."); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stop) {
    try {
      await poll();
    } catch (err) {
      errors++;
      console.error(`${new Date().toISOString()} poll failed: ${err.message}`);
      if (errors % 10 === 0) console.error(`(${errors} errors so far — continuing)`);
    }
    if (DURATION_MIN && (Date.now() - started) / 60000 >= DURATION_MIN) break;
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
  }

  saveState();
  console.log(`stopped | polls ${polls} | records ${records} | errors ${errors} | runtime ${Math.round((Date.now() - started) / 60000)}min`);
}

main();
