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
    await command('Network.setCacheDisabled',{cacheDisabled:true});
    await command('Network.setBypassServiceWorker',{bypass:true});
    for(const device of [
        {name:'iPad desktop mode',ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.4 Safari/605.1.15',platform:'MacIntel',cls:'ios-device',width:1024,height:1366},
        {name:'Android tablet',ua:'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',platform:'Linux armv8l',cls:'android-device',width:800,height:1280}
    ]) {
        await command('Emulation.setUserAgentOverride',{userAgent:device.ua,platform:device.platform});
        await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
        await command('Emulation.setDeviceMetricsOverride',{width:device.width,height:device.height,deviceScaleFactor:3,mobile:true});
        await command('Page.navigate',{url:'about:blank'});
        await waitFor(`location.href==='about:blank' && document.readyState==='complete'`);
        await command('Storage.clearDataForOrigin',{origin:'http://127.0.0.1:8765',storageTypes:'indexeddb,service_workers,cache_storage,local_storage'});
        await command('Page.navigate',{url:'http://127.0.0.1:8765/'});
        await waitFor(`document.getElementById('library-status')?.dataset.ready==='true'`);
        assert.ok(await evaluate(`document.documentElement.classList.contains('${device.cls}') && document.documentElement.classList.contains('tablet-device')`),device.name+' is detected');
        await evaluate(`document.getElementById('splash-close-btn').click();document.getElementById('mode-opt-edit').click();const original=AnimationMotion.frame;AnimationMotion.frame=(obj,now)=>{window.tabletTarget=obj;window.tabletTransform=document.getElementById('main-canvas').getContext('2d').getTransform().toJSON();return original(obj,now)};document.getElementById('circle-tool').click()`);
        await waitFor(`window.tabletTarget`);
        const initial=await evaluate(`({x:tabletTarget.x,y:tabletTarget.y})`);
        for(const size of [{width:device.width,height:device.height},{width:device.height,height:device.width}]){
            await command('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:3,mobile:true});
            await new Promise(r=>setTimeout(r,200));
            assert.deepEqual(await evaluate(`({x:tabletTarget.x,y:tabletTarget.y})`),initial,'Rotation preserves target coordinates');
            const matrix=await evaluate(`tabletTransform`);
            const zoom=Math.min((size.width-40)/1920,(size.height-40)/1080);
            assert.ok(Math.abs(matrix.a/2-zoom)<.01,device.name+' canvas stays fitted after rotation');
            assert.equal(await evaluate(`document.getElementById('main-canvas').width`),3840,'Retina drawing memory stays bounded');
            await evaluate(`if(!document.getElementById('media-library').classList.contains('open'))document.getElementById('toggle-library-btn').click();document.querySelector('[data-symbol-import]').click()`);
            assert.ok(await evaluate(`(()=>{const r=document.getElementById('symbol-library').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`),'Dialog fits tablet');
            await evaluate(`Object.defineProperty(visualViewport,'height',{configurable:true,value:430});Object.defineProperty(visualViewport,'offsetTop',{configurable:true,value:25});visualViewport.dispatchEvent(new Event('resize'))`);
            await new Promise(r=>setTimeout(r,100));
            assert.ok(await evaluate(`(()=>{const r=document.getElementById('symbol-library').getBoundingClientRect();const b=document.getElementById('symbol-save').getBoundingClientRect();return r.top>=25&&r.bottom<=455&&b.bottom<=r.bottom})()`),'Keyboard leaves import action visible');
            await evaluate(`delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('resize'));document.getElementById('symbol-library').close()`);
            assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'No horizontal overflow');
        }
        console.log('PASS: '+device.name+' detection, portrait/landscape fit, unchanged targets, bounded retina canvas, and simulated keyboard viewport');
    }
    await command('Emulation.setUserAgentOverride',{userAgent:'',platform:''});
    assert.equal(errors.length,0,JSON.stringify(errors));
    socket.close();
})().catch(e=>{console.error(e,errors);socket?.close();process.exitCode=1});
