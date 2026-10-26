import { CONFIG } from "./config.js";

/**
 * Trains your stats for infiltration. Needs Singularity (Source-File 4 or
 * BitNode 4) to start gym and university classes.
 *
 * Infiltration difficulty, from the game's source:
 *   startingSecurity - (str + def + dex + agi + cha)^0.9 / 250 - int / 1600
 * All five stats count equally, as a sum. So every round it trains whichever
 * stat would gain the most levels in the next round, wherever that's fastest.
 * That's usually your lowest stat (skills grow with the log of exp, so a low
 * stat levels fastest), weighted by your exp multipliers and the gym or
 * university's multiplier.
 *
 * It stops by itself once the goal is met, or if you start doing something
 * else (it won't fight you for control). Stop it any time with:
 *   kill batch/train.js
 *
 *   run batch/train.js                           work through every location, easiest first
 *   run batch/train.js --location ECorp          just one location
 *   run batch/train.js --level trivial           trivial | normal | hard
 *   run batch/train.js --focus                   focus on the class (faster, takes over the screen)
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");
  const cfg = CONFIG.train;
  const flags = ns.flags([
    ["location", ""],
    ["level", cfg.level],
    ["focus", cfg.focus],
    ["round", cfg.roundSec],
  ]);
  const port = CONFIG.ports.train;
  const say = (data) => {
    ns.clearPort(port);
    ns.writePort(port, { ...data, updated: Date.now() });
  };

  const reset = ns.getResetInfo();
  if (!(reset.currentNode === 4 || (reset.ownedSF.get(4) ?? 0) > 0)) {
    ns.tprint("train.js needs Singularity (Source-File 4, or BitNode 4) to start classes from a script.");
    ns.tprint("Without it, train by hand: Powerhouse Gym in Sector-12 for str/def/dex/agi, ZB Institute in Volhaven (Leadership) for charisma.");
    return;
  }
  const LEVEL_EDGE = { trivial: 1, normal: 2, hard: 3 };
  const edge = LEVEL_EDGE[String(flags.level).toLowerCase()];
  if (edge === undefined) {
    ns.tprint(`Unknown --level "${flags.level}". Use trivial, normal or hard.`);
    return;
  }

  // Stat total each location needs, solved straight from the difficulty formula.
  const needFor = (start) => {
    const int = ns.getPlayer().skills.intelligence;
    const x = 250 * (start - int / 1600 - edge);
    return x <= 0 ? 0 : Math.ceil(Math.pow(x, 1 / 0.9));
  };
  const allLocs = ns.infiltration.getPossibleLocations().map((l) => l.name);
  const locs = flags.location ? allLocs.filter((n) => n.toLowerCase() === String(flags.location).toLowerCase()) : allLocs;
  if (locs.length === 0) {
    ns.tprint(`No infiltration location called "${flags.location}". Options: ${allLocs.join(", ")}`);
    return;
  }
  const starts = new Map(locs.map((n) => [n, ns.infiltration.getInfiltration(n).startingSecurityLevel]));

  ns.atExit(() => {
    say({ state: "stopped", note: "not running" });
  });

  let ours = null; // the class we last started, to notice if you take over
  while (true) {
    const p = ns.getPlayer();
    const total = STATS.reduce((sum, s) => sum + p.skills[s.key], 0);
    const needs = locs.map((n) => ({ name: n, need: needFor(starts.get(n)) })).sort((a, b) => a.need - b.need);
    const allGoal = needs[needs.length - 1].need;
    // With no --location, aim at the next location not yet reached, so the
    // goal and ETA are always for a real next step.
    const nextLoc = needs.find((x) => x.need > total);
    const goal = flags.location || !nextLoc ? allGoal : nextLoc.need;
    const goalName = flags.location ? locs[0] : nextLoc?.name ?? "every location";

    const summary = summarise(locs, starts, needFor, total);
    if (total >= allGoal) {
      if (ours && sameWork(ns.singularity.getCurrentWork(), ours)) ns.singularity.stopAction();
      say({ state: "done", total, goal, level: flags.level, summary });
      ns.tprint(`Training done: stat total ${total} reaches "${flags.level}" for ${flags.location || "every location"}.`);
      return;
    }

    // You started something else: hand control back rather than fight over it.
    const work = ns.singularity.getCurrentWork();
    if (ours && work && !sameWork(work, ours)) {
      say({ state: "stopped", note: "you started other work, so training stopped", total, goal, summary });
      ns.tprint("train.js stopped: you started other work. Run it again when you want to resume training.");
      return;
    }

    const rates = rateTable(ns, p);
    const mEff = Object.fromEntries(STATS.map((st) => [st.key, Math.max(1, p.skills[st.key]) / base(p.exp[st.key])]));
    const pick = bestOption(rates, p.exp, mEff, flags.round);
    if (p.city !== pick.place.city) ns.singularity.travelToCity(pick.place.city);
    const started = pick.stat.gym
      ? ns.singularity.gymWorkout(pick.place.name, pick.stat.gym, flags.focus)
      : ns.singularity.universityCourse(pick.place.name, pick.stat.uni, flags.focus);
    if (!started) {
      say({ state: "error", note: `couldn't start ${pick.stat.key} at ${pick.place.name}`, total, goal, summary });
      await ns.sleep(5000);
      continue;
    }
    ours = { classType: pick.stat.gym ?? pick.stat.uni, location: pick.place.name };

    const etaSec = simulateEta(rates, p, mEff, goal, flags.round);
    say({
      state: "training",
      stat: pick.stat.key,
      place: pick.place.name,
      gainPerRound: pick.gain,
      total,
      goal,
      level: flags.level,
      goalName,
      etaSec: isFinite(etaSec) ? etaSec : null,
      etaOverYear: !isFinite(etaSec),
      summary,
    });
    await ns.sleep(flags.round * 1000);
  }
}

// baseExp: exp per second at a location with multiplier 1, from the game's
// class data (gym 1 per cycle, Leadership 4 per cycle, 5 cycles a second,
// divided by 5 in the formula). Only used without Formulas.exe.
const STATS = [
  { key: "strength", gym: "str", exp: "strExp", expMult: "strength_exp", baseExp: 1 },
  { key: "defense", gym: "def", exp: "defExp", expMult: "defense_exp", baseExp: 1 },
  { key: "dexterity", gym: "dex", exp: "dexExp", expMult: "dexterity_exp", baseExp: 1 },
  { key: "agility", gym: "agi", exp: "agiExp", expMult: "agility_exp", baseExp: 1 },
  { key: "charisma", uni: "Leadership", exp: "chaExp", expMult: "charisma_exp", baseExp: 4 },
];
// Location exp multipliers from the game's data, used only without Formulas.exe.
const GYMS = [
  { name: "Powerhouse Gym", city: "Sector-12", exp: 10 },
  { name: "Snap Fitness Gym", city: "Aevum", exp: 5 },
  { name: "Millenium Fitness Gym", city: "Volhaven", exp: 4 },
  { name: "Crush Fitness Gym", city: "Aevum", exp: 2 },
  { name: "Iron Gym", city: "Sector-12", exp: 1 },
];
const UNIS = [
  { name: "ZB Institute of Technology", city: "Volhaven", exp: 4 },
  { name: "Summit University", city: "Aevum", exp: 3 },
  { name: "Rothman University", city: "Sector-12", exp: 2 },
];

/** Skill from exp, continuous version of the game's formula. */
const base = (exp) => Math.max(1e-9, 32 * Math.log(exp + 534.6) - 200);

