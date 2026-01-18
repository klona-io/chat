let socket, currentRoom, sessionId, myName, selectedZone, typingTimer;

window.onload = async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const zoneFromUrl = urlParams.get('zone');

    if (zoneFromUrl) {
        sessionStorage.setItem('chat_zone', zoneFromUrl);
        selectedZone = zoneFromUrl;
    }
    const savedToken = sessionStorage.getItem('chat_token');
    if (savedToken) {
        myName = sessionStorage.getItem('chat_name');
        selectedZone = sessionStorage.getItem('chat_zone');
        document.getElementById('scr-cgu').classList.add('hidden');
        document.getElementById('chat-ui').classList.remove('hidden');
        document.getElementById('active-zone-tag').innerText = "📍 " + selectedZone;
        connectSocket(savedToken);
    } else {
        await loadZones();
    }
};

function connectSocket(token) {
    socket = io({ auth: { token } });
    socket.on('connect', () => socket.emit('get_active_session', { name: myName }));
    socket.on('active_session_info', (data) => {
        if (data && data.sessionId) {
            sessionId = data.sessionId;
            currentRoom = data.room;
            enableChat();
            loadHistory(sessionId);
        }
    });
    socket.emit('join_waiting_room', { zone: selectedZone });
    setupListeners();
}
function openReportModal() {
    document.getElementById('report-modal').classList.remove('hidden');
}

function closeReportModal() {
    document.getElementById('report-modal').classList.add('hidden');
}

function submitReport() {
    const reason = document.getElementById('report-reason').value;
    const zonePourSignalement = (typeof selectedZone !== 'undefined' && selectedZone)
        ? selectedZone
        : (sessionStorage.getItem('chat_zone') || "Générale");
    if (socket && sessionId) {
        // On envoie le signalement au serveur
        socket.emit('report_issue', {
            sessionId: sessionId,
            room: currentRoom,
            reason: reason,
            zone: zonePourSignalement,
            timestamp: new Date().toISOString()
        });

        // Feedback visuel
        alert("Signalement envoyé. Un modérateur va vérifier la conversation.");
        closeReportModal();

        // Optionnel : On peut proposer de quitter le chat immédiatement après un signalement
        confirmEndChat();
    }
}

function setupListeners() {
    const box = document.getElementById('chat-box');
    box.innerHTML = `<div class="system">🔒 Rappel : Ne partagez aucune donnée personnelle (téléphone, adresse, nom).</div>`;
    socket.on('chat_started', d => {
        currentRoom = d.room; sessionId = d.sessionId;
        document.getElementById('op-name').innerText = d.operator;
        document.getElementById('status-txt').innerText = "En ligne";
        document.getElementById('status-dot').classList.add('active');
        document.getElementById('btn-report').style.display = 'flex';
        enableChat();
    });

    socket.on('disconnect', () => {
        document.getElementById('status-txt').innerText = "Déconnecté - Reconnexion...";
        document.getElementById('status-dot').classList.remove('active');
        document.getElementById('msg-input').disabled = true;


    });
    socket.on('operator_changed', (data) => {
        console.log("Changement d'opérateur reçu :", data.newOperatorName);
        const nameEl = document.getElementById('op-name');
        if (nameEl) {
            nameEl.innerText = data.newOperatorName;
            // Petit flash visuel pour confirmer le changement
            nameEl.style.transition = "color 0.3s";
            nameEl.style.color = "#4f46e5";
            setTimeout(() => { nameEl.style.color = ""; }, 2000);
        }
    });

    socket.on('receive_message', d => {
        const box = document.getElementById('chat-box');
        const cls = d.isSystem ? 'system' : (d.sender === myName ? 'me' : 'other');
        box.innerHTML += `<div class="msg ${cls}">${d.content}</div>`;
        box.scrollTop = box.scrollHeight;
    });

    socket.on('is_typing', () => document.getElementById('typing-indicator').style.display = 'block');
    socket.on('is_not_typing', () => document.getElementById('typing-indicator').style.display = 'none');

    // Déclenché quand l'OPÉRATEUR termine le chat
    socket.on('request_rating', d => {
        sessionId = d.sessionId;
        endSessionUI();
    });
}

