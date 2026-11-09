#!/usr/bin/env bash
# Test de pagina's en het scanformulier tegen een draaiende server.
#
# Gebruik:
#   tests/api-tests.sh <adres> <stand>
#
#   <adres>  bijvoorbeeld http://127.0.0.1:8788 (wrangler pages dev) of https://jouwproject.pages.dev
#   <stand>  zonder-instellingen     de server heeft geen omgevingsvariabelen (een geldige aanvraag geeft 500)
#            nep-sleutel             de server heeft RESEND_API_KEY=nep, FROM_EMAIL en TO_EMAIL, zonder
#                                    TURNSTILE_SECRET_KEY (een geldige aanvraag geeft 502, want Resend weigert
#                                    de nepsleutel)
#            nep-sleutel-turnstile   zoals nep-sleutel, plus TURNSTILE_SECRET_KEY met de testsleutel van
#                                    Turnstile die altijd goedkeurt
#            mock                    dit script start zelf een nep-Resend en nep-Turnstile (tests/mock_server.py)
#                                    en wrangler op de poort uit <adres>, zonder TURNSTILE_SECRET_KEY, en kijkt
#                                    wat de functie naar Resend stuurt. Start dan zelf geen wrangler op die poort.
#                                    Nodig: python3 en wrangler (tests/node_modules/.bin/wrangler na npm ci in
#                                    tests/, of zet WRANGLER).
#            mock-turnstile          zoals mock, met TURNSTILE_SECRET_KEY (de testsleutel)
#
# De functie controleert de token van Turnstile alleen als TURNSTILE_SECRET_KEY er is (de standen met
# -turnstile) en turnstile_sitekey in config.json is ingevuld. Dit script leest config.json en weet zo wat
# het moet verwachten. Het gaat ervan uit dat de server dist/ uit deze map gebruikt.
#
# Er gaat bij deze tests nooit een echte mail weg: zonder instellingen, met een nepsleutel of met de
# nep-Resend komt er niets bij Resend aan. Test de echte mail met de hand, zie README.
set -u

BASE="${1:?Geef het adres, bijvoorbeeld http://127.0.0.1:8788}"
MODE="${2:?Geef de stand: zonder-instellingen, nep-sleutel, nep-sleutel-turnstile, mock of mock-turnstile}"
case "$MODE" in
  zonder-instellingen) VALID_EXPECT=500; SECRET=uit ;;
  nep-sleutel) VALID_EXPECT=502; SECRET=uit ;;
  nep-sleutel-turnstile) VALID_EXPECT=502; SECRET=aan ;;
  mock) VALID_EXPECT=200; SECRET=uit ;;
  mock-turnstile) VALID_EXPECT=200; SECRET=aan ;;
  *) echo "Onbekende stand: $MODE"; exit 2 ;;
