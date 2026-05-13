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

// ==================== CORS FIX ====================
app.use(cors({
  origin: [
    'https://request-rh.azurewebsites.net',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.options('*', cors());
// ===================================================

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
const SALARY_ADVANCE_MANAGER = 'rami.mejri@avocarbon.com';
const SALARY_ADVANCE_HR      = 'rihem.arfaoui@avocarbon.com';

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

function formatTimeHHMM(value) {
  if (!value) return '—';
  if (typeof value === 'string') return value.slice(0, 5);
  try {
    return String(value).slice(0, 5);
  } catch {
    return '—';
  }
}

function toMinutesFromTime(value) {
  if (!value) return null;
  const s = typeof value === 'string' ? value : String(value);
  const match = s.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function formatMinutesToHours(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  const safe = Math.max(0, Math.round(minutes));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${h}h${String(m).padStart(2, '0')}`;
}

function enumerateWeekdays(startDateStr, endDateStr) {
  const dates = [];
  const current = new Date(`${startDateStr}T00:00:00`);
  const end = new Date(`${endDateStr}T00:00:00`);

  while (current <= end) {
    const day = current.getDay();
    if (day >= 1 && day <= 5) {
      const iso = current.toISOString().split('T')[0];
      dates.push({
        iso,
        shortLabel: current.toLocaleDateString('fr-FR', {
          weekday: 'short',
          day: '2-digit',
          month: '2-digit'
        }).replace('.', '')
      });
    }
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

function computeWorkedMinutes(arrivalTime, departureTime, lunchBreakMinutes = 60) {
  const arrival = toMinutesFromTime(arrivalTime);
  const departure = toMinutesFromTime(departureTime);

  if (arrival === null || departure === null || departure <= arrival) return null;

  const raw = departure - arrival;
  return Math.max(0, raw - lunchBreakMinutes);
}

function normalizeTypeDemande(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function getRequestDatesInRange(request, startDateStr, endDateStr) {
  const result = [];
  const type = normalizeTypeDemande(request.type_demande);

  const reportStart = new Date(`${startDateStr}T00:00:00`);
  const reportEnd = new Date(`${endDateStr}T00:00:00`);

  const departStr = request.date_depart instanceof Date
    ? request.date_depart.toISOString().split('T')[0]
    : String(request.date_depart).split('T')[0];

  const retourStr = request.date_retour
    ? (request.date_retour instanceof Date
        ? request.date_retour.toISOString().split('T')[0]
        : String(request.date_retour).split('T')[0])
    : null;

  const requestStart = new Date(`${departStr}T00:00:00`);
  const requestEnd = retourStr
    ? new Date(`${retourStr}T00:00:00`)
    : new Date(requestStart);

  if (type === 'autorisation') {
    if (requestStart >= reportStart && requestStart <= reportEnd) {
      const day = requestStart.getDay();
      if (day >= 1 && day <= 5) {
        result.push(requestStart.toISOString().split('T')[0]);
      }
    }
    return result;
  }

  const adjustedRequestEnd = (type === 'conges' && requestEnd > requestStart)
    ? new Date(requestEnd.getTime() - 24 * 60 * 60 * 1000)
    : requestEnd;

  const start = requestStart > reportStart ? requestStart : reportStart;
  const end = adjustedRequestEnd < reportEnd ? adjustedRequestEnd : reportEnd;

  if (start > end) return result;

  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getDay();
    if (day >= 1 && day <= 5) {
      result.push(cursor.toISOString().split('T')[0]);
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return result;
}

function buildApprovedRequestMap(requestRows, startDateStr, endDateStr) {
  const map = new Map();

  for (const req of requestRows) {
    const coveredDates = getRequestDatesInRange(req, startDateStr, endDateStr);
    for (const date of coveredDates) {
      const key = `${req.employe_id}__${date}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(req);
    }
  }

  return map;
}

function getAuthorizationMinutes(req) {
  const start = toMinutesFromTime(req.heure_depart);
  const end = toMinutesFromTime(req.heure_retour);
  if (start === null || end === null || end <= start) return null;
  return end - start;
}

function getLateJustified(arrivalTime, requestsForDay, lateThresholdMinutes = 8 * 60 + 30) {
  const arrival = toMinutesFromTime(arrivalTime);
  if (arrival === null || arrival <= lateThresholdMinutes) return false;

  if (arrival >= 13 * 60) return false;

  return requestsForDay.some(req => {
    if (req.type_demande !== 'autorisation') return false;
    const start = toMinutesFromTime(req.heure_depart);
    const end = toMinutesFromTime(req.heure_retour);
    if (start === null || end === null) return false;
    return start <= lateThresholdMinutes && end >= arrival;
  });
}

function chooseDayDisplay(attendanceRow, requestsForDay) {
  const conge = requestsForDay.find(r => r.type_demande === 'conges');
  const autorisations = requestsForDay.filter(r => r.type_demande === 'autorisation');
  const mission = requestsForDay.find(r => r.type_demande === 'mission');

  if (conge) {
    if (conge.demi_journee) {
      return { minutes: 240, text: '4h00 (congé 1/2 journée)', lateCount: 0 };
    }
    return { minutes: 0, text: 'Congé', lateCount: 0 };
  }

  const arrival = attendanceRow?.arrival_time || null;
  const departure = attendanceRow?.departure_time || null;
  const workedMinutes = computeWorkedMinutes(arrival, departure, 60);

  const totalAuthorizationMinutes = autorisations.reduce((sum, req) => {
    const m = getAuthorizationMinutes(req);
    return sum + (m || 0);
  }, 0);

  const arrivalMinutes = toMinutesFromTime(arrival);
  if (attendanceRow && arrivalMinutes !== null && arrivalMinutes >= 13 * 60 && departure === null) {
    return {
      minutes: 0,
      text: `— (entrée manquante, sortie probable : ${formatTimeHHMM(arrival)})`,
      lateCount: 0
    };
  }

  if (attendanceRow && workedMinutes !== null) {
    const lateJustified = getLateJustified(arrival, requestsForDay);
    const isLate = arrivalMinutes !== null
      && arrivalMinutes > (8 * 60 + 30)
      && arrivalMinutes < 13 * 60
      && !lateJustified;

    let finalMinutes = workedMinutes;
    let details = `${formatTimeHHMM(arrival)} → ${formatTimeHHMM(departure)}`;

    if (totalAuthorizationMinutes > 0) {
      finalMinutes = Math.max(0, finalMinutes - totalAuthorizationMinutes);
      details += `, autorisation -${formatMinutesToHours(totalAuthorizationMinutes)}`;
    } else if (mission) {
      const missionMinutes = getAuthorizationMinutes(mission);
      if (missionMinutes) {
        finalMinutes = Math.max(0, workedMinutes + missionMinutes - 60);
        details += `, mission +${formatMinutesToHours(missionMinutes)} -1h pause`;
      } else {
        details += ', mission';
      }
    }

    return {
      minutes: finalMinutes,
      text: `${formatMinutesToHours(finalMinutes)} (${details})`,
      lateCount: isLate ? 1 : 0
    };
  }

  if (attendanceRow && (arrival || departure)) {
    const partialText = `${arrival ? formatTimeHHMM(arrival) : 'entrée manquante'} → ${departure ? formatTimeHHMM(departure) : 'sortie manquante'}`;
    return { minutes: 0, text: `— (${partialText})`, lateCount: 0 };
  }

  if (totalAuthorizationMinutes > 0) {
    return {
      minutes: totalAuthorizationMinutes,
      text: `${formatMinutesToHours(totalAuthorizationMinutes)} (autorisation)`,
      lateCount: 0
    };
  }

  if (mission) {
    return {
      minutes: 480,
      text: '8h00 (mission journée complète)',
      lateCount: 0
    };
  }

  return { minutes: 0, text: '—', lateCount: 0 };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


async function ensureSalaryAdvanceTable() {
  await poolHR.query(`
    CREATE TABLE IF NOT EXISTS demandes_avance_salaire (
      id SERIAL PRIMARY KEY,
      employe_id INTEGER NOT NULL REFERENCES employees(id),
      titre_motif TEXT NOT NULL,
      montant_demande NUMERIC(12, 3) NOT NULL,
      mode_remboursement_souhaite TEXT NOT NULL,
      signature_demandeur TEXT NOT NULL,
      acceptation_responsabilite BOOLEAN NOT NULL DEFAULT false,
      montant_accorde NUMERIC(12, 3),
      mode_remboursement_appliquer TEXT,
      commentaire_refus TEXT,
      statut VARCHAR(40) NOT NULL DEFAULT 'en_attente_admin',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Safe migrations for existing tables
  const migrations = [
    `ALTER TABLE demandes_avance_salaire ADD COLUMN IF NOT EXISTS commentaire_refus TEXT`,
    `ALTER TABLE demandes_avance_salaire ALTER COLUMN statut TYPE VARCHAR(40)`
  ];
  for (const sql of migrations) {
    await poolHR.query(sql).catch(() => {});
  }

  console.log('✅ Table demandes_avance_salaire OK');
}

function formatMontantTND(value) {
  const numberValue = Number(value || 0);
  return numberValue.toLocaleString('fr-TN', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3
  });
}

// ==================== ADVISORY LOCK FUNCTIONS ====================

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
      if (demande.type_demande === 'conges' && demande.nombre_jours) {
        demandeInfo.push({ label: 'Jours demandés (employé):', value: `${demande.nombre_jours} jour${demande.nombre_jours > 1 ? 's' : ''}`, highlight: true });
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


async function genererPDFAvanceSalaire(demande) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 45, bottom: 45, left: 50, right: 50 } });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(18).text('FICHE D\'AVANCE SUR SALAIRE', { align: 'center' });
      doc.moveDown(1.2);
      doc.font('Helvetica').fontSize(11);

      const line = (label, value = '') => {
        doc.font('Helvetica-Bold').text(label, { continued: true });
        doc.font('Helvetica').text(` ${value || ''}`);
        doc.moveDown(0.7);
      };

      line('Date :', formatDateFR(demande.created_at || new Date()));
      line('Nom et prénoms :', `${demande.nom} ${demande.prenom}`);
      line('Poste occupé :', demande.poste || '');
      line('Titre & Motif de l\'avance :', demande.titre_motif);
      line('Montant demandé :', `${formatMontantTND(demande.montant_demande)} TND`);
      line('Mode de remboursement souhaité :', demande.mode_remboursement_souhaite);

      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').text('Signature demandeur :', { continued: true });
      doc.font('Helvetica').text(` ${demande.signature_demandeur}`);
      doc.fontSize(9).fillColor('#555555')
        .text(`Acceptation et prise de responsabilité confirmées le ${formatDateFR(demande.created_at || new Date())}.`);
      doc.fillColor('#000000').fontSize(11);

      doc.moveDown(1.4);
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke('#9ca3af');
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').text('-A remplir par l\'administration-', { align: 'center' });
      doc.moveDown(1.0);
      line('Montant accordé :', demande.montant_accorde ? `${formatMontantTND(demande.montant_accorde)} TND` : '');
      line('Mode de remboursement à appliquer :', demande.mode_remboursement_appliquer || '');
      doc.moveDown(1.4);
      doc.font('Helvetica-Bold').fontSize(11).text('Signature Bénéficiaire :');

      if (demande.signature_confirmation_employe) {
        try {
          const base64Data = demande.signature_confirmation_employe.replace(/^data:image\/png;base64,/, '');
          const signatureBuffer = Buffer.from(base64Data, 'base64');
          const signatureY = doc.y + 10;

          doc.rect(70, signatureY, 240, 90).stroke('#e5e7eb');
          doc.image(signatureBuffer, 80, signatureY + 8, {
            fit: [220, 70],
            align: 'center',
            valign: 'center'
          });

          doc.y = signatureY + 100;
          doc.font('Helvetica').fontSize(9).fillColor('#555555')
            .text(`Signé électroniquement le ${formatDateFR(demande.date_signature_confirmation || new Date())}`);
          doc.fillColor('#000000').fontSize(11);
        } catch (signatureError) {
          console.error('⚠️ Erreur insertion signature employé dans PDF:', signatureError.message);
          doc.font('Helvetica').fontSize(9)
            .text('(signature électronique non lisible)');
        }
      } else {
        doc.font('Helvetica').fontSize(9)
          .text('(avec mention : montant reçu et mode de remboursement accepté)');
      }

      const footerY = doc.page.height - 75;
      doc.fontSize(8).fillColor('#555555')
        .text('Adresse : Cyber Parc. H.Lif Ben Arous 2050. Carte d\'identification fiscale : 000M A 1793574/B', 50, footerY, {
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

    const activeEmployeesResult = await poolHR.query(`
      SELECT id, matricule, nom, prenom
      FROM employees
      WHERE date_depart IS NULL
        AND COALESCE(statut, 'actif') = 'actif'
      ORDER BY nom, prenom
    `);

    const activeEmployees = activeEmployeesResult.rows;

    const attendanceEmployeesResult = await poolAttendance.query(`
      SELECT uid, matricule, full_name
      FROM employees
    `);

    const attendanceByMatricule = new Map();
    attendanceEmployeesResult.rows.forEach(row => {
      if (row.matricule) {
        attendanceByMatricule.set(String(row.matricule).trim(), row);
      }
    });

    const employeesForReport = activeEmployees.map(emp => {
      const attendanceEmp = attendanceByMatricule.get(String(emp.matricule).trim());
      return {
        hrId: emp.id,
        matricule: emp.matricule,
        fullName: `${emp.prenom} ${emp.nom}`,
        attendanceUid: attendanceEmp ? attendanceEmp.uid : null,
        attendanceFullName: attendanceEmp ? attendanceEmp.full_name : `${emp.prenom} ${emp.nom}`
      };
    });

    const activeAttendanceUids = employeesForReport
      .filter(e => e.attendanceUid !== null && e.attendanceUid !== undefined)
      .map(e => e.attendanceUid);

    const arrivals = activeAttendanceUids.length > 0
      ? await poolAttendance.query(`
          SELECT uid, full_name, arrival_time
          FROM attendance_daily
          WHERE work_date = $1
            AND uid = ANY($2::int[])
          ORDER BY arrival_time NULLS LAST, full_name
        `, [todayStr, activeAttendanceUids])
      : { rows: [] };

    const weekData = activeAttendanceUids.length > 0
      ? await poolAttendance.query(`
          SELECT uid, full_name, work_date, arrival_time, departure_time, status
          FROM attendance_daily
          WHERE work_date BETWEEN $1 AND $2
            AND uid = ANY($3::int[])
          ORDER BY work_date, full_name
        `, [startDate, endDate, activeAttendanceUids])
      : { rows: [] };

    const approvedRequestsResult = await poolHR.query(`
      SELECT *
      FROM demande_rh
      WHERE statut = 'approuve'
        AND date_depart <= $2
        AND COALESCE(date_retour, date_depart) >= $1
    `, [startDate, endDate]);

    const approvedRequestMap = buildApprovedRequestMap(
      approvedRequestsResult.rows,
      startDate,
      endDate
    );

    const attendanceByUidDate = new Map();
    weekData.rows.forEach(row => {
      const workDate =
        row.work_date instanceof Date
          ? row.work_date.toISOString().split('T')[0]
          : String(row.work_date).split('T')[0];

      const key = `${row.uid}__${workDate}`;
      attendanceByUidDate.set(key, row);
    });

    const weekDays = enumerateWeekdays(startDate, endDate);

    const totalPresentToday = arrivals.rows.filter(r => r.arrival_time).length;
    const totalEmployees = employeesForReport.length;

    const arrivalsRows = arrivals.rows.map((r, i) => `
      <tr style="border-bottom:1px solid #f3f4f6; ${i % 2 !== 0 ? 'background:#fafafa;' : ''}">
        <td style="padding:10px 10px; color:#374151; font-size:14px;">${escapeHtml(r.full_name)}</td>
        <td style="padding:10px 10px; text-align:center; color:#374151; font-size:14px;">${formatTimeHHMM(r.arrival_time)}</td>
      </tr>
    `).join('');

    let totalWorkedMinutesWeek = 0;
    let totalLateCount = 0;
    let employeesWithAnyData = 0;

    const headerDayColumns = weekDays.map(d => `
      <th style="text-align:center; padding:8px 10px; color:#374151; font-weight:600; min-width:160px;">
        ${escapeHtml(d.shortLabel)}
      </th>
    `).join('');

    const reportRows = employeesForReport.map((emp, rowIndex) => {
      let employeeWeekMinutes = 0;
      let employeeLateCount = 0;
      let employeeHasData = false;

      const dayCells = weekDays.map(dayInfo => {
        const attendanceKey = emp.attendanceUid !== null && emp.attendanceUid !== undefined
          ? `${emp.attendanceUid}__${dayInfo.iso}`
          : null;

        const attendanceRow = attendanceKey ? attendanceByUidDate.get(attendanceKey) : null;
        const requestsForDay = approvedRequestMap.get(`${emp.hrId}__${dayInfo.iso}`) || [];

        const dayResult = chooseDayDisplay(attendanceRow, requestsForDay);

        if (dayResult.text !== '—') employeeHasData = true;
        employeeWeekMinutes += dayResult.minutes;
        employeeLateCount += dayResult.lateCount;

        return `
          <td style="padding:10px 8px; text-align:center; color:#374151; font-size:13px; vertical-align:top;">
            ${escapeHtml(dayResult.text)}
          </td>
        `;
      }).join('');

      if (employeeHasData) employeesWithAnyData++;
      totalWorkedMinutesWeek += employeeWeekMinutes;
      totalLateCount += employeeLateCount;

      return `
        <tr style="border-bottom:1px solid #f3f4f6; ${rowIndex % 2 !== 0 ? 'background:#fafafa;' : ''}">
          <td style="padding:10px 10px; color:#374151; font-size:14px; font-weight:600;">
            ${escapeHtml(emp.fullName)}
          </td>
          ${dayCells}
          <td style="padding:10px 8px; text-align:center; color:#111827; font-size:13px; font-weight:700;">
            ${formatMinutesToHours(employeeWeekMinutes)}
          </td>
          <td style="padding:10px 8px; text-align:center; color:#111827; font-size:13px; font-weight:700;">
            ${employeeLateCount}
          </td>
        </tr>
      `;
    }).join('');

    const mailOptions = {
      from: {
        name: 'Administration STS',
        address: 'administration.STS@avocarbon.com'
      },
      to: ['fethi.chaouachi@avocarbon.com','rami.mejri@avocarbon.com'],
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
                <div style="font-size:32px; font-weight:700; color:#1e293b;">${employeesWithAnyData}</div>
                <div style="font-size:12px; color:#6b7280; margin-top:3px;">Employés avec données cette semaine</div>
              </div>
              <div style="flex:1; padding:20px; text-align:center;">
                <div style="font-size:32px; font-weight:700; color:#1e293b;">${totalEmployees}</div>
                <div style="font-size:12px; color:#6b7280; margin-top:3px;">Total employés actifs</div>
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

              <table style="width:100%; border-collapse:collapse; font-size:14px; margin-bottom:24px;">
                <thead>
                  <tr style="border-bottom:2px solid #1e293b;">
                    <th style="text-align:left; padding:8px 10px; color:#374151; font-weight:600; min-width:180px;">Employé</th>
                    ${headerDayColumns}
                    <th style="text-align:center; padding:8px 10px; color:#374151; font-weight:600; min-width:95px;">Total semaine</th>
                    <th style="text-align:center; padding:8px 10px; color:#374151; font-weight:600; min-width:85px;">Nb retards</th>
                  </tr>
                </thead>
                <tbody>
                  ${reportRows}
                </tbody>
              </table>

              <!-- SUMMARY -->
              <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px; padding:16px 20px; font-size:13px; color:#374151;">
                <strong style="display:block; margin-bottom:8px; color:#1e293b;">Statistiques</strong>
                Heures totales semaine : <strong>${formatMinutesToHours(totalWorkedMinutesWeek)}</strong> &nbsp;•&nbsp;
                Total retards : <strong>${totalLateCount}</strong> &nbsp;•&nbsp;
                Employés avec données : <strong>${employeesWithAnyData}</strong> &nbsp;•&nbsp;
                Total employés actifs : <strong>${totalEmployees}</strong>
              </div>

              <div style="margin-top:12px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px; padding:14px 18px; font-size:12px; color:#6b7280; line-height:1.6;">
                <strong style="color:#374151;">Légende :</strong>
                XhYY (08:12 → 17:11) = heures travaillées après déduction d'1h de pause déjeuner.<br>
                Autorisation = absence personnelle déduite des heures travaillées.<br>
                Mission journée complète (sans pointage) = 8h fixes. Mission partielle (avec pointage) = heures réelles + heures mission - 1h pause.<br>
                Les retards sont comptés uniquement après 08:30 et ignorés s'ils sont couverts par une autorisation approuvée.<br>
                Entrée manquante = pointage unique après 13h00 (probablement une sortie enregistrée dans le champ arrivée).
              </div>

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

// Manual trigger endpoint — calls BOTH functions
app.post('/api/attendance/send-report', async (req, res) => {
  try {
    await sendAttendanceReport();
    await sendTeamAttendanceReportPerResponsable();
    res.json({ success: true, message: "Both attendance reports sent successfully" });
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


app.post('/api/demandes-avance-salaire', async (req, res) => {
  const {
    employe_id,
    titre_motif,
    montant_demande,
    mode_remboursement_souhaite,
    signature_demandeur,
    acceptation_responsabilite
  } = req.body;

  // --- Validation ---
  if (!employe_id || !titre_motif || !montant_demande || !mode_remboursement_souhaite || !signature_demandeur || !acceptation_responsabilite) {
    return res.status(400).json({
      error: 'Employé, motif, montant, mode de remboursement, signature et acceptation sont obligatoires'
    });
  }

  const montant = parseFloat(montant_demande);
  if (!Number.isFinite(montant) || montant <= 0) {
    return res.status(400).json({ error: 'Le montant demandé doit être supérieur à 0' });
  }

  try {
    const employeResult = await poolHR.query(
      `SELECT id, matricule, nom, prenom, poste, adresse_mail
       FROM employees WHERE id = $1`,
      [employe_id]
    );
    if (employeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Employé non trouvé' });
    }
    const employe = employeResult.rows[0];

    const insertResult = await poolHR.query(
      `INSERT INTO demandes_avance_salaire
       (employe_id, titre_motif, montant_demande, mode_remboursement_souhaite,
        signature_demandeur, acceptation_responsabilite, statut)
       VALUES ($1, $2, $3, $4, $5, $6, 'en_attente_admin')
       RETURNING *`,
      [employe_id, titre_motif.trim(), montant, mode_remboursement_souhaite.trim(),
       signature_demandeur.trim(), true]
    );

    const demandeId = insertResult.rows[0].id;
    const decisionLink = `${BASE_URL}/avance-decision?id=${demandeId}`;

    // Send initial PDF (employee's request only — admin section blank)
    const demande = { ...insertResult.rows[0], ...employe };
    const pdfBuffer = await genererPDFAvanceSalaire(demande);
    const pdfFileName = `Demande_Avance_Salaire_${employe.nom}_${employe.prenom}_${Date.now()}.pdf`;

    // Email to manager (Fethi only) with decision link
    await sendEmailWithRetry({
      from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
      to: SALARY_ADVANCE_MANAGER,
      subject: `Demande d'avance sur salaire — ${employe.nom} ${employe.prenom}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;">
          <h2 style="color:#2563eb;border-bottom:2px solid #2563eb;padding-bottom:10px;">
            💰 Nouvelle demande d'avance sur salaire
          </h2>
          <div style="background:#f8fafc;padding:20px;border-radius:8px;margin:20px 0;">
            <p><strong>Employé :</strong> ${escapeHtml(employe.nom)} ${escapeHtml(employe.prenom)}</p>
            <p><strong>Matricule :</strong> ${escapeHtml(employe.matricule || '—')}</p>
            <p><strong>Poste :</strong> ${escapeHtml(employe.poste || '—')}</p>
            <p><strong>Motif :</strong> ${escapeHtml(titre_motif)}</p>
            <p><strong>Montant demandé :</strong> <strong style="color:#2563eb;font-size:16px;">${formatMontantTND(montant)} TND</strong></p>
            <p><strong>Remboursement souhaité :</strong> ${escapeHtml(mode_remboursement_souhaite)}</p>
            <p><strong>Signature :</strong> ${escapeHtml(signature_demandeur)}</p>
          </div>
          <div style="text-align:center;margin:30px 0;">
            <a href="${decisionLink}"
               style="display:inline-block;padding:14px 36px;background:#2563eb;color:white;
                      text-decoration:none;border-radius:8px;font-weight:bold;font-size:16px;">
              ✍️ Traiter la demande
            </a>
          </div>
          <p style="color:#6b7280;font-size:13px;text-align:center;">
            Vous pouvez approuver le montant tel quel, le modifier, ou refuser la demande.
            L'employé devra ensuite confirmer votre décision.
          </p>
        </div>
      `,
      attachments: [{ filename: pdfFileName, content: pdfBuffer, contentType: 'application/pdf' }]
    }, 'Demande avance sur salaire — managers');

    // Confirmation to employee
    if (employe.adresse_mail) {
      await sendEmailWithRetry({
        from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
        to: employe.adresse_mail,
        subject: 'Votre demande d\'avance sur salaire a été transmise',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#10b981;">📨 Demande transmise</h2>
            <p>Bonjour ${escapeHtml(employe.nom)} ${escapeHtml(employe.prenom)},</p>
            <p>Votre demande d'avance sur salaire de <strong>${formatMontantTND(montant)} TND</strong>
               a été transmise à l'administration. Vous recevrez un email dès qu'une décision sera prise.</p>
          </div>
        `
      }, 'Confirmation employé — avance soumise');
    }

    res.json({
      success: true,
      message: 'Demande transmise avec succès',
      demandeId
    });

  } catch (err) {
    console.error('❌ Erreur création avance salaire:', err);
    res.status(500).json({ error: 'Erreur lors de la création de la demande: ' + err.message });
  }
});

