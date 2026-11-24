// The market's arithmetic. It mirrors the position script exactly: integers only, division
// truncating toward zero. Amounts are sats, prices are USD cents, times are unix seconds.

export const BPS = 10_000;
export const MAINTENANCE = 100;
// The offer contract refuses a trade whose margin, or maximum profit, is below this: a stake must
// stay large next to the 330 sats that fold into the other side at settlement.
export const MIN_MARGIN = 5_000;
// The offer contract refuses a trade shorter than this.
export const MIN_DURATION = 60;
export const DUST_FOLD = 330;
const CARRY_PERIOD = BigInt(BPS) * 86_400n;
const SETTLE_WINDOW = 3_600;

export interface Coin {
  txid: string;
  vout: number;
  amount: number;
  script: string;
  spent: boolean;
  /** The transaction that spent it; empty while unspent, and when a batch took it. */
  spentBy: string;
  createdAt: number;
  expiresAt: number;
}

/** What a liquidity provider fixes in its deposit address. Keys and programs are hex. */
export interface OfferTerms {
  lpPk: string;
  lpProgram: string;
  spreadBps: number;
  maxLeverage: number;
  maxDuration: number;
  /** Holding fee, in basis points of a position's size per day. */
  carryBps: number;
}

/** What a trader fixes in its deposit address. */
export interface TradeTerms {
  traderPk: string;
  traderProgram: string;
  side: number;
  leverage: number;
  capBps: number;
  limitPrice: number;
  duration: number;
  deadline: number;
  /** The highest holding fee the trader accepts. */
  maxCarryBps: number;
  /** The widest spread around the signed price the trader accepts. */
  maxSpreadBps: number;
}

export interface Offer extends Coin {
  lpPk: string;
  lpProgram: string;
  spreadBps: number;
  maxLeverage: number;
  maxDuration: number;
  carryBps: number;
}

export interface PositionState {
  side: number;
  entryPrice: number;
  notional: number;
  margin: number;
  houseMargin: number;
  startAt: number;
  expiry: number;
  carryBps: number;
}

export interface Position extends Coin, PositionState {
  traderPk: string;
  traderProgram: string;
  lpProgram: string;
}

export interface Quote {
  offer: Offer;
  margin: number;
  notional: number;
  houseMargin: number;
  entryPrice: number;
  liquidation: number;
  takeProfit: number;
  carryPerDay: number;
}

export class NoOfferError extends Error {
  constructor(reason = "") {
    super(reason ? `no offer fits this trade: ${reason}` : "no offer fits this trade");
  }
}

const big = BigInt;
const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v);

/** The holding fee a position owes its provider at a time: it accrues from the start to the expiry. */
export function fee(p: PositionState, at: number): number {
  const held = Math.max(Math.min(at, p.expiry) - p.startAt, 0);
  return Number((big(p.notional) * big(p.carryBps) * big(held)) / CARRY_PERIOD);
}

/** What the provider takes of the pot at a price signed at a time. */
export function houseShare(p: PositionState, price: number, at: number): number {
  let pnl = (big(p.notional) * big(price - p.entryPrice)) / big(price);
  if (p.side === 1) pnl = -pnl;
  const share = big(p.houseMargin) - pnl + big(fee(p, at));
  return Number(clamp(share, 0n, big(p.margin + p.houseMargin)));
}

/**
 * The prices at which a side's margin is exhausted at a time, so the position can be settled
 * early: the trader's (liquidation) and the provider's (take-profit). 0 means no such price.
 */
export function levels(p: PositionState, at: number): { liquidation: number; takeProfit: number } {
  const buffer = Math.floor(p.margin / MAINTENANCE);
  const owed = fee(p, at);
  const n = big(p.notional);
  const e = big(p.entryPrice);
  const loss = big(Math.max(p.margin - buffer - owed, 1 - p.notional));
  const gain = big(p.houseMargin - buffer + owed);
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  if (p.side === 0) {
    return {
      liquidation: Number((e * n) / (n + loss)),
      takeProfit: n > gain ? Number(ceilDiv(e * n, n - gain)) : 0,
    };
  }
  return {
    liquidation: n > loss ? Number(ceilDiv(e * n, n - loss)) : 0,
    takeProfit: Number((e * n) / (n + gain)),
  };
}

/** Whether anyone may settle the position at a price signed now. */
export function resolvable(p: PositionState, price: number, now: number): boolean {
  return now >= p.startAt && ending(p, price, now) !== "closed";
}

/**
 * How a position ends when it settles at a price and time: past its end date, with the trader's
 * margin gone, with the provider's margin gone, or, when none of those holds, because the trader
 * closed it, the only settlement the contracts then allow.
 */
export type Ending = "ended" | "liquidated" | "take-profit" | "closed";

export function ending(p: PositionState, price: number, time: number): Ending {
  if (time >= p.expiry) return "ended";
  const share = houseShare(p, price, time);
  const buffer = Math.floor(p.margin / MAINTENANCE);
  if (share >= p.margin + p.houseMargin - buffer) return "liquidated";
  if (share <= buffer) return "take-profit";
  return "closed";
}

/** A position that settled: the price it settled on, how it ended and what each side received. */
export interface Settlement extends Position {
  price: number;
  time: number;
  ending: Ending;
  trader: number;
  provider: number;
}

const sane = (...values: number[]) => values.every((v) => Number.isSafeInteger(v) && v >= 0);