esac
MOCK=""
case "$MODE" in mock*) MOCK=1 ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
config() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2], "").strip())' "$ROOT/config.json" "$1"; }
PHONE="$(config telefoon)"
# Turnstile op de pagina (sitekey in config.json) en in de functie (sitekey en TURNSTILE_SECRET_KEY samen).
PAGE_TS=uit
[ -n "$(config turnstile_sitekey)" ] && PAGE_TS=aan
TS=uit
[ "$PAGE_TS" = aan ] && [ "$SECRET" = aan ] && TS=aan
echo "Turnstile: op de pagina $PAGE_TS, TURNSTILE_SECRET_KEY $SECRET, dus de functie controleert de token: $TS"
TMP="$(mktemp -d)"
MOCK_PID=""
WRANGLER_PID=""
kill_tree() { # stopt een proces en alles wat het heeft gestart
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null
}
cleanup() {
  # Stoppen en wachten tot ze weg zijn, zodat de poort meteen weer vrij is.
  [ -n "$WRANGLER_PID" ] && kill_tree "$WRANGLER_PID" && wait "$WRANGLER_PID" 2>/dev/null
  [ -n "$MOCK_PID" ] && kill_tree "$MOCK_PID" && wait "$MOCK_PID" 2>/dev/null
  if [ -n "$MOCK" ]; then
    rm -f "$ROOT/.dev.vars"
    [ -e "$TMP/dev.vars.bewaard" ] && mv "$TMP/dev.vars.bewaard" "$ROOT/.dev.vars"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
PASS=0
FAIL=0

if [ -n "$MOCK" ]; then
  WRANGLER="${WRANGLER:-$ROOT/tests/node_modules/.bin/wrangler}"
  PORT="${BASE##*:}"
  MOCK_LOG="$TMP/mock.jsonl"
  python3 "$ROOT/tests/mock_server.py" "$MOCK_LOG" "$TMP/mock.port" &
  MOCK_PID=$!
  for _ in $(seq 50); do [ -s "$TMP/mock.port" ] && break; sleep 0.1; done
  MOCK_URL="http://127.0.0.1:$(cat "$TMP/mock.port")"
  # Een bestaand .dev.vars bewaren we en zetten we na afloop terug.
  [ -e "$ROOT/.dev.vars" ] && mv "$ROOT/.dev.vars" "$TMP/dev.vars.bewaard"
  # TURNSTILE_VERIFY_URL staat er altijd. Zo ziet de nep-Turnstile het als de functie hem vraagt terwijl
  # Turnstile uit staat.
  cat > "$ROOT/.dev.vars" <<EOF
RESEND_API_KEY=re_nep
FROM_EMAIL=formulier@example.com
TO_EMAIL=jij@example.com
RESEND_API_URL=$MOCK_URL/emails
TURNSTILE_VERIFY_URL=$MOCK_URL/siteverify
EOF
  [ "$SECRET" = aan ] && echo "TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA" >> "$ROOT/.dev.vars"
  (cd "$ROOT" && exec "$WRANGLER" pages dev dist --port "$PORT" --ip 127.0.0.1 > "$TMP/wrangler.log" 2>&1) &
  WRANGLER_PID=$!
  for _ in $(seq 120); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null)" = 200 ] && break
    sleep 0.5
  done
  echo "Nep-Resend en nep-Turnstile op $MOCK_URL, wrangler op $BASE"
fi

# request NAAM METHODE PAD [curl-opties...]: zet $STATUS, $BODY en $HEADERS
request() {
  local name="$1" method="$2" path="$3"
  shift 3
  STATUS="$(curl -s -X "$method" -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' --max-time 30 "$@" "$BASE$path")"
  # Alleen om te tonen bij een fout. Zonder nultekens, want een lettertype is binair.
  BODY="$(head -c 1000 "$TMP/body" | tr -d '\0')"
  HEADERS="$(tr -d '\r' < "$TMP/headers")"
  CURRENT="$name"
}

expect() { # expect OMSCHRIJVING VOORWAARDE...
  local what="$1"
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    printf 'OK    %-58s status %s\n' "$CURRENT: $what" "$STATUS"
  else
    FAIL=$((FAIL + 1))
    printf 'FOUT  %-58s status %s\n      body: %s\n' "$CURRENT: $what" "$STATUS" "${BODY:0:300}"
  fi
}

status_is() { [ "$STATUS" = "$1" ]; }
body_has() { grep -qF -- "$1" "$TMP/body"; }
body_lacks() { ! grep -qF -- "$1" "$TMP/body"; }
header_has() { grep -qiF -- "$1" <<<"$HEADERS"; }
header_lacks() { ! grep -qiF -- "$1" <<<"$HEADERS"; }
# Alleen in de standen mock en mock-turnstile: hoeveel verzoeken de nep-Resend en de nep-Turnstile kregen,
# of de log van wrangler een tekst bevat, en een Python-expressie over c, het laatste verzoek aan de
# nep-Resend ({"pad", "headers", "body"}).
resend_calls() { grep -c '"pad": "/emails"' "$MOCK_LOG" || true; }
siteverify_calls() { grep -c '"pad": "/siteverify"' "$MOCK_LOG" || true; }
log_has() { grep -qF -- "$1" "$TMP/wrangler.log"; }
last_resend() {
  python3 - "$MOCK_LOG" "$1" <<'PY'
import json, sys
calls = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
calls = [call for call in calls if call["pad"] == "/emails"]
c = calls[-1] if calls else None
sys.exit(0 if c is not None and eval(sys.argv[2]) else 1)
PY
}

TOKEN='XXXX.DUMMY.TOKEN.XXXX'
VALID='{"naam":"Test Persoon","bedrijf":"Testhoveniers","email":"test@example.com","telefoon":"0612345678","gemeente":"Huizen","website":"testhoveniers.nl","toestemming":"on","bedrijfswebsite_extra":"","cf-turnstile-response":"XXXX.DUMMY.TOKEN.XXXX"}'
JSON=(-H 'Content-Type: application/json' -H 'Accept: application/json')

