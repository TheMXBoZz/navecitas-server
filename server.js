// ================================================================
//  NAVESISTAS.IO — Servidor Multijugador
//  Node.js + Socket.io
//  Arquitectura: Servidor autoritativo ligero
//  - El servidor lleva el estado canónico de todos los jugadores
//  - Bots corren en el servidor (no en el cliente)
//  - Clientes envían input, reciben estado del mundo
// ================================================================
'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  // Tick rate de transmisión al cliente (ms)
  // 50ms = 20 updates/seg, buen balance para hosting compartido
});

const PORT = process.env.PORT || 3000;

// ================================================================
//  CONSTANTES DEL MUNDO (espejadas del cliente)
// ================================================================
const WORLD      = 12800;
const SPEED_BASE = 260;
const TICK_MS    = 50;   // 20 ticks/seg servidor
const MAX_PLAYERS_PER_ROOM = 20;
const BOT_TARGET = 18; // bots fill up to 18, replaced by real players   // bots para rellenar hasta este número

// ================================================================
//  HELPERS
// ================================================================
const rng   = (a,b) => a + Math.random()*(b-a);
const rngI  = (a,b) => Math.floor(rng(a,b+1));
const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
const lerp  = (a,b,t) => a + (b-a)*t;
const dist  = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
const pick  = arr => arr[Math.floor(Math.random()*arr.length)];
let _uid = 1;
const nid = () => (_uid++).toString(36);

// ================================================================
//  CLASES DE NAVE
// ================================================================
const CLASSES = [
  {id:'guardian',  hpB:50,  spdM:.88, abCD:12, abDur:6,  cannon:{n:1,sp:0},  shootCD:.44},
  {id:'medic',     hpB:25,  spdM:.93, abCD:18, abDur:8,  cannon:{n:1,sp:0},  shootCD:.44},
  {id:'raider',    hpB:0,   spdM:1.1, abCD:10, abDur:3,  cannon:{n:2,sp:16}, shootCD:.38},
  {id:'phantom',   hpB:-10, spdM:1.08,abCD:20, abDur:10, cannon:{n:1,sp:0},  shootCD:.44},
  {id:'bomber',    hpB:30,  spdM:.85, abCD:14, abDur:1,  cannon:{n:3,sp:18}, shootCD:.50},
  {id:'sniper',    hpB:-15, spdM:1.05,abCD:8,  abDur:2,  cannon:{n:1,sp:0},  shootCD:.30},
  {id:'engineer',  hpB:20,  spdM:.90, abCD:22, abDur:15, cannon:{n:1,sp:0},  shootCD:.44},
  {id:'berserker', hpB:40,  spdM:.92, abCD:25, abDur:8,  cannon:{n:2,sp:14}, shootCD:.42},
];

const AMMO = [
  {dmg:10, spd:360, r:4, homing:false},
  {dmg:18, spd:480, r:5, homing:false},
  {dmg:26, spd:700, r:3, homing:false, pierce:true},
  {dmg:35, spd:340, r:7, homing:true},
];

// ================================================================
//  BOT NAMES & PERSONALITIES
// ================================================================
const BOT_NAMES = [
  'VoidRacer','StarCrusher','NebulaDrifter','CosmicHunter','DarkMatter',
  'XenonBlade','PlasmaWolf','AstroKiller','OrionPilot','GalaxyStar',
  'NullPtr','Stack','Kernel','Runtime','Debug','Malloc','Socket',
  'HackerBro','WallHack','AimAssist','GlobalElite','Spinbot',
  'IronWing','CryptoBot','NightShade','ShadowX','BinaryFox',
];
const usedBotNames = new Set();
function rndBotName(){
  let n;
  let tries = 0;
  do {
    n = pick(BOT_NAMES) + (Math.random()<.4 ? rngI(1,99) : '');
    tries++;
  } while(usedBotNames.has(n) && tries < 100);
  usedBotNames.add(n);
  return n;
}

