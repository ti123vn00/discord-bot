/**
 * combat-system.js
 * Logic trận đấu — state lưu trên Upstash Redis
 *
 * KEY SCHEMA:
 *   battle:{battleId}        → JSON toàn bộ battle state   (TTL 24h, gia hạn mỗi lần write)
 *   shin_users               → Redis SET chứa userId đã học Shin
 *
 * BUGS FIXED (so với phiên bản cũ):
 *   #1  COMBAT_STATE là in-memory Map → bot restart mất hết → chuyển sang Upstash
 *   #2  playerAttack trả về finalDmg, không phải modifiedDmg
 *   #3  playerDodge trả về staCost, không phải sta
 *   #4  playerParry không có field clash → button không bao giờ reply
 *   #5  Boss selector dùng b.id thay vì b.bossId
 *   #6  Emotion Level 2 tính maxLight sai (dùng baseMaxLight thay vì player.emotionLevel)
 *   #7  Shin giảm res bản thân (đúng theo ruleset) chứ không phải res địch
 */

const { rollWeaponDamage, rollCriticalDice, getWeapon } = require("./weapons");

// ─── Redis client (inject từ index.js) ───────────────────────────────────────
let _redis = null;
let _withTimeout = null;

function initCombatRedis(redisClient, withTimeoutFn) {
  _redis = redisClient;
  _withTimeout = withTimeoutFn;
}

// ─── Redis helpers ────────────────────────────────────────────────────────────
const BATTLE_TTL = 60 * 60 * 24; // 24 giờ
const REDIS_RETRIES = 2;
const REDIS_RETRY_BASE_MS = 150;

