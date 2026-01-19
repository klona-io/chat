let myToken;
let refreshInterval;

async function performLogin() {
    const u = document.getElementById('login-user').value;
    const p = document.getElementById('login-pass').value;
    const err = document.getElementById('login-error');

    const res = await fetch('/api/login-operator', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();

    if (data.token) {
        myToken = data.token;
        document.getElementById('admin-name').innerText = "Admin : " + u;
        document.getElementById('admin-login-overlay').style.opacity = '0';
        setTimeout(() => {
            document.getElementById('admin-login-overlay').style.display = 'none';
            startSystem();
        }, 500);
    } else {
        err.style.display = 'block';
        err.innerText = "Identifiants incorrects.";
    }
}

function startSystem() {
    loadData();
    setupAutoRefresh();
    const socket = io({ auth: { token: myToken } });

    socket.on('update_queue', (queue) => {
        const statWaiting = document.getElementById('stat-waiting');
        const waitingBar = document.getElementById('waiting-bar');
        const chipsContainer = document.getElementById('waiting-list-chips');

        statWaiting.innerText = queue.length;

        if (queue.length > 0) {
            waitingBar.style.display = 'flex';
            chipsContainer.innerHTML = queue.map(c => `
                <div class="waiting-chip">
                    ${c.name} <span style="opacity:0.7; font-weight:400;">(${c.zone || 'Général'})</span>
                </div>
            `).join('');
        } else {
            waitingBar.style.display = 'none';
        }
    });

    socket.on('update_stats', d => {
        document.getElementById('stat-active').innerText = d.active;
        if (d.waiting !== undefined) document.getElementById('stat-waiting').innerText = d.waiting;
    });

    socket.on('refresh_admin_data', () => {
        console.log("🔄 Rafraîchissement forcé des données admin");
        loadData();
    });

    socket.on('refresh_admin_logs', () => {
        const sectionLogs = document.getElementById('section-logs');
        if (sectionLogs && sectionLogs.classList.contains('active')) {
            loadConnectionLogs();
        }
    });
}

function askSupervisor() {
    const panel = document.getElementById('op-manager');
    if (panel.style.display === 'block') { panel.style.display = 'none'; }
    else { document.getElementById('modal-supervisor').style.display = 'block'; document.getElementById('sup-code').focus(); }
}

function unlockManager() {
    if (document.getElementById('sup-code').value === "supervisor!") {
        document.getElementById('modal-supervisor').style.display = 'none';
        document.getElementById('op-manager').style.display = 'block';
        loadOperators();
    } else { alert("Code invalide"); }
}

async function loadOperators() {
    const res = await fetch('/api/admin/operators');
    const ops = await res.json();
    document.getElementById('op-list').innerHTML = ops.map(o => `
        <div class="op-badge">
            <span>👤 <b>${o.name}</b> (@${o.username})</span>
            <div>
                <button class="btn btn-view" style="padding:4px 8px" onclick="resetPass('${o.username}')">🔑</button>
                <button class="btn btn-purge" style="padding:4px 8px" onclick="deleteOp('${o.username}')">×</button>
            </div>
        </div>
    `).join('');
}

async function createOperator() {
    const name = document.getElementById('new-name').value;
    const user = document.getElementById('new-user').value;
    const pass = document.getElementById('new-pass').value;
    if (!name || !user || !pass) return alert("Champs vides");
    await fetch('/api/admin/operators', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, username: user, password: pass })
    });
    loadOperators();
}

async function resetPass(username) {
    const n = prompt("Nouveau mot de passe :");
    if (n) await fetch('/api/admin/operators/reset-password', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, newPassword: n })
    });
}

async function deleteOp(u) {
    if (confirm("Supprimer @" + u + " ?")) {
        await fetch('/api/admin/operators/' + u, { method: 'DELETE' });
        loadOperators();
    }
}

