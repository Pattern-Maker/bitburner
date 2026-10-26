import { CONFIG, loadConfig } from "./config.js";

/**
 * Live dashboard in a tail window. Reads what the batcher and crawler publish.
 * @param {NS} ns
 */
export async function main(ns) {
  loadConfig(ns);
  ns.disableLog("ALL");
  // Only pop the window open when asked (start.js does this once). A restart
  // after a crash stays quiet; open it yourself any time with: tail batch/status.js
  if (ns.args.includes("--tail")) {
    ns.ui.openTail();
    ns.ui.resizeTail(680, 600);
  }
  ns.ui.setTailTitle("Batcher status");
  const f = ns.format;
  // ns.format.money doesn't exist in 3.0.1, so build it from ns.format.number.
  const money = (n) => (n < 0 ? "-$" : "$") + f.number(Math.abs(n));

  while (true) {
    try {
      render(ns, f, money);
    } catch (e) {
      ns.print(`Status display error: ${e?.message ?? e}`);
    }
    await ns.sleep(1000);
  }
}

function render(ns, f, money) {
  const b = ns.peek(CONFIG.ports.batcher);
  const c = ns.peek(CONFIG.ports.crawler);
  ns.clearLog();
  const now = Date.now();

  if (b === "NULL PORT DATA") {
    ns.print("Waiting for the batcher to report...");
  } else {
    const s = b.session;
    const elapsed = Math.max(1, (now - s.start) / 1000);
    ns.print(`== Batcher ==   ${b.formulas ? "Formulas.exe: exact + level prediction" : "no Formulas.exe: live values"}`);
    ns.print(`  RAM         ${f.ram(b.totalRam)} on ${b.hosts} servers = ${f.number(b.capacity, 0)} worker threads`);
    const tune = b.slotTune && b.slotTune.phase !== "idle" ? ", trying a higher cap" : "";
    ns.print(`  Workers     ${f.number(b.workers, 0)} running (cap ${f.number(b.maxWorkers, 0)}${tune})`);
    if (b.usage && b.usage.capacity > 0) {
      const u = b.usage;
      ns.print(`  In use      ${f.percent(u.used / u.capacity, 0)} of threads, ${f.number(u.slotsUsed, 0)} / ${f.number(u.slots, 0)} batch slots`);
      if (u.limit === "slots") {
        ns.print(`              limit: script slots. Raise maxWorkerScripts if lateness stays low`);
      } else if (u.limit === "targets") {
        ns.print(`              limit: targets. All ${u.considered} considered targets get every thread that still adds income`);
        ns.print(`              (each can land one batch per 4 landing gaps); the rest is lent to factions`);
      }
    }
    if (b.share) {
      const sh = b.share;
      const homeNote = sh.homeShareGB > 0 ? ` (${f.number(sh.homeThreads ?? 0, 0)} on home, ${f.percent(sh.homeShareGB / Math.max(1, sh.homeRam), 0)} of it)` : "";
      if (sh.xpThreads > 0) {
        ns.print(`  XP          ${f.number(sh.xpThreads, 0)} spare threads weakening ${sh.xpTarget ?? "?"} for hacking exp (level ${b.level ?? "?"})`);
        if (sh.why) ns.print(`              ${sh.why}`);
      }
      if (sh.threads > 0) ns.print(`  Sharing     ${f.number(sh.threads, 0)} threads${homeNote}: faction rep x${sh.power.toFixed(3)} while you work for a faction`);
      else if (sh.reserve > 0.11) ns.print(`  Sharing     holding back ${f.percent(sh.reserve, 0)} of threads after batches needed RAM`);
    }
    ns.print(`  Timing      ${b.spacing} ms gap, ${b.buffer} ms launch buffer, replan in ${f.time(Math.max(0, b.nextReplan - now))}`);
    if (b.lagStats) {
      const L = b.lagStats;
      const M = b.missStats;
      const missed = M && M.landed ? `, ${f.number(M.missed, 0)} of ${f.number(M.landed, 0)} missed their slot` : "";
      ns.print(`  Launch lag  typical ${Math.round(L.p50)} ms, worst 1% ${Math.round(L.p99)} ms${missed}`);
    }
    if (b.lateStats) {
      const L = b.lateStats;
      ns.print(`  Game lag    landings resolve ~${Math.round(L.p50)} ms late (worst 1% ${Math.round(L.p99)} ms); harmless, order is kept`);
    }
    if (b.planStats) {
      const p = b.planStats;
      ns.print(`  Planner     ${p.targets} targets weighed in ${f.time(p.ms)} over ${p.ticks} ticks${b.planning ? "  (replanning now)" : ""}`);
    }
    if (b.lastError && now - b.lastError.at < 600000) {
      ns.print(`  Error       ${b.lastError.target}: ${b.lastError.message} (${f.time(now - b.lastError.at)} ago, recovered)`);
    }
    if (b.stalls && b.stalls.count > 0) {
      const ago = f.time(now - b.stalls.lastAt);
      ns.print(`  Stalls      game paused ${b.stalls.count}x, last for ${f.time(b.stalls.lastMs)} (${ago} ago)`);
      if (now - b.stalls.lastAt < 120000) ns.print(`              (background browser tab? keep the game visible)`);
    }
    ns.print("");
    ns.print(`== Targets ==`);
    if (b.lanes.length === 0) ns.print("  (planning)");
    let expected = 0;
    for (const l of b.lanes) {
      const state = `sec ${l.sec.toFixed(2)}/${l.minSec.toFixed(2)}  money ${f.percent(l.cash / l.maxCash, 1)} of ${money(l.maxCash)}`;
      // Income over the last minute, comparable with "expect".
      const earned = l.firstLand && now > l.firstLand ? `  got ${money(l.recentRate ?? 0)}/s` : "";
      ns.print(`  ${l.target.padEnd(18)} ${(l.pre ? "PRE" : l.mode.toUpperCase()).padEnd(6)} ${state}`);
      if (l.mode === "batch" && l.plan) {
        const p = l.plan;
        expected += p.rate * 1000;
        ns.print(`      ${p.w1 > 0 ? `H${p.h} W${p.w1} G${p.g} W${p.w2}` : `H${p.h} G${p.g} W${p.w2}`}  takes ${f.percent(p.f, 2)}, one every ${Math.round(p.P)} ms, ~${p.inFlight} in flight`);
        if (!l.firstLand || now < l.firstLand) {
          const wait = l.firstLand ? `first batch lands in ${f.time(l.firstLand - now)}` : "starting";
          ns.print(`      ${f.number(p.conc, 0)} threads   expect ${money(p.rate * 1000)}/s   filling pipeline: ${wait}`);
        } else {
          ns.print(`      ${f.number(p.conc, 0)} threads   expect ${money(p.rate * 1000)}/s${earned}`);
        }
      } else if (l.mode === "prep" && l.prep) {
        const p = l.prep;
        const ahead = l.pre ? `, ahead of time (you can hack it at level ${l.req})` : "";
        ns.print(`      prepping: W${p.w1} G${p.g} W${p.w2}${p.complete ? " (last round)" : " (more rounds needed)"}${ahead}`);
      } else if (l.mode === "drain") {
        ns.print(`      drifted: letting ${l.workers} workers land, then re-prep${earned}`);
      } else if (l.mode === "retire") {
        ns.print(`      no longer the best use of RAM: ${l.workers} workers finishing`);
      }
    }
    ns.print("");
    ns.print(`== Income ==`);
    ns.print(`  Expected    ${money(expected)}/s from batching targets`);
    ns.print(`  Session     ${money(s.money)} in ${f.time(elapsed * 1000)}  (${money(s.money / elapsed)}/s)`);
    const notes = [];
    if (s.desyncs) notes.push(`${s.desyncs} re-preps`);
    if (b.repairs) notes.push(`${b.repairs} drifts repaired without re-prep`);
    if (s.aborted) notes.push(`${s.aborted} late hacks skipped`);
    if (notes.length) ns.print(`              ${notes.join(", ")}`);
  }

  const buyer = ns.peek(CONFIG.ports.buyer);
  const sing = ns.peek(CONFIG.ports.singularity);
  if ([CONFIG.ports.buyer, CONFIG.ports.singularity, CONFIG.ports.contracts, CONFIG.ports.hacknet, CONFIG.ports.stocks].some((p) => ns.peek(p) !== "NULL PORT DATA")) {
    ns.print("");
    ns.print(`== Automation ==`);
    if (buyer !== "NULL PORT DATA") {
      const next = buyer.next ? `; next: ${buyer.next.what} for ${money(buyer.next.cost)}` : "";
      ns.print(`  Cloud RAM   ${buyer.state}: ${buyer.note}${buyer.state === "bought" ? "" : next}`);
    }
    const cc = ns.peek(CONFIG.ports.contracts);
    if (cc !== "NULL PORT DATA") {
      const last = cc.recent[0] ? `; last: ${cc.recent[0].reward}` : "";
      ns.print(`  Contracts   ${cc.solved} solved${cc.failed.length ? `, ${cc.failed.length} failed` : ""}${last}`);
    }
    const sk = ns.peek(CONFIG.ports.stocks);
    if (sk !== "NULL PORT DATA") {
      if (sk.state === "trading") ns.print(`  Stocks      ${money(sk.value ?? 0)} in ${sk.note}; profit ${money(sk.realized + (sk.unrealized ?? 0))} (${money(sk.realized)} banked)`);
      else ns.print(`  Stocks      ${sk.state}: ${sk.note}`);
    }
    const hn = ns.peek(CONFIG.ports.hacknet);
    if (hn !== "NULL PORT DATA") {
      ns.print(`  Hacknet     ${hn.nodes ?? 0} nodes, ${money(hn.income ?? 0)}/s; ${hn.note}`);
    }
    if (sing !== "NULL PORT DATA") {
      if (sing.home) ns.print(`  Home RAM    ${sing.home.note}${sing.home.cost && isFinite(sing.home.cost) ? ` (next ${f.ram(sing.home.ram)} for ${money(sing.home.cost)})` : ""}`);
      const doing = sing.current ? `installing on ${sing.current}` : "idle";
      ns.print(`  Backdoors   ${sing.backdoored.length} done this session, ${sing.remaining ?? 0} to go, ${doing}`);
      if (sing.error) ns.print(`  Error       ${sing.error}`);
    }
  }

  const tr = ns.peek(CONFIG.ports.train);
  if (tr !== "NULL PORT DATA" && tr.state !== "stopped") {
    ns.print("");
    ns.print(`== Training ==`);
    if (tr.state === "training") {
      const eta = tr.etaOverYear ? ", over a year at this rate (augments help far more)" : tr.etaSec ? `, about ${f.time(tr.etaSec * 1000)} to go` : "";
      ns.print(`  Now         ${tr.stat} at ${tr.place}`);
      ns.print(`  Stat total  ${f.number(tr.total, 0)} / ${f.number(tr.goal, 0)} for ${tr.goalName} at "${tr.level}"${eta}`);
    } else ns.print(`  ${tr.state}: ${tr.note ?? ""}`);
    if (tr.summary) {
      const ready = tr.summary.filter((x) => x.ready).length;
      const next = tr.summary.find((x) => !x.ready);
      ns.print(`  Locations   ${ready} / ${tr.summary.length} at "${tr.level}" or easier`);
    }
  }

  if (c !== "NULL PORT DATA") {
    ns.print("");
    ns.print(`== To do ==`);
    ns.print(`  Rooted      ${c.rooted} / ${c.total} servers`);
    if (c.nextProgram) ns.print(`  Buy next    ${c.nextProgram} (unlocks ${c.unlockedByNext} more)`);
    else ns.print(`  Port openers: all owned`);
    if (!c.formulas) ns.print(`  Buy         Formulas.exe for exact planning and level prediction`);
    // With singularity.js running, backdoors happen by themselves.
    if (sing === "NULL PORT DATA") for (const bd of c.backdoors) ns.print(`  Backdoor    ${bd.host}:  ${bd.command}`);
  }

  if (c !== "NULL PORT DATA" && c.bitnode) {
    const n = c.bitnode;
    const ok = (x) => (x ? "done" : "");
    ns.print("");
    ns.print(`== Finishing BitNode ${n.node} ==`);
    if (!n.daedalus) {
      const skill = n.hacking >= 2500 ? "done" : `${f.number(n.hacking, 0)} / 2500 (or every combat stat 1500: lowest is ${f.number(n.combatMin, 0)})`;
      ns.print(`  Daedalus    invite needs all three:`);
      ns.print(`    augments  ${n.augs} / ${n.augsNeed} installed ${ok(n.augs >= n.augsNeed)}`);
      ns.print(`    money     ${money(n.money)} / $100b ${ok(n.money >= 100e9)}`);
      ns.print(`    hacking   ${skill}`);
    } else if (!n.redPill) {
      ns.print(`  Daedalus    joined: earn the rep for The Red Pill, buy it, install augments`);
    } else {
      ns.print(`  Red Pill    installed`);
    }
    const lvl = n.hacking >= n.daemonReq ? "reached" : `${f.number(n.hacking, 0)} / ${f.number(n.daemonReq, 0)}`;
    ns.print(`  w0r1d_d43m0n hacking ${lvl}${n.daemonVisible ? "" : " (it appears after The Red Pill)"}`);
    if (n.redPill && n.hacking >= n.daemonReq) ns.print(`  Finish      backdoor w0r1d_d43m0n (backdoor.js skips it unless backdoor.includeWorldDaemon is on)`);
  }
}