// ==================== STEP 2: MANAGER DECISION PAGE (GET) ====================

app.get('/avance-decision', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('<h1>ID manquant</h1>');

  try {
    const result = await poolHR.query(
      `SELECT d.*, e.nom, e.prenom, e.poste, e.matricule, e.adresse_mail
       FROM demandes_avance_salaire d
       JOIN employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;background:#f4f4f4;">
          <div style="background:white;max-width:480px;margin:0 auto;padding:40px;border-radius:12px;">
            <div style="font-size:48px;">❌</div>
            <h2 style="color:#ef4444;">Demande non trouvée</h2>
          </div>
        </body></html>
      `);
    }

    const d = result.rows[0];

    // Already handled by manager
    if (d.statut !== 'en_attente_admin') {
      const labels = {
        en_attente_employe: { icon: '⏳', color: '#f59e0b', text: 'En attente de confirmation de l\'employé' },
        approuve:           { icon: '✅', color: '#10b981', text: 'Approuvée et confirmée par l\'employé' },
        refuse_admin:       { icon: '❌', color: '#ef4444', text: 'Refusée par l\'administration' },
        refuse_employe:     { icon: '🚫', color: '#ef4444', text: 'Refusée par l\'employé' }
      };
      const info = labels[d.statut] || { icon: 'ℹ️', color: '#64748b', text: d.statut };
      return res.send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;background:#f4f4f4;">
          <div style="background:white;max-width:500px;margin:0 auto;padding:40px;border-radius:12px;">
            <div style="font-size:48px;">${info.icon}</div>
            <h2 style="color:${info.color};">${info.text}</h2>
            ${d.statut === 'approuve' ? `
              <p><strong>Montant accordé :</strong> ${formatMontantTND(d.montant_accorde)} TND</p>
              <p><strong>Remboursement :</strong> ${escapeHtml(d.mode_remboursement_appliquer || '')}</p>
            ` : d.commentaire_refus ? `
              <p><strong>Motif :</strong> ${escapeHtml(d.commentaire_refus)}</p>
            ` : ''}
          </div>
        </body></html>
      `);
    }

    // Render decision form for manager
    res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Décision — Avance sur Salaire #${d.id}</title>
        <style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{font-family:'Segoe UI',Arial,sans-serif;background:linear-gradient(135deg,#1e3a5f,#2563eb);min-height:100vh;padding:30px 16px}
          .card{background:white;max-width:700px;margin:0 auto;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25)}
          .hdr{background:#1e3a5f;color:white;padding:26px 32px}
          .hdr h1{font-size:20px;margin-bottom:4px}
          .hdr p{font-size:13px;color:#94a3b8}
          .body{padding:28px 32px}
          .sec-title{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px;margin:22px 0 10px}
          .info-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px}
          .row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px}
          .row:last-child{border-bottom:none}
          .lbl{color:#64748b;font-weight:600}
          .val{color:#1e293b;font-weight:500;text-align:right;max-width:58%}
          .big{color:#2563eb;font-size:17px;font-weight:700}
          .form-group{margin-top:18px}
          .form-group label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px}
          input[type=number],textarea{width:100%;padding:10px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:14px;font-family:inherit;transition:border-color .2s}
          input[type=number]:focus,textarea:focus{outline:none;border-color:#2563eb}
          .hint{font-size:12px;color:#94a3b8;margin-top:5px}
          .err{color:#ef4444;font-size:12px;margin-top:4px;display:none}
          hr{border:none;border-top:1px solid #e2e8f0;margin:24px 0}
          .btn-row{display:flex;gap:12px;margin-top:24px}
          .btn{flex:1;padding:14px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:all .2s}
          .btn-ok{background:#10b981;color:white}
          .btn-ok:hover:not(:disabled){background:#059669;transform:translateY(-1px)}
          .btn-no{background:#ef4444;color:white}
          .btn-no:hover:not(:disabled){background:#dc2626;transform:translateY(-1px)}
          .btn:disabled{opacity:.55;cursor:not-allowed;transform:none}
          .refus-box{display:none;margin-top:20px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:18px}
          .refus-box label{display:block;font-size:13px;font-weight:600;color:#991b1b;margin-bottom:6px}
          .badge{display:inline-block;padding:3px 12px;background:#fef3c7;color:#92400e;border-radius:20px;font-size:13px;font-weight:500}
        </style>
      </head>
      <body>
        <div class="card">
          <div class="hdr">
            <h1>💰 Avance sur Salaire — Décision</h1>
            <p>Demande #${d.id} &nbsp;·&nbsp; Soumise le ${formatDateFR(d.created_at)} &nbsp;·&nbsp; <span class="badge">En attente de votre décision</span></p>
          </div>
          <div class="body">

            <div class="sec-title">Employé</div>
            <div class="info-box">
              <div class="row"><span class="lbl">Nom</span><span class="val">${escapeHtml(d.nom)} ${escapeHtml(d.prenom)}</span></div>
              <div class="row"><span class="lbl">Matricule</span><span class="val">${escapeHtml(d.matricule || '—')}</span></div>
              <div class="row"><span class="lbl">Poste</span><span class="val">${escapeHtml(d.poste || '—')}</span></div>
            </div>

            <div class="sec-title">Ce que l'employé demande</div>
            <div class="info-box">
              <div class="row"><span class="lbl">Motif</span><span class="val">${escapeHtml(d.titre_motif)}</span></div>
              <div class="row"><span class="lbl">Montant demandé</span><span class="val big">${formatMontantTND(d.montant_demande)} TND</span></div>
              <div class="row"><span class="lbl">Remboursement souhaité</span><span class="val">${escapeHtml(d.mode_remboursement_souhaite)}</span></div>
              <div class="row"><span class="lbl">Signature</span><span class="val">${escapeHtml(d.signature_demandeur)}</span></div>
            </div>

            <hr>
            <div class="sec-title">✍️ Votre décision — vous pouvez modifier les conditions</div>

            <div class="form-group">
              <label>Montant accordé (TND) *</label>
              <input type="number" id="montant_accorde" min="0.001" step="0.001"
                     value="${parseFloat(d.montant_demande).toFixed(3)}" />
              <div class="hint">L'employé a demandé ${formatMontantTND(d.montant_demande)} TND — modifiez si nécessaire.</div>
              <div class="err" id="e_montant">Montant invalide (doit être > 0).</div>
            </div>

            <div class="form-group">
              <label>Mode de remboursement à appliquer *</label>
              <textarea id="mode_remboursement" rows="3"
                placeholder="Ex: retenue de 400 TND/mois sur 2 mois">${escapeHtml(d.mode_remboursement_souhaite)}</textarea>
              <div class="hint">Proposition de l'employé : « ${escapeHtml(d.mode_remboursement_souhaite)} »</div>
              <div class="err" id="e_mode">Veuillez préciser le mode de remboursement.</div>
            </div>

            <div class="btn-row">
              <button class="btn btn-ok" id="btnOk" onclick="approuver()">✅ Approuver et envoyer à l'employé</button>
              <button class="btn btn-no" id="btnNo" onclick="showRefus()">❌ Refuser</button>
            </div>

            <div class="refus-box" id="refusBox">
              <label>Motif du refus (obligatoire) *</label>
              <textarea id="commentaire_refus" rows="3"
                placeholder="Expliquez la raison du refus à l'employé..."></textarea>
              <div class="err" id="e_refus">Veuillez indiquer le motif du refus.</div>
              <div style="margin-top:12px">
                <button class="btn btn-no" id="btnConfirmRefus" onclick="refuser()"
                  style="max-width:260px;">Confirmer le refus</button>
              </div>
            </div>

          </div>
        </div>

        <script>
          const DID = ${parseInt(id, 10)};

          let hasSignature = false;
          const canvas = document.getElementById('signaturePad');
          const ctx = canvas.getContext('2d');
          let drawing = false;

          function resizeCanvas(){
            const rect = canvas.getBoundingClientRect();
            const oldImage = hasSignature ? canvas.toDataURL('image/png') : null;
            canvas.width = rect.width;
            canvas.height = 180;
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.strokeStyle = '#111827';

            if(oldImage){
              const img = new Image();
              img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              img.src = oldImage;
            }
          }

          function getPos(e){
            const rect = canvas.getBoundingClientRect();
            const touch = e.touches ? e.touches[0] : e;
            return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
          }

          function startDraw(e){
            drawing = true;
            hasSignature = true;
            document.getElementById('e_signature').style.display='none';
            const pos = getPos(e);
            ctx.beginPath();
            ctx.moveTo(pos.x, pos.y);
            e.preventDefault();
          }

          function draw(e){
            if(!drawing) return;
            const pos = getPos(e);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
            e.preventDefault();
          }

          function stopDraw(){
            drawing = false;
            ctx.beginPath();
          }

          function clearSignature(){
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            hasSignature = false;
          }

          resizeCanvas();
          window.addEventListener('resize', resizeCanvas);
          canvas.addEventListener('mousedown', startDraw);
          canvas.addEventListener('mousemove', draw);
          canvas.addEventListener('mouseup', stopDraw);
          canvas.addEventListener('mouseleave', stopDraw);
          canvas.addEventListener('touchstart', startDraw, { passive:false });
          canvas.addEventListener('touchmove', draw, { passive:false });
          canvas.addEventListener('touchend', stopDraw);

          function lock(on){
            ['btnOk','btnNo','btnConfirmRefus'].forEach(id=>{
              const b=document.getElementById(id);
              if(b) b.disabled=on;
            });
          }

          function showErr(id,show){
            document.getElementById(id).style.display=show?'block':'none';
          }

          function showRefus(){
            document.getElementById('refusBox').style.display='block';
            document.getElementById('btnNo').style.display='none';
          }

          function done(statut,msg){
            document.querySelector('.body').innerHTML=\`
              <div style="text-align:center;padding:50px 20px;">
                <div style="font-size:60px;">\${statut==='approuve'?'✅':'❌'}</div>
                <h2 style="color:\${statut==='approuve'?'#10b981':'#ef4444'};margin:18px 0 10px;">
                  \${statut==='approuve'?'Décision envoyée à l\\'employé':'Demande refusée'}
                </h2>
                <p style="color:#64748b;font-size:14px;">\${msg}</p>
              </div>
            \`;
          }

          async function approuver(){
            const montant=parseFloat(document.getElementById('montant_accorde').value);
            const mode=document.getElementById('mode_remboursement').value.trim();
            let ok=true;
            if(!montant||montant<=0){showErr('e_montant',true);ok=false;}else showErr('e_montant',false);
            if(!mode){showErr('e_mode',true);ok=false;}else showErr('e_mode',false);
            if(!ok)return;
            lock(true);
            try{
              const r=await fetch('/api/demandes-avance-salaire/'+DID+'/decision-manager',{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({action:'approuver',montant_accorde:montant,mode_remboursement_appliquer:mode})
              });
              const data=await r.json();
              if(r.ok) done('approuve',data.message||'L\\'employé va recevoir un email pour confirmer votre décision.');
              else{alert('Erreur : '+(data.error||'inconnue'));lock(false);}
            }catch(e){alert('Erreur réseau');lock(false);}
          }

          async function refuser(){
            const commentaire=document.getElementById('commentaire_refus').value.trim();
            if(!commentaire){showErr('e_refus',true);return;}
            showErr('e_refus',false);
            lock(true);
            try{
              const r=await fetch('/api/demandes-avance-salaire/'+DID+'/decision-manager',{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({action:'refuser',commentaire_refus:commentaire})
              });
              const data=await r.json();
              if(r.ok) done('refuse',data.message||'L\\'employé a été notifié du refus.');
              else{alert('Erreur : '+(data.error||'inconnue'));lock(false);}
            }catch(e){alert('Erreur réseau');lock(false);}
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Erreur page décision manager:', err);
    res.status(500).send('<h1>Erreur serveur</h1>');
  }
});

// ==================== STEP 2: MANAGER DECISION API (POST) ====================

app.post('/api/demandes-avance-salaire/:id/decision-manager', async (req, res) => {
  const { id } = req.params;
  const { action, montant_accorde, mode_remboursement_appliquer, commentaire_refus } = req.body;

  if (!['approuver', 'refuser'].includes(action)) {
    return res.status(400).json({ error: 'Action invalide' });
  }

  try {
    const result = await poolHR.query(
      `SELECT d.*, e.nom, e.prenom, e.poste, e.matricule, e.adresse_mail
       FROM demandes_avance_salaire d
       JOIN employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Demande non trouvée' });
    const demande = result.rows[0];

    // State guard — only process if waiting for manager
    if (demande.statut !== 'en_attente_admin') {
      return res.status(409).json({
        error: `Statut invalide pour cette action : ${demande.statut}`
      });
    }

    // ---- MANAGER REFUSES ----
    if (action === 'refuser') {
      const commentaire = (commentaire_refus || '').trim();
      if (!commentaire) return res.status(400).json({ error: 'Motif du refus obligatoire' });

      await poolHR.query(
        `UPDATE demandes_avance_salaire
         SET statut='refuse_admin', commentaire_refus=$1, updated_at=CURRENT_TIMESTAMP
         WHERE id=$2`,
        [commentaire, id]
      );

      if (demande.adresse_mail) {
        await sendEmailWithRetry({
          from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
          to: demande.adresse_mail,
          subject: 'Votre demande d\'avance sur salaire — Refusée',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
              <h2 style="color:#ef4444;border-bottom:3px solid #ef4444;padding-bottom:10px;">
                ❌ Demande d'avance refusée
              </h2>
              <div style="background:#fef2f2;padding:20px;border-radius:8px;margin:20px 0;border-left:4px solid #ef4444;">
                <p>Bonjour <strong>${escapeHtml(demande.nom)} ${escapeHtml(demande.prenom)}</strong>,</p>
                <p>Votre demande d'avance sur salaire de <strong>${formatMontantTND(demande.montant_demande)} TND</strong>
                   n'a pas pu être accordée.</p>
                <p><strong>Motif :</strong> ${escapeHtml(commentaire)}</p>
              </div>
              <p style="color:#6b7280;font-size:13px;">
                Pour toute question, rapprochez-vous de votre responsable ou de l'administration RH.
              </p>
            </div>
          `
        }, 'Refus avance — email employé');
      }

      return res.json({ success: true, message: 'Demande refusée. L\'employé a été notifié.' });
    }

    // ---- MANAGER APPROVES (possibly with modified terms) ----
    const montant = parseFloat(montant_accorde);
    const mode = (mode_remboursement_appliquer || '').trim();

    if (!Number.isFinite(montant) || montant <= 0) {
      return res.status(400).json({ error: 'montant_accorde doit être un nombre positif' });
    }
    if (!mode) {
      return res.status(400).json({ error: 'mode_remboursement_appliquer est obligatoire' });
    }

    // Save manager's proposed terms, move to awaiting employee confirmation
    await poolHR.query(
      `UPDATE demandes_avance_salaire
       SET statut='en_attente_employe',
           montant_accorde=$1,
           mode_remboursement_appliquer=$2,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$3`,
      [montant, mode, id]
    );

    // Determine if manager modified the terms
    const montantModifie = Math.abs(montant - parseFloat(demande.montant_demande)) > 0.001;
    const modeModifie = mode.trim() !== demande.mode_remboursement_souhaite.trim();
    const termsChanged = montantModifie || modeModifie;

    const confirmLink = `${BASE_URL}/avance-confirmation-employe?id=${id}`;

    // Email to employee with manager's decision — they must accept or reject
    if (demande.adresse_mail) {
      await sendEmailWithRetry({
        from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
        to: demande.adresse_mail,
        subject: termsChanged
          ? '⚠️ Votre demande d\'avance — conditions modifiées, confirmation requise'
          : '✅ Votre demande d\'avance approuvée — confirmation requise',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;">
            <h2 style="color:${termsChanged ? '#f59e0b' : '#10b981'};border-bottom:3px solid ${termsChanged ? '#f59e0b' : '#10b981'};padding-bottom:10px;">
              ${termsChanged ? '⚠️ Décision avec conditions modifiées' : '✅ Demande approuvée par l\'administration'}
            </h2>

            <p>Bonjour <strong>${escapeHtml(demande.nom)} ${escapeHtml(demande.prenom)}</strong>,</p>

            ${termsChanged ? `
              <div style="background:#fffbeb;padding:16px 20px;border-radius:8px;border-left:4px solid #f59e0b;margin:16px 0;">
                <p style="margin:0;color:#92400e;">
                  <strong>⚠️ L'administration a modifié les conditions de votre demande.</strong>
                  Veuillez lire attentivement et confirmer ou refuser ces nouvelles conditions.
                </p>
              </div>
            ` : `
              <div style="background:#f0fdf4;padding:16px 20px;border-radius:8px;border-left:4px solid #10b981;margin:16px 0;">
                <p style="margin:0;color:#065f46;">
                  Votre demande a été approuvée avec les conditions que vous avez proposées.
                  Veuillez confirmer votre accord.
                </p>
              </div>
            `}

            <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
              <thead>
                <tr>
                  <th style="text-align:left;padding:10px;background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;font-size:12px;text-transform:uppercase;">Élément</th>
                  <th style="text-align:center;padding:10px;background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;font-size:12px;text-transform:uppercase;">Votre demande</th>
                  <th style="text-align:center;padding:10px;background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;font-size:12px;text-transform:uppercase;">Décision administration</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="padding:12px 10px;border:1px solid #e2e8f0;font-weight:600;color:#374151;">Montant</td>
                  <td style="padding:12px 10px;border:1px solid #e2e8f0;text-align:center;color:#64748b;">${formatMontantTND(demande.montant_demande)} TND</td>
                  <td style="padding:12px 10px;border:1px solid #e2e8f0;text-align:center;font-weight:700;color:${montantModifie ? '#dc2626' : '#10b981'};">
                    ${formatMontantTND(montant)} TND ${montantModifie ? '⚠️' : '✅'}
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 10px;border:1px solid #e2e8f0;font-weight:600;color:#374151;">Remboursement</td>
                  <td style="padding:12px 10px;border:1px solid #e2e8f0;text-align:center;color:#64748b;">${escapeHtml(demande.mode_remboursement_souhaite)}</td>
                  <td style="padding:12px 10px;border:1px solid #e2e8f0;text-align:center;font-weight:700;color:${modeModifie ? '#dc2626' : '#10b981'};">
                    ${escapeHtml(mode)} ${modeModifie ? '⚠️' : '✅'}
                  </td>
                </tr>
              </tbody>
            </table>

            <div style="text-align:center;margin:30px 0;">
              <a href="${confirmLink}"
                 style="display:inline-block;padding:14px 36px;background:#2563eb;color:white;
                        text-decoration:none;border-radius:8px;font-weight:bold;font-size:16px;">
                👉 Voir et confirmer ma décision
              </a>
            </div>
            <p style="color:#6b7280;font-size:13px;text-align:center;">
              Vous devrez accepter ou refuser les conditions proposées par l'administration.
            </p>
          </div>
        `
      }, 'Décision manager — email employé pour confirmation');
    }

    return res.json({
      success: true,
      message: termsChanged
        ? 'Conditions modifiées envoyées à l\'employé pour confirmation.'
        : 'Approbation envoyée à l\'employé pour confirmation.'
    });

  } catch (err) {
    console.error('❌ Erreur décision manager avance:', err);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  }
});

