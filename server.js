const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const createReport = require('docx-templates').default;
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Configuration PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER || 'administrationSTS',
  host: process.env.DB_HOST || 'avo-adb-002.postgres.database.azure.com',
  database: process.env.DB_NAME || 'rh_application',
  password: process.env.DB_PASS || 'St$@0987',
  port: process.env.DB_PORT || 5432,
  ssl: { rejectUnauthorized: false }
});

// ==================== CONFIGURATION SMTP CORRIGÉE ====================
// Fonction pour créer un transporteur SMTP
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'avocarbon-com.mail.protection.outlook.com',
    port: parseInt(process.env.SMTP_PORT) || 25,
    secure: false, // Port 25 utilise STARTTLS, pas SSL direct
    auth: {
      user: process.env.SMTP_USER || 'administration.STS@avocarbon.com',
      pass: process.env.SMTP_PASSWORD || 'shnlgdyfbcztbhxn'
    },
    tls: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2'
    },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    logger: true,
    debug: process.env.NODE_ENV !== 'production'
  });
};

// Pool de transporteurs SMTP pour une meilleure fiabilité
const emailPool = {
  transporters: [],
  currentIndex: 0,
  maxRetries: 3,
  
  init: function(count = 3) {
    for (let i = 0; i < count; i++) {
      this.transporters.push(createTransporter());
    }
    console.log(`📧 Pool SMTP initialisé avec ${count} transporteurs`);
  },
  
  getTransporter: function() {
    const transporter = this.transporters[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.transporters.length;
    return transporter;
  },
  
  rotateTransporter: function() {
    this.currentIndex = (this.currentIndex + 1) % this.transporters.length;
    return this.getTransporter();
  }
};

// Initialisation du pool
emailPool.init(3);

// Fonction pour vérifier la connexion SMTP
async function verifySMTPConnection() {
  for (let i = 0; i < emailPool.transporters.length; i++) {
    try {
      await emailPool.transporters[i].verify();
      console.log(`✅ Connexion SMTP ${i+1} établie avec succès`);
    } catch (error) {
      console.error(`❌ Échec connexion SMTP ${i+1}:`, error.message);
    }
  }
}

// Fonction pour logger les détails d'envoi d'email
function logEmailDetails(mailOptions, context, attempt = 1) {
  console.log(`📧 [${new Date().toISOString()}] Détails email (tentative ${attempt}):`);
  console.log(`   Contexte: ${context}`);
  console.log(`   De: ${mailOptions.from.address || mailOptions.from}`);
  console.log(`   À: ${mailOptions.to}`);
  console.log(`   Sujet: ${mailOptions.subject}`);
  console.log(`   Pièces jointes: ${mailOptions.attachments ? mailOptions.attachments.length : 0}`);
  if (mailOptions.attachments && mailOptions.attachments.length > 0) {
    const totalSize = mailOptions.attachments.reduce((sum, att) => sum + (att.content?.length || 0), 0);
    console.log(`   Taille totale: ${Math.round(totalSize / 1024)}KB`);
  }
}

// Fonction améliorée pour envoyer des emails avec retry et fallback
async function sendEmailWithRetry(mailOptions, context, maxRetries = 3) {
  let lastError;
  
  // S'assurer que l'email FROM est correct
  if (!mailOptions.from) {
    mailOptions.from = {
      name: 'Administration STS',
      address: process.env.SMTP_FROM || 'administration.STS@avocarbon.com'
    };
  }
  
  logEmailDetails(mailOptions, context, 1);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const transporter = emailPool.getTransporter();
    
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`✅ Email envoyé avec succès (tentative ${attempt}/${maxRetries})`);
      console.log(`   Message ID: ${info.messageId}`);
      console.log(`   Response: ${info.response}`);
      
      return {
        success: true,
        messageId: info.messageId,
        attempt: attempt
      };
      
    } catch (error) {
      lastError = error;
      console.error(`❌ Échec envoi email ${context} (tentative ${attempt}/${maxRetries}):`, error.message);
      
      // Log plus détaillé pour diagnostic
      if (error.code) console.error(`   Code d'erreur: ${error.code}`);
      if (error.command) console.error(`   Commande: ${error.command}`);
      
      if (attempt < maxRetries) {
        const baseDelay = 2000;
        const maxDelay = 15000;
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        const jitter = Math.random() * 1000;
        const totalDelay = delay + jitter;
        
        console.log(`⏳ Nouvelle tentative dans ${Math.round(totalDelay)}ms...`);
        
        emailPool.rotateTransporter();
        await new Promise(resolve => setTimeout(resolve, totalDelay));
        
        logEmailDetails(mailOptions, context, attempt + 1);
      }
    }
  }
  
  // Toutes les tentatives ont échoué - dernière tentative avec nouveau transporteur
  console.error(`💥 Échec final après ${maxRetries} tentatives`);
  
  try {
    console.log('🔄 Tentative finale avec nouveau transporteur...');
    const emergencyTransporter = createTransporter();
    const info = await emergencyTransporter.sendMail(mailOptions);
    
    console.log('✅ Email envoyé avec transporteur d\'urgence');
    return {
      success: true,
      messageId: info.messageId,
      attempt: 'emergency',
      warning: 'Sent with emergency transporter'
    };
    
  } catch (emergencyError) {
    console.error('💥 Échec même avec transporteur d\'urgence:', emergencyError.message);
    
    throw {
      message: `Échec d'envoi après ${maxRetries} tentatives et transporteur d'urgence`,
      originalError: lastError,
      emergencyError: emergencyError,
      context: context
    };
  }
}

// ==================== HELPER FUNCTIONS ====================
const BASE_URL = process.env.BASE_URL || 'https://hr-back.azurewebsites.net';
const TEMPLATE_TRAVAIL_PATH = path.join(__dirname, 'templates', 'Attestation de travail Modèle IA.docx');
const TEMPLATE_SALAIRE_PATH = path.join(__dirname, 'templates', 'Attestation de salaire Modèle IA.docx');

