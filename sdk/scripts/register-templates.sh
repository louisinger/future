#!/bin/sh
# Registers the market's contracts and templates on an executor, so it publishes offers and
# refunds late deposits by itself. An executor takes templates on its admin port (7081 by
# default), and on its public port too when it runs with EXECUTOR_PUBLIC_REGISTRY=true:
#   scripts/register-templates.sh http://localhost:7081
# Add "renew" to also register the templates that renew offers and positions before their coins
# expire:
#   scripts/register-templates.sh http://localhost:7081 renew
set -eu
url=${1:?usage: register-templates.sh <executor admin url> [renew]}
cd "$(dirname "$0")/../contracts"
post() {
  node -e 'process.stdout.write(JSON.stringify({document: require("fs").readFileSync(process.argv[1], "utf8")}))' "$2" |
    curl -sS --fail-with-body -X POST -H 'content-type: application/json' --data-binary @- "$url/v1/$1" >/dev/null
  echo "registered $2"
}
for f in artifacts/*.json; do post artifact "$f"; done
for f in executor-templates/register_offer.json executor-templates/refund_trade.json; do
  post template "$f"
done
if [ "${2:-}" = renew ]; then
  for f in executor-templates/renew_offer.json executor-templates/renew_position.json; do
    post template "$f"
  done
fi
