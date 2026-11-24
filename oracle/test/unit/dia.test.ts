import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oracleArtifact from "../../artifacts/dia_btc_usd_oracle.json";
import {
  DIA_DOMAIN,
  DIA_INTENT,
  DIA_KEY,
  DIA_SECOND_KEY,
  OracleError,
  OtherSignerError,
  decodeDia,
  dia,
  localFeed,
} from "../../src/dia";
import sample from "./testdata/dia.json";

// The recorded update is signed by the second of DIA's two signers.
const KEY = DIA_SECOND_KEY;
const SIGNER = "6f8b0911b1c77de54e113e326ed4bac69da5c51c";
const OTHER = "10e34723aa722c7a9860f5ec6446f22252db168a";

// A response of DIA's registry, recorded from its public RPC.
const answer = () => new Response(JSON.stringify({ result: sample.result }));
const event = (hash: string, signer: string) => ({
  topics: ["0x00", `0x${hash.repeat(32)}`, "0x00", "0x00"],
  data: `0x${"00".repeat(44)}${signer}`,
});
/**
 * A registry whose latest update is another signer's. Its events list `signers` oldest first,
 * and it serves the recorded update for the hash of an event of the trusted signer.
 */
const registry = (signers: string[]) =>
  vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: { data: string }[] };
    const reply = (result: unknown) => new Response(JSON.stringify({ result }));
    if (method === "eth_blockNumber") return reply("0x3e8");
    if (method === "eth_getLogs") return reply(signers.map((s, i) => event(`a${i}`, s)));
    const hash = params[0].data.slice(10);
    if (hash.length !== 64) return reply(otherSigner());
    const at = Number(hash[1]);
    return reply(signers[at] === SIGNER ? sample.result : otherSigner());
  });
// The same update with another price: its signature is no longer the pinned signer's.
const otherSigner = () => {
  const words = sample.result.slice(2).match(/.{64}/g) as string[];
  words[7] = (BigInt(`0x${words[7]}`) + 1n).toString(16).padStart(64, "0");
  return `0x${words.join("")}`;
};

describe("decodeDia", () => {
  it("reads a real update and rounds its price to the cent", () => {
    const u = decodeDia(sample.result, KEY);
    expect(u.time).toBe(sample.time);
    expect(u.price).toBe(Number((BigInt(sample.price) + 5n * 10n ** 15n) / 10n ** 16n));
    expect(u.rawPrice).toBe(BigInt(sample.price));
    expect(u.expiry).toBe(BigInt(sample.time) + 3600n);
    expect(u.signature).toHaveLength(64);
  });

  it("refuses an update whose price is not the one signed", () => {
    expect(() => decodeDia(otherSigner(), KEY)).toThrow(OtherSignerError);
  });

  it("refuses the recorded update for DIA's other signer", () => {
    expect(() => decodeDia(sample.result, DIA_KEY)).toThrow(OtherSignerError);
  });

  it.each(["", "0x", "0xzz", `0x${"00".repeat(32 * 12)}`])("refuses %j", (result) => {
    expect(() => decodeDia(result, KEY)).toThrow(OracleError);
  });
});

describe("the oracle contract", () => {
  it("checks the domain and the message type this client signs and verifies", () => {
    const asm = JSON.stringify(oracleArtifact);
    expect(asm).toContain(`0x${hex.encode(DIA_DOMAIN)}`);
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
    const oracle = dia({ key: KEY, request });
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
    const oracle = dia({ key: KEY, request });
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

  it("reads the trusted signer's newest update when another signed the latest", async () => {
    const request = registry([SIGNER, OTHER, SIGNER, OTHER]);
    const u = await dia({ key: KEY, request }).latest();
    expect(u.time).toBe(sample.time);
    const calls = request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { method: string; params: { data?: string; fromBlock?: string }[] });
    expect(calls.map((c) => c.method)).toEqual(["eth_call", "eth_blockNumber", "eth_getLogs", "eth_call"]);
    expect(calls[2].params[0].fromBlock).toBe("0x190");
    expect(calls[3].params[0].data?.slice(10)).toBe("a2".repeat(32));
  });

  it("has no price while only another signer has published lately, and asks again soon", async () => {
    const request = registry([OTHER, OTHER]);
    const oracle = dia({ key: KEY, request });
    await expect(oracle.latest()).rejects.toThrow(OtherSignerError);
    await expect(oracle.latest()).rejects.toThrow(OracleError);
    expect(request).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(5_000);
    await expect(oracle.latest()).rejects.toThrow(OtherSignerError);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("fails without a first answer and waits before asking again", async () => {
    const request = vi.fn(async () => new Response("", { status: 429 }));
    const oracle = dia({ key: KEY, request });
    await expect(oracle.latest()).rejects.toThrow("DIA answered 429");
    await expect(oracle.latest()).rejects.toThrow(OracleError);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("localFeed", () => {
  it("signs the price it is given, dated just before now, in DIA's format", async () => {
    const secret = new Uint8Array(32).fill(9);
    const feed = localFeed(secret, () => 6_000_000);
    const u = await feed.latest();
    expect(u.price).toBe(6_000_000);
    expect(u.rawPrice).toBe(6_000_000n * 10n ** 16n);
    expect(Math.floor(Date.now() / 1000) - u.time).toBeGreaterThanOrEqual(5);
    expect(feed.key).toEqual(Uint8Array.of(0x10, ...secp256k1.getPublicKey(secret, true)));
  });

  it("refuses to sign no price", async () => {
    await expect(localFeed(new Uint8Array(32).fill(9), () => 0).latest()).rejects.toThrow(OracleError);
  });
});

describe("dia", () => {
  it("reads DIA's documented signer unless told another", () => {
    expect(hex.encode(dia().key)).toBe(DIA_KEY);
    expect(hex.encode(dia({ key: DIA_SECOND_KEY }).key)).toBe(DIA_SECOND_KEY);
  });
});
