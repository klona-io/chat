let socket, myToken, myLogin, typingTimer;
let sessions = {};
let shortcuts = JSON.parse(localStorage.getItem('my_shortcuts')) || {
    '/bjr': 'Bonjour, comment puis-je vous aider ?'
};

// Sons avec timeout pour éviter le blocage
const notificationSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3');
const queueSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3');

// Préchargement des sons de manière asynchrone
notificationSound.preload = 'auto';
queueSound.preload = 'auto';

let isWindowFocused = true;
window.onfocus = () => {
    isWindowFocused = true;
    document.title = "Console Support";
};
window.onblur = () => {
    isWindowFocused = false;
};

function notifyExpert(msg) {
    if (!isWindowFocused) {
        let blink = true;
        const interval = setInterval(() => {
            document.title = blink ? "🔔 NOUVEAU MESSAGE" : "Console Support";
            blink = !blink;
            if (isWindowFocused) {
                clearInterval(interval);
                document.title = "Console Support";
            }
        }, 1000);
    }
}

function playSound(audio) {
    try {
        const playPromise = audio.play();
        if (playPromise) {
            playPromise.catch(e => console.log('Son bloqué par le navigateur'));
        }
    } catch (e) { }
}
let lastQueueCount = 0;

function getNow() {
    return new Date().toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

document.getElementById('login-p').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
});

async function handleLogin() {
    const u = document.getElementById('login-u').value;
    const p = document.getElementById('login-p').value;
    const errorDiv = document.getElementById('login-error');
    const res = await fetch('/api/login-operator', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            username: u,
            password: p
        })
    });
    const data = await res.json();
    if (data.token) {
        myToken = data.token;
        document.getElementById('login-overlay').style.display = 'none';
        completeInit();
    } else {
        errorDiv.style.display = 'block';
    }
}

async function completeInit() {
    const payload = JSON.parse(atob(myToken.split('.')[1]));
    myLogin = payload.login;

    // Setup socket IMMÉDIATEMENT (non bloquant)
    setupSocket();
    renderShortcuts();

    // Chargement du profil en arrière-plan
    loadOperatorProfile();
    updateOperatorList();
}

function showModal(title, text, onConfirm) {
    const modal = document.getElementById('custom-modal');
    document.getElementById('modal-title').innerText = title;
    document.getElementById('modal-text').innerText = text;
    modal.style.display = 'flex';

    document.getElementById('modal-confirm').onclick = () => {
        onConfirm();
        modal.style.display = 'none';
    };
    document.getElementById('modal-cancel').onclick = () => {
        modal.style.display = 'none';
    };
}

async function loadOperatorProfile() {
    try {
        const res = await fetch('/api/admin/operators');
        const ops = await res.json();
        const me = ops.find(o => o.username.toLowerCase() === myLogin.toLowerCase());

        if (me) {
            document.getElementById('op-display-name').innerText = me.name;
            document.getElementById('op-username').innerText = "@" + me.username;

            // Mise à jour du nom sur le socket une fois chargé
            if (socket && socket.connected) {
                socket.emit('update_op_name', {
                    newName: me.name
                });
            }
        }
    } catch (e) {
        console.error("Erreur de chargement du profil:", e);
        // Fallback sur le login
        document.getElementById('op-display-name').innerText = myLogin;
        document.getElementById('op-username').innerText = "@" + myLogin;
    }
}

async function changeName() {
    const currentName = document.getElementById('op-display-name').innerText;
    const newName = prompt("Choisissez votre nom d'affichage :", currentName);

    if (newName && newName.trim() !== "" && newName !== currentName) {
        try {
            // 1. Enregistrement en base de données
            const res = await fetch('/api/admin/operators/update-name', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    username: myLogin,
                    newDisplayName: newName
                })
            });

            if (res.ok) {
                // 2. Mise à jour UI
                document.getElementById('op-display-name').innerText = newName;
                localStorage.setItem('custom_op_name', newName);

                // 3. Information en temps réel au serveur pour les transferts
                if (socket) socket.emit('update_op_name', {
                    newName: newName
                });

                alert("Nom mis à jour avec succès !");
            }
        } catch (e) {
            alert("Erreur lors de l'enregistrement du nom.");
        }
    }
}
let isSocketSetup = false; // Flag pour éviter de setup le socket plusieurs fois

