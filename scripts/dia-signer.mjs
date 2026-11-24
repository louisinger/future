// Fetches the latest signed BTC/USD update from DIA and prints it with the key that signed it.
// Run it to learn the key to pin in src/dia.ts when DIA's signer changes:
//   node scripts/dia-signer.mjs
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const RPC = "https://rpc.diadata.org/";
const REGISTRY = "0x5612599CF48032d7428399d5Fcb99eDcc75c06A7";
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const utf8 = (s) => new TextEncoder().encode(s);
const word = (n) => bytes(BigInt(n).toString(16).padStart(64, "0"));
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const abiString = (s) => {
  const b = utf8(s);
  return hex(word(b.length)) + hex(b).padEnd(Math.ceil(b.length / 32) * 64, "0");
};

const selector = hex(keccak_256(utf8("getLatestIntentByType(string,string)"))).slice(0, 8);
const a = abiString("OracleUpdate");
const data = `0x${selector}${hex(word(64))}${hex(word(64 + a.length / 2))}${a}${abiString("BTC/USD")}`;
const res = await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: REGISTRY, data }, "latest"] }),
});
const limits = [...res.headers].filter(([k]) => /rate|retry|limit/i.test(k));
const result = (await res.json()).result;
const out = bytes(result.slice(2));
const at = (i) => out.slice(32 + i * 32, 64 + i * 32);
const num = (i) => BigInt(`0x${hex(at(i))}`);
const sigAt = 32 + Number(num(9));
const sig = out.slice(sigAt + 32, sigAt + 32 + 65);
const update = { chainId: num(2), nonce: num(3), expiry: num(4), price: num(6), time: num(7), signer: `0x${hex(at(10).slice(12))}` };

const typeHash = keccak_256(utf8("OracleIntent(string intentType,string version,uint256 chainId,uint256 nonce,uint256 expiry,string symbol,uint256 price,uint256 timestamp,string source)"));
const domainType = keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"));
const domain = keccak_256(cat(domainType, keccak_256(utf8("DIA Oracle")), keccak_256(utf8("1.0")), word(1050), word(BigInt(REGISTRY)), word(0)));
const body = cat(
  typeHash, keccak_256(utf8("OracleUpdate")), keccak_256(utf8("1.0")), word(update.chainId), word(update.nonce),
  word(update.expiry), keccak_256(utf8("BTC/USD")), word(update.price), word(update.time), keccak_256(utf8("DIA Oracle")),
);
const digest = keccak_256(cat(Uint8Array.of(0x19, 0x01), domain, keccak_256(body)));
const recovered = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(sig[64] - 27).recoverPublicKey(digest);
const address = `0x${hex(keccak_256(recovered.toBytes(false).slice(1)).slice(12))}`;

console.log(JSON.stringify({
  status: res.status, rateLimitHeaders: limits, domain: hex(domain), typeHash: hex(typeHash),
  update: Object.fromEntries(Object.entries(update).map(([k, v]) => [k, String(v)])),
  signature: hex(sig), digest: hex(digest), recoveredAddress: address, signerMatches: address === update.signer,
  pinThis: `10${hex(recovered.toBytes(true))}`, result, ageSeconds: Math.floor(Date.now() / 1000) - Number(update.time),
}, null, 2));
