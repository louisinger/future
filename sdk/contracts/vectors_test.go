package contracts

import (
	"bytes"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	template "github.com/arkade-os/executor/pkg/template"
	"github.com/arkade-os/executor/pkg/template/artifact"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/stretchr/testify/require"
)

// TestVectors pins the output script of each contract for fixed keys and arguments. The app's
// TypeScript derivation is checked against the same file, so the scripts these tests execute are
// the ones the app deploys. UPDATE_VECTORS=1 rewrites it.
func TestVectors(t *testing.T) {
	key := func(b byte) *btcec.PrivateKey {
		k, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{b}, 32))
		return k
	}
	pub := func(b byte) value {
		return value{Type: "pubkey", Raw: key(b).PubKey().SerializeCompressed()}
	}
	program := func(b byte) value {
		return value{Type: "bytes32", Raw: schnorr.SerializePubKey(key(b).PubKey())}
	}
	num := func(n int64) value { return value{Type: "int", Raw: scriptNum(n)} }
	keys := template.Keys{Server: key(1).PubKey(), Emulator: key(2).PubKey()}
	build := func(name string, args map[string]value) *built {
		raw, err := os.ReadFile(filepath.Join("artifacts", name+".json"))
		require.NoError(t, err)
		a, err := artifact.Parse(raw)
		require.NoError(t, err)
		def := a.Definition()
		c, err := buildContract(&def, args, keys)
		require.NoError(t, err)
		return c
	}

	oracleTxid := value{Type: "bytes32", Raw: bytes.Repeat([]byte{3}, 32)}
	got := map[string]string{}
	position := build("position", map[string]value{
		"oracleTxid": oracleTxid, "oracleGidx": num(0), "renewalWindow": num(86400), "maxFee": num(1000),
		"exitKey": unspendable(), "exitDelay": num(4194308),
	})
	positionProgram := value{Type: "bytes32", Raw: position.PkScript[2:]}
	offer := build("offer", map[string]value{
		"oracleTxid": oracleTxid, "oracleGidx": num(0), "positionProgram": positionProgram,
		"renewalWindow": num(86400), "maxFee": num(1000),
		"exitKey": unspendable(), "exitDelay": num(4194308),
	})
	offerDeposit := build("offer_deposit", map[string]value{
		"offerProgram": {Type: "bytes32", Raw: offer.PkScript[2:]},
		"lpPk":         pub(5), "lpProgram": program(7),
		"spreadBps": num(10), "maxLeverage": num(50), "maxDuration": num(604800),
		"carryBps": num(25), "exitDelay": num(4194308),
	})
	tradeDeposit := build("trade_deposit", map[string]value{
		"oracleTxid": oracleTxid, "oracleGidx": num(0), "maxSpreadBps": num(10),
		"positionProgram": positionProgram,
		"traderPk":        pub(4), "traderProgram": program(6),
		"side": num(1), "leverage": num(10), "capBps": num(20000), "limitPrice": num(5_940_000),
		"duration": num(86400), "deadline": num(1_800_000_000), "maxCarryBps": num(100),
		"exitDelay": num(4194308),
	})

	got["position"] = hex.EncodeToString(position.PkScript)
	got["offer"] = hex.EncodeToString(offer.PkScript)
	got["offer_deposit"] = hex.EncodeToString(offerDeposit.PkScript)
	got["trade_deposit"] = hex.EncodeToString(tradeDeposit.PkScript)
	requireGolden(t, "vectors.json", got)
}
