package contracts

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/arkade-os/executor/pkg/template"
	"github.com/arkade-os/executor/pkg/template/artifact"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/sha3"
)

const (
	quotePacket    = 34
	offerPacket    = 64
	positionPacket = 65

	dust          = 330
	renewalWindow = 86400
	maxFee        = 1000
	exitDelay     = 144
)

func TestFill(t *testing.T) {
	m := newMarket(t)
	now := time.Now().Unix()

	tests := []struct {
		name       string
		mutate     func(*fillCase)
		rejectedBy string
	}{
		{name: "long at the oracle price plus the spread"},
		{
			name: "short at the oracle price minus the spread",
			mutate: func(c *fillCase) {
				c.side, c.state.side = 1, 1
				c.limit, c.state.entry = 9_950_000, 9_990_000
			},
		},
		{
			name:       "entry better than the spread allows",
			mutate:     func(c *fillCase) { c.state.entry = 10_000_000 },
			rejectedBy: "offer",
		},
		{
			name:       "entry beyond the trader's limit",
			mutate:     func(c *fillCase) { c.limit = 10_005_000 },
			rejectedBy: "deposit",
		},
		{
			name: "stale quote",
			mutate: func(c *fillCase) {
				c.quoteTime -= 300
				c.state.startAt -= 300
				c.state.expiry -= 300
			},
			rejectedBy: "offer",
		},
		{
			name: "position starts before the quote",
			mutate: func(c *fillCase) {
				c.state.startAt -= 60
				c.state.expiry -= 60
			},
			rejectedBy: "offer",
		},
		{
			name: "leverage above the offer's cap",
			mutate: func(c *fillCase) {
				c.leverage, c.maxLeverage = 20, 10
				c.state.notional, c.state.houseMargin = 2_000_000, 2_000_000
				c.positionValue, c.offerChange = 2_100_000, 3_000_000
			},
			rejectedBy: "offer",
		},
		{
			name: "longer than the offer allows",
			mutate: func(c *fillCase) {
				c.duration = 30 * 86400
				c.state.expiry = c.state.startAt + c.duration
			},
			rejectedBy: "offer",
		},
		{
			name:       "position underfunded",
			mutate:     func(c *fillCase) { c.positionValue-- },
			rejectedBy: "deposit",
		},
		{
			name:       "offer drained beyond the house margin",
			mutate:     func(c *fillCase) { c.offerChange-- },
			rejectedBy: "offer",
		},
		{
			name:       "offer state dropped",
			mutate:     func(c *fillCase) { c.dropOfferState = true },
			rejectedBy: "offer",
		},
		{
			name:       "trader payout redirected",
			mutate:     func(c *fillCase) { c.state.traderProgram = random32(t) },
			rejectedBy: "deposit",
		},
		{
			name:       "lp payout redirected",
			mutate:     func(c *fillCase) { c.state.lpProgram = random32(t) },
			rejectedBy: "offer",
		},
		{
			name: "take-profit below the trader's cap",
			mutate: func(c *fillCase) {
				c.state.houseMargin = 500_000
				c.positionValue, c.offerChange = 600_000, 4_500_000
			},
			rejectedBy: "deposit",
		},
		{
			name:       "notional not margin times leverage",
			mutate:     func(c *fillCase) { c.state.notional = 900_000 },
			rejectedBy: "deposit",
		},
		{
			name:       "after the deposit deadline",
			mutate:     func(c *fillCase) { c.deadline = now - 1 },
			rejectedBy: "deposit",
		},
		{
			name:   "holding fee of the offer recorded",
			mutate: func(c *fillCase) { c.carry, c.state.carry = 25, 25 },
		},
		{
			name:       "holding fee not the offer's",
			mutate:     func(c *fillCase) { c.carry, c.state.carry = 25, 5 },
			rejectedBy: "offer",
		},
		{
			name:       "holding fee above the trader's cap",
			mutate:     func(c *fillCase) { c.carry, c.state.carry = 150, 150 },
			rejectedBy: "deposit",
		},
		{
			name: "spread above the trader's cap",
			mutate: func(c *fillCase) {
				c.spread, c.state.entry = 30, 10_030_000
			},
			rejectedBy: "deposit",
		},
		{
			name: "entry at the trader's limit but far from the signed price",
			mutate: func(c *fillCase) {
				c.spread, c.state.entry = 50, 10_050_000
			},
			rejectedBy: "deposit",
		},
		{
			name: "trade that ends as it starts",
			mutate: func(c *fillCase) {
				c.duration = 0
				c.state.expiry = c.state.startAt
			},
			rejectedBy: "offer",
		},
		{
			name: "margin below the minimum",
			mutate: func(c *fillCase) {
				c.margin, c.state.margin = 4_999, 4_999
				c.state.notional, c.state.houseMargin = 49_990, 49_990
				c.positionValue, c.offerChange = 54_989, 4_950_010
			},
			rejectedBy: "offer",
		},
		{
			name: "house margin below the minimum",
			mutate: func(c *fillCase) {
				c.capBps, c.state.houseMargin = 100, 1_000
				c.positionValue, c.offerChange = 101_000, 4_999_000
			},
			rejectedBy: "offer",
		},
		{
			name:       "side neither long nor short",
			mutate:     func(c *fillCase) { c.side, c.state.side = 2, 2 },
			rejectedBy: "offer",
		},
		{
			name: "house margin above the notional",
			mutate: func(c *fillCase) {
				c.state.houseMargin = 1_000_001
				c.positionValue, c.offerChange = 1_100_001, 3_999_999
			},
			rejectedBy: "offer",
		},
		{
			name: "no house margin",
			mutate: func(c *fillCase) {
				c.capBps, c.state.houseMargin = 0, 0
				c.positionValue, c.offerChange = 100_000, 5_000_000
			},
			rejectedBy: "offer",
		},
		{
			name:       "expiry not the start plus the duration",
			mutate:     func(c *fillCase) { c.state.expiry++ },
			rejectedBy: "deposit",
		},
		{
			name: "margin not what the deposit holds",
			mutate: func(c *fillCase) {
				c.state.margin, c.state.notional = 90_000, 900_000
			},
			rejectedBy: "deposit",
		},
		{
			name:       "price dated in the future",
			mutate:     func(c *fillCase) { c.quoteTime, c.state.startAt = now+600, now+600 },
			rejectedBy: "offer",
		},
		{
			name:       "price not signed by the oracle",
			mutate:     func(c *fillCase) { c.forgedQuote = true },
			rejectedBy: "offer",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := m.defaultFill(now)
			if tt.mutate != nil {
				tt.mutate(&c)
			}
			errs := m.fill(t, c)
			if tt.rejectedBy == "" {
				for who, err := range errs {
					require.NoError(t, err, who)
				}
				return
			}
			require.Error(t, errs[tt.rejectedBy])
		})
	}
}

