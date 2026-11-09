#!/usr/bin/env python3
"""Bouwt de website: kopieert src/ naar dist/ en vult de {{placeholders}} in uit config.json.

Gebruik:
    python3 build.py            bouwen; waarschuwt als er nog [invulvelden] in config.json staan
    python3 build.py --streng   bouwen en stoppen met een fout als er nog [invulvelden] staan (btw_id mag
                                nog open zijn), als turnstile_sitekey nog de testsleutel is, of als Turnstile
                                aan staat en de privacyverklaring dat niet zegt: ze noemt Turnstile niet, of
                                nog met "als we dit aanzetten"
Op Cloudflare Pages staat de strenge controle vanzelf aan voor de productiebranch (PRODUCTIE_BRANCH,
Pages zet CF_PAGES_BRANCH). Builds van andere branches (previews) mogen nog invulvelden hebben.

Regels:
- {{sleutel}} wordt vervangen door de waarde uit config.json, in .html, .xml, .svg, .txt,
  _headers en _redirects. In HTML en XML wordt de waarde veilig gemaakt (& < > " ').
  In <script type="application/ld+json"> wordt hij als JSON-tekst ingevuld.
- {{#sleutel}} ... {{/sleutel}}: dat stuk blijft alleen staan als de sleutel in config.json is ingevuld:
  niet leeg en geen [invulveld]. Staan de twee markeringen elk op een eigen regel, dan verdwijnen die
  regels helemaal. Zo komt de spamcontrole (Turnstile) alleen op de site als turnstile_sitekey is ingevuld,
  en de regel met het btw-id pas als btw_id is ingevuld.
- turnstile_sitekey mag leeg zijn: dan staat Turnstile uit. De andere velden mogen niet leeg zijn.
- btw_id mag ook op de productiebranch nog [btw-id] zijn. Het btw-id komt per brief van de Belastingdienst,
  binnen twee weken na de inschrijving bij de KvK. Tot dan staat de regel met het btw-id niet op de site.
- <span class="ph">...</span> is de streepjeslijn voor een invulveld. Staat er na het invullen
  geen [tekst tussen haken] meer in, dan haalt de build de streepjeslijn weg.
  Een e-mailadres wordt dan een klikbare mailto-link.
- Blijft er ergens {{ over, of is config.json niet in orde, dan stopt de build met exitcode 1
  en is er geen dist/. Cloudflare Pages zet de site dan niet online.

Alleen de standaardbibliotheek van Python (3.8 of nieuwer) is nodig.
"""
import argparse
import html
import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
CONFIG = ROOT / "config.json"
# Heet de productiebranch in Cloudflare Pages anders, pas dit dan aan.
PRODUCTIE_BRANCH = "main"

REQUIRED_KEYS = [
    "bedrijfsnaam", "domein", "email", "telefoon", "telefoon_e164",
    "eigenaar", "kvk", "btw_id", "plaats",
]
# Mogen leeg zijn of ontbreken (dan geldt de waarde hier). Leeg turnstile_sitekey: Turnstile staat uit.
OPTIONAL_KEYS = {"turnstile_sitekey": ""}
# Mogen ook bij --streng (en dus op de productiebranch) nog een [invulveld] zijn. Het btw-id komt per brief,
# binnen twee weken na de inschrijving bij de KvK. Tot dan laat {{#btw_id}} de regel met het btw-id weg.
LATER_KEYS = {"btw_id"}
# Zo noemt de privacyverklaring Turnstile zolang het uit staat. Staat Turnstile aan, dan moet dit eruit.
TURNSTILE_NOG_UIT = "als we dit aanzetten"
HTML_SUFFIXES = {".html"}
XML_SUFFIXES = {".xml", ".svg"}
RAW_SUFFIXES = {".txt"}
RAW_NAMES = {"_headers", "_redirects"}
# Alleen voor de controle op overgebleven {{: alle tekstbestanden.
TEXT_SUFFIXES = HTML_SUFFIXES | XML_SUFFIXES | RAW_SUFFIXES | {".js", ".css", ".json", ".webmanifest", ".md"}

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
# {{#sleutel}} ... {{/sleutel}}, eerst met de markeringen op eigen regels, daarna midden in een regel.
SECTION_LINES = re.compile(
    r"^[ \t]*\{\{#([A-Za-z_][A-Za-z0-9_]*)\}\}[ \t]*\n(.*?)^[ \t]*\{\{/\1\}\}[ \t]*(?:\n|\Z)", re.S | re.M)
