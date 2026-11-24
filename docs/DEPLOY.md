# Deploying

Commands to put the oracle and the market on Mutinynet, then on mainnet. Run them from the
repository root, on the `oracle-output` branch. Everything is filled in except three things only
you have: the executor's admin URL, the coins that fund the oracle, and the admin key the first
step creates.

Do Mutinynet first and trade on it before touching mainnet.

## 0. Once

```sh
git checkout oracle-output && git pull
pnpm install
pnpm -C oracle build
```

## 1. The admin key

One per network. The file holds the secret; the command prints only the public key. Whoever
holds the file can move the oracle to other rules, so move it offline once the oracle is live,
and back it up.

```sh
ADMIN_MUTINYNET=$(node oracle/scripts/admin-key.mjs ~/.arkade-oracle-admin-mutinynet.key)
ADMIN_MAINNET=$(node oracle/scripts/admin-key.mjs ~/.arkade-oracle-admin-mainnet.key)
echo "$ADMIN_MUTINYNET" "$ADMIN_MAINNET"
```

## 2. Mutinynet

### 2.1 Templates on the executor

The admin port (7081) is not public: put the URL you reach it at.

```sh
EXECUTOR_ADMIN=http://<mutinynet executor admin host>:7081
sdk/scripts/register-templates.sh "$EXECUTOR_ADMIN"
oracle/scripts/register-templates.sh "$EXECUTOR_ADMIN"
```

Check from the public port. Each line must end in `200`:

```sh
for id in \
  7bf0fc3fce5b08a6ffcf122bf88020871cbedd654be73c80fb2d48d15780f335 \
  32d07de4874111c1bff5d654447d28e5c49877a27d861bd0999f0dabe38f3bd6 \
  abb9af08fe162ae60e028b11f4e67e68a961b181642bfb59e7a1fac8b82588df
do curl -s -o /dev/null -w "$id %{http_code}\n" https://executor.mutinynet.arkade.sh/v1/template/$id; done
```

Those are `register_offer`, `refund_trade` and `renew_oracle`. Leave the offer and position
renewals (`sdk/scripts/register-templates.sh "$EXECUTOR_ADMIN" renew`) until the operator runs
arkd v0.9.27 or later: earlier versions refuse them and the executor then disables the template.

### 2.2 The oracle

```sh
node oracle/scripts/deploy.mjs \
  --ark https://mutinynet.arkade.sh \
  --emulator https://emulator.mutinynet.arkade.sh \
  --executor https://executor.mutinynet.arkade.sh \
  --admin "$ADMIN_MUTINYNET" \
  --lanes 3 --sats 10000 \
  --out oracle.mutinynet.json
```

It prints a funding key and `send 31000 sats to tark1…`, then waits. Pay that address from an
Arkade wallet on Mutinynet. It then issues the token, creates the three oracle coins, asks the
executor to renew them and writes `oracle.mutinynet.json`. Prices are DIA's, from its documented
signer `0x10e34723aA722C7A9860f5eC6446f22252dB168a`.

### 2.3 Check it

```sh
node oracle/scripts/status.mjs \
  --ark https://mutinynet.arkade.sh \
  --emulator https://emulator.mutinynet.arkade.sh \
  --executor https://executor.mutinynet.arkade.sh \
  --params oracle.mutinynet.json
```

Expect three `output` lines, `audit ok`, a `price` signed seconds ago, `executor has the renewal
template` and `renewal registered, active`. If the renewal is not registered, run the same
command with `--register` added.

### 2.4 Point the market at it and try

```sh
node oracle/scripts/save.mjs oracle.mutinynet.json
pnpm dev
```

Open `http://localhost:5173/?net=mutinynet`. Offer some liquidity under Earn, open a small
trade, close it, and see it under Closed trades.

## 3. Mainnet

### 3.1 Before anything

The new contracts are a new market. The current app, on `main`, is the only page that shows the
old one.

1. Withdraw your offer and settle any position at https://louisinger.github.io/future/ now.
2. Keep a way back to the old page:

```sh
git tag old-market 95ad03e && git push origin old-market
```

### 3.2 Templates on the executor

```sh
EXECUTOR_ADMIN=http://<mainnet executor admin host>:7081
sdk/scripts/register-templates.sh "$EXECUTOR_ADMIN"
oracle/scripts/register-templates.sh "$EXECUTOR_ADMIN"
for id in \
  7bf0fc3fce5b08a6ffcf122bf88020871cbedd654be73c80fb2d48d15780f335 \
  32d07de4874111c1bff5d654447d28e5c49877a27d861bd0999f0dabe38f3bd6 \
  abb9af08fe162ae60e028b11f4e67e68a961b181642bfb59e7a1fac8b82588df
do curl -s -o /dev/null -w "$id %{http_code}\n" https://executor.arkade.sh/v1/template/$id; done
```

Mainnet runs arkd v0.9.26: do not add `renew` yet.

### 3.3 The oracle

```sh
node oracle/scripts/deploy.mjs \
  --ark https://arkade.computer \
  --emulator https://emulator.arkade.computer \
  --executor https://executor.arkade.sh \
  --admin "$ADMIN_MAINNET" \
  --lanes 3 --sats 10000 \
  --out oracle.mainnet.json
```

Pay the `ark1…` address it prints 31,000 sats from an Arkade wallet.

### 3.4 Check it and point the market at it

```sh
node oracle/scripts/status.mjs \
  --ark https://arkade.computer \
  --emulator https://emulator.arkade.computer \
  --executor https://executor.arkade.sh \
  --params oracle.mainnet.json
node oracle/scripts/save.mjs oracle.mainnet.json
pnpm dev
```

Open `http://localhost:5173/?net=mainnet` and make one small trade against a small offer of your
own before publishing.

## 4. Publish

```sh
pnpm typecheck && pnpm test && pnpm build
git add sdk/src/oracles.json
git commit -S -m "Point the market at the deployed oracles"
git push
gh pr ready 1 && gh pr merge 1 --merge
```

Merging to `main` builds and publishes the site. Then:

```sh
gh run watch "$(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Move both admin key files offline. Keep `oracle.mutinynet.json` and `oracle.mainnet.json`: they
are what other apps need to read the same oracle, and nothing in them is secret.

## What was checked, and what was not

- The deploy script connects to both networks and reaches the funding step; nothing was
  funded, so no oracle has been created on either.
- The whole flow ran on regtest: deploy, status, save, trading through the oracle, and the
  executor renewing an oracle coin.
- The mainnet emulator is v0.0.9: it has every opcode the oracle and the market use, by reading
  its source. No transaction of this design has run on mainnet or Mutinynet.

## Later

- `node oracle/scripts/status.mjs …` at any time shows the coins' expiry and whether the
  executor still renews them.
- `node oracle/scripts/dia-signer.mjs` shows which DIA signer published last. If DIA retires
  the documented one, the oracle has to be moved with the admin key; that tool is not written
  yet.
