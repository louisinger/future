import "./style.css";
import { type PositionState, fee, houseShare, levels, resolvable } from "@louisinger/future-sdk";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sats = (n: number) => `${Math.round(n).toLocaleString("en-US")} sats`;
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
type Child = Node | string;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

// keep the network the reader came from
for (const id of ["back", "back-brand"]) $<HTMLAnchorElement>(id).href = `./${location.search}`;

// ---------- every transaction ----------
type Kind = "wallet" | "contract" | "payout";
interface Coin {
  kind: Kind;
  name: string;
  /** For a spent coin, the contract function that allows the spend; for a new one, what pins it. */
  sub: string;
}
interface Tx {
  id: string;
  title: string;
  what: string;
  action: string;
  inputs: Coin[];
  outputs: Coin[];
  who: string;
  signed: string;
  notes: string;
  rules: { by: string; checks: string[] }[];
}

const TXS: Tx[] = [
  {
    id: "pay-offer",
    title: "1. A provider pays their offer deposit",
    what: "The page turns the provider's terms into an address. Paying it is an ordinary send from any Arkade wallet, which knows nothing about the market.",
    action: "Send",
    inputs: [{ kind: "wallet", name: "Provider's coin", sub: "their own wallet" }],
    outputs: [
      { kind: "contract", name: "Offer deposit", sub: "holds the liquidity" },
      { kind: "wallet", name: "Change", sub: "back to the wallet, if any" },
    ],
    who: "The provider",
    signed: "The provider's wallet",
    notes: "None",
    rules: [{ by: "Nothing yet", checks: ["A payment is not checked. The rules start with what the address allows next."] }],
  },
  {
    id: "register",
    title: "2. The deposit becomes an offer",
    what: "The deposit moves to the market's offer address and gains a note listing the provider's terms. From here everyone can see it.",
    action: "Register",
    inputs: [{ kind: "contract", name: "Offer deposit", sub: "OfferDeposit.register" }],
    outputs: [{ kind: "contract", name: "Offer", sub: "same sats, with its note" }],
    who: "Anyone",
    signed: "Nobody",
    notes: "Offer note (64) written",
    rules: [
      {
        by: "OfferDeposit.register",
        checks: [
          "It is the only coin spent",
          "The new coin is at the market's offer address",
          "It holds at least what the deposit held",
          "The offer note is exactly the terms in the deposit's address",
        ],
      },
    ],
  },
  {
    id: "pay-trade",
    title: "3. A trader pays their trade deposit",
    what: "Direction, leverage, take-profit, the worst entry price and the highest fees the trader accepts are all part of this address. Whatever lands here is the margin.",
    action: "Send",
    inputs: [{ kind: "wallet", name: "Trader's coin", sub: "their own wallet" }],
    outputs: [
      { kind: "contract", name: "Trade deposit", sub: "holds the margin" },
      { kind: "wallet", name: "Change", sub: "back to the wallet, if any" },
    ],
    who: "The trader",
    signed: "The trader's wallet",
    notes: "None",
    rules: [{ by: "Nothing yet", checks: ["A payment is not checked. The address decides what can happen to it next."] }],
  },
  {
    id: "open",
    title: "4. The trade opens",
    what: "One transaction spends the deposit and an offer together. The most the trader can win leaves the offer and joins the trader's margin in a new coin: the position. Two contracts check the same transaction, each protecting its own side.",
    action: "Open",
    inputs: [
      { kind: "contract", name: "Trade deposit", sub: "TradeDeposit.fill" },
      { kind: "contract", name: "Price oracle", sub: "checks DIA's signature" },
      { kind: "contract", name: "Offer", sub: "Offer.fill" },
    ],
    outputs: [
      { kind: "contract", name: "Price oracle", sub: "put straight back" },
      { kind: "contract", name: "Position", sub: "margin + maximum profit" },
      { kind: "contract", name: "Offer", sub: "what is left, same note" },
    ],
    who: "Anyone, with a DIA price signed in the last two minutes",
    signed: "Nobody. DIA's signed price rides along, and the price oracle checks it.",
    notes: "Price (34), offer note (64) carried, position note (65) written",
    rules: [
      {
        by: "TradeDeposit.fill protects the trader",
        checks: [
          "The price comes from the price oracle, and the position starts at that moment",
          "Entry is within the trader's limit and within their spread cap of the signed price",
          "The note names the trader's key and payout address, their direction and leverage",
          "Margin is exactly what the deposit holds; size is margin × leverage",
          "The provider's margin is at least the take-profit the trader asked for",
          "The holding fee is within the trader's cap",
          "The position ends exactly when the trader chose",
          "The new coin is at the position address and holds both margins",
          "The deposit's deadline has not passed",
        ],
      },
      {
        by: "Offer.fill protects the provider",
        checks: [
          "The price comes from the price oracle and is fresh, and the position starts at that moment",
          "Entry is no better than the signed price moved by the offer's spread",
          "Leverage and duration respect the offer's limits",
          "The holding fee in the note is the offer's",
          "Both margins are at least 5,000 sats; the trade lasts at least a minute",
          "The position pays the provider's address and holds both margins",
          "Only the provider's margin leaves; the rest returns to the same offer address with the same note",
          "Exactly three coins are spent, the deposit, the oracle and the offer, so one offer cannot fund two trades at once",
        ],
      },
    ],
  },
  {
    id: "settle",
    title: "5. The position settles",
    what: "At its end date the pot is split by the formula below. Before that, anyone can settle it the moment one side's margin is used up: that is a liquidation when it is the trader's, and the take-profit when it is the provider's.",
    action: "Settle",
    inputs: [
      { kind: "contract", name: "Position", sub: "Position.resolve" },
      { kind: "contract", name: "Price oracle", sub: "checks DIA's signature" },
    ],
    outputs: [
      { kind: "contract", name: "Price oracle", sub: "put straight back" },
      { kind: "payout", name: "Trader's address", sub: "the pot minus the provider's share" },
      { kind: "payout", name: "Provider's address", sub: "the provider's share" },
    ],
    who: "Anyone, with a signed price",
    signed: "Nobody. DIA's signed price rides along, and the price oracle checks it.",
    notes: "Price (34)",
    rules: [
      {
        by: "Position.resolve",
        checks: [
          "The price comes from the price oracle, at a time after the position started",
          "Either that time is past the end date, or one side is down to 1% of the trader's margin",
          "The provider gets what the formula gives, the trader the rest",
          "Both are paid to the addresses in the position's note",
          "A share of 330 sats or less is folded into the other, leaving a single payout",
          "Only the position and the price oracle are spent",
        ],
      },
    ],
  },
  {
    id: "close",
    title: "6. The trader closes early",
    what: "The same split, at any moment the trader chooses. Only the trader's key allows it, and only at a price signed in the last two minutes.",
    action: "Close",
    inputs: [
      { kind: "contract", name: "Position", sub: "Position.close" },
      { kind: "contract", name: "Price oracle", sub: "checks DIA's signature" },
    ],
    outputs: [
      { kind: "contract", name: "Price oracle", sub: "put straight back" },
      { kind: "payout", name: "Trader's address", sub: "the pot minus the provider's share" },
      { kind: "payout", name: "Provider's address", sub: "the provider's share" },
    ],
    who: "The trader",
    signed: "The key in the position's note signs this coin's identity",
    notes: "Price (34)",
    rules: [
      {
        by: "Position.close",
        checks: [
          "The trader's key signed for this exact coin",
          "The price comes from the price oracle, after the start and less than two minutes ago",
          "Same formula, same addresses and same folding as a settlement",
          "Only the position and the price oracle are spent",
        ],
      },
    ],
  },
  {
    id: "cancel",
    title: "7. The trader cancels a deposit",
    what: "A deposit that has not opened can be taken back at any time.",
    action: "Cancel",
    inputs: [{ kind: "contract", name: "Trade deposit", sub: "TradeDeposit.cancel" }],
    outputs: [{ kind: "payout", name: "Trader's address", sub: "all of it" }],
    who: "The trader",
    signed: "The key in the deposit's address signs this coin's identity",
    notes: "None",
    rules: [{ by: "TradeDeposit.cancel", checks: ["The trader's key signed for this exact coin", "Everything goes to the trader's address", "It is the only coin spent"] }],
  },
  {
    id: "refund",
    title: "8. A deposit is refunded after its deadline",
    what: "Past its deadline a deposit can no longer open a trade. Anyone can send it home, without the trader's key.",
    action: "Refund",
    inputs: [{ kind: "contract", name: "Trade deposit", sub: "TradeDeposit.refund" }],
    outputs: [{ kind: "payout", name: "Trader's address", sub: "all of it" }],
    who: "Anyone, once the deadline has passed",
    signed: "Nobody",
    notes: "None",
    rules: [{ by: "TradeDeposit.refund", checks: ["The deadline has passed, on the operator's clock and on bitcoin's", "Everything goes to the trader's address", "It is the only coin spent"] }],
  },
  {
    id: "withdraw",
    title: "9. The provider withdraws an offer",
    what: "Whatever is not locked in a position can be taken back at any time.",
    action: "Withdraw",
    inputs: [{ kind: "contract", name: "Offer", sub: "Offer.withdraw" }],
    outputs: [{ kind: "payout", name: "Provider's address", sub: "all of it" }],
    who: "The provider",
    signed: "The key in the offer's note signs this coin's identity",
    notes: "None",
    rules: [{ by: "Offer.withdraw", checks: ["The provider's key signed for this exact coin", "Everything goes to the address in the offer's note", "It is the only coin spent"] }],
  },
  {
    id: "renew",
    title: "10. An offer or a position is renewed",
    what: "Arkade coins expire. Near its expiry a coin can be carried into the next batch unchanged. The contracts allow it; this page does not do it for you yet.",
    action: "Renew",
    inputs: [{ kind: "contract", name: "Offer or position", sub: "Offer.renew · Position.renew" }],
    outputs: [{ kind: "contract", name: "The same coin", sub: "same address, same note" }],
    who: "Anyone, in the last day before expiry",
    signed: "Nobody",
    notes: "The coin's note carried unchanged",
    rules: [
      {
        by: "renew",
        checks: [
          "The coin is within a day of expiring",
          "The request only renews: it cannot move the coin on-chain",
          "The new coin has the same address, and the same note",
          "At most 1,000 sats are taken as the operator's fee",
        ],
      },
    ],
  },
  {
    id: "exit",
    title: "11. A deposit leaves on-chain",
    what: "The emergency path if the operator stops signing. Only deposits have one: offers and positions cannot name their owners in a bitcoin script.",
    action: "Exit",
    inputs: [{ kind: "contract", name: "A deposit, on-chain", sub: "TradeDeposit.exit · OfferDeposit.exit" }],
    outputs: [{ kind: "wallet", name: "Anywhere", sub: "the owner chooses" }],
    who: "The deposit's owner",
    signed: "The owner's key, after the operator's exit delay",
    notes: "None",
    rules: [{ by: "exit", checks: ["Checked by bitcoin itself, not by Arkade", "The operator's exit delay has passed since the coin reached the chain", "The owner's key signed"] }],
  },
];