function extraireNomPrenomDepuisEmail(email) {
  if (!email) return { prenom: '', nom: '', fullName: '' };
  
  const localPart = email.split('@')[0];
  const rawParts = localPart.split(/[._-]+/).filter(Boolean);
  const capitalize = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : '';
  
  if (rawParts.length >= 2) {
    const prenom = capitalize(rawParts[0]);
    const nom = capitalize(rawParts[1]);
    return { prenom, nom, fullName: `${prenom} ${nom}` };
  } else {
    const prenom = capitalize(rawParts[0]);
    return { prenom, nom: '', fullName: prenom };
  }
}

function genererReference(nom, prenom) {
  const now = new Date();
  const initial = (prenom ? prenom[0] : nom ? nom[0] : 'X').toUpperCase();
  const jour = String(now.getDate()).padStart(2, '0');
  const mois = String(now.getMonth() + 1).padStart(2, '0');
  const annee = now.getFullYear();
  const heures = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const secondes = String(now.getSeconds()).padStart(2, '0');
  
  return `${initial}${jour}${mois}${annee}${heures}${minutes}${secondes}`;
}

function formatDateFR(date) {
  if (!date) return '';
  if (typeof date === 'string' && date.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
    return date;
  }
  
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  
  const jour = String(d.getDate()).padStart(2, '0');
  const mois = String(d.getMonth() + 1).padStart(2, '0');
  const annee = d.getFullYear();
  
  return `${jour}/${mois}/${annee}`;
}

function formatDateShort(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('fr-FR');
}

function getTypeCongeLabel(type_conge, type_conge_autre) {
  if (!type_conge) return 'Non spécifié';
  if (type_conge === 'annuel') return 'Congé annuel';
  if (type_conge === 'sans_solde') return 'Congé sans solde';
  if (type_conge === 'autre') {
    return `Autre${type_conge_autre ? ` (${type_conge_autre})` : ''}`;
  }
  return type_conge;
}

function calculerJoursOuvres(dateDebut, dateFin) {
  if (!dateDebut || !dateFin) return 0;
  
  const debut = new Date(dateDebut);
  const fin = new Date(dateFin);
  
  debut.setHours(0, 0, 0, 0);
  fin.setHours(0, 0, 0, 0);
  
  if (fin < debut) return 0;
  
  let joursOuvres = 0;
  const dateActuelle = new Date(debut);
  
  while (dateActuelle <= fin) {
    const jourSemaine = dateActuelle.getDay();
    if (jourSemaine >= 1 && jourSemaine <= 5) {
      joursOuvres++;
    }
    dateActuelle.setDate(dateActuelle.getDate() + 1);
  }
  
  return joursOuvres;
}

async function optimizeAttachments(attachments) {
  if (!attachments || attachments.length === 0) return attachments;
  
  return attachments.map(attachment => {
    if (attachment.content && attachment.content.length > 5 * 1024 * 1024) {
      console.warn(`⚠️ Pièce jointe volumineuse: ${attachment.filename} (${Math.round(attachment.content.length / 1024 / 1024)}MB)`);
    }
    return attachment;
  });
}

// ==================== GÉNÉRATION DE DOCUMENTS ====================
async function genererAttestationTravailWord(employe) {
  try {
    await fs.access(TEMPLATE_TRAVAIL_PATH);
    const templateBuffer = await fs.readFile(TEMPLATE_TRAVAIL_PATH);
    const reference = genererReference(employe.nom, employe.prenom);
    
    const data = {
      reference: reference,
      nom_complet: `${employe.nom} ${employe.prenom}`,
      date_naissance: formatDateFR(employe.date_naissance || ''),
      cin: employe.cin || '',
      date_debut: formatDateFR(employe.date_debut),
      poste: employe.poste || '',
      date_actuelle: formatDateFR(new Date())
    };
    
    const reportBuffer = await createReport({
      template: templateBuffer,
      data,
      cmdDelimiter: ['{{', '}}'],
      additionalJsContext: {
        uppercase: (str) => str ? str.toUpperCase() : '',
        lowercase: (str) => str ? str.toLowerCase() : '',
        capitalize: (str) => str ? str.charAt(0).toUpperCase() + str.slice(1) : ''
      }
    });
    
    console.log(`✅ Attestation travail générée pour ${employe.nom} ${employe.prenom} (${reportBuffer.length} octets)`);
    return reportBuffer;
    
  } catch (error) {
    console.error('Erreur génération attestation travail:', error);
    throw error;
  }
}

