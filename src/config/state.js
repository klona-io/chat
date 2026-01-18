// État partagé en mémoire
const state = {
    operatorSockets: {}, // Map<username, socketId>
    waitingQueue: []     // Array<{id, name, zone}>
};

module.exports = state;
