import { NoOracleOutputError, OracleError } from "@louisinger/dia-oracle";
import { NoCoinError } from "@louisinger/future-sdk";

/** Turns the failure of an action into a sentence for the person who asked for it. */
export function explain(action: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const has = (...parts: string[]) => parts.some((p) => message.includes(p));
  if (err instanceof NoCoinError) return "Nothing has arrived at this address yet.";
  if (has("signature verification failed")) return "This key is not allowed to do that.";
  if (has("ALREADY_SPENT", "already spent", "double spend")) {
    return "That coin was just used by another transaction. Refreshing.";
  }
  if (has("failed to execute arkade script")) {
    if (action === "fill") return "The trade could not open: the price or the offer changed. Trying again.";
    if (action === "resolve") return "This position cannot be settled at this price.";
    if (action === "close") return "The close was refused. Refresh the price and try again.";
    return "The contract refused this transaction.";
  }
  if (err instanceof NoOracleOutputError) return "The price oracle is busy or not live. Trying again shortly.";
  if (err instanceof OracleError) return `No signed price right now: ${message}. Trying again shortly.`;
  if (has("Failed to fetch", "fetch failed", "ECONNREFUSED", "NetworkError")) {
    return "Cannot reach the Arkade operator. Check your connection.";
  }
  return `${message.charAt(0).toUpperCase()}${message.slice(1)}.`;
}
