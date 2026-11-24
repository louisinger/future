// Signed BTC/USD prices, in the form the contracts verify: a DIA OracleUpdate, an EIP-712 message
// signed with an Ethereum key and published on DIA's Lasernet. https://www.diadata.org/docs

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";

const DIA_RPC = "https://rpc.diadata.org/";
const DIA_REGISTRY = "5612599cf48032d7428399d5fcb99edcc75c06a7";
const DIA_CHAIN = 1050n;
/**
 * DIA's price signer, 0x6f8b0911b1c77de54e113e326ed4bac69da5c51c, as the scripts take a key:
 * 0x10 marks an ECDSA key. `scripts/dia-signer.mjs` prints the one currently publishing.
 */
export const DIA_KEY = "1002b79a8537202478fb5285c4b580d32160471c2671ad8cc0711f9dd8c88f962277";
export const DIA_EXPLORER = `https://explorer.diadata.org/address/0x${DIA_REGISTRY}`;

// DIA publishes about every 25 seconds: asking more often than this returns the same update.
const REUSE_MS = 20_000;
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 120_000;
// The contracts open and close on a price at most 120 seconds old.
const STALE_AFTER = 90;
// The emulator refuses a price dated ahead of its clock.
const CLOCK_MARGIN = 5;
// DIA prices have 18 decimals, the contracts count in cents.
const CENT = 10n ** 16n;

export interface PriceUpdate {
  /** USD cents for one bitcoin, rounded half up as the contracts round it. */
  price: number;
  /** When the price was taken, unix seconds. */
  time: number;
  /** What a contract's price check takes: the signed price, nonce, expiry and signature. */
  witness: Uint8Array[];
}

export interface Oracle {
  /** The key the contracts check prices against. */
  readonly key: Uint8Array;
  latest(): Promise<PriceUpdate>;
}

export class OracleError extends Error {}

/** DIA has several signers taking turns; a market's contracts take the prices of one. */
export class OtherSignerError extends OracleError {
  constructor() {
    super("DIA's latest price is from a signer this market does not use, the next one is seconds away");
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
    witness: [scriptNum(u.raw), scriptNum(u.nonce), scriptNum(u.expiry), signature],
  };
}

/** A non-negative integer as the minimal number a script reads. */
export function scriptNum(n: bigint): Uint8Array {
  const out: number[] = [];
  for (let v = n; v > 0n; v >>= 8n) out.push(Number(v & 0xffn));
  if (out.length && out[out.length - 1] & 0x80) out.push(0);
  return Uint8Array.from(out);
}

/**
 * Reads what the registry's `getLatestIntentByType` returned and checks it is signed by the key
 * the contracts trust, so a transaction is never built on an update they would refuse.
 */
export function decodeDia(result: string): PriceUpdate {
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
  const key = hex.decode(DIA_KEY).subarray(1);
  if (signature.length !== 64 || !secp256k1.verify(signature, digest(u), key, { prehash: false, lowS: false })) {
    throw new OtherSignerError();
  }
  return update(u, signature);
}

const abiString = (s: string) => {
  const b = utf8(s);
  return hex.encode(word(BigInt(b.length))) + hex.encode(b).padEnd(Math.ceil(b.length / 32) * 64, "0");
};
const LATEST_UPDATE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "eth_call",
  params: [
    {
      to: `0x${DIA_REGISTRY}`,
      data:
        `0x${hex.encode(name("getLatestIntentByType(string,string)")).slice(0, 8)}` +
        hex.encode(word(64n)) +
        hex.encode(word(128n)) +
        abiString("OracleUpdate") +
        abiString("BTC/USD"),
    },
    "latest",
  ],
});

/**
 * DIA's live BTC/USD price, read from its public RPC with no key and no account. However often it
 * is asked, it sends one request per update DIA publishes, shares it between callers, and backs
 * off when DIA does not answer, serving the last update for as long as the contracts take it.
 * The registry only tells its latest update: when that one is another signer's, it asks again
 * a few seconds later.
 */
export function dia(request: typeof fetch = (...a) => fetch(...a)): Oracle {
  let last: PriceUpdate | undefined;
  let fetchedAt = 0;
  let retryAt = 0;
  let failures = 0;
  let pending: Promise<PriceUpdate> | undefined;

  const load = async (): Promise<PriceUpdate> => {
    try {
      const res = await request(DIA_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: LATEST_UPDATE,
        cache: "no-store",
      });
      if (!res.ok) throw new OracleError(`DIA answered ${res.status}`);
      const { result } = (await res.json()) as { result?: string };
      last = decodeDia(result ?? "");
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
    key: hex.decode(DIA_KEY),
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
 * given, in DIA's format. A market built on it is only as honest as whoever holds `secret`.
 */
export function localOracle(secret: Uint8Array, price: () => number): Oracle {
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
