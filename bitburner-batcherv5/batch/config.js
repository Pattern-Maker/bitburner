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

  // Gap between landings inside a batch (ms). The game resolves landings in
  // due-time order even when it runs late, so this only has to cover timer
  // precision (about a millisecond each way), not the game's lag. Each target
  // lands one batch per 4 gaps, so a smaller gap means more income per
  // target. Workers that start too late are handled by launching earlier.
  spacingMinMs: 4,

  // How many pipeline cycles ahead to look when weighing a target's income
  // against the time it needs to prep. Also the margin before a running
  // target is swapped out: 10 means "only if at least ~10% better".
  switchPaybackCycles: 10,

  // How many of the most promising targets the planner considers each replan.
  maxTargets: 30,
  // How finely the planner divides your threads when sharing them between
  // targets (60 = steps of 1/60th). Higher is more precise but slower to plan.
  planChunks: 60,

  // Worker script cap. With autoTuneSlots the batcher tries raising it while
  // script slots are what limits income, keeps a raise only if expected
  // income goes up once lateness has been measured under the extra load, and
  // lowers it if the game starts lagging. maxWorkerScripts is where it starts
  // (and the lowest it goes); maxWorkerScriptsLimit is the most it will try.
  maxWorkerScripts: 30000,
  maxWorkerScriptsLimit: 200000,
  autoTuneSlots: true,

  // A batch whose hacks came up short by at most this fraction is repaired
  // (the next batch grows back the missing money) instead of re-prepping the
  // target, which costs two weaken times of no income. Bigger drifts, or a
  // repair batch that is itself short, still re-prep.
  repairMaxShortfall: 0.25,

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

  // Stat training for infiltration (train.js, needs Source-File 4). It takes
  // over what your character is doing, so it stops by itself if you start
  // something else, and start.js won't restart it.
  // level: the infiltration difficulty to reach (trivial, normal or hard).
  // focus: focusing trains faster but takes over the screen.
  // roundSec: how long each stat is trained before picking again.
  train: {
    autoStart: true, // start.js starts training (only with Singularity)
    level: "normal",
    focus: false,
    roundSec: 60,
  },

  // RAM the batching plan can't use is lent to your factions with
  // ns.share(), which multiplies faction rep gain while you work for one by
  // 1 + ln(threads) / 25 (1 million threads is about +55%). reserveFraction of
  // your threads is always kept free so batches never wait for RAM.
  // RAM the plan can't use right now (spare RAM, plus RAM held back for a
  // target while it preps) is lent out, and taken back when batches need it.
  share: {
    enabled: true,
    // What spare RAM does:
    //   "auto"  hacking XP while servers with money still need a higher
    //           hacking level than yours (levels unlock better targets and
    //           make every operation faster), keeping xpShareFraction of it
    //           sharing; once nothing is level-locked, all of it shares.
    //   "xp"    always hacking XP (keeping xpShareFraction sharing)
    //   "share" always faction rep (ns.share)
    use: "auto",
    // Share's rep bonus grows with the log of the threads, so a small slice
    // gets most of it: 10% of the spare RAM gives about four-fifths of the
    // bonus that all of it would.
    xpShareFraction: 0.1,
    reserveFraction: 0.1,
    // Once home is at most this share of all your RAM, home stops batching
    // and shares instead (its cores make each share thread worth more).
    dedicateHomeBelow: 0.1,
    // When home is dedicated, keep this share of it free for your own scripts.
    homeKeepFree: 0.1,
  },

  // Coding contract solver (contracts.js): how often to look for new ones.
  contracts: {
    enabled: true,
    intervalMs: 60000,
  },

  // Hacknet nodes (hacknet.js): buy only what pays for itself within
  // paybackHours, spending at most spendFraction of your money per purchase.
  hacknet: {
    enabled: true,
    paybackHours: 2,
    spendFraction: 0.1,
    intervalMs: 10000,
  },

  // Port numbers used for communication. Change only if they clash with yours.
  ports: {
    reports: 7101, // workers -> batcher (finish times, money taken)
    batcher: 7102, // batcher -> status
    crawler: 7103, // crawler -> status / start
    buyer: 7104, // buyer -> status
    singularity: 7105, // singularity -> status
    train: 7106, // train -> status
    contracts: 7107, // contracts -> status
    hacknet: 7108, // hacknet -> status
  },

  workers: {
    hack: "batch/hack.js",
    grow: "batch/grow.js",
    weaken: "batch/weaken.js",
    share: "batch/share.js",
    xp: "batch/xp.js",
  },
};
