// Run against a dedicated Chrome test profile: see tests/README.md.
// Importing a background or foreground puts it on the canvas straight away; clicking one in the
// library switches to it; Clear removes it.
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
// Colour of the canvas a quarter of the way across, half way down.
const pixel = `(()=>{const c=document.getElementById('main-canvas');const p=c.getContext('2d').getImageData(Math.round(c.width*.25),Math.round(c.height*.5),1,1).data;return [p[0],p[1],p[2]]})()`;
const importPicture = (input, colour, type, name) => `(async()=>{const c=document.createElement('canvas');c.width=1600;c.height=900;const x=c.getContext('2d');
    x.fillStyle='${colour}';x.fillRect(0,0,${type === 'image/png' ? 800 : 1600},900);
    const blob=await new Promise(r=>c.toBlob(r,'${type}',.9));const t=new DataTransfer();t.items.add(new File([blob],'${name}',{type:blob.type}));
    const i=document.getElementById('${input}');i.files=t.files;i.dispatchEvent(new Event('change'))})()`;
const near = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) <= 3);

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
        else if (message.method === 'Page.javascriptDialogOpening') command('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    await command('Runtime.enable');
    await command('Page.enable');
    await command('Page.bringToFront');
    await command('Emulation.setTouchEmulationEnabled', { enabled: false });
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await command('Network.setCacheDisabled', { cacheDisabled: true });
    await command('Network.setBypassServiceWorker', { bypass: true });
    await command('Page.navigate', { url: 'about:blank' });
    await waitFor(`location.href === 'about:blank' && document.readyState === 'complete'`);
    await command('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8765', storageTypes: 'indexeddb,local_storage,service_workers,cache_storage' });
    await command('Page.navigate', { url: 'http://127.0.0.1:8765/' });
    await waitFor(`document.getElementById('library-status')?.dataset.ready === 'true'`);
    await evaluate(`document.getElementById('splash-close-btn').click();document.getElementById('mode-opt-edit').click()`);
    assert.ok(near(await evaluate(pixel), [0, 0, 0]), 'Starts on the black page background');

    // Importing puts the picture on the canvas without any further clicks.
    await evaluate(importPicture('bg-image-input', '#ff0000', 'image/jpeg', 'Red room.jpg'));
    await waitFor(`document.querySelectorAll('#backgrounds-grid .media-item').length === 1`);
    await waitFor(`(${pixel})[0] > 240`);
    assert.equal(await evaluate(`document.getElementById('delete-bg-btn').classList.contains('hidden')`), false, 'Clear background is offered');
    await evaluate(importPicture('fg-image-input', '#0000ff', 'image/png', 'Blue window.png'));
    await waitFor(`document.querySelectorAll('#foregrounds-grid .media-item').length === 1`);
    await waitFor(`(${pixel})[2] > 240`);
    console.log('PASS: imported backgrounds and foregrounds appear on the canvas straight away');

    // Clicking a library picture switches to it; Clear removes it.
    await evaluate(importPicture('bg-image-input', '#00ff00', 'image/jpeg', 'Green room.jpg'));
    await waitFor(`document.querySelectorAll('#backgrounds-grid .media-item').length === 2`);
    await evaluate(`document.getElementById('delete-fg-btn').click()`);
    await waitFor(`(${pixel})[1] > 240`);
    await evaluate(`[...document.querySelectorAll('#backgrounds-grid .media-item')].find(el => el.title.includes('Red room')).click()`);
    await waitFor(`(${pixel})[0] > 240 && (${pixel})[1] < 20`);
    await evaluate(`document.getElementById('delete-bg-btn').click()`);
    await waitFor(`(${pixel}).every(v => v < 10)`);
    console.log('PASS: library pictures switch the background, and Clear removes backgrounds and foregrounds');

    assert.equal(errors.length, 0, JSON.stringify(errors));
    socket.close();
})().catch(error => { console.error(error, errors); socket?.close(); process.exitCode = 1; });
