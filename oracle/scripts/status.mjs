#!/usr/bin/env node
// Shows an oracle's state: its outputs and when they expire, whether every unit of its asset is
// in them, whether its signer is publishing, and whether an executor renews it.
// Build the package first (`pnpm build`), then:
//
//   node scripts/status.mjs --ark <operator> --emulator <emulator> --params <file from deploy>
//     [--executor <executor's public URL>] [--register]
//
// --register asks the executor to renew the oracle's outputs; asking again changes nothing.
import { readFileSync } from "node:fs";
import { DiaOracle, RENEW_TEMPLATE, connect, dia } from "../dist/index.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, a, i, all) => (a.startsWith("--") ? [...out, [a.slice(2), all[i + 1]]] : out), []),
);
for (const required of ["ark", "emulator", "params"]) {
  if (!args[required]) throw new Error(`--${required} is required`);
}
const { assetId, oraclePk, adminPk } = JSON.parse(readFileSync(args.params, "utf8"));
const conn = await connect({ arkUrl: args.ark, emulatorUrl: args.emulator });
const oracle = new DiaOracle(conn, { assetId, oraclePk, adminPk }, dia({ key: oraclePk }));
const now = Math.floor(Date.now() / 1000);

console.log("network ", conn.network);
console.log("address ", oracle.address);
const outputs = await oracle.outputs();
for (const o of outputs) {
  const days = o.expiresAt ? `${((o.expiresAt - now) / 86400).toFixed(1)} days` : "unknown";
  console.log(`output   ${o.txid}:${o.vout}  ${o.value} sats  expires in ${days}`);
}
if (!outputs.length) console.log("output   none");
console.log("audit   ", await oracle.audit().then(() => "ok: no control asset, every unit is in an output", (e) => `FAILED: ${e.message}`));
console.log(
  "price   ",
  await oracle.feed.latest().then(
    (u) => `$${(u.price / 100).toFixed(2)}, signed ${now - u.time} s ago by the trusted signer`,
    (e) => `FAILED: ${e.message}`,
  ),
);
if (args.executor) {
  const has = await fetch(`${args.executor}/v1/template/${RENEW_TEMPLATE}`).then((r) => r.ok, () => false);
  console.log("executor", has ? "has the renewal template" : "does NOT have the renewal template");
  if (has && "register" in args) {
    const res = await fetch(`${args.executor}/v1/delegation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(oracle.renewal()),
    });
    console.log("renewal ", res.ok ? "registered" : `refused: ${await res.text()}`);
  } else if (has) {
    const d = await fetch(`${args.executor}/v1/delegation?address=${oracle.address}`).then((r) => (r.ok ? r.json() : null), () => null);
    console.log("renewal ", d?.delegation ? `registered, ${d.delegation.status}` : "not registered: run again with --register");
  }
}
process.exit(0);