/** Exp per second for every stat at every place, for the current character. */
function rateTable(ns, p) {
  const formulas = ns.fileExists("Formulas.exe", "home");
  const out = [];
  for (const stat of STATS) {
    for (const place of stat.gym ? GYMS : UNIS) {
      let expPerSec;
      if (formulas) {
        const g = stat.gym
          ? ns.formulas.work.gymGains(p, stat.gym, place.name)
          : ns.formulas.work.universityGains(p, stat.uni, place.name);
        expPerSec = g[stat.exp] * 5; // gains are per 200 ms game cycle
      } else {
        expPerSec = stat.baseExp * place.exp * (p.mults[stat.expMult] ?? 1);
      }
      out.push({ stat, place, expPerSec });
    }
  }
  return out;
}

/**
 * The stat and place that gain the most levels in one round. The effective
 * level multiplier (augments and BitNode together) is worked out from your
 * current level and exp, so no BitNode data is needed.
 */
function bestOption(rates, exp, mEff, roundSec) {
  let best = null;
  for (const r of rates) {
    const e = exp[r.stat.key];
    const gain = mEff[r.stat.key] * (base(e + r.expPerSec * roundSec) - base(e));
    if (!best || gain > best.gain) best = { ...r, gain };
  }
  return best;
}

/**
 * Seconds until the goal, by playing the same choices forward. Levels get
 * slower the higher they are, so a straight-line estimate would be far too
 * optimistic. Returns Infinity past a year.
 */
function simulateEta(rates, p, mEff, goal, roundSec) {
  const exp = { ...p.exp };
  const level = (k) => mEff[k] * base(exp[k]);
  const total = () => STATS.reduce((sum, s) => sum + level(s.key), 0);
  // Long rounds once far away keep this quick; accuracy matters near the end.
  let t = 0;
  for (let i = 0; i < 200000 && t < 365 * 86400; i++) {
    const left = goal - total();
    if (left <= 0) return t;
    const step = Math.max(roundSec, Math.min(86400, t / 50));
    const b = bestOption(rates, exp, mEff, step);
    exp[b.stat.key] += b.expPerSec * step;
    t += step;
  }
  return Infinity;
}

function sameWork(work, ours) {
  return !!work && work.type === "CLASS" && work.location === ours.location && String(work.classType).toLowerCase().startsWith(String(ours.classType).toLowerCase().slice(0, 3));
}

function summarise(locs, starts, needFor, total) {
  return locs
    .map((n) => ({ name: n, need: needFor(starts.get(n)) }))
    .sort((a, b) => a.need - b.need)
    .map((x) => ({ ...x, ready: total >= x.need }));
}
