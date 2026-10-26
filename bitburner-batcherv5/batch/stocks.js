import { CONFIG, loadConfig } from "./config.js";
import { scanAll } from "./lib.js";

/**
 * Stock trader. Works without Source-File 4: buys the WSE account, TIX API
 * and 4S Market Data TIX API itself once they're cheap next to your money,
 * then trades long positions on the 4S forecasts.
 *
 * Each market update (about every 6 seconds) it:
 *  - sells any stock whose forecast has turned (below stocks.sellBelow),
 *  - buys the stocks expected to rise fastest (volatility x how far the
 *    forecast is above 50%), keeping at most stocks.capitalFraction of your
 *    net worth in the market, and never making a trade so small that the
 *    commission is more than 1% of it.
 *
 * It also tells the batcher which servers belong to companies you hold, so
 * grows there are run with { stock: true } and push those prices up.
 * Shorting needs BitNode 8 or Source-File 8, so this only goes long.
 * @param {NS} ns
 */
export async function main(ns) {
  loadConfig(ns);
  ns.disableLog("ALL");
  const cfg = CONFIG.stocks;
  const port = CONFIG.ports.stocks;
  const st = { state: "starting", note: "", realized: 0, trades: 0, started: Date.now() };
  const publish = (extra = {}) => {
    ns.clearPort(port);
    ns.writePort(port, { updated: Date.now(), ...st, ...extra });
  };

  // ---- access ----
  const C = ns.stock.getConstants();
  while (!(ns.stock.hasWseAccount() && ns.stock.hasTixApiAccess() && ns.stock.has4SDataTixApi())) {
    // Buy all of it in one go once it's at most accessFraction of your money,
    // so a partly bought stack doesn't sit unused.
    const missing = [];
    if (!ns.stock.hasWseAccount()) missing.push(["WSE account", C.WseAccountCost, () => ns.stock.purchaseWseAccount()]);
    if (!ns.stock.hasTixApiAccess()) missing.push(["TIX API", C.TixApiCost, () => ns.stock.purchaseTixApi()]);
    if (!ns.stock.has4SDataTixApi()) missing.push(["4S Market Data TIX API", C.MarketDataTixApi4SCost, () => ns.stock.purchase4SMarketDataTixApi()]);
    const total = missing.reduce((s, m) => s + m[1], 0);
    const money = ns.getServerMoneyAvailable("home");
    if (money * cfg.accessFraction >= total) {
      for (const [, , buy] of missing) buy();
      continue;
    }
    st.state = "saving";
    st.note = `buying ${missing.map((m) => m[0]).join(", ")} (about $${ns.format.number(total)}) once that's ${Math.round(cfg.accessFraction * 100)}% of your money`;
    publish();
    await ns.sleep(10000);
  }

  // ---- which server is each company's ----
  const serverOf = new Map();
  const byOrg = new Map();
  for (const h of scanAll(ns).hosts) {
    const org = ns.getServer(h).organizationName;
    if (org) byOrg.set(org, h);
  }
  const syms = ns.stock.getSymbols();
  for (const sym of syms) {
    const h = byOrg.get(ns.stock.getOrganization(sym));
    if (h) serverOf.set(sym, h);
  }

  // ---- trading ----
  const commission = C.StockMarketCommission;
  while (true) {
    await ns.stock.nextUpdate();
    const stocks = syms.map((sym) => {
      const [long, avg] = ns.stock.getPosition(sym);
      const f = ns.stock.getForecast(sym);
      return { sym, long, avg, f, vol: ns.stock.getVolatility(sym), ask: ns.stock.getAskPrice(sym), bid: ns.stock.getBidPrice(sym), max: ns.stock.getMaxShares(sym) };
    });
    for (const s of stocks) s.er = s.vol * (s.f - 0.5); // expected rise per update

    // Sell what's turned.
    for (const s of stocks) {
      if (s.long > 0 && s.f < cfg.sellBelow) {
        const price = ns.stock.sellStock(s.sym, s.long);
        if (price > 0) {
          st.realized += s.long * (price - s.avg) - commission;
          st.trades++;
          s.long = 0;
        }
      }
    }

    // Buy the best risers with what the capital limit allows.
    let value = stocks.reduce((t, s) => t + s.long * s.bid, 0);
    let cash = ns.getServerMoneyAvailable("home");
    let budget = Math.min(cash, cfg.capitalFraction * (cash + value) - value);
    for (const s of stocks.filter((x) => x.f >= cfg.buyAbove).sort((a, c) => c.er - a.er)) {
      if (budget < 100 * commission) break;
      const shares = Math.floor(Math.min(s.max - s.long, (budget - commission) / s.ask));
      if (shares <= 0 || shares * s.ask < 100 * commission) continue;
      const price = ns.stock.buyStock(s.sym, shares);
      if (price > 0) {
        const cost = shares * price + commission;
        budget -= cost;
        st.realized -= commission;
        value += shares * s.bid;
        s.avg = (s.avg * s.long + shares * price) / (s.long + shares);
        s.long += shares;
        st.trades++;
      }
    }

    const held = stocks.filter((s) => s.long > 0);
    const unrealized = held.reduce((t, s) => t + s.long * (s.bid - s.avg), 0);
    st.state = "trading";
    st.note = `${held.length} stocks held`;
    publish({
      value,
      unrealized,
      // Servers whose company you hold: grows there push the price up.
      growServers: held.map((s) => serverOf.get(s.sym)).filter(Boolean),
      top: held
        .sort((a, c) => c.long * c.bid - a.long * a.bid)
        .slice(0, 5)
        .map((s) => ({ sym: s.sym, value: s.long * s.bid, f: s.f })),
    });
  }
}
