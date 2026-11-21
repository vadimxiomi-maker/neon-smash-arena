const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const ARENA_SIZE = 1600;
const PLAYER_RADIUS = 22;
const TARGET_BOTS = 7;
const MATCH_KILL_GOAL = 1000;

const BOT_NAMES = ['CYBER_X', 'VIPER', 'NEON_GHOST', 'BLITZ', 'KRAKEN', 'ZERO_COOL', 'SHADOW', 'NOVA', 'REX', 'PULSE'];
const COLORS = ['#00f0ff', '#ff2a85', '#a855f7', '#22c55e', '#facc15', '#fb923c', '#38bdf8'];
const HULLS = ['circle', 'hex', 'triangle'];

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function generateObstacles() {
  const list = [];
  const count = Math.floor(Math.random() * 4) + 7;
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 160 + Math.random() * 460;
      const x = Math.round(ARENA_SIZE / 2 + Math.cos(angle) * dist);
      const y = Math.round(ARENA_SIZE / 2 + Math.sin(angle) * dist);
      const r = Math.floor(32 + Math.random() * 24);
      const overlaps = list.some(o => Math.hypot(o.x - x, o.y - y) < o.r + r + 95);
      if (!overlaps) {
        list.push({ x, y, r });
        break;
      }
    }
  }
  return list;
}

function createWorld(mode) {
  return {
    mode,
    players: new Map(),
    rivalry: new Map(),
    sessionKills: new Map(),
    eliminatedOrder: [],
    obstacles: generateObstacles(),
    bullets: [],
    powerups: [],
    airDropPlane: null,
    airDropTimer: 1500,
    matchTotalKills: 0,
    matchResetPause: 0,
    royaleStarted: false,
    safeZone: { x: ARENA_SIZE / 2, y: ARENA_SIZE / 2, radius: 740, targetRadius: 740 },
    zoneFrames: mode === 'royale' ? 900 : 1800
  };
}

const worlds = {
  arena: createWorld('arena'),
  royale: createWorld('royale')
};
const lobbies = new Map();


function getHumanCount(w) {
  let count = 0;
  for (const p of w.players.values()) if (!p.isBot) count++;
  return count;
}

function findSafeSpawnPoint(w) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = rand(60, Math.max(120, w.safeZone.radius * 0.65));
    const x = w.safeZone.x + Math.cos(angle) * dist;
    const y = w.safeZone.y + Math.sin(angle) * dist;
    const hitWall = w.obstacles.some(ob => Math.hypot(x - ob.x, y - ob.y) < ob.r + PLAYER_RADIUS + 20);
    if (!hitWall) return { x, y };
  }
  return { x: w.safeZone.x, y: w.safeZone.y };
}

function createPlayer(w, id, name, color, hull, isBot = false) {
  const h = hull || HULLS[Math.floor(Math.random() * HULLS.length)];
  const maxHp = h === 'hex' ? 140 : (h === 'triangle' ? 85 : 100);
  const pos = findSafeSpawnPoint(w);
  return {
    id,
    name: name || 'Боец',
    color: color || COLORS[Math.floor(Math.random() * COLORS.length)],
    hull: h,
    isBot,
    x: pos.x,
    y: pos.y,
    vx: 0,
    vy: 0,
    angle: 0,
    hp: maxHp,
    maxHp,
    lives: w.mode === 'royale' ? 3 : 1,
    kills: w.mode === 'arena' ? (w.sessionKills.get(name) || 0) : 0,
    streak: 0,
    dashCd: 0,
    shootCd: 0,
    tripleShot: 0,
    shield: 180,
    speedBoost: 0,
    hyperWeapon: 0,
    godMode: 0,
    berserk: 0,
    input: { up: false, down: false, left: false, right: false, shooting: false, angle: 0 },
    aiTimer: 0,
    aiTargetAngle: Math.random() * Math.PI * 2
  };
}
function spawnPowerup(w) {
  if (w.powerups.length >= 5) return;
  const types = ['heal', 'triple', 'shield', 'speed'];
  const type = types[Math.floor(Math.random() * types.length)];
  const pos = findSafeSpawnPoint(w);
  w.powerups.push({
    id: 'pw_' + Math.random().toString(36).slice(2, 8),
    type,
    x: pos.x,
    y: pos.y
  });
}

