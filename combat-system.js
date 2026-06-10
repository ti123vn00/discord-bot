/**
 * combat-system.js
 * Quản lý logic trận đấu: HP, Stamina, turn order, effect ticking, Injury, Shin/Mang
 */

const { rollWeaponDamage, rollCriticalDice, getWeapon, ACTION_COSTS } = require("./weapons");

const COMBAT_STATE = new Map(); // battleId -> battle data
const SHIN_ENABLED_USERS = new Set(); // Usernames enabled to use Shin/Mang (populate từ database)

/**
 * Tạo battle ID duy nhất
 */
function generateBattleId() {
  return `battle_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Khởi tạo trận đấu mới
 */
function createBattle(gmId, battleName) {
  const battleId = generateBattleId();
  COMBAT_STATE.set(battleId, {
    battleId,
    gmId,
    battleName,
    participants: [], // { userId, name, hp, maxHp, sta, maxSta, light, maxLight, sanity, maxSanity, weapon, res: {B,P,S}, buff: {}, debuff: {}, effects: {}, injuries: [], emotionLevel: 0, totalDmgDealt: 0, isShinActive: false, staSinceLastLight: 0 }
    bosses: [],       // { bossId, name, hp, maxHp, sta, maxSta, sanity, maxSanity, res: {B,P,S}, buff: {}, debuff: {}, effects: {} }
    turnIndex: 0,     // 0 = boss turn, 1+ = player turn index
    currentTurnActor: null, // { type: "boss"/"player", id }
    log: [],          // 15 action gần nhất
    turnNumber: 1,
    turnPhase: "boss", // "boss" / "player" / "end"
    status: "ongoing",
    currentPlayerTurnIdx: 0, // Index player hiện tại trong turn
  });
  return battleId;
}

/**
 * Thêm boss vào trận
 */
function addBoss(battleId, bossData) {
  const battle = COMBAT_STATE.get(battleId);
  if (!battle) return false;

  const bossId = `boss_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const boss = {
    bossId,
    name: bossData.name,
    hp: bossData.hp,
    maxHp: bossData.hp,
    sta: bossData.sta || 100,
    maxSta: bossData.sta || 100,
    sanity: bossData.sanity || 0,
    maxSanity: 45,
    res: bossData.res || { B: 1, P: 1, S: 1 },
    buff: {},
    debuff: {},
    effects: {}, // burn, bleed, rupture, tremor, sinking, etc.
  };
  battle.bosses.push(boss);
  addLog(battleId, `🐉 Boss **${boss.name}** tham gia trận [HP: ${boss.hp}/${boss.maxHp}]`);
  return bossId;
}

/**
 * Thêm player vào trận
 */
function addPlayer(battleId, userId, playerData) {
  const battle = COMBAT_STATE.get(battleId);
  if (!battle) return false;

  const weapon = getWeapon(playerData.weaponId);
  if (!weapon) return false;

  const participant = {
    userId,
    name: playerData.name,
    hp: playerData.hp,
    maxHp: playerData.hp,
    sta: playerData.sta || 100,
    maxSta: playerData.sta || 100,
    light: playerData.light || 0,
    maxLight: playerData.maxLight || 4,
    sanity: 0, // Always start at 0
    maxSanity: 45,
    weapon: weapon.id,
    res: playerData.res || { B: 1, P: 1, S: 1 },
    buff: {},
    debuff: {},
    effects: {}, // burn, bleed, rupture, poise, etc.
    injuries: [], // gãy tay, gãy chân, gãy xương, choáng, mất tay, mất chân, vết thương lớn
    emotionLevel: 0, // 0 / 1 / 2
    emotionTurnCounter: 0,
    totalDmgDealt: 0,
    isShinActive: false,
    staSinceLastLight: 0,
    isStaggered: false,
    staggerTurnCounter: 0,
    isPanic: false,
    skillCd: {}, // skillId -> remainingCd
  };
  battle.participants.push(participant);
  addLog(battleId, `⚔️ Player **${participant.name}** tham gia trận [HP: ${participant.hp}/${participant.maxHp}]`);
  return true;
}

