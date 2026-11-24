# @louisinger/future-sdk

The client of [Arkade futures](https://github.com/louisinger/future): a leveraged BTC/USD market
made of four Arkade Script contracts, with no backend. It derives the market's addresses, reads
its state from the Arkade indexer, builds every transaction, and fetches the prices the contracts
settle on. It runs in a browser and in Node 20 or later, and never holds funds: money moves when
someone pays an address, and only where the contracts allow.

**New and unaudited.** On mainnet it moves real bitcoin. Read
[what the contracts do not protect against](../docs/DESIGN.md#what-it-does-not-protect-against).

It is not on npm yet. Build it here and install the tarball:

```sh
pnpm -C sdk pack          # builds, then writes louisinger-future-sdk-0.1.0.tgz
npm install ./louisinger-future-sdk-0.1.0.tgz
```

## Read the market

```ts
import { Engine, NETWORKS } from "@louisinger/future-sdk";

const market = await Engine.connect({ ...NETWORKS.mainnet, oracle });
const [offers, positions, price] = await Promise.all([
  market.offers(),
  market.positions(),
  market.latest(),
]);
```

`NETWORKS` has `mainnet`, `mutinynet` and `regtest`. Amounts are sats, prices USD cents, times
unix seconds.

## The oracle

The market's contracts read prices from an oracle output:
[`@louisinger/dia-oracle`](../oracle/README.md), which checks DIA's signature. `oracle` is the
parameters its operator publishes, `{ assetId, oraclePk, adminPk }`; `NETWORKS.<name>.oracle`
holds them once one is deployed on that network.

The oracle's identity asset is part of every address of the market, so another oracle is
another market. DIA's key is not: the oracle's admin can rotate it without touching an open
trade. Every transaction that needs a price spends one of the oracle's outputs with it; the SDK
picks one, and moves to another when someone else just took it.

For a local stack, deploy an oracle bound to a key of your own and pass its feed:

```ts
import { connect, deploy, localFeed } from "@louisinger/dia-oracle";

const feed = localFeed(secret, () => cents);
const oracle = await deploy(wallet, await connect({ arkUrl, emulatorUrl }), feed, { adminPk });
const market = await Engine.connect({ arkUrl, emulatorUrl, oracle, feed });
```

## Offer liquidity

A provider needs a key, which later withdraws the offer, and a payout program: the 32-byte
taproot program of an Arkade address.

```ts
import { newAccount } from "@louisinger/future-sdk";

const provider = newAccount();                       // keep provider.key
const terms = {
  lpPk: provider.pub,
  lpProgram: market.program("ark1…"),                // where payouts and withdrawals go
  spreadBps: 10,                                     // 0.10% on the entry price
  carryBps: 5,                                       // 0.05% of a position's size per day
  maxLeverage: 50,
  maxDuration: 86_400,
};
const { address } = market.offerDeposit(terms);      // pay this from any Arkade wallet
await market.register(terms);                        // once paid: the coin becomes an offer
// later, with the same key
const [mine] = (await market.offers()).filter((o) => o.lpPk === provider.pub.slice(2));
await market.withdraw(mine, provider.key);
```

## Trade

```ts
const trader = newAccount();
const { price } = await market.latest();
const terms = {
  traderPk: trader.pub,
  traderProgram: market.program("ark1…"),
  side: 0,                                           // 0 long, 1 short
  leverage: 10,
  capBps: 20_000,                                    // take profit at +200% of the margin
  limitPrice: Math.ceil(price * 1.01),               // worst entry accepted
  duration: 3_600,                                   // closes itself after an hour
  deadline: Math.floor(Date.now() / 1000) + 3_600,   // the address accepts payments until then
  maxCarryBps: 10,                                   // highest holding fee accepted
  maxSpreadBps: 15,                                  // highest spread accepted
};
const preview = await market.quote(terms, 10_000, price);   // what 10,000 sats would open
const { address } = market.tradeDeposit(terms);             // pay the margin here
const opened = await market.fill(terms);                    // once paid: opens the position
const [position] = (await market.positions()).filter((p) => p.traderPk === trader.pub.slice(2));
await market.close(position, trader.key);                   // at DIA's latest price
// or, before it opened: await market.cancel(terms, trader.key)
```

The terms are the address: keep them to act on a deposit later. `fill` throws `NoCoinError`
until the payment is visible and `NoOfferError` when no offer fits.

## Keep a market running

Nothing runs by itself. Someone has to submit the transactions the contracts allow, and anyone
can: none of these needs a key.

```ts
import { resolvable } from "@louisinger/future-sdk";

const quote = await market.latest();
for (const p of await market.positions()) {
  // past its end, or one side out of margin
  if (resolvable(p, quote.price, quote.time)) await market.resolve(p);
}
```

`payouts`, `levels`, `fee` and `houseShare` are the contracts' arithmetic, for showing what a
position is worth before it settles.

## See what settled

A settled position stays readable: who was in it, the price it settled on, how it ended and
what each side received. This is how a provider learns that a trade against their offer closed
while they were away.

```ts
for (const s of await market.settlements()) {
  // s.ending: "closed" by the trader, "liquidated", "take-profit" or "ended" at its end date
  console.log(s.side ? "short" : "long", s.entryPrice, "→", s.price, s.ending, s.trader, s.provider);
}
```

Pass `settlements((outpoint) => seen.has(outpoint))` to skip the ones already read.

## Executor

An [executor](https://github.com/arkade-os/executor) that has the market's templates acts with
no client running: it publishes an offer when its deposit is paid, refunds a trade deposit that
missed its deadline, and renews offers, positions and the oracle's outputs before their coins
expire. It cannot open
or settle a trade, which need a price, nor cancel or withdraw, which need the owner's signature.

```ts
import { Executor } from "@louisinger/future-sdk";

const executor = await Executor.connect(NETWORKS.mainnet.executorUrl, market.keys);
await executor?.delegate(market.offerDelegation(offerTerms));     // per offer deposit address
await executor?.delegate(market.refundDelegation(tradeTerms));    // per trade deposit address
for (const renewal of market.renewalDelegations()) {              // once per market
  await executor?.delegate(renewal);
}
```

`delegate` resolves to false when the executor does not have the template; registering the same
delegation twice changes nothing. `scripts/register-templates.sh <admin url> [renew]` registers
the templates on an executor. Renewal needs an operator on arkd v0.9.27 or later: see the
repository's README.

## What is in the package

```
src/engine.ts       Engine: addresses, market state, every transaction
src/payoff.ts       the market's arithmetic, offer matching, state validation
src/executor.ts     Executor: delegations
src/networks.ts     NETWORKS
contracts/artifacts/   the four contracts, hand-written Arkade Script
contracts/          their Go tests, the executor templates
```

The artifacts and executor templates are also exported as files:
`@louisinger/future-sdk/artifacts/position.json`, `…/templates/register_offer.json`.

## Test

```sh
pnpm test                          # arithmetic, script parity with the Go tests
pnpm test:e2e                      # a full market on a local regtest stack
(cd contracts && go test ./...)    # every contract function, accepted and refused
```

See the repository's README for what each suite needs.
