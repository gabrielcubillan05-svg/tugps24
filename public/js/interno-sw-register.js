function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function subscribeToPush(registration) {
  if (!('PushManager' in window) || !('Notification' in window)) return;
  try {
    const existing = await registration.pushManager.getSubscription();
    if (existing) return; // ya suscrito en este navegador, no hace falta pedir permiso de nuevo

    if (Notification.permission === 'denied') return; // el usuario ya lo bloqueó, no insistir

    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') return;

    const res = await fetch('/api/push-public-key');
    const data = await res.json().catch(() => ({}));
    if (!data.publicKey) return; // todavía no se configuraron las llaves VAPID en el servidor

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(data.publicKey),
    });

    await fetch('/api/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
  } catch {
    // no es crítico si falla (navegador sin soporte, permiso denegado, etc.)
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker
      .register('/interno-sw.js', { scope: '/interno/' })
      .then(function (registration) {
        subscribeToPush(registration);
      })
      .catch(function () {});
  });
}
