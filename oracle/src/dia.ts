// DIA's signed BTC/USD prices: an EIP-712 `OracleUpdate` of DIA's registry on Lasernet, signed
// with an Ethereum key. https://www.diadata.org/docs

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";

const DIA_RPC = "https://rpc.diadata.org/";
const DIA_REGISTRY = "5612599cf48032d7428399d5fcb99edcc75c06a7";
const DIA_CHAIN = 1050n;
/**
 * DIA's Lasernet price signer, 0x10e34723aA722C7A9860f5eC6446f22252dB168a, as a script takes a
 * key: 0x10 marks an ECDSA key. DIA has a second signer publishing to the same registry,
 * 0x6f8b0911b1c77de54e113e326ed4bac69da5c51c (`DIA_SECOND_KEY`); an oracle output trusts one.
 */
export const DIA_KEY = "100211ee120bca9f272034d98b1b026bb4ab735ebeb5da8be6a69bf7ee0ea24cfd48";
export const DIA_SECOND_KEY = "1002b79a8537202478fb5285c4b580d32160471c2671ad8cc0711f9dd8c88f962277";
export const DIA_EXPLORER = `https://explorer.diadata.org/address/0x${DIA_REGISTRY}`;

// Lasernet makes a block every 0.3 seconds: this is about three minutes of updates.
const LOOKBACK_BLOCKS = 600n;
// DIA publishes about every 25 seconds: asking more often than this returns the same update.
const REUSE_MS = 20_000;
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 120_000;
// An update this old is no longer served: consumers usually want a price of the last minutes.
const STALE_AFTER = 90;
// The emulator refuses a price dated ahead of its clock.
const CLOCK_MARGIN = 5;
// DIA prices have 18 decimals, the contracts count in cents.
const CENT = 10n ** 16n;

/** A signed BTC/USD update, as DIA publishes it. */
export interface PriceUpdate {
  /** USD cents for one bitcoin, rounded half up as the oracle output rounds it. */
  price: number;
  /** When the price was taken, unix seconds. */
  time: number;
  /** The signed price, with 18 decimals. */
  rawPrice: bigint;
  nonce: bigint;
  /** When the update stops being accepted, unix seconds. */
  expiry: bigint;
  /** The signer's 64-byte signature. */
  signature: Uint8Array;
}

/** Where signed prices come from, and the key that signs them. */
export interface PriceFeed {
  /** The signer's key as an oracle output holds it: 0x10 then the compressed key. */
  readonly key: Uint8Array;
  latest(): Promise<PriceUpdate>;
}

export class OracleError extends Error {}

/** DIA has several signers taking turns; an oracle output takes the prices of one. */
export class OtherSignerError extends OracleError {
  constructor() {
    super("DIA has no recent price from the signer this oracle trusts");
  }
}