func TestResolve(t *testing.T) {
	m := newMarket(t)
	now := time.Now().Unix()
	long := m.defaultFill(now - 2*86400).state
	short := long
	short.side = 1

	tests := []struct {
		name       string
		state      positionState
		price      int64
		quoteTime  int64
		wantTrader int64
		tamper     func(outs []*wire.TxOut)
		forged     bool
		rejected   bool
	}{
		{
			name:  "long in profit at expiry",
			state: long, price: 11_011_000, quoteTime: long.expiry, wantTrader: 190_909,
		},
		{
			name:  "short loses the same move",
			state: short, price: 11_011_000, quoteTime: short.expiry, wantTrader: 9_091,
		},
		{
			name:  "long liquidated before expiry",
			state: long, price: 9_100_000, quoteTime: long.startAt + 60, wantTrader: 0,
		},
		{
			name:  "take-profit reached before expiry",
			state: long, price: 20_000_000_000, quoteTime: long.startAt + 60,
			wantTrader: 1_099_499,
		},
		{
			name:  "a day's holding fee of one percent paid at expiry",
			state: withCarry(long, 100), price: long.entry, quoteTime: long.expiry,
			wantTrader: 90_000,
		},
		{
			name:  "the fee stops at expiry",
			state: withCarry(long, 100), price: long.entry, quoteTime: long.expiry + 3600,
			wantTrader: 90_000,
		},
		{
			name:  "healthy before expiry",
			state: long, price: 10_500_000, quoteTime: long.startAt + 60, rejected: true,
		},
		{
			name:  "liquidation price signed before the position started",
			state: long, price: 9_100_000, quoteTime: long.startAt - 1, rejected: true,
		},
		{
			name:  "liquidation price not signed by the oracle",
			state: long, price: 9_100_000, quoteTime: long.startAt + 60,
			forged: true, rejected: true,
		},
		{
			name:  "price dated in the future",
			state: long, price: 9_100_000, quoteTime: now + 600, rejected: true,
		},
		{
			name:  "ended position settled at a price signed before it started",
			state: ended(long), price: 20_000_000, quoteTime: long.startAt - 1, rejected: true,
		},
		{
			name:  "trader underpaid",
			state: long, price: 11_011_000, quoteTime: long.expiry, wantTrader: 190_909,
			tamper: func(outs []*wire.TxOut) {
				outs[0].Value--
				outs[1].Value++
			},
			rejected: true,
		},
		{
			name:  "trader payout redirected",
			state: long, price: 11_011_000, quoteTime: long.expiry, wantTrader: 190_909,
			tamper:   func(outs []*wire.TxOut) { outs[0].PkScript = p2tr(random32(t)) },
			rejected: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, outs, oracleSig := m.settlement(t, tt.state, tt.price, tt.quoteTime, tt.tamper)
			if tt.forged {
				_, oracleSig = m.signQuote(t, m.traderSk, tt.price, tt.quoteTime)
			}
			err := s.exec(0, m.position.Covenants["resolve"], oracleSig)
			if tt.rejected {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.wantTrader, paid(outs, tt.state.traderProgram))
			pot := tt.state.margin + tt.state.houseMargin
			require.Equal(t, pot-tt.wantTrader, paid(outs, tt.state.lpProgram))
		})
	}
}

// TestArtifacts pins the contracts built for each oracle: every source in src/ with the price
// check of every file in oracles/ in place of its "$oracle" markers. UPDATE_VECTORS=1 rewrites
// them.
func TestArtifacts(t *testing.T) {
	sources, err := filepath.Glob(filepath.Join("src", "*.json"))
	require.NoError(t, err)
	oracles, err := filepath.Glob(filepath.Join("oracles", "*.json"))
	require.NoError(t, err)
	require.NotEmpty(t, sources)
	require.NotEmpty(t, oracles)

	for _, o := range oracles {
		check, err := os.ReadFile(o)
		require.NoError(t, err)
		for _, src := range sources {
			name := filepath.Join(strings.TrimSuffix(filepath.Base(o), ".json"), filepath.Base(src))
			t.Run(name, func(t *testing.T) {
				contract, err := os.ReadFile(src)
				require.NoError(t, err)
				got := withOracle(t, contract, check)
				_, err = artifact.Parse(got)
				require.NoError(t, err)

				path := filepath.Join("artifacts", name)
				if os.Getenv("UPDATE_VECTORS") != "" {
					require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
					require.NoError(t, os.WriteFile(path, got, 0o644))
				}
				want, err := os.ReadFile(path)
				require.NoError(t, err)
				require.Equal(t, string(want), string(got))
			})
		}
	}
}

// TestOracles runs a trade's life on each price check the contracts can be built with.
func TestOracles(t *testing.T) {
	for _, o := range []oracle{dia, schnorrOracle} {
		t.Run(o.name, func(t *testing.T) {
			m := newMarketOn(t, o)
			now := time.Now().Unix()
			open := m.defaultFill(now - 5)
			ended := m.defaultFill(now - 2*86400).state
			const price = 11_011_000

			tests := []struct {
				name     string
				run      func(t *testing.T) error
				rejected bool
			}{
				{
					name: "opens at a signed price",
					run: func(t *testing.T) error {
						errs := m.fill(t, open)
						return errors.Join(errs["deposit"], errs["offer"])
					},
				},
				{
					name: "the deposit refuses a price signed by another key",
					run: func(t *testing.T) error {
						forged := open
						forged.forgedQuote = true
						return m.fill(t, forged)["deposit"]
					},
					rejected: true,
				},
				{
					name: "the offer refuses a price signed by another key",
					run: func(t *testing.T) error {
						forged := open
						forged.forgedQuote = true
						return m.fill(t, forged)["offer"]
					},
					rejected: true,
				},
				{
					name: "settles at a signed price",
					run: func(t *testing.T) error {
						s, _, witness := m.settlement(t, ended, price, ended.expiry, nil)
						return s.exec(0, m.position.Covenants["resolve"], witness)
					},
				},
				{
					name: "refuses to settle at a price signed by another key",
					run: func(t *testing.T) error {
						s, _, _ := m.settlement(t, ended, price, ended.expiry, nil)
						_, forged := m.signQuote(t, m.traderSk, price, ended.expiry)
						return s.exec(0, m.position.Covenants["resolve"], forged)
					},
					rejected: true,
				},
				{
					name: "refuses a price other than the one signed",
					run: func(t *testing.T) error {
						s, _, witness := m.settlementAt(
							t, ended, price, ended.expiry, quoteOf(price+1, ended.expiry),
						)
						return s.exec(0, m.position.Covenants["resolve"], witness)
					},
					rejected: true,
				},
				{
					name: "refuses a time other than the one signed",
					run: func(t *testing.T) error {
						s, _, witness := m.settlementAt(
							t, ended, price, ended.expiry, quoteOf(price, ended.expiry+1),
						)
						return s.exec(0, m.position.Covenants["resolve"], witness)
					},
					rejected: true,
				},
				{
					name: "closes on the trader's signature at a signed price",
					run: func(t *testing.T) error {
						live := m.defaultFill(now - 3600).state
						s, _, witness := m.settlement(t, live, price, now-5, nil)
						sig := signOutpoint(t, m.traderSk, "close", s.coins[0].op)
						return s.exec(0, m.position.Covenants["close"], append(witness, sig))
					},
				},
			}
			for _, tt := range tests {
				t.Run(tt.name, func(t *testing.T) {
					err := tt.run(t)
					if tt.rejected {
						require.Error(t, err)
						return
					}
					require.NoError(t, err)
				})
			}
		})
	}
}

