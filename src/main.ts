import "./style.css";
import { sha256 } from "@noble/hashes/sha2.js";
import templateIds from "../contracts/testdata/templates.json";
import { type Account, type Deposit, Engine, NoCoinError, accountFrom, explain, newAccount } from "./engine";
import { Executor } from "./executor";
import { DIA_EXPLORER, type PriceUpdate, dia, localOracle } from "./oracle";
import {
  MIN_MARGIN,
  type Offer,
  type OfferTerms,
  type Position,
  type Quote,
  type TradeTerms,
  fee,
  levels,
  payouts,
  resolvable,
} from "./payoff";
import { qrSvg } from "./qr";

const NETWORKS = {
  mainnet: {
    name: "Mainnet",
    arkUrl: "https://arkade.computer",
    emulatorUrl: "https://emulator.arkade.computer",
    executorUrl: "https://executor.arkade.sh",
  },
  mutinynet: {
    name: "Mutinynet",
    arkUrl: "https://mutinynet.arkade.sh",
    emulatorUrl: "https://emulator.mutinynet.arkade.sh",
    executorUrl: "https://executor.mutinynet.arkade.sh",
  },
  regtest: {
    name: "Regtest",
    arkUrl: "http://localhost:7070",
    emulatorUrl: "http://localhost:7073",
    executorUrl: "http://localhost:7080",
  },
};
type Net = keyof typeof NETWORKS;
// The network is the one in the address, else the one last chosen in this browser, else test coins.
const net: Net = (() => {
  let asked = new URLSearchParams(location.search).get("net");
  try {
    asked ??= localStorage.getItem("futures.net");
  } catch {
    // no storage: the address decides
  }
  return asked && asked in NETWORKS ? (asked as Net) : "mutinynet";
})();
// On a local stack the page signs prices itself, with a key anyone can read here.
const TEST_ORACLE_SEED = "arkade-futures-demo-oracle";
const DURATIONS: [number, string][] = [[900, "15 minutes"], [3600, "1 hour"], [86400, "1 day"], [604800, "7 days"]];
if (net === "regtest") DURATIONS.unshift([240, "4 minutes"]);
const LEVERAGES = [2, 5, 10, 25, 50];
const CAPS = [1, 2, 5, 10];
const REFRESH_MS = 8000;
const WATCH_AFTER_DEADLINE = 7 * 86400;
const SPREAD_HEADROOM_BPS = 5;

type DepositState = "waiting" | "opening" | "stuck" | "done";
interface Pending extends Deposit {
  state: DepositState;
  note: string;
  funded?: number;
  created: number;
  delegated?: boolean;
}
interface TradeDeposit extends Pending {
  terms: TradeTerms;
  amount: number;
}
interface OfferDeposit extends Pending {
  terms: OfferTerms;
}
interface Priced extends Position {
  traderAmount: number;
  resolvable: boolean;
  liquidation: number;
  takeProfit: number;
  fee: number;
}
interface Entry {
  t: number;
  text: string;
  tone: string;
}