/**
 * Trừ HP với tính toán Res
 * dmgData = { amount, type: "B"/"P"/"S", source: "player"/"boss" }
 */
function takeDamage(battleId, targetType, targetId, dmgData) {
  const battle = COMBAT_STATE.get(battleId);
  if (!battle) return null;

  let target = null;
  if (targetType === "boss") {
    target = battle.bosses.find(b => b.bossId === targetId);
  } else {
    target = battle.participants.find(p => p.userId === targetId);
  }
  if (!target) return null;

  const res = target.res[dmgData.type] || 1;
  const finalDmg = Math.ceil(dmgData.amount * res);
  
  // Check injury debuffs
  if (target.injuries && targetType === "player") {
    if (target.injuries.includes("mất-tay")) {
      const reducedDmg = Math.ceil(finalDmg * 0.5);
      addLog(battleId, `⚠️ ${target.name} bị "Mất Tay" - Dmg từ ${finalDmg} → ${reducedDmg}`);
      target.hp = Math.max(0, target.hp - reducedDmg);
      return { finalDmg: reducedDmg, targetHp: target.hp, maxHp: target.maxHp };
    }
    if (target.injuries.includes("vết-thương-lớn")) {
      target.maxHp = Math.max(1, target.maxHp - 100);
      addLog(battleId, `⚠️ ${target.name} bị "Vết Thương Lớn" - Max HP → ${target.maxHp}`);
    }
  }

  target.hp = Math.max(0, target.hp - finalDmg);
  addLog(battleId, `💥 ${target.name} nhận ${finalDmg} DMG [${dmgData.type}] (Res: ${res}x) | HP: ${target.hp}/${target.maxHp}`);

  // Check injury trigger (dmg > 30% maxHp)
  if (targetType === "player" && finalDmg > target.maxHp * 0.3) {
    const injuryRoll = Math.random() * 100;
    if (injuryRoll < 10) {
      applyHeavyInjury(battleId, targetId);
    } else if (injuryRoll < 50) {
      applyLightInjury(battleId, targetId);
    }
  }

  return { finalDmg, targetHp: target.hp, maxHp: target.maxHp };
}

/**
 * Apply light injury (10% when dmg > 30% HP)
 */
function applyLightInjury(battleId, playerId) {
  const battle = COMBAT_STATE.get(battleId);
  const player = battle.participants.find(p => p.userId === playerId);
  if (!player) return;

  const injuryTypes = ["gãy-tay", "gãy-chân", "gãy-xương", "choáng"];
  const injury = injuryTypes[Math.floor(Math.random() * injuryTypes.length)];

  if (!player.injuries.includes(injury)) {
    player.injuries.push(injury);
    addLog(battleId, `🩹 ${player.name} bị chấn thương nhẹ: **${injury}**`);
  }
}

/**
 * Apply heavy injury (40% when dmg > 30% HP)
 */
function applyHeavyInjury(battleId, playerId) {
  const battle = COMBAT_STATE.get(battleId);
  const player = battle.participants.find(p => p.userId === playerId);
  if (!player) return;

  const injuryTypes = ["mất-tay", "mất-chân", "vết-thương-lớn"];
  const injury = injuryTypes[Math.floor(Math.random() * injuryTypes.length)];

  if (!player.injuries.includes(injury)) {
    player.injuries.push(injury);
    addLog(battleId, `💀 ${player.name} bị chấn thương nặng: **${injury}**`);
  }
}

/**
 * Player action: Đánh
 */
