# Website (werknaam Groen Gevonden)

Dit is de website van je bedrijf, klaar om online te zetten met Cloudflare Pages.
De bedrijfsnaam, het domein en de contactgegevens staan op één plek: `config.json`.
Verander je de naam of het domein, dan pas je alleen dat bestand aan.

Inloggen, accounts aanmaken en betalen doe jij of je ouder. De rest kan Claude doen.

## Wat staat waar

| Pad | Wat het is |
|---|---|
| `config.json` | Bedrijfsnaam, domein, e-mail, telefoon, eigenaar, KvK-nummer, btw-id, plaats en contactpersoon. |
| `src/index.html` | De homepage met het scanformulier. |
| `src/privacy.html` | De privacyverklaring. Een kopie van `website/privacy.html` van 9 november 2026. |
| `src/404.html` | De pagina voor een adres dat niet bestaat. |
| `src/main.js` | De kopieerknop en het versturen van het formulier. |
| `src/favicon.svg` | Het logo (speld met blad) als icoontje in het tabblad. |
| `src/robots.txt`, `src/sitemap.xml` | Voor zoekmachines. |
| `src/_headers` | Beveiligingsheaders, zoals de Content-Security-Policy (CSP). |
| `functions/api/scan.js` | Ontvangt het formulier op `/api/scan` en mailt de aanvraag via Resend. |
| `build.py` | Bouwt `src/` naar `dist/` en vult de gegevens uit `config.json` in. |
| `tests/` | Controles na een wijziging. Zie "Testen". |
| `dist/` | Wordt gemaakt door `build.py`. Staat niet in git. |

