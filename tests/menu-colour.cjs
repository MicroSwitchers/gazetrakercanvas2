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

    await evaluate(`document.getElementById('splash-close-btn').click();document.getElementById('mode-opt-edit').click();if(!document.getElementById('controls-drawer').classList.contains('open'))document.getElementById('toggle-controls-btn').click()`);
    await new Promise(r=>setTimeout(r,400));
    for(const width of [1440,390]) {
        await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width===390});
        await command('Emulation.setTouchEmulationEnabled',{enabled:width===390,maxTouchPoints:5});
        await evaluate(`document.getElementById('menu-colour-button').scrollIntoView({block:'center',behavior:'instant'});document.getElementById('menu-colour-button').click()`);
        await waitFor(`document.getElementById('menu-colour-button').getAttribute('aria-expanded')==='true'`);
        assert.ok(await evaluate(`(()=>{const r=document.getElementById('menu-colour-palette').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`));
        assert.equal(await evaluate(`document.querySelectorAll('[data-menu-colour-option]').length`),6);
        await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await waitFor(`!document.getElementById('menu-colour-palette').matches(':popover-open')`);
    }
    // Snapshot after the viewport checks, so only the palette change is compared.
    await new Promise(r=>setTimeout(r,400));
    const canvas=await evaluate(`document.getElementById('main-canvas').toDataURL()`);
    const colours=[];
    for(const value of ['slate','sage','sand','lavender','high-contrast','original']) {
        await evaluate(`document.getElementById('menu-colour-button').click()`);
        await waitFor(`document.getElementById('menu-colour-palette').matches(':popover-open')`);
        await evaluate(`document.querySelector('[data-menu-colour-option="${value}"]').click()`);
        await waitFor(`document.documentElement.dataset.menuColour==='${value}' && !document.getElementById('menu-colour-palette').matches(':popover-open')`);
        assert.equal(await evaluate(`document.activeElement.id`),'menu-colour-button');
        colours.push(await evaluate(`getComputedStyle(document.getElementById('controls-drawer')).getPropertyValue('--md-surface-variant')`));
    }
    await evaluate(`document.getElementById('menu-colour-button').click()`);
    await waitFor(`document.getElementById('menu-colour-palette').matches(':popover-open')`);
    await evaluate(`document.querySelector('[data-menu-colour-option="high-contrast"]').click()`);
    for (const dark of [false,true]) {
        await evaluate(`document.documentElement.classList.toggle('dark',${dark})`);
        const palette=await evaluate(`(()=>{const s=getComputedStyle(document.getElementById('controls-drawer'));return {surface:s.getPropertyValue('--md-surface').trim(),text:s.getPropertyValue('--md-on-surface').trim(),border:s.getPropertyValue('--md-outline').trim()}})()`);
        assert.equal(palette.surface,dark?'#000000':'#ffffff');
        assert.equal(palette.text,dark?'#ffffff':'#000000');
        assert.equal(palette.border,palette.text);
    }
    assert.equal(await evaluate(`document.querySelector('[data-menu-colour-option="rose"]')`),null);
    assert.equal(new Set(colours).size,6,'Presets have different menu colours');
    assert.equal(await evaluate(`document.getElementById('main-canvas').toDataURL()`),canvas,'Palette does not change canvas');
    await evaluate(`document.getElementById('menu-colour-button').click()`);
    await waitFor(`document.getElementById('menu-colour-button').getAttribute('aria-expanded')==='true'`);
    const point=await evaluate(`(()=>{const r=document.querySelector('[data-menu-colour-option="lavender"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
    await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await waitFor(`localStorage.getItem('menuColour')==='lavender'`);
    const before=await evaluate(`getComputedStyle(document.getElementById('controls-drawer')).getPropertyValue('--md-surface')`);
    await evaluate(`document.getElementById('theme-toggle').click()`);
    assert.notEqual(await evaluate(`getComputedStyle(document.getElementById('controls-drawer')).getPropertyValue('--md-surface')`),before);
    await reloadPage();await waitFor(`document.getElementById('library-status')?.dataset.ready==='true'`);
    assert.equal(await evaluate(`document.documentElement.dataset.menuColour`),'lavender');
    await evaluate(`document.getElementById('splash-close-btn')?.click();if(!document.getElementById('controls-drawer').classList.contains('open'))document.getElementById('toggle-controls-btn').click();document.getElementById('menu-colour-button').scrollIntoView({block:'center',behavior:'instant'});document.getElementById('menu-colour-button').click()`);
    await new Promise(r=>setTimeout(r,400));
    await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('menu-colour-mobile.png'),Buffer.from(r.data,'base64')));
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('PASS: palette opens/closes, fits desktop/mobile, six distinct presets, native touch choice, keyboard dismissal, focus restoration, persistence and light/dark adaptation; canvas unchanged');
    socket.close();
})().catch(e=>{console.error(e,errors);socket?.close();process.exitCode=1});