async function genererAttestationSalaireWord(employe) {
  try {
    await fs.access(TEMPLATE_SALAIRE_PATH);
    const templateBuffer = await fs.readFile(TEMPLATE_SALAIRE_PATH);
    
    const formaterSalaire = (salaire) => {
      if (!salaire) return '0,00';
      return parseFloat(salaire).toLocaleString('fr-TN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).replace(/,/g, ' ');
    };
    
    const reference = genererReference(employe.nom, employe.prenom);
    
    const data = {
      reference: reference,
      nom_complet: `${employe.nom} ${employe.prenom}`,
      cin: employe.cin || '',
      date_debut: formatDateFR(employe.date_debut),
      poste: employe.poste || '',
      salaire: formaterSalaire(employe.salaire_brute),
      date_actuelle: formatDateFR(new Date())
    };
    
    const reportBuffer = await createReport({
      template: templateBuffer,
      data,
      cmdDelimiter: ['{{', '}}'],
      additionalJsContext: {
        uppercase: (str) => str ? str.toUpperCase() : '',
        lowercase: (str) => str ? str.toLowerCase() : '',
        capitalize: (str) => str ? str.charAt(0).toUpperCase() + str.slice(1) : ''
      }
    });
    
    console.log(`✅ Attestation salaire générée pour ${employe.nom} ${employe.prenom} (${reportBuffer.length} octets)`);
    return reportBuffer;
    
  } catch (error) {
    console.error('Erreur génération attestation salaire:', error);
    throw error;
  }
}

// ==================== ROUTES API ====================
app.get('/api/employees/actifs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, matricule, nom, prenom, poste, adresse_mail, mail_responsable1, mail_responsable2, 
              date_debut, date_naissance, cin, salaire_brute 
       FROM employees 
       WHERE date_depart IS NULL 
       ORDER BY nom, prenom`
    );
    
    console.log(`✅ Récupération ${result.rows.length} employés actifs`);
    res.json(result.rows);
    
  } catch (err) {
    console.error('❌ Erreur récupération employés:', err);
    res.status(500).json({ error: 'Erreur lors de la récupération des employés' });
  }
});

app.post('/api/generer-attestation', async (req, res) => {
  const { employe_id, type_document } = req.body;
  
  try {
    if (!employe_id || !type_document) {
      return res.status(400).json({ error: 'Les champs employé et type de document sont obligatoires' });
    }
    
    console.log(`📄 Génération attestation pour employé ${employe_id}, type: ${type_document}`);
    
    const employeResult = await pool.query(
      `SELECT nom, prenom, poste, adresse_mail, date_debut, date_naissance, cin, matricule, salaire_brute 
       FROM employees WHERE id = $1`,
      [employe_id]
    );
    
    if (employeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Employé non trouvé' });
    }
    
    const employe = employeResult.rows[0];
    let wordBuffer;
    let fileName;
    let documentTypeLabel;
    
    if (type_document === 'attestation_salaire') {
      if (!employe.salaire_brute) {
        return res.status(400).json({ error: 'Salaire non disponible pour cet employé' });
      }
      wordBuffer = await genererAttestationSalaireWord(employe);
      fileName = `Attestation_Salaire_${employe.nom}_${employe.prenom}.docx`;
      documentTypeLabel = 'Attestation de salaire';
    } else {
      wordBuffer = await genererAttestationTravailWord(employe);
      fileName = `Attestation_Travail_${employe.nom}_${employe.prenom}.docx`;
      documentTypeLabel = 'Attestation de travail';
    }
    
    const optimizedAttachments = await optimizeAttachments([
      {
        filename: fileName,
        content: wordBuffer,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }
    ]);
    
    const mailOptions = {
      from: {
        name: 'Administration STS',
        address: process.env.SMTP_FROM || 'administration.STS@avocarbon.com'
      },
      to: 'majed.messai@avocarbon.com',
      subject: `Demande de ${documentTypeLabel.toLowerCase()} - ${employe.nom} ${employe.prenom}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2c3e50;">Demande de ${documentTypeLabel.toLowerCase()}</h2>
          
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Employé:</strong> ${employe.nom} ${employe.prenom}</p>
            <p><strong>Matricule:</strong> ${employe.matricule || 'Non spécifié'}</p>
            <p><strong>Poste:</strong> ${employe.poste || 'Non spécifié'}</p>
            <p><strong>Date d'embauche:</strong> ${formatDateFR(employe.date_debut)}</p>
            <p><strong>Type de document:</strong> ${documentTypeLabel}</p>
            ${type_document === 'attestation_salaire' ? `
              <p><strong>Salaire brut annuel:</strong> ${employe.salaire_brute} TND</p>
            ` : ''}
            <p><strong>Date de la demande:</strong> ${formatDateFR(new Date())}</p>
          </div>
          
          <p>${documentTypeLabel} est jointe à cet email en format Word (.docx).</p>
        </div>
      `,
      attachments: optimizedAttachments
    };
    
    const emailResult = await sendEmailWithRetry(mailOptions, `Génération ${documentTypeLabel}`);
    
    res.json({
      success: true,
      message: `${documentTypeLabel} générée et envoyée par email avec succès`,
      fileName: fileName,
      emailResult: emailResult
    });
    
  } catch (err) {
    console.error('❌ Erreur génération attestation:', err);
    res.status(500).json({
      error: 'Erreur lors de la génération du document: ' + err.message,
      details: err.details || ''
    });
  }
});

app.post('/api/telecharger-attestation', async (req, res) => {
  const { employe_id, type_document } = req.body;
  
  try {
    if (!employe_id) {
      return res.status(400).json({ error: 'ID employé requis' });
    }
    
    console.log(`📥 Téléchargement attestation pour employé ${employe_id}, type: ${type_document}`);
    
    const employeResult = await pool.query(
      `SELECT nom, prenom, poste, date_debut, date_naissance, cin, salaire_brute 
       FROM employees WHERE id = $1`,
      [employe_id]
    );
    
    if (employeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Employé non trouvé' });
    }
    
    const employe = employeResult.rows[0];
    let wordBuffer;
    let fileName;
    
    if (type_document === 'attestation_salaire') {
      wordBuffer = await genererAttestationSalaireWord(employe);
      fileName = `Attestation_Salaire_${employe.nom}_${employe.prenom}.docx`;
    } else {
      wordBuffer = await genererAttestationTravailWord(employe);
      fileName = `Attestation_Travail_${employe.nom}_${employe.prenom}.docx`;
    }
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', wordBuffer.length);
    
    console.log(`✅ Téléchargement ${fileName} (${wordBuffer.length} octets)`);
    res.send(wordBuffer);
    
  } catch (error) {
    console.error('❌ Erreur téléchargement attestation:', error);
    res.status(500).json({ error: 'Erreur lors de la génération du document' });
  }
});

app.post('/api/demandes', async (req, res) => {
  const {
    employe_id, type_demande, titre, date_depart, date_retour,
    heure_depart, heure_retour, demi_journee, type_conge,
    frais_deplacement, type_conge_autre
  } = req.body;
  
  try {
    if (!employe_id || !type_demande || !titre || !date_depart) {
      return res.status(400).json({
        error: 'Les champs employé, type de demande, titre et date de départ sont obligatoires'
      });
    }
    
    console.log(`📋 Création demande ${type_demande} pour employé ${employe_id}: ${titre}`);
    
    const employeResult = await pool.query(
      `SELECT nom, prenom, poste, adresse_mail, mail_responsable1, mail_responsable2 
       FROM employees WHERE id = $1`,
      [employe_id]
    );
    
    if (employeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Employé non trouvé' });
    }
    
    const employe = employeResult.rows[0];
    
    const dateRetourFinal = date_retour && date_retour !== '' ? date_retour : null;
    const heureDepartFinal = heure_depart && heure_depart !== '' ? heure_depart : null;
    const heureRetourFinal = heure_retour && heure_retour !== '' ? heure_retour : null;
    const fraisDeplacementFinal = frais_deplacement && frais_deplacement !== '' ? parseFloat(frais_deplacement) : null;
    const typeCongeFinal = type_conge && type_conge !== '' ? type_conge : null;
    const typeCongeAutreFinal = type_conge_autre && type_conge_autre.trim() !== '' ? type_conge_autre.trim() : null;
    
    const insertResult = await pool.query(
      `INSERT INTO demande_rh 
       (employe_id, type_demande, titre, date_depart, date_retour, heure_depart, heure_retour, 
        demi_journee, type_conge, type_conge_autre, frais_deplacement, statut) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
       RETURNING id`,
      [
        employe_id, type_demande, titre, date_depart, dateRetourFinal,
        heureDepartFinal, heureRetourFinal, demi_journee || false,
        typeCongeFinal, typeCongeAutreFinal, fraisDeplacementFinal, 'en_attente'
      ]
    );
    
    const demandeId = insertResult.rows[0].id;
    console.log(`✅ Demande créée avec ID: ${demandeId}`);
    
    if (employe.mail_responsable1) {
      await envoyerEmailResponsable(
        employe,
        employe.mail_responsable1,
        demandeId,
        1,
        {
          type_demande,
          titre,
          date_depart,
          date_retour: dateRetourFinal,
          heure_depart: heureDepartFinal,
          heure_retour: heureRetourFinal,
          demi_journee,
          type_conge: typeCongeFinal,
          type_conge_autre: typeCongeAutreFinal,
          frais_deplacement: fraisDeplacementFinal
        }
      );
    } else {
      console.warn(`⚠️ Aucun responsable 1 défini pour ${employe.nom} ${employe.prenom}`);
    }
    
    res.json({
      success: true,
      message: 'Demande créée avec succès',
      demandeId
    });
    
  } catch (err) {
    console.error('❌ Erreur création demande:', err);
    res.status(500).json({ error: 'Erreur lors de la création de la demande: ' + err.message });
  }
});

async function envoyerEmailResponsable(employe, emailResponsable, demandeId, niveau, details, premierResponsable = null) {
  const baseUrl = BASE_URL;
  const lienApprobation = `${baseUrl}/approuver-demande?id=${demandeId}&niveau=${niveau}`;
  
  let typeLabel = details.type_demande === 'conges' ? 'Congé' :
                  details.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';
  
  let detailsHtml = `
    <p><strong>Type:</strong> ${typeLabel}</p>
    <p><strong>Motif:</strong> ${details.titre}</p>
    <p><strong>Date de départ:</strong> ${formatDateShort(details.date_depart)}</p>
  `;
  
  if (details.type_demande === 'conges') {
    const typeCongeLabel = getTypeCongeLabel(details.type_conge, details.type_conge_autre);
    detailsHtml += `
      <p><strong>Date de retour:</strong> ${details.date_retour ? formatDateShort(details.date_retour) : 'Non spécifié'}</p>
      <p><strong>Demi-journée:</strong> ${details.demi_journee ? 'Oui' : 'Non'}</p>
      <p><strong>Type de congé:</strong> ${typeCongeLabel}</p>
    `;
  } else if (details.type_demande === 'autorisation') {
    detailsHtml += `
      <p><strong>Heure de départ:</strong> ${details.heure_depart || 'Non spécifié'}</p>
      <p><strong>Heure d'arrivée:</strong> ${details.heure_retour || 'Non spécifié'}</p>
    `;
  } else if (details.type_demande === 'mission') {
    detailsHtml += `
      <p><strong>Date de retour:</strong> ${details.date_retour ? formatDateShort(details.date_retour) : 'Non spécifié'}</p>
      <p><strong>Heure de sortie:</strong> ${details.heure_depart || 'Non spécifié'}</p>
      <p><strong>Heure de retour:</strong> ${details.heure_retour || 'Non spécifié'}</p>
      <p><strong>Frais de déplacement:</strong> ${details.frais_deplacement || 0} TND</p>
    `;
  }
  
  let infoPremierApprobation = '';
  if (premierResponsable && niveau === 2) {
    infoPremierApprobation = `
      <div style="background-color: #d4edda; color: #155724; padding: 10px; border-radius: 5px; margin-bottom: 15px;">
        ✓ Cette demande a déjà été approuvée par ${premierResponsable}
      </div>
    `;
  }
  
  const mailOptions = {
    from: {
      name: 'Administration STS',
      address: process.env.SMTP_FROM || 'administration.STS@avocarbon.com'
    },
    to: emailResponsable,
    subject: `${niveau === 2 && premierResponsable ? '✓ ' : ''}Nouvelle demande RH - ${employe.nom} ${employe.prenom}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">
          ${niveau === 2 && premierResponsable ? 'Demande approuvée par le premier responsable - ' : ''}
          Demande RH en attente d'approbation
        </h2>
        ${infoPremierApprobation}
        
        <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Employé:</strong> ${employe.nom} ${employe.prenom}</p>
          <p><strong>Poste:</strong> ${employe.poste}</p>
          ${detailsHtml}
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${lienApprobation}" 
             style="background-color: #007bff; color: white; padding: 12px 30px; 
                    text-decoration: none; border-radius: 5px; display: inline-block;">
            ${niveau === 2 && premierResponsable ? 'Donner votre approbation finale' : 'Voir et traiter la demande'}
          </a>
        </div>
        
        <p style="color: #6c757d; font-size: 12px;">
          Ce lien expirera après traitement de la demande.
        </p>
      </div>
    `
  };
  
  try {
    await sendEmailWithRetry(mailOptions, `Notification demande RH niveau ${niveau}`);
    console.log(`✅ Email envoyé à ${emailResponsable} pour demande ${demandeId} (niveau ${niveau})`);
  } catch (error) {
    console.error(`❌ Erreur envoi email à responsable ${niveau}:`, error);
  }
}

app.get('/approuver-demande', async (req, res) => {
  const { id, niveau } = req.query;
  console.log(`🔗 Accès page approbation demande ${id}, niveau ${niveau}`);
  
  try {
    const result = await pool.query(
      `SELECT d.*, e.nom, e.prenom, e.poste, e.adresse_mail, e.mail_responsable1, e.mail_responsable2 
       FROM demande_rh d 
       JOIN employees e ON d.employe_id = e.id 
       WHERE d.id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Demande non trouvée</title>
          <style>body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }</style>
        </head>
        <body>
          <h1>Demande non trouvée</h1>
          <p>La demande que vous cherchez n'existe pas ou a déjà été traitée.</p>
        </body>
        </html>
      `);
    }
    
    const demande = result.rows[0];
    
    if (demande.statut !== 'en_attente') {
      console.log(`ℹ️ Demande ${id} déjà traitée: ${demande.statut}`);
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Demande déjà traitée</title>
          <style>body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }</style>
        </head>
        <body>
          <h1>Demande déjà traitée</h1>
          <p>Cette demande a déjà été ${demande.statut === 'approuve' ? 'approuvée' : 'refusée'}.</p>
        </body>
        </html>
      `);
    }
    
    const typeDemandeLabel = demande.type_demande === 'conges' ? 'Congé' :
                            demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';
    const typeCongeLabel = demande.type_demande === 'conges' ? 
                          getTypeCongeLabel(demande.type_conge, demande.type_conge_autre) : null;
    
    const resp1 = demande.mail_responsable1 ? extraireNomPrenomDepuisEmail(demande.mail_responsable1) : null;
    const resp2 = demande.mail_responsable2 ? extraireNomPrenomDepuisEmail(demande.mail_responsable2) : null;
    
    const jsSafeTitre = demande.titre.replace(/'/g, "\\'");
    const jsSafeTypeCongeLabel = typeCongeLabel ? typeCongeLabel.replace(/'/g, "\\'") : '';
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Approbation Demande RH</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
          }
          .container {
            background: white;
            border-radius: 10px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            max-width: 600px;
            width: 100%;
            padding: 30px;
          }
          h1 {
            color: #2c3e50;
            margin-bottom: 10px;
            font-size: 24px;
          }
          .badge {
            display: inline-block;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .badge-warning { background-color: #fff3cd; color: #856404; }
          .badge-success { background-color: #d4edda; color: #155724; }
          .info-section {
            background-color: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
          }
          .info-row {
            display: flex;
            justify-content: space-between;
            padding: 10px 0;
            border-bottom: 1px solid #dee2e6;
          }
          .info-row:last-child { border-bottom: none; }
          .info-label {
            font-weight: 600;
            color: #495057;
          }
          .info-value {
            color: #212529;
          }
          .button-group {
            display: flex;
            gap: 15px;
            margin-top: 30px;
          }
          .btn {
            flex: 1;
            padding: 12px 20px;
            border: none;
            border-radius: 5px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
          }
          .btn-success {
            background-color: #28a745;
            color: white;
          }
          .btn-success:hover {
            background-color: #218838;
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(40,167,69,0.3);
          }
          .btn-danger {
            background-color: #dc3545;
            color: white;
          }
          .btn-danger:hover {
            background-color: #c82333;
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(220,53,69,0.3);
          }
          .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.5);
            justify-content: center;
            align-items: center;
            z-index: 1000;
          }
          .modal-content {
            background: white;
            padding: 30px;
            border-radius: 10px;
            max-width: 400px;
            width: 90%;
          }
          .modal-content h3 {
            margin-bottom: 15px;
            color: #2c3e50;
          }
          .modal-content textarea {
            width: 100%;
            min-height: 100px;
            padding: 10px;
            border: 1px solid #ced4da;
            border-radius: 5px;
            font-family: inherit;
            font-size: 14px;
            margin-bottom: 15px;
            resize: vertical;
          }
          .modal-buttons {
            display: flex;
            gap: 10px;
          }
          .btn-secondary {
            background-color: #6c757d;
            color: white;
          }
          .btn-secondary:hover {
            background-color: #5a6268;
          }
          .alert {
            padding: 15px;
            border-radius: 5px;
            margin-top: 20px;
            display: none;
          }
          .alert-success { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
          .alert-danger { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
          .spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(255,255,255,.3);
            border-radius: 50%;
            border-top-color: #fff;
            animation: spin 1s ease-in-out infinite;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📋 Demande RH - Approbation</h1>
          <span class="badge badge-warning">En attente de validation</span>
          
          ${niveau == 2 && demande.mail_responsable1 ? `
            <div style="background-color: #d4edda; color: #155724; padding: 10px; border-radius: 5px; margin-bottom: 15px;">
              ✓ Cette demande a été approuvée par ${resp1 ? resp1.fullName : 'le premier responsable'}
            </div>
          ` : ''}
          
          <div class="info-section">
            <div class="info-row">
              <span class="info-label">Employé:</span>
              <span class="info-value">${demande.nom} ${demande.prenom}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Poste:</span>
              <span class="info-value">${demande.poste}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Type de demande:</span>
              <span class="info-value">${typeDemandeLabel}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Motif:</span>
              <span class="info-value">${demande.titre}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Date de départ:</span>
              <span class="info-value">${formatDateShort(demande.date_depart)}</span>
            </div>
            ${demande.date_retour ? `
              <div class="info-row">
                <span class="info-label">Date de retour:</span>
                <span class="info-value">${formatDateShort(demande.date_retour)}</span>
              </div>
            ` : ''}
            ${demande.heure_depart ? `
              <div class="info-row">
                <span class="info-label">Heure de départ:</span>
                <span class="info-value">${demande.heure_depart}</span>
              </div>
            ` : ''}
            ${demande.heure_retour ? `
              <div class="info-row">
                <span class="info-label">Heure de retour:</span>
                <span class="info-value">${demande.heure_retour}</span>
              </div>
            ` : ''}
            ${demande.frais_deplacement ? `
              <div class="info-row">
                <span class="info-label">Frais de déplacement:</span>
                <span class="info-value">${demande.frais_deplacement} TND</span>
              </div>
            ` : ''}
            ${demande.type_demande === 'conges' ? `
              <div class="info-row">
                <span class="info-label">Type de congé:</span>
                <span class="info-value">${typeCongeLabel}</span>
              </div>
            ` : ''}
          </div>
          
          <div class="button-group">
            <button onclick="approuver()" class="btn btn-success">✅ Approuver</button>
            <button onclick="ouvrirModalRefus()" class="btn btn-danger">❌ Refuser</button>
          </div>
          
          <div id="message" class="alert"></div>
        </div>
        
        <div id="modalRefus" class="modal">
          <div class="modal-content">
            <h3>Confirmer le refus</h3>
            <textarea id="commentaireRefus" placeholder="Motif du refus (optionnel)"></textarea>
            <div class="modal-buttons">
              <button onclick="fermerModalRefus()" class="btn btn-secondary">Annuler</button>
              <button onclick="confirmerRefus()" class="btn btn-danger">Confirmer le refus</button>
            </div>
          </div>
        </div>
        
        <script>
          function ouvrirModalRefus() {
            document.getElementById('modalRefus').style.display = 'flex';
          }
          
          function fermerModalRefus() {
            document.getElementById('modalRefus').style.display = 'none';
          }
          
          async function approuver() {
            const btn = event.target;
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Approbation...';
            
            try {
              const response = await fetch('/api/demandes/${id}/approuver', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ niveau: ${niveau} })
              });
              
              const data = await response.json();
              
              if (data.success) {
                showMessage('success', '✅ Demande approuvée avec succès!');
                setTimeout(() => {
                  window.location.reload();
                }, 2000);
              } else {
                showMessage('danger', '❌ ' + (data.error || 'Erreur lors de l\\'approbation'));
                btn.disabled = false;
                btn.innerHTML = '✅ Approuver';
              }
            } catch (error) {
              showMessage('danger', '❌ Erreur de connexion au serveur');
              btn.disabled = false;
              btn.innerHTML = '✅ Approuver';
            }
          }
          
          async function confirmerRefus() {
            const commentaire = document.getElementById('commentaireRefus').value.trim();
            
            if (!commentaire) {
              alert('Veuillez indiquer un motif de refus');
              return;
            }
            
            fermerModalRefus();
            
            try {
              const response = await fetch('/api/demandes/${id}/refuser', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ niveau: ${niveau}, commentaire: commentaire })
              });
              
              const data = await response.json();
              
              if (data.success) {
                showMessage('success', '✅ Demande refusée avec succès');
                setTimeout(() => {
                  window.location.reload();
                }, 2000);
              } else {
                showMessage('danger', '❌ ' + (data.error || 'Erreur lors du refus'));
              }
            } catch (error) {
              showMessage('danger', '❌ Erreur de connexion au serveur');
            }
          }
          
          function showMessage(type, message) {
            const messageDiv = document.getElementById('message');
            messageDiv.className = 'alert alert-' + type;
            messageDiv.textContent = message;
            messageDiv.style.display = 'block';
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Erreur page approbation:', err);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Erreur</title>
        <style>body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }</style>
      </head>
      <body>
        <h1>Erreur serveur</h1>
        <p>Une erreur est survenue lors du traitement de votre demande.</p>
      </body>
      </html>
    `);
  }
});

app.post('/api/demandes/:id/approuver', async (req, res) => {
  const { id } = req.params;
  const { niveau } = req.body;
  console.log(`✅ Approbation demande ${id}, niveau ${niveau}`);
  
  try {
    const demandeResult = await pool.query(
      `SELECT d.*, e.nom, e.prenom, e.adresse_mail, e.mail_responsable1, e.mail_responsable2, 
               e.poste, e.matricule 
       FROM demande_rh d 
       JOIN employees e ON d.employe_id = e.id 
       WHERE d.id = $1`,
      [id]
    );
    
    if (demandeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Demande non trouvée' });
    }
    
    const demande = demandeResult.rows[0];
    
    if (demande.statut !== 'en_attente') {
      console.log(`ℹ️ Demande ${id} déjà traitée: ${demande.statut}`);
      return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
    }
    
    const colonne = niveau == 1 ? 'approuve_responsable1' : 'approuve_responsable2';
    
    await pool.query(
      `UPDATE demande_rh SET ${colonne} = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );
    
    const resp1 = demande.mail_responsable1 ? extraireNomPrenomDepuisEmail(demande.mail_responsable1) : null;
    const resp2 = demande.mail_responsable2 ? extraireNomPrenomDepuisEmail(demande.mail_responsable2) : null;
    
    if (niveau == 1 && demande.mail_responsable2) {
      await sendEmailWithRetry({
        from: {
          name: 'Administration STS',
          address: process.env.SMTP_FROM || 'administration.STS@avocarbon.com'
        },
        to: demande.adresse_mail,
        subject: 'Votre demande RH a été approuvée par votre responsable (Niveau 1)',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #28a745;">✅ Étape 1 : Demande approuvée</h2>
            <p>Bonjour ${demande.nom} ${demande.prenom},</p>
            <p>Votre demande de ${demande.type_demande} a été approuvée par ${resp1 ? resp1.fullName : 'votre responsable hiérarchique'}.</p>
            <p>Elle est maintenant en attente d'approbation par ${resp2 ? resp2.fullName : 'le deuxième responsable'}.</p>
            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p><strong>Date de départ :</strong> ${formatDateShort(demande.date_depart)}</p>
              <p><strong>Motif :</strong> ${demande.titre}</p>
            </div>
            <p>Vous recevrez un nouvel email lorsque la demande sera définitivement approuvée.</p>
          </div>
        `
      }, 'Approbation niveau 1');
      
      await envoyerEmailResponsable(
        demande,
        demande.mail_responsable2,
        id,
        2,
        {
          type_demande: demande.type_demande,
          titre: demande.titre,
          date_depart: demande.date_depart,
          date_retour: demande.date_retour,
          heure_depart: demande.heure_depart,
          heure_retour: demande.heure_retour,
          demi_journee: demande.demi_journee,
          type_conge: demande.type_conge,
          type_conge_autre: demande.type_conge_autre,
          frais_deplacement: demande.frais_deplacement
        },
        resp1 ? resp1.fullName : 'le premier responsable'
      );
      
      return res.json({
        success: true,
        message: 'Demande approuvée par le premier responsable, en attente du second'
      });
    }
    
    await pool.query(`UPDATE demande_rh SET statut = 'approuve' WHERE id = $1`, [id]);
    
    let approuveur = null;
    if (niveau == 1 && !demande.mail_responsable2) {
      approuveur = resp1;
    } else if (niveau == 2) {
      approuveur = resp2;
    }
    
    const typeCongeLabel = demande.type_demande === 'conges' ? 
                          getTypeCongeLabel(demande.type_conge, demande.type_conge_autre) : null;
    
    await sendEmailWithRetry({
      from: {
        name: 'Administration STS',
        address: process.env.SMTP_FROM || 'administration.STS@avocarbon.com'
      },
      to: demande.adresse_mail,
      subject: '✅ Votre demande RH a été approuvée',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #28a745;">✅ Demande RH approuvée</h2>
          <p>Bonjour ${demande.nom} ${demande.prenom},</p>
          <p>Nous avons le plaisir de vous informer que votre demande a été approuvée.</p>
          
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #2c3e50; margin-top: 0;">📋 Détails de la demande</h3>
            <p><strong>Type de demande:</strong> ${demande.type_demande === 'conges' ? 'Congé' : demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission'}</p>
            <p><strong>Motif:</strong> ${demande.titre}</p>
            <p><strong>Date de départ:</strong> ${formatDateShort(demande.date_depart)}</p>
            ${demande.date_retour ? `<p><strong>Date de retour:</strong> ${formatDateShort(demande.date_retour)}</p>` : ''}
            ${typeCongeLabel ? `<p><strong>Type de congé:</strong> ${typeCongeLabel}</p>` : ''}
            ${demande.heure_depart ? `<p><strong>Heure de départ:</strong> ${demande.heure_depart}</p>` : ''}
            ${demande.heure_retour ? `<p><strong>Heure de retour:</strong> ${demande.heure_retour}</p>` : ''}
            ${demande.frais_deplacement ? `<p><strong>Frais de déplacement:</strong> ${demande.frais_deplacement} TND</p>` : ''}
            ${approuveur ? `<p><strong>Approuvé par:</strong> ${approuveur.fullName}</p>` : ''}
          </div>
          
          <p style="color: #6c757d; font-size: 14px;">Si vous avez des questions, n'hésitez pas à contacter le service RH.</p>
        </div>
      `
    }, 'Approbation finale - Email employé');
    
    let joursOuvres = 0;
    let infoJoursCongee = '';
    if (demande.type_demande === 'conges' && demande.date_retour) {
      joursOuvres = calculerJoursOuvres(demande.date_depart, demande.date_retour);
      infoJoursCongee = `
        <div class="info-row">
          <span class="info-label">Nombre de jours ouvrés:</span>
          <span class="info-value">${joursOuvres} jour${joursOuvres > 1 ? 's' : ''}</span>
        </div>
      `;
    }
    
    await sendEmailWithRetry({
      from: {
        name: 'Administration STS',
        address: process.env.SMTP_FROM || 'administration.STS@avocarbon.com'
      },
      to: 'fethi.chaouachi@avocarbon.com',
      subject: `📋 Demande RH approuvée - ${demande.nom} ${demande.prenom}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; background-color: #f8f9fa; padding: 30px; border-radius: 10px;">
          <h2 style="color: #2c3e50; border-bottom: 3px solid #007bff; padding-bottom: 10px;">📋 Nouvelle demande RH approuvée</h2>
          
          <div style="background-color: #d1ecf1; color: #0c5460; padding: 15px; border-radius: 5px; margin: 20px 0;">
            ℹ️ Une demande RH vient d'être approuvée et nécessite votre attention pour le suivi administratif.
          </div>
          
          <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #495057; margin-top: 0;">👤 Informations Employé</h3>
            <p><strong>Nom complet:</strong> ${demande.nom} ${demande.prenom}</p>
            <p><strong>Matricule:</strong> ${demande.matricule || 'Non spécifié'}</p>
            <p><strong>Poste:</strong> ${demande.poste || 'Non spécifié'}</p>
            <p><strong>Email:</strong> ${demande.adresse_mail}</p>
          </div>
          
          <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #495057; margin-top: 0;">📋 Détails de la Demande</h3>
            <p><strong>Type de demande:</strong> ${demande.type_demande === 'conges' ? 'Congé' : demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission'}</p>
            <p><strong>Motif:</strong> ${demande.titre}</p>
            <p><strong>Date de départ:</strong> ${formatDateShort(demande.date_depart)}</p>
            ${demande.date_retour ? `<p><strong>Date de retour:</strong> ${formatDateShort(demande.date_retour)}</p>` : ''}
            ${joursOuvres > 0 ? `<p><strong>Nombre de jours ouvrés:</strong> ${joursOuvres} jour${joursOuvres > 1 ? 's' : ''}</p>` : ''}
            ${typeCongeLabel ? `<p><strong>Type de congé:</strong> ${typeCongeLabel}</p>` : ''}
            ${demande.demi_journee ? `<p><strong>Demi-journée:</strong> Oui</p>` : ''}
            ${demande.heure_depart ? `<p><strong>Heure de départ:</strong> ${demande.heure_depart}</p>` : ''}
            ${demande.heure_retour ? `<p><strong>Heure de retour:</strong> ${demande.heure_retour}</p>` : ''}
            ${demande.frais_deplacement ? `<p><strong>Frais de déplacement:</strong> ${demande.frais_deplacement} TND</p>` : ''}
          </div>
          
          <p style="color: #6c757d; font-size: 12px; text-align: center; margin-top: 30px;">
            Cet email est envoyé automatiquement par le système de gestion RH
          </p>
        </div>
      `
    }, 'Notification RH - Demande approuvée');
    
    console.log(`✅ Demande ${id} complètement approuvée - Emails envoyés`);
    
    res.json({
      success: true,
      message: 'Demande complètement approuvée et notifications envoyées'
    });
  } catch (err) {
    console.error('❌ Erreur approbation demande:', err);
    res.status(500).json({ error: 'Erreur lors de l\'approbation' });
  }
});

