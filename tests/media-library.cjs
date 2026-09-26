// Run against a dedicated Chrome test profile: see tests/README.md.
const assert = require('node:assert/strict');
const fs = require('node:fs');
let socket, sequence = 0;
let interceptedDrag;
const pending = new Map(), errors = [];
async function command(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
}
async function waitFor(expression) {
    for (let i = 0; i < 400; i++) {
        try { if (await evaluate(expression)) return; }
        catch (error) {
            if (!/context.*destroyed|Cannot find context|target navigated/i.test(error.message || '')) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out: ' + expression);
}
async function reloadPage() {
    const previous = await evaluate('performance.timeOrigin');
    await command('Page.reload', { ignoreCache: true });
    await waitFor(`performance.timeOrigin !== ${previous} && document.readyState === 'complete'`);
}
(async () => {
    const tabs = await (await fetch('http://127.0.0.1:9337/json')).json();
    socket = new WebSocket(tabs.find(tab => tab.type === 'page' && !tab.url.startsWith('chrome:')).webSocketDebuggerUrl);
    await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id) {
            const promise = pending.get(message.id); pending.delete(message.id);
            if (message.error) promise.reject(message.error); else promise.resolve(message.result);
        } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
        else if (message.method === 'Input.dragIntercepted') interceptedDrag = message.params.data;
        else if (message.method === 'Page.javascriptDialogOpening') command('Page.handleJavaScriptDialog', { accept: true, promptText: 'Library regression test' }).catch(error => { if (!/No dialog is showing/.test(error.message || '')) errors.push(error); });
    });
    await command('Runtime.enable');
    await command('Page.enable');
    await command('Network.enable');
    await command('Emulation.setTouchEmulationEnabled', { enabled: false });
    await command('Emulation.setDeviceMetricsOverride', { width:1440,height:1000,deviceScaleFactor:1,mobile:false });
    await command('Network.setCacheDisabled', { cacheDisabled: true });
    await command('Network.setBypassServiceWorker', { bypass: true });
    await command('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
    await command('Page.navigate', { url: 'about:blank' });
    await waitFor(`location.href === 'about:blank' && document.readyState === 'complete'`);
    await command('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8765', storageTypes: 'indexeddb,service_workers,cache_storage' });
    await command('Page.navigate', { url: 'http://127.0.0.1:8765/' });
    await waitFor(`document.getElementById('library-status')?.dataset.ready === 'true'`);
    assert.equal(errors.length, 0, 'Startup errors');
    assert.equal(await evaluate(`document.getElementById('splash-tutorials-tab').getAttribute('aria-selected')`), 'true');
    await evaluate(`document.getElementById('splash-tutorials-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
    await waitFor(`document.querySelector('.splash-saved-empty') !== null`);
    assert.equal(await evaluate(`document.getElementById('splash-saved-panel').hidden`), false);
    await evaluate(`document.getElementById('splash-saved-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`);
    assert.equal(await evaluate(`document.getElementById('splash-tutorials-panel').hidden`), false);
    console.log('PASS: Tutorials default, keyboard tabs, and explanatory empty Saved Files tab');
    await evaluate(`document.getElementById('splash-close-btn').click()`);
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.makeBatch = (count, inputId = 'image-upload') => {
        const transfer = new DataTransfer();
        for (let i = 0; i < count; i++) transfer.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="hsl(' + i + ',80%,50%)"/></svg>'], 'Target ' + i + '.svg', {type:'image/svg+xml'}));
        const input = document.getElementById(inputId); input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true}));
    }; makeBatch(120);`);
    await waitFor(`document.getElementById('library-status').textContent.startsWith('120 saved')`);
    assert.equal(await evaluate(`document.querySelectorAll('#visual-targets-grid .media-item').length`), 48);
    assert.equal(await evaluate(`MediaStore.transaction('readonly', s => s.count())`), 120);
    assert.ok(await evaluate(`(() => {
        const saves = document.getElementById('project-saves').getBoundingClientRect();
        const filters = document.querySelector('.library-tools').getBoundingClientRect();
        return document.getElementById('project-saves').parentElement === document.querySelector('#controls-drawer > .flex-1') &&
            !document.getElementById('project-saves').closest('.accordion-content, details') &&
            document.getElementById('project-saves').previousElementSibling.id === 'left-panel-accordion' &&
            document.getElementById('canvas-container').getBoundingClientRect().top === 0 &&
            Array.from(document.querySelectorAll('.library-collection')).every(section => {
                const window = section.querySelector('.library-window').getBoundingClientRect();
                const buttons = section.querySelectorAll('[data-file-input]');
                return filters.top >= window.bottom && buttons.length === 2 && buttons[0].getBoundingClientRect().bottom <= window.top;
            });
    })()`));
    console.log('PASS: saves follow settings in same scroll area; image windows precede filtering');
    console.log('PASS: 120-file batch persisted; 48 cards rendered');
    await evaluate(`window.pageNext = document.querySelector('#library-page-visualTargets button:last-child');
        window.pageBefore = pageNext.getBoundingClientRect().toJSON();
        document.querySelector('#visual-targets-grid').parentElement.scrollTop = 120;
        pageNext.focus({preventScroll:true}); pageNext.click();`);
    assert.ok(await evaluate(`pageNext === document.activeElement && document.querySelector('#visual-targets-grid').parentElement.scrollTop === 0`));
    await evaluate(`pageNext.click()`);
    assert.ok(await evaluate(`(() => { const r=pageNext.getBoundingClientRect(); return r.x===pageBefore.x && r.y===pageBefore.y && pageNext.disabled && document.querySelector('#library-page-visualTargets span').textContent==='3 / 3'; })()`));
    await evaluate(`document.querySelector('#library-page-visualTargets button').click(); document.querySelector('#library-page-visualTargets button').click();`);
    console.log('PASS: stable pagination position, retained keyboard focus, and scroll reset');
    assert.equal(await evaluate(`document.querySelectorAll('.save-slot--active').length`), 0);
    // Begin a real browser drag with the mouse, then deliver its native payload.
    await command('Input.setInterceptDrags', { enabled: true });
    const source = await evaluate(`(() => { const r=document.querySelector('#visual-targets-grid .media-item').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await command('Input.dispatchMouseEvent', { type:'mouseMoved', ...source });
    await command('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', buttons:1, clickCount:1, ...source });
    await command('Input.dispatchMouseEvent', { type:'mouseMoved', x:source.x-20,y:source.y-20,button:'left',buttons:1 });
    await command('Input.dispatchMouseEvent', { type:'mouseMoved', x:source.x-40,y:source.y-40,button:'left',buttons:1 });
    for(let i=0;i<30 && !interceptedDrag;i++) await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(interceptedDrag?.items.some(item=>item.mimeType==='application/x-gaze-media'), 'Native card drag includes stable asset ID');
    for (const type of ['dragEnter','dragOver','drop']) await command('Input.dispatchDragEvent', {type,x:400,y:400,data:interceptedDrag});
    await command('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:400,y:400});
    await command('Input.setInterceptDrags', { enabled: false });
    await waitFor(`document.querySelectorAll('#layer-list > *').length === 1`);
    await evaluate(`document.getElementById('undo-btn').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length === 0`);
    console.log('PASS: native mouse drag starts on image preview and drops on canvas');
    await command('Page.captureScreenshot').then(result => fs.writeFileSync(require('./screenshot-path.cjs')('library-test.png'), Buffer.from(result.data, 'base64')));
    await evaluate(`document.getElementById('theme-toggle').click()`);
    await new Promise(resolve => setTimeout(resolve, 350));
    await command('Page.captureScreenshot').then(result => fs.writeFileSync(require('./screenshot-path.cjs')('library-test-light.png'), Buffer.from(result.data, 'base64')));
    await evaluate(`document.getElementById('theme-toggle').click()`);
    await evaluate(`window.dragCard = (card, target, x=300, y=350) => {
        const transfer = new DataTransfer();
        card.dispatchEvent(new DragEvent('dragstart',{dataTransfer:transfer,bubbles:true,cancelable:true}));
        target.dispatchEvent(new DragEvent('dragover',{dataTransfer:transfer,bubbles:true,cancelable:true}));
        target.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true,clientX:x,clientY:y}));
        card.dispatchEvent(new DragEvent('dragend',{dataTransfer:transfer,bubbles:true}));
    };
    const card = document.querySelector('#visual-targets-grid .media-item');
    window.draggedId = card.dataset.assetId;
    dragCard(card, document.querySelector('.library-collection[data-library-category="foregrounds"]'));`);
    await waitFor(`document.querySelector('#foregrounds-grid .media-item') !== null`);
    assert.equal(await evaluate(`MediaStore.transaction('readonly', s=>s.getAll()).then(rows=>rows.find(r=>r.id===draggedId).category)`), 'foregrounds');
    await evaluate(`dragCard(document.querySelector('#foregrounds-grid .media-item'),document.querySelector('.library-collection[data-library-category="visualTargets"]'))`);
    await waitFor(`document.querySelectorAll('#foregrounds-grid .media-item').length === 0`);
    await evaluate(`dragCard(document.querySelector('#visual-targets-grid .media-item'),document.getElementById('main-canvas'))`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length === 1`);
    await evaluate(`document.getElementById('undo-btn').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length === 0`);
    console.log('PASS: dragging whole library cards moves between categories and places targets on canvas');
    await evaluate(`makeBatch(120)`);
    await waitFor(`document.getElementById('library-status').textContent.startsWith('0 saved · 120 duplicates')`);
    assert.equal(await evaluate(`MediaStore.transaction('readonly', s => s.count())`), 120);
    console.log('PASS: repeated import skips identical content');
    await evaluate(`const search = document.getElementById('library-search'); search.value = 'Target 11'; search.dispatchEvent(new Event('input'));`);
    await waitFor(`document.querySelectorAll('#visual-targets-grid .media-item').length === 11`);
    await evaluate(`document.getElementById('library-select-all').click(); document.getElementById('library-destination').value = 'backgrounds'; document.getElementById('library-move').click();`);
    await waitFor(`document.querySelectorAll('#backgrounds-grid .media-item').length === 11`);
    assert.equal(await evaluate(`MediaStore.transaction('readonly', s => s.getAll()).then(rows => rows.filter(r => r.category === 'backgrounds').length)`), 11);
    console.log('PASS: search and atomic bulk move');
    await reloadPage();
    await waitFor(`document.getElementById('library-status')?.dataset.ready === 'true' && document.querySelectorAll('#backgrounds-grid .media-item').length === 11`);
    assert.equal(await evaluate(`document.querySelectorAll('#visual-targets-grid .media-item').length`), 48);
    console.log('PASS: library and category changes survive reload');
    await evaluate(`document.querySelector('#visual-targets-grid .media-item').click(); document.querySelector('#backgrounds-grid .media-item').click();`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length > 0`);
    await evaluate(`document.getElementById('undo-btn').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length === 0`);
    await evaluate(`document.getElementById('redo-btn').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length === 1`);
    console.log('PASS: library canvas placement works with undo and redo');
    await evaluate(`document.querySelector('.save-slot__btn--save[data-slot="1"]').click()`);
    await waitFor(`document.querySelector('.save-slot__btn--load[data-slot="1"]') !== null`);
    assert.equal(await evaluate(`document.querySelector('.save-slot--active')?.dataset.slot`), '1');
    assert.equal(await evaluate(`document.querySelectorAll('.save-slot__open').length`), 1);
    const save = await evaluate(`new Promise((resolve,reject) => { const r=indexedDB.open('gazeTrackerSaves'); r.onsuccess=()=>{ const db=r.result; const q=db.transaction('slots').objectStore('slots').get(1); q.onsuccess=()=>{resolve(q.result);db.close()}; q.onerror=()=>reject(q.error); }; })`);
    assert.ok(save.objects[0].imgSrc.startsWith('data:image/svg+xml'), 'Save retains original SVG bytes');
    assert.ok(save.backgroundImage.startsWith('data:image/svg+xml'), 'Background saved independently');
    await evaluate(`document.getElementById('library-select-all').click(); document.getElementById('library-remove').click();`);
    await waitFor(`document.querySelectorAll('.media-item').length === 0`);
    assert.equal(await evaluate(`MediaStore.transaction('readonly', s => s.count())`), 0);
    await reloadPage();
    await waitFor(`document.getElementById('library-status')?.dataset.ready === 'true' && document.querySelector('.save-slot__btn--load[data-slot="1"]') !== null`);
    assert.equal(await evaluate(`document.getElementById('splash-tutorials-tab').getAttribute('aria-selected')`), 'true');
    await evaluate(`document.getElementById('splash-saved-tab').click()`);
    await waitFor(`document.querySelector('.splash-saved-project[data-slot="1"]') !== null`);
    await command('Page.captureScreenshot').then(result=>fs.writeFileSync(require('./screenshot-path.cjs')('splash-saved.png'),Buffer.from(result.data,'base64')));
    await evaluate(`document.querySelector('.splash-saved-project[data-slot="1"]').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length > 0`);
    console.log('PASS: saved scene restores after all library files were removed and page reloaded');
    await waitFor(`document.getElementById('splash-screen-overlay')?.classList.contains('fade-out') || !document.getElementById('splash-screen-overlay')`);
    assert.equal(await evaluate(`document.querySelector('.save-slot--active')?.dataset.slot`), '1');
    console.log('PASS: splash shortcut loads the saved scene, closes welcome, and marks the open project');
    await evaluate(`document.getElementById('splash-close-btn')?.click();
        window.importTestFiles = files => { const t = new DataTransfer(); files.forEach(file => t.items.add(file)); const input = document.getElementById('image-upload'); input.files = t.files; input.dispatchEvent(new Event('change')); };
        importTestFiles([new File(['broken'], 'broken.png', {type:'image/png'}), new File(['notes'], 'notes.txt', {type:'text/plain'}), new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="5" cx="5" cy="5"/></svg>'], 'valid.svg')]);`);
    await waitFor(`document.getElementById('library-status').textContent.includes('1 saved') && document.getElementById('library-status').textContent.includes('1 failed')`);
    assert.equal(await evaluate(`MediaStore.transaction('readonly', s => s.count())`), 1);
    console.log('PASS: corrupt and unsupported files do not block valid imports, including missing MIME types');
    await evaluate(`window.originalTransaction = MediaStore.transaction; MediaStore.transaction = (mode, action) => mode === 'readwrite' ? Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError')) : originalTransaction(mode, action);
        importTestFiles([new File(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>'], 'quota.svg', {type:'image/svg+xml'})]);`);
    await waitFor(`document.getElementById('library-status').textContent.startsWith('0 saved') && document.getElementById('library-status').textContent.includes('1 failed')`);
    assert.equal(await evaluate(`document.querySelectorAll('.media-item').length`), 1);
    await evaluate(`document.getElementById('library-select-all').click(); document.getElementById('library-remove').click()`);
    await waitFor(`document.getElementById('library-status').textContent.includes('Could not save')`);
    assert.equal(await evaluate(`document.querySelectorAll('.media-item').length`), 1);
    await evaluate(`MediaStore.transaction = originalTransaction`);
    assert.equal(await evaluate(`MediaStore.transaction('readonly', s => s.count())`), 1);
    console.log('PASS: storage failures retain existing assets and never show failed imports as saved');
    await evaluate(`(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0,0,32,32);
        const stream = canvas.captureStream(10); const chunks = [];
        const recorder = new MediaRecorder(stream, {mimeType:'video/webm'});
        recorder.ondataavailable = e => chunks.push(e.data);
        const complete = new Promise(resolve => recorder.onstop = resolve);
        recorder.start(); await new Promise(resolve => setTimeout(resolve,250)); recorder.stop(); await complete;
        stream.getTracks().forEach(track=>track.stop());
        window.testVideo = new Blob(chunks, {type:'video/webm'});
        importTestFiles([new File([testVideo], 'test-video.webm', {type:'video/webm'})]);
    })()`);
    await waitFor(`document.querySelector('#visual-targets-grid video') !== null`);
    await evaluate(`document.querySelector('#visual-targets-grid video').parentElement.click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length === 2`);
    await evaluate(`(async()=>{for(let n=0;n<6&&!document.querySelector('.save-slot__btn--save[data-slot="2"]');n++)await (async()=>{document.getElementById('add-save-slot')?.click();await new Promise(r=>setTimeout(r,120))})(); document.querySelector('.save-slot__btn--save[data-slot="2"]').click()})()`);
    await waitFor(`document.querySelector('.save-slot__btn--load[data-slot="2"]') !== null`);
    assert.ok(await evaluate(`new Promise(resolve=>{const r=indexedDB.open('gazeTrackerSaves');r.onsuccess=()=>{const db=r.result;const q=db.transaction('slots').objectStore('slots').get(2);q.onsuccess=()=>{resolve(q.result.objects.some(o=>o.videoSrc?.startsWith('data:video/webm')));db.close()}}})`));
    console.log('PASS: video canvas media saved as original bytes');
    await evaluate(`importTestFiles(Array.from({length:120}, (_,i)=>new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>' + i + '</text></svg>'], 'cancel-' + i + '.svg', {type:'image/svg+xml'})))`);
    await waitFor(`document.getElementById('library-cancel-import').hidden === false`);
    await evaluate(`document.getElementById('library-cancel-import').click()`);
    await waitFor(`document.getElementById('library-status').textContent.includes('cancelled')`);
    console.log('PASS: cancelled import finishes pending files and stops the remaining batch');
    await evaluate(`(() => {
        const file = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0L10 10" stroke="red"/></svg>'], 'nested.svg', {type:'image/svg+xml'});
        const leaf = {isFile:true, name:'nested.svg', file:resolve=>resolve(file)};
        const directory = (name, children) => ({isDirectory:true, name, createReader:()=>{let read=false;return {readEntries:resolve=>{resolve(read?[]:children);read=true;}}}});
        const entry = directory('Animals', [directory('Birds', [leaf])]);
        const event = new Event('drop', {bubbles:true,cancelable:true});
        Object.defineProperty(event,'dataTransfer',{value:{files:[],items:[{kind:'file',webkitGetAsEntry:()=>entry}]}});
        document.dispatchEvent(event);
    })()`);
    await waitFor(`document.querySelector('[title="Animals/Birds/nested.svg"]') !== null`);
    console.log('PASS: dropping a nested folder retains its searchable path');
    await reloadPage();
    await waitFor(`document.getElementById('library-status')?.dataset.ready === 'true' && document.querySelector('.save-slot__btn--load[data-slot="2"]') !== null`);
    await evaluate(`document.querySelector('.save-slot__btn--load[data-slot="2"]').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length === 2`);
    await waitFor(`document.querySelector('.save-slot--active')?.dataset.slot === '2'`);
    assert.equal(await evaluate(`document.querySelector('.save-slot--active')?.dataset.slot`), '2');
    // Loading an older slot must direct Ctrl+S there, not to the latest saved slot.
    await evaluate(`document.querySelector('.save-slot__btn--load[data-slot="1"]').click()`);
    await waitFor(`document.querySelector('.save-slot--active')?.dataset.slot === '1'`);
    await evaluate(`(async () => { window.readTestSlot = slot => new Promise(resolve=>{const r=indexedDB.open('gazeTrackerSaves');r.onsuccess=()=>{const db=r.result;const q=db.transaction('slots').objectStore('slots').get(slot);q.onsuccess=()=>{resolve(q.result);db.close()}}});
        window.beforeSaveOne = (await readTestSlot(1)).savedAt; window.beforeSaveTwo = (await readTestSlot(2)).savedAt;
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true})); })()`);
    await waitFor(`readTestSlot(1).then(row=>row.savedAt !== beforeSaveOne)`);
    assert.equal(await evaluate(`readTestSlot(2).then(row=>row.savedAt === beforeSaveTwo)`), true);
    assert.equal(await evaluate(`document.querySelector('.save-slot--active')?.dataset.slot`), '1');
    console.log('PASS: open-project highlight follows loading and saving');
    await evaluate(`document.getElementById('splash-close-btn').click(); document.getElementById('media-library').classList.add('open'); document.getElementById('controls-drawer').classList.add('open');`);
    await new Promise(resolve=>setTimeout(resolve,350));
    await command('Page.captureScreenshot').then(result=>fs.writeFileSync(require('./screenshot-path.cjs')('library-active-project.png'),Buffer.from(result.data,'base64')));
    await command('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:true });
    await evaluate(`document.getElementById('media-library').classList.remove('open'); document.getElementById('controls-drawer').classList.add('open'); document.querySelector('#controls-drawer > .flex-1').scrollTop=99999;`);
    await new Promise(resolve=>setTimeout(resolve,350));
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('.save-slot')).every(el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=document.getElementById('project-saves').getBoundingClientRect().bottom;})`));
    await command('Page.captureScreenshot').then(result=>fs.writeFileSync(require('./screenshot-path.cjs')('library-mobile.png'),Buffer.from(result.data,'base64')));
    assert.ok(await evaluate(`(() => {
        const saves=document.getElementById('project-saves');
        const before=saves.getBoundingClientRect().top;
        const tools=document.querySelector('#controls-drawer > .flex-1'); tools.style.scrollBehavior='auto'; tools.scrollTop=0;
        const moved = saves.getBoundingClientRect().top>before;
        tools.scrollTop=tools.scrollHeight;
        return moved && Array.from(saves.querySelectorAll('.save-slot__btn')).every(button=>{
            const r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
        });
    })()`));
    console.log('PASS: save controls scroll with settings and are reachable at bottom on mobile');
    await evaluate(`document.querySelector('.save-slot__btn--delete[data-slot="1"]').click()`);
    await waitFor(`document.querySelectorAll('.save-slot--active').length===0 && document.getElementById('active-project-label').textContent==='Unsaved canvas'`);
    console.log('PASS: deleting the open save clears the active banner');
    console.log('PASS: image and video save reload together');
    await reloadPage();
    await waitFor(`document.getElementById('library-status')?.dataset.ready==='true'`);
    assert.equal(await evaluate(`document.getElementById('splash-tutorials-tab').getAttribute('aria-selected')`), 'true');
    await evaluate(`document.getElementById('splash-saved-tab').click()`);
    await waitFor(`document.querySelector('.splash-saved-project[data-slot="2"]') !== null`);
    await command('Page.captureScreenshot').then(result=>fs.writeFileSync(require('./screenshot-path.cjs')('splash-saved-mobile.png'),Buffer.from(result.data,'base64')));
    await evaluate(`document.querySelector('.splash-saved-project[data-slot="2"]').click()`);
    await waitFor(`document.querySelector('.save-slot--active')?.dataset.slot==='2'`);
    console.log('PASS: mobile Saved Files shortcut opens image/video project');
    await require('./play-mode.cjs')({ command, evaluate, waitFor, reloadPage });
    await require('./grids.cjs')({ command, evaluate, waitFor, reloadPage });
    await require('./library-bulk.cjs')({ command, evaluate, waitFor, reloadPage });
    assert.equal(errors.length, 0, JSON.stringify(errors));
    socket.close();
})().catch(error => { console.error(error, errors); socket?.close(); process.exitCode = 1; });