const NS = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}
function diagram(tx: Tx): SVGSVGElement {
  const W = 760;
  const NODE_W = 250;
  const NODE_H = 56;
  const GAP = 18;
  const rows = Math.max(tx.inputs.length, tx.outputs.length);
  const H = rows * NODE_H + (rows - 1) * GAP + 24;
  const hub = { x: W / 2, y: H / 2, r: 44 };
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${tx.title}: ${tx.inputs.map((c) => c.name).join(" and ")} in, ${tx.outputs.map((c) => c.name).join(" and ")} out` });
  const yOf = (i: number, n: number) => H / 2 - (n * NODE_H + (n - 1) * GAP) / 2 + i * (NODE_H + GAP);
  const edges: SVGElement[] = [];
  const nodes: SVGElement[] = [];
  const draw = (coins: Coin[], x: number, into: boolean) => {
    coins.forEach((c, i) => {
      const y = yOf(i, coins.length);
      const mid = y + NODE_H / 2;
      const from = into ? x + NODE_W : hub.x;
      const to = into ? hub.x : x;
      const bend = (from + to) / 2;
      edges.push(svg("path", { class: "edge", d: `M${from} ${into ? mid : hub.y} C${bend} ${into ? mid : hub.y}, ${bend} ${into ? hub.y : mid}, ${to} ${into ? hub.y : mid}` }));
      nodes.push(
        svg("rect", { class: `node-${c.kind}`, x, y, width: NODE_W, height: NODE_H, rx: c.kind === "contract" ? 16 : 6 }),
        svg("text", { class: "name", x: x + 14, y: y + 23 }, c.name),
        svg("text", { class: "sub", x: x + 14, y: y + 41 }, c.sub),
      );
    });
  };
  draw(tx.inputs, 0, true);
  draw(tx.outputs, W - NODE_W, false);
  root.append(
    ...edges,
    ...nodes,
    svg("circle", { class: "hub", cx: hub.x, cy: hub.y, r: hub.r }),
    svg("text", { class: "hub-text", x: hub.x, y: hub.y + 4, "text-anchor": "middle" }, tx.action),
  );
  return root;
}
$("txs").replaceChildren(
  ...TXS.map((tx) =>
    h(
      "article",
      { className: "tx", id: tx.id },
      h("h3", { textContent: tx.title }),
      h("p", { textContent: tx.what }),
      h("div", { className: "diagram" }, diagram(tx)),
      h(
        "dl",
        { className: "meta" },
        h("div", {}, h("dt", { textContent: "Who can send it" }), h("dd", { textContent: tx.who })),
        h("div", {}, h("dt", { textContent: "Signed by" }), h("dd", { textContent: tx.signed })),
        h("div", {}, h("dt", { textContent: "Notes attached" }), h("dd", { textContent: tx.notes })),
      ),
      h(
        "div",
        { className: "rules" },
        ...tx.rules.map((r) =>
          h("div", {}, h("h4", { textContent: r.by }), h("ul", { className: "plain" }, ...r.checks.map((c) => h("li", { textContent: c })))),
        ),
      ),
    ),
  ),
);

// ---------- the four contracts ----------
const CONTRACTS: { name: string; what: string; terms: string; fns: [string, string, string][] }[] = [
  {
    name: "OfferDeposit",
    what: "The address a provider pays. One per set of terms.",
    terms: "In the address: the provider's key and payout address, spread, holding fee, highest leverage, longest trade.",
    fns: [
      ["register", "anyone", "register"],
      ["exit", "provider's key, on-chain", "exit"],
    ],
  },
  {
    name: "TradeDeposit",
    what: "The address a trader pays. One per trade.",
    terms: "In the address: the trader's key and payout address, direction, leverage, take-profit, price limit, spread and fee caps, duration, deadline.",
    fns: [
      ["fill", "anyone, with a signed price", "open"],
      ["cancel", "trader's key", "cancel"],
      ["refund", "anyone, after the deadline", "refund"],
      ["exit", "trader's key, on-chain", "exit"],
    ],
  },
  {
    name: "Offer",
    what: "A provider's liquidity. Every offer lives at this one address.",
    terms: "In the address: the price oracle's token and the position address. In its note: the provider's terms.",
    fns: [
      ["fill", "anyone, with a signed price", "open"],
      ["withdraw", "provider's key", "withdraw"],
      ["renew", "anyone, near expiry", "renew"],
    ],
  },
  {
    name: "Position",
    what: "One trade: both margins in one coin. Every position lives at this one address.",
    terms: "In the address: the price oracle's token. In its note: everything about the trade.",
    fns: [
      ["resolve", "anyone, with a signed price", "settle"],
      ["close", "trader's key", "close"],
      ["renew", "anyone, near expiry", "renew"],
    ],
  },
];
$("contracts").replaceChildren(
  ...CONTRACTS.map((c) =>
    h(
      "article",
      {},
      h("h3", { textContent: c.name }),
      h("p", { textContent: c.what }),
      h("p", { className: "hint", textContent: c.terms }),
      h("h4", { textContent: "Functions" }),
      ...c.fns.map(([fn, who, tx]) =>
        h("div", { className: "fn" }, h("a", { href: `#${tx}` }, h("code", { textContent: fn })), h("span", { className: "muted", textContent: who })),
      ),
    ),
  ),
);

