const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const libreoffice = require('libreoffice-convert');
const util = require('util');
const { exec } = require('child_process');
const createReport = require('docx-templates').default;
require('dotenv').config();

const app = express();

// Configuration CORS manuelle
const corsOptions = {
  origin: function (origin, callback) {
    // Liste des origines autorisées
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:5173',
      'https://votre-frontend.azurewebsites.net',
      // Ajoutez d'autres origines au besoin
    ];
    
    // En développement, autoriser toutes les origines
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    // En production, vérifier l'origine
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Pour les pré-requêtes OPTIONS
app.use(express.json());

// Configuration PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER || 'administrationSTS',
  host: process.env.DB_HOST || 'avo-adb-002.postgres.database.azure.com',
  database: process.env.DB_NAME || 'rh_application',
  password: process.env.DB_PASSWORD || 'St$@0987',
  port: process.env.DB_PORT || 5432,
  ssl: { rejectUnauthorized: false }
});

// Configuration SMTP Outlook
const transporter = nodemailer.createTransport({
  host: 'avocarbon-com.mail.protection.outlook.com',
  port: 25,
  secure: false,
  tls: { rejectUnauthorized: false }
});

// URL de base (backend déployé)
const BASE_URL = 'https://hr-back.azurewebsites.net';

// Chemin vers le template Word
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'Attestation de travail Modèle IA.docx');

// Convertir libreoffice.convert en promesse
const libreofficeConvert = util.promisify(libreoffice.convert);
const execAsync = util.promisify(exec);

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

// Helper : formatage simple de date (sans heure)
function formatDateShort(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toDateString();
}

// Helper : formatage date française (JJ/MM/AAAA)
function formatDateFR(date) {
  if (!date) return '';
  
  // Si c'est déjà une chaîne au format JJ/MM/AAAA, la retourner telle quelle
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

// Fonction pour générer une attestation Word
async function genererAttestationWord(employe) {
  try {
    // Vérifier si le template existe
    try {
      await fs.access(TEMPLATE_PATH);
    } catch (error) {
      console.error(`Template non trouvé: ${TEMPLATE_PATH}`);
      throw new Error('Template Word non trouvé. Placez-le dans le dossier templates/');
    }
    
    // Lire le template Word
    const templateBuffer = await fs.readFile(TEMPLATE_PATH);
    
    // Données à injecter dans le template
    const data = {
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
      // Options supplémentaires pour préserver le formatage
      additionalJsContext: {
        uppercase: (str) => str ? str.toUpperCase() : '',
        lowercase: (str) => str ? str.toLowerCase() : '',
        capitalize: (str) => str ? str.charAt(0).toUpperCase() + str.slice(1) : ''
      }
    });
    
    return reportBuffer;
    
  } catch (error) {
    console.error('Erreur lors de la génération Word:', error);
    throw error;
  }
}

// Fonction pour vérifier si LibreOffice est installé
async function verifierLibreOffice() {
  try {
    // Essayer de trouver soffice (LibreOffice) dans différents chemins
    const paths = [
      '/usr/bin/soffice',
      '/usr/local/bin/soffice',
      '/opt/libreoffice/program/soffice',
      'soffice', // Essayer dans le PATH
      'libreoffice', // Alternative
    ];
    
    for (const binPath of paths) {
      try {
        const { stdout } = await execAsync(`${binPath} --version`);
        console.log(`LibreOffice trouvé: ${binPath}`);
        console.log(`Version: ${stdout.trim()}`);
        return { installed: true, path: binPath, version: stdout.trim() };
      } catch (error) {
        continue; // Essayer le chemin suivant
      }
    }
    
    return { installed: false, path: null, version: null };
  } catch (error) {
    console.error('Erreur lors de la vérification de LibreOffice:', error);
    return { installed: false, path: null, version: null };
  }
}

