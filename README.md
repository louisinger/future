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

| | Operator | Emulator | Executor | Oracle |
|---|---|---|---|---|
| `mainnet` (default) | `arkade.computer` | `emulator.arkade.computer` | `executor.arkade.sh` | not deployed yet |
| `mutinynet` | `mutinynet.arkade.sh` | `emulator.mutinynet.arkade.sh` | `executor.mutinynet.arkade.sh` | not deployed yet |
| `regtest` | `localhost:7070` | `localhost:7073` | `localhost:7080` | one you deploy, on a test key |

Each network is a separate market with its own key and addresses in the browser.

### The price

Prices are BTC/USD updates signed by [DIA](https://www.diadata.org/docs). The market does not
check DIA's signature itself: it reads the price from an oracle output within Arkade, a
separate contract in [`oracle/`](oracle/README.md) that any app can use. A transaction that
needs a price spends one of the oracle's coins along with its own; the oracle checks the
signature and is put straight back.

The market recognises the oracle by its identity asset, so DIA's key can change without
touching an open trade. The oracle has several interchangeable coins, so that people trading at
the same moment do not wait on each other, and an executor renews them.

A network trades once an oracle is deployed on it and its parameters are in
`sdk/src/networks.ts`:

```sh
pnpm -C oracle build
node oracle/scripts/deploy.mjs --ark <operator> --emulator <emulator> --admin <x-only key>
```

On regtest, add `--signer test:arkade-futures-demo-oracle --explorer http://localhost:3000
--out public/oracle.regtest.json`: the page reads that file and signs the prices you set.

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
| Renew the oracle's coins before they expire | `renew_oracle`, in `oracle/` | works, tested on regtest |

Opening, closing, settling and liquidating need a price: a page does those. Cancelling and
withdrawing need the owner's signature at the time: a page does those too.

When the network's executor has a template, the page uses it: it hands the executor each
address it creates, and registers the market's renewal delegations, which cover every offer,
every position and the oracle's coins. Without the templates the page does the first two steps itself while it is
open, and nothing renews.

Templates are registered on an executor's admin port, by its operator:

```sh
sdk/scripts/register-templates.sh http://localhost:7081          # publish and refund
sdk/scripts/register-templates.sh http://localhost:7081 renew    # and the two renewals
oracle/scripts/register-templates.sh http://localhost:7081       # the oracle's renewal
```

**Renewal does not work on arkd v0.9.26 and earlier**, which mainnet runs today. Offers and
positions have no unilateral exit leaf, and those versions refuse such a coin in a batch
(`INVALID_VTXO_SCRIPT: no exit leaf`); the executor's attempt on regtest (arkd v0.9.13) got
exactly that answer. arkd v0.9.27 accepts them. Register the renewal templates only once the
operator runs it: ten refusals in a row disable a template. Renewal has not been seen working
end to end.

## Layout

The repository is the app and two packages usable on their own from a browser or Node:
[`@louisinger/future-sdk`](sdk/README.md), the market's client, and
[`@louisinger/dia-oracle`](oracle/README.md), the price oracle any Arkade app can read.

```
index.html, how.html     the two pages
src/main.ts              the trading page
src/how.ts               the reference page
src/explain.ts           failures as sentences
src/qr.ts                QR codes for deposit addresses
oracle/                  the price oracle: its contract, DIA client, deploy and renewal
sdk/src/                 the client: addresses, market state, every transaction, executor
sdk/contracts/artifacts/ the four contracts, hand-written Arkade Script
sdk/contracts/           their tests, a Go module that runs each script in the emulator's engine
sdk/contracts/executor-templates/   templates executord can run by itself: register, refund, renew
sdk/scripts/             register the templates on an executor
docs/DESIGN.md           how it works and what it does not protect against
```

## Test

```sh
pnpm test                      # the oracle package, arithmetic, script parity with the Go tests
pnpm test:e2e                  # full market on a local regtest stack
(cd sdk/contracts && go test ./...)   # every contract function, accepted and refused
```

- `sdk/contracts` needs a sibling checkout of [executor](https://github.com/arkade-os/executor) for
  its template engine (`replace` in `go.mod`). `sdk/contracts/testdata/vectors.json` pins each
  contract's output script; `sdk/test/unit/vectors.test.ts` checks the SDK derives the same bytes,
  so the scripts the Go tests execute are the ones the page deploys. Rewrite it, and the
  template ids in `templates.json`, with `UPDATE_VECTORS=1 go test ./...` after changing a
  contract; a template names its contracts by id, printed by the failing test.
- `pnpm test:e2e` expects arkd and the emulator on localhost and a container named `arkd`
  whose CLI wallet it uses as a faucet. executor's `make regtest-up` provides all three. One
  Two scenarios read DIA's live prices, so they need the internet. The executor scenario runs when
  executord answers on `:7080` with the templates registered, and is skipped otherwise.

## Known limits

- DIA's key decides every price, and the oracle's admin key can replace the oracle's rules. A position that reached its end can be settled on any DIA
  price of the following hour, so whoever settles picks among them.
- Offers and positions have no exit if the operator disappears. Deposits do.
- Coins expire, and until the operator runs arkd v0.9.27 nothing can renew an offer or a
  position: withdraw an offer and settle a position before their coins expire. The other side's
  coin can also shorten yours.
- A trade opens or settles when someone's page is open, yours or anyone's: an executor cannot
  fetch a price.
- Nothing has been traded on mainnet. The mainnet emulator runs an older version than the one
  the tests ran against; it has every opcode the contracts use, by reading its source.