function launchAirDropPlane(w) {
  const startLeft = Math.random() < 0.5;
  const targetPos = findSafeSpawnPoint(w);
  w.airDropPlane = {
    x: startLeft ? -150 : ARENA_SIZE + 150,
    y: targetPos.y,
    vx: startLeft ? 11 : -11,
    dropX: targetPos.x,
    dropped: false
  };
  io.to(w.mode).emit('airdrop_alert', '✈️ ВНИМАНИЕ! Истребитель сбрасывает секретный груз!');
}

function fireBullet(w, p) {
  if (p.shootCd > 0) return;
  if (p.shield > 0 && p.shield <= 180 && p.godMode <= 0) p.shield = 0;

  let baseCd = p.hull === 'triangle' ? 11 : (p.hull === 'hex' ? 24 : 17);
  let dmg = p.hull === 'hex' ? 20 : (p.hull === 'triangle' ? 10 : 14);
  const spd = p.hull === 'triangle' ? 13 : (p.hull === 'hex' ? 10 : 11);

  if (p.hyperWeapon > 0) baseCd = 7;
  if (p.berserk > 0) dmg = Math.round(dmg * 1.8);

  p.shootCd = p.tripleShot > 0 ? Math.max(8, baseCd - 3) : baseCd;

  let angles = [p.angle];
  if (p.hyperWeapon > 0) {
    angles = [p.angle - 0.28, p.angle - 0.14, p.angle, p.angle + 0.14, p.angle + 0.28];
  } else if (p.tripleShot > 0) {
    angles = [p.angle - 0.16, p.angle, p.angle + 0.16];
  }

  angles.forEach(a => {
    w.bullets.push({
      id: 'b_' + Math.random().toString(36).slice(2, 9),
      ownerId: p.id,
      ownerName: p.name,
      color: p.hyperWeapon > 0 ? '#facc15' : (p.berserk > 0 ? '#ff2a85' : p.color),
      dmg,
      unstoppable: p.hyperWeapon > 0,
      x: p.x + Math.cos(a) * (PLAYER_RADIUS + 10),
      y: p.y + Math.sin(a) * (PLAYER_RADIUS + 10),
      vx: Math.cos(a) * spd,
      vy: Math.sin(a) * spd,
      life: 85
    });
  });

  p.vx -= Math.cos(p.angle) * (p.hull === 'hex' ? 1.5 : 0.8);
  p.vy -= Math.sin(p.angle) * (p.hull === 'hex' ? 1.5 : 0.8);
}

function triggerDash(w, p) {
  if (p.dashCd > 0) return;
  p.dashCd = p.hull === 'triangle' ? 50 : 75;
  const dashPower = (p.hull === 'triangle' ? 21 : (p.hull === 'hex' ? 15 : 18)) * (p.speedBoost > 0 ? 1.25 : 1);
  p.vx += Math.cos(p.angle) * dashPower;
  p.vy += Math.sin(p.angle) * dashPower;
  io.to(w.mode).emit('fx_event', { type: 'dash', x: p.x, y: p.y, color: p.color });
}

