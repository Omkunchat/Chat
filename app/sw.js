// CHATKUN AI - Service Worker for Push Notifications
self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : {};
    const title = data.title || "🚨 New Agent Alert";
    const options = {
        body: data.body || "A customer needs your help!",
        icon: "/assets/icon.png", // Apna icon path dein
        badge: "/assets/badge.png",
        vibrate: [200, 100, 200]
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// Notification par click karne par dashboard kholne ke liye
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(function(clientList) {
            for (const client of clientList) {
                if (client.url === '/' && 'focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow('/');
        })
    );
});