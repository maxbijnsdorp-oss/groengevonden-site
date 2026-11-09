#!/usr/bin/env python3
"""Controleert dist/ na `python3 build.py`. Alleen de standaardbibliotheek van Python.

Gebruik (vanuit de hoofdmap van de repo):
    python3 build.py && python3 tests/check_dist.py

Controleert:
- geen {{ meer in dist/
- HTML is netjes: elke tag die opent wordt ook gesloten, geen dubbele id's
- elke interne link wijst naar een bestaand bestand of een bestaand #anker
- geen inline <script> (behalve JSON-LD), CSP zonder 'unsafe-inline' voor scripts
- JSON-LD is geldige JSON met de gegevens uit config.json
- de bedrijfsnaam en het domein staan nergens letterlijk in src/ of functions/ (alleen in config.json)
- de teksten bij vinkje 1 en vinkje 2 zijn gelijk aan CONSENT_TEXT en VERVOLG_TEXT in de functie
- de maxlength van de velden is gelijk aan de limieten in de functie
- de gemeenten in de functie zijn gelijk aan de keuzelijst, de e-mailcontrole in main.js aan die in de functie
- Turnstile: met een sitekey in config.json het Turnstile-vak met die sitekey en challenges.cloudflare.com in de CSP,
  met een lege sitekey geen vak, geen melding voor bezoekers zonder JavaScript en niets van Turnstile in de CSP;
  het formulier heeft geen novalidate; de functie heeft TURNSTILE_SECRET_KEY niet nodig
- lettertypen van de eigen site: fonts.css met de vijf lettertypen (font-display: swap), echte woff2-bestanden,
  de licenties, elke pagina laadt fonts.css, nergens Google Fonts, en de CSP staat alleen font-src 'self' toe
- de privacyverklaring noemt beide vinkjes met de tekst van nu, en niet meer het oude vinkje
- de privacyverklaring is gelijk aan ../website/privacy.html, op de correcties in tools/privacy-bron.json na
  (alleen als dat bestand er is)
- geen lange of halve kastlijnen (gedachtestreepjes) in de teksten
"""
import difflib
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
SRC = ROOT / "src"
FUNCTION = ROOT / "functions" / "api" / "scan.js"
PRIVACY_SETTINGS = ROOT / "tools" / "privacy-bron.json"
OLD_CONSENT = "mag mij per e-mail de scan en maximaal twee"
QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', " ": " "})
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
        "param", "source", "track", "wbr"}
TEXT_SUFFIXES = {".html", ".xml", ".svg", ".txt", ".js", ".css", ".json", ".md"}
TEXT_NAMES = {"_headers", "_redirects"}
GEMEENTEN = 13
# De lettertypen in src/fonts/fonts.css: (familie, gewicht).
FONTS = {("Young Serif", "400"), ("Atkinson Hyperlegible", "400"), ("Atkinson Hyperlegible", "700"),
         ("IBM Plex Mono", "400"), ("IBM Plex Mono", "500")}
