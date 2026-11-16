/*
 * Kopieerknop voor het telefoonnummer en het scanformulier, met de spamcontrole (Cloudflare Turnstile)
 * als die aan staat. Dit script staat in een eigen bestand, zodat de Content-Security-Policy
 * geen inline scripts hoeft toe te staan. Het bevat geen bedrijfsgegevens:
 * het telefoonnummer leest het uit de pagina (#phone) en de sitekey uit #f-turnstile.
 * build.py vult die uit config.json. Is turnstile_sitekey in config.json leeg, dan zet build.py
 * het vak #f-turnstile niet op de pagina. Dan laadt dit script Turnstile niet en gaat het formulier
 * zonder token naar de server.
 */
(function () {
  'use strict';

  var phoneEl = document.getElementById('phone');
  var phoneText = phoneEl ? phoneEl.textContent.trim() : '';
  var belZin = phoneText ? ' Appen kan ook: ' + phoneText + '.' : '';

  /* Telefoonnummer kopiëren */
  var copyBtn = document.getElementById('copy-phone');
  function selectPhone() {
    var r = document.createRange();
    r.selectNodeContents(phoneEl);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    copyBtn.textContent = 'Geselecteerd, kopieer met Ctrl+C';
  }
  if (copyBtn && phoneEl) {
    copyBtn.addEventListener('click', function () {
      var done = function () {
        copyBtn.textContent = 'Gekopieerd';
        setTimeout(function () { copyBtn.textContent = 'Kopieer nummer'; }, 1800);
      };
      try {
        navigator.clipboard.writeText(phoneText.replace(/\s+/g, '')).then(done, selectPhone);
      } catch (e) {
        selectPhone();
      }
    });
  }

  /* Scanformulier */
  var form = document.getElementById('scan-form');
  if (!form) return;
  // Met JavaScript controleren we de velden zelf, met Nederlandse meldingen. Zonder JavaScript
  // doet de browser dat. Daarom staat novalidate niet in de HTML, maar zetten we het hier aan.
  form.noValidate = true;
  var msg = document.getElementById('form-msg');
  var submitBtn = document.getElementById('f-submit');
  var f = form.elements;
  // Zelfde regel als EMAIL_RE in functions/api/scan.js. tests/check_dist.py controleert dat.
  var EMAIL_RE = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

  function show(text, isError) {
    msg.textContent = text;
    msg.className = 'form-msg' + (isError ? ' err' : '');
    msg.hidden = false;
  }

  // Zet het telefoonnummer achter een foutmelding, behalve als de melding het al noemt.
  function metTelefoon(text) {
    return phoneText && text.indexOf(phoneText) === -1 ? text + belZin : text;
  }

  /* Spamcontrole met Cloudflare Turnstile, alleen als het vak #f-turnstile op de pagina staat.
     Het script laden we pas als iemand het formulier gebruikt. */
  var tsBox = document.getElementById('f-turnstile');
  var tsId = null;
  var tsStatus = ''; // '', 'laden', 'klaar' of 'mislukt'
  var tsFouten = 0; // hoe vaak het laden of de controle mislukte
  window.gvTurnstileGeladen = function () {
    tsStatus = 'klaar';
    tsId = window.turnstile.render('#f-turnstile', {
      sitekey: tsBox.getAttribute('data-sitekey'),
      language: 'nl',
      // Op een smal scherm past de gewone widget (minstens 300 pixels breed) niet. Het lege vak zelf
      // is nog verborgen, dus we meten de knop: die is even breed als het formulier.
      size: submitBtn.offsetWidth < 300 ? 'compact' : 'flexible',
      // Zonder deze functie gooit Turnstile bij een fout een uitzondering. De widget probeert het zelf opnieuw.
      'error-callback': function () { tsFouten += 1; }
    });
  };
  function laadTurnstile() {
    if (!tsBox || tsStatus === 'laden' || tsStatus === 'klaar') return;
    tsStatus = 'laden';
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=gvTurnstileGeladen';
    s.async = true;
    s.onerror = function () { tsStatus = 'mislukt'; tsFouten += 1; };
    document.head.appendChild(s);
  }
  if (tsBox) {
    form.addEventListener('focusin', laadTurnstile);
    form.addEventListener('pointerdown', laadTurnstile);
  }
  // Een token werkt maar één keer. Na een poging vraagt de widget een nieuwe aan.
  function nieuweToken() {
    if (window.turnstile && tsId !== null) {
      try { window.turnstile.reset(tsId); } catch (err) { /* widget is weg */ }
    }
  }

  // Eén id per ingevuld formulier. Verstuur je precies hetzelfde nog een keer (bijvoorbeeld na een
  // time-out), dan stuurt Resend geen tweede mail. Verander je iets, dan komt er een nieuw id.
  var aanvraag = { id: '', inhoud: '' };
  function maakId() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var bytes = new Uint8Array(16);
    var i;
    if (c && c.getRandomValues) c.getRandomValues(bytes);
    else for (i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    var hex = '';
    for (i = 0; i < 16; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
    return hex;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    laadTurnstile();

    var missing = [];
    if (!f.naam.value.trim()) missing.push('je naam');
    if (!f.bedrijf.value.trim()) missing.push('de naam van je bedrijf');
    var em = f.email.value.trim();
    if (em.length > 254 || em.indexOf('@') > 64 || !EMAIL_RE.test(em)) missing.push('een geldig e-mailadres');
    if (!f.gemeente.value) missing.push('je gemeente');
    if (missing.length) {
      show('Vul nog in: ' + missing.join(', ') + '.', true);
      return;
    }
    if (!f.toestemming.checked) {
      show('Zet het eerste vinkje aan. Zonder dat vinkje kunnen we je de scan niet mailen.', true);
      return;
    }

    var endpoint = form.getAttribute('data-endpoint');
    if (!endpoint) {
      show('Het formulier is nog niet aangesloten.' + belZin, true);
      return;
    }

    // Alle velden gaan mee, ook de honeypot bedrijfswebsite_extra en (als Turnstile aan staat) de token
    // cf-turnstile-response.
    var data = {};
    new FormData(form).forEach(function (value, key) { data[key] = value; });
    if (tsBox && !data['cf-turnstile-response']) {
      show(tsFouten > 0
        ? metTelefoon('De controle tegen spam lukt nu niet. Probeer het over een paar seconden opnieuw.')
        : 'De controle tegen spam onder het formulier is nog bezig. Probeer het over een paar seconden opnieuw.', true);
      return;
    }
    // Hetzelfde id zolang de ingevulde velden gelijk blijven. De token telt niet mee.
    var inhoud = JSON.stringify(Object.keys(data).sort()
      .filter(function (key) { return key !== 'cf-turnstile-response'; })
      .map(function (key) { return [key, data[key]]; }));
    if (inhoud !== aanvraag.inhoud) {
      aanvraag.inhoud = inhoud;
      aanvraag.id = maakId();
    }
    data.aanvraag_id = aanvraag.id;

    submitBtn.disabled = true;
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (r) {
        return r.json().then(
          function (body) { return { ok: r.ok, status: r.status, body: body || {} }; },
          function () { return { ok: r.ok, status: r.status, body: {} }; }
        );
      })
      .then(function (res) {
        var serverText = typeof res.body.error === 'string' ? res.body.error : '';
        if (res.ok) {
          form.reset();
          aanvraag.id = '';
          aanvraag.inhoud = '';
          show('Dank je. Je scan komt binnen twee werkdagen in je mailbox.', false);
        } else if (res.status === 400) {
          show(serverText || 'Controleer de velden en probeer het opnieuw.', true);
        } else {
          show(metTelefoon(serverText || 'Versturen lukte niet. Probeer het later opnieuw.'), true);
        }
        // Bij 400 kijkt de server nog niet naar de token. Daarna is hij gebruikt.
        if (res.status !== 400) nieuweToken();
      })
      .catch(function () {
        show(metTelefoon('Versturen lukte niet. Controleer je internetverbinding en probeer het opnieuw.'), true);
        nieuweToken();
      })
      .then(function () {
        submitBtn.disabled = false;
      });
  });
})();
