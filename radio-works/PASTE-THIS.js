<script>
/* ===== Radio Works: song + artist fix =====
   PASTE THIS AT THE VERY END OF THE TEXT ACTION. It brings its own <script>
   tags, so it does not matter that the page's own script has already closed.

   Why it was broken: the page reads every song title through
   fetch('/np?u=...'), a local server that the self-contained build removed.
   The fetch fails, so it says "this station sends no song info" for every
   station. This asks each station's own platform instead.

   ASCII only, on purpose: the Shortcut base64-encodes this text and any
   non-ASCII character in here can come out mangled. */
(function(){
  'use strict';
  if (typeof fetchNowPlaying !== 'function') { return; }   // wrong spot; do no harm
  var T = 4500;
  var won = {};                            // stationuuid -> rung that worked

  function gj(u,s){ return fetch(u,{signal:s,mode:'cors',cache:'no-store',credentials:'omit'})
    .then(function(r){ if(!r.ok) throw 0; return r.json(); }); }
  function gt(u,s){ return fetch(u,{signal:s,mode:'cors',cache:'no-store',credentials:'omit'})
    .then(function(r){ if(!r.ok) throw 0; return r.text(); }); }

  /* Japanese / Chinese / Korean feeds use a full-width dash and no spaces.
     The page's parseTrack needs " - " with spaces, so make one. */
  var CJKre = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
  function norm(s){
    if(!s) return s;
    var t = String(s).replace(/　/g,' ')
                     .replace(/[－‐‒]/g,'-')
                     .replace(/～/g,'~').trim();
    if (CJKre.test(t) && !/\s[-–—]\s/.test(t)) {
      var m = t.match(/^([^-–—]{2,})[-–—]([^-–—].*)$/);
      if (m) t = m[1].trim() + ' - ' + m[2].trim();
    }
    return t;
  }

  /* Find a song inside ANY json shape, so platforms nobody has heard of
     still work. Prefers a real artist+title pair over a combined string. */
  var SK = /^(song_?title|songtitle|streamtitle|stream_title|now_?playing|nowplaying|currently_?playing|current_?song|current_?track|track_?title|song_?name|track_?name|title|song|track|text)$/i;
  var TK = /^(title|song|track|name|song_?name|track_?name|title_?name)$/i;
  function isArr(x){ return Object.prototype.toString.call(x) === '[object Array]'; }
  function dig(o,d,seen){
    d = d||0; seen = seen||[];
    if(!o || d>6 || seen.indexOf(o)>=0) return null;
    if(typeof o === 'object') seen.push(o);
    if(isArr(o)){
      for(var i=0;i<Math.min(o.length,12);i++){ var h=dig(o[i],d+1,seen); if(h) return h; }
      return null;
    }
    if(typeof o !== 'object') return null;
    var ks = Object.keys(o);
    var ak=null, tk=null, j;
    for(j=0;j<ks.length;j++){ if(!ak && /^artist(_?name)?$/i.test(ks[j])) ak=ks[j];
                              if(!tk && TK.test(ks[j])) tk=ks[j]; }
    if(ak && tk){
      var a = (typeof o[ak]==='string') ? o[ak]
            : (o[ak] && typeof o[ak].name==='string' ? o[ak].name : '');
      var t = (typeof o[tk]==='string') ? o[tk] : '';
      if(t.trim()) return (a.trim() ? a.trim()+' - ' : '') + t.trim();
    }
    for(j=0;j<ks.length;j++){
      var v = o[ks[j]];
      if(typeof v==='string' && v.trim() && SK.test(ks[j])) return v.trim();
    }
    for(j=0;j<ks.length;j++){
      var w = o[ks[j]];
      if(w && typeof w==='object'){ var g=dig(w,d+1,seen); if(g) return g; }
    }
    return null;
  }
  function digArt(o,d){
    d = d||0;
    if(!o || typeof o!=='object' || d>5) return null;
    for(var k in o){
      var v = o[k];
      if(typeof v==='string'
         && /^(art|artwork|artwork_url|artwork_url_large|cover|cover_url|image|albumart|album_art|thumb)$/i.test(k)
         && /^https?:\/\//.test(v)) return v.replace(/^http:/,'https:');
      if(v && typeof v==='object'){ var h=digArt(v,d+1); if(h) return h; }
    }
    return null;
  }

  /* Triton wraps every field as <property name="X"><![CDATA[ ... ]]></property> */
  function tp(xml,name){
    var re = new RegExp('name="'+name+'"[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))','i');
    var m = xml.match(re);
    return m ? String(m[1]!=null ? m[1] : (m[2]||'')).trim() : '';
  }

  function chain(list, fn){          // try each url until one yields a result
    var i = 0;
    function step(){
      if(i >= list.length) return null;
      return fn(list[i++]).then(function(r){ return r || step(); }, step);
    }
    return step();
  }

  var RUNGS = [
    { n:'abc',
      claim:function(u,st){ return typeof abcSlug==='function' && !!abcSlug(st); },
      run:function(u,st,s){
        return gj('https://music.abcradio.net.au/api/v1/plays/search.json?station='
          + encodeURIComponent(abcSlug(st)) + '&order=desc&limit=1', s).then(function(j){
          var r = j && j.items && j.items[0] && j.items[0].recording;
          if(!r || !r.title) return null;
          var a = (r.artists && r.artists[0] && r.artists[0].name) || '';
          return { raw: a ? a+' - '+r.title : r.title, art:null };
        });
      } },

    { n:'azuracast',
      claim:function(u){ return /\/(listen|radio)\//.test(u.pathname) || /azura/i.test(u.host); },
      run:function(u,st,s){
        var m = u.pathname.match(/\/listen\/([^/]+)\//) || u.pathname.match(/\/radio\/\d+\/([^/]+)/);
        var list = m ? [u.origin+'/api/nowplaying_static/'+m[1]+'.json', u.origin+'/api/nowplaying']
                     : [u.origin+'/api/nowplaying'];
        return chain(list, function(url){
          return gj(url,s).then(function(j){
            var np = isArr(j) ? (j[0] && j[0].now_playing) : j.now_playing;
            var g = np && np.song;
            if(g && g.title) return { raw: g.artist ? g.artist+' - '+g.title : (g.text||g.title),
                                      art: g.art || null };
            return null;
          });
        });
      } },

    { n:'radio.co',
      claim:function(u){ return /radio\.co$/.test(u.host); },
      run:function(u,st,s){
        var id = (u.pathname.match(/\/(s[0-9a-z]+)\b/i)||[])[1];
        if(!id) return null;
        return gj('https://public.radio.co/stations/'+id+'/status', s).then(function(j){
          var c = j && j.current_track;
          return (c && c.title) ? { raw:c.title, art:(c.artwork_url_large||c.artwork_url||null) } : null;
        });
      } },

    { n:'radioking',
      claim:function(u){ return /radioking/i.test(u.host); },
      run:function(u,st,s){
        var g = (u.pathname.match(/\/(?:play|radio)\/([^/]+)/)||[])[1];
        if(!g) return null;
        return gj('https://api.radioking.io/widget/radio/'+g+'/track/current', s).then(function(j){
          return (j && j.title) ? { raw:(j.artist ? j.artist+' - ' : '')+j.title, art:j.cover||null } : null;
        });
      } },

    { n:'laut.fm',
      claim:function(u){ return /laut\.fm$/.test(u.host); },
      run:function(u,st,s){
        var n = u.pathname.replace(/^\//,'').split('/')[0];
        if(!n) return null;
        return gj('https://api.laut.fm/station/'+n+'/current_song', s).then(function(j){
          if(!j || !j.title) return null;
          var a = (j.artist && j.artist.name) ? j.artist.name+' - ' : '';
          return { raw: a + j.title, art:null };
        });
      } },

    { n:'radiojar',
      claim:function(u){ return /radiojar/i.test(u.host); },
      run:function(u,st,s){
        var id = u.pathname.replace(/^\//,'').split('/')[0];
        if(!id) return null;
        return gj('https://www.radiojar.com/api/stations/'+id+'/now_playing/', s).then(function(j){
          return (j && j.title) ? { raw:(j.artist ? j.artist+' - ' : '')+j.title, art:j.thumb||null } : null;
        });
      } },

    { n:'triton',
      claim:function(u){ return /streamtheworld|tritondigital/i.test(u.host); },
      run:function(u,st,s){
        var m = u.pathname.match(/([A-Z0-9_]+(?:AAC|MP3|_SC)?)(?:\.(?:mp3|aac))?$/i);
        if(!m) return null;
        return gt('https://np.tritondigital.com/public/nowplaying?mountName='+m[1]
                  + '&numberToFetch=1&eventType=track', s).then(function(x){
          var t = tp(x,'cue_title');
          if(!t) return null;
          var a = tp(x,'track_artist_name');
          return { raw:(a ? a+' - ' : '')+t, art: tp(x,'track_album_art')||null };
        });
      } },

    /* Icecast 2.4+ serves this with CORS on by default, so it is worth
       trying against absolutely everything. Highest-yield rung. */
    { n:'icecast',
      claim:function(){ return true; },
      run:function(u,st,s){
        return gj(u.origin+'/status-json.xsl', s).then(function(j){
          var src = j && j.icestats && j.icestats.source;
          if(!src) return null;
          var arr = isArr(src) ? src : [src];
          var mine = null, i;
          for(i=0;i<arr.length;i++){
            var lu = arr[i].listenurl;
            if(typeof lu==='string' && lu.slice(-u.pathname.length)===u.pathname){ mine=arr[i]; break; }
          }
          if(!mine) mine = arr[0];
          if(!mine) return null;
          var keys = ['title','yp_currently_playing','song'];
          for(i=0;i<keys.length;i++){
            var v = mine[keys[i]];
            if(typeof v==='string' && v.trim()) return { raw:v.trim(), art:null };
          }
          return null;
        });
      } },

    { n:'shoutcast',
      claim:function(){ return true; },
      run:function(u,st,s){
        return chain([u.origin+'/stats?json=1&sid=1', u.origin+'/statistics?json=1'], function(url){
          return gj(url,s).then(function(j){
            var r = (j && j.songtitle) || dig(j);
            return r ? { raw:String(r).trim(), art:null } : null;
          });
        });
      } },

    { n:'generic',
      claim:function(){ return true; },
      run:function(u,st,s){
        return chain([u.origin+'/api/nowplaying', u.origin+'/nowplaying.json',
                      u.origin+'/currentsong?sid=1', u.origin+'/api/live-info'], function(url){
          return gt(url,s).then(function(b){
            var j = null;
            try { j = JSON.parse(b); } catch(e){}
            var r = j ? dig(j) : ((b.trim().length>1 && b.length<200) ? b.trim() : null);
            return r ? { raw:String(r).trim(), art: j ? digArt(j) : null } : null;
          });
        });
      } },
  ];

  /* ---- the replacement ---- */
  fetchNowPlaying = async function(st, warm){
    var stream = (st && (st.url_resolved || st.url)) || '';
    if(!stream) return { raw:null, art:null };
    var u;
    try { u = new URL(stream.replace(/^http:/,'https:')); }
    catch(e){ return { raw:null, art:null }; }

    var ac = ('AbortController' in window) ? new AbortController() : null;
    var timer = ac ? setTimeout(function(){ try{ ac.abort(); }catch(e){} }, T) : null;
    var sig = ac ? ac.signal : undefined;
    var id = st.stationuuid;

    var order = RUNGS.slice();
    if(won[id]) order.sort(function(a,b){ return (b.n===won[id]) - (a.n===won[id]); });

    try {
      for(var i=0;i<order.length;i++){
        var r = order[i], ok = false;
        try { ok = r.claim(u, st); } catch(e){}
        if(!ok) continue;
        try {
          var hit = await r.run(u, st, sig);
          if(hit && hit.raw){
            won[id] = r.n;
            try { if(!warm){ npSource = r.n; npDirectArt = hit.art || null; } } catch(e){}
            return { raw: norm(hit.raw), art: hit.art || null };
          }
        } catch(e){ /* CORS, 404, timeout: just try the next rung */ }
        if(sig && sig.aborted) break;
      }
    } finally { if(timer) clearTimeout(timer); }

    delete won[id];
    try { if(!warm){ npSource = 'none'; npDirectArt = null; } } catch(e){}
    return { raw:null, art:null };
  };

  try { if (typeof cur !== 'undefined' && cur) startTrackWatch(cur); } catch(e){}
})();
</script>