function setupSocket() {
    if (isSocketSetup) return; // Éviter la re-création

    socket = io({
        auth: {
            token: myToken
        },
        reconnection: true, // Reconnexion automatique activée
        reconnectionAttempts: 5, // Réduit à 5 tentatives
        reconnectionDelay: 1000, // Réduit à 1 seconde
        timeout: 10000 // Timeout de connexion à 10s
    });

    isSocketSetup = true;
    setupSocketEvents();
}

function switchChat(rid) {
    // 1. Cacher l'état vide
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = 'none';

    // 2. Désactiver tous les autres onglets et fenêtres
    document.querySelectorAll('.tab-item, .chat-win').forEach(el => el.classList.remove('active'));

    // 3. Activer la fenêtre demandée
    const currentTab = document.getElementById(`tab-${rid}`);
    const currentWin = document.getElementById(`win-${rid}`);

    if (currentTab) currentTab.classList.add('active');
    if (currentWin) currentWin.classList.add('active');

    // --- RÉINITIALISATION DU BADGE ---
    const badge = document.getElementById(`badge-${rid}`);
    if (badge) {
        badge.style.display = 'none'; // On cache le rond rouge au clic
    }

    // --- MARQUER COMME VU ---
    const sid = sessions[rid]?.sid;
    if (sid) {
        socket.emit('mark_read', { roomId: rid, sessionId: sid });
    }

    const input = document.getElementById(`in-${rid}`);
    if (input) input.focus();
}

