const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
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

// Récupérer tous les employés actifs (sans date de départ)
app.get('/api/employees/actifs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, matricule, nom, prenom, poste, adresse_mail, 
              mail_responsable1, mail_responsable2
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

// Créer une nouvelle demande RH
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
    frais_deplacement
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

    // Insérer la demande
    const insertResult = await pool.query(
      `INSERT INTO demande_rh 
       (employe_id, type_demande, titre, date_depart, date_retour, 
        heure_depart, heure_retour, demi_journee, type_conge, frais_deplacement, statut)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
  const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
  const lienApprobation = `${baseUrl}/approuver-demande?id=${demandeId}&niveau=${niveau}`;
  
  let typeLabel = details.type_demande === 'conges' ? 'Congé' : 
                  details.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';
  
  let detailsHtml = `
    <p><strong>Type:</strong> ${typeLabel}</p>
    <p><strong>Motif:</strong> ${details.titre}</p>
    <p><strong>Date de départ:</strong> ${details.date_depart}</p>
  `;

  if (details.type_demande === 'conges') {
    detailsHtml += `
      <p><strong>Date de retour:</strong> ${details.date_retour || 'Non spécifié'}</p>
      <p><strong>Demi-journée:</strong> ${details.demi_journee ? 'Oui' : 'Non'}</p>
      <p><strong>Type de congé:</strong> ${details.type_conge === 'annuel' ? 'Congé annuel' : details.type_conge === 'sans_solde' ? 'Congé sans solde' : 'Non spécifié'}</p>
    `;
  } else if (details.type_demande === 'autorisation') {
    detailsHtml += `
      <p><strong>Heure de départ:</strong> ${details.heure_depart || 'Non spécifié'}</p>
      <p><strong>Heure d'arrivée:</strong> ${details.heure_retour || 'Non spécifié'}</p>
    `;
  } else if (details.type_demande === 'mission') {
    detailsHtml += `
      <p><strong>Date de retour:</strong> ${details.date_retour || 'Non spécifié'}</p>
      <p><strong>Heure de sortie:</strong> ${details.heure_depart || 'Non spécifié'}</p>
      <p><strong>Heure de retour:</strong> ${details.heure_retour || 'Non spécifié'}</p>
      <p><strong>Frais de déplacement:</strong> ${details.frais_deplacement || 0} TND</p>
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
        <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">Demande RH en attente d'approbation</h2>
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
    console.log(`Email envoyé à ${emailResponsable} pour la demande ${demandeId}`);
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
              <div class="info-value">${demande.type_demande === 'conges' ? 'Congé' : demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission'}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Motif:</div>
              <div class="info-value">${demande.titre}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Date de départ:</div>
              <div class="info-value">${demande.date_depart}</div>
            </div>
            ${demande.date_retour ? `
            <div class="info-item">
              <div class="info-label">Date de retour:</div>
              <div class="info-value">${demande.date_retour}</div>
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
          </div>
          
          <div class="buttons">
            <button class="approve" onclick="approuver()">✅ Approuver</button>
            <button class="reject" onclick="toggleRefus()">❌ Refuser</button>
          </div>
          
          <div class="refus-section">
            <textarea id="commentaire" rows="4" placeholder="Veuillez indiquer le motif du refus..."></textarea>
            <button class="reject" onclick="refuser()" style="display:none; margin-top:10px;" id="confirmRefus">Confirmer le refus</button>
          </div>
        </div>

        <script>
          function toggleRefus() {
            document.getElementById('commentaire').style.display = 'block';
            document.getElementById('confirmRefus').style.display = 'inline-block';
          }

          async function approuver() {
            const response = await fetch('/api/demandes/${id}/approuver', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ niveau: ${niveau} })
            });
            
            if (response.ok) {
              alert('✅ Demande approuvée avec succès');
              window.location.reload();
            } else {
              alert('❌ Erreur lors de l\\'approbation');
            }
          }

          async function refuser() {
            const commentaire = document.getElementById('commentaire').value;
            if (!commentaire.trim()) {
              alert('Veuillez indiquer le motif du refus');
              return;
            }

            const response = await fetch('/api/demandes/${id}/refuser', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ niveau: ${niveau}, commentaire })
            });
            
            if (response.ok) {
              alert('✅ Demande refusée');
              window.location.reload();
            } else {
              alert('❌ Erreur lors du refus');
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

// Approuver une demande
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

    // Mettre à jour l'approbation
    await pool.query(
      `UPDATE demande_rh SET ${colonne} = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );

    // Vérifier si besoin d'approbation du responsable 2
    if (niveau == 1 && demande.mail_responsable2) {
      // Envoyer au responsable 2
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
          frais_deplacement: demande.frais_deplacement
        }
      );
      
      res.json({ 
        success: true, 
        message: 'Demande approuvée par le premier responsable, en attente du second' 
      });
    } else {
      // Demande complètement approuvée
      await pool.query(
        `UPDATE demande_rh SET statut = 'approuve' WHERE id = $1`,
        [id]
      );

      // Envoyer email de confirmation à l'employé
      await transporter.sendMail({
        from: {
          name: 'Administration STS',
          address: 'administration.STS@avocarbon.com'
        },
        to: demande.adresse_mail,
        subject: 'Demande RH approuvée',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #10b981;">✅ Votre demande RH a été approuvée</h2>
            <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Bonjour ${demande.nom} ${demande.prenom},</strong></p>
              <p>Votre demande de <strong>${demande.type_demande}</strong> pour le <strong>${demande.date_depart}</strong> a été approuvée.</p>
              <p><strong>Motif:</strong> ${demande.titre}</p>
            </div>
          </div>
        `
      });

      res.json({ 
        success: true, 
        message: 'Demande complètement approuvée' 
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de l\'approbation' });
  }
});

// Refuser une demande
app.post('/api/demandes/:id/refuser', async (req, res) => {
  const { id } = req.params;
  const { niveau, commentaire } = req.body;

  try {
    const demandeResult = await pool.query(
      `SELECT d.*, e.nom, e.prenom, e.adresse_mail
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

    // Mettre à jour le statut
    await pool.query(
      `UPDATE demande_rh 
       SET statut = 'refuse', commentaire_refus = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [commentaire, id]
    );

    // Envoyer email à l'employé
    await transporter.sendMail({
      from: {
        name: 'Administration STS',
        address: 'administration.STS@avocarbon.com'
      },
      to: demande.adresse_mail,
      subject: 'Demande RH refusée',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #ef4444;">❌ Votre demande RH a été refusée</h2>
          <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Bonjour ${demande.nom} ${demande.prenom},</strong></p>
            <p>Votre demande de <strong>${demande.type_demande}</strong> pour le <strong>${demande.date_depart}</strong> a été refusée.</p>
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

// Route de santé
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Serveur RH fonctionnel',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📧 Emails d'approbation: http://localhost:${PORT}/approuver-demande`);
  console.log(`👥 API Employés: http://localhost:${PORT}/api/employees/actifs`);
  console.log(`📋 API Demandes: http://localhost:${PORT}/api/demandes`);
});