interface Signed {
  raw: bigint;
  time: bigint;
  nonce: bigint;
  expiry: bigint;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const word = (n: bigint) => hex.decode(n.toString(16).padStart(64, "0"));
const hash = (...parts: Uint8Array[]) => keccak_256(concatBytes(...parts));
const name = (s: string) => hash(utf8(s));
const seconds = () => Math.floor(Date.now() / 1000);

export const DIA_DOMAIN = hash(
  name("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"),
  name("DIA Oracle"),
  name("1.0"),
  word(DIA_CHAIN),
  word(BigInt(`0x${DIA_REGISTRY}`)),
  word(0n),
);
export const DIA_INTENT = name(
  "OracleIntent(string intentType,string version,uint256 chainId,uint256 nonce,uint256 expiry," +
    "string symbol,uint256 price,uint256 timestamp,string source)",
);

function digest(u: Signed): Uint8Array {
  const body = hash(
    DIA_INTENT,
    name("OracleUpdate"),
    name("1.0"),
    word(DIA_CHAIN),
    word(u.nonce),
    word(u.expiry),
    name("BTC/USD"),
    word(u.raw),
    word(u.time),
    name("DIA Oracle"),
  );
  return hash(Uint8Array.of(0x19, 0x01), DIA_DOMAIN, body);
}

function update(u: Signed, signature: Uint8Array): PriceUpdate {
  return {
    price: Number((u.raw + CENT / 2n) / CENT),
    time: Number(u.time),
    rawPrice: u.raw,
    nonce: u.nonce,
    expiry: u.expiry,
    signature,
  };
}

/**
 * Reads an update as DIA's registry returns it and checks it is signed by `key`, the key the
 * oracle output trusts, so a transaction is never built on an update it would refuse.
 */
export function decodeDia(result: string, key: string = DIA_KEY): PriceUpdate {
  let out: Uint8Array;
  try {
    out = hex.decode(result.replace(/^0x/, ""));
  } catch {
    throw new OracleError("DIA returned no price");
  }
  if (out.length < 32 * 12) throw new OracleError("DIA returned no price");
  const field = (i: number) => BigInt(`0x${hex.encode(out.subarray(32 + i * 32, 64 + i * 32))}`);
  const u = { nonce: field(3), expiry: field(4), raw: field(6), time: field(7) };
  const at = field(9) < BigInt(out.length) ? 64 + Number(field(9)) : out.length;
  const signature = out.slice(at, at + 64);
  const signer = hex.decode(key).subarray(1);
  if (signature.length !== 64 || !secp256k1.verify(signature, digest(u), signer, { prehash: false, lowS: false })) {
    throw new OtherSignerError();
  }
  return update(u, signature);
}

const abiString = (s: string) => {
  const b = utf8(s);
  return hex.encode(word(BigInt(b.length))) + hex.encode(b).padEnd(Math.ceil(b.length / 32) * 64, "0");
};
const selector = (signature: string) => `0x${hex.encode(name(signature)).slice(0, 8)}`;
const registry = (data: string) => [{ to: `0x${DIA_REGISTRY}`, data }, "latest"];
const LATEST_UPDATE = registry(
  selector("getLatestIntentByType(string,string)") +
    hex.encode(word(64n)) +
    hex.encode(word(128n)) +
    abiString("OracleUpdate") +
    abiString("BTC/USD"),
);
const UPDATE_REGISTERED = `0x${hex.encode(name("IntentRegistered(bytes32,string,uint256,uint256,address)"))}`;
const BTC_USD = `0x${hex.encode(name("BTC/USD"))}`;
// An Ethereum address is the end of the hash of the uncompressed key.
const address = (key: string) =>
  hex.encode(
    keccak_256(secp256k1.Point.fromBytes(hex.decode(key).subarray(1)).toBytes(false).subarray(1)).subarray(12),
  );

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * The newest BTC/USD update signed by `key`. The registry's own "latest" is whichever signer
 * published last, so when that is another one, this finds the trusted signer's in the registry's
 * recent events and reads it by its hash.
 */
export async function trustedUpdate(rpc: Rpc, key: string = DIA_KEY): Promise<PriceUpdate> {
  const signer = address(key);
  try {
    return decodeDia(String(await rpc("eth_call", LATEST_UPDATE)), key);
  } catch (e) {
    if (!(e instanceof OtherSignerError)) throw e;
  }
  const head = BigInt(String(await rpc("eth_blockNumber", [])));
  const events = (await rpc("eth_getLogs", [
    {
      address: `0x${DIA_REGISTRY}`,
      topics: [UPDATE_REGISTERED, null, BTC_USD],
      fromBlock: `0x${(head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n).toString(16)}`,
      toBlock: "latest",
    },
  ])) as { topics?: string[]; data?: string }[];
  const mine = Array.isArray(events)
    ? events.filter((e) => e.data?.toLowerCase().endsWith(signer) && e.topics?.length === 4).at(-1)
    : undefined;
  if (!mine?.topics) throw new OtherSignerError();
  const update = await rpc("eth_call", registry(selector("getIntent(bytes32)") + mine.topics[1].slice(2)));
  return decodeDia(String(update), key);
}

/**
 * DIA's live BTC/USD price, read from its public RPC with no key and no account. However often it
 * is asked, it looks for a new update at most once per update DIA publishes, shares it between
 * callers, and backs off when DIA does not answer, serving the last update while it is recent.
 *
 * `key` picks which of DIA's signers to read: the one the oracle output trusts.
 */
export function dia(
  { key = DIA_KEY, request = (...a) => fetch(...a) }: { key?: string; request?: typeof fetch } = {},
): PriceFeed {
  let last: PriceUpdate | undefined;
  let fetchedAt = 0;
  let retryAt = 0;
  let failures = 0;
  let pending: Promise<PriceUpdate> | undefined;

  const rpc: Rpc = async (method, params) => {
    const res = await request(DIA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
    });
    if (!res.ok) throw new OracleError(`DIA answered ${res.status}`);
    const { result } = (await res.json()) as { result?: unknown };
    if (result === undefined || result === null) throw new OracleError("DIA returned no price");
    return result;
  };
  const load = async (): Promise<PriceUpdate> => {
    try {
      last = await trustedUpdate(rpc, key);
      fetchedAt = Date.now();
      failures = 0;
      return last;
    } catch (e) {
      const wait = e instanceof OtherSignerError ? FIRST_RETRY_MS : FIRST_RETRY_MS * 2 ** failures++;
      retryAt = Date.now() + Math.min(MAX_RETRY_MS, wait);
      throw e;
    }
  };
  const usable = () => last !== undefined && seconds() - last.time < STALE_AFTER;

  return {
    key: hex.decode(key),
    async latest() {
      const fresh = last !== undefined && Date.now() - fetchedAt < REUSE_MS;
      if (!fresh && Date.now() >= retryAt) {
        pending ??= load().finally(() => {
          pending = undefined;
        });
        try {
          return await pending;
        } catch (e) {
          if (!usable()) throw e;
        }
      }
      if (!last || !usable()) throw new OracleError("DIA has not answered with a recent price");
      return last;
    },
  };
}

/**
 * A price signer of your own, for a local stack and for tests: it signs whatever price it is
 * given, in DIA's format, so it exercises the same oracle contract. An oracle output bound to it
 * is only as honest as whoever holds `secret`.
 */
export function localFeed(secret: Uint8Array, price: () => number): PriceFeed {
  return {
    key: concatBytes(Uint8Array.of(0x10), secp256k1.getPublicKey(secret, true)),
    async latest() {
      const now = seconds();
      const u = {
        raw: BigInt(Math.round(price())) * CENT,
        time: BigInt(now - CLOCK_MARGIN),
        nonce: BigInt(now),
        expiry: BigInt(now + 3600),
      };
      if (u.raw <= 0n) throw new OracleError("no price is set");
      return update(u, secp256k1.sign(digest(u), secret, { prehash: false }));
    },
  };
}
