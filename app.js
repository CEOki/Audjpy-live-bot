const $ = id => document.getElementById(id);
let ws = null, pollTimer = null, candles = [], current = null, lastTick = 0, feedMode = 'disconnected';
const MAX = 180;

$('connect').onclick = connect;
$('backtest').onclick = backtest;

function symbolFor(asset) {
  return asset === 'AUDJPY' ? 'AUD/JPY' : asset === 'EURJPY' ? 'EUR/JPY' : 'USD/JPY';
}

function connect() {
  if (ws) try { ws.close(); } catch(e) {}
  if (pollTimer) clearInterval(pollTimer);
  feedMode = 'loading';
  const key = $('apiKey').value.trim();
  if (!key) { $('status').textContent = 'Enter your Twelve Data API key'; return; }
  localStorage.setItem('td_key', key);
  localStorage.setItem('aud_asset', $('asset').value);
  candles = []; current = null; lastTick = 0;
  resetStats();
  $('status').textContent = 'Loading 1-minute candles…';

  const symbol = symbolFor($('asset').value);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=120&order=asc&timezone=UTC&apikey=${encodeURIComponent(key)}`;
  fetch(url).then(r => r.json()).then(data => {
    if (data.status === 'error' || !data.values) throw new Error(data.message || 'Market-data request failed');
    for (const x of data.values) addCandle([Date.parse(x.datetime + 'Z'), +x.open, +x.high, +x.low, +x.close]);
    $('status').textContent = 'History loaded — connecting live feed…';
    connectStream(key, symbol);
  }).catch(err => $('status').textContent = err.message || 'Could not load market data');
}

function connectStream(key, symbol) {
  ws = new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(key)}`);
  ws.onopen = () => {
    feedMode = 'websocket';
    $('status').textContent = 'Live market connected (Twelve Data)';
    ws.send(JSON.stringify({action:'subscribe', params:{symbols:symbol}}));
  };
  ws.onmessage = e => {
    let d; try { d = JSON.parse(e.data); } catch(_) { return; }
    if (d.event === 'price' && typeof d.price === 'number') tick(d.timestamp || Date.now()/1000, d.price);
    else if (d.status === 'error' || d.code) $('status').textContent = d.message || 'Market-data error';
  };
  ws.onerror = () => {
    $('status').textContent = 'WebSocket unavailable — switching to live polling';
    startPolling(key, symbol);
  };
  ws.onclose = () => {
    if (feedMode === 'websocket') { $('status').textContent = 'Live feed disconnected — polling'; startPolling(key, symbol); }
  };
}