function resetWorld(w) {
  w.sessionKills.clear();
  w.rivalry.clear();
  w.eliminatedOrder = [];
  w.matchTotalKills = 0;
  w.bullets = [];
  w.powerups = [];
  w.airDropPlane = null;
  w.obstacles = generateObstacles();
  w.safeZone = { x: ARENA_SIZE / 2, y: ARENA_SIZE / 2, radius: 740, targetRadius: 740 };
  w.zoneFrames = w.mode === 'royale' ? 900 : 1800;

  for (const p of w.players.values()) {
    if (p.isBot) {
      w.players.delete(p.id);
    } else {
      const pos = findSafeSpawnPoint(w);
      p.x = pos.x;
      p.y = pos.y;
      p.kills = 0;
      p.streak = 0;
      p.lives = w.mode === 'royale' ? 3 : 1;
      p.hp = p.maxHp;
      p.shield = 180;
    }
  }
}

function maintainPopulation(w) {
  if (w.royaleStarted) return;

  const existingNames = new Set(Array.from(w.players.values()).map(p => p.name));
  let idx = 0;
  while (w.players.size < TARGET_BOTS + 1 && idx < BOT_NAMES.length) {
    const bName = BOT_NAMES[idx++];
    if (!existingNames.has(bName)) {
      const id = 'bot_' + w.mode + '_' + Math.random().toString(36).slice(2, 7);
      w.players.set(id, createPlayer(w, id, bName, null, null, true));
    }
  }
}

