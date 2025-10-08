/**
 * PWA Installation Module
 * Handles Progressive Web App installation prompts and user interaction
 */

let deferredPrompt;

/**
 * Initialize PWA installation prompt handling
 */
export function initPWA() {
    window.addEventListener('beforeinstallprompt', (e) => {
        console.log('[PWA] Install prompt triggered');
        e.preventDefault();
        deferredPrompt = e;

        // Show install button or notification
        showInstallPrompt();
    });
}

/**
 * Display the PWA installation notification
 */
function showInstallPrompt() {
    // Create install notification
    const installNotification = document.createElement('div');
    installNotification.className = 'fixed top-4 right-4 z-50 bg-blue-600 text-white p-4 rounded-lg shadow-lg max-w-sm transition-all duration-300';
    installNotification.innerHTML = `
        <div class="flex items-center space-x-3">
            <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"></path>
            </svg>
            <div class="flex-1">
                <h4 class="font-semibold">Install Gaze Tracker</h4>
                <p class="text-sm opacity-90">Add to your home screen for quick access</p>
            </div>
            <button id="install-app-btn" class="bg-white text-blue-600 px-3 py-1 rounded font-medium text-sm hover:bg-gray-100 transition-colors" aria-label="Install application">
                Install
            </button>
            <button id="dismiss-install-btn" class="text-white hover:text-gray-200 transition-colors ml-2" aria-label="Dismiss installation prompt">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>
    `;

    document.body.appendChild(installNotification);

    // Handle install button click
    document.getElementById('install-app-btn').addEventListener('click', async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log('[PWA] User choice:', outcome);
            deferredPrompt = null;
            installNotification.remove();
        }
    });

    // Handle dismiss button click
    document.getElementById('dismiss-install-btn').addEventListener('click', () => {
        installNotification.remove();
        deferredPrompt = null;
    });

    // Auto dismiss after 10 seconds
    setTimeout(() => {
        if (installNotification.parentNode) {
            installNotification.remove();
        }
    }, 10000);
}
