// The oracle output within Arkade: one coin per unit of an identity asset, each locked by the
// DiaBtcUsdOracle contract. A consumer contract names the asset, never a key or an address; a
// transaction that needs a price spends one of those coins as its input 1, hands it a signed
// update, and the contract recreates the coin on output 0 with the price in packet 34.

import {
  RestEmulatorProvider,
  RestIndexerProvider,
  RestOperatorProvider,
  UnknownPacket,
  arkade,
  asset,
  networks,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import artifact from "../artifacts/dia_btc_usd_oracle.json";
import templateIds from "../templates/ids.json";
import renewTemplate from "../templates/renew_oracle.json";
import type { PriceFeed, PriceUpdate } from "./dia.js";

/** The extension packet a verified price is written in: 0x01, price in cents, time. */
export const QUOTE_PACKET = 34;
/** How long before its expiry an oracle output may be renewed, in seconds. */
export const RENEWAL_WINDOW = 86_400n;
/** The most a renewal may take from an oracle output as the batch's fee, in sats. */
export const MAX_FEE = 1_000n;

/** Everything that tells where an oracle's outputs are. Its operator publishes this. */
export interface OracleParams {
  /** The identity asset. Consumers bind it; it never changes. */
  assetId: string;
  /** The price signer the outputs trust: 0x10 then a compressed key, hex. */
  oraclePk: string;
  /** The x-only key that can move the outputs to another script, hex. */
  adminPk: string;
  renewalWindow?: bigint;
  maxFee?: bigint;
}

/** An operator and its emulator, as contracts of several packages share them. */
export interface Connection {
  client: arkade.Arkade;
  indexer: RestIndexerProvider;
  network: string;
  dust: number;
  /** The operator's unilateral exit delay as a script reads it. */
  exitDelay: bigint;
}

export interface OracleOutput {
  txid: string;
  vout: number;
  value: number;
  script: string;
  /** Unix seconds; 0 when the operator states none. */
  expiresAt: number;
}

/** What an executor needs to run a template for an address: the body of its `POST /v1/delegation`. */
export interface Delegation {
  templateId: string;
  /** The template's variables, in lower-case hex. */
  variables: Record<string, string>;
}

/** The id of the template that renews an oracle's outputs, as an executor names it. */
export const RENEW_TEMPLATE: string = templateIds.renew_oracle;

export class ExecutorError extends Error {}

export class NoOracleOutputError extends Error {
  constructor() {
    super("the oracle has no live output at its address");
  }
}

/**
 * Connects to an operator and its emulator. On a public network the SDK knows the emulator's key
 * and this refuses an emulator that answers with another; a local stack has a key of its own.
 */
export async function connect(cfg: { arkUrl: string; emulatorUrl: string }): Promise<Connection> {
  const operator = new RestOperatorProvider(cfg.arkUrl);
  const emulator = new RestEmulatorProvider(cfg.emulatorUrl);
  const indexer = new RestIndexerProvider(cfg.arkUrl);
  const [info, emulatorInfo] = await Promise.all([operator.getInfo(), emulator.getInfo()]);
  const local = info.network === "regtest";
  const client = await arkade.Arkade.connect({
    arkade: operator,
    emulator,
    indexer,
    network: networks[info.network as keyof typeof networks] ?? networks.regtest,
    ...(local ? { emulatorPubkey: emulatorInfo.signerPubkey } : {}),
  });
  const xonly = (k: Uint8Array) => hex.encode(k.length === 33 ? k.slice(1) : k);
  if (!local && client.emulatorKey && xonly(client.emulatorKey) !== emulatorInfo.signerPubkey.slice(-64)) {
    throw new Error("the emulator's key is not the one the SDK trusts for this network");
  }
  // BIP68: seconds are counted in units of 512 with bit 22 set
  const delay = Number(info.unilateralExitDelay);
  return {
    client,
    indexer,
    network: info.network,
    dust: Number(info.dust),
    exitDelay: BigInt(delay >= 512 ? (1 << 22) | Math.floor(delay / 512) : delay),
  };
}

export class DiaOracle {
  readonly contract: arkade.ArkadeContract;
  /** The identity as a consumer contract's `AssetId oracleId` argument binds it. */
  readonly id: { "oracleId.txid": Uint8Array; "oracleId.gidx": bigint };

  constructor(
    private readonly conn: Connection,
    readonly params: OracleParams,
    readonly feed: PriceFeed,
  ) {
    if (hex.encode(feed.key) !== params.oraclePk) {
      throw new Error("the price feed is not signed by the key this oracle trusts");
    }
    this.id = assetArgument(params.assetId);
    this.contract = conn.client.contract(
      arkade.programFromArtifact(artifact as arkade.ContractArtifact),
      {
        ...this.id,
        oraclePk: hex.decode(params.oraclePk),
        adminPk: hex.decode(params.adminPk),
        renewalWindow: params.renewalWindow ?? RENEWAL_WINDOW,
        maxFee: params.maxFee ?? MAX_FEE,
        operatorExitDelay: conn.exitDelay,
      },
    );
  }

  get address(): string {
    return this.contract.address;
  }

  get script(): string {
    return hex.encode(this.contract.pkScript);
  }

  /**
   * What an executor needs to renew every output of this oracle before it expires, with no key
   * and nobody online. One delegation covers all of them; registering it again changes nothing.
   */
  renewal(): Delegation {
    const num = (n: bigint) => hex.encode(scriptNum(n));
    return {
      templateId: RENEW_TEMPLATE,
      variables: {
        oracle_txid: hex.encode(this.id["oracleId.txid"]),
        oracle_gidx: num(this.id["oracleId.gidx"]),
        oracle_pk: this.params.oraclePk,
        // an x-only key is the compressed key of even parity
        admin_pk: `02${this.params.adminPk}`,
        renewal_window: num(this.params.renewalWindow ?? RENEWAL_WINDOW),
        max_fee: num(this.params.maxFee ?? MAX_FEE),
        exit_delay: num(this.conn.exitDelay),
      },
    };
  }

  /**
   * Has an executor renew every output of this oracle before it expires. It gives the executor
   * the oracle's contract and renewal template when it lacks them, which an executor accepts on
   * its public port only when it runs with `EXECUTOR_PUBLIC_REGISTRY=true`, then registers the
   * delegation. Doing it again changes nothing.
   */
  async renewWith(executorUrl: string): Promise<void> {
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${executorUrl}/v1/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new ExecutorError(`the executor refused the ${path}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as { template?: { id: string } };
    };
    const known = await fetch(`${executorUrl}/v1/template/${RENEW_TEMPLATE}`).then((r) => r.ok);
    if (!known) {
      await post("artifact", { document: JSON.stringify(artifact) });
      const { template } = await post("template", { document: JSON.stringify(renewTemplate) });
      if (template?.id !== RENEW_TEMPLATE) {
        throw new ExecutorError("the executor names the renewal template otherwise: templates/ids.json is stale");
      }
    }
    await post("delegation", this.renewal());
  }

  /** The oracle's live outputs: the unspent coins at its script that hold one identity unit. */
  async outputs(): Promise<OracleOutput[]> {
    const { vtxos } = await this.conn.indexer.getVtxos({ scripts: [this.script] });
    return vtxos
      .filter((v) => !v.isSpent && v.assets?.some((a) => a.assetId === this.params.assetId && a.amount === 1n))
      .map((v) => ({
        txid: v.txid,
        vout: v.vout,
        value: v.value,
        script: v.script,
        expiresAt: v.expiresAt ? Math.floor(v.expiresAt.getTime() / 1000) : 0,
      }));
  }

  /**
   * Checks that the identity asset can only ever be where this oracle's rules hold it: it has no
   * control asset, so no unit can be minted, and every unit that exists is in a live output of
   * this oracle. A unit anywhere else is a coin that passes for the oracle with any price.
   *
   * Run it before trusting an oracle someone else deployed. It can fail for a moment while an
   * output is being spent, until the indexer lists the new one.
   */
  async audit(): Promise<void> {
    const [details, live] = await Promise.all([
      this.conn.indexer.getAssetDetails(this.params.assetId),
      this.outputs(),
    ]);
    if (details.controlAssetId !== undefined) {
      throw new Error("the oracle's asset has a control asset: more units can be minted");
    }
    if (details.supply !== BigInt(live.length)) {
      throw new Error(`the oracle's asset has ${details.supply} units and ${live.length} are in its outputs`);
    }
  }

  /**
   * Sends a transaction that reads the price. `start` returns a builder holding the consumer's
   * single `.from()`; `finish` adds the consumer's outputs and packets once the price is known.
   * The oracle lands where consumers read it: input 1 and output 0.
   *
   * Everyone reading a price spends one of the same few outputs. When another transaction took
   * the one this picked, it tries again on another, until none is left untried.
   */
  async spend(
    start: () => arkade.ArkadeTransactionBuilder,
    finish: (tx: arkade.ArkadeTransactionBuilder, update: PriceUpdate) => arkade.ArkadeTransactionBuilder,
  ): Promise<{ txid: string; update: PriceUpdate }> {
    const taken = new Set<string>();
    for (;;) {
      const tx = start();
      const { update, output } = await this.attach(tx, (o) => taken.has(o));
      try {
        const { txid } = await finish(tx, update).send();
        return { txid, update };
      } catch (e) {
        // arkd names the coin it refuses: only a refusal of the oracle output is worth another try
        const message = e instanceof Error ? e.message : String(e);
        if (!message.includes("ALREADY_SPENT") || !message.includes(output.txid)) throw e;
        taken.add(`${output.txid}:${output.vout}`);
      }
    }
  }

  /**
   * Adds the oracle to a consumer's transaction, with the feed's latest price: an oracle output
   * as input 1, its continuation as output 0, the identity unit and the price packet. `spend`
   * does this and sends; use `attach` to build without sending.
   *
   * Call it after the consumer's single `.from()` and before any `.to()`. `skip` names outputs,
   * as `txid:vout`, not to use. Outputs are picked at random, so the spends of many users spread
   * over them.
   */
  async attach(
    tx: arkade.ArkadeTransactionBuilder,
    skip: (outpoint: string) => boolean = () => false,
  ): Promise<{ update: PriceUpdate; output: OracleOutput }> {
    const [update, live] = await Promise.all([this.feed.latest(), this.outputs()]);
    const usable = live.filter((o) => !skip(`${o.txid}:${o.vout}`));
    if (!usable.length) throw new NoOracleOutputError();
    const output = usable[Math.floor(Math.random() * usable.length)];
    tx.from(
      { txid: output.txid, vout: output.vout, value: output.value, script: output.script },
      this.contract.unlock.verify({
        arkadeScript: [update.rawPrice, BigInt(update.time), update.nonce, update.expiry, update.signature],
      }),
    )
      .to(this.contract.pkScript, BigInt(output.value))
      .withAsset({
        assetId: this.params.assetId,
        inputs: [{ vin: 1, amount: 1 }],
        outputs: [{ vout: 0, amount: 1 }],
      })
      .withPacket(quotePacket(update));
    return { update, output };
  }
}

/** A non-negative integer as the minimal number a script reads. */
export function scriptNum(n: bigint): Uint8Array {
  const out: number[] = [];
  for (let v = n; v > 0n; v >>= 8n) out.push(Number(v & 0xffn));
  if (out.length && out[out.length - 1] & 0x80) out.push(0);
  return Uint8Array.from(out);
}

/** The price note of a transaction: 0x01, the price in cents and its time, 8 bytes each. */
export function quotePacket(update: Pick<PriceUpdate, "price" | "time">): UnknownPacket {
  const body = new Uint8Array(17);
  body[0] = 1;
  const view = new DataView(body.buffer);
  view.setBigUint64(1, BigInt(update.price), true);
  view.setBigUint64(9, BigInt(update.time), true);
  return new UnknownPacket(QUOTE_PACKET, body);
}

/** An asset id as a contract's `AssetId` argument takes it: the issuance txid reversed, and the group index. */
export function assetArgument(assetId: string): { "oracleId.txid": Uint8Array; "oracleId.gidx": bigint } {
  const id = asset.AssetId.fromString(assetId);
  return { "oracleId.txid": Uint8Array.from(id.txid).reverse(), "oracleId.gidx": BigInt(id.groupIndex) };
}

/** What `deploy` needs of a wallet: an `@arkade-os/sdk` Wallet has it. */
export interface Deployer {
  assetManager: { issue(params: { amount: bigint }): Promise<{ assetId: string }> };
  send(params: { address: string; amount: number; assets: { assetId: string; amount: bigint }[] }): Promise<string>;
}

/**
 * Creates an oracle: issues `lanes` units of a new asset with no control asset, so no more can
 * ever exist, and locks each in an output of its own. More lanes let more transactions read a
 * price at the same moment. Each output holds `sats`, which pay its renewals' fees.
 */
export async function deploy(
  wallet: Deployer,
  conn: Connection,
  feed: PriceFeed,
  cfg: { adminPk: string; lanes?: number; sats?: number },
): Promise<OracleParams> {
  const lanes = cfg.lanes ?? 1;
  const { assetId } = await wallet.assetManager.issue({ amount: BigInt(lanes) });
  const params: OracleParams = { assetId, oraclePk: hex.encode(feed.key), adminPk: cfg.adminPk };
  const oracle = new DiaOracle(conn, params, feed);
  for (let lane = 0; lane < lanes; lane++) {
    await wallet.send({
      address: oracle.address,
      amount: cfg.sats ?? 10_000,
      assets: [{ assetId, amount: 1n }],
    });
  }
  return params;
}
