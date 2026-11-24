package contracts

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/emulator/pkg/arkade"
	template "github.com/arkade-os/executor/pkg/template"
	"github.com/arkade-os/executor/pkg/template/artifact"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/txscript/v2"
)

var (
	decimalToken     = regexp.MustCompile(`^(0|-?[1-9][0-9]*)$`)
	hexToken         = regexp.MustCompile(`^0x([0-9a-f]{2})+$`)
	placeholderToken = regexp.MustCompile(`^<([^<>]+)>$`)
)

// value is a constructor argument: an int is a script number, a pubkey a compressed key.
type value struct {
	Type string
	Raw  []byte
}

// built is a contract bound to its arguments: its output script and each function's Arkade
// Script, assembled the way executord's template engine does.
type built struct {
	PkScript  []byte
	Covenants map[string][]byte
}

func buildContract(
	def *artifact.Definition, args map[string]value, keys template.Keys,
) (*built, error) {
	c := &built{Covenants: map[string][]byte{}}
	field := func(name string) ([]byte, bool, error) {
		v, ok := args[name]
		if !ok {
			return nil, false, fmt.Errorf("unknown constructor value %q", name)
		}
		if v.Type != "pubkey" {
			return v.Raw, v.Type == "int", nil
		}
		pk, err := btcec.ParsePubKey(v.Raw)
		if err != nil {
			return nil, false, err
		}
		return schnorr.SerializePubKey(pk), false, nil
	}
	for _, fn := range def.Functions {
		if fn.Arkade == nil {
			continue
		}
		s, err := assemble(fn.Arkade.Asm, field)
		if err != nil {
			return nil, fmt.Errorf("function %q: %w", fn.Name, err)
		}
		c.Covenants[fn.Name] = s
	}
	leaf := func(name string) ([]byte, bool, error) {
		parts := strings.Split(name, ":")
		switch {
		case name == "SERVER_KEY":
			return schnorr.SerializePubKey(keys.Server), false, nil
		case len(parts) == 2 && parts[0] == "EMULATOR_KEY":
			cov, ok := c.Covenants[parts[1]]
			if !ok {
				return nil, false, fmt.Errorf("function %q has no covenant", parts[1])
			}
			tweaked := arkade.ComputeArkadeScriptPublicKey(
				keys.Emulator, arkade.ArkadeScriptHash(cov),
			)
			return schnorr.SerializePubKey(tweaked), false, nil
		}
		return field(name)
	}
	var leaves []txscript.TapLeaf
	for _, fn := range def.Functions {
		for _, l := range fn.Leaves {
			s, err := assemble(l.Asm, leaf)
			if err != nil {
				return nil, fmt.Errorf("leaf %s/%s: %w", fn.Name, l.Name, err)
			}
			leaves = append(leaves, txscript.NewBaseTapLeaf(s))
		}
	}
	tree := txscript.AssembleTaprootScriptTree(leaves...)
	root := tree.RootNode.TapHash()
	var err error
	c.PkScript, err = script.P2TRScript(
		txscript.ComputeTaprootOutputKey(script.UnspendableKey(), root[:]),
	)
	return c, err
}

// assemble turns asm tokens into a script: opcodes, decimals, 0x hex pushes and <placeholders>,
// which lookup resolves to bytes or, when number is set, to a script number.
func assemble(
	tokens []string, lookup func(name string) (raw []byte, number bool, err error),
) ([]byte, error) {
	b := txscript.NewScriptBuilder()
	push := func(raw []byte) {
		if len(raw) == 1 && raw[0] == 0 {
			b.AddOps([]byte{txscript.OP_DATA_1, 0}) // AddData would emit OP_0
			return
		}
		b.AddData(raw)
	}
	for _, tok := range tokens {
		switch {
		case strings.HasPrefix(tok, "OP_"):
			op, ok := arkade.OpcodeByName[tok]
			if !ok {
				return nil, fmt.Errorf("unknown opcode %q", tok)
			}
			b.AddOp(op)
		case decimalToken.MatchString(tok):
			n, err := strconv.ParseInt(tok, 10, 64)
			if err != nil {
				return nil, err
			}
			b.AddInt64(n)
		case hexToken.MatchString(tok):
			raw := make([]byte, (len(tok)-2)/2)
			if _, err := fmt.Sscanf(tok[2:], "%x", &raw); err != nil {
				return nil, err
			}
			push(raw)
		case placeholderToken.MatchString(tok):
			raw, number, err := lookup(tok[1 : len(tok)-1])
			if err != nil {
				return nil, fmt.Errorf("%s: %w", tok, err)
			}
			if !number {
				push(raw)
				continue
			}
			n, err := arkade.MakeScriptNum(raw, true, 8)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", tok, err)
			}
			b.AddInt64(int64(n))
		default:
			return nil, fmt.Errorf("unsupported token %q", tok)
		}
	}
	return b.Script()
}

func scriptNum(n int64) []byte {
	b, _ := arkade.BigNumFromInt64(n).Bytes()
	return b
}
