const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {createClass}=require('../js/pencil-object.js');
class Base {
    constructor(x,y,width,height,zIndex,type){Object.assign(this,{id:Math.random(),x,y,width,height,zIndex,type,visible:true,rotation:0,scale:1});}
}
const PencilObject=createClass(Base);
const stroke={points:[{x:100,y:100},{x:300,y:100}],width:10,color:'#FF0000',opacity:.8};
const obj=new PencilObject(stroke,5);
assert.equal(obj.type,'pencil');assert.equal(obj.pencilOpacity,80);
assert.ok(obj.hitsStroke(200,100),'eraser hits between sample points');
assert.ok(!obj.isPointInside(200,130));
obj.x+=100;assert.ok(obj.isPointInside(300,100));assert.ok(!obj.isPointInside(110,100));
obj.width*=2;assert.ok(obj.isPointInside(500,100));
obj.rotation=Math.PI/2;
assert.ok(obj.isPointInside(obj.x+obj.width/2,obj.y+obj.height/2+50));
assert.ok(!obj.isPointInside(obj.x+obj.width/2+50,obj.y+obj.height/2));
const dot=new PencilObject({points:[{x:30,y:50}],width:8},1);
assert.ok(dot.width>0 && dot.height>0);assert.ok(dot.isPointInside(30,50));
const calls=[];const ctx=new Proxy({}, {get:(t,k)=>t[k] || ((...a)=>calls.push([k,...a]))});
dot.drawContent(ctx);assert.ok(calls.some(c=>c[0]==='arc'));
assert.equal(calls.filter(c=>c[0]==='save').length,calls.filter(c=>c[0]==='restore').length);
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const part=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const context=vm.createContext({PencilObject});
vm.runInContext(part('function serializeObject(obj)','function snapshotState()')+
part('function applyBaseProperties(obj, data)','function restoreState(snapshot)'),context);
context.applyBaseProperties(obj,obj);
const data=context.serializeObject(obj),restored=context.rebuildObject(data);
assert.deepEqual(context.serializeObject(restored),data);
assert.equal(restored.hitsStroke(obj.x+obj.width/2,obj.y+obj.height/2+50),true);
const state={undos:0,lists:0};
Object.assign(context,{objects:[restored,dot],interactionMode:'edit',selectedObject:restored,
    pushUndo(){state.undos++;},updateLayerList(){state.lists++;},setSelectedObject(o){context.selectedObject=o;}});
vm.runInContext('let eraserUndoCaptured=false;'+part('function eraseStrokesAtPoint(x, y, radius)','// --- Drawing Engine ---'),context);
context.eraseStrokesAtPoint(restored.x+restored.width/2,restored.y+restored.height/2,10);
assert.equal(context.objects.length,1);assert.equal(context.selectedObject,null);
context.eraseStrokesAtPoint(30,50,10);assert.equal(context.objects.length,0);assert.equal(state.undos,1);
context.objects=[dot];context.interactionMode='play';context.eraseStrokesAtPoint(30,50,10);
assert.equal(context.objects.length,1);assert.equal(state.undos,1);
// Exercise the real pointer-up commit block, including a single-point drawing.
Object.assign(context,{objects:[],currentPencilStroke:{points:[{x:20,y:20}],width:5},isDrawingPencil:true,
    getNextZIndex:()=>2,setSelectedObject(o){context.selectedObject=o;},draw(){},cancelLongPress(){},activePointers:new Map()});
const start=html.indexOf('                    if (currentPencilStroke.points.length)');
const end=html.indexOf('                    currentPencilStroke = null;',start);
vm.runInContext(html.slice(start,end),context);
assert.equal(context.objects.length,1);assert.equal(context.selectedObject,context.objects[0]);
assert.equal(context.objects[0].type,'pencil');
context.objects=[];context.data={pencilStrokes:[stroke,{...stroke,smoothedPoints:[{x:10,y:10},{x:20,y:20}]}]};
vm.runInContext(part('for (const stroke of (data.pencilStrokes || []))','backgroundColor = data.backgroundColor'),context);
assert.equal(context.objects.length,2);
assert.ok(context.objects[0].isPointInside(200,100));
assert.ok(context.objects[1].isPointInside(15,15));
console.log('Pencil object creation, dots, movement, scaling, rotation, hit testing, save/undo round trips, eraser grouping, and Play protection passed.');
