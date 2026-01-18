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
        document.getElementById('my-pseudo-header').innerText = myName;
        document.getElementById('active-zone-tag').innerText = "📍 " + selectedZone;
        connectSocket(savedToken);
    } else {
        await loadZones();
    }
};

function connectSocket(token) {
    socket = io({ auth: { token } });

    socket.on('connect', () => {
        console.log('✅ Client connecté au socket');
        socket.emit('get_active_session', { name: myName });

        // --- FIX RECONNEXION : Re-joindre la file d'attente automatiquement ---
        if (selectedZone) {
            console.log("📤 Re-joint la file d'attente pour zone:", selectedZone);
            socket.emit('join_waiting_room', { zone: selectedZone });
        }
    });

    socket.on('active_session_info', (data) => {
        if (data && data.sessionId) {
            sessionId = data.sessionId;
            currentRoom = data.room;
            enableChat();
            loadHistory(sessionId);
        }
    });

    setupListeners();

    // --- LOGIQUE DE MARQUAGE "LU" ---
    window.addEventListener('focus', () => {
        if (currentRoom && sessionId) socket.emit('mark_read', { roomId: currentRoom, sessionId });
    });

    document.addEventListener('click', () => {
        if (currentRoom && sessionId) socket.emit('mark_read', { roomId: currentRoom, sessionId });
    });
}

function setupListeners() {
    const box = document.getElementById('chat-box');
    box.innerHTML = `<div class="system">🔒 Rappel : Ne partagez aucune donnée personnelle (téléphone, adresse, nom).</div>`;

    socket.on('chat_started', d => {
        currentRoom = d.room;
        sessionId = d.sessionId;
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
            nameEl.style.transition = "color 0.3s";
            nameEl.style.color = "#4f46e5";
            setTimeout(() => { nameEl.style.color = ""; }, 2000);
        }
    });

    socket.on('operator_left_requeue', (d) => {
        console.log("Opérateur déconnecté, retour en file d'attente.");
        sessionId = null;
        document.getElementById('op-name').innerText = "Expert";
        document.getElementById('status-txt').innerText = "Recherche d'expert...";
        document.getElementById('status-dot').classList.remove('active');
        document.getElementById('btn-report').style.display = 'none';

        document.getElementById('msg-input').disabled = true;
        document.getElementById('msg-input').placeholder = "En attente d'un conseiller...";
        document.getElementById('send-btn').disabled = true;

        showToast("Votre conseiller s'est déconnecté. Recherche d'un nouvel expert...", "error");

        const box = document.getElementById('chat-box');
        box.innerHTML += `<div class="system">⚠️ Votre conseiller a quitté. Vous avez été replacé en file d'attente. Recherche en cours...</div>`;
        box.scrollTop = box.scrollHeight;
    });

    socket.on('receive_message', d => {
        const box = document.getElementById('chat-box');
        const cls = d.isSystem ? 'system' : (d.sender === myName ? 'me' : 'other');
        box.innerHTML += `<div class="msg ${cls}">${d.content}</div>`;
        box.scrollTop = box.scrollHeight;

        if (!d.isSystem && d.sender !== myName && document.hasFocus()) {
            socket.emit('mark_read', { roomId: currentRoom, sessionId });
        }
    });

    socket.on('messages_read', (data) => {
        document.querySelectorAll('.read-status').forEach(el => el.classList.add('visible'));
    });

    socket.on('is_typing', () => document.getElementById('typing-indicator').style.display = 'block');
    socket.on('is_not_typing', () => document.getElementById('typing-indicator').style.display = 'none');

    socket.on('request_rating', d => {
        sessionId = d.sessionId;
        endSessionUI();
    });
}

function confirmEndChat() {
    const isWaiting = !sessionId;
    const modal = document.getElementById('custom-confirm');
    const title = document.getElementById('modal-title');
    const text = document.getElementById('modal-text');
    const confirmBtn = document.getElementById('modal-confirm-btn');

    if (isWaiting) {
        title.innerText = "Annuler la demande ?";
        text.innerText = "Vous allez quitter la file d'attente.";
    } else {
        title.innerText = "Terminer la discussion ?";
        text.innerText = "Souhaitez-vous vraiment clore cet échange avec le conseiller ?";
    }

    confirmBtn.onclick = () => {
        executeEndChat(isWaiting);
        closeModal();
    };
    modal.classList.remove('hidden');
}