echo "Pagina's"
request "GET /" GET /
expect "200" status_is 200
expect "Content-Security-Policy aanwezig" header_has "content-security-policy: default-src 'self'"
if [ "$PAGE_TS" = aan ]; then
  expect "CSP: scripts van de eigen site, Web Analytics en Turnstile" header_has "script-src 'self' https://static.cloudflareinsights.com https://challenges.cloudflare.com;"
  expect "CSP staat het iframe van Turnstile toe" header_has "frame-src https://challenges.cloudflare.com;"
  expect "pagina heeft het vak voor Turnstile" body_has 'id="f-turnstile"'
else
  expect "CSP: scripts alleen van de eigen site en Web Analytics" header_has "script-src 'self' https://static.cloudflareinsights.com;"
  expect "CSP noemt Turnstile niet (staat uit)" header_lacks "challenges.cloudflare.com"
  expect "pagina heeft geen vak voor Turnstile" body_lacks 'id="f-turnstile"'
fi
expect "CSP: lettertypen alleen van de eigen site" header_has "font-src 'self';"
expect "CSP: geen Google Fonts" bash -c '! grep -qiE "fonts\.(googleapis|gstatic)\.com" <<<"$0"' "$HEADERS"
expect "pagina laadt de lettertypen van de eigen site" body_has '<link rel="stylesheet" href="/fonts/fonts.css">'
expect "pagina noemt Google Fonts niet" bash -c '! grep -qE "fonts\.(googleapis|gstatic)\.com" "$0"' "$TMP/body"
expect "X-Content-Type-Options: nosniff" header_has "x-content-type-options: nosniff"
expect "Referrer-Policy" header_has "referrer-policy: strict-origin-when-cross-origin"
expect "Permissions-Policy" header_has "permissions-policy: camera=()"
expect "X-Frame-Options: DENY" header_has "x-frame-options: DENY"

request "GET /privacy" GET /privacy
expect "200" status_is 200
expect "is de privacyverklaring" body_has "<h1>Privacyverklaring</h1>"

request "GET /privacy.html" GET /privacy.html
expect "redirect naar /privacy (Pages haalt .html weg)" bash -c '[[ "$0" =~ ^30[178]$ ]]' "$STATUS"
expect "Location: /privacy" header_has "location: /privacy"
request "GET /privacy.html (redirect gevolgd)" GET /privacy.html -L
expect "200 na redirect" status_is 200

request "GET /bestaat-niet" GET /bestaat-niet
expect "404" status_is 404
expect "eigen 404-pagina" body_has "Deze pagina staat niet op de tekening."
expect "CSP ook op de 404-pagina" header_has "content-security-policy:"

for f in /favicon.svg /robots.txt /sitemap.xml /main.js; do
  request "GET $f" GET "$f"
  expect "200" status_is 200
done

request "GET /fonts/fonts.css" GET /fonts/fonts.css
expect "200" status_is 200
expect "Content-Type: text/css" header_has "content-type: text/css"
FONT_FILES="$(grep -o '[A-Za-z0-9-]*\.woff2' "$TMP/body" | sort -u)"
expect "noemt vijf woff2-bestanden" test "$(wc -w <<<"$FONT_FILES")" -eq 5
for f in $FONT_FILES; do
  request "GET /fonts/$f" GET "/fonts/$f"
  expect "200" status_is 200
  expect "Content-Type: font/woff2" header_has "content-type: font/woff2"
  expect "is een woff2-bestand" test "$(head -c 4 "$TMP/body")" = wOF2
done

echo
echo "Formulier: POST /api/scan"
request "leeg verzoek" POST /api/scan "${JSON[@]}" --data '{}'
expect "400" status_is 400
expect "noemt wat ontbreekt" body_has 'Vul nog in: je naam, de naam van je bedrijf, een geldig e-mailadres, je gemeente.'
expect "noemt ook het vinkje" body_has 'Zet ook het vinkje'

request "velden ontbreken" POST /api/scan "${JSON[@]}" --data '{"naam":"Test","email":"geen-adres","toestemming":"on"}'
expect "400" status_is 400
expect "ontbreekt: bedrijf, email, gemeente" body_has '"ontbreekt":["bedrijf","email","gemeente"]'