// TestQuote settles an ended position on DIA updates that differ from a well-formed one.
func TestQuote(t *testing.T) {
	m := newMarket(t)
	now := time.Now().Unix()
	state := m.defaultFill(now - 2*86400).state
	const cents = 11_011_000
	scaled := func(extra int64) *big.Int {
		raw := new(big.Int).Mul(big.NewInt(cents), big.NewInt(1e16))
		return raw.Add(raw, big.NewInt(extra))
	}

	update := func(raw *big.Int, expiry int64) diaUpdate {
		return diaUpdate{raw: raw, time: state.expiry, nonce: 7, expiry: expiry}
	}

	tests := []struct {
		name     string
		update   diaUpdate
		signer   *btcec.PrivateKey
		packet   int64
		tamper   func(w wire.TxWitness)
		rejected bool
	}{
		{
			name:   "a price with no fraction of a cent",
			update: update(scaled(0), now+3600),
			signer: m.oracleSk, packet: cents,
		},
		{
			name:   "just under half a cent rounds down",
			update: update(scaled(5e15-1), now+3600),
			signer: m.oracleSk, packet: cents,
		},
		{
			name:   "half a cent rounds up",
			update: update(scaled(5e15), now+3600),
			signer: m.oracleSk, packet: cents + 1,
		},
		{
			name:   "the note claims the cent below the rounded price",
			update: update(scaled(5e15), now+3600),
			signer: m.oracleSk, packet: cents, rejected: true,
		},
		{
			name:   "an update past its validity",
			update: update(scaled(0), now-1),
			signer: m.oracleSk, packet: cents, rejected: true,
		},
		{
			name:   "an update signed by another key",
			update: update(scaled(0), now+3600),
			signer: m.traderSk, packet: cents, rejected: true,
		},
		{
			name:   "a nonce other than the one signed",
			update: update(scaled(0), now+3600),
			signer: m.oracleSk, packet: cents,
			tamper: func(w wire.TxWitness) { w[2] = scriptNum(8) }, rejected: true,
		},
		{
			name:   "a price that rounds to zero",
			update: update(big.NewInt(5e15-1), now+3600),
			signer: m.oracleSk, packet: 0, rejected: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, _, _ := m.settlementAt(
				t, state, max(tt.packet, 1), state.expiry, quoteOf(tt.packet, tt.update.time),
			)
			witness := tt.update.witness(t, tt.signer)
			if tt.tamper != nil {
				tt.tamper(witness)
			}
			err := s.exec(0, m.position.Covenants["resolve"], witness)
			if tt.rejected {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
		})
	}
}

func TestClose(t *testing.T) {
	m := newMarket(t)
	now := time.Now().Unix()
	state := m.defaultFill(now - 3600).state

	tests := []struct {
		name      string
		signer    *btcec.PrivateKey
		quoteTime int64
		rejected  bool
	}{
		{name: "trader closes at a fresh price", signer: m.traderSk, quoteTime: now - 5},
		{name: "someone else closes", signer: m.lpSk, quoteTime: now - 5, rejected: true},
		{name: "stale price", signer: m.traderSk, quoteTime: now - 600, rejected: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, outs, oracleSig := m.settlement(t, state, 10_500_000, tt.quoteTime, nil)
			sig := signOutpoint(t, tt.signer, "close", s.coins[0].op)
			err := s.exec(0, m.position.Covenants["close"], append(oracleSig, sig))
			if tt.rejected {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, int64(146_666), paid(outs, state.traderProgram))
		})
	}
}

func TestRenew(t *testing.T) {
	m := newMarket(t)
	now := time.Now().Unix()
	state := m.defaultFill(now - 3600).state
	value := state.margin + state.houseMargin
	intent := `{"onchain_output_indexes":[],"type":"register"}`

	tests := []struct {
		name      string
		outValue  int64
		outScript []byte
		keepState bool
		expiry    int64
		intent    string
		rejected  bool
	}{
		{
			name:     "renewed inside the window with the state carried",
			outValue: value - maxFee, outScript: m.position.PkScript, keepState: true,
			expiry: now + 3600, intent: intent,
		},
		{
			name:     "state dropped",
			outValue: value - maxFee, outScript: m.position.PkScript,
			expiry: now + 3600, intent: intent, rejected: true,
		},
		{
			name:     "fee above the cap",
			outValue: value - maxFee - 1, outScript: m.position.PkScript, keepState: true,
			expiry: now + 3600, intent: intent, rejected: true,
		},
		{
			name:     "before the renewal window",
			outValue: value - maxFee, outScript: m.position.PkScript, keepState: true,
			expiry: now + 10*renewalWindow, intent: intent, rejected: true,
		},
		{
			name:     "moved to another script",
			outValue: value - maxFee, outScript: p2tr(random32(t)), keepState: true,
			expiry: now + 3600, intent: intent, rejected: true,
		},
		{
			name:     "offboarded",
			outValue: value - maxFee, outScript: m.position.PkScript, keepState: true,
			expiry: now + 3600, intent: `{"onchain_output_indexes":[0],"type":"register"}`,
			rejected: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			proof := newCoin(t, p2tr(random32(t)), 0)
			position := newCoin(t, m.position.PkScript, value, state.packet())
			var packets []extension.Packet
			if tt.keepState {
				packets = append(packets, state.packet())
			}
			s := newSpend(
				t, []coin{proof, position},
				[]*wire.TxOut{wire.NewTxOut(tt.outValue, tt.outScript)}, packets...,
			)
			err := s.exec(
				1, m.position.Covenants["renew"], nil,
				arkade.WithExpiry(tt.expiry), arkade.WithIntentMessage(tt.intent),
			)
			if tt.rejected {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
		})
	}
}

func TestRegister(t *testing.T) {
	m := newMarket(t)
	terms := offerState{
		lpPk: xonly(m.lpSk), lpProgram: m.lpProgram,
		spread: 10, maxLeverage: 50, maxDuration: 7 * 86400,
	}
	deposit := m.offerDeposit(t, terms)

	tests := []struct {
		name      string
		state     offerState
		outScript []byte
		outValue  int64
		rejected  bool
	}{
		{
			name:  "deposit becomes an offer carrying its terms",
			state: terms, outScript: m.offer.PkScript, outValue: 5_000_000,
		},
		{
			name: "terms rewritten",
			state: offerState{
				lpPk: terms.lpPk, lpProgram: terms.lpProgram,
				spread: 0, maxLeverage: 50, maxDuration: 7 * 86400,
			},
			outScript: m.offer.PkScript, outValue: 5_000_000, rejected: true,
		},
		{
			name:  "sent somewhere else",
			state: terms, outScript: p2tr(random32(t)), outValue: 5_000_000, rejected: true,
		},
		{
			name:  "value skimmed",
			state: terms, outScript: m.offer.PkScript, outValue: 4_999_999, rejected: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newSpend(
				t, []coin{newCoin(t, deposit.PkScript, 5_000_000)},
				[]*wire.TxOut{wire.NewTxOut(tt.outValue, tt.outScript)}, tt.state.packet(),
			)
			err := s.exec(0, deposit.Covenants["register"], nil)
			if tt.rejected {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
		})
	}
}

