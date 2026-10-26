# Bitburner equilibrium batcher (v3.0.x)

One command runs everything:

```
run start.js
```

## Files

| In-game path | What it does | RAM |
|---|---|---|
| `start.js` | Starts everything, restarts anything that stops | ~4 GB |
| `cleanup.js` | Removes leftover scripts from every server | ~3 GB |
| `update.js` | Downloads the latest scripts from the GitHub repo | ~6 GB |
| `report.js` | Writes a diagnostics report to paste to Claude | ~3 GB |
| `backdoor.js` | Backdoors everything by typing into the terminal (no Source-File 4 needed) | ~30 GB |
| `batch/config.js` | Your preferences (home reserve, script cap, ports) | – |
| `batch/lib.js` | Scanning, rooting, RAM ledger, model and solvers | – |
| `batch/crawler.js` | Roots servers every 30 s and copies workers out | ~5 GB |
| `batch/batcher.js` | Runs a continuous pipeline on each chosen target | ~14 GB |
| `batch/status.js` | Live tail window | ~1.6 GB |
| `batch/buyer.js` | Buys and upgrades cloud servers while RAM is the bottleneck | ~6 GB |
| `batch/singularity.js` | Backdoors and home RAM upgrades (needs Source-File 4) | varies |
| `batch/train.js` | Trains stats for infiltration (needs Source-File 4) | varies |
| `batch/contracts.js` | Finds and solves coding contracts | ~25 GB |
| `batch/solvers.js` | The contract solvers | – |
| `batch/hacknet.js` | Buys hacknet nodes and upgrades that pay back within 2 hours | ~7 GB |
| `batch/hack.js`, `grow.js`, `weaken.js` | Workers | 1.85–1.9 GB per thread |
| `batch/share.js` | Share worker: lends spare RAM to factions | 4 GB per thread |

All of it needs roughly 60 GB on home.

## Updating

```
run update.js            update if the repo changed, then restart the suite
run update.js --check    just say whether there's an update
run update.js --force    download everything again
```

It finds the folder in the repo that holds `start.js` and installs that
folder's contents to home. Everything is downloaded before anything is
replaced, so a failed download changes nothing. Files deleted from the repo
are removed in-game too. Settings live in `batch/config.js`, which updates
like any other file, so change settings in the repo rather than in-game.

## How it works

**Lanes.** Each target gets its own lane. A batching lane lands one HWGW
batch every P ms, continuously. Every worker is launched just in time (its
landing time minus its own duration), so it only holds RAM while running.

**The equilibrium.** For a lane with a thread budget, the solver tries batch
periods P. For each one, bisection finds the largest hack size whose grow and
weakens still fit (the balance point, where restoration is exact). The P with
the most money per second wins. P = one weaken time is "one batch using every
thread"; shorter P splits the threads into more, smaller batches.

**Sharing threads between targets.** Each replan builds an income curve for
the most promising targets: how much each would earn with 1/60th of your
threads, 2/60ths, and so on (including the time it would need to prep).
Threads are then handed out a chunk at a time to whichever target gains most
from the next chunk. Every target ends where one more chunk would earn about
the same anywhere, which is where total income is highest. Curves are built a
few milliseconds per tick, so planning never delays launches.

**Protection.** Replanning happens once per pipeline cycle, or when RAM or
rooted servers change. New plans only affect batches created afterwards;
nothing in flight is resized or moved.

**Level-ups.** Each batch's grow is sized for the hack % expected at landing.
With Formulas.exe that comes from the exp every in-flight worker will give;
without it, from how fast hack % has been rising.

**Prep safety.** A prep round's weakens and grow must all fit before any
launch, and the weakens start first, so security can't be left raised.

**Self-checking.** Every hack reports what it took. If a batch's hacks take
less than planned, that lane stops, lets its batches land, re-preps, and
resumes. Workers that would start while security is briefly raised wait (at
most two landing gaps) so their timing stays exact. The landing gap is kept at
twice the worst lateness measured.

**Cores.** Grow and weaken go to servers with more cores first, where each
thread does more, and thread counts are reduced to match.

## Automation

`buyer.js` buys or upgrades cloud servers, spending at most `buy.spendFraction`
of your money per purchase and picking whatever adds the most RAM. It only
buys while at least `buy.minUsedFraction` of your RAM is in use: if threads
sit idle, RAM isn't what's limiting income, and the status window says what
is (usually script slots, fixed by raising `maxWorkerScripts`).

`singularity.js` runs only if you have Singularity. It backdoors every server
you can (faction servers first, never w0r1d_d43m0n unless you opt in) and
upgrades home RAM when it's no dearer per GB than cloud servers. Your terminal
follows it between servers while it works.

`train.js` trains your stats for infiltration. Difficulty depends on the sum
str + def + dex + agi + cha, so each round it trains whichever stat gains the
most levels, at the best gym or university for it. It shows the exact stat
total each location needs and a real ETA (levels slow down as they rise, so
it simulates the rest of the training rather than extrapolating). It isn't
started by start.js when you have Singularity, but never restarted: it takes
over what your character is doing, so it stops itself when done, or if you
start other work.

```
run batch/train.js                    work through locations, easiest first
run batch/train.js --location ECorp   one location
run batch/train.js --level hard       trivial | normal (default) | hard
run batch/train.js --focus            faster, but takes over the screen
```

**Sharing.** RAM the plan can't use is lent to your factions with
`ns.share()`. While you do faction work, rep gain is multiplied by
1 + ln(threads)/25 (a million threads is about +55%). If batches ever need
the RAM, they take back just what they need, and the batcher lends less from
then on, easing back over time. Turn it off with `share.enabled`.

**Contracts.** `contracts.js` solves every contract type in 3.0.x. Each
solver was checked against the game's own generator and answer checker on
2,000 random contracts per type. A contract it gets wrong is never retried,
so a bad solver can't destroy contracts.

**Hacknet.** `hacknet.js` buys whatever adds the most income per dollar, but
only if it pays for itself within `hacknet.paybackHours`.

**Backdoors without Source-File 4.** `run backdoor.js` types
`home; connect ...; backdoor` into the terminal for each server, faction
servers first. Keep the Terminal screen open; it waits whenever you're
typing or the terminal is busy, and stops when everything is done. The game
charges 25 GB of RAM for touching its page. A game update that changes the
terminal could break it; it says so if that happens.

**Diagnostics.** `run report.js` prints everything the suite knows about how
it's doing (and saves it to `report.txt`) for pasting into a chat with Claude.

## What's left to you

Buying TOR, port openers and Formulas.exe, running `backdoor.js` now and
then, and (without Source-File 4) home RAM, training and faction work: the game only lets scripts do
those through Singularity. The status window says what to buy next and gives the exact
`connect` path for each backdoor.
