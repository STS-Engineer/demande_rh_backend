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

// ==================== CONFIGURATION SMTP AMÉLIORÉE ====================

// Fonction pour créer un transporteur SMTP
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'avocarbon-com.mail.protection.outlook.com',
    port: parseInt(process.env.SMTP_PORT) || 25,
    secure: process.env.SMTP_SECURE === 'true' || false,
    auth: {
      user: process.env.SMTP_USER || 'administration.STS@avocarbon.com',
      pass: process.env.SMTP_PASS || 'shnlgdyfbcztbhxn'
    },
    tls: {
      ciphers: 'SSLv3',
      rejectUnauthorized: false
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000
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
  console.log(`   Destinataire: ${mailOptions.to}`);
  console.log(`   Sujet: ${mailOptions.subject}`);
  console.log(`   Pièces jointes: ${mailOptions.attachments ? mailOptions.attachments.length : 0}`);
  console.log(`   Taille pièces jointes: ${mailOptions.attachments ? 
    mailOptions.attachments.reduce((sum, att) => sum + (att.content?.length || 0), 0) : 0} octets`);
}

// Fonction améliorée pour envoyer des emails avec retry et fallback
async function sendEmailWithRetry(mailOptions, context, maxRetries = 3) {
  let lastError;
  let lastTransporterIndex = emailPool.currentIndex;
  
  logEmailDetails(mailOptions, context, 1);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const transporter = emailPool.getTransporter();
    
    try {
      // Limiter la taille des pièces jointes pour éviter les timeouts
      if (mailOptions.attachments && mailOptions.attachments.length > 0) {
        const totalSize = mailOptions.attachments.reduce((sum, att) => {
          return sum + (att.content?.length || 0);
        }, 0);
        
        if (totalSize > 10 * 1024 * 1024) { // 10MB max
          console.warn(`⚠️ Taille totale des pièces jointes élevée: ${Math.round(totalSize / 1024 / 1024)}MB`);
        }
      }
      
      const info = await transporter.sendMail(mailOptions);
      
      console.log(`✅ Email envoyé avec succès (tentative ${attempt}/${maxRetries})`);
      console.log(`   Message ID: ${info.messageId}`);
      
      return {
        success: true,
        messageId: info.messageId,
        attempt: attempt
      };
      
    } catch (error) {
      lastError = error;
      lastTransporterIndex = emailPool.currentIndex;
      
      console.error(`❌ Échec envoi email ${context} (tentative ${attempt}/${maxRetries}):`, error.message);
      
      if (attempt < maxRetries) {
        // Backoff exponentiel avec jitter
        const baseDelay = 1000;
        const maxDelay = 10000;
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        const jitter = Math.random() * 1000;
        const totalDelay = delay + jitter;
        
        console.log(`⏳ Nouvelle tentative dans ${Math.round(totalDelay)}ms...`);
        
        // Changer de transporteur pour la prochaine tentative
        emailPool.rotateTransporter();
        
        await new Promise(resolve => setTimeout(resolve, totalDelay));
        
        // Log de la nouvelle tentative
        logEmailDetails(mailOptions, context, attempt + 1);
      }
    }
  }
  
  // Toutes les tentatives ont échoué
  console.error(`💥 Échec final d'envoi email ${context} après ${maxRetries} tentatives:`, lastError.message);
  
  // Essayer de recréer un transporteur comme dernier recours
  try {
    console.log('🔄 Tentative avec nouveau transporteur...');
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

// URL de base (backend déployé)
const BASE_URL = process.env.BASE_URL || 'https://hr-back.azurewebsites.net';

// Chemin vers les templates Word
const TEMPLATE_TRAVAIL_PATH = path.join(__dirname, 'templates', 'Attestation de travail Modèle IA.docx');
const TEMPLATE_SALAIRE_PATH = path.join(__dirname, 'templates', 'Attestation de salaire Modèle IA.docx');

// Helper : extraire nom/prénom depuis l'adresse email
function extraireNomPrenomDepuisEmail(email) {
  if (!email) return { prenom: '', nom: '', fullName: '' };

  const localPart = email.split('@')[0];
  const rawParts = localPart.split(/[._-]+/).filter(Boolean);

  const capitalize = (str) =>
    str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : '';

  if (rawParts.length >= 2) {
    const prenom = capitalize(rawParts[0]);
    const nom = capitalize(rawParts[1]);
    return { prenom, nom, fullName: `${prenom} ${nom}` };
  } else {
    const prenom = capitalize(rawParts[0]);
    return { prenom, nom: '', fullName: prenom };
  }
}

// Helper : générer une référence unique
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

// Helper : formatage date française (JJ/MM/AAAA)
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

// Helper : formatage simple de date (sans heure)
function formatDateShort(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('fr-FR');
}

// Helper : label type de congé
function getTypeCongeLabel(type_conge, type_conge_autre) {
  if (!type_conge) return 'Non spécifié';
  if (type_conge === 'annuel') return 'Congé annuel';
  if (type_conge === 'sans_solde') return 'Congé sans solde';
  if (type_conge === 'autre') {
    return `Autre${type_conge_autre ? ` (${type_conge_autre})` : ''}`;
  }
  return type_conge;
}

// Fonction pour compresser les pièces jointes si nécessaire
async function optimizeAttachments(attachments) {
  if (!attachments || attachments.length === 0) return attachments;
  
  return attachments.map(attachment => {
    // Si le contenu est un buffer et trop grand, on pourrait le compresser ici
    // Pour l'instant, on se contente de vérifier la taille
    if (attachment.content && attachment.content.length > 5 * 1024 * 1024) {
      console.warn(`⚠️ Pièce jointe volumineuse: ${attachment.filename} (${Math.round(attachment.content.length / 1024 / 1024)}MB)`);
    }
    return attachment;
  });
}

// ==================== FONCTIONS DE GÉNÉRATION DE DOCUMENTS ====================

// Fonction pour générer une attestation de travail Word
async function genererAttestationTravailWord(employe) {
  try {
    // Vérifier si le template existe
    try {
      await fs.access(TEMPLATE_TRAVAIL_PATH);
    } catch (error) {
      console.error(`Template non trouvé: ${TEMPLATE_TRAVAIL_PATH}`);
      throw new Error('Template Word non trouvé. Placez-le dans le dossier templates/');
    }
    
    // Lire le template Word
    const templateBuffer = await fs.readFile(TEMPLATE_TRAVAIL_PATH);
    
    // Générer la référence
    const reference = genererReference(employe.nom, employe.prenom);
    
    // Données à injecter dans le template
    const data = {
      reference: reference,
      nom_complet: `${employe.nom} ${employe.prenom}`,
      date_naissance: formatDateFR(employe.date_naissance || ''),
      cin: employe.cin || '',
      date_debut: formatDateFR(employe.date_debut),
      poste: employe.poste || '',
      date_actuelle: formatDateFR(new Date())
    };
    
    // Générer le document Word
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
    console.error('Erreur lors de la génération Word attestation travail:', error);
    throw error;
  }
}

// Fonction pour générer une attestation de salaire Word
async function genererAttestationSalaireWord(employe) {
  try {
    // Vérifier si le template existe
    try {
      await fs.access(TEMPLATE_SALAIRE_PATH);
    } catch (error) {
      console.error(`Template non trouvé: ${TEMPLATE_SALAIRE_PATH}`);
      throw new Error('Template Word non trouvé. Placez-le dans le dossier templates/');
    }
    
    // Lire le template Word
    const templateBuffer = await fs.readFile(TEMPLATE_SALAIRE_PATH);
    
    // Formater le salaire
    const formaterSalaire = (salaire) => {
      if (!salaire) return '0,00';
      return parseFloat(salaire).toLocaleString('fr-TN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).replace(/,/g, ' ');
    };
    
    // Générer la référence
    const reference = genererReference(employe.nom, employe.prenom);
    
    // Données à injecter dans le template
    const data = {
      reference: reference,
      nom_complet: `${employe.nom} ${employe.prenom}`,
      cin: employe.cin || '',
      date_debut: formatDateFR(employe.date_debut),
      poste: employe.poste || '',
      salaire: formaterSalaire(employe.salaire_brute),
      date_actuelle: formatDateFR(new Date())
    };
    
    // Générer le document Word
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
    console.error('Erreur lors de la génération Word attestation salaire:', error);
    throw error;
  }
}
function calculerJoursOuvres(dateDebut, dateFin) {
  if (!dateDebut || !dateFin) return 0;
  
  const debut = new Date(dateDebut);
  const fin = new Date(dateFin);
  
  // Normaliser les heures pour éviter les problèmes de fuseau horaire
  debut.setHours(0, 0, 0, 0);
  fin.setHours(0, 0, 0, 0);
  
  // Si la date de fin est avant la date de début
  if (fin < debut) return 0;
  
  let joursOuvres = 0;
  const dateActuelle = new Date(debut);
  
  // Parcourir toutes les dates entre début et fin (inclus)
  while (dateActuelle <= fin) {
    const jourSemaine = dateActuelle.getDay();
    // 0 = Dimanche, 6 = Samedi
    // On compte seulement du lundi (1) au vendredi (5)
    if (jourSemaine >= 1 && jourSemaine <= 5) {
      joursOuvres++;
    }
    // Passer au jour suivant
    dateActuelle.setDate(dateActuelle.getDate() + 1);
  }
  
  return joursOuvres;
}
// ==================== ROUTES API ====================

// Récupérer tous les employés actifs (sans date de départ)
app.get('/api/employees/actifs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, matricule, nom, prenom, poste, adresse_mail, 
              mail_responsable1, mail_responsable2, date_debut,
              date_naissance, cin, salaire_brute
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

// Route pour générer une attestation Word et l'envoyer par email
app.post('/api/generer-attestation', async (req, res) => {
  const { employe_id, type_document } = req.body;

  try {
    // Validation
    if (!employe_id || !type_document) {
      return res.status(400).json({ 
        error: 'Les champs employé et type de document sont obligatoires' 
      });
    }

    console.log(`📄 Génération attestation pour employé ${employe_id}, type: ${type_document}`);

    // Récupérer les informations de l'employé
    const employeResult = await pool.query(
      `SELECT nom, prenom, poste, adresse_mail, date_debut, 
              date_naissance, cin, matricule, salaire_brute
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

    // Générer le document Word selon le type
    if (type_document === 'attestation_salaire') {
      wordBuffer = await genererAttestationSalaireWord(employe);
      fileName = `Attestation_Salaire_${employe.nom}_${employe.prenom}.docx`;
      documentTypeLabel = 'Attestation de salaire';
      
      // Vérifier si le salaire existe
      if (!employe.salaire_brute) {
        return res.status(400).json({ 
          error: 'Salaire non disponible pour cet employé' 
        });
      }
    } else {
      // Par défaut, attestation de travail
      wordBuffer = await genererAttestationTravailWord(employe);
      fileName = `Attestation_Travail_${employe.nom}_${employe.prenom}.docx`;
      documentTypeLabel = 'Attestation de travail';
    }

    // Optimiser les pièces jointes
    const optimizedAttachments = await optimizeAttachments([
      {
        filename: fileName,
        content: wordBuffer,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }
    ]);

    // Préparer l'email
    const mailOptions = {
      from: {
        name: 'Administration STS',
        address: 'administration.STS@avocarbon.com'
      },
      to: 'majed.messai@avocarbon.com',
      subject: `Demande de ${documentTypeLabel.toLowerCase()} - ${employe.nom} ${employe.prenom}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">
            Demande de ${documentTypeLabel.toLowerCase()}
          </h2>
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Employé:</strong> ${employe.nom} ${employe.prenom}</p>
            <p><strong>Matricule:</strong> ${employe.matricule || 'Non spécifié'}</p>
            <p><strong>Poste:</strong> ${employe.poste || 'Non spécifié'}</p>
            <p><strong>Date d'embauche:</strong> ${formatDateFR(employe.date_debut)}</p>
            <p><strong>Type de document:</strong> ${documentTypeLabel}</p>
            ${type_document === 'attestation_salaire' ? `<p><strong>Salaire brut annuel:</strong> ${employe.salaire_brute} TND</p>` : ''}
            <p><strong>Date de la demande:</strong> ${formatDateFR(new Date())}</p>
          </div>
          <p style="color: #6b7280; font-size: 14px;">
            ${documentTypeLabel} est jointe à cet email en format Word (.docx).
          </p>
        </div>
      `,
      attachments: optimizedAttachments
    };

    // Envoyer l'email avec retry
    const emailResult = await sendEmailWithRetry(mailOptions, `Génération ${documentTypeLabel}`);

    res.json({ 
      success: true, 
      message: `${documentTypeLabel} générée et envoyée par email avec succès`,
      fileName: fileName,
      emailResult: emailResult
    });

  } catch (err) {
    console.error('❌ Erreur lors de la génération d\'attestation:', err);
    res.status(500).json({ 
      error: 'Erreur lors de la génération du document: ' + err.message,
      details: err.details || ''
    });
  }
});

// Route pour télécharger l'attestation directement
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

    // Générer le document selon le type
    if (type_document === 'attestation_salaire') {
      wordBuffer = await genererAttestationSalaireWord(employe);
      fileName = `Attestation_Salaire_${employe.nom}_${employe.prenom}.docx`;
    } else {
      wordBuffer = await genererAttestationTravailWord(employe);
      fileName = `Attestation_Travail_${employe.nom}_${employe.prenom}.docx`;
    }
    
    // Envoyer le fichier Word en téléchargement
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

// Créer une nouvelle demande RH (congé/autorisation/mission)
app.post('/api/demandes', async (req, res) => {
  const {
    employe_id,
    type_demande,
    titre,
    date_depart,
    date_retour,
    heure_depart,
    heure_retour,
    demi_journee,
    type_conge,
    frais_deplacement,
    type_conge_autre
  } = req.body;

  try {
    // Validation des champs obligatoires
    if (!employe_id || !type_demande || !titre || !date_depart) {
      return res.status(400).json({ 
        error: 'Les champs employé, type de demande, titre et date de départ sont obligatoires' 
      });
    }

    console.log(`📋 Création demande ${type_demande} pour employé ${employe_id}: ${titre}`);

    // Récupérer les informations de l'employé
    const employeResult = await pool.query(
      `SELECT nom, prenom, poste, adresse_mail, mail_responsable1, mail_responsable2
       FROM employees WHERE id = $1`,
      [employe_id]
    );

    if (employeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Employé non trouvé' });
    }

    const employe = employeResult.rows[0];

    // Convertir les chaînes vides en null pour les champs optionnels
    const dateRetourFinal = date_retour && date_retour !== '' ? date_retour : null;
    const heureDepartFinal = heure_depart && heure_depart !== '' ? heure_depart : null;
    const heureRetourFinal = heure_retour && heure_retour !== '' ? heure_retour : null;
    const fraisDeplacementFinal = frais_deplacement && frais_deplacement !== '' ? parseFloat(frais_deplacement) : null;
    const typeCongeFinal = type_conge && type_conge !== '' ? type_conge : null;
    const typeCongeAutreFinal = type_conge_autre && type_conge_autre.trim() !== '' ? type_conge_autre.trim() : null;

    // Insérer la demande
    const insertResult = await pool.query(
      `INSERT INTO demande_rh 
       (employe_id, type_demande, titre, date_depart, date_retour, 
        heure_depart, heure_retour, demi_journee, type_conge, type_conge_autre, frais_deplacement, statut)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        employe_id, 
        type_demande, 
        titre, 
        date_depart, 
        dateRetourFinal,
        heureDepartFinal, 
        heureRetourFinal, 
        demi_journee || false, 
        typeCongeFinal,
        typeCongeAutreFinal,
        fraisDeplacementFinal,
        'en_attente'
      ]
    );

    const demandeId = insertResult.rows[0].id;
    console.log(`✅ Demande créée avec ID: ${demandeId}`);

    // Envoyer email au responsable 1
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

// Fonction pour envoyer email au responsable (MODIFIÉE)
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

  // Si c'est pour le deuxième responsable après approbation du premier
  let infoPremierApprobation = '';
  if (premierResponsable && niveau === 2) {
    infoPremierApprobation = `
      <div style="background: #d1fae5; padding: 15px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #10b981;">
        <p style="margin: 0; color: #065f46;">
          <strong>✓ Cette demande a déjà été approuvée par ${premierResponsable}</strong>
        </p>
      </div>
    `;
  }

  const mailOptions = {
    from: {
      name: 'Administration STS',
      address: 'administration.STS@avocarbon.com'
    },
    to: emailResponsable,
    subject: `${niveau === 2 && premierResponsable ? '✓ ' : ''}Nouvelle demande RH - ${employe.nom} ${employe.prenom}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">
          ${niveau === 2 && premierResponsable ? 'Demande approuvée par le premier responsable - ' : ''}Demande RH en attente d'approbation
        </h2>
        ${infoPremierApprobation}
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Employé:</strong> ${employe.nom} ${employe.prenom}</p>
          <p><strong>Poste:</strong> ${employe.poste}</p>
        </div>
        <div style="margin: 20px 0;">
          ${detailsHtml}
        </div>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${lienApprobation}" 
             style="display: inline-block; padding: 12px 30px; background-color: #2563eb; color: white; 
                    text-decoration: none; border-radius: 6px; font-weight: bold;">
            ${niveau === 2 && premierResponsable ? 'Donner votre approbation finale' : 'Voir et traiter la demande'}
          </a>
        </div>
        <p style="color: #6b7280; font-size: 14px; text-align: center;">
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
    // Ne pas propager l'erreur pour ne pas bloquer la création de la demande
  }
}

// Page d'approbation/refus de demande
app.get('/approuver-demande', async (req, res) => {
  const { id, niveau } = req.query;
  
  console.log(`🔗 Accès page approbation demande ${id}, niveau ${niveau}`);
  
  try {
    const result = await pool.query(
      `SELECT d.*, e.nom, e.prenom, e.poste, e.adresse_mail, 
              e.mail_responsable1, e.mail_responsable2
       FROM demande_rh d
       JOIN employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send(`
        <html>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: #ef4444;">Demande non trouvée</h1>
            <p>La demande que vous cherchez n'existe pas ou a déjà été traitée.</p>
          </body>
        </html>
      `);
    }

    const demande = result.rows[0];
    
    // Vérifier si la demande est déjà traitée
    if (demande.statut !== 'en_attente') {
      console.log(`ℹ️ Demande ${id} déjà traitée: ${demande.statut}`);
      return res.send(`
        <html>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: #6b7280;">Demande déjà traitée</h1>
            <p>Cette demande a déjà été ${demande.statut === 'approuve' ? 'approuvée' : 'refusée'}.</p>
          </body>
        </html>
      `);
    }

    const typeDemandeLabel = demande.type_demande === 'conges'
      ? 'Congé'
      : demande.type_demande === 'autorisation'
        ? 'Autorisation'
        : 'Mission';

    const typeCongeLabel = demande.type_demande === 'conges'
      ? getTypeCongeLabel(demande.type_conge, demande.type_conge_autre)
      : null;

    // Noms des responsables
    const resp1 = demande.mail_responsable1 ? extraireNomPrenomDepuisEmail(demande.mail_responsable1) : null;
    const resp2 = demande.mail_responsable2 ? extraireNomPrenomDepuisEmail(demande.mail_responsable2) : null;
    
    // Échapper les apostrophes dans les chaînes JavaScript
    const jsSafeTitre = demande.titre.replace(/'/g, "\\'");
    const jsSafeTypeCongeLabel = typeCongeLabel ? typeCongeLabel.replace(/'/g, "\\'") : '';
    
    res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Approbation Demande RH</title>
        <style>
          body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            max-width: 800px; 
            margin: 50px auto; 
            padding: 20px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
          }
          .card { 
            background: white; 
            border-radius: 16px; 
            padding: 30px; 
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
          }
          .header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #e5e7eb;
          }
          .header h1 {
            color: #1f2937;
            margin: 0;
            font-size: 2rem;
          }
          .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 30px;
            background: #f8fafc;
            padding: 20px;
            border-radius: 12px;
          }
          .info-item {
            margin: 8px 0;
          }
          .info-label {
            font-weight: 600;
            color: #374151;
          }
          .info-value {
            color: #6b7280;
          }
          .buttons { 
            text-align: center;
            margin-top: 40px; 
          }
          button { 
            padding: 14px 40px; 
            margin: 10px; 
            border: none; 
            border-radius: 8px; 
            cursor: pointer; 
            font-size: 16px; 
            font-weight: 600;
            transition: all 0.3s ease;
          }
          .approve { 
            background-color: #10b981; 
            color: white; 
          }
          .approve:hover {
            background-color: #059669;
            transform: translateY(-2px);
          }
          .reject { 
            background-color: #ef4444; 
            color: white; 
          }
          .reject:hover {
            background-color: #dc2626;
            transform: translateY(-2px);
          }
          textarea { 
            width: 100%; 
            padding: 12px; 
            margin-top: 10px; 
            display: none; 
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            font-family: inherit;
          }
          .refus-section {
            margin-top: 20px;
          }
          .status-badge {
            display: inline-block;
            padding: 4px 12px;
            background: #fef3c7;
            color: #92400e;
            border-radius: 20px;
            font-size: 14px;
            font-weight: 500;
          }
          .approval-notice {
            background: #d1fae5;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            border-left: 4px solid #10b981;
          }
          .approval-notice p {
            margin: 0;
            color: #065f46;
            font-weight: 600;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <h1>📋 Demande RH - Approbation</h1>
            <div class="status-badge">En attente de validation</div>
          </div>
          
          ${niveau == 2 && demande.mail_responsable1 ? `
          <div class="approval-notice">
            <p>✓ Cette demande a été approuvée par ${resp1 ? resp1.fullName : 'le premier responsable'}</p>
          </div>
          ` : ''}
          
          <div class="info-grid">
            <div class="info-item">
              <div class="info-label">Employé:</div>
              <div class="info-value">${demande.nom} ${demande.prenom}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Poste:</div>
              <div class="info-value">${demande.poste}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Type de demande:</div>
              <div class="info-value">${typeDemandeLabel}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Motif:</div>
              <div class="info-value">${demande.titre}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Date de départ:</div>
              <div class="info-value">${formatDateShort(demande.date_depart)}</div>
            </div>
            ${demande.date_retour ? `
            <div class="info-item">
              <div class="info-label">Date de retour:</div>
              <div class="info-value">${formatDateShort(demande.date_retour)}</div>
            </div>
            ` : ''}
            ${demande.heure_depart ? `
            <div class="info-item">
              <div class="info-label">Heure de départ:</div>
              <div class="info-value">${demande.heure_depart}</div>
            </div>
            ` : ''}
            ${demande.heure_retour ? `
            <div class="info-item">
              <div class="info-label">Heure de retour:</div>
              <div class="info-value">${demande.heure_retour}</div>
            </div>
            ` : ''}
            ${demande.frais_deplacement ? `
            <div class="info-item">
              <div class="info-label">Frais de déplacement:</div>
              <div class="info-value">${demande.frais_deplacement} TND</div>
            </div>
            ` : ''}
            ${demande.type_demande === 'conges' ? `
            <div class="info-item">
              <div class="info-label">Type de congé:</div>
              <div class="info-value">${typeCongeLabel}</div>
            </div>
            ` : ''}
          </div>
          
          <div class="buttons">
            <button class="approve" id="approveBtn">✅ Approuver</button>
            <button class="reject" id="rejectBtn">❌ Refuser</button>
          </div>
          
          <div class="refus-section">
            <textarea id="commentaire" rows="4" placeholder="Veuillez indiquer le motif du refus..."></textarea>
            <button class="reject" id="confirmRefus" style="display:none; margin-top:10px;">Confirmer le refus</button>
          </div>
        </div>

        <script>
          // Déclaration des variables globales
          const demandeId = ${id};
          const niveau = ${Number(niveau) || 1};
          
          function setProcessing(isProcessing) {
            const approveBtn = document.getElementById('approveBtn');
            const rejectBtn = document.getElementById('rejectBtn');
            const confirmRefus = document.getElementById('confirmRefus');

            [approveBtn, rejectBtn, confirmRefus].forEach(btn => {
              if (btn) btn.disabled = isProcessing;
            });

            if (approveBtn) {
              approveBtn.textContent = isProcessing ? 'Traitement...' : '✅ Approuver';
            }
            if (confirmRefus) {
              confirmRefus.textContent = isProcessing ? 'Traitement...' : 'Confirmer le refus';
            }
          }

          function showResult(status, message) {
            const badge = document.querySelector('.status-badge');
            if (badge) {
              if (status === 'approuve') {
                badge.textContent = 'Demande approuvée';
                badge.style.background = '#d1fae5';
                badge.style.color = '#065f46';
              } else if (status === 'refuse') {
                badge.textContent = 'Demande refusée';
                badge.style.background = '#fee2e2';
                badge.style.color = '#991b1b';
              }
            }

            const buttons = document.querySelector('.buttons');
            if (buttons) buttons.style.display = 'none';

            const refusSection = document.querySelector('.refus-section');
            if (refusSection) refusSection.style.display = 'none';

            const card = document.querySelector('.card');
            if (card && message) {
              const info = document.createElement('p');
              info.style.marginTop = '20px';
              info.style.textAlign = 'center';
              info.style.color = '#374151';
              info.textContent = message;
              card.appendChild(info);
            }
          }

          function toggleRefus() {
            const commentaire = document.getElementById('commentaire');
            const confirmRefus = document.getElementById('confirmRefus');
            if (commentaire) commentaire.style.display = 'block';
            if (confirmRefus) confirmRefus.style.display = 'inline-block';
          }

          async function approuver() {
            setProcessing(true);
            try {
              const response = await fetch('/api/demandes/' + demandeId + '/approuver', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ niveau: niveau })
              });
              
              if (response.ok) {
                const data = await response.json().catch(() => ({}));
                showResult('approuve', data.message || 'Votre décision a été enregistrée.');
              } else {
                alert('❌ Erreur lors de l\\'approbation');
                setProcessing(false);
              }
            } catch (e) {
              console.error(e);
              alert('❌ Erreur réseau');
              setProcessing(false);
            }
          }

          async function refuser() {
            const commentaireInput = document.getElementById('commentaire');
            const commentaire = commentaireInput ? commentaireInput.value : '';
            if (!commentaire.trim()) {
              alert('Veuillez indiquer le motif du refus');
              return;
            }

            setProcessing(true);
            try {
              const response = await fetch('/api/demandes/' + demandeId + '/refuser', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ niveau: niveau, commentaire: commentaire })
              });
              
              if (response.ok) {
                const data = await response.json().catch(() => ({}));
                showResult('refuse', data.message || 'Votre décision a été enregistrée.');
              } else {
                alert('❌ Erreur lors du refus');
                setProcessing(false);
              }
            } catch (e) {
              console.error(e);
              alert('❌ Erreur réseau');
              setProcessing(false);
            }
          }

          // Initialisation des événements
          document.addEventListener('DOMContentLoaded', function() {
            const approveBtn = document.getElementById('approveBtn');
            const rejectBtn = document.getElementById('rejectBtn');
            const confirmRefus = document.getElementById('confirmRefus');
            
            if (approveBtn) {
              approveBtn.addEventListener('click', approuver);
            }
            
            if (rejectBtn) {
              rejectBtn.addEventListener('click', toggleRefus);
            }
            
            if (confirmRefus) {
              confirmRefus.addEventListener('click', refuser);
            }
          });
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Erreur page approbation:', err);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: #ef4444;">Erreur serveur</h1>
          <p>Une erreur est survenue lors du traitement de votre demande.</p>
        </body>
      </html>
    `);
  }
});

// ==================== MODIFICATION DE LA ROUTE D'APPROBATION ====================

// Approuver une demande (VERSION MODIFIÉE)
app.post('/api/demandes/:id/approuver', async (req, res) => {
  const { id } = req.params;
  const { niveau } = req.body;

  console.log(`✅ Approbation demande ${id}, niveau ${niveau}`);

  try {
    const demandeResult = await pool.query(
      `SELECT d.*, e.nom, e.prenom, e.adresse_mail, e.mail_responsable1, e.mail_responsable2, e.poste, e.matricule
       FROM demande_rh d
       JOIN employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (demandeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Demande non trouvée' });
    }

    const demande = demandeResult.rows[0];

    // Vérifier si la demande est déjà traitée
    if (demande.statut !== 'en_attente') {
      console.log(`ℹ️ Demande ${id} déjà traitée: ${demande.statut}`);
      return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
    }

    const colonne = niveau == 1 ? 'approuve_responsable1' : 'approuve_responsable2';

    // Mettre à jour l'approbation (R1 ou R2) à TRUE
    await pool.query(
      `UPDATE demande_rh SET ${colonne} = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );

    // Noms des responsables à partir de leurs emails
    const resp1 = demande.mail_responsable1 ? extraireNomPrenomDepuisEmail(demande.mail_responsable1) : null;
    const resp2 = demande.mail_responsable2 ? extraireNomPrenomDepuisEmail(demande.mail_responsable2) : null;

    // CAS 1 : Niveau 1 & responsable 2 existe → mail étape 1 + mail à R2
    if (niveau == 1 && demande.mail_responsable2) {
      // Email à l'employé : approuvé par R1, en attente de R2
      await sendEmailWithRetry({
        from: {
          name: 'Administration STS',
          address: 'administration.STS@avocarbon.com'
        },
        to: demande.adresse_mail,
        subject: 'Votre demande RH a été approuvée par votre responsable (Niveau 1)',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #10b981;">✅ Étape 1 : Demande approuvée</h2>
            <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Bonjour ${demande.nom} ${demande.prenom},</strong></p>
              <p>Votre demande de <strong>${demande.type_demande}</strong> a été <strong>approuvée par ${resp1 ? resp1.fullName : 'votre responsable hiérarchique'}</strong>.</p>
              <p>Elle est maintenant <strong>en attente d'approbation par ${resp2 ? resp2.fullName : 'le deuxième responsable'}</strong>.</p>
              <p><strong>Date de départ :</strong> ${formatDateShort(demande.date_depart)}</p>
              <p><strong>Motif :</strong> ${demande.titre}</p>
            </div>
            <p style="color:#6b7280;font-size:14px;">Vous recevrez un nouvel email lorsque la demande sera définitivement approuvée.</p>
          </div>
        `
      }, 'Approbation niveau 1');

      // Email au responsable 2 avec mention du premier approbateur
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

    // CAS 2 : Demande complètement approuvée (pas de R2 ou validation niveau 2)
    await pool.query(
      `UPDATE demande_rh SET statut = 'approuve' WHERE id = $1`,
      [id]
    );

    // Qui est l'approbateur final ?
    let approuveur = null;
    if (niveau == 1 && !demande.mail_responsable2) {
      approuveur = resp1; // seul responsable
    } else if (niveau == 2) {
      approuveur = resp2; // deuxième approbation
    }

    const typeCongeLabel = demande.type_demande === 'conges'
      ? getTypeCongeLabel(demande.type_conge, demande.type_conge_autre)
      : null;

    // ==================== NOUVEAUX EMAILS D'APPROBATION FINALE ====================

    // 1. EMAIL À L'EMPLOYÉ - Confirmation d'approbation
    await sendEmailWithRetry({
      from: {
        name: 'Administration STS',
        address: 'administration.STS@avocarbon.com'
      },
      to: demande.adresse_mail,
      subject: '✅ Votre demande RH a été approuvée',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10b981; border-bottom: 3px solid #10b981; padding-bottom: 10px;">
            ✅ Demande RH approuvée
          </h2>
          <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10b981;">
            <p><strong>Bonjour ${demande.nom} ${demande.prenom},</strong></p>
            <p>Nous avons le plaisir de vous informer que votre demande a été <strong style="color: #10b981;">approuvée</strong>.</p>
          </div>
          
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #374151; margin-top: 0;">📋 Détails de la demande</h3>
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
          
          <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
            Si vous avez des questions, n'hésitez pas à contacter le service RH.
          </p>
        </div>
      `
    }, 'Approbation finale - Email employé');

// Dans la section "// 2. EMAIL À L'ÉQUIPE RH", remplacez par :

// Calcul du nombre de jours ouvrés pour les congés
let joursOuvres = 0;
let infoJoursCongee = '';
if (demande.type_demande === 'conges' && demande.date_retour) {
  joursOuvres = calculerJoursOuvres(demande.date_depart, demande.date_retour);
  infoJoursCongee = `
<tr>
  <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Nombre de jours ouvrés:</td>
  <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;"><strong style="color: #1976d2; font-size: 18px;">${joursOuvres} jour${joursOuvres > 1 ? 's' : ''}</strong></td>
</tr>`;
}

// 2. EMAIL À L'ÉQUIPE RH - Notification de la demande approuvée
await sendEmailWithRetry({
  from: {
    name: 'Administration STS',
    address: 'administration.STS@avocarbon.com'
  },
  to: 'fethi.chaouachi@avocarbon.com',
  subject: `📋 Demande RH approuvée - ${demande.nom} ${demande.prenom}`,
  html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f5f5;">
  <div style="max-width: 650px; margin: 30px auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
    
    <!-- En-tête -->
    <div style="background: linear-gradient(135deg, #1976d2 0%, #1565c0 100%); color: white; padding: 30px; text-align: center;">
      <h1 style="margin: 0; font-size: 26px; font-weight: 600;">📋 Nouvelle demande RH approuvée</h1>
    </div>
    
    <!-- Corps du message -->
    <div style="padding: 30px;">
      <div style="background-color: #e3f2fd; border-left: 4px solid #1976d2; padding: 15px; margin-bottom: 25px; border-radius: 4px;">
        <p style="margin: 0; color: #1565c0; font-weight: 500;">ℹ️ Une demande RH vient d'être approuvée et nécessite votre attention pour le suivi administratif.</p>
      </div>
      
      <!-- Informations Employé -->
      <h2 style="color: #1976d2; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; margin-top: 0;">👤 Informations Employé</h2>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;">
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555; width: 40%;">Nom complet:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;">${demande.nom} ${demande.prenom}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Matricule:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;"><strong>${demande.matricule || 'Non spécifié'}</strong></td>
        </tr>
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Poste:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;">${demande.poste || 'Non spécifié'}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Email:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;">${demande.adresse_mail}</td>
        </tr>
      </table>
      
      <!-- Détails de la Demande -->
      <h2 style="color: #1976d2; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px;">📋 Détails de la Demande</h2>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555; width: 40%;">Type de demande:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;"><strong>${demande.type_demande === 'conges' ? 'Congé' : demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission'}</strong></td>
        </tr>
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Motif:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;">${demande.titre}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Date de départ:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;">${formatDateShort(demande.date_depart)}</td>
        </tr>
        ${demande.date_retour ? `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Date de retour:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;">${formatDateShort(demande.date_retour)}</td>
        </tr>` : ''}
        ${infoJoursCongee}
        ${typeCongeLabel ? `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Type de congé:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;">${typeCongeLabel}</td>
        </tr>` : ''}
        ${demande.demi_journee ? `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Demi-journée:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;">Oui</td>
        </tr>` : ''}
        ${demande.heure_depart ? `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Heure de départ:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;">${demande.heure_depart}</td>
        </tr>` : ''}
        ${demande.heure_retour ? `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Heure de retour:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;">${demande.heure_retour}</td>
        </tr>` : ''}
        ${demande.frais_deplacement ? `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #555;">Frais de déplacement:</td>
          <td style="padding: 10px; border-bottom: 1px solid #e0e0e0; color: #333;">${demande.frais_deplacement} TND</td>
        </tr>` : ''}
      </table>
    </div>
    
    <!-- Pied de page -->
    <div style="background-color: #f5f5f5; padding: 20px; text-align: center; border-top: 1px solid #e0e0e0;">
      <p style="margin: 0; font-size: 12px; color: #666;">
        Cet email est envoyé automatiquement par le système de gestion RH
      </p>
    </div>
  </div>
</body>
</html>
  `
}, 'Notification RH - Demande approuvée');

    console.log(`✅ Demande ${id} complètement approuvée - Emails envoyés à l'employé et à l'équipe RH`);
    
    res.json({ 
      success: true, 
      message: 'Demande complètement approuvée et notifications envoyées' 
    });
  } catch (err) {
    console.error('❌ Erreur approbation demande:', err);
    res.status(500).json({ error: 'Erreur lors de l\'approbation' });
  }
});