SECTION = re.compile(r"\{\{#([A-Za-z_][A-Za-z0-9_]*)\}\}(.*?)\{\{/\1\}\}", re.S)
JSON_LD = re.compile(r'(<script type="application/ld\+json">)(.*?)(</script>)', re.S)
PH_SPAN = re.compile(r'<span class="ph">([^<]*)</span>')
BRACKETS = re.compile(r"\[[^\]]+\]")
DOMAIN = re.compile(r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
EMAIL = re.compile(r"^[^\s@<>\"]+@[^\s@<>\"]+\.[^\s@<>\"]+$")
E164 = re.compile(r"^\+[1-9][0-9]{7,14}$")
# Letters (ook met accent), cijfers, spaties en & ' . -. Dan blijft de afzender van de formuliermail geldig.
BEDRIJFSNAAM = re.compile(r"^[^\W_](?:[^\W_]|[ &'.\-])*$")
SITEKEY = re.compile(r"^[0-9A-Za-z_-]{10,100}$")
# De testsleutels van Turnstile (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
TURNSTILE_TEST_KEY = re.compile(r"^[123]x0{20}[A-Z]{2}$")


def is_open_field(value):
    """True als de waarde nog een invulveld bevat, zoals [naam ouder]."""
    return bool(BRACKETS.search(value))


def is_filled(value):
    """True als de waarde echt is ingevuld: niet leeg en geen invulveld zoals [btw-id]."""
    return bool(value.strip()) and not is_open_field(value)


def load_config():
    if not CONFIG.is_file():
        return None, [f"{CONFIG.name} ontbreekt."]
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return None, [f"{CONFIG.name} is geen geldige JSON: {exc}"]
    if not isinstance(cfg, dict):
        return None, [f"{CONFIG.name} moet een object zijn: {{ \"sleutel\": \"waarde\", ... }}."]

    errors = []
    for key in REQUIRED_KEYS:
        if key not in cfg:
            errors.append(f'config.json mist "{key}".')
    for key, default in OPTIONAL_KEYS.items():
        cfg.setdefault(key, default)
    for key, value in cfg.items():
        if not isinstance(value, str):
            errors.append(f'"{key}" in config.json moet tekst tussen aanhalingstekens zijn.')
        elif not value.strip() and key not in OPTIONAL_KEYS:
            errors.append(f'"{key}" in config.json is leeg.')
        elif re.search(r"[\x00-\x1f\x7f]", value):
            errors.append(f'"{key}" in config.json bevat een enter of tab. Zet alles op één regel.')
        elif "{{" in value or "}}" in value:
            errors.append(f'"{key}" in config.json mag geen {{{{ of }}}} bevatten.')
    if errors:
        return None, errors

    if not DOMAIN.match(cfg["domein"]):
        errors.append(
            f'"domein" moet een kale domeinnaam in kleine letters zijn, zoals voorbeeld.nl '
            f'(zonder https:// en zonder / aan het eind). Nu staat er: {cfg["domein"]}'
        )
    if not E164.match(cfg["telefoon_e164"]):
        errors.append(f'"telefoon_e164" moet de vorm +31612345678 hebben. Nu staat er: {cfg["telefoon_e164"]}')
    if not is_open_field(cfg["email"]) and not EMAIL.match(cfg["email"]):
        errors.append(f'"email" is geen geldig e-mailadres: {cfg["email"]}')
    if not BEDRIJFSNAAM.match(cfg["bedrijfsnaam"]):
        errors.append(
            '"bedrijfsnaam" mag alleen letters, cijfers, spaties en de tekens & \' . - bevatten, '
            f'en moet beginnen met een letter of cijfer. Nu staat er: {cfg["bedrijfsnaam"]}'
        )
    if cfg["turnstile_sitekey"] and not SITEKEY.match(cfg["turnstile_sitekey"]):
        errors.append(
            '"turnstile_sitekey" moet leeg zijn (Turnstile uit) of de sitekey van je Turnstile-widget '
            f'(letters, cijfers, - en _). Nu staat er: {cfg["turnstile_sitekey"]}'
        )
    return cfg, errors


def escape_html(value):
    return html.escape(value, quote=True)


def escape_json(value):
    # JSON-tekst zonder de buitenste aanhalingstekens, veilig binnen een <script>-blok.
    return (json.dumps(value, ensure_ascii=False)[1:-1]
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))


