import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { arkade } from "@arkade-os/sdk";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error a build script, not typed
import { compileContract } from "../../scripts/compile.mjs";
import {
  type Connection,
  DiaOracle,
  ExecutorError,
  RENEW_TEMPLATE,
  assetArgument,
  quotePacket,
  scriptNum,
} from "../../src/oracle";

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

describe("renewWith", () => {
  const params = {
    assetId: `${"11".repeat(32)}0000`,
    oraclePk: `10${hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(4), true))}`,
    adminPk: hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(5))),
  };
  const key = (b: number) => schnorr.getPublicKey(new Uint8Array(32).fill(b));
  // an operator and emulator that exist only as keys: enough to derive the oracle's address
  const conn = {
    client: {
      contract: (program: ReturnType<typeof arkade.programFromArtifact>, args: Record<string, unknown>) => {
        const script = new arkade.ArkadeProgramScript(program, { ...args, server: key(1) } as never, {
          serverKey: key(1),
          emulatorKey: key(2),
        });
        return { pkScript: script.pkScript, address: "tark1test" };
      },
    },
    exitDelay: 4194308n,
  } as unknown as Connection;
  const oracle = new DiaOracle(conn, params, { key: hex.decode(params.oraclePk), latest: () => Promise.reject() });

  const executor = (has: boolean, templateId = RENEW_TEMPLATE) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = url.replace("http://executor/v1/", "");
      calls.push(`${init?.method ?? "GET"} ${path.split("/")[0]}`);
      if (!init) return new Response("{}", { status: has ? 200 : 404 });
      const body = JSON.parse(String(init.body)) as { document?: string; templateId?: string };
      if (path === "artifact") expect(JSON.parse(body.document ?? "").contractName).toBe("DiaBtcUsdOracle");
      if (path === "template") expect(JSON.parse(body.document ?? "").type).toBe("proof");
      if (path === "delegation") expect(body.templateId).toBe(RENEW_TEMPLATE);
      return new Response(JSON.stringify({ template: { id: templateId } }));
    });
    return calls;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("only registers the delegation when the executor has the template", async () => {
    const calls = executor(true);
    await oracle.renewWith("http://executor");
    expect(calls).toEqual(["GET template", "POST delegation"]);
  });

  it("gives the executor the contract and the template first when it lacks them", async () => {
    const calls = executor(false);
    await oracle.renewWith("http://executor");
    expect(calls).toEqual(["GET template", "POST artifact", "POST template", "POST delegation"]);
  });

  it("stops when the executor names the template otherwise", async () => {
    executor(false, "00".repeat(32));
    await expect(oracle.renewWith("http://executor")).rejects.toThrow(ExecutorError);
  });

  it("reports an executor that refuses templates", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) =>
      init ? new Response("registration is disabled", { status: 403 }) : new Response("{}", { status: 404 }),
    );
    await expect(oracle.renewWith("http://executor")).rejects.toThrow("refused the artifact");
  });
});
