/** Where a network's operator, emulator and executor answer. */
export interface Network {
  arkUrl: string;
  emulatorUrl: string;
  executorUrl: string;
}

export const NETWORKS = {
  mainnet: {
    arkUrl: "https://arkade.computer",
    emulatorUrl: "https://emulator.arkade.computer",
    executorUrl: "https://executor.arkade.sh",
  },
  mutinynet: {
    arkUrl: "https://mutinynet.arkade.sh",
    emulatorUrl: "https://emulator.mutinynet.arkade.sh",
    executorUrl: "https://executor.mutinynet.arkade.sh",
  },
  regtest: {
    arkUrl: "http://localhost:7070",
    emulatorUrl: "http://localhost:7073",
    executorUrl: "http://localhost:7080",
  },
} satisfies Record<string, Network>;