function playerAttack(battleId, playerId) {
  const battle = COMBAT_STATE.get(battleId);
  const player = battle.participants.find(p => p.userId === playerId);
  if (!player || battle.bosses.length === 0) return null;

  const weapon = getWeapon(player.weapon);
  const staCost = weapon.staCost;

  if (player.sta < staCost) {
    addLog(battleId, `❌ ${player.name} không đủ Stamina`);
    return { error: "Không đủ Stamina" };
  }

  const dmgRoll = rollWeaponDamage(weapon);
  player.sta -= staCost;
  player.staSinceLastLight += staCost;

  // Apply Sanity modifier: mỗi -1 sanity = -1% dice
  const sanityMod = 1 - Math.abs(player.sanity) / 100;
  const modifiedDmg = Math.ceil(dmgRoll * sanityMod);

  const boss = battle.bosses[0];
  const dmgData = { amount: modifiedDmg, type: weapon.type, source: "player" };
  const hitResult = takeDamage(battleId, "boss", boss.bossId, dmgData);

  player.totalDmgDealt += modifiedDmg;
  checkEmotionLevel(battleId, playerId);

  addLog(battleId, `⚔️ ${player.name} [${weapon.name}] → Roll: ${dmgRoll} (Sanity mod: ${sanityMod.toFixed(2)}) → ${modifiedDmg} DMG`);

  return { player, weapon, roll: dmgRoll, modifiedDmg, hitResult };
}

/**
 * Player action: Né
 */
function playerDodge(battleId, playerId) {
  const player = COMBAT_STATE.get(battleId).participants.find(p => p.userId === playerId);
  if (!player) return null;

  // Check injury: mất chân = không thể né
  if (player.injuries.includes("mất-chân")) {
    addLog(battleId, `❌ ${player.name} không thể né vì bị mất chân`);
    return { error: "Bị mất chân - không thể né" };
  }

  let staCost = 20;
  // Gãy chân: mất gấp đôi stamina để né
  if (player.injuries.includes("gãy-chân")) staCost = 40;

  if (player.sta < staCost) {
    return { error: "Không đủ Stamina" };
  }

  player.sta -= staCost;
  addLog(battleId, `💨 ${player.name} né (Sta: -${staCost})`);
  return { success: true, sta: staCost };
}

/**
 * Player action: Guard
 */
function playerGuard(battleId, playerId) {
  const player = COMBAT_STATE.get(battleId).participants.find(p => p.userId === playerId);
  if (!player) return null;

  if (player.sta < 10) {
    return { error: "Không đủ Stamina" };
  }

  player.sta -= 10;
  addLog(battleId, `🛡️ ${player.name} Guard (Sta: -10)`);
  return { success: true };
}

/**
 * Player action: Parry (d20 vs d16)
 * Nếu thắng: no dmg, +10 sanity
 * Nếu thua: -40 sta, nhận full dmg, -10 sanity
 */
function playerParry(battleId, playerId) {
  const player = COMBAT_STATE.get(battleId).participants.find(p => p.userId === playerId);
  if (!player) return null;

  // Check injury: gãy tay/gãy xương = trừ dice parry
  let playerDice = 20;
  if (player.injuries.includes("gãy-tay")) playerDice -= 5;
  if (player.injuries.includes("gãy-xương")) playerDice -= 30;
  if (player.injuries.includes("mất-tay")) playerDice -= 10;

  playerDice = Math.max(1, playerDice);

  const bossParryDice = Math.floor(Math.random() * 16) + 1; // d16
  const playerParryDice = Math.floor(Math.random() * playerDice) + 1;

  const success = playerParryDice >= bossParryDice;

  if (success) {
    player.sanity = Math.min(45, player.sanity + 10);
    addLog(battleId, `🎯 ${player.name} Parry thành công! [${playerParryDice} vs ${bossParryDice}] (+10 Sanity)`);
    return { success: true, clash: true, sanityChange: 10 };
  } else {
    player.sta = Math.max(0, player.sta - 40);
    player.sanity = Math.max(-45, player.sanity - 10);
    addLog(battleId, `❌ ${player.name} Parry thất bại [${playerParryDice} vs ${bossParryDice}] (-40 Sta, -10 Sanity)`);
    return { success: false, clash: true, staLoss: 40, sanityChange: -10 };
  }
}

/**
 * Check & update Emotion Level
 */
