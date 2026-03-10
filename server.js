const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const createReport = require('docx-templates').default;
const PDFDocument = require('pdfkit');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ==================== DATABASE CONFIGURATION ====================

// HR Database (for employees, demandes_rh, etc.)
const poolHR = new Pool({
  user: process.env.DB_USER || 'administrationSTS',
  host: process.env.DB_HOST || 'avo-adb-002.postgres.database.azure.com',
  database: process.env.DB_NAME || 'rh_application',
  password: process.env.DB_PASS || 'St$@0987',
  port: process.env.DB_PORT || 5432,
  ssl: { rejectUnauthorized: false }
});

// Attendance Database (same server, different database name)
const poolAttendance = new Pool({
  user: process.env.DB_USER || 'administrationSTS',
  host: process.env.DB_HOST || 'avo-adb-002.postgres.database.azure.com',
  database: 'attendance',  // Just the database name is different
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

  init: function (count = 3) {
    for (let i = 0; i < count; i++) {
      this.transporters.push(createTransporter());
    }
    console.log(`📧 Pool SMTP initialisé avec ${count} transporteurs`);
  },

  getTransporter: function () {
    const transporter = this.transporters[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.transporters.length;
    return transporter;
  },

  rotateTransporter: function () {
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
      console.log(`✅ Connexion SMTP ${i + 1} établie avec succès`);
    } catch (error) {
      console.error(`❌ Échec connexion SMTP ${i + 1}:`, error.message);
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
  console.log(
    `   Taille pièces jointes: ${
      mailOptions.attachments
        ? mailOptions.attachments.reduce((sum, att) => sum + (att.content?.length || 0), 0)
        : 0
    } octets`
  );
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
    try {
      await fs.access(TEMPLATE_TRAVAIL_PATH);
    } catch (error) {
      console.error(`Template non trouvé: ${TEMPLATE_TRAVAIL_PATH}`);
      throw new Error('Template Word non trouvé. Placez-le dans le dossier templates/');
    }

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
    console.error('Erreur lors de la génération Word attestation travail:', error);
    throw error;
  }
}

// Fonction pour générer une attestation de salaire Word
async function genererAttestationSalaireWord(employe) {
  try {
    try {
      await fs.access(TEMPLATE_SALAIRE_PATH);
    } catch (error) {
      console.error(`Template non trouvé: ${TEMPLATE_SALAIRE_PATH}`);
      throw new Error('Template Word non trouvé. Placez-le dans le dossier templates/');
    }

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
    console.error('Erreur lors de la génération Word attestation salaire:', error);
    throw error;
  }
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

// ==================== FONCTION DE GÉNÉRATION PDF POUR L'ÉQUIPE RH ====================

async function genererPDFDemandeApprouvee(demande, joursOuvres = 0) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 }
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.rect(0, 0, doc.page.width, 80).fill('#1976d2');

      doc.fillColor('#ffffff')
        .fontSize(24)
        .font('Helvetica-Bold')
        .text('Demande RH Approuvée', 50, 30, { align: 'center' });

      doc.fillColor('#000000');

      doc.rect(50, 100, doc.page.width - 100, 60)
        .fillAndStroke('#e3f2fd', '#1976d2');

      doc.fillColor('#1565c0')
        .fontSize(12)
        .font('Helvetica-Bold')
        .text('Une demande RH vient d\'être approuvée', 60, 115)
        .font('Helvetica')
        .text('Cette demande nécessite votre attention pour le suivi administratif.', 60, 135);

      doc.fillColor('#000000');

      let yPosition = 180;

      doc.fontSize(16)
        .font('Helvetica-Bold')
        .fillColor('#1976d2')
        .text('Informations Employé', 50, yPosition);

      yPosition += 25;
      doc.moveTo(50, yPosition).lineTo(doc.page.width - 50, yPosition).stroke('#e0e0e0');
      yPosition += 15;

      const employeInfo = [
        { label: 'Nom complet:', value: `${demande.nom} ${demande.prenom}` },
        { label: 'Matricule:', value: demande.matricule || 'Non spécifié' },
        { label: 'Poste:', value: demande.poste || 'Non spécifié' },
        { label: 'Email:', value: demande.adresse_mail }
      ];

      doc.fillColor('#000000').font('Helvetica');
      employeInfo.forEach(info => {
        doc.fontSize(11)
          .font('Helvetica-Bold')
          .text(info.label, 60, yPosition, { width: 150, continued: true })
          .font('Helvetica')
          .text(info.value, { width: 350 });
        yPosition += 20;
      });

      yPosition += 15;

      doc.fontSize(16)
        .font('Helvetica-Bold')
        .fillColor('#1976d2')
        .text('Détails de la Demande', 50, yPosition);

      yPosition += 25;
      doc.moveTo(50, yPosition).lineTo(doc.page.width - 50, yPosition).stroke('#e0e0e0');
      yPosition += 15;

      const typeDemandeLabel = demande.type_demande === 'conges' ? 'Congé' :
        demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';

      const typeCongeLabel = demande.type_demande === 'conges'
        ? getTypeCongeLabel(demande.type_conge, demande.type_conge_autre)
        : null;

      const demandeInfo = [
        { label: 'Type de demande:', value: typeDemandeLabel },
        { label: 'Motif:', value: demande.titre },
        { label: 'Date de départ:', value: formatDateShort(demande.date_depart) }
      ];

      if (demande.date_retour) {
        demandeInfo.push({ label: 'Date de retour:', value: formatDateShort(demande.date_retour) });
      }

      if (demande.type_demande === 'conges' && joursOuvres > 0) {
        demandeInfo.push({
          label: 'Nombre de jours ouvrés:',
          value: `${joursOuvres} jour${joursOuvres > 1 ? 's' : ''}`,
          highlight: true
        });
      }

      if (typeCongeLabel) {
        demandeInfo.push({ label: 'Type de congé:', value: typeCongeLabel });
      }

      if (demande.demi_journee) {
        demandeInfo.push({ label: 'Demi-journée:', value: 'Oui' });
      }

      if (demande.heure_depart) {
        demandeInfo.push({ label: 'Heure de départ:', value: demande.heure_depart });
      }

      if (demande.heure_retour) {
        demandeInfo.push({ label: 'Heure de retour:', value: demande.heure_retour });
      }

      if (demande.frais_deplacement) {
        demandeInfo.push({ label: 'Frais de déplacement:', value: `${demande.frais_deplacement} TND` });
      }

      doc.fillColor('#000000').font('Helvetica');
      demandeInfo.forEach(info => {
        if (yPosition > doc.page.height - 100) {
          doc.addPage();
          yPosition = 50;
        }

        doc.fontSize(11)
          .font('Helvetica-Bold')
          .text(info.label, 60, yPosition, { width: 150, continued: true });

        if (info.highlight) {
          doc.fillColor('#1976d2')
            .fontSize(14)
            .font('Helvetica-Bold')
            .text(info.value, { width: 350 });
          doc.fillColor('#000000').fontSize(11);
        } else {
          doc.font('Helvetica')
            .text(info.value, { width: 350 });
        }

        yPosition += 25;
      });

      const footerY = doc.page.height - 60;
      doc.rect(0, footerY, doc.page.width, 60).fill('#f5f5f5');
      doc.fillColor('#666666')
        .fontSize(9)
        .font('Helvetica')
        .text('Cet email est envoyé automatiquement par le système de gestion RH', 50, footerY + 20, {
          align: 'center',
          width: doc.page.width - 100
        });

      doc.text(`Généré le ${formatDateFR(new Date())}`, 50, footerY + 35, {
        align: 'center',
        width: doc.page.width - 100
      });

      doc.end();

    } catch (error) {
      reject(error);
    }
  });
}

