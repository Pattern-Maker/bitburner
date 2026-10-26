import { CONFIG } from "./config.js";
import { scanAll } from "./lib.js";
import { SOLVERS } from "./solvers.js";

/**
 * Finds coding contracts anywhere on the network and solves them, for money
 * or faction reputation. Every solver has been checked against the game's own
 * contract generator and answer checker.
 *
 * Slow solvers run a few milliseconds at a time, so solving never delays the
 * batcher. A contract it gets wrong is never retried (each wrong answer uses
 * up a try, and the last one destroys the contract); it's listed in the
 * status window instead so you can look at it.
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");
  const cc = ns.codingcontract;
  const state = { solved: 0, recent: [], failed: [], unknown: [], lastScan: 0 };
  const skip = new Set(); // host:file we won't touch again

  const report = () => {
    ns.clearPort(CONFIG.ports.contracts);
    ns.writePort(CONFIG.ports.contracts, { ...state, updated: Date.now() });
  };

  while (true) {
    const { hosts } = scanAll(ns);
    for (const host of hosts) {
      for (const file of ns.ls(host, ".cct")) {
        const key = `${host}:${file}`;
        if (skip.has(key)) continue;
        const type = cc.getContractType(file, host);
        const solver = SOLVERS[type];
        if (!solver) {
          skip.add(key);
          state.unknown.push({ host, file, type });
          continue;
        }
        let answer;
        try {
          answer = await run(ns, solver, cc.getData(file, host));
        } catch (e) {
          skip.add(key);
          state.failed.push({ host, file, type, why: String(e?.message ?? e) });
          continue;
        }
        const reward = cc.attempt(answer, file, host);
        if (reward) {
          state.solved++;
          state.recent.unshift({ type, reward, at: Date.now() });
          state.recent.length = Math.min(state.recent.length, 5);
          ns.print(`Solved ${type} on ${host}: ${reward}`);
        } else {
          skip.add(key);
          state.failed.push({ host, file, type, why: "answer rejected" });
          ns.print(`WARNING: wrong answer for ${type} on ${host} (${file}); not retrying`);
        }
        report();
      }
    }
    state.lastScan = Date.now();
    report();
    await ns.sleep(CONFIG.contracts.intervalMs);
  }
}

/** Run a solver; generator solvers get a few ms at a time with pauses between. */
async function run(ns, solver, data) {
  const r = solver(data);
  if (!r || typeof r.next !== "function") return r;
  for (;;) {
    const t0 = Date.now();
    let step;
    do step = r.next();
    while (!step.done && Date.now() - t0 < 3);
    if (step.done) return step.value;
    await ns.sleep(5);
  }
}