// Refuser une demande
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

    // Vérifier si la demande est déjà traitée
    if (demande.statut !== 'en_attente') {
      console.log(`ℹ️ Demande ${id} déjà traitée: ${demande.statut}`);
      return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
    }

    const colonneRefus = niveau == 1 ? 'approuve_responsable1' : 'approuve_responsable2';
    
    // Mise à jour statut + commentaire + champ approuve_responsable à FALSE
    await pool.query(
      `UPDATE demande_rh 
       SET statut = 'refuse', 
           commentaire_refus = $1, 
           ${colonneRefus} = false,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [commentaire, id]
    );

    // Identité du responsable qui refuse
    const resp1 = demande.mail_responsable1 ? extraireNomPrenomDepuisEmail(demande.mail_responsable1) : null;
    const resp2 = demande.mail_responsable2 ? extraireNomPrenomDepuisEmail(demande.mail_responsable2) : null;

    let refuserParTexte = 'votre responsable hiérarchique';
    if (niveau == 1 && resp1) {
      refuserParTexte = resp1.fullName;
    } else if (niveau == 2 && resp2) {
      refuserParTexte = resp2.fullName;
    }

    const typeCongeLabel = demande.type_demande === 'conges'
      ? getTypeCongeLabel(demande.type_conge, demande.type_conge_autre)
      : null;

    // Email à l'employé
    await sendEmailWithRetry({
      from: {
        name: 'Administration STS',
        address: 'administration.STS@avocarbon.com'
      },
      to: demande.adresse_mail,
      subject: 'Votre demande RH a été refusée',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #ef4444;">❌ Votre demande RH a été refusée</h2>
          <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Bonjour ${demande.nom} ${demande.prenom},</strong></p>
            <p>Votre demande de <strong>${demande.type_demande}</strong> pour le <strong>${formatDateShort(demande.date_depart)}</strong> a été refusée.</p>
            ${typeCongeLabel ? `<p><strong>Type de congé:</strong> ${typeCongeLabel}</p>` : ''}
            <p>La décision a été prise par <strong>${refuserParTexte}</strong>.</p>
            <p><strong>Motif du refus:</strong> ${commentaire}</p>
          </div>
        </div>
      `
    }, 'Refus demande');

    console.log(`✅ Demande ${id} refusée`);
    
    res.json({ 
      success: true, 
      message: 'Demande refusée avec succès' 
    });
  } catch (err) {
    console.error('❌ Erreur refus demande:', err);
    res.status(500).json({ error: 'Erreur lors du refus' });
  }
});