// Whether this browser keeps what the page saves: without it the key lives only in this tab.
const storageWorks = (() => {
  try {
    localStorage.setItem("futures.probe", "1");
    localStorage.removeItem("futures.probe");
    return true;
  } catch {
    return false;
  }
})();
const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = JSON.parse(localStorage.getItem(`futures.${net}.${k}`) ?? "null");
      return (v ?? fallback) as T;
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem(`futures.${net}.${k}`, JSON.stringify(v));
    } catch {
      // storage is a convenience: the page works without it
    }
  },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false));
  return node;
}
const fmtSats = (n: number) => `${Math.round(n).toLocaleString("en-US")} sats`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n)).toLocaleString("en-US")} sats`;
const usd = (cents: number) =>
  cents > 0 ? `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "–";
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const xonly = (pub: string) => pub.slice(2);
const now = () => Math.floor(Date.now() / 1000);
function until(ts: number): string {
  const s = ts - now();
  if (s <= 0) return "now";
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 172800) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} days`;
}
const durationName = (s: number) => DURATIONS.find(([v]) => v === s)?.[1] ?? `${Math.round(s / 3600)} h`;

let engine: Engine;
let executor: Executor | undefined;
let account: Account;
let side = 0;
let leverage = 10;
let cap = 2;
let latest: PriceUpdate | undefined;
let priceLate = false;
let testPrice = store.get("testPrice", 6_000_000);
let offers: Offer[] = [];
let positions: Priced[] = [];
let busy = false;
let quote: Quote | null = null;
let payoutProgram = "";
const trades = store.get<TradeDeposit[]>("trades", []);
const offerDeposits = store.get<OfferDeposit[]>("offerDeposits", []);
let activity = store.get<Entry[]>("activity", []);
const confirming = new Set<string>();

// ---------- activity ----------
function say(text: string, tone = ""): void {
  activity.unshift({ t: Date.now(), text, tone });
  activity = activity.slice(0, 60);
  store.set("activity", activity);
  renderLog();
}
function renderLog(): void {
  const log = $("log");
  if (!activity.length) {
    log.replaceChildren(el("p", { className: "empty", textContent: "Nothing yet." }));
    return;
  }
  log.replaceChildren(
    ...activity.map((a) =>
      el(
        "div",
        { className: a.tone },
        el("time", { textContent: new Date(a.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }),
        el("span", { textContent: a.text }),
      ),
    ),
  );
}

// ---------- price ----------
const price = () => latest?.price ?? 0;
async function refreshPrice(): Promise<void> {
  try {
    latest = await engine.oracle.latest();
    priceLate = false;
  } catch (e) {
    if (!priceLate) say(explain("price", e), "bad");
    priceLate = true;
  }
  showPrice();
}
function showPrice(): void {
  const out = $("price");
  out.textContent = usd(price());
  out.classList.toggle("late", priceLate);
  out.title = priceLate ? "This price is not current: the price feed is not answering." : "";
}
function setTestPrice(cents: number): void {
  if (!(cents > 0)) return;
  testPrice = Math.round(cents);
  store.set("testPrice", testPrice);
  $<HTMLInputElement>("manual").value = (testPrice / 100).toFixed(0);
  void refresh();
}

// ---------- the pot rail ----------
interface RailLevels {
  side: number;
  entryPrice: number;
  liquidation: number;
  takeProfit: number;
}
function rail(p: RailLevels, current: number): HTMLElement {
  const lo = Math.min(p.liquidation || p.entryPrice, p.takeProfit || p.entryPrice);
  let hi = Math.max(p.liquidation || p.entryPrice, p.takeProfit || p.entryPrice);
  if ((!p.takeProfit && p.side === 0) || (!p.liquidation && p.side === 1)) hi = p.entryPrice * 2;
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / Math.max(1, hi - lo)) * 100)).toFixed(2)}%`;
  const node = el("div", { className: `rail ${p.side ? "is-short" : ""}` });
  node.style.setProperty("--entry", at(p.entryPrice));
  node.style.setProperty("--now", at(current || p.entryPrice));
  const liq = el("div", {}, el("span", { className: "short", textContent: "Liquidated at" }), el("b", { className: "num", textContent: usd(p.liquidation) }));
  const tp = el("div", {}, el("span", { className: "long", textContent: "Take profit at" }), el("b", { className: "num", textContent: usd(p.takeProfit) }));
  node.append(
    el("div", { className: "bar" }, el("span", { className: "tick" }), current ? el("span", { className: "now" }) : null),
    el("div", { className: "ends" }, ...(p.side ? [tp, liq] : [liq, tp])),
  );
  return node;
}

