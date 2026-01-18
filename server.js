require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { initDb } = require('./src/config/db');
const { PORT } = require('./src/config/constants');
const initSockets = require('./src/sockets');
const apiRouter = require('./src/routes/api');

const app = express();
const server = http.createServer(app);

// Initialisation des Sockets
const io = initSockets(server);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes API
app.use('/api', apiRouter(io));

// Route Admin (Legacy, could be improved)
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

// Initialisation Base de Données et Lancement
initDb().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Serveur actif sur port ${PORT}`);
    });
}).catch(err => {
    console.error("Erreur critique au démarrage:", err);
});