# Arkade futures

A leveraged BTC/USD market with no house and no backend. It is one static page: you get an
address, you pay it from any Arkade wallet, and every later step is a transaction the page
builds and the Arkade emulator checks. `how.html` draws every contract and every transaction.

**Live: https://louisinger.github.io/future/** — mainnet by default, with a switch to Mutinynet
for test coins.

**New and unaudited.** On mainnet it moves real bitcoin: read
[what it does not protect against](docs/DESIGN.md#what-it-does-not-protect-against) first.

Prices are BTC/USD updates signed by [DIA](https://www.diadata.org/docs). The contracts verify
DIA's signature themselves, so the page cannot invent a price.

## Run

```sh
pnpm install
pnpm dev                       # http://localhost:5173
pnpm build                     # static site in dist/, servable from any folder
```

A push to `main` tests, builds and publishes `dist/` to GitHub Pages
(`.github/workflows/pages.yml`).

The page shows your open positions, your liquidity and the trades against it, and a list of
closed trades with how each ended (closed by the trader, liquidated, take-profit, end date), the
price and what you received, whoever settled them and whether or not the page was open.

## Networks

The header switches network; `?net=` in the address does the same.

| | Operator | Emulator | Executor | Price |
|---|---|---|---|---|
| `mainnet` (default) | `arkade.computer` | `emulator.arkade.computer` | `executor.arkade.sh` | DIA |
| `mutinynet` | `mutinynet.arkade.sh` | `emulator.mutinynet.arkade.sh` | `executor.mutinynet.arkade.sh` | DIA |
| `regtest` | `localhost:7070` | `localhost:7073` | `localhost:7080` | a test key, you set the price |

Each network is a separate market with its own key and addresses in the browser.

### The price

The price check is a module of the contracts and the oracle a parameter of the SDK: see
[Choose the oracle](sdk/README.md#choose-the-oracle). The app uses DIA on mainnet and
Mutinynet, chosen in one line of `src/main.ts`.

`sdk/src/oracle.ts` reads DIA's latest signed BTC/USD update from its public RPC,
`https://rpc.diadata.org`, with no account and no key. Each browser asks for itself, at most
once per 20 seconds however many trades are open (DIA publishes about every 25) with one to
four small requests, shares the
answer between everything on the page, and backs off up to two minutes when refused while it
serves the last update the contracts still accept.

DIA has two signers taking turns, about ten seconds apart, and the contracts pin one key,
`0x6f8b…c51c`. The registry's "latest" is whoever published last, so when that is the other
signer the page finds the pinned signer's newest update in the registry's events and reads it by
its hash: every price it uses is that signer's, and under half a minute old. `node
sdk/scripts/dia-signer.mjs` prints who signed the latest update. A market on another key is a new
set of addresses.

### The executor

An [executor](https://github.com/arkade-os/executor) sends a template's transaction when a coin
arrives or a time comes, with no page open. It cannot fetch a price, so it runs the steps that
need none:

| Step | Template | Status |
|---|---|---|
| Publish an offer when its deposit is paid | `register_offer` | works, tested on regtest |
| Refund a trade deposit that missed its deadline | `refund_trade` | works, tested on regtest |
| Renew an offer before its coin expires | `renew_offer` | needs arkd v0.9.27, see below |
| Renew a position before its coin expires | `renew_position` | needs arkd v0.9.27, see below |

Opening, closing, settling and liquidating need a price: a page does those. Cancelling and
withdrawing need the owner's signature at the time: a page does those too.

When the network's executor has a template, the page uses it: it hands the executor each
address it creates, and registers the market's two renewal delegations, which cover every offer
and every position. Without the templates the page does the first two steps itself while it is
open, and nothing renews.

Templates are registered on an executor's admin port, by its operator:

```sh
sdk/scripts/register-templates.sh http://localhost:7081          # publish and refund
sdk/scripts/register-templates.sh http://localhost:7081 renew    # and the two renewals
```

**Renewal does not work on arkd v0.9.26 and earlier**, which mainnet runs today. Offers and
positions have no unilateral exit leaf, and those versions refuse such a coin in a batch
(`INVALID_VTXO_SCRIPT: no exit leaf`); the executor's attempt on regtest (arkd v0.9.13) got
exactly that answer. arkd v0.9.27 accepts them. Register the renewal templates only once the
operator runs it: ten refusals in a row disable a template. Renewal has not been seen working
end to end.

## Layout

The repository is the app and, in `sdk/`, the client it is built on:
[`@louisinger/future-sdk`](sdk/README.md), usable on its own from a browser or Node.

```
index.html, how.html     the two pages
src/main.ts              the trading page
src/how.ts               the reference page
src/explain.ts           failures as sentences
src/qr.ts                QR codes for deposit addresses
sdk/src/                 the client: addresses, market state, every transaction, prices, executor
sdk/contracts/src/       the four contracts, hand-written Arkade Script
sdk/contracts/oracles/   the price checks they can be built with: dia, schnorr
sdk/contracts/artifacts/ the contracts built with each price check, generated
sdk/contracts/           their tests, a Go module that runs each script in the emulator's engine
sdk/contracts/executor-templates/   templates executord can run by itself: register, refund, renew
sdk/scripts/             register the templates on an executor, print DIA's current signer
docs/DESIGN.md           how it works and what it does not protect against
```

## Test

```sh
pnpm test                      # arithmetic, the price client, script parity with the Go tests
pnpm test:e2e                  # full market on a local regtest stack
(cd sdk/contracts && go test ./...)   # every contract function, accepted and refused
```

- `sdk/contracts` needs a sibling checkout of [executor](https://github.com/arkade-os/executor) for
  its template engine (`replace` in `go.mod`). `sdk/contracts/testdata/vectors.json` pins each
  contract's output script; `sdk/test/unit/vectors.test.ts` checks the SDK derives the same bytes,
  so the scripts the Go tests execute are the ones the page deploys. Rewrite it, and the
  template ids in `templates.json`, with `UPDATE_VECTORS=1 go test ./...` after changing a
  contract or a price check, which also regenerates `artifacts/`; a template names its
  contracts by id, printed by the failing test.
- `pnpm test:e2e` expects arkd and the emulator on localhost and a container named `arkd`
  whose CLI wallet it uses as a faucet. executor's `make regtest-up` provides all three. One
  Two scenarios read DIA's live prices, so they need the internet. The executor scenario runs when
  executord answers on `:7080` with the templates registered, and is skipped otherwise.

## Known limits

- DIA's key decides every price. A position that reached its end can be settled on any DIA
  price of the following hour, so whoever settles picks among them.
- Offers and positions have no exit if the operator disappears. Deposits do.
- Coins expire, and until the operator runs arkd v0.9.27 nothing can renew an offer or a
  position: withdraw an offer and settle a position before their coins expire. The other side's
  coin can also shorten yours.
- A trade opens or settles when someone's page is open, yours or anyone's: an executor cannot
  fetch a price.
- Nothing has been traded on mainnet. The mainnet emulator runs an older version than the one
  the tests ran against; it has every opcode the contracts use, by reading its source.
