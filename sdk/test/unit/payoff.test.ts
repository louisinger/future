import { describe, expect, it } from "vitest";
import {
  MIN_MARGIN,
  NoOfferError,
  candidates,
  ending,
  fee,
  houseShare,
  levels,
  match,
  payouts,
  resolvable,
  validOffer,
  validPosition,
  type Offer,
  type Position,
  type PositionState,
  type TradeTerms,
} from "../../src/payoff";

const NOW = 1_800_000_000;

function offer(amount: number, spreadBps: number, maxLeverage: number, carryBps = 0): Offer {
  return {
    txid: "a",
    vout: 0,
    amount,
    script: "",
    spent: false,
    spentBy: "",
    createdAt: NOW,
    expiresAt: NOW + 7 * 86400,
    lpPk: "",
    lpProgram: "",
    spreadBps,
    maxLeverage,
    maxDuration: 7 * 86400,
    carryBps,
  };
}

const long: TradeTerms = {
  traderPk: "",
  traderProgram: "",
  side: 0,
  leverage: 10,
  capBps: 20_000,
  limitPrice: 6_060_000,
  duration: 86400,
  deadline: 0,
  maxCarryBps: 100,
  maxSpreadBps: 100,
};
const short: TradeTerms = { ...long, side: 1, limitPrice: 5_940_000 };

describe("match", () => {
  const cases: {
    name: string;
    terms: TradeTerms;
    margin: number;
    offers: Offer[];
    spread?: number;
    entry?: number;
    error?: string;
  }[] = [
    {
      name: "takes the cheapest offer that fits",
      terms: long,
      margin: 10_000,
      offers: [offer(50_000, 30, 50), offer(50_000, 10, 50), offer(50_000, 20, 50)],
      spread: 10,
      entry: 6_006_000,
    },
    {
      name: "a short enters below the price",
      terms: short,
      margin: 10_000,
      offers: [offer(50_000, 10, 50)],
      spread: 10,
      entry: 5_994_000,
    },
    {
      name: "skips an offer too small for the maximum profit",
      terms: long,
      margin: 10_000,
      offers: [offer(20_329, 5, 50), offer(20_330, 40, 50)],
      spread: 40,
      entry: 6_024_000,
    },
    {
      name: "skips an offer below the leverage",
      terms: long,
      margin: 10_000,
      offers: [offer(50_000, 5, 5), offer(50_000, 25, 10)],
      spread: 25,
      entry: 6_015_000,
    },
    {
      name: "a holding fee counts in the price of an offer",
      terms: long,
      margin: 10_000,
      offers: [offer(50_000, 5, 50, 40), offer(50_000, 30, 50, 5)],
      spread: 30,
      entry: 6_018_000,
    },
    {
      name: "holding fee above what the trader accepts",
      terms: long,
      margin: 10_000,
      offers: [offer(50_000, 5, 50, 101)],
      error: "the holding fee is above what you accept",
    },
    { name: "no liquidity at all", terms: long, margin: 10_000, offers: [], error: "no offer fits this trade" },
    {
      name: "spread above what the trader accepts",
      terms: { ...long, maxSpreadBps: 10 },
      margin: 10_000,
      offers: [offer(50_000, 10, 50)],
      error: "the spread is above what you accept",
    },
    {
      name: "trade shorter than a minute",
      terms: { ...long, duration: 59 },
      margin: 10_000,
      offers: [offer(50_000, 10, 50)],
      error: "too short",
    },
    {
      name: "maximum profit below the minimum stake",
      terms: { ...long, capBps: 4_000 },
      margin: 10_000,
      offers: [offer(50_000, 10, 50)],
      error: "maximum profit",
    },
    {
      name: "not enough liquidity in one offer",
      terms: long,
      margin: 10_000,
      offers: [offer(15_000, 10, 50), offer(15_000, 10, 50)],
      error: "it needs 20330 sats of liquidity in one offer",
    },
    {
      name: "spread pushes the entry past the limit",
      terms: { ...long, maxSpreadBps: 1_000 },
      margin: 10_000,
      offers: [offer(50_000, 200, 50)],
      error: "the price moved past your limit",
    },
    {
      name: "liquidity expires before the trade would",
      terms: long,
      margin: 10_000,
      offers: [{ ...offer(50_000, 10, 50), expiresAt: NOW + 86400 }],
      error: "the liquidity expires before the trade would",
    },
    {
      name: "margin below the minimum",
      terms: long,
      margin: MIN_MARGIN - 1,
      offers: [offer(50_000, 10, 50)],
      error: "below the 5000 sat minimum",
    },
    {
      name: "maximum profit above the notional",
      terms: { ...long, leverage: 2, capBps: 30_000, duration: 60 },
      margin: 10_000,
      offers: [offer(50_000, 10, 50)],
      error: "maximum profit",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      if (c.error) {
        expect(() => match(c.terms, c.margin, 6_000_000, c.offers, 330, NOW)).toThrow(c.error);
        return;
      }
      const q = match(c.terms, c.margin, 6_000_000, c.offers, 330, NOW);
      expect(q.offer.spreadBps).toBe(c.spread);
      expect(q.entryPrice).toBe(c.entry);
      expect(q.notional).toBe(c.margin * c.terms.leverage);
      expect(q.houseMargin).toBe((c.margin * c.terms.capBps) / 10_000);
    });
  }

  it("ranks every offer that fits, cheapest first", () => {
    const ranked = candidates(long, 10_000, 6_000_000, [offer(50_000, 30, 50), offer(50_000, 10, 50), offer(1_000, 1, 50)], 330, NOW);
    expect(ranked.map((q) => q.offer.spreadBps)).toEqual([10, 30]);
  });

  it("says no offer fits with a typed error", () => {
    expect(() => match(long, 10_000, 6_000_000, [], 330, NOW)).toThrow(NoOfferError);
  });
});

