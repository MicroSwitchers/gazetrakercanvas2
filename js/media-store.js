/* Local media storage. Originals are Blobs; object URLs never cross sessions. */
window.MediaStore = (() => {
    let database;
    const categories = ['visualTargets', 'backgrounds', 'foregrounds'];
    function open() {
        if (!database) database = new Promise((resolve, reject) => {
            const request = indexedDB.open('gazeTrackerMedia', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('assets', { keyPath: 'id' });
            request.onsuccess = () => {
                request.result.onversionchange = () => { request.result.close(); database = null; };
                resolve(request.result);
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Close other app tabs and try again.'));
        }).catch(error => { database = null; throw error; });
        return database;
    }
    async function transaction(mode, action) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('assets', mode);
            const request = action(tx.objectStore('assets'));
            tx.oncomplete = () => resolve(request?.result);
            tx.onabort = tx.onerror = () => reject(tx.error || new Error('Library storage failed.'));
        });
    }
    function readDataURL(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.onabort = () => reject(new Error('Reading media was cancelled.'));
            reader.readAsDataURL(blob);
        });
    }
    async function sourceDataURL(src) {
        if (!src) return null;
        if (src.startsWith('data:')) return src;
        const response = await fetch(src);
        if (!response.ok) throw new Error('Could not read media for saving.');
        return readDataURL(await response.blob());
    }
    function typedBlob(file) {
        if (/^(image|video)\//.test(file.type)) return file;
        const types = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
        const type = types[file.name?.split('.').pop().toLowerCase()];
        return type ? file.slice(0, file.size, type) : file;
    }
    function decode(blob, name = '', video = blob.type.startsWith('video/')) {
        return new Promise((resolve, reject) => {
            const el = document.createElement(video ? 'video' : 'img');
            const url = URL.createObjectURL(blob);
            const timer = setTimeout(() => finish(new Error('Media took too long to load.')), 30000);
            function finish(error) {
                clearTimeout(timer);
                el.onload = el.onloadedmetadata = el.onerror = null;
                if (error) { URL.revokeObjectURL(url); reject(error); }
                else resolve(el);
            }
            el.dataset.name = name;
            if (video) { el.preload = 'metadata'; el.muted = true; el.loop = true; el.playsInline = true; }
            el.onload = el.onloadedmetadata = () => finish();
            el.onerror = () => finish(new Error('Unsupported or damaged media.'));
            el.src = url;
        });
    }
    async function thumbnail(el) {
        if (el.tagName === 'VIDEO') return null;
        const scale = Math.min(1, 192 / Math.max(el.naturalWidth, el.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(el.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(el.naturalHeight * scale));
        canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
        return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    }
    async function fingerprint(blob) {
        // Content identity avoids duplicate folder imports, even after files are renamed.
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return { categories, transaction, readDataURL, sourceDataURL, typedBlob, decode, thumbnail, fingerprint };
})();
