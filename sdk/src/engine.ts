// The market's client. It derives the market's addresses, reads its state from the indexer and
// builds every transaction, which the Arkade emulator checks and cosigns. It holds no funds.

import {
  ArkAddress,
  Extension,
  RestEmulatorProvider,
  RestIndexerProvider,
  RestOperatorProvider,
  Transaction,
  UnknownPacket,
  arkade,
  networks,
} from "@arkade-os/sdk";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64, hex } from "@scure/base";
import templateIds from "../contracts/testdata/templates.json";
import diaOffer from "../contracts/artifacts/dia/offer.json";
import diaOfferDeposit from "../contracts/artifacts/dia/offer_deposit.json";
import diaPosition from "../contracts/artifacts/dia/position.json";
import diaTradeDeposit from "../contracts/artifacts/dia/trade_deposit.json";
import schnorrOffer from "../contracts/artifacts/schnorr/offer.json";
import schnorrOfferDeposit from "../contracts/artifacts/schnorr/offer_deposit.json";
import schnorrPosition from "../contracts/artifacts/schnorr/position.json";
import schnorrTradeDeposit from "../contracts/artifacts/schnorr/trade_deposit.json";
import { type Oracle, type OracleScheme, type PriceUpdate, scriptNum } from "./oracle.js";
import {
  type Coin,
  type Offer,
  type OfferTerms,
  type Position,
  type Quote,
  type TradeTerms,
  DUST_FOLD,
  candidates,
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

/** The market's four contracts, built with the price check of each oracle scheme. */
export const ARTIFACTS: Record<OracleScheme, Record<"position" | "offer" | "offerDeposit" | "tradeDeposit", unknown>> = {
  dia: { position: diaPosition, offer: diaOffer, offerDeposit: diaOfferDeposit, tradeDeposit: diaTradeDeposit },
  schnorr: {
    position: schnorrPosition,
    offer: schnorrOffer,
    offerDeposit: schnorrOfferDeposit,
    tradeDeposit: schnorrTradeDeposit,
  },
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

/**
 * The ids of the market's executor templates, as an executor names them. They are built on the
 * DIA contracts: a market on another oracle scheme has none.
 */
export const TEMPLATES: { register_offer: string; refund_trade: string; renew_position: string } = templateIds;

/** What an executor needs to run one of the market's templates for an address. */
export interface Delegation {
  template: string;
  variables: Record<string, string>;
}

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
  private readonly exitDelay: bigint;
  private readonly artifacts: (typeof ARTIFACTS)[OracleScheme];
  private readonly position: Contract;
  private readonly offer: Contract;

  private constructor(
    private readonly client: arkade.Arkade,
    private readonly indexer: RestIndexerProvider,
    info: { network: string; dust: number; exitDelaySeconds: number },
    readonly oracle: Oracle,
  ) {
    this.network = info.network;
    this.dust = info.dust;
    // BIP68: seconds are counted in units of 512 with bit 22 set
    const delay = info.exitDelaySeconds;
    this.exitDelay = big(delay >= 512 ? (1 << 22) | Math.floor(delay / 512) : delay);
    const market = { oraclePk: oracle.key, renewalWindow: RENEWAL_WINDOW, maxFee: MAX_FEE };
    this.artifacts = ARTIFACTS[oracle.scheme];
    this.position = client.contract(load(this.artifacts.position), market);
    this.offer = client.contract(load(this.artifacts.offer), { ...market, positionProgram: program(this.position.pkScript) });
  }

  /**
   * Reads the operator's and the emulator's parameters and derives the market's two scripts, which
   * settle on the prices of `oracle` and no other.
   */
  static async connect(cfg: { arkUrl: string; emulatorUrl: string; oracle: Oracle }): Promise<Engine> {
    const operator = new RestOperatorProvider(cfg.arkUrl);
    const emulator = new RestEmulatorProvider(cfg.emulatorUrl);
    const indexer = new RestIndexerProvider(cfg.arkUrl);
    const [info, emulatorInfo] = await Promise.all([operator.getInfo(), emulator.getInfo()]);
    const network = networks[info.network as keyof typeof networks] ?? networks.regtest;
    // The SDK pins the emulator key of public networks; a local stack has its own.
    const local = info.network === "regtest";
    const client = await arkade.Arkade.connect({
      arkade: operator,
      emulator,
      indexer,
      network,
      ...(local ? { emulatorPubkey: emulatorInfo.signerPubkey } : {}),
    });
    if (!local && client.emulatorKey && !sameKey(client.emulatorKey, hex.decode(emulatorInfo.signerPubkey))) {
      throw new Error("the emulator's key is not the one this app trusts for this network");
    }
    if (Number(info.dust) > DUST_FOLD) {
      throw new Error("this operator's smallest coin is larger than the contracts allow for");
    }
    return new Engine(
      client,
      indexer,
      { network: info.network, dust: Number(info.dust), exitDelaySeconds: Number(info.unilateralExitDelay) },
      cfg.oracle,
    );
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
        if (validPosition(position)) out.push(position);
      } catch {
        // not a note the contracts wrote
      }
    }
    return out;
  }

  /** What an executor needs to turn a payment to the offer deposit of terms into an offer. */
  offerDelegation(t: OfferTerms): Delegation {
    this.requireTemplates();
    return {
      template: templateIds.register_offer,
      variables: {
        oracle_pk: hex.encode(this.oracle.key),
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
    this.requireTemplates();
    return {
      template: templateIds.refund_trade,
      variables: {
        oracle_pk: hex.encode(this.oracle.key),
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
    const quote = await this.oracle.latest();
    let failure: unknown;
    for (const q of candidates(terms, coin.amount, quote.price, await this.offers(), this.dust, now())) {
      const state = concat(
        Uint8Array.of(1),
        le8(terms.side),
        le8(q.entryPrice),
        le8(q.notional),
        le8(q.margin),
        le8(q.houseMargin),
        le8(quote.time),
        le8(quote.time + terms.duration),
        xonly(terms.traderPk),
        hex.decode(terms.traderProgram),
        hex.decode(q.offer.lpProgram),
        le8(q.offer.carryBps),
      );
      try {
        await this.send(
          this.client
            .transaction()
            .from(utxo(coin), contract.unlock.fill({ arkadeScript: quote.witness }))
            .from(utxo(q.offer), this.offer.unlock.fill({ arkadeScript: quote.witness }))
            .to([
              { script: this.position.pkScript, amount: big(q.margin + q.houseMargin) },
              { script: this.offer.pkScript, amount: big(q.offer.amount - q.houseMargin) },
            ])
            .withPacket(quotePacket(quote))
            .withPacket(new UnknownPacket(OFFER_PACKET, offerState(q.offer)))
            .withPacket(new UnknownPacket(POSITION_PACKET, state)),
        );
        return q;
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
    const quote = await this.oracle.latest();
    await this.send(
      this.client
        .transaction()
        .from(utxo(p), this.position.unlock.resolve({ arkadeScript: quote.witness }))
        .to(settlement(p, quote.price, quote.time))
        .withPacket(quotePacket(quote)),
    );
    return quote;
  }

  /** Settles a position at the oracle's latest price on the trader's signature. */
  async close(p: Position, key: string): Promise<PriceUpdate> {
    const quote = await this.oracle.latest();
    await this.signedSpend("close", key, (sig) =>
      this.client
        .transaction()
        .from(utxo(p), this.position.unlock.close({ arkadeScript: [sig, ...quote.witness] }))
        .to(settlement(p, quote.price, quote.time))
        .withPacket(quotePacket(quote)),
    );
    return quote;
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
    return this.client.contract(load(this.artifacts.offerDeposit), {
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
    return this.client.contract(load(this.artifacts.tradeDeposit), {
      oraclePk: this.oracle.key,
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

  private requireTemplates(): void {
    if (this.oracle.scheme !== "dia") throw new Error("there are no executor templates for this oracle");
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
    const draft = await build(new Uint8Array(64)).build();
    const input = draft.arkTx.getInput(0);
    if (!input.txid || input.index === undefined) throw new Error("the transaction has no input");
    const vout = new Uint8Array(4);
    new DataView(vout.buffer).setUint32(0, input.index, true);
    // the script reads the transaction id in wire order, the reverse of its hex form
    const message = sha256(concat(text(action), input.txid.slice().reverse(), vout));
    return this.send(build(schnorr.sign(message, hex.decode(key))));
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

function quotePacket(q: PriceUpdate): UnknownPacket {
  return new UnknownPacket(QUOTE_PACKET, concat(Uint8Array.of(1), le8(q.price), le8(q.time)));
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