// FONCTION POUR QUITTER MANUELLEMENT
function confirmEndChat() {
    const isWaiting = !sessionId;
    const modal = document.getElementById('custom-confirm');
    const title = document.getElementById('modal-title');
    const text = document.getElementById('modal-text');
    const confirmBtn = document.getElementById('modal-confirm-btn');

    // Personnalisation du texte selon l'état
    if (isWaiting) {
        title.innerText = "Annuler la demande ?";
        text.innerText = "Vous allez quitter la file d'attente.";
    } else {
        title.innerText = "Terminer la discussion ?";
        text.innerText = "Souhaitez-vous vraiment clore cet échange avec le conseiller ?";
    }

    // On définit l'action du bouton confirmer
    confirmBtn.onclick = () => {
        executeEndChat(isWaiting);
        closeModal();
    };

    modal.classList.remove('hidden');
}
function executeEndChat(isWaiting) {
    if (socket) {
        // On envoie le signal avant de couper
        socket.emit('client_leaving', {
            room: currentRoom || null,
            sessionId: sessionId || null
        });
    }

    sessionStorage.clear();

    if (isWaiting) {
        location.reload();
    } else {
        endSessionUI();
    }
}

function closeModal() {
    document.getElementById('custom-confirm').classList.add('hidden');
}

function endSessionUI() {
    // Cache le chat et montre uniquement la notation
    document.getElementById('btn-report').style.display = 'none';
    document.getElementById('chat-ui').classList.add('hidden');
    document.getElementById('scr-rating').classList.remove('hidden');
}

function emitTyping() {
    if (!socket || !currentRoom) return;
    socket.emit('is_typing', { room: currentRoom });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        if (socket) socket.emit('is_not_typing', { room: currentRoom });
    }, 2000);
}

async function loadHistory(sId) {
    try {
        const res = await fetch(`/api/history-data/${sId}`);
        const msgs = await res.json();
        const box = document.getElementById('chat-box');
        box.innerHTML = msgs.map(m => {
            const cls = m.sender_name === myName ? 'me' : 'other';
            return `<div class="msg ${cls}">${m.content}</div>`;
        }).join('');
        box.scrollTop = box.scrollHeight;
    } catch (e) { console.error("Erreur historique", e); }
}

function send() {
    const input = document.getElementById('msg-input');
    if (input.value.trim() && currentRoom) {
        socket.emit('send_message', { message: input.value, room: currentRoom, sessionId });
        input.value = '';
        socket.emit('is_not_typing', { room: currentRoom });
    }
}

async function startSession() {
    myName = document.getElementById('username').value.trim();
    selectedZone = document.getElementById('client-zone').value;
    if (!myName) return alert("Veuillez entrer votre nom.");

    const res = await fetch('/api/login-user', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: myName })
    });
    const { token } = await res.json();

    sessionStorage.setItem('chat_token', token);
    sessionStorage.setItem('chat_name', myName);
    sessionStorage.setItem('chat_zone', selectedZone);

    document.getElementById('active-zone-tag').innerText = "📍 " + selectedZone;
    changeScreen('scr-login', 'chat-ui');
    connectSocket(token);
}

function enableChat() {
    const inp = document.getElementById('msg-input');
    inp.disabled = false;
    inp.placeholder = "Écrivez ici...";
    document.getElementById('send-btn').disabled = false;
}

function handleKey(e) { if (e.key === 'Enter') send(); }

function changeScreen(oldId, newId) {
    document.getElementById(oldId).classList.add('hidden');
    document.getElementById(newId).classList.remove('hidden');
}

function initLoginScreen() { changeScreen('scr-cgu', 'scr-login'); }

async function loadZones() {
    try {
        const res = await fetch('/api/zones');
        const zones = await res.json();
        const zoneSelect = document.getElementById('client-zone');

        // On remplit le select normalement
        zoneSelect.innerHTML = zones.map(z => `<option value="${z}">${z}</option>`).join('');

        // --- LOGIQUE DE CACHAGE ---
        const urlParams = new URLSearchParams(window.location.search);
        const zoneFromUrl = urlParams.get('zone');

        if (zoneFromUrl) {
            // On force la valeur interne
            zoneSelect.value = zoneFromUrl;
            selectedZone = zoneFromUrl;

            // On cache la box (le select) pour que l'utilisateur ne puisse pas la modifier
            zoneSelect.style.display = 'none';

            // OPTIONNEL : On peut ajouter un petit texte pour confirmer la zone
            zoneSelect.insertAdjacentHTML('afterend', `<p style="color:var(--primary); font-weight:600;">📍 Zone : ${zoneFromUrl}</p>`);
        }
    } catch (e) { console.error(e); }
}

async function submitRating(val) {
    if (sessionId) {
        await fetch('/api/rate-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, rating: val })
        });
    }
    sessionStorage.clear();
    changeScreen('scr-rating', 'scr-thanks');
}