func TestWithdraw(t *testing.T) {
	m := newMarket(t)
	state := offerState{
		lpPk: xonly(m.lpSk), lpProgram: m.lpProgram,
		spread: 10, maxLeverage: 50, maxDuration: 7 * 86400,
	}

	tests := []struct {
		name      string
		signer    *btcec.PrivateKey
		outScript []byte
		rejected  bool
	}{
		{name: "lp withdraws to its program", signer: m.lpSk, outScript: p2tr(m.lpProgram)},
		{
			name:   "someone else withdraws",
			signer: m.traderSk, outScript: p2tr(m.lpProgram), rejected: true,
		},
		{
			name:   "withdrawn somewhere else",
			signer: m.lpSk, outScript: p2tr(random32(t)), rejected: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			offer := newCoin(t, m.offer.PkScript, 5_000_000, state.packet())
			s := newSpend(
				t, []coin{offer}, []*wire.TxOut{wire.NewTxOut(5_000_000, tt.outScript)},
			)
			sig := signOutpoint(t, tt.signer, "withdraw", offer.op)
			err := s.exec(0, m.offer.Covenants["withdraw"], wire.TxWitness{sig})
			if tt.rejected {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
		})
	}
}

func TestRefund(t *testing.T) {
	m := newMarket(t)
	now := time.Now().Unix()

	tests := []struct {
		name      string
		deadline  int64
		outScript []byte
		rejected  bool
	}{
		{name: "unfilled deposit returns after its deadline", deadline: now - 1},
		{name: "before the deadline", deadline: now + 600, rejected: true},
		{
			name:     "returned somewhere else",
			deadline: now - 1, outScript: p2tr(random32(t)), rejected: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := m.defaultFill(now)
			c.deadline = tt.deadline
			deposit := m.tradeDeposit(t, c)
			outScript := tt.outScript
			if outScript == nil {
				outScript = p2tr(m.traderProgram)
			}
			s := newSpend(
				t, []coin{newCoin(t, deposit.PkScript, c.margin)},
				[]*wire.TxOut{wire.NewTxOut(c.margin, outScript)},
			)
			err := s.exec(0, deposit.Covenants["refund"], nil)
			if tt.rejected {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
		})
	}
}

// TestPayoff sweeps the price and checks that the position script settles exactly when the payoff
// says it may, and refuses a payout one sat short on either side.
func TestPayoff(t *testing.T) {
	m := newMarket(t)
	now := time.Now().Unix()
	open := m.defaultFill(now - 3600).state
	matured := m.defaultFill(now - 2*86400).state
	short := func(s positionState) positionState { s.side = 1; return s }
	small := func(s positionState) positionState {
		s.notional, s.margin, s.houseMargin = 5_000, 500, 400
		return s
	}

	tests := []struct {
		name      string
		state     positionState
		quoteTime int64
	}{
		{name: "long before expiry", state: open, quoteTime: now - 10},
		{name: "short before expiry", state: short(open), quoteTime: now - 10},
		{name: "long at expiry", state: matured, quoteTime: matured.expiry},
		{name: "short at expiry", state: short(matured), quoteTime: matured.expiry},
		{name: "near dust before expiry", state: small(open), quoteTime: now - 10},
		{name: "near dust at expiry", state: small(matured), quoteTime: matured.expiry},
		{name: "near dust short at expiry", state: short(small(matured)), quoteTime: matured.expiry},
		{name: "long paying a holding fee", state: withCarry(open, 300), quoteTime: now - 10},
		{name: "short paying a holding fee", state: withCarry(short(open), 300), quoteTime: now - 10},
		{
			name:  "long paying a holding fee at expiry",
			state: withCarry(matured, 300), quoteTime: matured.expiry,
		},
		{
			name:  "fee larger than the margin at expiry",
			state: withCarry(matured, 2_000), quoteTime: matured.expiry,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			settled := 0
			for percent := int64(1); percent <= 400; percent += 3 {
				price := tt.state.entry * percent / 100
				s, outs, oracleSig := m.settlement(t, tt.state, price, tt.quoteTime, nil)
				err := s.exec(0, m.position.Covenants["resolve"], oracleSig)
				want := tt.state.resolvable(price, tt.quoteTime)
				require.Equal(t, want, err == nil, "price %d: %v", price, err)
				if !want {
					continue
				}
				settled++
				for i := range outs {
					short, _, sig := m.settlement(
						t, tt.state, price, tt.quoteTime,
						func(outs []*wire.TxOut) { outs[i].Value-- },
					)
					require.Error(
						t, short.exec(0, m.position.Covenants["resolve"], sig),
						"price %d output %d", price, i,
					)
				}
			}
			require.NotZero(t, settled)
		})
	}
}

func TestInputs(t *testing.T) {
	m := newMarket(t)
	now := time.Now().Unix()
	state := m.defaultFill(now - 2*86400).state

	tests := []struct {
		name string
		run  func(t *testing.T, extra coin) error
	}{
		{
			name: "resolve with a second input",
			run: func(t *testing.T, extra coin) error {
				s, _, sig := m.settlement(t, state, 11_011_000, state.expiry, nil)
				s.add(extra)
				return s.exec(0, m.position.Covenants["resolve"], sig)
			},
		},
		{
			name: "close with a second input",
			run: func(t *testing.T, extra coin) error {
				s, _, oracleSig := m.settlement(t, state, 11_011_000, now-5, nil)
				s.add(extra)
				sig := signOutpoint(t, m.traderSk, "close", s.coins[0].op)
				return s.exec(0, m.position.Covenants["close"], append(oracleSig, sig))
			},
		},
		{
			name: "withdraw with a second input",
			run: func(t *testing.T, extra coin) error {
				offer := offerState{lpPk: xonly(m.lpSk), lpProgram: m.lpProgram}
				c := newCoin(t, m.offer.PkScript, 5_000_000, offer.packet())
				s := newSpend(
					t, []coin{c}, []*wire.TxOut{wire.NewTxOut(5_000_000, p2tr(m.lpProgram))},
				)
				s.add(extra)
				sig := signOutpoint(t, m.lpSk, "withdraw", c.op)
				return s.exec(0, m.offer.Covenants["withdraw"], wire.TxWitness{sig})
			},
		},
		{
			name: "fill with a third input",
			run: func(t *testing.T, extra coin) error {
				c := m.defaultFill(now)
				s, sig := m.fillSpend(t, c)
				s.add(extra)
				return s.exec(1, m.offer.Covenants["fill"], sig)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Error(t, tt.run(t, newCoin(t, p2tr(random32(t)), 1_000)))
		})
	}
}

func TestCancel(t *testing.T) {
	m := newMarket(t)
	c := m.defaultFill(time.Now().Unix())
	deposit := m.tradeDeposit(t, c)

	tests := []struct {
		name      string
		signer    *btcec.PrivateKey
		outScript []byte
		outValue  int64
		rejected  bool
	}{
		{
			name:   "trader takes the deposit back before the deadline",
			signer: m.traderSk, outScript: p2tr(m.traderProgram), outValue: c.margin,
		},
		{
			name:   "someone else cancels",
			signer: m.lpSk, outScript: p2tr(m.traderProgram), outValue: c.margin, rejected: true,
		},
		{
			name:   "sent somewhere else",
			signer: m.traderSk, outScript: p2tr(random32(t)), outValue: c.margin, rejected: true,
		},
		{
			name:   "value skimmed",
			signer: m.traderSk, outScript: p2tr(m.traderProgram), outValue: c.margin - 1,
			rejected: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			funded := newCoin(t, deposit.PkScript, c.margin)
			s := newSpend(
				t, []coin{funded}, []*wire.TxOut{wire.NewTxOut(tt.outValue, tt.outScript)},
			)
			sig := signOutpoint(t, tt.signer, "cancel", funded.op)
			err := s.exec(0, deposit.Covenants["cancel"], wire.TxWitness{sig})
			if tt.rejected {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
		})
	}
}

