// Eenmalig: punten met opdrachten langs "Route rechtsom" en het team De Avondstrijders
// toevoegen aan Familieweekend 2026. Slaat over als het team er al is. De route blijft ongemoeid.
const game = require('./game');

const DROPPING = 'dc316e4ae5b';
const TEAM = 'De Avondstrijders';

// Letters vormen gehusseld het codewoord VLEERMUIS.
const POINTS = [
  { name: 'Eerste bocht', lat: 52.10114, lng: 5.6639, type: 'vraag', letter: 'M',
    intro: 'Jullie zijn op weg! Hier maakt de route een bocht.',
    question: 'Lampen uit en 30 seconden doodstil staan. Hoeveel verschillende geluiden hoorden jullie, en welke?',
    hint: 'Elk antwoord telt, als jullie maar echt stil waren.' },
  { name: 'Lange rechte stuk', lat: 52.0957, lng: 5.6736, type: 'foto', letter: 'U', kompas: true,
    intro: 'Kaart weg! Alleen het kompas wijst de weg langs de bosrand.',
    question: 'Lichtkunst: maak een foto waarop jullie met telefoonlampjes samen een grote A vormen, van Avondstrijders. Lange sluitertijd of nachtmodus helpt.' },
  { name: 'Zuidpunt', lat: 52.08942, lng: 5.67931, type: 'keuze', letter: 'E',
    intro: 'Het zuidelijkste punt van de tocht. Vanaf hier buigen jullie om het bos heen.',
    question: 'Het bos naast jullie hoort bij het Wekeromse Zand. Wat is dat eigenlijk?',
    options: ['Een stuifzandgebied', 'Een oude rivierbedding', 'Een zandafgraving voor de snelweg', 'Een strand uit de ijstijd'],
    correct: 0, hint: 'De wind heeft hier eeuwenlang vrij spel gehad.' },
  { name: 'Strijdkreet', lat: 52.08882, lng: 5.68592, type: 'vraag', letter: 'L',
    intro: 'Tijd om te laten horen wie hier loopt.',
    question: 'Verzin een strijdkreet voor de Avondstrijders van precies vier woorden en roep hem drie keer samen (zachtjes als er huizen in de buurt zijn). Typ hem hier in.',
    hint: 'Vier woorden, niet meer en niet minder.' },
  { name: 'Sterrenwacht', lat: 52.0923, lng: 5.69379, type: 'keuze', letter: 'S',
    intro: 'Kijk even omhoog. Zonder straatlantaarns zie je hier veel meer sterren.',
    question: 'Welke ster staat (bijna) altijd op dezelfde plek en wijst het noorden aan?',
    options: ['Sirius', 'De Poolster', 'Venus', 'Betelgeuze'], correct: 1,
    hint: 'Trek een lijn vanaf de achterkant van de Steelpan (Grote Beer).' },
  { name: 'Horrorposter', lat: 52.09479, lng: 5.69682, type: 'foto', letter: 'V',
    intro: 'Donker, stil, bos ernaast: perfect decor.',
    question: 'Maak de poster van jullie eigen horrorfilm: de engste groepsfoto die jullie kunnen maken, alleen met telefoonlampjes als licht.' },
  { name: 'Raadsel van de nacht', lat: 52.09922, lng: 5.69643, type: 'vraag', letter: 'I',
    intro: 'Een raadsel om onderweg over na te denken.',
    question: 'Hoe meer je ervan hebt, hoe minder je ziet. Wat is het?',
    answers: 'duisternis|het donker|donker|duister|de duisternis|het duister|mist',
    hint: 'Jullie lopen er nu middenin.' },
  { name: 'Blinde mol', lat: 52.10309, lng: 5.69815, type: 'opdracht', letter: 'R', kompas: true,
    intro: 'Weer alleen op het kompas. Vertrouw op elkaar.',
    question: 'Eén van jullie doet de ogen dicht en wordt 20 meter over het pad geleid. De rest mag alleen geluiden maken, geen woorden en niet aanraken. Gelukt? Druk dan op klaar.' },
  { name: 'Nachtogen', lat: 52.10651, lng: 5.69687, type: 'keuze', letter: 'E',
    intro: 'Bijna binnen! Merken jullie dat je steeds beter ziet in het donker?',
    question: 'Hoe lang duurt het ongeveer voordat je ogen helemaal aan het donker gewend zijn?',
    options: ['10 seconden', '2 minuten', '20 tot 30 minuten', '2 uur'], correct: 2,
    hint: 'Langer dan je denkt, en één keer in een felle lamp kijken zet de teller weer op nul.' },
  { name: 'Finish', lat: 52.10983, lng: 5.69657, type: 'vraag', letter: '', points: 150,
    intro: 'De laatste etappe! Bij de finish wacht nog één vraag.',
    question: 'Hussel alle letters die jullie verzameld hebben. Welk dier dat hier vannacht rondvliegt vormen ze?',
    answers: 'vleermuis|vleermuizen|de vleermuis',
    hint: 'Het hangt overdag ondersteboven te slapen.' },
];

module.exports = function avond(db, save) {
  const d = db.droppings.find(x => x.id === DROPPING);
  if (!d) return console.log('[avond] dropping niet gevonden');
  if (d.teams.some(t => t.name === TEAM)) return console.log('[avond] al gedaan');
  for (const p of POINTS) {
    if (game.inZone(d, p.lat, p.lng)) { console.log('[avond] in verboden zone, overgeslagen:', p.name); continue; }
    d.points.push({
      id: game.id('p'), radius: 35, intro: '', question: '', answers: '', options: [], correct: 0, hint: '',
      points: 100, letter: '', kompas: false, ...p,
    });
  }
  const pin = TEAM;
  d.teams.push({ id: game.id('t'), name: TEAM, pin, color: '#b06bff', offset: 0 });
  save(db);
  console.log('[avond] toegevoegd:', d.points.length, 'punten in totaal, wachtwoord', pin);
};