// ---------- ticket ----------
function seg(container: HTMLElement, values: number[], label: (v: number) => string, current: () => number, pick: (v: number) => void): void {
  container.replaceChildren(
    ...values.map((v) => {
      const b = el("button", { textContent: label(v), type: "button" });
      b.setAttribute("aria-pressed", String(v === current()));
      b.onclick = () => {
        pick(v);
        seg(container, values, label, current, pick);
        void refreshQuote();
      };
      return b;
    }),
  );
}
function tradeTerms(maxCarryBps: number, maxSpreadBps: number): TradeTerms {
  const slippage = Number($<HTMLSelectElement>("slippage").value);
  const p = price();
  return {
    traderPk: account.pub,
    traderProgram: payoutProgram,
    side,
    leverage,
    capBps: Math.min(cap, leverage) * 10000,
    limitPrice: side === 0 ? Math.ceil((p * (10000 + slippage)) / 10000) : Math.floor((p * (10000 - slippage)) / 10000),
    duration: Number($<HTMLSelectElement>("duration").value),
    deadline: now() + 3600,
    maxCarryBps,
    maxSpreadBps,
  };
}
let quoteSeq = 0;
async function refreshQuote(): Promise<void> {
  const box = $("quote");
  const margin = Math.floor(Number($<HTMLInputElement>("margin").value));
  const seq = ++quoteSeq;
  let next: Quote | null = null;
  let problem = "";
  if (!price()) problem = "Waiting for a price.";
  else if (!(margin >= MIN_MARGIN)) problem = `The smallest margin is ${fmtSats(MIN_MARGIN)}.`;
  if (!problem) {
    try {
      // the preview accepts any fee; the address then pins the ones it was quoted
      next = await engine.quote(tradeTerms(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), margin, price());
    } catch (e) {
      problem = offers.length
        ? explain("quote", e)
        : "Nobody is offering liquidity yet. Offer some under Earn, or come back later.";
    }
  }
  if (seq !== quoteSeq) return;
  quote = next;
  if (!quote) {
    box.replaceChildren(el("p", { className: "hint bad quote-problem", textContent: problem }));
  } else {
    const q = quote;
    const fact = (label: string, value: string, tone = "") =>
      el("div", {}, el("dt", { textContent: label }), el("dd", { className: `num ${tone}`, textContent: value }));
    box.replaceChildren(
      rail({ ...q, side }, 0),
      el(
        "dl",
        { className: "facts" },
        fact("Position size", `${usd((q.notional * q.entryPrice) / 1e8)} (${fmtSats(q.notional)})`),
        fact("Opens at about", usd(q.entryPrice)),
        fact("Most you can lose", fmtSats(q.margin), "short"),
        fact("Most you can win", fmtSats(q.houseMargin), "long"),
        fact("Spread in the price", pct(q.offer.spreadBps)),
        fact("Holding fee", q.carryPerDay ? `${fmtSats(q.carryPerDay)} a day` : "none"),
        fact("Closes itself", `after ${durationName(Number($<HTMLSelectElement>("duration").value))}`),
      ),
    );
  }
  $<HTMLButtonElement>("create-trade").disabled = !quote || !payoutProgram;
}

function checkPayout(input: HTMLInputElement): void {
  const address = input.value.trim();
  const inputs = [...document.querySelectorAll<HTMLInputElement>(".payout")];
  for (const other of inputs) if (other !== input) other.value = address;
  payoutProgram = "";
  let text = "";
  let cls = "hint";
  if (address) {
    try {
      payoutProgram = engine.program(address);
      store.set("payout", address);
      text = "Payouts go here.";
      cls = "hint good";
    } catch (e) {
      text = explain("program", e);
      cls = "hint bad";
    }
  }
  for (const h of [$("payout-hint"), $("payout2-hint")]) {
    h.textContent = text;
    h.className = cls;
  }
  for (const i of inputs) i.classList.toggle("bad", cls === "hint bad");
  $<HTMLButtonElement>("create-trade").disabled = !quote || !payoutProgram;
  $<HTMLButtonElement>("create-offer").disabled = !payoutProgram;
}