// ================================================================
//  FACTORY: JUGADOR / BOT
// ================================================================
function makePlayer(name, x, y, classId, team, isBot, level=1, socketId=null){
  const cls = CLASSES.find(c=>c.id===classId) || CLASSES[0];
  return {
    id: socketId || nid(),
    socketId,
    name,
    isBot,
    team,
    x, y,
    vx: 0, vy: 0,
    angle: 0,
    classId,
    hp: 100 + cls.hpB,
    maxHp: 100 + cls.hpB,
    shield: 0,
    maxShield: 60,
    level,
    xp: 0,
    money: 0,
    kills: 0,
    deaths: 0,
    score: 0,
    alive: true,
    visible: true,
    invulnTimer: 0,
    shootTimer: 0,
    shootCooldown: cls.shootCD,
    ammoIdx: 0,
    speedLevel: 0,
    fireLevel: 0,
    defenseLevel: 0,
    fireRateLevel: 0,
    abilityTimer: 0,
    abilityCooldown: cls.abCD,
    abilityActive: false,
    abilityTimeLeft: 0,
    abilityDuration: cls.abDur,
    // Bot-only
    botState: 'roam',
    botTarget: null,
    botTimer: rng(.5, 2),
    botMoveTarget: null,
    botMemory: { lastDmgFrom: null, lastDmgTime: 0 },
  };
}

// ================================================================
//  FACTORY: BALA
// ================================================================
function makeBullet(owner, tx, ty){
  const am  = AMMO[owner.ammoIdx] || AMMO[0];
  const ang = Math.atan2(ty - owner.y, tx - owner.x);
  const dmgMult = 1 + (owner.fireLevel||0)*0.15;
  return {
    id: nid(),
    ownerId: owner.id,
    ownerTeam: owner.team,
    x: owner.x,
    y: owner.y,
    vx: Math.cos(ang) * am.spd,
    vy: Math.sin(ang) * am.spd,
    dmg: am.dmg * dmgMult,
    r: am.r,
    ammoIdx: owner.ammoIdx,
    homing: am.homing,
    pierce: am.pierce || false,
    life: 3.5,
  };
}

// ================================================================
//  FACTORY: METEORITO
// ================================================================
function makeMeteor(x, y, type){
  const cfgs = {
    small:  {r:11, hp:22,  xp:8,  money:3,  sides:4},
    medium: {r:22, hp:65,  xp:22, money:9,  sides:5},
    big:    {r:36, hp:160, xp:55, money:22, sides:6},
  };
  const c = cfgs[type];
  return {
    id: nid(), x, y, type, ...c,
    hp: c.hp, maxHp: c.hp,
    vx: rng(-20,20), vy: rng(-20,20),
    alive: true,
  };
}

// ================================================================
//  SALA DE JUEGO
// ================================================================
class GameRoom {
  constructor(id, mode){
    this.id       = id;
    this.mode     = mode;
    this.players  = [];   // jugadores reales + bots
    this.bullets  = [];
    this.meteors  = [];
    this.teamScore = { mars:0, earth:0 };
    this.matchTime = 0;
    this.lastTick  = Date.now();
    this._initWorld();
    this._tickInterval = setInterval(()=>this._tick(), TICK_MS);
  }

  // ── Inicializar meteoritos ──────────────────────────────────
  _initWorld(){
    const counts = {small:180, medium:70, big:30};
    for(const [type, count] of Object.entries(counts)){
      for(let i=0;i<count;i++){
        this.meteors.push(makeMeteor(rng(100,WORLD-100), rng(100,WORLD-100), type));
      }
    }
    // Spawnar bots iniciales
    this._refillBots();
  }

  // ── Añadir jugador real ─────────────────────────────────────
  addPlayer(socketId, name, classId, team){
    // Determinar spawn
    const spawnX = team==='mars' ? rng(200,800) : (team==='earth' ? rng(WORLD-800,WORLD-200) : rng(200,WORLD-200));
    const p = makePlayer(name, spawnX, rng(200,WORLD-200), classId, team, false, 1, socketId);
    this.players.push(p);
    this._refillBots();
    return p;
  }