func TestTemplates(t *testing.T) {
	m := newMarket(t)
	now := time.Now().Unix()
	terms := offerState{
		lpPk: xonly(m.lpSk), lpProgram: m.lpProgram,
		spread: 10, maxLeverage: 50, maxDuration: 7 * 86400,
	}
	trade := m.defaultFill(now)
	trade.deadline = now - 1
	position := m.defaultFill(now - 3600).state

	tests := []struct {
		name      string
		variables map[string][]byte
		source    coin
		expiry    int64
		opts      []arkade.ExecuteOption
		check     func(t *testing.T, tx *wire.MsgTx)
	}{
		{
			name: "register_offer",
			variables: map[string][]byte{
				"oracle_pk":        m.oracle.key(m.oracleSk).Raw,
				"position_program": m.position.PkScript[2:],
				"renewal_window":   scriptNum(renewalWindow),
				"max_fee":          scriptNum(maxFee),
				"lp_pk":            m.lpSk.PubKey().SerializeCompressed(),
				"lp_program":       m.lpProgram,
				"spread_bps":       scriptNum(terms.spread),
				"max_leverage":     scriptNum(terms.maxLeverage),
				"max_duration":     scriptNum(terms.maxDuration),
				"carry_bps":        scriptNum(terms.carry),
				"exit_delay":       scriptNum(exitDelay),
			},
			source: newCoin(t, m.offerDeposit(t, terms).PkScript, 5_000_000),
			check: func(t *testing.T, tx *wire.MsgTx) {
				require.Equal(t, m.offer.PkScript, tx.TxOut[0].PkScript)
				require.Equal(t, int64(5_000_000), tx.TxOut[0].Value)
				require.Equal(t, packetData(t, terms.packet()), txPacket(t, tx, offerPacket))
			},
		},
		{
			name: "refund_trade",
			variables: map[string][]byte{
				"position_program": m.position.PkScript[2:],
				"trader_pk":        m.traderSk.PubKey().SerializeCompressed(),
				"trader_program":   m.traderProgram,
				"side":             scriptNum(trade.side),
				"leverage":         scriptNum(trade.leverage),
				"cap_bps":          scriptNum(trade.capBps),
				"limit_price":      scriptNum(trade.limit),
				"duration":         scriptNum(trade.duration),
				"deadline":         scriptNum(trade.deadline),
				"max_carry_bps":    scriptNum(trade.maxCarry),
				"max_spread_bps":   scriptNum(trade.maxSpread),
				"oracle_pk":        m.oracle.key(m.oracleSk).Raw,
				"exit_delay":       scriptNum(exitDelay),
			},
			source: newCoin(t, m.tradeDeposit(t, trade).PkScript, trade.margin),
			check: func(t *testing.T, tx *wire.MsgTx) {
				require.Equal(t, p2tr(m.traderProgram), tx.TxOut[0].PkScript)
				require.Equal(t, trade.margin, tx.TxOut[0].Value)
				require.Equal(t, uint32(trade.deadline), tx.LockTime)
			},
		},
		{
			name: "renew_offer",
			variables: map[string][]byte{
				"oracle_pk":        m.oracle.key(m.oracleSk).Raw,
				"position_program": m.position.PkScript[2:],
				"renewal_window":   scriptNum(renewalWindow),
				"max_fee":          scriptNum(maxFee),
			},
			// an offer left by an opened trade: its transaction also carries the price and the
			// position's note
			source: newCoin(
				t, m.offer.PkScript, 5_000_000, quoteOf(10_000_000, now), terms.packet(),
				position.packet(),
			),
			expiry: now + 3600,
			opts: []arkade.ExecuteOption{
				arkade.WithExpiry(now + 3600),
				arkade.WithIntentMessage(`{"onchain_output_indexes":[],"type":"register"}`),
			},
			check: func(t *testing.T, tx *wire.MsgTx) {
				require.Equal(t, m.offer.PkScript, tx.TxOut[0].PkScript)
				require.Equal(t, int64(5_000_000), tx.TxOut[0].Value)
				require.Equal(t, packetData(t, terms.packet()), txPacket(t, tx, offerPacket))
			},
		},
		{
			name: "renew_position",
			variables: map[string][]byte{
				"oracle_pk":      m.oracle.key(m.oracleSk).Raw,
				"renewal_window": scriptNum(renewalWindow),
				"max_fee":        scriptNum(maxFee),
			},
			source: newCoin(
				t, m.position.PkScript, position.margin+position.houseMargin,
				quoteOf(10_000_000, now), terms.packet(), position.packet(),
			),
			expiry: now + 3600,
			opts: []arkade.ExecuteOption{
				arkade.WithExpiry(now + 3600),
				arkade.WithIntentMessage(`{"onchain_output_indexes":[],"type":"register"}`),
			},
			check: func(t *testing.T, tx *wire.MsgTx) {
				require.Equal(t, m.position.PkScript, tx.TxOut[0].PkScript)
				require.Equal(t, position.margin+position.houseMargin, tx.TxOut[0].Value)
				require.Equal(
					t, packetData(t, position.packet()), txPacket(t, tx, positionPacket),
				)
			},
		},
	}

	ids := map[string]string{}
	t.Cleanup(func() { requireGolden(t, "templates.json", ids) })

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("executor-templates", tt.name+".json"))
			require.NoError(t, err)
			tmpl, err := template.Parse(raw, artifactDocuments(t))
			require.NoError(t, err)
			ids[tt.name] = tmpl.ID()
			bound, err := tmpl.Bind(template.Bindings{Keys: m.keys, Variables: tt.variables})
			require.NoError(t, err)
			action, err := bound.Build(template.BuildRequest{
				Sources: []*template.Source{{
					Outpoint: tt.source.op, Tx: tt.source.tx,
					Amount:    uint64(tt.source.out.Value),
					Expiry:    time.Unix(tt.expiry, 0),
					CreatedAt: time.Unix(now-60, 0),
				}},
				Fee: template.Fee{Dust: dust},
			})
			require.NoError(t, err)

			tx := action.Tx.UnsignedTx
			tt.check(t, tx)
			entries, err := arkade.FindEmulatorPacket(tx)
			require.NoError(t, err)
			require.Len(t, entries, 1)
			script, err := arkade.ReadArkadeScript(action.Tx, m.keys.Emulator, entries[0])
			require.NoError(t, err)
			vin := int(entries[0].Vin)
			proof := tmpl.Type() == template.Proof
			if proof {
				tx = tx.Copy()
				message := &wire.TxIn{Sequence: wire.MaxTxInSequenceNum}
				tx.TxIn = append([]*wire.TxIn{message}, tx.TxIn...)
				vin++
			}
			s := &spend{tx: tx, coins: []coin{tt.source}, proof: proof}
			require.NoError(t, script.Execute(tx, s, vin, tt.opts...))
		})
	}
}

// oracle is a price check the contracts can be built with, as the tests drive it: its file in
// oracles/, the key a contract holds for a signer, and the witness that satisfies the check.
type oracle struct {
	name string
	key  func(*btcec.PrivateKey) value
	sign func(t *testing.T, signer *btcec.PrivateKey, price, quoteTime int64) wire.TxWitness
}

