// End-to-end tests against a local regtest stack: arkd on :7070 and the emulator on :7073, with
// the operator's CLI wallet (in the `arkd` container) as the faucet.

import { execSync } from "node:child_process";
import {
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Wallet,
  arkade,
} from "@arkade-os/sdk";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { beforeAll, describe, expect, it } from "vitest";
import gateArtifact from "../../artifacts/price_gate.json";
import { DIA_KEY, dia, localFeed, trustedUpdate } from "../../src/dia";
import {
  type Connection,
  DiaOracle,
  type OracleParams,
  RENEW_TEMPLATE,
  connect,
  deploy,
} from "../../src/oracle";

const ARK_URL = "http://localhost:7070";
const EMULATOR_URL = "http://localhost:7073";
const EXPLORER_URL = "http://localhost:3000";
const EXECUTOR_URL = "http://localhost:7080";
const EXECUTOR_ADMIN_URL = "http://localhost:7081";

const sh = (cmd: string) => execSync(cmd, { encoding: "utf8", timeout: 90_000, stdio: "pipe" }).trim();
const pay = (address: string, sats: number) =>
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

let conn: Connection;
let wallet: Wallet;
const admin = hex.encode(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));

let gates = 0n;

/**
 * A coin anyone can spend while the oracle's price is at least `minPrice` cents. Each gate asks
 * a cent less than the one before, so each has an address, and a coin, of its own.
 */
async function gate(oracle: DiaOracle, minPrice: bigint, sats = 5_000) {
  gates += 1n;
  const contract = conn.client.contract(
    arkade.programFromArtifact(gateArtifact as arkade.ContractArtifact),
    { ...oracle.id, minPrice: minPrice - gates },
  );
  pay(contract.address, sats);
  const coin = await eventually(async () => {
    const { vtxos } = await conn.indexer.getVtxos({ scripts: [hex.encode(contract.pkScript)] });
    const unspent = vtxos.find((v) => !v.isSpent);
    if (!unspent) throw new Error("the gate is not funded yet");
    return { txid: unspent.txid, vout: unspent.vout, value: unspent.value, script: unspent.script };
  });
  return { contract, coin };
}

/** Spends a gate with the oracle's price; the gate's sats go to `to`. */
function open(oracle: DiaOracle, g: Awaited<ReturnType<typeof gate>>, to: Uint8Array) {
  return oracle.spend(
    () => conn.client.transaction().from(g.coin, g.contract.unlock.open()),
    (tx) => tx.to(to, BigInt(g.coin.value)),
  );
}

beforeAll(async () => {
  try {
    sh("docker exec arkd ark init --password secret --server-url localhost:7070 --explorer http://chopsticks:3000");
  } catch {
    // already initialized
  }
  const note = sh("docker exec arkd arkd note --amount 1000000").split("\n").pop() as string;
  sh(`docker exec arkd ark redeem-notes -n ${note} --password secret`);
  conn = await connect({ arkUrl: ARK_URL, emulatorUrl: EMULATOR_URL });
  wallet = await Wallet.create({
    identity: SingleKey.fromRandomBytes(),
    operatorProvider: new RestOperatorProvider(ARK_URL),
    indexerProvider: new RestIndexerProvider(ARK_URL),
    onchainProvider: new EsploraProvider(EXPLORER_URL),
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlement: false,
  });
  pay(await wallet.getAddress(), 200_000);
  await eventually(async () => {
    const balance = await wallet.getBalance();
    if (balance.available < 200_000) throw new Error("the deployer is not funded yet");
  });
}, 180_000);