// ---------- the payoff ----------
const ENTRY = 6_000_000;
const DAY = 86_400;
let demoSide = 0;
function demoPosition(): PositionState {
  // a spread of 0.10% moves the entry against the trader
  const entry = demoSide === 0 ? ENTRY + 6_000 : ENTRY - 6_000;
  return {
    side: demoSide, entryPrice: entry, notional: 100_000, margin: 10_000, houseMargin: 20_000,
    startAt: 0, expiry: 7 * DAY, carryBps: 5,
  };
}
function drawDemo(): void {
  const p = demoPosition();
  const price = Number($<HTMLInputElement>("demo-price").value) * 100;
  const days = Number($<HTMLInputElement>("demo-days").value);
  const at = Math.round(days * DAY);
  const pot = p.margin + p.houseMargin;
  const provider = houseShare(p, price, at);
  const trader = pot - provider;
  const { liquidation, takeProfit } = levels(p, at);

  $("demo-price-out").textContent = usd(price);
  $("demo-days-out").textContent = days === 0 ? "just opened" : `${days} ${days === 1 ? "day" : "days"}`;
  $("pot-trader").style.width = `${(trader / pot) * 100}%`;
  $("pot-trader").textContent = trader > 2_500 ? `Trader ${sats(trader)}` : "";
  $("pot-provider").textContent = provider > 2_500 ? `Provider ${sats(provider)}` : "";

  const lo = Math.min(liquidation, takeProfit);
  const hi = Math.max(liquidation, takeProfit);
  const at100 = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100)).toFixed(2)}%`;
  const rail = h("div", { className: `rail ${p.side ? "is-short" : ""}` });
  rail.style.setProperty("--entry", at100(p.entryPrice));
  rail.style.setProperty("--now", at100(price));
  const end = (cls: string, label: string, value: number) =>
    h("div", {}, h("span", { className: cls, textContent: label }), h("b", { className: "num", textContent: usd(value) }));
  const liq = end("short", "Liquidated at", liquidation);
  const tp = end("long", "Take profit at", takeProfit);
  rail.append(
    h("div", { className: "bar" }, h("span", { className: "tick" }), h("span", { className: "now" })),
    h("div", { className: "ends" }, ...(p.side ? [tp, liq] : [liq, tp])),
  );
  $("demo-rail").replaceChildren(rail);

  const fact = (label: string, value: string) =>
    h("div", {}, h("dt", { textContent: label }), h("dd", { className: "num", textContent: value }));
  const pnl = trader - p.margin;
  $("demo-facts").replaceChildren(
    fact("Opened at", usd(p.entryPrice)),
    fact("Size", `${sats(p.notional)} (10× of 10,000)`),
    fact("Trader's result", `${pnl >= 0 ? "+" : "−"}${sats(Math.abs(pnl))}`),
    fact("Holding fee paid so far", sats(fee(p, at))),
  );
  const ended = at >= p.expiry;
  const done = resolvable(p, price, at);
  $("demo-verdict").textContent = ended
    ? "The trade has reached its end: anyone may settle it at this split."
    : done && trader < p.margin
      ? "The trader's margin is used up: anyone may settle it now, and the provider takes the pot. This is a liquidation."
      : done
        ? "The provider's margin is used up: anyone may settle it now, and the trader takes the pot. This is the take-profit."
        : "Between the two ends only the trader can close it early. The holding fee slowly moves both ends toward the trader's loss.";
}
function pickDemoSide(s: number): void {
  demoSide = s;
  $("demo-long").setAttribute("aria-pressed", String(s === 0));
  $("demo-short").setAttribute("aria-pressed", String(s === 1));
  drawDemo();
}
$("demo-long").onclick = () => pickDemoSide(0);
$("demo-short").onclick = () => pickDemoSide(1);
$("demo-price").addEventListener("input", drawDemo);
$("demo-days").addEventListener("input", drawDemo);
drawDemo();