function checkEmotionLevel(battleId, playerId) {
  const player = COMBAT_STATE.get(battleId).participants.find(p => p.userId === playerId);
  if (!player) return;

  if (player.totalDmgDealt >= 500 && player.emotionLevel < 2) {
    player.emotionLevel = 2;
    player.emotionTurnCounter = 0;
    player.maxLight = Math.min(6, player.maxLight + 2);
    addLog(battleId, `🔥 ${player.name} đạt Emotion Level 2! (Max Light +2)`);
  } else if (player.totalDmgDealt >= 200 && player.emotionLevel < 1) {
    player.emotionLevel = 1;
    player.emotionTurnCounter = 0;
    player.maxLight = Math.min(6, player.maxLight + 1);
    addLog(battleId, `🔥 ${player.name} đạt Emotion Level 1! (Max Light +1)`);
  }
}

/**
 * Tick effect damage (Burn, Bleed, etc) + apply Stagger/Panic
 */
function tickEffects(battleId, targetType, targetId) {
  const battle = COMBAT_STATE.get(battleId);
  let target = null;

  if (targetType === "boss") {
    target = battle.bosses.find(b => b.bossId === targetId);
  } else {
    target = battle.participants.find(p => p.userId === targetId);
  }

  if (!target) return;

  // Burn: dmg = 2x count, then halve
  if (target.effects.burn && target.effects.burn > 0) {
    const burnDmg = target.effects.burn * 2;
    target.hp = Math.max(0, target.hp - burnDmg);
    target.effects.burn /= 2;
    if (target.effects.burn < 0.5) target.effects.burn = 0;
    addLog(battleId, `🔥 ${target.name} nhận ${burnDmg} Burn DMG`);
  }

  // Bleed: dmg = count/4 per action, halve on end turn
  if (target.effects.bleed && target.effects.bleed > 0) {
    const bleedDmg = Math.ceil(target.effects.bleed / 4);
    target.hp = Math.max(0, target.hp - bleedDmg);
    addLog(battleId, `🩸 ${target.name} nhận ${bleedDmg} Bleed DMG`);
  }

  // Check Stagger (sta = 0)
  if (targetType === "player" && target.sta === 0 && !target.isStaggered) {
    target.isStaggered = true;
    target.staggerTurnCounter = 1;
    target.res = { B: 2, P: 2, S: 2 };
    addLog(battleId, `⚡ ${target.name} bị STAGGER! Không thể hành động 1 turn, Res: 2x`);
  }

  // Check Panic (sanity = -45)
  if (target.sanity <= -45 && !target.isPanic) {
    target.isPanic = true;
    addLog(battleId, `😱 ${target.name} bị PANIC! Không thể hành động 1 turn`);
  }
}

/**
 * End Turn: Hồi Sta, Light recovery, Emotion tick, Effect halve
 */
