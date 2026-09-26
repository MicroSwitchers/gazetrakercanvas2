/* Shared geometry for rendering, selection and anchored resizing. */
(function (root) {
    const names = { rect: 'Rectangle', square: 'Square', circle: 'Circle', triangle: 'Triangle', star: 'Star', octagon: 'Octagon' };
    function vertices(type) {
        if (type === 'triangle') return [[.5, 0], [1, 1], [0, 1]];
        if (type === 'octagon') {
            const a = 1 / (2 + Math.sqrt(2));
            return [[a,0],[1-a,0],[1,a],[1,1-a],[1-a,1],[a,1],[0,1-a],[0,a]];
        }
        if (type === 'star') {
            const points = Array.from({length: 10}, (_, i) => {
                const angle = -Math.PI / 2 + i * Math.PI / 5;
                const radius = i % 2 ? .225 : .5;
                return [Math.cos(angle) * radius, Math.sin(angle) * radius];
            });
            const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
            const minX = Math.min(...xs), minY = Math.min(...ys);
            const w = Math.max(...xs) - minX, h = Math.max(...ys) - minY;
            return points.map(([x,y]) => [(x-minX)/w, (y-minY)/h]);
        }
        return [[0,0],[1,0],[1,1],[0,1]];
    }
    function path(ctx, obj) {
        const {x,y,width:w,height:h,shapeType:type} = obj;
        ctx.beginPath();
        if (type === 'circle') ctx.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2);
        else if (type === 'rect' || type === 'square') ctx.roundRect(x,y,w,h,Math.min(obj.cornerRadius || 0,w/2,h/2));
        else vertices(type).forEach(([px,py],i) => ctx[i ? 'lineTo' : 'moveTo'](x+px*w,y+py*h));
        ctx.closePath();
    }
    function localPoint(obj, px, py) {
        const angle = -(obj.rotation || 0), c = Math.cos(angle), s = Math.sin(angle);
        const dx = px-obj.x-obj.width/2, dy = py-obj.y-obj.height/2;
        return {x: (dx*c-dy*s)/(obj.scale || 1)+obj.width/2, y: (dx*s+dy*c)/(obj.scale || 1)+obj.height/2};
    }
    function contains(obj, px, py) {
        const p = localPoint(obj,px,py), w = obj.width, h = obj.height;
        if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) return false;
        if (obj.shapeType === 'circle') return ((p.x-w/2)/(w/2))**2 + ((p.y-h/2)/(h/2))**2 <= 1;
        if (obj.shapeType === 'rect' || obj.shapeType === 'square') {
            const r = Math.min(obj.cornerRadius || 0,w/2,h/2);
            const dx = p.x-Math.max(r,Math.min(w-r,p.x)), dy = p.y-Math.max(r,Math.min(h-r,p.y));
            return dx*dx+dy*dy <= r*r;
        }
        const points = vertices(obj.shapeType), x=p.x/w, y=p.y/h;
        let inside = false;
        for (let i=0,j=points.length-1;i<points.length;j=i++) {
            const [ax,ay]=points[i], [bx,by]=points[j];
            if ((ay>y)!==(by>y) && x < (bx-ax)*(y-ay)/(by-ay)+ax) inside=!inside;
        }
        // Outline shapes remain easy to grab anywhere inside their silhouette.
        return inside;
    }
    function resize(orig, handle, px, py, type, rotation=0, pinned=null) {
        const sx = handle.endsWith('r') ? 1 : -1, sy = handle.startsWith('b') ? 1 : -1;
        const c=Math.cos(rotation), s=Math.sin(rotation);
        const cx=orig.x+orig.width/2, cy=orig.y+orig.height/2;
        const anchor = pinned || {x:cx-c*sx*orig.width/2+s*sy*orig.height/2, y:cy-s*sx*orig.width/2-c*sy*orig.height/2};
        const dx=px-anchor.x, dy=py-anchor.y, factor=pinned ? 2 : 1;
        let width=Math.max(10,(dx*c+dy*s)*sx*factor), height=Math.max(10,(-dx*s+dy*c)*sy*factor);
        if (type !== 'rect') {
            const ratio=type==='square' || type==='circle' ? 1 : orig.width/orig.height;
            const size=Math.max(width,height*ratio);
            width=size; height=size/ratio;
        }
        const center=pinned || {x:anchor.x+c*sx*width/2-s*sy*height/2, y:anchor.y+s*sx*width/2+c*sy*height/2};
        return {x:center.x-width/2,y:center.y-height/2,width,height};
    }
    const api = {names,vertices,path,localPoint,contains,resize};
    if (typeof module !== 'undefined') module.exports=api;
    else root.ShapeGeometry=api;
})(globalThis);
