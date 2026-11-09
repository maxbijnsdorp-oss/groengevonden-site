#!/usr/bin/env bash
# Draait alle tests na elkaar, voor de site zonder Turnstile en met Turnstile (de testsleutel van Cloudflare):
#   tests/check_build.py (één keer): de strenge controle van build.py, het btw-id en de privacyverklaring
#   python3 build.py en tests/check_dist.py
#   tests/api-tests.sh in alle vijf standen, dus zonder en met TURNSTILE_SECRET_KEY
#   tests/browser-check.cjs in dezelfde standen, behalve mock
# Alles gebeurt in tijdelijke kopieën van deze map. config.json, .dev.vars en dist/ hier blijven zoals ze zijn.
#
# Gebruik: tests/alle-tests.sh [poort]      (standaard 8790)
# Nodig: python3, node, en wrangler en Playwright in tests/node_modules (zie README, "Testen"),
# of zet WRANGLER en NODE_PATH zelf. Voor de standen met nep-sleutel en voor Turnstile in de browser
# is internet nodig. Er gaat nooit een echte mail weg.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8790}"
BASE="http://127.0.0.1:$PORT"
TMP="$(mktemp -d)"
export WRANGLER="${WRANGLER:-$REPO/tests/node_modules/.bin/wrangler}"
[ -d "$REPO/tests/node_modules" ] && export NODE_PATH="$REPO/tests/node_modules${NODE_PATH:+:$NODE_PATH}"
# De testsleutels van Turnstile die altijd goedkeuren
# (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
TEST_SITEKEY=1x00000000000000000000AA
TEST_SECRET=1x0000000000000000000000000000000AA
NEP=(RESEND_API_KEY=nep FROM_EMAIL=formulier@example.com TO_EMAIL=jij@example.com)
SERVER_PID=""
OK=0
FOUT=0
SAMENVATTING=()

kill_tree() { # stopt een proces en alles wat het heeft gestart
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null
}
stop_server() {
  [ -n "$SERVER_PID" ] && kill_tree "$SERVER_PID" && wait "$SERVER_PID" 2>/dev/null
  SERVER_PID=""
}
trap 'stop_server; rm -rf "$TMP"' EXIT

# stap NAAM COMMANDO...: draait het commando, bewaart de uitvoer en onthoudt of het lukte.
stap() {
  local naam="$1" log="$TMP/stap-$((OK + FOUT + 1)).log" regel
  shift
  if "$@" > "$log" 2>&1; then
    OK=$((OK + 1))
    regel="OK    $naam"
  else
    FOUT=$((FOUT + 1))
    regel="FOUT  $naam"
    grep -E '^(FOUT|BOUWEN MISLUKT|  - )' -A1 "$log" | head -40
  fi
  regel="$regel: $(grep -E 'controles OK|OK, [0-9]+ FOUT|^Klaar:|^BOUWEN MISLUKT' "$log" | tail -n 1)"
  SAMENVATTING+=("$regel")
  echo "$regel"
}

# kopie NAAM SITEKEY: een kopie van deze map met deze sitekey in config.json (leeg: Turnstile uit).
# Zonder .git, dist, node_modules, .wrangler en .dev.vars. ../website/privacy.html gaat mee, dan kan
# check_dist.py de privacyverklaring ook in de kopie vergelijken.
kopie() {
  local dir="$TMP/$1/site"
  mkdir -p "$dir"
  tar -C "$REPO" --exclude=./.git --exclude=./dist --exclude=node_modules --exclude=./.wrangler \
    --exclude=./.dev.vars -cf - . | tar -C "$dir" -xf -
  if [ -f "$REPO/../website/privacy.html" ]; then
    mkdir -p "$TMP/$1/website" && cp "$REPO/../website/privacy.html" "$TMP/$1/website/"
  fi
  python3 - "$dir/config.json" "$2" <<'PY'
import json, sys
path, sitekey = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    cfg = json.load(f)
cfg["turnstile_sitekey"] = sitekey
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
  echo "$dir"
}

# server MAP [REGEL...]: start wrangler in MAP met deze regels in .dev.vars (zonder regels: geen .dev.vars).
server() {
  local dir="$1"
  shift
  rm -f "$dir/.dev.vars"
  [ $# -gt 0 ] && printf '%s\n' "$@" > "$dir/.dev.vars"
  (cd "$dir" && exec "$WRANGLER" pages dev dist --port "$PORT" --ip 127.0.0.1 > "$dir/../wrangler.log" 2>&1) &
  SERVER_PID=$!
  for _ in $(seq 120); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null)" = 200 ] && return 0
    sleep 0.5
  done
  return 1
}

echo "== Strenge controle van build.py"
stap "check_build.py" python3 "$REPO/tests/check_build.py"

for variant in zonder met; do
  if [ "$variant" = met ]; then sitekey="$TEST_SITEKEY"; else sitekey=""; fi
  echo "== Site $variant Turnstile"
  dir="$(kopie "$variant" "$sitekey")"
  stap "$variant Turnstile: build.py" python3 "$dir/build.py"
  stap "$variant Turnstile: check_dist.py" python3 "$dir/tests/check_dist.py"
  for stand in zonder-instellingen nep-sleutel nep-sleutel-turnstile; do
    case "$stand" in
      zonder-instellingen) vars=() ;;
      nep-sleutel) vars=("${NEP[@]}") ;;
      nep-sleutel-turnstile) vars=("${NEP[@]}" "TURNSTILE_SECRET_KEY=$TEST_SECRET") ;;
    esac
    if server "$dir" ${vars[@]+"${vars[@]}"}; then
      stap "$variant Turnstile: api-tests.sh $stand" "$dir/tests/api-tests.sh" "$BASE" "$stand"
      stap "$variant Turnstile: browser-check.cjs $stand" node "$dir/tests/browser-check.cjs" "$BASE" "$stand"
    else
      FOUT=$((FOUT + 1))
      SAMENVATTING+=("FOUT  $variant Turnstile: wrangler startte niet ($stand)")
      tail -n 20 "$dir/../wrangler.log"
    fi
    stop_server
  done
  for stand in mock mock-turnstile; do
    stap "$variant Turnstile: api-tests.sh $stand" "$dir/tests/api-tests.sh" "$BASE" "$stand"
  done
done

echo
echo "Samenvatting"
printf '%s\n' "${SAMENVATTING[@]}"
echo
echo "$OK stappen OK, $FOUT FOUT"
[ "$FOUT" -eq 0 ]
