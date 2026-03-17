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
  database: 'attendance',
  password: process.env.DB_PASS || 'St$@0987',
  port: process.env.DB_PORT || 5432,
  ssl: { rejectUnauthorized: false }
});

// ==================== CONFIGURATION SMTP ====================

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

emailPool.init(3);

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

async function sendEmailWithRetry(mailOptions, context, maxRetries = 3) {
  let lastError;

  logEmailDetails(mailOptions, context, 1);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const transporter = emailPool.getTransporter();

    try {
      if (mailOptions.attachments && mailOptions.attachments.length > 0) {
        const totalSize = mailOptions.attachments.reduce((sum, att) => {
          return sum + (att.content?.length || 0);
        }, 0);
        if (totalSize > 10 * 1024 * 1024) {
          console.warn(`⚠️ Taille totale des pièces jointes élevée: ${Math.round(totalSize / 1024 / 1024)}MB`);
        }
      }

      const info = await transporter.sendMail(mailOptions);
      console.log(`✅ Email envoyé avec succès (tentative ${attempt}/${maxRetries})`);
      console.log(`   Message ID: ${info.messageId}`);
      return { success: true, messageId: info.messageId, attempt };

    } catch (error) {
      lastError = error;
      console.error(`❌ Échec envoi email ${context} (tentative ${attempt}/${maxRetries}):`, error.message);

      if (attempt < maxRetries) {
        const baseDelay = 1000;
        const maxDelay = 10000;
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

  try {
    console.log('🔄 Tentative avec nouveau transporteur...');
    const emergencyTransporter = createTransporter();
    const info = await emergencyTransporter.sendMail(mailOptions);
    console.log('✅ Email envoyé avec transporteur d\'urgence');
    return { success: true, messageId: info.messageId, attempt: 'emergency', warning: 'Sent with emergency transporter' };
  } catch (emergencyError) {
    console.error('💥 Échec même avec transporteur d\'urgence:', emergencyError.message);
    throw {
      message: `Échec d'envoi après ${maxRetries} tentatives et transporteur d'urgence`,
      originalError: lastError,
      emergencyError,
      context
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
  if (typeof date === 'string' && date.match(/^\d{2}\/\d{2}\/\d{4}$/)) return date;
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
  if (type_conge === 'autre') return `Autre${type_conge_autre ? ` (${type_conge_autre})` : ''}`;
  return type_conge;
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

// ==================== ADVISORY LOCK FUNCTIONS (prevents duplicate emails on Azure multi-instance) ====================

const acquireJobLock = async (lockId) => {
  const instanceId = process.env.WEBSITE_INSTANCE_ID || `instance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    const lockHash = Math.abs(lockId.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0));

    const result = await poolHR.query('SELECT pg_try_advisory_lock($1) as acquired', [lockHash]);

    if (result.rows[0].acquired) {
      console.log(`🔒 Instance ${instanceId} acquired lock "${lockId}" (hash: ${lockHash})`);
      return { acquired: true, instanceId, lockHash };
    } else {
      console.log(`⏭️ Instance ${instanceId} failed to acquire lock "${lockId}" — another instance is handling this job`);
      return { acquired: false, instanceId, lockHash };
    }
  } catch (error) {
    console.error(`❌ Error acquiring lock "${lockId}":`, error.message);
    return { acquired: false, instanceId, error: error.message };
  }
};

const releaseJobLock = async (lockId, instanceId, lockHash) => {
  try {
    if (lockHash) {
      await poolHR.query('SELECT pg_advisory_unlock($1)', [lockHash]);
      console.log(`🔓 Instance ${instanceId} released lock "${lockId}"`);
    }
  } catch (error) {
    console.error(`⚠️ Could not release lock "${lockId}":`, error.message);
  }
};

// ==================== DOCUMENT GENERATION FUNCTIONS ====================

async function genererAttestationTravailWord(employe) {
  try {
    try {
      await fs.access(TEMPLATE_TRAVAIL_PATH);
    } catch (error) {
      throw new Error('Template Word non trouvé. Placez-le dans le dossier templates/');
    }

    const templateBuffer = await fs.readFile(TEMPLATE_TRAVAIL_PATH);
    const reference = genererReference(employe.nom, employe.prenom);

    const data = {
      reference,
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

async function genererAttestationSalaireWord(employe) {
  try {
    try {
      await fs.access(TEMPLATE_SALAIRE_PATH);
    } catch (error) {
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
      reference,
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
    if (jourSemaine >= 1 && jourSemaine <= 5) joursOuvres++;
    dateActuelle.setDate(dateActuelle.getDate() + 1);
  }
  return joursOuvres;
}

async function genererPDFDemandeApprouvee(demande, joursOuvres = 0) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 } });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.rect(0, 0, doc.page.width, 80).fill('#1976d2');
      doc.fillColor('#ffffff').fontSize(24).font('Helvetica-Bold')
        .text('Demande RH Approuvée', 50, 30, { align: 'center' });
      doc.fillColor('#000000');

      doc.rect(50, 100, doc.page.width - 100, 60).fillAndStroke('#e3f2fd', '#1976d2');
      doc.fillColor('#1565c0').fontSize(12).font('Helvetica-Bold')
        .text('Une demande RH vient d\'être approuvée', 60, 115)
        .font('Helvetica')
        .text('Cette demande nécessite votre attention pour le suivi administratif.', 60, 135);
      doc.fillColor('#000000');

      let yPosition = 180;

      doc.fontSize(16).font('Helvetica-Bold').fillColor('#1976d2').text('Informations Employé', 50, yPosition);
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
        doc.fontSize(11).font('Helvetica-Bold').text(info.label, 60, yPosition, { width: 150, continued: true })
          .font('Helvetica').text(info.value, { width: 350 });
        yPosition += 20;
      });

      yPosition += 15;
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#1976d2').text('Détails de la Demande', 50, yPosition);
      yPosition += 25;
      doc.moveTo(50, yPosition).lineTo(doc.page.width - 50, yPosition).stroke('#e0e0e0');
      yPosition += 15;

      const typeDemandeLabel = demande.type_demande === 'conges' ? 'Congé' :
        demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';
      const typeCongeLabel = demande.type_demande === 'conges'
        ? getTypeCongeLabel(demande.type_conge, demande.type_conge_autre) : null;

      const demandeInfo = [
        { label: 'Type de demande:', value: typeDemandeLabel },
        { label: 'Motif:', value: demande.titre },
        { label: 'Date de départ:', value: formatDateShort(demande.date_depart) }
      ];

      if (demande.date_retour) demandeInfo.push({ label: 'Date de retour:', value: formatDateShort(demande.date_retour) });
      if (demande.type_demande === 'conges' && joursOuvres > 0) {
        demandeInfo.push({ label: 'Nombre de jours ouvrés:', value: `${joursOuvres} jour${joursOuvres > 1 ? 's' : ''}`, highlight: true });
      }
      if (typeCongeLabel) demandeInfo.push({ label: 'Type de congé:', value: typeCongeLabel });
      if (demande.demi_journee) demandeInfo.push({ label: 'Demi-journée:', value: 'Oui' });
      if (demande.heure_depart) demandeInfo.push({ label: 'Heure de départ:', value: demande.heure_depart });
      if (demande.heure_retour) demandeInfo.push({ label: 'Heure de retour:', value: demande.heure_retour });
      if (demande.frais_deplacement) demandeInfo.push({ label: 'Frais de déplacement:', value: `${demande.frais_deplacement} TND` });

      doc.fillColor('#000000').font('Helvetica');
      demandeInfo.forEach(info => {
        if (yPosition > doc.page.height - 100) { doc.addPage(); yPosition = 50; }
        doc.fontSize(11).font('Helvetica-Bold').text(info.label, 60, yPosition, { width: 150, continued: true });
        if (info.highlight) {
          doc.fillColor('#1976d2').fontSize(14).font('Helvetica-Bold').text(info.value, { width: 350 });
          doc.fillColor('#000000').fontSize(11);
        } else {
          doc.font('Helvetica').text(info.value, { width: 350 });
        }
        yPosition += 25;
      });

      const footerY = doc.page.height - 60;
      doc.rect(0, footerY, doc.page.width, 60).fill('#f5f5f5');
      doc.fillColor('#666666').fontSize(9).font('Helvetica')
        .text('Cet email est envoyé automatiquement par le système de gestion RH', 50, footerY + 20, { align: 'center', width: doc.page.width - 100 });
      doc.text(`Généré le ${formatDateFR(new Date())}`, 50, footerY + 35, { align: 'center', width: doc.page.width - 100 });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// ==================== ATTENDANCE REPORT SYSTEM ====================

async function sendAttendanceReport() {
  const lockId = 'attendance_report_job';
  const lock = await acquireJobLock(lockId);

  if (!lock.acquired) {
    console.log(`⏭️ [Attendance Report] Skipping — lock held by another instance`);
    return;
  }

  try {
    const today = new Date();
    const day = today.getDay();

    if (day === 0 || day === 6) {
      console.log("Weekend - no attendance report");
      return;
    }

    const todayStr = today.toISOString().split('T')[0];

    let startDate, endDate;

    if (day === 1) {
      const lastMonday = new Date(today);
      lastMonday.setDate(today.getDate() - 7);
      const lastFriday = new Date(today);
      lastFriday.setDate(today.getDate() - 3);
      startDate = lastMonday.toISOString().split('T')[0];
      endDate = lastFriday.toISOString().split('T')[0];
    } else {
      const monday = new Date(today);
      monday.setDate(today.getDate() - (day - 1));
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      startDate = monday.toISOString().split('T')[0];
      endDate = yesterday.toISOString().split('T')[0];
    }

    console.log(`📊 Attendance report range: ${startDate} -> ${endDate}`);

    const arrivals = await poolAttendance.query(`
      SELECT full_name, arrival_time
      FROM attendance_daily
      WHERE work_date = $1
      ORDER BY arrival_time
    `, [todayStr]);

    const weekData = await poolAttendance.query(`
      SELECT full_name, work_date, arrival_time, departure_time
      FROM attendance_daily
      WHERE work_date BETWEEN $1 AND $2
      ORDER BY work_date, full_name
    `, [startDate, endDate]);

    const groupedByDate = {};
    weekData.rows.forEach(row => {
      if (!groupedByDate[row.work_date]) groupedByDate[row.work_date] = [];
      groupedByDate[row.work_date].push(row);
    });

    const totalPresentToday = arrivals.rows.length;
    const totalPresentWeek = weekData.rows.length;
    const avgPerDay = Object.keys(groupedByDate).length > 0
      ? Math.round(totalPresentWeek / Object.keys(groupedByDate).length)
      : 0;

    const totalEmployeesResult = await poolAttendance.query(`SELECT COUNT(*) as total FROM employees`);
    const totalEmployees = parseInt(totalEmployeesResult.rows[0].total);

    const arrivalsRows = arrivals.rows.map((r, i) => `
      <tr style="border-bottom:1px solid #f3f4f6; ${i % 2 !== 0 ? 'background:#fafafa;' : ''}">
        <td style="padding:10px 10px; color:#374151; font-size:14px;">${r.full_name}</td>
        <td style="padding:10px 10px; text-align:center; color:#374151; font-size:14px;">${r.arrival_time || '—'}</td>
      </tr>
    `).join('');

    let weekRows = '';
    let rowIndex = 0;
    for (const [date, records] of Object.entries(groupedByDate)) {
      const dateObj = new Date(date);
      const dayName = dateObj.toLocaleDateString('fr-FR', { weekday: 'long' }).toUpperCase();
      weekRows += `
        <tr>
          <td colspan="3" style="padding:8px 10px; background:#f3f4f6; font-size:12px; font-weight:700; color:#374151; letter-spacing:0.5px;">
            ${dayName} ${formatDateFR(date)}
          </td>
        </tr>
      `;
      records.forEach(r => {
        weekRows += `
          <tr style="border-bottom:1px solid #f3f4f6; ${rowIndex % 2 !== 0 ? 'background:#fafafa;' : ''}">
            <td style="padding:10px 10px; color:#374151; font-size:14px;">${r.full_name}</td>
            <td style="padding:10px 10px; text-align:center; color:#374151; font-size:14px;">${r.arrival_time || '—'}</td>
            <td style="padding:10px 10px; text-align:center; color:${r.departure_time ? '#374151' : '#9ca3af'}; font-size:14px;">${r.departure_time || '—'}</td>
          </tr>
        `;
        rowIndex++;
      });
    }

    const mailOptions = {
      from: {
        name: 'Administration STS',
        address: 'administration.STS@avocarbon.com'
      },
      to: 'fethi.chaouachi@avocarbon.com',
      subject: `Rapport de Présence — ${formatDateFR(today)}`,
      html: `
        <!DOCTYPE html>
        <html lang="fr">
        <head>
          <meta charset="UTF-8">
        </head>
        <body style="margin:0; padding:30px 20px; background:#f4f4f4; font-family: Arial, sans-serif;">

          <div style="width:100%; background:#ffffff; border:1px solid #ddd; border-radius:6px; overflow:hidden;">

            <!-- HEADER -->
            <div style="background:#2d4a6e; padding:24px 32px;">
              <p style="margin:0; color:#94a3b8; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Administration STS</p>
              <h1 style="margin:6px 0 0; color:#ffffff; font-size:20px; font-weight:700;">Rapport de Présence</h1>
              <p style="margin:4px 0 0; color:#94a3b8; font-size:13px;">
                ${today.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                — ${today.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>

            <!-- STATS -->
            <div style="display:flex; border-bottom:1px solid #e5e7eb;">
              <div style="flex:1; padding:20px; text-align:center; border-right:1px solid #e5e7eb;">
                <div style="font-size:32px; font-weight:700; color:#1e293b;">${totalPresentToday}</div>
                <div style="font-size:12px; color:#6b7280; margin-top:3px;">Présents aujourd'hui</div>
              </div>
              <div style="flex:1; padding:20px; text-align:center; border-right:1px solid #e5e7eb;">
                <div style="font-size:32px; font-weight:700; color:#1e293b;">${totalPresentWeek}</div>
                <div style="font-size:12px; color:#6b7280; margin-top:3px;">Présences cette semaine</div>
              </div>
              <div style="flex:1; padding:20px; text-align:center;">
                <div style="font-size:32px; font-weight:700; color:#1e293b;">${totalEmployees}</div>
                <div style="font-size:12px; color:#6b7280; margin-top:3px;">Total employés</div>
              </div>
            </div>

            <div style="padding:28px 32px;">

              <!-- TODAY'S ARRIVALS -->
              <p style="margin:0 0 12px; font-size:13px; font-weight:700; color:#1e293b; text-transform:uppercase; letter-spacing:0.5px;">
                Arrivées du jour — ${formatDateFR(todayStr)}
              </p>

              ${arrivals.rows.length > 0 ? `
              <table style="width:100%; border-collapse:collapse; margin-bottom:32px; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #1e293b;">
                    <th style="text-align:left; padding:8px 10px; color:#374151; font-weight:600;">Employé</th>
                    <th style="text-align:center; padding:8px 10px; color:#374151; font-weight:600;">Heure d'arrivée</th>
                  </tr>
                </thead>
                <tbody>
                  ${arrivalsRows}
                </tbody>
              </table>
              ` : `
              <div style="background:#fffbeb; border:1px solid #fde68a; color:#92400e; padding:14px 18px; border-radius:6px; font-size:13px; margin-bottom:32px;">
                ⚠️ Aucune arrivée enregistrée aujourd'hui
              </div>
              `}

              <!-- WEEKLY SUMMARY -->
              <p style="margin:0 0 12px; font-size:13px; font-weight:700; color:#1e293b; text-transform:uppercase; letter-spacing:0.5px;">
                Résumé hebdomadaire — ${formatDateFR(startDate)} → ${formatDateFR(endDate)}
              </p>

              ${weekData.rows.length > 0 ? `
              <table style="width:100%; border-collapse:collapse; font-size:14px; margin-bottom:24px;">
                <thead>
                  <tr style="border-bottom:2px solid #1e293b;">
                    <th style="text-align:left; padding:8px 10px; color:#374151; font-weight:600;">Employé</th>
                    <th style="text-align:center; padding:8px 10px; color:#374151; font-weight:600;">Arrivée</th>
                    <th style="text-align:center; padding:8px 10px; color:#374151; font-weight:600;">Départ</th>
                  </tr>
                </thead>
                <tbody>
                  ${weekRows}
                </tbody>
              </table>

              <!-- SUMMARY -->
              <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px; padding:16px 20px; font-size:13px; color:#374151;">
                <strong style="display:block; margin-bottom:8px; color:#1e293b;">Statistiques</strong>
                Total présences : <strong>${totalPresentWeek}</strong> &nbsp;•&nbsp;
                Moyenne/jour : <strong>${avgPerDay} employés</strong> &nbsp;•&nbsp;
                Jours avec données : <strong>${Object.keys(groupedByDate).length}</strong> &nbsp;•&nbsp;
                Total employés : <strong>${totalEmployees}</strong>
              </div>
              ` : `
              <div style="background:#fffbeb; border:1px solid #fde68a; color:#92400e; padding:14px 18px; border-radius:6px; font-size:13px;">
                ⚠️ Aucune donnée de présence pour cette période
              </div>
              `}

            </div>

            <!-- FOOTER -->
            <div style="background:#f9fafb; border-top:1px solid #e5e7eb; padding:16px 32px; text-align:center;">
              <p style="margin:0; font-size:12px; color:#9ca3af;">
                Rapport automatique — Système RH STS &nbsp;•&nbsp; ${formatDateFR(today)} à ${today.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
              </p>
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
  } finally {
    await releaseJobLock(lockId, lock.instanceId, lock.lockHash);
  }
}

// Manual trigger endpoint
app.post('/api/attendance/send-report', async (req, res) => {
  try {
    await sendAttendanceReport();
    res.json({ success: true, message: "Attendance report sent successfully" });
  } catch (error) {
    console.error("Error in manual attendance report:", error);
    res.status(500).json({ error: "Error sending attendance report", details: error.message });
  }
});

// ==================== ROUTES API ====================

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

app.post('/api/generer-attestation', async (req, res) => {
  const { employe_id, type_document } = req.body;

  try {
    if (!employe_id || !type_document) {
      return res.status(400).json({ error: 'Les champs employé et type de document sont obligatoires' });
    }

    const employeResult = await poolHR.query(
      `SELECT nom, prenom, poste, adresse_mail, date_debut, 
              date_naissance, cin, matricule, salaire_brute
       FROM employees WHERE id = $1`,
      [employe_id]
    );

    if (employeResult.rows.length === 0) return res.status(404).json({ error: 'Employé non trouvé' });

    const employe = employeResult.rows[0];
    let wordBuffer, fileName, documentTypeLabel;

    if (type_document === 'attestation_salaire') {
      if (!employe.salaire_brute) return res.status(400).json({ error: 'Salaire non disponible pour cet employé' });
      wordBuffer = await genererAttestationSalaireWord(employe);
      fileName = `Attestation_Salaire_${employe.nom}_${employe.prenom}.docx`;
      documentTypeLabel = 'Attestation de salaire';
    } else {
      wordBuffer = await genererAttestationTravailWord(employe);
      fileName = `Attestation_Travail_${employe.nom}_${employe.prenom}.docx`;
      documentTypeLabel = 'Attestation de travail';
    }

    const optimizedAttachments = await optimizeAttachments([{
      filename: fileName,
      content: wordBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }]);

    const mailOptions = {
      from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
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
    res.json({ success: true, message: `${documentTypeLabel} générée et envoyée avec succès`, fileName, emailResult });

  } catch (err) {
    console.error('❌ Erreur génération attestation:', err);
    res.status(500).json({ error: 'Erreur lors de la génération du document: ' + err.message });
  }
});

app.post('/api/telecharger-attestation', async (req, res) => {
  const { employe_id, type_document } = req.body;

  try {
    if (!employe_id) return res.status(400).json({ error: 'ID employé requis' });

    const employeResult = await poolHR.query(
      `SELECT nom, prenom, poste, date_debut, date_naissance, cin, salaire_brute
       FROM employees WHERE id = $1`,
      [employe_id]
    );

    if (employeResult.rows.length === 0) return res.status(404).json({ error: 'Employé non trouvé' });

    const employe = employeResult.rows[0];
    let wordBuffer, fileName;

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
      return res.status(400).json({ error: 'Les champs employé, type de demande, titre et date de départ sont obligatoires' });
    }

    const employeResult = await poolHR.query(
      `SELECT nom, prenom, poste, adresse_mail, mail_responsable1, mail_responsable2
       FROM employees WHERE id = $1`,
      [employe_id]
    );

    if (employeResult.rows.length === 0) return res.status(404).json({ error: 'Employé non trouvé' });

    const employe = employeResult.rows[0];
    employe.id = employe_id;

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
      [employe_id, type_demande, titre, date_depart, dateRetourFinal,
        heureDepartFinal, heureRetourFinal, demi_journee || false,
        typeCongeFinal, typeCongeAutreFinal, fraisDeplacementFinal, 'en_attente']
    );

    const demandeId = insertResult.rows[0].id;

    // ========== DEBUG LOGS - EMAIL ROUTING ==========
    console.log(`\n🔍 [DEBUG] New demande created:`);
    console.log(`   Demande ID  : ${demandeId}`);
    console.log(`   Employee    : ${employe.nom} ${employe.prenom} (id: ${employe_id})`);
    console.log(`   Type        : ${type_demande}`);
    console.log(`   Responsable1: ${employe.mail_responsable1 || 'NOT SET'}`);
    console.log(`   Responsable2: ${employe.mail_responsable2 || 'NOT SET'}`);
    // ================================================

    if (employe.mail_responsable1) {
      // ========== DEBUG LOG ==========
      console.log(`📤 [DEBUG][DEMANDE ${demandeId}] Sending email to responsable1: ${employe.mail_responsable1}`);
      // ================================

      const emailResult = await envoyerEmailResponsable(employe, employe.mail_responsable1, demandeId, 1, {
        type_demande, titre, date_depart,
        date_retour: dateRetourFinal,
        heure_depart: heureDepartFinal,
        heure_retour: heureRetourFinal,
        demi_journee,
        type_conge: typeCongeFinal,
        type_conge_autre: typeCongeAutreFinal,
        frais_deplacement: fraisDeplacementFinal
      });

      // ========== DEBUG LOG ==========
      console.log(`📬 [DEBUG][DEMANDE ${demandeId}] Email to responsable1 result:`, JSON.stringify(emailResult));
      // ================================
    } else {
      console.warn(`⚠️ [DEBUG][DEMANDE ${demandeId}] No responsable1 defined for ${employe.nom} ${employe.prenom} — no email sent`);
    }

    res.json({ success: true, message: 'Demande créée avec succès', demandeId });
  } catch (err) {
    console.error('❌ Erreur création demande:', err);
    res.status(500).json({ error: 'Erreur lors de la création de la demande: ' + err.message });
  }
});

async function envoyerEmailResponsable(employe, emailResponsable, demandeId, niveau, details, premierResponsable = null) {

  // ========== DEBUG LOGS ==========
  console.log(`\n📨 [DEBUG][envoyerEmailResponsable] Called:`);
  console.log(`   Employee    : ${employe.nom} ${employe.prenom}`);
  console.log(`   Recipient   : ${emailResponsable}`);
  console.log(`   Demande ID  : ${demandeId}`);
  console.log(`   Niveau      : ${niveau}`);
  console.log(`   employe.id  : ${employe.id || employe.employe_id || 'UNDEFINED'}`);
  // ================================

  const baseUrl = BASE_URL;
  const lienApprobation = `${baseUrl}/approuver-demande?id=${demandeId}&niveau=${niveau}`;

  let typeLabel = details.type_demande === 'conges' ? 'Congé' :
    details.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';

  let leaveBalanceValue = '0.000';
  try {
    const employeeId = employe?.id || employe?.employe_id || employe?.employee_id;

    // ========== DEBUG LOG ==========
    console.log(`   [DEBUG] employeeId for leave balance lookup: ${employeeId}`);
    // ================================

    if (employeeId) {
      const lb = await poolHR.query(`SELECT balance FROM leave_balances WHERE employee_id = $1`, [employeeId]);

      // ========== DEBUG LOG ==========
      console.log(`   [DEBUG] Leave balance query returned ${lb.rows.length} row(s): ${lb.rows.length > 0 ? lb.rows[0].balance : 'none'}`);
      // ================================

      if (lb.rows.length > 0 && lb.rows[0].balance !== undefined && lb.rows[0].balance !== null) {
        leaveBalanceValue = String(lb.rows[0].balance);
      }
    }
  } catch (e) {
    console.error(`   [DEBUG] ❌ Erreur récupération solde congé:`, e.message);
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
    from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
    to: emailResponsable,
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
        <div style="margin: 20px 0;">${detailsHtml}</div>
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
    // ========== DEBUG LOG ==========
    console.log(`📤 [DEBUG][DEMANDE ${demandeId}] Attempting sendEmailWithRetry to: ${emailResponsable}`);
    // ================================

    await sendEmailWithRetry(mailOptions, `Notification demande RH niveau ${niveau}`);

    // ========== DEBUG LOG ==========
    console.log(`✅ [DEBUG][DEMANDE ${demandeId}] Email successfully sent to: ${emailResponsable} (niveau ${niveau})`);
    // ================================

    console.log(`✅ Email envoyé à ${emailResponsable} pour demande ${demandeId} (niveau ${niveau})`);
    return { success: true };
  } catch (error) {
    // ========== DEBUG LOG ==========
    console.error(`❌ [DEBUG][DEMANDE ${demandeId}] FAILED to send to: ${emailResponsable} (niveau ${niveau})`);
    console.error(`   Error code   : ${error.code || 'N/A'}`);
    console.error(`   Error message: ${error.message || JSON.stringify(error)}`);
    // ================================

    console.error(`❌ Erreur envoi email à responsable ${niveau}:`, error);
    return { success: false, error: error.message };
  }
}

app.get('/approuver-demande', async (req, res) => {
  const { id, niveau } = req.query;

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
        <html><body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: #ef4444;">Demande non trouvée</h1>
          <p>La demande que vous cherchez n'existe pas ou a déjà été traitée.</p>
        </body></html>
      `);
    }

    const demande = result.rows[0];

    if (demande.statut !== 'en_attente') {
      return res.send(`
        <html><body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: #6b7280;">Demande déjà traitée</h1>
          <p>Cette demande a déjà été ${demande.statut === 'approuve' ? 'approuvée' : 'refusée'}.</p>
        </body></html>
      `);
    }

    const typeDemandeLabel = demande.type_demande === 'conges' ? 'Congé' :
      demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';
    const typeCongeLabel = demande.type_demande === 'conges'
      ? getTypeCongeLabel(demande.type_conge, demande.type_conge_autre) : null;

    const resp1 = demande.mail_responsable1 ? extraireNomPrenomDepuisEmail(demande.mail_responsable1) : null;
    const resp2 = demande.mail_responsable2 ? extraireNomPrenomDepuisEmail(demande.mail_responsable2) : null;

    res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Approbation Demande RH</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
          .card { background: white; border-radius: 16px; padding: 30px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 2px solid #e5e7eb; }
          .header h1 { color: #1f2937; margin: 0; font-size: 2rem; }
          .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; background: #f8fafc; padding: 20px; border-radius: 12px; }
          .info-item { margin: 8px 0; }
          .info-label { font-weight: 600; color: #374151; }
          .info-value { color: #6b7280; }
          .buttons { text-align: center; margin-top: 40px; }
          button { padding: 14px 40px; margin: 10px; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: 600; transition: all 0.3s ease; }
          .approve { background-color: #10b981; color: white; }
          .approve:hover { background-color: #059669; transform: translateY(-2px); }
          .reject { background-color: #ef4444; color: white; }
          .reject:hover { background-color: #dc2626; transform: translateY(-2px); }
          textarea { width: 100%; padding: 12px; margin-top: 10px; display: none; border: 2px solid #e5e7eb; border-radius: 8px; font-family: inherit; }
          .status-badge { display: inline-block; padding: 4px 12px; background: #fef3c7; color: #92400e; border-radius: 20px; font-size: 14px; font-weight: 500; }
          .approval-notice { background: #d1fae5; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #10b981; }
          .approval-notice p { margin: 0; color: #065f46; font-weight: 600; }
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
          </div>` : ''}
          <div class="info-grid">
            <div class="info-item"><div class="info-label">Employé:</div><div class="info-value">${demande.nom} ${demande.prenom}</div></div>
            <div class="info-item"><div class="info-label">Poste:</div><div class="info-value">${demande.poste}</div></div>
            ${demande.type_demande === 'conges' ? `<div class="info-item"><div class="info-label">Solde congé:</div><div class="info-value">${demande.solde_conge}</div></div>` : ''}
            <div class="info-item"><div class="info-label">Type de demande:</div><div class="info-value">${typeDemandeLabel}</div></div>
            <div class="info-item"><div class="info-label">Motif:</div><div class="info-value">${demande.titre}</div></div>
            <div class="info-item"><div class="info-label">Date de départ:</div><div class="info-value">${formatDateShort(demande.date_depart)}</div></div>
            ${demande.date_retour ? `<div class="info-item"><div class="info-label">Date de retour:</div><div class="info-value">${formatDateShort(demande.date_retour)}</div></div>` : ''}
            ${demande.heure_depart ? `<div class="info-item"><div class="info-label">Heure de départ:</div><div class="info-value">${demande.heure_depart}</div></div>` : ''}
            ${demande.heure_retour ? `<div class="info-item"><div class="info-label">Heure de retour:</div><div class="info-value">${demande.heure_retour}</div></div>` : ''}
            ${demande.frais_deplacement ? `<div class="info-item"><div class="info-label">Frais de déplacement:</div><div class="info-value">${demande.frais_deplacement} TND</div></div>` : ''}
            ${demande.type_demande === 'conges' ? `<div class="info-item"><div class="info-label">Type de congé:</div><div class="info-value">${typeCongeLabel}</div></div>` : ''}
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
            ['approveBtn','rejectBtn','confirmRefus'].forEach(id => {
              const btn = document.getElementById(id);
              if (btn) btn.disabled = isProcessing;
            });
            const approveBtn = document.getElementById('approveBtn');
            const confirmRefus = document.getElementById('confirmRefus');
            if (approveBtn) approveBtn.textContent = isProcessing ? 'Traitement...' : '✅ Approuver';
            if (confirmRefus) confirmRefus.textContent = isProcessing ? 'Traitement...' : 'Confirmer le refus';
          }
          function showResult(status, message) {
            const badge = document.querySelector('.status-badge');
            if (badge) {
              badge.textContent = status === 'approuve' ? 'Demande approuvée' : 'Demande refusée';
              badge.style.background = status === 'approuve' ? '#d1fae5' : '#fee2e2';
              badge.style.color = status === 'approuve' ? '#065f46' : '#991b1b';
            }
            document.querySelector('.buttons').style.display = 'none';
            document.querySelector('.refus-section').style.display = 'none';
            if (message) {
              const info = document.createElement('p');
              info.style.cssText = 'margin-top:20px; text-align:center; color:#374151;';
              info.textContent = message;
              document.querySelector('.card').appendChild(info);
            }
          }
          async function approuver() {
            setProcessing(true);
            try {
              const response = await fetch('/api/demandes/' + demandeId + '/approuver', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ niveau })
              });
              if (response.ok) {
                const data = await response.json().catch(() => ({}));
                showResult('approuve', data.message || 'Votre décision a été enregistrée.');
              } else {
                alert('❌ Erreur lors de l\\'approbation');
                setProcessing(false);
              }
            } catch (e) { alert('❌ Erreur réseau'); setProcessing(false); }
          }
          async function refuser() {
            const commentaire = document.getElementById('commentaire').value;
            if (!commentaire.trim()) { alert('Veuillez indiquer le motif du refus'); return; }
            setProcessing(true);
            try {
              const response = await fetch('/api/demandes/' + demandeId + '/refuser', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ niveau, commentaire })
              });
              if (response.ok) {
                const data = await response.json().catch(() => ({}));
                showResult('refuse', data.message || 'Votre décision a été enregistrée.');
              } else {
                alert('❌ Erreur lors du refus');
                setProcessing(false);
              }
            } catch (e) { alert('❌ Erreur réseau'); setProcessing(false); }
          }
          document.addEventListener('DOMContentLoaded', function() {
            document.getElementById('approveBtn').addEventListener('click', approuver);
            document.getElementById('rejectBtn').addEventListener('click', () => {
              document.getElementById('commentaire').style.display = 'block';
              document.getElementById('confirmRefus').style.display = 'inline-block';
            });
            document.getElementById('confirmRefus').addEventListener('click', refuser);
          });
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Erreur page approbation:', err);
    res.status(500).send(`<html><body style="font-family:Arial,sans-serif;text-align:center;padding:50px;"><h1 style="color:#ef4444;">Erreur serveur</h1></body></html>`);
  }
});