async function getBattleFromRedis(battleId) {
  const key = `battle:${battleId}`;
  let lastErr;
  for (let i = 0; i <= REDIS_RETRIES; i++) {
    try {
      const raw = await _withTimeout(_redis.get(key));
      if (!raw) return null;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (err) {
      lastErr = err;
      if (i < REDIS_RETRIES) await new Promise(r => setTimeout(r, REDIS_RETRY_BASE_MS * (i + 1)));
    }
  }
  throw lastErr;
}

async function saveBattleToRedis(battle) {
  const key = `battle:${battle.battleId}`;
  let lastErr;
  for (let i = 0; i <= REDIS_RETRIES; i++) {
    try {
      await _withTimeout(_redis.set(key, JSON.stringify(battle), { ex: BATTLE_TTL }));
      return;
    } catch (err) {
      lastErr = err;
      if (i < REDIS_RETRIES) await new Promise(r => setTimeout(r, REDIS_RETRY_BASE_MS * (i + 1)));
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// KHỞI TẠO
// ─────────────────────────────────────────────────────────────────────────────

function generateBattleId() {
  return `battle_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

async function createBattle(gmId, battleName) {
  const battleId = generateBattleId();
  const battle = {
    battleId,
    gmId,
    battleName,
    participants: [],
    bosses: [],
    log: [],
    turnNumber: 1,
    turnPhase: "boss",
    status: "ongoing",
    ended: false,
  };
  await saveBattleToRedis(battle);
  return battleId;
}

async function addBoss(battleId, bossData) {
  const battle = await getBattleFromRedis(battleId);
  if (!battle) return false;

  const bossId = `boss_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  battle.bosses.push({
    bossId,
    name: bossData.name,
    hp: bossData.hp,
    maxHp: bossData.hp,
    sta: bossData.sta ?? 100,
    maxSta: bossData.sta ?? 100,
    sanity: 0,
    maxSanity: 45,
    res: bossData.res ?? { B: 1, P: 1, S: 1 },
    buff: {},
    debuff: {},
    effects: {},
    guarding: false,
  });
  _addLog(battle, `🐉 Boss **${bossData.name}** xuất hiện [HP: ${bossData.hp}]`);
  await saveBattleToRedis(battle);
  return bossId;
}

async function addPlayer(battleId, userId, playerData) {
  const battle = await getBattleFromRedis(battleId);
  if (!battle) return false;

  const weapon = getWeapon(playerData.weaponId);
  if (!weapon) return false;

  // Nếu player đã trong trận thì không thêm lại
  if (battle.participants.find(p => p.userId === userId)) return false;

  battle.participants.push({
    userId,
    name: playerData.name,
    hp: playerData.hp,
    maxHp: playerData.hp,
    sta: playerData.sta ?? 100,
    maxSta: playerData.sta ?? 100,
    light: 0,
    maxLight: Math.min(6, playerData.maxLight ?? 4),
    baseMaxLight: Math.min(6, playerData.maxLight ?? 4),
    sanity: 0,
    maxSanity: 45,
    weapon: weapon.id,
    res: playerData.res ?? { B: 1, P: 1, S: 1 },
    baseRes: playerData.res ?? { B: 1, P: 1, S: 1 },
    buff: {},
    debuff: {},
    effects: {},
    injuries: [],
    emotionLevel: 0,
    emotionActiveTurns: 0,
    emotionCooldown: 0,
    totalDmgDealt: 0,
    isShinActive: false,
    isMangActive: false,
    staUsedThisTurn: 0,
    pendingLightGain: 0,
    isGuarding: false,
    isStaggered: false,
    staggerTurnsLeft: 0,
    isPanic: false,
    stunsStacks: 0,
    skillCd: {},
    _mangMul: 1.1,
  });

  _addLog(battle, `⚔️ **${playerData.name}** tham gia trận [HP: ${playerData.hp} | Vũ khí: ${weapon.name}]`);
  await saveBattleToRedis(battle);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAMAGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gây dmg lên target — PURE (không async, không save), gọi saveBattleToRedis sau.
 * Trả về { finalDmg, targetHp, maxHp }
 */
function _applyDamage(battle, targetType, targetId, dmgData) {
  const target = _getTarget(battle, targetType, targetId);
  if (!target) return null;

  let amount = dmgData.amount;

  // Guard: giảm 90% dmg
  if (target.isGuarding || target.guarding) {
    amount = Math.ceil(amount * 0.1);
    _addLog(battle, `🛡️ ${target.name} Guard giảm dmg → ${amount}`);
  }

  // FIX #7: Shin giảm res của BẢN THÂN (attacker), không phải res địch.
  // shinResMod ở đây KHÔNG dùng nữa — res bản thân đã được modify trong playerActivateShin.
  // Tính resistance (True Dmg bỏ qua res nếu res < 1x)
  let res = target.res[dmgData.type] ?? 1;
  if (dmgData.isTrueDmg && res < 1) res = 1;
  res = Math.max(0, res);
  const finalDmg = Math.ceil(amount * res);

  // Sinking: mỗi lần bị tấn công trừ 1 sanity, bonus dmg nếu địch đã panic sanity
  let sinkingBonus = 0;
  if (target.effects.sinking && target.effects.sinking >= 1) {
    if (target.sanity !== undefined) {
      target.sanity = Math.max(-45, target.sanity - 1);
    }
    if (
      (targetType === "boss" && target.sanity === undefined) ||
      (target.sanity !== undefined && target.sanity <= -45)
    ) {
      sinkingBonus = Math.floor(target.effects.sinking);
    }
    target.effects.sinking = Math.max(0, target.effects.sinking - 1);
    if (target.effects.sinking < 0.5) target.effects.sinking = 0;
    if (sinkingBonus > 0) _addLog(battle, `💀 Sinking bonus +${sinkingBonus} DMG`);
  }

  // Rupture: bonus dmg bằng count, giảm 1 mỗi đòn
  let ruptureDmg = 0;
  if (target.effects.rupture && target.effects.rupture >= 1) {
    ruptureDmg = Math.floor(target.effects.rupture);
    target.effects.rupture = Math.max(0, target.effects.rupture - 1);
    if (target.effects.rupture < 0.5) target.effects.rupture = 0;
  }

  const totalDmg = finalDmg + ruptureDmg + sinkingBonus;
  target.hp = Math.max(0, target.hp - totalDmg);

  const logParts = [`💥 ${target.name} nhận **${finalDmg}** DMG [${dmgData.type}] (Res: ${res}x)`];
  if (ruptureDmg > 0) logParts.push(`+${ruptureDmg} Rupture`);
  if (sinkingBonus > 0) logParts.push(`+${sinkingBonus} Sinking`);
  logParts.push(`| HP: ${target.hp}/${target.maxHp}`);
  _addLog(battle, logParts.join(" "));

  // Injury check: chỉ cho player
  if (targetType === "player" && !dmgData.skipInjuryCheck && totalDmg > target.maxHp * 0.3) {
    const roll = Math.random() * 100;
    if (roll < 10) _applyHeavyInjury(battle, targetId);
    else if (roll < 50) _applyLightInjury(battle, targetId);
  }

  // Guard reset sau khi nhận đòn
  target.isGuarding = false;
  target.guarding = false;

  // Check panic
  if (target.sanity !== undefined && target.sanity <= -45 && !target.isPanic) {
    _applyPanic(battle, target);
  }

  return { finalDmg: totalDmg, targetHp: target.hp, maxHp: target.maxHp };
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER ACTIONS (tất cả đều async — load battle, mutate, save)
// ─────────────────────────────────────────────────────────────────────────────

async function playerAttack(battleId, playerId, targetBossId) {
  const battle = await getBattleFromRedis(battleId);
  if (!battle) return { error: "Trận đấu không tìm thấy" };
  if (battle.bosses.length === 0) return { error: "Không có boss" };

  const player = _getPlayer(battle, playerId);
  if (!player) return { error: "Không tìm thấy player" };
  if (player.isStaggered || player.isPanic) return { error: "Đang Stagger/Panic, không thể hành động" };

  const weapon = getWeapon(player.weapon);
  const staCost = weapon.staCost;
  if (player.sta < staCost) return { error: `Không đủ Stamina (cần ${staCost})` };

  const hasMissingArm = player.injuries.includes("mất-tay");

  player.sta -= staCost;
  player.staUsedThisTurn += staCost;
  player.isGuarding = false;

  if (player.sta <= 0 && !player.isStaggered) _applyStagger(battle, player);

  // Poise: tính crit rate (5% per poise stack)
  let isCrit = false;
  const poiseStacks = player.effects.poise ?? 0;
  if (poiseStacks >= 1) {
    const critChance = Math.min(poiseStacks * 0.05, 0.99);
    isCrit = Math.random() < critChance;
    if (isCrit) {
      player.effects.poise = poiseStacks / 2;
      if (player.effects.poise < 0.5) player.effects.poise = 0;
      _addLog(battle, `✨ CRIT! Poise kích hoạt → DMG x1.3`);
    }
  }

  let dmgRoll = rollWeaponDamage(weapon);
  if (isCrit) dmgRoll = Math.ceil(dmgRoll * 1.3);

  let finalDmg = dmgRoll;

  if (hasMissingArm) {
    finalDmg = Math.ceil(finalDmg * 0.5);
    _addLog(battle, `⚠️ Mất tay: DMG giảm còn ${finalDmg}`);
  }

  if (player.isMangActive) {
    const mangMul = player._mangMul ?? 1.1;
    finalDmg = Math.ceil(finalDmg * mangMul);
    _addLog(battle, `⬛ Mang kích hoạt → DMG +${Math.round((mangMul - 1) * 100)}%`);
  }

  const boss = targetBossId
    ? battle.bosses.find(b => b.bossId === targetBossId)
    : battle.bosses.find(b => b.hp > 0);
  if (!boss) return { error: "Không tìm thấy boss" };

  const hitResult = _applyDamage(battle, "boss", boss.bossId, {
    amount: finalDmg,
    type: weapon.type,
    isTrueDmg: player.isMangActive,
  });

  player.totalDmgDealt += hitResult?.finalDmg ?? 0;
  _checkEmotionLevel(battle, playerId);

  _addLog(battle, `⚔️ **${player.name}** [${weapon.name}] Roll: ${dmgRoll}${isCrit ? " CRIT" : ""} → **${finalDmg} DMG**`);

  _tickBleedOnAction(battle, "player", player.userId);

  await saveBattleToRedis(battle);
  return { player, weapon, roll: dmgRoll, finalDmg, isCrit, hitResult };
}

async function playerDodge(battleId, playerId) {
  const battle = await getBattleFromRedis(battleId);
  if (!battle) return { error: "Trận đấu không tìm thấy" };

  const player = _getPlayer(battle, playerId);
  if (!player) return { error: "Không tìm thấy player" };
  if (player.isStaggered || player.isPanic) return { error: "Đang Stagger/Panic, không thể hành động" };
  if (player.injuries.includes("mất-chân")) return { error: "Bị mất chân — không thể né" };

  let staCost = 20;
  if (player.injuries.includes("gãy-chân")) staCost = 40;
  if (player.sta < staCost) return { error: `Không đủ Stamina (cần ${staCost})` };

  player.sta -= staCost;
  player.staUsedThisTurn += staCost;
  player.isGuarding = false;

  if (player.sta <= 0 && !player.isStaggered) _applyStagger(battle, player);

  _addLog(battle, `💨 **${player.name}** né (Sta: -${staCost})`);
  await saveBattleToRedis(battle);
  // FIX #3: trả về staCost (không phải sta)
  return { success: true, staCost };
}

async function playerGuard(battleId, playerId) {
  const battle = await getBattleFromRedis(battleId);
  if (!battle) return { error: "Trận đấu không tìm thấy" };

  const player = _getPlayer(battle, playerId);
  if (!player) return { error: "Không tìm thấy player" };
  if (player.isStaggered || player.isPanic) return { error: "Đang Stagger/Panic, không thể hành động" };
  if (player.sta < 10) return { error: "Không đủ Stamina (cần 10)" };

  player.sta -= 10;
  player.staUsedThisTurn += 10;
  player.isGuarding = true;

  if (player.sta <= 0 && !player.isStaggered) _applyStagger(battle, player);

  _addLog(battle, `🛡️ **${player.name}** Guard (Sta: -10) — Giảm 90% dmg`);
  await saveBattleToRedis(battle);
  return { success: true };
}

async function playerParry(battleId, playerId) {
  const battle = await getBattleFromRedis(battleId);
  if (!battle) return { error: "Trận đấu không tìm thấy" };

  const player = _getPlayer(battle, playerId);
  if (!player) return { error: "Không tìm thấy player" };
  if (player.isStaggered || player.isPanic) return { error: "Đang Stagger/Panic, không thể hành động" };

  player.isGuarding = false;

  let playerDiceMax = 20;
  if (player.injuries.includes("gãy-tay")) playerDiceMax -= 5;
  if (player.injuries.includes("gãy-chân")) playerDiceMax -= 3;
  if (player.injuries.includes("mất-chân")) playerDiceMax -= 10;
  playerDiceMax = Math.max(1, playerDiceMax);

  const playerRoll = Math.floor(Math.random() * playerDiceMax) + 1;
  const bossRoll = Math.floor(Math.random() * 16) + 1;
  const success = playerRoll >= bossRoll;

  if (success) {
    player.sanity = Math.min(45, player.sanity + 10);
    _addLog(battle, `🎯 **${player.name}** Parry thành công! [${playerRoll} vs ${bossRoll}] (+10 Sanity)`);
    await saveBattleToRedis(battle);
    // FIX #4: trả về success flag đúng tên, không phải result.clash
    return { success: true, playerRoll, bossRoll, sanityChange: +10 };
  } else {
    let staPenalty = 40;
    if (player.injuries.includes("gãy-tay")) staPenalty *= 2;

    player.sta = Math.max(0, player.sta - staPenalty);
    player.sanity = Math.max(-45, player.sanity - 10);

    _addLog(battle, `❌ **${player.name}** Parry thất bại [${playerRoll} vs ${bossRoll}] (-${staPenalty} Sta, -10 Sanity)`);

    if (player.sta <= 0 && !player.isStaggered) _applyStagger(battle, player);
    if (player.sanity <= -45 && !player.isPanic) _applyPanic(battle, player);

    await saveBattleToRedis(battle);
    return { success: false, playerRoll, bossRoll, staPenalty, sanityChange: -10 };
  }
}

async function playerActivateShin(battleId, playerId) {
  const battle = await getBattleFromRedis(battleId);
  if (!battle) return { error: "Trận đấu không tìm thấy" };

  const player = _getPlayer(battle, playerId);
  if (!player) return { error: "Không tìm thấy player" };
  if (player.sanity < -10) return { error: "Sanity quá thấp để dùng Shin (cần > -10)" };

  // Kiểm tra Shin từ Redis SET
  const hasShin = await _withTimeout(_redis.sismember("shin_users", playerId));
  if (!hasShin) return { error: "Bạn chưa học được Shin" };

  player.sanity -= 25;
  player.isShinActive = true;
  player.isMangActive = true;
  player._mangStartTurn = battle.turnNumber;
  player._mangMul = 1.1;

  // FIX #7: Shin giảm res của BẢN THÂN (theo ruleset), không phải res địch
  player.res = {
    B: Math.max(0, player.res.B - 0.2),
    P: Math.max(0, player.res.P - 0.2),
    S: Math.max(0, player.res.S - 0.2),
  };

  _addLog(battle, `⬜ **${player.name}** kích hoạt Shin/Mang (-25 Sanity, Res bản thân -0.2x, Dmg +10%)`);
  await saveBattleToRedis(battle);
  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// END TURN
// ─────────────────────────────────────────────────────────────────────────────

async function endTurn(battleId) {
  const battle = await getBattleFromRedis(battleId);
  if (!battle) return;

  for (const player of battle.participants) {
    // Stagger
    if (player.isStaggered) {
      player.staggerTurnsLeft--;
      if (player.staggerTurnsLeft <= 0) {
        player.isStaggered = false;
        player.sta = player.maxSta;
        player.res = { ...player.baseRes };
        _addLog(battle, `✅ **${player.name}** hết Stagger — Sta hồi đầy`);
      } else {
        _addLog(battle, `⚡ **${player.name}** vẫn đang Stagger (${player.staggerTurnsLeft} turn còn lại)`);
      }
    } else {
      player.sta = Math.min(player.maxSta, player.sta + 30);
    }

    // Panic
    if (player.isPanic) {
      player.isPanic = false;
      player.sanity = 0;
      _addLog(battle, `✅ **${player.name}** hết Panic — Sanity reset về 0`);
    }

    // Light recovery
    if (player.pendingLightGain > 0) {
      player.light = Math.min(player.maxLight, player.light + player.pendingLightGain);
      _addLog(battle, `💡 **${player.name}** nhận +${player.pendingLightGain} Light`);
      player.pendingLightGain = 0;
    }
    const newLight = Math.floor(player.staUsedThisTurn / 20);
    if (newLight > 0) player.pendingLightGain = newLight;
    player.staUsedThisTurn = 0;

    player.isGuarding = false;

    // Emotion Level tick
    if (player.emotionLevel > 0) {
      player.emotionActiveTurns--;
      if (player.emotionActiveTurns <= 0) {
        const prevLevel = player.emotionLevel;
        player.emotionLevel = 0;
        player.emotionCooldown = 5;
        // FIX #6: dùng baseMaxLight để restore đúng
        player.maxLight = player.baseMaxLight;
        _addLog(battle, `📉 **${player.name}** mất Emotion Level — Cooldown 5 turn`);
      }
    }
    if (player.emotionCooldown > 0) player.emotionCooldown--;

    // Mang mul tăng 10% mỗi turn khi Shin active
    if (player.isShinActive) {
      player._mangMul = Math.min(player._mangMul + 0.1, 2.0);
    }

    // Burn/Bleed tick cuối turn
    _tickEffectsEndTurn(battle, "player", player.userId);

    // Cooldown reduction
    for (const skillId of Object.keys(player.skillCd)) {
      player.skillCd[skillId] = Math.max(0, player.skillCd[skillId] - 1);
    }
  }

  for (const boss of battle.bosses) {
    _tickEffectsEndTurn(battle, "boss", boss.bossId);
  }

  battle.turnNumber++;
  _addLog(battle, `⏭️ ─── End Turn ${battle.turnNumber - 1} → Turn ${battle.turnNumber} ───`);

  await saveBattleToRedis(battle);
}

// ─────────────────────────────────────────────────────────────────────────────
// EMOTION LEVEL
// ─────────────────────────────────────────────────────────────────────────────

function _checkEmotionLevel(battle, playerId) {
  const player = _getPlayer(battle, playerId);
  if (!player || player.emotionCooldown > 0) return;

  const totalDmg = player.totalDmgDealt;

  if (player.emotionLevel < 2 && totalDmg >= 500) {
    player.emotionLevel = 2;
    player.emotionActiveTurns = 2;
    // FIX #6: tăng so với baseMaxLight, không cộng dồn liên tục
    player.maxLight = Math.min(6, player.baseMaxLight + 2);
    const hpHeal = Math.ceil(player.maxHp * 0.10);
    player.hp = Math.min(player.maxHp, player.hp + hpHeal);
    _addLog(battle, `🔥 **${player.name}** → **Emotion Level 2**! (Max Light +2, Hồi ${hpHeal} HP, +2 Dice Up)`);
  } else if (player.emotionLevel < 1 && totalDmg >= 200) {
    player.emotionLevel = 1;
    player.emotionActiveTurns = 2;
    player.maxLight = Math.min(6, player.baseMaxLight + 1);
    const hpHeal = Math.ceil(player.maxHp * 0.05);
    player.hp = Math.min(player.maxHp, player.hp + hpHeal);
    _addLog(battle, `🔥 **${player.name}** → **Emotion Level 1**! (Max Light +1, Hồi ${hpHeal} HP, +1 Dice Up)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EFFECTS TICK
// ─────────────────────────────────────────────────────────────────────────────

function _tickEffectsEndTurn(battle, targetType, targetId) {
  const target = _getTarget(battle, targetType, targetId);
  if (!target) return;

  if (target.effects.burn && target.effects.burn >= 1) {
    const burnDmg = Math.ceil(target.effects.burn * 2);
    target.hp = Math.max(0, target.hp - burnDmg);
    target.effects.burn = target.effects.burn / 2;
    if (target.effects.burn < 0.5) target.effects.burn = 0;
    _addLog(battle, `🔥 ${target.name} nhận ${burnDmg} Burn DMG (count còn ${target.effects.burn.toFixed(1)})`);
  }

  if (target.effects.bleed && target.effects.bleed >= 0.5) {
    target.effects.bleed = target.effects.bleed / 2;
    if (target.effects.bleed < 0.5) target.effects.bleed = 0;
  }
}

function _tickBleedOnAction(battle, targetType, targetId) {
  const target = _getTarget(battle, targetType, targetId);
  if (!target || !target.effects.bleed || target.effects.bleed < 0.5) return;
  const bleedDmg = Math.ceil(target.effects.bleed / 4);
  target.hp = Math.max(0, target.hp - bleedDmg);
  _addLog(battle, `🩸 ${target.name} nhận ${bleedDmg} Bleed DMG (hành động)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// INJURY
// ─────────────────────────────────────────────────────────────────────────────

function _applyLightInjury(battle, playerId) {
  const player = _getPlayer(battle, playerId);
  if (!player) return;
  const choices = ["gãy-tay", "gãy-chân", "gãy-xương", "choáng"];
  const injury = choices[Math.floor(Math.random() * choices.length)];

  if (injury === "gãy-xương") {
    player.maxHp = Math.max(1, player.maxHp - 30);
    player.hp = Math.min(player.hp, player.maxHp);
    _addLog(battle, `🩹 **${player.name}** Chấn thương nhẹ: **Gãy Xương** (Max HP -30 → ${player.maxHp})`);
  } else if (injury === "choáng") {
    player.stunsStacks = (player.stunsStacks ?? 0) + 1;
    _addLog(battle, `🩹 **${player.name}** Chấn thương nhẹ: **Choáng** (Stack ${player.stunsStacks}/2)`);
  } else {
    if (!player.injuries.includes(injury)) {
      player.injuries.push(injury);
      _addLog(battle, `🩹 **${player.name}** Chấn thương nhẹ: **${injury}**`);
    }
  }
}

function _applyHeavyInjury(battle, playerId) {
  const player = _getPlayer(battle, playerId);
  if (!player) return;
  const choices = ["mất-tay", "mất-chân", "vết-thương-lớn"];
  const injury = choices[Math.floor(Math.random() * choices.length)];

  if (injury === "vết-thương-lớn") {
    player.maxHp = Math.max(1, player.maxHp - 100);
    player.hp = Math.min(player.hp, player.maxHp);
    _addLog(battle, `💀 **${player.name}** Chấn thương nặng: **Vết Thương Lớn** (Max HP -100 → ${player.maxHp})`);
  } else {
    if (!player.injuries.includes(injury)) {
      player.injuries.push(injury);
      _addLog(battle, `💀 **${player.name}** Chấn thương nặng: **${injury}**`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGGER / PANIC
// ─────────────────────────────────────────────────────────────────────────────

function _applyStagger(battle, player) {
  let staggerDuration = 1;
  if ((player.stunsStacks ?? 0) >= 2) {
    staggerDuration = 2;
    player.stunsStacks = 0;
    _addLog(battle, `⚡ **${player.name}** STAGGER ${staggerDuration} turn (Choáng x2!)`);
  } else {
    _addLog(battle, `⚡ **${player.name}** STAGGER — Không thể hành động 1 turn`);
  }
  player.isStaggered = true;
  player.staggerTurnsLeft = staggerDuration;
  player.res = { B: 2, P: 2, S: 2 };
}

function _applyPanic(battle, player) {
  player.isPanic = true;
  _addLog(battle, `😱 **${player.name}** PANIC — Không thể hành động 1 turn`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIN helpers (Redis SET)
// ─────────────────────────────────────────────────────────────────────────────

async function enableShinForUser(userId) {
  await _withTimeout(_redis.sadd("shin_users", userId));
}

async function canUseShin(userId) {
  return !!(await _withTimeout(_redis.sismember("shin_users", userId)));
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER / UTILITY
// ─────────────────────────────────────────────────────────────────────────────

function _getPlayer(battle, playerId) {
  return battle?.participants.find(p => p.userId === playerId) ?? null;
}

function _getTarget(battle, type, id) {
  if (type === "boss") return battle.bosses.find(b => b.bossId === id) ?? null;
  return battle.participants.find(p => p.userId === id) ?? null;
}

function _addLog(battle, message) {
  battle.log.push(message);
  if (battle.log.length > 20) battle.log.shift();
}

async function getBattle(battleId) {
  return getBattleFromRedis(battleId);
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT DISPLAY
// ─────────────────────────────────────────────────────────────────────────────

function formatParticipantStatus(participant) {
  const effectStrs = [];
  for (const [key, val] of Object.entries(participant.effects ?? {})) {
    if (val > 0) effectStrs.push(`${key}: ${val % 1 === 0 ? val : val.toFixed(1)}`);
  }
  const injuryParts = [...(participant.injuries ?? [])];
  if ((participant.stunsStacks ?? 0) > 0) injuryParts.push(`Choáng x${participant.stunsStacks}`);

  return {
    hpBar: formatBar(participant.hp, participant.maxHp, 15),
    staBar: formatBar(participant.sta, participant.maxSta, 15),
    light: `${participant.light}/${participant.maxLight}`,
    sanity: `${participant.sanity >= 0 ? "+" : ""}${participant.sanity} / ±45`,
    res: `B:${participant.res.B}x  P:${participant.res.P}x  S:${participant.res.S}x`,
    effects: effectStrs.join("  ") || "None",
    buff: Object.keys(participant.buff ?? {}).join(", ") || "None",
    injuries: injuryParts.join(", ") || "None",
    emotionLevel: participant.emotionLevel,
    stateFlags: [
      participant.isStaggered ? `⚡ Stagger (${participant.staggerTurnsLeft}t)` : null,
      participant.isPanic ? "😱 Panic" : null,
      participant.isGuarding ? "🛡️ Guarding" : null,
      participant.isShinActive ? "⬜ Shin/Mang" : null,
    ].filter(Boolean).join("  ") || "None",
  };
}

function formatBar(current, max, length = 15) {
  if (max <= 0) return `— ${current}/${max}`;
  const pct = Math.min(1, Math.max(0, current / max));
  const filled = Math.round(pct * length);
  return "🟩".repeat(filled) + "⬛".repeat(length - filled) + ` ${current}/${max}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  initCombatRedis,
  // Battle lifecycle
  generateBattleId,
  createBattle,
  addBoss,
  addPlayer,
  getBattle,
  endTurn,
  // Actions
  playerAttack,
  playerDodge,
  playerGuard,
  playerParry,
  playerActivateShin,
  // Damage
  applyDamage: _applyDamage,
  // Injury (dùng trong combat-ui nếu cần GM manual)
  applyLightInjury: _applyLightInjury,
  applyHeavyInjury: _applyHeavyInjury,
  // Display
  formatParticipantStatus,
  formatBar,
  // Shin
  enableShinForUser,
  canUseShin,
  // Internal save (dùng trong combat-ui sau khi mutate)
  saveBattle: saveBattleToRedis,
};