app.post('/api/demandes/:id/refuser', async (req, res) => {
  const { id } = req.params;
  const { niveau, commentaire } = req.body;
  console.log(`❌ Refus demande ${id}, niveau ${niveau}`);
  
  try {
    const demandeResult = await pool.query(
      `SELECT d.*, e.nom, e.prenom, e.adresse_mail, e.mail_responsable1, e.mail_responsable2 
       FROM demande_rh d 
       JOIN employees e ON d.employe_id = e.id 
       WHERE d.id = $1`,
      [id]
    );
    
    if (demandeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Demande non trouvée' });
    }
    
    const demande = demandeResult.rows[0];
    
    if (demande.statut !== 'en_attente') {
      console.log(`ℹ️ Demande ${id} déjà traitée: ${demande.statut}`);
      return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
    }
    
    const colonneRefus = niveau == 1 ? 'approuve_responsable1' : 'approuve_responsable2';
    
    await pool.query(
      `UPDATE demande_rh 
       SET statut = 'refuse', commentaire_refus = $1, ${colonneRefus} = false, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [commentaire, id]
    );
    
    const resp1 = demande.mail_responsable1 ? extraireNomPrenomDepuisEmail(demande.mail_responsable1) : null;
    const resp2 = demande.mail_responsable2 ? extraireNomPrenomDepuisEmail(demande.mail_responsable2) : null;
    
    let refuserParTexte = 'votre responsable hiérarchique';
    if (niveau == 1 && resp1) {
      refuserParTexte = resp1.fullName;
    } else if (niveau == 2 && resp2) {
      refuserParTexte = resp2.fullName;
    }
    
    const typeCongeLabel = demande.type_demande === 'conges' ? 
                          getTypeCongeLabel(demande.type_conge, demande.type_conge_autre) : null;
    
    await sendEmailWithRetry({
      from: {
        name: 'Administration STS',
        address: process.env.SMTP_FROM || 'administration.STS@avocarbon.com'
      },
      to: demande.adresse_mail,
      subject: 'Votre demande RH a été refusée',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #dc3545;">❌ Votre demande RH a été refusée</h2>
          <p>Bonjour ${demande.nom} ${demande.prenom},</p>
          <p>Votre demande de ${demande.type_demande} pour le ${formatDateShort(demande.date_depart)} a été refusée.</p>
          ${typeCongeLabel ? `<p><strong>Type de congé:</strong> ${typeCongeLabel}</p>` : ''}
          <p>La décision a été prise par ${refuserParTexte}.</p>
          <div style="background-color: #f8d7da; color: #721c24; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <strong>Motif du refus:</strong> ${commentaire}
          </div>
        </div>
      `
    }, 'Refus demande');
    
    console.log(`✅ Demande ${id} refusée`);
    res.json({ success: true, message: 'Demande refusée avec succès' });
  } catch (err) {
    console.error('❌ Erreur refus demande:', err);
    res.status(500).json({ error: 'Erreur lors du refus' });
  }
});

