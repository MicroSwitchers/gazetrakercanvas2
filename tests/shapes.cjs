// Pure geometry and actual app shape serialization/rendering; no browser required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const geometry = require('../js/shape-geometry.js');
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-7, `${a} != ${b}`);
const base = {x:100,y:80,width:200,height:200,rotation:0,scale:1,cornerRadius:0};
for (const type of Object.keys(geometry.names)) {
    const obj={...base,shapeType:type};
    assert.ok(geometry.contains(obj,200,180),type+' center');
    assert.ok(!geometry.contains(obj,90,180),type+' outside');
    if (!['rect','square'].includes(type)) assert.ok(!geometry.contains(obj,101,81),type+' transparent corner');
}
assert.ok(!geometry.contains({...base,shapeType:'rect',cornerRadius:30},101,81));
const rotated={...base,width:300,height:100,shapeType:'rect',rotation:Math.PI/2};
assert.ok(geometry.contains(rotated,250,260));
assert.ok(!geometry.contains(rotated,380,130));
for (const type of ['star','octagon','triangle']) {
    const points=geometry.vertices(type);
    for (const axis of [0,1]) {near(Math.min(...points.map(p=>p[axis])),0);near(Math.max(...points.map(p=>p[axis])),1);}
}
for (const type of Object.keys(geometry.names)) for (const handle of ['tl','tr','bl','br']) for (const angle of [0,.6,Math.PI/2]) {
    const orig={x:100,y:80,width:200,height:200};
    const sx=handle.endsWith('r')?1:-1, sy=handle.startsWith('b')?1:-1;
    const c=Math.cos(angle),s=Math.sin(angle);
    const anchor={x:200-c*sx*100+s*sy*100,y:180-s*sx*100-c*sy*100};
    const pointer={x:anchor.x+c*sx*260-s*sy*240,y:anchor.y+s*sx*260+c*sy*240};
    const r=geometry.resize(orig,handle,pointer.x,pointer.y,type,angle);
    near(r.x+r.width/2-c*sx*r.width/2+s*sy*r.height/2,anchor.x);
    near(r.y+r.height/2-s*sx*r.width/2-c*sy*r.height/2,anchor.y);
    if (type!=='rect') near(r.width,r.height);
    const crossed=geometry.resize(orig,handle,anchor.x-c*sx*30+s*sy*30,anchor.y-s*sx*30-c*sy*30,type,angle);
    assert.ok(crossed.width>=10 && crossed.height>=10);
}
const pinned=geometry.resize(base,'br',300,280,'circle',0,{x:200,y:180});
near(pinned.x+pinned.width/2,200); near(pinned.y+pinned.height/2,180);
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const part=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const context=vm.createContext({ShapeGeometry:geometry,CanvasObject:class {
    constructor(x,y,width,height,zIndex,type){Object.assign(this,{x,y,width,height,zIndex,type,rotation:0,scale:1,visible:true});}
}});
vm.runInContext(part('class ShapeObject extends CanvasObject','class AnimationPath')+
    part('function serializeObject(obj)', 'function snapshotState()')+
    part('function applyBaseProperties(obj, data)', 'function restoreState(snapshot)')+
    ';globalThis.Shape=ShapeObject;',context);
