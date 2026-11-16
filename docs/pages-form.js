/*
 * Alleen voor de voorlopige versie op GitHub Pages (zie tools/maak_github_pages.py).
 * GitHub Pages kan geen formulieren verwerken. Daarom opent dit script het mailprogramma
 * van de bezoeker met de ingevulde aanvraag. De bezoeker verstuurt die mail zelf.
 * Het vangt het versturen af voordat main.js het naar /api/scan stuurt.
 */
(function () {
  'use strict';
  var form = document.getElementById('scan-form');
  if (!form) return;
  var EMAIL = 'groengevonden@gmail.com';
  var TELEFOON = '06 20 26 37 18';
  var msg = document.getElementById('form-msg');

  function show(text, isError) {
    msg.textContent = text;
    msg.className = 'form-msg' + (isError ? ' err' : '');
    msg.hidden = false;
  }

  document.addEventListener('submit', function (e) {
    if (e.target !== form) return;
    e.preventDefault();
    e.stopPropagation();
    var f = form.elements;
    if (f.bedrijfswebsite_extra.value) return; // verborgen veld: alleen robots vullen dit in
    if (!form.checkValidity()) {
      show('Vul je naam, je bedrijf, je e-mailadres en je gemeente in. Zet ook het eerste vinkje aan.', true);
      return;
    }
    var regels = ['Hoi Max,', '', 'Stuur mij de gratis scan per e-mail.'];
    if (f.vervolg.checked) {
      regels.push('Ja, je mag me daarna hooguit twee berichten sturen over wat je zou doen en wat het kost.');
    }
    regels.push('', 'Naam: ' + f.naam.value.trim(), 'Bedrijf: ' + f.bedrijf.value.trim(),
      'E-mailadres: ' + f.email.value.trim(), 'Gemeente: ' + f.gemeente.value);
    if (f.telefoon.value.trim()) regels.push('Telefoon: ' + f.telefoon.value.trim());
    if (f.website.value.trim()) regels.push('Website of Google-profiel: ' + f.website.value.trim());
    window.location.href = 'mailto:' + EMAIL +
      '?subject=' + encodeURIComponent('Gratis scan voor ' + f.bedrijf.value.trim()) +
      '&body=' + encodeURIComponent(regels.join('\r\n'));
    show('Je mailprogramma opent nu met je aanvraag. Klik daar op verzenden. Opent er niets? Mail naar ' +
      EMAIL + ' of app ' + TELEFOON + '.', false);
  }, true);
})();
