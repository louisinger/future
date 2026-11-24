# Arkade futures

A leveraged BTC/USD market with no house and no backend. It is one static page: you get an
address, you pay it from any Arkade wallet, and every later step is a transaction the page
builds and the Arkade emulator checks. `how.html` draws every contract and every transaction.

**Live: https://louisinger.github.io/future/** — Mutinynet by default, with a switch to mainnet.

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

## Networks

The header switches network; `?net=` in the address does the same.

| | Operator | Emulator | Executor | Price |
|---|---|---|---|---|
| `mainnet` | `arkade.computer` | `emulator.arkade.computer` | `executor.arkade.sh` | DIA |
| `mutinynet` (default) | `mutinynet.arkade.sh` | `emulator.mutinynet.arkade.sh` | `executor.mutinynet.arkade.sh` | DIA |
| `regtest` | `localhost:7070` | `localhost:7073` | `localhost:7080` | a test key, you set the price |

Each network is a separate market with its own key and addresses in the browser.

### The price

`src/oracle.ts` reads DIA's latest signed BTC/USD update from its public RPC,
`https://rpc.diadata.org`, with no account and no key. Each browser asks for itself, at most
once per 20 seconds however many trades are open (DIA publishes about every 25), shares the
answer between everything on the page, and backs off up to two minutes when refused while it
serves the last update the contracts still accept. The contracts pin DIA's signing key: if DIA
rotates it, `node scripts/dia-signer.mjs` prints the new one, and a market on the new key is a
new set of addresses.

### The executor

An [executor](https://github.com/arkade-os/executor) sends a template's transaction when a coin
arrives. When the network's executor has this market's templates, the page hands it every
address it creates: an offer then goes live, and a deposit that missed its deadline is refunded,
with no page open. Without them the page does both itself while it is open.

Templates are registered on an executor's admin port, by its operator:

```sh
scripts/register-templates.sh http://localhost:7081
```

## Layout

```
index.html, how.html     the two pages
src/payoff.ts            the market's arithmetic: payoff, fee, levels, matching, state validation
src/engine.ts            the client: addresses, market state, every transaction, on @arkade-os/sdk
src/oracle.ts            signed prices: DIA's, and a test signer for a local stack
src/executor.ts          hands addresses to the network's executor
src/main.ts              the trading page
src/how.ts               the reference page
src/qr.ts                QR codes for deposit addresses
contracts/artifacts/     the four contracts, hand-written Arkade Script
contracts/               their tests, a Go module that runs each script in the emulator's engine
contracts/executor-templates/   templates executord can run by itself: register, refund, renew
scripts/                 register the templates on an executor, print DIA's current signer
docs/DESIGN.md           how it works and what it does not protect against
```

## Test

```sh
pnpm test                      # arithmetic, the price client, script parity with the Go tests
pnpm test:e2e                  # full market on a local regtest stack
(cd contracts && go test ./...)   # every contract function, accepted and refused
```

- `contracts` needs a sibling checkout of [executor](https://github.com/arkade-os/executor) for
  its template engine (`replace` in `go.mod`). `contracts/testdata/vectors.json` pins each
  contract's output script; `test/unit/vectors.test.ts` checks the SDK derives the same bytes,
  so the scripts the Go tests execute are the ones the page deploys. Rewrite it, and the
  template ids in `templates.json`, with `UPDATE_VECTORS=1 go test ./...` after changing a
  contract; a template names its contracts by id, printed by the failing test.
- `pnpm test:e2e` expects arkd and the emulator on localhost and a container named `arkd`
  whose CLI wallet it uses as a faucet. executor's `make regtest-up` provides all three. One
  scenario trades on DIA's live price, so it needs the internet. The executor scenario runs when
  executord answers on `:7080` with the templates registered, and is skipped otherwise.

## Known limits

- DIA's key decides every price. A position that reached its end can be settled on any DIA
  price of the following hour, so whoever settles picks among them.
- Offers and positions have no exit if the operator disappears. Deposits do.
- Coins expire. Renewal is in the contracts and in an executord template, but nothing runs it
  here, and the other side's coin can shorten yours.
- A trade opens or settles when someone's page is open, yours or anyone's: an executor cannot
  fetch a price.
- Nothing has been traded on mainnet. The mainnet emulator runs an older version than the one
  the tests ran against; it has every opcode the contracts use, by reading its source.
