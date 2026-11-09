#!/usr/bin/env bash
# Test de pagina's en het scanformulier tegen een draaiende server.
#
# Gebruik:
#   tests/api-tests.sh <adres> <stand>
#
#   <adres>  bijvoorbeeld http://127.0.0.1:8788 (wrangler pages dev) of https://jouwproject.pages.dev
#   <stand>  zonder-instellingen  de server heeft geen RESEND_API_KEY, FROM_EMAIL en TO_EMAIL
#                                 (een geldige aanvraag geeft dan 500)
#            nep-sleutel          de server heeft RESEND_API_KEY=nep (een geldige aanvraag geeft 502)
#
# Er gaat bij deze tests nooit een echte mail weg: zonder instellingen of met een nepsleutel
# weigert Resend (of komt de functie er niet aan toe). Test de echte mail met de hand, zie README.
set -u

BASE="${1:?Geef het adres, bijvoorbeeld http://127.0.0.1:8788}"
MODE="${2:?Geef de stand: zonder-instellingen of nep-sleutel}"
case "$MODE" in
  zonder-instellingen) VALID_EXPECT=500 ;;
  nep-sleutel) VALID_EXPECT=502 ;;
  *) echo "Onbekende stand: $MODE"; exit 2 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

# request NAAM METHODE PAD [curl-opties...]: zet $STATUS, $BODY en $HEADERS
request() {
  local name="$1" method="$2" path="$3"
  shift 3
  STATUS="$(curl -s -X "$method" -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' --max-time 30 "$@" "$BASE$path")"
  BODY="$(cat "$TMP/body")"
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
header_has() { grep -qiF -- "$1" <<<"$HEADERS"; }

VALID='{"naam":"Test Persoon","bedrijf":"Testhoveniers","email":"test@example.com","telefoon":"0612345678","gemeente":"Huizen","website":"testhoveniers.nl","toestemming":"on","bedrijfswebsite_extra":""}'
JSON=(-H 'Content-Type: application/json' -H 'Accept: application/json')

echo "Pagina's"
request "GET /" GET /
expect "200" status_is 200
expect "Content-Security-Policy aanwezig" header_has "content-security-policy: default-src 'self'"
expect "CSP zonder unsafe-inline voor scripts" header_has "script-src 'self' https://static.cloudflareinsights.com;"
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

request "honeypot ingevuld" POST /api/scan "${JSON[@]}" --data "${VALID/\"bedrijfswebsite_extra\":\"\"/\"bedrijfswebsite_extra\":\"http://spam.example\"}"
expect "200 en niets verstuurd" status_is 200
expect "antwoord {\"ok\":true}" body_has '{"ok":true}'

request "geldige aanvraag (JSON)" POST /api/scan "${JSON[@]}" --data "$VALID"
expect "$VALID_EXPECT" status_is "$VALID_EXPECT"
if [ "$VALID_EXPECT" = 500 ]; then
  expect "meldt ontbrekende instellingen" body_has '"ontbrekende_instellingen":["RESEND_API_KEY","FROM_EMAIL","TO_EMAIL"]'
else
  expect "meldt dat versturen niet lukte" body_has 'Versturen lukte niet.'
fi
expect "Cache-Control: no-store" header_has "cache-control: no-store"
expect "X-Content-Type-Options: nosniff" header_has "x-content-type-options: nosniff"

request "geldige aanvraag (formulier, geen JavaScript)" POST /api/scan -H 'Accept: text/html' \
  --data-urlencode 'naam=Test Persoon' --data-urlencode 'bedrijf=Testhoveniers' \
  --data-urlencode 'email=test@example.com' --data-urlencode 'gemeente=Huizen' --data-urlencode 'toestemming=on' \
  --data-urlencode 'bedrijfswebsite_extra='
expect "$VALID_EXPECT met HTML-pagina" status_is "$VALID_EXPECT"
expect "HTML-antwoord" header_has "content-type: text/html"

request "formulier zonder velden (geen JavaScript)" POST /api/scan -H 'Accept: text/html' --data 'naam='
expect "400 met HTML-pagina" status_is 400
expect "noemt wat ontbreekt" body_has 'Vul nog in:'

request "van een andere site (Origin)" POST /api/scan "${JSON[@]}" -H 'Origin: https://andere-site.example' --data "$VALID"
expect "403" status_is 403

request "verkeerd formaat" POST /api/scan -H 'Content-Type: text/plain' --data 'hallo'
expect "415" status_is 415

request "kapotte JSON" POST /api/scan "${JSON[@]}" --data '{"naam":'
expect "400" status_is 400

request "te groot" POST /api/scan "${JSON[@]}" --data "{\"naam\":\"$(head -c 20000 /dev/zero | tr '\0' 'x')\"}"
expect "413" status_is 413

request "GET /api/scan" GET /api/scan
expect "405" status_is 405
expect "Allow: POST" header_has "allow: POST"

request "PUT /api/scan" PUT /api/scan "${JSON[@]}" --data "$VALID"
expect "405" status_is 405

echo
echo "$PASS OK, $FAIL FOUT"
[ "$FAIL" -eq 0 ]
