const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const symbols=require('../js/symbol-library.js');
(async()=>{
    assert.equal(symbols.safeURL('javascript:alert(1)'),null);
    assert.equal(symbols.safeURL('http://example.com/a.png'),null);
    assert.equal(symbols.safeURL('https://user:secret@example.com/a.png'),null);
    const normalized=symbols.normalize('mulberry',[
        {text:'Cat',picto:{id:1,image_url:'https://globalsymbols.com/cat.svg'}},
        {text:'Cat duplicate',picto:{id:1,image_url:'https://globalsymbols.com/cat.svg'}},
        {text:'Unsafe',picto:{id:2,image_url:'javascript:alert(1)'}},
        {text:'No image',picto:{id:3}}
    ],'cat');
    assert.equal(normalized.length,1);
    assert.equal(Object.keys(symbols.skinTones).length,6);
    for(const tone of ['light','medlight','medium','meddark','dark']) {
        const pixels=new Uint8ClampedArray([247,231,224,255,0,0,0,255,247,231,224,0]);
        assert.equal(symbols.recolorSkin(pixels,tone),true);
        assert.deepEqual([...pixels.slice(0,3)],symbols.skinTones[tone].rgb);
        assert.deepEqual([...pixels.slice(4)],[0,0,0,255,247,231,224,0],'outlines and transparent pixels stay unchanged');
    }
    assert.equal(symbols.recolorSkin(new Uint8ClampedArray([247,231,224,255]),'none'),false);
    assert.equal(symbols.supportsTone({source:'jellow'},'dark'),false);
    assert.equal(symbols.supportsTone({source:'picom'},'dark'),false);
    assert.equal(symbols.supportsTone({source:'mulberry',adaptable:false},'dark'),false);
    assert.equal(symbols.supportsTone({source:'mulberry',adaptable:true},'dark'),true);
    assert.equal(symbols.normalize('arasaac',[{_id:'../bad'},{_id:123,keywords:[{keyword:'Cat'}]}],'cat').length,1);
    const requests=[];
    const fetcher=async url=>{
        requests.push(url);
        if(url.includes('symbolset=jellow')) return {ok:false,status:503};
        if(url.includes('openmoji.json'))return {ok:true,json:async()=>[
            {hexcode:'1F408',annotation:'cat',group:'animals-nature',skintone:''},
            {hexcode:'1F44B',annotation:'waving hand',group:'people-body',skintone:''},
            {hexcode:'1F44B-1F3FB',annotation:'waving hand light',group:'people-body',skintone:'1',skintone_base_hexcode:'1F44B'},
            {hexcode:'bad/url',annotation:'cat',group:'animals-nature',skintone:''}
        ]};
        if(url.includes('arasaac'))return {ok:true,json:async()=>[{_id:123,keywords:[{keyword:'cat'}]}]};
        return {ok:true,json:async()=>[{text:'Cat',picto:{id:1,image_url:'https://globalsymbols.com/cat.svg'}}]};
    };
    const client=symbols.createClient(fetcher);
    const found=await client.search('all','cat',new AbortController().signal);
    assert.equal(found.results.length,4);assert.deepEqual(found.failed,['Jellow']);
    assert.equal(new Set(found.results.map(item=>item.source)).size,4);
    await client.search('openmoji','cat',new AbortController().signal);
    assert.equal(requests.filter(url=>url.includes('openmoji.json')).length,1,'emoji catalogue is cached');
    const waving=await client.search('openmoji','waving',new AbortController().signal);
    assert.equal(waving.results.length,1);
    assert.equal(waving.results[0].variants['1'],'1F44B-1F3FB');
    await client.search('arasaac','cat & dog',new AbortController().signal);
    assert.ok(requests.at(-1).endsWith('cat%20%26%20dog'));
    const aborted=new AbortController();aborted.abort();
    await assert.rejects(client.search('all','cat',aborted.signal),{name:'AbortError'});
    const down=await symbols.createClient(async()=>{throw new Error('offline');}).search('all','cat',new AbortController().signal);
    assert.equal(down.results.length,0);assert.equal(down.failed.length,5);
    assert.match(symbols.credit(found.results[0]),/Original image:/);
    assert.match(symbols.credit(normalized[0]),/CC BY-SA 4.0/);

    // Verify real persistent-library code stores credits on import, reload and duplicates.
    const records=new Map();
    const store={put(record){records.set(record.id,structuredClone(record));},getAll(){return [...records.values()];}};
    const sandbox={window:{},Blob,URL:{createObjectURL:()=> 'blob:test'},crypto:{randomUUID:()=> 'test-id'},
        MediaStore:{categories:['visualTargets'],transaction:async(mode,fn)=>fn(store),thumbnail:async()=>null,fingerprint:async()=> 'hash'},
        document:{createElement:()=>({dataset:{},removeAttribute(){}})}};
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../js/media-library.js'),'utf8'),sandbox);
    const make=()=>sandbox.window.createMediaLibrary({changed(){},status(){},error(error){throw error;}});
    const library=make();await library.ready;
    const image={tagName:'IMG',dataset:{name:'Cat.png'},src:'blob:cat',removeAttribute(){}};
    const blob=new Blob(['png'],{type:'image/png'}),credit=symbols.credit(normalized[0]);
    const first=await library.add('visualTargets',image,{blob,hash:'hash',symbolCredit:credit});
    assert.equal(first.el.dataset.symbolCredit,credit);
    const reload=make();await reload.ready;
    assert.equal(reload.assets.visualTargets[0].dataset.symbolCredit,credit);
    const duplicate=await reload.add('visualTargets',image,{blob,hash:'hash',symbolCredit:'Second source'});
    assert.equal(duplicate.duplicate,true);assert.equal(reload.assets.visualTargets.length,1);
    assert.match(records.get('test-id').symbolCredit,/Second source/);

    // Imports rasterize remote SVGs into self-contained PNG files before storage.
    const original={fetch:global.fetch,Image:global.Image,document:global.document};
    let drawn=0;
    global.fetch=async()=>({ok:true,blob:async()=>new Blob(['<svg/>'],{type:'image/svg+xml'})});
    global.Image=class {constructor(){this.naturalWidth=200;this.naturalHeight=100;}set src(value){if(value)queueMicrotask(()=>this.onload());}};
    global.document={createElement(){return {getContext:()=>({drawImage(){drawn++;}}),toBlob(callback){callback(new Blob(['png'],{type:'image/png'}));}};}};
    try {
        const file=await symbols.download(normalized[0]);
        assert.equal(file.type,'image/png');assert.match(file.name,/Mulberry/);assert.match(file.name,/\.png$/);
        assert.equal(file.symbolCredit,credit);assert.equal(drawn,1);
        let requestedURL='';
        global.fetch=async url=>{requestedURL=url;return {ok:true,blob:async()=>new Blob(['<svg/>'],{type:'image/svg+xml'})};};
        const emoji=await symbols.download(waving.results[0],'light');
        assert.match(requestedURL,/1F44B-1F3FB\.svg$/);assert.match(emoji.name,/Light\.png$/);
        assert.match(emoji.symbolCredit,/OpenMoji variant/);
        let outputPixels;
        global.document={createElement(){return {getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray([247,231,224,255])}),putImageData(pixels){outputPixels=pixels.data;}}),toBlob(cb){cb(new Blob(['png'],{type:'image/png'}));}};}};
        const pictogram=await symbols.download({source:'arasaac',id:'1',label:'Person',url:'https://static.arasaac.org/1.png'},'dark');
        assert.deepEqual([...outputPixels],[90,68,62,255]);assert.match(pictogram.symbolCredit,/Dark \(adapted\)/);
        const originalCreateURL=URL.createObjectURL;
        let imageBlob;
        URL.createObjectURL=blob=>{imageBlob=blob;return originalCreateURL(blob);};
        try {
            global.fetch=async()=>({ok:true,blob:async()=>new Blob(['<svg><path fill="#FFEEC8"/><path fill="#000000"/></svg>'],{type:'image/svg+xml'})});
            const mulberry=await symbols.download({...normalized[0],adaptable:true},'medium');
            assert.match(await imageBlob.text(),/#c07848/);assert.match(await imageBlob.text(),/#000000/);
            assert.match(mulberry.symbolCredit,/Medium \(adapted\)/);
        } finally {URL.createObjectURL=originalCreateURL;}
        global.fetch=async()=>({ok:false,status:503});
        await assert.rejects(symbols.download(normalized[0]),/could not be downloaded/);
        global.fetch=async()=>({ok:true,blob:async()=>new Blob(['error'],{type:'text/html'})});
        await assert.rejects(symbols.download(normalized[0]),/did not return an image/);
    } finally {Object.assign(global,original);}
    console.log('Symbol providers, encoding, deduplication, partial outages, cancellation, cached catalogue, and persistent attribution checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
