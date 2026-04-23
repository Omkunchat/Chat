// firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// ⚠️ APNI FIREBASE CONFIG YAHAN DAALEIN (Settings se copy karein)
const firebaseConfig = {
  apiKey: "AIzaSyD97D0E5WZkM6dvEyYGJyj8bV48bkmxEdY",
  authDomain: "chatkun-edd6b.firebaseapp.com",
  projectId: "chatkun-edd6b",
  storageBucket: "chatkun-edd6b.firebasestorage.app",
  messagingSenderId: "585623461902",
  appId: "1:585623461902:web:e7330dbb630d43a20c1c5f",
  measurementId: "G-5N2KX4S4VW"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// Jab background mein notification aaye
messaging.onBackgroundMessage((payload) => {
    console.log('[sw.js] Background Message received: ', payload);

    const notificationTitle = payload.notification.title;
    const notificationOptions = {
        body: payload.notification.body,
        icon: '/logo/logo.png', // Apna icon path
        badge: '/logo/logo.png',
        tag: 'urgent-alert', 
        renotify: true,
        data: { url: payload.data.url || '/' }
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
});

// Notification click par dashboard kholna
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            if (clientList.length > 0) return clientList[0].focus();
            return clients.openWindow(event.notification.data.url);
        })
    );
});