var (
	dia = oracle{
		name: "dia",
		key:  oracleKey,
		sign: func(
			t *testing.T, signer *btcec.PrivateKey, price, quoteTime int64,
		) wire.TxWitness {
			raw := new(big.Int).Mul(big.NewInt(price), big.NewInt(1e16))
			u := diaUpdate{raw: raw, time: quoteTime, nonce: 7, expiry: time.Now().Unix() + 3600}
			return u.witness(t, signer)
		},
	}
	schnorrOracle = oracle{
		name: "schnorr",
		key: func(k *btcec.PrivateKey) value {
			return value{Type: "bytes", Raw: schnorr.SerializePubKey(k.PubKey())}
		},
		sign: func(
			t *testing.T, signer *btcec.PrivateKey, price, quoteTime int64,
		) wire.TxWitness {
			digest := sha256.Sum256(append(le8(price), le8(quoteTime)...))
			sig, err := schnorr.Sign(signer, digest[:])
			require.NoError(t, err)
			return wire.TxWitness{sig.Serialize()}
		},
	}
)

type market struct {
	oracle                   oracle
	keys                     template.Keys
	oracleSk, traderSk, lpSk *btcec.PrivateKey
	position, offer          *built
	traderProgram, lpProgram []byte
}

type positionState struct {
	side, entry, notional, margin, houseMargin, startAt, expiry int64
	traderPk, traderProgram, lpProgram                          []byte
	carry                                                       int64
}

type offerState struct {
	lpPk, lpProgram                         []byte
	spread, maxLeverage, maxDuration, carry int64
}

type fillCase struct {
	side, leverage, capBps, limit, duration, deadline int64
	margin, liquidity                                 int64
	spread, maxLeverage, maxDuration                  int64
	carry, maxCarry, maxSpread                        int64
	price, quoteTime                                  int64
	state                                             positionState
	positionValue, offerChange                        int64
	dropOfferState, forgedQuote                       bool
}

type coin struct {
	op  wire.OutPoint
	out *wire.TxOut
	tx  *wire.MsgTx
}

// spend is a transaction and the coins it spends; a proof's first input is its message.
type spend struct {
	tx    *wire.MsgTx
	coins []coin
	proof bool
}

func newMarket(t *testing.T) *market {
	t.Helper()
	return newMarketOn(t, dia)
}

// newMarketOn builds the market's contracts with the price check of an oracle.
func newMarketOn(t *testing.T, o oracle) *market {
	t.Helper()
	key := func() *btcec.PrivateKey {
		k, err := btcec.NewPrivateKey()
		require.NoError(t, err)
		return k
	}
	m := &market{
		oracle:        o,
		keys:          template.Keys{Server: key().PubKey(), Emulator: key().PubKey()},
		oracleSk:      key(),
		traderSk:      key(),
		lpSk:          key(),
		traderProgram: xonly(key()),
		lpProgram:     xonly(key()),
	}
	m.position = m.build(t, "position", map[string]value{
		"oraclePk":      m.oracle.key(m.oracleSk),
		"renewalWindow": number(renewalWindow), "maxFee": number(maxFee),
	})
	m.offer = m.build(t, "offer", map[string]value{
		"oraclePk":        m.oracle.key(m.oracleSk),
		"positionProgram": bytes32(m.position.PkScript[2:]),
		"renewalWindow":   number(renewalWindow), "maxFee": number(maxFee),
	})
	return m
}

func (m *market) build(
	t *testing.T, name string, args map[string]value,
) *built {
	t.Helper()
	a, err := artifact.Parse(contractOn(t, m.oracle.name, name))
	require.NoError(t, err)
	def := a.Definition()
	c, err := buildContract(&def, args, m.keys)
	require.NoError(t, err)
	return c
}

func (m *market) tradeDeposit(t *testing.T, c fillCase) *built {
	t.Helper()
	return m.build(t, "trade_deposit", map[string]value{
		"oraclePk":        m.oracle.key(m.oracleSk),
		"positionProgram": bytes32(m.position.PkScript[2:]),
		"traderPk":        pubkey(m.traderSk),
		"traderProgram":   bytes32(m.traderProgram),
		"side":            number(c.side),
		"leverage":        number(c.leverage),
		"capBps":          number(c.capBps),
		"limitPrice":      number(c.limit),
		"duration":        number(c.duration),
		"deadline":        number(c.deadline),
		"maxCarryBps":     number(c.maxCarry),
		"maxSpreadBps":    number(c.maxSpread),
		"exitDelay":       number(exitDelay),
	})
}

func (m *market) offerDeposit(t *testing.T, s offerState) *built {
	t.Helper()
	return m.build(t, "offer_deposit", map[string]value{
		"offerProgram": bytes32(m.offer.PkScript[2:]),
		"lpPk":         pubkey(m.lpSk),
		"lpProgram":    bytes32(s.lpProgram),
		"spreadBps":    number(s.spread),
		"maxLeverage":  number(s.maxLeverage),
		"maxDuration":  number(s.maxDuration),
		"carryBps":     number(s.carry),
		"exitDelay":    number(exitDelay),
	})
}

// defaultFill is a 10x long of 100,000 sats opened at $100,000 plus a 10 bps spread.
func (m *market) defaultFill(quoteTime int64) fillCase {
	return fillCase{
		side: 0, leverage: 10, capBps: 100_000, limit: 10_050_000,
		duration: 86400, deadline: time.Now().Unix() + 600,
		margin: 100_000, liquidity: 5_000_000,
		spread: 10, maxLeverage: 50, maxDuration: 7 * 86400, maxCarry: 100, maxSpread: 10,
		price: 10_000_000, quoteTime: quoteTime,
		state: positionState{
			side: 0, entry: 10_010_000, notional: 1_000_000,
			margin: 100_000, houseMargin: 1_000_000,
			startAt: quoteTime, expiry: quoteTime + 86400,
			traderPk: xonly(m.traderSk), traderProgram: m.traderProgram,
			lpProgram: m.lpProgram,
		},
		positionValue: 1_100_000, offerChange: 4_000_000,
	}
}

// fill runs the two covenants of a fill and returns each one's verdict.
func (m *market) fill(t *testing.T, c fillCase) map[string]error {
	t.Helper()
	s, oracleSig := m.fillSpend(t, c)
	return map[string]error{
		"deposit": s.exec(0, m.tradeDeposit(t, c).Covenants["fill"], oracleSig),
		"offer":   s.exec(1, m.offer.Covenants["fill"], oracleSig),
	}
}

// fillSpend is the transaction of a fill: the deposit and the offer in, the position and the
// offer out.
func (m *market) fillSpend(t *testing.T, c fillCase) (*spend, wire.TxWitness) {
	t.Helper()
	deposit := m.tradeDeposit(t, c)
	offer := offerState{
		lpPk: xonly(m.lpSk), lpProgram: m.lpProgram,
		spread: c.spread, maxLeverage: c.maxLeverage, maxDuration: c.maxDuration,
		carry: c.carry,
	}
	signer := m.oracleSk
	if c.forgedQuote {
		signer = m.traderSk
	}
	quote, oracleSig := m.signQuote(t, signer, c.price, c.quoteTime)
	packets := []extension.Packet{quote, c.state.packet()}
	if !c.dropOfferState {
		packets = append(packets, offer.packet())
	}
	s := newSpend(
		t,
		[]coin{
			newCoin(t, deposit.PkScript, c.margin),
			newCoin(t, m.offer.PkScript, c.liquidity, offer.packet()),
		},
		[]*wire.TxOut{
			wire.NewTxOut(c.positionValue, m.position.PkScript),
			wire.NewTxOut(c.offerChange, m.offer.PkScript),
		},
		packets...,
	)
	return s, oracleSig
}

