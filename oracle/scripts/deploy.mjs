#!/usr/bin/env node
// Deploys an oracle: issues its identity asset and locks one unit in each of its outputs.
// Build the package first (`pnpm build`), then:
//
//   node scripts/deploy.mjs --ark https://mutinynet.arkade.sh \
//     --emulator https://emulator.mutinynet.arkade.sh --admin <x-only key, hex>
//
//   --signer   dia (default), second, a 0x10-prefixed key in hex, or test:<seed> for a key
//              derived from a seed, as a local stack uses
//   --lanes    how many outputs, so that many transactions can read a price at once (default 3)
//   --sats     what each output holds, which pays its renewals' fees (default 10000)
//   --key      the funding wallet's key, hex; a new one is made and printed otherwise
//   --explorer an esplora URL, for a local stack
//   --out      a file to write the oracle's parameters to, besides printing them
//   --executor an executor's URL: once deployed, gives it the oracle's contract and renewal
//              template if it lacks them, and asks it to renew the oracle's outputs. The
//              executor must run with EXECUTOR_PUBLIC_REGISTRY=true, or already have them
//
// It prints an address and waits for it to hold lanes * sats, plus a little for the operator's
// dust. The admin key can move the oracle to another script: keep its secret offline.
import { writeFileSync } from "node:fs";
import {
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { DIA_KEY, DIA_SECOND_KEY, DiaOracle, connect, deploy } from "../dist/index.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, a, i, all) => (a.startsWith("--") ? [...out, [a.slice(2), all[i + 1]]] : out), []),
);
for (const required of ["ark", "emulator", "admin"]) {
  if (!args[required]) throw new Error(`--${required} is required`);
}
if (!/^[0-9a-f]{64}$/.test(args.admin)) throw new Error("--admin is an x-only key: 64 hexadecimal characters");
const lanes = Number(args.lanes ?? 3);
const sats = Number(args.sats ?? 10_000);

function signerKey(spec = "dia") {
  if (spec === "dia") return DIA_KEY;
  if (spec === "second") return DIA_SECOND_KEY;
  if (spec.startsWith("test:")) {
    const secret = sha256(new TextEncoder().encode(spec.slice(5)));
    return `10${hex.encode(secp256k1.getPublicKey(secret, true))}`;
  }
  if (!/^10(02|03)[0-9a-f]{64}$/.test(spec)) throw new Error("--signer is not a 0x10-prefixed compressed key");
  return spec;
}

// fail on a wrong operator, emulator, signer or executor before any money moves
const conn = await connect({ arkUrl: args.ark, emulatorUrl: args.emulator });
if (args.executor) {
  const info = await fetch(`${args.executor}/v1/info`).then((r) => r.json());
  const network = info.network === "bitcoin" ? "bitcoin" : info.network;
  if (network !== conn.network) throw new Error(`the executor serves ${info.network}, the operator ${conn.network}`);
}
// deploying needs the signer's key, not its prices
const feed = { key: hex.decode(signerKey(args.signer)), latest: () => Promise.reject(new Error("no feed")) };
console.error(`network ${conn.network}, signer ${hex.encode(feed.key)}, ${lanes} outputs of ${sats} sats`);

const identity = args.key ? SingleKey.fromHex(args.key) : SingleKey.fromRandomBytes();
const wallet = await Wallet.create({
  identity,
  operatorProvider: new RestOperatorProvider(args.ark),
  indexerProvider: new RestIndexerProvider(args.ark),
  ...(args.explorer ? { onchainProvider: new EsploraProvider(args.explorer) } : {}),
  storage: {
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  },
  settlement: false,
});
const needed = lanes * sats + 1_000;
if (!args.key) console.error("funding wallet key (keep it until the oracle is live):", identity.toHex());
console.error(`send ${needed} sats to ${await wallet.getAddress()}`);
while ((await wallet.getBalance()).available < needed) await new Promise((r) => setTimeout(r, 3_000));

const params = await deploy(wallet, conn, feed, { adminPk: args.admin, lanes, sats });
const oracle = new DiaOracle(conn, params, feed);
const out = JSON.stringify({ ...params, address: oracle.address, network: conn.network }, null, 2);
if (args.out) writeFileSync(args.out, `${out}\n`);
console.log(out);
if (args.executor) {
  await oracle.renewWith(args.executor).then(
    () => console.error("the executor will renew the oracle's outputs"),
    (e) => console.error(`${e.message}\nrun scripts/status.mjs with --register once it accepts templates`),
  );
}
process.exit(0);
