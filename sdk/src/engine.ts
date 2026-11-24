// The market's client. It derives the market's addresses, reads its state from the indexer and
// builds every transaction, which the Arkade emulator checks and cosigns. It holds no funds.

import { ArkAddress, Extension, type RestIndexerProvider, Transaction, UnknownPacket, arkade } from "@arkade-os/sdk";
import {
  type Connection,
  type Delegation,
  DiaOracle,
  type OracleParams,
  type PriceFeed,
  type PriceUpdate,
  connect,
  dia,
  scriptNum,
} from "@louisinger/dia-oracle";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64, hex } from "@scure/base";
import offerArtifact from "../contracts/artifacts/offer.json";
import offerDepositArtifact from "../contracts/artifacts/offer_deposit.json";
import positionArtifact from "../contracts/artifacts/position.json";
import tradeDepositArtifact from "../contracts/artifacts/trade_deposit.json";
import templateIds from "../contracts/testdata/templates.json";
import {
  type Coin,
  type Offer,
  type OfferTerms,
  type Position,
  type Quote,
  type Settlement,
  type TradeTerms,
  DUST_FOLD,
  NoOfferError,
  candidates,
  ending,
  match,
  maxDuration,
  payouts,
  validOffer,
  validPosition,
} from "./payoff.js";

const QUOTE_PACKET = 34;
const OFFER_PACKET = 64;
const POSITION_PACKET = 65;
const OFFER_STATE_SIZE = 97;
const POSITION_STATE_SIZE = 161;
const RENEWAL_WINDOW = 86_400n;
const MAX_FEE = 1_000n;

/** The market's four contracts. */
export const ARTIFACTS = {
  position: positionArtifact,
  offer: offerArtifact,
  offerDeposit: offerDepositArtifact,
  tradeDeposit: tradeDepositArtifact,
};

type Contract = arkade.ArkadeContract;

export interface Account {
  key: string;
  pub: string;
}

export interface Deposit {
  address: string;
  script: string;
}

/** The ids of the market's executor templates, as an executor names them. */
export const TEMPLATES: {
  register_offer: string;
  refund_trade: string;
  renew_offer: string;
  renew_position: string;
} = templateIds;

export class NoCoinError extends Error {
  constructor() {
    super("no unspent coin at the address");
  }
}

export class ForeignAddressError extends Error {
  constructor() {
    super("this address is not from the connected operator");
  }
}

export function newAccount(): Account {
  return accountFrom(hex.encode(schnorr.utils.randomSecretKey()));
}

export function accountFrom(key: string): Account {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("a key is 64 hexadecimal characters");
  return { key, pub: hex.encode(secp256k1.getPublicKey(hex.decode(key), true)) };
}