  // ── Quitar jugador ──────────────────────────────────────────
  removePlayer(socketId){
    this.players = this.players.filter(p => p.socketId !== socketId);
  }

  // ── Rellenar con bots ───────────────────────────────────────
  _refillBots(){
    const humanCount = this.players.filter(p=>!p.isBot).length;
    const botCount   = this.players.filter(p=>p.isBot).length;
    const total      = humanCount + botCount;
    const need       = Math.max(0, BOT_TARGET - total);
    for(let i=0;i<need;i++){
      const lvl    = pick([2,3,4,5,5,6,6,7,8,9,10]);
      const cls    = pick(CLASSES);
      const team   = (this.mode==='solo'||this.mode==='br') ? 'none' : (Math.random()<.5?'mars':'earth');
      const bx     = team==='mars'?rng(100,WORLD/2):team==='earth'?rng(WORLD/2,WORLD-100):rng(200,WORLD-200);
      const bot    = makePlayer(rndBotName(), bx, rng(200,WORLD-200), cls.id, team, true, lvl);
      // Nivel-up automático
      for(let l=1;l<lvl;l++) this._botAutoUpgrade(bot);
      this.players.push(bot);
    }
  }

  // ── Auto-upgrade bot ────────────────────────────────────────
  _botAutoUpgrade(b){
    const r = Math.random();
    if(r<.33) b.maxHp += 8;
    else if(r<.66) b.speedLevel = (b.speedLevel||0)+1;
    else b.fireLevel = (b.fireLevel||0)+1;
  }

  // ── Procesar input de jugador real ──────────────────────────
  handleInput(socketId, input){
    const p = this.players.find(p=>p.socketId===socketId);
    if(!p || !p.alive) return;

    const dt   = TICK_MS / 1000;
    const spd  = SPEED_BASE * (CLASSES.find(c=>c.id===p.classId)?.spdM||1) * (1 + (p.speedLevel||0)*.08);
    let dx = 0, dy = 0;
    if(input.up)    dy -= 1;
    if(input.down)  dy += 1;
    if(input.left)  dx -= 1;
    if(input.right) dx += 1;
    if(dx&&dy){ dx*=.707; dy*=.707; }

    p.vx = lerp(p.vx, dx*spd, dt*9);
    p.vy = lerp(p.vy, dy*spd, dt*9);
    p.angle = input.angle || 0;

    // Disparar
    if(input.shooting){
      p.shootTimer -= dt;
      if(p.shootTimer <= 0){
        p.shootTimer = p.shootCooldown * (1 - (p.fireRateLevel||0)*.08);
        this.bullets.push(makeBullet(p, input.mx, input.my));
      }
    } else {
      p.shootTimer = Math.max(0, p.shootTimer - dt);
    }
  }