function setupSocketEvents() {
    socket.on('connect', () => {
        console.log('✅ Connecté au serveur');
        document.getElementById('op-display-name').style.color = '';
        const currentName = document.getElementById('op-display-name').innerText;
        if (currentName !== 'Chargement...') {
            socket.emit('update_op_name', { newName: currentName });
        }
    });

    // GESTION DE LA RECONNEXION (Pour ne pas perdre la socket)
    socket.on('reconnect_attempt', (attempt) => {
        console.log('🔄 Tentative de reconnexion n°', attempt);
        document.getElementById('op-display-name').style.color = 'orange';
    });

    socket.on('reconnect', () => {
        console.log('✨ Reconnexion réussie');
        updateOperatorList();
    });

    socket.on('disconnect', () => {
        document.getElementById('op-display-name').style.color = 'var(--danger)';
    });

    // NOUVEAU : Fermeture auto si le client quitte ou se déconnecte
    socket.on('close_chat_window', (data) => {
        const rid = data.room;
        const st = document.getElementById(`status-${rid}`);
        if (st) {
            st.innerText = "SÉANCE TERMINÉE";
            st.className = "tab-status offline";
        }
        const input = document.getElementById(`in-${rid}`);
        if (input) {
            input.disabled = true;
            input.placeholder = "Le client a quitté.";
        }
        // Optionnel : on ferme l'onglet automatiquement après 10 secondes
        setTimeout(() => { if (sessions[rid]) release(rid, true); }, 10000);
    });

    socket.on('chat_history_recap', (data) => {
        const rid = data.room;
        console.log("📜 REÇU HISTORIQUE pour ", rid, data.messages.length, "messages");
        setTimeout(() => {
            const finalBox = document.getElementById(`box-${rid}`);
            console.log("🔍 Recherche box:", `box-${rid}`, finalBox ? "TROUVÉ" : "NON TROUVÉ");
            if (finalBox) {
                let historyHtml = '<div class="history-divider">Historique</div>';
                data.messages.forEach(m => {
                    const side = m.is_operator ? 'me' : 'other';
                    const isRead = m.read_at ? 'visible' : '';
                    const readStatus = m.is_operator ? `<span class="read-status ${isRead}">Vu</span>` : '';
                    historyHtml += `<div class="msg ${side} history"><b>${m.sender_name}:</b> ${m.content}${readStatus}</div>`;
                });
                finalBox.innerHTML = historyHtml + '<div class="history-divider">Direct</div>';
                finalBox.scrollTop = finalBox.scrollHeight;

                // Marquer comme vu au chargement de l'historique si actif
                const win = document.getElementById(`win-${rid}`);
                if (win && win.classList.contains('active')) {
                    socket.emit('mark_read', { roomId: rid, sessionId: data.sessionId });
                }
            }
        }, 100);
    });

    socket.on('update_queue', q => {
        console.log("📨 REÇU UPDATE_QUEUE:", q);
        if (q.length > lastQueueCount) playSound(queueSound);
        lastQueueCount = q.length;
        document.getElementById('q-list').innerHTML = q.map(c => `
        <div class="q-item">
            <div class="q-info">
                <span style="color:white; font-weight:500;">${c.name}</span>
                <span class="q-zone-badge">${c.zone}</span>
            </div>
            <button class="btn-pick" onclick="pick('${c.id}', '${c.name}', null, '${c.zone}')">Répondre</button>
        </div>`).join('');
    });

    socket.on('receive_message', d => {
        const rid = d.room;
        const box = document.getElementById(`box-${rid}`);
        if (box) {
            const currentOpName = document.getElementById('op-display-name').innerText;
            const isMe = d.sender === currentOpName;
            const cls = d.isSystem ? 'system' : (isMe ? 'me' : 'other');
            const readStatus = isMe ? '<span class="read-status">Vu</span>' : '';

            box.innerHTML += `<div class="msg ${cls}">${d.content}<span class="msg-time">${getNow()}</span>${readStatus}</div>`;
            box.scrollTop = box.scrollHeight;

            if (!isMe && !d.isSystem) {
                playSound(notificationSound);
                notifyExpert(d.content);

                const currentWin = document.getElementById(`win-${rid}`);
                // Si la fenêtre est active, on marque comme lu DIRECTEMENT
                if (currentWin && currentWin.classList.contains('active')) {
                    socket.emit('mark_read', { roomId: rid, sessionId: sessions[rid]?.sid });
                } else if (currentWin) {
                    // Sinon on montre le badge rouge
                    const badge = document.getElementById(`badge-${rid}`);
                    if (badge) badge.style.display = 'block';
                }
            }
        }
    });

    socket.on('messages_read', (data) => {
        console.log("👀 Messages lus dans room:", data.roomId);
        const box = document.getElementById(`box-${data.roomId}`);
        if (box) {
            box.querySelectorAll('.read-status').forEach(el => el.classList.add('visible'));
        }
    });

    socket.on('is_typing', (data) => {
        const st = document.getElementById(`status-room_${data.senderId}`);
        if (st) { st.innerText = "écrit..."; st.classList.add('typing'); }
    });

    socket.on('is_not_typing', (data) => {
        const st = document.getElementById(`status-room_${data.senderId}`);
        if (st) { st.innerText = "En ligne"; st.classList.remove('typing'); }
    });

    socket.on('transfer_request', data => {
        playSound(notificationSound);
        showModal("Transfert", `Reprendre ${data.clientName} ?`, () => {
            socket.emit('accept_transfer', {
                room: data.room,
                sessionId: data.sessionId  // Assurez-vous que data.sessionId contient l'UUID
            });
            pick(data.room.replace('room_', ''), data.clientName, data.sessionId, data.zone);
        });
    });
}
function handleTyping(rid) {
    // On envoie 'is_typing' pour correspondre au serveur
    socket.emit('is_typing', {
        room: rid
    });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        socket.emit('is_not_typing', {
            room: rid
        });
    }, 1500);
}