// ==================== ATTENDANCE REPORT SYSTEM ====================

async function sendAttendanceReport() {
  try {
    const today = new Date();
    const day = today.getDay(); // 0=Sun, 1=Mon, ... 6=Sat

    // Skip weekends
    if (day === 0 || day === 6) {
      console.log("Weekend - no attendance report");
      return;
    }

    const todayStr = today.toISOString().split('T')[0];

    let startDate;
    let endDate;

    // Calculate date range
    if (day === 1) { // Monday
      const lastMonday = new Date(today);
      lastMonday.setDate(today.getDate() - 7);
      const lastFriday = new Date(today);
      lastFriday.setDate(today.getDate() - 3);
      startDate = lastMonday.toISOString().split('T')[0];
      endDate = lastFriday.toISOString().split('T')[0];
    } else { // Tuesday to Friday
      const monday = new Date(today);
      monday.setDate(today.getDate() - (day - 1));
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      startDate = monday.toISOString().split('T')[0];
      endDate = yesterday.toISOString().split('T')[0];
    }

    console.log(`📊 Attendance report range: ${startDate} -> ${endDate}`);

    // Get today's arrivals from attendance database
    const arrivals = await poolAttendance.query(`
      SELECT full_name, arrival_time
      FROM attendance_daily
      WHERE work_date = $1
      ORDER BY arrival_time
    `, [todayStr]);

    // Get weekly data from attendance database
    const weekData = await poolAttendance.query(`
      SELECT full_name, work_date, arrival_time, departure_time
      FROM attendance_daily
      WHERE work_date BETWEEN $1 AND $2
      ORDER BY work_date, full_name
    `, [startDate, endDate]);

    // Group weekly data by date
    const groupedByDate = {};
    weekData.rows.forEach(row => {
      if (!groupedByDate[row.work_date]) {
        groupedByDate[row.work_date] = [];
      }
      groupedByDate[row.work_date].push(row);
    });

    // Calculate statistics
    const totalPresentToday = arrivals.rows.length;
    const totalPresentWeek = weekData.rows.length;
    const uniqueEmployeesWeek = new Set(weekData.rows.map(r => r.full_name)).size;

    // Build HTML for arrivals
    const arrivalsHTML = arrivals.rows.map(r => `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${r.full_name}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${r.arrival_time || 'Not arrived'}</td>
      </tr>
    `).join('');

    // Build HTML for weekly data
    let weekHTML = '';
    for (const [date, records] of Object.entries(groupedByDate)) {
      weekHTML += `
        <tr>
          <td colspan="3" style="background-color: #e2e8f0; padding: 10px; font-weight: bold; color: #1e40af;">
            📅 ${formatDateFR(date)}
          </td>
        </tr>
      `;
      records.forEach(r => {
        weekHTML += `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${r.full_name}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">${r.arrival_time || 'N/A'}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">${r.departure_time || 'N/A'}</td>
          </tr>
        `;
      });
    }

    // Send email
    const mailOptions = {
      from: {
        name: 'Administration STS',
        address: 'administration.STS@avocarbon.com'
      },
      to: ['fethi.chaouachi@avocarbon.com', 'rami.mejri@avocarbon.com' ], // Manager's email
      subject: `📊 Rapport de Présence - ${formatDateFR(today)}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 900px; margin: 0 auto; background: #ffffff; }
            .header { 
              background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%);
              color: white; 
              padding: 25px; 
              border-radius: 10px 10px 0 0;
            }
            .stats-grid { 
              display: grid; 
              grid-template-columns: repeat(3, 1fr); 
              gap: 20px; 
              margin: 25px 0;
            }
            .stat-card { 
              background: #f8fafc; 
              padding: 20px; 
              border-radius: 10px; 
              text-align: center;
              border: 1px solid #e2e8f0;
            }
            .stat-number { 
              font-size: 32px; 
              font-weight: bold; 
              color: #2563eb; 
            }
            .section-title {
              color: #1e293b;
              font-size: 20px;
              font-weight: 600;
              margin: 30px 0 15px;
              padding-bottom: 8px;
              border-bottom: 3px solid #2563eb;
            }
            table { 
              width: 100%; 
              border-collapse: collapse; 
              margin: 15px 0;
              background: white;
              border-radius: 8px;
              overflow: hidden;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            th { 
              background-color: #2563eb; 
              color: white; 
              padding: 12px; 
              text-align: left;
            }
            td { padding: 10px; border-bottom: 1px solid #e2e8f0; }
            .footer { 
              margin-top: 30px; 
              padding: 20px; 
              border-top: 2px solid #e2e8f0; 
              font-size: 13px; 
              color: #64748b; 
              text-align: center;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin:0;">📊 Rapport de Présence</h1>
              <p style="margin:5px 0 0; opacity:0.9;">Période: ${formatDateFR(startDate)} → ${formatDateFR(endDate)}</p>
            </div>

            <div class="stats-grid">
              <div class="stat-card">
                <div class="stat-number">${totalPresentToday}</div>
                <div style="color: #475569;">Présents aujourd'hui</div>
              </div>
              <div class="stat-card">
                <div class="stat-number">${totalPresentWeek}</div>
                <div style="color: #475569;">Total présences semaine</div>
              </div>
              <div class="stat-card">
                <div class="stat-number">${uniqueEmployeesWeek}</div>
                <div style="color: #475569;">Employés distincts</div>
              </div>
            </div>

            <div class="section-title">
              ✅ Arrivées Aujourd'hui (${formatDateFR(todayStr)})
            </div>
            
            ${arrivals.rows.length > 0 ? `
            <table>
              <thead>
                <tr>
                  <th>Employé</th>
                  <th style="text-align: center;">Heure d'arrivée</th>
                </tr>
              </thead>
              <tbody>
                ${arrivalsHTML}
              </tbody>
            </table>
            ` : `
            <div style="background: #fef9c3; color: #854d0e; padding: 15px; border-radius: 8px;">
              ⚠️ Aucune arrivée enregistrée aujourd'hui
            </div>
            `}

            <div class="section-title">
              📅 Résumé Hebdomadaire
            </div>

            ${weekData.rows.length > 0 ? `
            <table>
              <thead>
                <tr>
                  <th>Employé</th>
                  <th style="text-align: center;">Arrivée</th>
                  <th style="text-align: center;">Départ</th>
                </tr>
              </thead>
              <tbody>
                ${weekHTML}
              </tbody>
            </table>
            
            <div style="background: #e8f4fd; padding: 15px; border-radius: 8px; margin-top: 15px;">
              <p style="margin:0; color: #1e40af;">
                <strong>📊 Statistiques détaillées:</strong><br>
                • Total des présences: ${totalPresentWeek}<br>
                • Moyenne journalière: ${Math.round(totalPresentWeek / Object.keys(groupedByDate).length || 1)} employés<br>
                • Jours avec données: ${Object.keys(groupedByDate).length} jour(s)<br>
                • Employés ayant pointé: ${uniqueEmployeesWeek}
              </p>
            </div>
            ` : `
            <div style="background: #fef9c3; color: #854d0e; padding: 15px; border-radius: 8px;">
              ⚠️ Aucune donnée de présence pour cette période
            </div>
            `}

            <div class="footer">
              <p>📧 Rapport généré automatiquement depuis la base de données "attendance"</p>
              <p>📅 ${formatDateFR(today)} à ${today.toLocaleTimeString('fr-FR')}</p>
            </div>
          </div>
        </body>
        </html>
      `
    };

    await sendEmailWithRetry(mailOptions, "Attendance report");
    console.log("✅ Attendance report sent successfully");

  } catch (error) {
    console.error("❌ Attendance report error:", error);
  }
}

