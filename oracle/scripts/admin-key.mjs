#!/usr/bin/env node
// Makes an oracle's admin key, or reads one made earlier:
//   node scripts/admin-key.mjs <file>
// The secret is written to <file>, readable by you alone, and never printed. What it prints is
// the x-only public key to give `deploy.mjs --admin`. Whoever holds the file can move the
// oracle to other rules: keep it offline and backed up.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

const file = process.argv[2];
if (!file) throw new Error("usage: admin-key.mjs <file>");
if (!existsSync(file)) writeFileSync(file, `${hex.encode(schnorr.utils.randomSecretKey())}\n`, { mode: 0o600, flag: "wx" });
console.log(hex.encode(schnorr.getPublicKey(hex.decode(readFileSync(file, "utf8").trim()))));