Een `_redirects`-bestand is niet nodig. Cloudflare Pages stuurt `/privacy.html` zelf door naar `/privacy`
([bron](https://developers.cloudflare.com/pages/configuration/serving-pages/)). Lokaal gaf dat een 308.

## Naam of domein veranderen

Pas één regel aan in `config.json`, bijvoorbeeld:

```json
"bedrijfsnaam": "Nieuwe Naam",
"domein": "nieuwenaam.nl",
```

Draai daarna `python3 build.py`. De nieuwe naam staat dan overal: titel, logo, teksten, footer,
privacyverklaring, het vinkje bij het formulier, de gegevens voor Google (JSON-LD), sitemap en robots.txt.
De functie voor het formulier leest `config.json` ook. Zo klopt ook de afzendernaam van de mail.

Bij een nieuw domein regel je buiten deze map nog drie dingen:

- het domein koppelen in Cloudflare Pages (zie "Eigen domein koppelen");
- het domein toevoegen in Resend en `FROM_EMAIL` aanpassen;
- de privacyverklaring bijwerken, als die het oude domein noemt.

### Invulvelden tussen [ ]

In `config.json` staan nog invulvelden: `[e-mailadres]`, `[naam ouder]`, `[KvK-nummer]`, `[btw-id]`
en `Max [achternaam]`. De site toont die tekst met een stippellijn eronder.
Vul je een echte waarde in, dan verdwijnt de stippellijn. Een echt e-mailadres wordt in de footer een klikbare link.

Controleer voor de echte lancering:

```
python3 build.py --streng
```

Die stopt met een fout zolang er nog iets tussen [ ] staat.

## Bouwen

```
python3 build.py
```

- Kopieert `src/` naar `dist/` en vult elke `{{sleutel}}` in met de waarde uit `config.json`.
- Werkt in `.html`, `.xml`, `.svg`, `.txt`, `_headers` en `_redirects`. Tekens als `&` en `<` worden veilig gemaakt.
- Staat er daarna nog ergens `{{`, of klopt `config.json` niet, dan stopt de build met exitcode 1 en is er geen `dist/`.
  Cloudflare Pages markeert de build dan als mislukt en zet niets online
  ([bron](https://developers.cloudflare.com/pages/configuration/build-configuration/)).
- Alleen standaard Python, geen pakketten. Getest met Python 3.8, 3.11, 3.12 en 3.13.
  De build image van Cloudflare (v3) heeft standaard Python 3.13.3
  ([bron](https://developers.cloudflare.com/pages/configuration/build-image/)).

Controleer daarna het resultaat:

```
python3 tests/check_dist.py
```

## Online zetten met Cloudflare Pages

### Manier 1 (aanbevolen): via GitHub

1. Zet deze map in een eigen GitHub-repository. Privé mag.
2. Ga in het Cloudflare-dashboard naar **Workers & Pages** > **Create application** > **Pages** > **Connect to Git**.
   Kies **GitHub**, kies de repository, dan **Install & Authorize** en **Begin setup**
   ([bron](https://developers.cloudflare.com/pages/get-started/git-integration/)).
3. Vul bij **Set up builds and deployments** in:
   - Framework preset: geen (None)
   - Build command: `python3 build.py`
   - Build output directory: `dist`
   - Root directory: leeg laten. De map `functions/` staat in de hoofdmap, naast `build.py`. Daar zoekt Cloudflare hem.
4. Kies **Save and Deploy**.
5. Zet de omgevingsvariabelen (zie hieronder). Start daarna een nieuwe deployment, bijvoorbeeld door een nieuwe commit te pushen.

Let op:

- Dat het commando in de build image `python3` heet, staat niet letterlijk in de docs van Cloudflare (niet geverifieerd).
  Zie je in de buildlog `python3: command not found`, gebruik dan `python build.py`.
- Kies je voor GitHub, dan kun je later niet meer overstappen op Direct Upload
  ([bron](https://developers.cloudflare.com/pages/get-started/git-integration/)).

### Manier 2: dist/ meesturen in git

Wil je dat Cloudflare niets hoeft te bouwen? Dan stuur je `dist/` zelf mee.

1. Haal de regel `dist/` weg uit `.gitignore`.
2. Draai `python3 build.py` en commit `dist/` mee.
3. Laat in Cloudflare **Build command** leeg en zet **Build output directory** op `dist`
   ([bron](https://developers.cloudflare.com/pages/configuration/build-configuration/)).

Nadeel: na elke wijziging moet je zelf bouwen en `dist/` opnieuw committen. Vergeet je dat, dan blijft de oude versie online.

### Manier 3: Direct Upload met wrangler (zonder GitHub)

Vanuit deze map:

```
python3 build.py
npx wrangler pages deploy dist --project-name=<projectnaam>
```

- Draai dit vanuit de map waar `functions/` staat. Dan gaat de functie mee
  ([bron](https://developers.cloudflare.com/pages/get-started/direct-upload/)).
- Uploaden door te slepen in het dashboard neemt `functions/` niet mee. Het formulier werkt dan niet (zelfde bron).
- Wrangler heeft `CLOUDFLARE_API_TOKEN` en `CLOUDFLARE_ACCOUNT_ID` nodig. Maak de token aan bij **API Tokens** > **Create Token**
  met de rechten *Account*, *Cloudflare Pages*, *Edit*
  ([bron](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)).
- Een Direct Upload-project kun je later niet omzetten naar GitHub
  ([bron](https://developers.cloudflare.com/pages/get-started/direct-upload/)).

### Eigen domein koppelen

1. **Workers & Pages** > je project > **Custom domains** > **Set up a domain**. Vul het domein in en kies **Continue**
   ([bron](https://developers.cloudflare.com/pages/configuration/custom-domains/)).
2. Voor het hoofddomein (zonder www) moet het domein een zone zijn in hetzelfde Cloudflare-account,
   met de nameservers van Cloudflare (zelfde bron).
3. Maak niet zelf eerst een CNAME-record aan. Koppel het domein eerst in Pages, anders krijg je fout 522 (zelfde bron).
4. www doorsturen naar het hoofddomein gaat met Bulk Redirects plus een proxied A-record `www` naar `192.0.2.1`
   ([bron](https://developers.cloudflare.com/pages/how-to/www-redirect/)).

De adressen op `pages.dev` krijgen via `_headers` de header `X-Robots-Tag: noindex`.
Zo toont Google alleen je eigen domein ([bron](https://developers.cloudflare.com/pages/configuration/headers/)).
Zolang je nog geen eigen domein hebt gekoppeld, is de site dus niet te vinden in Google.

### Web Analytics aanzetten

**Workers & Pages** > je project > **Metrics** > **Enable** bij Web Analytics.
Cloudflare zet het script er bij de volgende deployment zelf in
([bron](https://developers.cloudflare.com/pages/how-to/web-analytics/)).
De CSP in `src/_headers` staat dat script al toe ([bron](https://developers.cloudflare.com/web-analytics/faq/)).

### E-mailadres in de footer

Cloudflare verbergt e-mailadressen op je site standaard voor spambots (Email Address Obfuscation).
Het zet daarvoor een klein script op de pagina
([bron](https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/)).
Of dat goed samengaat met de strenge CSP van deze site is niet getest (niet geverifieerd).
Kijk na de lancering of je e-mailadres in de footer goed leesbaar is.
Zie je `[email protected]`, zet dan **Email Address Obfuscation** uit bij **Security** > **Settings** (zelfde bron).

## Omgevingsvariabelen

Zet deze in Cloudflare bij **Workers & Pages** > je project > **Settings** > **Variables and Secrets** > **Add**
([bron](https://developers.cloudflare.com/pages/functions/bindings/)):

| Naam | Wat vul je in | Soort |
|---|---|---|
| `RESEND_API_KEY` | De API-sleutel van Resend. Die begint met `re_` ([bron](https://resend.com/docs/api-reference/emails/send-email)). | Secret: kies **Encrypt** |
| `FROM_EMAIL` | De afzender op je geverifieerde domein, bijvoorbeeld `formulier@groen-gevonden.nl`. De bedrijfsnaam zet de functie er zelf voor. | Gewone variabele |
| `TO_EMAIL` | Waar de aanvragen heen moeten, bijvoorbeeld het Google Workspace-adres van Max. Meerdere adressen scheid je met een komma. | Gewone variabele |

Deploy opnieuw na een wijziging. Pas dan gebruikt de functie de nieuwe waarden (zelfde bron).
Ontbreekt er een van de drie, dan krijgt de bezoeker een nette foutmelding (status 500) en gaat er niets weg.

### Resend instellen

1. Maak een account aan op resend.com. Het gratis plan heeft 3.000 mails per maand, 100 per dag en 3 domeinen
   (gecontroleerd op 9 november 2026, [bron](https://resend.com/pricing)).
2. Voeg je domein toe bij **Domains**. Staat je DNS bij Cloudflare, dan kan dat met de knop **Sign in to Cloudflare**.
   Resend zet de DNS-records dan zelf ([bron](https://resend.com/docs/knowledge-base/cloudflare)).
   Het MX-record van Resend komt op `send.<jouw domein>`, niet op het hoofddomein waar de mail van Google Workspace binnenkomt (zelfde bron).
3. Maak een API-sleutel met alleen verzendrechten (`sending_access`)
   ([bron](https://resend.com/docs/api-reference/api-keys/create-api-key)). Zet die in Cloudflare als secret `RESEND_API_KEY`.

Goed om te weten: Resend weigert verzoeken zonder `User-Agent`-header met een 403
([bron](https://resend.com/docs/api-reference/introduction)). De functie stuurt die header mee.

## Testen

### 1. Na elke wijziging: bouwen en controleren

```
python3 build.py
python3 tests/check_dist.py
```

Dit controleert onder meer: geen `{{` meer, alle HTML-tags gesloten, interne links en ankers kloppen,
JSON-LD klopt met `config.json`, geen inline scripts, dezelfde toestemmingstekst in pagina en functie,
en de bedrijfsnaam en het domein staan alleen in `config.json`.

### 2. Het formulier lokaal testen (er gaat geen mail weg)

Je hebt Node.js nodig. Start vanuit deze map, dan vindt wrangler de map `functions/`:

```
npx wrangler@4 pages dev dist --port 8788
```

Draai in een tweede terminal:

```
tests/api-tests.sh http://127.0.0.1:8788 zonder-instellingen
```

Dit test de pagina's, de headers en het formulier. Een geldige aanvraag geeft hier 500, want er zijn nog geen instellingen.

Testen met een nepsleutel: maak in deze map een bestand `.dev.vars`
([bron](https://developers.cloudflare.com/pages/functions/bindings/)):

```
RESEND_API_KEY=nep
FROM_EMAIL=formulier@example.com
TO_EMAIL=jij@example.com
```

Start wrangler opnieuw en draai `tests/api-tests.sh http://127.0.0.1:8788 nep-sleutel`.
Een geldige aanvraag geeft dan 502, want Resend weigert de nepsleutel.
`.dev.vars` staat in `.gitignore`. Gooi het bestand weg als je klaar bent.

Browsertest met Playwright: `node tests/browser-check.cjs http://127.0.0.1:8788 500` (of `502` met de nepsleutel).
Die kijkt of er geen fouten in de console staan, of de CSP niets blokkeert en of de foutmelding netjes op de pagina komt.

Eén verzoek met de hand:

```
curl -i -X POST http://127.0.0.1:8788/api/scan \
  -H 'Content-Type: application/json' \
  -d '{"naam":"Test","bedrijf":"Testhoveniers","email":"test@example.com","gemeente":"Huizen","toestemming":"on"}'
```

### 3. Online testen met een echte mail

Als de variabelen staan en je opnieuw hebt gedeployd:

1. Vul het formulier op de site in met je eigen e-mailadres en zet het vinkje aan.
2. Je ziet: "Dank je. Je scan komt binnen twee werkdagen in je mailbox."
3. Op `TO_EMAIL` komt een mail met als onderwerp `Scanaanvraag: <bedrijf> (<gemeente>)`.
   Antwoord je erop, dan gaat je antwoord naar het adres uit het formulier.
4. Gaat er iets mis? Bekijk de logs bij **Workers & Pages** > je project > de deployment > **View details** > **Functions**
   ([bron](https://developers.cloudflare.com/pages/functions/debugging-and-logging/)).

### Wat de statuscodes betekenen

| Status | Betekenis |
|---|---|
| 200 | Verstuurd. Of de honeypot was ingevuld: dan lijkt het gelukt, maar gaat er niets weg. |
| 400 | Een verplicht veld ontbreekt of is te lang, of het vinkje staat uit. De melding zegt wat. |
| 403 | Het verzoek kwam van een andere website. |
| 405 | Geen POST. |
| 413, 415 | Te groot, of geen JSON en geen formulier. |
| 500 | `RESEND_API_KEY`, `FROM_EMAIL` of `TO_EMAIL` ontbreekt. Het antwoord noemt welke. |
| 502 | Resend weigerde of was niet bereikbaar. `resend_status` in het antwoord zegt meer: 401 is een verkeerde sleutel, 403 meestal een domein dat niet geverifieerd is of een `FROM_EMAIL` op een ander domein, 429 is een limiet ([bron](https://resend.com/docs/api-reference/errors)). |

## Zo werkt het formulier

- `main.js` controleert de velden in de browser en stuurt ze als JSON naar `/api/scan`.
- Het verborgen veld `bedrijfswebsite_extra` is een val voor spambots. Mensen zien het niet.
  Is het ingevuld, dan antwoordt de functie 200 en verstuurt ze niets.
- Zonder JavaScript werkt het formulier ook. De browser stuurt het dan gewoon naar `/api/scan` en krijgt een korte pagina terug.
- De functie controleert alles opnieuw, haalt enters en onzichtbare tekens weg en stuurt een platte-tekstmail via Resend.
  In de mail staan alle velden, de tekst bij het vinkje en het tijdstip (ISO, UTC). Dat is je bewijs van toestemming.
- De headers uit `_headers` gelden niet voor de functie. De functie zet daarom zelf `Cache-Control: no-store`
  en `X-Content-Type-Options: nosniff` ([bron](https://developers.cloudflare.com/pages/configuration/headers/)).
- Op het gratis plan telt elke verzending als 1 van de 100.000 verzoeken per dag voor Functions en Workers samen.
  Pagina's en bestanden tellen niet mee ([bron](https://developers.cloudflare.com/pages/functions/pricing/)).

Pas je de tekst bij het vinkje aan? Doe dat in `src/index.html` én in `functions/api/scan.js` (`CONSENT_TEXT`).
`tests/check_dist.py` meldt het als ze verschillen.

## Nog te doen

- De invulvelden in `config.json` invullen: e-mailadres, naam ouder, KvK-nummer, btw-id en achternaam.
- Resend: account, domein verifiëren en API-sleutel. Daarna de drie variabelen in Cloudflare zetten.
- De lettertypen komen van servers van Google (fonts.googleapis.com en fonts.gstatic.com).
  Google ziet daardoor het IP-adres van elke bezoeker. Google Fonts staat niet in de privacyverklaring.
  Je kunt de lettertypen ook zelf hosten. Dan kunnen die twee adressen uit de CSP.
- Er is nog geen afbeelding voor als iemand de link deelt (`og:image`).
- `src/privacy.html` is een kopie. Verandert de privacyverklaring, werk dan ook deze kopie bij.
  Neem daarbij mee: het formulier vraagt ook de gemeente, en de mail gaat via Resend (de tekst noemt alleen Cloudflare).
- Schema.org noemt het type `ProfessionalService` verouderd voor lokale bedrijven
  ([bron](https://schema.org/ProfessionalService)). Wil je dat netjes, zet dan in `src/index.html` `"@type": "LocalBusiness"`
  en pas `tests/check_dist.py` mee aan.
