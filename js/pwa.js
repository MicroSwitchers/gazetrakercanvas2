/** Installation belongs in the consultant's drawer, away from the child's canvas. */
export function initPWA() {
    let deferredPrompt;
    const button = document.getElementById('install-app-btn');
    if (!button) return;
    const installed = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: minimal-ui)').matches || navigator.standalone === true;
    const ua = navigator.userAgent;
    const ipad = /iPad|iPhone/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS|Firefox/.test(ua);
    // Safari (iPad and Mac) has no install prompt, so the button explains the two steps instead.
    if (!installed() && safari) button.hidden = false;
    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        deferredPrompt = event;
        button.hidden = false;
    });
    button.addEventListener('click', async () => {
        if (deferredPrompt) {
            const prompt = deferredPrompt;
            deferredPrompt = null;
            button.hidden = true;
            try {
                await prompt.prompt();
                await prompt.userChoice;
            } catch (error) {
                console.warn('Installation prompt unavailable:', error);
            }
            return;
        }
        if (safari) showInstallHelp(ipad);
    });
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        button.hidden = true;
    });
}

function showInstallHelp(ipad) {
    document.querySelector('.install-help')?.remove();
    const help = document.createElement('div');
    help.className = 'install-help';
    help.setAttribute('role', 'dialog');
    help.setAttribute('aria-label', 'Install Gaze Tracking Canvas');
    help.innerHTML = ipad
        ? '<strong>Add to your Home Screen</strong><ol><li>Tap the Share button in Safari\'s toolbar.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol><button type="button">Got it</button>'
        : '<strong>Add to your Dock</strong><ol><li>In Safari\'s menu bar, choose <b>File</b>.</li><li>Choose <b>Add to Dock</b>, then <b>Add</b>.</li></ol><button type="button">Got it</button>';
    help.querySelector('button').addEventListener('click', () => help.remove());
    document.body.appendChild(help);
    help.querySelector('button').focus();
}
