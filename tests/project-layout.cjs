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
        else if (message.method === 'Page.javascriptDialogOpening') command('Page.handleJavaScriptDialog', { accept: true, promptText: 'A longer project name to check wrapping and button spacing' }).catch(error => { if (!/No dialog is showing/.test(error.message || '')) errors.push(error); });
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
    await command('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8765', storageTypes: 'indexeddb,service_workers,cache_storage' });
    await command('Page.navigate', { url: 'http://127.0.0.1:8765/' });
    await waitFor(`document.getElementById('library-status')?.dataset.ready === 'true'`);

    await evaluate(`document.getElementById('splash-close-btn').click();document.getElementById('mode-opt-edit').click();if(!document.getElementById('controls-drawer').classList.contains('open'))document.getElementById('toggle-controls-btn').click();document.querySelector('.save-slot__btn--save[data-slot="1"]').click()`);
    await waitFor(`document.querySelector('.save-slot--active[data-slot="1"]')`);
    await evaluate(`(async()=>{for(let n=0;n<6&&!document.querySelector('.save-slot__btn--save[data-slot="2"]');n++)await (async()=>{document.getElementById('add-save-slot')?.click();await new Promise(r=>setTimeout(r,120))})(); document.querySelector('.save-slot__btn--save[data-slot="2"]').click()})()`);
    await waitFor(`document.querySelector('.save-slot--active[data-slot="2"]')`);
    for (const [width,height,touch] of [[1440,1000,false],[390,844,true],[844,390,true],[320,640,true]]) {
        await command('Emulation.setTouchEmulationEnabled',{enabled:touch,maxTouchPoints:5});
        await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:touch});
        await evaluate(`document.getElementById('project-saves').scrollIntoView({block:'start',behavior:'instant'})`);
        await new Promise(r=>setTimeout(r,350));
        const problems=await evaluate(`(()=>{const bad=[];for(const card of document.querySelectorAll('#project-saves .save-slot')){const r=card.getBoundingClientRect();for(const el of card.querySelectorAll('.save-slot__top,.save-slot__btn')){const b=el.getBoundingClientRect();if(b.left<r.left||b.right>r.right+1||b.top<r.top||b.bottom>r.bottom+1)bad.push(card.dataset.slot+': overflow')}const top=card.querySelector('.save-slot__top').getBoundingClientRect(),buttons=card.querySelector('.save-slot__btns').getBoundingClientRect();if(top.bottom>buttons.top)bad.push(card.dataset.slot+': overlap')}return bad})()`);
        assert.deepEqual(problems,[],`${width}x${height}`);
        assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
        if(width===390){await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('project-saves-mobile.png'),Buffer.from(r.data,'base64')));}
    }
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('PASS: saved, active and empty projects fit their cards; long names wrap; buttons do not overlap at desktop, phone and landscape sizes');
    socket.close();
})().catch(e=>{console.error(e,errors);socket?.close();process.exitCode=1});
