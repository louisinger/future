// Compiles an Arkade Language contract of contracts/ and adapts it to the operator as it runs
// today.
//
// arkadec 0.1.0 writes each covenant leaf for one operator key, <OPERATOR_KEY:fn>. Today the
// operator signs with two: arkd's key, and the emulator's key tweaked by the function's script.
// @arkade-os/sdk 0.5.13 and the emulator only know that form, so the leaves are rewritten to it,
// and <OPERATOR_EXIT_DELAY> becomes a constructor argument the caller binds to the operator's
// exit delay. Nothing else of the compiler's output changes the scripts.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@arkade-os/compiler";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts");

function sources(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".ark")
        ? [[relative(root, join(dir, e.name)), readFileSync(join(dir, e.name), "utf8")]]
        : [],
  );
}

// executord reads a decimal token up to 2^53 - 1. A larger one is written as the push of the
// same bytes, so the script does not change.
function push(token) {
  if (!/^\d+$/.test(token) || BigInt(token) <= BigInt(Number.MAX_SAFE_INTEGER)) return token;
  const bytes = [];
  for (let v = BigInt(token); v > 0n; v >>= 8n) bytes.push(Number(v & 0xffn));
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const injected = (name) => ({ name, type: "signature", encoding: "schnorr-64", injected: true });

export function forTwoKeyOperator(artifact) {
  const out = structuredClone(artifact);
  // the compile time is not part of the contract, and executord refuses codeHash, which it does
  // not know yet
  delete out.updatedAt;
  delete out.codeHash;
  let exits = false;
  for (const fn of out.functions) {
    if (fn.arkade) fn.arkade.asm = fn.arkade.asm.map(push);
    for (const leaf of fn.leaves) {
      const key = leaf.asm.length === 2 && leaf.asm[1] === "OP_CHECKSIG" && /^<OPERATOR_KEY:(.+)>$/.exec(leaf.asm[0]);
      if (key) {
        leaf.asm = ["<SERVER_KEY>", "OP_CHECKSIGVERIFY", `<EMULATOR_KEY:${key[1]}>`, "OP_CHECKSIG"];
        leaf.witness = [injected("serverSig"), injected("emulatorSig")];
      }
      if (leaf.asm.some((t) => t.includes("OPERATOR_KEY"))) {
        throw new Error(`leaf ${leaf.name}: an operator key in a place this adapter does not know`);
      }
      exits ||= leaf.asm.includes("<OPERATOR_EXIT_DELAY>");
      leaf.asm = leaf.asm.map((t) => (t === "<OPERATOR_EXIT_DELAY>" ? "<operatorExitDelay>" : t));
    }
  }
  if (exits) out.constructorInputs.push({ name: "operatorExitDelay", type: "int" });
  return out;
}

/** The artifact of contracts/<entry>, for the operator as it runs today. */
export async function compileContract(entry) {
  const { artifact, diagnostics } = await compile({ entry, files: Object.fromEntries(sources()) });
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (!artifact) throw new Error(errors.map((d) => `${d.file}:${d.start?.line} ${d.message}`).join("\n"));
  return forTwoKeyOperator(artifact);
}