describe("levels", () => {
  const base = { startAt: 0, expiry: 1, carryBps: 0 };
  const cases: { name: string; p: PositionState }[] = [
    {
      name: "long 10x capped at twice the margin",
      p: { ...base, side: 0, entryPrice: 6_006_000, notional: 100_000, margin: 10_000, houseMargin: 20_000 },
    },
    {
      name: "short 10x capped at twice the margin",
      p: { ...base, side: 1, entryPrice: 5_994_000, notional: 100_000, margin: 10_000, houseMargin: 20_000 },
    },
    {
      name: "long 2x capped at the margin",
      p: { ...base, side: 0, entryPrice: 6_006_000, notional: 20_000, margin: 10_000, houseMargin: 10_000 },
    },
    {
      name: "long paying a holding fee, a day in",
      p: {
        side: 0, entryPrice: 6_006_000, notional: 100_000, margin: 10_000, houseMargin: 20_000,
        carryBps: 200, startAt: -86400, expiry: 1,
      },
    },
    {
      name: "short paying a holding fee, a day in",
      p: {
        side: 1, entryPrice: 5_994_000, notional: 100_000, margin: 10_000, houseMargin: 20_000,
        carryBps: 200, startAt: -86400, expiry: 1,
      },
    },
    {
      name: "short 50x",
      p: { ...base, side: 1, entryPrice: 5_994_000, notional: 500_000, margin: 10_000, houseMargin: 50_000 },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const before = 0;
      const { liquidation, takeProfit } = levels(c.p, before);
      expect(liquidation).toBeGreaterThan(0);
      expect(takeProfit).toBeGreaterThan(0);
      const inward = c.p.side === 1 ? -1 : 1;
      expect(resolvable(c.p, liquidation, before)).toBe(true);
      expect(resolvable(c.p, takeProfit, before)).toBe(true);
      expect(resolvable(c.p, liquidation + inward, before)).toBe(false);
      expect(resolvable(c.p, takeProfit - inward, before)).toBe(false);
      expect(resolvable(c.p, c.p.entryPrice, before)).toBe(false);
      expect(resolvable(c.p, c.p.entryPrice, c.p.expiry)).toBe(true);
    });
  }
});

describe("resolvable", () => {
  const p: PositionState = {
    side: 0, entryPrice: 6_000_000, notional: 100_000, margin: 10_000, houseMargin: 20_000,
    startAt: 1_000, expiry: 2_000, carryBps: 0,
  };
  it("never at a price signed before the position started", () => {
    expect(resolvable(p, 3_000_000, 999)).toBe(false);
    expect(resolvable({ ...p, expiry: 0 }, 12_000_000, 999)).toBe(false);
  });
  it("at any price once it has ended", () => expect(resolvable(p, 6_000_000, 2_000)).toBe(true));
});

describe("ending", () => {
  const long: PositionState = {
    side: 0, entryPrice: 6_000_000, notional: 100_000, margin: 10_000, houseMargin: 20_000,
    startAt: 1_000, expiry: 2_000, carryBps: 0,
  };
  const short = { ...long, side: 1 };
  const { liquidation, takeProfit } = levels(long, 1_500);
  const cases: [string, PositionState, number, number, string][] = [
    ["a long settled while it runs, between its levels", long, 6_100_000, 1_500, "closed"],
    ["a long at its liquidation price", long, liquidation, 1_500, "liquidated"],
    ["a long below its liquidation price", long, liquidation - 100_000, 1_500, "liquidated"],
    ["a long at its take-profit price", long, takeProfit, 1_500, "take-profit"],
    ["a short when the price doubles", short, 12_000_000, 1_500, "liquidated"],
    ["a short when the price halves", short, 3_000_000, 1_500, "take-profit"],
    ["any position at its end date", long, 6_100_000, 2_000, "ended"],
    ["a liquidated position past its end date", long, liquidation, 2_500, "ended"],
  ];
  it.each(cases)("%s", (_name, p, price, time, want) => {
    expect(ending(p, price, time)).toBe(want);
  });
  it("is closed exactly when nobody but the trader could settle", () => {
    for (const price of [3_000_000, liquidation, liquidation + 1, 6_000_000, takeProfit - 1, takeProfit]) {
      expect(ending(long, price, 1_500) === "closed").toBe(!resolvable(long, price, 1_500));
    }
  });
});