def raw(value):
    return value


def sections(text, cfg, unknown):
    """Laat {{#sleutel}} ... {{/sleutel}} staan als de sleutel is ingevuld, anders gaat het stuk weg."""
    def repl(match):
        key = match.group(1)
        if key not in cfg:
            unknown.add(key)
            return match.group(0)  # blijft staan; de controle op {{ meldt het met regelnummer
        return match.group(2) if is_filled(cfg[key]) else ""
    return SECTION.sub(repl, SECTION_LINES.sub(repl, text))


def substitute(text, cfg, escape, unknown):
    def repl(match):
        key = match.group(1)
        if key not in cfg:
            unknown.add(key)
            return match.group(0)  # blijft staan; de controle hieronder meldt het met regelnummer
        return escape(cfg[key])
    return PLACEHOLDER.sub(repl, text)


def unwrap_filled(match):
    inner = match.group(1)
    plain = html.unescape(inner)
    if is_open_field(plain):
        return match.group(0)  # nog niet ingevuld: streepjeslijn laten staan
    if EMAIL.match(plain):
        return f'<a href="mailto:{inner}">{inner}</a>'
    return inner


def render_html(text, cfg, unknown):
    text = JSON_LD.sub(
        lambda m: m.group(1) + substitute(m.group(2), cfg, escape_json, unknown) + m.group(3), text)
    text = substitute(text, cfg, escape_html, unknown)
    return PH_SPAN.sub(unwrap_filled, text)


def kind_of(path):
    if path.name in RAW_NAMES or path.suffix in RAW_SUFFIXES:
        return "raw"
    if path.suffix in HTML_SUFFIXES:
        return "html"
    if path.suffix in XML_SUFFIXES:
        return "xml"
    return None


def is_text_file(path):
    return path.suffix in TEXT_SUFFIXES or path.name in RAW_NAMES


def fail(errors):
    if DIST.exists():
        shutil.rmtree(DIST)
    print("\nBOUWEN MISLUKT. Er is geen dist/ gemaakt.", file=sys.stderr)
    for err in errors:
        print(f"  - {err}", file=sys.stderr)
    sys.exit(1)


