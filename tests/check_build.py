#!/usr/bin/env python3
"""Test de strenge controle van build.py, in tijdelijke kopieën. Alleen de standaardbibliotheek van Python.

Gebruik (vanuit de hoofdmap van de repo):
    python3 tests/check_build.py

Controleert:
- zonder --streng bouwt de site met [invulvelden] en noemt build.py ze
- met --streng, en op de productiebranch (CF_PAGES_BRANCH=main), stopt de build zolang er nog een [invulveld]
  staat, behalve btw_id. Een andere branch (een preview) bouwt wel.
- btw_id nog open: de build van main lukt, en de regel met het btw-id staat niet op de site.
  btw_id ingevuld: de regel staat er wel, met het btw-id.
- Turnstile aan en de privacyverklaring zegt nog "als we dit aanzetten": --streng stopt, zonder --streng
  bouwt hij met een waarschuwing
- Turnstile aan en de privacyverklaring noemt Turnstile niet: --streng stopt
- Turnstile aan en de privacyverklaring is aangepast: --streng bouwt
- turnstile_sitekey is nog de testsleutel van Cloudflare: --streng stopt

Elke test draait in een eigen kopie van build.py, config.json en src/, met testwaarden. Je eigen config.json,
src/ en dist/ blijven zoals ze zijn.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOG_UIT = "als we dit aanzetten"
# Zoals config.json nu is: alles nog open, Turnstile uit.
OPEN = {"email": "[e-mailadres]", "eigenaar": "[naam ouder]", "kvk": "[KvK-nummer]", "btw_id": "[btw-id]",
        "contactpersoon": "Max [achternaam]", "turnstile_sitekey": ""}
# Zoals op de dag van de KvK-afspraak: alles ingevuld behalve het btw-id. Testwaarden, niet echt.
KVK_DAG = dict(OPEN, email="info@example.com", eigenaar="Test Ouder", kvk="12345678", contactpersoon="Max Test")
BTW_ID = "NL123456789B01"  # het voorbeeld van de KvK, geen echt btw-id
SITEKEY = "0x4AAAAAAAtestsitekey00"  # geen echte sitekey, en ook niet de testsleutel van Cloudflare
TEST_SITEKEY = "1x00000000000000000000AA"  # de testsleutel van Cloudflare

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))


def privacy_nog_uit(text):
    """De privacyverklaring noemt Turnstile als iets dat we kunnen aanzetten."""
    if NOG_UIT not in text.lower():
        text = text.replace("</body>", "<p>Als we dit aanzetten, gebruiken we Cloudflare Turnstile.</p>\n</body>")
    return text


def privacy_aan(text):
    """De privacyverklaring zegt dat Turnstile aan staat: "als we dit aanzetten" is eruit."""
    text = re.sub(r"Als we dit aanzetten, gebruiken we", "We gebruiken", text)
    text = re.sub(r",?\s*als we dit aanzetten", "", text, flags=re.I)
    if "Turnstile" not in text:
        text = text.replace("</body>", "<p>We gebruiken Cloudflare Turnstile.</p>\n</body>")
    return text


def privacy_zonder_turnstile(text):
    """De privacyverklaring noemt Turnstile helemaal niet."""
    return text.replace("Turnstile", "spamcontrole")


def build(work, name, settings, args=(), branch=None, privacy=None):
    """Bouwt in een eigen kopie. Geeft (exitcode, uitvoer, dist-map)."""
    site = work / name
    site.mkdir()
    shutil.copy2(ROOT / "build.py", site / "build.py")
    shutil.copytree(ROOT / "src", site / "src")
    cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    cfg.update(settings)
    (site / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if privacy:
        page = site / "src" / "privacy.html"
        page.write_text(privacy(page.read_text(encoding="utf-8")), encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k != "CF_PAGES_BRANCH"}
    if branch:
        env["CF_PAGES_BRANCH"] = branch
    run = subprocess.run([sys.executable, str(site / "build.py"), *args], env=env, cwd=str(site),
                         capture_output=True, text=True)
    return run.returncode, run.stdout + run.stderr, site / "dist"


def last_lines(output):
    return " | ".join(line.strip() for line in output.strip().splitlines()[-4:])


def main():
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)

        code, out, dist = build(work, "open", OPEN)
        check("invulvelden, zonder --streng: bouwt en noemt de open velden",
              code == 0 and dist.is_dir() and "nog niet ingevuld" in out, last_lines(out))

        code, out, dist = build(work, "open-streng", OPEN, ["--streng"])
        check("invulvelden, --streng: stopt, zonder dist/, en noemt btw_id niet als reden",
              code == 1 and not dist.exists()
              and "Nog niet ingevuld in config.json: email, eigenaar, kvk, contactpersoon." in out,
              last_lines(out))

        code, out, dist = build(work, "open-main", OPEN, branch="main")
        check("invulvelden, CF_PAGES_BRANCH=main: stopt (main is altijd streng)",
              code == 1 and not dist.exists() and "Nog niet ingevuld" in out, last_lines(out))

        code, out, dist = build(work, "open-test", OPEN, branch="test")
        check("invulvelden, CF_PAGES_BRANCH=test: bouwt (een preview mag invulvelden hebben)",
              code == 0 and dist.is_dir(), last_lines(out))

        code, out, dist = build(work, "kvk-dag", KVK_DAG, branch="main")
        index = (dist / "index.html").read_text(encoding="utf-8") if dist.is_dir() else ""
        check("alles behalve btw_id ingevuld, CF_PAGES_BRANCH=main: bouwt, met KvK-nummer en zonder regel voor het btw-id",
              code == 0 and "KvK 12345678" in index and "Btw-id" not in index
              and "btw_id is nog niet ingevuld" in out, last_lines(out))

        code, out, dist = build(work, "btw", dict(KVK_DAG, btw_id=BTW_ID), ["--streng"])
        index = (dist / "index.html").read_text(encoding="utf-8") if dist.is_dir() else ""
        check("btw_id ingevuld, --streng: bouwt, met het btw-id onderaan de site",
              code == 0 and f"Btw-id {BTW_ID}" in index and "btw_id is nog niet ingevuld" not in out,
              last_lines(out))

        code, out, dist = build(work, "kvk-open", dict(KVK_DAG, kvk="[KvK-nummer]"), ["--streng"])
        check("alleen kvk nog open, --streng: stopt en noemt kvk",
              code == 1 and "Nog niet ingevuld in config.json: kvk." in out, last_lines(out))

        aan = dict(KVK_DAG, btw_id=BTW_ID, turnstile_sitekey=SITEKEY)
        code, out, dist = build(work, "ts-nog-uit-streng", aan, ["--streng"], privacy=privacy_nog_uit)
        check(f'Turnstile aan, privacyverklaring zegt nog "{NOG_UIT}", --streng: stopt',
              code == 1 and not dist.exists() and f'zegt nog "{NOG_UIT}"' in out, last_lines(out))

        code, out, dist = build(work, "ts-nog-uit", aan, privacy=privacy_nog_uit)
        check(f'Turnstile aan, privacyverklaring zegt nog "{NOG_UIT}", zonder --streng: bouwt met een waarschuwing',
              code == 0 and dist.is_dir() and "Let op: Turnstile staat aan" in out and NOG_UIT in out,
              last_lines(out))

        code, out, dist = build(work, "ts-niet-genoemd", aan, ["--streng"], privacy=privacy_zonder_turnstile)
        check("Turnstile aan, privacyverklaring noemt Turnstile niet, --streng: stopt",
              code == 1 and "noemt Turnstile niet" in out, last_lines(out))

        code, out, dist = build(work, "ts-aan", aan, ["--streng"], privacy=privacy_aan)
        check("Turnstile aan, privacyverklaring aangepast, --streng: bouwt",
              code == 0 and dist.is_dir() and "Spamcontrole (Turnstile): aan." in out, last_lines(out))

        code, out, dist = build(work, "ts-testsleutel", dict(aan, turnstile_sitekey=TEST_SITEKEY), ["--streng"],
                                privacy=privacy_aan)
        check("turnstile_sitekey is de testsleutel, --streng: stopt",
              code == 1 and "turnstile_sitekey (nog de testsleutel)" in out, last_lines(out))

    failed = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print(f"{'OK  ' if ok else 'FOUT'}  {name}" + ("" if ok or not detail else f"\n      {detail}"))
    print(f"\n{len(results) - len(failed)} van {len(results)} controles OK.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
