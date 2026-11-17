/*
 * Alleen voor de voorlopige versie op GitHub Pages (zie tools/maak_github_pages.py).
 * GitHub Pages kan zelf geen formulieren verwerken. Daarom stuurt dit script de aanvraag
 * via de dienst FormSubmit (formsubmit.co) naar de mailbox van de zaak. De bezoeker hoeft
 * zelf geen mail te schrijven. Het vangt het versturen af voordat main.js het naar /api/scan stuurt.
 *
 * Eerste keer: FormSubmit stuurt na de eerste aanvraag één mail naar de mailbox met een knop
 * om het formulier te activeren. Pas daarna komen aanvragen binnen.
 */
(function () {
  'use strict';
  var form = document.getElementById('scan-form');
  if (!form) return;
  var EMAIL = 'groengevonden@gmail.com';
  var TELEFOON = '06 20 26 37 18';
  // Staat er een URL van de eigen web-app (Google Apps Script) in tools/github-pages.json, dan gaat de
  // aanvraag daarheen: die mailt de aanvraag naar de mailbox en een bevestiging naar de aanvrager.
  // Anders gaat de aanvraag via FormSubmit.
  var EIGEN_URL = '';
  var ENDPOINT = EIGEN_URL || 'https://formsubmit.co/ajax/' + EMAIL;
  var msg = document.getElementById('form-msg');
  var knop = document.getElementById('f-submit');
  var bezig = false;

  function show(text, isError) {
    msg.textContent = text;
    msg.className = 'form-msg' + (isError ? ' err' : '');
    msg.hidden = false;
  }
  function mislukt() {
    show('Versturen lukte niet. Probeer het opnieuw, of mail naar ' + EMAIL + ' of app ' + TELEFOON + '.', true);
  }

  document.addEventListener('submit', function (e) {
    if (e.target !== form) return;
    e.preventDefault();
    e.stopPropagation();
    if (bezig) return;
    var f = form.elements;
    if (f.bedrijfswebsite_extra.value) return; // verborgen veld: alleen robots vullen dit in

    var ontbreekt = [];
    if (!f.naam.value.trim()) ontbreekt.push('je naam');
    if (!f.bedrijf.value.trim()) ontbreekt.push('de naam van je bedrijf');
    if (!f.email.value.trim() || !f.email.checkValidity()) ontbreekt.push('een geldig e-mailadres');
    if (!f.gemeente.value) ontbreekt.push('je gemeente');
    if (!f.website.value.trim()) ontbreekt.push('je Google Bedrijfsprofiel');
    if (ontbreekt.length) {
      show('Vul nog in: ' + ontbreekt.join(', ') + '.', true);
      return;
    }
    if (!f.toestemming.checked) {
      show('Zet het eerste vinkje aan. Zonder dat vinkje kunnen we je de scan niet mailen.', true);
      return;
    }

    var bedrijf = f.bedrijf.value.trim();
    var data = {
      _subject: 'Scanaanvraag: ' + bedrijf + ' (' + f.gemeente.value + ')',
      _template: 'table',
      _captcha: 'false',
      _replyto: f.email.value.trim(),
      Bedrijf: bedrijf,
      'Google Bedrijfsprofiel': f.website.value.trim(),
      Naam: f.naam.value.trim(),
      'E-mailadres': f.email.value.trim(),
      Telefoon: f.telefoon.value.trim() || '(niet ingevuld)',
      Gemeente: f.gemeente.value,
      'Vinkje 1, scan per e-mail': 'ja',
      'Vinkje 2, hooguit twee vervolgberichten': f.vervolg.checked ? 'ja' : 'nee',
      Aangevraagd: new Date().toLocaleString('nl-NL')
    };

    bezig = true;
    knop.disabled = true;
    show('Bezig met versturen. Dit kan een halve minuut duren.', false);
    // Antwoordt de dienst niet binnen 45 seconden, dan stoppen we en ziet de bezoeker de foutmelding.
    // FormSubmit is soms traag, daarom wachten we ruim.
    var stop = window.AbortController ? new AbortController() : null;
    var klok = setTimeout(function () { if (stop) stop.abort(); }, 45000);
    var verzoek = { method: 'POST', signal: stop ? stop.signal : undefined };
    if (EIGEN_URL) {
      // text/plain: dan stuurt de browser geen extra controleverzoek, dat een Apps Script-web-app niet kent.
      var eigen = {};
      new FormData(form).forEach(function (value, key) { eigen[key] = value; });
      verzoek.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      verzoek.body = JSON.stringify(eigen);
    } else {
      verzoek.headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      verzoek.body = JSON.stringify(data);
    }
    fetch(ENDPOINT, verzoek).then(function (r) {
      return r.json().then(function (antwoord) { return { ok: r.ok, antwoord: antwoord }; });
    }).then(function (res) {
      var gelukt = res.ok && (EIGEN_URL ? res.antwoord.ok === true : String(res.antwoord.success) === 'true');
      if (!gelukt) { mislukt(); return; }
      form.reset();
      show(EIGEN_URL
        ? 'Dank je. Je aanvraag is verstuurd. Je krijgt nu een bevestiging per e-mail. Je scan komt binnen twee werkdagen.'
        : 'Dank je. Je aanvraag is verstuurd. Je scan komt binnen twee werkdagen in je mailbox.', false);
    }).catch(mislukt).then(function () {
      clearTimeout(klok);
      bezig = false;
      knop.disabled = false;
    });
  }, true);
})();
