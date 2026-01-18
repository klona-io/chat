const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/db');
const { JWT_SECRET } = require('../config/constants');
const state = require('../config/state');

let io;

function broadcastStats() {
    let activeChatsCount = 0;
    if (!io) return;

    const rooms = io.sockets.adapter.rooms;
    for (const [roomName, members] of rooms) {
        if (roomName.startsWith('room_') && members.size > 0) activeChatsCount++;
    }
    io.emit('update_stats', { waiting: state.waitingQueue.length, active: activeChatsCount });
}

function initSockets(server) {
    io = new Server(server);

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
        console.log(`🔌 Connexion socket: ${socket.id} (Role: ${socket.user ? socket.user.role : 'inconnu'})`);

        if (socket.user && socket.user.role === 'operator') {
            state.operatorSockets[socket.user.login] = socket.id;
            console.log(`👨‍💻 Opérateur connecté: ${socket.user.login}`);
            socket.emit('update_queue', state.waitingQueue);
            broadcastStats();
        }

        socket.on('join_waiting_room', (data) => {
            console.log(`📥 Demande join_waiting_room de ${socket.id} (Pre: ${socket.user.name})`);
            if (socket.user.role === 'user') {
                socket.sessionId = data.sessionId;
                socket.isClient = true;
                const zone = data.zone || "Défaut";
                // Enlever le client s'il est déjà dans la file
                state.waitingQueue = state.waitingQueue.filter(c => c.id !== socket.id);
                state.waitingQueue.push({ id: socket.id, name: socket.user.name, zone: zone });
                io.emit('update_queue', state.waitingQueue);
                broadcastStats();
            }
        });

        socket.on('report_issue', async (data) => {
            const { sessionId, room, reason, zone } = data;
            const db = await getDb();
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
                const db = await getDb();
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
                const db = await getDb();
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
            state.waitingQueue = state.waitingQueue.filter(c => c.id !== socket.id);
            io.emit('update_queue', state.waitingQueue);
            broadcastStats();
        });

        socket.on('pick_client', async (clientId) => {
            const clientData = state.waitingQueue.find(c => c.id === clientId);
            const clientSocket = io.sockets.sockets.get(clientId);

            if (clientSocket && socket.user.role === 'operator' && clientData) {
                const roomId = `room_${clientId}`;
                socket.join(roomId);
                clientSocket.join(roomId);
                state.waitingQueue = state.waitingQueue.filter(c => c.id !== clientId);

                const db = await getDb();
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

                setTimeout(async () => {
                    const history = await db.all('SELECT sender_name, content, is_operator, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sId]);
                    if (history.length > 0) {
                        socket.emit('chat_history_recap', { messages: history, room: roomId, sessionId: sId });
                    }
                }, 500);

                io.emit('update_queue', state.waitingQueue);
                broadcastStats();
            }
        });

        socket.on('send_message', async (data) => {
            if (data.sessionId) {
                const db = await getDb();
                await db.run('INSERT INTO messages (session_id, sender_name, content, is_operator) VALUES (?, ?, ?, ?)',
                    [data.sessionId, socket.user.name, data.message, socket.user.role === 'operator' ? 1 : 0]);
            }
            io.to(data.room).emit('receive_message', { sender: socket.user.name, content: data.message, room: data.room });
        });

        socket.on('is_typing', (data) => socket.to(data.room).emit('is_typing', { senderId: socket.id }));
        socket.on('is_not_typing', (data) => socket.to(data.room).emit('is_not_typing', { senderId: socket.id }));

        socket.on('transfer_chat', (data) => {
            const { sessionId, room, newOperatorLogin, clientName, zone } = data;
            const targetSocketId = state.operatorSockets[newOperatorLogin];
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
                const db = await getDb();
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

            io.to(room).emit('receive_message', {
                sender: "Système",
                content: `${socket.user.name} a rejoint la conversation.`,
                isSystem: true,
                room: room
            });

            // --- FIX: ENVOI DE L'HISTORIQUE AU NOUVEL OPÉRATEUR ---
            setTimeout(async () => {
                try {
                    const db = await getDb();
                    const history = await db.all('SELECT sender_name, content, is_operator, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId]);
                    if (history.length > 0) {
                        socket.emit('chat_history_recap', { messages: history, room: room, sessionId: sessionId });
                    }
                } catch (errHistory) {
                    console.error("Erreur récupération historique transfert:", errHistory);
                }
            }, 500);
        });

        socket.on('disconnecting', () => {
            const rooms = Array.from(socket.rooms);
            rooms.forEach(room => {
                if (room.startsWith('room_')) {
                    socket.to(room).emit('close_chat_window', { room: room });
                }
            });
        });

        socket.on('disconnect', async () => {
            if (socket.user && socket.user.role === 'operator') {
                if (state.operatorSockets[socket.user.login] === socket.id) {
                    delete state.operatorSockets[socket.user.login];
                }
            }
            state.waitingQueue = state.waitingQueue.filter(c => c.id !== socket.id);

            if (socket.sessionId) {
                try {
                    const db = await getDb();
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

            io.emit('update_queue', state.waitingQueue);
            broadcastStats();
        });
    });

    return io;
}

module.exports = initSockets;