function createTrade(): void {
  if (!quote) return;
  // the address accepts the quoted fees, and a spread a little above it should that offer go
  const terms = tradeTerms(quote.offer.carryBps, quote.offer.spreadBps + SPREAD_HEADROOM_BPS);
  const d = engine.tradeDeposit(terms);
  const amount = Math.floor(Number($<HTMLInputElement>("margin").value));
  const trade: TradeDeposit = { terms, ...d, state: "waiting", note: "", amount, created: now() };
  trades.unshift(trade);
  store.set("trades", trades);
  delegate(trade, "trades", trades, engine.refundDelegation(terms));
  say(`${side ? "Short" : "Long"} ${leverage}× prepared. Send your margin to the address shown.`);
  render();
  $("pending-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function createOffer(): void {
  const terms: OfferTerms = {
    lpPk: account.pub,
    lpProgram: payoutProgram,
    spreadBps: Math.round(Number($<HTMLInputElement>("spread").value) * 100),
    maxLeverage: Number($<HTMLSelectElement>("maxlev").value),
    maxDuration: Number($<HTMLSelectElement>("maxdur").value),
    carryBps: Math.round(Number($<HTMLInputElement>("carry").value) * 100),
  };
  if (!(terms.spreadBps >= 0 && terms.spreadBps <= 500)) throw new Error("Choose a spread between 0% and 5%.");
  if (!(terms.carryBps >= 0 && terms.carryBps <= 500)) throw new Error("Choose a holding fee between 0% and 5% a day.");
  const d = engine.offerDeposit(terms);
  const offer: OfferDeposit = { terms, ...d, state: "waiting", note: "", created: now() };
  offerDeposits.unshift(offer);
  store.set("offerDeposits", offerDeposits);
  delegate(offer, "offerDeposits", offerDeposits, engine.offerDelegation(terms));
  say("Offer prepared. Send the liquidity to the address shown.");
  render();
  $("pending-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Hands an address to the network's executor, which then acts on a payment with no page open.
function delegate(d: Pending, key: string, list: Pending[], delegation: ReturnType<Engine["offerDelegation"]>): void {
  void executor?.delegate(delegation).then((taken) => {
    if (!taken) return;
    d.delegated = true;
    store.set(key, list);
    render();
  });
}

// ---------- the keeper: what the page does by itself ----------
async function settleDeposits(): Promise<void> {
  // An address stays payable after its trade opened, was removed from view, or stopped accepting
  // trades, so it is watched for a week past its deadline: a late payment can still be refunded.
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].state === "done" && now() > trades[i].terms.deadline + WATCH_AFTER_DEADLINE) trades.splice(i, 1);
  }
  for (const t of trades) {
    try {
      const unspent = (await engine.coins(t.script)).filter((c) => !c.spent);
      if (!unspent.length) {
        // a funded deposit whose coin is gone was opened or refunded, here or by someone else
        if (t.state !== "waiting" || now() > t.terms.deadline) t.state = "done";
        continue;
      }
      t.funded = unspent[0].amount;
      if (now() > t.terms.deadline) {
        t.state = "stuck";
        t.note = "This address stopped accepting trades before yours opened. Cancel it to get your payment back.";
        continue;
      }
      t.state = "opening";
      t.note = "";
      render();
      const q = await engine.fill(t.terms);
      t.state = "done";
      say(`${t.terms.side ? "Short" : "Long"} ${t.terms.leverage}× opened at ${usd(q.entryPrice)} with ${fmtSats(q.margin)}.`, "good");
    } catch (e) {
      if (e instanceof NoCoinError) {
        t.state = "waiting";
        continue;
      }
      t.state = "stuck";
      t.note = explain("fill", e);
    }
  }
  for (const d of offerDeposits) {
    try {
      const unspent = (await engine.coins(d.script)).filter((c) => !c.spent);
      if (!unspent.length) {
        if (d.state !== "waiting") d.state = "done";
        continue;
      }
      d.funded = unspent[0].amount;
      d.state = "opening";
      d.note = "";
      render();
      await engine.register(d.terms);
      d.state = "done";
      say(`Your offer of ${fmtSats(unspent[0].amount)} is live.`, "good");
    } catch (e) {
      if (e instanceof NoCoinError) {
        d.state = "waiting";
        continue;
      }
      d.state = "stuck";
      d.note = explain("register", e);
    }
  }
  store.set("trades", trades);
  store.set("offerDeposits", offerDeposits);
}
const myPrograms = () =>
  new Set([payoutProgram, ...trades.map((t) => t.terms.traderProgram), ...offerDeposits.map((d) => d.terms.lpProgram)].filter(Boolean));
const isMine = (p: Position) => p.traderPk === xonly(account.pub);
const isAgainstMe = (p: Position) => !isMine(p) && myPrograms().has(p.lpProgram);

async function settleResolvable(): Promise<boolean> {
  let settled = false;
  for (const p of positions) {
    if (!p.resolvable || !(isMine(p) || isAgainstMe(p))) continue;
    try {
      const at = await engine.resolve(p);
      settled = true;
      const mine = isMine(p);
      const got = mine ? p.traderAmount : p.amount - p.traderAmount;
      const why = now() >= p.expiry ? "reached its end" : p.traderAmount <= p.margin / 100 ? "was liquidated" : "hit its take-profit";
      say(`${mine ? "Your" : "A"} ${p.side ? "short" : "long"} ${why} at ${usd(at.price)}: ${fmtSats(got)} paid to you.`, got > 0 ? "good" : "bad");
    } catch (e) {
      if (!(e instanceof NoCoinError)) say(explain("resolve", e), "bad");
    }
  }
  return settled;
}

