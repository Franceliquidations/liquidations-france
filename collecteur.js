const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BODACC_API  = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records';

const SECTEURS_RETAIL = [
  'vêtement','habillement','mode','textile','lingerie','chaussure',
  'électronique','électroménager','informatique','téléphonie','high-tech',
  'meuble','ameublement','décoration','literie','maison',
  'sport','loisir','jouet','jeux',
  'librairie','livre','papeterie',
  'bijou','bijouterie','horlogerie','accessoire',
  'bricolage','jardinerie',
  'cosméti','parfum','beauté',
  'alimentation','épicerie','supermarché','traiteur',
  'restaurant','café','brasserie',
  'optique','lunette',
  'détail','commerce','magasin','boutique','enseigne'
];

function estRetail(activite = '') {
  const a = activite.toLowerCase();
  return SECTEURS_RETAIL.some(s => a.includes(s));
}

function scoreAffaire(type = '', activite = '') {
  let score = 3;
  if (type.toLowerCase().includes('liquidation')) score += 1;
  if (['électronique','meuble','ameublement','vêtement','mode','chaussure'].some(s => activite.toLowerCase().includes(s))) score += 1;
  return Math.min(score, 5);
}

// Extraire infos depuis publicationavis (structure imbriquée BODACC)
function extraireInfos(r) {
  const pub = r.publicationavis || {};

  // Nom : chercher dans toutes les structures possibles
  let nom = pub.commercant || pub.denomination || '';
  if (!nom && pub.listepersonnes && pub.listepersonnes[0]) {
    const p = pub.listepersonnes[0];
    nom = p.denomination || p.nom || (p.prenom ? `${p.prenom} ${p.nom||''}` : '') || '';
  }
  if (!nom) nom = r.commercant || 'N/A';

  // Activité
  let activite = '';
  if (pub.listepersonnes && pub.listepersonnes[0]) {
    activite = pub.listepersonnes[0].activite || pub.listepersonnes[0].activitedetail || '';
  }
  if (!activite) activite = pub.activite || '';

  // Adresse
  let adresse = '';
  let ville = r.ville || '';
  let cp = r.cp || '';
  if (pub.listepersonnes && pub.listepersonnes[0]) {
    const adr = pub.listepersonnes[0].adresse || {};
    const rue = [adr.numvoie, adr.typevoie, adr.nomvoie].filter(Boolean).join(' ');
    if (rue) adresse = `${rue}, ${adr.codepostal||cp} ${adr.ville||ville}`.trim();
    if (!ville && adr.ville) ville = adr.ville;
    if (!cp && adr.codepostal) cp = adr.codepostal;
  }

  const dept = r.numerodepartement || (cp ? cp.substring(0,2) : '');

  return { nom: nom.trim(), activite: activite.trim(), adresse, ville, cp, dept };
}

async function fetchBODACC(offset = 0) {
  // Requête minimale — seulement les champs qui existent avec certitude
  const params = new URLSearchParams({
    limit: 100,
    offset,
    order_by: 'dateparution DESC',
    where: 'familleavis:"pc"'
  });

  const url = `${BODACC_API}?${params}`;
  console.log(`   URL: ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`BODACC API erreur: ${res.status} — ${txt.slice(0,300)}`);
  }
  return res.json();
}

async function main() {
  console.log('🚀 Démarrage du collecteur BODACC...');
  console.log(`📅 Date: ${new Date().toLocaleDateString('fr-FR')}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: {} },
    realtime: { transport: ws }
  });

  let totalInsere = 0;
  let totalIgnore = 0;
  let offset = 0;
  let continuer = true;

  while (continuer) {
    console.log(`\n📡 Récupération des annonces (offset: ${offset})...`);

    let data;
    try {
      data = await fetchBODACC(offset);
    } catch (e) {
      console.error('❌ Erreur API BODACC:', e.message);
      break;
    }

    const records = data.results || [];
    console.log(`   → ${records.length} annonces reçues`);

    // Log du premier record pour déboguer la structure
    if (offset === 0 && records.length > 0) {
      console.log('   → Exemple de champs disponibles:', Object.keys(records[0]).join(', '));
    }

    if (records.length === 0) { continuer = false; break; }

    const toInsert = [];
    for (const r of records) {
      const { nom, activite, adresse, ville, cp, dept } = extraireInfos(r);
      const type = r.familleavis_lib || '';

      if (!estRetail(activite) && !estRetail(nom)) continue;

      toInsert.push({
        bodacc_id:      r.id || '',
        nom:            nom || 'N/A',
        ville:          ville || '',
        adresse:        adresse || null,
        code_postal:    cp || '',
        departement:    dept || '',
        type_procedure: type,
        date_parution:  r.dateparution ? r.dateparution.split('T')[0] : null,
        activite:       activite || '',
        est_retail:     true,
        score_affaire:  scoreAffaire(type, activite),
        url_bodacc:     `https://www.bodacc.fr/pages/annonces-commerciales-detail/?q.id=id:${r.id}`,
        verifie:        true,
        source:         'BODACC',
        actif:          true
      });
    }

    console.log(`   → ${toInsert.length} annonces retail à insérer`);

    if (toInsert.length > 0) {
      const { error } = await supabase
        .from('liquidations')
        .upsert(toInsert, { onConflict: 'bodacc_id', ignoreDuplicates: true });

      if (error) {
        console.error('❌ Erreur Supabase:', error.message);
      } else {
        totalInsere += toInsert.length;
        console.log(`   ✅ ${toInsert.length} enregistrements insérés`);
      }
    }

    totalIgnore += (records.length - toInsert.length);
    offset += 100;
    if (offset >= 300 || records.length < 100) continuer = false;
  }

  console.log(`\n✅ Collecte terminée !`);
  console.log(`   📦 Insertions : ${totalInsere}`);
  console.log(`   ⏭️  Ignorés (hors retail) : ${totalIgnore}`);

  try {
    await supabase.from('meta').upsert({ cle: 'derniere_collecte', valeur: new Date().toISOString() });
  } catch(e) {}
}

main().catch(err => {
  console.error('💥 Erreur fatale:', err);
  process.exit(1);
});
