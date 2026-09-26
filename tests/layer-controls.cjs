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
    await command('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8765', storageTypes: 'indexeddb,service_workers,cache_storage' });
    await command('Page.navigate', { url: 'http://127.0.0.1:8765/' });
    await waitFor(`document.getElementById('library-status')?.dataset.ready === 'true'`);

    await evaluate(`localStorage.removeItem('menuColour')`);await reloadPage();
    await waitFor(`document.getElementById('library-status')?.dataset.ready==='true'`);
    assert.equal(await evaluate(`document.documentElement.dataset.menuColour`),'slate');
    await evaluate(`document.getElementById('splash-close-btn').click();document.getElementById('mode-opt-edit').click();if(!document.getElementById('controls-drawer').classList.contains('open'))document.getElementById('toggle-controls-btn').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('#undo-btn').length`),1);
    assert.ok(await evaluate(`!!(document.querySelector('.drawer-history').compareDocumentPosition(document.querySelector('.display-controls')) & Node.DOCUMENT_POSITION_FOLLOWING)`));
    await evaluate(`const t=new DataTransfer();for(let i=0;i<3;i++)t.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><circle r="'+(i+10)+'" cx="25" cy="25"/></svg>'],'Layer preview '+i+'.svg',{type:'image/svg+xml'}));const input=document.getElementById('image-upload');input.files=t.files;input.dispatchEvent(new Event('change'))`);
    await waitFor(`document.getElementById('visual-targets-count').textContent==='3'`);
    await evaluate(`document.querySelector('[data-select-library="visualTargets"]').click();document.getElementById('library-add-canvas').click()`);
    await waitFor(`document.querySelectorAll('#layer-list .layer-item').length===3`);
    await evaluate(`document.getElementById('undo-btn').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list .layer-item').length`),0);
    await evaluate(`document.getElementById('redo-btn').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list .layer-item').length`),3);
    const first=await evaluate(`document.querySelector('#layer-list .layer-item').dataset.id`);
    await evaluate(`document.querySelector('#layer-list .layer-item__actions button:nth-child(2)').click()`);
    assert.notEqual(await evaluate(`document.querySelector('#layer-list .layer-item').dataset.id`),first);
    await evaluate(`document.querySelector('#layer-list .layer-item__actions button:nth-child(3)').click()`);
    assert.equal(await evaluate(`document.querySelector('#layer-list .layer-item__actions button:nth-child(3)').getAttribute('aria-pressed')`),'false');
    await evaluate(`document.querySelector('#layer-list .layer-item').focus()`);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    assert.equal(await evaluate(`document.querySelector('#layer-list .layer-item').getAttribute('aria-current')`),'true');
    for(const width of [1440,390,320]) {
        await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<500});
        await command('Emulation.setTouchEmulationEnabled',{enabled:width<500,maxTouchPoints:5});
        await evaluate(`if(document.getElementById('media-library').classList.contains('open'))document.getElementById('toggle-library-btn').click();if(!document.getElementById('controls-drawer').classList.contains('open'))document.getElementById('toggle-controls-btn').click();document.getElementById('layer-list').scrollIntoView({block:'center',behavior:'instant'})`);
        await new Promise(r=>setTimeout(r,350));
        assert.ok(await evaluate(`(()=>{return [...document.querySelectorAll('#layer-list .layer-item')].every(card=>{const r=card.getBoundingClientRect();return [...card.querySelectorAll('button,.layer-item__label')].every(el=>{const b=el.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right+1&&b.top>=r.top&&b.bottom<=r.bottom+1})})})()`),width+' layer content fits');
        if(width===390)await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('layers-mobile.png'),Buffer.from(r.data,'base64')));
    }
    await evaluate(`document.getElementById('menu-colour-button').click()`);
    await waitFor(`document.getElementById('menu-colour-palette').matches(':popover-open')`);
    await evaluate(`document.querySelector('[data-menu-colour-option="sand"]').click()`);await reloadPage();
    await waitFor(`document.documentElement.dataset.menuColour==='sand'`);
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('PASS: Slate default preserves saved preferences; relocated history undoes/redoes; layer reorder, visibility and keyboard selection work; rows fit desktop and narrow touch widths');
    socket.close();
})().catch(e=>{console.error(e,errors);socket?.close();process.exitCode=1});
