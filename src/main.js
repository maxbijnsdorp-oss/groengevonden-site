/*
 * Kopieerknop voor het telefoonnummer en het scanformulier.
 * Dit script staat in een eigen bestand, zodat de Content-Security-Policy
 * geen inline scripts hoeft toe te staan. Het bevat geen bedrijfsgegevens:
 * het telefoonnummer leest het uit de pagina (#phone), die build.py vult uit config.json.
 */
(function () {
  'use strict';

  var phoneEl = document.getElementById('phone');
  var phoneText = phoneEl ? phoneEl.textContent.trim() : '';
  var belZin = phoneText ? ' Bellen of appen kan ook: ' + phoneText + '.' : '';

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
  var msg = document.getElementById('form-msg');
  var submitBtn = document.getElementById('f-submit');
  var f = form.elements;

  function show(text, isError) {
    msg.textContent = text;
    msg.className = 'form-msg' + (isError ? ' err' : '');
    msg.hidden = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var missing = [];
    if (!f.naam.value.trim()) missing.push('je naam');
    if (!f.bedrijf.value.trim()) missing.push('de naam van je bedrijf');
    var em = f.email.value.trim();
    if (!em || em.indexOf('@') < 1 || em.lastIndexOf('.') < em.indexOf('@')) missing.push('een geldig e-mailadres');
    if (!f.gemeente.value) missing.push('je gemeente');
    if (missing.length) {
      show('Vul nog in: ' + missing.join(', ') + '.', true);
      return;
    }
    if (!f.toestemming.checked) {
      show('Zet het vinkje bij de toestemming. Zonder dat vinkje mogen we je de scan niet mailen.', true);
      return;
    }

    var endpoint = form.getAttribute('data-endpoint');
    if (!endpoint) {
      show('Het formulier is nog niet aangesloten.' + belZin, true);
      return;
    }

    // Alle velden gaan mee, ook het verborgen veld bedrijfswebsite_extra (de honeypot).
    var data = {};
    new FormData(form).forEach(function (value, key) { data[key] = value; });

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
          show('Dank je. Je scan komt binnen twee werkdagen in je mailbox.', false);
        } else if (res.status === 400) {
          show(serverText || 'Controleer de velden en probeer het opnieuw.', true);
        } else if (res.status === 500) {
          show((serverText || 'Het formulier werkt nu even niet.') + belZin, true);
        } else if (res.status === 502) {
          show((serverText || 'Versturen lukte niet. Probeer het later opnieuw.') + belZin, true);
        } else {
          show('Versturen lukte niet. Probeer het later opnieuw.' + belZin, true);
        }
      })
      .catch(function () {
        show('Versturen lukte niet. Controleer je internetverbinding en probeer het opnieuw.' + belZin, true);
      })
      .then(function () {
        submitBtn.disabled = false;
      });
  });
})();
