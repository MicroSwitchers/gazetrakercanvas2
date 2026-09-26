// Run against a dedicated Chrome test profile: see tests/README.md.
// Saves capture every setting, and an exported project file opens on a "new computer" (all
// browser storage wiped) exactly as it was: same targets, settings, media bytes and pixels.
const assert = require('node:assert/strict');
let socket, sequence = 0;
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
const origin = 'http://127.0.0.1:8765';
async function freshStart() {
    await command('Page.navigate', { url: 'about:blank' });
    await waitFor(`location.href === 'about:blank' && document.readyState === 'complete'`);
    await command('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb,local_storage,service_workers,cache_storage' });
    await command('Page.navigate', { url: origin + '/' });
    await waitFor(`document.getElementById('library-status')?.dataset.ready === 'true'`);
    await evaluate(`document.getElementById('splash-close-btn').click();document.getElementById('mode-opt-edit').click();
        if(!document.getElementById('controls-drawer').classList.contains('open'))document.getElementById('toggle-controls-btn').click();
        // Capture downloads instead of saving them to disk.
        window.exports = [];
        HTMLAnchorElement.prototype.click = function () { if (this.download) fetch(this.href).then(r => r.text()).then(text => window.exports.push({ name: this.download, text })); };`);
}
const readSlot = slot => `new Promise(resolve=>{const r=indexedDB.open('gazeTrackerSaves');r.onsuccess=()=>{const q=r.result.transaction('slots').objectStore('slots').get(${slot});q.onsuccess=()=>{r.result.close();resolve(q.result)}}})`;
const writeSlot = scene => `new Promise(resolve=>{const r=indexedDB.open('gazeTrackerSaves');r.onsuccess=()=>{const tx=r.result.transaction('slots','readwrite');tx.objectStore('slots').put(${scene});tx.oncomplete=()=>{r.result.close();resolve()}}})`;
async function lastExport(count) {
    await waitFor(`window.exports.length >= ${count}`);
    return JSON.parse(await evaluate(`window.exports[${count - 1}].text`));
}
// Everything except bookkeeping that is expected to change between saves.
const comparable = scene => {
    const { savedAt, slot, viewport, canvasZoom, canvasPanX, canvasPanY, ...rest } = scene;
    return rest;
};

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
        else if (message.method === 'Page.javascriptDialogOpening') command('Page.handleJavaScriptDialog', { accept: true, promptText: 'Portable project' }).catch(() => {});
    });
    await command('Runtime.enable');
    await command('Page.enable');
    await command('Page.bringToFront');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await command('Network.setCacheDisabled', { cacheDisabled: true });
    await command('Network.setBypassServiceWorker', { bypass: true });
    await freshStart();

    // 1. Build a project with every kind of target.
    await evaluate(`(async()=>{
        const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');
        const stream=canvas.captureStream(10);const recorder=new MediaRecorder(stream,{mimeType:'video/webm'});const chunks=[];
        recorder.ondataavailable=e=>chunks.push(e.data);const done=new Promise(r=>recorder.onstop=r);
        recorder.start();for(let i=0;i<5;i++){ctx.fillStyle='hsl('+i*60+',80%,50%)';ctx.fillRect(0,0,64,64);await new Promise(r=>setTimeout(r,50));}recorder.stop();await done;
        const t=new DataTransfer();
        t.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#e11d48"/><circle cx="40" cy="30" r="20" fill="#fde047"/></svg>'],'Duck.svg',{type:'image/svg+xml'}));
        t.items.add(new File([new Blob(chunks,{type:'video/webm'})],'Clip.webm',{type:'video/webm'}));
        const input=document.getElementById('image-upload');input.files=t.files;input.dispatchEvent(new Event('change'));
    })()`);
    await waitFor(`document.querySelectorAll('#visual-targets-grid .media-item').length===2 && document.querySelector('#visual-targets-grid video')`);
    await evaluate(`document.querySelector('#visual-targets-grid img').closest('.media-item').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length===1`);
    await evaluate(`document.querySelector('#visual-targets-grid video').closest('.media-item').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length===2`);
    await evaluate(`document.getElementById('circle-tool').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length===3`);
    await evaluate(`document.getElementById('text-tool').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length===4`);
    await evaluate(`document.getElementById('pencil-tool').click()`);
    const box = await evaluate(`(()=>{const r=document.getElementById('canvas-container').getBoundingClientRect();return {x:r.x+r.width*.42,y:r.y+r.height*.72}})()`);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i++) await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + i * 15, y: box.y - Math.sin(i / 2) * 20, button: 'left', buttons: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 180, y: box.y, button: 'left', clickCount: 1 });
    await waitFor(`document.querySelectorAll('#layer-list > *').length===5`);
    await evaluate(`document.getElementById('pencil-tool').click()`);
    await evaluate(`document.querySelector('.save-slot__btn--save[data-slot="1"]').click()`);
    await waitFor(`document.querySelector('.save-slot--active[data-slot="1"]')`);

    // 2. Give every target and the page non-default settings, straight in the saved project.
    const svg = b => 'data:image/svg+xml;base64,' + Buffer.from(b).toString('base64');
    const rich = await evaluate(`(async()=>{
        const scene=await ${readSlot(1)};
        const kinds=scene.objects.map(o=>o.type).sort().join(',');
        scene.objects.forEach((o,i)=>Object.assign(o,{
            x:100+i*260,y:180+i*40,rotation:i*.3,scale:1+i*.1,flipHorizontal:i%2===0,flipVertical:i===1,visible:i!==3,allowPlayDrag:i%2===1,
            animationType:['path','circular','pendum','gentle-shake','path'][i],animationDuration:1.8,animationCycles:6,animationIntensity:12,
            speechMode:i===0?'custom':'default',customSpeechText:i===0?'Yellow duck':'',speechScope:i===0?'own':undefined,
            animationRetrigger:['toggle','ignore','restart','toggle','ignore'][i],triggerOnPress:i!==2,triggerOnKey:true,triggerKey:'abcde'[i],
            pathAnimationMode:['pingpong','loop','to-end','loop','pingpong'][i],pathAnimationDuration:7,pathAnimationSpeed:2,
            pathTurnMode:['flip','rotate','none','flip','rotate'][i],pathFacing:[180,-90,0,90,45][i]}));
        for (const o of scene.objects) if (o.animationType==='path') o.animationPath={nodes:[{x:o.x,y:o.y},{x:o.x+300,y:o.y+50},{x:o.x+120,y:o.y+260}],closed:true,color:'#ff00ff',visible:true};
        const text=scene.objects.find(o=>o.type==='text');Object.assign(text,{text:'Look here',color:'#00ffcc',size:88,fontFamily:'Atkinson Hyperlegible, sans-serif',fontWeight:'bold',fontStyle:'italic'});
        const shape=scene.objects.find(o=>o.type==='shape');Object.assign(shape,{color:'#2680FF',appearance:'outline',strokeColor:'#FFFF00',strokeWidth:12,cornerRadius:24});
        Object.assign(scene,{backgroundColor:'#ddd8c7',backgroundImage:${JSON.stringify(svg('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#1e3a8a"/></svg>'))},
            foregroundImage:${JSON.stringify(svg('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect x="60" y="30" width="40" height="30" fill="#f97316"/></svg>'))},
            currentGrid:6,showGuides:false,enableAutoSnap:false,gridFitTargets:false,gridIncludeText:false,gridIncludeShapes:true,
            pencilColor:'#00FFFF',pencilWidth:21,pencilOpacity:.6,eraserWidth:33,enableHoverPopup:true,lockAllInPlay:true});
        await ${writeSlot('scene')};
        return kinds;
    })()`);
    assert.equal(rich, 'image,pencil,shape,text,video', 'Project holds every kind of target');

    // 3. Opening the project and exporting it gives back every setting.
    await evaluate(`document.querySelector('.save-slot__btn--load[data-slot="1"]').click()`);
    await waitFor(`document.querySelector('#layer-list .layer-item') && document.getElementById('active-project-label').textContent.includes('Portable project')`);
    await new Promise(r => setTimeout(r, 500));
    const stored = await evaluate(`${readSlot(1)}`);
    assert.equal(await evaluate(`document.querySelector('.grid-choice[aria-pressed="true"]')?.dataset.frames`), '6', 'Grid choice follows the project');
    assert.equal(await evaluate(`document.querySelector('.preset-color-bg.selected')?.dataset.color`), '#ddd8c7', 'Background swatch follows the project');
    assert.equal(await evaluate(`document.getElementById('eraser-width-value').textContent`), '33px', 'Eraser size follows the project');
    assert.equal(await evaluate(`document.querySelector('.pencil-color-btn[aria-pressed="true"]')?.dataset.color`), '#00FFFF');
    await evaluate(`document.querySelector('.save-slot__btn--export[data-slot="1"]').click()`);
    const exported = await lastExport(1);
    assert.equal(exported.format, 'gaze-tracking-canvas-project');
    assert.equal(exported.name, 'Portable project');
    assert.deepEqual(comparable(exported.scene), comparable(stored), 'Slot export is an exact copy of the save');
    await evaluate(`document.getElementById('export-canvas-btn').click()`);
    const live = await lastExport(2);
    assert.deepEqual(comparable(live.scene).objects, comparable(stored).objects, 'Every target setting survives open and re-save');
    const { objects: _o, slotName: _n, objectCount: _c, ...liveScene } = comparable(live.scene);
    const { objects: _o2, slotName: _n2, objectCount: _c2, ...storedScene } = comparable(stored);
    assert.deepEqual(liveScene, storedScene, 'Every page setting survives open and re-save');
    for (const o of exported.scene.objects) {
        if (o.imgSrc) assert.match(o.imgSrc, /^data:image\//, 'Pictures are embedded in the file');
        if (o.videoSrc) assert.match(o.videoSrc, /^data:video\//, 'Videos are embedded in the file');
    }
    const pixelsBefore = await evaluate(`(async()=>{await new Promise(r=>setTimeout(r,300));return document.getElementById('main-canvas').toDataURL()})()`);
    console.log('PASS: saves capture every target type and setting; slot and canvas exports match the save exactly');

    // 4. "Another computer": wipe all storage, import the file, and compare.
    const fileText = await evaluate(`window.exports[0].text`);
    await freshStart();
    assert.equal(await evaluate(`MediaStore.transaction('readonly', s => s.count())`), 0, 'Media library is empty on the new computer');
    await evaluate(`(()=>{const t=new DataTransfer();t.items.add(new File([${JSON.stringify(fileText)}],'Portable project.gazecanvas.json',{type:'application/json'}));
        const input=document.getElementById('import-project-input');input.files=t.files;input.dispatchEvent(new Event('change'));})()`);
    await waitFor(`document.querySelector('.save-slot--active[data-slot="1"]') && document.querySelectorAll('#layer-list > *').length===5`);
    await new Promise(r => setTimeout(r, 500));
    const imported = await evaluate(`${readSlot(1)}`);
    assert.equal(imported.slotName, 'Portable project');
    assert.deepEqual(comparable(imported).objects, comparable(exported.scene).objects, 'Imported targets match the export exactly, media included');
    await evaluate(`document.getElementById('export-canvas-btn').click()`);
    const reexported = await lastExport(1);
    assert.deepEqual(comparable(reexported.scene).objects, comparable(exported.scene).objects, 'Nothing is lost on a round trip');
    assert.equal(reexported.scene.backgroundImage, exported.scene.backgroundImage);
    assert.equal(reexported.scene.foregroundImage, exported.scene.foregroundImage);
    // The export was made at this same window size, so the view is identical too.
    await evaluate(`document.getElementById('mode-opt-edit').click()`);
    const pixelsAfter = await evaluate(`(async()=>{await new Promise(r=>setTimeout(r,300));return document.getElementById('main-canvas').toDataURL()})()`);
    assert.ok(pixelsAfter === pixelsBefore, 'The imported canvas looks exactly the same');
    console.log('PASS: exported project opens on a wiped browser with identical targets, settings, media and pixels');

    // 5. A different screen fits the canvas instead of keeping an off-screen view.
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await new Promise(r => setTimeout(r, 400));
    await evaluate(`document.querySelector('.save-slot__btn--load[data-slot="1"]').click()`);
    await new Promise(r => setTimeout(r, 800));
    await evaluate(`document.getElementById('export-canvas-btn').click()`);
    const phone = await lastExport(2);
    assert.ok(phone.scene.viewport.width < 400, 'Saves remember the screen they were made on');
    assert.ok(1920 * phone.scene.canvasZoom <= phone.scene.viewport.width + 1, 'On a smaller screen the whole canvas fits in view');
    console.log('PASS: opening on a different screen size fits the canvas to that screen');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    // 6. Files that are not projects are refused with a message, and nothing changes.
    await evaluate(`(()=>{const t=new DataTransfer();t.items.add(new File(['{"hello":1}'],'notes.json',{type:'application/json'}));
        const input=document.getElementById('import-project-input');input.files=t.files;input.dispatchEvent(new Event('change'));})()`);
    await waitFor(`[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('not a Gaze Tracking Canvas project'))`);
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`), 5);
    console.log('PASS: other files are refused with a clear message');

    assert.equal(errors.length, 0, JSON.stringify(errors));
    socket.close();
})().catch(error => { console.error(error, errors); socket?.close(); process.exitCode = 1; });
