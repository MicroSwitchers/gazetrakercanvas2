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
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await command('Network.setCacheDisabled', { cacheDisabled: true });
    await command('Network.setBypassServiceWorker', { bypass: true });
    await command('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
    await command('Page.navigate', { url: 'about:blank' });
    await waitFor(`location.href==='about:blank' && document.readyState==='complete'`);
    await command('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8765', storageTypes: 'indexeddb,service_workers,cache_storage' });
    await command('Page.addScriptToEvaluateOnNewDocument', {source: `
        try{localStorage.setItem('symbolSkinTone','none')}catch{}
        const originalFetch=window.fetch.bind(window);
        window.fetch=async (url,options)=>{
            const address=String(url);
            if(address.includes('api.arasaac.org')) {
                const word=decodeURIComponent(address.split('/').pop());
                return new Response(JSON.stringify([{_id:word==='cat'?101:102,keywords:[{keyword:word}]}]),{headers:{'Content-Type':'application/json'}});
            }
            if(address.includes('static.arasaac.org')) {
                if(window.failSymbolDownload)throw new Error('Test offline');
                return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="'+(address.includes('101')?'red':'blue')+'"/></svg>',{headers:{'Content-Type':'image/svg+xml'}});
            }
            return originalFetch(url,options);
        };
    `});
    await command('Page.navigate', { url: 'http://127.0.0.1:8765/' });
    await waitFor(`document.getElementById('library-status')?.dataset.ready === 'true'`);

    await evaluate(`document.getElementById('splash-close-btn').click();document.getElementById('mode-opt-edit').click();document.getElementById('toggle-library-btn').click();document.querySelector('[data-symbol-import="visualTargets"]').click();document.querySelector('[data-symbol-source="arasaac"]').click();document.getElementById('symbol-query').focus()`);
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(await evaluate(`document.querySelectorAll('[data-symbol-import]').length`),1);
    assert.equal(await evaluate(`document.getElementById('symbol-destination')`),null);
    assert.equal(await evaluate(`document.activeElement.id`),'symbol-query');
    async function search(word){
        await evaluate(`document.getElementById('symbol-query').value=${JSON.stringify(word)};document.getElementById('symbol-search-form').dispatchEvent(new Event('submit',{cancelable:true}))`);
        await waitFor(`document.querySelectorAll('.symbol-result').length===1`);
    }
    await search('cat');
    await evaluate(`document.querySelector('.symbol-select').click()`);
    assert.equal(await evaluate(`document.querySelector('.symbol-select').checked`),true);
    await evaluate(`document.querySelector('.symbol-select').focus()`);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    assert.equal(await evaluate(`document.getElementById('symbol-selection-count').textContent`),'0 selected');
    await evaluate(`document.querySelector('.symbol-result').click()`);
    await search('dog');
    await evaluate(`document.querySelector('.symbol-result').click()`);
    assert.equal(await evaluate(`document.getElementById('symbol-selection-count').textContent`),'2 selected');
    assert.equal(await evaluate(`document.querySelectorAll('#symbol-selected-items button').length`),2);
    await evaluate(`document.getElementById('symbol-search-form').scrollIntoView({block:'start'});document.querySelectorAll('.toast').forEach(el=>el.remove())`);
    await new Promise(resolve=>setTimeout(resolve,350));
    await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('import-workflow-desktop.png'),Buffer.from(r.data,'base64')));
    await evaluate(`window.failSymbolDownload=true;document.getElementById('symbol-save').click()`);
    await waitFor(`document.getElementById('symbol-status').textContent.includes('2 downloads failed')`);
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),0);
    assert.equal(await evaluate(`document.getElementById('symbol-selection-count').textContent`),'2 selected');
    await evaluate(`window.failSymbolDownload=false;document.getElementById('symbol-save').click()`);
    await waitFor(`document.getElementById('symbol-selection-count').textContent==='0 selected'`);
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),0,'Import does not add to canvas');
    assert.equal(await evaluate(`document.getElementById('symbol-library').matches(':modal')`),true);
    await evaluate(`document.querySelector('#symbol-library [data-close-symbols]').click();document.querySelector('[data-select-library="visualTargets"]').click();document.getElementById('library-add-canvas').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length===2`);
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),2);
    assert.equal(await evaluate(`document.getElementById('symbol-selection-count').textContent`),'0 selected');
    await evaluate(`document.getElementById('undo-btn').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),0);
    await evaluate(`document.getElementById('redo-btn').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),2);
    await evaluate(`document.querySelector('.save-slot__btn--save[data-slot="1"]').click()`);
    await waitFor(`document.querySelector('.save-slot__btn--load[data-slot="1"]')`);
    const credits=await evaluate(`new Promise(resolve=>{const r=indexedDB.open('gazeTrackerSaves');r.onsuccess=()=>{const db=r.result;const q=db.transaction('slots').objectStore('slots').get(1);q.onsuccess=()=>{resolve(JSON.stringify(q.result));db.close()}}})`);
    assert.match(credits,/Original image/);
    await evaluate(`document.querySelector('[data-symbol-import="visualTargets"]').click()`);
    await search('cat');await evaluate(`document.querySelector('.symbol-result').click();document.getElementById('symbol-save').click()`);
    await waitFor(`document.getElementById('symbol-selection-count').textContent==='0 selected'`);
    assert.equal(await evaluate(`document.getElementById('visual-targets-count').textContent`),'2');
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),2);
    console.log('PASS: cross-search selection, download failure and retry, batch add/undo/redo, saved credits, duplicate save without canvas changes');
    await evaluate(`document.getElementById('symbol-query').value='d';document.getElementById('symbol-query').dispatchEvent(new Event('input'))`);
    assert.equal(await evaluate(`document.querySelectorAll('.symbol-result').length`),0);
    await evaluate(`document.getElementById('symbol-library').close();document.getElementById('library-clear-selection').click();document.getElementById('library-search').value='does not match';const t=new DataTransfer();t.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle r="10" cx="10" cy="10"/></svg>'],'personal.svg',{type:'image/svg+xml'}));const input=document.getElementById('image-upload');input.files=t.files;input.dispatchEvent(new Event('change'))`);
    await waitFor(`document.getElementById('visual-targets-count').textContent==='3'`);
    assert.equal(await evaluate(`document.getElementById('library-search').value`),'');
    assert.equal(await evaluate(`document.getElementById('library-add-imported')`),null);
    assert.equal(await evaluate(`document.getElementById('library-import-feedback')`),null);
    assert.equal(await evaluate(`[...document.querySelectorAll('.toast')].some(el=>el.textContent.includes('Import complete'))`),false);
    await evaluate(`document.querySelector('#visual-targets-grid .library-select').click();document.getElementById('library-add-canvas').click()`);
    await waitFor(`document.querySelectorAll('#layer-list > *').length===3`);
    await evaluate(`document.getElementById('undo-btn').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),2);
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate(`document.querySelector('[data-symbol-import="visualTargets"]').click()`);
    assert.equal(await evaluate(`document.querySelector('[data-symbol-import]').dataset.symbolImport`),'visualTargets');
    await search('cat');await evaluate(`document.querySelector('.symbol-result').click();document.getElementById('symbol-save').scrollIntoView({block:'center'})`);
    assert.ok(await evaluate(`document.getElementById('symbol-save').getBoundingClientRect().width>100`));
    assert.ok(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`));
    await evaluate(`document.querySelectorAll('.toast').forEach(el=>el.remove())`);
    await new Promise(resolve=>setTimeout(resolve,350));
    await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('import-workflow-mobile.png'),Buffer.from(r.data,'base64')));
    assert.ok(await evaluate(`(()=>{const r=document.getElementById('symbol-library').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`),'Modal fits mobile viewport');
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await waitFor(`!document.getElementById('symbol-library').open`);
    await waitFor(`document.activeElement.dataset.symbolImport==='visualTargets'`);
    assert.equal(await evaluate(`document.activeElement.dataset.symbolImport`),'visualTargets','Closing restores the launch button focus');
    await evaluate(`document.querySelector('[data-symbol-import="visualTargets"]').scrollIntoView({block:'center',behavior:'instant'})`);
    await new Promise(r=>setTimeout(r,350));
    await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    const openButton=await evaluate(`(()=>{const r=document.querySelector('[data-symbol-import="visualTargets"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[openButton]});
    await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await waitFor(`document.getElementById('symbol-library').matches(':modal')`);
    assert.equal(await evaluate(`document.querySelector('[data-symbol-import]').dataset.symbolImport`),'visualTargets');
    await evaluate(`document.querySelector('#symbol-library [data-close-symbols]').focus()`);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
    assert.equal(await evaluate(`document.querySelectorAll('#layer-list > *').length`),2,'Modal keys cannot edit the project');
    for(let i=0;i<12;i++){
        await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        assert.ok(await evaluate(`document.getElementById('symbol-library').contains(document.activeElement)`),'Focus remains in dialog');
    }
    await evaluate(`document.documentElement.classList.add('dark');document.documentElement.dataset.menuColour='slate';document.getElementById('symbol-import-options').open=true`);
    await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('symbol-import-dark.png'),Buffer.from(r.data,'base64')));
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('PASS: stale results clear immediately; personal imports use existing selection actions without a duplicate prompt; mobile controls fit');
    socket.close();
})().catch(error=>{console.error(error,errors);socket?.close();process.exitCode=1});
