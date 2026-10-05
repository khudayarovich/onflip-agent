const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const UI_ROOT = path.resolve(__dirname, '../ui-dist');
const APP_VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version;
const output = process.env.ONFLIP_UI_SCREENSHOTS
  ? path.resolve(process.env.ONFLIP_UI_SCREENSHOTS)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'onflip-ui-'));
fs.mkdirSync(output, {recursive:true});

// Serve the production bundle, with no engine, account, or external requests.
const server = http.createServer((req, res) => {
  let target;
  try {
    const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    target = path.resolve(UI_ROOT, '.' + (route === '/' ? '/index.html' : route));
  } catch {res.writeHead(400).end();return;}
  if (!target.startsWith(UI_ROOT + path.sep)) {res.writeHead(403).end();return;}
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'};
  fs.readFile(target, (error, bytes) => {
    if(error){res.writeHead(404).end();return;}
    res.writeHead(200, {'Content-Type':types[path.extname(target)] || 'application/octet-stream'}).end(bytes);
  });
});

// Isolated renderer fixture. These records never enter the app's real store.
function installFixture(version) {
  const subscribers = {};
  const calls = [];
  const listen = (name, fn) => { (subscribers[name] ??= new Set()).add(fn); return () => subscribers[name].delete(fn); };
  const event = (name, data) => subscribers.event?.forEach(fn => fn(name, data));
  const signal = (name, ...args) => subscribers[name]?.forEach(fn => fn(...args));
  const cwd = 'C:\\Projects\\onflip-agent';
  const status = { version, cwd, home: 'C:\\Users\\designer', sessionId: 'fresh', sessionTitle: '', model: 'gpt-6-luna', provider: 'chatgpt', contextChars: 0, contextBudget: 200000, approvalMode: 'ask', approvalModes: ['read-only', 'ask', 'auto-edit', 'full-auto', 'yolo'], shellEnabled: true, networkEnabled: true, maxIterations: 100, transport: 'browser', gitBranch: 'codex/workspace-redesign', gitDirty: true, instructionSources: [], headed: false, busy: false, queued: [], snapshotCount: 0, todoCount: 0, signedIn: true, account: { name: 'Alex Morgan', email: 'alex@example.test' }, usage: {today: 4, week: 24, month: 66, total: 120, since: Date.now()} };
  const sessions = [{ id: 'loom', title: 'Build the next chapter', cwd: 'C:\\Projects\\Loom', model: status.model, updatedAt: Date.now()-3600000, messageCount: 12 }, { id: 'onflip', title: 'A fresh workspace for ideas', cwd, model: status.model, updatedAt: Date.now()-10800000, messageCount: 8 }];
  const projects = sessions.map((s, i) => ({cwd:s.cwd, sessions: i ? 8 : 4, updatedAt:s.updatedAt, exists:true}));
  const models = [{slug:status.model,label:'GPT-6 Luna',description:'Fast and capable'}, {slug:'gpt-6-sol',label:'GPT-6 Sol',description:'A deeper look'}];
  const config = {headed:false,browserHeadless:false,embeddedBrowser:true,subAgents:false,maxIterations:100,replyTimeout:600,compactAfterChars:200000,autoResume:false,rules:[],allowedCommands:[],allowedWriteDirs:[]};
  const diffs = [{path: cwd+'\\src\\App.tsx',rel:'src/App.tsx',added:4,removed:1,lines:[{kind:'ctx',text:'export function App() {',oldLine:1,newLine:1},{kind:'del',text:'  return <main>Welcome</main>;',oldLine:2},{kind:'add',text:'  return (',newLine:2},{kind:'add',text:'    <Workspace>',newLine:3},{kind:'add',text:'      <Conversation />',newLine:4},{kind:'add',text:'    </Workspace>',newLine:5},{kind:'ctx',text:'  );',oldLine:3,newLine:6},{kind:'ctx',text:'}',oldLine:4,newLine:7}]}, {path:cwd+'\\src\\theme.css',rel:'src/theme.css',added:2,removed:1,lines:[{kind:'ctx',text:':root {',oldLine:1,newLine:1},{kind:'del',text:'  --accent: #fa713a;',oldLine:2},{kind:'add',text:'  --accent: #b7f5c1;',newLine:2},{kind:'add',text:'  --surface: #181d20;',newLine:3},{kind:'ctx',text:'}',oldLine:3,newLine:4}]}];
  const history = [{type:'user',id:'u1',text:'Give this workspace a calmer, more modern feel. Keep the essentials close, and let the work take center stage.'}, {type:'assistant',id:'a1',text:'I’m bringing the workspace together with a quieter palette, clear navigation, and a place to review your work.'}, {type:'tool',id:'t1',call:{id:'t1',tool:'edit',subject:'src/App.tsx',args:{}},result:{title:'Updated the workspace layout',output:'Layout updated.',display:{kind:'diff',diff:diffs[0]}}}, {type:'assistant',id:'a2',text:'The new workspace is ready to review.\n\n- A clear space for the conversation\n- Preview, changes, and terminal within reach\n- Consistent colors and focus states\n\nYour project and its history stay connected.'}];
  const activate = () => {status.sessionId='onflip';status.sessionTitle=sessions[1].title;status.snapshotCount=2;event('status',{...status});event('transcript',{items:history});};
  const rpc = async (method, p={}) => {
    calls.push({method, params:p});
    switch(method) {
      case 'init': setTimeout(()=>event('connect',{state:'ready'}),40); return {...status};
      case 'status': return {...status};
      case 'listSessions': return sessions;
      case 'recentProjects': return projects;
      case 'listModels': case 'refreshModels': return models;
      case 'getConfig': return {...config};
      case 'setConfigValue': config[p.key]=p.value; return {...config};
      case 'listSubTasks': return [];
      case 'sessionDiff': return diffs;
      case 'setModel': status.model=p.slug; event('status',{...status}); return {...status};
      case 'setThinking': status.thinking=p.level; return {...status};
      case 'setApproval': status.approvalMode=p.mode; return {...status};
      case 'setShell': status.shellEnabled=p.enabled; return {...status};
      case 'setNetwork': status.networkEnabled=p.enabled; return {...status};
      case 'newSession': status.sessionId='fresh'; status.sessionTitle='';status.snapshotCount=0;event('transcript',{items:[]});event('todos',{items:[]});return {...status};
      case 'resumeSession': case 'openProject': activate(); return {...status};
      case 'send': if(window.__fixture.refuse) throw new Error('Fixture: send refused'); event('item',{type:'user',id:'u-new',text:p.text}); status.busy=true;event('status',{...status}); event('turn',{state:'start'});event('thinking',{iteration:1});return {queued:false};
      case 'interrupt': status.busy=false;event('status',{...status});event('turn',{state:'end',interrupted:true});return null;
      case 'signInBrowserInfo': return {name:'Google Chrome',channel:'chrome'};
      case 'setBrowserViewport': return {ok:true};
      default: throw new Error('Unimplemented fixture RPC '+method);
    }
  };
  const record = (method, params) => {calls.push({method,params});return true;};
  window.onflip = {
    call:rpc,onEvent:fn=>listen('event',fn),onApproval:fn=>listen('approval',fn),onApprovalSettled:fn=>listen('approvalSettled',fn),onEngineExit:fn=>listen('exit',fn),
    respondApproval:(id,decision)=>record('respondApproval',{id,decision}),
    appInfo:async()=>({version:status.version,platform:'win32'}),
    winControl:async()=>({maximized:false}),onWinState:fn=>listen('winstate',fn),setTheme:async theme=>record('setTheme',theme),setPrefs:async p=>record('setPrefs',p),setMinWidth:async width=>record('setMinWidth',width),
    browserViewAvailable:async()=>true,browserViewChrome:async()=>({url:'http://localhost:3000',title:'Loom',loading:false,canGoBack:false,canGoForward:false}),onBrowserChrome:fn=>listen('browserChrome',fn),browserViewBounds:async p=>record('browserViewBounds',p),browserViewHide:async()=>record('browserViewHide'),browserViewAct:async()=>true,browserViewGo:async()=>true,
    onTermData:fn=>listen('termData',fn),onTermExit:fn=>listen('termExit',fn),termRun:async(command,cwd)=>{record('termRun',{command,cwd});signal('termData',{kind:'out',text:'> workspace@1.0.0 build\nBuild completed successfully.\n'});return {ok:true};},termKill:async()=>true,
    schedulesList:async()=>[],onSchedulesChanged:fn=>listen('schedules',fn),onTelegramChanged:fn=>listen('telegram',fn),telegramGet:async()=>({enabled:false,hasToken:false,allowedIds:'',state:'off'}),indicatorGet:async()=>({enabled:false,size:42}),
    providerGet:async()=>({id:status.provider,label:({chatgpt:'ChatGPT',deepseek:'DeepSeek',qwen:'Qwen',gemini:'Gemini API'})[status.provider],all:[{id:'chatgpt',label:'ChatGPT'},{id:'deepseek',label:'DeepSeek'},{id:'qwen',label:'Qwen'},{id:'gemini',label:'Gemini API'}]}),providerSet:async id=>{record('providerSet',id);return {ok:false,reason:'Fixture: service is busy'};},
    pickFolder:async()=>cwd,pickFiles:async()=>[],onUpdateAvailable:fn=>listen('updateAvailable',fn),onUpdateProgress:fn=>listen('updateProgress',fn),checkUpdate:async()=>({available:false,current:status.version,url:'https://example.test'}),
  };
  window.__fixture = {calls,status,event,signal,activate,refuse:false};
}