function pick(cid, name, existingSid = null, zone = "Général") {
    const rid = `room_${cid}`;
    if (!sessions[rid]) {
        sessions[rid] = {
            name,
            cid,
            sid: existingSid,
            zone
        };

        // --- CRÉATION DU TAB ---
        const tab = document.createElement('div');
        tab.id = `tab-${rid}`;
        tab.className = 'tab-item';
        tab.innerHTML = `
    <span class="tab-zone-tag">📍 ${zone}</span>
    <span class="tab-name">${name}</span>
    <span class="tab-status" id="status-${rid}">En ligne</span>
    <div class="unread-badge" id="badge-${rid}"></div>
    <span class="close-tab" onclick="event.stopPropagation(); release('${rid}')">QUITTER</span>`;
        tab.onclick = () => switchChat(rid);
        document.getElementById('tabs-list').appendChild(tab);

        // --- CRÉATION DE LA WINDOW ---
        const win = document.createElement('div');
        win.id = `win-${rid}`;
        win.className = 'chat-win';
        win.innerHTML = `
    <div class="chat-header">
        <div style="display:flex; flex-direction:column; gap:2px; min-width:120px;">
            <span style="font-size:12px; font-weight:700;">${name}</span>
            <span style="font-size:10px; color:var(--brand); font-weight:600;">${zone}</span>
        </div>
        <input type="text" class="notes-input" id="note-${rid}" placeholder="Note dossier..." onblur="saveNote('${rid}')">
        <select id="tsel-${rid}" style="font-size:11px; border-radius:5px; border:1px solid #ddd;" onfocus="updateOperatorList('${rid}')">
            <option value="">Chargement...</option>
        </select>
        <button class="btn-pick" onclick="transfer('${rid}')" style="background:var(--success)">OK</button>
    </div>
    <div class="msg-list" id="box-${rid}"></div>
    <div class="input-area">
        <input type="text" id="in-${rid}" placeholder="Répondre..." onkeypress="if(event.key==='Enter') send('${rid}')" oninput="handleTyping('${rid}')">
        <button class="btn-send" onclick="send('${rid}')">➤</button>
    </div>`;
        document.getElementById('chat-container').appendChild(win);

        // --- RÉCUPÉRATION SESSION ---
        if (!existingSid) {
            socket.emit('pick_client', cid);
            // On écoute une seule fois pour lier le SID
            socket.once('chat_started', d => {
                if (d.room === rid) sessions[rid].sid = d.sessionId;
            });
        }

        updateOperatorList();
    }
    switchChat(rid);
}

function send(rid) {
    const input = document.getElementById(`in-${rid}`);
    const text = input.value.trim();
    if (!text) return;

    let message = text;
    for (let k in shortcuts) {
        if (text.toLowerCase() === k.toLowerCase()) message = shortcuts[k];
    }

    socket.emit('send_message', {
        room: rid,
        message: message,
        sessionId: sessions[rid].sid
    });
    input.value = '';
    socket.emit('is_not_typing', { room: rid });
}

async function saveNote(rid) {
    const sid = sessions[rid]?.sid;
    const note = document.getElementById(`note-${rid}`).value;
    if (sid) {
        fetch('/api/update-notes', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, note })
        });
    }
}


function release(rid, auto = false) {
    const action = () => {
        const session = sessions[rid];
        if (session && session.sid) {
            // CRUCIAL : On envoie le SID et le RID au serveur
            socket.emit('finish_session', {
                sessionId: session.sid,
                roomId: rid
            });
        }

        // Nettoyage de l'interface expert
        document.getElementById(`tab-${rid}`)?.remove();
        document.getElementById(`win-${rid}`)?.remove();
        delete sessions[rid];

        if (Object.keys(sessions).length === 0) {
            document.getElementById('empty-state').style.display = 'flex';
        }
    };

    if (auto) action();
    else showModal("Terminer", "Clore la discussion et demander une note ?", action);
}


