import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import positionArtifact from "../../contracts/artifacts/position.json";
import {
  DIA_DOMAIN,
  DIA_INTENT,
  OracleError,
  OtherSignerError,
  decodeDia,
  dia,
  localOracle,
  scriptNum,
} from "../../src/oracle";
import sample from "./testdata/dia.json";

// A response of DIA's registry, recorded from its public RPC.
const answer = () => new Response(JSON.stringify({ result: sample.result }));
// The same update with another price: its signature is no longer the pinned signer's.
const otherSigner = () => {
  const words = sample.result.slice(2).match(/.{64}/g) as string[];
  words[7] = (BigInt(`0x${words[7]}`) + 1n).toString(16).padStart(64, "0");
  return `0x${words.join("")}`;
};

describe("decodeDia", () => {
  it("reads a real update and rounds its price to the cent", () => {
    const u = decodeDia(sample.result);
    expect(u.time).toBe(sample.time);
    expect(u.price).toBe(Number((BigInt(sample.price) + 5n * 10n ** 15n) / 10n ** 16n));
    expect(u.witness[0]).toEqual(scriptNum(BigInt(sample.price)));
    expect(u.witness[3]).toHaveLength(64);
  });

  it("refuses an update whose price is not the one signed", () => {
    expect(() => decodeDia(otherSigner())).toThrow(OtherSignerError);
  });

  it.each(["", "0x", "0xzz", `0x${"00".repeat(32 * 12)}`])("refuses %j", (result) => {
    expect(() => decodeDia(result)).toThrow(OracleError);
  });
});

describe("the contracts", () => {
  it("check the domain and the message type this client signs and verifies", () => {
    const asm = JSON.stringify(positionArtifact);
    expect(asm).toContain(`0x1901${hex.encode(DIA_DOMAIN)}`);
    expect(asm).toContain(`0x${hex.encode(DIA_INTENT)}`);
  });
});

describe("dia", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime((sample.time + 10) * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one request for many callers and reuses the update until DIA publishes again", async () => {
    const request = vi.fn(async () => answer());
    const oracle = dia(request);
    const [a, b] = await Promise.all([oracle.latest(), oracle.latest()]);
    expect(a).toBe(b);
    await oracle.latest();
    expect(request).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(21_000);
    await oracle.latest();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("backs off when refused, serving the last update while the contracts still take it", async () => {
    let refuse = false;
    const request = vi.fn(async () => (refuse ? new Response("", { status: 429 }) : answer()));
    const oracle = dia(request);
    const first = await oracle.latest();

    refuse = true;
    vi.advanceTimersByTime(21_000);
    expect(await oracle.latest()).toBe(first);
    expect(request).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    expect(await oracle.latest()).toBe(first);
    expect(request).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(4_000);
    expect(await oracle.latest()).toBe(first);
    expect(request).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(60_000);
    await expect(oracle.latest()).rejects.toThrow(OracleError);
  });

  it("keeps the last update and asks again soon when the latest is another signer's", async () => {
    let other = false;
    const request = vi.fn(
      async () => new Response(JSON.stringify({ result: other ? otherSigner() : sample.result })),
    );
    const oracle = dia(request);
    const first = await oracle.latest();

    other = true;
    for (let asked = 2; asked <= 4; asked++) {
      vi.advanceTimersByTime(21_000);
      expect(await oracle.latest()).toBe(first);
      expect(request).toHaveBeenCalledTimes(asked);
      vi.advanceTimersByTime(4_000);
      expect(await oracle.latest()).toBe(first);
      expect(request).toHaveBeenCalledTimes(asked);
    }
  });

  it("has no price while the only update seen is another signer's", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ result: otherSigner() })));
    const oracle = dia(request);
    await expect(oracle.latest()).rejects.toThrow(OtherSignerError);
    vi.advanceTimersByTime(5_000);
    await expect(oracle.latest()).rejects.toThrow(OtherSignerError);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails without a first answer and waits before asking again", async () => {
    const request = vi.fn(async () => new Response("", { status: 429 }));
    const oracle = dia(request);
    await expect(oracle.latest()).rejects.toThrow("DIA answered 429");
    await expect(oracle.latest()).rejects.toThrow(OracleError);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("localOracle", () => {
  it("signs the price it is given, dated just before now", async () => {
    const secret = new Uint8Array(32).fill(9);
    const oracle = localOracle(secret, () => 6_000_000);
    const u = await oracle.latest();
    expect(u.price).toBe(6_000_000);
    expect(Math.floor(Date.now() / 1000) - u.time).toBeGreaterThanOrEqual(5);
    expect(oracle.key).toEqual(Uint8Array.of(0x10, ...secp256k1.getPublicKey(secret, true)));
    expect(u.witness[0]).toEqual(scriptNum(6_000_000n * 10n ** 16n));
  });

  it("refuses to sign no price", async () => {
    await expect(localOracle(new Uint8Array(32).fill(9), () => 0).latest()).rejects.toThrow(OracleError);
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