describe("an oracle output", () => {
  const signer = secp256k1.utils.randomSecretKey();
  const price = { cents: 6_000_000 };
  const feed = localFeed(signer, () => price.cents);
  const sink = () => Uint8Array.of(0x51, 0x20, ...schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
  let params: OracleParams;
  let oracle: DiaOracle;

  it("is created with one output per lane, each holding one identity unit", async () => {
    params = await deploy(wallet, conn, feed, { adminPk: admin, lanes: 2 });
    oracle = new DiaOracle(conn, params, feed);
    const outputs = await eventually(async () => {
      const live = await oracle.outputs();
      expect(live).toHaveLength(2);
      return live;
    });
    expect(outputs.every((o) => o.script === oracle.script && o.value === 10_000)).toBe(true);
    const details = await conn.indexer.getAssetDetails(params.assetId);
    expect(details.supply).toBe(2n);
    expect(details.controlAssetId).toBeUndefined();
  }, 120_000);

  it("gives its price to a consumer and continues at the same address", async () => {
    const g = await gate(oracle, 5_000_000n);
    const before = await oracle.outputs();
    const { update, txid } = await open(oracle, g, sink());
    expect(update.price).toBe(6_000_000);
    await eventually(async () => {
      const live = await oracle.outputs();
      expect(live).toHaveLength(2);
      expect(live.filter((o) => before.some((b) => b.txid === o.txid))).toHaveLength(1);
      expect(live.some((o) => o.txid === txid && o.vout === 0)).toBe(true);
      expect(live.every((o) => o.value === 10_000)).toBe(true);
    });
  }, 120_000);

  it("is refused to a consumer whose condition the price does not meet", async () => {
    const g = await gate(oracle, 7_000_000n);
    await expect(open(oracle, g, sink())).rejects.toThrow("failed to execute arkade script");
    price.cents = 7_000_000;
    await open(oracle, g, sink());
    price.cents = 6_000_000;
  }, 120_000);

  it("refuses a price signed by a key it does not trust", async () => {
    const forged = localFeed(secp256k1.utils.randomSecretKey(), () => 9_000_000);
    expect(() => new DiaOracle(conn, params, forged)).toThrow("not signed by the key");
    const lying = new DiaOracle(conn, params, { key: feed.key, latest: () => forged.latest() });
    const g = await gate(lying, 5_000_000n);
    await expect(open(lying, g, sink())).rejects.toThrow("failed to execute arkade script");
  }, 120_000);

  it("serves several consumers at the same moment, moving to another output when one is taken", async () => {
    const gates = [await gate(oracle, 5_000_000n), await gate(oracle, 5_000_000n), await gate(oracle, 5_000_000n)];
    // three spends for two outputs: at least one finds its output taken and tries the other
    const done = await Promise.allSettled(gates.map((g) => open(oracle, g, sink())));
    expect(done.filter((d) => d.status === "fulfilled").length).toBeGreaterThanOrEqual(2);
    for (const [i, d] of done.entries()) {
      if (d.status === "rejected") await eventually(() => open(oracle, gates[i], sink()));
    }
    await eventually(async () => expect(await oracle.outputs()).toHaveLength(2));
  }, 180_000);

  // Needs executord on :7080 with the oracle's template (scripts/register-templates.sh).
  it("is renewed by an executor before it expires, and still serves consumers", async ({ skip }) => {
    const registered = await fetch(`${EXECUTOR_URL}/v1/template/${RENEW_TEMPLATE}`).then(
      (r) => r.ok,
      () => false,
    );
    if (!registered) return skip();
    const own = await deploy(wallet, conn, feed, { adminPk: admin });
    const single = new DiaOracle(conn, own, feed);
    const [before] = await eventually(async () => {
      const live = await single.outputs();
      expect(live).toHaveLength(1);
      return live;
    });

    const res = await fetch(`${EXECUTOR_URL}/v1/delegation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(single.renewal()),
    });
    expect(res.ok).toBe(true);
    const { delegation } = (await res.json()) as { delegation: { id: string } };
    try {
      const [after] = await eventually(async () => {
        const live = await single.outputs();
        expect(live).toHaveLength(1);
        expect(live[0].txid).not.toBe(before.txid);
        return live;
      }, 600);
      expect(after.expiresAt).toBeGreaterThan(before.expiresAt);
      expect(before.value - after.value).toBeGreaterThanOrEqual(0);
      expect(before.value - after.value).toBeLessThanOrEqual(1_000);
    } finally {
      // on regtest a coin is always within a day of its expiry: the executor would renew forever
      await fetch(`${EXECUTOR_ADMIN_URL}/v1/admin/delegation/${delegation.id}/cancel`, { method: "POST" });
    }
    const g = await gate(single, 5_000_000n);
    await eventually(() => open(single, g, sink()), 120);
  }, 900_000);

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

  it("verifies DIA's live signature when bound to DIA's signer", async () => {
    const live = dia();
    const diaParams = await deploy(wallet, conn, live, { adminPk: admin });
    expect(diaParams.oraclePk).toBe(DIA_KEY);
    const real = new DiaOracle(conn, diaParams, live);
    await eventually(async () => expect(await real.outputs()).toHaveLength(1));
    const g = await gate(real, 1_000_000n);
    const { update } = await eventually(() => open(real, g, sink()), 60);
    expect(Math.floor(Date.now() / 1000) - update.time).toBeLessThan(120);
    expect(update.price).toBeGreaterThan(1_000_000);
  }, 180_000);
});
