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
    updateNotification.className = 'fixed bottom-4 right-4 z-50 bg-green-600 text-white p-4 rounded-lg shadow-lg max-w-sm';
    updateNotification.innerHTML = `
        <div class="flex items-center space-x-3">
            <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
            </svg>
            <div class="flex-1">
                <h4 class="font-semibold">Update Available</h4>
                <p class="text-sm opacity-90">A new version is ready</p>
            </div>
            <button id="update-app-btn" class="bg-white text-green-600 px-3 py-1 rounded font-medium text-sm hover:bg-gray-100" aria-label="Update application">
                Update
            </button>
        </div>
    `;

    document.body.appendChild(updateNotification);

    document.getElementById('update-app-btn').addEventListener('click', () => {
        newWorker.postMessage({ type: 'SKIP_WAITING' });
        window.location.reload();
    });
}