request "zonder toestemming" POST /api/scan "${JSON[@]}" --data "${VALID/\"toestemming\":\"on\"/\"toestemming\":\"\"}"
expect "400" status_is 400
expect "alleen het vinkje ontbreekt" body_has '"ontbreekt":["toestemming"]'

request "te lang veld" POST /api/scan "${JSON[@]}" --data "${VALID/Test Persoon/$(printf 'x%.0s' {1..101})}"
expect "400" status_is 400
expect "noemt te lang veld" body_has '"te_lang":["naam"]'

for adres in 'a@b..c' 'test@example.com.' '.a@b.c' 'a@[1.2.3.4]' 'jürgen@müller.de' 'Max <a@b.c>' 'a@b.c,d@e.f'; do
  request "e-mailadres $adres" POST /api/scan "${JSON[@]}" --data "${VALID/test@example.com/$adres}"
  expect "400, alleen e-mail ontbreekt" body_has '"ontbreekt":["email"]'
done

request "gemeente niet uit de lijst" POST /api/scan "${JSON[@]}" --data "${VALID/Huizen/Huizen Subject: x}"
expect "400, gemeente ontbreekt" body_has '"ontbreekt":["gemeente"]'

[ -n "$MOCK" ] && CALLS_BEFORE="$(resend_calls)"
request "honeypot ingevuld" POST /api/scan "${JSON[@]}" --data "${VALID/\"bedrijfswebsite_extra\":\"\"/\"bedrijfswebsite_extra\":\"http://spam.example\"}"
expect "200 en niets verstuurd" status_is 200
expect "antwoord {\"ok\":true}" body_has '{"ok":true}'
[ -n "$MOCK" ] && expect "geen verzoek aan Resend" test "$(resend_calls)" -eq "$CALLS_BEFORE"

request "zonder token van de spamcontrole" POST /api/scan "${JSON[@]}" --data "${VALID/$TOKEN/}"
if [ "$TS" = aan ]; then
  expect "403" status_is 403
  expect "noemt de spamcontrole" body_has 'De controle tegen spam ontbreekt.'
else
  expect "$VALID_EXPECT, want Turnstile staat uit en de token is niet nodig" status_is "$VALID_EXPECT"
fi

request "geldige aanvraag (JSON)" POST /api/scan "${JSON[@]}" --data "$VALID"
expect "$VALID_EXPECT" status_is "$VALID_EXPECT"
case "$VALID_EXPECT" in
  500) expect "zegt dat het formulier nog niet klaar is" body_has 'Het formulier is nog niet klaar voor gebruik.'
       expect "noemt geen instellingen" body_lacks 'RESEND_API_KEY' ;;
  502) expect "meldt dat versturen niet lukte" body_has 'Versturen lukte niet.'
       expect "noemt geen status van Resend" body_lacks 'resend_status' ;;
  200) expect "antwoord {\"ok\":true}" body_has '{"ok":true}' ;;
esac
expect "Cache-Control: no-store" header_has "cache-control: no-store"
expect "X-Content-Type-Options: nosniff" header_has "x-content-type-options: nosniff"

if [ -n "$MOCK" ]; then
  if [ "$TS" = aan ]; then
    expect "de functie liet de token controleren door de nep-Turnstile" test "$(siteverify_calls)" -ge 1
  else
    expect "de functie vroeg Turnstile niets, want Turnstile staat uit" test "$(siteverify_calls)" -eq 0
  fi
  expect "Resend krijgt alleen from, to, reply_to, subject en text" \
    last_resend 'sorted(c["body"]) == ["from", "reply_to", "subject", "text", "to"]'
  expect "reply_to is het adres uit het formulier" last_resend 'c["body"]["reply_to"] == "test@example.com"'
  expect "onderwerp met bedrijf en gemeente" last_resend 'c["body"]["subject"] == "Scanaanvraag: Testhoveniers (Huizen)"'
  expect "beide vinkjes staan in de tekst" \
    last_resend '"Vinkje 1 (verplicht): aan." in c["body"]["text"] and "Vinkje 2 (vervolgberichten): uit" in c["body"]["text"]'
  expect "naam in From staat tussen aanhalingstekens" last_resend 'c["body"]["from"].startswith(chr(34)) and c["body"]["from"].endswith(chr(34) + " <formulier@example.com>")'
  expect "User-Agent en Idempotency-Key meegestuurd" \
    last_resend 'c["headers"].get("user-agent") and c["headers"].get("idempotency-key", "").startswith("scan-")'
