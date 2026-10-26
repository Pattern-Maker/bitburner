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
| `batch/config.js` | Your preferences (home reserve, script cap, ports) | – |
| `batch/lib.js` | Scanning, rooting, RAM ledger, model and solvers | – |
| `batch/crawler.js` | Roots servers every 30 s and copies workers out | ~5 GB |
| `batch/batcher.js` | Runs a continuous pipeline on each chosen target | ~14 GB |
| `batch/status.js` | Live tail window | ~1.6 GB |
| `batch/buyer.js` | Buys and upgrades cloud servers while RAM is the bottleneck | ~6 GB |
| `batch/singularity.js` | Backdoors and home RAM upgrades (needs Source-File 4) | varies |
| `batch/hack.js`, `grow.js`, `weaken.js` | Workers | 1.85–1.9 GB per thread |

All of it needs roughly 25 GB on home.

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

## What's left to you

Buying port openers and Formulas.exe, and (without Source-File 4) home RAM
and backdoors. The status window says what to buy next and gives the exact
`connect` path for each backdoor.
