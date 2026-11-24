import type { OracleParams } from "@louisinger/dia-oracle";
import deployed from "./oracles.json";

// The oracle of each network, as `oracle/scripts/deploy.mjs` printed it.
const oracles: Record<string, OracleParams | undefined> = deployed;

/** Where a network's operator, emulator and executor answer, and the oracle its market reads. */
export interface Network {
  arkUrl: string;
  emulatorUrl: string;
  executorUrl: string;
  /** Absent while no oracle output is deployed on the network. */
  oracle?: OracleParams;
}

export const NETWORKS: Record<"mainnet" | "mutinynet" | "regtest", Network> = {
  mainnet: {
    arkUrl: "https://arkade.computer",
    emulatorUrl: "https://emulator.arkade.computer",
    executorUrl: "https://executor.arkade.sh",
    oracle: oracles.mainnet,
  },
  mutinynet: {
    arkUrl: "https://mutinynet.arkade.sh",
    emulatorUrl: "https://emulator.mutinynet.arkade.sh",
    executorUrl: "https://executor.mutinynet.arkade.sh",
    oracle: oracles.mutinynet,
  },
  regtest: {
    arkUrl: "http://localhost:7070",
    emulatorUrl: "http://localhost:7073",
    executorUrl: "http://localhost:7080",
  },
};
