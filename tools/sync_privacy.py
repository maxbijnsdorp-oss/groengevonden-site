#!/usr/bin/env python3
"""Maakt src/privacy.html uit deel 1 van de privacyverklaring (10-Privacyverklaring.md).

Gebruik (vanuit de hoofdmap van de repo):
    python3 tools/sync_privacy.py
    python3 tools/sync_privacy.py --versie "Versie 1.3, december 2026"

Wat het doet:
- leest deel 1 van de bron: van "### Wie wij zijn" tot de laatste --- voor "## Deel 2";
- past de correcties uit tools/privacy-bron.json toe: plekken waar de bron nog niet klopt met deze site;
- zet de Markdown om met pandoc, met dezelfde opties als website/privacy.html;
- zet {{placeholders}} op de plek van de vaste namen en [invulvelden];
- neemt de versieregel over uit ../website/privacy.html, of uit --versie;
- laat de <head> van src/privacy.html staan zoals hij is.

Draai daarna python3 build.py en python3 tests/check_dist.py.
Nodig: Python 3.8 of nieuwer en pandoc. Alleen voor dit script, de build zelf heeft pandoc niet nodig.
"""
import argparse
import html
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETTINGS = ROOT / "tools" / "privacy-bron.json"
OUT = ROOT / "src" / "privacy.html"
# Zonder smart (-smart): rechte aanhalingstekens en geen kastlijnen, net als website/privacy.html.
PANDOC_FORMAT = "markdown-smart+lists_without_preceding_blankline+hard_line_breaks"


def stop(message):
    sys.exit(f"STOP: {message}")


def part_one(markdown):
    lines = markdown.split("\n")
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == "### Wie wij zijn")
        deel2 = next(i for i, line in enumerate(lines) if line.startswith("## Deel 2"))
        end = max(i for i in range(start, deel2) if lines[i].strip() == "---")
    except (StopIteration, ValueError):
        stop('deel 1 niet gevonden: de bron moet "### Wie wij zijn", "## Deel 2" en een --- daartussen hebben.')
    return "\n".join(lines[start:end]).strip() + "\n"


def apply_corrections(text, corrections):
    notes = []
    for number, correction in enumerate(corrections, 1):
        old, new = correction["oud"], correction["nieuw"]
        count = text.count(old)
        if count == 1:
            text = text.replace(old, new)
            notes.append(f"correctie {number} toegepast, de bron heeft hier nog de oude tekst: {correction['waarom']}")
        elif new in text:
            notes.append(f"correctie {number} is niet meer nodig, de bron heeft de nieuwe tekst al. "
                         f"Haal hem weg uit {SETTINGS.name}.")
        else:
            stop(f"correctie {number} past niet: de oude tekst staat {count} keer in de bron. "
                 f"Kijk de bron na en pas {SETTINGS.name} aan.")
    return text, notes


def main():
    settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
    parser = argparse.ArgumentParser(description="Maak src/privacy.html uit de privacyverklaring.")
    parser.add_argument("--bron", default=str((ROOT / settings["bron"]).resolve()))
    parser.add_argument("--master", default=str((ROOT / settings["master_html"]).resolve()),
                        help="HTML-versie van de bron, voor de versieregel")
    parser.add_argument("--versie", help='bijvoorbeeld "Versie 1.3, december 2026"')
    args = parser.parse_args()

    if not shutil.which("pandoc"):
        stop("pandoc ontbreekt. Installeer het (https://pandoc.org/installing.html) of vraag het Claude.")
    bron = Path(args.bron)
    if not bron.is_file():
        stop(f"de bron {bron} bestaat niet.")

    if args.versie:
        version = html.escape(args.versie)
    else:
        master = Path(args.master)
        found = re.search(r'<p class="meta">(.*?)</p>', master.read_text(encoding="utf-8")) if master.is_file() else None
        if not found:
            stop(f"geen versieregel gevonden in {master}. Geef hem mee met --versie.")
        version = found.group(1)

    # Verwijzingen naar interne bestanden, zoals " (zie 09-Verwerkersovereenkomst.md)", horen niet op de site.
    body_md = re.sub(r" \(zie [^()\n]*\.md\)", "", part_one(bron.read_text(encoding="utf-8")))
    body_md, notes = apply_corrections(body_md, settings["correcties"])
    body = subprocess.run(["pandoc", "-f", PANDOC_FORMAT, "-t", "html", "--wrap=none"],
                          input=body_md, capture_output=True, text=True, check=True).stdout

    body = body.replace("<table>", '<div class="tbl"><table>').replace("</table>", "</table></div>")
    for field in settings["invulvelden"]:
        value = "{{" + field["sleutel"] + "}}"
        body = body.replace(field["tekst"], f'<span class="ph">{value}</span>' if field["streepjes"] else value)
    # Een kop-id met de bedrijfsnaam erin (je-bent-klant-van-groen-gevonden) wordt je-bent-klant.
    name = next(field["tekst"] for field in settings["invulvelden"] if field["sleutel"] == "bedrijfsnaam")
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    body = re.sub(rf'(id="[^"]*?)-(?:van-)?{re.escape(slug)}"', r'\1"', body)
    body = body.replace('<h3 id="wie-wij-zijn">', '<h3 id="wie-wij-zijn" style="border-top:0;margin-top:24px">', 1)

    leftovers = [field["tekst"] for field in settings["invulvelden"] if field["tekst"] in body]
    leftovers += re.findall(r"\[[^\]<>]*\]|\S+\.md\b|index\.html", body)
    leftovers += [slug] if slug in body else []
    if leftovers:
        stop("deze tekst staat er na het omzetten nog: " + ", ".join(sorted(set(leftovers))))

    old_page = OUT.read_text(encoding="utf-8")
    head = old_page[: old_page.index("<body>")]
    page = (head + "<body>\n<div class=\"wrap\">\n"
            + "<a class=\"back\" href=\"/\">&larr; Terug naar {{bedrijfsnaam}}</a>\n"
            + "<h1>Privacyverklaring</h1>\n"
            + f"<p class=\"meta\">{version}</p>\n"
            + body.strip() + "\n</div>\n</body>\n</html>\n")
    OUT.write_text(page, encoding="utf-8")

    for note in notes:
        print(f"LET OP: {note}")
    if any("toegepast" in note for note in notes):
        print(f"Neem de toegepaste correcties ook over in {bron.name}, dan klopt de bron weer.")
    print(f"Klaar: {OUT.relative_to(ROOT)} ({version}).")


if __name__ == "__main__":
    main()
