// ============================================================
// COLLECTEUR BODACC — tourne automatiquement chaque nuit
// Interroge l'API officielle et stocke dans Supabase
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BODACC_API  = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records';

// Secteurs de commerce de détail qui intéressent les chasseurs de bonnes affaires
const SECTEURS_RETAIL = [
  'vêtement', 'habillement', 'mode', 'textile', 'lingerie', 'chaussure',
  'électronique', 'électroménager', 'informatique', 'téléphonie', 'high-tech',
  'meuble', 'ameublement', 'décoration', 'literie', 'maison',
  'sport', 'loisir', 'jouet', 'jeux',
  'librairie', 'livre', 'papeterie',
  'bijou', 'bijouterie', 'horlogerie', 'accessoire',
  'bricolage', 'jardinerie', 'jardinage',
  'cosméti', 'parfum', 'beauté',
  'alimentation', 'épicerie', 'supermarché', 'traiteur',
  'restaurant', 'café', 'brasserie',
  'optique', 'lunette',
  'détail', 'commerce', 'magasin', 'boutique', 'enseigne', 'vente au détail'
];

function estRetail(activite = '') {
  const a = activite.toLowerCase();
  return SECTEURS_RETAIL.some(s => a.includes(s));
}

function scoreAffaire(record) {
  // Score de 1 à 5 étoiles selon l'attractivité pour les bonnes affaires
  let score = 3; // score de base
  const activite = (record.activite || '').toLowerCase();
  const type = (record.type || '').toLowerCase();

  // Liquidation judiciaire = meilleures remises (entreprise forcée de liquider)
  if (type.includes('liquidation')) score += 1;

  // Secteurs avec fort potentiel de bonnes affaires
  if (['électronique','meuble','ameublement','vêtement','mode','chaussure'].some(s => activite.includes(s))) score += 1;

  return Math.min(score, 5);
}

async function fetchBODACC(offset = 0) {
  const params = new URLSearchParams({
    limit: 100,
    offset,
    order_by: 'dateparution DESC',
    select: 'id,dateparution,ville,cp,nomcommercial,activite,familleavis_lib,numerodepartement,publicationavis',
    where: `familleavis_lib IN ("Jugement de liquidation","Jugement d'ouverture de la procédure de liquidation judiciaire","Redressement judiciaire","Jugement de redressement","Sauvegarde","Jugement d'ouverture de la procédure de sauvegarde") AND dateparution >= "2024-01-01"`
  });

  const res = await fetch(`${BODACC_API}?${params}`);
  if (!res.ok) throw new Error(`BODACC API erreur: ${res.status}`);
  return res.json();
}

function normaliserRecord(r) {
  const pub = r.publicationavis || {};
  const pm  = pub.personneMorale || {};
  const pp  = pub.personnePhysique || {};
  const adr = pub.adresse || {};

  const nom = r.nomcommercial
    || pm.denomination
    || (pp.prenom ? `${pp.prenom} ${pp.nom}` : pp.nom)
    || 'N/A';

  const ville = r.ville || adr.ville || '—';
  const cp    = r.cp || adr.codePostal || '';
  const dept  = r.numerodepartement || (cp ? cp.substring(0, 2) : '—');

  const type = r.familleavis_lib || '—';
  const typeCourt = type.toLowerCase().includes('liquidation') ? 'Liquidation judiciaire'
    : type.toLowerCase().includes('redressement') ? 'Redressement judiciaire'
    : type.toLowerCase().includes('sauvegarde')   ? 'Sauvegarde'
    : type;

  const activite = r.activite || pub.activite || '—';

  const adresse = [
    adr.numVoie, adr.typeVoie, adr.nomVoie
  ].filter(Boolean).join(' ') || '';
  const adresseComplete = adresse
    ? `${adresse}, ${cp} ${ville}`
    : '';

  const record = {
    bodacc_id:    r.id || '',
    nom:          nom.trim(),
    ville:        ville,
    adresse:      adresseComplete || null,
    code_postal:  cp,
    departement:  dept,
    type_procedure: typeCourt,
    date_parution: r.dateparution ? r.dateparution.split('T')[0] : null,
    activite:     activite,
    est_retail:   estRetail(activite),
    score_affaire: scoreAffaire({ activite, type }),
    url_bodacc:   `https://www.bodacc.fr/pages/annonces-commerciales/?q=${encodeURIComponent(nom)}`,
    verifie:      true, // source officielle
    source:       'BODACC'
  };

  return record;
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

    if (records.length === 0) {
      continuer = false;
      break;
    }

    // Normaliser et filtrer uniquement le retail
    const normalized = records.map(normaliserRecord);
    const retailSeulement = normalized.filter(r => r.est_retail);
    console.log(`   → ${retailSeulement.length} annonces retail pertinentes`);

    // Insérer dans Supabase (ignore les doublons via bodacc_id)
    if (retailSeulement.length > 0) {
      const { data: inserted, error } = await supabase
        .from('liquidations')
        .upsert(retailSeulement, { onConflict: 'bodacc_id', ignoreDuplicates: true });

      if (error) {
        console.error('❌ Erreur Supabase:', error.message);
      } else {
        totalInsere += retailSeulement.length;
        console.log(`   ✅ ${retailSeulement.length} enregistrements insérés/mis à jour`);
      }
    }

    totalIgnore += (records.length - retailSeulement.length);

    // Limite : 300 annonces max par exécution pour rester dans les quotas gratuits
    offset += 100;
    if (offset >= 300 || records.length < 100) continuer = false;
  }

  console.log(`\n✅ Collecte terminée !`);
  console.log(`   📦 Insertions : ${totalInsere}`);
  console.log(`   ⏭️  Ignorés (hors retail) : ${totalIgnore}`);

  // Mettre à jour la date de dernière collecte
  await supabase
    .from('meta')
    .upsert({ cle: 'derniere_collecte', valeur: new Date().toISOString() });
}

main().catch(err => {
  console.error('💥 Erreur fatale:', err);
  process.exit(1);
});