async function loadPositions(): Promise<Priced[]> {
  if (!latest) return [];
  // a position settles on the signed price and its time, not on this computer's clock
  const { price: p, time: at } = latest;
  return (await engine.positions()).map((position) => ({
    ...position,
    traderAmount: payouts(position, p, at).trader,
    resolvable: resolvable(position, p, at),
    ...levels(position, at),
    fee: fee(position, at),
  }));
}

async function refresh(): Promise<void> {
  if (busy || !engine) return;
  busy = true;
  try {
    await refreshPrice();
    offers = await engine.offers();
    await settleDeposits();
    offers = await engine.offers();
    positions = await loadPositions();
    if (await settleResolvable()) positions = await loadPositions();
  } catch (e) {
    say(explain("refresh", e), "bad");
  }
  busy = false;
  render();
  void refreshQuote();
}

// ---------- rendering ----------
function act(label: string, action: string, fn: () => Promise<void>, cls = "btn small"): HTMLButtonElement {
  const b = el("button", { className: cls, textContent: label, type: "button" });
  b.onclick = async () => {
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      say(explain(action, e), "bad");
    }
    await refresh();
  };
  return b;
}
function confirmable(id: string, label: string, question: string, yes: string, action: string, fn: () => Promise<void>): HTMLElement {
  if (!confirming.has(id)) {
    const b = el("button", { className: "btn small", textContent: label, type: "button" });
    b.onclick = () => {
      confirming.add(id);
      render();
    };
    return b;
  }
  const keep = el("button", { className: "btn small", textContent: "Not now", type: "button" });
  keep.onclick = () => {
    confirming.delete(id);
    render();
  };
  const go = act(yes, action, async () => {
    confirming.delete(id);
    await fn();
  }, "btn small danger");
  return el("div", { className: "confirm" }, el("span", { textContent: question }), go, keep);
}

function depositCard<D extends TradeDeposit | OfferDeposit>(d: D, list: D[], key: string, trade: TradeDeposit | null): HTMLElement {
  const want = trade
    ? `Send about ${fmtSats(trade.amount)} to open your ${trade.terms.side ? "short" : "long"} ${trade.terms.leverage}×`
    : "Send the bitcoin you want to offer";
  const steps = trade
    ? ["Waiting for your payment", "Opening the position", "Open"]
    : ["Waiting for your payment", "Publishing the offer", "Live"];
  const at = d.state === "waiting" ? 0 : 1;
  const copy = el("button", { className: "btn small", textContent: "Copy address", type: "button" });
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(d.address);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Select and copy it";
    }
  };
  const actions: HTMLElement[] = [copy];
  const funded = d.state === "stuck" || d.state === "opening";
  if (trade && funded) {
    actions.push(
      confirmable(`cancel-${d.address}`, "Cancel and refund", `Send ${fmtSats(d.funded ?? 0)} back to your address?`, "Refund it", "cancel", async () => {
        await engine.cancel(trade.terms, account.key);
        d.state = "done";
        say(`Deposit cancelled: ${fmtSats(d.funded ?? 0)} sent back to you.`, "good");
      }),
    );
  }
  if (!funded) {
    // hiding keeps the address watched: a payment already on its way is not lost
    const hide = el("button", { className: "btn small", textContent: "Hide", type: "button" });
    hide.onclick = () => {
      d.state = "done";
      store.set(key, list);
      render();
    };
    actions.push(hide);
  }
  return el(
    "div",
    { className: "item" },
    el("h3", { textContent: want }),
    el(
      "div",
      { className: "pay" },
      qrSvg(d.address),
      el(
        "div",
        {},
        el("div", { className: "addr", textContent: d.address }),
        el("ol", { className: "steps" }, ...steps.map((s, i) => el("li", { className: i < at ? "done" : i === at ? "now" : "", textContent: s }))),
      ),
    ),
    d.note ? el("div", { className: "notice", textContent: d.note }) : null,
    d.delegated && d.state === "waiting"
      ? el("p", { className: "hint", textContent: trade ? "If it has not opened when the address stops accepting trades, the network's executor sends your payment back, even with this page closed." : "The network's executor publishes your offer when the payment arrives, even with this page closed." })
      : null,
    trade && d.state === "waiting"
      ? el("p", { className: "hint", textContent: `This address accepts a payment for the next ${until(trade.terms.deadline).replace("in ", "")}. Entry limit ${usd(trade.terms.limitPrice)}.` })
      : null,
    el("div", { className: "row-actions" }, ...actions),
  );
}

