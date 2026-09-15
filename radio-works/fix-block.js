
/* =====================================================================
   NOW-PLAYING FIX  (appended 2026 — replaces the dead /np endpoint)

   The old fetchNowPlaying() called '/np?u=...', a local Pythonista helper
   that does not exist in the self-contained data: URL build. Every station
   therefore reported "sends no song info". parseTrack() was never broken;
   it was simply never handed a string.

   This asks each station's own platform directly, the same way
   abcNowPlaying() already does. Same contract, same return shape:
       const {raw, art} = await fetchNowPlaying(st, warm);
   so everything downstream is untouched.

   Two rules decide the whole design:
     1. CORS is the gate. A page can only read endpoints that send
        Access-Control-Allow-Origin. Everything else is invisible however
        good its JSON is, so each rung fails silently and we fall through.
     2. Mixed content: the page is https, so http:// is blocked. Upgrade.
   ===================================================================== */
(function(){
  if(typeof fetchNowPlaying!=='function') return;   // page didn't load; do nothing

  var NP_TIMEOUT=4500;
  var rungMemo=new Map();      // stationuuid -> the rung that answered last time

  function getJSON(url,sig){
    return fetch(url,{signal:sig,mode:'cors',cache:'no-store',credentials:'omit'})
      .then(function(r){ if(!r.ok)throw new Error(r.status); return r.json(); });
  }
  function getText(url,sig){
    return fetch(url,{signal:sig,mode:'cors',cache:'no-store',credentials:'omit'})
      .then(function(r){ if(!r.ok)throw new Error(r.status); return r.text(); });
  }

  /* --- pull a song out of an arbitrary shape, so a platform we have never
         seen still works. Prefers an explicit artist+title PAIR over a
         combined string, because splitting on " - " is a guess and a pair
         is not. --- */
  var SONG_KEYS=/^(song_?title|songtitle|streamtitle|stream_title|now_?playing|nowplaying|currently_?playing|current_?song|current_?track|track_?title|song_?name|track_?name|title|song|track|text)$/i;
  /* Kept separate from SONG_KEYS: a title-ish key is only trusted when an
     artist key sits beside it, so this may be loose (plain 'name' included)
     without inviting false positives. */
  var TITLE_KEYS=/^(title|song|track|name|song_?name|track_?name|title_?name)$/i;
  function deepSong(o,d,seen){
    d=d||0; seen=seen||new Set();
    if(!o||d>6)return null;
    if(typeof o==='object'){ if(seen.has(o))return null; seen.add(o); } else return null;
    if(Array.isArray(o)){
      for(var i=0;i<Math.min(o.length,12);i++){ var h=deepSong(o[i],d+1,seen); if(h)return h; }
      return null;
    }
    var keys=Object.keys(o);
    var ak=keys.find(function(k){return /^artist(_?name)?$/i.test(k);});
    var tk=keys.find(function(k){return TITLE_KEYS.test(k);});
    if(ak&&tk){
      var av=o[ak];
      var a=typeof av==='string'?av:(av&&typeof av.name==='string'?av.name:'');
      var t=typeof o[tk]==='string'?o[tk]:'';
      if(t.trim())return (a.trim()?a.trim()+' - ':'')+t.trim();
    }
    for(var j=0;j<keys.length;j++){
      var v=o[keys[j]];
      if(typeof v==='string'&&v.trim()&&SONG_KEYS.test(keys[j]))return v.trim();
    }
    for(var k2=0;k2<keys.length;k2++){
      var v2=o[keys[k2]];
      if(v2&&typeof v2==='object'){ var h2=deepSong(v2,d+1,seen); if(h2)return h2; }
    }
    return null;
  }
  function artOf(o){
    if(!o||typeof o!=='object')return null;
    var keys=Object.keys(o);
    for(var i=0;i<keys.length;i++){
      var v=o[keys[i]];
      if(typeof v==='string'&&/^(art|artwork|artwork_url|artwork_url_large|cover|cover_url|image|albumart|album_art|thumb)$/i.test(keys[i])
         &&/^https?:\/\//.test(v))return v.replace(/^http:/,'https:');
      if(v&&typeof v==='object'){ var h=artOf(v); if(h)return h; }
    }
    return null;
  }

  /* --- normalise an ICY string before parseTrack() sees it ---------------
     parseTrack splits on /\s+[-–—]\s+/ : whitespace required both
     sides, and no knowledge of full-width punctuation. CJK feeds break both
     assumptions, e.g. a full-width U+FF0D with no spaces around it, so the
     whole string lands in the title and the artist comes out blank.
     Fixed here rather than in parseTrack so that function stays untouched.
     The unspaced-hyphen rule is gated on the string CONTAINING CJK/Kana/
     Hangul; applying it to Latin text would split "Jean-Michel Jarre". */
  var CJK=/[぀-ヿ㐀-䶿一-鿿가-힯]/;
  function normalizeIcy(s){
    if(!s)return s;
    var t=String(s).replace(/　/g,' ')
                   .replace(/[－‐‒]/g,'-')
                   .replace(/～/g,'~').trim();
    if(CJK.test(t)&&!/\s[-–—]\s/.test(t)){
      var m=t.match(/^([^-–—]{2,})[-–—]([^-–—].*)$/);
      if(m)t=m[1].trim()+' - '+m[2].trim();
    }
    return t;
  }

  /* Triton wraps each field in <property name="x"><![CDATA[...]]></property>.
     An earlier attempt looked for a value="..." attribute, which does not
     exist - so every Triton station (most large US broadcasters) silently
     returned nothing. */
  function tritonProp(xml,name){
    var re=new RegExp('name="'+name+'"[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))','i');
    var m=xml.match(re);
    if(!m)return '';
    return String(m[1]!=null?m[1]:(m[2]!=null?m[2]:'')).trim();
  }

  /* ================= THE LADDER =================
     claim() stops us firing nine requests at every station. Each rung
     returns {raw, art} in ICY shape, or null. Ordered by what actually
     answers a browser. */
  var RUNGS=[
   {name:'abc',
    claim:function(u,st){ return !!abcSlug(st); },
    run:function(u,st,sig){
      return getJSON('https://music.abcradio.net.au/api/v1/plays/search.json?station='
        +encodeURIComponent(abcSlug(st))+'&order=desc&limit=1',sig).then(function(j){
        var rec=j&&j.items&&j.items[0]&&j.items[0].recording;
        if(!rec||!rec.title)return null;
        var a=(rec.artists&&rec.artists[0]&&rec.artists[0].name)||'';
        var art=null;
        try{ var sz=rec.releases[0].artwork[0].sizes; art=sz[sz.length-1].url; }catch(e){}
        return {raw:a?a+' - '+rec.title:rec.title,art:art};
      });
    }},

   {name:'azuracast',
    claim:function(u){ return /\/(listen|radio)\//.test(u.pathname)||/azura/i.test(u.host); },
    run:function(u,st,sig){
      var m=u.pathname.match(/\/listen\/([^/]+)\//)||u.pathname.match(/\/radio\/\d+\/([^/]+)/);
      var tries=m?[u.origin+'/api/nowplaying_static/'+m[1]+'.json',u.origin+'/api/nowplaying']
                 :[u.origin+'/api/nowplaying'];
      return tries.reduce(function(p,t){
        return p.then(function(hit){
          if(hit)return hit;
          return getJSON(t,sig).then(function(j){
            var np=Array.isArray(j)?(j[0]&&j[0].now_playing):(j&&j.now_playing);
            var s=np&&np.song;
            if(s&&s.title)return {raw:s.artist?s.artist+' - '+s.title:(s.text||s.title),art:s.art||null};
            return null;
          }).catch(function(){return null;});
        });
      },Promise.resolve(null));
    }},

   {name:'radio.co',
    claim:function(u){ return /radio\.co$/.test(u.host); },
    run:function(u,st,sig){
      var id=(u.pathname.match(/\/(s[0-9a-z]+)\b/i)||[])[1];
      if(!id)return Promise.resolve(null);
      return getJSON('https://public.radio.co/stations/'+id+'/status',sig).then(function(j){
        var c=j&&j.current_track;
        return (c&&c.title)?{raw:c.title,art:c.artwork_url_large||c.artwork_url||null}:null;
      });
    }},

   {name:'radioking',
    claim:function(u){ return /radioking/i.test(u.host); },
    run:function(u,st,sig){
      var slug=(u.pathname.match(/\/(?:play|radio)\/([^/]+)/)||[])[1];
      if(!slug)return Promise.resolve(null);
      return getJSON('https://api.radioking.io/widget/radio/'+slug+'/track/current',sig).then(function(j){
        return (j&&j.title)?{raw:j.artist?j.artist+' - '+j.title:j.title,art:j.cover||null}:null;
      });
    }},

   {name:'laut.fm',
    claim:function(u){ return /laut\.fm$/.test(u.host); },
    run:function(u,st,sig){
      var n=u.pathname.replace(/^\//,'').split('/')[0];
      if(!n)return Promise.resolve(null);
      return getJSON('https://api.laut.fm/station/'+n+'/current_song',sig).then(function(j){
        if(!j||!j.title)return null;
        var a=(j.artist&&j.artist.name)?j.artist.name+' - ':'';
        return {raw:a+j.title,art:null};
      });
    }},

   {name:'radiojar',
    claim:function(u){ return /radiojar/i.test(u.host); },
    run:function(u,st,sig){
      var id=u.pathname.replace(/^\//,'').split('/')[0];
      if(!id)return Promise.resolve(null);
      return getJSON('https://www.radiojar.com/api/stations/'+id+'/now_playing/',sig).then(function(j){
        return (j&&j.title)?{raw:(j.artist?j.artist+' - ':'')+j.title,art:j.thumb||null}:null;
      });
    }},

   {name:'triton',
    claim:function(u){ return /streamtheworld|tritondigital/i.test(u.host); },
    run:function(u,st,sig){
      var m=u.pathname.match(/([A-Z0-9_]+(?:AAC|MP3|_SC)?)(?:\.(?:mp3|aac))?$/i);
      if(!m)return Promise.resolve(null);
      return getText('https://np.tritondigital.com/public/nowplaying?mountName='+m[1]
        +'&numberToFetch=1&eventType=track',sig).then(function(x){
        var a=tritonProp(x,'track_artist_name'), t=tritonProp(x,'cue_title');
        return t?{raw:(a?a+' - ':'')+t,art:tritonProp(x,'track_album_art')||null}:null;
      });
    }},

   /* The generic self-hosted pair. Icecast 2.4+ serves status-json.xsl with
      Access-Control-Allow-Origin: * by default, which is why it is worth
      trying on literally everything. */
   {name:'icecast',
    claim:function(){ return true; },
    run:function(u,st,sig){
      return getJSON(u.origin+'/status-json.xsl',sig).then(function(j){
        var src=j&&j.icestats&&j.icestats.source;
        if(!src)return null;
        var arr=Array.isArray(src)?src:[src];
        var mine=arr.filter(function(s){
          return typeof s.listenurl==='string'&&s.listenurl.indexOf(u.pathname)===s.listenurl.length-u.pathname.length;
        })[0]||arr[0];
        if(!mine)return null;
        var raw=['title','yp_currently_playing','song'].map(function(k){return mine[k];})
          .filter(function(v){return typeof v==='string'&&v.trim();})[0];
        return raw?{raw:raw.trim(),art:null}:null;
      });
    }},

   {name:'shoutcast2',
    claim:function(){ return true; },
    run:function(u,st,sig){
      var tries=[u.origin+'/stats?json=1&sid=1',u.origin+'/statistics?json=1'];
      return tries.reduce(function(p,t){
        return p.then(function(hit){
          if(hit)return hit;
          return getJSON(t,sig).then(function(j){
            var raw=(j&&j.songtitle)||deepSong(j);
            return raw?{raw:String(raw).trim(),art:null}:null;
          }).catch(function(){return null;});
        });
      },Promise.resolve(null));
    }},

   /* Last rung: whatever the host serves at a few conventional paths, read
      by SHAPE rather than by name. This is how a platform we have never
      heard of still lights up. */
   {name:'generic',
    claim:function(){ return true; },
    run:function(u,st,sig){
      var tries=[u.origin+'/api/nowplaying',u.origin+'/nowplaying.json',
                 u.origin+'/currentsong?sid=1',u.origin+'/api/live-info'];
      return tries.reduce(function(p,t){
        return p.then(function(hit){
          if(hit)return hit;
          return getText(t,sig).then(function(body){
            var j=null; try{ j=JSON.parse(body); }catch(e){}
            var raw=j?deepSong(j):((body.trim().length>1&&body.length<200)?body.trim():null);
            return raw?{raw:String(raw).trim(),art:j?artOf(j):null}:null;
          }).catch(function(){return null;});
        });
      },Promise.resolve(null));
    }}
  ];

  /* ================= the call the app makes ================= */
  fetchNowPlaying=async function(st,warm){
    var stream=streamOf(st||{});
    if(!stream){ if(!warm)npSource='none'; return {raw:null,art:null}; }

    var u;
    try{ u=new URL(stream.replace(/^http:/,'https:')); }
    catch(e){ if(!warm)npSource='none'; return {raw:null,art:null}; }

    var ac=('AbortController' in window)?new AbortController():null;
    /* A WARM read must never be registered as the cancellable one:
       startTrackWatch calls abortNP() on every station change, which would
       kill the very read meant to make the next station instant. */
    if(ac&&!warm)npAbort=ac;
    var timer=ac?setTimeout(function(){ try{ac.abort();}catch(e){} },NP_TIMEOUT):null;
    var sig=ac?ac.signal:undefined;

    var id=st.stationuuid||stream;
    var won=rungMemo.get(id);
    // once a station has told us which rung answers, stop asking the other eight
    var order=won?RUNGS.filter(function(r){return r.name===won;})
                       .concat(RUNGS.filter(function(r){return r.name!==won;}))
                 :RUNGS;

    try{
      for(var i=0;i<order.length;i++){
        var rung=order[i], claims=false;
        try{ claims=rung.claim(u,st); }catch(e){}
        if(!claims)continue;
        try{
          var hit=await rung.run(u,st,sig);
          if(hit&&hit.raw){
            rungMemo.set(id,rung.name);
            if(!warm){ npSource=rung.name; npDirectArt=hit.art||null; }
            return {raw:normalizeIcy(hit.raw),art:hit.art||null};
          }
        }catch(e){ /* CORS, 404, timeout - all the same: try the next rung */ }
        if(sig&&sig.aborted)break;
      }
    }finally{
      if(timer)clearTimeout(timer);
      if(npAbort===ac)npAbort=null;
    }

    if(won)rungMemo.delete(id);   // it used to answer; let it re-hunt next time
    if(!warm){ npSource='none'; npDirectArt=null; }
    return {raw:null,art:null};
  };
})();
