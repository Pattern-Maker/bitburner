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
| `batch/config.js` | Default settings (override them in `my-config.txt`) | – |
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
| `batch/stocks.js` | Buys market access and trades stocks on the 4S forecasts | ~38 GB |
| `batch/hack.js`, `grow.js`, `weaken.js` | Workers | 1.85–1.9 GB per thread |
| `batch/share.js` | Share worker: lends spare RAM to factions | 4 GB per thread |
| `batch/xp.js` | XP worker: turns spare RAM into hacking exp | 1.75 GB per thread |

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
like any other file, so don't edit it in-game: put your own settings in
`my-config.txt` instead (start.js creates it). Anything there replaces the
same setting in `config.js`, and updates never touch it:

```
{ "share": { "use": "share" }, "buy": { "spendFraction": 0.5 } }
```

start.js warns if the file isn't valid JSON or names a setting that doesn't
exist.

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
less than planned, the money was short when they landed. A small shortfall
(up to `repairMaxShortfall`, 25%) is repaired: the next batch grows back the
missing money too, and batching never stops. A bigger one, or a repair that
didn't work, makes that lane stop, let its batches land, re-prep and resume.
Each lane also learns how far its hacks run over the plan (level-ups the
prediction missed) and sizes its grows for that. Every drift is recorded with
its cause for `report.js`. Workers that would start while security is briefly raised wait (at
most two landing gaps) so their timing stays exact.

**Timing.** The game applies an operation's effect the moment its timer
fires, and timers fire in due-time order even when the game is running late.
So game lag delays landings but never reorders them, and the gap between
landings only has to cover timer precision: it's fixed at `spacingMinMs`
(4 ms). The one thing that can break a batch is a worker starting too late
to schedule its landing. Each worker reports its spare time ("slack"), and
the launch buffer is set to twice the worst launch lag measured, so workers
start early enough. Each target lands one batch every 3 gaps (4 with HWGW), so this alone
was worth about 3.6x the income in simulation when targets are the limit.

**HGW batches.** By default a batch is hack, grow, weaken (`batchType:
"hgw"`): the grow lands one gap after the hack, while the hack's security is
still on, so it's sized for that security (the game's growth per thread is
min(ln(1 + 0.03/security), ln 1.0035), so targets with minimum security
under 8.57 need no extra threads at all), and one weaken undoes both. That's
3 landings per batch instead of 4, so each target lands a third more batches,
and one script fewer per batch. In simulation it earned 50-85% more when
targets were the limit. `"hwgw"` brings back the four-landing batch.

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

**Script cap.** With `autoTuneSlots`, whenever script slots are what limits
income the batcher tries a 25% higher cap. Two plans later, once lateness has
been measured under the extra load, it keeps the raise only if expected
income went up. It lowers the cap if the game starts lagging.

**Sharing.** RAM the plan can't use is lent to your factions with
`ns.share()`. It's topped up and trimmed at each replan rather than restarted,
so the boost doesn't dip. While you do faction work, rep gain is multiplied
by 1 + ln(threads)/25 (a million threads is about +55%). If batches ever need
the RAM, they take back just what they need, and the batcher lends less from
then on, easing back over time. Turn it off with `share.enabled`.

**Home's share.** Home's extra cores make each share thread count for more,
so home always shares `homeShareStart` (25%) of itself. Once home is at most
`homeExchangeBelow` (50%) of all your RAM, every GB you gain elsewhere frees
one more GB of home for sharing, so batching RAM stays level while home
switches over, until all of home shares (bar `homeReserveGB` for your
scripts). For example, with 1 PB home: 250 TB shares until you have 1 PB
elsewhere, then all of home shares by the time you have 1.75 PB elsewhere.

**Hacking XP.** Early in a run your hacking level is what holds income
back: it decides which servers you can hack, and every hack, grow and weaken
takes time proportional to 1/(level + 50). So while some server with money
still needs a higher level than yours (`share.use: "auto"`), spare RAM runs
`xp.js` instead, a weaken loop on whichever server gives the most exp per
second, and only `xpShareFraction` (10%) shares; that small slice still gets
about four-fifths of the rep bonus, because the bonus grows with the log of
the threads. Once nothing is level-locked, all spare RAM shares. RAM held for
a target while it preps counts as spare too, so the first few minutes of a
run aren't wasted. Set `share.use` to `"xp"` or `"share"` to fix the choice.

**Prepping ahead.** Weaken and grow only need root access, not hacking
level. When spare RAM isn't farming XP (`share.use: "share"`), it first preps
the next rooted server you can't hack yet, so that server starts batching the
moment your level reaches it. While XP is on, spare RAM levels you instead:
in simulation that got to new servers sooner than prepping them ahead did.
Pre-prepped servers show as PRE in the status window. Turn it off with
`share.prePrep: false`.

**Finishing the BitNode.** The status window tracks the way out: a Daedalus
invite (30 installed augmentations, $100b, and hacking 2500 or every combat
stat 1500), then The Red Pill from Daedalus, then the hacking level
w0r1d_d43m0n needs (3000 in BitNode 1) and its backdoor. The numbers are
BitNode 1's; other BitNodes can ask for more.

**Contracts.** `contracts.js` solves every contract type in 3.0.x. Each
solver was checked against the game's own generator and answer checker on
2,000 random contracts per type. A contract it gets wrong is never retried,
so a bad solver can't destroy contracts.

**Stocks.** `stocks.js` needs no Source-File. Once the WSE account, TIX API
and 4S Market Data TIX API together cost at most `stocks.accessFraction`
(10%) of your money (about $31b in BitNode 1), it buys them. Then, every
market update, it sells stocks whose forecast has dropped below 50% and buys
the ones expected to rise fastest (volatility x how far the forecast is
above 50%, from 55% up), keeping at most `stocks.capitalFraction` (half) of
your net worth in shares and never making a trade small enough for the
$100k commission to matter. Grows on the servers of companies you hold run
with `{ stock: true }`, which pushes those prices up. It only goes long:
shorting needs BitNode 8 or Source-File 8.

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
