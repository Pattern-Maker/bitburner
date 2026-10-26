import { CONFIG } from "./batch/config.js";

/**
 * Writes a diagnostics report: what every part of the suite is doing and how
 * well, plus the facts about your game it depends on. Paste it to Claude to
 * have the suite tuned on your real numbers.
 *
 *   run report.js        print it and save it to report.txt
 * @param {NS} ns
 */
export async function main(ns) {
  const peek = (port) => {
    const d = ns.peek(port);
    return d === "NULL PORT DATA" ? null : d;
  };
  const now = Date.now();
  const age = (d) => (d?.updated ? `${Math.round((now - d.updated) / 1000)}s ago` : "never");
  const lines = [];
  const out = (s = "") => lines.push(s);
  const num = (n) => (typeof n === "number" ? ns.format.number(n) : String(n));

  // ---- game ----
  const info = ns.ui.getGameInfo();
  const reset = ns.getResetInfo();
  const p = ns.getPlayer();
  const sfs = [...reset.ownedSF.entries()].map(([n, l]) => `${n}.${l}`).join(" ") || "none";
  out(`== Bitburner report ==  ${new Date(now).toISOString()}`);
  out(`Game ${info.version} (${info.platform ?? "?"})  BitNode ${reset.currentNode}  Source-Files: ${sfs}`);
  out(`Hacking ${p.skills.hacking}  money $${num(p.money)}  Formulas.exe ${ns.fileExists("Formulas.exe", "home") ? "yes" : "no"}`);
  out(`Since last augment install: ${ns.format.time(now - reset.lastAugReset)}`);
  const home = ns.getServer("home");
  out(`Home ${ns.format.ram(home.maxRam)} (${home.cpuCores} cores), ${ns.format.ram(home.ramUsed)} used`);

  // ---- batcher ----
  const b = peek(CONFIG.ports.batcher);
  out("");
  if (!b) out("Batcher: not reporting (is start.js running?)");
  else {
    const s = b.session;
    const secs = Math.max(1, (now - s.start) / 1000);
    out(`Batcher (updated ${age(b)}):`);
    out(`  RAM ${ns.format.ram(b.totalRam)} on ${b.hosts} servers = ${num(b.capacity)} threads; workers ${b.workers}/${b.maxWorkers}`);
    if (b.usage) out(`  plan uses ${((b.usage.used / Math.max(1, b.usage.capacity)) * 100).toFixed(1)}% of threads, slots ${b.usage.slotsUsed}/${b.usage.slots}`);
    out(`  gap ${b.spacing} ms, buffer ${b.buffer} ms`);
    if (b.lateStats) out(`  lateness p50 ${b.lateStats.p50} ms, p99 ${b.lateStats.p99} ms, max ${b.lateStats.max} ms (n=${b.lateStats.n})`);
    if (b.planStats) out(`  planner ${b.planStats.targets} targets, ${b.planStats.ms} ms over ${b.planStats.ticks} ticks`);
    if (b.stalls?.count) out(`  stalls ${b.stalls.count}, last ${Math.round(b.stalls.lastMs / 1000)}s long, ${Math.round((now - b.stalls.lastAt) / 1000)}s ago`);
    if (b.share) out(`  sharing ${num(b.share.threads)} threads, rep x${b.share.power.toFixed(3)}, reserve ${(b.share.reserve * 100).toFixed(0)}%, reclaims ${b.share.reclaims}`);
    if (b.lastError) out(`  last error ${Math.round((now - b.lastError.at) / 1000)}s ago on ${b.lastError.target}: ${b.lastError.message}`);
    out(`  session $${num(s.money)} in ${ns.format.time(secs * 1000)} ($${num(s.money / secs)}/s), batches ${s.batches}, re-preps ${s.desyncs}, late hacks skipped ${s.aborted}`);
    let expected = 0;
    for (const l of b.lanes) {
      const st = `${l.target} ${l.mode} sec+${(l.sec - l.minSec).toFixed(2)} money ${((l.cash / l.maxCash) * 100).toFixed(1)}% of $${num(l.maxCash)} workers ${l.workers} re-preps ${l.desyncs}`;
      if (l.plan) {
        expected += l.plan.rate * 1000;
        out(`  - ${st}`);
        out(`      H${l.plan.h} W${l.plan.w1} G${l.plan.g} W${l.plan.w2} f=${(l.plan.f * 100).toFixed(2)}% P=${Math.round(l.plan.P)}ms inflight=${l.plan.inFlight} threads=${num(l.plan.conc)} budget=${num(l.budget)} expect $${num(l.plan.rate * 1000)}/s got $${num(l.recentRate ?? 0)}/s`);
      } else out(`  - ${st}${l.prep ? ` prep W${l.prep.w1} G${l.prep.g} W${l.prep.w2}` : ""}`);
    }
    out(`  expected total $${num(expected)}/s`);
  }

  // ---- the rest ----
  const section = (name, d, fmt) => {
    out("");
    out(d ? `${name} (updated ${age(d)}): ${fmt(d)}` : `${name}: not running`);
  };
  section("Crawler", peek(CONFIG.ports.crawler), (c) => `rooted ${c.rooted}/${c.total}, programs ${c.ownedPrograms}/5${c.nextProgram ? `, next ${c.nextProgram}` : ""}`);
  section("Buyer", peek(CONFIG.ports.buyer), (d) => `${d.state}: ${d.note}`);
  section("Singularity", peek(CONFIG.ports.singularity), (d) => `backdoored ${d.backdoored.length}, ${d.remaining ?? 0} left; home: ${d.home?.note ?? "-"}${d.error ? `; error: ${d.error}` : ""}`);
  section("Training", peek(CONFIG.ports.train), (d) => `${d.state} ${d.stat ?? ""} total ${d.total ?? "?"}/${d.goal ?? "?"} ${d.note ?? ""}`);
  section("Contracts", peek(CONFIG.ports.contracts), (d) => `solved ${d.solved}, failed ${d.failed.length}${d.failed.length ? ` (${d.failed.map((f) => f.type).join(", ")})` : ""}, unknown types ${d.unknown.length}`);
  section("Hacknet", peek(CONFIG.ports.hacknet), (d) => `${d.state}: ${d.nodes ?? 0} nodes, $${num(d.income ?? 0)}/s, bought ${d.bought ?? 0}; ${d.note}`);

  // ---- processes and settings ----
  out("");
  out("Running on home:");
  for (const proc of ns.ps("home")) out(`  ${proc.filename} ${proc.args.join(" ")} (${proc.threads}t)`);
  out("");
  out("Settings: " + JSON.stringify({ ...CONFIG, ports: undefined, workers: undefined }));
  const version = ns.read("update/version.txt").trim();
  out(`Installed commit: ${version ? version.slice(0, 7) : "unknown (not installed with update.js)"}`);

  const text = lines.join("\n");
  ns.write("report.txt", text, "w");
  ns.tprint("\n" + text);
  ns.tprint("Saved to report.txt. Copy everything above and paste it to Claude.");
}
