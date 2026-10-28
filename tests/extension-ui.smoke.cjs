// Optional browser smoke test, with mocked Chrome APIs and queue responses.
// npm --prefix api install --no-save --package-lock=false playwright-core
// CHROME_PATH=/path/to/chromium node tests/extension-ui.smoke.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const requireFromApi = createRequire(path.join(__dirname, '../api/package.json'));
const { chromium } = requireFromApi('playwright-core');
const dir = path.join(__dirname, '../extension');
const chromePath = process.env.CHROME_PATH;
if (!chromePath) throw new Error('Set CHROME_PATH to a Chromium executable.');

function installMock(mode) {
  const playlist = 'PL1234567890';
  const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', C = 'CCCCCCCCCCC';
  const video = { videoId: A, url: `https://www.youtube.com/watch?v=${A}`, title:'Current lesson', channel:'Test channel', durationSeconds:120, currentTime:15, thumbnail:'' };
  const data = {
    s1: { series: { id:'s1',title:'Linked course',playlist:{id:playlist,autoSync:true,lastSyncedAt:'2026-01-01T00:00:00Z',lastError:null} }, videos:[
      {id:'v1',youtubeId:A,title:'Current lesson',status:'watching',durationSeconds:120,resumeSeconds:30},
      {id:'v2',youtubeId:B,title:'Completed',status:'done',durationSeconds:60,resumeSeconds:0},
      {id:'v3',youtubeId:C,title:'Unknown duration',status:'todo',durationSeconds:null,resumeSeconds:0},
    ]}
  };
  const store = { apiBaseUrl:'https://api.workers.dev', token:'tok', lastSeriesId:'s1', settings:{showPill:true,recordResume:true} };
  const calls = [];
  const events = [];
  const list = () => Object.values(data).map(({series,videos})=>({ id:series.id,title:series.title,playlistId:series.playlist?.id||null,total:videos.length,done:videos.filter(v=>v.status==='done').length }));
  const updateStore = (patch) => {
    const changes = {};
    for (const [key,val] of Object.entries(patch)) { changes[key]={oldValue:store[key],newValue:val}; if (val===undefined) delete store[key]; else store[key]=val; }
    for(const fn of events) fn(changes,'local');
  };
  function respond(msg) {
    calls.push(JSON.parse(JSON.stringify(msg)));
    switch(msg.type) {
      case 'state': return {ok:true,apiBaseUrl:store.apiBaseUrl,hasToken:!!store.token,lastSeriesId:store.lastSeriesId,settings:store.settings};
      case 'setConfig': updateStore(msg.patch); return {ok:true,lastSeriesId:store.lastSeriesId,settings:store.settings};
      case 'series': return {ok:true,series:list()};
      case 'seriesVideos': return data[msg.seriesId] ? {ok:true,...JSON.parse(JSON.stringify(data[msg.seriesId]))} : {ok:false,error:'Not found'};
      case 'findVideo': {
        const matches=[]; for(const {series,videos} of Object.values(data)) for(const v of videos) if(v.youtubeId===msg.youtubeId) matches.push({seriesId:series.id,seriesTitle:series.title,video:{...v}});
        return {ok:true,found:!!matches.length,matches};
      }
      case 'patchVideo': {
        const v=Object.values(data).flatMap(d=>d.videos).find(v=>v.id===msg.videoId);
        if(!v) return {ok:false,error:'Not found'};
        if(msg.status) v.status=msg.status;
        if(typeof msg.resumeSeconds==='number') v.resumeSeconds=msg.resumeSeconds;
        if(msg.durationSeconds && !v.durationSeconds) v.durationSeconds=msg.durationSeconds;
        return {ok:true};
      }
      case 'refreshPlaylist': {
        const target=data[msg.seriesId];
        const added=target.videos.some(v=>v.id==='v4')?0:1;
        if(added) target.videos.push({id:'v4',youtubeId:'DDDDDDDDDDD',title:'New lesson',status:'todo',durationSeconds:300,resumeSeconds:0});
        return {ok:true,added};
      }
      case 'setAutoSync': data[msg.seriesId].series.playlist.autoSync=msg.enabled; return {ok:true};
      case 'importPlaylist':
        data.s2={series:{id:'s2',title:msg.title||'Imported course',playlist:{id:playlist,autoSync:msg.autoSync,lastSyncedAt:'2026-01-02T00:00:00Z'}},videos:[{id:'n1',youtubeId:B,title:'Imported video',status:'todo',durationSeconds:60,resumeSeconds:0}]};
        updateStore({lastSeriesId:'s2'}); return {ok:true,id:'s2',added:1,unavailable:1};
      case 'save': data[msg.seriesId].videos.push({id:'saved',youtubeId:A,title:'Current lesson',status:'watching',durationSeconds:120,resumeSeconds:15}); return {ok:true,seriesTitle:data[msg.seriesId].series.title};
      case 'saveMany': return {ok:true,added:msg.urls.length,duplicates:0,skipped:0};
      case 'createSeries': data.s3={series:{id:'s3',title:msg.title,playlist:null},videos:[]}; return {ok:true,id:'s3'};
      default: return {ok:false,error:'unexpected mock '+msg.type};
    }
  }
  window.__mock={calls,store,data}; window.confirm=()=>true;
  window.chrome = {
    runtime: {lastError:null, sendMessage(msg,callback){ const res=respond(msg); if(callback) queueMicrotask(()=>callback(res)); else return Promise.resolve(res); },onMessage:{addListener(){}},openOptionsPage(){}},
    tabs: {async query(){return [{id:7,url:mode==='playlist' ? `https://www.youtube.com/playlist?list=${playlist}` : `https://www.youtube.com/watch?v=${A}&list=${playlist}`}];},async sendMessage(){return video;}, create(){}},
    permissions: {async request(value){calls.push({type:'permission',...value});return true;}},
    storage:{local:{async get(keys){const out={}; for(const k of (Array.isArray(keys)?keys:[keys])) if(k in store) out[k]=store[k]; return out;},async set(obj){updateStore(obj);},async remove(keys){const p={};for(const k of (Array.isArray(keys)?keys:[keys]))p[k]=undefined;updateStore(p);}},onChanged:{addListener(fn){events.push(fn);}}}
  };
}