function updateBots(w) {
  const all = Array.from(w.players.values());
  for (const b of all) {
    if (!b.isBot) continue;

    let nearest = null;
    let minDist = Infinity;
    for (const other of all) {
      if (other.id === b.id) continue;
      const d = Math.hypot(other.x - b.x, other.y - b.y);
      if (d < minDist) { minDist = d; nearest = other; }
    }

    const distToCenter = Math.hypot(b.x - w.safeZone.x, b.y - w.safeZone.y);
    if (distToCenter > w.safeZone.radius * 0.78) {
      b.aiTargetAngle = Math.atan2(w.safeZone.y - b.y, w.safeZone.x - b.x);
    } else if (nearest) {
      b.angle = Math.atan2(nearest.y - b.y, nearest.x - b.x);
      if (b.aiTimer <= 0) {
        b.aiTimer = Math.floor(rand(20, 50));
        b.aiTargetAngle = b.angle + (minDist > 320 ? rand(-0.4, 0.4) : rand(1.1, 2.0));
      }
      if (minDist < 620 && Math.random() < 0.08) fireBullet(w, b);
      if (minDist < 180 && b.dashCd === 0 && Math.random() < 0.04) triggerDash(w, b);
    }

    b.aiTimer--;
    const bSpeed = b.speedBoost > 0 ? 0.9 : 0.65;
    b.vx += Math.cos(b.aiTargetAngle) * bSpeed;
    b.vy += Math.sin(b.aiTargetAngle) * bSpeed;
  }
}
function tickWorld(w) {
  if (w.mode === 'royale' && getHumanCount(w) === 0) return;

  if (w.matchResetPause > 0) {
    w.matchResetPause--;
    if (w.matchResetPause === 0) {
      resetWorld(w);
      if (w.mode === 'royale' && getHumanCount(w) > 0) {
        maintainPopulation(w);
        w.royaleStarted = true;
      }
      io.to(w.mode).emit('match_restarted');
    }
    return;
  }

  maintainPopulation(w);
  if (Math.random() < 0.025) spawnPowerup(w);

  w.airDropTimer--;
  if (w.airDropTimer <= 0 && !w.airDropPlane) {
    launchAirDropPlane(w);
    w.airDropTimer = 1800;
  }
  if (w.airDropPlane) {
    w.airDropPlane.x += w.airDropPlane.vx;
    if (!w.airDropPlane.dropped && Math.abs(w.airDropPlane.x - w.airDropPlane.dropX) < 15) {
      w.airDropPlane.dropped = true;
      w.powerups.push({
        id: 'gift_' + Math.random().toString(36).slice(2, 8),
        type: 'mystery',
        x: w.airDropPlane.dropX,
        y: w.airDropPlane.y
      });
      io.to(w.mode).emit('fx_event', { type: 'explosion', x: w.airDropPlane.dropX, y: w.airDropPlane.y, color: '#facc15' });
    }
    if (w.airDropPlane.x < -250 || w.airDropPlane.x > ARENA_SIZE + 250) {
      w.airDropPlane = null;
    }
  }

  w.zoneFrames--;
  if (w.zoneFrames <= 0) {
    if (w.mode === 'royale') {
      w.zoneFrames = 900;
      if (w.safeZone.targetRadius > 180) w.safeZone.targetRadius -= 110;
    } else {
      if (w.safeZone.targetRadius >= 720) {
        w.safeZone.targetRadius = Math.floor(rand(500, 610));
        w.zoneFrames = 300;
      } else {
        w.safeZone.targetRadius = 740;
        w.zoneFrames = 1800;
      }
    }
  }
  if (Math.abs(w.safeZone.radius - w.safeZone.targetRadius) > 0.5) {
    const speed = w.mode === 'royale' ? 0.015 : (w.safeZone.targetRadius < w.safeZone.radius ? 0.04 : 0.025);
    w.safeZone.radius += (w.safeZone.targetRadius - w.safeZone.radius) * speed;
  }

  updateBots(w);

  for (const p of w.players.values()) {
    if (p.dashCd > 0) p.dashCd--;
    if (p.shootCd > 0) p.shootCd--;
    if (p.tripleShot > 0) p.tripleShot--;
    if (p.shield > 0) p.shield--;
    if (p.speedBoost > 0) p.speedBoost--;
    if (p.hyperWeapon > 0) p.hyperWeapon--;
    if (p.godMode > 0) p.godMode--;
    if (p.berserk > 0) p.berserk--;

    if (!p.isBot) {
      let ax = 0, ay = 0;
      if (p.input.up) ay -= 1;
      if (p.input.down) ay += 1;
      if (p.input.left) ax -= 1;
      if (p.input.right) ax += 1;
      if (ax !== 0 || ay !== 0) {
        const len = Math.hypot(ax, ay);
        let accel = p.hull === 'triangle' ? 1.08 : (p.hull === 'hex' ? 0.68 : 0.85);
        if (p.speedBoost > 0 || p.berserk > 0) accel *= 1.38;
        p.vx += (ax / len) * accel;
        p.vy += (ay / len) * accel;
      }
      p.angle = p.input.angle;
      if (p.input.shooting) fireBullet(w, p);
    }

    p.vx *= 0.88;
    p.vy *= 0.88;
    p.x += p.vx;
    p.y += p.vy;

    for (const ob of w.obstacles) {
      const dxOb = p.x - ob.x;
      const dyOb = p.y - ob.y;
      const distOb = Math.hypot(dxOb, dyOb);
      const minDistOb = ob.r + PLAYER_RADIUS;
      if (distOb < minDistOb && distOb > 0) {
        const nx = dxOb / distOb;
        const ny = dyOb / distOb;
        p.x = ob.x + nx * minDistOb;
        p.y = ob.y + ny * minDistOb;
        p.vx += nx * 1.5;
        p.vy += ny * 1.5;
      }
    }
    const dx = p.x - w.safeZone.x;
    const dy = p.y - w.safeZone.y;
    const distFromZone = Math.hypot(dx, dy);
    const maxAllowed = w.safeZone.radius - PLAYER_RADIUS;

    if (distFromZone > maxAllowed) {
      const nx = dx / distFromZone;
      const ny = dy / distFromZone;
      p.x = w.safeZone.x + nx * maxAllowed;
      p.y = w.safeZone.y + ny * maxAllowed;
      p.vx -= nx * 3.5;
      p.vy -= ny * 3.5;
      if (p.shield <= 0 && p.godMode <= 0) p.hp -= 0.3;
      if (Math.random() < 0.25) {
        io.to(w.mode).emit('fx_event', { type: 'hit', x: p.x + nx * PLAYER_RADIUS, y: p.y + ny * PLAYER_RADIUS, color: '#ff2a85' });
      }
    }

    for (let i = w.powerups.length - 1; i >= 0; i--) {
      const pw = w.powerups[i];
      if (Math.hypot(p.x - pw.x, p.y - pw.y) < PLAYER_RADIUS + 20) {
        let buffLabel = '';
        if (pw.type === 'heal') { p.hp = Math.min(p.maxHp, p.hp + 45); buffLabel = '❤️ АПТЕЧКА (+45 HP)'; }
        if (pw.type === 'triple') { p.tripleShot = 480; buffLabel = '🔱 ТРОЙНОЙ ЗАЛП (8с)'; }
        if (pw.type === 'shield') { p.shield = 360; buffLabel = '🛡️ ЭНЕРГОЩИТ (6с)'; }
        if (pw.type === 'speed') { p.speedBoost = 420; buffLabel = '⚡ ТУРБО-СКОРОСТЬ (7с)'; }
        if (pw.type === 'mystery') {
          const gifts = ['hyper', 'god', 'ultra_heal', 'berserk'];
          const g = gifts[Math.floor(Math.random() * gifts.length)];
          if (g === 'hyper') { p.hyperWeapon = 420; buffLabel = '🎁 ГИПЕР-ПУШКА 5X (7с)!'; }
          if (g === 'god') { p.godMode = 360; p.shield = 360; buffLabel = '🎁 НЕУЯЗВИМОСТЬ (6с)!'; }
          if (g === 'ultra_heal') { p.hp = p.maxHp; p.shield = 300; buffLabel = '🎁 УЛЬТРА-ХИЛ 100% + ЩИТ!'; }
          if (g === 'berserk') { p.berserk = 420; p.speedBoost = 420; buffLabel = '🎁 РЕЖИМ БЕРСЕРКА 2X УРОН (7с)!'; }
        }
        if (!p.isBot && buffLabel) io.to(p.id).emit('buff_picked', buffLabel);
        io.to(w.mode).emit('fx_event', { type: 'pickup', x: pw.x, y: pw.y, color: pw.type === 'mystery' ? '#facc15' : '#22c55e' });
        w.powerups.splice(i, 1);
      }
    }

        if (p.hp <= 0) {
      io.to(w.mode).emit('fx_event', { type: 'explosion', x: p.x, y: p.y, color: p.color });
      const isRoyaleMatch = (w.mode === 'royale' || w.royaleStarted);

      if (isRoyaleMatch && p.lives > 1) {
        p.lives--;
        p.hp = p.maxHp;
        p.shield = 180;
        p.streak = 0;
        const pos = findSafeSpawnPoint(w);
        p.x = pos.x;
        p.y = pos.y;
        if (!p.isBot) io.to(p.id).emit('life_lost', { livesLeft: p.lives });
      } else {
        if (isRoyaleMatch) {
          w.eliminatedOrder.push({ id: p.id, name: p.name, kills: p.kills, color: p.color });
        }
        if (!p.isBot) {
          const place = isRoyaleMatch ? w.players.size : null;
          io.to(p.id).emit('you_died', { kills: p.kills, mode: isRoyaleMatch ? 'royale' : 'arena', place });
        }
        w.players.delete(p.id);

                if (isRoyaleMatch && w.royaleStarted && w.players.size === 1) {
          const champion = Array.from(w.players.values())[0];

          const second = w.eliminatedOrder[w.eliminatedOrder.length - 1];
          const third = w.eliminatedOrder[w.eliminatedOrder.length - 2];
          const top3 = [
            champion ? { name: champion.name, kills: champion.kills, color: champion.color } : null,
            second ? { name: second.name, kills: second.kills, color: second.color } : null,
            third ? { name: third.name, kills: third.kills, color: third.color } : null
          ].filter(Boolean);

                    w.royaleStarted = false;
          w.players.clear();
          io.to(w.mode).emit('match_finished', { top3, totalKills: w.matchTotalKills, isRoyale: true });

        }
      }
    }
  }
  for (let i = w.bullets.length - 1; i >= 0; i--) {
    const b = w.bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.life--;

    const bDist = Math.hypot(b.x - w.safeZone.x, b.y - w.safeZone.y);
    const hitObstacle = w.obstacles.some(ob => Math.hypot(b.x - ob.x, b.y - ob.y) < ob.r + 6);

    if (b.life <= 0 || bDist >= w.safeZone.radius || hitObstacle) {
      if (hitObstacle) io.to(w.mode).emit('fx_event', { type: 'hit', x: b.x, y: b.y, color: '#00f0ff' });
      w.bullets.splice(i, 1);
      continue;
    }

    let neutralized = false;
    for (let j = i - 1; j >= 0; j--) {
      const other = w.bullets[j];
      if (!other || other.ownerId === b.ownerId) continue;
      if (Math.hypot(b.x - other.x, b.y - other.y) < 14) {
        io.to(w.mode).emit('fx_event', { type: 'hit', x: (b.x + other.x) / 2, y: (b.y + other.y) / 2, color: '#ffffff' });
        if (b.unstoppable && !other.unstoppable) {
          w.bullets.splice(j, 1);
          i--;
        } else if (!b.unstoppable && other.unstoppable) {
          w.bullets.splice(i, 1);
          neutralized = true;
          break;
        } else if (!b.unstoppable && !other.unstoppable) {
          w.bullets.splice(i, 1);
          w.bullets.splice(j, 1);
          i--;
          neutralized = true;
          break;
        }
      }
    }
    if (neutralized) continue;

    for (const target of w.players.values()) {
      if (target.id === b.ownerId) continue;
      if (Math.hypot(target.x - b.x, target.y - b.y) < PLAYER_RADIUS + 8) {
        target.vx += b.vx * 0.45;
        target.vy += b.vy * 0.45;

        if (target.shield <= 0 && target.godMode <= 0) {
          const domKey = b.ownerName + '|' + target.name;
          const isDominated = (w.rivalry.get(domKey) || 0) >= 3;
          const rawDmg = b.dmg || 14;
          const finalDmg = isDominated ? Math.round(rawDmg * 0.65) : rawDmg;

          target.hp -= finalDmg;
          if (target.hp <= 0) {
            const killer = w.players.get(b.ownerId);
            if (killer) {
              killer.kills++;
              if (w.mode === 'arena') w.sessionKills.set(killer.name, killer.kills);
              killer.streak = (killer.streak || 0) + 1;
            }
            w.matchTotalKills++;

            const revKey = target.name + '|' + b.ownerName;
            const wasRevenge = (w.rivalry.get(revKey) || 0) >= 3;
            w.rivalry.set(revKey, 0);
            const newCount = (w.rivalry.get(domKey) || 0) + 1;
            w.rivalry.set(domKey, newCount);

            if (wasRevenge) io.to(w.mode).emit('kill_feed', { killer: '⚡ РЕВАНШ! ' + b.ownerName, victim: target.name });
            else if (newCount === 3) io.to(w.mode).emit('kill_feed', { killer: '👑 ДОМИНАЦИЯ! ' + b.ownerName, victim: target.name + ' (3:0)' });
            else io.to(w.mode).emit('kill_feed', { killer: b.ownerName, victim: target.name });

            if (w.mode === 'arena' && w.matchTotalKills >= MATCH_KILL_GOAL) {
              const top3 = Array.from(w.players.values())
                .sort((a, b) => b.kills - a.kills)
                .slice(0, 3)
                .map(pl => ({ name: pl.name, kills: pl.kills, color: pl.color }));
              w.matchResetPause = 480;
              io.to('arena').emit('match_finished', { top3, totalKills: w.matchTotalKills, isRoyale: false });
            }
          }
        }
        io.to(w.mode).emit('fx_event', { type: 'hit', x: b.x, y: b.y, color: b.color });
        w.bullets.splice(i, 1);
        break;
      }
    }
  }

  const activeDominations = [];
  for (const [key, count] of w.rivalry.entries()) {
    if (count >= 3) {
      const [dom, vic] = key.split('|');
      activeDominations.push({ dom, vic });
    }
  }

  io.to(w.mode).emit('arena_state', {
    mode: w.mode,
    arenaSize: ARENA_SIZE,
    safeZone: w.safeZone,
    obstacles: w.obstacles,
    airDropPlane: w.airDropPlane,
    matchTotalKills: w.matchTotalKills,
    matchGoal: MATCH_KILL_GOAL,
    zoneSec: Math.ceil(w.zoneFrames / 60),
    powerups: w.powerups,
    dominations: activeDominations,
    bullets: w.bullets.map(b => ({ x: b.x, y: b.y, color: b.color })),
    players: Array.from(w.players.values()).map(p => ({
      id: p.id, name: p.name, color: p.color, hull: p.hull, x: p.x, y: p.y,
      angle: p.angle, hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp,
      lives: p.lives, kills: p.kills, streak: p.streak || 0,
      shield: p.shield > 0, godMode: p.godMode > 0, dashReady: p.dashCd === 0
    }))
  });
}

