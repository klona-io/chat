require('dotenv').config();

module.exports = {
    JWT_SECRET: process.env.JWT_SECRET || 'votre_secret_2026',
    PORT: process.env.PORT || 3000,
    CHAT_ZONES: process.env.CHAT_ZONES ? process.env.CHAT_ZONES.split(',').map(z => z.trim()) : ["Général"]
};
