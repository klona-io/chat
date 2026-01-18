const io = require('socket.io-client');

const socket = io('http://localhost:3000', {
    reconnection: false
});

socket.on('connect', () => {
    console.log('✅ Test Client connected:', socket.id);

    // Simulate joining waiting room
    console.log('📤 Emitting join_waiting_room');
    socket.emit('join_waiting_room', {
        zone: 'SAV',
        name: 'Jean-Test' // Simulate a user name if needed by server (server usually uses socket.user.name, let's see)
    });
});

socket.on('disconnect', () => {
    console.log('❌ Disconnected');
});

// Keep alive for a bit
setTimeout(() => {
    console.log('👋 Closing test client');
    socket.close();
}, 5000);
