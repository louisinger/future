#!/usr/bin/env node
// Records a deployed oracle as the one a network's market reads:
//   node scripts/save.mjs <file from deploy>
// It writes the oracle's identity, signer and admin key under its network in
// sdk/src/oracles.json, which the app is built with.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const file = process.argv[2];
if (!file) throw new Error("usage: save.mjs <file from deploy>");
const { assetId, oraclePk, adminPk, network } = JSON.parse(readFileSync(file, "utf8"));
const name = network === "bitcoin" ? "mainnet" : network;
if (!["mainnet", "mutinynet"].includes(name)) throw new Error(`the app has no network ${name}`);
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "sdk", "src", "oracles.json");
const all = JSON.parse(readFileSync(target, "utf8"));
all[name] = { assetId, oraclePk, adminPk };
writeFileSync(target, `${JSON.stringify(all, null, 2)}\n`);
console.log(`${name}: ${assetId}`);
