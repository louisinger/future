// End-to-end tests against a local regtest stack: arkd on :7070 and the emulator on :7073, with
// the operator's CLI wallet (in the `arkd` container) as the faucet. They only ever fund the
// market by plain sends to an address, as an external wallet would.

import { execSync } from "node:child_process";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine, ForeignAddressError, NoCoinError, newAccount, type Account } from "../../src/engine";
import templateIds from "../../contracts/testdata/templates.json";
import { Executor } from "../../src/executor";
import { type Oracle, dia, localOracle, trustedUpdate } from "../../src/oracle";
import { NoOfferError, levels, type OfferTerms, type Position, type Quote, type TradeTerms } from "../../src/payoff";

const ARK_URL = "http://localhost:7070";
const EMULATOR_URL = "http://localhost:7073";
const EXECUTOR_URL = "http://localhost:7080";
const DEPOSIT = 10_000;

const sh = (cmd: string) => execSync(cmd, { encoding: "utf8", timeout: 90_000, stdio: "pipe" }).trim();
const pay = (address: string, sats = DEPOSIT) =>
  sh(`docker exec arkd ark send --to ${address} --amount ${sats} --password secret`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(action: () => Promise<T>, seconds = 30): Promise<T> {
  for (let left = seconds; ; left--) {
    try {
      return await action();
    } catch (e) {
      if (left <= 0) throw e;
      await sleep(1000);
    }
  }
}

/**
 * A market of its own, with the keys of one provider and one trader. Its prices are signed by a
 * key of its own, at whatever price a test asks for.
 */
class Desk {
  private constructor(
    readonly engine: Engine,
    private readonly quote: { price: number },
    readonly lp: Account,
    readonly trader: Account,
    readonly lpPayout: string,
    readonly traderPayout: string,
  ) {}

  static async open(oracle?: Oracle): Promise<Desk> {
    const quote = { price: 0 };
    oracle ??= localOracle(secp256k1.utils.randomSecretKey(), () => quote.price);
    const engine = await Engine.connect({ arkUrl: ARK_URL, emulatorUrl: EMULATOR_URL, oracle });
    const program = () => hex.encode(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
    return new Desk(engine, quote, newAccount(), newAccount(), program(), program());
  }

  fill(terms: TradeTerms, price: number): Promise<Quote> {
    this.quote.price = price;
    return this.engine.fill(terms);
  }

  async resolve(p: Position, price: number): Promise<void> {
    this.quote.price = price;
    await this.engine.resolve(p);
  }

  async close(p: Position, price: number, key: string): Promise<void> {
    this.quote.price = price;
    await this.engine.close(p, key);
  }

  offerTerms(spreadBps: number, carryBps = 0): OfferTerms {
    return {
      lpPk: this.lp.pub, lpProgram: this.lpPayout, spreadBps, maxLeverage: 50, maxDuration: 7 * 86400,
      carryBps,
    };
  }

  /** Trades last four minutes: regtest coins live 512 seconds. */
  tradeTerms(side: number, leverage: number, capBps: number): TradeTerms {
    return {
      traderPk: this.trader.pub, traderProgram: this.traderPayout, side, leverage, capBps,
      limitPrice: side === 1 ? 9_950_000 : 10_050_000, duration: 240,
      deadline: Math.floor(Date.now() / 1000) + 600, maxCarryBps: 1_000_000, maxSpreadBps: 100,
    };
  }

  async offer(spreadBps: number, carryBps = 0): Promise<void> {
    const terms = this.offerTerms(spreadBps, carryBps);
    pay(this.engine.offerDeposit(terms).address, 2 * DEPOSIT);
    await eventually(() => this.engine.register(terms));
  }

  async position(): Promise<Position> {
    return eventually(async () => {
      const open = await this.engine.positions();
      if (open.length !== 1) throw new Error(`want one open position, got ${open.length}`);
      return open[0];
    });
  }

  async paid(program: string): Promise<number> {
    const coins = await this.engine.coins(`5120${program}`);
    return coins.filter((c) => !c.spent).reduce((sum, c) => sum + c.amount, 0);
  }
}

beforeAll(() => {
  try {
    sh("docker exec arkd ark init --password secret --server-url localhost:7070 --explorer http://chopsticks:3000");
  } catch {
    // already initialized
  }
  const note = sh("docker exec arkd arkd note --amount 1000000").split("\n").pop() as string;
  sh(`docker exec arkd ark redeem-notes -n ${note} --password secret`);
}, 120_000);

describe("a market", () => {
  it("opens two longs against an offer, closes one in profit, liquidates the other, withdraws the rest", async () => {
    const d = await Desk.open();
    await d.offer(10);
    const [offer] = await eventually(async () => {
      const open = await d.engine.offers();
      if (open.length !== 1) throw new Error("no offer yet");
      return open;
    });
    expect(offer.amount).toBe(2 * DEPOSIT);
    expect(offer.lpProgram).toBe(d.lpPayout);

    const terms = d.tradeTerms(0, 2, 5_000);
    const { address } = d.engine.tradeDeposit(terms);
    pay(address);
    const quote = await eventually(() => d.fill(terms, 10_000_000));
    expect(quote.entryPrice).toBe(10_010_000);
    const first = await d.position();
    expect(first).toMatchObject({ entryPrice: 10_010_000, margin: DEPOSIT, houseMargin: 5_000, amount: DEPOSIT + 5_000 });
    await expect(d.fill(terms, 10_000_000)).rejects.toBeInstanceOf(NoCoinError);

    await expect(d.close(first, 10_500_000, d.lp.key)).rejects.toThrow("signature verification failed");
    await d.close(first, 10_500_000, d.trader.key);
    await eventually(async () => expect(await d.paid(d.traderPayout)).toBe(10_933));
    expect(await d.paid(d.lpPayout)).toBe(4_067);

    pay(address);
    await eventually(() => d.fill(terms, 10_000_000));
    const second = await d.position();
    await expect(d.resolve(second, 9_900_000)).rejects.toThrow("failed to execute arkade script");
    await d.resolve(second, 6_000_000);
    await eventually(async () => expect(await d.paid(d.lpPayout)).toBe(4_067 + DEPOSIT + 5_000));

    const [rest] = await d.engine.offers();
    expect(rest.amount).toBe(2 * DEPOSIT - 10_000);
    await expect(d.engine.withdraw(rest, d.trader.key)).rejects.toThrow("signature verification failed");
    await d.engine.withdraw(rest, d.lp.key);
    await eventually(async () => expect(await d.engine.offers()).toHaveLength(0));
  }, 180_000);

  it("opens a short against the cheaper of two offers and settles it at its take-profit", async () => {
    const d = await Desk.open();
    await d.offer(40);
    await d.offer(15);

    const terms = d.tradeTerms(1, 2, 5_000);
    pay(d.engine.tradeDeposit(terms).address);
    const quote = await eventually(() => d.fill(terms, 10_000_000));
    expect(quote.offer.spreadBps).toBe(15);
    expect(quote.entryPrice).toBe(9_985_000);

    const position = await d.position();
    expect(position.side).toBe(1);
    const { liquidation, takeProfit } = levels(position, Math.floor(Date.now() / 1000));
    expect(liquidation).toBeGreaterThan(position.entryPrice);
    expect(takeProfit).toBeLessThan(position.entryPrice);

    await expect(d.resolve(position, takeProfit + 1)).rejects.toThrow();
    await d.resolve(position, takeProfit);
    await eventually(async () => {
      const [trader, provider] = [await d.paid(d.traderPayout), await d.paid(d.lpPayout)];
      expect(trader + provider).toBe(DEPOSIT + 5_000);
      expect(trader).toBeGreaterThanOrEqual(DEPOSIT + 5_000 - 50);
    });
  }, 180_000);

  it("leaves a deposit that cannot open to its trader, who cancels it", async () => {
    const d = await Desk.open();
    const terms = d.tradeTerms(0, 2, 5_000);
    await expect(d.fill(terms, 10_000_000)).rejects.toBeInstanceOf(NoCoinError);

    pay(d.engine.tradeDeposit(terms).address);
    await eventually(async () => {
      await expect(d.fill(terms, 10_000_000)).rejects.toBeInstanceOf(NoOfferError);
    });
    await expect(d.engine.cancel(terms, d.lp.key)).rejects.toThrow("signature verification failed");
    await d.engine.cancel(terms, d.trader.key);
    await eventually(async () => expect(await d.paid(d.traderPayout)).toBe(DEPOSIT));
    await expect(d.engine.cancel(terms, d.trader.key)).rejects.toBeInstanceOf(NoCoinError);
  }, 180_000);

  it("pays the provider a holding fee out of the trader's margin", async () => {
    const d = await Desk.open();
    await d.offer(0, 864_000);

    const terms = { ...d.tradeTerms(0, 2, 5_000), limitPrice: 6_100_000, maxSpreadBps: 1 };
    pay(d.engine.tradeDeposit(terms).address);
    // a price that does not divide evenly: the entry is rounded, as with a live price
    const quote = await eventually(() => d.fill(terms, 5_958_713));
    expect(quote.carryPerDay).toBe((2 * DEPOSIT * 864_000) / 10_000);

    const position = await d.position();
    expect(position.carryBps).toBe(864_000);
    await sleep(3000);
    await d.close(position, position.entryPrice, d.trader.key);
    await eventually(async () => {
      const [trader, provider] = [await d.paid(d.traderPayout), await d.paid(d.lpPayout)];
      expect(trader + provider).toBe(DEPOSIT + 5_000);
      // 20 sats a second on a 20,000 sat position
      expect(provider).toBeGreaterThan(5_000 + 40);
      expect(provider).toBeLessThan(5_000 + 1_000);
    });
  }, 180_000);

  it("finds the trusted signer's update in DIA's events when the registry's latest is not its own", async () => {
    // the registry's latest answer is altered, as if the other signer had published last; the
    // events and the update they lead to are DIA's own
    let latest = true;
    const rpc = async (method: string, params: unknown[]) => {
      const res = await fetch("https://rpc.diadata.org/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const { result } = (await res.json()) as { result: unknown };
      if (!latest || method !== "eth_call") return result;
      latest = false;
      const words = String(result).slice(2).match(/.{64}/g) as string[];
      words[7] = (BigInt(`0x${words[7]}`) + 1n).toString(16).padStart(64, "0");
      return `0x${words.join("")}`;
    };
    const update = await trustedUpdate(rpc);
    expect(latest).toBe(false);
    expect(Math.floor(Date.now() / 1000) - update.time).toBeLessThan(90);
    expect(update.price).toBeGreaterThan(1_000_000);
  }, 60_000);

  it("opens and closes a trade on DIA's live signed price", async () => {
    const d = await Desk.open(dia());
    await d.offer(10);
    const { price } = await eventually(() => d.engine.oracle.latest(), 60);

    const terms = {
      ...d.tradeTerms(0, 2, 5_000),
      limitPrice: Math.ceil(price * 1.02),
    };
    pay(d.engine.tradeDeposit(terms).address);
    const quote = await eventually(() => d.engine.fill(terms));
    expect(Math.abs(quote.entryPrice / price - 1)).toBeLessThan(0.01);

    const position = await d.position();
    await d.engine.close(position, d.trader.key);
    await eventually(async () => {
      const [trader, provider] = [await d.paid(d.traderPayout), await d.paid(d.lpPayout)];
      expect(trader + provider).toBe(DEPOSIT + 5_000);
      expect(trader).toBeGreaterThan(DEPOSIT - 500);
    });
  }, 180_000);

  // Needs executord on :7080 with the market's templates (scripts/register-templates.sh).
  it("lets an executor publish an offer and refund a late deposit, with no client involved", async ({ skip }) => {
    const d = await Desk.open();
    const executor = await Executor.connect(EXECUTOR_URL, d.engine.keys, Object.values(templateIds));
    if (!executor) return skip();

    const offer = d.offerTerms(10);
    expect(await executor.delegate(d.engine.offerDelegation(offer))).toBe(true);
    pay(d.engine.offerDeposit(offer).address, 2 * DEPOSIT);
    await eventually(async () => {
      const open = await d.engine.offers();
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ amount: 2 * DEPOSIT, lpProgram: d.lpPayout, spreadBps: 10 });
    }, 120);

    const late = { ...d.tradeTerms(0, 2, 5_000), deadline: Math.floor(Date.now() / 1000) + 20 };
    expect(await executor.delegate(d.engine.refundDelegation(late))).toBe(true);
    pay(d.engine.tradeDeposit(late).address);
    // a deadline is read against the chain's clock, which on regtest only moves with blocks
    await sleep(25_000);
    sh("nigiri rpc --generate 12");
    await eventually(async () => expect(await d.paid(d.traderPayout)).toBe(DEPOSIT), 120);
  }, 480_000);

  it("is refused by an executor serving another operator", async () => {
    const d = await Desk.open();
    const other = { ...d.engine.keys, server: "00".repeat(32) };
    expect(await Executor.connect(EXECUTOR_URL, other, [])).toBeUndefined();
    expect(await Executor.connect("http://localhost:1", d.engine.keys, [])).toBeUndefined();
  }, 60_000);

  it("only accepts addresses of the connected operator", async () => {
    const d = await Desk.open();
    const own = d.engine.address(d.traderPayout);
    expect(d.engine.program(own)).toBe(d.traderPayout);
    expect(() => d.engine.program("bcrt1qnotanarkadeaddress")).toThrow("not an Arkade address");
    const { ArkAddress } = await import("@arkade-os/sdk");
    const foreign = new ArkAddress(
      schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
      hex.decode(d.traderPayout),
      "tark",
    ).encode();
    expect(() => d.engine.program(foreign)).toThrow(ForeignAddressError);
  }, 60_000);
});
