(function(root) {
    function createClass(CanvasObject) {
        return class PencilObject extends CanvasObject {
            constructor(stroke, zIndex) {
                const points = stroke.smoothedPoints || stroke.points || [];
                const width = Math.max(1, stroke.width || 8), pad = width;
                let left=Infinity, top=Infinity, right=-Infinity, bottom=-Infinity;
                for (const p of points) {left=Math.min(left,p.x);top=Math.min(top,p.y);right=Math.max(right,p.x);bottom=Math.max(bottom,p.y);}
                if (!points.length) left=top=right=bottom=0;
                super(left-pad,top-pad,right-left+pad*2,bottom-top+pad*2,zIndex,'pencil');
                this.name='Highlight';
                this.points=points.map(p=>({x:p.x-this.x,y:p.y-this.y}));
                this.sourceWidth=this.width;this.sourceHeight=this.height;
                this.color=stroke.color || '#FF0000';this.lineWidth=width;
                this.pencilOpacity=(stroke.opacity ?? .95)*100;
            }
            drawContent(ctx) {
                if (!this.points.length) return;
                ctx.save();
                ctx.translate(this.x,this.y);
                ctx.scale(this.width/this.sourceWidth,this.height/this.sourceHeight);
                ctx.strokeStyle=this.color;ctx.fillStyle=this.color;
                ctx.lineCap='round';ctx.lineJoin='round';
                const opacity=this.pencilOpacity/100;
                for (const [width,alpha,blur,blend] of [[1.05,.15,.25,'source-over'],[1,.88,.08,'source-over'],[.45,.25,0,'source-over'],[.25,.35,0,'overlay']]) {
                    ctx.globalAlpha=opacity*alpha;ctx.shadowColor=this.color;ctx.shadowBlur=this.lineWidth*blur;
                    ctx.globalCompositeOperation=blend;ctx.lineWidth=this.lineWidth*width;
                    ctx.beginPath();
                    if (this.points.length===1) {
                        ctx.arc(this.points[0].x,this.points[0].y,ctx.lineWidth/2,0,Math.PI*2);ctx.fill();
                    } else {
                        ctx.moveTo(this.points[0].x,this.points[0].y);
                        for (const point of this.points.slice(1)) ctx.lineTo(point.x,point.y);
                        ctx.stroke();
                    }
                }
                ctx.restore();
            }
            hitsStroke(x,y,radius=0) {
                const angle=this.rotation || 0,c=Math.cos(angle),s=Math.sin(angle),scale=this.scale || 1;
                const points=this.points.map(p=>{
                    const dx=(p.x/this.sourceWidth-.5)*this.width*scale*(this.flipHorizontal?-1:1);
                    const dy=(p.y/this.sourceHeight-.5)*this.height*scale*(this.flipVertical?-1:1);
                    return {x:this.x+this.width/2+dx*c-dy*s,y:this.y+this.height/2+dx*s+dy*c};
                });
                const tolerance=radius+this.lineWidth/2*Math.max(this.width/this.sourceWidth,this.height/this.sourceHeight)*scale;
                return points.some((p,i)=>{
                    const q=points[Math.max(0,i-1)],dx=p.x-q.x,dy=p.y-q.y,length=dx*dx+dy*dy;
                    const t=length?Math.max(0,Math.min(1,((x-q.x)*dx+(y-q.y)*dy)/length)):0;
                    return Math.hypot(x-q.x-t*dx,y-q.y-t*dy)<=tolerance;
                });
            }
            isPointInside(x,y) {return this.hitsStroke(x,y,4);}
        };
    }
    if (typeof module!=='undefined') module.exports={createClass};
    else root.PencilDrawing={createClass};
})(globalThis);