fi

request "geldige aanvraag (formulier, geen JavaScript)" POST /api/scan -H 'Accept: text/html' \
  --data-urlencode 'naam=Test Persoon' --data-urlencode 'bedrijf=Testhoveniers' \
  --data-urlencode 'email=test@example.com' --data-urlencode 'gemeente=Huizen' --data-urlencode 'toestemming=on' \
  --data-urlencode 'bedrijfswebsite_extra=' --data-urlencode "cf-turnstile-response=$TOKEN"
expect "$VALID_EXPECT met HTML-pagina" status_is "$VALID_EXPECT"
expect "HTML-antwoord" header_has "content-type: text/html"
[ -n "$MOCK" ] && expect "sleutel uit datum en inhoud (scan- en 64 hextekens)" \
  last_resend 'len(c["headers"]["idempotency-key"]) == 69 and all(t in "0123456789abcdef" for t in c["headers"]["idempotency-key"][5:])'

request "formulier zonder token (geen JavaScript)" POST /api/scan -H 'Accept: text/html' \
  --data-urlencode 'naam=Test Persoon' --data-urlencode 'bedrijf=Testhoveniers' \
  --data-urlencode 'email=test@example.com' --data-urlencode 'gemeente=Huizen' --data-urlencode 'toestemming=on'
if [ "$TS" = aan ]; then
  expect "403 met HTML-pagina" status_is 403
  expect "noemt het telefoonnummer" body_has "Bellen of appen kan ook: $PHONE."
else
  expect "$VALID_EXPECT met HTML-pagina, want Turnstile staat uit" status_is "$VALID_EXPECT"
  if [ "$VALID_EXPECT" = 200 ]; then
    expect "zegt dat de scan komt" body_has 'Je scan komt binnen twee werkdagen in je mailbox.'
  else
    expect "noemt het telefoonnummer" body_has "Bellen of appen kan ook: $PHONE."
  fi
fi

request "formulier zonder velden (geen JavaScript)" POST /api/scan -H 'Accept: text/html' --data 'naam='
expect "400 met HTML-pagina" status_is 400
expect "noemt wat ontbreekt" body_has 'Vul nog in:'
expect "wijst naar de terugknop" body_has 'Ga met de terugknop van je browser terug naar het formulier.'
expect "geen link die het formulier leeg laadt" body_lacks 'href="/#scan"'

request "van een andere site (Origin)" POST /api/scan "${JSON[@]}" -H 'Origin: https://andere-site.example' --data "$VALID"
expect "403" status_is 403

request "verkeerd formaat" POST /api/scan -H 'Content-Type: text/plain' --data 'hallo'
expect "415" status_is 415

request "multipart (bestanden)" POST /api/scan -F 'naam=Test' -F "cf-turnstile-response=$TOKEN"
expect "415" status_is 415

request "kapotte JSON" POST /api/scan "${JSON[@]}" --data '{"naam":'
expect "400" status_is 400

request "te groot" POST /api/scan "${JSON[@]}" --data "{\"naam\":\"$(head -c 20000 /dev/zero | tr '\0' 'x')\"}"
expect "413" status_is 413

printf '{"naam":"%s"}' "$(head -c 20000 /dev/zero | tr '\0' 'x')" > "$TMP/groot.json"
request "te groot zonder Content-Length (JSON, chunked)" POST /api/scan "${JSON[@]}" \
  -H 'Transfer-Encoding: chunked' --data-binary @"$TMP/groot.json"
expect "413" status_is 413
printf 'naam=%s' "$(head -c 20000 /dev/zero | tr '\0' 'x')" > "$TMP/groot.txt"
request "te groot zonder Content-Length (formulier, chunked)" POST /api/scan \
  -H 'Content-Type: application/x-www-form-urlencoded' -H 'Transfer-Encoding: chunked' --data-binary @"$TMP/groot.txt"
expect "413" status_is 413

request "GET /api/scan" GET /api/scan
expect "405" status_is 405
expect "Allow: POST" header_has "allow: POST"

request "PUT /api/scan" PUT /api/scan "${JSON[@]}" --data "$VALID"
expect "405" status_is 405