def build(strict):
    cfg, errors = load_config()
    if errors:
        fail(errors)
    if not SRC.is_dir():
        fail(["De map src/ ontbreekt."])

    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(SRC, DIST)

    unknown = set()
    filled = []
    for path in sorted(p for p in DIST.rglob("*") if p.is_file()):
        kind = kind_of(path)
        if kind is None:
            continue
        rel = path.relative_to(DIST).as_posix()
        text = path.read_text(encoding="utf-8")
        new = sections(text, cfg, unknown)
        if kind == "html":
            new = render_html(new, cfg, unknown)
            for block in JSON_LD.finditer(new):
                try:
                    json.loads(block.group(2))
                except json.JSONDecodeError as exc:
                    errors.append(f"{rel}: het JSON-LD-blok is na het invullen geen geldige JSON: {exc}")
        elif kind == "xml":
            new = substitute(new, cfg, escape_html, unknown)
        else:
            new = substitute(new, cfg, raw, unknown)
        if new != text:
            path.write_text(new, encoding="utf-8")
            filled.append(rel)

    for key in sorted(unknown):
        errors.append(f'Onbekende placeholder {{{{{key}}}}}. Zet "{key}" in config.json of haal hem weg uit src/.')
    for path in sorted(p for p in DIST.rglob("*") if p.is_file() and is_text_file(p)):
        rel = path.relative_to(DIST).as_posix()
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if "{{" in line:
                errors.append(f"{rel}, regel {lineno}: er staat nog {{{{ in: {line.strip()[:100]}")

    open_fields = [key for key, value in cfg.items() if is_open_field(value)]
    if TURNSTILE_TEST_KEY.match(cfg["turnstile_sitekey"]):
        open_fields.append("turnstile_sitekey (nog de testsleutel)")
    must_fill = [key for key in open_fields if key not in LATER_KEYS]
    if strict and must_fill:
        errors.append("Nog niet ingevuld in config.json: " + ", ".join(must_fill) + ".")

    # Staat Turnstile aan, dan moet de privacyverklaring zeggen dat het aan staat. Ze moet Turnstile noemen,
    # en niet meer met "als we dit aanzetten". Staat Turnstile uit, dan mag ze het zo noemen.
    turnstile = bool(cfg["turnstile_sitekey"].strip())
    privacy = DIST / "privacy.html"
    privacy_text = privacy.read_text(encoding="utf-8") if privacy.is_file() else ""
    notes = []
    problem = None
    if turnstile and "Turnstile" not in privacy_text:
        problem = ("Turnstile staat aan (turnstile_sitekey is ingevuld), maar de privacyverklaring noemt "
                   "Turnstile niet. Zet dat er eerst in (zie README, Turnstile aanzetten).")
    elif turnstile and TURNSTILE_NOG_UIT in " ".join(privacy_text.lower().split()):
        problem = ("Turnstile staat aan (turnstile_sitekey is ingevuld), maar de privacyverklaring zegt nog "
                   f'"{TURNSTILE_NOG_UIT}". Pas eerst de alinea over Turnstile en de regel van Cloudflare in de '
                   "tabel aan (zie README, Turnstile aanzetten).")
    if problem:
        (errors if strict else notes).append(problem)
    if errors:
        fail(errors)

    files = sorted(p.relative_to(DIST).as_posix() for p in DIST.rglob("*") if p.is_file())
    print(f"Klaar: {len(files)} bestanden in dist/ voor {cfg['bedrijfsnaam']} ({cfg['domein']}).")
    print("Ingevuld uit config.json: " + ", ".join(filled) + ".")
    print("Spamcontrole (Turnstile): " + ("aan." if turnstile else "uit, want turnstile_sitekey is leeg."))
    if must_fill:
        print("Let op: deze velden in config.json zijn nog niet ingevuld: " + ", ".join(must_fill) + ".")
        print("De site toont daar nu de tekst tussen [ ]. Vul ze in voordat je de site echt gebruikt.")
    if "btw_id" in open_fields:
        print("Let op: btw_id is nog niet ingevuld. De regel met het btw-id staat daarom nog niet op de site. "
              "Vul het in zodra de brief van de Belastingdienst er is.")
    for note in notes:
        print(f"Let op: {note}")


def main():
    parser = argparse.ArgumentParser(description="Bouw de website van src/ naar dist/.")
    parser.add_argument("--streng", "--strict", dest="strict", action="store_true",
                        help="stop met een fout als config.json nog [invulvelden] bevat (btw_id mag nog open "
                             "zijn), of als Turnstile aan staat en de privacyverklaring dat niet zegt")
    args = parser.parse_args()
    branch = os.environ.get("CF_PAGES_BRANCH", "")
    strict = args.strict or branch == PRODUCTIE_BRANCH
    if strict and not args.strict:
        print(f"Strenge controle staat aan: dit is een build van de productiebranch ({branch}).")
    build(strict)


if __name__ == "__main__":
    main()