const shape=new context.Shape('star',200,200,1,'#FF0000');
assert.equal(shape.appearance,'playful');
assert.equal(context.rebuildObject(context.serializeObject(shape)).appearance,'playful');
shape.appearance='outline';shape.strokeColor='#2680FF';shape.strokeWidth=9;shape.cornerRadius=16;
const saved=context.serializeObject(shape), restored=context.rebuildObject(saved);
for(const key of ['shapeType','color','appearance','strokeColor','strokeWidth','cornerRadius','x','y','width','height']) assert.equal(restored[key],shape[key],key);
delete saved.appearance;
assert.equal(context.rebuildObject(saved).appearance,'shaded','legacy saves retain shading');
const calls=[];
const ctx=new Proxy({}, {get(target,key){return target[key] || ((...args)=>calls.push([key,...args]));},set(target,key,value){target[key]=value;return true;}});
shape.appearance='solid';shape.drawContent(ctx);
assert.equal(ctx.fillStyle,'#FF0000');
assert.ok(calls.some(c=>c[0]==='fill'));
assert.ok(!calls.some(c=>/Gradient|shadow/i.test(c[0])));
calls.length=0;shape.appearance='outline';shape.drawContent(ctx);
assert.equal(ctx.strokeStyle,'#2680FF');assert.equal(ctx.lineWidth,18);
assert.ok(calls.findIndex(c=>c[0]==='clip')<calls.findIndex(c=>c[0]==='stroke'));
assert.ok(!calls.some(c=>c[0]==='fill'));
// Check the new finish for every silhouette, including small and stretched shapes.
for (const type of Object.keys(geometry.names)) for (const [width,height] of [[10,10],[180,180],[400,80]]) {
    const toy=new context.Shape(type,100,100,1,'#4285F4');
    toy.width=width;toy.height=height;
    const ops=[];
    const paint=new Proxy({}, {get(target,key) {
        return (...args) => {
            ops.push([key,...args]);
            for (const arg of args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg));
            if (key==='createLinearGradient' || key==='createRadialGradient') return {addColorStop(offset,color){
                assert.ok(offset>=0 && offset<=1);assert.ok(!color.includes('NaN'));
            }};
        };
    }});
    toy.drawContent(paint);
    assert.ok(ops.findIndex(op=>op[0]==='clip')<ops.findIndex(op=>op[0]==='fill'));
    assert.equal(ops.filter(op=>op[0]==='save').length,ops.filter(op=>op[0]==='restore').length);
    assert.ok(ops.some(op=>op[0]==='createRadialGradient'));
    assert.ok(ops.some(op=>op[0]==='stroke'));
}
console.log('Shape geometry, rotated corner anchoring, minimum sizes, pinned resize, rendering, save/undo round trips, and legacy compatibility passed.');
// Exercise the app's actual control handlers, including undo boundaries and Play protection.
const elements = new Map();
const element = id => {
    if (!elements.has(id)) elements.set(id,{value:'',handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}});
    return elements.get(id);
};
const history=[];
Object.assign(context,{document:{getElementById:element,querySelectorAll:()=>[]},shapeColorInput:element('shape-color-input'),
    selectedObject:shape,interactionMode:'edit',currentGrid:null,pushUndo:()=>history.push(context.serializeObject(shape)),
    updateLayerList(){},draw(){}});
vm.runInContext(part('function updateShapeControls()', '// Flip functionality'),context);
function change(id,value) {
    const input=element(id);input.value=String(value);input.valueAsNumber=Number(value);
    input.handlers.change({target:input});
}
shape.shapeType='circle';shape.width=shape.height=180;
const center=[shape.x+90,shape.y+90];
change('shape-width',240);
assert.equal(shape.width,240);assert.equal(shape.height,240);
near(shape.x+120,center[0]);near(shape.y+120,center[1]);assert.equal(history.length,1);
change('shape-height','');assert.equal(shape.height,240);assert.equal(history.length,1);
change('shape-stroke-width',99);assert.equal(shape.strokeWidth,30);
change('shape-style','outline');assert.equal(element('shape-outline-settings').hidden,false);
assert.equal(element('shape-color-input').disabled,true);
const before=context.serializeObject(shape), count=history.length;
context.interactionMode='play';change('shape-width',400);change('shape-color-input','#FFFF00');
assert.deepEqual(context.serializeObject(shape),before);assert.equal(history.length,count);
for (const match of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!match[1].includes('module')) new vm.Script(match[2]);
}
console.log('Shape property controls, one-step undo snapshots, invalid input handling, Play protection, and inline script syntax passed.');
