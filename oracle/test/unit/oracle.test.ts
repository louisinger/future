import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
// @ts-expect-error a build script, not typed
import { compileContract } from "../../scripts/compile.mjs";
import { assetArgument, quotePacket, scriptNum } from "../../src/oracle";

describe("the committed artifacts", () => {
  it.each([
    ["dia_btc_usd_oracle.ark", "dia_btc_usd_oracle.json"],
    ["test/price_gate.ark", "price_gate.json"],
  ])("%s compiles to artifacts/%s", async (entry, file) => {
    const committed = JSON.parse(readFileSync(new URL(`../../artifacts/${file}`, import.meta.url), "utf8"));
    expect(await compileContract(entry)).toEqual(committed);
  });

  it("are written for the two-key operator, with nothing executord refuses", async () => {
    const text = readFileSync(new URL("../../artifacts/dia_btc_usd_oracle.json", import.meta.url), "utf8");
    expect(text).not.toContain("OPERATOR_KEY");
    expect(text).not.toContain("codeHash");
    for (const token of text.match(/"\d+"/g) ?? []) {
      expect(BigInt(token.slice(1, -1)) <= BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    }
  });
});

describe("quotePacket", () => {
  it("is a version byte, the price in cents and the time, 8 bytes each, little-endian", () => {
    const p = quotePacket({ price: 6_000_000, time: 1_800_000_000 });
    expect(hex.encode(p.serialize())).toBe("01808d5b000000000000d2496b00000000");
  });
});

describe("assetArgument", () => {
  it("binds an asset id as the reversed issuance txid and the group index", () => {
    const txid = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const got = assetArgument(`${txid}0100`);
    expect(hex.encode(got["oracleId.txid"])).toBe(hex.encode(hex.decode(txid).reverse()));
    expect(got["oracleId.gidx"]).toBe(1n);
  });
});

describe("scriptNum", () => {
  it.each([
    [0n, ""],
    [1n, "01"],
    [127n, "7f"],
    [128n, "8000"],
    [255n, "ff00"],
    [256n, "0001"],
    [1_795_538_283n, "6bbd056b"],
  ])("%d", (n, want) => {
    expect(hex.encode(scriptNum(n))).toBe(want);
  });
});