  // ── TICK del servidor ───────────────────────────────────────
  _tick(){
    const now = Date.now();
    const dt  = Math.min((now - this.lastTick)/1000, .1);
    this.lastTick = now;
    this.matchTime += dt;

    // Mover jugadores
    for(const p of this.players){
      if(!p.alive) continue;
      if(p.isBot) this._botTick(p, dt);
      p.x = clamp(p.x + p.vx*dt, 20, WORLD-20);
      p.y = clamp(p.y + p.vy*dt, 20, WORLD-20);
      if(p.x<=20||p.x>=WORLD-20) p.vx*=-.5;
      if(p.y<=20||p.y>=WORLD-20) p.vy*=-.5;
      if(p.invulnTimer>0) p.invulnTimer-=dt;
    }

    // Mover meteoritos
    for(const m of this.meteors){
      if(!m.alive) continue;
      m.x = clamp(m.x + m.vx*dt, 20, WORLD-20);
      m.y = clamp(m.y + m.vy*dt, 20, WORLD-20);
      if(m.x<=20||m.x>=WORLD-20) m.vx*=-.5;
      if(m.y<=20||m.y>=WORLD-20) m.vy*=-.5;
    }

    // Mover balas + colisiones
    this._updateBullets(dt);

    // Respawn meteoritos muertos
    const aliveMeteors = this.meteors.filter(m=>m.alive).length;
    if(aliveMeteors < 150){
      for(let i=0;i<5;i++){
        const t = pick(['small','small','medium','big']);
        this.meteors.push(makeMeteor(rng(100,WORLD-100), rng(100,WORLD-100), t));
      }
    }
    this.meteors = this.meteors.filter(m=>m.alive);

    // Recheck bots
    const botCount = this.players.filter(p=>p.isBot).length;
    if(botCount < BOT_TARGET - this.players.filter(p=>!p.isBot).length - 2){
      this._refillBots();
    }

    // Emitir estado a todos los clientes en la sala
    this._broadcast();
  }

  // ── Actualizar balas ────────────────────────────────────────
  _updateBullets(dt){
    for(const b of this.bullets){
      b.life -= dt;

      // Homing: buscar el enemigo más cercano
      if(b.homing){
        let nearest=null, nd=1e9;
        const owner = this.players.find(p=>p.id===b.ownerId);
        for(const p of this.players){
          if(!p.alive || p.id===b.ownerId) continue;
          if(owner && p.team!=='none' && p.team===owner.team) continue;
          const d=dist(b,p); if(d<nd){nd=d;nearest=p;}
        }
        if(nearest && nd < 600){
          const a = Math.atan2(nearest.y-b.y, nearest.x-b.x);
          b.vx = lerp(b.vx, Math.cos(a)*AMMO[3].spd, dt*3);
          b.vy = lerp(b.vy, Math.sin(a)*AMMO[3].spd, dt*3);
        }
      }

      b.x += b.vx*dt;
      b.y += b.vy*dt;

      if(b.x<0||b.x>WORLD||b.y<0||b.y>WORLD){ b.life=-1; continue; }

      // Colisión con jugadores
      for(const p of this.players){
        if(!p.alive || p.id===b.ownerId || p.invulnTimer>0) continue;
        const owner = this.players.find(q=>q.id===b.ownerId);
        if(owner && p.team!=='none' && p.team===owner.team) continue;
        if(dist(b,p) < (p.classId==='bomber'?22:18) + b.r){
          this._dmgPlayer(p, b.dmg, owner);
          if(!b.pierce) b.life=-1;
          break;
        }
      }

      // Colisión con meteoritos
      for(const m of this.meteors){
        if(!m.alive) continue;
        if(dist(b,m) < m.r + b.r){
          m.hp -= b.dmg;
          if(m.hp<=0){
            m.alive=false;
            const owner=this.players.find(p=>p.id===b.ownerId);
            if(owner){ owner.xp+=m.xp; owner.money+=m.money; this._checkLevelUp(owner); }
          }
          if(!b.pierce) b.life=-1;
          break;
        }
      }
    }
    this.bullets = this.bullets.filter(b=>b.life>0);
  }

  // ── Daño a jugador ──────────────────────────────────────────
  _dmgPlayer(p, dmg, attacker){
    // Escudo absorbe primero
    if(p.shield>0){
      const abs=Math.min(p.shield, dmg);
      p.shield-=abs; dmg-=abs;
    }
    p.hp -= dmg;
    if(p.hp<=0){
      p.hp=0; p.alive=false;
      p.deaths=(p.deaths||0)+1;
      if(attacker){
        attacker.kills=(attacker.kills||0)+1;
        attacker.score=(attacker.score||0)+100;
        attacker.xp=(attacker.xp||0)+p.level*35;
        attacker.money=(attacker.money||0)+rngI(10,30)+p.level*5;
        this._checkLevelUp(attacker);
      }
      if(p.isBot){
        setTimeout(()=>this._respawnBot(p), rng(5000,12000));
      } else {
        // Avisar al cliente que murió
        const sock = io.sockets.sockets.get(p.socketId);
        if(sock) sock.emit('you_died', {kills:p.kills, deaths:p.deaths, score:p.score});
      }
    }
  }

