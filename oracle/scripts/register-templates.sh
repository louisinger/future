#!/bin/sh
# Registers the oracle contract and its renewal template on an executor, so it renews the
# oracle's outputs before they expire. Templates are registered on the executor's admin port
# (7081 by default), which only its operator can reach:
#   scripts/register-templates.sh http://localhost:7081
# The ids it prints are the ones in templates/ids.json; if they differ, the contract or the
# template changed and that file is stale.
set -eu
url=${1:?usage: register-templates.sh <executor admin url>}
cd "$(dirname "$0")/.."
post() {
  node -e 'process.stdout.write(JSON.stringify({document: require("fs").readFileSync(process.argv[1], "utf8")}))' "$2" |
    curl -sS --fail-with-body -X POST -H 'content-type: application/json' --data-binary @- "$url/v1/$1" |
    node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{const d=JSON.parse(s);console.log(process.argv[1],(d.artifact??d.template).id)})' "$2"
}
post artifact artifacts/dia_btc_usd_oracle.json
post template templates/renew_oracle.json
