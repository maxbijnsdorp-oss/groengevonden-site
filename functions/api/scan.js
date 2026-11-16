/**
 * Cloudflare Pages Function voor het scanformulier: POST /api/scan
 *
 * - Neemt JSON (van main.js) of een gewoon formulier (application/x-www-form-urlencoded) aan.
 *   multipart/form-data weigeren we (415): het formulier gebruikt dat niet.
 * - Leest nooit meer dan MAX_BODY_BYTES, ook niet zonder Content-Length (chunked).
 * - Controleert naam, bedrijf, e-mail, gemeente en de toestemming.
 * - Honeypot: is het verborgen veld bedrijfswebsite_extra ingevuld, dan antwoorden we 200
 *   en sturen we niets (spambot).
 * - Spamcontrole met Cloudflare Turnstile is niet verplicht. Die staat alleen aan als TURNSTILE_SECRET_KEY
 *   er is en turnstile_sitekey in config.json is ingevuld (dan toont de pagina de widget). Dan is een
 *   geldige token nodig (veld cf-turnstile-response), anders 403. Staat Turnstile uit, dan beschermen de
 *   honeypot, de controle op de Origin en de groottelimiet het formulier. Dat staat dan in de logs.
 * - Verstuurt een platte-tekstmail via de Resend HTTP API, met een Idempotency-Key tegen dubbele mails.
 *
 * Omgevingsvariabelen (Cloudflare: Settings > Variables and Secrets).
 * Verplicht:
 *   RESEND_API_KEY        geheime API-sleutel van Resend (als Secret)
 *   FROM_EMAIL            afzender op een domein dat in Resend is geverifieerd,
 *                         bijvoorbeeld formulier@jouwdomein.nl (de bedrijfsnaam zet de functie er zelf voor)
 *   TO_EMAIL              waar de aanvraag heen moet; meerdere adressen met komma's scheiden
 * Niet verplicht:
 *   TURNSTILE_SECRET_KEY  geheime sleutel van de Turnstile-widget (als Secret). Werkt alleen samen met
 *                         turnstile_sitekey in config.json.
 * Alleen voor tests, en alleen met een adres op 127.0.0.1 of localhost:
 *   RESEND_API_URL, TURNSTILE_VERIFY_URL
 *
 * Statuscodes: 200 verstuurd (of honeypot), 400 velden ontbreken of te lang, 403 ander domein of
 * (als Turnstile aan staat) geen geldige spamcontrole, 405 andere methode dan POST, 413 te groot,
 * 415 verkeerd formaat, 500 instellingen ontbreken, 502 Resend of Turnstile gaf een fout of was niet bereikbaar.
 * Het antwoord bevat alleen ok en error. De details staan in de logs (console.error).
 */
import config from "../../config.json";

const RESEND_URL = "https://api.resend.com/emails";
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RESEND_TIMEOUT_MS = 10000;
const TURNSTILE_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 16 * 1024;
const HONEYPOT = "bedrijfswebsite_extra";
const TOKEN_FIELD = "cf-turnstile-response";
// Een Turnstile-token is hooguit 2048 tekens lang.
const MAX_TOKEN_LENGTH = 2048;
// aanvraag_id van main.js: één id per ingevuld formulier.
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SEND_FAILED = "Versturen lukte niet. Probeer het later opnieuw.";
// Zonder deze instellingen kan de functie niets versturen (500). TURNSTILE_SECRET_KEY is niet verplicht.
const REQUIRED_ENV = ["RESEND_API_KEY", "FROM_EMAIL", "TO_EMAIL"];

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
// Alleen gewone ASCII-adressen: geen spaties, komma's, <>, aanhalingstekens, punt aan begin of eind
// van het deel voor de @, twee punten op rij of een domein zonder extensie.
// Dezelfde regel staat in src/main.js. tests/check_dist.py controleert dat ze gelijk zijn.
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
// Gelijk aan de keuzes bij #f-gemeente in src/index.html. tests/check_dist.py controleert dat.
const GEMEENTEN = [
  "Gooise Meren", "Huizen", "Blaricum", "Laren", "Eemnes", "Hilversum", "Wijdemeren", "Weesp",
  "Almere", "Stichtse Vecht", "Baarn", "Soest", "De Ronde Venen", "Andere gemeente",
];