setInterval(() => {
  tickWorld(worlds.arena);
  tickWorld(worlds.royale);
  for (const lobby of lobbies.values()) {
    if (lobby.world) tickWorld(lobby.world);
  }
}, 1000 / 60);

function getWorldByRoom(roomId) {
  if (!roomId || roomId === 'arena') return worlds.arena;
  if (roomId === 'royale') return worlds.royale;
  if (roomId.startsWith('custom_')) {
    const lobby = lobbies.get(roomId.replace('custom_', ''));
    return lobby ? lobby.world : null;
  }
  return null;
}

function broadcastLobby(code) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  io.to('lobby_' + code).emit('lobby_update', {
    code: lobby.code,
    hostId: lobby.hostId,
    members: Array.from(lobby.members.values())
  });
}

io.on('connection', (socket) => {
  socket.on('create_lobby', ({ name, color, hull, presetCode }) => {
    const code = presetCode || String(Math.floor(1000 + Math.random() * 9000));


    const cleanName = (name || '').trim().slice(0, 14) || ('Host_' + code);
    const lobby = { code, hostId: socket.id, members: new Map(), world: null };
    lobby.members.set(socket.id, { id: socket.id, name: cleanName, color, hull });
    lobbies.set(code, lobby);
    socket.join('lobby_' + code);
    socket.data.lobbyCode = code;
    broadcastLobby(code);
  });

  socket.on('join_lobby', ({ code, name, color, hull }) => {
    const cleanCode = String(code || '').trim();
    const lobby = lobbies.get(cleanCode);
    if (!lobby) {
      socket.emit('lobby_error', 'Комната #' + cleanCode + ' не найдена!');
      return;
    }
    const cleanName = (name || '').trim().slice(0, 14) || ('Player_' + Math.floor(rand(100, 999)));
    lobby.members.set(socket.id, { id: socket.id, name: cleanName, color, hull });
    socket.join('lobby_' + cleanCode);
    socket.data.lobbyCode = cleanCode;
    broadcastLobby(cleanCode);
  });

  socket.on('leave_lobby', () => {
    const code = socket.data.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    if (lobby) {
      lobby.members.delete(socket.id);
      if (lobby.members.size === 0) lobbies.delete(code);
      else {
        if (lobby.hostId === socket.id) lobby.hostId = Array.from(lobby.members.keys());
        broadcastLobby(code);
      }
    }
    socket.leave('lobby_' + code);
    socket.data.lobbyCode = null;
  });

  socket.on('start_lobby_match', ({ mode }) => {
    const code = socket.data.lobbyCode;
    const lobby = lobbies.get(code);
    if (!lobby || lobby.hostId !== socket.id) return;

    const selectedMode = mode === 'royale' ? 'royale' : 'arena';
    const roomChannel = 'custom_' + code;
    const w = createWorld(selectedMode);
    w.mode = roomChannel;
    lobby.world = w;

        for (const m of lobby.members.values()) {
      const s = io.sockets.sockets.get(m.id);
      if (s) {
        s.join(roomChannel);
        s.data.mode = roomChannel;
        const p = createPlayer(w, m.id, m.name, m.color, m.hull, false);
        w.players.set(m.id, p);
        s.emit('spawned', { id: m.id, mode: selectedMode });
      }
    }
    maintainPopulation(w);
    if (selectedMode === 'royale') {
      for (const pl of w.players.values()) pl.lives = 3;
      w.royaleStarted = true;
    }

  });

  socket.on('spawn', ({ name, color, hull, isFreshStart, mode }) => {
    const selectedMode = mode === 'royale' ? 'royale' : 'arena';
    socket.join(selectedMode);
    socket.data.mode = selectedMode;
    const w = worlds[selectedMode];

    const cleanName = (name || '').trim().slice(0, 14) || ('Fighter_' + Math.floor(rand(100, 999)));
    if (selectedMode === 'arena' && isFreshStart && getHumanCount(w) === 0) {
      w.sessionKills.delete(cleanName);
      w.obstacles = generateObstacles();
    }

        if (socket.data.mode && socket.data.mode !== selectedMode) {
      const oldW = getWorldByRoom(socket.data.mode);
      if (oldW) oldW.players.delete(socket.id);
      socket.leave(socket.data.mode);
    }

       w.players.delete(socket.id);
    const humansNow = getHumanCount(w);
    const needRoyaleReset = selectedMode === 'royale' && (humansNow === 0 || !w.royaleStarted || w.players.size <= 1);
    if (needRoyaleReset) {
      w.players.clear();
      resetWorld(w);
    }

    const p = createPlayer(w, socket.id, cleanName, color, hull, false);
    w.players.set(socket.id, p);

    if (needRoyaleReset) {
      maintainPopulation(w);
      w.royaleStarted = true;
    }

    socket.emit('spawned', { id: socket.id, mode: selectedMode });

  });

  socket.on('input', (data) => {
    const w = getWorldByRoom(socket.data.mode);
    const p = w && w.players.get(socket.id);
    if (p) p.input = data;
  });

  socket.on('shoot', () => {
    const w = getWorldByRoom(socket.data.mode);
    const p = w && w.players.get(socket.id);
    if (p) fireBullet(w, p);
  });

  socket.on('dash', () => {
    const w = getWorldByRoom(socket.data.mode);
    const p = w && w.players.get(socket.id);
    if (p) triggerDash(w, p);
  });

  socket.on('leave_arena', () => {
    const ch = socket.data.mode;
    const w = getWorldByRoom(ch);
    if (!w) return;
    const p = w.players.get(socket.id);
    if (p && w.mode === 'arena') w.sessionKills.delete(p.name);
    w.players.delete(socket.id);
    socket.leave(ch);
  });

  socket.on('disconnect', () => {
    if (socket.data.lobbyCode) {
      const lobby = lobbies.get(socket.data.lobbyCode);
      if (lobby) {
        lobby.members.delete(socket.id);
        if (lobby.members.size === 0) lobbies.delete(socket.data.lobbyCode);
        else broadcastLobby(socket.data.lobbyCode);
      }
    }
    const w = getWorldByRoom(socket.data.mode);
    if (!w) return;
    const p = w.players.get(socket.id);
    if (p && w.mode === 'arena' && getHumanCount(w) <= 1) w.sessionKills.delete(p.name);
    w.players.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('NEON SMASH ARENA running on http://localhost:' + PORT));