// settlement spends a position and pays both sides what the payoff says at the signed price.
func (m *market) settlement(
	t *testing.T, state positionState, price, quoteTime int64, tamper func([]*wire.TxOut),
) (*spend, []*wire.TxOut, wire.TxWitness) {
	t.Helper()
	pot := state.margin + state.houseMargin
	house := min(state.houseShare(price, quoteTime), pot)
	trader := pot - house
	var outs []*wire.TxOut
	switch {
	case house > dust && trader > dust:
		outs = append(
			outs, wire.NewTxOut(trader, p2tr(state.traderProgram)),
			wire.NewTxOut(house, p2tr(state.lpProgram)),
		)
	case house <= dust:
		outs = append(outs, wire.NewTxOut(pot, p2tr(state.traderProgram)))
	default:
		outs = append(outs, wire.NewTxOut(pot, p2tr(state.lpProgram)))
	}
	if tamper != nil {
		tamper(outs)
	}
	quote, oracleSig := m.signQuote(t, m.oracleSk, price, quoteTime)
	s := newSpend(
		t, []coin{newCoin(t, m.position.PkScript, pot, state.packet())}, outs, quote,
	)
	return s, outs, oracleSig
}

// settlementAt is settlement with the quote packet given, for updates built by hand.
func (m *market) settlementAt(
	t *testing.T, state positionState, price, quoteTime int64, quote extension.Packet,
) (*spend, []*wire.TxOut, wire.TxWitness) {
	t.Helper()
	s, outs, witness := m.settlement(t, state, price, quoteTime, nil)
	return newSpend(t, s.coins, outs, quote), outs, witness
}

func (s positionState) packet() extension.Packet {
	data := []byte{0x01}
	for _, n := range []int64{
		s.side, s.entry, s.notional, s.margin, s.houseMargin, s.startAt, s.expiry,
	} {
		data = append(data, le8(n)...)
	}
	data = append(data, s.traderPk...)
	data = append(data, s.traderProgram...)
	data = append(data, s.lpProgram...)
	data = append(data, le8(s.carry)...)
	return extension.UnknownPacket{PacketType: positionPacket, Data: data}
}

// resolvable says whether the payoff lets anyone settle at a price signed at quoteTime: past
// expiry, or with a side down to its last hundredth of the margin.
func (s positionState) resolvable(price, quoteTime int64) bool {
	share, buffer := s.houseShare(price, quoteTime), s.margin/100
	exhausted := share <= buffer || share >= s.margin+s.houseMargin-buffer
	return quoteTime >= s.startAt && (quoteTime >= s.expiry || exhausted)
}

// houseShare is the payoff the position script must agree with: the provider's margin, less the
// trader's profit, plus the holding fee accrued until quoteTime or the expiry.
func (s positionState) houseShare(price, quoteTime int64) int64 {
	pnl := s.notional * (price - s.entry) / price
	if s.side == 1 {
		pnl = -pnl
	}
	held := max(min(quoteTime, s.expiry)-s.startAt, 0)
	fee := s.notional * s.carry * held / 864_000_000
	return min(max(s.houseMargin-pnl+fee, 0), s.margin+s.houseMargin)
}

func (s offerState) packet() extension.Packet {
	data := append([]byte{0x01}, s.lpPk...)
	data = append(data, s.lpProgram...)
	for _, n := range []int64{s.spread, s.maxLeverage, s.maxDuration, s.carry} {
		data = append(data, le8(n)...)
	}
	return extension.UnknownPacket{PacketType: offerPacket, Data: data}
}

func newCoin(t *testing.T, pkScript []byte, value int64, packets ...extension.Packet) coin {
	t.Helper()
	tx := wire.NewMsgTx(3)
	var parent wire.OutPoint
	copy(parent.Hash[:], random32(t))
	tx.AddTxIn(wire.NewTxIn(&parent, nil, nil))
	out := wire.NewTxOut(value, pkScript)
	tx.AddTxOut(out)
	addExtension(t, tx, packets)
	return coin{op: wire.OutPoint{Hash: tx.TxHash(), Index: 0}, out: out, tx: tx}
}

func newSpend(
	t *testing.T, coins []coin, outs []*wire.TxOut, packets ...extension.Packet,
) *spend {
	t.Helper()
	tx := wire.NewMsgTx(3)
	for _, c := range coins {
		tx.AddTxIn(wire.NewTxIn(&c.op, nil, nil))
	}
	for _, out := range outs {
		tx.AddTxOut(out)
	}
	addExtension(t, tx, packets)
	return &spend{tx: tx, coins: coins}
}

func addExtension(t *testing.T, tx *wire.MsgTx, packets []extension.Packet) {
	t.Helper()
	if len(packets) == 0 {
		return
	}
	ext, err := extension.NewExtensionFromPackets(packets...)
	require.NoError(t, err)
	out, err := ext.TxOut()
	require.NoError(t, err)
	tx.AddTxOut(out)
}

func (s *spend) add(c coin) {
	s.tx.AddTxIn(wire.NewTxIn(&c.op, nil, nil))
	s.coins = append(s.coins, c)
}

// exec runs one input's Arkade Script in the emulator's engine against the spend.
func (s *spend) exec(
	vin int, script []byte, witness wire.TxWitness, opts ...arkade.ExecuteOption,
) error {
	vm, err := arkade.NewEngine(
		script, s.tx, vin, txscript.NewSigCache(10), txscript.NewTxSigHashes(s.tx, s),
		s.coins[vin].out.Value, s,
	)
	if err != nil {
		return err
	}
	for _, opt := range opts {
		opt(vm)
	}
	if len(witness) > 0 {
		vm.SetStack(witness)
	}
	return vm.Execute()
}

func (s *spend) FetchPrevOutput(op wire.OutPoint) *wire.TxOut {
	for _, c := range s.coins {
		if c.op == op {
			return c.out
		}
	}
	if s.proof && op == s.tx.TxIn[0].PreviousOutPoint {
		return wire.NewTxOut(0, nil)
	}
	return nil
}

func (s *spend) FetchPrevOutArkTx(op wire.OutPoint) *wire.MsgTx {
	for _, c := range s.coins {
		if c.op == op {
			return c.tx
		}
	}
	return nil
}

func (s *spend) FetchVtxoPrevOutPkScript(op wire.OutPoint) []byte {
	if out := s.FetchPrevOutput(op); out != nil {
		return out.PkScript
	}
	return nil
}

// diaUpdate is a DIA OracleUpdate for BTC/USD: a price with 18 decimals and the time it was
// taken, valid until expiry.
type diaUpdate struct {
	raw                 *big.Int
	time, nonce, expiry int64
}

// signQuote returns the quote packet for a price in cents and the witness that makes the
// market's price check take it.
func (m *market) signQuote(
	t *testing.T, signer *btcec.PrivateKey, price, quoteTime int64,
) (extension.Packet, wire.TxWitness) {
	t.Helper()
	return quoteOf(price, quoteTime), m.oracle.sign(t, signer, price, quoteTime)
}

