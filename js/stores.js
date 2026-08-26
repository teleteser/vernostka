// Vernostka store presets - common loyalty-card retailers with known domain (for reliable
// favicon lookup) and a brand color used as a fallback background if no logo image is found.
const STORE_PRESETS = [
  { name: 'Lidl', domain: 'lidl.sk', color: '#0050AA' },
  { name: 'Kaufland', domain: 'kaufland.sk', color: '#E10915' },
  { name: 'Tesco', domain: 'tesco.sk', color: '#00539F' },
  { name: 'Billa', domain: 'billa.sk', color: '#E2001A' },
  { name: 'COOP Jednota', domain: 'coop.sk', color: '#00954C' },
  { name: 'dm drogerie markt', domain: 'dm.sk', color: '#0C1F73' },
  { name: 'Decathlon', domain: 'decathlon.sk', color: '#0082C3' },
  { name: 'IKEA', domain: 'ikea.com', color: '#0058A3' },
  { name: 'McDonald\'s', domain: 'mcdonalds.sk', color: '#DA291C' },
  { name: 'KFC', domain: 'kfc.sk', color: '#E4002B' },
  { name: 'Starbucks', domain: 'starbucks.com', color: '#00704A' },
  { name: 'H&M', domain: 'hm.com', color: '#E50010' },
  { name: 'C&A', domain: 'c-and-a.com', color: '#EE1C25' },
  { name: 'Deichmann', domain: 'deichmann.com', color: '#FCD900' },
  { name: 'Alza', domain: 'alza.sk', color: '#AE1E22' },
  { name: 'Datart', domain: 'datart.sk', color: '#004F9F' },
  { name: 'OMV', domain: 'omv.sk', color: '#1B1464' },
  { name: 'Shell', domain: 'shell.sk', color: '#FFD500' },
  { name: 'Slovnaft', domain: 'slovnaft.sk', color: '#0033A0' },
  { name: 'Yves Rocher', domain: 'yvesrocher.sk', color: '#00623B' },
  { name: 'Sephora', domain: 'sephora.sk', color: '#0B0B0B' },
  { name: 'Baumax', domain: 'baumax.sk', color: '#EC6608' },
  { name: 'Hornbach', domain: 'hornbach.sk', color: '#F39200' },
  { name: 'Jysk', domain: 'jysk.sk', color: '#0C4DA1' },
  { name: 'Pepco', domain: 'pepco.sk', color: '#E4032E' }
];

function findStoreSuggestions(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  return STORE_PRESETS.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 5);
}