async function forceClose(sid) {
    if (!confirm("Voulez-vous vraiment clore cette session ?")) return;
    try {
        const res = await fetch('/api/admin/force-close', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${myToken}`
            },
            body: JSON.stringify({ sessionId: sid })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            loadData();
        } else {
            alert("Erreur : " + (data.error || "Impossible de fermer la session."));
        }
    } catch (e) {
        alert("Erreur réseau : Vérifiez la connexion au serveur.");
    }
}

function switchSection(id) {
    const targetSection = document.getElementById('section-' + id);
    if (!targetSection) return;

    // Hide all sections
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    // Show target section
    targetSection.classList.add('active');

    // Update button states
    document.querySelectorAll('.btn-nav').forEach(b => b.classList.remove('active'));

    const btn = document.getElementById('btn-show-' + id);
    if (btn) btn.classList.add('active');

    // Load specific data if needed
    if (id === 'logs') loadConnectionLogs();
}

async function loadConnectionLogs() {
    try {
        const res = await fetch('/api/admin/connection-logs');
        const logs = await res.json();
        const tbody = document.getElementById('logs-table-body');

        tbody.innerHTML = logs.map(l => {
            const date = new Date(l.created_at);
            const actionClass = l.action === 'connect' ? 'log-connect' : 'log-disconnect';
            const actionLabel = l.action === 'connect' ? 'Connexion' : 'Déconnexion';
            return `
                <tr>
                    <td>${date.toLocaleDateString()} ${date.toLocaleTimeString()}</td>
                    <td>${l.user_type === 'operator' ? '👨‍💻 Opérateur' : '👤 Client'}</td>
                    <td><b>${l.username}</b></td>
                    <td class="${actionClass}">${actionLabel}</td>
                </tr>
            `;
        }).join('');
    } catch (e) {
        console.error("Erreur chargement logs:", e);
    }
}

async function loadData() {
    try {
        const res = await fetch('/api/admin/sessions');
        const sessions = await res.json();

        const tbody = document.getElementById('table-body');
        const activeTbody = document.getElementById('active-table-body');

        const activeSessions = sessions.filter(s => s.rating === null || s.rating === 0);
        const historySessions = sessions.filter(s => s.rating !== null && s.rating > 0);

        activeTbody.innerHTML = activeSessions.map(s => {
            const isReported = s.reported;
            return `
            <tr style="${isReported ? 'background-color: #fff1f0;' : ''}">
                <td><span class="zone-tag">${s.zone || 'Général'}</span></td>
                <td><b>${s.client_name}</b> ${isReported ? '🚨' : ''}</td>
                <td>${s.operator_username || '---'}</td>
                <td>
                    <button class="btn btn-view" onclick="window.open('/api/history/${s.id}','','width=500,height=700')">👁️ Observer</button>
                    <button class="btn btn-purge" onclick="forceClose('${s.id}')">✕ Clore</button>
                </td>
            </tr>`;
        }).join('');

        if (tbody) tbody.innerHTML = historySessions.map(s => {
            const dateObj = new Date(s.created_at);
            const reportIcon = s.reported
                ? `<span title="${s.report_reason}" style="color:var(--danger); font-weight:bold; cursor:help;">🚨</span>`
                : `<span style="color:var(--success); opacity:0.6;">✅</span>`;

            return `
            <tr style="${s.reported ? 'background-color: #fff1f0;' : ''}">
                <td>${dateObj.toLocaleDateString()} <br> <small>${dateObj.toLocaleTimeString()}</small></td>
                <td><span class="zone-tag">${s.zone || 'Général'}</span></td>
                <td><b>${s.client_name}</b></td>
                <td>${s.operator_username || '---'}</td>
                <td>${reportIcon}</td> <td>${s.msg_count}</td>
                <td style="color:#f1c40f" title="${(s.client_comment || '').replace(/"/g, '&quot;')}">${'⭐'.repeat(s.rating)} ${(s.client_comment) ? '📝' : ''}</td>
                <td>
                    <button class="btn btn-view" onclick="window.open('/api/history/${s.id}','','width=500,height=700')">👁️</button>
                    <a href="/api/admin/export/${s.id}" class="btn btn-export">📄</a>
                </td>
            </tr>`;
        }).join('');

        const statActive = document.getElementById('stat-active');
        if (statActive) statActive.innerText = activeSessions.length;
    } catch (e) { console.error("Erreur supervision", e); }
}

function setupAutoRefresh() {
    clearInterval(refreshInterval);
    const check = document.getElementById('auto-refresh-check');
    const time = document.getElementById('refresh-time').value;
    if (check.checked) {
        refreshInterval = setInterval(loadData, time * 1000);
    }
}

async function runPurge() {
    const d = document.getElementById('purge-days').value;
    if (confirm("Purger à " + d + " jours ?")) {
        await fetch('/api/admin/cleanup', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days: d })
        });
        loadData();
    }
}

// Global exposure
window.performLogin = performLogin;
window.askSupervisor = askSupervisor;
window.unlockManager = unlockManager;
window.createOperator = createOperator;
window.resetPass = resetPass;
window.deleteOp = deleteOp;
window.forceClose = forceClose;
window.runPurge = runPurge;
window.setupAutoRefresh = setupAutoRefresh;
window.switchSection = switchSection;
