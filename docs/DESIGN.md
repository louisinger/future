# Design

An inverse BTC/USD leveraged position, in the spirit of LN Markets' perp, with no house and no
backend. A trader gets an address and pays it; a provider does the same to offer liquidity. The
market's state is a set of coins anyone can list. `how.html` is the visual version of this page.

## State

Scripts are constant; a coin's terms travel in an extension packet on the transaction that
created it. A script reads its own with `OP_INSPECTINPUTPACKET` and only lets a new coin exist
if the new packet is exactly what its rules compute. Integers are 8 bytes little-endian.

| Coin | Script | Terms |
|---|---|---|
| Offer deposit | per provider | in the address |
| Trade deposit | per trade | in the address |
| Offer | one for the whole market | packet 64, 97 bytes |
| Position | one for the whole market | packet 65, 161 bytes |

- Packet 34, price: `0x01 | price 8 | time 8`, USD cents and unix seconds.
- Packet 64, offer: `0x01 | lpPk 32 | lpProgram 32 | spreadBps 8 | maxLeverage 8 | maxDuration 8
  | carryBps 8`.
- Packet 65, position: `0x01 | side 8 | entryPrice 8 | notional 8 | margin 8 | houseMargin 8 |
  startAt 8 | expiry 8 | traderPk 32 | traderProgram 32 | lpProgram 32 | carryBps 8`.

A position pays out only its own value, to the two programs in its own packet. Anyone can
create a position-shaped coin with an invented packet; they split their own sats. The client
ignores packets the contracts could not have written (`validPosition`, `validOffer`).

## Price

A price is a DIA `OracleUpdate` for `BTC/USD`: an EIP-712 message of DIA's registry on Lasernet
(chain 1050, `0x5612599CF48032d7428399d5Fcb99eDcc75c06A7`), signed with an Ethereum key. A spend
that needs a price carries DIA's price (18 decimals), nonce, expiry and signature as witness, and
packet 34 with the price in cents and DIA's timestamp. The script:

1. refuses an update past DIA's own expiry, an hour after it was signed;
2. rounds the price to the cent, half up, and requires packet 34 to hold exactly that;
3. rebuilds the EIP-712 digest with keccak (`OP_DIGEST`) from the witness and the packet's time;
4. checks the ECDSA signature against the key in its address (`OP_CHECKSIGFROMSTACK`, key
   prefixed `0x10`);
5. refuses a time ahead of the emulator's clock.

The key is a constructor argument of the position, offer and trade deposit contracts, so it is
part of every address: another key is another market. On regtest the page signs the same
message with a test key.

## Payoff

Prices in USD cents, amounts in sats, division truncating toward zero:

```
pnl        = notional * (price - entryPrice) / price        negated for a short
fee        = notional * carryBps * clamp(min(time, expiry) - startAt, 0) / 864000000
houseShare = clamp(houseMargin - pnl + fee, 0, margin + houseMargin)
provider   = min(houseShare, pot)        trader = pot - provider
```

A share of 330 sats or less folds into the other side. `houseMargin` is the trader's maximum
profit, so it is the take-profit; leverage sets the liquidation.

## Transactions

| | Spends | Creates | Needs |
|---|---|---|---|
| Register | offer deposit | offer + packet 64 | nothing |
| Open | trade deposit, offer | position + packet 65, offer continuation | a DIA price under 120 s old |
| Settle | position | trader payout, provider payout | a DIA price after the start, under an hour old; past expiry, or a side down to 1% of the margin |
| Close | position | same | the trader's signature, a DIA price under 120 s old |
| Cancel | trade deposit | trader payout | the trader's signature |
| Refund | trade deposit | trader payout | the deadline passed (CLTV leaf) |
| Withdraw | offer | provider payout | the provider's signature |
| Renew | offer or position | the same coin | within a day of expiry |
| Exit | a deposit, on-chain | anything | the owner's key after the operator's exit delay |

Signatures for close, cancel and withdraw are over `sha256(action | outpoint)` of the input,
which in an offchain transaction is the checkpoint's outpoint: the client builds the
transaction once to learn it, signs, and builds again.

Matching is not a protocol step. Whoever builds the opening transaction pairs a deposit with an
offer; the page takes the cheapest offer that fits and falls back to the next if one is
refused.

Register and Refund are also executord templates. When the network's executor has them, the
page registers a delegation for each address it creates, and the executor sends the transaction
when the coin arrives or the deadline passes. Opening and settling need a price fetched at the
time, which an executor cannot do: a page does those.

## What each side is protected from

- The offer is spent only into a position whose entry is the signed price moved by its spread
  against the trader, within its leverage, duration and fee, with both margins at least 5,000
  sats and a life of at least a minute. Only the provider's margin leaves; the rest returns to
  the same script with the same packet.
- The trade deposit is spent only into a position that names its key, payout program,
  direction and leverage, at an entry within its limit and within its spread cap of the signed
  price, at a fee within its cap, holding the take-profit it asked for.
- A position settles only at a price signed after it started.

## What it does not protect against

- **DIA.** Its key decides every price: a wrong or stolen signature settles trades at a wrong
  price. If DIA stops publishing or rotates its key, open positions cannot settle at all, since
  every settlement needs a price signed by the key in the address; offers can still be
  withdrawn and deposits cancelled. DIA has two signers taking turns and the contracts take
  only one of them, the one signing most updates: if that one stops, the other does not help. There is no fallback oracle and no way to change the key of
  an open market.
- **Which price settles.** A position past its end, or liquidated, settles on any DIA update
  that is newer than its start (its end, for an expired one) and under an hour old. Whoever
  submits the transaction picks among them, so a side can wait up to an hour for a better price
  unless the other settles first. The page settles as soon as it can.
- **Expiry.** A new coin expires with the earliest of the coins spent, so a counterparty can
  open against an offer with a coin about to expire and shorten the life of the provider's
  remaining liquidity and of the position. The client refuses to open a trade that would
  outlive its coins, but the scripts cannot read another input's expiry. Renewal is the
  remedy and is not run by the page.
- **Renewal's fee.** `renew` lets up to 1,000 sats leave per renewal and does not pin where
  they go. It has never been run on a real stack.
- **The operator.** Offers and positions have no unilateral exit.
- **Gap risk.** A side cannot lose more than it locked.
- **Privacy.** Every term of every trade is public.

## Tests

- `sdk/contracts/`: each script executed in the emulator's engine, accepted and refused cases, a
  price sweep checking settlement against the payoff for longs, shorts, fees and near-dust
  pots, and the three executord templates built by the template engine.
  The price check runs on updates signed like DIA's by a test key: rounding at half a cent,
  an expired update, another signer, a tampered nonce, a price of zero.
- `sdk/test/unit`: the arithmetic, state validation, byte parity of the SDK's derivation with the
  Go tests' scripts, a recorded DIA response, and the price client's caching and back-off.
- `sdk/test/e2e`: on regtest, with real arkd and emulator: a market's life, a short to its
  take-profit, a cancelled deposit, the holding fee at a non-round price, address checks, a
  trade opened and closed on DIA's live price and real signature, and executord publishing an
  offer and refunding a late deposit from delegations alone.
- By hand in a browser: the page connects on mainnet, mutinynet and regtest and shows DIA's
  price; no horizontal overflow at 320 and 375 pixels on either page.
- `renew_position` has only been built and executed in the engine.
- Nothing has been traded on mutinynet or mainnet. The mainnet emulator is v0.0.9, the tests
  ran against v0.0.10: v0.0.9 has every opcode the contracts use, by reading its source.
