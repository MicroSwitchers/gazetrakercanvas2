/* Public symbol sources used by the companion AAC app. No account or API key. */
(function(root) {
    const CDN='https://cdn.jsdelivr.net/npm/openmoji@15.0.0';
    const skinTones={
        none:{label:'None selected',color:'#d2d8e2'},
        light:{label:'Light',color:'#f7dece',rgb:[247,222,206],mulberry:'#fde8d4',emoji:'1'},
        medlight:{label:'Medium light',color:'#d29e64',rgb:[210,158,100],mulberry:'#daa56e',emoji:'2'},
        medium:{label:'Medium',color:'#b77841',rgb:[183,120,65],mulberry:'#c07848',emoji:'3'},
        meddark:{label:'Medium dark',color:'#985f34',rgb:[152,95,52],mulberry:'#a06030',emoji:'4'},
        dark:{label:'Dark',color:'#5a443e',rgb:[90,68,62],mulberry:'#6b3828',emoji:'5'}
    };
    function supportsTone(item,tone) {
        if(!skinTones[tone]?.rgb)return false;
        return item.source==='arasaac' || (item.source==='mulberry' && item.adaptable) ||
            (item.source==='openmoji' && !!item.variants?.[skinTones[tone].emoji]);
    }
    function recolorSkin(data,tone) {
        const target=skinTones[tone]?.rgb;if(!target)return false;
        let changed=false;
        for(let i=0;i<data.length;i+=4) {
            if(data[i+3]>=10 && Math.abs(data[i]-247)<=15 && Math.abs(data[i+1]-231)<=15 && Math.abs(data[i+2]-224)<=15) {
                [data[i],data[i+1],data[i+2]]=target;changed=true;
            }
        }
        return changed;
    }
    const providers={
        arasaac:{name:'ARASAAC',author:'Sergio Palao / Government of Aragon',license:'CC BY-NC-SA 4.0',url:'https://arasaac.org',terms:'https://creativecommons.org/licenses/by-nc-sa/4.0/'},
        mulberry:{name:'Mulberry',author:'Mulberry Symbols / Steve Lee',license:'CC BY-SA 4.0',url:'https://globalsymbols.com/symbolsets/mulberry',terms:'https://creativecommons.org/licenses/by-sa/4.0/',set:'mulberry'},
        jellow:{name:'Jellow',author:'IDC School of Design',license:'CC BY-NC-SA 4.0',url:'https://globalsymbols.com/symbolsets/jellow',terms:'https://creativecommons.org/licenses/by-nc-sa/4.0/',set:'jellow'},
        openmoji:{name:'OpenMoji',author:'OpenMoji contributors',license:'CC BY-SA 4.0',url:'https://openmoji.org',terms:'https://creativecommons.org/licenses/by-sa/4.0/'},
        picom:{name:'PiCom',author:'Sensory App House with Global Symbols',license:'CC BY-SA 4.0',url:'https://globalsymbols.com/symbolsets/ai-realistic-symbols-a-picom-collection',terms:'https://creativecommons.org/licenses/by-sa/4.0/',set:'ai-realistic-symbols-a-picom-collection'}
    };
    function safeURL(value) {try {const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password ? url.href : null;} catch {return null;}}
    async function json(url,signal,fetcher) {
        const response=await fetcher(url,{signal,credentials:'omit',referrerPolicy:'no-referrer'});
        if (!response.ok) throw new Error(`Service returned ${response.status}`);
        const data=await response.json();
        if (!Array.isArray(data)) throw new Error('Unexpected search response');
        return data;
    }
    function normalize(source,data,query) {
        const seen=new Set();
        return data.map(item=>{
            if (source==='arasaac') {
                if (!/^\d+$/.test(String(item._id))) return null;
                return {source,id:String(item._id),label:item.keywords?.find(k=>k.keyword)?.keyword || query,url:`https://static.arasaac.org/pictograms/${item._id}/${item._id}_500.png`};
            }
            return {source,id:String(item.picto?.id || item.id || ''),label:item.text || query,url:safeURL(item.picto?.image_url),adaptable:item.picto?.adaptable===true || item.picto?.adaptable==='true'};
        }).filter(item=>{
            if (!item?.url || !item.id || seen.has(item.id)) return false;
            seen.add(item.id);item.label=String(item.label).slice(0,160);return true;
        }).slice(0,48);
    }
    function createClient(fetcher=root.fetch.bind(root)) {
        let emojiData=null;
        async function searchOne(source,query,signal) {
            if (source==='openmoji') {
                if (!emojiData) emojiData=await json(`${CDN}/data/openmoji.json`,signal,fetcher);
                const q=query.toLowerCase();
                return emojiData.filter(item=>!item.skintone && !String(item.group).startsWith('extras-') && /^[0-9A-F-]+$/i.test(item.hexcode) &&
                    [item.annotation,item.tags,item.openmoji_tags].some(text=>String(text || '').toLowerCase().includes(q)))
                    .slice(0,48).map(item=>({source,id:item.hexcode,label:item.annotation,url:`${CDN}/color/svg/${item.hexcode}.svg`,
                        variants:Object.fromEntries(emojiData.filter(v=>v.skintone_base_hexcode===item.hexcode && /^[0-9A-F-]+$/i.test(v.hexcode)).map(v=>[String(v.skintone),v.hexcode]))}));
            }
            const url=source==='arasaac' ? `https://api.arasaac.org/api/pictograms/en/search/${encodeURIComponent(query)}` :
                `https://globalsymbols.com/api/v1/labels/search?${new URLSearchParams({query,symbolset:providers[source].set,language:'en',language_iso_format:'639-1',limit:'48'})}`;
            return normalize(source,await json(url,signal,fetcher),query);
        }
        async function search(source,query,signal) {
            const keys=source==='all'?Object.keys(providers):[source];
            const groups=await Promise.allSettled(keys.map(async key=>{
                const request=new AbortController(),cancel=()=>request.abort();
                signal?.addEventListener('abort',cancel,{once:true});
                if(signal?.aborted)cancel();
                const timeout=setTimeout(cancel,12000);
                try {return await searchOne(key,query,request.signal);}
                finally {clearTimeout(timeout);signal?.removeEventListener('abort',cancel);}
            }));
            if (signal?.aborted) throw new DOMException('Search cancelled','AbortError');
            const results=[],failed=[];
            groups.forEach((group,i)=>{if(group.status==='fulfilled') results.push(...group.value);else failed.push(providers[keys[i]].name);});
            // Interleave sources so the first page shows the range of symbol styles.
            results.sort((a,b)=>groups[keys.indexOf(a.source)].value.indexOf(a)-groups[keys.indexOf(b.source)].value.indexOf(b));
            return {results,failed};
        }
        return {search};
    }
    function credit(item,tone='none',changed=false) {const p=providers[item.source];return `${item.label} — ${p.name}\n${p.author}\n${p.url}\n${p.license}: ${p.terms}\nOriginal image: ${item.url}\nImported as PNG; ${changed?`skin colour: ${skinTones[tone].label}${item.source==='openmoji'?' (OpenMoji variant)':' (adapted)'}`:'appearance unchanged'}.`;}
    async function download(item,tone='none') {
        const adaptable=supportsTone(item,tone);
        const imageURL=adaptable && item.source==='openmoji' ? `${CDN}/color/svg/${item.variants[skinTones[tone].emoji]}.svg` : item.url;
        const response=await fetch(imageURL,{signal:(AbortSignal.timeout?AbortSignal.timeout(20000):(c=>(setTimeout(()=>c.abort(),20000),c.signal))(new AbortController())),credentials:'omit',referrerPolicy:'no-referrer'});
        if (!response.ok) throw new Error('The symbol could not be downloaded. Please try again.');
        let blob=await response.blob(),changed=adaptable && item.source==='openmoji';
        if (blob.size>10*1024*1024) throw new Error('This symbol is too large to import.');
        if (!/^image\//.test(blob.type)) throw new Error('The provider did not return an image.');
        if(adaptable && item.source==='mulberry' && blob.type.includes('svg')) {
            const svg=await blob.text();
            changed=/#ffeec8\b/i.test(svg);
            blob=new Blob([svg.replace(/#ffeec8\b/gi,skinTones[tone].mulberry)],{type:'image/svg+xml'});
        }
        const url=URL.createObjectURL(blob),img=new Image();
        try {
            await new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>{img.src='';reject(new Error('The symbol took too long to open.'));},15000);
                img.onload=()=>{clearTimeout(timer);resolve();};img.onerror=()=>{clearTimeout(timer);reject(new Error('This symbol could not be opened.'));};img.src=url;
            });
            const scale=Math.min(1,1024/Math.max(img.naturalWidth,img.naturalHeight));
            const canvas=document.createElement('canvas');
            canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
            const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,canvas.width,canvas.height);
            if(adaptable && item.source==='arasaac') {
                const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
                changed=recolorSkin(pixels.data,tone);ctx.putImageData(pixels,0,0);
            }
            const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
            if (!png) throw new Error('This symbol could not be converted to an image.');
            const name=`${item.label.replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').trim().slice(0,80) || 'Symbol'} — ${providers[item.source].name} ${item.id}.png`;
            const file=new File([png],changed?name.replace(/\.png$/,` — ${skinTones[tone].label}.png`):name,{type:'image/png'});
            file.symbolCredit=credit({...item,url:imageURL},tone,changed);return file;
        } finally {URL.revokeObjectURL(url);}
    }
    function mount({container,importFiles,addToCanvas,canImport,getCredits}) {
        const find=id=>container.querySelector('#'+id),client=createClient();
        const form=find('symbol-search-form'),query=find('symbol-query'),source=find('symbol-source'),status=find('symbol-status'),results=find('symbol-results');
        const more=find('symbol-more');
        const sourceTabs=find('symbol-source-tabs');
        if(sourceTabs)for(const option of source.options){
            const button=document.createElement('button');button.type='button';button.dataset.symbolSource=option.value;
            button.textContent=option.value==='all'?'All libraries':providers[option.value].name;
            button.setAttribute('aria-pressed',String(option.value===source.value));
            button.onclick=()=>{source.value=option.value;source.dispatchEvent(new Event('change'));};sourceTabs.append(button);
        }
        let generation=0,controller=null,items=[],shown=0,debounce=null;
        let tone='none',revision=0,running=0;
        const previewURLs=[],jobs=[];
        const selected=new Map();
        let busy=false;
        const selectionCount=find('symbol-selection-count'),saveButton=find('symbol-save'),addButton=find('symbol-add'),clearButton=find('symbol-clear');
        function updateSelection() {
            selectionCount.textContent=`${selected.size} selected`;
            saveButton.disabled=clearButton.disabled=busy || !selected.size;
            if(addButton)addButton.disabled=busy || !selected.size;
            saveButton.textContent=busy?'Importing symbols...':selected.size?`Import ${selected.size} symbol${selected.size===1?'':'s'}`:'Import symbols';
            container.querySelectorAll('[data-close-symbols]').forEach(button=>button.disabled=busy);
            sourceTabs?.querySelectorAll('button').forEach(button=>button.disabled=busy);
            const tray=find('symbol-selected-items');tray.replaceChildren();
            for(const [key,entry] of selected) {
                const remove=document.createElement('button');remove.type='button';remove.disabled=busy;
                remove.textContent=entry.item.label+' ×';remove.title=`Remove ${entry.item.label} · ${providers[entry.item.source].name} · ${skinTones[entry.tone].label}`;
                remove.setAttribute('aria-label',remove.title);
                remove.onclick=()=>{selected.delete(key);updateSelection();};tray.appendChild(remove);
            }
            results.querySelectorAll('.symbol-result').forEach(button=>{
                const checkbox=button.querySelector('input');
                checkbox.checked=selected.has(button.dataset.key);
                checkbox.disabled=busy || button.dataset.preparing==='true';
            });
        }
        clearButton.onclick=()=>{selected.clear();updateSelection();};
        async function importSelection(toCanvas) {
            if(busy || !selected.size)return;
            if(!canImport()){status.textContent='Switch to Edit mode to add symbols.';return;}
            busy=true;updateSelection();
            const category='visualTargets';
            const batch=[...selected.entries()],failures=[],ready=[];
            let cursor=0,complete=0;
            try {
                await Promise.all(Array.from({length:Math.min(3,batch.length)},async()=>{
                    while(cursor<batch.length) {
                        const index=cursor++, [key,entry]=batch[index];
                        try {
                            entry.file ||= await entry.prepare();
                            ready.push({key,file:entry.file,index});
                        } catch {failures.push(entry.item.label);}
                        status.textContent=`Preparing ${++complete} of ${batch.length} symbols?`;
                    }
                }));
                ready.sort((a,b)=>a.index-b.index);
                if(!canImport()){status.textContent='Switch to Edit mode and retry. Your selection is kept.';return;}
                const outcome=ready.length?await importFiles(ready.map(entry=>entry.file),category):null;
                const imported=[...new Set(outcome?.imported || [])];
                const fullySaved=outcome && outcome.added+outcome.duplicates===ready.length;
                let added=false;
                if(toCanvas && imported.length && fullySaved)added=await addToCanvas(imported);
                if(fullySaved && (!toCanvas || added))ready.forEach(entry=>selected.delete(entry.key));
                status.textContent=`${imported.length} saved to ${category==='visualTargets'?'Targets':category}. `+
                    (toCanvas?(added?'Added to canvas. Undo removes this batch. ':'Not added to canvas; your selection is kept so you can retry. '):'')+
                    (failures.length?`${failures.length} downloads failed: ${failures.slice(0,3).join(', ')}. These remain selected; try again. `:'')+
                    (outcome && !fullySaved?'Some files were not saved. Your selection is kept; retry to save the remaining files.':'');
            } catch(error) {status.textContent='Could not finish. Your selection is kept; please try again.';
            } finally {busy=false;updateSelection();}
        }
        saveButton.onclick=()=>importSelection(false);if(addButton)addButton.onclick=()=>importSelection(true);
        container.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
        try {const saved=localStorage.getItem('symbolSkinTone');if(Object.hasOwn(skinTones,saved))tone=saved;}catch{}
        function queuePreview(job) {return new Promise((resolve,reject)=>{jobs.push({job,resolve,reject});pump();});}
        function pump() {
            while(running<3 && jobs.length) {
                const task=jobs.shift();running++;
                Promise.resolve().then(task.job).then(task.resolve,task.reject).finally(()=>{running--;pump();});
            }
        }
        function clearPreviews() {revision++;previewURLs.splice(0).forEach(url=>URL.revokeObjectURL(url));results.replaceChildren();}
        const skinControls=find('symbol-skin-tones'),skinName=find('symbol-skin-name');
        skinName.textContent=skinTones[tone].label;
        for(const [value,skin] of Object.entries(skinTones)) {
            const button=document.createElement('button');button.type='button';button.className='symbol-skin-tone';button.dataset.tone=value;
            button.style.setProperty('--skin-color',skin.color);button.title=skin.label;button.setAttribute('aria-label',skin.label+' skin colour');
            button.setAttribute('aria-pressed',String(value===tone));
            button.addEventListener('click',()=>{
                tone=value;skinName.textContent=skinTones[tone].label;try{localStorage.setItem('symbolSkinTone',tone);}catch{}
                skinControls.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tone===tone)));
                const count=shown;clearPreviews();shown=0;while(shown<count)renderMore();
            });skinControls.appendChild(button);
        }
        function renderMore() {
            const end=Math.min(shown+24,items.length);
            for (;shown<end;shown++) {
                const item=items[shown],key=item.source+':'+item.id+':'+tone;
                const cardTone=tone,cardRevision=revision;
                let prepared=null,preparedFile=null;
                const button=document.createElement('label');button.className='symbol-result';
                const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='library-select symbol-select';
                checkbox.checked=selected.has(key);
                const img=document.createElement('img');img.src=item.url;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';
                img.onerror=()=>{img.hidden=true;button.classList.add('symbol-result--unavailable');};
                const label=document.createElement('span');label.textContent=item.label;
                const detail=document.createElement('small');detail.textContent=providers[item.source].name;
                button.dataset.key=key;
                button.append(checkbox,img,label,detail);button.title=`Select ${item.label} · ${providers[item.source].name}`;
                checkbox.setAttribute('aria-label',button.title);checkbox.disabled=busy;
                if(supportsTone(item,cardTone)) {
                    img.style.visibility='hidden';button.dataset.preparing='true';checkbox.disabled=true;
                    prepared=queuePreview(()=>{
                        if(cardRevision!==revision)throw new Error('Preview replaced');
                        return download(item,cardTone);
                    }).then(file=>{
                        if(cardRevision!==revision)return null;
                        preparedFile=file;const url=URL.createObjectURL(file);previewURLs.push(url);img.hidden=false;img.src=url;img.style.visibility='';
                        button.dataset.preparing='false';checkbox.disabled=busy;return file;
                    }).catch(()=>{
                        if(cardRevision===revision){img.hidden=true;detail.textContent='Preview unavailable';button.dataset.preparing='false';checkbox.disabled=busy;}
                        return null;
                    });
                }
                checkbox.addEventListener('change',()=>{
                    if(busy)return;
                    if(!checkbox.checked)selected.delete(key);
                    else selected.set(key,{item,tone:cardTone,prepare:async()=>preparedFile || (prepared && await prepared) || await download(item,cardTone)});
                    updateSelection();
                });results.appendChild(button);
            }
            more.hidden=shown>=items.length;
        }
        async function search() {
            sourceTabs?.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.symbolSource===source.value)));
            clearTimeout(debounce);controller?.abort();const token=++generation;
            items=[];shown=0;clearPreviews();more.hidden=true;form.removeAttribute('aria-busy');
            const q=query.value.trim().slice(0,100);
            if (q.length<2) {status.textContent='Enter at least two letters, such as cat, eat, or happy.';return;}
            controller=new AbortController();const active=controller;
            const timer=setTimeout(()=>active.abort(),15000);
            form.setAttribute('aria-busy','true');status.textContent='Searching symbol libraries…';
            try {
                const data=await client.search(source.value,q,active.signal);
                if(token!==generation)return;
                items=data.results;renderMore();
                status.textContent=(items.length?`${items.length} symbol${items.length===1?'':'s'}`:'No symbols found. Try another word.')+
                    (data.failed.length?` Unavailable: ${data.failed.join(', ')}. Search again to retry.`:'');
            } catch(error) {
                if(token===generation)status.textContent=active.signal.aborted?'Search timed out. Please try again.':'Could not search. Check your connection and try again.';
            } finally {clearTimeout(timer);if(token===generation)form.removeAttribute('aria-busy');}
        }
        form.addEventListener('submit',event=>{event.preventDefault();search();});
        query.addEventListener('input',()=>{controller?.abort();generation++;clearTimeout(debounce);items=[];shown=0;clearPreviews();more.hidden=true;form.removeAttribute('aria-busy');status.textContent=query.value.trim().length<2?'Enter at least two letters, such as cat, eat, or happy.':'Waiting to search?';debounce=setTimeout(search,400);});
        source.addEventListener('change',search);more.addEventListener('click',renderMore);
        container.addEventListener('close',()=>{if(container.open)return;clearTimeout(debounce);controller?.abort();generation++;form.removeAttribute('aria-busy');});
        const credits=find('symbol-provider-credits');
        for(const p of Object.values(providers)) {
            const li=document.createElement('li'),link=document.createElement('a');link.href=p.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=p.name;
            const terms=document.createElement('a');terms.href=p.terms;terms.target='_blank';terms.rel='noopener noreferrer';terms.textContent=p.license;
            li.append(link,` — ${p.author}. `,terms);credits.append(li);
        }
        container.addEventListener('symbol-import-open',()=>{if(controller?.signal.aborted && query.value.trim().length>=2)search();});
        find('symbol-download-credits').addEventListener('click',()=>{
            const credits=[...new Set(getCredits().filter(Boolean))];
            if(!credits.length){status.textContent='Import a symbol to save its credits.';return;}
            const url=URL.createObjectURL(new Blob([credits.join('\n\n')],{type:'text/plain'}));
            const link=document.createElement('a');link.href=url;link.download='symbol-credits.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        });
    }
    const api={providers,skinTones,supportsTone,recolorSkin,safeURL,normalize,createClient,credit,download,mount};
    if(typeof module!=='undefined')module.exports=api;else root.SymbolLibrary=api;
})(globalThis);