function startPolling(key, symbol) {
  if (pollTimer) clearInterval(pollTimer);
  feedMode = 'polling';
  const poll = () => {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=2&order=desc&timezone=UTC&apikey=${encodeURIComponent(key)}`;
    fetch(url).then(r=>r.json()).then(data=>{
      if(data.status==='error'||!data.values||!data.values.length) throw new Error(data.message||'Polling failed');
      const x=data.values[0];
      const t=Date.parse(x.datetime+'Z');
      addCandle([t,+x.open,+x.high,+x.low,+x.close]);
      $('price').textContent=(+x.close).toFixed(3);
      lastTick=Date.now();
      $('status').textContent='Live market connected (polling)';
    }).catch(err=>{ $('status').textContent='Live data error: '+(err.message||'request failed'); });
  };
  poll();
  pollTimer=setInterval(poll,15000);
}

function addCandle(x) {
  let t = Number(x[0]); if (t < 1e12) t *= 1000;
  const c = {t, o:+x[1], h:+x[2], l:+x[3], c:+x[4]};
  if (!isFinite(c.c)) return;
  const last = candles[candles.length-1];
  if (last && Math.floor(last.t/60000) === Math.floor(c.t/60000)) Object.assign(last,c);
  else candles.push(c);
  if (candles.length > MAX) candles.shift();
  render();
}

function tick(ts,p) {
  ts=Number(ts); if(ts<1e12) ts*=1000; lastTick=Date.now(); $('price').textContent=Number(p).toFixed(3);
  const bucket=Math.floor(ts/60000)*60000;
  if(!current || current.t!==bucket){ if(current) candles.push(current); current={t:bucket,o:p,h:p,l:p,c:p}; if(candles.length>MAX)candles.shift(); }
  else { current.c=p; current.h=Math.max(current.h,p); current.l=Math.min(current.l,p); }
  render();
}

function closes(){return candles.concat(current?[current]:[]).map(x=>x.c)}
function ema(a,n){if(a.length<n)return null;let k=2/(n+1),v=a.slice(0,n).reduce((x,y)=>x+y,0)/n;for(let i=n;i<a.length;i++)v=a[i]*k+v*(1-k);return v}
function rsi(a,n=14){if(a.length<n+1)return null;let g=0,l=0;for(let i=a.length-n;i<a.length;i++){let d=a[i]-a[i-1];if(d>0)g+=d;else l-=d}if(l===0)return 100;let rs=(g/n)/(l/n);return 100-100/(1+rs)}

function atr(a,n=14){
  if(a.length<n+1)return null;
  let tr=[];
  for(let i=1;i<a.length;i++){
    const prev=a[i-1], x=a[i];
    tr.push(Math.abs(x.h-x.l), Math.abs(x.h-prev.c), Math.abs(x.l-prev.c));
  }
  let v=0, count=Math.min(n,tr.length);
  // Conservative ATR approximation from candle ranges.
  for(let i=0;i<count;i+=3) v+=tr[i];
  return count? v/Math.ceil(count/3):null;
}
function slope(a,n=5){
  if(a.length<n+1)return 0;
  return a[a.length-1]-a[a.length-1-n];
}
function signalFor(a) {
  if(a.length<30)return {sig:'WAIT',score:0,reason:'Need more candles'};
  const e9=ema(a.map(x=>x.c||x),9), e21=ema(a.map(x=>x.c||x),21), r=rsi(a.map(x=>x.c||x));
  if(e9==null||e21==null||r==null)return {sig:'WAIT',score:0,reason:'Need more candles'};
  const price=a[a.length-1].c||a[a.length-1], prev=a[a.length-2].c||a[a.length-2];
  const vals=a.map(x=>x.c||x), e9prev=ema(vals.slice(0,-1),9), e21prev=ema(vals.slice(0,-1),21);
  let up=0,down=0;
  const sep=Math.abs(e9-e21)/price*10000;
  if(e9>e21)up+=2; else down+=2;
  if(e9prev!=null && e21prev!=null && e9-e9prev>0)up+=1;
  if(e9prev!=null && e21prev!=null && e9-e9prev<0)down+=1;
  if(r>=55&&r<=68)up+=2;
  if(r<=45&&r>=32)down+=2;
  if(price>prev)up+=1; if(price<prev)down+=1;
  // Require a meaningful EMA separation and agreement; otherwise SKIP.
  if(sep<0.8)return {sig:'SKIP',score:Math.max(up,down),reason:'Trend separation too weak'};
  if(up>=6 && up>down+1)return {sig:'UP',score:up,reason:'Trend + momentum + candle aligned'};
  if(down>=6 && down>up+1)return {sig:'DOWN',score:down,reason:'Trend + momentum + candle aligned'};
  return {sig:'SKIP',score:Math.max(up,down),reason:'Conditions not sufficiently aligned'};
}
function render() {
  const a=closes(), e9=ema(a,9), e21=ema(a,21), r=rsi(a);
  $('ema9').textContent=e9?e9.toFixed(3):'—'; $('ema21').textContent=e21?e21.toFixed(3):'—'; $('rsi').textContent=r==null?'—':r.toFixed(1);
  if(e9&&e21)$('trend').textContent=e9>e21?'UP':'DOWN';
  const s=signalFor(a), sig=s.sig;
  $('signal').textContent=sig; $('signal').className=sig==='UP'?'up':sig==='DOWN'?'down':'skip';
  $('confidence').textContent=sig==='UP'||sig==='DOWN'?`Strict filter • score ${s.score}/8 • ${s.reason}`:s.reason;
  $('feedBadge').textContent=feedMode==='websocket'?'LIVE WS':feedMode==='polling'?'LIVE POLL':feedMode==='loading'?'CONNECTING':'OFFLINE';
  $('age').textContent=lastTick?'Last tick '+Math.max(0,Math.round((Date.now()-lastTick)/1000))+'s ago':'—'; draw(a);
}

function backtest() {
  const key=$('apiKey').value.trim();
  if(!key){$('backtestStatus').textContent='Enter your Twelve Data API key first.';return;}
  const symbol=symbolFor($('asset').value);
  const outputSize=Math.min(Math.max(Number($('historySize').value)||1000,100),5000);
  $('backtestStatus').textContent='Downloading historical 1-minute candles…';
  resetStats();
  const url=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=${outputSize}&order=asc&timezone=UTC&apikey=${encodeURIComponent(key)}`;
  fetch(url).then(r=>r.json()).then(data=>{
    if(data.status==='error'||!data.values)throw new Error(data.message||'Historical data request failed');
    const hist=data.values.slice().reverse().map(x=>({t:Date.parse(x.datetime+'Z'),o:+x.open,h:+x.high,l:+x.low,c:+x.close})).reverse();
    runBacktest(hist);
  }).catch(err=>$('backtestStatus').textContent=err.message||'Backtest failed');
}

function runBacktest(hist) {
  let wins=0,losses=0,skips=0,trades=0;
  // Signal is computed using candle i's close; outcome is candle i+1 close.
  for(let i=0;i<hist.length-1;i++){
    const a=hist.slice(0,i+1).map(x=>x.c);
    const result=signalFor(hist.slice(0,i+1));
    const sig=result.sig;
    if(sig==='SKIP'){skips++;continue;}
    if(sig!=='UP'&&sig!=='DOWN')continue;
    trades++;
    const entry=hist[i].c, exit=hist[i+1].c;
    const win=(sig==='UP'&&exit>entry)||(sig==='DOWN'&&exit<entry);
    if(win)wins++;else losses++;
  }
  const pct=trades?(wins/trades*100):0;
  $('wins').textContent=wins; $('losses').textContent=losses; $('skips').textContent=skips; $('trades').textContent=trades; $('winpct').textContent=trades?pct.toFixed(2)+'%':'—';
  $('backtestStatus').textContent=`Tested ${hist.length.toLocaleString()} historical 1-minute candles. Each signal is evaluated against the following candle's close.`;
}

function resetStats(){['wins','losses','skips','trades'].forEach(id=>$(id).textContent='—');$('winpct').textContent='—';$('backtestStatus').textContent='Not run yet';}

function draw(a){const c=$('chart'),x=c.getContext('2d');x.clearRect(0,0,c.width,c.height);if(a.length<2)return;let v=a.slice(-80),mi=Math.min(...v),ma=Math.max(...v),rg=ma-mi||1;x.beginPath();v.forEach((p,i)=>{let X=i*(c.width-20)/(v.length-1)+10,Y=c.height-10-(p-mi)/rg*(c.height-20);i?x.lineTo(X,Y):x.moveTo(X,Y)});x.strokeStyle='#7ea7ff';x.lineWidth=2;x.stroke()}

$('apiKey').value=localStorage.getItem('td_key')||''; $('asset').value=localStorage.getItem('aud_asset')||'AUDJPY'; resetStats();
setInterval(()=>{if(lastTick&&Date.now()-lastTick>15000)$('status').textContent='Connected, but no tick received recently'},5000);