  // ── Level up ────────────────────────────────────────────────
  _checkLevelUp(p){
    const XPL = l => Math.floor(100*Math.pow(1.45,l-1));
    while(p.xp >= XPL(p.level)){
      p.xp -= XPL(p.level);
      p.level++;
      p.maxHp+=10; p.hp=Math.min(p.hp+30, p.maxHp);
      if(p.isBot) this._botAutoUpgrade(p);
    }
  }

  // ── Respawn bot ──────────────────────────────────────────────
  _respawnBot(b){
    b.hp=b.maxHp; b.alive=true; b.kills=0; b.deaths=(b.deaths||0);
    b.x=rng(200,WORLD-200); b.y=rng(200,WORLD-200);
    b.vx=0; b.vy=0;
    b.botState='roam'; b.botTarget=null;
    b.invulnTimer=3;
  }

  // ── Bot AI (simplificada pero funcional) ───────────────────
  _botTick(b, dt){
    b.botTimer-=dt;
    const spd = SPEED_BASE * (CLASSES.find(c=>c.id===b.classId)?.spdM||1) * (1+(b.speedLevel||0)*.08);
    const pers = { atkRange:400+b.level*15, fleeHp:.2+rng(0,.1) };

    if(b.botTimer<=0){
      b.botTimer=rng(.8,2.5);

      // Buscar enemigo
      let target=null, nd=1e9;
      for(const p of this.players){
        if(!p.alive||p.id===b.id) continue;
        if(b.team!=='none'&&p.team===b.team) continue;
        const d=dist(b,p); if(d<pers.atkRange&&d<nd){nd=d;target=p;}
      }

      if(b.hp/b.maxHp < pers.fleeHp){
        b.botState='flee';
        b.botMoveTarget={x:rng(100,WORLD-100), y:rng(100,WORLD-100)};
      } else if(target){
        b.botState='attack'; b.botTarget=target;
      } else {
        // Roam hacia un meteorito cercano para farmear
        let nearM=null, md=1e9;
        for(const m of this.meteors){
          if(!m.alive) continue;
          const d=dist(b,m); if(d<md){md=d;nearM=m;}
        }
        b.botState='farm';
        b.botMoveTarget=nearM||{x:rng(200,WORLD-200),y:rng(200,WORLD-200)};
      }
    }

    // Ejecutar estado
    if(b.botState==='attack'&&b.botTarget?.alive){
      const t=b.botTarget;
      const d=dist(b,t);
      const a=Math.atan2(t.y-b.y, t.x-b.x);
      b.angle=a;
      if(d>120){
        b.vx=lerp(b.vx,Math.cos(a)*spd,dt*6);
        b.vy=lerp(b.vy,Math.sin(a)*spd,dt*6);
      } else {
        b.vx=lerp(b.vx,0,dt*4); b.vy=lerp(b.vy,0,dt*4);
      }
      // Disparar
      if(d<pers.atkRange){
        b.shootTimer-=dt;
        if(b.shootTimer<=0){
          b.shootTimer=b.shootCooldown*(1-(b.fireRateLevel||0)*.08)+rng(0,.15);
          const err=rng(-.12,.12);
          this.bullets.push(makeBullet(b, t.x+Math.cos(err)*80, t.y+Math.sin(err)*80));
        }
      }
    } else if(b.botMoveTarget){
      const t=b.botMoveTarget;
      const a=Math.atan2(t.y-b.y, t.x-b.x);
      b.angle=a;
      const d=dist(b,t);
      if(d>60){
        b.vx=lerp(b.vx,Math.cos(a)*spd,dt*5);
        b.vy=lerp(b.vy,Math.sin(a)*spd,dt*5);
      } else {
        b.botMoveTarget=null; b.botTimer=0;
        b.vx=lerp(b.vx,0,dt*4); b.vy=lerp(b.vy,0,dt*4);
      }
      // Si es farm, disparar al meteorito
      if(b.botState==='farm'){
        b.shootTimer-=dt;
        if(b.shootTimer<=0&&d<200){
          b.shootTimer=b.shootCooldown+rng(0,.2);
          this.bullets.push(makeBullet(b, t.x, t.y));
        }
      }
    } else {
      b.vx=lerp(b.vx,0,dt*3); b.vy=lerp(b.vy,0,dt*3);
    }
  }