function positionCard(p: Priced, mine: boolean): HTMLElement {
  const mineAmount = mine ? p.traderAmount : p.amount - p.traderAmount;
  const stake = mine ? p.margin : p.houseMargin;
  const pnl = mineAmount - stake;
  const lev = Math.round(p.notional / Math.max(1, p.margin));
  const fact = (label: string, value: string) =>
    el("div", {}, el("dt", { textContent: label }), el("dd", { className: "num", textContent: value }));
  const kids: Child[] = [
    el(
      "div",
      { className: "pos-head" },
      el(
        "div",
        {},
        el("span", { className: `tag ${p.side ? "short" : "long"}`, textContent: `${p.side ? "Short" : "Long"} ${lev}×` }),
        " ",
        el("span", { className: "num", textContent: usd((p.notional * p.entryPrice) / 1e8) }),
        " ",
        el("span", { className: "muted", textContent: mine ? `from ${usd(p.entryPrice)}` : `against your offer, from ${usd(p.entryPrice)}` }),
      ),
      el("div", { className: `pnl num ${pnl >= 0 ? "long" : "short"}`, textContent: signed(pnl) }),
    ),
    rail(p, price()),
    el(
      "dl",
      { className: "facts" },
      fact(mine ? "Your margin" : "Your stake", fmtSats(stake)),
      fact("Yours if settled now", fmtSats(mineAmount)),
      fact("Closes itself", until(p.expiry)),
      fact(mine ? "Holding fee so far" : "Holding fee earned", p.carryBps ? fmtSats(p.fee) : "none"),
    ),
  ];
  if (p.expiresAt && p.expiresAt - now() < 7200 && p.expiresAt < p.expiry + 3600) {
    kids.push(el("div", { className: "notice", textContent: `The coin holding this position expires ${until(p.expiresAt)}. ${mine ? "Close it before then." : "It must be settled before then."}` }));
  }
  if (mine) {
    kids.push(
      el(
        "div",
        { className: "row-actions" },
        confirmable(`close-${p.txid}`, "Close position", `Close now for ${fmtSats(p.traderAmount)}?`, "Close it", "close", async () => {
          const at = await engine.close(p, account.key);
          say(`Position closed at ${usd(at.price)}: about ${fmtSats(p.traderAmount)} paid to you (${signed(pnl)}).`, pnl >= 0 ? "good" : "bad");
        }),
      ),
    );
  }
  return el("div", { className: "item" }, ...kids);
}

