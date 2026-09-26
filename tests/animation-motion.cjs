const assert=require('node:assert/strict');
const {frame}=require('../js/animation-motion.js');
const base={isAnimating:true,animationStartTime:1000,animationDuration:1,animationCycles:2,animationIntensity:5,width:160,height:160,rotation:0,scale:1};
for(const animationType of ['gentle-shake','pendum','circular']) {
    const obj={...base,animationType};
    for(const t of [1000,3000]) {
        const pose=frame(obj,t);
        assert.ok(Math.abs(pose.x)+Math.abs(pose.y)+Math.abs(pose.rotation)<1e-8,'Motion starts and ends at rest');
    }
    const mid=frame(obj,1250);
    assert.ok(Math.abs(mid.x)+Math.abs(mid.y)+Math.abs(mid.rotation)>0);
    assert.equal(frame(obj,3000).done,true);
    const before=frame(obj,2999);
    assert.ok(Math.abs(before.x)+Math.abs(before.y)+Math.abs(before.rotation)<.01,'Soft landing');
}
const path={...base,animationType:'path',pathAnimationDuration:4,pathAnimationSpeed:2,pathAnimationMode:'to-end',getCenterPoint:()=>({x:10,y:20}),animationPath:{nodes:[{},{}],getPointAt:t=>({x:10+100*t,y:20})}};
assert.equal(frame(path,2000).x,50,'Path duration and speed combine correctly');
assert.equal(frame(path,3000).x,100,'One-way path reaches endpoint');
assert.equal(frame(path,3000).hold,true);
path.pathAnimationMode='pingpong';
assert.equal(frame(path,2000).x,100);
assert.equal(frame(path,5000).x,0,'Round trip returns to start');
assert.equal(frame(path,5000).done,true);
assert.deepEqual(frame({...base,isAnimating:false,animationRestPose:{x:5,y:8,rotation:0}},5000),{x:5,y:8,rotation:0});
console.log('PASS: motion continuity, gentle stops, path speed/duration, endpoint hold and round trips');

const stopping={...base,isAnimating:false,animationType:'circular',animationTransition:{from:{x:80,y:20,rotation:.2},start:1000,stop:true}};
assert.equal(frame(stopping,1000).x,80,'Stop preserves current position');
assert.equal(frame(stopping,1175).x,40,'Stop eases toward home');
assert.equal(frame(stopping,1350).x,0);
assert.equal(frame(stopping,1350).done,true);
const restarting={...base,animationType:'circular',animationTransition:{from:{x:80,y:20,rotation:.2},start:1000,stop:false}};
assert.equal(frame(restarting,1000).x,80,'Restart begins at displayed position');
assert.ok(Math.abs(frame(restarting,1001).x-80)<.01,'Restart does not snap');

const shortRestart={...path,pathAnimationMode:'to-end',pathAnimationDuration:.3,pathAnimationSpeed:1,animationTransition:{from:{x:100,y:0,rotation:0},start:1000,stop:false,duration:100}};
assert.equal(frame(shortRestart,1300).x,100,'Short restarted paths still finish at the exact endpoint');

const {guide}=require('../js/animation-motion.js');
for(const animationType of ['gentle-shake','circular','pendum']) {
    const obj={...base,animationType,isAnimating:false,rotation:.6,scale:1.4,getCenterPoint:()=>({x:200,y:300})};
    const before=JSON.stringify(obj),points=guide(obj);
    assert.equal(points.length,97);
    assert.equal(JSON.stringify(obj),before,'Guides do not change playback state');
    const moving=frame({...obj,isAnimating:true,animationStartTime:0,animationCycles:3,animationGuide:true},1250);
    const anchor=animationType==='pendum'?obj.height/2*obj.scale:0;
    assert.ok(Math.abs(points[24].x-(200+moving.x-anchor*Math.sin(obj.rotation+moving.rotation)))<1e-8,'Guide matches rotated, scaled movement');
    assert.ok(Math.abs(points[24].y-(300+moving.y+anchor*Math.cos(obj.rotation+moving.rotation)))<1e-8);
}
assert.deepEqual(guide({...base,animationType:''}),[]);
assert.deepEqual(guide({...base,animationType:'path'}),[]);
console.log('PASS: motion guides match movement and preserve playback state');

// On turns: a route that goes right, then comes back left along a lower lane.
const uTurn=t=>t<.45?{x:1000*t/.45,y:0}:t<.55?{x:1000+100*Math.sin((t-.45)/.1*Math.PI),y:200*(t-.45)/.1}:{x:1000-1000*(t-.55)/.45,y:200};
const route={...base,animationType:'path',pathAnimationMode:'to-end',pathAnimationDuration:4,pathAnimationSpeed:1,getCenterPoint:()=>({x:0,y:0}),animationPath:{nodes:[{},{}],closed:false,getPointAt:uTurn}};
const flip={...route,pathTurnMode:'flip',pathFacing:0};
assert.equal(frame(flip,2000).sx,1,'Flip: faces the way it starts');
assert.equal(frame(flip,2000).rotation,0,'Flip: stays upright');
assert.ok(frame(flip,5000).sx<-.99,'Flip: faces back the other way after the U-turn');
assert.equal(frame({...flip,pathFacing:180},1000).sx,1,'Flip: starts as placed');
assert.ok(frame({...flip,pathFacing:180},2000).sx<-.99,'Flip: a left-facing picture is mirrored to drive right');
const rocket={...route,pathTurnMode:'rotate',pathFacing:-90};
assert.equal(frame(rocket,1000).rotation,0,'Rotate: eases in rather than snapping at the start');
assert.ok(Math.abs(frame(rocket,1800).rotation-Math.PI/2)<.05,'Rotate: an upward nose turns to point along the route');
assert.equal(frame({...route,pathTurnMode:'none'},3000).rotation,0,'No effect: no turning');
assert.equal(frame({...route,pathTurn:false},3000).rotation,0,'Older on/off switch still honoured');
console.log('PASS: rotate, flip and no-effect turn modes');