describe("state read from the network", () => {
  const p: PositionState = {
    side: 0, entryPrice: 6_000_000, notional: 100_000, margin: 10_000, houseMargin: 20_000,
    startAt: 1_000, expiry: 2_000, carryBps: 5,
  };
  const bad: [string, Partial<PositionState>][] = [
    ["a side that is neither long nor short", { side: 2 }],
    ["no entry price", { entryPrice: 0 }],
    ["a margin below the minimum", { margin: 200 }],
    ["a provider margin below the minimum", { houseMargin: 1 }],
    ["a provider margin above the size", { houseMargin: 100_001 }],
    ["an end before its start", { expiry: 0 }],
    ["a number too large to be real", { notional: Number.MAX_SAFE_INTEGER + 2 }],
    ["a fraction", { margin: 10_000.5 }],
  ];
  it("accepts a position the contracts would write", () => expect(validPosition(p)).toBe(true));
  for (const [name, change] of bad) {
    it(`rejects a position with ${name}`, () => expect(validPosition({ ...p, ...change })).toBe(false));
  }
  it("never divides by zero on the state that used to crash the page", () => {
    const forged = { ...p, side: 1, notional: 1, houseMargin: 1, margin: 200 };
    expect(validPosition(forged)).toBe(false);
  });

  const o = { spreadBps: 10, maxLeverage: 50, maxDuration: 86_400, carryBps: 5 };
  it("accepts an offer a provider would write", () => expect(validOffer(o)).toBe(true));
  it("rejects an offer with a spread of 100% or more", () => expect(validOffer({ ...o, spreadBps: 10_000 })).toBe(false));
  it("rejects an offer with no leverage", () => expect(validOffer({ ...o, maxLeverage: 0 })).toBe(false));
  it("rejects an offer with a negative fee read as a huge number", () => {
    expect(validOffer({ ...o, carryBps: Number.MAX_SAFE_INTEGER + 2 })).toBe(false);
  });
});

describe("houseShare", () => {
  const long: PositionState = {
    side: 0, entryPrice: 10_010_000, notional: 1_000_000, margin: 100_000, houseMargin: 1_000_000,
    startAt: 0, expiry: 0, carryBps: 0,
  };
  const short = { ...long, side: 1 };
  const paying = { ...long, carryBps: 100, expiry: 2 * 86400 };
  const cases: [string, PositionState, number, number, number][] = [
    ["long flat", long, 10_010_000, 0, 1_000_000],
    ["long up ten percent", long, 11_011_000, 0, 909_091],
    ["long wiped", long, 9_100_000, 0, 1_100_000],
    ["long past the cap", long, 20_000_000_000, 0, 501],
    ["short up ten percent", short, 11_011_000, 0, 1_090_909],
    ["short wiped", short, 11_200_000, 0, 1_100_000],
    ["short past the cap", short, 5_000_000, 0, 0],
    ["a day of holding fee", paying, 10_010_000, 86400, 1_010_000],
    ["half a day of holding fee", paying, 10_010_000, 43200, 1_005_000],
    ["no fee after expiry", paying, 10_010_000, 10 * 86400, 1_020_000],
    ["no fee before the start", paying, 10_010_000, -5, 1_000_000],
  ];

  for (const [name, p, price, at, want] of cases) {
    it(name, () => expect(houseShare(p, price, at)).toBe(want));
  }

  it("accrues the fee linearly", () => {
    expect(fee(paying, 86400)).toBe(10_000);
    expect(fee(paying, 3 * 86400)).toBe(20_000);
  });
});

describe("payouts", () => {
  const coin = { txid: "a", vout: 0, script: "", spent: false, spentBy: "", createdAt: 0, expiresAt: 0 };
  const p: Position = {
    ...coin, amount: 30_000, side: 0, entryPrice: 6_000_000, notional: 100_000, margin: 10_000,
    houseMargin: 20_000, startAt: 0, expiry: 86400, carryBps: 0, traderPk: "", traderProgram: "",
    lpProgram: "",
  };

  it("splits the pot in two when both sides are above dust", () => {
    expect(payouts(p, 6_300_000, 10)).toEqual({ trader: 14_761, provider: 15_239, single: null });
  });
  it("pays the provider everything on a liquidation", () => {
    expect(payouts(p, 5_000_000, 10)).toEqual({ trader: 0, provider: 30_000, single: "provider" });
  });
  it("pays the trader everything at the take-profit", () => {
    expect(payouts(p, 9_000_000, 10)).toEqual({ trader: 30_000, provider: 0, single: "trader" });
  });
  it("never pays more than the coin holds", () => {
    const thin = { ...p, amount: 12_000 };
    const out = payouts(thin, 6_000_000, 10);
    expect(out.trader + out.provider).toBe(12_000);
  });
});
