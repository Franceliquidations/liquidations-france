const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ============================================================
// FLUX RSS GOOGLE ACTUALITÉS
// ============================================================
const FLUX_RSS = [
  'liquidation+totale+magasin+france',
  'liquidation+judiciaire+commerce+france',
  'fermeture+définitive+boutique+france',
  'liquidation+stock+enseigne+france',
  'tout+doit+partir+liquidation+france',
  'liquidation+vêtements+france',
  'liquidation+électroménager+france',
  'liquidation+meubles+france',
  'liquidation+chaussures+france',
  'liquidation+sport+france',
  'fermeture+magasin+liquidation+soldes',
  'dépôt+bilan+enseigne+france',
  'redressement+judiciaire+commerce+france',
];

const MOTS_POSITIFS = [
  'liquidation','fermeture définitive','tout doit partir','dépôt de bilan',
  'redressement judiciaire','liquidation judiciaire','liquidation totale',
  'fermeture boutique','fermeture magasin','soldes de fermeture',
  'liquidation stock','vente liquidation'
];

const MOTS_EXCLUS = [
  'liquidités','liquidation boursière','assurance liquidation',
  'liquidation succession','liquidation société holding'
];

function estPertinent(titre, description) {
  const texte = (titre + ' ' + description).toLowerCase();
  const positif = MOTS_POSITIFS.some(m => texte.includes(m.toLowerCase()));
  const exclu   = MOTS_EXCLUS.some(m => texte.includes(m.toLowerCase()));
  return positif && !exclu;
}

function extraireDept(texte) {
  const match = texte.match(/\b(0[1-9]|[1-8]\d|9[0-5]|97[1-6])\d{3}\b/);
  if (match) return match[0].substring(0, 2);
  return '';
}

function extraireVille(texte) {
  const match = texte.match(/\b(?:à|de|en|sur)\s+([A-ZÉÈÊËÀÂÙÛÜÎÏÔŒÆÇ][a-zéèêëàâùûüîïôœæç]+(?:[-\s][A-ZÉÈÊËÀÂÙÛÜÎÏÔŒÆÇ][a-zéèêëàâùûüîïôœæç]+)*)/);
  if (match) return match[1];
  return '';
}

function extraireEnseigne(titre) {
  const patterns = [
    /^(.+?)\s+(?:en liquidation|en redressement|ferme définitivement|fermeture)/i,
    /liquidation\s+(?:de\s+)?(.+?)(?:\s+à|\s+en|\s*:|\s*-|\s*\|)/i,
    /fermeture\s+(?:de\s+)?(.+?)(?:\s+à|\s+en|\s*:|\s*-|\s*\|)/i,
  ];
  for (const p of patterns) {
    const m = titre.match(p);
    if (m && m[1] && m[1].length < 60) return m[1].trim();
  }
  return titre.substring(0, 80).trim();
}

async function parserFluxRSS(requete) {
  const url = `https://news.google.com/rss/search?q=${requete}&hl=fr&gl=FR&ceid=FR:fr`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LiquidationsFrance/1.0)' }
    });
    if (!res.ok) {
      console.log(`   ⚠️  Flux erreur ${res.status}`);
      return [];
    }

    const xml = await res.text();
    const articles = [];
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

    for (const item of items) {
      const titre  = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)  || item.match(/<title>(.*?)<\/title>/))?.[1]  || '';
      const lien   = (item.match(/<link>(.*?)<\/link>/)                    || item.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/))?.[1] || '';
      const desc   = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/))?.[1] || '';
      const date   = (item.match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
      const source = (item.match(/<source[^>]*>(.*?)<\/source>/))?.[1] || '';

      const descPropre  = desc.replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').trim();
      const titrePropre = titre.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').trim();

      if (!titrePropre || !lien) continue;
      if (!estPertinent(titrePropre, descPropre)) continue;

      const texteComplet = titrePropre + ' ' + descPropre;

      articles.push({
        titre:          titrePropre,
        lien,
        description:    descPropre.substring(0, 500),
        date_article:   date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        source_media:   source,
        ville:          extraireVille(texteComplet),
        departement:    extraireDept(texteComplet),
        nom:            extraireEnseigne(titrePropre),
      });
    }

    return articles;
  } catch(e) {
    console.log(`   ⚠️  Erreur: ${e.message}`);
    return [];
  }
}

async function main() {
  console.log('🚀 Démarrage du collecteur RSS...');
  console.log(`📅 Date: ${new Date().toLocaleDateString('fr-FR')}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: {} },
    realtime: { transport: ws }
  });

  let totalArticles = 0;
  let totalInsere   = 0;
  const dejaVus     = new Set();

  for (const requete of FLUX_RSS) {
    console.log(`\n📰 Flux: "${requete.replace(/\+/g,' ')}"...`);

    const articles = await parserFluxRSS(requete);
    console.log(`   → ${articles.length} articles pertinents`);
    totalArticles += articles.length;

    const nouveaux = articles.filter(a => !dejaVus.has(a.lien));
    nouveaux.forEach(a => dejaVus.add(a.lien));
    if (nouveaux.length === 0) continue;

    const toInsert = nouveaux.map(a => ({
      source_url:     a.lien,
      nom:            a.nom,
      ville:          a.ville || '',
      adresse:        null,
      code_postal:    '',
      departement:    a.departement || '',
      type_procedure: 'Liquidation (presse)',
      date_parution:  a.date_article,
      activite:       '',
      description:    a.description,
      source_media:   a.source_media,
      est_retail:     true,
      score_affaire:  3,
      url_bodacc:     a.lien,
      verifie:        false,
      source:         'Google Actualités',
      actif:          true
    }));

    const { error } = await supabase
      .from('liquidations')
      .upsert(toInsert, { onConflict: 'source_url', ignoreDuplicates: true });

    if (error) {
      console.error(`   ❌ Erreur Supabase: ${error.message}`);
    } else {
      totalInsere += toInsert.length;
      console.log(`   ✅ ${toInsert.length} insérés`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n✅ Collecte terminée !`);
  console.log(`   📰 Articles pertinents : ${totalArticles}`);
  console.log(`   📦 Insertions : ${totalInsere}`);

  try {
    await supabase.from('meta').upsert({ cle: 'derniere_collecte', valeur: new Date().toISOString() });
  } catch(e) {}
}

main().catch(err => {
  console.error('💥 Erreur fatale:', err);
  process.exit(1);
});
