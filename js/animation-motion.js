/* Time-based motion shared by rendering and pointer hit testing. */
(function(root) {
    const smooth = t => t * t * (3 - 2 * t);
    const clamp01 = t => Math.max(0, Math.min(1, t));
    const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

    // How much energy the motion has right now. Real objects need a push to get going, lose a
    // little energy on every swing, and settle to rest rather than stopping dead.
    function energy(elapsed, duration, total) {
        const push = smooth(clamp01(elapsed / (duration * .6)));
        const settle = smooth(clamp01((total - elapsed) / Math.min(total * .45, duration * 1.2)));
        return push * settle * (1 - .25 * clamp01(elapsed / total));
    }

    // Direction of the route at u (0 to 1), measured across a short stretch of the line so
    // hand-drawn wobbles do not make the target twitch.
    function pathHeading(path, u) {
        const length = path.getLengthTable?.().total || 0;
        const d = length ? Math.min(.1, Math.max(20, Math.min(60, length * .03)) / length) : .02;
        const at = v => path.getPointAt(path.closed ? ((v % 1) + 1) % 1 : clamp01(v));
        const a = at(u - d), b = at(u + d);
        return Math.atan2(b.y - a.y, b.x - a.x);
    }

    // What a path target does on turns: 'rotate' (turn with the line), 'flip' (stay upright and
    // mirror to face the way it is going) or 'none'. Older projects stored a pathTurn switch.
    function pathTurnMode(obj) {
        return ['rotate', 'flip', 'none'].includes(obj.pathTurnMode) ? obj.pathTurnMode : obj.pathTurn === false ? 'none' : 'rotate';
    }
    // Which way the front of the picture points, as placed: 0 = right, 90 = down, 180 = left, -90 = up.
    const facingRadians = obj => (Number(obj.pathFacing) || 0) * Math.PI / 180;

    // Left/right travel along the route, with a dead zone around straight up and down so a target
    // only flips once the line has really turned back on itself. Smoothed over a short stretch of
    // the route so the flip looks like the target turning round rather than a jump.
    function travelSide(path, u, startSide) {
        const table = path.getLengthTable?.();
        const key = `${table?.key}|${startSide}`;
        if (path._flipTable?.key !== key) {
            const count = 240, sides = new Float32Array(count + 1);
            let side = Math.cos(pathHeading(path, 0)) > .2 ? 1 : Math.cos(pathHeading(path, 0)) < -.2 ? -1 : startSide;
            for (let i = 0; i <= count; i++) {
                const c = Math.cos(pathHeading(path, i / count));
                if (c > .2) side = 1; else if (c < -.2) side = -1;
                sides[i] = side;
            }
            const sums = new Float32Array(count + 2);
            for (let i = 0; i <= count; i++) sums[i + 1] = sums[i] + sides[i];
            // The turn-round is spread over roughly 14% of the route (120-300px each side of the turn).
            const length = table?.total || 1000, reach = Math.max(120, Math.min(300, length * .14));
            path._flipTable = { key, count, sums, window: Math.max(1, Math.round(count * reach / length)) };
        }
        const { count, sums, window } = path._flipTable;
        const i = Math.round(clamp01(u) * count), lo = Math.max(0, i - window), hi = Math.min(count, i + window);
        // Ease in and out of the turn so it starts gently, turns through the middle and settles.
        return 2 * smooth((sums[hi + 1] - sums[lo]) / (hi - lo + 1) / 2 + .5) - 1;
    }

    function motionFrame(obj, now) {
        if (!obj.isAnimating || !obj.animationType) return obj.animationRestPose || {x:0,y:0,rotation:0};
        const path = obj.animationType === 'path';
        const duration = Math.max(.1, path ? (obj.pathAnimationDuration || 5) / (obj.pathAnimationSpeed || 1) : obj.animationDuration || 1);
        const cycles = path && obj.pathAnimationMode === 'to-end' ? 1 : Math.max(1, obj.animationCycles || 1);
        const elapsed = Math.max(0, (now - obj.animationStartTime) / 1000);
        const done = elapsed >= duration * cycles;
        const phase = done ? 1 : (elapsed / duration) % 1;
        if (path && obj.animationPath?.nodes.length >= 2) {
            const once = obj.pathAnimationMode === 'to-end';
            let progress;
            if (once) progress = smooth(phase);
            else if (obj.animationPath.closed && obj.pathAnimationMode === 'loop') {
                // Constant speed around a closed route, easing in only at the very start and out
                // at the very end, so laps flow into each other instead of stopping every lap.
                const total = duration * cycles, ramp = Math.min(duration * .5, total / 4, .8);
                const t = Math.min(elapsed, total), speed = 1 / (total - ramp);
                const travelled = t < ramp ? speed * t * t / (2 * ramp)
                    : t > total - ramp ? 1 - speed * (total - t) ** 2 / (2 * ramp)
                    : speed * (t - ramp / 2);
                progress = done ? 0 : (travelled * cycles) % 1;
            } else progress = .5 - .5 * Math.cos(phase * 2 * Math.PI);
            const point = obj.animationPath.getPointAt(progress), center = obj.getCenterPoint();
            const mode = pathTurnMode(obj);
            let rotation = 0, sx = 1;
            if (mode !== 'none') {
                // Ease into the turn or flip when starting, and back out when the target returns home,
                // so nothing snaps.
                const total = duration * cycles;
                const ease = mode === 'flip' ? .8 : .45; // flips turn round more slowly than rotation
                const blend = smooth(clamp01(elapsed / ease)) * (once ? 1 : smooth(clamp01((total - elapsed) / ease)));
                // There and back: the target turns round at the far end instead of reversing.
                const t = elapsed / duration;
                const sharpness = mode === 'flip' ? 1.6 : 4;
                const heading = obj.pathAnimationMode === 'pingpong' ? (t < .25 ? 1 : Math.max(-1, Math.min(1, Math.sin(t * 2 * Math.PI) * sharpness))) : 1;
                if (mode === 'rotate') {
                    const along = pathHeading(obj.animationPath, progress) + Math.PI * (1 - heading) / 2;
                    rotation = wrapAngle(along - facingRadians(obj) - (obj.rotation || 0)) * blend;
                } else {
                    const facingSide = Math.cos(facingRadians(obj)) < -.01 ? -1 : 1;
                    const side = travelSide(obj.animationPath, progress, facingSide) * heading * facingSide;
                    sx = 1 + (side - 1) * blend;
                }
            }
            return {x:point.x-center.x,y:point.y-center.y,rotation,sx,sy:1,done,hold:once};
        }
        const total = duration * cycles;
        const e = obj.animationGuide ? 1 : energy(elapsed, duration, total);
        const strength = (obj.animationIntensity || 5) / 5;
        const weight = Math.min(strength, 2.4); // squash and lean stop growing at very large sizes
        const angle = phase * 2 * Math.PI, swing = Math.sin(angle), speed = Math.cos(angle);
        // Size is measured against the target: Medium moves about a third of its size, Huge about
        // its whole size, and the largest settings well beyond it.
        const amplitude = Math.max(30, Math.min(obj.width, obj.height) * .3) * strength * e;
        let x=0,y=0,rotation=0,sx=1,sy=1;
        if (obj.animationType === 'gentle-shake') {
            // Side to side; the top trails the movement and the body squashes as it turns back.
            x = swing * amplitude;
            rotation = -.07 * weight * e * Math.cos(angle - .5);
            sx = 1 - .035 * weight * e * swing * swing; sy = 1 / sx;
        }
        if (obj.animationType === 'circular') {
            // Round a circle, leaning into the direction of travel.
            x = (Math.cos(angle) - 1) * amplitude; y = swing * amplitude;
            rotation = -.08 * weight * e * Math.sin(angle - .4);
        }
        if (obj.animationType === 'pendum') {
            // Hangs like a weight on a string: it stretches a little at the bottom of each swing,
            // where it moves fastest, and lingers at each end. Bigger sways hang from a longer
            // string above the target, so they sweep a wide arc instead of just tilting.
            rotation = Math.min(1.2, .065 * (obj.animationIntensity || 5)) * e * swing;
            sy = 1 + .02 * weight * (e * speed) ** 2; sx = 1 - .012 * weight * (e * speed) ** 2;
            const half = obj.height / 2, string = obj.height * .6 * Math.max(0, strength - 1);
            const hang = string + half * sy;
            x = -hang * Math.sin(rotation); y = hang * Math.cos(rotation) - string - half;
        }
        const a=obj.rotation || 0, scale=obj.scale || 1;
        return {x:(x*Math.cos(a)-y*Math.sin(a))*scale,y:(x*Math.sin(a)+y*Math.cos(a))*scale,rotation,sx,sy,done};
    }
    // Runtime transitions stay separate from saved animation settings.
    function frame(obj, now) {
        const transition = obj.animationTransition;
        const pose = transition?.stop ? {x:0,y:0,rotation:0} : motionFrame(obj, now);
        if (!transition) return pose;
        const t = Math.max(0, Math.min(1, (now-transition.start)/(transition.duration||350)));
        const weight = 1-smooth(t), from = transition.from;
        return {...pose, x:pose.x+from.x*weight,
            y:pose.y+from.y*weight, rotation:pose.rotation+from.rotation*weight,
            sx:(pose.sx ?? 1)+((from.sx ?? 1)-1)*weight, sy:(pose.sy ?? 1)+((from.sy ?? 1)-1)*weight,
            done:transition.stop ? t===1 : pose.done};
    }
    // Sample a full-strength cycle for a stable setup guide, independent of playback.
    function guide(obj) {
        if (!['gentle-shake','circular','pendum'].includes(obj.animationType)) return [];
        const duration=Math.max(.1,obj.animationDuration||1);
        const sample={...obj,isAnimating:true,animationStartTime:0,animationCycles:3,animationRestPose:null,animationGuide:true};
        const center=obj.getCenterPoint(), points=[];
        const anchorY=obj.animationType==='pendum'?obj.height/2*(obj.scale||1):0;
        for(let i=0;i<=96;i++) {
            const pose=motionFrame(sample,duration*1000*(1+i/96));
            const angle=(obj.rotation||0)+pose.rotation;
            points.push({x:center.x+pose.x-anchorY*Math.sin(angle),y:center.y+pose.y+anchorY*Math.cos(angle)});
        }
        return points;
    }
    const api={frame,guide,pathTurnMode};
    if(typeof module!=='undefined')module.exports=api;else root.AnimationMotion=api;
})(globalThis);
