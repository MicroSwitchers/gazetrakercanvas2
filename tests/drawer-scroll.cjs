const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const start = html.indexOf('function setupDrawerScrollFix(drawer)');
const end = html.indexOf('            setupDrawerScrollFix(controlsDrawer);', start);
const context = vm.createContext({getComputedStyle: element => ({overflowY:element.overflow || 'visible'})});
vm.runInContext(html.slice(start,end),context);
let wheel;
const drawer = {addEventListener(type,fn){assert.equal(type,'wheel');wheel=fn;}};
const main = {parentElement:drawer,overflow:'auto',scrollTop:100,clientHeight:400,scrollHeight:1600};
const nested = {parentElement:main,overflow:'auto',scrollTop:20,clientHeight:100,scrollHeight:300};
const slider = {parentElement:nested,matches:()=>true};
context.setupDrawerScrollFix(drawer);
function send(target,deltaY,deltaMode=0,extra={}) {
    let prevented=0;
    wheel({target,deltaY,deltaMode,preventDefault(){prevented++;},...extra});
    return prevented;
}
assert.equal(send({matches:()=>false},80),0,'ordinary wheel events stay native');
assert.equal(main.scrollTop,100);assert.equal(nested.scrollTop,20);
assert.equal(send(slider,30),1);assert.equal(nested.scrollTop,50);assert.equal(main.scrollTop,100);
send(slider,-2,1);assert.equal(nested.scrollTop,18,'line deltas are normalized once');
send(slider,1,2);assert.equal(nested.scrollTop,118,'page deltas use the scroller height');
nested.scrollTop=200;send(slider,40);assert.equal(main.scrollTop,140,'a full nested scroller passes movement outward');
assert.equal(send(slider,20,0,{ctrlKey:true}),0,'browser zoom remains native');
assert.equal(send(slider,20,0,{defaultPrevented:true}),0,'already handled events are not scrolled twice');
assert.equal(send(slider,0),0);
console.log('Drawer native scrolling, single slider scroll, nested boundaries, delta modes, and zoom checks passed.');
