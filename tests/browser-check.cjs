// Browsercontrole met Playwright tegen een draaiende server (bijvoorbeeld wrangler pages dev).
//
// Gebruik:
//   node tests/browser-check.cjs <adres> <stand> [map voor screenshots]
//   node tests/browser-check.cjs http://127.0.0.1:8788 zonder-instellingen
//
// <stand> zegt welke instellingen de server heeft, net als bij tests/api-tests.sh:
//   zonder-instellingen     geen omgevingsvariabelen: versturen geeft 500 (kortweg: 500)
//   nep-sleutel             RESEND_API_KEY=nep, FROM_EMAIL en TO_EMAIL: versturen geeft 502 (kortweg: 502)
//   nep-sleutel-turnstile   zoals nep-sleutel, plus TURNSTILE_SECRET_KEY met de testsleutel: ook 502
// Controleert: geen consolefouten, geen CSP-schendingen, geen JavaScript-fouten, de lettertypen van de
// eigen site (geen Google Fonts, geen verzoeken naar andere sites), de kopieerknop, de controle in de
// browser, de spamcontrole (Turnstile met de testsleutel, als turnstile_sitekey in config.json is ingevuld;
// anders juist geen Turnstile), de foutmelding na versturen (zonder crash), een geslaagde verzending
// (nagebootst, er gaat geen mail weg), hetzelfde aanvraag_id bij een tweede poging, het formulier zonder
// JavaScript en de breedte op een telefoon.
// Het script gaat ervan uit dat de server dist/ uit deze map gebruikt, gebouwd met deze config.json.
// Nodig: npm ci en npx playwright install chromium in tests/ (zie README).
const { chromium } = require('playwright');
const path = require('path');
const config = require(path.join(__dirname, '..', 'config.json'));

// Per stand: de status bij versturen, en of de server TURNSTILE_SECRET_KEY heeft.
const STANDEN = {
  'zonder-instellingen': [500, false], 'nep-sleutel': [502, false], 'nep-sleutel-turnstile': [502, true],
  500: [500, false], 502: [502, false],
};
const base = process.argv[2];
const stand = STANDEN[process.argv[3]];
const shotDir = process.argv[4];
if (!base || !stand) {
  console.error('Gebruik: node tests/browser-check.cjs <adres> <zonder-instellingen|nep-sleutel|nep-sleutel-turnstile> [map voor screenshots]');
  process.exit(2);
}
const [expectedStatus, serverSecret] = stand;
// Turnstile staat op de pagina als turnstile_sitekey in config.json is ingevuld. De functie controleert
// de token alleen als de server ook TURNSTILE_SECRET_KEY heeft.
const turnstileOn = String(config.turnstile_sitekey || '').trim() !== '';
const tokenChecked = turnstileOn && serverSecret;
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com/';
const FONTS = [['Young Serif', '400'], ['Atkinson Hyperlegible', '400'], ['Atkinson Hyperlegible', '700'],
  ['IBM Plex Mono', '400'], ['IBM Plex Mono', '500']];

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

function watch(page, log) {
  page.on('console', (m) => { if (m.type() === 'error') log.console.push(m.text()); });
  page.on('pageerror', (e) => log.page.push(String(e)));
  page.on('requestfailed', (r) => log.failed.push(`${r.url()} (${r.failure() && r.failure().errorText})`));
  page.on('request', (r) => log.requests.push(r.url()));
}

// Verzoeken naar een andere site dan de server die we testen. Cloudflare Web Analytics telt niet mee:
// dat zet Cloudflare er online zelf in als het aan staat, en de CSP en de privacyverklaring noemen het.
const ANALYTICS = ['https://static.cloudflareinsights.com/', 'https://cloudflareinsights.com/'];
const elsewhere = (urls) => urls.filter((u) => !u.startsWith(`${base}/`) && !/^(data|blob|about):/.test(u)
  && !ANALYTICS.some((a) => u.startsWith(a)));