  // ── Broadcast estado del mundo ──────────────────────────────
  _broadcast(){
    // Snapshot ligero: solo lo que el cliente necesita para renderizar
    const snapshot = {
      t: Date.now(),
      players: this.players.filter(p=>p.alive).map(p=>({
        id:      p.id,
        name:    p.name,
        isBot:   p.isBot,
        team:    p.team,
        x:       Math.round(p.x),
        y:       Math.round(p.y),
        angle:   +p.angle.toFixed(3),
        classId: p.classId,
        hp:      Math.round(p.hp),
        maxHp:   p.maxHp,
        shield:  Math.round(p.shield),
        maxShield: p.maxShield,
        level:   p.level,
        kills:   p.kills,
        visible: p.visible,
        alive:   p.alive,
      })),
      bullets: this.bullets.map(b=>({
        id:b.id, x:Math.round(b.x), y:Math.round(b.y),
        ammoIdx:b.ammoIdx, ownerId:b.ownerId,
      })),
      meteors: this.meteors.filter(m=>m.alive).map(m=>({
        id:m.id, x:Math.round(m.x), y:Math.round(m.y),
        type:m.type, r:m.r, hp:m.hp, maxHp:m.maxHp,
      })),
      teamScore: this.teamScore,
      matchTime: Math.round(this.matchTime),
    };
    io.to(this.id).emit('state', snapshot);
  }

  destroy(){
    clearInterval(this._tickInterval);
  }
}

// ================================================================
//  GESTIÓN DE SALAS
// ================================================================
const rooms = new Map(); // roomId => GameRoom

function getOrCreateRoom(mode){
  // Buscar sala con espacio
  for(const [id, room] of rooms){
    if(room.mode===mode && room.players.filter(p=>!p.isBot).length < MAX_PLAYERS_PER_ROOM){
      return room;
    }
  }
  // Crear nueva sala
  const id = 'room_' + nid();
  const room = new GameRoom(id, mode);
  rooms.set(id, room);
  console.log(`[Room] Created ${id} mode=${mode}`);
  return room;
}

