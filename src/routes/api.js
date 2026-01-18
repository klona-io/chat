const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const { getDb } = require('../config/db');
const { JWT_SECRET, CHAT_ZONES } = require('../config/constants');
const state = require('../config/state');

module.exports = (io) => {

    // --- ROUTES API ---

    router.get('/zones', (req, res) => {
        res.json(CHAT_ZONES);
    });

    router.post('/login-operator', async (req, res) => {
        const { username, password } = req.body;
        try {
            const db = await getDb();
            const op = await db.get('SELECT * FROM operators WHERE username = ?', [username.toLowerCase()]);
            if (op && await bcrypt.compare(password, op.password_hash)) {
                const token = jwt.sign({ login: op.username, name: op.display_name || op.username, role: 'operator' }, JWT_SECRET);
                return res.json({ success: true, token });
            }
            res.status(401).json({ error: "Identifiants invalides" });
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: "Erreur serveur" });
        }
    });

    router.post('/login-user', (req, res) => {
        const token = jwt.sign({ name: req.body.username, role: 'user' }, JWT_SECRET);
        res.json({ token });
    });

    router.post('/rate-session', async (req, res) => {
        const { sessionId, rating } = req.body;
        try {
            const db = await getDb();
            await db.run('UPDATE chat_sessions SET rating = ? WHERE id = ?', [rating, sessionId]);
            res.json({ success: true });
        } catch (e) { res.status(500).send(); }
    });

    router.get('/history-data/:sessionId', async (req, res) => {
        try {
            const db = await getDb();
            const rows = await db.all('SELECT sender_name, content, is_operator, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC', [req.params.sessionId]);
            res.json(rows);
        } catch (e) { res.status(500).json({ error: "Erreur chargement" }); }
    });

    // --- ROUTES DE GESTION DES OPÉRATEURS ---

    router.get('/admin/operators', async (req, res) => {
        try {
            const db = await getDb();
            const rows = await db.all('SELECT username, display_name as name FROM operators');
            res.json(rows);
        } catch (e) {
            res.status(500).json({ error: "Erreur base de données" });
        }
    });

    router.get('/operators-online', async (req, res) => {
        try {
            const db = await getDb();
            const allOps = await db.all('SELECT username as login, display_name as name FROM operators');
            const onlineLogins = Object.keys(state.operatorSockets);
            const list = allOps
                .filter(op => onlineLogins.includes(op.login))
                .map(op => ({
                    login: op.login,
                    name: op.name || op.login
                }));
            res.json(list);
        } catch (e) {
            res.status(500).json({ error: "Erreur liste experts" });
        }
    });

    // HTML VIEW (Should ideally be a template or client side, but keeping as is for now)
    router.get('/history/:sessionId', async (req, res) => {
        try {
            const db = await getDb();
            const session = await db.get('SELECT * FROM chat_sessions WHERE id = ?', [req.params.sessionId]);
            const messages = await db.all('SELECT sender_name, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC', [req.params.sessionId]);

            if (!session) return res.status(404).send("Session introuvable.");

            res.setHeader('Content-Type', 'text/html; charset=utf-8');

            let alertHtml = "";
            if (session.reported) {
                alertHtml = `
                <div style="background:#fee2e2; padding:15px; border:2px solid #ef4444; border-radius:8px; margin-bottom:20px; color:#b91c1c;">
                    <h3 style="margin:0 0 5px 0;">⚠️ SESSION SIGNALÉE</h3>
                    <strong>Motif :</strong> ${session.report_reason || 'Non précisé'}
                </div>`;
            }

            let html = `
            <html>
            <body style="font-family:sans-serif; padding:20px; background:#f4f7f6; line-height:1.5;">
                <h2>Détails de la Session #${req.params.sessionId}</h2>
                ${alertHtml}
                <div style="background:#fff9c4; padding:15px; border:1px solid #fbc02d; border-radius:8px; margin-bottom:20px;">
                    <strong>Note Interne de l'expert :</strong><br>
                    ${(session.internal_notes || 'Aucune note.').replace(/\n/g, '<br>')}
                </div>
                <div style="background:white; padding:20px; border-radius:8px; border:1px solid #e2e8f0;">
                    <h3 style="margin-top:0;">Transcription des échanges</h3>
                    <hr style="border:0; border-top:1px solid #eee; margin-bottom:20px;">
                    ${messages.map(m => `
                        <div style="margin-bottom:10px;">
                            <small style="color:gray;">[${new Date(m.created_at).toLocaleString()}]</small> 
                            <strong style="color:#4f46e5;">${m.sender_name} :</strong> 
                            <span>${m.content}</span>
                        </div>
                    `).join('')}
                </div>
                <div style="margin-top:20px;">
                    <button onclick="window.close()" style="padding:10px 20px; cursor:pointer;">Fermer la fenêtre</button>
                </div>
            </body>
            </html>`;

            res.send(html);
        } catch (e) {
            console.error(e);
            res.status(500).send("Erreur lors de la récupération de l'historique.");
        }
    });

    router.put('/update-notes', async (req, res) => {
        const { sessionId, note } = req.body;
        try {
            const db = await getDb();
            await db.run('UPDATE chat_sessions SET internal_notes = ? WHERE id = ?', [note, sessionId]);
            res.json({ success: true });
        } catch (e) { res.status(500).send(); }
    });

    router.get('/admin/sessions', async (req, res) => {
        try {
            const db = await getDb();
            const rows = await db.all(`
                SELECT s.*, (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as msg_count 
                FROM chat_sessions s ORDER BY created_at DESC
            `);
            res.json(rows);
        } catch (e) { res.status(500).send(); }
    });

    router.post('/admin/force-close', async (req, res) => {
        let { sessionId } = req.body;
        if (!sessionId) return res.status(400).json({ error: "ID manquant" });

        const cleanId = sessionId.toString().replace('room_', '');

        try {
            const db = await getDb();
            const result = await db.run(
                'UPDATE chat_sessions SET rating = 1 WHERE id = ?',
                [cleanId]
            );

            if (result.changes === 0) {
                return res.status(404).json({ error: "Session non trouvée" });
            }

            const rooms = [cleanId, `room_${cleanId}`];
            rooms.forEach(r => {
                io.to(r).emit('request_rating', { sessionId: cleanId });
                io.to(r).emit('receive_message', {
                    sender: "Système",
                    content: "Cette session a été clôturée par l'administration.",
                    isSystem: true
                });
            });

            res.json({ success: true });
        } catch (e) {
            console.error("Erreur SQL Force-close:", e.message);
            res.status(500).json({ error: "Erreur base de données" });
        }
    });

    router.get('/admin/export/:sessionId', async (req, res) => {
        try {
            const db = await getDb();
            const s = await db.get(
                'SELECT internal_notes, client_name, zone, reported, report_reason FROM chat_sessions WHERE id = ?',
                [req.params.sessionId]
            );

            const messages = await db.all(
                'SELECT sender_name, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC',
                [req.params.sessionId]
            );

            if (!s) return res.status(404).send("Session introuvable");

            const internalNote = s.internal_notes || "Aucune note";
            const clientName = s.client_name || "Inconnu";
            const zone = s.zone || "N/A";
            const estSignale = s.reported ? "OUI" : "NON";
            const raisonSignale = s.report_reason || "R.A.S";

            let csv = "\uFEFF";
            csv += `Fiche de Session :;${req.params.sessionId}\n`;
            csv += `Zone :;${zone}\n`;
            csv += `Client :;${clientName}\n`;
            csv += `Signalement :;${estSignale}\n`;
            csv += `Motif Signalement :;${raisonSignale.replace(/"/g, '""')}\n`;
            csv += `Note Interne :;${internalNote.replace(/"/g, '""')}\n\n`;
            csv += "Date;Expediteur;Message\n";

            messages.forEach(m => {
                csv += `${new Date(m.created_at).toLocaleString()};${m.sender_name};"${m.content.replace(/"/g, '""').replace(/\n/g, ' ')}"\n`;
            });

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=session_${req.params.sessionId}.csv`);
            res.send(csv);
        } catch (e) {
            console.error("Erreur export:", e);
            res.status(500).send("Erreur lors de la génération de l'export.");
        }
    });

    router.get('/admin/export-all', async (req, res) => {
        try {
            const db = await getDb();
            const query = `SELECT s.id, s.created_at, s.client_name, s.operator_username, s.reported, s.report_reason,s.internal_notes, s.rating, m.sender_name, m.content, m.created_at as msg_date 
                        FROM chat_sessions s JOIN messages m ON s.id = m.session_id ORDER BY s.created_at DESC, m.created_at ASC`;
            const result = await db.all(query);
            let csv = "\uFEFFID;Date;Client;Operateur;Note_Privee;Score;Emetteur;Message;Heure\n";
            result.forEach(r => {
                csv += `${r.id};${new Date(r.created_at).toLocaleDateString()};${r.client_name};${r.operator_username || 'N/A'};"${(r.internal_notes || '').replace(/"/g, '""')}";${r.rating || 0};${r.sender_name};"${r.content.replace(/"/g, '""').replace(/\n/g, ' ')}";${new Date(r.msg_date).toLocaleTimeString()}\n`;
            });
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=export_global.csv');
            res.send(csv);
        } catch (e) { res.status(500).send("Erreur export."); }
    });

    router.delete('/admin/cleanup', async (req, res) => {
        try {
            const db = await getDb();
            await db.run("DELETE FROM chat_sessions WHERE created_at < datetime('now', '-' || ? || ' days')", [req.body.days]);
            res.json({ success: true });
        } catch (e) {
            console.error(e);
            res.status(500).send();
        }
    });

    // --- ADMIN OP MANAGEMENT ---

    router.post('/admin/operators', async (req, res) => {
        const { name, username, password } = req.body;
        try {
            const db = await getDb();
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(password, saltRounds);

            await db.run(
                'INSERT INTO operators (display_name, username, password_hash) VALUES (?, ?, ?)',
                [name, username.toLowerCase(), hashedPassword]
            );
            res.json({ success: true });
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: "Erreur lors de la création (le login existe peut-être déjà)" });
        }
    });

    router.delete('/admin/operators/:username', async (req, res) => {
        const username = req.params.username;
        try {
            const db = await getDb();
            await db.run('DELETE FROM operators WHERE username = ?', [username.toLowerCase()]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: "Erreur lors de la suppression" }); }
    });

    router.put('/admin/operators/update-name', async (req, res) => {
        const { username, newDisplayName } = req.body;
        try {
            const db = await getDb();
            await db.run('UPDATE operators SET display_name = ? WHERE username = ?', [newDisplayName, username]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: "Erreur mise à jour" });
        }
    });

    return router;
};