// Récupérer les demandes d'un employé
app.get('/api/demandes/employe/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM demande_rh 
       WHERE employe_id = $1 
       ORDER BY created_at DESC`,
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

// Route de santé
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Serveur RH fonctionnel',
    timestamp: new Date().toISOString(),
    smtpPoolSize: emailPool.transporters.length,
    activeTransporterIndex: emailPool.currentIndex
  });
});

// Route pour tester la configuration SMTP
app.get('/api/test-email', async (req, res) => {
  try {
    const testMailOptions = {
      from: {
        name: 'Administration STS',
        address: 'administration.STS@avocarbon.com'
      },
      to: 'majed.messai@avocarbon.com',
      subject: 'Test SMTP Configuration - ' + new Date().toISOString(),
      text: 'Ceci est un email de test pour vérifier la configuration SMTP.',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #2563eb;">Test SMTP Configuration</h2>
          <p>Ceci est un email de test envoyé depuis le serveur RH.</p>
          <p>Timestamp: ${new Date().toISOString()}</p>
          <p>Server: ${process.env.NODE_ENV || 'development'}</p>
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

// Route pour vérifier l'état des transporteurs SMTP
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
  =========================================
  📧 Emails d'approbation: http://localhost:${PORT}/approuver-demande
  👥 API Employés: http://localhost:${PORT}/api/employees/actifs
  📋 API Demandes: http://localhost:${PORT}/api/demandes
  📄 API Attestations: http://localhost:${PORT}/api/generer-attestation
  🩺 Santé: http://localhost:${PORT}/health
  🔧 Test SMTP: http://localhost:${PORT}/api/test-email
  📊 Status SMTP: http://localhost:${PORT}/api/smtp-status
  `);
  
  // Vérifier la connexion SMTP au démarrage
  await verifySMTPConnection();
  
  // Vérifier les templates Word
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
