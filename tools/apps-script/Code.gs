/**
 * Formulier van groen-gevonden.nl: stuurt elke scanaanvraag naar de mailbox van Groen Gevonden
 * en stuurt de aanvrager een bevestiging. Beide mails komen van het Google-account waarin dit
 * script staat. Er komt geen andere dienst aan te pas.
 *
 * Zo zet je het aan (één keer, zie README "Formulier via Google Apps Script"):
 *   1. script.google.com, Nieuw project, plak dit bestand in Code.gs.
 *   2. Implementeren, Nieuwe implementatie, type Web-app.
 *      Uitvoeren als: Ik. Wie heeft toegang: Iedereen.
 *   3. Kopieer de URL van de web-app en zet hem in tools/github-pages.json bij "formulier_url".
 * Verander je dit script later, maak dan een nieuwe versie van dezelfde implementatie
 * (Implementeren, Implementaties beheren, potlood, Versie: Nieuwe versie). De URL blijft dan gelijk.
 */
const NAAR = 'groengevonden@gmail.com';
const SITE = 'groen-gevonden.nl';
// Een gratis Google-account mag ongeveer 100 mails per dag sturen. Elke aanvraag kost er twee.
const MAX_AANVRAGEN_PER_DAG = 40;

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    // Verborgen veld: alleen robots vullen dit in. We doen alsof het gelukt is.
    if (d.bedrijfswebsite_extra) return antwoord({ ok: true });

    const naam = schoon(d.naam, 100);
    const bedrijf = schoon(d.bedrijf, 120);
    const email = schoon(d.email, 254);
    const telefoon = schoon(d.telefoon, 30);
    const gemeente = schoon(d.gemeente, 60);
    const profiel = schoon(d.website, 300);
    const toestemming = d.toestemming === true || d.toestemming === 'on';
    const vervolg = d.vervolg === true || d.vervolg === 'on';
    const emailGoed = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(email);
    if (!naam || !bedrijf || !gemeente || !profiel || !emailGoed || !toestemming) {
      return antwoord({ ok: false, error: 'Vul alle verplichte velden in en zet het eerste vinkje aan.' });
    }
    if (!binnenDaglimiet()) {
      return antwoord({ ok: false, error: 'Het formulier is nu te druk. Mail naar ' + NAAR + '.' });
    }

    const gegevens = [
      'Bedrijf: ' + bedrijf,
      'Google Bedrijfsprofiel: ' + profiel,
      'Naam: ' + naam,
      'E-mailadres: ' + email,
      'Telefoon: ' + (telefoon || '(niet ingevuld)'),
      'Gemeente: ' + gemeente,
    ];

    // 1. De aanvraag naar de eigen mailbox. Antwoorden gaat naar de aanvrager.
    MailApp.sendEmail({
      to: NAAR,
      replyTo: email,
      subject: 'Scanaanvraag: ' + bedrijf + ' (' + gemeente + ')',
      body: ['Nieuwe aanvraag voor een gratis vindbaarheidsscan via ' + SITE + '.', '']
        .concat(gegevens)
        .concat([
          '',
          'Vinkje 1, scan per e-mail: ja',
          'Vinkje 2, hooguit twee vervolgberichten: ' + (vervolg ? 'ja' : 'nee'),
          'Aangevraagd: ' + Utilities.formatDate(new Date(), 'Europe/Amsterdam', 'dd-MM-yyyy HH:mm'),
          '',
          'Bewaar deze mail: dit is het bewijs dat de hovenier zelf om de scan vroeg.',
        ]).join('\n'),
    });

    // 2. De bevestiging naar de aanvrager. Geen aanbod en geen prijs: alleen wat er is aangevraagd.
    MailApp.sendEmail({
      to: email,
      replyTo: NAAR,
      name: 'Groen Gevonden',
      subject: 'Je aanvraag voor een gratis scan is binnen',
      body: [
        'Beste ' + naam + ',',
        '',
        'Je aanvraag voor een gratis vindbaarheidsscan van ' + bedrijf + ' is binnen.',
        'Je krijgt de scan binnen twee werkdagen per e-mail.',
        '',
        'Dit heb je ingevuld:',
      ].concat(gegevens).concat([
        '',
        'Heb jij dit niet aangevraagd? Antwoord dan op deze mail. Dan verwijder ik je gegevens.',
        '',
        'Groet,',
        'Max',
        'Groen Gevonden, Muiderberg',
        NAAR,
        '',
        'Hoe ik met je gegevens omga, lees je op ' + SITE + '/privacy.',
      ]).join('\n'),
    });

    return antwoord({ ok: true });
  } catch (err) {
    console.error(err);
    return antwoord({ ok: false, error: 'Versturen lukte niet.' });
  }
}

// Handig om te zien of de web-app aan staat: open de URL in je browser.
function doGet() {
  return antwoord({ ok: true, melding: 'Het formulier van Groen Gevonden staat aan.' });
}

// Haalt regeleinden weg (zodat niemand extra regels in de mail kan smokkelen) en kapt af op de maximale lengte.
function schoon(waarde, maximaal) {
  return String(waarde == null ? '' : waarde).replace(/[\r\n\t]+/g, ' ').trim().slice(0, maximaal);
}

// Telt de aanvragen van vandaag. Zo kan niemand via het formulier eindeloos mails laten versturen.
function binnenDaglimiet() {
  const slot = LockService.getScriptLock();
  slot.waitLock(10000);
  try {
    const opslag = PropertiesService.getScriptProperties();
    const vandaag = Utilities.formatDate(new Date(), 'Europe/Amsterdam', 'yyyy-MM-dd');
    let teller = JSON.parse(opslag.getProperty('teller') || '{}');
    if (teller.dag !== vandaag) teller = { dag: vandaag, aantal: 0 };
    if (teller.aantal >= MAX_AANVRAGEN_PER_DAG) return false;
    teller.aantal += 1;
    opslag.setProperty('teller', JSON.stringify(teller));
    return true;
  } finally {
    slot.releaseLock();
  }
}

function antwoord(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);
}