let browser;
(async()=>{
  if (!fs.existsSync(path.join(UI_ROOT,'index.html'))) throw new Error('Build the renderer first: npm run build:ui');
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser = await chromium.launch({channel:'chrome',headless:true}).catch(()=>chromium.launch({headless:true}));
  const context = await browser.newContext({viewport:{width:1440,height:960},deviceScaleFactor:1});
  await context.addInitScript(installFixture, APP_VERSION);
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const origin='http://127.0.0.1:'+server.address().port;
  await page.goto(origin);
  await page.locator('.conn-dot.ready').first().waitFor();
  await page.evaluate(()=>document.fonts.ready);
  const shot=async(name)=>{await page.waitForTimeout(350);await page.screenshot({path:path.join(output,name+'.png')});};
  await shot('01-home-dark');
  await page.getByRole('button',{name:'Build something',exact:true}).click();
  const draft=await page.locator('.composer textarea').inputValue();
  assert(draft.includes('Help me build'));
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog',{name:'Search anything'}).waitFor();
  await page.getByRole('textbox',{name:'Where would you like to go?'}).fill('connections');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog',{name:'Your connections'}).waitFor();
  assert.equal(await page.locator('.provider-card.active').count(),1);
  await shot('02-connections-dark');
  await page.locator('.provider-card').filter({hasText:'DeepSeek'}).getByRole('button',{name:/Switch/}).click();
  await page.getByText('Fixture: service is busy').waitFor();
  assert.equal(await page.locator('.provider-card').filter({hasText:'DeepSeek'}).getByRole('button',{name:/Switch/}).isEnabled(),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.composer textarea').inputValue(),draft);
  await page.getByRole('button',{name:'Switch color theme'}).click();
  await shot('03-home-light');
  await page.getByRole('button',{name:'Switch color theme'}).click();
  await page.locator('.welcome-project').last().click();
  await page.locator('.assistant-identity').first().waitFor();
  assert(await page.evaluate(()=>__fixture.calls.some(c=>c.method==='resumeSession')));
  await page.locator('.context-strip button').filter({hasText:'diff'}).click();
  await page.locator('.changes-panel .diff').first().waitFor();
  await shot('04-conversation-changes');
  await page.locator('.changes-panel').getByRole('button',{name:/^terminal$/i}).click();
  await page.locator('.term-input-row input').fill('npm run build');
  await page.locator('.term-input-row input').press('Enter');
  await page.getByText('Build completed successfully.',{exact:false}).waitFor();
  await page.locator('.term-panel').getByRole('button',{name:'Changes',exact:true}).click();
  await page.locator('.changes-panel').getByRole('button',{name:/^terminal$/i}).click();
  assert(await page.getByText('Build completed successfully.',{exact:false}).isVisible());
  await shot('05-terminal');
  await page.locator('.term-panel').getByRole('button',{name:'Preview',exact:true}).click();
  await page.waitForTimeout(350);
  let bounds=await page.evaluate(()=>__fixture.calls.filter(c=>c.method==='browserViewBounds').at(-1)?.params);
  assert(bounds?.width>200 && bounds?.height>200);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(50);
  const lastViewCall=await page.evaluate(()=>__fixture.calls.filter(c=>['browserViewHide','browserViewBounds'].includes(c.method)).at(-1));
  assert.equal(lastViewCall.method,'browserViewHide');
  await page.getByRole('textbox',{name:'Where would you like to go?'}).fill('settings');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
  await shot('06-settings');
  await page.getByRole('switch',{name:'Interface motion'}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.motion),'off');
  await page.locator('.settings-navigation').getByRole('button',{name:'Shell rules'}).click();
  assert(await page.locator('[data-settings="rules"]').evaluate(el=>document.activeElement===el));
  assert((await page.locator('.modal-body').evaluate(el=>el.scrollTop))>300);
  const firstControl=page.locator('.modal-head button');
  await firstControl.focus();
  await page.keyboard.press('Shift+Tab');
  assert(await page.locator('.modal').evaluate(el=>el.contains(document.activeElement)));
  await page.evaluate(()=>__fixture.signal('approval',42,{kind:'command',reason:'Review this command',subject:'npm run build',dangerous:false}));
  await page.locator('.modal.approval').waitFor();
  await page.waitForFunction(()=>document.activeElement?.matches('.modal.approval'));
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>__fixture.calls.filter(c=>c.method==='respondApproval').length),0);
  await page.keyboard.press('Tab');
  assert(await page.locator('.modal.approval').evaluate(el=>el.contains(document.activeElement)));
  assert(await page.locator('.modal.approval').evaluate(el=>Number(getComputedStyle(el.parentElement).zIndex)>100));
  await shot('08-approval');
  await page.keyboard.press('Escape');
  await page.locator('.modal.approval').waitFor({state:'detached'});
  assert(await page.getByRole('dialog',{name:'Settings',exact:true}).isVisible());
  assert(await page.evaluate(()=>__fixture.calls.some(c=>c.method==='respondApproval'&&c.params.id===42&&c.params.decision.abort===true)));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  bounds=await page.evaluate(()=>__fixture.calls.filter(c=>['browserViewHide','browserViewBounds'].includes(c.method)).at(-1));
  assert.equal(bounds.method,'browserViewBounds');
  await page.locator('.browser-panel .term-btn').last().click();
  await page.evaluate(()=>__fixture.refuse=true);
  await page.locator('.composer textarea').fill('Keep this draft after refusal');
  await page.locator('.composer textarea').press('Enter');
  await page.getByText('Fixture: send refused',{exact:false}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.composer textarea').value==='Keep this draft after refusal');
  assert.equal(await page.locator('.composer textarea').inputValue(),'Keep this draft after refusal');
  await page.evaluate(()=>__fixture.refuse=false);
  await page.locator('.composer textarea').press('Enter');
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  assert(await page.evaluate(()=>__fixture.calls.some(c=>c.method==='interrupt')));
  await page.setViewportSize({width:900,height:800});
  await shot('07-compact-conversation');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.getByRole('button',{name:'Toggle sidebar'}).click();
  assert(await page.locator('.sidebar').evaluate(el=>el.inert));
  await page.getByRole('button',{name:'Toggle sidebar'}).click();
  assert.equal(await page.locator('.sidebar').evaluate(el=>el.inert),false);
  await context.addInitScript(()=>{
    const id=new URL(location.href).searchParams.get('provider');
    if(id){__fixture.status.provider=id;__fixture.status.model=({deepseek:'deepseek-chat',qwen:'qwen3-max',gemini:'gemini-2.5-pro'})[id];__fixture.status.account=null;}
  });
  for(const id of ['deepseek','qwen','gemini']){
    await page.goto(origin+'/?provider='+id);
    await page.locator('.conn-dot.ready').first().waitFor();
    await page.locator('.workspace-navigation').getByRole('button',{name:'Your connections'}).click();
    const active=page.locator('.provider-card.active');
    await active.waitFor();
    assert.equal(await active.count(),1);
    assert.equal(await active.locator('.studio-badge').textContent(),'connected');
    assert.equal(await active.locator('.provider-card-model strong').textContent(),await page.evaluate(()=>__fixture.status.model));
    await page.evaluate(()=>__fixture.event('connect',{state:'error',detail:'Fixture: offline'}));
    await active.locator('.studio-badge.muted').waitFor();
    await page.keyboard.press('Escape');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.new-chat-btn').evaluate(el=>getComputedStyle(el).transitionDuration.split(',')[0].trim()),'1e-05s');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'qa-result.json'),JSON.stringify({passed:true,checks:['dark and light home','suggestions populate a persistent draft','keyboard palette navigation','truthful cards for all four providers','provider-switch rejection clears busy state','resume project','diff dock','terminal state preserved across tabs','native preview bounds and modal parking','settings section navigation and focus trap','approval focus, stacking, and safe Enter handling','motion preference and system reduced motion','refused send restores draft','interrupt','compact layout'],pageErrors:errors},null,2));
  await browser.close();
  console.log('Renderer workflows passed. Screenshots saved to '+output);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