async function main(){
  const browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--no-sandbox','--disable-gpu']});
  const errors=[];
  const newPage=async(mode)=>{ const page=await browser.newPage({viewport:{width:380,height:850}});page.on('pageerror',e=>errors.push(e.message)); await page.addInitScript(installMock,mode);return page; };
  try{
    const popup=await newPage('watch');
    await popup.goto('file://'+path.join(dir,'popup.html'));
    await popup.waitForFunction(()=>document.querySelector('#progressLabel').textContent.includes('1 / 3'));
    assert.equal(await popup.locator('#progressPercent').innerText(),'33%');
    assert.equal(await popup.locator('#remainingTime').innerText(),'Remaining: 1m 30s');
    assert.match(await popup.locator('#durationCoverage').innerText(),/2 of 3 durations known/);
    assert.equal(await popup.locator('#queuedActions').isVisible(),true);
    assert.equal(await popup.locator('#playlistCard').isVisible(),true);
    await popup.locator('#savePosition').click();
    await popup.waitForFunction(()=>document.querySelector('#msg').textContent.includes('Position saved'));
    assert.equal(await popup.evaluate(()=>window.__mock.data.s1.videos[0].resumeSeconds),15);
    await popup.locator('#autoSync').uncheck();
    await popup.waitForFunction(()=>document.querySelector('#msg').textContent.includes('paused'));
    assert.equal(await popup.evaluate(()=>window.__mock.data.s1.series.playlist.autoSync),false);
    await popup.locator('#refreshPlaylist').click();
    await popup.waitForFunction(()=>document.querySelector('#progressLabel').textContent.includes('1 / 4'));
    await popup.locator('#restorePlaylist').click();
    await popup.waitForFunction(()=>window.__mock.calls.some(x=>x.type==='refreshPlaylist'&&x.restoreRemoved));
    await popup.locator('#playlistTitle').fill('Imported course');
    await popup.locator('#importPlaylist').click();
    await popup.waitForFunction(()=>document.querySelector('#playlistMsg').textContent.includes('Imported 1 videos'));
    assert.equal(await popup.locator('#series').inputValue(),'s2');
    await popup.locator('#save').click();
    await popup.waitForFunction(()=>document.querySelector('#msg').textContent.includes('Saved to'));
    assert.equal(await popup.locator('#save').innerText(),'Already in this series');
    console.log('PASS popup: selected-series insights, position, auto-sync, refresh/restore, playlist import and save');
    await popup.close();

    const playlistOnly=await newPage('playlist');
    await playlistOnly.goto('file://'+path.join(dir,'popup.html'));
    await playlistOnly.waitForFunction(()=>document.querySelector('#playlistCard').hidden===false);
    assert.equal(await playlistOnly.locator('#saveCard').isVisible(),false);
    assert.equal(await playlistOnly.locator('#noVideo').isVisible(),false);
    await playlistOnly.locator('#importPlaylist').click();
    await playlistOnly.waitForFunction(()=>document.querySelector('#playlistMsg').textContent.includes('Imported'));
    console.log('PASS popup: playlist-only tab import');
    await playlistOnly.close();

    const options=await newPage('watch');
    await options.goto('file://'+path.join(dir,'options.html'));
    await options.waitForFunction(()=>document.querySelector('#apiUrl').value.includes('workers.dev'));
    await options.locator('#apiUrl').fill('https://custom.example/api');
    await options.locator('#saveConn').click();
    await options.waitForFunction(()=>document.querySelector('#testResult').textContent==='Saved.');
    assert.deepEqual(await options.evaluate(()=>window.__mock.calls.find(x=>x.type==='permission').origins),['https://custom.example/*']);
    assert.equal(await options.evaluate(()=>window.__mock.store.apiBaseUrl),'https://custom.example/api');
    await options.locator('#apiUrl').fill('http://untrusted.example');
    await options.locator('#saveConn').click();
    assert.match(await options.locator('#testResult').innerText(),/HTTPS/);
    console.log('PASS settings: custom-host permission and insecure URL rejection');
    await options.close();

    const page=await newPage('watch'); await page.setViewportSize({width:1024,height:768});
    await page.route('https://www.youtube.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><html><head><title>Current lesson - YouTube</title></head><body><video></video><h1 class="ytd-watch-metadata"><yt-formatted-string>Current lesson</yt-formatted-string></h1><div id="owner"><div id="channel-name"><a>Test channel</a></div></div><ytd-playlist-panel-renderer id="playlist"><ytd-playlist-panel-video-renderer><a id="wc-endpoint" href="/watch?v=AAAAAAAAAAA">one</a></ytd-playlist-panel-video-renderer><ytd-playlist-panel-video-renderer><a id="wc-endpoint" href="/watch?v=BBBBBBBBBBB">two</a></ytd-playlist-panel-video-renderer></ytd-playlist-panel-renderer></body></html>`}));
    await page.goto('https://www.youtube.com/watch?v=AAAAAAAAAAA&list=PL1234567890');
    await page.evaluate(()=>{const v=document.querySelector('video');Object.defineProperty(v,'duration',{value:120});Object.defineProperty(v,'currentTime',{value:15,writable:true});});
    await page.addScriptTag({path:path.join(dir,'shared.js')});
    await page.addScriptTag({path:path.join(dir,'content-youtube.js')});
    const root=page.locator('#ytq-save-root');
    await root.locator('.pill').click();
    await page.waitForFunction(()=>document.querySelector('#ytq-save-root').shadowRoot.querySelector('.progress-label').textContent.includes('1/3'));
    assert.equal(await root.locator('.panel').getAttribute('data-open'),'1');
    assert.match(await root.locator('.time-remaining').innerText(),/1m 30s/);
    assert.equal(await root.locator('.save').innerText(),'Already in this series');
    await root.locator('.save-position').click();
    await page.waitForFunction(()=>document.querySelector('#ytq-save-root').shadowRoot.querySelector('.msg').textContent.includes('Position saved'));
    assert.equal(await page.evaluate(()=>window.__mock.data.s1.videos[0].resumeSeconds),15);
    await root.locator('.auto-sync').uncheck();
    await page.waitForFunction(()=>window.__mock.data.s1.series.playlist.autoSync===false);
    await root.locator('.refresh-playlist').click();
    await page.waitForFunction(()=>document.querySelector('#ytq-save-root').shadowRoot.querySelector('.progress-label').textContent.includes('1/4'));
    const box=await root.locator('.pill').boundingBox();
    await page.mouse.move(box.x+45,box.y+15);await page.mouse.down();await page.mouse.move(box.x-140,box.y-140,{steps:6});await page.mouse.up();
    assert.notEqual(await root.locator('.pill').evaluate(e=>e.style.left),'auto');
    await page.evaluate(()=>chrome.storage.local.remove(['pillPos','panelPos']));
    await page.waitForFunction(()=>document.querySelector('#ytq-save-root').shadowRoot.querySelector('.pill').style.left==='auto');
    await page.evaluate(()=>{history.pushState({},'', '/playlist?list=PL1234567890');window.dispatchEvent(new Event('yt-navigate-finish'));});
    await root.locator('.pill').click();
    await page.waitForFunction(()=>document.querySelector('#ytq-save-root').shadowRoot.querySelector('.panel').dataset.open==='1');
    assert.equal(await root.locator('.video-meta').isVisible(),false);
    assert.equal(await root.locator('.playlist-tools').isVisible(),true);
    assert.match(await root.locator('.playlist').innerText(),/2 visible/);
    assert.equal(await root.locator('.queued').evaluate(e=>getComputedStyle(e).display),'none');
    await root.locator('.import-playlist').click();
    await page.waitForFunction(()=>document.querySelector('#ytq-save-root').shadowRoot.querySelector('.msg').textContent.includes('Imported'));
    console.log('PASS YouTube panel: opens, queued state, insights, progress, refresh, drag reset and playlist-page import');
    await page.close();
    assert.deepEqual(errors,[]);
    console.log('No browser page errors.');
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
