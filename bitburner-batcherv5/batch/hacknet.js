import { CONFIG, loadConfig } from "./config.js";

/**
 * Buys and upgrades hacknet nodes, but only purchases that pay for
 * themselves within hacknet.paybackHours. Each round it looks at every
 * option (a new node, or +1 level, double RAM or +1 core on any node), and
 * buys whichever earns the most extra income per dollar.
 *
 * Production is level x 1.035^(ram-1) x (cores+5)/6 x your multipliers. The
 * multipliers are read off your existing nodes (production divided by that
 * formula), so augments and BitNode bonuses are included without needing
 * Formulas.exe.
 * @param {NS} ns
 */
export async function main(ns) {
  loadConfig(ns);
  ns.disableLog("ALL");
  const cfg = CONFIG.hacknet;
  const hn = ns.hacknet;
  const report = (data) => {
    ns.clearPort(CONFIG.ports.hacknet);
    ns.writePort(CONFIG.ports.hacknet, { ...data, updated: Date.now() });
  };
  let bought = 0;

  while (true) {
    try {
      if (!cfg.enabled) {
        report({ state: "off", note: "disabled in config.js" });
      } else if (hn.hashCapacity() > 0) {
        report({ state: "off", note: "you have hacknet servers (hashes), which this doesn't manage yet" });
      } else {
        // Up to 50 purchases per round, so a big budget gets spent quickly.
        let note = "";
        for (let i = 0; i < 50; i++) {
          const best = bestOption(ns, hn);
          const money = ns.getServerMoneyAvailable("home");
          if (!best) {
            note = "nothing left to buy";
            break;
          }
          const payback = best.cost / best.gain; // seconds
          if (payback > cfg.paybackHours * 3600) {
            note = `next (${best.what}) would take ${ns.format.time(payback * 1000)} to pay back`;
            break;
          }
          if (best.cost > money * cfg.spendFraction) {
            note = `saving for ${best.what} ($${ns.format.number(best.cost)})`;
            break;
          }
          if (!best.buy()) break;
          bought++;
          note = `bought ${best.what}`;
        }
        let income = 0;
        for (let i = 0; i < hn.numNodes(); i++) income += hn.getNodeStats(i).production;
        report({ state: "running", nodes: hn.numNodes(), income, bought, note });
      }
    } catch (e) {
      report({ state: "error", note: String(e?.message ?? e) });
    }
    await ns.sleep(cfg.intervalMs);
  }
}

const factor = (level, ram, cores) => level * Math.pow(1.035, ram - 1) * ((cores + 5) / 6);

function bestOption(ns, hn) {
  const n = hn.numNodes();
  const stats = [];
  for (let i = 0; i < n; i++) stats.push(hn.getNodeStats(i));
  // Income per unit of the formula, from your own nodes.
  let perFactor;
  const live = stats.filter((s) => s.production > 0);
  if (live.length) perFactor = live.reduce((a, s) => a + s.production / factor(s.level, s.ram, s.cores), 0) / live.length;
  else perFactor = 1.5 * (ns.getPlayer().mults.hacknet_node_money ?? 1);

  const options = [];
  if (n < hn.maxNumNodes()) {
    const cost = hn.getPurchaseNodeCost();
    options.push({ what: "a new node", cost, gain: perFactor * factor(1, 1, 1), buy: () => hn.purchaseNode() >= 0 });
  }
  stats.forEach((s, i) => {
    const base = factor(s.level, s.ram, s.cores);
    const lv = hn.getLevelUpgradeCost(i, 1);
    if (isFinite(lv)) options.push({ what: `node ${i} level ${s.level + 1}`, cost: lv, gain: perFactor * (factor(s.level + 1, s.ram, s.cores) - base), buy: () => hn.upgradeLevel(i, 1) });
    const rm = hn.getRamUpgradeCost(i, 1);
    if (isFinite(rm)) options.push({ what: `node ${i} RAM ${s.ram * 2}GB`, cost: rm, gain: perFactor * (factor(s.level, s.ram * 2, s.cores) - base), buy: () => hn.upgradeRam(i, 1) });
    const cr = hn.getCoreUpgradeCost(i, 1);
    if (isFinite(cr)) options.push({ what: `node ${i} core ${s.cores + 1}`, cost: cr, gain: perFactor * (factor(s.level, s.ram, s.cores + 1) - base), buy: () => hn.upgradeCore(i, 1) });
  });
  const valid = options.filter((o) => o.cost > 0 && o.gain > 0);
  valid.sort((a, b) => b.gain / b.cost - a.gain / a.cost);
  return valid[0] ?? null;
}