// Fonction pour convertir un fichier Word en PDF avec méthode directe (sans libreoffice-convert)
async function convertirWordEnPDFDirect(wordBuffer, nomFichier) {
  try {
    console.log('Tentative de conversion directe avec LibreOffice...');
    
    // Créer un fichier temporaire
    const tempDir = path.join(__dirname, 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    
    const tempWordPath = path.join(tempDir, `${Date.now()}_${nomFichier}`);
    const tempPdfPath = path.join(tempDir, `${Date.now()}_${nomFichier.replace('.docx', '.pdf')}`);
    
    // Écrire le buffer Word dans un fichier temporaire
    await fs.writeFile(tempWordPath, wordBuffer);
    
    // Essayer différentes commandes LibreOffice
    const commands = [
      `libreoffice --headless --convert-to pdf --outdir "${tempDir}" "${tempWordPath}"`,
      `soffice --headless --convert-to pdf --outdir "${tempDir}" "${tempWordPath}"`,
      `/usr/bin/libreoffice --headless --convert-to pdf --outdir "${tempDir}" "${tempWordPath}"`,
      `/usr/bin/soffice --headless --convert-to pdf --outdir "${tempDir}" "${tempWordPath}"`,
    ];
    
    let conversionSuccess = false;
    let pdfBuffer = null;
    
    for (const command of commands) {
      try {
        console.log(`Essai de commande: ${command}`);
        const { stdout, stderr } = await execAsync(command);
        
        if (stderr) {
          console.warn('Avertissement LibreOffice:', stderr);
        }
        
        console.log('LibreOffice stdout:', stdout);
        
        // Vérifier si le fichier PDF a été créé
        try {
          pdfBuffer = await fs.readFile(tempPdfPath);
          conversionSuccess = true;
          console.log(`Conversion réussie avec commande: ${command}`);
          break;
        } catch (error) {
          // Chercher le fichier PDF généré (peut avoir un nom différent)
          const files = await fs.readdir(tempDir);
          const pdfFile = files.find(f => f.endsWith('.pdf') && f.includes(nomFichier.replace('.docx', '')));
          
          if (pdfFile) {
            const actualPdfPath = path.join(tempDir, pdfFile);
            pdfBuffer = await fs.readFile(actualPdfPath);
            conversionSuccess = true;
            
            // Nettoyer le fichier temporaire
            try { await fs.unlink(actualPdfPath); } catch {}
            
            console.log(`Conversion réussie, fichier trouvé: ${pdfFile}`);
            break;
          }
        }
      } catch (error) {
        console.log(`Commande échouée: ${command} - ${error.message}`);
        continue;
      }
    }
    
    // Nettoyer les fichiers temporaires
    try { await fs.unlink(tempWordPath); } catch {}
    try { 
      if (await fs.access(tempPdfPath).then(() => true).catch(() => false)) {
        await fs.unlink(tempPdfPath); 
      }
    } catch {}
    
    if (!conversionSuccess || !pdfBuffer) {
      throw new Error('Aucune méthode de conversion n\'a fonctionné');
    }
    
    console.log(`Conversion directe réussie, taille du PDF: ${pdfBuffer.length} bytes`);
    return pdfBuffer;
    
  } catch (error) {
    console.error('Erreur lors de la conversion directe:', error);
    throw new Error(`Échec de la conversion directe: ${error.message}`);
  }
}

// Fonction pour convertir un fichier Word en PDF (méthode hybride)
async function convertirWordEnPDF(wordBuffer, nomFichier = 'attestation.docx') {
  try {
    console.log('Début de la conversion Word -> PDF...');
    
    // Essayer d'abord avec libreoffice-convert
    try {
      console.log('Tentative avec libreoffice-convert...');
      const pdfBuffer = await libreofficeConvert(wordBuffer, '.pdf', undefined);
      console.log('Conversion réussie avec libreoffice-convert');
      console.log(`Taille du PDF généré: ${pdfBuffer.length} bytes`);
      return pdfBuffer;
    } catch (convertError) {
      console.warn('libreoffice-convert a échoué:', convertError.message);
      
      // Fallback: méthode directe
      console.log('Essai de la méthode directe...');
      return await convertirWordEnPDFDirect(wordBuffer, nomFichier);
    }
    
  } catch (error) {
    console.error('Toutes les méthodes de conversion ont échoué:', error);
    
    // Dernier recours: envoyer le Word si la conversion échoue
    console.log('Conversion PDF impossible, le document Word sera envoyé à la place');
    throw new Error(`Conversion PDF impossible. Le document sera envoyé en format Word. Détails: ${error.message}`);
  }
}

// ==================== ROUTES API ====================

// Récupérer tous les employés actifs (sans date de départ)
app.get('/api/employees/actifs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, matricule, nom, prenom, poste, adresse_mail, 
              mail_responsable1, mail_responsable2, date_debut,
              date_naissance, cin
       FROM employees 
       WHERE date_depart IS NULL 
       ORDER BY nom, prenom`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des employés' });
  }
});

// Route pour générer une attestation Word, la convertir en PDF et l'envoyer par email
app.post('/api/generer-attestation', async (req, res) => {
  const { employe_id, type_document } = req.body;

  try {
    // Validation
    if (!employe_id || !type_document) {
      return res.status(400).json({ 
        error: 'Les champs employé et type de document sont obligatoires' 
      });
    }

    // Récupérer les informations de l'employé
    const employeResult = await pool.query(
      `SELECT nom, prenom, poste, adresse_mail, date_debut, 
              date_naissance, cin, matricule
       FROM employees WHERE id = $1`,
      [employe_id]
    );

    if (employeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Employé non trouvé' });
    }

    const employe = employeResult.rows[0];

    // Générer le document Word
    const wordBuffer = await genererAttestationWord(employe);
    console.log(`Document Word généré: ${wordBuffer.length} bytes`);

    // Noms des fichiers
    const fileNameBase = `Attestation_Travail_${employe.nom}_${employe.prenom}`;
    const wordFileName = `${fileNameBase}.docx`;
    const pdfFileName = `${fileNameBase}.pdf`;

    let pdfBuffer = null;
    let conversionSuccess = false;
    let attachments = [];

    // Essayer de convertir en PDF
    try {
      pdfBuffer = await convertirWordEnPDF(wordBuffer, wordFileName);
      conversionSuccess = true;
      
      // Ajouter le PDF en pièce jointe
      attachments.push({
        filename: pdfFileName,
        content: pdfBuffer,
        contentType: 'application/pdf'
      });
      
      console.log('PDF généré avec succès');
      
    } catch (conversionError) {
      console.error('Échec de la conversion PDF, envoi du Word à la place:', conversionError.message);
      conversionSuccess = false;
      
      // Ajouter le Word en pièce jointe (fallback)
      attachments.push({
        filename: wordFileName,
        content: wordBuffer,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });
    }

    // Préparer l'email
    const formatDocument = conversionSuccess ? 'PDF' : 'Word (PDF non disponible)';
    
    const mailOptions = {
      from: {
        name: 'Administration STS',
        address: 'administration.STS@avocarbon.com'
      },
      to: 'majed.messai@avocarbon.com',
      subject: `Demande d'attestation de travail - ${employe.nom} ${employe.prenom}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">
            Demande d'attestation de travail
          </h2>
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Employé:</strong> ${employe.nom} ${employe.prenom}</p>
            <p><strong>Matricule:</strong> ${employe.matricule || 'Non spécifié'}</p>
            <p><strong>Poste:</strong> ${employe.poste || 'Non spécifié'}</p>
            <p><strong>Date d'embauche:</strong> ${formatDateFR(employe.date_debut)}</p>
            <p><strong>Type de document:</strong> ${type_document}</p>
            <p><strong>Format:</strong> ${formatDocument}</p>
            <p><strong>Date de la demande:</strong> ${formatDateFR(new Date())}</p>
          </div>
          <p style="color: #6b7280; font-size: 14px;">
            ${conversionSuccess 
              ? 'L\'attestation de travail est jointe à cet email en format PDF.' 
              : 'L\'attestation de travail est jointe en format Word (conversion PDF temporairement indisponible).'}
          </p>
          <p style="color: #6b7280; font-size: 12px;">
            <em>Document généré automatiquement le ${new Date().toLocaleDateString('fr-FR')}</em>
          </p>
        </div>
      `,
      attachments: attachments
    };

    // Envoyer l'email
    await transporter.sendMail(mailOptions);
    console.log(`Email envoyé avec ${conversionSuccess ? 'PDF' : 'Word'}: ${conversionSuccess ? pdfFileName : wordFileName}`);

    res.json({ 
      success: true, 
      message: conversionSuccess 
        ? 'Attestation générée, convertie en PDF et envoyée par email avec succès'
        : 'Attestation générée et envoyée en format Word (conversion PDF échouée)',
      fileName: conversionSuccess ? pdfFileName : wordFileName,
      format: conversionSuccess ? 'pdf' : 'word',
      fileSize: conversionSuccess ? pdfBuffer.length : wordBuffer.length
    });

  } catch (err) {
    console.error('Erreur lors de la génération d\'attestation:', err);
    
    res.status(500).json({ 
      error: 'Erreur lors de la génération de l\'attestation: ' + err.message 
    });
  }
});

// Route pour télécharger l'attestation directement en PDF (avec fallback)
app.post('/api/telecharger-attestation-pdf', async (req, res) => {
  const { employe_id } = req.body;

  try {
    if (!employe_id) {
      return res.status(400).json({ error: 'ID employé requis' });
    }

    const employeResult = await pool.query(
      `SELECT nom, prenom, poste, date_debut, date_naissance, cin
       FROM employees WHERE id = $1`,
      [employe_id]
    );

    if (employeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Employé non trouvé' });
    }

    const employe = employeResult.rows[0];
    
    // Générer le document Word
    const wordBuffer = await genererAttestationWord(employe);
    
    // Nom du fichier
    const wordFileName = `Attestation_Travail_${employe.nom}_${employe.prenom}.docx`;
    const pdfFileName = `Attestation_Travail_${employe.nom}_${employe.prenom}.pdf`;
    
    try {
      // Essayer de convertir en PDF
      const pdfBuffer = await convertirWordEnPDF(wordBuffer, wordFileName);
      
      // Envoyer le fichier PDF en téléchargement
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${pdfFileName}"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
      
    } catch (conversionError) {
      console.error('Conversion PDF échouée, envoi du Word:', conversionError);
      
      // Fallback: envoyer le Word
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${wordFileName}"`);
      res.setHeader('Content-Length', wordBuffer.length);
      res.send(wordBuffer);
    }

  } catch (error) {
    console.error('Erreur:', error);
    res.status(500).json({ error: 'Erreur lors de la génération du document: ' + error.message });
  }
});

