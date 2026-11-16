# Website (werknaam Groen Gevonden)

Dit is de website van je bedrijf, klaar om online te zetten met Cloudflare Pages.
De bedrijfsnaam, het domein en de contactgegevens staan op één plek: `config.json`.
Verander je de naam of het domein, dan pas je alleen dat bestand aan.

Inloggen, accounts aanmaken en betalen doe jij of je ouder. De rest kan Claude doen.

## Wat staat waar

| Pad | Wat het is |
|---|---|
| `config.json` | Bedrijfsnaam, domein, e-mail, telefoon, eigenaar, KvK-nummer, btw-id, plaats, contactpersoon en de sitekey van Turnstile. Is die sitekey leeg, dan staat Turnstile uit. |
| `src/index.html` | De homepage met het scanformulier. |
| `src/privacy.html` | De privacyverklaring. Pas hem niet met de hand aan: `tools/sync_privacy.py` maakt hem uit deel 1 van `10-Privacyverklaring.md`. Zie "Privacyverklaring bijwerken". |
| `tools/sync_privacy.py`, `tools/privacy-bron.json` | Het script voor de privacyverklaring, en welke tekst op de site anders moet dan in de bron. |
| `src/404.html` | De pagina voor een adres dat niet bestaat. |
| `src/main.js` | De kopieerknop en het versturen van het formulier. Staat Turnstile aan, dan laadt het ook die spamcontrole. |
| `src/fonts/` | De lettertypen van de site, `fonts.css` met de regels die ze laden, en hun licenties. Zie "Lettertypen". |
| `src/favicon.svg` | Het logo (speld met blad) als icoontje in het tabblad. |
| `src/robots.txt`, `src/sitemap.xml` | Voor zoekmachines. |
| `src/_headers` | Beveiligingsheaders, zoals de Content-Security-Policy (CSP). |
| `functions/api/scan.js` | Ontvangt het formulier op `/api/scan`, controleert de token van Turnstile (als die aan staat) en mailt de aanvraag via Resend. |
| `build.py` | Bouwt `src/` naar `dist/` en vult de gegevens uit `config.json` in. |
| `tests/` | Controles na een wijziging. Zie "Testen". `tests/package.json` legt de versies van wrangler en Playwright vast. Het staat in `tests/` en niet in de hoofdmap, anders installeert Cloudflare Pages die pakketten bij elke build ([bron](https://developers.cloudflare.com/pages/configuration/build-image/)). |
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
privacyverklaring, de gegevens voor Google (JSON-LD), sitemap en robots.txt.
De functie voor het formulier leest `config.json` ook. Zo klopt ook de afzendernaam van de mail.
In de bedrijfsnaam mogen alleen letters, cijfers, spaties en de tekens `&`, `'`, `.` en `-` staan.
Anders stopt de build, want een komma of `@` in de naam maakt de afzender van de mail ongeldig.

Bij een nieuw domein regel je buiten deze map nog drie dingen:

- het domein koppelen in Cloudflare Pages (zie "Eigen domein koppelen");
- het subdomein `meldingen.<nieuw domein>` toevoegen in Resend en `FROM_EMAIL` aanpassen (zie "Resend instellen");
- de privacyverklaring bijwerken, als die het oude domein noemt.

### Invulvelden tussen [ ]

In `config.json` staan nog invulvelden: `[naam ouder]`, `[KvK-nummer]`, `[btw-id]`
en `Max [achternaam]`. De site toont die tekst met een stippellijn eronder.
Vul je een echte waarde in, dan verdwijnt de stippellijn. Een echt e-mailadres wordt in de footer een klikbare link.

Het btw-id is anders. Dat komt per brief van de Belastingdienst, binnen twee weken na de inschrijving bij de KvK
([bron](https://www.kvk.nl/advies-en-informatie/bedrijf-starten/btw-nummer-alles-wat-je-wil-weten/)).
Zolang `btw_id` nog `[btw-id]` is, staat de regel met het btw-id niet in de footer (`{{#btw_id}}` in `src/index.html`).
Komt de brief, vul dan `btw_id` in en zet een nieuwe versie online. Dan staat het btw-id onderaan de site.

`turnstile_sitekey` is leeg. Dan staat de spamcontrole Turnstile uit, en dat is goed zo.
Zet je Turnstile later aan, dan komt hier de sitekey van je widget. Zie "Turnstile aanzetten (als er spam binnenkomt)".

Controleer voor de echte lancering:

```
python3 build.py --streng
```

Die stopt met een fout zolang er nog iets tussen [ ] staat, behalve bij `btw_id`. Ook als `turnstile_sitekey` nog de testsleutel
van Cloudflare is (`1x00000000000000000000AA`, [bron](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)),
of als Turnstile aan staat en de privacyverklaring dat niet zegt: ze noemt Turnstile niet, of nog met "als we dit aanzetten".
Het KvK-nummer, het e-mailadres en de namen moeten er dus in staan. Het btw-id mag later (zie hierboven).
Op Cloudflare Pages gaat dit vanzelf: een build van de productiebranch `main` is altijd streng.
Cloudflare geeft de naam van de branch door in `CF_PAGES_BRANCH`
([bron](https://developers.cloudflare.com/pages/configuration/build-configuration/)).
Een build van een andere branch (een preview) mag nog invulvelden hebben.
Heet je productiebranch anders, pas dan `PRODUCTIE_BRANCH` bovenin `build.py` aan.

## Bouwen

```
python3 build.py
```

- Kopieert `src/` naar `dist/` en vult elke `{{sleutel}}` in met de waarde uit `config.json`.
- Werkt in `.html`, `.xml`, `.svg`, `.txt`, `_headers` en `_redirects`. Tekens als `&` en `<` worden veilig gemaakt.
- Een stuk tussen `{{#sleutel}}` en `{{/sleutel}}` blijft alleen staan als die sleutel in `config.json` is ingevuld:
  niet leeg en geen tekst tussen [ ]. Zo komen het vak van Turnstile (in `src/index.html`) en de adressen van Turnstile
  in de CSP (in `src/_headers`) alleen op de site als `turnstile_sitekey` is ingevuld. En de regel met het btw-id
  in de footer pas als `btw_id` is ingevuld.
- De build zegt of Turnstile aan of uit staat. Staat Turnstile aan en zegt de privacyverklaring dat niet
  (ze noemt Turnstile niet, of nog met "als we dit aanzetten"), dan waarschuwt hij. Met `--streng` stopt hij dan.
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

## Lettertypen

De site gebruikt drie lettertypen: Young Serif (koppen), Atkinson Hyperlegible (tekst, gewoon en vet)
en IBM Plex Mono (labels en cijfers, gewicht 400 en 500). Ze staan op de site zelf, in `src/fonts/`.
Een bezoeker laadt dus niets van Google. Google ziet zijn IP-adres niet, en de site hoeft Google Fonts
niet in de privacyverklaring te noemen. De CSP in `src/_headers` staat lettertypen alleen van de eigen site toe (`font-src 'self'`).

- `src/fonts/fonts.css` zegt welk bestand bij welk lettertype hoort. Elke pagina laadt dat bestand.
- `font-display: swap`: de tekst staat er meteen in een systeemletter en wisselt zodra het lettertype er is.
- Alleen de Latijnse tekens, net als bij Google Fonts. Dat is genoeg voor Nederlands, ook voor é, ë en ï.
  Een teken dat er niet in zit (zoals de pijl ← op de privacypagina of ł in een naam die iemand typt),
  toont de browser in een systeemletter.
- De bestanden komen van Google Fonts (fonts.gstatic.com), opgehaald op 9 november 2026:
  Young Serif v2, Atkinson Hyperlegible v12 en IBM Plex Mono v20.
- Licentie: alle drie vallen onder de SIL Open Font License 1.1. Je mag ze gebruiken en meesturen,
  ook voor een bedrijf, zolang de licentie erbij blijft. Die staat in `src/fonts/OFL-*.txt`
  (uit [google/fonts](https://github.com/google/fonts/tree/main/ofl)) en komt mee online.

Een lettertype bijwerken of toevoegen: vraag de CSS op bij Google Fonts met de User-Agent van een gewone browser,
bijvoorbeeld `https://fonts.googleapis.com/css2?family=Young+Serif&display=swap`. Neem uit het blok `/* latin */`
het adres van het woff2-bestand en de `unicode-range`. Zet het bestand in `src/fonts/`, pas `fonts.css` aan en draai de tests.
`tests/check_dist.py` controleert welke vijf lettertypen er zijn. Pas daar `FONTS` mee aan.

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
   - Voor de branch `main` controleert `build.py` dan vanzelf streng (zie "Invulvelden tussen [ ]").
     Zolang er nog invulvelden zijn (behalve het btw-id), mislukt de build van `main` en zet Cloudflare niets nieuws online.
     Wil je eerder testen, push dan naar een andere branch, bijvoorbeeld `test`. Die krijgt een preview-adres
     zoals `test.<projectnaam>.pages.dev`. Let op: zo'n preview is standaard voor iedereen te openen
     ([bron](https://developers.cloudflare.com/pages/configuration/preview-deployments/)).
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
4. www doorsturen naar het hoofddomein gaat met een Redirect Rule (Single Redirect) in de zone van je domein:
   `https://www.*` naar `https://${1}`, status 301, query string behouden
   ([bron](https://developers.cloudflare.com/rules/url-forwarding/examples/redirect-www-to-root/)).
   Zet daarbij een proxied A-record `www` naar `192.0.2.1`. Een redirect werkt alleen op verkeer via Cloudflare
   ([bron](https://developers.cloudflare.com/pages/how-to/www-redirect/)).
   Gebruik geen Bulk Redirects: die horen bij het account, en de sleutel voor Claude heeft alleen *Zone*, *Single Redirect*, *Edit*.

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

## Voorlopige versie op GitHub Pages

Zolang er geen Cloudflare-account en geen eigen domein is, staat er een gratis voorlopige versie bij GitHub Pages:
https://maxbijnsdorp-oss.github.io/groengevonden-site/

Die versie staat in de map `docs/`. Je maakt hem zo opnieuw:

```bash
python3 build.py
python3 tools/maak_github_pages.py
```

Daarna leg je `docs/` vast en stuur je het naar GitHub. GitHub Pages toont de map `docs/` van de branch `main`
(Settings, Pages, "Deploy from a branch").

Wat anders is dan bij de echte site:

- Er staat `noindex` op elke pagina. Google neemt de voorlopige versie dus niet op.
- Het formulier verstuurt zelf niets. De knop opent het mailprogramma van de bezoeker met de aanvraag.
  GitHub Pages kan geen formulieren verwerken (`functions/api/scan.js` draait daar niet).
- Bovenaan staat "Voorlopige versie", en de privacypagina legt uit dat de site tijdelijk bij GitHub staat.
- De gebruikersnaam en de naam van de repository staan in `tools/github-pages.json`.

Zodra de site op Cloudflare Pages en het eigen domein staat, zet je GitHub Pages uit en verwijder je `docs/`.

## Omgevingsvariabelen

Zet deze in Cloudflare bij **Workers & Pages** > je project > **Settings** > **Variables and Secrets** > **Add**
([bron](https://developers.cloudflare.com/pages/functions/bindings/)):

| Naam | Wat vul je in | Soort | Verplicht |
|---|---|---|---|
| `RESEND_API_KEY` | De API-sleutel van Resend. Die begint met `re_` ([bron](https://resend.com/docs/api-reference/emails/send-email)). | Secret: kies **Encrypt** | Ja |
| `FROM_EMAIL` | De afzender op het subdomein dat je in Resend hebt geverifieerd: `formulier@meldingen.<jouw domein>` (zie "Resend instellen"). Een adres op het hoofddomein weigert Resend dan met een 403 ([bron](https://resend.com/docs/api-reference/errors)). De bedrijfsnaam zet de functie er zelf voor. | Gewone variabele | Ja |
| `TO_EMAIL` | Waar de aanvragen heen moeten: `groengevonden@gmail.com`. Later, met Google Workspace, kan dat een adres op je eigen domein zijn. Meerdere adressen scheid je met een komma. | Gewone variabele | Ja |
| `TURNSTILE_SECRET_KEY` | De secret key van je Turnstile-widget. Alleen als je Turnstile aanzet, zie "Turnstile aanzetten (als er spam binnenkomt)". | Secret: kies **Encrypt** | Nee |

Deploy opnieuw na een wijziging. Pas dan gebruikt de functie de nieuwe waarden (zelfde bron).
Ontbreekt er een van de drie verplichte, dan krijgt de bezoeker een nette foutmelding (status 500) en gaat er niets weg.
Welke ontbreekt, staat alleen in de logs van de functie, niet in het antwoord aan de bezoeker (zie "Online testen").
Zonder `TURNSTILE_SECRET_KEY` werkt het formulier gewoon. Bij elke aanvraag staat dan in de logs dat Turnstile uit staat.

### Resend instellen

1. Maak een account aan op resend.com. Het gratis plan heeft 3.000 mails per maand, 100 per dag en 3 domeinen
   (gecontroleerd op 9 november 2026, [bron](https://resend.com/pricing)).
2. Voeg bij **Domains** het subdomein `meldingen.<jouw domein>` toe, niet het hoofddomein. Resend raadt sterk een subdomein aan
   ([bron](https://resend.com/docs/add-a-domain)). Kies als regio Ierland (`eu-west-1`,
   [bron](https://resend.com/docs/dashboard/domains/regions)) en laat Return-Path op `send` staan.
   Staat je DNS bij Cloudflare, dan kan het met de knop **Sign in to Cloudflare**. Resend zet de DNS-records dan zelf
   ([bron](https://resend.com/docs/knowledge-base/cloudflare)). De records komen op het subdomein: DKIM op
   `resend._domainkey.meldingen` en het MX- en SPF-record op `send.meldingen`. Zo raken ze de mail van Google Workspace
   op het hoofddomein niet (zelfde bron).
3. Maak een API-sleutel met alleen verzendrechten (`sending_access`), voor het domein `meldingen.<jouw domein>`
   ([bron](https://resend.com/docs/api-reference/api-keys/create-api-key)). Zet die in Cloudflare als secret `RESEND_API_KEY`.
   `FROM_EMAIL` wordt `formulier@meldingen.<jouw domein>`.

Goed om te weten: Resend weigert verzoeken zonder `User-Agent`-header met een 403
([bron](https://resend.com/docs/api-reference/introduction)). De functie stuurt die header mee.

### Turnstile aanzetten (als er spam binnenkomt)

Turnstile is de spamcontrole van Cloudflare. Hij staat uit, en dat mag zo blijven zolang er geen spam binnenkomt.
Het formulier heeft al drie remmen: een verborgen veld dat alleen spambots invullen (de honeypot),
een controle die verzoeken van andere websites weigert (de Origin) en een limiet van 16 kB per aanvraag.
Met je eigen domein komt daar rate limiting bij (zie "Extra rem").

Komen er toch veel nepaanvragen binnen? Iemand met een klein script kan honderd aanvragen achter elkaar sturen.
Dan is het gratis plan van Resend (100 mails per dag) op en werkt het formulier die dag niet meer.
Zet dan Turnstile aan. Het formulier vraagt dan eerst een token aan Turnstile. Zonder geldige token stuurt de functie niets (status 403).

1. Pas eerst de privacyverklaring aan. Die noemt Turnstile al, met "als we dit aanzetten": in de alinea
   "Spamcontrole bij het formulier" en in de regel van Cloudflare in de tabel met diensten. Haal "als we dit aanzetten"
   op beide plekken weg, zodat er staat dat Turnstile aan staat. Maak daarna de privacypagina opnieuw
   (zie "Privacyverklaring bijwerken"). `python3 build.py --streng` stopt als Turnstile aan staat en de privacyverklaring
   Turnstile niet noemt, of nog "als we dit aanzetten" zegt.
2. Ga in het Cloudflare-dashboard naar **Turnstile** en kies **Add widget**
   ([bron](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/)).
3. Vul in: **Widget name** (bijvoorbeeld `Scanformulier`), bij **Hostname management** je domein,
   en als **Widget mode** `Managed`. Dat raadt Cloudflare aan ([bron](https://developers.cloudflare.com/turnstile/)).
   Wil je ook op een preview-adres testen, voeg dan ook dat `pages.dev`-adres toe.
4. Kies **Create**. Je krijgt een sitekey en een secret key (zelfde bron).
5. Zet de sitekey in `config.json` bij `turnstile_sitekey`. Die is niet geheim.
   Zet de secret key in Cloudflare als `TURNSTILE_SECRET_KEY`, met **Encrypt**.
6. Zet een nieuwe versie online en test het formulier (zie "Online testen met een echte mail").

Turnstile werkt pas als allebei staan: de sitekey in `config.json` en `TURNSTILE_SECRET_KEY` in Cloudflare.
Staat er maar één, dan werkt het formulier zonder Turnstile en staat er een melding in de logs van de functie.
Zo valt het formulier niet uit als een van de twee nog ontbreekt.

Uitzetten gaat andersom: maak `turnstile_sitekey` leeg, haal `TURNSTILE_SECRET_KEY` weg en zet "als we dit aanzetten"
terug in de alinea over Turnstile en in de regel van Cloudflare in de tabel. Maak daarna de privacypagina opnieuw.

Het gratis plan heeft tot 20 widgets, 10 hostnamen per widget en geen limiet op het aantal controles
(gecontroleerd op 9 november 2026, [bron](https://developers.cloudflare.com/turnstile/plans/)).
Voor tests zijn er vaste testsleutels. Een echte secret key weigert de testtoken
([bron](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)).

Goed om te weten, als Turnstile aan staat:

- Zonder JavaScript krijgt een bezoeker geen token. Het formulier zegt dan dat hij moet bellen of appen.
  Staat Turnstile uit, dan werkt het formulier ook zonder JavaScript.
- Turnstile laadt pas als iemand in het formulier klikt of typt. Bezoekers die het formulier niet gebruiken, laden het dus niet.
- Turnstile gebruikt het IP-adres en browsergegevens. Cloudflare gebruikt die ook om Turnstile zelf te verbeteren
  ([bron](https://www.cloudflare.com/turnstile-privacy-policy/)). Daarom moet het in de privacyverklaring staan.
- Of Turnstile cookies zet, is niet geverifieerd. De cookielijst van Cloudflare noemt Turnstile niet
  ([bron](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/)).

### Extra rem: rate limiting op /api/scan

Dit kan pas als je eigen domein een zone is in je Cloudflare-account (zie "Eigen domein koppelen").
Het werkt alleen op dat domein, niet op het `pages.dev`-adres. Het gratis plan heeft 1 regel, geteld per IP-adres,
met een periode van 10 seconden en een blokkade van 10 seconden ([bron](https://developers.cloudflare.com/waf/rate-limiting-rules/)).

1. Ga in het dashboard van je domein naar **Security rules** en kies **Create rule** > **Rate limiting rules**
   ([bron](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/)).
2. **Rule name**: `Scanformulier`. Kies als veld het pad (URI Path), dan `equals` en `/api/scan`.
3. Bij **When rate exceeds**: 3 verzoeken per 10 seconden. Bij **Then take action**: Block, **Duration** 10 seconden.
4. Kies **Deploy**.

Een mens verstuurt het formulier één keer, dus 3 per 10 seconden is ruim genoeg.

## Testen

### 1. Na elke wijziging: bouwen en controleren

```
python3 build.py
python3 tests/check_dist.py
```

Dit controleert onder meer: geen `{{` meer, alle HTML-tags gesloten, interne links en ankers kloppen,
JSON-LD klopt met `config.json`, de footer noemt het KvK-nummer en het btw-id alleen als het is ingevuld, geen inline scripts, dezelfde teksten bij beide vinkjes in pagina en functie,
dezelfde gemeenten en e-mailcontrole in pagina en functie, geen `novalidate`,
Turnstile in pagina en CSP alleen als `turnstile_sitekey` is ingevuld, de functie heeft alleen `RESEND_API_KEY`,
`FROM_EMAIL` en `TO_EMAIL` nodig, de lettertypen komen van de eigen site (met `font-display: swap` en de licenties,
nergens Google Fonts), de privacyverklaring noemt beide vinkjes en is gelijk aan `website/privacy.html`
(op de correcties na), en de bedrijfsnaam en het domein staan alleen in `config.json`.

Pas je `build.py` aan? Draai dan ook:

```
python3 tests/check_build.py
```

Dat bouwt in tijdelijke kopieën, met testwaarden, en controleert de strenge controle: `--streng` en de build van `main`
stoppen bij invulvelden, behalve bij het btw-id, de regel met het btw-id staat er alleen als het is ingevuld,
en Turnstile aan met een privacyverklaring die het niet noemt of nog "als we dit aanzetten" zegt, stopt de build.
Je eigen `config.json`, `src/` en `dist/` blijven zoals ze zijn.

### 2. Alles in één keer

Je hebt Node.js nodig. Installeer één keer de vaste versies van wrangler en Playwright, met de browser Chromium
([bron](https://playwright.dev/docs/browsers)). Op Linux zet `--with-deps` er ook de systeempakketten bij:

```
cd tests
npm ci
npx playwright install chromium
cd ..
```

Draai dan:

```
tests/alle-tests.sh
```

Dat duurt een paar minuten. Eerst draait `tests/check_build.py`. Daarna maakt het script twee tijdelijke kopieën van deze map: één zonder Turnstile
(lege `turnstile_sitekey`) en één met de testsleutel van Turnstile. In elke kopie draait het `build.py`,
`tests/check_dist.py`, `tests/api-tests.sh` in alle vijf standen en `tests/browser-check.cjs` in drie standen.
Je eigen `config.json`, `.dev.vars` en `dist/` blijven zoals ze zijn. Onderaan staat per stap OK of FOUT.
Voor de standen met `nep-sleutel` en voor Turnstile in de browser is internet nodig. Er gaat geen echte mail weg.

### 3. Het formulier lokaal testen, stap voor stap (er gaat geen mail weg)

Start de server vanuit deze map, dan vindt wrangler de map `functions/`:

```
tests/node_modules/.bin/wrangler pages dev dist --port 8788
```

Draai in een tweede terminal:

```
tests/api-tests.sh http://127.0.0.1:8788 zonder-instellingen
```

Dit test de pagina's, de headers, de lettertypen en het formulier. Een geldige aanvraag geeft hier 500,
want er zijn nog geen instellingen. Het script leest `turnstile_sitekey` uit `config.json` en weet zo of Turnstile
op de pagina hoort te staan.

Testen met een nepsleutel: maak in deze map een bestand `.dev.vars`
([bron](https://developers.cloudflare.com/pages/functions/bindings/)):

```
RESEND_API_KEY=nep
FROM_EMAIL=formulier@example.com
TO_EMAIL=jij@example.com
```

Start wrangler opnieuw en draai `tests/api-tests.sh http://127.0.0.1:8788 nep-sleutel`. Hiervoor heb je internet nodig.
Een geldige aanvraag geeft dan 502, want Resend weigert de nepsleutel.
Zet je er de regel `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA` bij, gebruik dan de stand `nep-sleutel-turnstile`.
Dat is de testsleutel van Turnstile die altijd goedkeurt ([bron](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)).
De functie controleert de token alleen als ook `turnstile_sitekey` in `config.json` is ingevuld.
`.dev.vars` staat in `.gitignore`. Gooi het bestand weg als je klaar bent.

Kijken wat de functie naar Resend stuurt, zonder internet: `tests/api-tests.sh http://127.0.0.1:8789 mock`,
of `mock-turnstile` voor hetzelfde met `TURNSTILE_SECRET_KEY`. Start daarvoor zelf geen wrangler. Het script start een
nep-Resend en nep-Turnstile (`tests/mock_server.py`) en wrangler op poort 8789, en zet daarna je eigen `.dev.vars` terug.
Het controleert onder meer: alleen `from`, `to`, `reply_to`, `subject` en `text`, het adres uit het formulier als `reply_to`,
beide vinkjes in de tekst, de `Idempotency-Key`, geen mail bij de honeypot of (als Turnstile aan staat) een foute token,
geen vraag aan Turnstile als Turnstile uit staat, de melding over Turnstile in de log,
en wat er gebeurt als Resend 409, 422 of 429 geeft.

Browsertest met Playwright: `node tests/browser-check.cjs http://127.0.0.1:8788 zonder-instellingen`
(of `nep-sleutel` of `nep-sleutel-turnstile`, net als bij `api-tests.sh`).
Die kijkt of er geen fouten in de console staan, of de CSP niets blokkeert, of de lettertypen van de eigen site komen,
of de pagina niets van andere sites laadt (behalve Turnstile als die aan staat), of Turnstile een token geeft,
of de foutmelding netjes op de pagina komt, hoe het formulier werkt zonder JavaScript en of alles past op 375 en 320 pixels breed.

Eén verzoek met de hand. De token is alleen nodig als Turnstile aan staat, dit is de testtoken:

```
curl -i -X POST http://127.0.0.1:8788/api/scan \
  -H 'Content-Type: application/json' \
  -d '{"naam":"Test","bedrijf":"Testhoveniers","email":"test@example.com","gemeente":"Huizen","toestemming":"on","cf-turnstile-response":"XXXX.DUMMY.TOKEN.XXXX"}'
```

### 4. Online testen met een echte mail

Als de variabelen staan en je opnieuw hebt gedeployd:

1. Vul het formulier op de site in met je eigen e-mailadres en zet het eerste vinkje aan.
2. Je ziet: "Dank je. Je scan komt binnen twee werkdagen in je mailbox."
3. Op `TO_EMAIL` komt een mail met als onderwerp `Scanaanvraag: <bedrijf> (<gemeente>)`.
   Antwoord je erop, dan gaat je antwoord naar het adres uit het formulier.
4. Gaat er iets mis? Bekijk de logs bij **Workers & Pages** > je project > de deployment > **View details** > **Functions**
   ([bron](https://developers.cloudflare.com/pages/functions/debugging-and-logging/)).

### Wat de statuscodes betekenen

| Status | Betekenis |
|---|---|
| 200 | Verstuurd. Of de honeypot was ingevuld: dan lijkt het gelukt, maar gaat er niets weg. |
| 400 | Een verplicht veld ontbreekt of is te lang, of het eerste vinkje staat uit. De melding zegt wat. |
| 403 | Het verzoek kwam van een andere website. Of Turnstile staat aan en de token ontbreekt, klopt niet of is verlopen. |
| 405 | Geen POST. |
| 413, 415 | Te groot (meer dan 16 kB, ook zonder Content-Length), of geen JSON en geen gewoon formulier (bijvoorbeeld multipart). |
| 500 | `RESEND_API_KEY`, `FROM_EMAIL` of `TO_EMAIL` ontbreekt. Welke, staat in de logs van de functie: **Workers & Pages** > je project > de deployment > **View details** > **Functions** ([bron](https://developers.cloudflare.com/pages/functions/debugging-and-logging/)). |
| 502 | Resend weigerde of was niet bereikbaar, of (als Turnstile aan staat) Turnstile was niet bereikbaar of weigerde onze sleutel. De status van Resend staat in dezelfde logs: 401 is een verkeerde sleutel, 403 meestal een domein dat niet geverifieerd is of een `FROM_EMAIL` op een ander domein, 429 is een limiet ([bron](https://resend.com/docs/api-reference/errors)). Bij 429 vraagt de pagina de bezoeker om te bellen of te appen. |

## Zo werkt het formulier

- `main.js` controleert de velden in de browser en stuurt ze als JSON naar `/api/scan`, met een `aanvraag_id`.
  Staat Turnstile aan, dan gaat ook de token van Turnstile mee.
- Het verborgen veld `bedrijfswebsite_extra` is een val voor spambots. Mensen zien het niet.
  Is het ingevuld, dan antwoordt de functie 200 en verstuurt ze niets.
- Komt het verzoek van een andere website (de header `Origin`), dan weigert de functie het (403).
- Zonder JavaScript controleert de browser de verplichte velden (er staat geen `novalidate` in de HTML).
  Staat Turnstile uit, dan gaat het formulier gewoon naar de functie en krijgt de bezoeker een korte pagina terug.
  Staat Turnstile aan, dan lukt versturen niet, want er is geen token. Die pagina noemt dan het telefoonnummer.
  Bij een fout zegt die pagina dat hij met de terugknop terug kan. Wat hij invulde, staat er dan meestal nog.
- De functie controleert alles opnieuw: de gemeente moet uit de lijst komen, het e-mailadres moet een gewoon adres zijn.
  Ze haalt enters, stuurtekens en onzichtbare tekens weg en stuurt een platte-tekstmail via Resend.
  Ze leest hooguit 16 kB, ook als de bezoeker geen Content-Length meestuurt.
- In de mail staan alle velden en de tekst van beide vinkjes, en of vinkje 2 aan stond. Dat is je bewijs van toestemming.
  Het tijdstip is de datum en tijd van de mail zelf.
- Elke mail krijgt een `Idempotency-Key`. Verstuurt iemand na een time-out precies hetzelfde formulier nog een keer,
  dan stuurt Resend binnen 24 uur geen tweede mail. Daarvoor moet de inhoud precies gelijk zijn
  ([bron](https://resend.com/docs/dashboard/emails/idempotency-keys)). Daarom staat er geen tijdstip in de tekst.
  Zegt Resend 409, dan probeert de functie het nog één keer met een nieuwe sleutel: liever een dubbele mail dan een aanvraag die zoekraakt.
- Weigert Resend het verzoek met 400 of 422, bijvoorbeeld om het antwoordadres, dan probeert de functie het nog één keer
  zonder `reply_to`. Onderaan staat dan een waarschuwing in de tekst. Of Resend zo'n adres echt weigert, is niet geverifieerd.
- Het antwoord aan de browser bevat alleen `ok` en `error`. Details staan in de logs.
- De headers uit `_headers` gelden niet voor de functie. De functie zet daarom zelf `Cache-Control: no-store`
  en `X-Content-Type-Options: nosniff` ([bron](https://developers.cloudflare.com/pages/configuration/headers/)).
- Op het gratis plan telt elke verzending als 1 van de 100.000 verzoeken per dag voor Functions en Workers samen.
  Pagina's en bestanden tellen niet mee ([bron](https://developers.cloudflare.com/pages/functions/pricing/)).

Pas je de tekst bij een vinkje aan? Doe dat in `src/index.html`, in `functions/api/scan.js` (`CONSENT_TEXT` of `VERVOLG_TEXT`)
en in de privacyverklaring (zie hieronder). `tests/check_dist.py` meldt het als ze verschillen.

## Privacyverklaring bijwerken

De bron is `10-Privacyverklaring.md` in de map hierboven. Deel 1 daarvan staat op de site.

1. Pas de bron aan en maak `website/privacy.html` opnieuw. Dat doet Claude.
2. Draai `python3 tools/sync_privacy.py`. Dat maakt `src/privacy.html` en neemt de versieregel over uit `website/privacy.html`.
   Het script heeft pandoc nodig. De build zelf niet.
3. Draai `python3 build.py` en `python3 tests/check_dist.py`. Die vergelijkt de site met `website/privacy.html` en meldt elk verschil.

`tools/privacy-bron.json` kan plekken noemen waar de bron nog niet klopt met dit formulier. Het script past ze toe
en meldt elke plek met LET OP. Neem ze over in de bron. Daarna kun je ze uit `tools/privacy-bron.json` halen.
Nu staan er geen correcties in.

Staat Turnstile aan, dan moet de privacyverklaring zeggen dat Turnstile aan staat: ze noemt Turnstile, en nergens
meer "als we dit aanzetten". Klopt dat niet, dan waarschuwt `build.py` en stopt `build.py --streng` (en dus de build
van `main`). `tests/check_build.py` test dat.

## Nog te doen

- De invulvelden in `config.json` invullen: e-mailadres, naam ouder, KvK-nummer en achternaam.
  Het btw-id zodra de brief van de Belastingdienst er is.
- Resend: account, het subdomein `meldingen.<jouw domein>` verifiëren en API-sleutel. Daarna de drie verplichte variabelen in Cloudflare zetten.
- Als het domein gekoppeld is: de regel voor rate limiting op `/api/scan` maken (zie "Extra rem").
- Turnstile pas als er spam binnenkomt (zie "Turnstile aanzetten (als er spam binnenkomt)").
- Er is nog geen afbeelding voor als iemand de link deelt (`og:image`).
- Schema.org noemt het type `ProfessionalService` verouderd voor lokale bedrijven
  ([bron](https://schema.org/ProfessionalService)). Wil je dat netjes, zet dan in `src/index.html` `"@type": "LocalBusiness"`
  en pas `tests/check_dist.py` mee aan.