const xonly = (compressed: string) => hex.decode(compressed).slice(1);
const program = (pkScript: Uint8Array) => pkScript.slice(2);
const le8 = (n: number) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
};
// A note's integers are 8 bytes, little-endian, with the top bit as a sign: the contracts never
// write a negative or a huge one, so a note carrying either was not made by them.
const readLe8 = (b: Uint8Array, at: number) => {
  const v = new DataView(b.buffer, b.byteOffset).getBigUint64(at, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("number out of range");
  return Number(v);
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const text = (s: string) => new TextEncoder().encode(s);
const big = BigInt;

export class Engine {
  readonly network: string;
  readonly dust: number;
  private readonly client: arkade.Arkade;
  private readonly indexer: RestIndexerProvider;
  private readonly exitDelay: bigint;
  private readonly position: Contract;
  private readonly offer: Contract;

  private constructor(
    conn: Connection,
    /** The oracle output the market's contracts read prices from. */
    readonly oracle: DiaOracle,
  ) {
    this.client = conn.client;
    this.indexer = conn.indexer;
    this.network = conn.network;
    this.dust = conn.dust;
    this.exitDelay = conn.exitDelay;
    const market = { ...this.oracleArgs, renewalWindow: RENEWAL_WINDOW, maxFee: MAX_FEE };
    this.position = this.client.contract(load(ARTIFACTS.position), market);
    this.offer = this.client.contract(load(ARTIFACTS.offer), {
      ...market,
      positionProgram: program(this.position.pkScript),
    });
  }

  /**
   * Reads the operator's and the emulator's parameters and derives the market's two scripts,
   * which take prices from the oracle `oracle` names and no other. `feed` is where prices are
   * fetched: DIA's, read for the signer the oracle trusts, unless given.
   */
  static async connect(cfg: {
    arkUrl: string;
    emulatorUrl: string;
    oracle: OracleParams;
    feed?: PriceFeed;
  }): Promise<Engine> {
    const conn = await connect(cfg);
    if (conn.dust > DUST_FOLD) {
      throw new Error("this operator's smallest coin is larger than the contracts allow for");
    }
    const oracle = new DiaOracle(conn, cfg.oracle, cfg.feed ?? dia({ key: cfg.oracle.oraclePk }));
    return new Engine(conn, oracle);
  }

  /** The newest signed price. */
  latest(): Promise<PriceUpdate> {
    return this.oracle.feed.latest();
  }

  /** The operator's and the emulator's keys, x-only. */
  get keys(): { server: string; emulator: string } {
    const x = (k?: Uint8Array) => (k ? hex.encode(k.length === 33 ? k.slice(1) : k) : "");
    return { server: x(this.client.serverKey), emulator: x(this.client.emulatorKey) };
  }

  get offerScript(): string {
    return hex.encode(this.offer.pkScript);
  }

  get positionScript(): string {
    return hex.encode(this.position.pkScript);
  }

  /** The address of the operator that pays a taproot program. */
  address(programHex: string): string {
    return new ArkAddress(this.client.serverKey, hex.decode(programHex), this.client.network.hrp).encode();
  }

  /** The taproot program an address of the operator pays. */
  program(address: string): string {
    let decoded: ArkAddress;
    try {
      decoded = ArkAddress.decode(address);
    } catch {
      throw new Error("not an Arkade address");
    }
    if (!sameKey(decoded.serverPubKey, this.client.serverKey)) throw new ForeignAddressError();
    return hex.encode(decoded.vtxoTaprootKey);
  }

  /** The address a liquidity provider pays to offer liquidity under terms. */
  offerDeposit(terms: OfferTerms): Deposit {
    return deposit(this.offerDepositContract(terms));
  }

  /** The address a trader pays to open a trade under terms. */
  tradeDeposit(terms: TradeTerms): Deposit {
    return deposit(this.tradeDepositContract(terms));
  }

  /** The coins at a script, spent ones included. */
  async coins(script: string): Promise<Coin[]> {
    const { vtxos } = await this.indexer.getVtxos({ scripts: [script] });
    return vtxos.map((v) => ({
      txid: v.txid,
      vout: v.vout,
      amount: v.value,
      script: v.script,
      spent: Boolean(v.isSpent),
      spentBy: v.arkTxId ?? "",
      createdAt: Math.floor(v.createdAt.getTime() / 1000),
      expiresAt: expiryOf(v),
    }));
  }

  /** The open offers: every unspent coin at the offer script that carries well-formed terms. */
  async offers(): Promise<Offer[]> {
    const out: Offer[] = [];
    for (const [coin, s] of await this.stateful(this.offerScript, OFFER_PACKET, OFFER_STATE_SIZE)) {
      try {
        const offer: Offer = {
          ...coin,
          lpPk: hex.encode(s.slice(1, 33)),
          lpProgram: hex.encode(s.slice(33, 65)),
          spreadBps: readLe8(s, 65),
          maxLeverage: readLe8(s, 73),
          maxDuration: readLe8(s, 81),
          carryBps: readLe8(s, 89),
        };
        if (validOffer(offer)) out.push(offer);
      } catch {
        // not a note the contracts wrote
      }
    }
    return out;
  }

  /** The open positions: every unspent coin at the position script that carries a well-formed state. */
  async positions(): Promise<Position[]> {
    const out: Position[] = [];
    for (const [coin, s] of await this.stateful(this.positionScript, POSITION_PACKET, POSITION_STATE_SIZE)) {
      const position = readPosition(coin, s);
      if (position) out.push(position);
    }
    return out;
  }

  /**
   * The positions that settled, newest first, each with the price it settled on, how it ended and
   * what each side received. `known` names the coins, as `txid:vout`, a caller has already seen:
   * they are not read again. A position a batch renewed did not settle and is not listed.
   */
  async settlements(known: (outpoint: string) => boolean = () => false, limit = 50): Promise<Settlement[]> {
    const spent = (await this.coins(this.positionScript))
      .filter((c) => c.spentBy && !known(`${c.txid}:${c.vout}`))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    const txs = await this.transactions(spent.flatMap((c) => [c.txid, c.spentBy]));
    const out: Settlement[] = [];
    for (const coin of spent) {
      const state = txs.get(coin.txid)?.getPacketByType(POSITION_PACKET)?.serialize();
      const quote = txs.get(coin.spentBy)?.getPacketByType(QUOTE_PACKET)?.serialize();
      if (state?.length !== POSITION_STATE_SIZE || state[0] !== 1 || quote?.length !== 17 || quote[0] !== 1) continue;
      const position = readPosition(coin, state);
      if (!position) continue;
      try {
        const price = readLe8(quote, 1);
        const time = readLe8(quote, 9);
        const { trader, provider } = payouts(position, price, time);
        out.push({ ...position, price, time, ending: ending(position, price, time), trader, provider });
      } catch {
        // not a price the contracts took
      }
    }
    return out.sort((a, b) => b.time - a.time);
  }

  /** What an executor needs to turn a payment to the offer deposit of terms into an offer. */
  offerDelegation(t: OfferTerms): Delegation {
    return {
      templateId: TEMPLATES.register_offer,
      variables: {
        ...this.oracleVariables,
        renewal_window: num(RENEWAL_WINDOW),
        max_fee: num(MAX_FEE),
        position_program: hex.encode(program(this.position.pkScript)),
        lp_pk: t.lpPk,
        lp_program: t.lpProgram,
        spread_bps: num(t.spreadBps),
        max_leverage: num(t.maxLeverage),
        max_duration: num(t.maxDuration),
        carry_bps: num(t.carryBps),
        exit_delay: num(this.exitDelay),
      },
    };
  }

  /** What an executor needs to refund the trade deposit of terms once its deadline has passed. */
  refundDelegation(t: TradeTerms): Delegation {
    return {
      templateId: TEMPLATES.refund_trade,
      variables: {
        ...this.oracleVariables,
        position_program: hex.encode(program(this.position.pkScript)),
        trader_pk: t.traderPk,
        trader_program: t.traderProgram,
        side: num(t.side),
        leverage: num(t.leverage),
        cap_bps: num(t.capBps),
        limit_price: num(t.limitPrice),
        duration: num(t.duration),
        deadline: num(t.deadline),
        max_carry_bps: num(t.maxCarryBps),
        max_spread_bps: num(t.maxSpreadBps),
        exit_delay: num(this.exitDelay),
      },
    };
  }

  /**
   * What an executor needs to renew every offer and every position of the market, and the
   * oracle's outputs, before their coins expire. They are the market's, not a user's: registering
   * them again changes nothing.
   */
  renewalDelegations(): Delegation[] {
    const market = { ...this.oracleVariables, renewal_window: num(RENEWAL_WINDOW), max_fee: num(MAX_FEE) };
    return [
      {
        templateId: TEMPLATES.renew_offer,
        variables: { ...market, position_program: hex.encode(program(this.position.pkScript)) },
      },
      { templateId: TEMPLATES.renew_position, variables: market },
      this.oracle.renewal(),
    ];
  }

  /** What a trade of `margin` under terms would open at now. */
  async quote(terms: TradeTerms, margin: number, price: number): Promise<Quote> {
    return match(terms, margin, price, await this.offers(), this.dust, now());
  }

  /** Turns the coin at the offer deposit of terms into an offer. */
  async register(terms: OfferTerms): Promise<string> {
    const contract = this.offerDepositContract(terms);
    const coin = await this.unspent(hex.encode(contract.pkScript));
    return this.send(
      this.client
        .transaction()
        .from(utxo(coin), contract.unlock.register())
        .to([{ script: this.offer.pkScript, amount: big(coin.amount) }])
        .withPacket(new UnknownPacket(OFFER_PACKET, offerState(terms))),
    );
  }

  /**
   * Opens the trade funded at the deposit of terms at the oracle's latest price, against the
   * cheapest offer that fits. An offer the contracts refuse, or that someone else just used, is
   * skipped for the next.
   */
  async fill(terms: TradeTerms): Promise<Quote> {
    const contract = this.tradeDepositContract(terms);
    const coin = await this.unspent(hex.encode(contract.pkScript));
    if (coin.expiresAt > 0 && terms.duration > maxDuration(coin.expiresAt, now())) {
      throw new Error("your payment's coin expires before the trade would");
    }
    const offers = await this.offers();
    const seen = await this.latest();
    let failure: unknown;
    for (const candidate of candidates(terms, coin.amount, seen.price, offers, this.dust, now())) {
      let opened: Quote | undefined;
      try {
        await this.oracle.spend(
          () => this.client.transaction().from(utxo(coin), contract.unlock.fill()),
          (tx, quote) => {
            // the price is the one of the oracle output this attempt spends
            const [q] = candidates(terms, coin.amount, quote.price, [candidate.offer], this.dust, now());
            if (!q) throw new NoOfferError("the price moved out of this offer's reach");
            opened = q;
            return tx
              .from(utxo(q.offer), this.offer.unlock.fill())
              .to([
                { script: this.position.pkScript, amount: big(q.margin + q.houseMargin) },
                { script: this.offer.pkScript, amount: big(q.offer.amount - q.houseMargin) },
              ])
              .withPacket(new UnknownPacket(OFFER_PACKET, offerState(q.offer)))
              .withPacket(new UnknownPacket(POSITION_PACKET, positionState(terms, q, quote.time)));
          },
        );
        if (opened) return opened;
      } catch (e) {
        failure = e;
      }
    }
    throw failure;
  }

  /** Returns the coin at the trade deposit of terms to the trader, on the trader's signature. */
  async cancel(terms: TradeTerms, key: string): Promise<string> {
    const contract = this.tradeDepositContract(terms);
    const coin = await this.unspent(hex.encode(contract.pkScript));
    return this.signedSpend("cancel", key, (sig) =>
      this.client
        .transaction()
        .from(utxo(coin), contract.unlock.cancel({ arkadeScript: [sig] }))
        .to([{ script: p2tr(terms.traderProgram), amount: big(coin.amount) }]),
    );
  }

  /**
   * Settles a position at the oracle's latest price: past its expiry, or once a side's margin is
   * exhausted. Returns the price it settled at.
   */
  async resolve(p: Position): Promise<PriceUpdate> {
    const { update } = await this.oracle.spend(
      () => this.client.transaction().from(utxo(p), this.position.unlock.resolve()),
      (tx, quote) => tx.to(settlement(p, quote.price, quote.time)),
    );
    return update;
  }

  /** Settles a position at the oracle's latest price on the trader's signature. */
  async close(p: Position, key: string): Promise<PriceUpdate> {
    const start = (sig: Uint8Array) => () =>
      this.client.transaction().from(utxo(p), this.position.unlock.close({ arkadeScript: [sig] }));
    const finish = (tx: arkade.ArkadeTransactionBuilder, quote: PriceUpdate) =>
      tx.to(settlement(p, quote.price, quote.time));
    // the signature covers the position's outpoint, which no price or oracle output changes
    const draft = start(new Uint8Array(64))();
    const { update: drafted } = await this.oracle.attach(draft);
    const sig = await signOutpoint("close", key, finish(draft, drafted));
    const { update } = await this.oracle.spend(start(sig), finish);
    return update;
  }

  /** Pays an offer back to its provider's program on the provider's signature. */
  async withdraw(o: Offer, key: string): Promise<string> {
    return this.signedSpend("withdraw", key, (sig) =>
      this.client
        .transaction()
        .from(utxo(o), this.offer.unlock.withdraw({ arkadeScript: [sig] }))
        .to([{ script: p2tr(o.lpProgram), amount: big(o.amount) }]),
    );
  }

  private offerDepositContract(t: OfferTerms): Contract {
    return this.client.contract(load(ARTIFACTS.offerDeposit), {
      offerProgram: program(this.offer.pkScript),
      lpPk: xonly(t.lpPk),
      lpProgram: hex.decode(t.lpProgram),
      spreadBps: big(t.spreadBps),
      maxLeverage: big(t.maxLeverage),
      maxDuration: big(t.maxDuration),
      carryBps: big(t.carryBps),
      exitDelay: this.exitDelay,
    });
  }

  private tradeDepositContract(t: TradeTerms): Contract {
    return this.client.contract(load(ARTIFACTS.tradeDeposit), {
      ...this.oracleArgs,
      positionProgram: program(this.position.pkScript),
      traderPk: xonly(t.traderPk),
      traderProgram: hex.decode(t.traderProgram),
      side: big(t.side),
      leverage: big(t.leverage),
      capBps: big(t.capBps),
      limitPrice: big(t.limitPrice),
      duration: big(t.duration),
      deadline: big(t.deadline),
      maxCarryBps: big(t.maxCarryBps),
      maxSpreadBps: big(t.maxSpreadBps),
      exitDelay: this.exitDelay,
    });
  }

  /** The oracle's identity as the market's contracts hold it. */
  private get oracleArgs(): { oracleTxid: Uint8Array; oracleGidx: bigint } {
    return { oracleTxid: this.oracle.id["oracleId.txid"], oracleGidx: this.oracle.id["oracleId.gidx"] };
  }

  /** The same, as the variables of an executor template. */
  private get oracleVariables(): { oracle_txid: string; oracle_gidx: string } {
    return { oracle_txid: hex.encode(this.oracleArgs.oracleTxid), oracle_gidx: num(this.oracleArgs.oracleGidx) };
  }

  /** The notes of transactions, by transaction id; one that cannot be read is left out. */
  private async transactions(txids: string[]): Promise<Map<string, Extension>> {
    const out = new Map<string, Extension>();
    const wanted = [...new Set(txids)];
    for (let at = 0; at < wanted.length; at += 20) {
      try {
        const { txs } = await this.indexer.getVirtualTxs(wanted.slice(at, at + 20));
        for (const raw of txs) {
          const tx = Transaction.fromPSBT(base64.decode(raw));
          out.set(tx.id, Extension.fromTx(tx));
        }
      } catch {
        // those stay unread and are asked again next time
      }
    }
    return out;
  }

  private async unspent(script: string): Promise<Coin> {
    const coin = (await this.coins(script)).find((c) => !c.spent);
    if (!coin) throw new NoCoinError();
    return coin;
  }

  /**
   * The unspent coins at a script whose creating transaction carries a state packet of the right
   * size. A coin whose transaction cannot be read is left out, not fatal.
   */
  private async stateful(script: string, packet: number, size: number): Promise<[Coin, Uint8Array][]> {
    const unspent = (await this.coins(script)).filter((c) => !c.spent);
    const states = await Promise.all(
      unspent.map(async (coin) => {
        try {
          const { txs } = await this.indexer.getVirtualTxs([coin.txid]);
          if (txs.length !== 1) return undefined;
          return Extension.fromTx(Transaction.fromPSBT(base64.decode(txs[0])))
            .getPacketByType(packet)
            ?.serialize();
        } catch {
          return undefined;
        }
      }),
    );
    const out: [Coin, Uint8Array][] = [];
    unspent.forEach((coin, i) => {
      const state = states[i];
      if (state && state.length === size && state[0] === 1) out.push([coin, state]);
    });
    return out;
  }

  /**
   * Sends a spend that carries a signature over the outpoint its input spends. That outpoint is the
   * checkpoint's, only known once the transaction is built: it builds with an empty signature,
   * signs, and builds again.
   */
  private async signedSpend(
    action: string,
    key: string,
    build: (sig: Uint8Array) => arkade.ArkadeTransactionBuilder,
  ): Promise<string> {
    return this.send(build(await signOutpoint(action, key, build(new Uint8Array(64)))));
  }

  private async send(builder: arkade.ArkadeTransactionBuilder): Promise<string> {
    return (await builder.send()).txid;
  }
}

function load(artifact: unknown): ReturnType<typeof arkade.programFromArtifact> {
  return arkade.programFromArtifact(artifact as arkade.ContractArtifact);
}

function deposit(contract: Contract): Deposit {
  return { address: contract.address, script: hex.encode(contract.pkScript) };
}

function utxo(c: Coin): arkade.Utxo {
  return { txid: c.txid, vout: c.vout, value: c.amount, script: c.script };
}

function p2tr(programHex: string): Uint8Array {
  return concat(Uint8Array.of(0x51, 0x20), hex.decode(programHex));
}

/** The position a coin's note describes, when it is one the contracts could have written. */
function readPosition(coin: Coin, s: Uint8Array): Position | undefined {
  try {
    const position: Position = {
      ...coin,
      side: readLe8(s, 1),
      entryPrice: readLe8(s, 9),
      notional: readLe8(s, 17),
      margin: readLe8(s, 25),
      houseMargin: readLe8(s, 33),
      startAt: readLe8(s, 41),
      expiry: readLe8(s, 49),
      traderPk: hex.encode(s.slice(57, 89)),
      traderProgram: hex.encode(s.slice(89, 121)),
      lpProgram: hex.encode(s.slice(121, 153)),
      carryBps: readLe8(s, 153),
    };
    return validPosition(position) ? position : undefined;
  } catch {
    return undefined;
  }
}

/** The signature a contract checks over `action` and the outpoint a drafted transaction's first input spends. */
async function signOutpoint(action: string, key: string, draft: arkade.ArkadeTransactionBuilder): Promise<Uint8Array> {
  const input = (await draft.build()).arkTx.getInput(0);
  if (!input.txid || input.index === undefined) throw new Error("the transaction has no input");
  const vout = new Uint8Array(4);
  new DataView(vout.buffer).setUint32(0, input.index, true);
  // the script reads the transaction id in wire order, the reverse of its hex form
  return schnorr.sign(sha256(concat(text(action), input.txid.slice().reverse(), vout)), hex.decode(key));
}

function positionState(terms: TradeTerms, q: Quote, startAt: number): Uint8Array {
  return concat(
    Uint8Array.of(1),
    le8(terms.side),
    le8(q.entryPrice),
    le8(q.notional),
    le8(q.margin),
    le8(q.houseMargin),
    le8(startAt),
    le8(startAt + terms.duration),
    xonly(terms.traderPk),
    hex.decode(terms.traderProgram),
    hex.decode(q.offer.lpProgram),
    le8(q.offer.carryBps),
  );
}

function num(n: number | bigint): string {
  return hex.encode(scriptNum(big(n)));
}

function offerState(t: OfferTerms | Offer): Uint8Array {
  const lpPk = hex.decode(t.lpPk);
  return concat(
    Uint8Array.of(1),
    lpPk.length === 33 ? lpPk.slice(1) : lpPk,
    hex.decode(t.lpProgram),
    le8(t.spreadBps),
    le8(t.maxLeverage),
    le8(t.maxDuration),
    le8(t.carryBps),
  );
}

function settlement(p: Position, price: number, at: number): { script: Uint8Array; amount: bigint }[] {
  const split = payouts(p, price, at);
  if (split.single === "trader") return [{ script: p2tr(p.traderProgram), amount: big(split.trader) }];
  if (split.single === "provider") return [{ script: p2tr(p.lpProgram), amount: big(split.provider) }];
  return [
    { script: p2tr(p.traderProgram), amount: big(split.trader) },
    { script: p2tr(p.lpProgram), amount: big(split.provider) },
  ];
}

function expiryOf(v: { virtualStatus?: { batchExpiry?: number }; expiresAt?: Date }): number {
  if (v.expiresAt instanceof Date) return Math.floor(v.expiresAt.getTime() / 1000);
  const ms = v.virtualStatus?.batchExpiry;
  return ms ? Math.floor(ms / 1000) : 0;
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  const x = (k: Uint8Array) => hex.encode(k.length === 33 ? k.slice(1) : k);
  return x(a) === x(b);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