// Route pour télécharger l'attestation en Word (version originale)
app.post('/api/telecharger-attestation-word', async (req, res) => {
  const { employe_id } = req.body;

  try {
    if (!employe_id) {
      return res.status(400).json({ error: 'ID employé requis' });
    }

    const employeResult = await pool.query(
      `SELECT nom, prenom, poste, date_debut, date_naissance, cin
       FROM employees WHERE id = $1`,
      [employe_id]
    );

    if (employeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Employé non trouvé' });
    }

    const employe = employeResult.rows[0];
    const wordBuffer = await genererAttestationWord(employe);
    
    const fileName = `Attestation_Travail_${employe.nom}_${employe.prenom}.docx`;
    
    // Envoyer le fichier Word en téléchargement
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', wordBuffer.length);
    res.send(wordBuffer);

  } catch (error) {
    console.error('Erreur:', error);
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
    }

    res.json({ 
      success: true, 
      message: 'Demande créée avec succès',
      demandeId 
    });
  } catch (err) {
    console.error('Erreur détaillée:', err);
    res.status(500).json({ error: 'Erreur lors de la création de la demande: ' + err.message });
  }
});

// Fonction pour envoyer email au responsable
async function envoyerEmailResponsable(employe, emailResponsable, demandeId, niveau, details) {
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

  // Si on écrit au responsable 2, préciser que R1 a déjà approuvé
  let infoNiveauHtml = '';
  if (niveau === 2 && employe.mail_responsable1) {
    const resp1 = extraireNomPrenomDepuisEmail(employe.mail_responsable1);
    infoNiveauHtml = `
      <p style="margin-top:10px;">
        Cette demande a déjà été approuvée par 
        <strong>${resp1.fullName}</strong> (Responsable niveau 1).
      </p>
    `;
  }

  const mailOptions = {
    from: {
      name: 'Administration STS',
      address: 'administration.STS@avocarbon.com'
    },
    to: emailResponsable,
    subject: `Nouvelle demande RH - ${employe.nom} ${employe.prenom}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">
          Demande RH en attente d'approbation
        </h2>
        ${infoNiveauHtml}
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
            Voir et traiter la demande
          </a>
        </div>
        <p style="color: #6b7280; font-size: 14px; text-align: center;">
          Ce lien expirera après traitement de la demande.
        </p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email envoyé à ${emailResponsable} pour la demande ${demandeId} (niveau ${niveau})`);
  } catch (error) {
    console.error('Erreur envoi email:', error);
  }
}

