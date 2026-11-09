/**
 * Cloudflare Pages Function voor het scanformulier: POST /api/scan
 *
 * - Neemt JSON (van main.js) of een gewoon formulier (zonder JavaScript) aan.
 * - Controleert naam, bedrijf, e-mail, gemeente en de toestemming.
 * - Honeypot: is het verborgen veld bedrijfswebsite_extra ingevuld, dan antwoorden we 200
 *   en sturen we niets (spambot).
 * - Verstuurt een platte-tekstmail via de Resend HTTP API.
 *
 * Omgevingsvariabelen (Cloudflare: Settings > Variables and Secrets):
 *   RESEND_API_KEY  geheime API-sleutel van Resend (als Secret)
 *   FROM_EMAIL      afzender op een domein dat in Resend is geverifieerd,
 *                   bijvoorbeeld formulier@jouwdomein.nl (de bedrijfsnaam zet de functie er zelf voor)
 *   TO_EMAIL        waar de aanvraag heen moet; meerdere adressen met komma's scheiden
 *
 * Statuscodes: 200 verstuurd (of honeypot), 400 velden ontbreken of te lang, 403 ander domein,
 * 405 andere methode dan POST, 413 te groot, 415 verkeerd formaat,
 * 500 instellingen ontbreken, 502 Resend gaf een fout of was niet bereikbaar.
 */
import config from "../../config.json";

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 16 * 1024;
const HONEYPOT = "bedrijfswebsite_extra";

// Maximale lengte per veld. Gelijk aan de maxlength in src/index.html (gemeente is een keuzelijst).
const LIMITS = { naam: 100, bedrijf: 120, email: 254, telefoon: 30, gemeente: 60, website: 300 };
const REQUIRED_LABELS = {
  naam: "je naam",
  bedrijf: "de naam van je bedrijf",
  email: "een geldig e-mailadres",
  gemeente: "je gemeente",
};
const FIELD_NAMES = {
  naam: "je naam",
  bedrijf: "de bedrijfsnaam",
  email: "het e-mailadres",
  telefoon: "het telefoonnummer",
  gemeente: "de gemeente",
  website: "de website",
};
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

// Dezelfde teksten als bij de twee vinkjes in src/index.html. Pas ze samen aan.
// tests/check_dist.py controleert na elke build dat CONSENT_TEXT gelijk is aan vinkje 1.
const CONSENT_TEXT =
  `Stuur mij de gratis scan per e-mail. ` +
  `Hoe we met je gegevens omgaan, staat in de privacyverklaring.`;