function render(): void {
  showPrice();
  const pending = [
    ...trades.filter((t) => t.state !== "done").map((t) => depositCard(t, trades, "trades", t)),
    ...offerDeposits.filter((d) => d.state !== "done").map((d) => depositCard(d, offerDeposits, "offerDeposits", null)),
  ];
  $("pending-panel").hidden = !pending.length;
  $("pending").replaceChildren(...pending);

  const mine = positions.filter(isMine);
  $("mine").replaceChildren(
    ...(mine.length
      ? mine.map((p) => positionCard(p, true))
      : [el("p", { className: "empty", textContent: "You have no open position. Pick a direction on the left, get an address and pay it." })]),
  );

  const myOffers = offers.filter((o) => o.lpPk === xonly(account.pub));
  const against = positions.filter(isAgainstMe);
  $("lp-panel").hidden = !myOffers.length && !against.length;
  $("my-offers").replaceChildren(
    ...myOffers.map((o) =>
      el(
        "div",
        { className: "item" },
        el(
          "div",
          { className: "pos-head" },
          el("div", {}, el("b", { className: "num", textContent: fmtSats(o.amount) }), " ", el("span", { className: "muted", textContent: `available at ${pct(o.spreadBps)} spread and ${pct(o.carryBps)} a day, up to ${o.maxLeverage}×` })),
          el("span", { className: "muted", textContent: o.expiresAt ? `usable ${until(o.expiresAt).replace("in ", "for ")}` : "" }),
        ),
        o.expiresAt && o.expiresAt - now() < 7200
          ? el("div", { className: "notice", textContent: `This offer's coin expires ${until(o.expiresAt)}. Withdraw it and offer again to keep it safe.` })
          : null,
        el(
          "div",
          { className: "row-actions" },
          confirmable(`withdraw-${o.txid}`, "Withdraw", `Send ${fmtSats(o.amount)} back to your address?`, "Withdraw it", "withdraw", async () => {
            await engine.withdraw(o, account.key);
            say(`Offer withdrawn: ${fmtSats(o.amount)} sent to you.`, "good");
          }),
        ),
      ),
    ),
  );
  $("against").replaceChildren(...against.map((p) => positionCard(p, false)));

  const liquidity = offers.reduce((s, o) => s + o.amount, 0);
  const openInterest = positions.reduce((s, p) => s + p.notional, 0);
  $("market-summary").textContent = offers.length
    ? `${fmtSats(liquidity)} offered by ${offers.length} ${offers.length === 1 ? "offer" : "offers"}. ${positions.length} open ${positions.length === 1 ? "position" : "positions"} worth ${fmtSats(openInterest)}.`
    : "Nobody is offering liquidity yet. The first offer opens the market.";
  $("offers").replaceChildren(
    ...[...offers]
      .sort((a, b) => a.spreadBps - b.spreadBps)
      .map((o) =>
        el(
          "tr",
          {},
          el("td", { className: "num", textContent: fmtSats(o.amount) }),
          el("td", { className: "num", textContent: pct(o.spreadBps) }),
          el("td", { className: "num", textContent: pct(o.carryBps) }),
          el("td", { className: "num", textContent: `${o.maxLeverage}×` }),
          el("td", { textContent: durationName(o.maxDuration) }),
          el("td", { className: "muted", textContent: !o.expiresAt ? "–" : o.expiresAt <= now() ? "expired" : until(o.expiresAt).replace("in ", "") }),
        ),
      ),
  );
}

function pickSide(s: number): void {
  side = s;
  $("side-long").setAttribute("aria-pressed", String(s === 0));
  $("side-short").setAttribute("aria-pressed", String(s === 1));
  void refreshQuote();
}
function pickTab(name: "trade" | "earn"): void {
  for (const t of ["trade", "earn"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`view-${t}`).hidden = t !== name;
  }
}
const guarded = (action: string, fn: () => void) => () => {
  try {
    fn();
  } catch (e) {
    say(explain(action, e), "bad");
  }
};

