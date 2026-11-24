# @louisinger/dia-oracle

DIA's BTC/USD price as an oracle output within Arkade, for any contract that needs a price: the
oracle contract, and a client to deploy it, find it and read a price in a transaction.

**New and unaudited.** A contract that reads this oracle trusts DIA's signing key and the
oracle's admin key.

## How it works

The oracle is a coin with rules. It can be spent by anyone who hands it a genuine, recent DIA
price, and only if it is put straight back at the same address. It stores no price: it checks
the one it is shown and writes it in a note on the transaction.

A contract that needs a price is spent together with the oracle:

```
inputs:   0  the consumer's coin        outputs:  0  the oracle, continued
          1  an oracle output                     1… the consumer's outputs
packet 34: 0x01 | price in USD cents, 8 bytes | time, 8 bytes
```

The consumer does not check DIA's signature. It checks that input 1 holds one unit of the
oracle's identity asset, then reads packet 34. So it names an asset, never a key or an address:
DIA's key can be rotated, or the oracle's rules replaced, without touching a consumer.

- **Several outputs.** The identity asset has as many units as the oracle has outputs, each in
  an output of its own. A consumer takes any of them, so transactions of different users do not
  wait on each other. The client picks one at random and moves to another when one was just
  taken.
- **Renewal.** `renew` lets anyone take an output into a batch within a day of its expiry, with
  no key: an executor does it. A new coin expires with the earliest coin spent with it, so a
  consumer's coin can shorten an output's life; renewal is what restores it.
- **Admin.** `migrate` moves an output to another script on the admin key's signature, to
  rotate DIA's key. `unilateral` is the admin's on-chain exit if the operator stops.

The contract is `contracts/dia_btc_usd_oracle.ark`, the one of the
[Arkade docs](https://docs.arkadeos.com/oracles/dia-btc-usd-live.md) with `renew` added. A
consumer reads it with `DiaBtcUsdCents.readPrice(oracleId)` from `dia_btc_usd_cents.ark`.

## Use it

```ts
import { DiaOracle, connect, dia } from "@louisinger/dia-oracle";

const conn = await connect({ arkUrl, emulatorUrl });
const oracle = new DiaOracle(conn, params, dia({ key: params.oraclePk }));

// a consumer contract takes the oracle's identity as its `AssetId oracleId` argument
const consumer = conn.client.contract(program, { ...oracle.id, ...otherArguments });

// spend a consumer coin with the oracle's price
const { txid, update } = await oracle.spend(
  () => conn.client.transaction().from(coin, consumer.unlock.settle()),
  (tx, price) => tx.to(payout, amountAt(price.price)),
);
```

`params` is what the oracle's operator publishes: `{ assetId, oraclePk, adminPk }`. Before
trusting an oracle you did not deploy, run `await oracle.audit()`: it checks that the identity
asset has no control asset and that every unit of it is in one of the oracle's outputs. A unit
held anywhere else would pass for the oracle with any price.

 `spend`
puts the oracle at input 1 and output 0, attaches the identity unit and packet 34, and retries
on another output when one is taken. `attach` does the same without sending.

Prices come from `dia()`: DIA's public RPC, `https://rpc.diadata.org`, with no account and no
key. Each client asks for itself, at most once per 20 seconds, and backs off when refused. DIA
has two signers taking turns and an oracle trusts one: when the registry's latest update is the
other's, the client finds the trusted signer's in the registry's events.

## Deploy one

```sh
pnpm build
node scripts/deploy.mjs --ark https://mutinynet.arkade.sh \
  --emulator https://emulator.mutinynet.arkade.sh --admin <x-only key, hex> --lanes 3
```

It prints an address to fund, issues the identity asset with no control asset, so no further
unit can ever exist, locks one unit in each output, and prints the parameters to publish.

Add `--executor <url>` and it also has that executor renew the outputs: it gives the executor
the oracle's contract and renewal template if it lacks them, then registers one delegation that
covers every output. An executor takes templates on its public port when it runs with
`EXECUTOR_PUBLIC_REGISTRY=true`, and always on its admin port. From code it is
`await oracle.renewWith(executorUrl)`; doing it twice changes nothing. Each output holds sats
that pay its renewals' fees.

`node scripts/status.mjs --ark … --emulator … --params <file> --executor <url>` shows the
outputs and their expiry, audits the asset, and tells whether the executor renews them; with
`--register` it sets the renewal up.

## Built for the operator as it runs today

`contracts/*.ark` compile with `@arkade-os/compiler` 0.1.0 (`pnpm build:contracts`), and
`scripts/compile.mjs` then adapts the result:

- the compiler writes each covenant leaf for one operator key; today the operator signs with
  two, arkd's and the emulator's, which is the form `@arkade-os/sdk` 0.5.13 and the emulator
  accept;
- executord refuses the `codeHash` field and any number literal above 2^53 − 1; the first is
  dropped and the second written as the push of the same bytes.

An oracle deployed from this artifact is at another address than one compiled for the
single-key operator. Its identity asset is what consumers bind, so moving it is a `migrate`.

## Test

```sh
pnpm test        # the DIA client, and that contracts/ compile to artifacts/
pnpm test:e2e    # on a local regtest stack, against the real emulator
```

The end-to-end suite deploys oracles, reads prices from them with a consumer contract, has
several consumers collide, verifies DIA's live signature, and, when executord answers on
`:7080` and takes templates there, has it renew an output. executor's `make regtest-up` provides the
stack.