// ================================================================
//  SOCKET.IO EVENTOS
// ================================================================
io.on('connection', socket => {
  console.log(`[Socket] Connected: ${socket.id}`);
  let currentRoom = null;
  let myPlayer    = null;

  // Cliente listo para unirse a partida
  socket.on('join', ({name, classId, team, mode}) => {
    // Validar
    name    = (name||'Piloto').substring(0,16);
    classId = CLASSES.find(c=>c.id===classId) ? classId : 'guardian';
    mode    = ['solo','teams','br','ctf','koth'].includes(mode) ? mode : 'solo';
    team    = ['mars','earth','none'].includes(team) ? team : 'none';

    currentRoom = getOrCreateRoom(mode);
    myPlayer    = currentRoom.addPlayer(socket.id, name, classId, team);
    socket.join(currentRoom.id);

    socket.emit('joined', {
      myId:   myPlayer.id,
      roomId: currentRoom.id,
      mode:   currentRoom.mode,
    });

    console.log(`[Join] ${name} → room=${currentRoom.id} class=${classId} team=${team}`);
  });

  // Input del jugador (enviado cada frame desde el cliente)
  socket.on('input', input => {
    if(currentRoom) currentRoom.handleInput(socket.id, input);
  });

  // Solicitud de respawn
  socket.on('respawn', ({classId}) => {
    if(!currentRoom || !myPlayer) return;
    classId = CLASSES.find(c=>c.id===classId) ? classId : myPlayer.classId;
    const cls = CLASSES.find(c=>c.id===classId);
    const spawnX = myPlayer.team==='mars'?rng(200,800):(myPlayer.team==='earth'?rng(WORLD-800,WORLD-200):rng(200,WORLD-200));
    myPlayer.x=spawnX; myPlayer.y=rng(200,WORLD-200);
    myPlayer.hp=100+cls.hpB; myPlayer.maxHp=100+cls.hpB;
    myPlayer.alive=true; myPlayer.vx=0; myPlayer.vy=0;
    myPlayer.classId=classId;
    myPlayer.invulnTimer=3;
    socket.emit('respawned', {myId:myPlayer.id});
  });

  // Compra en tienda
  socket.on('buy', ({itemId}) => {
    if(!currentRoom||!myPlayer||!myPlayer.alive) return;
    const PRICES = {
      hp_boost:80, speed_boost:100, dmg_boost:120, firerate:130,
    };
    const cost = PRICES[itemId];
    if(!cost || myPlayer.money<cost) return;
    myPlayer.money-=cost;
    if(itemId==='hp_boost'){myPlayer.maxHp+=30;myPlayer.hp=Math.min(myPlayer.hp+30,myPlayer.maxHp);}
    if(itemId==='speed_boost') myPlayer.speedLevel=(myPlayer.speedLevel||0)+1;
    if(itemId==='dmg_boost')   myPlayer.fireLevel=(myPlayer.fireLevel||0)+1;
    if(itemId==='firerate')    myPlayer.fireRateLevel=(myPlayer.fireRateLevel||0)+1;
    socket.emit('bought', {itemId, money:myPlayer.money});
  });

  // Desconexión
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    if(currentRoom){
      currentRoom.removePlayer(socket.id);
      // Si sala vacía de humanos, destruirla después de un delay
      const humans = currentRoom.players.filter(p=>!p.isBot).length;
      if(humans===0){
        setTimeout(()=>{
          const r = rooms.get(currentRoom.id);
          if(r && r.players.filter(p=>!p.isBot).length===0){
            r.destroy();
            rooms.delete(currentRoom.id);
            console.log(`[Room] Destroyed ${currentRoom.id} (empty)`);
          }
        }, 30000);
      }
    }
  });
});

// ================================================================
//  SERVIR ARCHIVOS ESTÁTICOS (opcional si usas mismo servidor)
//  Si el hosting de Neubox sirve los assets, comenta esta línea
// ================================================================
app.use(express.static(path.join(__dirname, 'public')));

app.get('/status', (req,res)=>{
  const info = [...rooms.values()].map(r=>({
    id: r.id,
    mode: r.mode,
    humans: r.players.filter(p=>!p.isBot).length,
    bots: r.players.filter(p=>p.isBot).length,
    max: MAX_PLAYERS_PER_ROOM,
    display: r.players.filter(p=>!p.isBot).length+'/'+MAX_PLAYERS_PER_ROOM,
  }));
  res.json({rooms:info, totalConnected:io.engine.clientsCount});
});

// Room list for lobby UI
app.get('/rooms', (req,res)=>{
  const list = [...rooms.values()].map(r=>({
    id: r.id,
    mode: r.mode,
    players: r.players.filter(p=>!p.isBot).length,
    max: MAX_PLAYERS_PER_ROOM,
    open: r.players.filter(p=>!p.isBot).length < MAX_PLAYERS_PER_ROOM,
  }));
  res.json(list);
});

server.listen(PORT, ()=>{
  console.log(`🚀 Navesistas.io server en puerto ${PORT}`);
});