FONT_LICENSES = ["OFL-young-serif.txt", "OFL-atkinson-hyperlegible.txt", "OFL-ibm-plex-mono.txt"]
GOOGLE_FONTS = ("fonts.googleapis.com", "fonts.gstatic.com")
REQUIRED_ENV = ["RESEND_API_KEY", "FROM_EMAIL", "TO_EMAIL"]

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.problems, self.ids, self.refs, self.scripts = [], [], {}, [], []
        self.elements = []  # (tag, attrs) van alle elementen
        self.text_stack = []  # (for, tekst) van de labels bij de vinkjes
        self.label_texts = {}  # for-attribuut van een label.consent -> tekst
        self.options = []  # waarden van de keuzes in #f-gemeente
        self._option = None
        self._in_gemeente = False
        self.saw_doctype = False

    def handle_decl(self, decl):
        if decl.lower() == "doctype html":
            self.saw_doctype = True

    def _attrs(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        self.elements.append((tag, a))
        line = self.getpos()[0]
        if "id" in a:
            if a["id"] in self.ids:
                self.problems.append(f"regel {line}: id \"{a['id']}\" komt dubbel voor")
            self.ids[a["id"]] = line
        for attr in ("href", "src", "action"):
            if attr in a:
                self.refs.append((tag, attr, a[attr], line))
        if tag == "script":
            self.scripts.append(a)
        return a

    def handle_starttag(self, tag, attrs):
        a = self._attrs(tag, attrs)
        if tag in VOID:
            return
        self.stack.append((tag, self.getpos()[0]))
        if tag == "label" and "consent" in a.get("class", "").split():
            # for="f-consent" is vinkje 1 (de scan), for="f-vervolg" vinkje 2 (vervolgberichten).
            self.text_stack.append((a.get("for", ""), []))
        if tag == "select":
            self._in_gemeente = a.get("id") == "f-gemeente"
        if tag == "option" and self._in_gemeente:
            self._option = (a.get("value"), [])

    def handle_startendtag(self, tag, attrs):
        self._attrs(tag, attrs)

    def handle_data(self, data):
        if self.text_stack:
            self.text_stack[-1][1].append(data)
        if self._option is not None:
            self._option[1].append(data)

    def handle_endtag(self, tag):
        line = self.getpos()[0]
        if tag in VOID:
            self.problems.append(f"regel {line}: sluittag </{tag}> hoort niet bij een leeg element")
            return
        if tag == "label" and self.text_stack:
            label_for, collected = self.text_stack.pop()
            self.label_texts[label_for] = " ".join("".join(collected).split())
        if tag == "option" and self._option is not None:
            value, collected = self._option
            self.options.append(" ".join("".join(collected).split()) if value is None else value)
            self._option = None
        if tag == "select":
            self._in_gemeente = False
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()
            return
        names = [t for t, _ in self.stack]
        if tag not in names:
            self.problems.append(f"regel {line}: </{tag}> zonder openingstag")
            return
        while self.stack and self.stack[-1][0] != tag:
            open_tag, open_line = self.stack.pop()
            self.problems.append(f"<{open_tag}> van regel {open_line} is niet gesloten (gezien bij </{tag}> op regel {line})")
        self.stack.pop()

    def finish(self):
        self.close()
        for tag, line in self.stack:
            self.problems.append(f"<{tag}> van regel {line} is niet gesloten")


def parse(path):
    parser = PageParser()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.finish()
    return parser


def norm_text(text):
    """Tekst zonder verschil in aanhalingstekens en witruimte."""
    return " ".join(text.translate(QUOTES).split())


class BlockParser(HTMLParser):
    """Verzamelt de tekst van elke p, li, th, td, h1 en h3, zonder opmaak."""
    BLOCKS = {"p", "li", "th", "td", "h1", "h3"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks, self.open = [], []

    def handle_starttag(self, tag, attrs):
        if tag in self.BLOCKS:
            self.open.append([])
        elif tag == "br" and self.open:
            self.open[-1].append(" ")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag in self.BLOCKS:
            self.handle_endtag(tag)

    def handle_data(self, data):
        if self.open:
            self.open[-1].append(data)

    def handle_endtag(self, tag):
        if tag in self.BLOCKS and self.open:
            self.blocks.append(norm_text("".join(self.open.pop())))


def text_blocks(path):
    parser = BlockParser()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    return parser.blocks


def js_string(src, name):
    """De tekst van const NAAM = "..." of `...` + `...`; in scan.js, of None."""
    found = re.search(rf"const {name} =\s*((?:(?:`[^`]*`|\"[^\"]*\")\s*\+?\s*)+);", src)
    if not found:
        return None
    return " ".join("".join(a or b for a, b in re.findall(r"`([^`]*)`|\"([^\"]*)\"", found.group(1))).split())


def privacy_drift(cfg, master):
    """Vergelijkt dist/privacy.html met de HTML-versie van de bron. Geeft een lijst met problemen."""
    settings = json.loads(PRIVACY_SETTINGS.read_text(encoding="utf-8"))
    joined = "\n\n".join(text_blocks(master))
    problems = []
    for number, correction in enumerate(settings["correcties"], 1):
        old, new = ("\n\n".join(norm_text(part) for part in correction[key].split("\n\n"))
                    for key in ("oud", "nieuw"))
        if joined.count(old) == 1:
            joined = joined.replace(old, new)
        elif new not in joined:
            problems.append(f"correctie {number} uit tools/privacy-bron.json past niet meer op {master.name}")
    for field in settings["invulvelden"]:
        joined = joined.replace(field["tekst"], cfg[field["sleutel"]])
    expected, actual = joined.split("\n\n"), text_blocks(DIST / "privacy.html")
    if expected != actual:
        diff = [line for line in difflib.unified_diff(expected, actual, "bron", "site", lineterm="", n=0)
                if not line.startswith(("---", "+++", "@@"))]
        problems.append("verschil met de bron (- bron, + site), draai python3 tools/sync_privacy.py:\n      "
                        + "\n      ".join(line[:160] for line in diff[:12]))
    return problems


def text_files(base):
    return sorted(p for p in base.rglob("*")
                  if p.is_file() and (p.suffix in TEXT_SUFFIXES or p.name in TEXT_NAMES))


def target_for(url_path):
    """Welk bestand in dist/ Cloudflare Pages serveert voor een pad (zonder ?query en #anker)."""
    if url_path.startswith("/api/"):
        return ROOT / "functions" / (url_path.lstrip("/") + ".js")
    rel = url_path.lstrip("/")
    if rel == "" or rel.endswith("/"):
        return DIST / rel / "index.html"
    candidate = DIST / rel
    if candidate.is_file():
        return candidate
    return DIST / (rel + ".html")


def main():
    if not DIST.is_dir():
        print("dist/ ontbreekt. Draai eerst: python3 build.py")
        return 1
    cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))

    # 1. Geen {{ meer
    leftovers = [f"{p.relative_to(DIST)}:{i}" for p in text_files(DIST)
                 for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1) if "{{" in line]
    check("geen {{ meer in dist/", not leftovers, ", ".join(leftovers))

    pages = {p.relative_to(DIST).as_posix(): parse(p) for p in sorted(DIST.rglob("*.html"))}
    check("HTML-pagina's gevonden", {"index.html", "privacy.html", "404.html"} <= set(pages),
          ", ".join(pages))

    # 2. Structuur per pagina
    for name, page in pages.items():
        check(f"{name}: alle tags netjes gesloten, geen dubbele id's", not page.problems,
              "; ".join(page.problems[:10]))
        tags = {(t, a.get("name", a.get("rel", a.get("charset", "")))) for t, a in page.elements}
        html_tag = next((a for t, a in page.elements if t == "html"), {})
        viewport = next((a.get("content", "") for t, a in page.elements
                         if t == "meta" and a.get("name") == "viewport"), "")
        problems = []
        if not page.saw_doctype:
            problems.append("geen <!doctype html>")
        if html_tag.get("lang") != "nl":
            problems.append('geen <html lang="nl">')
        if not any(t == "meta" and "charset" in a for t, a in page.elements):
            problems.append("geen <meta charset>")
        if "viewport-fit=cover" not in viewport:
            problems.append("viewport zonder viewport-fit=cover")
        if ("link", "icon") not in tags:
            problems.append("geen favicon-link")
        if name != "404.html" and ("link", "canonical") not in tags:
            problems.append("geen canonical")
        check(f"{name}: doctype, lang, charset, viewport, favicon, canonical", not problems,
              ", ".join(problems))

        # Geen inline scripts behalve JSON-LD
        inline = [s for s in page.scripts if not s.get("src") and s.get("type") != "application/ld+json"]
        check(f"{name}: geen inline <script>", not inline, str(inline))

        # Interne links
        broken = []
        for tag, attr, value, line in page.refs:
            if re.match(r"^(https?:|mailto:|tel:|data:)", value):
                continue
            path_part, _, fragment = value.partition("#")
            path_part = path_part.split("?")[0]
            if path_part == "":
                target_page = page
            else:
                if not path_part.startswith("/"):
                    path_part = "/" + (Path(name).parent / path_part).as_posix().lstrip("./")
                target = target_for(path_part)
                if not target.is_file():
                    broken.append(f"regel {line}: {attr}=\"{value}\" (geen {target.relative_to(ROOT)})")
                    continue
                target_page = pages.get(target.relative_to(DIST).as_posix()) if target.suffix == ".html" and DIST in target.parents else None
            if fragment and fragment != "top" and target_page is not None and fragment not in target_page.ids:
                broken.append(f"regel {line}: {attr}=\"{value}\" (anker #{fragment} bestaat niet)")
            if fragment == "top" and target_page is not None and "top" not in target_page.ids:
                broken.append(f"regel {line}: #top bestaat niet")
        check(f"{name}: interne links en ankers kloppen", not broken, "; ".join(broken))

    # 3. JSON-LD
    index_html = (DIST / "index.html").read_text(encoding="utf-8")
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', index_html, re.S)
    try:
        data = json.loads(blocks[0])
        expected = {
            "@type": "ProfessionalService",
            "name": cfg["bedrijfsnaam"],
            "url": f"https://{cfg['domein']}/",
            "telephone": cfg["telefoon_e164"],
        }
        diffs = [f"{k}: {data.get(k)!r} in plaats van {v!r}" for k, v in expected.items() if data.get(k) != v]
        if len(data.get("areaServed", [])) != GEMEENTEN:
            diffs.append(f"areaServed heeft {len(data.get('areaServed', []))} gemeenten in plaats van {GEMEENTEN}")
        check("index.html: JSON-LD klopt met config.json", not diffs, "; ".join(diffs))
    except (IndexError, json.JSONDecodeError) as exc:
        check("index.html: JSON-LD klopt met config.json", False, str(exc))

    # 4. Formulier
    index = pages["index.html"]
    form = next((a for t, a in index.elements if t == "form" and a.get("id") == "scan-form"), {})
    names = {a.get("name") for t, a in index.elements if t in ("input", "select") and a.get("name")}
    wanted = {"naam", "bedrijf", "email", "telefoon", "gemeente", "website", "toestemming", "bedrijfswebsite_extra"}
    check("formulier: data-endpoint=/api/scan, action=/api/scan, method=post",
          form.get("data-endpoint") == "/api/scan" and form.get("action") == "/api/scan" and form.get("method") == "post",
          str(form))
    check("formulier: alle velden en de honeypot zijn er", wanted <= names, f"ontbreekt: {wanted - names}")

    function_src = FUNCTION.read_text(encoding="utf-8")
    limits_match = re.search(r"const LIMITS = \{([^}]*)\}", function_src)
    limits = dict((k, int(v)) for k, v in re.findall(r"(\w+):\s*(\d+)", limits_match.group(1))) if limits_match else {}
    maxlengths = {a["name"]: int(a["maxlength"]) for t, a in index.elements
                  if t == "input" and a.get("maxlength") and a.get("name")}
    mismatch = [f"{k}: maxlength {v}, functie {limits.get(k)}" for k, v in maxlengths.items() if limits.get(k) != v]
    check("formulier: maxlength gelijk aan de limieten in de functie", bool(limits) and not mismatch,
          "; ".join(mismatch) or ("LIMITS niet gevonden" if not limits else ""))

    fn_consent = js_string(function_src, "CONSENT_TEXT")
    fn_vervolg = js_string(function_src, "VERVOLG_TEXT")
    page_consent = index.label_texts.get("f-consent")
    page_vervolg = index.label_texts.get("f-vervolg", "")
    if page_vervolg.endswith("(niet verplicht)"):
        page_vervolg = page_vervolg[: -len("(niet verplicht)")].strip()
    check("vinkje 1: CONSENT_TEXT in de functie is gelijk aan de tekst op de pagina",
          fn_consent is not None and fn_consent == page_consent,
          f"\n    pagina:  {page_consent}\n    functie: {fn_consent}")
    check("vinkje 2: VERVOLG_TEXT in de functie is gelijk aan de tekst op de pagina",
          fn_vervolg is not None and fn_vervolg == page_vervolg,
          f"\n    pagina:  {page_vervolg}\n    functie: {fn_vervolg}")

    gemeenten_match = re.search(r"const GEMEENTEN = \[([^\]]*)\]", function_src)
    fn_gemeenten = re.findall(r'"([^"]*)"', gemeenten_match.group(1)) if gemeenten_match else []
    page_gemeenten = [option for option in index.options if option]
    check("gemeenten: GEMEENTEN in de functie is gelijk aan de keuzelijst",
          bool(fn_gemeenten) and fn_gemeenten == page_gemeenten,
          f"\n    pagina:  {page_gemeenten}\n    functie: {fn_gemeenten}")

    main_js = (SRC / "main.js").read_text(encoding="utf-8")
    fn_email = re.search(r"const EMAIL_RE = (/.+/);", function_src)
    js_email = re.search(r"var EMAIL_RE = (/.+/);", main_js)
    check("e-mailcontrole: EMAIL_RE in main.js is gelijk aan die in de functie",
          bool(fn_email and js_email) and fn_email.group(1) == js_email.group(1),
          f"\n    main.js: {js_email and js_email.group(1)}\n    functie: {fn_email and fn_email.group(1)}")

    # Turnstile staat aan als turnstile_sitekey in config.json is ingevuld. Leeg of afwezig: uit.
    sitekey = cfg.get("turnstile_sitekey", "").strip()
    turnstile = "aan" if sitekey else "uit"
    widget = next((a for t, a in index.elements if a.get("id") == "f-turnstile"), None)
    noscript = any(t == "noscript" for t, a in index.elements)
    problems = []
    if sitekey:
        if widget is None:
            problems.append("het vak #f-turnstile ontbreekt, terwijl turnstile_sitekey is ingevuld")
        elif widget.get("data-sitekey") != sitekey:
            problems.append(f"#f-turnstile heeft data-sitekey {widget.get('data-sitekey')!r}, niet de sitekey uit config.json")
        if not noscript:
            problems.append("de melding voor bezoekers zonder JavaScript (<noscript>) ontbreekt")
    else:
        if widget is not None:
            problems.append("het vak #f-turnstile staat er, terwijl turnstile_sitekey leeg is")
        if noscript:
            problems.append("de melding dat het formulier alleen met JavaScript werkt staat er, maar zonder Turnstile werkt het ook zonder")
        if "challenges.cloudflare.com" in index_html:
            problems.append("index.html noemt challenges.cloudflare.com, terwijl Turnstile uit staat")
    if "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" not in main_js:
        problems.append("main.js laadt api.js van Turnstile niet van het vaste adres")
    if "novalidate" in form:
        problems.append("het formulier heeft novalidate (dan controleert de browser zonder JavaScript niets)")
    check(f"formulier: spamcontrole (Turnstile staat {turnstile}) en controle door de browser", not problems,
          "; ".join(problems))

    env_match = re.search(r"const REQUIRED_ENV = \[([^\]]*)\]", function_src)
    fn_env = re.findall(r'"([A-Z_]+)"', env_match.group(1)) if env_match else []
    check("functie: verplicht zijn alleen RESEND_API_KEY, FROM_EMAIL en TO_EMAIL (Turnstile is niet verplicht)",
          fn_env == REQUIRED_ENV, f"REQUIRED_ENV in de functie: {fn_env or 'niet gevonden'}")

    # 5. Headers
    headers = (DIST / "_headers").read_text(encoding="utf-8")
    csp = re.search(r"Content-Security-Policy:\s*(.+)", headers)
    csp_value = csp.group(1) if csp else ""
    directives = {part.split()[0]: " ".join(part.split()[1:]) for part in csp_value.split(";") if part.split()}
    script_src = directives.get("script-src", "")
    problems = []
    if not csp:
        problems.append("geen CSP")
    elif not script_src or "'unsafe-inline'" in script_src:
        problems.append("script-src ontbreekt of staat 'unsafe-inline' toe")
    if sitekey:
        if "https://challenges.cloudflare.com" not in script_src.split():
            problems.append("script-src staat Turnstile (https://challenges.cloudflare.com) niet toe")
        if directives.get("frame-src") != "https://challenges.cloudflare.com":
            problems.append("frame-src staat alleen het iframe van Turnstile toe: dat klopt niet")
    elif "challenges.cloudflare.com" in csp_value:
        problems.append("de CSP staat challenges.cloudflare.com toe, terwijl Turnstile uit staat")
    if directives.get("font-src") != "'self'":
        problems.append(f"font-src is {directives.get('font-src')!r}, niet 'self'")
    if directives.get("style-src") != "'self' 'unsafe-inline'":
        problems.append(f"style-src is {directives.get('style-src')!r}, niet 'self' 'unsafe-inline'")
    for needed in ["frame-ancestors 'none'", "https://static.cloudflareinsights.com", "https://cloudflareinsights.com",
                   "X-Content-Type-Options: nosniff", "Referrer-Policy:", "Permissions-Policy:"]:
        if needed not in headers:
            problems.append(f"mist {needed}")
    if any(len(line) > 2000 for line in headers.splitlines()):
        problems.append("een regel is langer dan 2000 tekens (limiet van Cloudflare)")
    check(f"_headers: CSP en beveiligingsheaders (Turnstile staat {turnstile})", not problems, "; ".join(problems))

    # 6. Lettertypen van de eigen site
    fonts_dir = DIST / "fonts"
    fonts_css = fonts_dir / "fonts.css"
    problems = []
    faces = set()
    if not fonts_css.is_file():
        problems.append("dist/fonts/fonts.css ontbreekt")
    else:
        for block in re.findall(r"@font-face\s*\{([^}]*)\}", fonts_css.read_text(encoding="utf-8")):
            family = re.search(r"font-family:\s*\"([^\"]+)\"", block)
            weight = re.search(r"font-weight:\s*(\d+)", block)
            face = f"{family.group(1) if family else '?'} {weight.group(1) if weight else '?'}"
            faces.add((family.group(1) if family else "", weight.group(1) if weight else ""))
            if not re.search(r"font-display:\s*swap\s*;", block):
                problems.append(f"{face}: geen font-display: swap")
            urls = re.findall(r"url\(\"?([^\")]+)\"?\)", block)
            if not urls:
                problems.append(f"{face}: geen url()")
            for url in urls:
                target = (fonts_dir / url).resolve() if not url.startswith("/") else DIST / url.lstrip("/")
                if re.match(r"^[a-z]+:", url):
                    problems.append(f"{face}: {url} staat niet op de eigen site")
                elif not target.is_file():
                    problems.append(f"{face}: {url} bestaat niet in dist/fonts/")
                elif target.read_bytes()[:4] != b"wOF2":
                    problems.append(f"{face}: {url} is geen woff2-bestand")
        if faces != FONTS:
            problems.append(f"fonts.css heeft {sorted(faces)}, verwacht {sorted(FONTS)}")
    for name in FONT_LICENSES:
        if not (fonts_dir / name).is_file():
            problems.append(f"de licentie {name} ontbreekt in dist/fonts/")
    for name, page in pages.items():
        if ("link", "/fonts/fonts.css") not in {(t, a.get("href")) for t, a in page.elements if a.get("rel") == "stylesheet"}:
            problems.append(f"{name} laadt /fonts/fonts.css niet")
    google = [f"{p.relative_to(ROOT)}" for base in (DIST, SRC, ROOT / "functions") for p in text_files(base)
              if any(host in p.read_text(encoding="utf-8") for host in GOOGLE_FONTS)]
    if google:
        problems.append("Google Fonts staat nog in: " + ", ".join(google))
    check("lettertypen: van de eigen site, met font-display: swap en de licenties, geen Google Fonts", not problems,
          "; ".join(problems))

    # 7. Bedrijfsnaam en domein alleen in config.json
    literals = [cfg["bedrijfsnaam"], cfg["domein"], "groengevonden.nl"]
    hits = []
    for base in (SRC, ROOT / "functions"):
        for p in text_files(base):
            text = p.read_text(encoding="utf-8")
            for lit in literals:
                if lit.lower() in text.lower():
                    hits.append(f"{p.relative_to(ROOT)} bevat \"{lit}\"")
    check("bedrijfsnaam en domein staan alleen in config.json", not hits, "; ".join(hits))

    # 8. Privacyverklaring: dezelfde vinkjes als het formulier, en gelijk aan de bron
    privacy_text = norm_text(" ".join(text_blocks(DIST / "privacy.html")))
    wanted = [fn_consent.split(". ")[0] + "." if fn_consent else "(CONSENT_TEXT niet gevonden)",
              fn_vervolg or "(VERVOLG_TEXT niet gevonden)"]
    problems = [f"mist de tekst van een vinkje: {text}" for text in wanted if norm_text(text) not in privacy_text]
    if OLD_CONSENT in privacy_text:
        problems.append(f"noemt nog het oude vinkje ({OLD_CONSENT} ...)")
    check("privacy.html: noemt beide vinkjes met de tekst van nu", not problems, "; ".join(problems))

    settings = json.loads(PRIVACY_SETTINGS.read_text(encoding="utf-8"))
    master = (ROOT / settings["master_html"]).resolve()
    if master.is_file():
        problems = privacy_drift(cfg, master)
        check(f"privacy.html: gelijk aan {master.parent.name}/{master.name}, op de correcties na", not problems,
              "; ".join(problems))
    else:
        check(f"privacy.html: vergelijking met de bron overgeslagen ({master} bestaat hier niet)", True)

    # 9. Geen gedachtestreepjes in de teksten
    dash_files = []
    own_files = sorted(p for base in (ROOT / "tools", ROOT / "tests") for p in base.glob("*")
                       if p.is_file() and p.name != "check_dist.py")  # dit bestand noemt de streepjes zelf
    for p in (text_files(SRC) + text_files(ROOT / "functions") + own_files
              + [ROOT / "README.md", ROOT / "build.py"]):
        if p.is_file() and ("–" in p.read_text(encoding="utf-8") or "—" in p.read_text(encoding="utf-8")):
            dash_files.append(str(p.relative_to(ROOT)))
    check("geen lange of halve kastlijnen in de teksten", not dash_files, ", ".join(dash_files))

    failed = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print(f"{'OK  ' if ok else 'FOUT'}  {name}" + ("" if ok or not detail else f"\n      {detail}"))
    print(f"\n{len(results) - len(failed)} van {len(results)} controles OK.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