function executeEndChat(isWaiting) {
    if (socket) {
        socket.emit('client_leaving', { room: currentRoom || null, sessionId: sessionId || null });
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
    document.getElementById('btn-report').style.display = 'none';
    document.getElementById('chat-ui').classList.add('hidden');
    document.getElementById('scr-rating').classList.remove('hidden');

    // Redirection auto après 30s
    setTimeout(() => {
        if (!document.getElementById('scr-rating').classList.contains('hidden')) {
            sessionStorage.clear();
            location.reload();
        }
    }, 30000);
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

    if (!myName) {
        const input = document.getElementById('username');
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 500);
        showToast("Veuillez indiquer votre pseudo pour démarrer.", "error");
        return;
    }

    sessionStorage.setItem('chat_name', myName);
    sessionStorage.setItem('chat_zone', selectedZone);
    document.getElementById('my-pseudo-header').innerText = myName;

    const res = await fetch('/api/login-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: myName })
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
        zoneSelect.innerHTML = zones.map(z => `<option value="${z}">${z}</option>`).join('');

        const urlParams = new URLSearchParams(window.location.search);
        const zoneFromUrl = urlParams.get('zone');

        if (zoneFromUrl) {
            zoneSelect.value = zoneFromUrl;
            selectedZone = zoneFromUrl;
            zoneSelect.style.display = 'none';
            zoneSelect.insertAdjacentHTML('afterend', `<p style="color:var(--primary); font-weight:600;">📍 Zone : ${zoneFromUrl}</p>`);
        }
    } catch (e) { console.error(e); }
}

function selectStar(val) {
    document.getElementById('selected-rating').value = val;
    const starsContainer = document.querySelector('.stars-container');
    const errorMsg = document.getElementById('rating-error');

    if (starsContainer) starsContainer.classList.remove('shake');
    if (errorMsg) errorMsg.style.display = 'none';

    document.querySelectorAll('.star').forEach((s, i) => {
        s.style.opacity = (i < val) ? '1' : '0.3';
        s.style.transform = (i < val) ? 'scale(1.1)' : 'scale(1)';
    });
}

function showToast(msg, type = 'error') {
    const toast = document.getElementById('toast-msg');
    const txt = document.getElementById('toast-text');
    const icon = document.getElementById('toast-icon');

    toast.className = `toast ${type} show`;
    txt.innerText = msg;
    icon.innerText = type === 'error' ? '⚠️' : '✅';

    setTimeout(() => { toast.classList.remove('show'); }, 3000);
}

async function submitRating() {
    const val = document.getElementById('selected-rating').value;
    const errorMsg = document.getElementById('rating-error');

    if (!val) {
        const starsContainer = document.querySelector('.stars-container');
        if (starsContainer) {
            starsContainer.classList.remove('shake');
            void starsContainer.offsetWidth;
            starsContainer.classList.add('shake');
        }
        if (errorMsg) errorMsg.style.display = 'block';
        return;
    }

    const comment = document.getElementById('rate-comment').value;

    if (sessionId) {
        await fetch('/api/rate-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, rating: val, comment })
        });
    }

    sessionStorage.clear();
    changeScreen('scr-rating', 'scr-thanks');
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
        socket.emit('report_issue', {
            sessionId: sessionId,
            room: currentRoom,
            reason: reason,
            zone: zonePourSignalement,
            timestamp: new Date().toISOString()
        });
        alert("Signalement envoyé. Un modérateur va vérifier la conversation.");
        closeReportModal();
        confirmEndChat();
    }
}

// --- EXPOSITION GLOBALE ---
window.initLoginScreen = initLoginScreen;
window.startSession = startSession;
window.confirmEndChat = confirmEndChat;
window.send = send;
window.handleKey = handleKey;
window.emitTyping = emitTyping;
window.selectStar = selectStar;
window.submitRating = submitRating;
window.openReportModal = openReportModal;
window.closeReportModal = closeReportModal;
window.submitReport = submitReport;
window.closeModal = closeModal;
