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

    // The animation remote (off by default) lets hotkeys work in Edit, so start from the default.
    await evaluate(`localStorage.removeItem('animationRemote.v1')`);
    await evaluate(`document.getElementById('splash-close-btn').click();document.getElementById('mode-opt-edit').click();const motion=AnimationMotion.frame;AnimationMotion.frame=(obj,now)=>{window.animationTarget=obj;return motion(obj,now)};document.getElementById('circle-tool').click()`);
    await waitFor(`window.animationTarget && document.querySelector('#layer-list .layer-item')`);
    await evaluate(`document.querySelector('[data-animation="circular"]').click();document.getElementById('trigger-on-press').click();document.getElementById('trigger-on-key').click();document.getElementById('animation-retrigger').value='toggle';document.getElementById('animation-retrigger').dispatchEvent(new Event('change'))`);
    assert.equal(await evaluate(`animationTarget.triggerKey`),'1');
    assert.equal(await evaluate(`animationTarget.isAnimating`),false,'Applying motion does not autoplay');
    async function key(options={}){await command('Input.dispatchKeyEvent',{type:'keyDown',key:'1',code:'Digit1',windowsVirtualKeyCode:49,...options});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'1',code:'Digit1',windowsVirtualKeyCode:49});}
    await evaluate(`document.getElementById('main-canvas').focus()`);await key();
    assert.equal(await evaluate(`animationTarget.isAnimating`),false,'Hotkeys do not animate while editing');
    await evaluate(`document.getElementById('animation-control-btn').click()`);
    assert.equal(await evaluate(`animationTarget.isAnimating`),true);
    await evaluate(`document.getElementById('animation-control-btn').click()`);
    assert.equal(await evaluate(`animationTarget.isAnimating`),false);
    await evaluate(`animationTarget.x=400;animationTarget.y=250;animationTarget.width=160;animationTarget.height=160;document.querySelector('.save-slot__btn--save[data-slot="1"]').click()`);
    await waitFor(`document.querySelector('.save-slot--active[data-slot="1"]')`);
    const read=`window.readAnimationSave=()=>new Promise(resolve=>{const r=indexedDB.open('gazeTrackerSaves');r.onsuccess=()=>{const db=r.result;const q=db.transaction('slots').objectStore('slots').get(1);q.onsuccess=()=>{resolve(q.result);db.close()}}});`;
    await evaluate(read);
    const scene=await evaluate(`readAnimationSave()`);
    assert.equal(scene.objects[0].animationRetrigger,'toggle');assert.equal(scene.objects[0].triggerOnKey,true);assert.equal(scene.objects[0].triggerOnPress,false);
    await evaluate(`(async()=>{const scene=await readAnimationSave();Object.assign(scene,{canvasZoom:1,canvasPanX:0,canvasPanY:0,showGuides:false});await new Promise(resolve=>{const r=indexedDB.open('gazeTrackerSaves');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('slots','readwrite');tx.objectStore('slots').put(scene);tx.oncomplete=()=>{db.close();resolve()}}});document.querySelector('.save-slot__btn--load[data-slot="1"]').click()})()`);
    await waitFor(`animationTarget.animationRetrigger==='toggle'`);
    await evaluate(`document.getElementById('mode-opt-play').click()`);
    await evaluate(`window.typingField=document.createElement('input');document.body.appendChild(typingField);typingField.focus()`);
    await key();assert.equal(await evaluate(`animationTarget.isAnimating`),false,'Typing does not trigger');
    await evaluate(`typingField.remove()`);
    await key({modifiers:2});assert.equal(await evaluate(`animationTarget.isAnimating`),false,'Ctrl shortcuts do not trigger');
    await key();assert.equal(await evaluate(`animationTarget.isAnimating`),true);
    const started=await evaluate(`animationTarget.animationStartTime`);
    await key({autoRepeat:true});assert.equal(await evaluate(`animationTarget.animationStartTime`),started,'Held key does not restart');
    await key();assert.equal(await evaluate(`animationTarget.isAnimating`),false,'Toggle stops');
    const tap=async(x,y)=>{await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
    await tap(480,330);assert.equal(await evaluate(`animationTarget.isAnimating`),false,'Adult-only target ignores child touch');
    await evaluate(`document.getElementById('mode-opt-edit').click();document.querySelector('#layer-list .layer-item').click();document.getElementById('trigger-on-press').click();document.getElementById('trigger-on-key').click();document.getElementById('animation-retrigger').value='ignore';document.getElementById('animation-retrigger').dispatchEvent(new Event('change'));document.getElementById('mode-opt-play').click()`);
    await key();assert.equal(await evaluate(`animationTarget.isAnimating`),false,'Child-only target ignores hotkey');
    await tap(480,330);assert.equal(await evaluate(`animationTarget.isAnimating`),true);
    const childStart=await evaluate(`animationTarget.animationStartTime`);
    const pose=await evaluate(`AnimationMotion.frame(animationTarget,performance.now())`);
    await tap(480+pose.x,330+pose.y);assert.equal(await evaluate(`animationTarget.animationStartTime`),childStart,'Ignore repeated trigger');
    await waitFor(`!animationTarget.isAnimating`);
    await evaluate(`document.getElementById('mode-opt-edit').click();document.querySelector('#layer-list .layer-item').click();document.querySelector('[data-animation="path"]').click()`);
    assert.equal(await evaluate(`document.getElementById('animation-control-btn').disabled`),true,'Path requires drawing before preview');
    await evaluate(`document.getElementById('draw-animation-path').click()`);
    assert.equal(await evaluate(`document.getElementById('controls-drawer').classList.contains('open')`),false,'Path drawing exposes canvas');
    assert.equal(await evaluate(`document.getElementById('path-drawing-toolbar').hidden`),false);
    await tap(700,330);
    await evaluate(`document.getElementById('finish-animation-path').click()`);
    assert.equal(await evaluate(`document.getElementById('animation-control-btn').disabled`),false);
    await evaluate(`window.savedPath=JSON.stringify(animationTarget.animationPath.nodes);window.pathDraws=0;window.guidePoints=0;const originalPathDraw=animationTarget.animationPath.draw;animationTarget.animationPath.draw=function(...args){pathDraws++;return originalPathDraw.apply(this,args)};const originalGuide=AnimationMotion.guide;AnimationMotion.guide=obj=>{const points=originalGuide(obj);guidePoints=points.length;return points}`);
    for(const type of ['gentle-shake','circular','pendum','']) {
        await evaluate(`pathDraws=0;guidePoints=0;document.querySelector('[data-animation="${type}"]').click()`);
        assert.equal(await evaluate(`pathDraws`),0,'Saved custom path is hidden for '+type);
        assert.equal(await evaluate(`guidePoints`),type?97:0,'Only active preset has a motion guide');
        assert.equal(await evaluate(`JSON.stringify(animationTarget.animationPath.nodes)`),await evaluate(`savedPath`),'Switching preserves the path');
        if(type==='pendum')await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('animation-sway-guide.png'),Buffer.from(r.data,'base64')));
    }
    await evaluate(`document.querySelector('.save-slot__btn--save[data-slot="1"]').click()`);
    await waitFor(`document.querySelector('.save-slot--active[data-slot="1"]')`);
    assert.equal(await evaluate(`(async()=>JSON.stringify((await readAnimationSave()).objects[0].animationPath.nodes))()`),await evaluate(`savedPath`),'Disabled custom path is included in saved projects');
    await evaluate(`document.querySelector('[data-animation="path"]').click()`);
    assert.ok(await evaluate(`pathDraws`)>0,'Reactivating Path shows the saved route');
    await evaluate(`pathDraws=0;guidePoints=0;animationTarget.pathAnimationDuration=.3;document.getElementById('mode-opt-play').click()`);
    assert.equal(await evaluate(`pathDraws+guidePoints`),0,'No motion guides in Play');
    await tap(480,330);
    await waitFor(`!animationTarget.isAnimating && !!animationTarget.animationRestPose`);
    assert.ok(Math.abs(await evaluate(`animationTarget.animationRestPose.x`)-220)<1,'Path stays at its endpoint');
    const pathStart=await evaluate(`animationTarget.animationStartTime`);
    await tap(700,330);
    assert.ok(await evaluate(`animationTarget.animationStartTime`)>pathStart,'The child can trigger the target at its moved position');
    await evaluate(`document.getElementById('mode-opt-edit').click();document.querySelector('#layer-list .layer-item').click();if(!document.getElementById('controls-drawer').classList.contains('open'))document.getElementById('toggle-controls-btn').click();document.getElementById('prop-tab-motion').click();document.getElementById('animation-settings').open=true;document.getElementById('draw-animation-path').scrollIntoView({block:'center',behavior:'instant'})`);
    await new Promise(r=>setTimeout(r,350));
    assert.equal(await evaluate(`document.getElementById('draw-animation-path').textContent`),'Edit path');
    await evaluate(`document.getElementById('draw-animation-path').scrollIntoView({block:'center',behavior:'instant'})`);
    const button=await evaluate(`(()=>{const r=document.getElementById('draw-animation-path').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await tap(button.x,button.y);
    await waitFor(`!document.getElementById('path-drawing-toolbar').hidden`);
    assert.equal(await evaluate(`document.getElementById('path-drawing-toolbar').hidden`),false,'Native touch opens editor');
    assert.equal(await evaluate(`animationTarget.animationPath.nodes.length`),2,'Edit preserves path');
    async function drag(points){
        await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[points[0]]});
        for(const point of points.slice(1))await command('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point]});
        await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }
    await new Promise(r=>setTimeout(r,350));
    await drag([{x:700,y:330},{x:720,y:380},{x:750,y:420}]);
    assert.ok(Math.abs(await evaluate(`animationTarget.animationPath.nodes[1].y`)-420)<2,'Touch drags existing node');
    await drag([{x:800,y:450},{x:840,y:480},{x:880,y:500},{x:930,y:490},{x:970,y:450}]);
    assert.ok(await evaluate(`animationTarget.animationPath.nodes.length`)>4,'Freehand stroke creates editable nodes');
    await tap(750,420);
    assert.equal(await evaluate(`document.getElementById('delete-path-node').disabled`),false);
    const count=await evaluate(`animationTarget.animationPath.nodes.length`);
    await evaluate(`document.getElementById('delete-path-node').click()`);
    assert.equal(await evaluate(`animationTarget.animationPath.nodes.length`),count-1,'Delete selected point');
    await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('animation-path-editor.png'),Buffer.from(r.data,'base64')));
    await evaluate(`document.getElementById('redraw-animation-path').click()`);
    assert.equal(await evaluate(`animationTarget.animationPath.nodes.length`),1,'New path starts at the target');
    await drag([{x:480,y:330},{x:520,y:360},{x:560,y:420},{x:600,y:450}]);
    assert.ok(await evaluate(`animationTarget.animationPath.nodes.length`)>2,'Draw directly from the target');
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await new Promise(r=>setTimeout(r,350));
    assert.ok(await evaluate(`(()=>{const r=document.getElementById('path-drawing-toolbar').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&[...document.querySelectorAll('#path-drawing-toolbar button')].every(b=>b.getBoundingClientRect().height>=44)})()`),'Path toolbar fits a narrow touch screen');
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('touch-selection-toolbar')).display`),'none','Path editor hides unrelated object actions');
    await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('animation-path-mobile.png'),Buffer.from(r.data,'base64')));
    await evaluate(`document.getElementById('finish-animation-path').click()`);
    await evaluate(`document.getElementById('mode-opt-edit').click();document.querySelector('#layer-list .layer-item').click();document.querySelector('[data-animation="gentle-shake"]').click();document.getElementById('trigger-on-key').click();if(!document.getElementById('controls-drawer').classList.contains('open'))document.getElementById('toggle-controls-btn').click();document.getElementById('prop-tab-motion').click()`);
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    await evaluate(`document.getElementById('animation-trigger-settings').scrollIntoView({block:'center',behavior:'instant'})`);
    await new Promise(r=>setTimeout(r,400));
    await command('Page.captureScreenshot').then(r=>fs.writeFileSync(require('./screenshot-path.cjs')('animation-setup-mobile.png'),Buffer.from(r.data,'base64')));
    assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('PASS: no autoplay, preview/stop, distinct adult/child triggers, modifier/repeat guards, saved setup, repeat policies, native touch path editing, freehand drawing, point deletion, endpoint hit testing, mobile layout');
    socket.close();
})().catch(e=>{console.error(e,errors);socket?.close();process.exitCode=1});
