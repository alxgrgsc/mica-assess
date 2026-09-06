/* Mica Assess self-test: nothing captured on site may be lost.
 *
 * Open the app with both parameters and it runs itself:
 *
 *   elevation-picker.html?api=http://127.0.0.1:8000/api&selftest=1
 *
 * It creates a throwaway case, captures two walls and a core while standing
 * in for a server that is down, restarts the page (the tablet being killed),
 * keeps the server down a little longer, brings it back, and then asks the
 * server what it holds. Every step is a named check; the result shows on
 * screen and in `window.__selftestResult`. The test case is removed from the
 * tablet at the end. The server keeps its copy, which is the point.
 */
(function(){
  const M = window.__mica;
  if(!M) return;
  const PHASE_KEY = 'mica-selftest';
  const sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  const results = [];

  // ---- on-screen report ----
  const box = document.createElement('pre');
  box.id = 'selftest';
  box.style.cssText = 'position:fixed;left:12px;top:12px;z-index:9999;max-width:520px;max-height:90vh;overflow:auto;'
    + 'background:#0b0f14;color:#dfe6ee;border:1px solid #2a3542;padding:12px 14px;margin:0;'
    + 'font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap';
  document.body.appendChild(box);
  function draw(status){
    box.textContent = 'SELF-TEST ' + (status || '') + '\n' + results.map(function(r){
      return (r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '  (' + r.detail + ')' : '');
    }).join('\n');
  }
  function check(name, ok, detail){
    results.push({ name: name, ok: !!ok, detail: detail || '' });
    draw('running');
  }
  function finish(){
    const pass = results.every(function(r){ return r.ok; });
    window.__selftestResult = { pass: pass, results: results };
    draw(pass ? 'PASSED' : 'FAILED');
    console.log('[selftest]', pass ? 'PASSED' : 'FAILED', results);
  }

  // ---- a server that can be down ----
  // The app calls the global fetch, so replacing it here is exactly what a
  // dead connection looks like to the app: a rejected promise, no response.
  const realFetch = window.fetch.bind(window);
  let down = false;
  window.fetch = function(){
    if(down) return Promise.reject(new TypeError('Failed to fetch (self-test: server down)'));
    return realFetch.apply(null, arguments);
  };

  function photoBlob(label){
    return new Promise(function(resolve){
      const c = document.createElement('canvas'); c.width = 160; c.height = 120;
      const g = c.getContext('2d');
      g.fillStyle = '#6b7a8a'; g.fillRect(0, 0, 160, 120);
      g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText(label, 12, 66);
      c.toBlob(resolve, 'image/jpeg', 0.7);
    });
  }
  async function addPhoto(wall, label){
    const id = M.uid();
    const blob = await photoBlob(label);
    await M.putPhoto({ id: id, wall: wall, blob: blob, ts: Date.now() });
    M.captures[wall].photos.push({ id: id, state: 'pending', ts: Date.now() });
    M.save(); M.syncUI();
    return id;
  }
  function photosOf(walls){
    const out = [];
    walls.forEach(function(w){ (M.captures[w] ? M.captures[w].photos : []).forEach(function(p){ out.push(p); }); });
    return out;
  }
  function findSample(id){
    for(let i=0;i<M.day.properties.length;i++){
      const list = M.day.properties[i].samples || [];
      for(let j=0;j<list.length;j++) if(list[j].id === id) return list[j];
    }
    return null;
  }

  // ---- phase 1: capture with the server down, then die ----
  async function phase1(){
    const id = M.uid();
    M.day.properties.push({ id: id, caseNo: 'QA-SELFTEST', address: 'Self-test house, Buncrana',
                            eircode: '', county: 'Donegal', samples: [], audit: [] });
    M.saveDay();
    M.switchProperty(id);
    M.setStage('capture');
    M.save();

    down = true;
    const walls = M.panels().filter(function(p){ return p.pick; }).slice(0, 2).map(function(p){ return p.id; });
    check('two walls to work with', walls.length === 2, walls.join(', '));
    for(let i=0;i<walls.length;i++){
      const w = walls[i];
      M.select(w);
      const c = M.captures[w];
      c.note = 'Self-test ' + w; c.crack = true; c.crackMm = 1.5; c.defects = ['pattern'];
      await addPhoto(w, w + ' A');
      await addPhoto(w, w + ' B');
      M.save(); M.schedulePush();
    }
    M.select(null);
    M.pump();
    const room = M.addRoom('Kitchen', 0);
    room.crack = true; room.crackMm = 2; room.defects = ['horizontal']; room.note = 'Self-test room';
    M.save(); M.schedulePush();
    const sm = M.addSample(walls[0], 'Self-test core');
    sm.lab = 'Sandberg'; sm.test = 'XRD';
    M.sampleDirty(sm);

    await sleep(2500);
    const ph = photosOf(walls);
    check('four photos queued', ph.length === 4, ph.length + ' photos');
    check('photos held while the server is down',
      ph.every(function(p){ return p.state === 'pending' || p.state === 'uploading'; }),
      ph.map(function(p){ return p.state; }).join(','));
    check('core held while the server is down', sm.sync !== 'confirmed' && sm.sync !== 'failed', sm.sync);
    const conn = document.getElementById('conn').textContent;
    check('header says it is holding', /Sending|held/.test(conn), conn);

    sessionStorage.setItem(PHASE_KEY, JSON.stringify({ phase: 2, id: id, walls: walls, sampleId: sm.id, results: results }));
    draw('restarting the page (tablet killed)');
    await sleep(600);
    location.reload();
  }

  // ---- phase 2: come back, server still down, then back up ----
  async function phase2(st){
    st.results.forEach(function(r){ results.push(r); });
    down = true;
    M.switchProperty(st.id);
    M.setStage('capture');
    const walls = st.walls;
    let ph = photosOf(walls);
    check('queue survived the restart', ph.length === 4 && ph.every(function(p){ return p.state !== 'confirmed' && p.state !== 'failed'; }),
      ph.map(function(p){ return p.state; }).join(','));
    let sm = findSample(st.sampleId);
    check('core survived the restart', !!sm && sm.sync !== 'confirmed' && sm.sync !== 'failed', sm ? sm.sync : 'missing');
    check('room survived the restart', M.rooms().length === 1 && M.rooms()[0].note === 'Self-test room');
    check('wall data survived the restart',
      walls.every(function(w){ const c = M.captures[w]; return c && c.crack === true && c.crackMm === 1.5 && c.defects.indexOf('pattern') !== -1 && c.note === 'Self-test ' + w; }));

    await sleep(3000);
    ph = photosOf(walls);
    check('still holding with the server down after restart',
      ph.every(function(p){ return p.state !== 'confirmed' && p.state !== 'failed'; }),
      ph.map(function(p){ return p.state; }).join(','));

    down = false;
    M.resetBackoff(); M.pump(); M.pumpSamples(); M.schedulePush();
    const t0 = Date.now();
    while(Date.now() - t0 < 60000){
      ph = photosOf(walls);
      sm = findSample(st.sampleId);
      if(ph.every(function(p){ return p.state === 'confirmed'; }) && sm && sm.sync === 'confirmed') break;
      await sleep(500);
      M.pump(); M.pumpSamples();
    }
    check('every photo confirmed once the server is back',
      ph.every(function(p){ return p.state === 'confirmed'; }), ph.map(function(p){ return p.state; }).join(','));
    check('core confirmed once the server is back', sm && sm.sync === 'confirmed', sm ? sm.sync : 'missing');

    // what the server holds is the truth that matters
    let d = null;
    try{
      const r = await realFetch(M.apiBase + '/assessments/' + st.id + '/');
      d = r.ok ? await r.json() : null;
    }catch(e){}
    check('server has the assessment', !!d);
    if(d){
      walls.forEach(function(w){
        const e = (d.elevations || []).filter(function(x){ return x.slug === w; })[0];
        check('server has both photos for ' + w, e && e.captures.length === 2, e ? e.captures.length + ' stored' : 'wall missing');
        check('server has the wall record for ' + w,
          e && +e.crack_mm === 1.5 && (e.defects || []).indexOf('pattern') !== -1 && e.note === 'Self-test ' + w,
          e ? 'crack ' + e.crack_mm + ', defects ' + JSON.stringify(e.defects) : 'wall missing');
      });
      const rm = (d.rooms || []).filter(function(r){ return r.name === 'Kitchen'; })[0];
      check('server has the room with its findings', !!rm && +rm.crack_mm === 2 && (rm.defects || []).indexOf('horizontal') !== -1 && rm.note === 'Self-test room',
        rm ? 'crack ' + rm.crack_mm + ', defects ' + JSON.stringify(rm.defects) : 'missing');
      const srv = (d.samples || []).filter(function(s){ return s.id === st.sampleId; })[0];
      check('server has the core with its lab and test', !!srv && srv.lab === 'Sandberg' && srv.test_type === 'XRD',
        srv ? srv.lab + ' / ' + srv.test_type : 'missing');
    }

    // leave the tablet as it was; the server keeps the case
    ph = photosOf(walls);
    ph.forEach(function(p){ M.delPhoto(p.id).catch(function(){}); });
    M.day.properties = M.day.properties.filter(function(p){ return p.id !== st.id; });
    M.day.activeId = '';
    try{ localStorage.removeItem('elevation-picker-v1:' + st.id); }catch(e){}
    M.saveDay();
    sessionStorage.removeItem(PHASE_KEY);
    M.openToday();
    finish();
  }

  if(!M.apiBase){
    check('API configured (open with ?api=http://host:8000/api)', false);
    finish();
    return;
  }
  const st = JSON.parse(sessionStorage.getItem(PHASE_KEY) || 'null');
  if(st && st.phase === 2) phase2(st).catch(function(e){ check('phase 2 crashed', false, String(e)); finish(); });
  else phase1().catch(function(e){ check('phase 1 crashed', false, String(e)); finish(); });
})();