func quoteOf(price, quoteTime int64) extension.Packet {
	data := append([]byte{0x01}, le8(price)...)
	return extension.UnknownPacket{PacketType: quotePacket, Data: append(data, le8(quoteTime)...)}
}

// witness signs the update the way DIA does, an EIP-712 OracleIntent of its registry on Lasernet,
// and lays the stack out as the scripts read it: signature, expiry, nonce, then price on top.
func (u diaUpdate) witness(t *testing.T, signer *btcec.PrivateKey) wire.TxWitness {
	t.Helper()
	word := func(n int64) []byte { return big.NewInt(n).FillBytes(make([]byte, 32)) }
	registry, ok := new(big.Int).SetString("5612599CF48032d7428399d5Fcb99eDcc75c06A7", 16)
	require.True(t, ok)
	domain := keccak(
		keccak([]byte("EIP712Domain(string name,string version,uint256 chainId,"+
			"address verifyingContract,bytes32 salt)")),
		keccak([]byte("DIA Oracle")), keccak([]byte("1.0")), word(1050),
		registry.FillBytes(make([]byte, 32)), word(0),
	)
	body := keccak(
		keccak([]byte("OracleIntent(string intentType,string version,uint256 chainId,"+
			"uint256 nonce,uint256 expiry,string symbol,uint256 price,uint256 timestamp,"+
			"string source)")),
		keccak([]byte("OracleUpdate")), keccak([]byte("1.0")), word(1050), word(u.nonce),
		word(u.expiry), keccak([]byte("BTC/USD")), u.raw.FillBytes(make([]byte, 32)),
		word(u.time), keccak([]byte("DIA Oracle")),
	)
	sig := ecdsa.SignCompact(signer, keccak([]byte{0x19, 0x01}, domain, body), true)
	return wire.TxWitness{
		sig[1:], scriptNum(u.expiry), scriptNum(u.nonce), bigNum(u.raw),
	}
}

func keccak(parts ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

// bigNum encodes a non-negative integer as a minimal script number.
func bigNum(n *big.Int) []byte {
	b := n.Bytes()
	slices.Reverse(b)
	if len(b) > 0 && b[len(b)-1]&0x80 != 0 {
		b = append(b, 0)
	}
	return b
}

// oracleKey is a price signer's key as the scripts take it: an ECDSA key, marked 0x10.
func oracleKey(k *btcec.PrivateKey) value {
	return value{Type: "bytes", Raw: append([]byte{0x10}, k.PubKey().SerializeCompressed()...)}
}

// signOutpoint signs sha256(action | txid | vout), the message close and withdraw check.
func signOutpoint(
	t *testing.T, signer *btcec.PrivateKey, action string, op wire.OutPoint,
) []byte {
	t.Helper()
	msg := append([]byte(action), op.Hash[:]...)
	msg = binary.LittleEndian.AppendUint32(msg, op.Index)
	digest := sha256.Sum256(msg)
	sig, err := schnorr.Sign(signer, digest[:])
	require.NoError(t, err)
	return sig.Serialize()
}

// contractOn returns the artifact of a contract built with the price check of an oracle.
func contractOn(t *testing.T, oracle, name string) []byte {
	t.Helper()
	contract, err := os.ReadFile(filepath.Join("src", name+".json"))
	require.NoError(t, err)
	check, err := os.ReadFile(filepath.Join("oracles", oracle+".json"))
	require.NoError(t, err)
	return withOracle(t, contract, check)
}

// withOracle returns a contract's source with an oracle's inputs and price check in place of
// each "$oracle" marker.
func withOracle(t *testing.T, contract, check []byte) []byte {
	t.Helper()
	decode := func(raw []byte, into any) {
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber()
		require.NoError(t, d.Decode(into))
	}
	var doc map[string]any
	decode(contract, &doc)
	var o struct {
		Inputs []any `json:"inputs"`
		Asm    []any `json:"asm"`
	}
	decode(check, &o)
	splice := func(list any, marks func(any) bool, with []any) []any {
		out := []any{}
		for _, v := range list.([]any) {
			if marks(v) {
				out = append(out, with...)
				continue
			}
			out = append(out, v)
		}
		return out
	}
	for _, f := range doc["functions"].([]any) {
		code, ok := f.(map[string]any)["arkade"].(map[string]any)
		if !ok {
			continue
		}
		code["inputs"] = splice(code["inputs"], func(v any) bool {
			in, ok := v.(map[string]any)
			return ok && in["name"] == "$oracle"
		}, o.Inputs)
		code["asm"] = splice(code["asm"], func(v any) bool { return v == "$oracle" }, o.Asm)
	}
	var out bytes.Buffer
	e := json.NewEncoder(&out)
	e.SetEscapeHTML(false)
	e.SetIndent("", "  ")
	require.NoError(t, e.Encode(doc))
	return out.Bytes()
}

// requireGolden compares got with the pinned testdata file the app reads. UPDATE_VECTORS=1
// rewrites it.
func requireGolden(t *testing.T, name string, got map[string]string) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if os.Getenv("UPDATE_VECTORS") != "" {
		raw, err := json.MarshalIndent(got, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(path, append(raw, '\n'), 0o644))
	}
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var want map[string]string
	require.NoError(t, json.Unmarshal(raw, &want))
	require.Equal(t, want, got)
}

func artifactDocuments(t *testing.T) map[string][]byte {
	t.Helper()
	files, err := filepath.Glob(filepath.Join("src", "*.json"))
	require.NoError(t, err)
	docs := map[string][]byte{}
	for _, f := range files {
		raw := contractOn(t, dia.name, strings.TrimSuffix(filepath.Base(f), ".json"))
		a, err := artifact.Parse(raw)
		require.NoError(t, err)
		docs[a.ID()] = raw
	}
	return docs
}

func packetData(t *testing.T, p extension.Packet) []byte {
	t.Helper()
	data, err := p.Serialize()
	require.NoError(t, err)
	return data
}

func txPacket(t *testing.T, tx *wire.MsgTx, typ uint8) []byte {
	t.Helper()
	ext, err := extension.NewExtensionFromTx(tx)
	require.NoError(t, err)
	p := ext.GetPacketByType(typ)
	require.NotNil(t, p)
	return packetData(t, p)
}

func paid(outs []*wire.TxOut, program []byte) int64 {
	var total int64
	for _, out := range outs {
		if string(out.PkScript) == string(p2tr(program)) {
			total += out.Value
		}
	}
	return total
}

// ended is a position whose state claims an end date before its start.
func ended(s positionState) positionState {
	s.expiry = 0
	return s
}

func withCarry(s positionState, bps int64) positionState {
	s.carry = bps
	return s
}

func p2tr(program []byte) []byte { return append([]byte{txscript.OP_1, 32}, program...) }

func le8(n int64) []byte { return binary.LittleEndian.AppendUint64(nil, uint64(n)) }

func xonly(k *btcec.PrivateKey) []byte { return schnorr.SerializePubKey(k.PubKey()) }

func number(n int64) value { return value{Type: "int", Raw: scriptNum(n)} }

func bytes32(b []byte) value { return value{Type: "bytes32", Raw: b} }

func pubkey(k *btcec.PrivateKey) value {
	return value{Type: "pubkey", Raw: k.PubKey().SerializeCompressed()}
}

func random32(t *testing.T) []byte {
	t.Helper()
	b := make([]byte, 32)
	_, err := rand.Read(b)
	require.NoError(t, err)
	return b
}
