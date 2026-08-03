/* Smeeche's Lasagna — a first-person Italian-restaurant sim.

   You play Smidge, a majority-black tortoiseshell cat who owns the place. Buy
   crates of ingredients, cook at the stations, run the plates out to the tables
   that ordered them, take the money at the till, and keep the stars up.

   Same engine family as "Your Store" (textured raycaster + box-modelled
   fittings + billboard sprites); the management loop borrows its depth from
   "Pet Vet" — grow the floor, hire a brigade, keep the room clean.

   Classic script, relative paths only: these games are opened straight off disk
   via file:// as well as over http. */
(function(){
  'use strict';
  var clamp=EL.clamp, rnd=EL.rnd, rint=EL.rint, pick=EL.pick;

  // ====================== canvas / engine ======================
  var cv=document.getElementById('game'), ctx=cv.getContext('2d');
  var W=880,H=560,RW=340,RH=216,PLANE=0.7,dpr=1;
  var sceneCanvas=document.createElement('canvas'), sceneCtx=sceneCanvas.getContext('2d');
  var sceneImg=null, buf32=null, zbuf=new Float32Array(RW);
  var TW=64,TH=64,TMASK=63;
  function resize(){
    var r=cv.getBoundingClientRect(); dpr=Math.min(window.devicePixelRatio||1,2);
    var cw=Math.max(2,Math.round((r.width||880)*dpr)), ch=Math.max(2,Math.round((r.height||560)*dpr));
    var MAXW=1200; if(cw>MAXW){ ch=Math.round(ch*MAXW/cw); cw=MAXW; }
    cv.width=cw; cv.height=ch; W=cw; H=ch; PLANE=0.7*(W/H);
    RH=Math.max(2,Math.round(RW*H/W));
    sceneCanvas.width=RW; sceneCanvas.height=RH;
    sceneImg=sceneCtx.createImageData(RW,RH); buf32=new Uint32Array(sceneImg.data.buffer);
    zbuf=new Float32Array(RW); ctx.imageSmoothingEnabled=true;
  }
  window.addEventListener('resize',resize);
  function mkCanvas(w,h){ var c=document.createElement('canvas'); c.width=w; c.height=h; return c; }
  function jitC(hex,f){ var n=parseInt(hex.slice(1),16); var r=(n>>16)&255,g=(n>>8)&255,b=n&255;
    r=clamp(r*f|0,0,255); g=clamp(g*f|0,0,255); b=clamp(b*f|0,0,255); return 'rgb('+r+','+g+','+b+')'; }
  function texData(draw){ var c=mkCanvas(TW,TH), g=c.getContext('2d'); draw(g); return g.getImageData(0,0,TW,TH).data; }
  function grad(g,c0,c1){ var gd=g.createLinearGradient(0,0,0,TH); gd.addColorStop(0,c0); gd.addColorStop(1,c1); g.fillStyle=gd; g.fillRect(0,0,TW,TH); }
  function speck(g,n,base,spread,a){ for(var i=0;i<n;i++){ var s=Math.random();
    g.fillStyle='rgba('+((base[0]+s*spread)|0)+','+((base[1]+s*spread)|0)+','+((base[2]+s*spread)|0)+','+a+')'; g.fillRect((Math.random()*TW)|0,(Math.random()*TH)|0,1,1); } }

  var TEX={
    // trattoria wall: warm cream plaster over an olive-green dado, a hand-painted
    // tricolore stripe and a walnut skirting.
    wall: texData(function(g){
      grad(g,'#f3e6cd','#e6d3b2');
      g.fillStyle='#fbf3e2'; g.fillRect(0,0,TW,5);                                   // cornice
      g.fillStyle='rgba(0,0,0,0.10)'; g.fillRect(0,5,TW,1);
      g.fillStyle='#2f7e4f'; g.fillRect(0,21,TW,2);                                  // tricolore band
      g.fillStyle='#f4efe2'; g.fillRect(0,23,TW,2);
      g.fillStyle='#c8483c'; g.fillRect(0,25,TW,2);
      g.fillStyle='rgba(0,0,0,0.07)'; g.fillRect(0,27,TW,1);
      var wg=g.createLinearGradient(0,34,0,TH); wg.addColorStop(0,'#6f7d54'); wg.addColorStop(1,'#5a6845');
      g.fillStyle=wg; g.fillRect(0,34,TW,TH-34);                                     // olive dado
      for(var px=0;px<TW;px+=16){                                                    // panel seams
        g.fillStyle='rgba(30,38,20,0.30)'; g.fillRect(px,34,1,TH-40);
        g.fillStyle='rgba(255,255,255,0.16)'; g.fillRect(px+1,34,1,TH-40); }
      g.fillStyle='rgba(255,255,255,0.20)'; g.fillRect(0,34,TW,1);
      g.fillStyle='#4a3020'; g.fillRect(0,TH-6,TW,6);                                // skirting
      g.fillStyle='rgba(255,255,255,0.14)'; g.fillRect(0,TH-6,TW,1);
      speck(g,60,[225,205,175],20,0.18); }),
    // terracotta floor tiles with pale grout and a little kiln variation
    floor: texData(function(g){
      var c0='#b5623c', c1='#a45534';
      for(var cy=0;cy<2;cy++) for(var cx=0;cx<2;cx++){
        g.fillStyle=((cx+cy)&1)?c1:c0; g.fillRect(cx*32,cy*32,32,32);
        var hl=g.createLinearGradient(cx*32,cy*32,cx*32+32,cy*32+32);
        hl.addColorStop(0,'rgba(255,225,190,0.14)'); hl.addColorStop(1,'rgba(0,0,0,0.10)');
        g.fillStyle=hl; g.fillRect(cx*32,cy*32,32,32); }
      g.fillStyle='rgba(238,226,200,0.75)';                                          // grout
      g.fillRect(0,0,TW,2); g.fillRect(0,31,TW,2); g.fillRect(0,0,2,TH); g.fillRect(31,0,2,TH);
      speck(g,180,[150,80,50],30,0.22); }),
    // plastered ceiling crossed by dark timber beams, warm bulb between them
    ceil: texData(function(g){
      grad(g,'#efe4cf','#ded1b7');
      var lg=g.createRadialGradient(TW/2,TH/2,2,TW/2,TH/2,22);
      lg.addColorStop(0,'rgba(255,236,190,0.95)'); lg.addColorStop(0.6,'rgba(255,232,180,0.35)'); lg.addColorStop(1,'rgba(255,232,180,0)');
      g.fillStyle=lg; g.fillRect(0,0,TW,TH);                                         // pendant glow
      g.fillStyle='rgba(255,244,215,0.95)'; g.beginPath(); g.arc(TW/2,TH/2,5,0,7); g.fill();
      g.fillStyle='#4a3524'; g.fillRect(0,0,TW,7);                                   // beam
      g.fillStyle='rgba(255,255,255,0.12)'; g.fillRect(0,0,TW,1);
      g.fillStyle='rgba(0,0,0,0.22)'; g.fillRect(0,7,TW,2);
      speck(g,40,[235,225,205],12,0.25); }),
    // green-painted door with glass, brass handles and an APERTO sign
    door: texData(function(g){
      g.fillStyle='#2f4a34'; g.fillRect(0,0,TW,TH);                                  // frame
      var gl=g.createLinearGradient(0,0,TW,TH); gl.addColorStop(0,'#cfe8f2'); gl.addColorStop(0.5,'#8fb6c4'); gl.addColorStop(1,'#b0d4e0');
      g.fillStyle=gl; g.fillRect(6,4,TW-12,TH-10);                                   // glass
      g.fillStyle='#24382a'; g.fillRect(TW/2-2,4,4,TH-10);                           // mullion
      g.fillStyle='rgba(255,255,255,0.42)'; g.beginPath();                           // reflection
      g.moveTo(12,8); g.lineTo(22,8); g.lineTo(13,TH-8); g.lineTo(9,TH-8); g.closePath(); g.fill();
      g.fillStyle='rgba(255,255,255,0.22)'; g.beginPath();
      g.moveTo(TW/2+6,8); g.lineTo(TW/2+14,8); g.lineTo(TW/2+8,30); g.lineTo(TW/2+4,30); g.closePath(); g.fill();
      g.fillStyle='#caa14a'; g.fillRect(TW/2-12,18,5,28); g.fillRect(TW/2+7,18,5,28); // brass handles
      g.fillStyle='#c8483c'; g.fillRect(TW/2-17,6,34,12);
      g.fillStyle='#fff'; g.font='900 8px sans-serif'; g.textAlign='center'; g.fillText('APERTO',TW/2,15);
      g.fillStyle='#6a4426'; g.fillRect(4,TH-6,TW-8,6); })                            // mat
  };

  // ====================== ingredients ======================
  // Eight crates cover the whole menu — deliberately few, so a young player can
  // hold the whole pantry in their head.
  var ING={
    pasta:  { name:'Pasta',        emo:'🍝', col:'#e3c579', crate:12, cost:18 },
    cheese: { name:'Cheese',       emo:'🧀', col:'#f3e2a8', crate:10, cost:22 },
    tomato: { name:'Tomatoes',     emo:'🍅', col:'#cc3a2c', crate:12, cost:16 },
    meat:   { name:'Meat',         emo:'🥩', col:'#a8443c', crate:8,  cost:26 },
    veg:    { name:'Veg & Herbs',  emo:'🌿', col:'#4f8f42', crate:12, cost:17 },
    dough:  { name:'Dough',        emo:'🫓', col:'#e4cb9c', crate:10, cost:16 },
    sweet:  { name:'Sugar & Cream',emo:'🍮', col:'#f0dce4', crate:10, cost:20 },
    coffee: { name:'Coffee Beans', emo:'☕', col:'#4a2c18', crate:10, cost:22 }
  };
  var ING_KEYS=Object.keys(ING);
  function recStr(rec){ return ING_KEYS.filter(function(k){ return rec[k]; })
    .map(function(k){ return ING[k].emo+(rec[k]>1?'×'+rec[k]:''); }).join(' '); }
  function recCost(rec){ var c=0; ING_KEYS.forEach(function(k){ if(rec[k]) c+=rec[k]*ING[k].cost/ING[k].crate; }); return c; }

  // ====================== the kitchen stations ======================
  var STATIONS={
    stove: { name:'Stove Range',       emo:'🍳' },
    oven:  { name:'Lasagna Oven',      emo:'🔥' },
    pizza: { name:'Wood-Fired Oven',   emo:'🍕' },
    cold:  { name:'Antipasti Counter', emo:'🥗' },
    dolci: { name:'Dolci Case',        emo:'🍰' },
    bar:   { name:'Espresso Bar',      emo:'☕' }
  };

  // ====================== the menu ======================
  // Every dish: which station cooks it, what it eats out of the pantry, how long
  // it takes, and what it goes out at. `price` is live — the Menu tab edits it,
  // and `base` stays put so reviews can judge your markup.
  function plate(g,s,rim){
    g.fillStyle='rgba(0,0,0,0.16)'; g.beginPath(); g.ellipse(s*0.5,s*0.64,s*0.36,s*0.11,0,0,7); g.fill();
    g.fillStyle='#faf7ef'; g.beginPath(); g.ellipse(s*0.5,s*0.6,s*0.37,s*0.19,0,0,7); g.fill();
    g.fillStyle=rim||'#e6dfcd'; g.beginPath(); g.ellipse(s*0.5,s*0.585,s*0.28,s*0.14,0,0,7); g.fill(); }
  function mound(g,s,col,w,h,yy){ g.fillStyle=col; g.beginPath(); g.ellipse(s*0.5,s*(yy||0.55),s*w,s*h,0,0,7); g.fill(); }
  function noodles(g,s,col){ g.strokeStyle=col; g.lineWidth=s*0.026; g.lineCap='round';
    for(var i=0;i<7;i++){ var a=i*0.9; g.beginPath();
      g.moveTo(s*(0.34+i*0.045), s*0.52);
      g.quadraticCurveTo(s*(0.36+i*0.045+Math.sin(a)*0.05), s*(0.62+Math.cos(a)*0.03), s*(0.4+i*0.04), s*0.585);
      g.stroke(); } }
  function herb(g,s,n){ g.fillStyle='#3f8f3a'; for(var i=0;i<(n||4);i++){
    g.beginPath(); g.ellipse(s*(0.38+i*0.07), s*(0.5+((i%2)?0.05:0)), s*0.028, s*0.017, i*0.7,0,7); g.fill(); } }

  var DISHES={
    // ---- oven: the baked heart of the place ----
    lasagna:   { name:"Smidge's Lasagna", st:'oven', rec:{pasta:2,cheese:1,meat:1,tomato:1}, cook:9, price:19, signature:true,
      draw:function(g,s){ plate(g,s,'#e8dcc0');
        g.fillStyle='#8f2f26'; g.fillRect(s*0.3,s*0.44,s*0.4,s*0.15);                 // ragù slab
        g.fillStyle='#e6c98a'; g.fillRect(s*0.3,s*0.47,s*0.4,s*0.022);                // pasta layers
        g.fillStyle='#e6c98a'; g.fillRect(s*0.3,s*0.525,s*0.4,s*0.022);
        g.fillStyle='#f7e9b8'; g.fillRect(s*0.3,s*0.418,s*0.4,s*0.03);                // molten top
        g.fillStyle='#caa14a'; g.fillRect(s*0.3,s*0.412,s*0.4,s*0.012);
        herb(g,s,3); } },
    ziti:      { name:'Baked Ziti', st:'oven', rec:{pasta:2,cheese:1,tomato:1}, cook:8, price:15,
      draw:function(g,s){ plate(g,s); mound(g,s,'#c05233',0.24,0.11,0.53);
        g.fillStyle='#f2e0a6'; for(var i=0;i<5;i++){ g.fillRect(s*(0.35+i*0.06), s*0.48, s*0.035, s*0.05); } mound(g,s,'#f7e9b8',0.2,0.05,0.475); } },
    parmigiana:{ name:'Melanzane Parmigiana', st:'oven', rec:{veg:2,cheese:1,tomato:1}, cook:8, price:15,
      draw:function(g,s){ plate(g,s); mound(g,s,'#6d3f8c',0.23,0.1,0.54); mound(g,s,'#b8342a',0.19,0.075,0.505);
        mound(g,s,'#f7e9b8',0.15,0.05,0.475); herb(g,s,3); } },
    cannelloni:{ name:'Cannelloni', st:'oven', rec:{pasta:2,cheese:1,veg:1}, cook:8, price:16,
      draw:function(g,s){ plate(g,s); g.fillStyle='#f0e7c6';
        for(var i=0;i<3;i++){ g.beginPath(); g.ellipse(s*(0.4+i*0.1), s*0.53, s*0.045, s*0.075, 0,0,7); g.fill(); }
        mound(g,s,'#c05233',0.2,0.04,0.6); herb(g,s,3); } },
    // ---- stove: the everyday pans ----
    spaghetti: { name:'Spaghetti Bolognese', st:'stove', rec:{pasta:1,meat:1,tomato:1}, cook:6, price:13,
      draw:function(g,s){ plate(g,s); mound(g,s,'#e8cf8e',0.22,0.1,0.55); noodles(g,s,'#d4b56a');
        mound(g,s,'#9c2f22',0.13,0.06,0.52); herb(g,s,3); } },
    carbonara: { name:'Carbonara', st:'stove', rec:{pasta:1,cheese:1,meat:1}, cook:6, price:14,
      draw:function(g,s){ plate(g,s); mound(g,s,'#f2e0a2',0.22,0.1,0.55); noodles(g,s,'#e0c87e');
        g.fillStyle='#c9705a'; for(var i=0;i<5;i++) g.fillRect(s*(0.38+i*0.055), s*(0.5+(i%2)*0.04), s*0.03, s*0.02);
        g.fillStyle='#3a3a3a'; for(var j=0;j<8;j++) g.fillRect(s*(0.36+j*0.036), s*(0.53+(j%3)*0.02), s*0.008, s*0.008); } },
    pesto:     { name:'Pesto Trofie', st:'stove', rec:{pasta:1,veg:1,cheese:1}, cook:5, price:12,
      draw:function(g,s){ plate(g,s); mound(g,s,'#5f8f3a',0.22,0.1,0.55); noodles(g,s,'#7fae55');
        g.fillStyle='#e8e0b0'; for(var i=0;i<6;i++) g.fillRect(s*(0.37+i*0.045), s*(0.5+(i%2)*0.05), s*0.016, s*0.016); } },
    risotto:   { name:'Risotto ai Funghi', st:'stove', rec:{veg:2,cheese:1}, cook:7, price:14,
      draw:function(g,s){ plate(g,s); mound(g,s,'#efe3c0',0.25,0.11,0.55);
        g.fillStyle='#8a6a48'; for(var i=0;i<4;i++){ g.beginPath(); g.ellipse(s*(0.4+i*0.07), s*0.53, s*0.03,s*0.02,0,0,7); g.fill(); } herb(g,s,3); } },
    gnocchi:   { name:'Gnocchi al Pomodoro', st:'stove', rec:{dough:1,tomato:1,cheese:1}, cook:6, price:12,
      draw:function(g,s){ plate(g,s); mound(g,s,'#b8342a',0.23,0.1,0.55);
        g.fillStyle='#f4ead0'; for(var i=0;i<6;i++){ g.beginPath(); g.ellipse(s*(0.37+ (i%3)*0.08), s*(0.51+((i/3)|0)*0.045), s*0.032,s*0.024,0,0,7); g.fill(); } herb(g,s,3); } },
    minestrone:{ name:'Minestrone', st:'stove', rec:{veg:2,tomato:1}, cook:5, price:9,
      draw:function(g,s){ plate(g,s,'#dcd4bd'); mound(g,s,'#b8482c',0.24,0.115,0.55);
        g.fillStyle='#5f9f45'; for(var i=0;i<5;i++) g.fillRect(s*(0.38+i*0.05), s*(0.52+(i%2)*0.03), s*0.022, s*0.022);
        g.fillStyle='#e8c060'; for(var j=0;j<4;j++) g.fillRect(s*(0.42+j*0.05), s*0.56, s*0.018, s*0.018); } },
    // ---- wood-fired oven ----
    margherita:{ name:'Pizza Margherita', st:'pizza', rec:{dough:1,tomato:1,cheese:1}, cook:5, price:12,
      draw:function(g,s){ g.fillStyle='rgba(0,0,0,0.16)'; g.beginPath(); g.ellipse(s*0.5,s*0.63,s*0.34,s*0.1,0,0,7); g.fill();
        g.fillStyle='#e3bd7d'; g.beginPath(); g.ellipse(s*0.5,s*0.57,s*0.36,s*0.19,0,0,7); g.fill();
        g.fillStyle='#c8483c'; g.beginPath(); g.ellipse(s*0.5,s*0.565,s*0.3,s*0.155,0,0,7); g.fill();
        g.fillStyle='#f7f0dc'; for(var i=0;i<6;i++){ var a=i*1.05;
          g.beginPath(); g.ellipse(s*(0.5+Math.cos(a)*0.17), s*(0.565+Math.sin(a)*0.085), s*0.045,s*0.028,0,0,7); g.fill(); }
        herb(g,s,4); } },
    diavola:   { name:'Pizza Diavola', st:'pizza', rec:{dough:1,tomato:1,cheese:1,meat:1}, cook:6, price:15,
      draw:function(g,s){ DISHES.margherita.draw(g,s);
        g.fillStyle='#a3271f'; for(var i=0;i<5;i++){ var a=i*1.25+0.4;
          g.beginPath(); g.ellipse(s*(0.5+Math.cos(a)*0.16), s*(0.565+Math.sin(a)*0.08), s*0.04,s*0.026,0,0,7); g.fill(); } } },
    focaccia:  { name:'Focaccia & Oil', st:'pizza', rec:{dough:1,veg:1}, cook:3, price:6,
      draw:function(g,s){ plate(g,s); g.fillStyle='#e0be7c'; g.fillRect(s*0.32,s*0.47,s*0.36,s*0.13);
        g.fillStyle='#c9a25c'; for(var i=0;i<5;i++) g.fillRect(s*(0.35+i*0.065), s*0.5, s*0.02, s*0.02);
        g.fillStyle='rgba(120,160,40,0.5)'; g.fillRect(s*0.32,s*0.47,s*0.36,s*0.03); herb(g,s,3); } },
    calzone:   { name:'Calzone', st:'pizza', rec:{dough:1,cheese:1,meat:1}, cook:6, price:14,
      draw:function(g,s){ plate(g,s); g.fillStyle='#e0bd7e';
        g.beginPath(); g.moveTo(s*0.3,s*0.6); g.quadraticCurveTo(s*0.5,s*0.34,s*0.7,s*0.6); g.closePath(); g.fill();
        g.strokeStyle='#c39a58'; g.lineWidth=s*0.016; g.beginPath(); g.moveTo(s*0.3,s*0.6); g.lineTo(s*0.7,s*0.6); g.stroke();
        g.fillStyle='#caa14a'; for(var i=0;i<4;i++) g.fillRect(s*(0.4+i*0.06), s*0.47, s*0.03, s*0.012); } },
    // ---- antipasti counter (no heat, quick) ----
    bruschetta:{ name:'Bruschetta', st:'cold', rec:{dough:1,tomato:1,veg:1}, cook:2, price:7,
      draw:function(g,s){ plate(g,s); g.fillStyle='#dcb878';
        g.fillRect(s*0.3,s*0.5,s*0.17,s*0.08); g.fillRect(s*0.53,s*0.5,s*0.17,s*0.08);
        g.fillStyle='#c8483c'; g.fillRect(s*0.31,s*0.475,s*0.15,s*0.032); g.fillRect(s*0.54,s*0.475,s*0.15,s*0.032); herb(g,s,4); } },
    caprese:   { name:'Insalata Caprese', st:'cold', rec:{veg:1,cheese:1,tomato:1}, cook:2, price:9,
      draw:function(g,s){ plate(g,s);
        for(var i=0;i<4;i++){ g.fillStyle='#f7f2e2'; g.beginPath(); g.ellipse(s*(0.36+i*0.09), s*0.53, s*0.045,s*0.032,0,0,7); g.fill();
          g.fillStyle='#c8483c'; g.beginPath(); g.ellipse(s*(0.4+i*0.09), s*0.545, s*0.042,s*0.03,0,0,7); g.fill(); } herb(g,s,4); } },
    antipasto: { name:'Antipasto Misto', st:'cold', rec:{meat:1,cheese:1,veg:1}, cook:3, price:11,
      draw:function(g,s){ plate(g,s,'#ded6c0');
        g.fillStyle='#c9705a'; for(var i=0;i<3;i++){ g.beginPath(); g.ellipse(s*(0.36+i*0.06), s*0.52, s*0.04,s*0.028,0,0,7); g.fill(); }
        g.fillStyle='#f0e2a8'; g.fillRect(s*0.56,s*0.5,s*0.06,s*0.06); g.fillRect(s*0.63,s*0.53,s*0.05,s*0.05);
        g.fillStyle='#4f7a2a'; for(var j=0;j<3;j++){ g.beginPath(); g.arc(s*(0.42+j*0.07), s*0.59, s*0.018,0,7); g.fill(); } } },
    // ---- dolci ----
    tiramisu:  { name:'Tiramisù', st:'dolci', rec:{sweet:1,coffee:1,cheese:1}, cook:3, price:8,
      draw:function(g,s){ plate(g,s); g.fillStyle='#f4e7cf'; g.fillRect(s*0.35,s*0.45,s*0.3,s*0.14);
        g.fillStyle='#6b4326'; g.fillRect(s*0.35,s*0.49,s*0.3,s*0.03); g.fillRect(s*0.35,s*0.55,s*0.3,s*0.025);
        g.fillStyle='#3a2414'; g.fillRect(s*0.35,s*0.435,s*0.3,s*0.02);
        g.fillStyle='#f7f0e2'; g.fillRect(s*0.4,s*0.42,s*0.05,s*0.012); } },
    cannoli:   { name:'Cannoli', st:'dolci', rec:{dough:1,sweet:1,cheese:1}, cook:3, price:7,
      draw:function(g,s){ plate(g,s); g.save(); g.translate(s*0.5,s*0.53); g.rotate(-0.25);
        g.fillStyle='#c98f4e'; g.fillRect(-s*0.16,-s*0.05,s*0.32,s*0.1);
        g.fillStyle='#f7f0e0'; g.beginPath(); g.ellipse(-s*0.16,0,s*0.028,s*0.05,0,0,7); g.fill();
        g.beginPath(); g.ellipse(s*0.16,0,s*0.028,s*0.05,0,0,7); g.fill();
        g.fillStyle='#7a4a2a'; g.fillRect(-s*0.1,-s*0.05,s*0.02,s*0.1); g.fillRect(s*0.05,-s*0.05,s*0.02,s*0.1); g.restore(); } },
    gelato:    { name:'Gelato', st:'dolci', rec:{sweet:1}, cook:1, price:5,
      draw:function(g,s){ plate(g,s);
        g.fillStyle='#f2d0e0'; g.beginPath(); g.arc(s*0.43,s*0.5,s*0.07,0,7); g.fill();
        g.fillStyle='#d9e8c8'; g.beginPath(); g.arc(s*0.57,s*0.5,s*0.07,0,7); g.fill();
        g.fillStyle='#f7f0e0'; g.beginPath(); g.arc(s*0.5,s*0.44,s*0.065,0,7); g.fill();
        g.fillStyle='#c98f4e'; g.fillRect(s*0.6,s*0.4,s*0.02,s*0.14); } },
    // ---- espresso bar ----
    espresso:  { name:'Espresso', st:'bar', rec:{coffee:1}, cook:2, price:4,
      draw:function(g,s){ plate(g,s,'#ded6c0');
        g.fillStyle='#f7f4ec'; g.fillRect(s*0.4,s*0.42,s*0.2,s*0.16);
        g.fillStyle='#3a2414'; g.fillRect(s*0.42,s*0.44,s*0.16,s*0.05);
        g.strokeStyle='#f7f4ec'; g.lineWidth=s*0.022; g.beginPath(); g.arc(s*0.63,s*0.5,s*0.045,-1.1,1.1); g.stroke(); } },
    affogato:  { name:'Affogato', st:'bar', rec:{coffee:1,sweet:1}, cook:2, price:6,
      draw:function(g,s){ plate(g,s,'#ded6c0');
        g.fillStyle='#e8e4dc'; g.beginPath(); g.moveTo(s*0.4,s*0.42); g.lineTo(s*0.6,s*0.42); g.lineTo(s*0.56,s*0.6); g.lineTo(s*0.44,s*0.6); g.closePath(); g.fill();
        g.fillStyle='#f7f0e0'; g.beginPath(); g.arc(s*0.5,s*0.43,s*0.065,0,7); g.fill();
        g.fillStyle='#4a2c18'; g.beginPath(); g.ellipse(s*0.5,s*0.45,s*0.055,s*0.022,0,0,7); g.fill(); } }
  };
  var DISH_KEYS=Object.keys(DISHES);
  DISH_KEYS.forEach(function(k){ DISHES[k].key=k; DISHES[k].base=DISHES[k].price; DISHES[k].cost=recCost(DISHES[k].rec); });

  function dishIcon(k,s){ var c=mkCanvas(s,s), g=c.getContext('2d'); DISHES[k].draw(g,s); return c; }
  function ingIcon(k,s){ var c=mkCanvas(s,s), g=c.getContext('2d'), o=ING[k];
    g.fillStyle='#b98a52'; g.fillRect(s*0.12,s*0.3,s*0.76,s*0.55);                    // crate
    g.fillStyle='#a0743f'; g.fillRect(s*0.12,s*0.3,s*0.76,s*0.1);
    g.strokeStyle='#7c5526'; g.lineWidth=Math.max(1,s*0.04); g.strokeRect(s*0.12,s*0.3,s*0.76,s*0.55);
    g.fillStyle=o.col; g.beginPath(); g.arc(s*0.5,s*0.55,s*0.19,0,7); g.fill();
    g.fillStyle='rgba(255,255,255,0.25)'; g.beginPath(); g.arc(s*0.44,s*0.49,s*0.07,0,7); g.fill();
    return c; }
  var DICON={}, IICON={};
  DISH_KEYS.forEach(function(k){ DICON[k]=dishIcon(k,44); });
  ING_KEYS.forEach(function(k){ IICON[k]=ingIcon(k,44); });

  // ====================== fittings ======================
  // kinds: till | table | store | station | decor | restroom | wall | chair
  var FURNITURE={
    till:{ kind:'till', name:'Till', desc:'Required — put this in first', cost:40, color:'#7a4a2a', topZ:0.62,
      boxes:[ {x0:-0.42,y0:-0.16,x1:0.42,y1:0.18,z0:0,z1:0.44,col:'#7a4a2a'},
              {x0:-0.44,y0:-0.18,x1:0.44,y1:0.20,z0:0.44,z1:0.50,col:'#9a6a3c'},
              {x0:0.08,y0:-0.08,x1:0.30,y1:0.06,z0:0.50,z1:0.62,col:'#2a2a33'} ] },

    table2:{ kind:'table', seats:2, seatR:0.82, name:'Table for Two', desc:'Two covers · red-check cloth', cost:70, color:'#c8483c', topZ:0.42,
      boxes:[ {x0:-0.30,y0:-0.30,x1:0.30,y1:0.30,z0:0.36,z1:0.42,col:'#c8483c'},
              {x0:-0.07,y0:-0.07,x1:0.07,y1:0.07,z0:0,z1:0.36,col:'#6a4426'} ] },
    table4:{ kind:'table', seats:4, seatR:0.98, name:'Table for Four', desc:'Four covers · families sit here', cost:110, color:'#c8483c', topZ:0.44,
      boxes:[ {x0:-0.46,y0:-0.32,x1:0.46,y1:0.32,z0:0.38,z1:0.44,col:'#c8483c'},
              {x0:-0.40,y0:-0.26,x1:-0.32,y1:-0.18,z0:0,z1:0.38,col:'#6a4426'},
              {x0:0.32,y0:-0.26,x1:0.40,y1:-0.18,z0:0,z1:0.38,col:'#6a4426'},
              {x0:-0.40,y0:0.18,x1:-0.32,y1:0.26,z0:0,z1:0.38,col:'#6a4426'},
              {x0:0.32,y0:0.18,x1:0.40,y1:0.26,z0:0,z1:0.38,col:'#6a4426'} ] },
    booth:{ kind:'table', seats:4, seatR:0.92, prem:3, name:'Corner Booth', desc:'Four covers · velvet, and people linger', cost:230, color:'#6d2a3a', topZ:0.44,
      boxes:[ {x0:-0.44,y0:-0.30,x1:0.44,y1:0.30,z0:0.38,z1:0.44,col:'#8a3346'},
              {x0:-0.10,y0:-0.10,x1:0.10,y1:0.10,z0:0,z1:0.38,col:'#4a2a18'},
              {x0:-0.48,y0:-0.46,x1:0.48,y1:-0.32,z0:0,z1:0.78,col:'#6d2a3a'},
              {x0:-0.48,y0:0.32,x1:0.48,y1:0.46,z0:0,z1:0.78,col:'#6d2a3a'} ] },

    fridge:{ kind:'store', cap:26, name:'Fridge', desc:'Cold store — 26 units of ingredients', cost:95, color:'#b9c2ca', topZ:0.98,
      boxes:[ {x0:-0.34,y0:0.02,x1:0.34,y1:0.26,z0:0,z1:0.98,col:'#b9c2ca'},
              {x0:-0.36,y0:0.00,x1:0.36,y1:0.04,z0:0,z1:0.98,col:'#8f9aa6'},
              {x0:0.20,y0:-0.03,x1:0.28,y1:0.02,z0:0.42,z1:0.72,col:'#5a6470'} ] },
    pantry:{ kind:'store', cap:40, name:'Pantry Shelf', desc:'Dry store — 40 units, deliveries land here first', cost:130, color:'#8a5f34', topZ:1.0,
      boxes:[ {x0:-0.44,y0:0.02,x1:0.44,y1:0.24,z0:0,z1:1.0,col:'#8a5f34'},
              {x0:-0.46,y0:0.00,x1:0.46,y1:0.26,z0:0.30,z1:0.35,col:'#69471f'},
              {x0:-0.46,y0:0.00,x1:0.46,y1:0.26,z0:0.64,z1:0.69,col:'#69471f'} ] },

    stove:{ kind:'station', st:'stove', name:'Stove Range', desc:'Pasta, risotto, soup', cost:180, color:'#4a5058', topZ:0.56,
      boxes:[ {x0:-0.40,y0:-0.02,x1:0.40,y1:0.28,z0:0,z1:0.50,col:'#4a5058'},
              {x0:-0.42,y0:-0.04,x1:0.42,y1:0.30,z0:0.50,z1:0.56,col:'#22262c'},
              {x0:-0.42,y0:0.16,x1:0.42,y1:0.30,z0:0.56,z1:0.92,col:'#3a4048'} ] },
    oven:{ kind:'station', st:'oven', name:'Lasagna Oven', desc:'The one that makes the name — bakes lasagna', cost:280, color:'#8a3b2c', topZ:0.72,
      boxes:[ {x0:-0.40,y0:0.00,x1:0.40,y1:0.30,z0:0,z1:0.66,col:'#8a3b2c'},
              {x0:-0.42,y0:-0.02,x1:0.42,y1:0.32,z0:0.66,z1:0.72,col:'#5f2418'},
              {x0:-0.26,y0:-0.05,x1:0.26,y1:0.00,z0:0.16,z1:0.46,col:'#ffb35a'} ] },
    pizzaoven:{ kind:'station', st:'pizza', prem:2, name:'Wood-Fired Oven', desc:'Pizza and calzone · a proper brick dome', cost:340, color:'#a35a3c', topZ:1.0,
      boxes:[ {x0:-0.44,y0:0.00,x1:0.44,y1:0.34,z0:0,z1:0.34,col:'#7a4a2a'},
              {x0:-0.40,y0:0.02,x1:0.40,y1:0.32,z0:0.34,z1:0.86,col:'#a35a3c'},
              {x0:-0.28,y0:0.06,x1:0.28,y1:0.28,z0:0.86,z1:1.0,col:'#8a4830'},
              {x0:-0.18,y0:-0.03,x1:0.18,y1:0.02,z0:0.40,z1:0.68,col:'#ffb35a'} ] },
    antipasti:{ kind:'station', st:'cold', name:'Antipasti Counter', desc:'Bruschetta, caprese, misto — quick and cold', cost:150, color:'#7fa6b8', topZ:0.62,
      boxes:[ {x0:-0.42,y0:0.02,x1:0.42,y1:0.26,z0:0,z1:0.34,col:'#4a5a66'},
              {x0:-0.40,y0:0.04,x1:0.40,y1:0.24,z0:0.34,z1:0.56,col:'#a8d0e0'},
              {x0:-0.42,y0:0.02,x1:0.42,y1:0.26,z0:0.56,z1:0.62,col:'#4a5a66'} ] },
    dolcicase:{ kind:'station', st:'dolci', prem:1, name:'Dolci Case', desc:'Tiramisù, cannoli, gelato', cost:190, color:'#caa14a', topZ:0.72,
      boxes:[ {x0:-0.38,y0:0.02,x1:0.38,y1:0.26,z0:0,z1:0.26,col:'#5a3a20'},
              {x0:-0.36,y0:0.04,x1:0.36,y1:0.24,z0:0.26,z1:0.64,col:'#ffe9b0'},
              {x0:-0.38,y0:0.02,x1:0.38,y1:0.26,z0:0.64,z1:0.72,col:'#caa14a'} ] },
    espressobar:{ kind:'station', st:'bar', prem:1, name:'Espresso Bar', desc:'Espresso and affogato · fast money', cost:170, color:'#3a2a20', topZ:0.86,
      boxes:[ {x0:-0.40,y0:0.04,x1:0.40,y1:0.26,z0:0,z1:0.46,col:'#3a2a20'},
              {x0:-0.42,y0:0.02,x1:0.42,y1:0.28,z0:0.46,z1:0.52,col:'#6a4426'},
              {x0:-0.22,y0:0.06,x1:0.22,y1:0.24,z0:0.52,z1:0.86,col:'#c0c6cc'} ] },

    winerack:{ kind:'decor', prem:2, name:'Wine Rack', desc:'Dusty bottles · the room feels grown-up', cost:120, color:'#5a3a20', topZ:1.0,
      boxes:[ {x0:-0.36,y0:0.06,x1:0.36,y1:0.24,z0:0,z1:1.0,col:'#5a3a20'},
              {x0:-0.34,y0:0.04,x1:0.34,y1:0.10,z0:0.24,z1:0.32,col:'#2f4a34'},
              {x0:-0.34,y0:0.04,x1:0.34,y1:0.10,z0:0.56,z1:0.64,col:'#6d2a3a'} ] },
    olivetree:{ kind:'decor', prem:1, name:'Olive Tree', desc:'A pot of green in the corner', cost:70, color:'#5f7a3a', topZ:1.1,
      boxes:[ {x0:-0.16,y0:-0.16,x1:0.16,y1:0.16,z0:0,z1:0.26,col:'#a35a3c'},
              {x0:-0.05,y0:-0.05,x1:0.05,y1:0.05,z0:0.26,z1:0.68,col:'#6a5a3a'},
              {x0:-0.26,y0:-0.26,x1:0.26,y1:0.26,z0:0.68,z1:1.1,col:'#5f7a3a'} ] },
    mandolin:{ kind:'decor', prem:4, music:true, name:'Mandolin Corner', desc:'Live music — diners linger and tip the stars up', cost:300, color:'#8a5a2a', topZ:0.7,
      boxes:[ {x0:-0.40,y0:-0.30,x1:0.40,y1:0.30,z0:0,z1:0.18,col:'#6a4426'},
              {x0:-0.12,y0:-0.10,x1:0.12,y1:0.10,z0:0.18,z1:0.52,col:'#8a5a2a'},
              {x0:-0.06,y0:-0.04,x1:0.06,y1:0.04,z0:0.52,z1:0.70,col:'#caa14a'} ] },
    restroom:{ kind:'restroom', name:'Restroom', desc:'Diners need one — and it gets grubby', cost:130, color:'#7fc4d8', topZ:0.9,
      boxes:[ {x0:-0.44,y0:-0.30,x1:0.44,y1:0.30,z0:0,z1:0.9,col:'#bfe4ee'},
              {x0:-0.44,y0:-0.32,x1:0.44,y1:-0.26,z0:0,z1:0.9,col:'#7fc4d8'},
              {x0:-0.10,y0:-0.34,x1:0.10,y1:-0.30,z0:0.35,z1:0.55,col:'#2a3340'} ] },
    stool:{ kind:'chair', name:'Kitchen Stool', desc:'Somewhere to perch — staff work +8% faster (up to 4)', cost:45, color:'#b06a3c', topZ:0.5,
      boxes:[ {x0:-0.16,y0:-0.16,x1:0.16,y1:0.16,z0:0.26,z1:0.32,col:'#b06a3c'},
              {x0:-0.12,y0:-0.12,x1:-0.07,y1:-0.07,z0:0,z1:0.26,col:'#6a3c20'},
              {x0:0.07,y0:-0.12,x1:0.12,y1:-0.07,z0:0,z1:0.26,col:'#6a3c20'},
              {x0:-0.12,y0:0.07,x1:-0.07,y1:0.12,z0:0,z1:0.26,col:'#6a3c20'},
              {x0:0.07,y0:0.07,x1:0.12,y1:0.12,z0:0,z1:0.26,col:'#6a3c20'} ] },
    wall:{ kind:'wall', name:'Wall Section', desc:'Split the room — $30 a square', cost:30, color:'#8a92a4', topZ:1.0,
      boxes:[ {x0:-0.5,y0:-0.18,x1:0.5,y1:0.18,z0:0,z1:1.0,col:'#d8c9a8'},
              {x0:-0.5,y0:-0.20,x1:0.5,y1:0.20,z0:0.96,z1:1.0,col:'#a8956f'} ] }
  };
  var FURN_ORDER=['till','table2','table4','booth','fridge','pantry','stove','oven','pizzaoven',
                  'antipasti','dolcicase','espressobar','winerack','olivetree','mandolin','restroom','stool','wall'];
  var STATION_MAX_PLATES=2;

  // ====================== map / floor ======================
  var mapW=20,mapH=16, map=[], doorPt={x:9.5,y:14.5};
  var WORLD_W=20, WORLD_H=16, BASE_X0=6, BASE_Y0=10;   // base dining room: x 6..12, y 10..14
  var carved=[];                                       // ["x,y"] squares bought beyond the base room
  function baseFloor(x,y){ return x>=BASE_X0&&x<BASE_X0+7&&y>=BASE_Y0&&y<BASE_Y0+5; }
  function rebuildMap(){
    mapW=WORLD_W; mapH=WORLD_H; map=[];
    for(var y=0;y<mapH;y++){ var row=[]; for(var x=0;x<mapW;x++){ row.push(baseFloor(x,y)?0:1); } map.push(row); }
    carved.forEach(function(k){ var pp=k.split(','), x=+pp[0], yy=+pp[1];
      if(x>0&&yy>0&&x<mapW-1&&yy<mapH-1) map[yy][x]=0; });
    var dx=BASE_X0+3; map[mapH-1][dx]=2; doorPt={ x:dx+0.5, y:mapH-1.5 };
  }
  function floorArea(){ return 35+carved.length; }
  function mapAt(x,y){ var ix=Math.floor(x), iy=Math.floor(y); if(ix<0||iy<0||ix>=mapW||iy>=mapH) return 1; return map[iy][ix]; }
  function wallTex(v){ return v===2?TEX.door:TEX.wall; }

  // ====================== state ======================
  var money=0, covers=0, gstate='start';
  var px=9.5,py=13.0,dir=-Math.PI/2, dirX=0,dirY=-1, planeX=PLANE,planeY=0, cx2=9.5,cy2=13.0;
  var placed=[];        // fittings on the floor
  var till=null;        // reference to the placed till
  var floorCrates=[];   // {ing,count,x,y} delivered by the door
  var carrying=null;    // {type:'crate',ing,count} | {type:'plate',dish}
  var diners=[];
  var placing=null;     // {fkey,rot} | {carve:true}
  var ghostX=9.5, ghostY=12.5;
  var employees=[];     // {role,x,y,img,...}
  var wageT=30;
  var spawnT=0, toastT=0, tableSeq=1;
  var messes=[];                 // [{x,y}] spills on the floor
  var ING_TARGETS={};            // ingredient key -> desired stock (the purchaser tops up to this)
  var menuOn={};                 // dish key -> served today?
  var special=null, specialT=0, specialCd=0;
  var RIVAL_MARKUP=1.14;         // the rival trattoria runs a 14% margin over cost
  var reviews=[], ratingSum=0, ratingCount=0, rival=4.0;

  function reset(){
    carved.length=0; rebuildMap();
    money=600; covers=0; placed=[]; till=null; floorCrates=[]; carrying=null; diners=[]; placing=null; employees=[]; wageT=30;
    // A fresh kitchen opens on 3.0 stars (five seed "word of mouth" reviews) —
    // traffic then follows the rating: y = 5x diners per minute.
    reviews=[{stars:3,text:'New place on the corner. Promising — that lasagna smells incredible.'}];
    ratingSum=15; ratingCount=5; rival=4.0; spawnT=5; tableSeq=1;
    saleC=null; document.getElementById('cashOv').hidden=true; document.getElementById('ordOv').hidden=true;
    messes.length=0; ING_TARGETS={}; special=null; specialT=0; specialCd=0;
    menuOn={}; DISH_KEYS.forEach(function(k){ menuOn[k]=true; DISHES[k].price=DISHES[k].base; });
    px=(mapW/2); py=mapH-2.2; dir=-Math.PI/2; updateCamera(); refreshHUD();
  }
  function avgRating(){ return ratingCount? (ratingSum/ratingCount) : 0; }

  // ====================== save / load (named slots + autosave) ======================
  var SLOTS_KEY='smeeches.slots';
  function buildSaveData(){
    var prices={}; DISH_KEYS.forEach(function(k){ prices[k]=DISHES[k].price; });
    return { v:1, savedAt:Date.now(), money:money, covers:covers, carved:carved.slice(),
      ratingSum:ratingSum, ratingCount:ratingCount, rival:rival, reviews:reviews.slice(0,20),
      employees:employees.map(function(e){ return {role:e.role}; }),
      prices:prices, menuOn:menuOn, targets:ING_TARGETS, special:special, specialT:specialT,
      crates:floorCrates.map(function(b){ return {x:b.x,y:b.y,ing:b.ing,count:b.count}; }),
      placed:placed.map(function(f){ return { fkey:f.fkey, x:f.x, y:f.y, rot:f.rot||0,
        inv:f.inv?JSON.parse(JSON.stringify(f.inv)):null, plates:f.plates?f.plates.slice():null, dirty:f.dirty||0 }; }) };
  }
  function readSlots(){ try{ return JSON.parse(localStorage.getItem(SLOTS_KEY)||'{}'); }catch(e){ return {}; } }
  function writeSlot(name){ if(!name) return;
    var slots=readSlots(); slots[name]=buildSaveData();
    try{ localStorage.setItem(SLOTS_KEY, JSON.stringify(slots)); }catch(e){ toast('Save failed'); return; }
    toast('💾 Saved “'+name+'”'); renderSlotList(); }
  function hasSave(){ return Object.keys(readSlots()).length>0; }
  function newestSlotName(){ var sl=readSlots(), best=null, bt=-1;
    Object.keys(sl).forEach(function(k){ if((sl[k].savedAt||0)>bt){ bt=sl[k].savedAt||0; best=k; } });
    return best; }
  function applySaveData(d){
    if(!d) return false;
    reset();
    carved.length=0; (d.carved||[]).forEach(function(k){ carved.push(k); }); rebuildMap();
    money=d.money||0; covers=d.covers||0; ratingSum=d.ratingSum||0; ratingCount=d.ratingCount||0; rival=d.rival||4;
    reviews=d.reviews||[];
    DISH_KEYS.forEach(function(k){ if(d.prices&&d.prices[k]!=null) DISHES[k].price=d.prices[k];
      if(d.menuOn) menuOn[k]=d.menuOn[k]!==false; });
    ING_TARGETS={}; Object.keys(d.targets||{}).forEach(function(k){ if(ING[k]) ING_TARGETS[k]=d.targets[k]; });
    special=(d.special&&DISHES[d.special])?d.special:null; specialT=d.specialT||0;
    (d.placed||[]).forEach(function(fs){ if(!FURNITURE[fs.fkey]) return;
      var f=placeAt(fs.fkey, fs.x-0.5, fs.y-0.5, fs.rot);
      if(f.inv&&fs.inv) Object.keys(fs.inv).forEach(function(k){ if(ING[k]) f.inv[k]=fs.inv[k]; });
      if(f.plates&&fs.plates) fs.plates.forEach(function(p){ if(DISHES[p]) f.plates.push(p); });
      if(fs.dirty) f.dirty=fs.dirty; });
    (d.crates||[]).forEach(function(b){ if(ING[b.ing]) floorCrates.push({x:b.x,y:b.y,ing:b.ing,count:b.count}); });
    (d.employees||[]).forEach(function(e){ if(ROLES[e.role]) employees.push(newEmployee(e.role)); });
    px=(mapW/2); py=mapH-2.2; dir=-Math.PI/2; updateCamera(); refreshHUD();
    return true;
  }
  function loadSlot(name){ var sl=readSlots(); return sl[name]? applySaveData(sl[name]) : false; }
  function loadGame(){ var n=newestSlotName(); return n? loadSlot(n) : false; }
  function saveOvOpen(){ return !document.getElementById('saveOv').hidden; }
  function renderSlotList(){
    var list=document.getElementById('slotList'); list.innerHTML='';
    var sl=readSlots(), names=Object.keys(sl).sort(function(a,b){ return (sl[b].savedAt||0)-(sl[a].savedAt||0); });
    if(!names.length){ var em=document.createElement('div'); em.className='sub'; em.textContent='No saves yet — name one above.'; list.appendChild(em); return; }
    names.forEach(function(n){ var d=sl[n];
      var row=document.createElement('div'); row.className='row';
      var info=document.createElement('div'); info.className='info';
      info.innerHTML='<div class="nm">'+n+'</div><div class="ds">$'+d.money+' · '+(d.ratingCount?(d.ratingSum/d.ratingCount).toFixed(1):'—')+'★ · '+new Date(d.savedAt||0).toLocaleTimeString()+'</div>';
      row.appendChild(info);
      var lb=document.createElement('button'); lb.className='buy'; lb.textContent='Load';
      lb.onclick=function(){ if(applySaveData(d)){ document.getElementById('saveOv').hidden=true; document.getElementById('startOv').hidden=true; gstate='play'; toast('💾 Loaded “'+n+'”'); } };
      row.appendChild(lb);
      var db=document.createElement('button'); db.className='buy'; db.style.background='#e94560'; db.textContent='✕';
      db.onclick=function(){ var s2=readSlots(); delete s2[n]; localStorage.setItem(SLOTS_KEY,JSON.stringify(s2)); renderSlotList(); };
      row.appendChild(db);
      list.appendChild(row); });
  }
  function openSaveOv(){ renderSlotList(); document.getElementById('slotName').value=curSlot||''; document.getElementById('saveOv').hidden=false; }
  var curSlot=null;
  function autoSaveNow(){ if(gstate==='play') writeSlot('⏱ Autosave'); }
  window.addEventListener('pagehide',autoSaveNow);
  document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='hidden') autoSaveNow(); });

  // ====================== geometry helpers ======================
  function rotPt(x,y,r){ return r===0?[x,y]:r===1?[-y,x]:r===2?[-x,-y]:[y,-x]; }
  function rotB(b,r){ var a=rotPt(b.x0,b.y0,r), c=rotPt(b.x1,b.y1,r);
    return {x0:Math.min(a[0],c[0]),x1:Math.max(a[0],c[0]),y0:Math.min(a[1],c[1]),y1:Math.max(a[1],c[1]),z0:b.z0,z1:b.z1,col:b.col}; }
  function footprint(fkey,x,y,rot){ var bs=FURNITURE[fkey].boxes, nx=9,ny=9,xx=-9,xy=-9;
    for(var i=0;i<bs.length;i++){ var b=rotB(bs[i],rot); if(b.x0<nx)nx=b.x0; if(b.y0<ny)ny=b.y0; if(b.x1>xx)xx=b.x1; if(b.y1>xy)xy=b.y1; }
    return { fx0:x+nx, fy0:y+ny, fx1:x+xx, fy1:y+xy }; }
  function solidAt(x,y){ var r=0.17; for(var i=0;i<placed.length;i++){ var f=placed[i].fp; if(x>f.fx0-r&&x<f.fx1+r&&y>f.fy0-r&&y<f.fy1+r) return true; } return false; }
  function walkable(x,y){ return mapAt(x,y)===0 && !solidAt(x,y); }
  function rectsHit(a,b){ return a.fx0<b.fx1&&a.fx1>b.fx0&&a.fy0<b.fy1&&a.fy1>b.fy0; }
  function updateCamera(){ dirX=Math.cos(dir); dirY=Math.sin(dir); planeX=-dirY*PLANE; planeY=dirX*PLANE; cx2=px; cy2=py; }
  // a spot `dist` in front of a fitting, biased back toward the middle of the room
  function frontOf(f,dist){ var cx=mapW/2, cy=mapH/2-0.4; var dx=cx-f.x, dy=cy-f.y, d=Math.hypot(dx,dy)||1; return { x:f.x+dx/d*dist, y:f.y+dy/d*dist }; }
  // seats ring a table; only the ones on real floor count
  function seatPts(f){ var m=FURNITURE[f.fkey], n=m.seats, r=m.seatR||0.9, out=[];
    for(var i=0;i<n;i++){ var a=(i/n)*Math.PI*2 + (f.rot||0)*Math.PI/2 + Math.PI/4;
      out.push({ x:f.x+Math.cos(a)*r, y:f.y+Math.sin(a)*r }); }
    return out; }
  function seatFree(f,i){ if(f.dirty>=FURNITURE[f.fkey].seats) return false;
    var p=seatPts(f)[i]; if(!walkable(p.x,p.y)) return false;
    for(var j=0;j<diners.length;j++){ var c=diners[j]; if(c.table===f&&c.seat===i&&c.state!=='leave') return false; }
    return true; }
  function freeSeat(){ var opts=[];
    placed.forEach(function(f){ if(f.kind!=='table') return;
      for(var i=0;i<FURNITURE[f.fkey].seats;i++) if(seatFree(f,i)) opts.push({f:f,i:i}); });
    return opts.length?pick(opts):null; }
  function tableCount(){ var n=0; placed.forEach(function(f){ if(f.kind==='table') n++; }); return n; }

  // ====================== sprites ======================
  function personSprite(skin,shirt){ var c=mkCanvas(48,72), g=c.getContext('2d'); g.lineCap='round'; g.lineJoin='round';
    g.strokeStyle=shirt; g.lineWidth=9; g.beginPath(); g.moveTo(16,42); g.lineTo(13,64); g.moveTo(32,42); g.lineTo(35,64); g.stroke();
    g.fillStyle=shirt; g.beginPath(); g.moveTo(13,30); g.quadraticCurveTo(24,26,35,30); g.lineTo(33,46); g.quadraticCurveTo(24,50,15,46); g.closePath(); g.fill();
    g.lineWidth=7; g.beginPath(); g.moveTo(15,32); g.lineTo(9,46); g.moveTo(33,32); g.lineTo(39,46); g.stroke();
    g.fillStyle=skin; g.beginPath(); g.arc(24,17,9,0,7); g.fill(); g.fillStyle='#3a2a1a'; g.beginPath(); g.arc(24,12,9,Math.PI,0); g.fill();
    return c; }
  var SKINS=['#f0c8a0','#e0a878','#c88858','#a86840'], SHIRTS=['#c8483c','#3a86c8','#2f7e4f','#caa14a','#7a4bb0','#e0712e','#d86fb0'];
  function crateSprite(ing){ var c=mkCanvas(64,56), g=c.getContext('2d');
    g.fillStyle='#c9a06a'; g.fillRect(6,10,52,42); g.fillStyle='#b08a52'; g.fillRect(6,10,52,8);
    g.strokeStyle='#7c5526'; g.lineWidth=2; g.strokeRect(6,10,52,42); g.beginPath(); g.moveTo(6,31); g.lineTo(58,31); g.stroke();
    g.drawImage(IICON[ing],22,16,22,22);
    return c; }
  var CRATE_SPR={}; function crateImg(ing){ return CRATE_SPR[ing]||(CRATE_SPR[ing]=crateSprite(ing)); }
  var PLATE_SPR={}; function plateImg(d){ return PLATE_SPR[d]||(PLATE_SPR[d]=dishIcon(d,72)); }

  // Smidge: a majority-black tortoiseshell — mostly black with ginger and cream
  // patches, worn asymmetrically the way real torties are.
  function smidgeFace(s){ var c=mkCanvas(s,s), g=c.getContext('2d'), h=s/86;
    g.fillStyle='#1b1b1f'; g.beginPath(); g.ellipse(43*h,50*h,30*h,27*h,0,0,7); g.fill();          // head
    g.save(); g.beginPath(); g.ellipse(43*h,50*h,30*h,27*h,0,0,7); g.clip();
    g.fillStyle='#b5651d'; g.beginPath(); g.ellipse(22*h,38*h,14*h,17*h,0.5,0,7); g.fill();        // ginger patch
    g.fillStyle='#8a4512'; g.beginPath(); g.ellipse(60*h,66*h,12*h,10*h,-0.4,0,7); g.fill();
    g.fillStyle='#e8d9bd'; g.beginPath(); g.ellipse(43*h,70*h,13*h,9*h,0,0,7); g.fill();           // cream muzzle
    g.restore();
    g.fillStyle='#1b1b1f'; g.beginPath(); g.moveTo(18*h,30*h); g.lineTo(14*h,4*h); g.lineTo(38*h,20*h); g.closePath(); g.fill();   // ears
    g.beginPath(); g.moveTo(68*h,30*h); g.lineTo(72*h,4*h); g.lineTo(48*h,20*h); g.closePath(); g.fill();
    g.fillStyle='#b5651d'; g.beginPath(); g.moveTo(20*h,27*h); g.lineTo(18*h,11*h); g.lineTo(33*h,21*h); g.closePath(); g.fill();
    g.fillStyle='#7fd06a'; g.beginPath(); g.ellipse(31*h,47*h,7*h,8*h,0,0,7); g.fill();            // eyes
    g.beginPath(); g.ellipse(55*h,47*h,7*h,8*h,0,0,7); g.fill();
    g.fillStyle='#14140f'; g.beginPath(); g.ellipse(31*h,47*h,2.4*h,7*h,0,0,7); g.fill();
    g.beginPath(); g.ellipse(55*h,47*h,2.4*h,7*h,0,0,7); g.fill();
    g.fillStyle='#e07a8a'; g.beginPath(); g.moveTo(38*h,60*h); g.lineTo(48*h,60*h); g.lineTo(43*h,66*h); g.closePath(); g.fill();  // nose
    g.strokeStyle='rgba(255,255,255,0.75)'; g.lineWidth=1.4*h; g.lineCap='round';                  // whiskers
    g.beginPath(); g.moveTo(30*h,66*h); g.lineTo(4*h,60*h); g.moveTo(30*h,70*h); g.lineTo(6*h,74*h);
    g.moveTo(56*h,66*h); g.lineTo(82*h,60*h); g.moveTo(56*h,70*h); g.lineTo(80*h,74*h); g.stroke();
    return c; }
  // Smidge's paws, holding whatever you're carrying at the bottom of the screen
  function pawSprite(){ var c=mkCanvas(120,90), g=c.getContext('2d');
    function paw(x,flip,ginger){ g.save(); g.translate(x,0); if(flip) g.scale(-1,1);
      g.fillStyle='#1b1b1f'; g.beginPath(); g.moveTo(0,90); g.lineTo(2,40); g.quadraticCurveTo(6,16,26,14);
      g.quadraticCurveTo(46,16,48,40); g.lineTo(50,90); g.closePath(); g.fill();
      if(ginger){ g.fillStyle='#b5651d'; g.beginPath(); g.ellipse(14,54,11,20,0.2,0,7); g.fill(); }
      g.fillStyle='#2a2a30'; for(var i=0;i<3;i++){ g.beginPath(); g.ellipse(10+i*14,22,6,8,0,0,7); g.fill(); }
      g.fillStyle='#e8d9bd'; g.beginPath(); g.ellipse(25,40,13,10,0,0,7); g.fill();
      g.restore(); }
    paw(4,false,true); paw(116,true,false); return c; }
  var PAWS=pawSprite();

  // ====================== pantry ======================
  function stores(){ return placed.filter(function(f){ return f.kind==='store'; }); }
  function storeUsed(f){ var n=0; for(var k in f.inv) if(f.inv.hasOwnProperty(k)) n+=f.inv[k]; return n; }
  function storeSpace(f){ return FURNITURE[f.fkey].cap - storeUsed(f); }
  function storeSummary(f){ var s=[]; ING_KEYS.forEach(function(k){ if(f.inv[k]>0) s.push(ING[k].emo+f.inv[k]); });
    return s.length? s.join(' ') : 'empty'; }
  // one number per ingredient across every fridge and pantry in the building
  function pantryCount(k){ var n=0; stores().forEach(function(f){ n+=f.inv[k]||0; }); return n; }
  // everything of this ingredient you OWN — stored, still in a crate by the door,
  // in your paws, or under a porter's arm. Re-ordering has to count all of it, or
  // a full pantry makes the purchaser buy the same crate forever.
  function ownedCount(k){ var n=pantryCount(k);
    floorCrates.forEach(function(b){ if(b.ing===k) n+=b.count; });
    if(carrying&&carrying.type==='crate'&&carrying.ing===k) n+=carrying.count;
    employees.forEach(function(e){ if(e.crate&&e.crate.ing===k) n+=e.crate.count; });
    return n; }
  function totalSpace(){ return stores().reduce(function(s,f){ return s+storeSpace(f); },0); }
  function pantryPut(ing,count){                       // returns how many actually fitted
    var left=count;
    stores().forEach(function(f){ if(left<=0) return; var room=storeSpace(f); if(room<=0) return;
      var mv=Math.min(room,left); f.inv[ing]=(f.inv[ing]||0)+mv; left-=mv; });
    return count-left; }
  function pantryTake(ing,count){                      // returns how many were actually pulled
    var got=0;
    stores().forEach(function(f){ if(got>=count) return; var have=f.inv[ing]||0; if(have<=0) return;
      var mv=Math.min(have,count-got); f.inv[ing]=have-mv; got+=mv; if(!f.inv[ing]) delete f.inv[ing]; });
    return got; }
  // Pull from an unpacked crate on the floor. The kitchen prefers the fridge, but it
  // WILL rip open a crate by the door — without this, a pantry full of pasta can
  // permanently strand the veg you need, and the restaurant livelocks with a full
  // store, a full floor, and nothing cookable.
  function crateTake(ing,count){ var got=0;
    for(var i=floorCrates.length-1;i>=0&&got<count;i--){ var b=floorCrates[i]; if(b.ing!==ing) continue;
      var mv=Math.min(b.count,count-got); b.count-=mv; got+=mv;
      if(b.count<=0) floorCrates.splice(i,1); }
    return got; }
  function canMake(k){ var rec=DISHES[k].rec, ok=true;
    ING_KEYS.forEach(function(i){ if(rec[i] && ownedCount(i)<rec[i]) ok=false; }); return ok; }
  function missingFor(k){ var rec=DISHES[k].rec, out=[];
    ING_KEYS.forEach(function(i){ if(rec[i] && ownedCount(i)<rec[i]) out.push(ING[i].emo+' '+ING[i].name); }); return out; }
  function consume(k){ var rec=DISHES[k].rec;
    ING_KEYS.forEach(function(i){ if(!rec[i]) return;
      var need=rec[i]-pantryTake(i,rec[i]); if(need>0) crateTake(i,need); }); }

  // ====================== stations & the menu ======================
  function stationsOf(st){ return placed.filter(function(f){ return f.kind==='station' && FURNITURE[f.fkey].st===st; }); }
  function haveStation(st){ return stationsOf(st).length>0; }
  // a dish is orderable when it's ticked on the menu AND you own something to cook it on
  function orderable(){ return DISH_KEYS.filter(function(k){ return menuOn[k] && haveStation(DISHES[k].st); }); }
  // plates of this dish already in play: cooking, sitting on a pass, or in hand
  function platesOut(k){ var n=0;
    placed.forEach(function(f){ if(f.kind!=='station') return;
      if(f.cookDish===k) n++;
      f.plates.forEach(function(p){ if(p===k) n++; }); });
    if(carrying&&carrying.type==='plate'&&carrying.dish===k) n++;
    employees.forEach(function(e){ if(e.plate===k) n++; });
    return n; }
  function ordersFor(k){ var n=0; diners.forEach(function(c){ if(c.state==='ordering'&&c.order===k) n++; }); return n; }
  // What this station should start next: the longest-waiting unclaimed ticket it
  // can cook. With `ticketsOnly` there is no fallback — that matters, because a
  // sous chef who speculatively fills the pass starves the real orders behind it.
  // You, pressing Action by hand in a quiet moment, do get the prep fallback.
  function nextDishFor(f,ticketsOnly){
    var st=FURNITURE[f.fkey].st, best=null, bestWait=-1;
    diners.forEach(function(c){ if(c.state!=='ordering') return; var d=DISHES[c.order]; if(!d||d.st!==st) return;
      if(platesOut(c.order)>=ordersFor(c.order)) return;        // someone's already on it
      if(c.waitT>bestWait){ bestWait=c.waitT; best=c.order; } });
    if(best||ticketsOnly) return best;
    var pre=DISH_KEYS.filter(function(k){ return DISHES[k].st===st && menuOn[k] && canMake(k) && platesOut(k)<2; })
      .sort(function(a,b){ return DISHES[b].price-DISHES[a].price; });
    return pre.length?pre[0]:null; }
  // Is anyone still waiting on this exact plate?
  function plateWanted(k){ return ordersFor(k)>0; }
  function startCook(f,k,quiet){
    var m=FURNITURE[f.fkey];
    if(f.cookDish){ if(!quiet) toast(m.name+' is already busy'); return false; }
    if(f.plates.length>=STATION_MAX_PLATES){ if(!quiet) toast('The pass is full — run those plates out first'); return false; }
    if(!k){ if(!quiet) toast('Nothing to cook on the '+m.name.toLowerCase()+' right now'); return false; }
    if(!canMake(k)){ if(!quiet) toast('Out of '+missingFor(k).join(' & ')+' — order a crate 📱'); return false; }
    consume(k); f.cookDish=k; f.cookT=DISHES[k].cook/chairBoost();
    if(!quiet) toast('🍳 '+DISHES[k].name+' is on');
    return true; }
  var PLATE_STALE=30;                    // seconds a plate sits with nobody wanting it before it's scraped
  function tickStations(dt){
    placed.forEach(function(f){ if(f.kind!=='station') return;
      if(f.cookDish){ f.cookT-=dt;
        if(f.cookT<=0){ f.plates.push(f.cookDish); f.cookDish=null; f.cookT=0; } }
      // Food goes cold. If nothing on the pass is spoken for, bin the oldest after
      // a while — otherwise a pass full of unwanted plates blocks the whole station.
      if(f.plates.length && !f.plates.some(plateWanted)){
        f.staleT=(f.staleT||0)+dt;
        if(f.staleT>=PLATE_STALE){ f.staleT=0; var gone=f.plates.shift();
          toast('🗑️ '+DISHES[gone].name+' went cold — scraped'); } }
      else f.staleT=0; });
  }
  function stationWithPlate(k){ for(var i=0;i<placed.length;i++){ var f=placed[i];
      if(f.kind==='station'&&f.plates.indexOf(k)>=0) return f; } return null; }

  // ====================== room quality ======================
  function chairBoost(){ var n=0; placed.forEach(function(f){ if(f.kind==='chair') n++; }); return 1+0.08*Math.min(4,n); }
  function premScore(){ var n=0; placed.forEach(function(f){ n+=(FURNITURE[f.fkey].prem||0); }); return n; }
  function premBonus(){ return clamp(premScore()*0.05,0,0.45); }
  function hasMusic(){ return placed.some(function(f){ return FURNITURE[f.fkey].music; }); }
  function restrooms(){ return placed.filter(function(f){ return f.kind==='restroom'; }); }
  function dirtyTables(){ var n=0; placed.forEach(function(f){ if(f.kind==='table') n+=(f.dirty||0); }); return n; }
  // crates stacked by the door look every bit as bad as an uncleared table
  function grubbiness(){ return messes.length + dirtyTables() + floorCrates.length; }
  function dropMess(x,y){ if(messes.length<14) messes.push({x:x+rnd(-0.3,0.3),y:y+rnd(-0.3,0.3)}); }
  function nearestMess(e){ var best=null,bd=1e9; messes.forEach(function(m){ var d=Math.hypot(m.x-e.x,m.y-e.y); if(d<bd){bd=d;best=m;} }); return best; }
  // average markup across the dishes you're actually serving (1.0 = at the recipe's list price)
  function avgMarkup(){ var ms=orderable().map(function(k){ return DISHES[k].price/DISHES[k].base; });
    return ms.length? ms.reduce(function(a,b){return a+b;},0)/ms.length : 1; }

  // ====================== loop & projection ======================
  var DT=1/60;
  function frame(){ if(gstate==='play'){ update(); render(); } requestAnimationFrame(frame); }

  function camDepth(wx,wy){ var sx=wx-cx2, sy=wy-cy2; var invDet=1/(planeX*dirY-dirX*planeY); return invDet*(-planeY*sx+planeX*sy); }
  function projP(wx,wy,z){ var sx=wx-cx2, sy=wy-cy2; var invDet=1/(planeX*dirY-dirX*planeY);
    var tX=invDet*(dirY*sx-dirX*sy), tY=invDet*(-planeY*sx+planeX*sy);
    if(tY<=0.06) return null; var lineH=H/tY; return { x:(W/2)*(1+tX/tY), y:H/2+lineH/2 - z*lineH, tY:tY }; }
  function fillFace(g,pts,fill,edge){ for(var i=0;i<pts.length;i++) if(!pts[i]) return; g.beginPath(); g.moveTo(pts[0].x,pts[0].y);
    for(var j=1;j<pts.length;j++)g.lineTo(pts[j].x,pts[j].y); g.closePath(); g.fillStyle=fill; g.fill(); if(edge){ g.strokeStyle=edge; g.lineWidth=1; g.stroke(); } }
  function drawBoxes(g,fx,fy,boxesRaw,rot,alpha,tint){
    g.globalAlpha=alpha||1;
    boxesRaw.map(function(b){ return rotB(b,rot); }).map(function(b){ return {b:b,d:camDepth(fx+(b.x0+b.x1)/2,fy+(b.y0+b.y1)/2)}; }).sort(function(a,b){ return b.d-a.d; }).forEach(function(o){
      var b=o.b, x0=fx+b.x0,x1=fx+b.x1,y0=fy+b.y0,y1=fy+b.y1,z0=b.z0,z1=b.z1, col=tint||b.col, sides=[];
      if(cx2<x0) sides.push({c:[[x0,y0,z0],[x0,y1,z0],[x0,y1,z1],[x0,y0,z1]],sh:0.7});
      if(cx2>x1) sides.push({c:[[x1,y1,z0],[x1,y0,z0],[x1,y0,z1],[x1,y1,z1]],sh:0.7});
      if(cy2<y0) sides.push({c:[[x1,y0,z0],[x0,y0,z0],[x0,y0,z1],[x1,y0,z1]],sh:0.85});
      if(cy2>y1) sides.push({c:[[x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]],sh:0.85});
      sides.forEach(function(s){ fillFace(g, s.c.map(function(q){ return projP(q[0],q[1],q[2]); }), jitC(col,s.sh), jitC(col,s.sh*0.6)); });
      if(z1<0.72) fillFace(g, [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]].map(function(q){ return projP(q[0],q[1],q[2]); }), jitC(col,1.04), jitC(col,0.7));
    });
    g.globalAlpha=1;
  }
  function billboard(wx,wy,zOff,sh,sw,img,bright){ var pr=projP(wx,wy,0); if(!pr) return;
    var lineH=H/pr.tY, spH=lineH*sh, spW=lineH*sw, bottomY=H/2+lineH/2 - zOff*lineH, topY=bottomY-spH;
    var sx0=Math.floor(pr.x-spW/2), sx1=Math.ceil(pr.x+spW/2), xr=RW/W; ctx.globalAlpha=bright||1; var runStart=-1;
    for(var x=sx0;x<=sx1;x++){ var vis=x>=0&&x<W&&(pr.tY<zbuf[(x*xr)|0])&&x<sx1;
      if(vis&&runStart<0)runStart=x;
      if((!vis||x===sx1)&&runStart>=0){ var runEnd=vis?x:x-1; var srcX=((runStart-sx0)/spW)*img.width, srcW=((runEnd-runStart+1)/spW)*img.width;
        ctx.drawImage(img,srcX,0,srcW,img.height,runStart,topY,runEnd-runStart+1,spH); runStart=-1; } }
    ctx.globalAlpha=1; }
  var SHADOW_SPR=(function(){ var c=mkCanvas(64,24), g=c.getContext('2d');
    var rg=g.createRadialGradient(32,12,2,32,12,30);
    rg.addColorStop(0,'rgba(8,10,18,0.42)'); rg.addColorStop(0.7,'rgba(8,10,18,0.18)'); rg.addColorStop(1,'rgba(8,10,18,0)');
    g.fillStyle=rg; g.save(); g.translate(32,12); g.scale(1,0.375); g.beginPath(); g.arc(0,0,30,0,7); g.fill(); g.restore(); return c; })();
  function drawShadow(wx,wy,scale){ var pr=projP(wx,wy,0); if(!pr) return;
    if(pr.tY<=0.05||pr.tY>=zbuf[clamp((pr.x/W*RW)|0,0,RW-1)]) return;
    var lineH=H/pr.tY, w=lineH*0.5*(scale||1), h=w*0.34, by=H/2+lineH/2;
    ctx.globalAlpha=0.85; ctx.drawImage(SHADOW_SPR,pr.x-w/2,by-h*0.55,w,h); ctx.globalAlpha=1; }
  function labelAt(wx,wy,z,text,color){ var pr=projP(wx,wy,z); if(!pr) return; if(pr.tY<0.12||pr.tY>=zbuf[clamp((pr.x/W*RW)|0,0,RW-1)]) return;
    ctx.font='800 '+Math.max(10,W/74)+'px Nunito,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='bottom';
    var w=ctx.measureText(text).width+10, h=Math.max(15,W/46); ctx.fillStyle='rgba(10,14,28,0.82)';
    rr(ctx,pr.x-w/2,pr.y-h,w,h-3,6); ctx.fillStyle=color; ctx.fillText(text,pr.x,pr.y-6); }
  function rr(g,x,y,w,h,r){ g.beginPath(); if(g.roundRect)g.roundRect(x,y,w,h,r); else g.rect(x,y,w,h); g.fill(); }

  var VIG=null, VIG_W=0, VIG_H=0;
  function vignetteFor(w,h){ if(VIG&&VIG_W===w&&VIG_H===h) return VIG;
    VIG_W=w; VIG_H=h; VIG=mkCanvas(w,h); var g=VIG.getContext('2d');
    var rg=g.createRadialGradient(w/2,h*0.46,Math.min(w,h)*0.36,w/2,h*0.52,Math.max(w,h)*0.74);
    rg.addColorStop(0,'rgba(0,0,0,0)'); rg.addColorStop(0.75,'rgba(10,6,4,0.10)'); rg.addColorStop(1,'rgba(10,6,4,0.34)');
    g.fillStyle=rg; g.fillRect(0,0,w,h);
    var wl=g.createLinearGradient(0,0,0,h);                       // candle-warm wash from the ceiling
    wl.addColorStop(0,'rgba(255,198,120,0.07)'); wl.addColorStop(0.5,'rgba(255,198,120,0)');
    g.fillStyle=wl; g.fillRect(0,0,w,h);
    return VIG; }

  // ====================== render ======================
  function render(){
    if(placing){ renderTopDown(); return; }
    var halfH=RH/2, fog=0.085, rd0x=dirX-planeX, rd0y=dirY-planeY, rd1x=dirX+planeX, rd1y=dirY+planeY, buf=buf32, fd=TEX.floor, cd=TEX.ceil, y,x;
    for(y=(halfH|0)+1;y<RH;y++){
      var rowDist=halfH/(y-halfH), stepX=rowDist*(rd1x-rd0x)/RW, stepY=rowDist*(rd1y-rd0y)/RW, fx=cx2+rowDist*rd0x, fy=cy2+rowDist*rd0y;
      var shade=clamp(1-rowDist*fog,0.18,1), cs=shade*0.96, fr=y*RW, cr=(RH-1-y)*RW;
      for(x=0;x<RW;x++){ var tx=((fx-Math.floor(fx))*TW)&TMASK, ty=((fy-Math.floor(fy))*TH)&TMASK, ti=(ty*TW+tx)<<2;
        buf[fr+x]=(0xff000000|(((fd[ti+2]*shade)|0)<<16)|(((fd[ti+1]*shade)|0)<<8)|((fd[ti]*shade)|0))>>>0;
        buf[cr+x]=(0xff000000|(((cd[ti+2]*cs)|0)<<16)|(((cd[ti+1]*cs)|0)<<8)|((cd[ti]*cs)|0))>>>0; fx+=stepX; fy+=stepY; } }
    for(x=0;x<RW;x++){
      var cameraX=2*x/RW-1, rdx=dirX+planeX*cameraX, rdy=dirY+planeY*cameraX, mx=Math.floor(cx2), my=Math.floor(cy2);
      var ddx=Math.abs(1/rdx), ddy=Math.abs(1/rdy), stepXX,stepYY,sdx,sdy;
      if(rdx<0){ stepXX=-1; sdx=(cx2-mx)*ddx; } else { stepXX=1; sdx=(mx+1-cx2)*ddx; }
      if(rdy<0){ stepYY=-1; sdy=(cy2-my)*ddy; } else { stepYY=1; sdy=(my+1-cy2)*ddy; }
      var side=0,hit=0,guard=0,cellv=1;
      while(!hit&&guard++<60){ if(sdx<sdy){ sdx+=ddx; mx+=stepXX; side=0; } else { sdy+=ddy; my+=stepYY; side=1; } cellv=mapAt(mx+0.5,my+0.5); if(cellv!==0) hit=1; }
      var perp=side===0?(sdx-ddx):(sdy-ddy); zbuf[x]=perp;
      var lineH=RH/perp, drawStartF=halfH-lineH/2, wallX=side===0?(cy2+perp*rdy):(cx2+perp*rdx); wallX-=Math.floor(wallX);
      var texX=(wallX*TW)|0; if((side===0&&rdx>0)||(side===1&&rdy<0)) texX=TW-1-texX;
      var wd=wallTex(cellv), wsh=clamp(1-perp*fog,0.2,1)*(side===1?0.82:1);
      var y0=Math.max(0,Math.ceil(drawStartF)), y1=Math.min(RH-1,(drawStartF+lineH)|0), tStep=TH/lineH, tPos=(y0-drawStartF)*tStep;
      for(y=y0;y<=y1;y++){ var tyy=(tPos|0)&TMASK, tii=((tyy*TW+texX)<<2);
        buf[y*RW+x]=(0xff000000|(((wd[tii+2]*wsh)|0)<<16)|(((wd[tii+1]*wsh)|0)<<8)|((wd[tii]*wsh)|0))>>>0; tPos+=tStep; } }
    sceneCtx.putImageData(sceneImg,0,0); ctx.drawImage(sceneCanvas,0,0,RW,RH,0,0,W,H);
    ctx.drawImage(vignetteFor(W,H),0,0);

    var objs=[];
    placed.forEach(function(f){ objs.push({d:camDepth(f.x,f.y), kind:'furn', f:f}); });
    floorCrates.forEach(function(b){ objs.push({d:camDepth(b.x,b.y), kind:'crate', b:b}); });
    diners.forEach(function(c){ objs.push({d:camDepth(c.x,c.y), kind:'diner', c:c}); });
    messes.forEach(function(m){ objs.push({d:camDepth(m.x,m.y), kind:'mess', m:m}); });
    employees.forEach(function(e){ objs.push({d:camDepth(e.x,e.y), kind:'emp', e:e}); });
    objs.sort(function(a,b){ return b.d-a.d; });
    objs.forEach(function(o){
      if(o.kind==='furn'){ var f=o.f; drawBoxes(ctx,f.x,f.y,FURNITURE[f.fkey].boxes,f.rot,1); decorateFurn(f); }
      else if(o.kind==='crate'){ drawShadow(o.b.x,o.b.y,0.8); billboard(o.b.x,o.b.y,0,0.46,0.46,crateImg(o.b.ing),1);
        labelAt(o.b.x,o.b.y,0.56,ING[o.b.ing].name+' ×'+o.b.count,'#ffe08a'); }
      else if(o.kind==='diner'){ var c=o.c; drawShadow(c.x,c.y,0.7); billboard(c.x,c.y,0,0.62,0.42,c.img,1);
        if(c.state==='eating'&&c.order) billboard(c.x,c.y,0.66,0.2,0.2,DICON[c.order],1);
        if(c.emote) billboard(c.x,c.y,0.96,c.emote.w||0.22,c.emote.h||0.22,c.emote.img,1); }
      else if(o.kind==='mess'){ billboard(o.m.x,o.m.y,0.03,0.3,0.1,messSprite(),1); }
      else if(o.kind==='emp'){ var e=o.e; drawShadow(e.x,e.y,0.7); billboard(e.x,e.y,0,0.62,0.42,e.img,1);
        if(e.plate) billboard(e.x,e.y,0.56,0.2,0.2,DICON[e.plate],1);
        if(e.crate) billboard(e.x,e.y,0.52,0.2,0.2,crateImg(e.crate.ing),1);
        labelAt(e.x,e.y,0.66, ROLES[e.role].emo+' '+ROLES[e.role].name,'#9fd0ff'); }
    });

    drawCarried();
    drawReticle();
    var vig=ctx.createRadialGradient(W/2,H/2,H*0.3,W/2,H/2,H*0.78); vig.addColorStop(0,'rgba(0,0,0,0)'); vig.addColorStop(1,'rgba(0,0,0,0.34)'); ctx.fillStyle=vig; ctx.fillRect(0,0,W,H);
  }
  // Whatever Smidge is carrying, held in two tortoiseshell paws at the bottom of
  // the screen. Sizes key off H (not W) so the load stays put on any aspect ratio;
  // the item is drawn first so the paws close over its lower edge.
  function drawCarried(){ if(!carrying) return;
    var isPlate=carrying.type==='plate';
    var img = isPlate ? plateImg(carrying.dish) : crateImg(carrying.ing);
    var pawH=H*0.32, pawW=pawH*(PAWS.width/PAWS.height), pawTop=H-pawH*0.82;
    // Each sprite paints a different slice of its own canvas — a plate sits low in
    // its square, a crate nearly fills its box. Anchor by where the ART is, not the
    // canvas, so both types land in the paws and neither label drifts up the screen.
    var vTop = isPlate?0.36:0.10, vBot = isPlate?0.80:0.93;
    var ih = (isPlate?H*0.34:H*0.30), iw = ih*(img.width/img.height);
    var artBottom = pawTop + pawH*0.16;                     // let the paws close over the edge
    var iy = artBottom - ih*vBot;
    ctx.drawImage(img, W*0.5-iw/2, iy, iw, ih);
    ctx.drawImage(PAWS, W*0.5-pawW/2, pawTop, pawW, pawH);
    var label = isPlate ? DISHES[carrying.dish].name : ING[carrying.ing].name+' ×'+carrying.count;
    ctx.font='900 '+Math.max(12,H/30)+'px Nunito,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='bottom';
    var tw=ctx.measureText(label).width+16, th=Math.max(18,H/22);
    var ty=Math.max(H*0.62, iy+ih*vTop-th*0.3);             // never ride up over the reticle
    ctx.fillStyle='rgba(10,14,28,0.80)'; rr(ctx, W*0.5-tw/2, ty-th, tw, th, 8);
    ctx.fillStyle= isPlate?'#ffe8b0':'#cfeaff'; ctx.fillText(label, W*0.5, ty-th*0.22); }

  function decorateFurn(f){ var meta=FURNITURE[f.fkey];
    if(f.kind==='till'){ var q=diners.filter(function(c){ return c.state==='queue'; }).length;
      labelAt(f.x,f.y,meta.topZ+0.08, q>0?('TILL · '+q+' waiting'):'TILL', q>0?'#ffd24a':'#cfd6ea'); return; }
    if(f.kind==='station'){
      var st=STATIONS[meta.st];
      if(f.cookDish){ var d=DISHES[f.cookDish], pct=Math.round(100*(1-f.cookT/(d.cook/chairBoost())));
        billboard(f.x,f.y,meta.topZ,0.2,0.2,DICON[f.cookDish],0.85);
        labelAt(f.x,f.y,meta.topZ+0.2, '🍳 '+d.name+' '+clamp(pct,0,99)+'%','#ffd24a'); }
      else if(f.plates.length){
        f.plates.forEach(function(p,i){ billboard(f.x+(i-(f.plates.length-1)/2)*0.22, f.y, meta.topZ, 0.22,0.22, DICON[p],1); });
        labelAt(f.x,f.y,meta.topZ+0.24, '✅ '+f.plates.map(function(p){ return DISHES[p].name; }).join(' · '),'#7df0a8'); }
      else labelAt(f.x,f.y,meta.topZ+0.1, st.emo+' '+st.name,'#cfd6ea');
      return; }
    if(f.kind==='table'){
      var lbl='Table '+f.no, col='#cfd6ea';
      if(f.dirty) { lbl='Table '+f.no+' · 🍽️×'+f.dirty+' to clear'; col='#ffb0a0'; }
      labelAt(f.x,f.y,meta.topZ+0.22,lbl,col);
      // the orders taken at this table, floating over the cloth
      var os=diners.filter(function(c){ return c.table===f&&c.state==='ordering'; });
      os.forEach(function(c,i){ billboard(f.x+(i-(os.length-1)/2)*0.24, f.y, meta.topZ+0.06, 0.16,0.16, DICON[c.order],0.9); });
      for(var i=0;i<(f.dirty||0);i++) billboard(f.x-0.22+i*0.16, f.y+0.1, meta.topZ, 0.13,0.13, DIRTY_SPR(),0.95);
      return; }
    if(f.kind==='store'){ labelAt(f.x,f.y,meta.topZ+0.06, meta.name+' · '+storeSummary(f),'#9fd0ff'); return; }
    if(f.kind==='restroom'){ labelAt(f.x,f.y,meta.topZ+0.06,'🚻 Restroom','#9fd0ff'); return; }
  }
  var DIRTY_C=null;
  function DIRTY_SPR(){ if(DIRTY_C) return DIRTY_C;
    var c=mkCanvas(40,40), g=c.getContext('2d');
    g.fillStyle='#e8e2d4'; g.beginPath(); g.ellipse(20,24,15,8,0,0,7); g.fill();
    g.fillStyle='#b8a894'; g.beginPath(); g.ellipse(20,22,10,5,0,0,7); g.fill();
    g.fillStyle='#8a6a4a'; g.beginPath(); g.ellipse(17,21,4,2,0.3,0,7); g.fill();
    g.strokeStyle='#8f9aa6'; g.lineWidth=2; g.beginPath(); g.moveTo(28,10); g.lineTo(31,26); g.stroke();
    DIRTY_C=c; return c; }
  function drawReticle(){ var t=findTarget(); ctx.save(); ctx.translate(W/2,H/2);
    ctx.strokeStyle=t?'rgba(255,224,138,0.95)':'rgba(255,255,255,0.6)'; ctx.lineWidth=Math.max(2,W/420);
    var r=Math.max(7,W*0.012); ctx.beginPath(); ctx.arc(0,0,r,0,7); ctx.stroke(); ctx.restore(); promptFor(t); }

  // ---- bird's-eye build mode ----
  function renderTopDown(){
    ctx.fillStyle='#1a1208'; ctx.fillRect(0,0,W,H);
    var pad=Math.max(18,W*0.03), sc=Math.min((W-2*pad)/mapW,(H-2*pad)/mapH), ox=(W-sc*mapW)/2, oy=(H-sc*mapH)/2;
    function SX(wx){ return ox+wx*sc; } function SY(wy){ return oy+wy*sc; }
    var x,y;
    for(y=0;y<mapH;y++) for(x=0;x<mapW;x++){ var v=map[y][x];
      ctx.fillStyle = v===1?'#2a2318' : (v===2?'#2f7e4f':'#b5623c');
      ctx.fillRect(SX(x),SY(y),sc+0.5,sc+0.5); }
    for(y=0;y<mapH;y++) for(x=0;x<mapW;x++){ if(map[y][x]===1){ ctx.fillStyle='rgba(12,8,4,0.72)'; ctx.fillRect(SX(x),SY(y),sc,sc); } }
    ctx.strokeStyle='rgba(255,255,255,0.16)'; ctx.lineWidth=1; ctx.beginPath();
    for(x=0;x<=mapW;x++){ ctx.moveTo(SX(x),SY(0)); ctx.lineTo(SX(x),SY(mapH)); }
    for(y=0;y<=mapH;y++){ ctx.moveTo(SX(0),SY(y)); ctx.lineTo(SX(mapW),SY(y)); }
    ctx.stroke();
    placed.forEach(function(f){ var m=FURNITURE[f.fkey], fp=f.fp;
      ctx.fillStyle=jitC(m.color,0.95); ctx.fillRect(SX(fp.fx0),SY(fp.fy0),(fp.fx1-fp.fx0)*sc,(fp.fy1-fp.fy0)*sc);
      ctx.strokeStyle=jitC(m.color,0.55); ctx.lineWidth=2; ctx.strokeRect(SX(fp.fx0),SY(fp.fy0),(fp.fx1-fp.fx0)*sc,(fp.fy1-fp.fy0)*sc);
      ctx.fillStyle='#1a1008'; ctx.font='800 '+Math.max(9,sc*0.26)+'px Nunito,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(f.kind==='till'?'TILL':(f.kind==='table'?('T'+f.no):m.name.split(' ')[0]), SX((fp.fx0+fp.fx1)/2), SY((fp.fy0+fp.fy1)/2)); });
    floorCrates.forEach(function(b){ ctx.fillStyle='#c9a06a'; ctx.fillRect(SX(b.x)-sc*0.18,SY(b.y)-sc*0.18,sc*0.36,sc*0.36); });
    ctx.fillStyle='#7df0a8'; ctx.beginPath(); ctx.arc(SX(px),SY(py),sc*0.18,0,7); ctx.fill();
    ctx.strokeStyle='#7df0a8'; ctx.lineWidth=2.5; ctx.beginPath(); ctx.moveTo(SX(px),SY(py)); ctx.lineTo(SX(px+dirX*0.6),SY(py+dirY*0.6)); ctx.stroke();
    var sx=snap(ghostX), sy=snap(ghostY), ok=ghostValid();
    if(placing.carve){ var cgx=Math.floor(sx), cgy=Math.floor(sy);
      ctx.fillStyle=ok?'rgba(125,240,168,0.4)':'rgba(233,69,96,0.4)'; ctx.fillRect(SX(cgx),SY(cgy),sc,sc);
      ctx.strokeStyle=ok?'#7df0a8':'#e94560'; ctx.lineWidth=2.5; ctx.setLineDash([6,5]); ctx.strokeRect(SX(cgx),SY(cgy),sc,sc); ctx.setLineDash([]);
      ctx.fillStyle='#ffe08a'; ctx.font='900 '+Math.max(14,W/52)+'px Nunito,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='top';
      ctx.fillText('Build Mode · Lay floor $50/square — dining rooms, kitchens, corridors', W/2, 10);
    } else {
      var fp=footprint(placing.fkey,sx,sy,placing.rot);
      drawTopBoxes(SX,SY,sc,sx,sy,FURNITURE[placing.fkey].boxes,placing.rot, ok?'#7df0a8':'#e94560');
      ctx.strokeStyle=ok?'#7df0a8':'#e94560'; ctx.lineWidth=2.5; ctx.setLineDash([6,5]);
      ctx.strokeRect(SX(fp.fx0),SY(fp.fy0),(fp.fx1-fp.fx0)*sc,(fp.fy1-fp.fy0)*sc); ctx.setLineDash([]);
      ctx.fillStyle='#ffe08a'; ctx.font='900 '+Math.max(14,W/52)+'px Nunito,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='top';
      ctx.fillText('Build Mode · '+FURNITURE[placing.fkey].name+' — line it up on the grid', W/2, 10); }
  }
  function drawTopBoxes(SX,SY,sc,fx,fy,boxesRaw,rot,tint){
    boxesRaw.forEach(function(bb){ var b=rotB(bb,rot); ctx.fillStyle=tint; ctx.globalAlpha=0.5;
      ctx.fillRect(SX(fx+b.x0),SY(fy+b.y0),(b.x1-b.x0)*sc,(b.y1-b.y0)*sc); ctx.globalAlpha=1; }); }

  // ====================== placement ======================
  function snap(v){ return Math.floor(v)+0.5; }
  function startPlacing(fkey){ placing={fkey:fkey,rot:0}; ghostX=clamp(px+dirX*1.2,1.5,mapW-1.5); ghostY=clamp(py+dirY*1.2,1.5,mapH-1.5); placeBar(true); }
  function cancelPlacing(){
    if(placing&&placing.moving){ var mf=placing.moving; placed.push(mf); if(mf.kind==='till') till=mf; }
    placing=null; placeBar(false); toast('Cancelled'); }
  function rotateGhost(){ if(placing) placing.rot=(placing.rot+1)&3; }
  function placeBar(on){ document.getElementById('placeBar').hidden=!on; }
  function ghostValid(){ var sx=snap(ghostX), sy=snap(ghostY);
    if(placing.carve){ var gx2=Math.floor(sx), gy2=Math.floor(sy);
      if(gx2<1||gy2<1||gx2>=mapW-1||gy2>=mapH-1) return false;
      if(mapAt(sx,sy)!==1) return false;
      return mapAt(gx2+1.5,gy2+0.5)===0||mapAt(gx2-0.5,gy2+0.5)===0||mapAt(gx2+0.5,gy2+1.5)===0||mapAt(gx2+0.5,gy2-0.5)===0; }
    if(mapAt(sx,sy)!==0) return false;
    var fp=footprint(placing.fkey,sx,sy,placing.rot);
    for(var i=0;i<placed.length;i++){ if(rectsHit(fp,placed[i].fp)) return false; }
    if(px>fp.fx0-0.2&&px<fp.fx1+0.2&&py>fp.fy0-0.2&&py<fp.fy1+0.2) return false;
    return true; }
  function placeNow(){ if(!ghostValid()){ toast('Can’t put it there'); return; }
    var sx=snap(ghostX), sy=snap(ghostY);
    if(placing.carve){
      if(money<50){ toast('Need $50'); placing=null; placeBar(false); return; }
      money-=50; carved.push(Math.floor(sx)+','+Math.floor(sy)); rebuildMap(); refreshHUD();
      toast('🧱 Floor laid — $50 ('+floorArea()+' squares). Keep going, or Esc');
      return; }
    var meta=FURNITURE[placing.fkey];
    if(placing.moving){ var mf=placing.moving; mf.x=sx; mf.y=sy; mf.rot=placing.rot; mf.fp=footprint(mf.fkey,sx,sy,placing.rot);
      if(meta.kind==='till') till=mf;
      placed.push(mf); toast(meta.name+' moved'); placing=null; placeBar(false); return; }
    var f=newFurn(placing.fkey,sx,sy,placing.rot);
    placed.push(f); toast(meta.name+' installed'); placing=null; placeBar(false); }
  function newFurn(fkey,x,y,rot){ var meta=FURNITURE[fkey];
    var f={ kind:meta.kind, fkey:fkey, x:x, y:y, rot:rot||0, fp:footprint(fkey,x,y,rot||0) };
    if(meta.kind==='store') f.inv={};
    if(meta.kind==='station'){ f.plates=[]; f.cookDish=null; f.cookT=0; }
    if(meta.kind==='table'){ f.no=tableSeq++; f.dirty=0; }
    if(meta.kind==='till') till=f;
    return f; }
  function placeAt(fkey,tx,ty,rot){ var f=newFurn(fkey,tx+0.5,ty+0.5,rot||0); placed.push(f); return f; }
  // F on a fitting: lift it, stock and all, and put it back down somewhere better.
  function moveTargetFurn(){ if(placing||gstate!=='play') return;
    var t=findTarget(); if(!t||!t.f){ toast('Look at a fitting first'); return; }
    var f=t.f;
    if(diners.some(function(c){ return c.table===f&&c.state!=='leave'; })){ toast('Someone’s sitting there'); return; }
    placed.splice(placed.indexOf(f),1);
    if(till===f) till=null;
    placing={ fkey:f.fkey, rot:f.rot||0, moving:f };
    ghostX=f.x; ghostY=f.y; placeBar(true);
    toast('Moving the '+FURNITURE[f.fkey].name+' — arrows to move, R rotate, ✓ place'); }

  // ====================== targeting ======================
  function findTarget(){ if(placing) return null;
    var best=null, bestScore=1e9;
    function consider(wx,wy,obj,weight){ var dx=wx-px, dy=wy-py, d=Math.hypot(dx,dy); if(d>2.3||d<0.01) return;
      var dot=(dx*dirX+dy*dirY)/d; if(dot<0.55) return; var sc=(d*0.6+(1-dot)*2.4)*(weight||1); if(sc<bestScore){ bestScore=sc; best=obj; } }
    floorCrates.forEach(function(b){ consider(b.x,b.y,{type:'crate',crate:b}, 0.55); });
    placed.forEach(function(f){
      if(f.kind==='station') consider(f.x,f.y,{type:'station',f:f});
      else if(f.kind==='store') consider(f.x,f.y,{type:'store',f:f});
      else if(f.kind==='table') consider(f.x,f.y,{type:'table',f:f});
      else if(f.kind==='till') consider(f.x,f.y,{type:'till',f:f});
      else consider(f.x,f.y,{type:'furn',f:f}); });
    messes.forEach(function(m){ consider(m.x,m.y,{type:'mess',m:m}, 0.9); });
    return best; }

  function promptFor(t){ var p=document.getElementById('prompt');
    if(placing){ p.hidden=false; p.innerHTML='Aim &amp; <b>Action</b> to place · <b>R</b> rotate · <b>Esc</b> cancel'; return; }
    if(!t){ if(!till){ p.hidden=false; p.innerHTML='Open your <b>📱 Phone</b> → buy &amp; place the <b>Till</b>'; return; }
      if(!placed.some(function(f){ return f.kind==='station'; })){ p.hidden=false; p.innerHTML='📱 <b>Fittings</b> → a <b>Stove Range</b> and a <b>Table</b> next'; return; }
      p.hidden=true; return; }
    var txt='';
    if(t.type==='crate'){ txt= carrying?'Paws full — put that down first':'<b>Action</b>: pick up the '+ING[t.crate.ing].name+' crate'; }
    else if(t.type==='store'){ var f=t.f;
      txt= carrying&&carrying.type==='crate' ? '<b>Action</b>: unload '+ING[carrying.ing].name+' ('+storeSpace(f)+' space)'
         : FURNITURE[f.fkey].name+' · '+storeSummary(f)+' · <b>F</b> move'; }
    else if(t.type==='station'){ var s=t.f, m=FURNITURE[s.fkey];
      if(s.plates.length) txt='<b>Action</b>: pick up '+DISHES[s.plates[0]].name;
      else if(s.cookDish) txt='🍳 '+DISHES[s.cookDish].name+' — '+Math.ceil(s.cookT)+'s to go';
      else { var nd=nextDishFor(s); txt= nd? '<b>Action</b>: cook '+DISHES[nd].name+' ('+recStr(DISHES[nd].rec)+')' : m.name+' · nothing to cook · <b>F</b> move'; } }
    else if(t.type==='table'){ var tb=t.f;
      if(carrying&&carrying.type==='plate'){ var w=waiterTargetAt(tb,carrying.dish);
        txt= w? '<b>Action</b>: serve '+DISHES[carrying.dish].name+' to Table '+tb.no : 'Nobody at Table '+tb.no+' ordered that'; }
      else if(tb.dirty) txt='<b>Action</b>: clear Table '+tb.no+' ('+tb.dirty+' plate'+(tb.dirty>1?'s':'')+')';
      else txt='Table '+tb.no+' · '+FURNITURE[tb.fkey].seats+' covers · <b>F</b> move'; }
    else if(t.type==='till'){ var q=diners.filter(function(c){ return c.state==='queue'; }).length;
      txt= q>0? '<b>Action</b>: take the money ($'+nextBill()+')' : 'Till — nobody waiting · <b>F</b> move'; }
    else if(t.type==='mess'){ txt='<b>Action</b>: mop this up'; }
    else txt=FURNITURE[t.f.fkey].name+' · <b>F</b> move';
    p.hidden=false; p.innerHTML=txt; }
  function nextBill(){ var c=queueFront(); return c?c.bill:0; }
  function queueFront(){ var f=null, fd=1e9; diners.forEach(function(c){ if(c.state==='queue'&&c.qd<fd){ fd=c.qd; f=c; } }); return f; }
  // who at this table is still waiting on that exact dish
  function waiterTargetAt(tb,dish){ for(var i=0;i<diners.length;i++){ var c=diners[i];
      if(c.table===tb&&c.state==='ordering'&&c.order===dish) return c; } return null; }

  // ====================== actions ======================
  function doAction(){ if(gstate!=='play'||cashOpen()||ordOpen()) return;
    if(placing){ placeNow(); return; }
    var t=findTarget(); if(!t) return;
    if(t.type==='crate'){ if(carrying){ toast('Paws full!'); return; }
      var b=t.crate; carrying={ type:'crate', ing:b.ing, count:b.count };
      floorCrates.splice(floorCrates.indexOf(b),1); toast('Carrying '+ING[b.ing].name+' ×'+b.count); }
    else if(t.type==='store'){ var f=t.f;
      if(!carrying||carrying.type!=='crate'){ toast(FURNITURE[f.fkey].name+': '+storeSummary(f)); return; }
      var room=storeSpace(f); if(room<=0){ toast('That '+FURNITURE[f.fkey].name.toLowerCase()+' is full'); return; }
      var mv=Math.min(room,carrying.count); f.inv[carrying.ing]=(f.inv[carrying.ing]||0)+mv; carrying.count-=mv;
      toast('🧺 '+mv+' '+ING[carrying.ing].name+' away'); if(carrying.count<=0) carrying=null; }
    else if(t.type==='station'){ var s=t.f;
      if(s.plates.length){ if(carrying){ toast('Paws full — run that plate out first'); return; }
        carrying={ type:'plate', dish:s.plates.shift() }; toast('🍽️ '+DISHES[carrying.dish].name+' — hot, go go go'); return; }
      startCook(s, nextDishFor(s)); }
    else if(t.type==='table'){ var tb=t.f;
      if(carrying&&carrying.type==='plate'){ var c=waiterTargetAt(tb,carrying.dish);
        if(!c){ toast('Nobody at Table '+tb.no+' ordered '+DISHES[carrying.dish].name); return; }
        serve(c); carrying=null; return; }
      if(tb.dirty){ tb.dirty=0; toast('🧽 Table '+tb.no+' cleared'); return; }
      toast('Table '+tb.no+' — '+FURNITURE[tb.fkey].seats+' covers'); }
    else if(t.type==='till'){ var qc=queueFront(); if(!qc){ toast('Nobody waiting'); return; } startCheckout(qc); }
    else if(t.type==='mess'){ messes.splice(messes.indexOf(t.m),1); toast('🧽 Mopped'); }
  }
  function serve(c){
    c.state='eating'; c.eatT=rnd(7,13); c.servedAt=c.waitT; emote(c, c.order===special?'🤩':'😋');
    if(c.order==='lasagna'&&Math.random()<0.5) remark(c,'The lasagna! Finally!');
    covers++; refreshHUD(); toast('🍽️ Served Table '+c.table.no+' — '+DISHES[c.order].name); }

  // ====================== the bill ======================
  var saleC=null, saleGiven=0;
  function makeTender(p){ if(Math.random()<0.4) return p;
    var ups=[Math.ceil(p/5)*5, Math.ceil(p/10)*10, Math.ceil(p/20)*20].filter(function(t){ return t>p; });
    ups.push(p+1);
    return pick(ups); }
  function completeSale(c){ money+=c.bill; addReview(c); c.state='leave'; c.target=doorPt; refreshHUD(); }
  function cashOpen(){ return !document.getElementById('cashOv').hidden; }
  function startCheckout(c){
    c.tender=makeTender(c.bill);
    if(c.tender===c.bill){ emote(c,'🙂'); completeSale(c); toast('💵 Exact money  +$'+c.bill+'  '+DISHES[c.order].name); return; }
    saleC=c; saleGiven=0; c.state='paying'; c.flubs=0;
    document.getElementById('cashItem').textContent=DISHES[c.order].name+' — total';
    document.getElementById('cashPrice').textContent='$'+c.bill;
    document.getElementById('cashTender').textContent='$'+c.tender;
    document.getElementById('cashMsg').textContent='';
    updateCashUI();
    document.getElementById('cashOv').hidden=false;
  }
  function updateCashUI(){ document.getElementById('cashChange').textContent='Change: $'+saleGiven; }
  function cashGive(){ if(!saleC) return;
    var owed=saleC.tender-saleC.bill;
    if(saleGiven===owed){
      document.getElementById('cashOv').hidden=true;
      emote(saleC, saleC.flubs?'🙂':'😊');
      completeSale(saleC);
      toast('💵 +$'+saleC.bill+' — change given'+(saleC.flubs?' (eventually…)':' 👍'));
      saleC=null;
    } else {
      saleC.flubs++;
      var panel=document.getElementById('cashPanel');
      panel.classList.remove('shake'); void panel.offsetWidth; panel.classList.add('shake');
      document.getElementById('cashMsg').textContent =
        saleGiven<owed ? '“Hey, that’s not enough change!”' : '“That’s too much — count it again.”';
      emote(saleC,'😠');
      saleGiven=0; updateCashUI();
    }
  }
  document.querySelectorAll('#cashOv .bill').forEach(function(b){
    b.addEventListener('click',function(){ if(!saleC) return; saleGiven+=parseInt(b.dataset.v,10); updateCashUI(); }); });
  document.getElementById('cashClear').addEventListener('click',function(){ saleGiven=0; updateCashUI(); document.getElementById('cashMsg').textContent=''; });
  document.getElementById('cashGive').addEventListener('click',cashGive);

  // ====================== reviews ======================
  var GREAT=['That lasagna is worth crossing town for. Five stars.','Best Italian in the neighbourhood, hands down.',
             'Warm room, fast service, incredible food. Bellissimo!','Smidge runs a beautiful little place. We’ll be back Friday.'];
  var GOOD=['Solid plate of pasta, friendly service.','Nice trattoria — good value.','Came out hot and fast. No complaints.','Cosy spot, decent food.'];
  var MEH=['Long wait for the food.','Portions fine, prices creeping up.','Table next to us hadn’t been cleared.','Food was okay. Service dragged.'];
  var BAD=['Waited forever and it came out cold. Never again.','Way overpriced for what it is.','Grubby tables, slow kitchen. One star.','We got up and left. Shame.'];
  function addReview(c){ var stars=4, d=DISHES[c.order], base=d.base;
    if(c.bill>base*1.3) stars-=2; else if(c.bill>base*1.05) stars-=1;      // gouging is noticed instantly
    if(c.bill<base*0.9) stars+=1;                                          // a genuine deal gets talked about
    var wait=c.servedAt||0;                                               // seconds from ordering to the plate landing
    if(wait>18) stars-=1; if(wait>32) stars-=1; if(wait>48) stars-=1;
    if(c.patience>10) stars-=1;                                           // then queueing to pay on top of that
    if(employees.some(function(e){ return e.role==='maitre'; })) stars+=1;
    if(c.flubs) stars-=Math.min(2,c.flubs);
    if(d.signature && stars>=3) stars+=1;                                  // the lasagna does the heavy lifting
    if(hasMusic() && stars>=3) stars+=1;
    if(Math.random()<0.22) stars-=1;                                       // some people are just like that
    if(stars<5 && Math.random()<premBonus()) stars+=1;
    if(grubbiness()>4 && Math.random()<0.55) stars-=1;
    stars=clamp(Math.round(stars),1,5);
    var txt= stars>=5?pick(GREAT) : stars>=4?pick(GOOD) : stars>=3?pick(MEH) : pick(BAD);
    reviews.unshift({ stars:stars, text:txt }); if(reviews.length>20) reviews.pop();
    ratingSum+=stars; ratingCount++;
    rival = clamp(rival + (avgRating()>rival?-0.015:0.03), 3.6, 4.9);
  }
  function pushReview(stars,text){ reviews.unshift({stars:stars,text:text}); if(reviews.length>20) reviews.pop();
    ratingSum+=stars; ratingCount++; }

  // ====================== emotes & chatter ======================
  var EMO_CACHE={}, MESS_SPR=null, REM_CACHE={};
  function messSprite(){ if(MESS_SPR) return MESS_SPR;
    var c=mkCanvas(40,26), g=c.getContext('2d');
    g.fillStyle='rgba(150,40,30,0.8)';                                   // spilled sugo
    g.beginPath(); g.ellipse(20,15,13,7,0,0,7); g.fill();
    g.beginPath(); g.ellipse(9,10,5,3,0,0,7); g.fill();
    g.beginPath(); g.ellipse(31,9,4,2.6,0,0,7); g.fill();
    g.fillStyle='rgba(220,120,80,0.55)'; g.beginPath(); g.ellipse(20,13,7,3.6,0,0,7); g.fill();
    MESS_SPR=c; return c; }
  function emoteSprite(t){ if(EMO_CACHE[t]) return EMO_CACHE[t];
    var c=mkCanvas(48,48), g=c.getContext('2d');
    g.fillStyle='rgba(250,246,235,0.94)'; g.beginPath(); g.arc(24,22,19,0,7); g.fill();
    g.beginPath(); g.moveTo(18,38); g.lineTo(24,47); g.lineTo(29,38); g.closePath(); g.fill();
    g.font='24px serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(t,24,23);
    EMO_CACHE[t]=c; return c; }
  function emote(c,t,dur){ c.emote={ img:emoteSprite(t), t:dur||2.4 }; }
  function remarkSprite(t){ if(REM_CACHE[t]) return REM_CACHE[t];
    var c=mkCanvas(150,44), g=c.getContext('2d');
    g.fillStyle='rgba(250,246,235,0.95)'; rr(g,2,2,146,30,10);
    g.beginPath(); g.moveTo(66,31); g.lineTo(74,43); g.lineTo(82,31); g.closePath(); g.fill();
    g.fillStyle='#2a1f16'; g.font='800 13px Nunito,sans-serif'; g.textAlign='center'; g.textBaseline='middle';
    g.fillText(t,75,17.5);
    REM_CACHE[t]=c; return c; }
  function remark(c,t){ c.emote={ img:remarkSprite(t), t:3.2, w:0.72, h:0.21 }; }
  var REM_GOOD=['Smells amazing in here 😍','Love this place ✨','That garlic though!','Cosy little spot','Prices are fair 👍','So clean in here','I could live here','Buonissimo!'];
  var REM_BAD=['Bit pricey, hmm','Where IS everyone?','Sticky table…','Slow tonight 😕','Menu’s a bit thin','Seen better trattorias'];
  function tableRemark(c){
    if(grubbiness()>4){ remark(c, pick(['Someone clear this?','A bit grubby…','Ew, sticky menu'])); return; }
    if(avgMarkup()>1.25){ remark(c, pick(['These prices though 😬','Cheaper down the road…','How much?!'])); return; }
    if(avgMarkup()<0.95){ remark(c, pick(['What a bargain!','Cheap AND good?','Prices are 🔥'])); return; }
    var goodOdds=clamp((avgRating()-1.5)/3, 0.15, 0.9);
    remark(c, Math.random()<goodOdds ? pick(REM_GOOD) : pick(REM_BAD));
  }

  // ====================== diners ======================
  var WALKOUT=75;                       // seconds a table will wait for its food before giving up
  function moveToward(c,sp){ var dx=c.target.x-c.x, dy=c.target.y-c.y, d=Math.hypot(dx,dy); if(d<0.08) return true;
    var s=Math.min(sp,d); c.x+=dx/d*s; c.y+=dy/d*s; return false; }
  function tillPt(){ if(!till) return doorPt; return frontOf(till,0.85); }
  function spawnDiner(){
    if(!till) return; if(!orderable().length) return;
    var seat=freeSeat(); if(!seat) return;
    var c={ x:doorPt.x+rnd(-0.3,0.3), y:doorPt.y, img:personSprite(pick(SKINS),pick(SHIRTS)),
      order:null, bill:0, patience:0, waitT:0, qd:0, t:0, table:seat.f, seat:seat.i,
      state:'toSeat', target:seatPts(seat.f)[seat.i] };
    diners.push(c);
  }
  // What they fancy: the special first, then the lasagna, and mostly things the
  // kitchen can actually make right now.
  function chooseOrder(){
    var opts=orderable(); if(!opts.length) return null;
    var pool=[];
    opts.forEach(function(k){ var w=1;
      if(k===special) w+=3;
      if(DISHES[k].signature) w+=1.5;
      if(canMake(k)) w*=3;
      for(var i=0;i<Math.round(w*2);i++) pool.push(k); });
    return pool.length?pick(pool):pick(opts); }

  function updateDiners(dt){
    var qList=diners.filter(function(c){ return c.state==='queue'; }).sort(function(a,b){ return a.qd-b.qd; });
    for(var i=diners.length-1;i>=0;i--){ var c=diners[i]; c.t+=dt;
      if(c.emote){ c.emote.t-=dt; if(c.emote.t<=0) c.emote=null; }

      if(c.state==='toSeat'){ c.target=seatPts(c.table)[c.seat];
        if(moveToward(c,0.75*dt)){ c.state='seated'; c.menuT=rnd(3,7); c.remarkT=rnd(1,3); } }

      else if(c.state==='seated'){ c.menuT-=dt; c.remarkT-=dt;
        if(c.remarkT<=0&&!c.emote){ tableRemark(c); c.remarkT=rnd(4,8); }
        if(!c.wentLoo && Math.random()<dt*0.015){ var lo=restrooms()[0];
          if(lo){ c.wentLoo=true; c.state='toLoo'; c.loo=lo; c.target=frontOf(lo,0.7); }
          else if(Math.random()<0.4){ c.wentLoo=true; emote(c,'🚻'); remark(c,'No restroom?!');
            pushReview(2,'Lovely food, but there isn’t a restroom.'); leave(c); } }
        if(c.menuT<=0){ var k=chooseOrder();
          if(!k){ remark(c,'Nothing on tonight?'); leave(c); }
          else { c.order=k; c.bill=DISHES[k].price; c.state='ordering'; c.waitT=0;
            emote(c,'🔔'); } } }

      else if(c.state==='toLoo'){ if(moveToward(c,0.75*dt)){ c.state='inLoo'; c.looT=3; emote(c,'🚻'); } }
      else if(c.state==='inLoo'){ c.looT-=dt;
        if(c.looT<=0){ if(Math.random()<0.35) dropMess(c.loo.x,c.loo.y);
          if(seatFree(c.table,c.seat)||true){ c.state='seated'; c.menuT=rnd(2,4); c.remarkT=rnd(1,3); c.target=seatPts(c.table)[c.seat]; } } }

      else if(c.state==='ordering'){ c.waitT+=dt;
        c.target=seatPts(c.table)[c.seat]; moveToward(c,0.75*dt);
        if(!c.emote && Math.random()<dt*0.25) emote(c, c.waitT>30?'😠': c.waitT>18?'⏳':'🔔');
        if(c.waitT>WALKOUT){ emote(c,'😡'); remark(c,'We’re going elsewhere.');
          pushReview(1,'Waited an hour for a plate of pasta. Walked out.');
          toast('😡 Table '+c.table.no+' walked out — nobody brought their food');
          c.table.dirty=Math.min(FURNITURE[c.table.fkey].seats,(c.table.dirty||0)+1); leave(c); } }

      else if(c.state==='eating'){ c.eatT-=dt;
        c.target=seatPts(c.table)[c.seat]; moveToward(c,0.75*dt);
        if(!c.emote && Math.random()<dt*0.2) emote(c,pick(['😋','😍','🍷','👌']));
        if(c.eatT<=0){ c.table.dirty=Math.min(FURNITURE[c.table.fkey].seats,(c.table.dirty||0)+1);
          if(Math.random()<0.18) dropMess(c.x,c.y);
          c.state='toTill'; c.target=tillPt(); } }

      else if(c.state==='toTill'){ c.target=tillPt(); if(moveToward(c,0.8*dt)) c.state='queue'; }

      else if(c.state==='queue'){ c.patience+=dt; var idx=qList.indexOf(c); c.qd=idx; var rp=tillPt();
        var payers=diners.some(function(o){ return o.state==='paying'; })?1:0;
        c.target={ x:rp.x, y:rp.y+(idx+payers)*0.5 }; moveToward(c,0.75*dt);
        if(!c.emote && c.patience>14 && Math.random()<dt*0.3) emote(c,'💸');
        if(c.patience>34){ pushReview(1,'Stood at the till with money in my hand. Nobody came.');
          toast('A diner left without paying 😠'); leave(c); } }

      else if(c.state==='paying'){ /* counting out their change at the till */ }

      else if(c.state==='leave'){ if(Math.random()<dt*0.02) dropMess(c.x,c.y);
        if(moveToward(c,1.0*dt)) diners.splice(i,1); }
    }
  }
  function leave(c){ c.state='leave'; c.target=doorPt; }

  // ====================== the brigade ======================
  var ROLES={
    maitre:{ name:'Maître d’', emo:'👔', cost:230, col:'#27408b', desc:'Runs the till so you never leave the kitchen' },
    waiter:{ name:'Waiter',    emo:'🍽️', cost:220, col:'#7a2f3a', desc:'Runs plates from the pass out to the tables' },
    chef:{   name:'Sous Chef', emo:'🧑‍🍳', cost:300, col:'#e8e2d4', desc:'Works the stations and cooks the tickets for you' },
    porter:{ name:'Kitchen Porter', emo:'📦', cost:190, col:'#c75b2a', desc:'Hauls delivered crates into the fridge and pantry' },
    busser:{ name:'Busser',    emo:'🧽', cost:180, col:'#2f7e4f', desc:'Clears dirty tables and mops up spills' },
    buyer:{  name:'Purchaser', emo:'🧾', cost:260, col:'#6a4a8c', desc:'Re-orders ingredients to the targets you set' }
  };
  function empSprite(role){ var r=ROLES[role];
    var c=personSprite('#e8c49a', r.col), g=c.getContext('2d');
    g.fillStyle='#fff'; g.fillRect(19,29,10,3);                                    // name badge
    if(role==='maitre'){ g.fillStyle='#1a1a1a'; g.fillRect(17,26,14,5); }           // bow tie / waistcoat
    else if(role==='chef'){ g.fillStyle='#f7f4ec'; g.fillRect(15,2,18,9); g.fillRect(17,10,14,3); }  // toque
    else if(role==='waiter'){ g.fillStyle='#f7f4ec'; g.beginPath(); g.ellipse(38,30,7,3,0,0,7); g.fill(); }  // tray
    else if(role==='busser'){ g.fillStyle='#caa14a'; g.fillRect(34,18,3,24); g.fillStyle='#e8e0cc'; g.fillRect(31,40,9,4); } // mop
    else if(role==='buyer'){ g.fillStyle='#f7f3e8'; g.fillRect(31,26,8,11); g.fillStyle='#3a4252'; g.fillRect(32,28,6,1.5); g.fillRect(32,31,6,1.5); }
    else { g.fillStyle='#ffd24a'; g.fillRect(13,30,22,3); g.fillRect(13,40,22,3); }
    return c; }
  function empIcon(role){ var c=mkCanvas(44,44), g=c.getContext('2d'); g.drawImage(empSprite(role),4,-6,36,54); return c; }
  function newEmployee(role){ return { role:role, x:doorPt.x, y:doorPt.y, img:empSprite(role), target:null,
    plate:null, crate:null, serveT:0, cleanT:0, orderT:0, stuckT:0, walkTo:null }; }
  function hireEmployee(role){ var cost=ROLES[role].cost; if(money<cost){ toast('Need $'+cost); return false; }
    money-=cost; employees.push(newEmployee(role));
    refreshHUD(); toast('Hired a '+ROLES[role].name+'!'); return true; }
  // Whichever crate holds what the kitchen is shortest on, nearest breaking ties —
  // grabbing the closest crate first would keep restocking pasta we're swimming in.
  function nextCrate(e){ var best=null,bs=1e9;
    floorCrates.forEach(function(b){ var s=pantryCount(b.ing)*10 + Math.hypot(b.x-e.x,b.y-e.y);
      if(s<bs){ bs=s; best=b; } });
    return best; }
  function dirtiestTable(e){ var best=null,bd=1e9;
    placed.forEach(function(f){ if(f.kind!=='table'||!f.dirty) return; var d=Math.hypot(f.x-e.x,f.y-e.y); if(d<bd){ bd=d; best=f; } });
    return best; }
  function idleSpot(e){ return frontOf(till||{x:mapW/2,y:mapH/2-0.5},-0.7); }

  function updateEmployees(dt){
    var sp=chairBoost();
    employees.forEach(function(e){
      if(e.role==='maitre'){
        if(!till){ e.target=doorPt; moveToward(e,1.8*dt); return; }
        e.target=frontOf(till,0.5); moveToward(e,2.0*dt);
        var c=queueFront();
        if(c && c.state==='queue' && c.qd===0){ e.serveT+=dt;
          if(e.serveT>=2.0/sp){ e.serveT=0; money+=c.bill; addReview(c); leave(c); refreshHUD(); toast('💵 +$'+c.bill); } }
        else e.serveT=0;
      }
      else if(e.role==='chef'){
        // stand at whichever station has a ticket, and put it on
        var want=null, wd=1e9;
        placed.forEach(function(f){ if(f.kind!=='station'||f.cookDish||f.plates.length>=STATION_MAX_PLATES) return;
          if(!nextDishFor(f,true)) return; var d=Math.hypot(f.x-e.x,f.y-e.y); if(d<wd){ wd=d; want=f; } });
        if(want){ e.target=frontOf(want,0.8);
          if(moveToward(e,2.1*dt)){ e.serveT+=dt; if(e.serveT>=0.8/sp){ e.serveT=0; startCook(want,nextDishFor(want,true),true); } } }
        else { e.serveT=0; e.target=idleSpot(e); moveToward(e,1.4*dt); }
      }
      else if(e.role==='waiter'){
        if(!e.plate){ // find a ready plate somebody is waiting for
          var got=null, gf=null;
          placed.forEach(function(f){ if(f.kind!=='station'||got) return;
            f.plates.some(function(p){ if(waiterTargetAt2(p)){ got=p; gf=f; return true; } return false; }); });
          if(got){ e.target=frontOf(gf,0.8);
            if(moveToward(e,2.2*dt)){ var ix=gf.plates.indexOf(got); if(ix>=0){ e.plate=gf.plates.splice(ix,1)[0]; } } }
          else { e.target=idleSpot(e); moveToward(e,1.4*dt); }
        } else {
          var c2=waiterTargetAt2(e.plate);
          if(c2){ e.stuckT=0; e.target=seatPts(c2.table)[c2.seat];
            if(moveToward(e,2.2*dt)){ serve(c2); e.plate=null; } }
          else { e.stuckT+=dt; e.target=idleSpot(e); moveToward(e,1.4*dt);
            if(e.stuckT>5){ e.stuckT=0;                              // nobody wants it — park it back on a pass
              var back=placed.filter(function(f){ return f.kind==='station'&&FURNITURE[f.fkey].st===DISHES[e.plate].st&&f.plates.length<STATION_MAX_PLATES; })[0];
              if(back){ back.plates.push(e.plate); e.plate=null; } } }
        }
      }
      else if(e.role==='porter'){
        if(!e.crate){ var box=nextCrate(e);
          if(box){ e.target={x:box.x,y:box.y};
            if(moveToward(e,2.2*sp*dt)){ e.crate={ing:box.ing,count:box.count}; floorCrates.splice(floorCrates.indexOf(box),1); } }
          else { e.target=idleSpot(e); moveToward(e,1.4*dt); } }
        else { var st=stores().filter(function(f){ return storeSpace(f)>0; })[0];
          if(st){ e.stuckT=0; e.target=frontOf(st,0.8);
            if(moveToward(e,2.2*dt)){ var mv=Math.min(storeSpace(st),e.crate.count);
              st.inv[e.crate.ing]=(st.inv[e.crate.ing]||0)+mv; e.crate.count-=mv; if(e.crate.count<=0) e.crate=null; } }
          else { e.stuckT+=dt; e.target=idleSpot(e); moveToward(e,1.4*dt);
            if(e.stuckT>4){ e.stuckT=0; floorCrates.push({x:e.x+rnd(-0.3,0.3),y:e.y+rnd(-0.3,0.3),ing:e.crate.ing,count:e.crate.count}); e.crate=null; } } }
      }
      else if(e.role==='busser'){
        var tb=dirtiestTable(e);
        if(tb){ e.target=frontOf(tb,0.85);
          if(moveToward(e,2.0*dt)){ e.cleanT+=dt; if(e.cleanT>=1.2/sp){ e.cleanT=0; tb.dirty=Math.max(0,tb.dirty-1); } } }
        else { var ms=nearestMess(e);
          if(ms){ e.target={x:ms.x,y:ms.y};
            if(moveToward(e,1.9*dt)){ e.cleanT+=dt; if(e.cleanT>=1.3/sp){ e.cleanT=0; var mi=messes.indexOf(ms); if(mi>=0) messes.splice(mi,1); } } }
          else { e.cleanT=0; e.target=idleSpot(e); moveToward(e,1.3*dt); } }
      }
      else { // purchaser: walks the room, tops the pantry back up to your targets
        e.orderT-=dt;
        e.target=e.walkTo||idleSpot(e);
        if(moveToward(e,1.2*dt)||!e.walkTo){ var ss=stores(); e.walkTo=ss.length?frontOf(pick(ss),0.9):idleSpot(e); }
        if(e.orderT<=0){ e.orderT=4;
          // Don't order into a restaurant with nowhere to put it: a wall of crates
          // by the door is worse than an empty shelf.
          if(totalSpace()<=0 || floorCrates.length>=6) return;
          ING_KEYS.forEach(function(k){ var want=ING_TARGETS[k]; if(!want) return;
            if(ownedCount(k)>=want) return;                         // counts crates still on the floor
            if(money<ING[k].cost) return;
            money-=ING[k].cost; deliverCrate(k); refreshHUD(); toast('🧾 Purchaser ordered '+ING[k].name); }); }
      }
    });
  }
  // the longest-waiting diner still owed this dish
  function waiterTargetAt2(dish){ var best=null,bw=-1;
    diners.forEach(function(c){ if(c.state==='ordering'&&c.order===dish&&c.waitT>bw){ bw=c.waitT; best=c; } });
    return best; }

  // ====================== the tick ======================
  function update(dt){
    dt=dt||DT;
    if(placing){ var gs=3.2*dt; if(keys.up) ghostY-=gs; if(keys.down) ghostY+=gs; if(keys.left) ghostX-=gs; if(keys.right) ghostX+=gs;
      ghostX=clamp(ghostX,1.3,mapW-1.3); ghostY=clamp(ghostY,1.3,mapH-1.3); refreshHUD(); return; }

    var mv=0,tn=0; if(keys.up)mv+=1; if(keys.down)mv-=1; if(keys.left)tn-=1; if(keys.right)tn+=1;
    if(tn) dir+=tn*2.3*dt;
    if(mv){ var pspd=2.7*(1+(chairBoost()-1)*0.4), nx=px+dirX*mv*pspd*dt, ny=py+dirY*mv*pspd*dt;
      if(walkable(nx,py)) px=nx; if(walkable(px,ny)) py=ny; }
    updateCamera();

    tickStations(dt);
    updateEmployees(dt);
    updateDiners(dt);

    wageT-=dt; if(wageT<=0){ wageT=30; var wage=10*employees.length;
      if(wage>0){ if(money>=wage) money-=wage;
        else { var q=employees.pop(); if(q) toast('Couldn’t make payroll — the '+ROLES[q.role].name+' walked'); } } }

    if(specialT>0){ specialT-=dt;
      if(specialT<=0){ toast('🍽️ The special is finished for today');
        pushReview(5,'Caught the special of the day — outstanding.'); special=null; } }
    if(specialCd>0) specialCd-=dt;

    // Arrivals follow your stars: y = 5x diners per minute (3.0★ → 15/min).
    spawnT-=dt;
    if(spawnT<=0){ var perMin=5*Math.max(0.4,avgRating());
      perMin*=(1+premBonus()*0.5);
      perMin*=clamp(RIVAL_MARKUP/Math.max(0.5,avgMarkup()),0.55,1.15);
      if(grubbiness()>4) perMin*=0.75;
      if(specialT>0) perMin*=1.6;
      spawnT=(60/perMin)*rnd(0.85,1.15);
      if(diners.length<20) spawnDiner(); }

    refreshHUD();
    if(toastT>0){ toastT-=dt; if(toastT<=0) document.getElementById('toast').hidden=true; }
  }

  // ====================== HUD ======================
  function ticketCount(){ var n=0; diners.forEach(function(c){ if(c.state==='ordering') n++; }); return n; }
  function refreshHUD(){ document.getElementById('money').textContent='$'+money;
    var ar=avgRating(); document.getElementById('rating').textContent='⭐ '+(ratingCount?ar.toFixed(1):'—');
    document.getElementById('covers').textContent='🍽️ '+covers;
    var tk=ticketCount(); var te=document.getElementById('tickets');
    te.textContent='🔔 '+tk; te.style.color=tk>3?'#ff9aa8':(tk?'#ffb0a0':'#cfd6ea');
    document.getElementById('rival').textContent='🍕 Rival '+rival.toFixed(1);
    document.getElementById('queue').textContent='🧍 '+diners.filter(function(c){ return c.state==='queue'; }).length;
    document.getElementById('phMoney').textContent='$'+money; }
  function toast(msg){ var t=document.getElementById('toast'); t.textContent=msg; t.hidden=false; toastT=2.6; }

  // ====================== order tickets ======================
  function ordOpen(){ return !document.getElementById('ordOv').hidden; }
  function closeOrd(){ document.getElementById('ordOv').hidden=true; }
  function openOrd(){ if(gstate!=='play'||placing||cashOpen()) return; buildOrd(); document.getElementById('ordOv').hidden=false; }
  function buildOrd(){
    var list=document.getElementById('ordList'); list.innerHTML='';
    var open=diners.filter(function(c){ return c.state==='ordering'; }).sort(function(a,b){ return b.waitT-a.waitT; });
    document.getElementById('ordSub').innerHTML = open.length
      ? '<b>'+open.length+'</b> ticket'+(open.length>1?'s':'')+' up. Cook it, carry it, then <b>Action</b> on the table.'
      : 'No tickets right now — a good moment to prep or restock.';
    open.forEach(function(c){
      var d=DISHES[c.order], st=stationWithPlate(c.order), cooking=placed.some(function(f){ return f.cookDish===c.order; });
      var row=document.createElement('div'); row.className='tick-row'+(st?' ready':(c.waitT>32?' late':''));
      var ic=document.createElement('canvas'); ic.width=38; ic.height=38; ic.className='ic';
      ic.getContext('2d').drawImage(DICON[c.order],0,0,38,38); row.appendChild(ic);
      var info=document.createElement('div'); info.className='info';
      var pct=clamp(c.waitT/WALKOUT,0,1), cls=pct>0.55?'bad':(pct>0.3?'warn':'');
      info.innerHTML='<div class="nm">'+d.name+'</div>'+
        '<div class="ds">Table '+c.table.no+' · $'+d.price+' · waiting '+Math.round(c.waitT)+'s</div>'+
        '<div class="wbar '+cls+'"><i style="width:'+Math.round(pct*100)+'%"></i></div>';
      row.appendChild(info);
      var tag=document.createElement('span');
      tag.className='tag '+(st?'ready':(cooking?'cooking':'wait'));
      tag.textContent= st?'ON THE PASS' : (cooking?'COOKING':(canMake(c.order)?'TO COOK':'NO STOCK'));
      row.appendChild(tag);
      list.appendChild(row); });
    if(!open.length){ var e=document.createElement('div'); e.className='rev';
      e.innerHTML='<div class="tx">Tip: with a quiet pass you can cook ahead — <b>Action</b> on a station makes its dearest dish and parks it ready.</div>';
      list.appendChild(e); }
  }
  document.getElementById('ordClose').addEventListener('click',closeOrd);

  // ====================== phone ======================
  var phoneTab='pantry';
  function phoneOpen(){ return !document.getElementById('phoneOv').hidden; }
  function openPhone(){ if(gstate!=='play'||placing||cashOpen()||ordOpen()) return; document.getElementById('phoneOv').hidden=false; buildPhone(); }
  function closePhone(){ document.getElementById('phoneOv').hidden=true; }
  function makeRow(iconCanvas,name,desc,buyLabel,enabled,onBuy,owned){ var row=document.createElement('div'); row.className='row';
    var ic=document.createElement('canvas'); ic.width=42; ic.height=42; ic.className='ic';
    if(iconCanvas) ic.getContext('2d').drawImage(iconCanvas,1,1,40,40); row.appendChild(ic);
    var info=document.createElement('div'); info.className='info'; info.innerHTML='<div class="nm">'+name+'</div><div class="ds">'+desc+'</div>'; row.appendChild(info);
    var slot=document.createElement('div'); slot.className='buyslot';
    if(buyLabel!=null){ var b=document.createElement('button'); b.className='buy'+(owned?' owned':''); b.textContent=buyLabel; b.disabled=!enabled; b.onclick=onBuy; slot.appendChild(b); }
    row.appendChild(slot); return row; }
  function grpHdr(t){ var h=document.createElement('div'); h.className='grp'; h.textContent=t; return h; }
  function furnIcon(k){ var c=mkCanvas(44,44), g=c.getContext('2d'), f=FURNITURE[k];
    g.fillStyle=f.color; g.fillRect(8,8,28,28);
    g.fillStyle=jitC(f.color,0.72); g.fillRect(8,8,28,6);
    g.strokeStyle=jitC(f.color,0.5); g.lineWidth=2; g.strokeRect(8,8,28,28);
    if(f.kind==='station'){ g.font='16px serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(STATIONS[f.st].emo,22,26); }
    else if(f.kind==='table'){ g.fillStyle='#f7f0e0'; g.beginPath(); g.arc(22,24,6,0,7); g.fill(); }
    else if(f.kind==='till'){ g.fillStyle='#7df0a8'; g.fillRect(14,14,16,6); }
    else { g.fillStyle='#caa14a'; g.fillRect(12,18,20,3); g.fillRect(12,26,20,3); }
    return c; }
  function roomIcon(){ var c=mkCanvas(44,44), g=c.getContext('2d'); g.strokeStyle='#e0c090'; g.lineWidth=3; g.strokeRect(7,7,30,30);
    g.strokeStyle='#7df0a8'; g.beginPath(); g.moveTo(22,37); g.lineTo(22,22); g.lineTo(37,22); g.stroke(); return c; }

  function buildPhone(){ refreshHUD();
    document.querySelectorAll('.ph-tab').forEach(function(b){ b.classList.toggle('active', b.dataset.tab===phoneTab); });
    var list=document.getElementById('phList'); list.innerHTML='';

    if(phoneTab==='pantry'){
      var cap=stores().reduce(function(s,f){ return s+FURNITURE[f.fkey].cap; },0);
      var used=stores().reduce(function(s,f){ return s+storeUsed(f); },0);
      var hd=document.createElement('div'); hd.className='rev';
      hd.innerHTML='<div class="st">🧺 Pantry '+used+'/'+cap+'</div><div class="tx">Crates land by the front door — carry them in and <b>Action</b> on a fridge or pantry. Set a 🧾 target and a hired <b>Purchaser</b> keeps it topped up.</div>';
      list.appendChild(hd);
      if(!stores().length){ var w=document.createElement('div'); w.className='rev';
        w.innerHTML='<div class="tx">⚠️ You have nowhere to store ingredients — buy a <b>Fridge</b> in 🪑 Fittings first.</div>'; list.appendChild(w); }
      else if(totalSpace()<=0){ var w2=document.createElement('div'); w2.className='rev';
        w2.innerHTML='<div class="tx">⚠️ Storage is full — crates will pile up by the door. Add another <b>Fridge</b> or <b>Pantry Shelf</b>.</div>'; list.appendChild(w2); }
      ING_KEYS.forEach(function(k){ var o=ING[k], inCrates=ownedCount(k)-pantryCount(k);
        var row=makeRow(IICON[k], o.emo+' '+o.name, 'Crate of '+o.crate+' · in the pantry <b>'+pantryCount(k)+'</b>'+
            (inCrates>0?' · <b>'+inCrates+'</b> still boxed up':''),
          'Buy $'+o.cost, money>=o.cost, function(){ if(money<o.cost) return; money-=o.cost; deliverCrate(k); refreshHUD(); buildPhone(); });
        var ctl=document.createElement('div'); ctl.className='price-ctl';
        var minus=document.createElement('button'); minus.textContent='–';
        var pv=document.createElement('span'); pv.className='pv'; pv.textContent='🧾'+(ING_TARGETS[k]||0);
        var plus=document.createElement('button'); plus.textContent='+';
        minus.onclick=function(ev){ ev.stopPropagation(); ING_TARGETS[k]=Math.max(0,(ING_TARGETS[k]||0)-6); pv.textContent='🧾'+ING_TARGETS[k]; };
        plus.onclick=function(ev){ ev.stopPropagation(); ING_TARGETS[k]=(ING_TARGETS[k]||0)+6; pv.textContent='🧾'+ING_TARGETS[k]; };
        ctl.appendChild(minus); ctl.appendChild(pv); ctl.appendChild(plus);
        row.querySelector('.buyslot').appendChild(ctl);
        list.appendChild(row); });
    }

    else if(phoneTab==='menu'){
      var sp=document.createElement('div'); sp.className='rev';
      sp.innerHTML='<div class="st">🍽️ Special of the Day — $40</div><div class="tx">Chalk one dish on the board for 3 minutes: <b>60% more diners</b> through the door and most of them order it.</div>';
      if(specialT>0){ var cur=document.createElement('div'); cur.className='tx'; cur.style.marginTop='6px';
        cur.innerHTML='Running now: <b>'+DISHES[special].name+'</b> — '+Math.ceil(specialT)+'s left'; sp.appendChild(cur); }
      else if(specialCd>0){ var cd=document.createElement('div'); cd.className='tx'; cd.style.marginTop='6px';
        cd.textContent='Next board in '+Math.ceil(specialCd)+'s'; sp.appendChild(cd); }
      list.appendChild(sp);
      ['oven','stove','pizza','cold','dolci','bar'].forEach(function(st){
        var ks=DISH_KEYS.filter(function(k){ return DISHES[k].st===st; }); if(!ks.length) return;
        list.appendChild(grpHdr(STATIONS[st].emo+'  '+STATIONS[st].name+(haveStation(st)?'':'  — no station yet')));
        ks.forEach(function(k){ var d=DISHES[k];
          var row=makeRow(DICON[k], d.name+(d.signature?' ⭐':''),
            recStr(d.rec)+' · '+d.cook+'s · ingredients ≈$'+d.cost.toFixed(2), null, false, null);
          var slot=row.querySelector('.buyslot');
          var ctl=document.createElement('div'); ctl.className='price-ctl';
          var minus=document.createElement('button'); minus.textContent='–';
          var pv=document.createElement('span'); pv.className='pv'; pv.textContent='$'+d.price;
          var plus=document.createElement('button'); plus.textContent='+';
          minus.onclick=function(){ d.price=Math.max(1,d.price-1); pv.textContent='$'+d.price; };
          plus.onclick=function(){ d.price=d.price+1; pv.textContent='$'+d.price; };
          ctl.appendChild(minus); ctl.appendChild(pv); ctl.appendChild(plus); slot.appendChild(ctl);
          var tb=document.createElement('button'); tb.className='buy mini';
          var sync=function(){ tb.textContent=menuOn[k]?'On':'Off'; tb.className='buy mini'+(menuOn[k]?'':' off'); };
          tb.onclick=function(){ menuOn[k]=!menuOn[k]; sync(); }; sync(); slot.appendChild(tb);
          var stb=document.createElement('button'); stb.className='buy mini';
          stb.textContent= special===k?'★':'☆';
          stb.style.background = special===k?'#caa14a':'#3a4252';
          stb.disabled = !(specialT<=0 && specialCd<=0 && money>=40 && haveStation(st) && menuOn[k]);
          stb.onclick=function(){ if(specialT>0||specialCd>0||money<40) return;
            money-=40; special=k; specialT=180; specialCd=300; menuOn[k]=true;
            toast('🍽️ Today’s special: '+d.name+'!'); refreshHUD(); buildPhone(); };
          slot.appendChild(stb);
          list.appendChild(row); }); });
    }

    else if(phoneTab==='furn'){
      var groups=[['Front of house',['till','table2','table4','booth']],
                  ['Kitchen',['stove','oven','pizzaoven','antipasti','dolcicase','espressobar']],
                  ['Storage',['fridge','pantry']],
                  ['Comfort & atmosphere',['winerack','olivetree','mandolin','restroom','stool','wall']]];
      groups.forEach(function(gp){ list.appendChild(grpHdr(gp[0]));
        gp[1].forEach(function(k){ var f=FURNITURE[k];
          var owned=(k==='till'&&till);
          var have=placed.filter(function(p){ return p.fkey===k; }).length;
          list.appendChild(makeRow(furnIcon(k), f.name+(k==='till'?' ★':'')+(have?' ×'+have:''), f.desc+' · $'+f.cost,
            owned?'Placed':'Buy $'+f.cost, !owned&&money>=f.cost, function(){
              if(owned||money<f.cost) return; money-=f.cost; refreshHUD(); closePhone(); startPlacing(k);
              toast('Arrows to move · ↻ rotate · ✓ place'); }, owned)); }); });
    }

    else if(phoneTab==='staff'){
      var hdr=document.createElement('div'); hdr.className='rev';
      hdr.innerHTML='<div class="tx">Staff work while you do something else — and cost <b>$10 each</b> every payday. Miss payroll and someone walks.</div>';
      list.appendChild(hdr);
      Object.keys(ROLES).forEach(function(r){ var o=ROLES[r];
        var n=employees.filter(function(e){ return e.role===r; }).length;
        list.appendChild(makeRow(empIcon(r), o.emo+' '+o.name+(n?' ×'+n:''), o.desc+' · $'+o.cost,
          'Hire $'+o.cost, money>=o.cost, function(){ if(hireEmployee(r)) buildPhone(); })); });
      if(employees.length){ var fo=document.createElement('div'); fo.className='rev';
        fo.innerHTML='<div class="st">On the clock: '+employees.length+'</div><div class="tx">Payroll $'+(10*employees.length)+' every 30s.</div>';
        list.appendChild(fo); }
    }

    else if(phoneTab==='rooms'){
      var info=document.createElement('div'); info.className='rev';
      info.innerHTML='<div class="tx">Your floor is <b>'+floorArea()+' squares</b>. Lay more at <b>$50 a square</b> anywhere it touches the restaurant — push the dining room out, dig a kitchen round the back, run a corridor. <b>Wall Sections</b> ($30, 🪑 Fittings) divide it up again.</div>';
      list.appendChild(info);
      list.appendChild(makeRow(roomIcon(), 'Lay new floor', 'Build mode — pick the squares you want · $50 each', 'Build', money>=50, function(){
        closePhone(); placing={carve:true,rot:0}; ghostX=clamp(px+dirX*1.2,1.5,mapW-1.5); ghostY=clamp(py+dirY*1.2,1.5,mapH-1.5); placeBar(true);
        toast('🧱 Pick squares next to your floor — ✓ to buy each, Esc to stop'); }));
    }

    else { // reviews
      var rb=document.createElement('div'); rb.className='ratebar'; var ar=avgRating();
      rb.innerHTML='<div><div class="big">'+(ratingCount?ar.toFixed(1):'—')+' ★</div><div class="lab">'+ratingCount+' reviews</div></div>'+
        '<div style="flex:1"></div><div style="text-align:right"><div class="lab">Rival trattoria</div><div class="big" style="color:#9fb0cf;font-size:1.1rem">'+rival.toFixed(1)+' ★</div></div>';
      list.appendChild(rb);
      var tr=document.createElement('div'); tr.className='rev';
      tr.innerHTML='<div class="st">🚶 '+Math.round(5*ar)+' diners/min</div><div class="tx">Trade follows your stars: <b>5 × rating</b> people walk in every minute. Better reviews, busier room.</div>';
      list.appendChild(tr);
      var tips=document.createElement('div'); tips.className='rev';
      tips.innerHTML='<div class="st">What the critics mark you on</div><div class="tx">Speed from ticket to plate · your markup over the recipe price · clean tables and floor ·'+
        ' the <b>lasagna</b> (people forgive a lot for it) · live music · a queue at the till.</div>';
      list.appendChild(tips);
      if(!reviews.length){ var e2=document.createElement('div'); e2.className='rev'; e2.innerHTML='<div class="tx">No reviews yet — serve someone!</div>'; list.appendChild(e2); }
      reviews.slice(0,12).forEach(function(r){ var d=document.createElement('div'); d.className='rev';
        d.innerHTML='<div class="st">'+'★'.repeat(r.stars)+'<span style="color:#3a4252">'+'★'.repeat(5-r.stars)+'</span></div><div class="tx">'+r.text+'</div>';
        list.appendChild(d); });
    }
  }
  // a crate goes straight into the pantry if there's room; the rest lands by the door
  function deliverCrate(ing){
    var n=ING[ing].crate, put=pantryPut(ing,n);
    if(put>0) toast('🧺 '+put+' '+ING[ing].name+' straight into the pantry');
    if(put>=n) return;
    floorCrates.push({ ing:ing, count:n-put, x:doorPt.x+rnd(-0.7,0.7), y:doorPt.y-0.6+rnd(-0.2,0.2) });
    if(put<=0) toast('📦 '+ING[ing].name+' delivered — it’s by the door'); }

  // ====================== input ======================
  var keys={up:false,down:false,left:false,right:false};
  var KMAP={ KeyW:'up',ArrowUp:'up', KeyS:'down',ArrowDown:'down', KeyA:'left',ArrowLeft:'left', KeyD:'right',ArrowRight:'right' };
  window.addEventListener('keydown',function(e){
    if(cashOpen()){ e.preventDefault(); return; }                     // counting change — finish the sale first
    if(ordOpen()){ if(e.code==='KeyO'||e.code==='Escape'||e.code==='KeyE'||e.code==='Space'){ closeOrd(); e.preventDefault(); } return; }
    if(saveOvOpen()){ if(e.code==='Escape') document.getElementById('saveOv').hidden=true; return; }
    if(phoneOpen()){ if(e.code==='Escape'||e.code==='KeyP') closePhone(); return; }
    if(KMAP[e.code]){ keys[KMAP[e.code]]=true; e.preventDefault(); return; }
    if(e.code==='Space'||e.code==='KeyE'){ doAction(); e.preventDefault(); }
    else if(e.code==='KeyP'){ openPhone(); }
    else if(e.code==='KeyO'){ openOrd(); }
    else if(e.code==='KeyR'){ rotateGhost(); }
    else if(e.code==='KeyF'){ moveTargetFurn(); }
    else if(e.code==='Escape'){ if(placing) cancelPlacing(); } });
  window.addEventListener('keyup',function(e){ if(KMAP[e.code]) keys[KMAP[e.code]]=false; });
  if(matchMedia('(pointer:coarse)').matches||'ontouchstart' in window) document.body.classList.add('touch');
  document.querySelectorAll('.dpad .btn').forEach(function(b){ var k=b.dataset.k;
    var on=function(e){ e.preventDefault(); keys[k]=true; }, off=function(e){ e.preventDefault(); keys[k]=false; };
    b.addEventListener('pointerdown',on); b.addEventListener('pointerup',off); b.addEventListener('pointerleave',off); b.addEventListener('pointercancel',off); });
  document.getElementById('actBtn').addEventListener('click',function(){ doAction(); });
  document.getElementById('ordBtn').addEventListener('click',function(){ if(ordOpen()) closeOrd(); else openOrd(); });
  document.getElementById('phoneBtn').addEventListener('click',function(){ if(placing) cancelPlacing(); else openPhone(); });
  document.getElementById('pbRotate').addEventListener('click',rotateGhost);
  document.getElementById('pbPlace').addEventListener('click',function(){ placeNow(); });
  document.getElementById('pbCancel').addEventListener('click',cancelPlacing);
  var dragId=null,dragX=0;
  cv.addEventListener('pointerdown',function(e){ if(phoneOpen()||cashOpen()||ordOpen()||gstate!=='play') return; dragId=e.pointerId; dragX=e.clientX; try{cv.setPointerCapture(e.pointerId);}catch(err){} });
  cv.addEventListener('pointermove',function(e){ if(e.pointerId!==dragId) return; var dx=e.clientX-dragX; dragX=e.clientX; dir+=dx*0.005; });
  function endDrag(e){ if(e.pointerId===dragId) dragId=null; }
  cv.addEventListener('pointerup',endDrag); cv.addEventListener('pointercancel',endDrag);
  document.querySelectorAll('.ph-tab').forEach(function(b){ b.addEventListener('click',function(){ phoneTab=b.dataset.tab; buildPhone(); }); });
  document.getElementById('phClose').addEventListener('click',closePhone);
  document.getElementById('phoneOv').addEventListener('click',function(e){ if(e.target===this) closePhone(); });
  document.getElementById('saveOvClose').addEventListener('click',function(){ document.getElementById('saveOv').hidden=true; });
  document.getElementById('slotSaveBtn').addEventListener('click',function(){
    var n=document.getElementById('slotName').value.trim()||'My Trattoria'; curSlot=n; writeSlot(n); });

  // ====================== boot ======================
  (function(){ var pc=document.getElementById('smidgePic');
    if(pc) pc.getContext('2d').drawImage(smidgeFace(86),0,0); })();
  document.getElementById('startBtn').addEventListener('click',function(){ document.getElementById('startOv').hidden=true; gstate='play'; reset(); });
  document.getElementById('continueBtn').addEventListener('click',function(){
    if(loadGame()){ document.getElementById('startOv').hidden=true; gstate='play'; toast('💾 Welcome back, Smidge!'); }
    else toast('Save didn’t load — starting fresh'); });
  document.getElementById('continueBtn').hidden=!hasSave();
  document.getElementById('saveBtn2').addEventListener('click',function(){ if(gstate==='play') openSaveOv(); });
  resize(); reset(); requestAnimationFrame(frame);

  // ====================== test harness ======================
  // Real-time RAF makes assertions racy, so `step(n, dt)` drives update() directly.
  window.__t={
    get money(){ return money; }, set money(v){ money=v; refreshHUD(); },
    get state(){ return gstate; }, set state(v){ gstate=v; },
    get placed(){ return placed; }, get crates(){ return floorCrates; }, get diners(){ return diners; },
    get carrying(){ return carrying; }, set carrying(v){ carrying=v; },
    get employees(){ return employees; }, get reviews(){ return reviews; },
    get rating(){ return avgRating(); }, get rival(){ return rival; }, get till(){ return till; },
    get covers(){ return covers; }, get messes(){ return messes; }, get placing(){ return placing; },
    get special(){ return special; }, get menuOn(){ return menuOn; }, get targets(){ return ING_TARGETS; },
    DISHES:DISHES, ING:ING, FURNITURE:FURNITURE, ROLES:ROLES, STATIONS:STATIONS,
    step:function(n,dt){ for(var i=0;i<(n||1);i++) update(dt||DT); },
    key:function(k,down){ if(keys.hasOwnProperty(k)) keys[k]=!!down; },
    placeAt:placeAt, doAction:doAction, render:render, spawn:spawnDiner, hire:hireEmployee,
    startPlacing:startPlacing, rotateGhost:rotateGhost, placeNow:placeNow, ghostValid:ghostValid,
    set ghost(p){ ghostX=p.x; ghostY=p.y; },
    deliver:deliverCrate, pantryPut:pantryPut, pantryCount:pantryCount, ownedCount:ownedCount,
    totalSpace:totalSpace, canMake:canMake, startCheckout:function(c){ startCheckout(c||queueFront()); },
    cook:function(f,k){ return startCook(f,k||nextDishFor(f)); },
    orderable:orderable, nextDishFor:nextDishFor, findTarget:findTarget,
    openPhone:openPhone, buildPhone:buildPhone, openOrd:openOrd, buildOrd:buildOrd,
    reset:reset, save:writeSlot, load:loadSlot, saveData:buildSaveData, apply:applySaveData,
    set px(v){ px=v; }, set py(v){ py=v; }, get px(){ return px; }, get py(){ return py; },
    set dir(v){ dir=v; updateCamera(); },
    faceTo:function(x,y){ dir=Math.atan2(y-py,x-px); updateCamera(); },
    walkTo:function(x,y){ px=x; py=y; updateCamera(); }
  };
})();