// ==================== STEP 3: EMPLOYEE CONFIRMATION PAGE (GET) ====================

app.get('/avance-confirmation-employe', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('<h1>ID manquant</h1>');

  try {
    const result = await poolHR.query(
      `SELECT d.*, e.nom, e.prenom, e.poste, e.matricule, e.adresse_mail
       FROM demandes_avance_salaire d
       JOIN employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;background:#f4f4f4;">
          <div style="background:white;max-width:480px;margin:0 auto;padding:40px;border-radius:12px;">
            <div style="font-size:48px;">❌</div><h2 style="color:#ef4444;">Demande non trouvée</h2>
          </div>
        </body></html>
      `);
    }

    const d = result.rows[0];

    // Already confirmed/rejected by employee
    if (d.statut !== 'en_attente_employe') {
      const labels = {
        approuve:       { icon: '✅', color: '#10b981', text: 'Vous avez accepté — l\'avance est confirmée' },
        refuse_employe: { icon: '🚫', color: '#ef4444', text: 'Vous avez refusé les conditions proposées' },
        refuse_admin:   { icon: '❌', color: '#ef4444', text: 'Cette demande a été refusée par l\'administration' }
      };
      const info = labels[d.statut] || { icon: 'ℹ️', color: '#64748b', text: d.statut };
      return res.send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;background:#f4f4f4;">
          <div style="background:white;max-width:500px;margin:0 auto;padding:40px;border-radius:12px;">
            <div style="font-size:48px;">${info.icon}</div>
            <h2 style="color:${info.color};margin-top:16px;">${info.text}</h2>
          </div>
        </body></html>
      `);
    }

    const montantModifie = Math.abs(parseFloat(d.montant_accorde) - parseFloat(d.montant_demande)) > 0.001;
    const modeModifie = (d.mode_remboursement_appliquer || '').trim() !== (d.mode_remboursement_souhaite || '').trim();

    res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Confirmation — Avance sur Salaire</title>
        <style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{font-family:'Segoe UI',Arial,sans-serif;background:linear-gradient(135deg,#0f4c81,#1e88e5);min-height:100vh;padding:30px 16px}
          .card{background:white;max-width:660px;margin:0 auto;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25)}
          .hdr{background:#0f4c81;color:white;padding:26px 32px}
          .hdr h1{font-size:20px;margin-bottom:4px}
          .hdr p{font-size:13px;color:#90caf9}
          .body{padding:28px 32px}
          .alert{padding:16px 20px;border-radius:10px;margin-bottom:20px;font-size:14px}
          .alert-warn{background:#fffbeb;border-left:4px solid #f59e0b;color:#92400e}
          .alert-ok{background:#f0fdf4;border-left:4px solid #10b981;color:#065f46}
          table{width:100%;border-collapse:collapse;font-size:14px;margin:16px 0}
          th{background:#f8fafc;padding:10px;color:#64748b;border:1px solid #e2e8f0;font-size:11px;text-transform:uppercase;text-align:center}
          th:first-child{text-align:left}
          td{padding:12px 10px;border:1px solid #e2e8f0;vertical-align:top}
          td:not(:first-child){text-align:center}
          .changed{color:#dc2626;font-weight:700}
          .same{color:#10b981;font-weight:700}
          .sec-title{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px;margin:22px 0 10px}
          .checkbox-row{display:flex;align-items:flex-start;gap:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-top:16px}
          .checkbox-row input{margin-top:3px;width:18px;height:18px;cursor:pointer;flex-shrink:0}
          .checkbox-row label{font-size:14px;color:#374151;cursor:pointer;line-height:1.5}
          .signature-box{margin-top:18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px}
          #signaturePad{width:100%;height:180px;border:2px dashed #94a3b8;border-radius:8px;background:white;cursor:crosshair;touch-action:none;display:block}
          .clear-sign{margin-top:8px;padding:8px 14px;border:none;border-radius:6px;background:#64748b;color:white;cursor:pointer;font-weight:600}
          .clear-sign:hover{background:#475569}
          .err{color:#ef4444;font-size:12px;margin-top:6px;display:none}
          .btn-row{display:flex;gap:12px;margin-top:24px}
          .btn{flex:1;padding:14px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:all .2s}
          .btn-accept{background:#10b981;color:white}
          .btn-accept:hover:not(:disabled){background:#059669;transform:translateY(-1px)}
          .btn-decline{background:#ef4444;color:white}
          .btn-decline:hover:not(:disabled){background:#dc2626;transform:translateY(-1px)}
          .btn:disabled{opacity:.55;cursor:not-allowed;transform:none}
        </style>
      </head>
      <body>
        <div class="card">
          <div class="hdr">
            <h1>💰 Avance sur Salaire — Votre Confirmation</h1>
            <p>Demande #${d.id} &nbsp;·&nbsp; L'administration a rendu sa décision</p>
          </div>
          <div class="body">

            ${(montantModifie || modeModifie) ? `
              <div class="alert alert-warn">
                <strong>⚠️ Attention :</strong> L'administration a modifié les conditions de votre demande.
                Veuillez comparer attentivement avant de confirmer.
              </div>
            ` : `
              <div class="alert alert-ok">
                <strong>✅ Bonne nouvelle :</strong> L'administration a approuvé votre demande
                avec les conditions que vous avez proposées.
              </div>
            `}

            <div class="sec-title">Comparatif — Votre demande vs Décision administration</div>
            <table>
              <thead>
                <tr>
                  <th>Élément</th>
                  <th>Votre demande</th>
                  <th>Décision administration</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="font-weight:600;color:#374151;">Montant</td>
                  <td style="color:#64748b;">${formatMontantTND(d.montant_demande)} TND</td>
                  <td class="${montantModifie ? 'changed' : 'same'}">
                    ${formatMontantTND(d.montant_accorde)} TND ${montantModifie ? '⚠️ Modifié' : '✅'}
                  </td>
                </tr>
                <tr>
                  <td style="font-weight:600;color:#374151;">Remboursement</td>
                  <td style="color:#64748b;">${escapeHtml(d.mode_remboursement_souhaite)}</td>
                  <td class="${modeModifie ? 'changed' : 'same'}">
                    ${escapeHtml(d.mode_remboursement_appliquer)} ${modeModifie ? '⚠️ Modifié' : '✅'}
                  </td>
                </tr>
              </tbody>
            </table>

            <div class="sec-title">Votre accord</div>
            <div class="checkbox-row">
              <input type="checkbox" id="accepte" />
              <label for="accepte">
                Je, <strong>${escapeHtml(d.nom)} ${escapeHtml(d.prenom)}</strong>,
                confirme avoir pris connaissance de la décision de l'administration
                et j'accepte les conditions indiquées ci-dessus :
                montant de <strong>${formatMontantTND(d.montant_accorde)} TND</strong>
                avec remboursement selon : <strong>${escapeHtml(d.mode_remboursement_appliquer)}</strong>.
              </label>
            </div>
            <div class="err" id="e_check">Veuillez cocher la case pour confirmer votre accord.</div>

            <div class="sec-title">Signature employé</div>
            <div class="signature-box">
              <p style="font-size:13px;color:#374151;margin-bottom:8px;">
                Veuillez signer ci-dessous avant d'accepter ou refuser.
              </p>
              <canvas id="signaturePad"></canvas>
              <button type="button" class="clear-sign" onclick="clearSignature()">
                Effacer la signature
              </button>
              <div class="err" id="e_signature">Veuillez signer avant de continuer.</div>
            </div>

            <div class="btn-row">
              <button class="btn btn-accept" id="btnAccept" onclick="accepter()">
                ✅ J'accepte les conditions
              </button>
              <button class="btn btn-decline" id="btnDecline" onclick="refuser()">
                ❌ Je refuse
              </button>
            </div>

          </div>
        </div>
        <script>
  const DID = ${parseInt(id, 10)};

// ── Signature pad setup ──────────────────────────────
const canvas = document.getElementById('signaturePad');
const ctx = canvas.getContext('2d');
let drawing = false;
let hasSignature = false;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;          // ← GUARD ADDED
  const oldImage = hasSignature ? canvas.toDataURL('image/png') : null;
  canvas.width = rect.width;
  canvas.height = 180;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111827';
  if (oldImage) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.src = oldImage;
  }
}

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const touch = e.touches ? e.touches[0] : e;
  return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
}

function startDraw(e) {
  drawing = true;
  hasSignature = true;
  document.getElementById('e_signature').style.display = 'none';
  const pos = getPos(e);
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
  e.preventDefault();
}

function draw(e) {
  if (!drawing) return;
  const pos = getPos(e);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
  e.preventDefault();
}

function stopDraw() {
  drawing = false;
  ctx.beginPath();
}

function clearSignature() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  hasSignature = false;
}

window.addEventListener('load', () => resizeCanvas());   // ← CHANGED from resizeCanvas()
window.addEventListener('resize', resizeCanvas);
canvas.addEventListener('mousedown', startDraw);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDraw);
canvas.addEventListener('mouseleave', stopDraw);
canvas.addEventListener('touchstart', startDraw, { passive: false });
canvas.addEventListener('touchmove', draw, { passive: false });
canvas.addEventListener('touchend', stopDraw);
// ────────────────────────────────────────────────────

  function lock(on) {
    ['btnAccept', 'btnDecline'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.disabled = on;
    });
  }
function done(statut, msg) {
    const ok = statut === 'approuve';
    document.querySelector('.body').innerHTML =
      '<div style="text-align:center;padding:50px 20px;">' +
        '<div style="font-size:60px;">' + (ok ? '✅' : '🚫') + '</div>' +
        '<h2 style="color:' + (ok ? '#10b981' : '#ef4444') + ';margin:18px 0 10px;">' +
          (ok ? 'Avance confirm\u00e9e !' : 'Conditions refus\u00e9es') +
        '</h2>' +
        '<p style="color:#64748b;font-size:14px;">' + msg + '</p>' +
      '</div>';
  }

  async function accepter() {
    if (!document.getElementById('accepte').checked) {
      document.getElementById('e_check').style.display = 'block';
      return;
    }
    if (!hasSignature) {
      document.getElementById('e_signature').style.display = 'block';
      return;
    }
    document.getElementById('e_check').style.display = 'none';
    document.getElementById('e_signature').style.display = 'none';
    lock(true);
    try {
      const signatureData = canvas.toDataURL('image/png');
      const r = await fetch('/api/demandes-avance-salaire/' + DID + '/confirmation-employe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accepter', signature_confirmation_employe: signatureData })
      });
      const data = await r.json();
      if (r.ok) done('approuve', data.message || 'Le document final vous a été envoyé par email.');
      else { alert('Erreur : ' + (data.error || 'inconnue')); lock(false); }
    } catch (e) { alert('Erreur réseau'); lock(false); }
  }

  async function refuser() {
    if (!confirm('Êtes-vous sûr de vouloir refuser les conditions proposées ?\nL\'administration sera notifiée.')) return;
    lock(true);
    try {
      const r = await fetch('/api/demandes-avance-salaire/' + DID + '/confirmation-employe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refuser' })
      });
      const data = await r.json();
      if (r.ok) done('refuse', data.message || "L'administration a été notifiée de votre refus.");
      else { alert('Erreur : ' + (data.error || 'inconnue')); lock(false); }
    } catch (e) { alert('Erreur réseau'); lock(false); }
  }
</script>

       
      </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Erreur page confirmation employé:', err);
    res.status(500).send('<h1>Erreur serveur</h1>');
  }
});

// ==================== STEP 3: EMPLOYEE CONFIRMATION API (POST) ====================

app.post('/api/demandes-avance-salaire/:id/confirmation-employe', async (req, res) => {
  const { id } = req.params;
  const { action, signature_confirmation_employe } = req.body;

  if (!['accepter', 'refuser'].includes(action)) {
    return res.status(400).json({ error: 'Action invalide' });
  }

  try {
    const result = await poolHR.query(
      `SELECT d.*, e.nom, e.prenom, e.poste, e.matricule, e.adresse_mail
       FROM demandes_avance_salaire d
       JOIN employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Demande non trouvée' });
    const demande = result.rows[0];

    // State guard
    if (demande.statut !== 'en_attente_employe') {
      return res.status(409).json({
        error: `Statut invalide pour cette action : ${demande.statut}`
      });
    }

    // ---- EMPLOYEE REFUSES MANAGER'S TERMS ----
    if (action === 'refuser') {
      await poolHR.query(
        `UPDATE demandes_avance_salaire
         SET statut='refuse_employe', updated_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [id]
      );

      // Notify Fethi that employee rejected his terms
      await sendEmailWithRetry({
        from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
        to: SALARY_ADVANCE_MANAGER,
        subject: `🚫 Avance refusée par l'employé — ${demande.nom} ${demande.prenom}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#ef4444;">🚫 L'employé a refusé les conditions proposées</h2>
            <div style="background:#fef2f2;padding:20px;border-radius:8px;margin:20px 0;">
              <p><strong>Employé :</strong> ${escapeHtml(demande.nom)} ${escapeHtml(demande.prenom)}</p>
              <p><strong>Montant qu'il avait demandé :</strong> ${formatMontantTND(demande.montant_demande)} TND</p>
              <p><strong>Montant que vous avez accordé :</strong> ${formatMontantTND(demande.montant_accorde)} TND</p>
              <p><strong>Remboursement proposé :</strong> ${escapeHtml(demande.mode_remboursement_appliquer)}</p>
            </div>
            <p style="color:#6b7280;font-size:13px;">
              Un traitement manuel est nécessaire. Veuillez contacter l'employé directement.
            </p>
          </div>
        `
      }, 'Refus employé — notification admin');

      return res.json({
        success: true,
        message: 'Votre refus a été enregistré. L\'administration a été notifiée et vous contactera.'
      });
    }

    // ---- EMPLOYEE ACCEPTS ----
    if (!signature_confirmation_employe || !signature_confirmation_employe.startsWith('data:image/png;base64,')) {
      return res.status(400).json({ error: 'Signature obligatoire' });
    }

    await poolHR.query(
      `UPDATE demandes_avance_salaire
       SET statut='approuve',
           signature_confirmation_employe=$1,
           date_signature_confirmation=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [signature_confirmation_employe, id]
    );

    demande.signature_confirmation_employe = signature_confirmation_employe;
    demande.date_signature_confirmation = new Date();

    // Generate FINAL PDF with everything filled in
    const pdfBuffer = await genererPDFAvanceSalaire(demande);
    const pdfFileName = `Avance_Salaire_FINALE_${demande.nom}_${demande.prenom}_${Date.now()}.pdf`;

    // Send final PDF to employee
    if (demande.adresse_mail) {
      await sendEmailWithRetry({
        from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
        to: demande.adresse_mail,
        subject: '✅ Avance sur salaire confirmée — Document final',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#10b981;border-bottom:3px solid #10b981;padding-bottom:10px;">
              ✅ Avance sur salaire confirmée
            </h2>
            <div style="background:#f0fdf4;padding:20px;border-radius:8px;margin:20px 0;border-left:4px solid #10b981;">
              <p>Bonjour <strong>${escapeHtml(demande.nom)} ${escapeHtml(demande.prenom)}</strong>,</p>
              <p>Votre avance sur salaire est définitivement confirmée.</p>
            </div>
            <div style="background:#f8fafc;padding:20px;border-radius:8px;margin:20px 0;">
              <p><strong>Montant accordé :</strong> <strong style="color:#2563eb;font-size:16px;">${formatMontantTND(demande.montant_accorde)} TND</strong></p>
              <p><strong>Mode de remboursement :</strong> ${escapeHtml(demande.mode_remboursement_appliquer)}</p>
            </div>
            <p style="color:#6b7280;font-size:13px;">
              📎 Le document officiel signé est joint en PDF.
              Veuillez vous rapprocher de l'administration pour récupérer l'avance.
            </p>
          </div>
        `,
        attachments: [{ filename: pdfFileName, content: pdfBuffer, contentType: 'application/pdf' }]
      }, 'Confirmation employé — avance finale');
    }

    // Send final PDF to Nesria (HR) only — after employee confirms
    await sendEmailWithRetry({
      from: { name: 'Administration STS', address: 'administration.STS@avocarbon.com' },
      to: SALARY_ADVANCE_HR,
      subject: `✅ Avance CONFIRMÉE par l'employé — ${demande.nom} ${demande.prenom}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;">
          <h2 style="color:#10b981;">✅ Avance sur salaire — Dossier complet</h2>
          <div style="background:#f8fafc;padding:20px;border-radius:8px;margin:20px 0;">
            <p><strong>Employé :</strong> ${escapeHtml(demande.nom)} ${escapeHtml(demande.prenom)}</p>
            <p><strong>Montant accordé :</strong> <strong style="color:#2563eb;">${formatMontantTND(demande.montant_accorde)} TND</strong></p>
            <p><strong>Remboursement :</strong> ${escapeHtml(demande.mode_remboursement_appliquer)}</p>
            <p><strong>Signature demandeur :</strong> ${escapeHtml(demande.signature_demandeur)}</p>
          </div>
          <p style="color:#6b7280;font-size:13px;">
            📎 Le PDF final (avec toutes les sections remplies) est joint. Dossier prêt pour traitement.
          </p>
        </div>
      `,
      attachments: [{ filename: pdfFileName, content: pdfBuffer, contentType: 'application/pdf' }]
    }, 'Avance confirmée — notification HR finale');

    return res.json({
      success: true,
      message: 'Avance confirmée ! Le document final vous a été envoyé par email.'
    });

  } catch (err) {
    console.error('❌ Erreur confirmation employé avance:', err);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  }
});

app.post('/api/demandes', async (req, res) => {
  const {
    employe_id, type_demande, titre, date_depart, date_retour,
    heure_depart, heure_retour, demi_journee, type_conge,
    frais_deplacement, type_conge_autre, nombre_jours
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
    const nombreJoursFinal = nombre_jours ? parseFloat(nombre_jours) : null;

    const insertResult = await poolHR.query(
      `INSERT INTO demande_rh 
       (employe_id, type_demande, titre, date_depart, date_retour, 
        heure_depart, heure_retour, demi_journee, type_conge, type_conge_autre, frais_deplacement, nombre_jours, statut)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [employe_id, type_demande, titre, date_depart, dateRetourFinal,
        heureDepartFinal, heureRetourFinal, demi_journee || false,
        typeCongeFinal, typeCongeAutreFinal, fraisDeplacementFinal, nombreJoursFinal, 'en_attente']
    );

    const demandeId = insertResult.rows[0].id;

    console.log(`\n🔍 [DEBUG] New demande created:`);
    console.log(`   Demande ID  : ${demandeId}`);
    console.log(`   Employee    : ${employe.nom} ${employe.prenom} (id: ${employe_id})`);
    console.log(`   Type        : ${type_demande}`);
    console.log(`   Nombre jours: ${nombreJoursFinal}`);
    console.log(`   Responsable1: ${employe.mail_responsable1 || 'NOT SET'}`);
    console.log(`   Responsable2: ${employe.mail_responsable2 || 'NOT SET'}`);

    if (employe.mail_responsable1) {
      console.log(`📤 [DEBUG][DEMANDE ${demandeId}] Sending email to responsable1: ${employe.mail_responsable1}`);

      const emailResult = await envoyerEmailResponsable(employe, employe.mail_responsable1, demandeId, 1, {
        type_demande, titre, date_depart,
        date_retour: dateRetourFinal,
        heure_depart: heureDepartFinal,
        heure_retour: heureRetourFinal,
        demi_journee,
        type_conge: typeCongeFinal,
        type_conge_autre: typeCongeAutreFinal,
        frais_deplacement: fraisDeplacementFinal,
        nombre_jours: nombreJoursFinal
      });

      console.log(`📬 [DEBUG][DEMANDE ${demandeId}] Email to responsable1 result:`, JSON.stringify(emailResult));
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

  console.log(`\n📨 [DEBUG][envoyerEmailResponsable] Called:`);
  console.log(`   Employee    : ${employe.nom} ${employe.prenom}`);
  console.log(`   Recipient   : ${emailResponsable}`);
  console.log(`   Demande ID  : ${demandeId}`);
  console.log(`   Niveau      : ${niveau}`);
  console.log(`   employe.id  : ${employe.id || employe.employe_id || 'UNDEFINED'}`);

  const baseUrl = BASE_URL;
  const lienApprobation = `${baseUrl}/approuver-demande?id=${demandeId}&niveau=${niveau}`;

  let typeLabel = details.type_demande === 'conges' ? 'Congé' :
    details.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';

  let leaveBalanceValue = '0.000';
  try {
    const employeeId = employe?.id || employe?.employe_id || employe?.employee_id;

    console.log(`   [DEBUG] employeeId for leave balance lookup: ${employeeId}`);

    if (employeeId) {
      const lb = await poolHR.query(`SELECT balance FROM leave_balances WHERE employee_id = $1`, [employeeId]);

      console.log(`   [DEBUG] Leave balance query returned ${lb.rows.length} row(s): ${lb.rows.length > 0 ? lb.rows[0].balance : 'none'}`);

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
      ${details.nombre_jours ? `<p><strong>Nombre de jours ouvrables demandés:</strong> <strong style="color:#1976d2;">${details.nombre_jours} jour${details.nombre_jours > 1 ? 's' : ''}</strong></p>` : ''}
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
    console.log(`📤 [DEBUG][DEMANDE ${demandeId}] Attempting sendEmailWithRetry to: ${emailResponsable}`);
    await sendEmailWithRetry(mailOptions, `Notification demande RH niveau ${niveau}`);
    console.log(`✅ [DEBUG][DEMANDE ${demandeId}] Email successfully sent to: ${emailResponsable} (niveau ${niveau})`);
    return { success: true };
  } catch (error) {
    console.error(`❌ [DEBUG][DEMANDE ${demandeId}] FAILED to send to: ${emailResponsable} (niveau ${niveau})`);
    console.error(`   Error code   : ${error.code || 'N/A'}`);
    console.error(`   Error message: ${error.message || JSON.stringify(error)}`);
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
            ${demande.nombre_jours ? `<div class="info-item"><div class="info-label">Jours demandés:</div><div class="info-value" style="color:#1976d2; font-weight:600;">${demande.nombre_jours} jour${demande.nombre_jours > 1 ? 's' : ''}</div></div>` : ''}
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
        type_conge_autre: demande.type_conge_autre, frais_deplacement: demande.frais_deplacement,
        nombre_jours: demande.nombre_jours
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
            ${demande.nombre_jours ? `<p><strong>Nombre de jours demandés:</strong> ${demande.nombre_jours} jour${demande.nombre_jours > 1 ? 's' : ''}</p>` : ''}
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
              ${joursOuvres > 0 ? `<p><strong>Jours ouvrés (calculés):</strong> <strong>${joursOuvres} jour${joursOuvres > 1 ? 's' : ''}</strong></p>` : ''}
              ${demande.nombre_jours ? `<p><strong>Jours demandés (employé):</strong> <strong>${demande.nombre_jours} jour${demande.nombre_jours > 1 ? 's' : ''}</strong></p>` : ''}
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

async function sendTeamAttendanceReportPerResponsable() {
  const lockId = 'team_attendance_report_job';
  const lock = await acquireJobLock(lockId);

  if (!lock.acquired) {
    console.log(`⏭️ [Team Attendance Report] Skipping — lock held by another instance`);
    return;
  }

  try {
    const today = new Date();
    const day = today.getDay();

    if (day === 0 || day === 6) {
      console.log("Weekend - no team attendance report");
      return;
    }

    const todayStr = today.toISOString().split('T')[0];

    const RESPONSIBLE_EMAIL = 'taha.khiari@avocarbon.com';
    const REPORT_RECIPIENT = 'taha.khiari@avocarbon.com';

    const attendanceResult = await poolAttendance.query(`
      SELECT full_name, arrival_time, departure_time
      FROM attendance_daily
      WHERE work_date = $1
      ORDER BY arrival_time
    `, [todayStr]);

    if (attendanceResult.rows.length === 0) {
      console.log("No attendance data today — skipping team report");
      return;
    }

    const employeesResult = await poolHR.query(`
      SELECT 
        CONCAT(prenom, ' ', nom) AS full_name,
        poste,
        mail_responsable1
      FROM employees
      WHERE date_depart IS NULL
        AND mail_responsable1 = $1
    `, [RESPONSIBLE_EMAIL]);

    if (employeesResult.rows.length === 0) {
      console.log(`No employees found under ${RESPONSIBLE_EMAIL}`);
      return;
    }

    const employeeMap = {};
    employeesResult.rows.forEach(emp => {
      employeeMap[emp.full_name.trim().toLowerCase()] = emp.poste || '—';
    });

    console.log("🔍 [DEBUG] Attendance DB names:", attendanceResult.rows.map(r => r.full_name));
    console.log("🔍 [DEBUG] HR DB employee keys:", Object.keys(employeeMap));

    const teamRecords = attendanceResult.rows
      .filter(record => employeeMap[record.full_name.trim().toLowerCase()])
      .map(record => ({
        full_name: record.full_name,
        poste: employeeMap[record.full_name.trim().toLowerCase()],
        arrival_time: record.arrival_time || '—',
        departure_time: record.departure_time || '—'
      }));

    console.log(`🔍 [DEBUG] teamRecords matched: ${teamRecords.length}`);

    if (teamRecords.length === 0) {
      console.log("No team members present today — skipping team report email");
      return;
    }

    const rows = teamRecords.map((r, i) => `
      <tr style="border-bottom:1px solid #f3f4f6; ${i % 2 !== 0 ? 'background:#fafafa;' : ''}">
        <td style="padding:10px; color:#374151; font-size:14px;">${r.full_name}</td>
        <td style="padding:10px; color:#374151; font-size:14px;">${r.poste}</td>
        <td style="padding:10px; text-align:center; color:#374151; font-size:14px;">${r.arrival_time}</td>
        <td style="padding:10px; text-align:center; color:${r.departure_time !== '—' ? '#374151' : '#9ca3af'}; font-size:14px;">${r.departure_time}</td>
      </tr>
    `).join('');

    const mailOptions = {
      from: {
        name: 'Administration STS',
        address: 'administration.STS@avocarbon.com'
      },
      to: REPORT_RECIPIENT,
      subject: `Rapport de Présence Équipe — ${formatDateFR(today)}`,
      html: `
        <!DOCTYPE html>
        <html lang="fr">
        <head><meta charset="UTF-8"></head>
        <body style="margin:0; padding:30px 20px; background:#f4f4f4; font-family: Arial, sans-serif;">

          <div style="width:100%; background:#ffffff; border:1px solid #ddd; border-radius:6px; overflow:hidden;">

            <!-- HEADER -->
            <div style="background:#2d4a6e; padding:24px 32px;">
              <p style="margin:0; color:#94a3b8; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Administration STS</p>
              <h1 style="margin:6px 0 0; color:#ffffff; font-size:20px; font-weight:700;">Rapport de Présence — Votre Équipe</h1>
              <p style="margin:4px 0 0; color:#94a3b8; font-size:13px;">
                ${today.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                — ${today.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>

            <!-- STATS -->
            <div style="border-bottom:1px solid #e5e7eb; padding:20px 32px; background:#f9fafb;">
              <span style="font-size:28px; font-weight:700; color:#1e293b;">${teamRecords.length}</span>
              <span style="font-size:13px; color:#6b7280; margin-left:8px;">membre(s) présent(s) aujourd'hui</span>
            </div>

            <!-- TABLE -->
            <div style="padding:28px 32px;">
              <p style="margin:0 0 12px; font-size:13px; font-weight:700; color:#1e293b; text-transform:uppercase; letter-spacing:0.5px;">
                Arrivées du jour — ${formatDateFR(todayStr)}
              </p>

              <table style="width:100%; border-collapse:collapse; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #1e293b;">
                    <th style="text-align:left; padding:8px 10px; color:#374151; font-weight:600;">Employé</th>
                    <th style="text-align:left; padding:8px 10px; color:#374151; font-weight:600;">Poste</th>
                    <th style="text-align:center; padding:8px 10px; color:#374151; font-weight:600;">Arrivée</th>
                    <th style="text-align:center; padding:8px 10px; color:#374151; font-weight:600;">Départ</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows}
                </tbody>
              </table>
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

    await sendEmailWithRetry(mailOptions, `Team attendance report → ${REPORT_RECIPIENT}`);
    console.log(`✅ Team report sent to ${REPORT_RECIPIENT} (${teamRecords.length} employees present)`);

  } catch (error) {
    console.error("❌ Team attendance report error:", error);
  } finally {
    await releaseJobLock(lockId, lock.instanceId, lock.lockHash);
  }
}

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

  cron.schedule('30 9 * * 1-5', async () => {
    console.log("⏰ Running automatic attendance reports...");
    await sendAttendanceReport();
    //await sendTeamAttendanceReportPerResponsable();
  }, { timezone: "Africa/Tunis" });

  console.log("✅ Attendance reports scheduled for weekdays at 10:00 AM Tunisia time");

} catch (error) {
  console.warn("⚠️ Cron scheduling not available:", error.message);
}

// ==================== DB CONNECTION TEST ====================
async function testDatabaseConnections() {
  try {
    await poolHR.query('SELECT 1');
    console.log('✅ HR database connection OK');
  } catch (err) {
    console.error('❌ FATAL: HR database connection failed:', err.message);
    console.error('   Check DB_HOST, DB_USER, DB_PASS, DB_NAME env vars in Azure');
    process.exit(1);
  }
  try {
    await poolAttendance.query('SELECT 1');
    console.log('✅ Attendance database connection OK');
  } catch (err) {
    console.error('❌ FATAL: Attendance database connection failed:', err.message);
    process.exit(1);
  }
}

// ==================== SERVER START ====================

const PORT = process.env.PORT || 5001;

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

  await testDatabaseConnections();
  await ensureSalaryAdvanceTable();
  await verifySMTPConnection();

  try { await fs.access(TEMPLATE_TRAVAIL_PATH); console.log('✅ Template attestation travail trouvé'); }
  catch { console.warn('⚠️ Template attestation travail non trouvé'); }

  try { await fs.access(TEMPLATE_SALAIRE_PATH); console.log('✅ Template attestation salaire trouvé'); }
  catch { console.warn('⚠️ Template attestation salaire non trouvé'); }
});