app.get('/api/demandes/employe/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM demande_rh WHERE employe_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    console.log(`✅ Récupération ${result.rows.length} demandes pour employé ${req.params.id}`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erreur récupération demandes:', err);
    res.status(500).json({ error: 'Erreur lors de la récupération des demandes' });
  }
});

// ==================== ROUTES DE DIAGNOSTIC ====================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Serveur RH fonctionnel',
    timestamp: new Date().toISOString(),
    smtpPoolSize: emailPool.transporters.length,
    activeTransporterIndex: emailPool.currentIndex
  });
});

app.get('/api/test-email', async (req, res) => {
  try {
    const testMailOptions = {
      from: {
        name: 'Administration STS',
        address: process.env.SMTP_FROM || 'administration.STS@avocarbon.com'
      },
      to: 'majed.messai@avocarbon.com',
      subject: 'Test SMTP Configuration - ' + new Date().toISOString(),
      text: 'Ceci est un email de test pour vérifier la configuration SMTP.',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Test SMTP Configuration</h2>
          <p>Ceci est un email de test envoyé depuis le serveur RH.</p>
          <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          <p><strong>Server:</strong> ${process.env.NODE_ENV || 'development'}</p>
        </div>
      `
    };
    
    const result = await sendEmailWithRetry(testMailOptions, 'Test SMTP');
    
    res.json({
      success: true,
      message: 'Email de test envoyé avec succès',
      result: result
    });
  } catch (error) {
    console.error('❌ Erreur test email:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.originalError ? error.originalError.message : ''
    });
  }
});

app.get('/api/smtp-status', async (req, res) => {
  const statuses = [];
  for (let i = 0; i < emailPool.transporters.length; i++) {
    const transporter = emailPool.transporters[i];
    try {
      await transporter.verify();
      statuses.push({
        index: i,
        status: 'OK',
        isCurrent: i === emailPool.currentIndex
      });
    } catch (error) {
      statuses.push({
        index: i,
        status: 'ERROR',
        error: error.message,
        isCurrent: i === emailPool.currentIndex
      });
    }
  }
  res.json({
    poolSize: emailPool.transporters.length,
    currentIndex: emailPool.currentIndex,
    maxRetries: emailPool.maxRetries,
    transporters: statuses
  });
});

// ==================== DÉMARRAGE DU SERVEUR ====================
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`
  🚀 Serveur démarré sur le port ${PORT}
  📧 Emails d'approbation: http://localhost:${PORT}/approuver-demande
  👥 API Employés: http://localhost:${PORT}/api/employees/actifs
  📋 API Demandes: http://localhost:${PORT}/api/demandes
  📄 API Attestations: http://localhost:${PORT}/api/generer-attestation
  🩺 Santé: http://localhost:${PORT}/health
  🔧 Test SMTP: http://localhost:${PORT}/api/test-email
  📊 Status SMTP: http://localhost:${PORT}/api/smtp-status
  `);
  
  await verifySMTPConnection();
  
  try {
    await fs.access(TEMPLATE_TRAVAIL_PATH);
    console.log('✅ Template attestation travail trouvé');
  } catch {
    console.warn('⚠️ Template attestation travail non trouvé');
  }
  
  try {
    await fs.access(TEMPLATE_SALAIRE_PATH);
    console.log('✅ Template attestation salaire trouvé');
  } catch {
    console.warn('⚠️ Template attestation salaire non trouvé');
  }
});
