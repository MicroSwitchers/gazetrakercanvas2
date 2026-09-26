/**
 * Service Worker Manager Module
 * Handles service worker registration, updates, and lifecycle management
 */

/**
 * Register service worker and handle updates
 */
export function initServiceWorker() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', async () => {
            try {
                const registration = await navigator.serviceWorker.register('./sw.js');
                console.log('[PWA] Service Worker registered successfully:', registration.scope);

                // Handle service worker updates
                registration.addEventListener('updatefound', () => {
                    const newWorker = registration.installing;
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            showUpdatePrompt(newWorker);
                        }
                    });
                });
            } catch (error) {
                console.error('[PWA] Service Worker registration failed:', error);
            }
        });
    }
}

/**
 * Display update notification when a new service worker is available
 * @param {ServiceWorker} newWorker - The new service worker instance
 */
function showUpdatePrompt(newWorker) {
    const updateNotification = document.createElement('div');
    updateNotification.className = 'app-update-notice';
    updateNotification.innerHTML = `<span>App update available</span><button id="update-app-btn" type="button">Update app</button>`;
    document.querySelector('.display-controls')?.appendChild(updateNotification);

    document.getElementById('update-app-btn').addEventListener('click', () => {
        newWorker.postMessage({ type: 'SKIP_WAITING' });
        window.location.reload();
    });
}
