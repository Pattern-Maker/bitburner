/**
 * Settings for the batching suite.
 *
 * The solver itself has no tuning numbers: hack size, batch count and thread
 * counts are all derived from the game each cycle. Everything here is either
 * a personal preference (how much RAM to leave you) or a starting point that
 * the batcher corrects on its own (landing gap).
 */
export const CONFIG = {
  // RAM on home kept free for your own scripts. Capped at a share of home so
  // the reserve never swallows a small early-game home computer.
  homeReserveGB: 32,
  homeReserveMaxFraction: 0.25,

  // Gap between landings inside a batch (ms). This is only the starting value:
  // the batcher measures how late workers actually finish and adjusts it.
  spacingStartMs: 20,
  // Never tighten below this, however good the measurements look.
  spacingMinMs: 4,
  // Never widen beyond this. A healthy gap is a few ms to tens of ms; anything
  // bigger means the game itself was stalling, which a wider gap can't fix.
  spacingMaxMs: 200,

  // How many pipeline cycles ahead to look when weighing a target's income
  // against the time it needs to prep. Also the margin before a running
  // target is swapped out: 10 means "only if at least ~10% better".
  switchPaybackCycles: 10,

  // How many of the most promising targets the planner considers each replan.
  maxTargets: 15,
  // How finely the planner divides your threads when sharing them between
  // targets (60 = steps of 1/60th). Higher is more precise but slower to plan.
  planChunks: 60,

  // Most worker scripts allowed to run at once. Thousands of tiny scripts can
  // slow the game down; raise this if your machine copes, lower it if it lags.
  maxWorkerScripts: 10000,

  // How often the crawler rescans the network and tries to root servers.
  crawlIntervalMs: 30000,

  // Use servers you bought. Set to false to keep them for something else.
  usePurchasedServers: true,

  // Automatic cloud server buying (buyer.js) and, with Singularity, home RAM
  // upgrades (singularity.js). Each purchase may spend up to spendFraction of
  // the money you have at that moment. Buying pauses while less than
  // minUsedFraction of your RAM is in use, because then RAM isn't what's
  // limiting income and more would be wasted.
  buy: {
    enabled: true,
    spendFraction: 0.25,
    minUsedFraction: 0.9,
    homeRam: true,
    serverPrefix: "pserv-",
    intervalMs: 10000,
  },

  // Automatic backdoors (singularity.js, needs Source-File 4 or BitNode 4).
  // w0r1d_d43m0n is left out unless you opt in: backdooring it ends the BitNode.
  backdoor: {
    enabled: true,
    includeWorldDaemon: false,
    intervalMs: 30000,
  },

  // Port numbers used for communication. Change only if they clash with yours.
  ports: {
    reports: 7101, // workers -> batcher (finish times, money taken)
    batcher: 7102, // batcher -> status
    crawler: 7103, // crawler -> status / start
    buyer: 7104, // buyer -> status
    singularity: 7105, // singularity -> status
  },

  workers: {
    hack: "batch/hack.js",
    grow: "batch/grow.js",
    weaken: "batch/weaken.js",
  },
};
