// Browsercontrole met Playwright tegen een draaiende server (bijvoorbeeld wrangler pages dev).
//
// Gebruik:
//   node tests/browser-check.cjs <adres> <verwachte status bij versturen> [map voor screenshots]
//   node tests/browser-check.cjs http://127.0.0.1:8788 500
//
// De verwachte status is 500 als de server geen instellingen heeft, 502 met een nepsleutel.
// Controleert: geen consolefouten, geen CSP-schendingen, geen JavaScript-fouten, de kopieerknop,
// de controle in de browser, de foutmelding na versturen (zonder crash) en een geslaagde
// verzending (nagebootst, er gaat geen mail weg).
const { chromium } = require('playwright');
const path = require('path');
const config = require(path.join(__dirname, '..', 'config.json'));

const base = process.argv[2];
const expectedStatus = Number(process.argv[3]);
const shotDir = process.argv[4];
if (!base || ![500, 502].includes(expectedStatus)) {
  console.error('Gebruik: node tests/browser-check.cjs <adres> <500|502> [map voor screenshots]');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

function watch(page, log) {
  page.on('console', (m) => { if (m.type() === 'error') log.console.push(m.text()); });
  page.on('pageerror', (e) => log.page.push(String(e)));
  page.on('requestfailed', (r) => log.failed.push(`${r.url()} (${r.failure() && r.failure().errorText})`));
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
  const log = { console: [], page: [], failed: [] };
  watch(page, log);
  const resp = await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  check('homepage geeft 200', resp.status() === 200, resp.status());
  const csp = resp.headers()['content-security-policy'] || '';
  check('homepage heeft een CSP-header', csp.includes("default-src 'self'"), csp);
  check('titel komt uit config.json', (await page.title()).startsWith(config.bedrijfsnaam), await page.title());

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return ['Young Serif', 'Atkinson Hyperlegible', 'IBM Plex Mono'].map((f) => `${f}: ${document.fonts.check(`16px "${f}"`)}`);
  });
  check('Google Fonts geladen (CSP staat ze toe)', fonts.every((f) => f.endsWith('true')), fonts.join(', '));

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
  await page.fill('#f-naam', 'Test Persoon');
  await page.fill('#f-bedrijf', 'Testhoveniers');
  await page.fill('#f-email', 'test@example.com');
  await page.fill('#f-tel', '0612345678');
  await page.selectOption('#f-gemeente', 'Huizen');
  await page.fill('#f-site', 'testhoveniers.nl');
  await page.check('#f-consent');
  const [apiResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/scan') && r.request().method() === 'POST', { timeout: 30000 }),
    page.click('#f-submit'),
  ]);
  const sent = JSON.parse(apiResp.request().postData() || '{}');
  check('verzoek bevat alle velden en de lege honeypot', sent.toestemming === 'on' && sent.bedrijfswebsite_extra === '' && sent.gemeente === 'Huizen', JSON.stringify(sent));
  check(`server antwoordt ${expectedStatus}`, apiResp.status() === expectedStatus, apiResp.status());
  await page.waitForFunction(() => !document.getElementById('f-submit').disabled, null, { timeout: 15000 });
  const errMsg = await page.textContent('#form-msg');
  const errClass = await page.getAttribute('#form-msg', 'class');
  const expectedText = expectedStatus === 500 ? 'Het formulier is nog niet klaar voor gebruik.' : 'Versturen lukte niet.';
  check('pagina toont nette foutmelding met telefoonnummer', errMsg.startsWith(expectedText) && errMsg.includes(`Bellen of appen kan ook: ${config.telefoon}.`) && errClass.includes('err'), `"${errMsg}" (class ${errClass})`);
  check('ingevulde gegevens blijven staan na een fout', (await page.inputValue('#f-naam')) === 'Test Persoon');
  check('verstuurknop werkt weer na de fout', !(await page.isDisabled('#f-submit')));
  if (shotDir) await page.locator('#scan').screenshot({ path: path.join(shotDir, `formulier-${expectedStatus}.png`) });

  // 5. Geslaagde verzending nabootsen (geen echte mail)
  await page.route('**/api/scan', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.click('#f-submit');
  await page.waitForFunction(() => document.getElementById('form-msg').textContent.startsWith('Dank je'), null, { timeout: 5000 }).catch(() => {});
  const okMsg = await page.textContent('#form-msg');
  check('bij 200 toont de pagina "Dank je" en leegt het formulier', okMsg.startsWith('Dank je.') && (await page.inputValue('#f-naam')) === '', okMsg);
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

  if (shotDir) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(shotDir, 'home-desktop.png') });
  }

  // 6. Privacyverklaring en 404-pagina
  for (const [url, label, status] of [['/privacy', 'privacy', 200], ['/bestaat-niet', '404', 404]]) {
    const p = await context.newPage();
    const l = { console: [], page: [], failed: [] };
    watch(p, l);
    const r = await p.goto(`${base}${url}`, { waitUntil: 'networkidle' });
    // De 404-status zelf geeft in Chrome een consolemelding "Failed to load resource: 404". Die is verwacht.
    const consoleErrors = l.console.filter((t) => !(status === 404 && t.includes('404')));
    const v = await cspViolations(p);
    check(`${label}: status ${status}, geen fouten, geen CSP-schendingen`, r.status() === status && consoleErrors.length === 0 && l.page.length === 0 && v.length === 0 && l.failed.length === 0,
      `status ${r.status()}; console: ${consoleErrors.join(' | ')}; js: ${l.page.join(' | ')}; csp: ${v.join(' | ')}; mislukt: ${l.failed.join(' | ')}`);
    if (shotDir) await p.screenshot({ path: path.join(shotDir, `${label}-desktop.png`), fullPage: label === 'privacy' });
    await p.close();
  }

  // 7. Telefoonbreedte: geen horizontaal scrollen
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