function endTurn(battleId) {
  const battle = COMBAT_STATE.get(battleId);
  if (!battle) return;

  // Participants: Hồi 30 Sta, Light recovery, Emotion tick, Remove Stagger/Panic
  for (const player of battle.participants) {
    // Stagger cleanup
    if (player.isStaggered) {
      player.staggerTurnCounter--;
      if (player.staggerTurnCounter === 0) {
        player.isStaggered = false;
        player.sta = player.maxSta; // Hồi đầy
        // Reset res thành tính từ equipment
        player.res = { B: 1, P: 1, S: 1 }; // TODO: lấy từ equipment
        addLog(battleId, `✅ ${player.name} hết Stagger, Sta hồi đầy`);
      }
    } else {
      // Normal turn: Hồi 30 Sta
      player.sta = Math.min(player.maxSta, player.sta + 30);
    }

    // Panic cleanup
    if (player.isPanic) {
      player.isPanic = false;
      player.sanity = 0;
      addLog(battleId, `✅ ${player.name} hết Panic, Sanity reset về 0`);
    }

    // Light recovery: nếu dùng ≥20 Sta trong turn
    if (player.staSinceLastLight >= 20) {
      const lightGain = Math.floor(player.staSinceLastLight / 20);
      player.light = Math.min(player.maxLight, player.light + lightGain);
      addLog(battleId, `💡 ${player.name} nhận +${lightGain} Light`);
      player.staSinceLastLight = 0;
    }

    // Emotion Level tick
    if (player.emotionLevel > 0) {
      player.emotionTurnCounter++;
      if (player.emotionTurnCounter >= 5) {
        player.emotionLevel = 0;
        addLog(battleId, `📉 ${player.name} mất Emotion Level`);
      }
    }

    // Effect halve
    if (player.effects.burn) player.effects.burn /= 2;
    if (player.effects.bleed) player.effects.bleed /= 2;
    if (player.effects.rupture) player.effects.rupture /= 2;
    if (player.effects.tremor) player.effects.tremor /= 2;
    if (player.effects.sinking) player.effects.sinking /= 2;
    if (player.effects.poise) player.effects.poise /= 2;

    // Cleanup if < 0.5
    for (const key of ["burn", "bleed", "rupture", "tremor", "sinking", "poise"]) {
      if (player.effects[key] && player.effects[key] < 0.5) {
        player.effects[key] = 0;
      }
    }
  }

  // Boss effects halve
  for (const boss of battle.bosses) {
    if (boss.effects.burn) boss.effects.burn /= 2;
    if (boss.effects.bleed) boss.effects.bleed /= 2;
    if (boss.effects.rupture) boss.effects.rupture /= 2;
    if (boss.effects.tremor) boss.effects.tremor /= 2;
    if (boss.effects.sinking) boss.effects.sinking /= 2;

    for (const key of ["burn", "bleed", "rupture", "tremor", "sinking"]) {
      if (boss.effects[key] && boss.effects[key] < 0.5) {
        boss.effects[key] = 0;
      }
    }
  }

  battle.turnNumber++;
  addLog(battleId, `⏭️ End Turn ${battle.turnNumber - 1} → Start Turn ${battle.turnNumber}`);
}

/**
 * Thêm log (keep 15 gần nhất)
 */
function addLog(battleId, message) {
  const battle = COMBAT_STATE.get(battleId);
  if (!battle) return;

  battle.log.push(message);
  if (battle.log.length > 15) battle.log.shift();
}

/**
 * Format hiển thị trạng thái
 */
function formatParticipantStatus(participant) {
  const hpBar = formatBar(participant.hp, participant.maxHp, 20);
  const staBar = formatBar(participant.sta, participant.maxSta, 20);

  const resStr = `B:${participant.res.B}x P:${participant.res.P}x S:${participant.res.S}x`;
  const effectStrs = [];
  for (const [key, val] of Object.entries(participant.effects)) {
    if (val > 0) effectStrs.push(`${key}:${val.toFixed(1)}`);
  }
  const effectStr = effectStrs.join(" ") || "None";
  const buffStr = Object.keys(participant.buff).join(", ") || "None";
  const injuryStr = participant.injuries.join(", ") || "None";

  return {
    hpBar,
    staBar,
    light: `${participant.light}/${participant.maxLight}`,
    sanity: `${participant.sanity}/45`,
    res: resStr,
    effects: effectStr,
    buff: buffStr,
    injuries: injuryStr,
  };
}

/**
 * Format bar visual
 */
function formatBar(current, max, length = 20) {
  const percent = Math.min(100, Math.max(0, (current / max) * 100));
  const filled = Math.round((percent / 100) * length);
  const bar = "🟩".repeat(filled) + "⬛".repeat(length - filled);
  return `${bar} ${current}/${max}`;
}

/**
 * Get battle
 */
function getBattle(battleId) {
  return COMBAT_STATE.get(battleId) ?? null;
}

/**
 * Enable Shin/Mang for user
 */
function enableShinForUser(userId) {
  SHIN_ENABLED_USERS.add(userId);
}

/**
 * Check if user can use Shin
 */
function canUseShin(userId) {
  return SHIN_ENABLED_USERS.has(userId);
}

module.exports = {
  generateBattleId,
  createBattle,
  addBoss,
  addPlayer,
  takeDamage,
  playerAttack,
  playerDodge,
  playerGuard,
  playerParry,
  checkEmotionLevel,
  tickEffects,
  endTurn,
  addLog,
  formatParticipantStatus,
  formatBar,
  getBattle,
  enableShinForUser,
  canUseShin,
  COMBAT_STATE,
};
