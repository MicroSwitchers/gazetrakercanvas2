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
                return new Response(JSON.stringify(Array.from({length:25},(_,i)=>({_id:100+i,keywords:[{keyword:'Symbol '+i}]}))),{headers:{'Content-Type':'application/json'}});
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
        await waitFor(`document.querySelectorAll('.symbol-result').length===24`);
    }
    await search('symbols');
    await evaluate(`document.getElementById('symbol-more').click()`);
    await waitFor(`document.querySelectorAll('.symbol-result').length===25`);
    await evaluate(`(async()=>{const svg='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="10" y="10" width="80" height="80" rx="20" fill="#f6cc69"/><circle cx="35" cy="40" r="5"/><circle cx="65" cy="40" r="5"/><path d="M30 60 Q50 80 70 60" fill="none" stroke="black" stroke-width="4"/></svg>';await Promise.all([...document.querySelectorAll('.symbol-result img')].map(async img=>{img.loading='eager';img.onerror=null;img.src='data:image/svg+xml,'+encodeURIComponent(svg);img.hidden=false;img.parentElement.classList.remove('symbol-result--unavailable');await img.decode()}));document.querySelector('.symbol-result span').textContent='A longer symbol name that wraps onto several lines';})()`);
    for(const width of [1440,390]) {
        await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
        await command('Emulation.setTouchEmulationEnabled',{enabled:width<600,maxTouchPoints:5});
        await new Promise(r=>setTimeout(r,200));
        const layout=await evaluate(`(()=>{const cards=[...document.querySelectorAll('.symbol-result')];return cards.map(card=>{const r=card.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,contents:[...card.querySelectorAll('img,span,small')].map(el=>{const b=el.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right}})}})})()`);
        for(let i=0;i<layout.length;i++) {
            const card=layout[i];
            assert.ok(card.contents.every(b=>b.top>=card.top&&b.bottom<=card.bottom+1&&b.left>=card.left&&b.right<=card.right+1),width+': contents fit card '+i);
            for(const next of layout.slice(i+1))assert.ok(next.top>=card.bottom+8||next.left>=card.right+8||next.right<=card.left-8,width+': cards do not overlap');
        }
        assert.ok(await evaluate(`document.getElementById('symbol-results').scrollHeight>document.getElementById('symbol-results').clientHeight`),'Results scroll instead of compressing rows');
        await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('symbol-grid-'+width+'.png'),Buffer.from(r.data,'base64')));
    }
    await evaluate(`document.getElementById('symbol-library').close()`);
    for(const height of [700,1000]) {
        await command('Emulation.setDeviceMetricsOverride',{width:1440,height,deviceScaleFactor:1,mobile:false});
        // Each window ends just below its last row (or its drop zone when empty) instead of reserving a fixed height.
        const gaps=await evaluate(`[...document.querySelectorAll('[data-library-category] .library-window')].map(win=>{const content=[...win.children].filter(el=>getComputedStyle(el).display!=='none').at(-1).getBoundingClientRect();return win.getBoundingClientRect().bottom-content.bottom})`);
        assert.ok(gaps.every(gap=>gap>=0&&gap<=12),'No blank space below the last row: '+JSON.stringify(gaps));
    }
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('PASS: 25 loaded symbol images and wrapping labels fit non-overlapping rows on desktop and touch; library windows fit their content');
    socket.close();
})().catch(error=>{console.error(error,errors);socket?.close();process.exitCode=1});
