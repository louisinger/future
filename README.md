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
| `mainnet` (default) | `arkade.computer` | `emulator.arkade.computer` | `executor.arkade.sh` | deployed, below |
| `mutinynet` | `mutinynet.arkade.sh` | `emulator.mutinynet.arkade.sh` | `executor.mutinynet.arkade.sh` | deployed, below |
| `regtest` | `localhost:7070` | `localhost:7073` | `localhost:7080` | one you deploy, on a test key |

Each network is a separate market with its own key and addresses in the browser.

The oracles the market reads, each of three coins that the network's executor renews:

| | Oracle address | Identity asset |
|---|---|---|
| `mainnet` | `ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamee94p76chjnhgaarg42rsr2h90shqr90y8dj53r9fed68npzn8zjmahlwa6` | `75bdeeaff59a25d46e4034a1aa245f8294514b2475403f330030843b775971260000` |
| `mutinynet` | `tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf850g9aeygjfjg953gpkfcjezkha2s0fjw94pptpxrjnr9lt9d48gvxwtcz4` | `30195f37f8c1697ac90d922cd44b60108cfc2d2781ecc71254742ec95fb7a7380000` |

Both trust DIA's signer `0x10e34723aA722C7A9860f5eC6446f22252dB168a`. Their full parameters,
for other apps, are in [`oracle/README.md`](oracle/README.md#deployed-oracles).

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
`sdk/src/oracles.json` ([docs/DEPLOY.md](docs/DEPLOY.md) has every command):

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
| Renew an offer before its coin expires | `renew_offer` | works, tested on regtest |
| Renew a position before its coin expires | `renew_position` | works, tested on regtest |
| Renew the oracle's coins before they expire | `renew_oracle`, in `oracle/` | works, tested on regtest |

Opening, closing, settling and liquidating need a price: a page does those. Cancelling and
withdrawing need the owner's signature at the time: a page does those too.

When the network's executor has a template, the page uses it: it hands the executor each
address it creates, and registers the market's renewal delegations, which cover every offer,
every position and the oracle's coins. Without the templates the page does the first two steps itself while it is
open, and nothing renews.

Templates are registered on an executor's admin port, or on its public port when it runs with
`EXECUTOR_PUBLIC_REGISTRY=true`:

```sh
sdk/scripts/register-templates.sh http://localhost:7081 renew    # publish, refund, renewals
```

The oracle's own renewal needs no separate step: deploying it with `--executor` gives the
executor its contract and template and registers the renewal.

Renewing means joining a batch, and arkd up to v0.9.26 only takes a coin into a batch if its
script has an exit leaf. Offers and positions are shared addresses and cannot name an owner's
key, so their exit leaf names the key of BIP 341 that nobody can sign for: it satisfies arkd and
gives nobody a way out. The executor renewed an offer, a position and an oracle coin in one
batch on regtest, on arkd v0.9.13.

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
- Coins expire. An executor that has the templates renews offers, positions and the oracle's
  coins; without one, withdraw an offer and settle a position before their coins expire. The
  other side's coin can also shorten yours.
- A trade opens or settles when someone's page is open, yours or anyone's: an executor cannot
  fetch a price.
- Nothing has been traded on mainnet. The mainnet emulator runs an older version than the one
  the tests ran against; it has every opcode the contracts use, by reading its source.
