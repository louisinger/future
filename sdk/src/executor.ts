// The network's executor: a daemon that sends a template's transaction when a coin arrives, so an
// offer goes live and a late deposit is refunded with no page open. The page works without it:
// every transaction an executor would send, the page sends too.

import { type Delegation, TEMPLATES } from "./engine.js";

export class Executor {
  private constructor(
    private readonly url: string,
    private readonly templates: Set<string>,
  ) {}

  /**
   * Connects to the executor at `url` when it serves the operator and the emulator of `keys`
   * (`Engine.keys`), and learns which of the market's templates it has registered. Resolves to
   * undefined when it is unreachable or serves another network.
   */
  static async connect(
    url: string,
    keys: { server: string; emulator: string },
    templates: string[] = Object.values(TEMPLATES),
  ): Promise<Executor | undefined> {
    try {
      const info = (await (await fetch(`${url}/v1/info`)).json()) as Record<string, string | undefined>;
      const xonly = (key = "") => key.slice(-64);
      if (xonly(info.serverPubkey) !== keys.server || xonly(info.emulatorPubkey) !== keys.emulator) return undefined;
      const known = await Promise.all(
        templates.map(async (id) => ((await fetch(`${url}/v1/template/${id}`)).ok ? id : "")),
      );
      return new Executor(url, new Set(known.filter(Boolean)));
    } catch {
      return undefined;
    }
  }

  /** Whether the executor has a template registered. */
  runs(template: string): boolean {
    return this.templates.has(template);
  }

  /** Asks the executor to run a delegation's template. Resolves to whether it took it. */
  async delegate(d: Delegation): Promise<boolean> {
    if (!this.templates.has(d.template)) return false;
    try {
      const res = await fetch(`${this.url}/v1/delegation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: d.template, variables: d.variables }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
