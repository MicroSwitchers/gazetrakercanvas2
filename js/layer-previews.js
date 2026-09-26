/* Small, live canvas previews. Reuse object renderers without triggering animations. */
(function (root) {
    function signature(obj) {
        const media = obj.video || obj.img;
        return JSON.stringify([obj.name, obj.type, obj.shapeType, obj.width, obj.height, obj.rotation,
            obj.flipHorizontal, obj.flipVertical, obj.color, obj.appearance, obj.cornerRadius,
            obj.strokeColor, obj.strokeWidth, obj.text, obj.size, obj.fontFamily,
            obj.fontWeight, obj.fontStyle, obj.lineWidth, obj.pencilOpacity, obj.points,
            media?.currentSrc || media?.src, media?.naturalWidth, media?.videoWidth,
            media?.readyState, Math.floor((media?.currentTime || 0) * 8)]);
    }
    function render(canvas, obj) {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const size = canvas.width;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, size, size);
        const media = obj.video || obj.img;
        const waiting = media && (media.tagName === 'VIDEO' ? media.readyState < 2 : !media.complete || !media.naturalWidth);
        if (waiting || typeof obj.drawContent !== 'function') {
            ctx.fillStyle = '#64748b';
            ctx.font = `600 ${size * .28}px system-ui`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(obj.type === 'video' ? '\u25b6' : '\u25c7', size / 2, size / 2);
            return;
        }
        // Pencil strokes may have bounds that do not include their line thickness.
        const pad = obj.type === 'pencil' ? (obj.lineWidth || 8) / 2 : 0;
        const w = Math.max(1, obj.width) + pad * 2, h = Math.max(1, obj.height) + pad * 2;
        const angle = obj.rotation || 0, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
        const fit = (size - 12) / Math.max(w*c + h*s, w*s + h*c);
        ctx.save();
        try {
            ctx.translate(size / 2, size / 2);
            ctx.scale(fit, fit);
            ctx.rotate(angle);
            ctx.scale(obj.flipHorizontal ? -1 : 1, obj.flipVertical ? -1 : 1);
            ctx.translate(-obj.x - obj.width / 2, -obj.y - obj.height / 2);
            // drawContent includes the shape finish, font and media appearance, but
            // avoids draw()'s animation state changes and selection decorations.
            ctx.textAlign = 'start';
            obj.drawContent(ctx);
        } finally { ctx.restore(); }
    }
    function create() {
        const entries = new Map();
        let timer = null;
        function refresh() {
            timer = null;
            for (const entry of entries.values()) {
                const key = signature(entry.obj);
                if (key === entry.key) continue;
                try { render(entry.canvas, entry.obj); entry.key = key; }
                catch { /* An unavailable media frame should not interrupt the editor. */ }
                entry.label.textContent = entry.obj.type === 'text' ? entry.obj.text || 'Empty text' : entry.obj.name;
                entry.label.title = entry.label.textContent;
            }
        }
        function schedule() {
            if (timer === null && entries.size) timer = setTimeout(refresh, 100);
        }
        function clear() {
            if (timer !== null) clearTimeout(timer);
            timer = null;
            for (const entry of entries.values()) entry.detach?.();
            entries.clear();
        }
        function add(obj, canvas, label) {
            const entry = {obj,canvas,label,key:null};
            const media = obj.video || obj.img;
            if (media?.addEventListener) {
                const events = ['load','loadeddata','seeked','error'];
                events.forEach(event => media.addEventListener(event, schedule));
                entry.detach = () => events.forEach(event => media.removeEventListener(event, schedule));
            }
            entries.set(obj.id, entry);
        }
        function invalidate() { for (const entry of entries.values()) entry.key = null; schedule(); }
        return {add,clear,refresh,schedule,invalidate};
    }
    const api = {signature,render,create};
    if (typeof module !== 'undefined') module.exports = api;
    else root.LayerPreviews = api;
})(globalThis);