if [ -n "$MOCK" ]; then
  echo
  echo "Wat de functie naar Resend stuurt (nep-Resend)"
  WITH_ID="${VALID/\"toestemming\":\"on\"/\"toestemming\":\"on\",\"vervolg\":\"on\",\"aanvraag_id\":\"test-0000-0001\"}"
  request "met aanvraag_id en vinkje 2" POST /api/scan "${JSON[@]}" --data "$WITH_ID"
  expect "200" status_is 200
  expect "Idempotency-Key is scan- plus het id" last_resend 'c["headers"]["idempotency-key"] == "scan-test-0000-0001"'
  expect "vinkje 2 staat aan in de tekst" last_resend '"Vinkje 2 (vervolgberichten): aan." in c["body"]["text"]'

  CALLS_BEFORE="$(resend_calls)"
  request "token klopt niet" POST /api/scan "${JSON[@]}" --data "${VALID/$TOKEN/fout}"
  if [ "$TS" = aan ]; then
    expect "403" status_is 403
    expect "geen verzoek aan Resend" test "$(resend_calls)" -eq "$CALLS_BEFORE"
  else
    expect "200, want Turnstile staat uit en de token telt niet" status_is 200
    expect "wel een verzoek aan Resend" test "$(resend_calls)" -eq "$((CALLS_BEFORE + 1))"
  fi

  CALLS_BEFORE="$(resend_calls)"
  request "Resend weigert reply_to (422)" POST /api/scan "${JSON[@]}" --data "${WITH_ID/test-0000-0001/test-replyto-0001}"
  expect "200 na een tweede poging" status_is 200
  expect "twee verzoeken aan Resend" test "$(resend_calls)" -eq "$((CALLS_BEFORE + 2))"
  expect "tweede poging zonder reply_to, met waarschuwing" \
    last_resend '"reply_to" not in c["body"] and "LET OP: Resend weigerde" in c["body"]["text"]'

  request "sleutel al gebruikt (409)" POST /api/scan "${JSON[@]}" --data "${WITH_ID/test-0000-0001/test-dubbel-0001}"
  expect "200 met een nieuwe sleutel" status_is 200
  expect "nieuwe sleutel eindigt op -opnieuw" last_resend 'c["headers"]["idempotency-key"] == "scan-test-dubbel-0001-opnieuw"'

  request "limiet van Resend (429)" POST /api/scan "${JSON[@]}" --data "${WITH_ID/test-0000-0001/test-quotum-0001}"
  expect "502" status_is 502
  expect "vraagt te bellen, met nummer" body_has "Bel of app ons op $PHONE"
  expect "noemt geen status van Resend" body_lacks 'resend_status'

  CONTROL='{"naam":"Test Persoon","bedrijf":"Testhoveniers","email":"test@example.com","telefoon":"06\u0085­123‮","gemeente":"Huizen","toestemming":"on","cf-turnstile-response":"XXXX.DUMMY.TOKEN.XXXX"}'
  request "stuurtekens in velden" POST /api/scan "${JSON[@]}" --data "$CONTROL"
  expect "200" status_is 200
  expect "geen stuurtekens of onzichtbare tekens in de mail" \
    last_resend '"Telefoon: 06 123\n" in c["body"]["text"] and not any(0x80 <= ord(t) <= 0x9f or t in "­‮" for t in c["body"]["text"])'

  echo
  echo "Meldingen van de functie in de log van wrangler"
  CURRENT="log"
  case "$PAGE_TS/$SECRET" in
    uit/uit) expect "waarschuwing: Turnstile staat uit" log_has "scan: Turnstile staat uit (geen TURNSTILE_SECRET_KEY)" ;;
    uit/aan) expect "fout: TURNSTILE_SECRET_KEY zonder sitekey" log_has "maar turnstile_sitekey in config.json is leeg" ;;
    aan/uit) expect "waarschuwing: sitekey zonder TURNSTILE_SECRET_KEY" log_has "maar TURNSTILE_SECRET_KEY ontbreekt" ;;
    aan/aan) expect "geen melding dat Turnstile uit staat" \
      bash -c '! grep -qE "Turnstile staat uit|config.json is leeg|TURNSTILE_SECRET_KEY ontbreekt" "$0"' "$TMP/wrangler.log" ;;
  esac
fi

echo
echo "$PASS OK, $FAIL FOUT"
[ "$FAIL" -eq 0 ]
