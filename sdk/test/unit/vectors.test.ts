import { arkade } from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { ARTIFACTS } from "../../src/engine";
import vectors from "../../contracts/testdata/vectors.json";

// The Go contract tests execute scripts assembled by executord's template engine. This checks
// that the SDK assembles byte-identical outputs from the same artifacts, keys and arguments, so
// what those tests prove holds for what the app deploys.
describe("contract derivation", () => {
  const key = (b: number) => schnorr.getPublicKey(new Uint8Array(32).fill(b));
  const keys = { serverKey: key(1), emulatorKey: key(2) };
  const script = (artifact: unknown, args: Record<string, Uint8Array | bigint>) =>
    new arkade.ArkadeProgramScript(
      arkade.programFromArtifact(artifact as arkade.ContractArtifact),
      { ...args, server: keys.serverKey },
      keys,
    ).pkScript;

  const market = {
    oracleTxid: new Uint8Array(32).fill(3), oracleGidx: 0n, renewalWindow: 86400n, maxFee: 1000n,
    exitKey: hex.decode("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"), exitDelay: 4194308n,
  };
  const position = script(ARTIFACTS.position, market);
  const offer = script(ARTIFACTS.offer, { ...market, positionProgram: position.slice(2) });

  it("position", () => expect(hex.encode(position)).toBe(vectors.position));
  it("offer", () => expect(hex.encode(offer)).toBe(vectors.offer));
  it("offer deposit", () => {
    const got = script(ARTIFACTS.offerDeposit, {
      offerProgram: offer.slice(2), lpPk: key(5), lpProgram: key(7), spreadBps: 10n, maxLeverage: 50n,
      maxDuration: 604800n, carryBps: 25n, exitDelay: 4194308n,
    });
    expect(hex.encode(got)).toBe(vectors.offer_deposit);
  });
  it("trade deposit", () => {
    const got = script(ARTIFACTS.tradeDeposit, {
      oracleTxid: market.oracleTxid, oracleGidx: 0n, maxSpreadBps: 10n,
      positionProgram: position.slice(2), traderPk: key(4), traderProgram: key(6), side: 1n, leverage: 10n,
      capBps: 20000n, limitPrice: 5_940_000n, duration: 86400n, deadline: 1_800_000_000n, maxCarryBps: 100n,
      exitDelay: 4194308n,
    });
    expect(hex.encode(got)).toBe(vectors.trade_deposit);
  });
});