async function boot(): Promise<void> {
  const oracle = net === "regtest" ? localOracle(sha256(new TextEncoder().encode(TEST_ORACLE_SEED)), () => testPrice) : dia();
  engine = await Engine.connect({ ...NETWORKS[net], oracle });
  void Executor.connect(NETWORKS[net].executorUrl, engine.keys, Object.values(templateIds)).then((e) => {
    executor = e;
  });
  const saved = store.get<Account | null>("account", null);
  account = saved ?? newAccount();
  if (!saved) store.set("account", account);

  const networks = $<HTMLSelectElement>("network");
  networks.replaceChildren(
    ...(Object.keys(NETWORKS) as Net[])
      .filter((n) => n !== "regtest" || net === "regtest")
      .map((n) => el("option", { value: n, textContent: NETWORKS[n].name, selected: n === net })),
  );
  networks.onchange = () => {
    try {
      localStorage.setItem("futures.net", networks.value);
    } catch {
      // the address carries the choice
    }
    location.search = `?net=${networks.value}`;
  };
  $("mainnet-warning").hidden = net !== "mainnet";
  $("oracle-toggle").hidden = net !== "regtest";
  $<HTMLAnchorElement>("oracle-link").hidden = net === "regtest";
  $<HTMLAnchorElement>("oracle-link").href = DIA_EXPLORER;
  for (const input of document.querySelectorAll<HTMLInputElement>(".payout")) {
    input.placeholder = net === "mainnet" ? "ark1…" : "tark1…";
  }
  $<HTMLAnchorElement>("how-link").href = `./how.html${location.search}`;
  for (const id of ["duration", "maxdur"]) {
    $(id).replaceChildren(...DURATIONS.map(([v, name]) => el("option", { value: String(v), textContent: name })));
  }
  $<HTMLSelectElement>("duration").value = net === "regtest" ? "240" : "3600";
  $<HTMLSelectElement>("maxdur").value = "604800";
  const drawCap = () => seg($("cap"), CAPS.filter((v) => v <= leverage), (v) => `+${v * 100}%`, () => cap, (v) => { cap = v; });
  seg($("leverage"), LEVERAGES, (v) => `${v}×`, () => leverage, (v) => {
    leverage = v;
    if (cap > v) cap = v;
    drawCap();
  });
  drawCap();

  $("side-long").onclick = () => pickSide(0);
  $("side-short").onclick = () => pickSide(1);
  $("tab-trade").onclick = () => pickTab("trade");
  $("tab-earn").onclick = () => pickTab("earn");
  for (const id of ["margin", "duration", "slippage"]) $(id).addEventListener("input", () => void refreshQuote());
  for (const input of document.querySelectorAll<HTMLInputElement>(".payout")) {
    input.addEventListener("input", () => checkPayout(input));
  }
  $("create-trade").onclick = guarded("trade", createTrade);
  $("create-offer").onclick = guarded("offer", createOffer);
  $("oracle-toggle").onclick = () => {
    const open = $("oracle").hidden;
    $("oracle").hidden = !open;
    $("oracle-toggle").setAttribute("aria-expanded", String(open));
  };
  $<HTMLInputElement>("manual").value = (testPrice / 100).toFixed(0);
  $("manual").addEventListener("change", () => setTestPrice(Number($<HTMLInputElement>("manual").value) * 100));
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-nudge]")) {
    b.onclick = () => setTestPrice(testPrice * (1 + Number(b.dataset.nudge) / 100));
  }
  $("show-key").onclick = () => {
    const out = $("key-out");
    out.hidden = false;
    const backup = JSON.stringify({ key: account.key, trades, offerDeposits });
    out.replaceChildren(
      el("p", { className: "hint", textContent: "Keep this text somewhere safe. It holds your key and the addresses you created." }),
      el("textarea", { readOnly: true, value: backup, rows: 4 }),
    );
  };
  $("restore-key").onclick = () => {
    const out = $("key-out");
    out.hidden = false;
    const input = el("textarea", { placeholder: "Paste a backup, or a 64-character key", spellcheck: false, rows: 4 });
    const save = el("button", { className: "btn small restore", textContent: "Restore", type: "button" });
    let armed = false;
    save.onclick = () => {
      let restored: Account;
      let extra: { trades?: TradeDeposit[]; offerDeposits?: OfferDeposit[] } = {};
      try {
        const text = input.value.trim();
        if (text.startsWith("{")) {
          extra = JSON.parse(text) as typeof extra & { key: string };
          restored = accountFrom(String((extra as { key?: string }).key ?? "").toLowerCase());
        } else {
          restored = accountFrom(text.toLowerCase());
        }
      } catch (e) {
        say(explain("key", e), "bad");
        return;
      }
      if (!armed && restored.key !== account.key) {
        armed = true;
        save.textContent = "Replace this browser's key";
        save.classList.add("danger");
        out.append(el("p", { className: "hint bad", textContent: "Offers and trades made with the current key can only be managed with it. Back it up first if you have not." }));
        return;
      }
      account = restored;
      store.set("account", account);
      const known = new Set([...trades, ...offerDeposits].map((d) => d.address));
      for (const t of extra.trades ?? []) if (!known.has(t.address)) trades.push(t);
      for (const d of extra.offerDeposits ?? []) if (!known.has(d.address)) offerDeposits.push(d);
      store.set("trades", trades);
      store.set("offerDeposits", offerDeposits);
      out.hidden = true;
      say("Backup restored.", "good");
      void refresh();
    };
    out.replaceChildren(input, save);
  };

  const savedPayout = store.get("payout", "");
  if (savedPayout) {
    $<HTMLInputElement>("payout").value = savedPayout;
    checkPayout($<HTMLInputElement>("payout"));
  }
  $("storage-warning").hidden = storageWorks;
  $("boot").hidden = true;
  $("app").hidden = false;
  renderLog();
  render();
  await refresh();
  setInterval(() => void refresh(), REFRESH_MS);
}

boot().catch((e) => {
  $("boot-msg").textContent = `Could not start: ${explain("connect", e)}`;
});