function transfer(rid) {
    const selectEl = document.getElementById(`tsel-${rid}`);
    const targetLogin = selectEl.value;
    const targetName = selectEl.options[selectEl.selectedIndex].text;

    if (!targetLogin) return alert("Veuillez choisir un expert.");

    showModal(
        "Confirmer le transfert",
        `Voulez-vous envoyer ce client à ${targetName} ?`,
        () => {
            // 1. On demande le transfert au serveur
            socket.emit('transfer_chat', {
                sessionId: sessions[rid].sid,
                room: rid,
                newOperatorLogin: targetLogin,
                clientName: sessions[rid].name,
                zone: sessions[rid].zone
            });

            // 2. IMPORTANT : On ferme UNIQUEMENT la fenêtre de l'expert A
            // On ne doit PAS envoyer 'finish_session' ici !
            const tab = document.getElementById(`tab-${rid}`);
            const win = document.getElementById(`win-${rid}`);
            if (tab) tab.remove();
            if (win) win.remove();
            delete sessions[rid];

            // On affiche l'état vide si plus de chats
            if (Object.keys(sessions).length === 0) {
                document.getElementById('empty-state').style.display = 'flex';
            }
        }
    );
}


function copyShortcut(k) { alert("Tapez " + k + " dans le chat pour l'utiliser."); }

function closeUI(rid) {
    const t = document.getElementById(`tab-${rid}`);
    const w = document.getElementById(`win-${rid}`);
    if (t) t.remove();
    if (w) w.remove();
    delete sessions[rid];
    if (Object.keys(sessions).length === 0) document.getElementById('empty-state').style.display = 'block';
}

async function updateOperatorList(rid = null) {
    try {
        const res = await fetch('/api/operators-online');
        if (!res.ok) throw new Error("Erreur réseau");
        const ops = await res.json();

        // On filtre pour ne pas se voir soi-même dans la liste
        const otherOps = ops.filter(o => o.login && o.login !== myLogin);

        // On cible soit un sélecteur précis, soit tous les sélecteurs de fenêtres actives
        const selectors = rid ?
            [document.getElementById(`tsel-${rid}`)] :
            document.querySelectorAll('select[id^="tsel-"]');

        selectors.forEach(sel => {
            if (!sel) return;

            // On mémorise la sélection en cours pour ne pas la perdre
            const currentValue = sel.value;

            let html = '<option value="">Transférer à...</option>';
            html += otherOps.map(o => {
                const isSelected = o.login === currentValue ? 'selected' : '';
                return `<option value="${o.login}" ${isSelected}>${o.name}</option>`;
            }).join('');

            sel.innerHTML = html;
        });
    } catch (e) {
        console.error("Erreur lors de la mise à jour de la liste des experts:", e);
    }
}

function renderShortcuts() {
    const list = document.getElementById('shortcuts-list');
    list.innerHTML = Object.entries(shortcuts).map(([k, v]) => `
    <div style="font-size:12px; padding:8px; background:rgba(255,255,255,0.05); border-radius:8px; margin-bottom:5px; display:flex; justify-content:space-between; color:white;">
        <b>${k}</b> <span onclick="deleteShortcut('${k}')" style="cursor:pointer; color:var(--danger)">×</span>
    </div>`).join('');
    localStorage.setItem('my_shortcuts', JSON.stringify(shortcuts));
}

function addShortcut() {
    const k = prompt("Code (ex: /bjr)"),
        v = prompt("Message :");
    if (k && v) {
        shortcuts[k] = v;
        renderShortcuts();
    }
}

function deleteShortcut(k) {
    delete shortcuts[k];
    renderShortcuts();
}

// --- EXPOSITION DES FONCTIONS AU GLOBAL (POUR LE HTML) ---
window.handleLogin = handleLogin;
window.pick = pick;
window.release = release;
window.transfer = transfer;
window.switchChat = switchChat;
window.saveNote = saveNote;
window.updateOperatorList = updateOperatorList;
window.changeName = changeName;
window.send = send;
window.deleteShortcut = deleteShortcut;
window.copyShortcut = copyShortcut;
window.addShortcut = addShortcut;