const VERVOLG_TEXT =
  "Ja, je mag me daarna hooguit twee berichten sturen over wat je zou doen en wat het kost. Stoppen kan altijd met STOP.";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export async function onRequestPost({ request, env }) {
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  const isJson = contentType.includes("application/json");
  const isMultipart = contentType.includes("multipart/form-data");
  const isForm = isMultipart || contentType.includes("application/x-www-form-urlencoded");
  // Een gewoon formulier (browser zonder JavaScript) krijgt een HTML-pagina terug, de rest JSON.
  const wantsHtml = !isJson && (request.headers.get("Accept") || "").includes("text/html");
  const reply = (status, body) => (wantsHtml ? htmlResponse(status, body) : jsonResponse(status, body));

  if (!sameOrigin(request)) {
    return reply(403, { ok: false, error: "Dit formulier werkt alleen vanaf onze eigen website." });
  }
  if (!isJson && !isForm) {
    return reply(415, { ok: false, error: "Stuur het formulier als JSON of als gewoon formulier." });
  }
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) {
    return reply(413, { ok: false, error: "Je aanvraag is te groot." });
  }

  let raw;
  try {
    raw = await readBody(request, isJson, isMultipart);
  } catch (err) {
    if (err && err.message === "te groot") {
      return reply(413, { ok: false, error: "Je aanvraag is te groot." });
    }
    return reply(400, { ok: false, error: "We konden je aanvraag niet lezen. Probeer het opnieuw." });
  }

  // Honeypot ingevuld: doe alsof het gelukt is, maar verstuur niets.
  if (clean(raw[HONEYPOT])) {
    return reply(200, { ok: true });
  }

  const data = {};
  for (const key of Object.keys(LIMITS)) data[key] = clean(raw[key]);
  const consent = raw.toestemming === true || raw.toestemming === "on" || raw.toestemming === "true";
  const vervolg = raw.vervolg === true || raw.vervolg === "on" || raw.vervolg === "true";

  const missing = [];
  if (!data.naam) missing.push("naam");
  if (!data.bedrijf) missing.push("bedrijf");
  if (!EMAIL_RE.test(data.email)) missing.push("email");
  if (!data.gemeente) missing.push("gemeente");
  const tooLong = Object.keys(LIMITS).filter((key) => data[key].length > LIMITS[key]);

  if (missing.length || tooLong.length || !consent) {
    const sentences = [];
    if (missing.length) {
      sentences.push("Vul nog in: " + missing.map((key) => REQUIRED_LABELS[key]).join(", ") + ".");
    }
    if (tooLong.length) {
      sentences.push(
        "Maak korter: " +
          tooLong.map((key) => `${FIELD_NAMES[key]} (maximaal ${LIMITS[key]} tekens)`).join(", ") +
          "."
      );
    }
    if (!consent) {
      sentences.push(
        (sentences.length ? "Zet ook het vinkje" : "Zet het vinkje") +
          " bij 'Stuur mij de gratis scan'. Zonder dat vinkje kunnen we je de scan niet mailen."
      );
    }
    return reply(400, {
      ok: false,
      error: sentences.join(" "),
      ontbreekt: consent ? missing : [...missing, "toestemming"],
      te_lang: tooLong,
    });
  }

  const missingEnv = ["RESEND_API_KEY", "FROM_EMAIL", "TO_EMAIL"].filter(
    (name) => !env[name] || !String(env[name]).trim()
  );
  if (missingEnv.length) {
    console.error(`scan: instellingen ontbreken: ${missingEnv.join(", ")}`);
    return reply(500, {
      ok: false,
      error: "Het formulier is nog niet klaar voor gebruik. Je aanvraag is niet verstuurd.",
      ontbrekende_instellingen: missingEnv,
    });
  }

  const receivedAt = new Date().toISOString();
  const text = [
    "Nieuwe aanvraag voor een gratis vindbaarheidsscan via de website.",
    "",
    `Naam: ${data.naam}`,
    `Bedrijf: ${data.bedrijf}`,
    `E-mailadres: ${data.email}`,
    `Telefoon: ${data.telefoon || "(niet ingevuld)"}`,
    `Gemeente: ${data.gemeente}`,
    `Website of Google-profiel: ${data.website || "(niet ingevuld)"}`,
    "",
    "Vinkje 1 (verplicht): aan. Tekst:",
    `"${CONSENT_TEXT}"`,
    `Vinkje 2 (vervolgberichten): ${vervolg ? "aan" : "uit, stuur ALLEEN de scan en geen vervolgmails"}. Tekst:`,
    `"${VERVOLG_TEXT}"`,
    "",
    `Ontvangen op: ${receivedAt} (UTC)`,
    "",
    "Als je op deze mail antwoordt, gaat je antwoord naar de aanvrager.",
  ].join("\n");

  const fromAddress = String(env.FROM_EMAIL).trim();
  const from = fromAddress.includes("<")
    ? fromAddress
    : `${config.bedrijfsnaam.replace(/[<>"\\]/g, "").trim()} <${fromAddress}>`;
  const to = String(env.TO_EMAIL)
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  let res;
  try {
    res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`,
        "Content-Type": "application/json",
        // Resend weigert verzoeken zonder User-Agent met een 403.
        "User-Agent": "scanformulier/1.0",
      },
      body: JSON.stringify({
        from,
        to,
        reply_to: data.email,
        subject: `Scanaanvraag: ${data.bedrijf} (${data.gemeente})`,
        text,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`scan: Resend niet bereikbaar: ${err && err.name}: ${err && err.message}`);
    return reply(502, {
      ok: false,
      error: "Versturen lukte niet. Probeer het later opnieuw.",
      resend_status: null,
    });
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`scan: Resend gaf status ${res.status}: ${detail}`);
    return reply(502, {
      ok: false,
      error: "Versturen lukte niet. Probeer het later opnieuw.",
      resend_status: res.status,
    });
  }

  return reply(200, { ok: true });
}

// Alle andere methodes (GET, PUT, OPTIONS, ...) krijgen 405.
export async function onRequest() {
  return new Response(JSON.stringify({ ok: false, error: "Gebruik POST om het formulier te versturen." }), {
    status: 405,
    headers: { ...BASE_HEADERS, Allow: "POST", "Content-Type": "application/json; charset=utf-8" },
  });
}

async function readBody(request, isJson, isMultipart) {
  if (isMultipart) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form) if (typeof value === "string") out[key] = value;
    return out;
  }
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) throw new Error("te groot");
  if (!isJson) return Object.fromEntries(new URLSearchParams(body));
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("geen object");
  return parsed;
}

// Maakt van een waarde een nette regel tekst: geen stuurtekens, geen onzichtbare tekens, geen enters.
function clean(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f\s]+/g, " ")
    .trim();
}

// Een browser stuurt een Origin-header mee. Komt die van een andere site, dan weigeren we.
// Zonder Origin (bijvoorbeeld curl) laten we het verzoek door; de honeypot en de controles doen de rest.
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost === new URL(request.url).host || originHost === request.headers.get("Host");
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Antwoord voor bezoekers zonder JavaScript: een kleine pagina in plaats van JSON.
function htmlResponse(status, body) {
  const ok = status < 400;
  const title = ok ? "Dank je" : "Dat lukte niet";
  let message = ok ? "Je scan komt binnen twee werkdagen in je mailbox." : body.error;
  if (status >= 500) message += ` Bellen of appen kan ook: ${config.telefoon}.`;
  const back = ok
    ? '<a href="/">Terug naar de website</a>'
    : '<a href="/#scan">Terug naar het formulier</a>';
  const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} | ${escapeHtml(config.bedrijfsnaam)}</title>
<style>
body{margin:0;background:#f2f4ee;color:#1d2620;font:1.05rem/1.6 system-ui,sans-serif}
main{max-width:36rem;margin:0 auto;padding:56px 16px}
h1{font:400 2rem/1.2 Georgia,serif;margin:0 0 16px}
a{color:#7a4688}
@media (prefers-color-scheme: dark){body{background:#131915;color:#e4ebe2}a{color:#c99bd8}}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p>${back}</p>
</main>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}
