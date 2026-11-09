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
- de toestemmingstekst in de functie is gelijk aan de tekst bij het vinkje
- de maxlength van de velden is gelijk aan de limieten in de functie
- geen lange of halve kastlijnen (gedachtestreepjes) in de teksten
"""
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
SRC = ROOT / "src"
FUNCTION = ROOT / "functions" / "api" / "scan.js"
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
        "param", "source", "track", "wbr"}
TEXT_SUFFIXES = {".html", ".xml", ".svg", ".txt", ".js", ".css", ".json", ".md"}
TEXT_NAMES = {"_headers", "_redirects"}
GEMEENTEN = 13

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.problems, self.ids, self.refs, self.scripts = [], [], {}, [], []
        self.elements = []  # (tag, attrs) van alle elementen
        self.text_stack = []  # voor de toestemmingstekst
        self.consent_text = None
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
            self.text_stack.append([])

    def handle_startendtag(self, tag, attrs):
        self._attrs(tag, attrs)

    def handle_data(self, data):
        if self.text_stack:
            self.text_stack[-1].append(data)

    def handle_endtag(self, tag):
        line = self.getpos()[0]
        if tag in VOID:
            self.problems.append(f"regel {line}: sluittag </{tag}> hoort niet bij een leeg element")
            return
        if tag == "label" and self.text_stack:
            self.consent_text = " ".join("".join(self.text_stack.pop()).split())
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

    consent_parts = re.search(r"const CONSENT_TEXT =\s*((?:`[^`]*`\s*\+?\s*)+);", function_src)
    if consent_parts:
        fn_text = "".join(re.findall(r"`([^`]*)`", consent_parts.group(1)))
        fn_text = " ".join(fn_text.replace("${config.bedrijfsnaam}", cfg["bedrijfsnaam"]).split())
        check("toestemmingstekst in de functie is gelijk aan de tekst bij het vinkje",
              fn_text == index.consent_text, f"\n    pagina:  {index.consent_text}\n    functie: {fn_text}")
    else:
        check("toestemmingstekst in de functie gevonden", False, "CONSENT_TEXT niet gevonden in scan.js")

    # 5. Headers
    headers = (DIST / "_headers").read_text(encoding="utf-8")
    csp = re.search(r"Content-Security-Policy:\s*(.+)", headers)
    csp_value = csp.group(1) if csp else ""
    script_src = re.search(r"script-src ([^;]+)", csp_value)
    problems = []
    if not csp:
        problems.append("geen CSP")
    elif not script_src or "'unsafe-inline'" in script_src.group(1):
        problems.append("script-src ontbreekt of staat 'unsafe-inline' toe")
    for needed in ["frame-ancestors 'none'", "https://fonts.googleapis.com", "https://fonts.gstatic.com",
                   "https://static.cloudflareinsights.com", "https://cloudflareinsights.com",
                   "X-Content-Type-Options: nosniff", "Referrer-Policy:", "Permissions-Policy:"]:
        if needed not in headers:
            problems.append(f"mist {needed}")
    if any(len(line) > 2000 for line in headers.splitlines()):
        problems.append("een regel is langer dan 2000 tekens (limiet van Cloudflare)")
    check("_headers: CSP en beveiligingsheaders", not problems, "; ".join(problems))

    # 6. Bedrijfsnaam en domein alleen in config.json
    literals = [cfg["bedrijfsnaam"], cfg["domein"], "groengevonden.nl"]
    hits = []
    for base in (SRC, ROOT / "functions"):
        for p in text_files(base):
            text = p.read_text(encoding="utf-8")
            for lit in literals:
                if lit.lower() in text.lower():
                    hits.append(f"{p.relative_to(ROOT)} bevat \"{lit}\"")
    check("bedrijfsnaam en domein staan alleen in config.json", not hits, "; ".join(hits))

    # 7. Geen gedachtestreepjes in de teksten
    dash_files = []
    for p in text_files(SRC) + text_files(ROOT / "functions") + [ROOT / "README.md", ROOT / "build.py"]:
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
