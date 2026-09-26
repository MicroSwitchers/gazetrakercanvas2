const assert = require('node:assert/strict');
const previews = require('../js/layer-previews.js');
const calls = [];
const ctx = new Proxy({}, {get(target,key) {return target[key] || ((...args) => calls.push([key,...args]));}});
const canvas = {width:88,height:88,getContext:()=>ctx};
const obj = {id:1,type:'shape',name:'Star',x:100,y:60,width:200,height:180,rotation:.4,
    appearance:'playful',color:'#FF0000',drawContent(context){assert.equal(context,ctx);calls.push(['content']);}};
previews.render(canvas,obj);
assert.ok(calls.some(c=>c[0]==='content'));
assert.ok(calls.some(c=>c[0]==='rotate' && c[1]===.4));
assert.ok(calls.some(c=>c[0]==='translate' && c[1]===-200 && c[2]===-150));
assert.equal(calls.filter(c=>c[0]==='save').length,calls.filter(c=>c[0]==='restore').length);
const key=previews.signature(obj);
obj.x+=20;assert.equal(previews.signature(obj),key,'movement does not rerender a thumbnail');
obj.color='#00FF00';assert.notEqual(previews.signature(obj),key);
const label={};const manager=previews.create();manager.add(obj,canvas,label);
calls.length=0;manager.refresh();assert.equal(label.textContent,'Star');
calls.length=0;manager.refresh();assert.equal(calls.length,0,'unchanged preview is cached');
obj.appearance='outline';manager.refresh();assert.ok(calls.some(c=>c[0]==='content'));
obj.type='text';obj.text='<script>literal text</script>';manager.refresh();
assert.equal(label.textContent,obj.text,'text uses a text node');assert.equal(label.title,obj.text);
const media={tagName:'VIDEO',readyState:1,currentTime:0,videoWidth:0,
    listeners:new Map(),addEventListener(event,fn){this.listeners.set(event,fn);},removeEventListener(event){this.listeners.delete(event);}};
obj.type='video';obj.video=media;calls.length=0;previews.render(canvas,obj);
assert.ok(calls.some(c=>c[0]==='fillText'));assert.ok(!calls.some(c=>c[0]==='content'));
manager.clear();manager.add(obj,canvas,label);assert.equal(media.listeners.size,4);
media.readyState=2;media.videoWidth=640;manager.refresh();
const frameKey=previews.signature(obj);media.currentTime=.25;assert.notEqual(previews.signature(obj),frameKey);
calls.length=0;manager.refresh();assert.ok(calls.some(c=>c[0]==='content'));
manager.clear();assert.equal(media.listeners.size,0,'rebuilding a list releases media listeners');
calls.length=0;manager.refresh();assert.equal(calls.length,0);
// A failed frame restores the context, and later frames can recover.
const broken={...obj,drawContent(){throw new Error('frame unavailable');}};
manager.add(broken,canvas,label);calls.length=0;manager.refresh();
assert.equal(calls.filter(c=>c[0]==='save').length,calls.filter(c=>c[0]==='restore').length);
broken.drawContent=obj.drawContent;calls.length=0;manager.refresh();assert.ok(calls.some(c=>c[0]==='content'));
manager.clear();
console.log('Layer preview rendering, caching, text updates, video frames, listener cleanup, and failed-frame recovery passed.');