// Manual trigger endpoint for attendance report
app.post('/api/attendance/send-report', async (req, res) => {
  try {
    await sendAttendanceReport();
    res.json({
      success: true,
      message: "Attendance report sent successfully"
    });
  } catch (error) {
    console.error("Error in manual attendance report:", error);
    res.status(500).json({
      error: "Error sending attendance report",
      details: error.message
    });
  }
});

// ==================== ROUTES API ====================

// Récupérer tous les employés actifs (sans date de départ)
app.get('/api/employees/actifs', async (req, res) => {
  try {
    const result = await poolHR.query(
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
    if (!employe_id || !type_document) {
      return res.status(400).json({
        error: 'Les champs employé et type de document sont obligatoires'
      });
    }

    console.log(`📄 Génération attestation pour employé ${employe_id}, type: ${type_document}`);

    const employeResult = await poolHR.query(
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

    if (type_document === 'attestation_salaire') {
      wordBuffer = await genererAttestationSalaireWord(employe);
      fileName = `Attestation_Salaire_${employe.nom}_${employe.prenom}.docx`;
      documentTypeLabel = 'Attestation de salaire';

      if (!employe.salaire_brute) {
        return res.status(400).json({
          error: 'Salaire non disponible pour cet employé'
        });
      }
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
        address: 'administration.STS@avocarbon.com'
      },
      to: 'fethi.chaouachi@avocarbon.com',
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

    const employeResult = await poolHR.query(
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
    if (!employe_id || !type_demande || !titre || !date_depart) {
      return res.status(400).json({
        error: 'Les champs employé, type de demande, titre et date de départ sont obligatoires'
      });
    }

    console.log(`📋 Création demande ${type_demande} pour employé ${employe_id}: ${titre}`);

    const employeResult = await poolHR.query(
      `SELECT nom, prenom, poste, adresse_mail, mail_responsable1, mail_responsable2
       FROM employees WHERE id = $1`,
      [employe_id]
    );

    if (employeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Employé non trouvé' });
    }

    const employe = employeResult.rows[0];
    employe.id = employe_id; // ✅ Set employee ID for leave balance lookup

    const dateRetourFinal = date_retour && date_retour !== '' ? date_retour : null;
    const heureDepartFinal = heure_depart && heure_depart !== '' ? heure_depart : null;
    const heureRetourFinal = heure_retour && heure_retour !== '' ? heure_retour : null;
    const fraisDeplacementFinal = frais_deplacement && frais_deplacement !== '' ? parseFloat(frais_deplacement) : null;
    const typeCongeFinal = type_conge && type_conge !== '' ? type_conge : null;
    const typeCongeAutreFinal = type_conge_autre && type_conge_autre.trim() !== '' ? type_conge_autre.trim() : null;

    const insertResult = await poolHR.query(
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

// Fonction pour envoyer email au responsable
async function envoyerEmailResponsable(employe, emailResponsable, demandeId, niveau, details, premierResponsable = null) {
  const baseUrl = BASE_URL;
  const lienApprobation = `${baseUrl}/approuver-demande?id=${demandeId}&niveau=${niveau}`;

  let typeLabel = details.type_demande === 'conges' ? 'Congé' :
    details.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';

  // Récupérer solde congé depuis leave_balances
  let leaveBalanceValue = '0.000';
  try {
    const employeeId = employe?.id || employe?.employe_id || employe?.employee_id;
    if (employeeId) {
      const lb = await poolHR.query(
        `SELECT balance FROM leave_balances WHERE employee_id = $1`,
        [employeeId]
      );
      if (lb.rows.length > 0 && lb.rows[0].balance !== undefined && lb.rows[0].balance !== null) {
        leaveBalanceValue = String(lb.rows[0].balance);
      }
    }
  } catch (e) {
    console.error('❌ Erreur récupération solde congé:', e.message);
  }

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
    // ✅ MODIFICATION : ajout du type de demande dans l'objet de l'email
    subject: `${niveau === 2 && premierResponsable ? '✓ ' : ''}Nouvelle demande RH [${typeLabel}] - ${employe.nom} ${employe.prenom}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">
          ${niveau === 2 && premierResponsable ? 'Demande approuvée par le premier responsable - ' : ''}Demande RH en attente d'approbation
        </h2>
        ${infoPremierApprobation}
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Employé:</strong> ${employe.nom} ${employe.prenom}</p>
          <p><strong>Poste:</strong> ${employe.poste}</p>
          <p><strong>Solde de congé:</strong> ${leaveBalanceValue}</p>
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
  }
}

// Page d'approbation/refus de demande
app.get('/approuver-demande', async (req, res) => {
  const { id, niveau } = req.query;

  console.log(`🔗 Accès page approbation demande ${id}, niveau ${niveau}`);

  try {
    const result = await poolHR.query(
      `SELECT d.*, e.nom, e.prenom, e.poste, e.adresse_mail, 
              e.mail_responsable1, e.mail_responsable2,
              COALESCE(lb.balance, 0.000) AS solde_conge
       FROM demande_rh d
       JOIN employees e ON d.employe_id = e.id
       LEFT JOIN leave_balances lb ON lb.employee_id = e.id
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

    const resp1 = demande.mail_responsable1 ? extraireNomPrenomDepuisEmail(demande.mail_responsable1) : null;
    const resp2 = demande.mail_responsable2 ? extraireNomPrenomDepuisEmail(demande.mail_responsable2) : null;

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

            ${demande.type_demande === 'conges' ? `
            <div class="info-item">
              <div class="info-label">Solde congé:</div>
              <div class="info-value">${demande.solde_conge}</div>
            </div>
            ` : ''}

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

// ==================== ROUTE D'APPROBATION ====================

// Approuver une demande
app.post('/api/demandes/:id/approuver', async (req, res) => {
  const { id } = req.params;
  const { niveau } = req.body;

  console.log(`✅ Approbation demande ${id}, niveau ${niveau}`);

  try {
    const demandeResult = await poolHR.query(
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

    // ✅ FIX: set .id to the employee ID (not the demande ID) for leave balance lookup
    demande.id = demande.employe_id;

    if (demande.statut !== 'en_attente') {
      console.log(`ℹ️ Demande ${id} déjà traitée: ${demande.statut}`);
      return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
    }

    const colonne = niveau == 1 ? 'approuve_responsable1' : 'approuve_responsable2';

    await poolHR.query(
      `UPDATE demande_rh SET ${colonne} = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );

    const resp1 = demande.mail_responsable1 ? extraireNomPrenomDepuisEmail(demande.mail_responsable1) : null;
    const resp2 = demande.mail_responsable2 ? extraireNomPrenomDepuisEmail(demande.mail_responsable2) : null;

    // CAS 1 : Niveau 1 & responsable 2 existe → mail étape 1 + mail à R2
    if (niveau == 1 && demande.mail_responsable2) {
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
    await poolHR.query(
      `UPDATE demande_rh SET statut = 'approuve' WHERE id = $1`,
      [id]
    );

    let approuveur = null;
    if (niveau == 1 && !demande.mail_responsable2) {
      approuveur = resp1;
    } else if (niveau == 2) {
      approuveur = resp2;
    }

    const typeCongeLabel = demande.type_demande === 'conges'
      ? getTypeCongeLabel(demande.type_conge, demande.type_conge_autre)
      : null;

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

    // Calcul du nombre de jours ouvrés pour les congés
    let joursOuvres = 0;
    if (demande.type_demande === 'conges' && demande.date_retour) {
      joursOuvres = calculerJoursOuvres(demande.date_depart, demande.date_retour);
    }

    // 2. EMAIL À L'ÉQUIPE RH - Avec PDF en pièce jointe
    try {
      const pdfBuffer = await genererPDFDemandeApprouvee(demande, joursOuvres);
      const pdfFileName = `Demande_RH_${demande.nom}_${demande.prenom}_${new Date().getTime()}.pdf`;

      await sendEmailWithRetry({
        from: {
          name: 'Administration STS',
          address: 'administration.STS@avocarbon.com'
        },
        to: 'nesria.ibrahim@avocarbon.com',
        subject: `📋 Demande RH approuvée - ${demande.nom} ${demande.prenom}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1976d2; border-bottom: 3px solid #1976d2; padding-bottom: 10px;">
              📋 Nouvelle demande RH approuvée
            </h2>
            <div style="background: #e3f2fd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #1976d2;">
              <p style="margin: 0; color: #1565c0; font-weight: 500;">
                ℹ️ Une demande RH vient d'être approuvée et nécessite votre attention pour le suivi administratif.
              </p>
            </div>
            <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Employé:</strong> ${demande.nom} ${demande.prenom}</p>
              <p><strong>Type de demande:</strong> ${demande.type_demande === 'conges' ? 'Congé' : demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission'}</p>
              <p><strong>Date de départ:</strong> ${formatDateShort(demande.date_depart)}</p>
              ${joursOuvres > 0 ? `<p><strong>Nombre de jours ouvrés:</strong> <span style="color: #1976d2; font-size: 18px; font-weight: bold;">${joursOuvres} jour${joursOuvres > 1 ? 's' : ''}</span></p>` : ''}
            </div>
            <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
              📎 Veuillez consulter le fichier PDF joint pour tous les détails de la demande.
            </p>
          </div>
        `,
        attachments: [
          {
            filename: pdfFileName,
            content: pdfBuffer,
            contentType: 'application/pdf'
          }
        ]
      }, 'Notification RH - Demande approuvée (PDF)');

      console.log(`✅ PDF généré et envoyé à l'équipe RH: ${pdfFileName} (${pdfBuffer.length} octets)`);

    } catch (pdfError) {
      console.error('❌ Erreur génération/envoi PDF:', pdfError);
    }

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
    const demandeResult = await poolHR.query(
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

    await poolHR.query(
      `UPDATE demande_rh 
       SET statut = 'refuse', 
           commentaire_refus = $1, 
           ${colonneRefus} = false,
           updated_at = CURRENT_TIMESTAMP 
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

    const typeCongeLabel = demande.type_demande === 'conges'
      ? getTypeCongeLabel(demande.type_conge, demande.type_conge_autre)
      : null;

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
    const result = await poolHR.query(
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
        address: 'administration.STS@avocarbon.com'
      },
      to: 'rami.mejri@avocarbon.com',
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

// ==================== CRON JOB FOR AUTOMATIC ATTENDANCE REPORTS ====================

// Schedule automatic reports (Mon-Fri at 9 AM Tunisia time)
try {
  const cron = require('node-cron');
  
  // Schedule the job
  cron.schedule('0 9 * * 1-5', async () => {
    console.log("⏰ Running automatic attendance report...");
    await sendAttendanceReport();
  }, {
    timezone: "Africa/Tunis"
  });
  
  console.log("✅ Attendance reports scheduled for weekdays at 9:00 AM Tunisia time");
  
} catch (error) {
  console.warn("⚠️ Cron scheduling not available. To enable automatic reports, run: npm install node-cron");
  console.warn("Error details:", error.message);
}

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
  📊 API Rapport Présence: http://localhost:${PORT}/api/attendance/send-report
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