// Dezelfde teksten als bij de twee vinkjes in src/index.html. Pas ze samen aan, en ook de
// privacyverklaring. tests/check_dist.py controleert na elke build dat ze gelijk zijn.
const CONSENT_TEXT =
  `Stuur mij de gratis scan per e-mail. ` +
  `Hoe we met je gegevens omgaan, staat in de privacyverklaring.`;
const VERVOLG_TEXT =
  "Ja, je mag me daarna hooguit twee berichten sturen over wat je zou doen en wat het kost. Stoppen kan altijd met STOP.";
const REPLY_NOTE = "Als je op deze mail antwoordt, gaat je antwoord naar de aanvrager.";
const NO_REPLY_NOTE =
  "LET OP: Resend weigerde dit e-mailadres als antwoordadres. Je antwoord gaat dus niet vanzelf naar de aanvrager. " +
  "Controleer het adres en mail zelf.";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export async function onRequestPost({ request, env }) {
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  const isJson = contentType.includes("application/json");
  // Alleen een gewoon formulier. multipart/form-data (bestanden) gebruikt het formulier niet: 415.
  const isForm = contentType.includes("application/x-www-form-urlencoded");
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
    raw = await readBody(request, isJson);
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
  if (!validEmail(data.email)) missing.push("email");
  if (!GEMEENTEN.includes(data.gemeente)) missing.push("gemeente");
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

  // Staat Turnstile aan, dan versturen we niets zonder token. Bezoekers zonder JavaScript hebben dan geen token.
  const turnstile = turnstileAan(env);
  const token = typeof raw[TOKEN_FIELD] === "string" ? raw[TOKEN_FIELD].trim() : "";
  if (turnstile && (!token || token.length > MAX_TOKEN_LENGTH)) {
    return reply(403, {
      ok: false,
      error: "De controle tegen spam ontbreekt. Het formulier werkt alleen als JavaScript aan staat.",
    });
  }

  // Welke instelling ontbreekt, staat alleen in de logs. De bezoeker hoeft dat niet te zien.
  const missingEnv = REQUIRED_ENV.filter((name) => !filled(env[name]));
  if (missingEnv.length) {
    console.error(`scan: instellingen ontbreken: ${missingEnv.join(", ")}`);
    return reply(500, {
      ok: false,
      error: "Het formulier is nog niet klaar voor gebruik. Je aanvraag is niet verstuurd.",
    });
  }

  if (turnstile) {
    const verified = await verifyTurnstile(env, token, request.headers.get("CF-Connecting-IP"));
    if (verified === "geweigerd") {
      return reply(403, { ok: false, error: "De controle tegen spam is niet gelukt of verlopen. Probeer het opnieuw." });
    }
    if (verified !== "ok") {
      return reply(502, { ok: false, error: SEND_FAILED });
    }
  }

  // Geen tijdstip in de tekst: bij een tweede poging moet de inhoud precies gelijk zijn, anders werkt de
  // Idempotency-Key niet. Het tijdstip van de aanvraag is de datum van de mail zelf.
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
    "Het tijdstip van de aanvraag is de datum en tijd van deze mail.",
    REPLY_NOTE,
  ].join("\n");

  const fromAddress = String(env.FROM_EMAIL).trim();
  // De naam staat tussen aanhalingstekens. Dan breken tekens als , : ; @ in de naam de From-regel niet
  // (RFC 5322). build.py laat in de bedrijfsnaam alleen letters, cijfers, spaties en & ' . - toe.
  const name = config.bedrijfsnaam.replace(/["\\<>\r\n]/g, "").trim();
  const from = fromAddress.includes("<") ? fromAddress : `"${name}" <${fromAddress}>`;
  const to = String(env.TO_EMAIL)
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  let payload = {
    from,
    to,
    reply_to: data.email,
    subject: `Scanaanvraag: ${data.bedrijf} (${data.gemeente})`,
    text,
  };

  // Idempotency-Key: zelfde sleutel en zelfde inhoud binnen 24 uur, dan verstuurt Resend niet nog een keer.
  // main.js stuurt één aanvraag_id per ingevuld formulier. Zonder id (geen JavaScript) maken we de sleutel
  // uit de datum en de inhoud.
  const id = typeof raw.aanvraag_id === "string" && ID_RE.test(raw.aanvraag_id) ? raw.aanvraag_id : "";
  let key = id
    ? `scan-${id}`
    : `scan-${await sha256Hex(`${new Date().toISOString().slice(0, 10)}\n${JSON.stringify(payload)}`)}`;

  let res = await sendToResend(env, payload, key);
  // Weigert Resend het verzoek (400 of 422), bijvoorbeeld om het antwoordadres? Dan nog één keer zonder
  // reply_to. Het adres staat ook in de tekst, dus de aanvraag komt toch aan.
  if (res && (res.status === 400 || res.status === 422)) {
    await logResendError(res);
    payload = { ...payload, text: text.replace(REPLY_NOTE, NO_REPLY_NOTE) };
    delete payload.reply_to;
    key = `${key}-zonder-antwoordadres`;
    res = await sendToResend(env, payload, key);
  }
  // 409: de sleutel is al gebruikt voor andere inhoud, of een eerdere poging loopt nog.
  // Liever een dubbele mail dan een aanvraag die zoekraakt, dus nog één keer met een nieuwe sleutel.
  if (res && res.status === 409) {
    await logResendError(res);
    res = await sendToResend(env, payload, `${key}-opnieuw`);
  }
  if (!res) {
    return reply(502, { ok: false, error: SEND_FAILED });
  }
  if (!res.ok) {
    await logResendError(res);
    if (res.status === 429) {
      // Limiet van Resend bereikt (het gratis plan: 100 mails per dag). Vraag de bezoeker te appen.
      return reply(502, {
        ok: false,
        error: `Het formulier is nu te druk. Je aanvraag is niet verstuurd. App ons op ${config.telefoon}, dan maken we je scan toch.`,
      });
    }
    return reply(502, { ok: false, error: SEND_FAILED });
  }

  return reply(200, { ok: true });
}

// Eén verzoek aan Resend. Geeft het antwoord, of null als Resend niet bereikbaar was of te traag.
async function sendToResend(env, payload, key) {
  try {
    return await fetch(testUrl(env.RESEND_API_URL) || RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`,
        "Content-Type": "application/json",
        // Resend weigert verzoeken zonder User-Agent met een 403.
        "User-Agent": "scanformulier/1.0",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`scan: Resend niet bereikbaar: ${err && err.name}: ${err && err.message}`);
    return null;
  }
}

async function logResendError(res) {
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  console.error(`scan: Resend gaf status ${res.status}: ${detail}`);
}

// Turnstile staat alleen aan als de pagina de widget toont (turnstile_sitekey in config.json, build.py zet
// de widget er dan in) en de functie de token kan controleren (TURNSTILE_SECRET_KEY). Staat er maar één van
// de twee, dan werkt het formulier zonder Turnstile. In alle gevallen zonder Turnstile staat er een melding
// in de logs.
function turnstileAan(env) {
  const sitekey = filled(config.turnstile_sitekey);
  const secret = filled(env.TURNSTILE_SECRET_KEY);
  if (sitekey && secret) return true;
  if (secret) {
    console.error(
      "scan: TURNSTILE_SECRET_KEY is gezet, maar turnstile_sitekey in config.json is leeg. De pagina toont dan " +
        "geen spamcontrole, dus de functie controleert geen token. Vul de sitekey in of haal TURNSTILE_SECRET_KEY weg."
    );
  } else if (sitekey) {
    console.warn(
      "scan: turnstile_sitekey staat in config.json, maar TURNSTILE_SECRET_KEY ontbreekt. De token van Turnstile " +
        "wordt niet gecontroleerd."
    );
  } else {
    console.warn(
      "scan: Turnstile staat uit (geen TURNSTILE_SECRET_KEY). Alleen de honeypot, de controle op de Origin en " +
        "de groottelimiet beschermen het formulier."
    );
  }
  return false;
}

function filled(value) {
  return (typeof value === "string" || typeof value === "number") && String(value).trim() !== "";
}

// Vraagt Cloudflare of de token van de spamcontrole echt is. Een token werkt één keer en 300 seconden.
// Geeft "ok", "geweigerd" (token klopt niet of is verlopen) of "fout" (onbereikbaar, of onze sleutel klopt niet).
async function verifyTurnstile(env, token, ip) {
  const form = new URLSearchParams({ secret: String(env.TURNSTILE_SECRET_KEY).trim(), response: token });
  if (ip) form.set("remoteip", ip);
  let result;
  try {
    const res = await fetch(testUrl(env.TURNSTILE_VERIFY_URL) || TURNSTILE_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    result = await res.json();
  } catch (err) {
    console.error(`scan: Turnstile niet bereikbaar: ${err && err.name}: ${err && err.message}`);
    return "fout";
  }
  if (result && result.success === true) return "ok";
  const codes = Array.isArray(result && result["error-codes"]) ? result["error-codes"] : [];
  console.error(`scan: Turnstile weigerde: ${codes.join(", ") || "geen foutcode"}`);
  return codes.some((code) => /secret|internal-error/.test(code)) ? "fout" : "geweigerd";
}

// Alleen voor tests: een ander adres voor Resend of Turnstile, maar alleen op deze computer.
function testUrl(value) {
  const url = String(value || "").trim();
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url) ? url : "";
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validEmail(value) {
  // Hooguit 254 tekens in totaal en 64 voor de @.
  return value.length <= LIMITS.email && value.indexOf("@") <= 64 && EMAIL_RE.test(value);
}

// Alle andere methodes (GET, PUT, OPTIONS, ...) krijgen 405.
export async function onRequest() {
  return new Response(JSON.stringify({ ok: false, error: "Gebruik POST om het formulier te versturen." }), {
    status: 405,
    headers: { ...BASE_HEADERS, Allow: "POST", "Content-Type": "application/json; charset=utf-8" },
  });
}

async function readBody(request, isJson) {
  const body = await readLimited(request);
  if (!isJson) return Object.fromEntries(new URLSearchParams(body));
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("geen object");
  return parsed;
}

// Leest de body stukje voor stukje en stopt zodra het meer dan MAX_BODY_BYTES bytes is.
// Zo helpt ook een verzoek zonder Content-Length (Transfer-Encoding: chunked) niet om meer te sturen.
async function readLimited(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("te groot");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// Maakt van een waarde een nette regel tekst: geen stuurtekens (ook niet U+0080 tot U+009F),
// geen onzichtbare tekens (zacht afbreekstreepje, richtingstekens, tekens zonder breedte), geen enters.
function clean(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ")
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
  // Bij een fout in de velden helpt de terugknop. Bij andere fouten noemen we ook het telefoonnummer.
  if (!ok && status !== 400 && !message.includes(config.telefoon)) {
    message += ` Appen kan ook: ${config.telefoon}.`;
  }
  // Geen link terug: die laadt het formulier leeg. Met de terugknop blijft wat je invulde meestal staan.
  const back = ok
    ? '<a href="/">Terug naar de website</a>'
    : "Ga met de terugknop van je browser terug naar het formulier. Wat je had ingevuld, staat er dan meestal nog.";
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