// Laadt de vijf lettertypen en geeft per lettertype de status en het adres waar het vandaan kwam.
async function fontReport(page) {
  return page.evaluate(async (fonts) => {
    // Een lettertype dat niet laadt, geeft hieronder de status "error". Daarom allSettled.
    await Promise.allSettled(fonts.map(([family, weight]) => document.fonts.load(`${weight} 16px "${family}"`)));
    await document.fonts.ready;
    const weightOf = (w) => ({ normal: '400', bold: '700' }[w] || String(w));
    const faces = [...document.fonts];
    const files = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /\.woff2(\?|$)/.test(u));
    return {
      status: fonts.map(([family, weight]) => {
        const face = faces.find((f) => f.family.replace(/["']/g, '') === family && weightOf(f.weight) === weight);
        return `${family} ${weight}: ${face ? face.status : 'ontbreekt'}`;
      }),
      files,
    };
  }, FONTS);
}

async function cspViolations(page) {
  return page.evaluate(() => window.__csp || []);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  // Luistert naar CSP-schendingen. Playwright voegt dit script buiten de CSP om toe.
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} blokkeerde ${e.blockedURI || 'inline'}`);
    });
  });

  // 1. Homepage laden
  const page = await context.newPage();
  const log = { console: [], page: [], failed: [], requests: [] };
  watch(page, log);
  const resp = await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  check('homepage geeft 200', resp.status() === 200, resp.status());
  const csp = resp.headers()['content-security-policy'] || '';
  check('homepage heeft een CSP-header', csp.includes("default-src 'self'"), csp);
  check(`CSP ${turnstileOn ? 'staat' : 'noemt'} challenges.cloudflare.com ${turnstileOn ? 'toe (Turnstile staat aan)' : 'niet (Turnstile staat uit)'}`,
    csp.includes('challenges.cloudflare.com') === turnstileOn, csp);
  check('titel komt uit config.json', (await page.title()).startsWith(config.bedrijfsnaam), await page.title());

  // Lettertypen: alle vijf geladen, en alleen van de eigen site.
  const fonts = await fontReport(page);
  check('lettertypen geladen (alle vijf)', fonts.status.every((f) => f.endsWith(': loaded')), fonts.status.join(', '));
  check('lettertypen komen van de eigen site (/fonts/)', fonts.files.length > 0 && fonts.files.every((u) => u.startsWith(`${base}/fonts/`)),
    fonts.files.join(', ') || 'geen woff2 geladen');
  const loadRequests = elsewhere(log.requests);
  check('homepage laadt niets van andere sites (geen Google Fonts)', loadRequests.length === 0, loadRequests.join(', '));

  // Consolefouten tijdens het laden (voordat we iets versturen).
  const loadErrors = [...log.console];

  const honeypot = await page.locator('#f-extra').boundingBox();
  check('honeypot staat buiten beeld', honeypot && honeypot.x + honeypot.width < 0, JSON.stringify(honeypot));
  check('honeypot is niet met Tab te bereiken', (await page.getAttribute('#f-extra', 'tabindex')) === '-1');

  // 2. Kopieerknop (main.js moet geladen en uitgevoerd zijn)
  await page.click('#copy-phone');
  await page.waitForFunction(() => document.getElementById('copy-phone').textContent !== 'Kopieer nummer', null, { timeout: 3000 }).catch(() => {});
  const copyText = await page.textContent('#copy-phone');
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => `fout: ${e}`));
  check('kopieerknop kopieert het nummer zonder spaties', copyText === 'Gekopieerd' && clip === config.telefoon.replace(/\s+/g, ''), `knop "${copyText}", klembord "${clip}"`);

  // 3. Controle in de browser: leeg versturen
  await page.click('#f-submit');
  const emptyMsg = await page.textContent('#form-msg');
  check('leeg versturen geeft melding in de browser', emptyMsg.startsWith('Vul nog in: je naam'), emptyMsg);

  // 4. Geldig invullen en versturen: de server geeft 500 (geen instellingen) of 502 (nepsleutel)
  const fillForm = async (p) => {
    await p.fill('#f-naam', 'Test Persoon');
    await p.fill('#f-bedrijf', 'Testhoveniers');
    await p.fill('#f-email', 'test@example.com');
    await p.fill('#f-tel', '0612345678');
    await p.selectOption('#f-gemeente', 'Huizen');
    await p.fill('#f-site', 'testhoveniers.nl');
    await p.check('#f-consent');
  };
  // Turnstile laadt zodra je in het formulier klikt of typt. Met de testsleutel komt er snel een token.
  // Staat Turnstile uit, dan is er geen token en hoeft er ook niet op gewacht te worden.
  const tokenReady = (p) => (!turnstileOn ? Promise.resolve(true) : p.waitForFunction(() => {
    const t = document.querySelector('#scan-form [name="cf-turnstile-response"]');
    return Boolean(t && t.value);
  }, null, { timeout: 30000 }).then(() => true, () => false));
  await fillForm(page);
  if (turnstileOn) {
    check('spamcontrole (Turnstile) geeft een token', await tokenReady(page));
  } else {
    await page.waitForTimeout(1000);
    const ts = await page.evaluate(() => ({
      box: Boolean(document.getElementById('f-turnstile')),
      script: Boolean(document.querySelector('script[src*="challenges.cloudflare.com"]')),
      iframe: Boolean(document.querySelector('iframe')),
    }));
    check('Turnstile staat uit: geen vak, geen script en geen iframe na het invullen', !ts.box && !ts.script && !ts.iframe, JSON.stringify(ts));
  }
  const [apiResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/scan') && r.request().method() === 'POST', { timeout: 30000 }),
    page.click('#f-submit'),
  ]);
  const sent = JSON.parse(apiResp.request().postData() || '{}');
  check('verzoek bevat alle velden en de lege honeypot', sent.toestemming === 'on' && sent.bedrijfswebsite_extra === '' && sent.gemeente === 'Huizen', JSON.stringify(sent));
  if (turnstileOn) {
    check('verzoek bevat de token en een aanvraag_id', Boolean(sent['cf-turnstile-response']) && /^[A-Za-z0-9-]{8,64}$/.test(sent.aanvraag_id || ''), JSON.stringify(sent));
  } else {
    check('verzoek zonder token (Turnstile staat uit), met een aanvraag_id', !('cf-turnstile-response' in sent) && /^[A-Za-z0-9-]{8,64}$/.test(sent.aanvraag_id || ''), JSON.stringify(sent));
  }
  check(`server antwoordt ${expectedStatus}`, apiResp.status() === expectedStatus, apiResp.status());
  await page.waitForFunction(() => !document.getElementById('f-submit').disabled, null, { timeout: 15000 });
  const errMsg = await page.textContent('#form-msg');
  const errClass = await page.getAttribute('#form-msg', 'class');
  const expectedText = expectedStatus === 500 ? 'Het formulier is nog niet klaar voor gebruik.' : 'Versturen lukte niet.';
  check('pagina toont nette foutmelding met telefoonnummer', errMsg.startsWith(expectedText) && errMsg.includes(`Appen kan ook: ${config.telefoon}.`) && errClass.includes('err'), `"${errMsg}" (class ${errClass})`);
  check('ingevulde gegevens blijven staan na een fout', (await page.inputValue('#f-naam')) === 'Test Persoon');
  check('verstuurknop werkt weer na de fout', !(await page.isDisabled('#f-submit')));
  if (shotDir) await page.locator('#scan').screenshot({ path: path.join(shotDir, `formulier-${expectedStatus}.png`) });

  // 5. Geslaagde verzending nabootsen (geen echte mail). Na de fout vraagt de widget een nieuwe token.
  const mocked = [];
  await page.route('**/api/scan', (route) => {
    mocked.push(JSON.parse(route.request().postData() || '{}'));
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await tokenReady(page);
  await page.click('#f-submit');
  await page.waitForFunction(() => document.getElementById('form-msg').textContent.startsWith('Dank je'), null, { timeout: 5000 }).catch(() => {});
  const okMsg = await page.textContent('#form-msg');
  check('bij 200 toont de pagina "Dank je" en leegt het formulier', okMsg.startsWith('Dank je.') && (await page.inputValue('#f-naam')) === '', okMsg);
  check('tweede poging met dezelfde velden heeft hetzelfde aanvraag_id', mocked.length === 1 && mocked[0].aanvraag_id === sent.aanvraag_id,
    `${sent.aanvraag_id} en ${mocked[0] && mocked[0].aanvraag_id}`);
  await fillForm(page);
  await tokenReady(page);
  await page.click('#f-submit');
  for (let i = 0; i < 50 && mocked.length < 2; i += 1) await page.waitForTimeout(100);
  check('na een gelukte aanvraag krijgt een nieuwe aanvraag een nieuw id', mocked.length === 2 && mocked[1].aanvraag_id && mocked[1].aanvraag_id !== mocked[0].aanvraag_id,
    JSON.stringify(mocked.map((m) => m.aanvraag_id)));
  await page.unroute('**/api/scan');

  check('homepage: geen consolefouten bij het laden', loadErrors.length === 0, loadErrors.join(' | '));
  // Chrome meldt zelf elke HTTP-fout in de console. De melding voor de verwachte 500/502 is dus geen fout van de pagina.
  const expectedNetworkLine = `status of ${expectedStatus}`;
  const otherErrors = log.console.filter((t) => !t.includes(expectedNetworkLine));
  check(`homepage: geen consolefouten behalve Chromes eigen regel over de verwachte ${expectedStatus}`, otherErrors.length === 0,
    otherErrors.join(' | '));
  check(`  (die regel stond er ${log.console.length - otherErrors.length} keer)`, true);
  check('homepage: geen JavaScript-fouten', log.page.length === 0, log.page.join(' | '));
  const homeCsp = await cspViolations(page);
  check('homepage: geen CSP-schendingen', homeCsp.length === 0, homeCsp.join(' | '));
  check('homepage: geen mislukte verzoeken', log.failed.length === 0, log.failed.join(' | '));
  const others = elsewhere(log.requests).filter((u) => !(turnstileOn && u.startsWith(TURNSTILE_ORIGIN)));
  check(turnstileOn ? 'homepage: alleen Turnstile (challenges.cloudflare.com) laadt iets van een andere site'
    : 'homepage: geen enkel verzoek naar een andere site (Turnstile staat uit)', others.length === 0, others.join(' | '));

  if (shotDir) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(shotDir, 'home-desktop.png') });
  }

  // 6. Privacyverklaring en 404-pagina
  for (const [url, label, status] of [['/privacy', 'privacy', 200], ['/bestaat-niet', '404', 404]]) {
    const p = await context.newPage();
    const l = { console: [], page: [], failed: [], requests: [] };
    watch(p, l);
    const r = await p.goto(`${base}${url}`, { waitUntil: 'networkidle' });
    // De 404-status zelf geeft in Chrome een consolemelding "Failed to load resource: 404". Die is verwacht.
    const consoleErrors = l.console.filter((t) => !(status === 404 && t.includes('404')));
    const v = await cspViolations(p);
    check(`${label}: status ${status}, geen fouten, geen CSP-schendingen`, r.status() === status && consoleErrors.length === 0 && l.page.length === 0 && v.length === 0 && l.failed.length === 0,
      `status ${r.status()}; console: ${consoleErrors.join(' | ')}; js: ${l.page.join(' | ')}; csp: ${v.join(' | ')}; mislukt: ${l.failed.join(' | ')}`);
    const f = await fontReport(p);
    const away = elsewhere(l.requests);
    check(`${label}: lettertypen geladen van de eigen site, niets van andere sites`,
      f.status.every((s) => s.endsWith(': loaded')) && f.files.length > 0 && f.files.every((u) => u.startsWith(`${base}/fonts/`)) && away.length === 0,
      `${f.status.join(', ')}; bestanden: ${f.files.join(', ')}; andere sites: ${away.join(', ')}`);
    if (shotDir) await p.screenshot({ path: path.join(shotDir, `${label}-desktop.png`), fullPage: label === 'privacy' });
    await p.close();
  }

  // 7a. Turnstile geblokkeerd (bijvoorbeeld door een adblocker): de melding noemt het telefoonnummer.
  // Alleen als Turnstile aan staat.
  if (turnstileOn) {
    const blocked = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await blocked.route(`${TURNSTILE_ORIGIN}**`, (route) => route.abort());
    const b = await blocked.newPage();
    const bErrors = [];
    b.on('pageerror', (e) => bErrors.push(String(e)));
    await b.goto(`${base}/`, { waitUntil: 'networkidle' });
    await fillForm(b);
    await b.waitForTimeout(1000);
    await b.click('#f-submit');
    const blockedMsg = await b.textContent('#form-msg');
    check('Turnstile geblokkeerd: melding met telefoonnummer, geen JavaScript-fout',
      blockedMsg.includes('De controle tegen spam lukt nu niet.') && blockedMsg.includes(config.telefoon) && bErrors.length === 0,
      `"${blockedMsg}" ${bErrors.join(' | ')}`);
    await blocked.close();
  }

  // 7b. Zonder JavaScript: de browser controleert de verplichte velden, de server antwoordt met een pagina.
  // Controleert de functie de token, dan is er zonder JavaScript geen token (403). Anders komt de aanvraag
  // gewoon bij de server.
  const nojs = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: false });
  const n = await nojs.newPage();
  await n.goto(`${base}/`, { waitUntil: 'load' });
  let posted = 0;
  n.on('request', (r) => { if (r.url().endsWith('/api/scan')) posted += 1; });
  await n.click('#f-submit');
  await n.waitForTimeout(800);
  check('zonder JavaScript: de browser houdt een leeg formulier tegen', posted === 0 && n.url() === `${base}/`, `${posted} verzoek(en), adres ${n.url()}`);
  const noscriptText = await n.evaluate(() => [...document.querySelectorAll('noscript')].map((e) => e.textContent).join(' '));
  check(turnstileOn ? 'zonder JavaScript: de pagina zegt dat het formulier JavaScript nodig heeft'
    : 'zonder JavaScript: geen melding dat het formulier JavaScript nodig heeft (Turnstile staat uit)',
  noscriptText.includes('Dit formulier werkt alleen met JavaScript') === turnstileOn, noscriptText);
  await fillForm(n);
  const [noJsResp] = await Promise.all([n.waitForNavigation({ timeout: 15000 }), n.click('#f-submit')]);
  const noJsText = await n.textContent('body');
  const noJsStatus = tokenChecked ? 403 : expectedStatus;
  check(tokenChecked ? 'zonder JavaScript: zonder spamcontrole 403, met telefoonnummer en de terugknop'
    : `zonder JavaScript: de aanvraag komt bij de server (${expectedStatus}), met telefoonnummer en de terugknop`,
  noJsResp && noJsResp.status() === noJsStatus && noJsText.includes(config.telefoon) && noJsText.includes('terugknop'),
  `${noJsResp && noJsResp.status()}: ${noJsText.trim().slice(0, 200)}`);
  await n.goBack();
  check('zonder JavaScript: na de terugknop staat je naam er nog', (await n.inputValue('#f-naam')) === 'Test Persoon', await n.inputValue('#f-naam'));
  await nojs.close();

  // 8. Telefoonbreedte: geen horizontaal scrollen, ook niet als de spamcontrole er staat (als die aan staat)
  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  for (const url of ['/', '/privacy', '/bestaat-niet']) {
    const m = await mobile.newPage();
    await m.goto(`${base}${url}`, { waitUntil: 'networkidle' });
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`telefoon (375px) ${url}: geen horizontaal scrollen`, overflow <= 0, `${overflow}px te breed`);
    if (shotDir && url === '/') await m.screenshot({ path: path.join(shotDir, 'home-mobiel.png') });
    if (shotDir && url === '/bestaat-niet') await m.screenshot({ path: path.join(shotDir, '404-mobiel.png') });
    await m.close();
  }
  for (const width of [375, 320]) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
    const m = await ctx.newPage();
    await m.goto(`${base}/`, { waitUntil: 'networkidle' });
    await m.focus('#f-naam');
    const loaded = await tokenReady(m);
    await m.waitForTimeout(500);
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`telefoon (${width}px) /: ${turnstileOn ? 'spamcontrole geladen, ' : ''}geen horizontaal scrollen`, loaded && overflow <= 0, `token ${loaded}, ${overflow}px te breed`);
    if (shotDir) await m.locator('#scan-form').screenshot({ path: path.join(shotDir, `formulier-${width}px.png`) });
    await ctx.close();
  }
  const dark = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const d = await dark.newPage();
  await d.goto(`${base}/bestaat-niet`, { waitUntil: 'networkidle' });
  if (shotDir) await d.screenshot({ path: path.join(shotDir, '404-donker.png') });

  await browser.close();
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? 'OK  ' : 'FOUT'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
  }
  console.log(`\n${results.length - failed} van ${results.length} controles OK.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Browsercontrole gestopt met een fout:', e);
  process.exit(1);
});
