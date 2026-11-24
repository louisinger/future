// Writes artifacts/ from contracts/: `pnpm build:contracts`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileContract } from "./compile.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "artifacts");
mkdirSync(out, { recursive: true });
for (const [entry, file] of [
  ["dia_btc_usd_oracle.ark", "dia_btc_usd_oracle.json"],
  ["test/price_gate.ark", "price_gate.json"],
]) {
  writeFileSync(join(out, file), `${JSON.stringify(await compileContract(entry), null, 2)}\n`);
  console.log("wrote", file);
}
