require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'votre_secret_2026';

app.use(express.json());
app.use(express.static('public'));

const operatorSockets = {};
let waitingQueue = [];
let db; // Variable globale pour la connexion DB

// --- INITIALISATION DATABASE ---
async function initDb() {
    // Ouverture de la base de données (fichier chat.db)
    db = await open({
        filename: 'chat.db',
        driver: sqlite3.Database
    });

    console.log("📂 Base de données SQLite connectée.");

    // Création des tables
    await db.exec(`
        CREATE TABLE IF NOT EXISTS operators (
            username TEXT PRIMARY KEY,
            display_name TEXT,
            password_hash TEXT
        );
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_name TEXT,
            operator_username TEXT,
            zone TEXT,
            rating INTEGER,
            internal_notes TEXT,
            reported INTEGER DEFAULT 0,
            report_reason TEXT,
            client_comment TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER,
            sender_name TEXT,
            content TEXT,
            is_operator INTEGER,
            read_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // --- MIGRATION: Ajout de colonnes manquantes ---
    try {
        await db.run("ALTER TABLE messages ADD COLUMN read_at DATETIME");
    } catch (e) { }
    try {
        await db.run("ALTER TABLE chat_sessions ADD COLUMN client_comment TEXT");
        console.log("✅ Colonne 'client_comment' ajoutée à la table chat_sessions.");
    } catch (e) { }

    // --- CRÉATION DE L'ADMIN PAR DÉFAUT ---
    const adminUser = 'adm';
    const adminPass = 'admin1090!';

    const existingAdmin = await db.get('SELECT * FROM operators WHERE username = ?', [adminUser]);

    if (!existingAdmin) {
        const hash = await bcrypt.hash(adminPass, 10);
        await db.run('INSERT INTO operators (username, display_name, password_hash) VALUES (?, ?, ?)',
            [adminUser, 'Administrateur', hash]);
        console.log(`✅ Utilisateur "${adminUser}" créé avec succès.`);
    }
}

// Lancer l'initialisation
initDb().catch(err => console.error("Erreur Init DB:", err));


// --- HELPER STATS ---
function broadcastStats() {
    let activeChatsCount = 0;
    const rooms = io.sockets.adapter.rooms;
    for (const [roomName, members] of rooms) {
        if (roomName.startsWith('room_') && members.size > 0) activeChatsCount++;
    }
    io.emit('update_stats', { waiting: waitingQueue.length, active: activeChatsCount });
}

// --- ROUTES API ---

app.get('/api/zones', (req, res) => {
    const rawZones = process.env.CHAT_ZONES;
    const zonesArray = rawZones ? rawZones.split(',').map(z => z.trim()) : ["Général"];
    res.json(zonesArray);
});

app.post('/api/login-operator', async (req, res) => {
    const { username, password } = req.body;
    try {
        const op = await db.get('SELECT * FROM operators WHERE username = ?', [username.toLowerCase()]);
        if (op && await bcrypt.compare(password, op.password_hash)) {
            const token = jwt.sign({ login: op.username, name: op.display_name || op.username, role: 'operator' }, JWT_SECRET);
            return res.json({ success: true, token });
        }
        res.status(401).json({ error: "Identifiants invalides" });
    } catch (e) { res.status(500).json({ error: "Erreur serveur" }); }
});

app.post('/api/login-user', (req, res) => {
    const token = jwt.sign({ name: req.body.username, role: 'user' }, JWT_SECRET);
    res.json({ token });
});

app.post('/api/rate-session', async (req, res) => {
    const { sessionId, rating, comment } = req.body;
    try {
        await db.run(
            'UPDATE chat_sessions SET rating = ?, client_comment = ? WHERE id = ?',
            [rating, comment || null, sessionId]
        );
        res.json({ success: true });
    } catch (e) {
        console.error("Erreur notation:", e);
        res.status(500).json({ error: "Erreur enregistrement" });
    }
});

app.get('/api/history-data/:sessionId', async (req, res) => {
    try {
        const rows = await db.all('SELECT sender_name, content, is_operator, read_at, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC', [req.params.sessionId]);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: "Erreur chargement" }); }
});

// --- ROUTES DE GESTION DES OPÉRATEURS ---

app.get('/api/admin/operators', async (req, res) => {
    try {
        const rows = await db.all('SELECT username, display_name as name FROM operators');
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: "Erreur base de données" });
    }
});

app.get('/api/operators-online', async (req, res) => {
    try {
        const allOps = await db.all('SELECT username as login, display_name as name FROM operators');
        const onlineLogins = Object.keys(operatorSockets);
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

app.get('/api/history/:sessionId', async (req, res) => {
    try {
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
            <div style="background:#e0f2f1; padding:15px; border:1px solid #009688; border-radius:8px; margin-bottom:20px;">
                <strong>Avis du Client :</strong> <span style="color:#f1c40f">${'⭐'.repeat(session.rating || 0)}</span><br>
                <i>${(session.client_comment || 'Aucun commentaire.').replace(/\n/g, '<br>')}</i>
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

app.put('/api/update-notes', async (req, res) => {
    const { sessionId, note } = req.body;
    try {
        await db.run('UPDATE chat_sessions SET internal_notes = ? WHERE id = ?', [note, sessionId]);
        res.json({ success: true });
    } catch (e) { res.status(500).send(); }
});

app.get('/api/admin/sessions', async (req, res) => {
    try {
        // Sous-requête SQL standardisée pour SQLite
        const rows = await db.all(`
            SELECT s.*, (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as msg_count 
            FROM chat_sessions s ORDER BY created_at DESC
        `);
        res.json(rows);
    } catch (e) { res.status(500).send(); }
});

app.post('/api/admin/force-close', async (req, res) => {
    let { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "ID manquant" });

    const cleanId = sessionId.toString().replace('room_', '');

    try {
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

app.get('/api/admin/export/:sessionId', async (req, res) => {
    try {
        const s = await db.get(
            'SELECT internal_notes, client_name, zone, reported, report_reason, rating, client_comment FROM chat_sessions WHERE id = ?',
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
        csv += `Note Interne :;${internalNote.replace(/"/g, '""')}\n`;
        csv += `Note Client :;${s.rating || 0}/5\n`;
        csv += `Commentaire Client :;"${(s.client_comment || '').replace(/"/g, '""').replace(/\n/g, ' ')}"\n\n`;
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

app.get('/api/admin/export-all', async (req, res) => {
    try {
        const query = `SELECT s.id, s.created_at, s.client_name, s.operator_username, s.reported, s.report_reason,s.internal_notes, s.rating, s.client_comment, m.sender_name, m.content, m.created_at as msg_date 
                       FROM chat_sessions s JOIN messages m ON s.id = m.session_id ORDER BY s.created_at DESC, m.created_at ASC`;
        const result = await db.all(query);
        let csv = "\uFEFFID;Date;Client;Operateur;Note_Privee;Score;Commentaire;Emetteur;Message;Heure\n";
        result.forEach(r => {
            csv += `${r.id};${new Date(r.created_at).toLocaleDateString()};${r.client_name};${r.operator_username || 'N/A'};"${(r.internal_notes || '').replace(/"/g, '""')}";${r.rating || 0};"${(r.client_comment || '').replace(/"/g, '""').replace(/\n/g, ' ')}";${r.sender_name};"${r.content.replace(/"/g, '""').replace(/\n/g, ' ')}";${new Date(r.msg_date).toLocaleTimeString()}\n`;
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=export_global.csv');
        res.send(csv);
    } catch (e) { res.status(500).send("Erreur export."); }
});

app.delete('/api/admin/cleanup', async (req, res) => {
    try {
        // Syntaxe SQLite pour les dates : datetime('now', '-X days')
        await db.run("DELETE FROM chat_sessions WHERE created_at < datetime('now', '-' || ? || ' days')", [req.body.days]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).send();
    }
});

// --- GESTION DES COMPTES OPÉRATEURS (ADMIN) ---
app.get('/admin', (req, res) => res.sendFile(__dirname + '/public/admin.html'));

app.post('/api/admin/operators', async (req, res) => {
    const { name, username, password } = req.body;
    try {
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

app.delete('/api/admin/operators/:username', async (req, res) => {
    const username = req.params.username;
    try {
        await db.run('DELETE FROM operators WHERE username = ?', [username.toLowerCase()]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur lors de la suppression" }); }
});

app.put('/api/admin/operators/update-name', async (req, res) => {
    const { username, newDisplayName } = req.body;
    try {
        await db.run('UPDATE operators SET display_name = ? WHERE username = ?', [newDisplayName, username]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erreur mise à jour" });
    }
});

// --- SOCKET.IO AUTH ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error("Auth Error"));
        socket.user = decoded;
        next();
    });
});

// --- SOCKET.IO CORE ---
io.on('connection', (socket) => {
    if (socket.user && socket.user.role === 'operator') {
        operatorSockets[socket.user.login] = socket.id;
        socket.emit('update_queue', waitingQueue);
        broadcastStats();
    }

    socket.on('join_waiting_room', (data) => {
        if (socket.user.role === 'user') {
            socket.sessionId = data.sessionId;
            socket.isClient = true;
            const zone = data.zone || "Défaut";
            socket.chatZone = zone; // Sauvegarder la zone sur la socket
            waitingQueue = waitingQueue.filter(c => c.id !== socket.id);
            waitingQueue.push({ id: socket.id, name: socket.user.name, zone: zone });
            io.emit('update_queue', waitingQueue);
            broadcastStats();
        }
    });

    socket.on('report_issue', async (data) => {
        const { sessionId, room, reason, zone } = data;
        console.log(`⚠️ SIGNALEMENT [Zone: ${zone}] - Session: ${sessionId} - Raison: ${reason}`);
        try {
            await db.run(
                'UPDATE chat_sessions SET reported = 1, report_reason = ? WHERE id = ?',
                [`[Zone: ${zone}] ${reason}`, sessionId]
            );

            io.to(room).emit('receive_message', {
                sender: "Bouclier de Sécurité",
                content: "🛡️ Ce chat a été signalé aux modérateurs de la zone " + zone + ". L'historique a été sauvegardé pour vérification.",
                isSystem: true,
                room: room
            });
            io.emit('refresh_admin_data');
        } catch (e) {
            console.error("Erreur lors du signalement SQL:", e.message);
        }
    });

    socket.on('get_active_session', async (data) => {
        try {
            const result = await db.get(
                'SELECT id FROM chat_sessions WHERE client_name = ? AND rating IS NULL ORDER BY created_at DESC LIMIT 1',
                [data.name]
            );
            if (result) {
                const sId = result.id;
                socket.sessionId = sId;
                socket.emit('active_session_info', { sessionId: sId, room: `room_${socket.id}` });
            }
        } catch (err) { console.error(err); }
    });

    socket.on('finish_session', async (data) => {
        const sId = data.sessionId;
        try {
            await db.run(
                'UPDATE chat_sessions SET rating = COALESCE(rating, 1) WHERE id = ?',
                [sId]
            );
            io.emit('refresh_admin_data');
            io.to(data.roomId).emit('request_rating', { sessionId: sId });
            io.to(data.roomId).emit('receive_message', {
                sender: "Système",
                content: "La session est terminée. Merci de nous évaluer.",
                isSystem: true
            });
        } catch (e) {
            console.error("Erreur clôture session expert:", e);
        }
    });

    socket.on('client_leaving', (data) => {
        if (data.room) {
            socket.to(data.room).emit('close_chat_window', { room: data.room });
        }
        waitingQueue = waitingQueue.filter(c => c.id !== socket.id);
        io.emit('update_queue', waitingQueue);
        broadcastStats();
    });

    socket.on('pick_client', async (clientId) => {
        const clientData = waitingQueue.find(c => c.id === clientId);
        const clientSocket = io.sockets.sockets.get(clientId);

        if (clientSocket && socket.user.role === 'operator' && clientData) {
            const roomId = `room_${clientId}`;
            socket.join(roomId);
            clientSocket.join(roomId);
            waitingQueue = waitingQueue.filter(c => c.id !== clientId);

            // Note: SQLite n'a pas RETURNING, on utilise insert puis lastID
            const resInsert = await db.run(
                'INSERT INTO chat_sessions (client_name, operator_username, zone) VALUES (?, ?, ?)',
                [clientSocket.user.name, socket.user.login, clientData.zone]
            );
            const sId = resInsert.lastID;

            socket.sessionId = sId;
            clientSocket.sessionId = sId;
            io.to(roomId).emit('chat_started', {
                operator: socket.user.name, room: roomId, sessionId: sId, zone: clientData.zone
            });

            // Notification join
            const joinMsg = `${socket.user.name} a rejoint la conversation.`;
            await db.run(
                'INSERT INTO messages (session_id, sender_name, content, is_operator) VALUES (?, ?, ?, ?)',
                [sId, "Système", joinMsg, 1]
            );
            io.to(roomId).emit('receive_message', {
                sender: "Système",
                content: joinMsg,
                isSystem: true,
                room: roomId
            });

            setTimeout(async () => {
                const history = await db.all('SELECT sender_name, content, is_operator, read_at, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sId]);
                if (history.length > 0) {
                    socket.emit('chat_history_recap', { messages: history, room: roomId, sessionId: sId });
                }
            }, 500);

            io.emit('update_queue', waitingQueue);
            broadcastStats();
        }
    });

    socket.on('send_message', async (data) => {
        if (data.sessionId) {
            await db.run('INSERT INTO messages (session_id, sender_name, content, is_operator) VALUES (?, ?, ?, ?)',
                [data.sessionId, socket.user.name, data.message, socket.user.role === 'operator' ? 1 : 0]);
        }
        io.to(data.room).emit('receive_message', { sender: socket.user.name, content: data.message, room: data.room });
    });

    socket.on('is_typing', (data) => socket.to(data.room).emit('is_typing', { senderId: socket.id }));
    socket.on('is_not_typing', (data) => socket.to(data.room).emit('is_not_typing', { senderId: socket.id }));

    socket.on('mark_read', async (data) => {
        const { roomId, sessionId } = data;
        if (!sessionId) return;

        try {
            // On marque comme lu tous les messages qui ne viennent PAS de celui qui envoie l'event
            // (Ex: si c'est l'opérateur qui lit, on marque lus les messages du client)
            // On peut simplifier en marquant tout ce qui est dans la session et pas encore lu, 
            // sauf nos propres messages (optionnel, mais plus propre).
            // Ici on va faire simple : Update tout ce qui n'est pas "moi"

            const isOperator = socket.user.role === 'operator';

            await db.run(
                `UPDATE messages SET read_at = CURRENT_TIMESTAMP 
                 WHERE session_id = ? AND read_at IS NULL AND is_operator != ?`,
                [sessionId, isOperator ? 1 : 0]
            );

            // On prévient l'AUTRE que c'est lu
            socket.to(roomId).emit('messages_read', {
                roomId: roomId,
                readerId: socket.id,
                readAt: new Date().toISOString()
            });

        } catch (e) {
            console.error("Erreur mark_read:", e);
        }
    });

    socket.on('transfer_chat', (data) => {
        const { sessionId, room, newOperatorLogin, clientName, zone } = data;
        const targetSocketId = operatorSockets[newOperatorLogin];
        if (targetSocketId) {
            io.to(targetSocketId).emit('transfer_request', {
                room: room,
                sessionId: sessionId,
                clientName: clientName,
                zone: zone
            });
            io.to(room).emit('receive_message', {
                sender: "Système",
                content: "Veuillez patienter, nous vous transférons vers un autre expert...",
                isSystem: true,
                room: room
            });
        }
    });

    socket.on('accept_transfer', async (data) => {
        const { room, sessionId } = data;
        socket.join(room);
        console.log("Tentative de transfert - Room:", room, "ID:", sessionId);

        try {
            const result = await db.run(
                'UPDATE chat_sessions SET operator_username = ? WHERE id = ?',
                [socket.user.login, sessionId]
            );

            if (result.changes > 0) {
                // 2. INSERTION DU MESSAGE DE TRANSFERT DANS LA BASE DE DONNÉES (Historique)
                const transferMsg = `🔄 Transfert : La conversation est reprise par ${socket.user.name}`;
                await db.run(
                    'INSERT INTO messages (session_id, sender_name, content, is_operator) VALUES (?, ?, ?, ?)',
                    [sessionId, "Système", transferMsg, 1]
                );
                io.to(room).emit('operator_changed', { newOperatorName: socket.user.name });
                if (sessionId) {
                    io.to(sessionId).emit('operator_changed', {
                        newOperatorName: socket.user.name
                    });
                }
            } else {
                console.warn("⚠️ Aucune ligne trouvée pour l'ID:", sessionId);
            }
        } catch (e) {
            console.error("❌ Erreur MAJ transfert DB:", e.message);
        }

        const joinMsg = `${socket.user.name} a rejoint la conversation.`;
        io.to(room).emit('receive_message', {
            sender: "Système",
            content: joinMsg,
            isSystem: true,
            room: room
        });
    });

    socket.on('disconnecting', () => {
        const rooms = Array.from(socket.rooms);
        if (socket.user && socket.user.role === 'operator') {
            console.log(`⚠️ Opérateur ${socket.user.login} se déconnecte, vérification des sessions actives...`);
            rooms.forEach(room => {
                if (room.startsWith('room_')) {
                    const clientId = room.replace('room_', '');
                    const clientSocket = io.sockets.sockets.get(clientId);
                    if (clientSocket && clientSocket.user && clientSocket.user.role === 'user') {
                        const zone = clientSocket.chatZone || "Défaut";
                        console.log(`♻️ Ré-injection de ${clientSocket.user.name} dans la file (Zone: ${zone})`);

                        // Remettre dans la file
                        waitingQueue = waitingQueue.filter(c => c.id !== clientId);
                        waitingQueue.push({ id: clientId, name: clientSocket.user.name, zone: zone });

                        // Informer le client
                        clientSocket.emit('operator_left_requeue', { zone });
                    }
                }
            });
            // On attend 'disconnect' pour faire l'emit global update_queue (déjà géré)
        } else {
            rooms.forEach(room => {
                if (room.startsWith('room_')) {
                    socket.to(room).emit('close_chat_window', { room: room });
                }
            });
        }
    });

    socket.on('disconnect', async () => {
        if (socket.user && socket.user.role === 'operator') {
            if (operatorSockets[socket.user.login] === socket.id) {
                delete operatorSockets[socket.user.login];
            }
        }
        waitingQueue = waitingQueue.filter(c => c.id !== socket.id);

        if (socket.sessionId) {
            try {
                const result = await db.run(
                    'UPDATE chat_sessions SET rating = COALESCE(rating, 1) WHERE id = ? AND rating IS NULL',
                    [socket.sessionId]
                );

                if (result.changes > 0) {
                    console.log(`☁️ Session ${socket.sessionId} clôturée par déconnexion.`);
                    io.emit('refresh_admin_data');
                }
            } catch (e) {
                console.error("Erreur DB lors de la déconnexion client:", e.message);
            }
        }

        io.emit('update_queue', waitingQueue);
        broadcastStats();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Serveur actif sur port ${PORT}`));