import { CONFIG } from "./config.js";

/**
 * Buys and upgrades cloud servers, but only while RAM is what's limiting
 * income. The batcher publishes how much of the RAM its plan can use; if a
 * good share is idle (targets or script slots are the limit instead), more RAM
 * would be wasted, so buying pauses and the status window says why.
 *
 * Each purchase spends at most buy.spendFraction of your money at that
 * moment. Among what's affordable it picks the option that adds the most RAM.
 * After buying it waits for the batcher to replan with the new RAM before
 * judging again.
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");
  const cfg = CONFIG.buy;
  const workers = Object.values(CONFIG.workers);
  let lastBuyAt = 0;

  while (true) {
    const report = (data) => {
      ns.clearPort(CONFIG.ports.buyer);
      ns.writePort(CONFIG.ports.buyer, { ...data, updated: Date.now() });
    };
    try {
      if (!cfg.enabled) {
        report({ state: "off", note: "disabled in config.js" });
        await ns.sleep(cfg.intervalMs);
        continue;
      }
      const b = ns.peek(CONFIG.ports.batcher);
      if (b === "NULL PORT DATA" || !b.usage || !b.planStats) {
        report({ state: "waiting", note: "waiting for the batcher's first plan" });
        await ns.sleep(cfg.intervalMs);
        continue;
      }
      if (b.planStats.at <= lastBuyAt) {
        report({ state: "waiting", note: "waiting for the batcher to plan with the new RAM" });
        await ns.sleep(1000);
        continue;
      }

      const usedFrac = b.usage.capacity > 0 ? b.usage.used / b.usage.capacity : 1;
      const money = ns.getServerMoneyAvailable("home");
      const budget = money * cfg.spendFraction;
      const options = cloudOptions(ns, cfg, budget);
      const next = cheapestNext(ns, cfg);

      if (usedFrac < cfg.minUsedFraction) {
        const why =
          b.usage.slotsUsed >= 0.9 * b.usage.slots
            ? "script slots are full (raise maxWorkerScripts in config.js)"
            : "the targets can't use more";
        report({ state: "paused", usedFrac, note: `only ${(usedFrac * 100).toFixed(0)}% of RAM in use: ${why}`, next });
        await ns.sleep(cfg.intervalMs);
        continue;
      }

      if (options.length === 0) {
        report({ state: "saving", usedFrac, note: next ? "saving up" : "all cloud servers are at maximum RAM", next });
        await ns.sleep(cfg.intervalMs);
        continue;
      }

      // Most RAM added; if equal, the cheaper one.
      options.sort((x, y) => y.gain - x.gain || x.cost - y.cost);
      const o = options[0];
      let ok = false;
      let host = o.host;
      if (o.kind === "buy") {
        host = ns.cloud.purchaseServer(nextName(ns, cfg), o.ram);
        ok = !!host;
      } else {
        ok = ns.cloud.upgradeServer(o.host, o.ram);
      }
      if (ok) {
        ns.scp(workers, host, "home"); // so it's usable straight away
        lastBuyAt = Date.now();
        const what = o.kind === "buy" ? `bought ${host} (${ns.format.ram(o.ram)})` : `upgraded ${host} to ${ns.format.ram(o.ram)}`;
        ns.print(`${what} for $${ns.format.number(o.cost)}`);
        report({ state: "bought", usedFrac, note: what, cost: o.cost, last: { what, cost: o.cost, at: Date.now() } });
      }
    } catch (e) {
      report({ state: "error", note: String(e?.message ?? e) });
    }
    await ns.sleep(1000);
  }
}

/** Every affordable way to add RAM within the budget. */
function cloudOptions(ns, cfg, budget) {
  const out = [];
  const maxRam = ns.cloud.getRamLimit();
  const names = ns.cloud.getServerNames();
  if (names.length < ns.cloud.getServerLimit()) {
    let best = 0;
    for (let r = 2; r <= maxRam; r *= 2) if (ns.cloud.getServerCost(r) <= budget) best = r;
    if (best > 0) out.push({ kind: "buy", ram: best, gain: best, cost: ns.cloud.getServerCost(best) });
  }
  for (const host of names) {
    const cur = ns.getServerMaxRam(host);
    let best = 0;
    for (let r = cur * 2; r <= maxRam; r *= 2) {
      const c = ns.cloud.getServerUpgradeCost(host, r);
      if (c >= 0 && c <= budget) best = r;
    }
    if (best > 0) out.push({ kind: "upgrade", host, ram: best, gain: best - cur, cost: ns.cloud.getServerUpgradeCost(host, best) });
  }
  return out;
}

/** The cheapest next step, whatever it costs, for "saving up for" in status. */
function cheapestNext(ns, cfg) {
  const maxRam = ns.cloud.getRamLimit();
  const names = ns.cloud.getServerNames();
  let best = null;
  const consider = (what, cost) => {
    if (cost > 0 && isFinite(cost) && (!best || cost < best.cost)) best = { what, cost };
  };
  if (names.length < ns.cloud.getServerLimit()) {
    // A new server the size of your biggest one (or 2GB if it's your first).
    const r = Math.max(2, ...names.map((h) => ns.getServerMaxRam(h)));
    consider(`a new ${ns.format.ram(r)} server`, ns.cloud.getServerCost(r));
  }
  for (const host of names) {
    const cur = ns.getServerMaxRam(host);
    if (cur < maxRam) consider(`${host} to ${ns.format.ram(cur * 2)}`, ns.cloud.getServerUpgradeCost(host, cur * 2));
  }
  return best;
}

function nextName(ns, cfg) {
  const taken = new Set(ns.cloud.getServerNames());
  for (let i = 0; ; i++) if (!taken.has(`${cfg.serverPrefix}${i}`)) return `${cfg.serverPrefix}${i}`;
}