// Page d'approbation/refus de demande
app.get('/approuver-demande', async (req, res) => {
  const { id, niveau } = req.query;
  
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
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <h1>📋 Demande RH - Approbation</h1>
            <div class="status-badge">En attente de validation</div>
          </div>
          
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
            <button class="approve" id="approveBtn" onclick="approuver()">✅ Approuver</button>
            <button class="reject" id="rejectBtn" onclick="toggleRefus()">❌ Refuser</button>
          </div>
          
          <div class="refus-section">
            <textarea id="commentaire" rows="4" placeholder="Veuillez indiquer le motif du refus..."></textarea>
            <button class="reject" onclick="refuser()" style="display:none; margin-top:10px;" id="confirmRefus">Confirmer le refus</button>
          </div>
        </div>

        <script>
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
              info.style.text-align = 'center';
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
              const response = await fetch('/api/demandes/${id}/approuver', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ niveau: ${Number(niveau) || 1} })
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
              const response = await fetch('/api/demandes/${id}/refuser', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ niveau: ${Number(niveau) || 1}, commentaire })
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
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
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

// Approuver une demande (avec noms des responsables dans les mails)
app.post('/api/demandes/:id/approuver', async (req, res) => {
  const { id } = req.params;
  const { niveau } = req.body;

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
      await transporter.sendMail({
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
      });

      // Email au responsable 2 (avec mention que R1 a déjà approuvé → géré dans envoyerEmailResponsable)
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
        }
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

    // Email final à l'employé
    await transporter.sendMail({
      from: {
        name: 'Administration STS',
        address: 'administration.STS@avocarbon.com'
      },
      to: demande.adresse_mail,
      subject: 'Votre demande RH a été définitivement approuvée',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10b981;">✅ Demande RH approuvée</h2>
          <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Bonjour ${demande.nom} ${demande.prenom},</strong></p>
            <p>Votre demande de <strong>${demande.type_demande}</strong> pour le <strong>${formatDateShort(demande.date_depart)}</strong> a été <strong>approuvée</strong>.</p>
            ${approuveur ? `<p>La demande a été validée par <strong>${approuveur.fullName}</strong>.</p>` : ''}
            <p><strong>Motif:</strong> ${demande.titre}</p>
            ${typeCongeLabel ? `<p><strong>Type de congé:</strong> ${typeCongeLabel}</p>` : ''}
          </div>
        </div>
      `
    });

    res.json({ 
      success: true, 
      message: 'Demande complètement approuvée' 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de l\'approbation' });
  }
});

// Refuser une demande (avec nom du responsable qui refuse)
app.post('/api/demandes/:id/refuser', async (req, res) => {
  const { id } = req.params;
  const { niveau, commentaire } = req.body;

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
      return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
    }

    // Mettre à jour le champ approuve_responsable à FALSE selon le niveau
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
    await transporter.sendMail({
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
    });

    res.json({ 
      success: true, 
      message: 'Demande refusée avec succès' 
    });
  } catch (err) {
    console.error(err);
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
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des demandes' });
  }
});

// Route pour vérifier l'état de LibreOffice
app.get('/api/check-libreoffice', async (req, res) => {
  try {
    const status = await verifierLibreOffice();
    
    if (status.installed) {
      res.json({ 
        success: true, 
        message: 'LibreOffice est installé et fonctionnel',
        path: status.path,
        version: status.version,
        conversionAvailable: true
      });
    } else {
      res.json({ 
        success: false, 
        message: 'LibreOffice n\'est pas installé ou non trouvé',
        conversionAvailable: false,
        instructions: 'Pour installer LibreOffice sur Azure: apt-get install libreoffice'
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Erreur lors de la vérification',
      message: error.message
    });
  }
});

// Route de test de conversion
app.get('/api/test-conversion', async (req, res) => {
  try {
    // Créer un document Word simple pour tester
    const testWordBuffer = await genererAttestationWord({
      nom: 'TEST',
      prenom: 'Conversion',
      poste: 'Testeur',
      date_debut: new Date(),
      date_naissance: null,
      cin: 'TEST123456'
    });
    
    console.log('Test de conversion - Taille du Word:', testWordBuffer.length);
    
    const fileName = 'test_conversion.docx';
    
    try {
      // Essayer la conversion
      const pdfBuffer = await convertirWordEnPDF(testWordBuffer, fileName);
      
      res.json({ 
        success: true, 
        message: 'Conversion Word -> PDF fonctionnelle',
        wordSize: testWordBuffer.length,
        pdfSize: pdfBuffer.length,
        ratio: (pdfBuffer.length / testWordBuffer.length * 100).toFixed(2) + '%',
        method: 'Conversion réussie'
      });
    } catch (conversionError) {
      res.json({ 
        success: false, 
        message: 'Conversion échouée, fallback disponible',
        wordSize: testWordBuffer.length,
        error: conversionError.message,
        method: 'Fallback vers Word'
      });
    }
    
  } catch (error) {
    console.error('Erreur test conversion:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Échec du test',
      message: error.message
    });
  }
});

// Route de santé
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Serveur RH fonctionnel',
    timestamp: new Date().toISOString(),
    service: 'Gestion RH avec conversion PDF'
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📧 Emails d'approbation: http://localhost:${PORT}/approuver-demande`);
  console.log(`👥 API Employés: http://localhost:${PORT}/api/employees/actifs`);
  console.log(`📋 API Demandes: http://localhost:${PORT}/api/demandes`);
  console.log(`📄 API Attestations: http://localhost:${PORT}/api/generer-attestation`);
  console.log(`🧪 Test conversion: http://localhost:${PORT}/api/test-conversion`);
  console.log(`🔍 Vérif LibreOffice: http://localhost:${PORT}/api/check-libreoffice`);
  console.log(`📁 Template Word: ${TEMPLATE_PATH}`);
  
  // Vérifier LibreOffice au démarrage
  const libreOfficeStatus = await verifierLibreOffice();
  if (libreOfficeStatus.installed) {
    console.log(`✅ LibreOffice trouvé: ${libreOfficeStatus.version}`);
  } else {
    console.log(`⚠️  LibreOffice non trouvé. Le fallback Word sera utilisé.`);
    console.log(`ℹ️  Pour installer: apt-get install libreoffice`);
  }
});