/**
 * Whether a position's state is one the contracts could have produced. Anyone can create a coin
 * at the position address with any note, so nothing read from one is used before this passes.
 */
export function validPosition(p: PositionState): boolean {
  return (
    sane(p.side, p.entryPrice, p.notional, p.margin, p.houseMargin, p.startAt, p.expiry, p.carryBps) &&
    p.side <= 1 &&
    p.entryPrice > 0 &&
    p.margin >= MIN_MARGIN &&
    p.houseMargin >= MIN_MARGIN &&
    p.houseMargin <= p.notional &&
    p.expiry >= p.startAt + MIN_DURATION
  );
}

/** Whether an offer's state is one a provider could mean. */
export function validOffer(o: Pick<Offer, "spreadBps" | "maxLeverage" | "maxDuration" | "carryBps">): boolean {
  return (
    sane(o.spreadBps, o.maxLeverage, o.maxDuration, o.carryBps) &&
    o.spreadBps < BPS &&
    o.maxLeverage >= 1 &&
    o.maxDuration >= MIN_DURATION
  );
}

/** What an offer charges a trade held for its whole duration, in basis points of its size. */
function cost(o: Offer, duration: number): number {
  return o.spreadBps + Math.floor((o.carryBps * duration) / 86_400);
}

/** The longest a trade may last on a coin expiring at `expiresAt`, leaving time to settle it. */
export function maxDuration(expiresAt: number, now: number): number {
  const life = expiresAt - now;
  return life - Math.min(SETTLE_WINDOW, Math.floor(life / 4));
}

/**
 * What a trade of `margin` would open at against each offer that fits, cheapest first. Throws
 * NoOfferError with the reason when none fits.
 */
export function candidates(
  terms: TradeTerms,
  margin: number,
  price: number,
  offers: Offer[],
  dust: number,
  now: number,
): Quote[] {
  if (!(margin >= MIN_MARGIN)) throw new Error(`the margin is below the ${MIN_MARGIN} sat minimum`);
  if (!(price > 0)) throw new Error("no price");
  if (terms.duration < MIN_DURATION) throw new Error("the trade is too short");
  const notional = margin * terms.leverage;
  const houseMargin = Number((big(margin) * big(terms.capBps) + big(BPS) - 1n) / big(BPS));
  if (houseMargin < MIN_MARGIN || houseMargin > notional) {
    throw new Error(`the maximum profit must be between ${MIN_MARGIN} sats and the position's size`);
  }
  const fits: { offer: Offer; entry: number }[] = [];
  let reason = "";
  for (const o of offers) {
    const up = (big(price) * big(BPS + o.spreadBps) + big(BPS) - 1n) / big(BPS);
    const down = (big(price) * big(BPS - o.spreadBps)) / big(BPS);
    const entry = Number(terms.side === 1 ? down : up);
    if (terms.leverage > o.maxLeverage || terms.duration > o.maxDuration) continue;
    // strictly below: the entry price is rounded against the trader, and the deposit refuses an
    // entry past its cap by even a cent
    if (o.spreadBps >= terms.maxSpreadBps) {
      reason = "the spread is above what you accept";
      continue;
    }
    if (o.carryBps > terms.maxCarryBps) {
      reason = "the holding fee is above what you accept";
      continue;
    }
    if (houseMargin + dust > o.amount) {
      reason = `it needs ${houseMargin + dust} sats of liquidity in one offer`;
      continue;
    }
    if (o.expiresAt > 0 && terms.duration > maxDuration(o.expiresAt, now)) {
      reason = "the liquidity expires before the trade would";
      continue;
    }
    if ((terms.side === 0 && entry > terms.limitPrice) || (terms.side === 1 && entry < terms.limitPrice)) {
      reason = "the price moved past your limit";
      continue;
    }
    fits.push({ offer: o, entry });
  }
  if (!fits.length) throw new NoOfferError(reason);
  fits.sort((a, b) => cost(a.offer, terms.duration) - cost(b.offer, terms.duration));
  return fits.map(({ offer, entry }) => {
    const state: PositionState = {
      side: terms.side, entryPrice: entry, notional, margin, houseMargin, startAt: 0, expiry: 0,
      carryBps: offer.carryBps,
    };
    return {
      offer, margin, notional, houseMargin, entryPrice: entry,
      ...levels(state, 0),
      carryPerDay: Number((big(notional) * big(offer.carryBps)) / big(BPS)),
    };
  });
}

/** The cheapest offer a trade of `margin` would open against at `price`, and what it would be. */
export function match(
  terms: TradeTerms,
  margin: number,
  price: number,
  offers: Offer[],
  dust: number,
  now: number,
): Quote {
  return candidates(terms, margin, price, offers, dust, now)[0];
}

/** How a position's pot splits at a price signed at a time; a side at or below dust folds into the other. */
export function payouts(
  p: Position,
  price: number,
  at: number,
): { trader: number; provider: number; single: "trader" | "provider" | null } {
  const pot = p.amount;
  const provider = Math.min(houseShare(p, price, at), pot);
  const trader = pot - provider;
  if (provider > DUST_FOLD && trader > DUST_FOLD) return { trader, provider, single: null };
  if (provider <= DUST_FOLD) return { trader: pot, provider: 0, single: "trader" };
  return { trader: 0, provider: pot, single: "provider" };
}
