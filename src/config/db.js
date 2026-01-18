const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcrypt');
const path = require('path');

let db;

async function getDb() {
    if (!db) {
        db = await open({
            filename: path.join(__dirname, '../../chat.db'), // Remonte de 2 niveaux : src/config -> src -> root
            driver: sqlite3.Database
        });
    }
    return db;
}

async function initDb() {
    try {
        const db = await getDb();
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
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER,
                sender_name TEXT,
                content TEXT,
                is_operator INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

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
    } catch (error) {
        console.error("Erreur d'initialisation DB:", error);
    }
}

module.exports = { getDb, initDb };
