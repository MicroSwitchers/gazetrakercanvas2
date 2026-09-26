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
    await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await command('Network.setCacheDisabled', { cacheDisabled: true });
    await command('Network.setBypassServiceWorker', { bypass: true });
    await command('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
    await command('Page.navigate', { url: 'about:blank' });
    await waitFor(`location.href==='about:blank' && document.readyState==='complete'`);
    await command('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8765', storageTypes: 'indexeddb,service_workers,cache_storage' });
    await command('Page.navigate', { url: 'http://127.0.0.1:8765/' });
    await waitFor(`document.getElementById('library-status')?.dataset.ready === 'true'`);

    await evaluate(`document.getElementById('splash-close-btn').click();document.getElementById('mode-opt-edit').click();if(!document.getElementById('media-library').classList.contains('open'))document.getElementById('toggle-library-btn').click()`);
    await new Promise(r=>setTimeout(r,500));
    assert.equal(await evaluate(`matchMedia('(any-pointer: coarse)').matches`),true);
    async function tap(selector){
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
        await new Promise(r=>setTimeout(r,150));
        const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
        await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }
    for (const dark of [false,true]) {
        await evaluate(`document.documentElement.classList.toggle('dark',${dark})`);
        const dropdowns=await evaluate(`[...document.querySelectorAll('select.form-input')].map(el=>{const s=getComputedStyle(el);return {id:el.id,image:s.backgroundImage,repeat:s.backgroundRepeat,size:s.backgroundSize,position:s.backgroundPosition}})`);
        for (const field of dropdowns) {
            assert.notEqual(field.image,'none',field.id+' has an arrow');
            assert.equal(field.repeat,'no-repeat',field.id+' arrow must not tile');
            assert.equal(field.size,'16px 12px',field.id+' arrow stays small');
            assert.ok(field.position.includes('8px'),field.id+' arrow stays at the right edge');
        }
    }
    await evaluate(`document.querySelector('[data-symbol-import="visualTargets"]').click();document.getElementById('symbol-import-options').open=true`);
    const controls=['[data-symbol-import="visualTargets"]','.library-import-button','#symbol-save','#symbol-clear','.symbol-skin-tone','#library-add-canvas','#library-search','#library-sort'];
    for(const width of [390,1024]) {
        await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
        for(const selector of controls){
            const rect=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {w:r.width,h:r.height}})()`);
            assert.ok(rect.w>=38&&rect.h>=38,`${width}: ${selector} ${JSON.stringify(rect)}`);
        }
        assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'No horizontal page overflow');
    }
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate(`document.getElementById('symbol-library').close()`);
    await evaluate(`const t=new DataTransfer();for(let i=0;i<12;i++)t.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><circle r="'+(i+5)+'" cx="25" cy="25"/></svg>'],'Touch '+i+'.svg',{type:'image/svg+xml'}));const input=document.getElementById('image-upload');input.files=t.files;input.dispatchEvent(new Event('change'))`);
    await waitFor(`document.querySelectorAll('#visual-targets-grid .media-item').length===12`);
    await evaluate(`document.querySelectorAll('.toast').forEach(el=>el.remove());document.querySelector('#visual-targets-grid').scrollIntoView({block:'center',behavior:'instant'})`);
    await new Promise(r=>setTimeout(r,350));
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#visual-targets-grid .remove-media-btn')).display`),'flex');
    // Targets default to three across; the header's thumbnail-size buttons switch between 2, 3 and 4.
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#visual-targets-grid')).gridTemplateColumns.split(' ').length`),3);
    for (const [density, columns] of [['2',2],['4',4],['3',3]]) {
        await evaluate(`document.querySelector('#library-density [data-density="${density}"]').click()`);
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('#visual-targets-grid')).gridTemplateColumns.split(' ').length`),columns);
    }
    // Library windows fit their content, so a swipe scrolls whichever panel around them scrolls.
    const libraryScroller=`(()=>{let el=document.querySelector('#visual-targets-grid').closest('.library-window');while(el&&!(/(auto|scroll)/.test(getComputedStyle(el).overflowY)&&el.scrollHeight>el.clientHeight))el=el.parentElement;return el||document.scrollingElement})()`;
    const area=await evaluate(`(()=>{const w=document.querySelector('#visual-targets-grid').closest('.library-window');const r=w.getBoundingClientRect();return {x:r.x+r.width/2,y:Math.min(r.bottom-20,650),top:${libraryScroller}.scrollTop}})()`);
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:area.x,y:area.y}]});
    for(let i=1;i<=6;i++){
        await command('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:area.x,y:area.y-i*20}]});
        await new Promise(r=>setTimeout(r,25));
    }
    await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await new Promise(r=>setTimeout(r,250));
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),0,'Swiping must not add a target');
    assert.ok(await evaluate(`${libraryScroller}.scrollTop`)>area.top,'Library scrolls with a finger');
    await tap('#visual-targets-grid .remove-media-btn');
    await waitFor(`document.querySelectorAll('#visual-targets-grid .media-item').length===11`);
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),0,'Deleting must not add a target');
    await tap('#visual-targets-grid .library-select');
    assert.equal(await evaluate(`document.getElementById('library-selection-count').textContent`),'1 selected');
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),0,'Selection does not place a target');
    await tap('#library-add-canvas');
    await waitFor(`document.querySelectorAll('#layer-list > *').length===1`);
    await evaluate(`document.getElementById('undo-btn').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),0);
    await tap('[data-symbol-import="visualTargets"]');
    await waitFor(`document.getElementById('symbol-library').matches(':modal')`);
    assert.equal(await evaluate(`document.activeElement.id`),'symbol-query');
    await evaluate(`document.activeElement.blur();document.getElementById('symbol-import-options').open=true;document.getElementById('symbol-skin-tones').scrollIntoView({block:'center',behavior:'instant'})`);
    await tap('.symbol-skin-tone[data-tone="dark"]');
    assert.equal(await evaluate(`document.querySelector('.symbol-skin-tone[data-tone="dark"]').getAttribute('aria-pressed')`),'true');
    await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('touch-controls-mobile.png'),Buffer.from(r.data,'base64')));
    await evaluate(`document.getElementById('theme-toggle').click()`);
    await new Promise(r=>setTimeout(r,400));
    await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('touch-controls-light.png'),Buffer.from(r.data,'base64')));
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('PASS: phone/tablet compact touch controls and direct library deletion, no horizontal overflow, native touch scroll without accidental insertion, touch selection/add/undo, search shortcut, skin-tone taps');
    socket.close();
})().catch(error=>{console.error(error,errors);socket?.close();process.exitCode=1});
