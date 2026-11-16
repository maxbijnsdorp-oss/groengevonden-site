#!/usr/bin/env python3
"""Maakt docs/ voor GitHub Pages: een gratis, voorlopige versie van de site.

Gebruik (vanuit de hoofdmap van de repo):
    python3 build.py
    python3 tools/maak_github_pages.py

Wat het doet met de bestanden uit dist/:
- zet het pad van de repo voor alle links (/groengevonden-site/...), want GitHub Pages
  zet de site in een submap;
- zet 'noindex' op elke pagina, zodat Google de voorlopige versie niet opneemt;
- vervangt het versturen via /api/scan door versturen via FormSubmit (formsubmit.co), een gratis dienst
  die de aanvraag doorstuurt naar het mailadres uit config.json. GitHub Pages kan zelf geen formulieren
  verwerken. De eerste aanvraag levert één activatiemail op in die mailbox;
- zet een regel 'Voorlopige versie' op elke pagina en een uitleg op de privacypagina;
- laat _headers, robots.txt en sitemap.xml weg (die zijn voor Cloudflare en voor Google);
- staat er een "eigen_domein" in tools/github-pages.json, dan komt de site in de hoofdmap van dat domein
  en maakt het script het bestand docs/CNAME. Vul dat pas in als het domein gekocht is en de DNS klopt.

De echte site (Cloudflare Pages, eigen domein, werkend formulier) blijft dist/. Zie README.
"""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DOCS = ROOT / "docs"
PAGES = json.loads((ROOT / "tools" / "github-pages.json").read_text(encoding="utf-8"))
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
# Met een eigen domein staat de site in de hoofdmap. Zonder eigen domein in de submap van de repo.
EIGEN_DOMEIN = PAGES.get("eigen_domein", "").strip()
PREFIX = "" if EIGEN_DOMEIN else "/" + PAGES["repo"]
BASE_URL = f"https://{EIGEN_DOMEIN}" if EIGEN_DOMEIN else f"https://{PAGES['gebruiker']}.github.io{PREFIX}"

NOTICE = (
    '<div style="background:#7a4688;color:#fff;font:600 14px/1.4 system-ui,sans-serif;'
    'padding:8px 16px;text-align:center">Voorlopige versie. Dit bedrijf is nog in oprichting.</div>'
)
PRIVACY_NOTE = (
    '<p style="border:1px solid currentColor;border-radius:8px;padding:12px 14px">'
    "<b>Voorlopige versie.</b> Deze versie van de site staat tijdelijk bij GitHub Pages, niet bij Cloudflare. "
    "GitHub ziet daarbij je IP-adres. Het formulier stuurt je aanvraag via de dienst FormSubmit (formsubmit.co) "
    "naar onze mailbox. FormSubmit verwerkt daarbij wat je invult, alleen om het bericht bij ons af te leveren. "
    "Op de definitieve site vervalt deze tussenstap.</p>"
)


def stop(message):
    sys.exit(f"STOP: {message}")


def once(text, old, new, name):
    if text.count(old) != 1:
        stop(f"{name}: verwachtte precies één keer: {old[:60]!r}")
    return text.replace(old, new)


def page(text, name):
    # Paden die met / beginnen krijgen de submap van GitHub Pages ervoor.
    text = re.sub(r'(href|src|action|data-endpoint)="/(?!/)', rf'\1="{PREFIX}/', text)
    # Het eigen domein bestaat nog niet. Verwijs naar het adres bij GitHub.
    text = text.replace(f"https://{CONFIG['domein']}", BASE_URL)
    text = once(text, "<head>", '<head>\n<meta name="robots" content="noindex, nofollow">', name)
    text = re.sub(r"(<body[^>]*>)", lambda m: m.group(1) + "\n" + NOTICE, text, count=1)
    return text


if not DIST.is_dir():
    stop("dist/ bestaat niet. Draai eerst python3 build.py.")
if DOCS.exists():
    shutil.rmtree(DOCS)
DOCS.mkdir()

for source in sorted(DIST.rglob("*")):
    relative = source.relative_to(DIST)
    if source.is_dir() or relative.name in ("_headers", "robots.txt", "sitemap.xml"):
        continue
    target = DOCS / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.suffix == ".html":
        html = page(source.read_text(encoding="utf-8"), relative.name)
        if relative.name == "index.html":
            html = once(html, f'<script src="{PREFIX}/main.js" defer></script>',
                        f'<script src="{PREFIX}/main.js" defer></script>\n'
                        f'<script src="{PREFIX}/pages-form.js" defer></script>', relative.name)
        if relative.name == "privacy.html":
            html = once(html, "<h1>Privacyverklaring</h1>", "<h1>Privacyverklaring</h1>\n" + PRIVACY_NOTE, relative.name)
        target.write_text(html, encoding="utf-8")
    elif source.suffix == ".css":
        css = source.read_text(encoding="utf-8")
        target.write_text(re.sub(r"url\((['\"]?)/(?!/)", rf"url(\1{PREFIX}/", css), encoding="utf-8")
    else:
        shutil.copyfile(source, target)

form_js = (ROOT / "tools" / "github-pages-form.js").read_text(encoding="utf-8")
form_js = form_js.replace("__EMAIL__", CONFIG["email"]).replace("__TELEFOON__", CONFIG["telefoon"])
(DOCS / "pages-form.js").write_text(form_js, encoding="utf-8")
# Zonder dit bestand haalt GitHub de site door Jekyll. Dat is niet nodig.
(DOCS / ".nojekyll").write_text("", encoding="utf-8")
# GitHub leest het eigen domein uit dit bestand. Zonder eigen domein hoort het er niet te staan.
if EIGEN_DOMEIN:
    (DOCS / "CNAME").write_text(EIGEN_DOMEIN + "\n", encoding="utf-8")

left = [p.name for p in DOCS.glob("*.html") if PREFIX and re.search(r'(href|src)="/(?!/|' + PAGES["repo"] + ")", p.read_text(encoding="utf-8"))]
if left:
    stop(f"er staan nog paden zonder submap in: {', '.join(left)}")
print(f"Klaar: docs/ voor {BASE_URL}/ ({len(list(DOCS.rglob('*')))} bestanden).")
