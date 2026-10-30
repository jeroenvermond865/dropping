// Eenmalig: testmodus uit voor Familieweekend 2026.
module.exports = function testmodus(db, save) {
  const d = db.droppings.find(x => x.id === 'dc316e4ae5b');
  if (!d) return console.log('[testmodus] dropping niet gevonden');
  d.settings.testMode = false;
  save(db);
  console.log('[testmodus] uit voor', d.settings.title);
};