app.post('/api/demandes/:id/approuver', async (req, res) => {
  const { id } = req.params;
  const { niveau } = req.body;

  try {
    const demandeResult = await poolHR.query(
      `SELECT d.*, e.nom, e.prenom, e.adresse_mail, e.mail_responsable1, e.mail_responsable2, e.poste, e.matricule
       FROM demande_rh d JOIN employees e ON d.employe_id = e.id WHERE d.id = $1`,
      [id]
    );

    if (demandeResult.rows.length === 0) return res.status(404).json({ error: 'Demande non trouvée' });

    const demande = demandeResult.rows[0];
    demande.id = demande.employe_id;

    if (demande.statut !== 'en_attente') return res.status(400).json({ error: 'Cette demande a déjà été traitée' });

    const colonne = niveau == 1 ? 'approuve_responsable1' : 'approuve_responsable2';
    await poolHR.query(`UPDATE demande_rh SET ${colonne} = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);

    const resp1 = demande.mail_responsable1 ? extraireNomPrenomDepuisEmail(demande.mail_responsable1) : null;
    const resp2 = demande.mail_responsable2 ? extraireNomPrenomDepuisEmail(demande.mail_responsable2) : null;

    if (niveau == 1 && demande.mail_responsable2) {
      await sendEmailWithRetry({
        from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
        to: demande.adresse_mail,
        subject: 'Votre demande RH a été approuvée par votre responsable (Niveau 1)',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #10b981;">✅ Étape 1 : Demande approuvée</h2>
            <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Bonjour ${demande.nom} ${demande.prenom},</strong></p>
              <p>Votre demande a été approuvée par <strong>${resp1 ? resp1.fullName : 'votre responsable'}</strong>.</p>
              <p>Elle est en attente d'approbation par <strong>${resp2 ? resp2.fullName : 'le deuxième responsable'}</strong>.</p>
              <p><strong>Date de départ:</strong> ${formatDateShort(demande.date_depart)}</p>
              <p><strong>Motif:</strong> ${demande.titre}</p>
            </div>
          </div>
        `
      }, 'Approbation niveau 1');

      await envoyerEmailResponsable(demande, demande.mail_responsable2, id, 2, {
        type_demande: demande.type_demande, titre: demande.titre,
        date_depart: demande.date_depart, date_retour: demande.date_retour,
        heure_depart: demande.heure_depart, heure_retour: demande.heure_retour,
        demi_journee: demande.demi_journee, type_conge: demande.type_conge,
        type_conge_autre: demande.type_conge_autre, frais_deplacement: demande.frais_deplacement
      }, resp1 ? resp1.fullName : 'le premier responsable');

      return res.json({ success: true, message: 'Demande approuvée par le premier responsable, en attente du second' });
    }

    await poolHR.query(`UPDATE demande_rh SET statut = 'approuve' WHERE id = $1`, [id]);

    let approuveur = niveau == 1 && !demande.mail_responsable2 ? resp1 : niveau == 2 ? resp2 : null;
    const typeCongeLabel = demande.type_demande === 'conges'
      ? getTypeCongeLabel(demande.type_conge, demande.type_conge_autre) : null;

    await sendEmailWithRetry({
      from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
      to: demande.adresse_mail,
      subject: '✅ Votre demande RH a été approuvée',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10b981; border-bottom: 3px solid #10b981; padding-bottom: 10px;">✅ Demande RH approuvée</h2>
          <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10b981;">
            <p><strong>Bonjour ${demande.nom} ${demande.prenom},</strong></p>
            <p>Votre demande a été <strong style="color: #10b981;">approuvée</strong>.</p>
          </div>
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Type:</strong> ${demande.type_demande === 'conges' ? 'Congé' : demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission'}</p>
            <p><strong>Motif:</strong> ${demande.titre}</p>
            <p><strong>Date de départ:</strong> ${formatDateShort(demande.date_depart)}</p>
            ${demande.date_retour ? `<p><strong>Date de retour:</strong> ${formatDateShort(demande.date_retour)}</p>` : ''}
            ${typeCongeLabel ? `<p><strong>Type de congé:</strong> ${typeCongeLabel}</p>` : ''}
            ${demande.heure_depart ? `<p><strong>Heure de départ:</strong> ${demande.heure_depart}</p>` : ''}
            ${demande.heure_retour ? `<p><strong>Heure de retour:</strong> ${demande.heure_retour}</p>` : ''}
            ${demande.frais_deplacement ? `<p><strong>Frais de déplacement:</strong> ${demande.frais_deplacement} TND</p>` : ''}
            ${approuveur ? `<p><strong>Approuvé par:</strong> ${approuveur.fullName}</p>` : ''}
          </div>
        </div>
      `
    }, 'Approbation finale - Email employé');

    let joursOuvres = 0;
    if (demande.type_demande === 'conges' && demande.date_retour) {
      joursOuvres = calculerJoursOuvres(demande.date_depart, demande.date_retour);
    }

    try {
      const pdfBuffer = await genererPDFDemandeApprouvee(demande, joursOuvres);
      const pdfFileName = `Demande_RH_${demande.nom}_${demande.prenom}_${new Date().getTime()}.pdf`;

      await sendEmailWithRetry({
        from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
        to: 'nesria.ibrahim@avocarbon.com',
        subject: `📋 Demande RH approuvée - ${demande.nom} ${demande.prenom}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1976d2; border-bottom: 3px solid #1976d2; padding-bottom: 10px;">📋 Nouvelle demande RH approuvée</h2>
            <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Employé:</strong> ${demande.nom} ${demande.prenom}</p>
              <p><strong>Type:</strong> ${demande.type_demande === 'conges' ? 'Congé' : demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission'}</p>
              <p><strong>Date de départ:</strong> ${formatDateShort(demande.date_depart)}</p>
              ${joursOuvres > 0 ? `<p><strong>Jours ouvrés:</strong> <strong>${joursOuvres} jour${joursOuvres > 1 ? 's' : ''}</strong></p>` : ''}
            </div>
            <p style="color: #6b7280; font-size: 14px;">📎 Consultez le PDF joint pour tous les détails.</p>
          </div>
        `,
        attachments: [{ filename: pdfFileName, content: pdfBuffer, contentType: 'application/pdf' }]
      }, 'Notification RH - Demande approuvée (PDF)');
    } catch (pdfError) {
      console.error('❌ Erreur génération/envoi PDF:', pdfError);
    }

    res.json({ success: true, message: 'Demande complètement approuvée et notifications envoyées' });
  } catch (err) {
    console.error('❌ Erreur approbation demande:', err);
    res.status(500).json({ error: 'Erreur lors de l\'approbation' });
  }
});

app.post('/api/demandes/:id/refuser', async (req, res) => {
  const { id } = req.params;
  const { niveau, commentaire } = req.body;

  try {
    const demandeResult = await poolHR.query(
      `SELECT d.*, e.nom, e.prenom, e.adresse_mail, e.mail_responsable1, e.mail_responsable2
       FROM demande_rh d JOIN employees e ON d.employe_id = e.id WHERE d.id = $1`,
      [id]
    );

    if (demandeResult.rows.length === 0) return res.status(404).json({ error: 'Demande non trouvée' });

    const demande = demandeResult.rows[0];
    if (demande.statut !== 'en_attente') return res.status(400).json({ error: 'Cette demande a déjà été traitée' });

    const colonneRefus = niveau == 1 ? 'approuve_responsable1' : 'approuve_responsable2';
    await poolHR.query(
      `UPDATE demande_rh SET statut = 'refuse', commentaire_refus = $1, ${colonneRefus} = false, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [commentaire, id]
    );

    const resp1 = demande.mail_responsable1 ? extraireNomPrenomDepuisEmail(demande.mail_responsable1) : null;
    const resp2 = demande.mail_responsable2 ? extraireNomPrenomDepuisEmail(demande.mail_responsable2) : null;

    let refuserParTexte = 'votre responsable hiérarchique';
    if (niveau == 1 && resp1) refuserParTexte = resp1.fullName;
    else if (niveau == 2 && resp2) refuserParTexte = resp2.fullName;

    const typeCongeLabel = demande.type_demande === 'conges'
      ? getTypeCongeLabel(demande.type_conge, demande.type_conge_autre) : null;

    await sendEmailWithRetry({
      from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
      to: demande.adresse_mail,
      subject: 'Votre demande RH a été refusée',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #ef4444;">❌ Votre demande RH a été refusée</h2>
          <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Bonjour ${demande.nom} ${demande.prenom},</strong></p>
            <p>Votre demande de <strong>${demande.type_demande}</strong> pour le <strong>${formatDateShort(demande.date_depart)}</strong> a été refusée.</p>
            ${typeCongeLabel ? `<p><strong>Type de congé:</strong> ${typeCongeLabel}</p>` : ''}
            <p>Décision prise par <strong>${refuserParTexte}</strong>.</p>
            <p><strong>Motif du refus:</strong> ${commentaire}</p>
          </div>
        </div>
      `
    }, 'Refus demande');

    res.json({ success: true, message: 'Demande refusée avec succès' });
  } catch (err) {
    console.error('❌ Erreur refus demande:', err);
    res.status(500).json({ error: 'Erreur lors du refus' });
  }
});

app.get('/api/demandes/employe/:id', async (req, res) => {
  try {
    const result = await poolHR.query(
      `SELECT * FROM demande_rh WHERE employe_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erreur récupération demandes:', err);
    res.status(500).json({ error: 'Erreur lors de la récupération des demandes' });
  }
});

// ==================== DIAGNOSTIC ROUTES ====================

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
    const result = await sendEmailWithRetry({
      from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
      to: 'rami.mejri@avocarbon.com',
      subject: 'Test SMTP Configuration - ' + new Date().toISOString(),
      html: `<div style="font-family: Arial, sans-serif; padding: 20px;"><h2>Test SMTP</h2><p>Timestamp: ${new Date().toISOString()}</p></div>`
    }, 'Test SMTP');
    res.json({ success: true, message: 'Email de test envoyé', result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/smtp-status', async (req, res) => {
  const statuses = [];
  for (let i = 0; i < emailPool.transporters.length; i++) {
    try {
      await emailPool.transporters[i].verify();
      statuses.push({ index: i, status: 'OK', isCurrent: i === emailPool.currentIndex });
    } catch (error) {
      statuses.push({ index: i, status: 'ERROR', error: error.message, isCurrent: i === emailPool.currentIndex });
    }
  }
  res.json({ poolSize: emailPool.transporters.length, currentIndex: emailPool.currentIndex, transporters: statuses });
});

// ==================== CRON JOB ====================

try {
  const cron = require('node-cron');

  cron.schedule('0 9 * * 1-5', async () => {
    console.log("⏰ Running automatic attendance report...");
    await sendAttendanceReport();
  }, { timezone: "Africa/Tunis" });

  console.log("✅ Attendance reports scheduled for weekdays at 9:15 AM Tunisia time");

} catch (error) {
  console.warn("⚠️ Cron scheduling not available:", error.message);
}

// ==================== SERVER START ====================

const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`
  🚀 Serveur démarré sur le port ${PORT}
  =========================================
  📧 Approbation:     http://localhost:${PORT}/approuver-demande
  👥 Employés:        http://localhost:${PORT}/api/employees/actifs
  📋 Demandes:        http://localhost:${PORT}/api/demandes
  📄 Attestations:    http://localhost:${PORT}/api/generer-attestation
  📊 Rapport:         http://localhost:${PORT}/api/attendance/send-report
  🩺 Health:          http://localhost:${PORT}/health
  🔧 Test SMTP:       http://localhost:${PORT}/api/test-email
  📊 SMTP Status:     http://localhost:${PORT}/api/smtp-status
  `);

  await verifySMTPConnection();

  try { await fs.access(TEMPLATE_TRAVAIL_PATH); console.log('✅ Template attestation travail trouvé'); }
  catch { console.warn('⚠️ Template attestation travail non trouvé'); }

  try { await fs.access(TEMPLATE_SALAIRE_PATH); console.log('✅ Template attestation salaire trouvé'); }
  catch { console.warn('⚠️ Template attestation salaire non trouvé'); }
});
