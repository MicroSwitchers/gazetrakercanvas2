/* Persistent library controller; canvas elements keep the existing app contract. */
window.createMediaLibrary = function ({ changed, status, error, isInUse = () => true }) {
    const assets = Object.fromEntries(MediaStore.categories.map(category => [category, []]));
    const records = new Map();
    const identities = new Map();
    let queue = Promise.resolve();
    let restoring = true;
    function referenceElement(record, url = URL.createObjectURL(record.blob)) {
        const el = document.createElement(record.video ? 'video' : 'img');
        if (record.video) { el.preload = 'none'; el.muted = true; el.loop = true; el.playsInline = true; }
        else el.loading = 'lazy';
        el.src = url;
        return el;
    }
    function attach(record, el) {
        el.dataset.name = record.name;
        el.dataset.libraryId = record.id;
        el.dataset.path = record.path || '';
        el.dataset.autoLoaded = record.autoLoaded ? 'true' : 'false';
        el.dataset.autoLoadSource = record.sourceFolderName || '';
        el.dataset.loadedAt = record.loadedAt;
        if (record.symbolCredit) el.dataset.symbolCredit = record.symbolCredit;
        if (record.thumbnail) el.dataset.thumbnail = URL.createObjectURL(record.thumbnail);
        records.set(record.id, record);
        identities.set(record.category + ':' + record.hash, el);
        assets[record.category].push(el);
    }
    function schedule(action) {
        const job = queue.then(action);
        queue = job.catch(() => {});
        return job;
    }
    const ready = MediaStore.transaction('readonly', store => store.getAll()).then(async rows => {
        // Restore without decoding every full-size original at startup.
        for (const row of rows) {
            if (!assets[row.category] || !(row.blob instanceof Blob)) continue;
            attach(row, referenceElement(row));
        }
        status('Library ready. Imports are saved automatically on this device.');
    }).catch(err => { error(err); }).finally(() => { restoring = false; changed(); });
    return {
        assets, ready,
        get restoring() { return restoring; },
        flush: () => queue,
        list: category => assets[category],
        find: (category, hash) => identities.get(category + ':' + hash),
        isEmpty: category => assets[category].length === 0,
        updateView: changed,
        async add(category, el, metadata = {}) {
            return schedule(async () => {
                await ready;
                if (!assets[category]) throw new Error('Choose a valid library category.');
                const blob = metadata.blob || await (await fetch(el.src)).blob();
                const hash = metadata.hash || await MediaStore.fingerprint(blob);
                const existing = identities.get(category + ':' + hash);
                if (existing) {
                    if (metadata.symbolCredit && !existing.dataset.symbolCredit?.includes(metadata.symbolCredit)) {
                        const record = {...records.get(existing.dataset.libraryId)};
                        record.symbolCredit = [record.symbolCredit, metadata.symbolCredit].filter(Boolean).join('\n\n');
                        await MediaStore.transaction('readwrite', store => store.put(record));
                        records.set(record.id,record);existing.dataset.symbolCredit=record.symbolCredit;
                    }
                    return { el: existing, duplicate: true };
                }
                const record = {
                    id: crypto.randomUUID(), category, blob, hash,
                    video: el.tagName === 'VIDEO', name: el.dataset.name || 'Untitled media',
                    path: metadata.path || '', loadedAt: new Date().toISOString(),
                    autoLoaded: !!metadata.autoLoaded, sourceFolderName: metadata.sourceFolderName || '',
                    symbolCredit: metadata.symbolCredit || '',
                    thumbnail: await MediaStore.thumbnail(el)
                };
                await MediaStore.transaction('readwrite', store => store.put(record));
                // Release the decoded import after making its preview. Canvas use loads the original on demand.
                const stored = metadata.blob ? referenceElement(record, el.src) : el;
                if (stored !== el) { el.removeAttribute('src'); if (record.video) el.load(); }
                attach(record, stored);
                changed();
                return { el: stored, duplicate: false };
            });
        },
        async changeMany(items, destination = null) {
            return schedule(async () => {
                await ready;
                if (destination && !assets[destination]) throw new Error('Choose a valid library category.');
                const changes = [...new Set(items)].map(el => ({ el, record: records.get(el.dataset.libraryId) })).filter(x => x.record);
                // One atomic transaction: failed writes leave both the library and UI intact.
                const keys = new Set(identities.keys());
                for (const change of changes) {
                    change.remove = !destination || (destination !== change.record.category && keys.has(destination + ':' + change.record.hash));
                    if (destination) keys.add(destination + ':' + change.record.hash);
                }
                await MediaStore.transaction('readwrite', store => {
                    for (const { record, remove } of changes) {
                        if (remove) store.delete(record.id);
                        else store.put({ ...record, category: destination });
                    }
                });
                for (const { el, record, remove } of changes) {
                    const list = assets[record.category];
                    list.splice(list.indexOf(el), 1);
                    identities.delete(record.category + ':' + record.hash);
                    if (remove) {
                        records.delete(record.id);
                        if (el.dataset.thumbnail) URL.revokeObjectURL(el.dataset.thumbnail);
                        // Keep media referenced by the canvas or undo history; release unused originals.
                        if (!isInUse(el.src)) URL.revokeObjectURL(el.src);
                    } else {
                        record.category = destination;
                        assets[destination].push(el);
                        identities.set(destination + ':' + record.hash, el);
                    }
                }
                changed();
            });
        },
        remove(category, el) { return this.changeMany([el]); },
        move(from, to, el) { return this.changeMany([el], to); },
        getAutoLoadedFiles(category) { return assets[category].filter(el => el.dataset.autoLoaded === 'true'); },
        async clearAutoLoadedFiles(category) {
            const items = this.getAutoLoadedFiles(category);
            await this.changeMany(items);
            return items.length;
        },
        getAllAutoLoadedFiles() {
            return Object.entries(assets).flatMap(([category, items]) => items.filter(el => el.dataset.autoLoaded === 'true').map(file => ({
                file, category, sourceFolderName: file.dataset.autoLoadSource, loadedAt: file.dataset.loadedAt
            })));
        }
    };
};
