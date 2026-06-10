/**
 * combat-system.js
 * Quản lý logic trận đấu: HP, Stamina, turn order, effect ticking, Injury, Shin/Mang
 *
 * RULESET VERSION: đã sửa & hoàn thiện
 */

const { rollWeaponDamage, rollCriticalDice, getWeapon } = require("./weapons");

const COMBAT_STATE = new Map(); // battleId -> battle data
const SHIN_ENABLED_USERS = new Set(); // userId đã học Shin

// ─────────────────────────────────────────────────────────────────────────────
// KHỞI TẠO
// ─────────────────────────────────────────────────────────────────────────────

function generateBattleId() {
  return `battle_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Tạo trận đấu mới
 */
function createBattle(gmId, battleName) {
  const battleId = generateBattleId();
  COMBAT_STATE.set(battleId, {
    battleId,
    gmId,
    battleName,
    participants: [],
    bosses: [],
    log: [],
    turnNumber: 1,
    turnPhase: "boss", // "boss" | "player" | "end"
    status: "ongoing",
  });
  return battleId;
}

/**
 * Thêm boss/mob vào trận
 */
function addBoss(battleId, bossData) {
  const battle = COMBAT_STATE.get(battleId);
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
    effects: {}, // burn, bleed, rupture, tremor, sinking
  });
  addLog(battleId, `🐉 Boss **${bossData.name}** xuất hiện [HP: ${bossData.hp}]`);
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

  battle.participants.push({
    userId,
    name: playerData.name,
    hp: playerData.hp,
    maxHp: playerData.hp,
    sta: playerData.sta ?? 100,
    maxSta: playerData.sta ?? 100,
    light: playerData.light ?? 0,
    maxLight: Math.min(6, playerData.maxLight ?? 4),
    sanity: 0,
    maxSanity: 45,
    weapon: weapon.id,
    res: playerData.res ?? { B: 1, P: 1, S: 1 },
    baseRes: playerData.res ?? { B: 1, P: 1, S: 1 }, // dùng để restore sau stagger
    buff: {},
    debuff: {},
    effects: {}, // burn, bleed, rupture, tremor, sinking, poise, charge
    injuries: [],
    emotionLevel: 0,
    emotionActiveTurns: 0,   // số turn còn lại của emotion level
    emotionCooldown: 0,      // countdown 5 turn sau khi hết
    totalDmgDealt: 0,
    emotionDmgThreshold: 0,  // dmg đã tích lũy từ mốc hiện tại
    isShinActive: false,
    isMangActive: false,
    // Light recovery: đếm sta đã dùng trong turn hiện tại (reset đầu mỗi turn)
    staUsedThisTurn: 0,
    pendingLightGain: 0, // light sẽ nhận vào đầu turn sau
    // Guard flag
    isGuarding: false,
    // Stagger
    isStaggered: false,
    staggerTurnsLeft: 0,
    // Panic
    isPanic: false,
    // Injury: choáng stack
    stunsStacks: 0,
    // Skill cooldown
    skillCd: {},
  });

  addLog(battleId, `⚔️ **${playerData.name}** tham gia trận [HP: ${playerData.hp} | Vũ khí: ${weapon.name}]`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAMAGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gây dmg lên target, tính res, guard, injury trigger
 * dmgData = { amount, type: "B"|"P"|"S", isTrueDmg: bool, skipInjuryCheck: bool }
 * Trả về { finalDmg, targetHp, maxHp }
 */
function takeDamage(battleId, targetType, targetId, dmgData) {
  const battle = COMBAT_STATE.get(battleId);
  if (!battle) return null;

  const target = _getTarget(battle, targetType, targetId);
  if (!target) return null;

  let amount = dmgData.amount;

  // Guard: giảm 90% dmg
  if (target.isGuarding) {
    amount = Math.ceil(amount * 0.1);
    addLog(battleId, `🛡️ ${target.name} Guard giảm dmg → ${amount}`);
  }

  // Tính resistance (True Dmg bỏ qua res nếu res < 1x)
  let res = target.res[dmgData.type] ?? 1;
  if (dmgData.isTrueDmg && res < 1) res = 1;
  const finalDmg = Math.ceil(amount * res);

  // Sinking: mỗi lần bị tấn công trừ 1 sanity, giảm 1 count
  if (target.effects.sinking && target.effects.sinking >= 1) {
    target.sanity = Math.max(-45, (target.sanity ?? 0) - 1);
    // Bonus dmg nếu sanity <= -45 hoặc không có sanity (boss không có sanity)
    const bonusSinking =
      (targetType === "boss" && target.sanity === undefined) ||
      (target.sanity !== undefined && target.sanity <= -45)
        ? target.effects.sinking
        : 0;
    target.effects.sinking = Math.max(0, target.effects.sinking - 1);
    if (target.effects.sinking < 0.5) target.effects.sinking = 0;
    if (bonusSinking > 0) {
      addLog(battleId, `💀 Sinking bonus +${bonusSinking} DMG`);
    }
  }

  // Rupture: bonus dmg bằng count, giảm 1 mỗi đòn
  let ruptureDmg = 0;
  if (target.effects.rupture && target.effects.rupture >= 1) {
    ruptureDmg = Math.floor(target.effects.rupture);
    target.effects.rupture = Math.max(0, target.effects.rupture - 1);
    if (target.effects.rupture < 0.5) target.effects.rupture = 0;
  }

  const totalDmg = finalDmg + ruptureDmg;
  target.hp = Math.max(0, target.hp - totalDmg);

  const logParts = [`💥 ${target.name} nhận **${finalDmg}** DMG [${dmgData.type}] (Res: ${res}x)`];
  if (ruptureDmg > 0) logParts.push(`+${ruptureDmg} Rupture`);
  logParts.push(`| HP: ${target.hp}/${target.maxHp}`);
  addLog(battleId, logParts.join(" "));

  // Injury check: chỉ cho player, và không bỏ qua
  if (targetType === "player" && !dmgData.skipInjuryCheck && totalDmg > target.maxHp * 0.3) {
    const roll = Math.random() * 100;
    if (roll < 10) {
      applyHeavyInjury(battleId, targetId);
    } else if (roll < 50) {
      applyLightInjury(battleId, targetId);
    }
  }

  // Check stagger
  if (targetType === "player" && target.sta <= 0 && !target.isStaggered) {
    _applyStagger(battleId, target);
  }

  // Check panic
  if (target.sanity !== undefined && target.sanity <= -45 && !target.isPanic) {
    _applyPanic(battleId, target);
  }

  return { finalDmg: totalDmg, targetHp: target.hp, maxHp: target.maxHp };
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Đánh thường
 */
function playerAttack(battleId, playerId, targetBossId) {
  const battle = COMBAT_STATE.get(battleId);
  if (!battle || battle.bosses.length === 0) return { error: "Không có boss" };

  const player = _getPlayer(battle, playerId);
  if (!player) return { error: "Không tìm thấy player" };
  if (player.isStaggered || player.isPanic) return { error: "Đang Stagger/Panic, không thể hành động" };

  const weapon = getWeapon(player.weapon);
  const staCost = weapon.staCost;

  if (player.sta < staCost) return { error: "Không đủ Stamina" };

  // Mất tay: -50% dmg gây ra
  const hasMissingArm = player.injuries.includes("mất-tay");

  player.sta -= staCost;
  player.staUsedThisTurn += staCost;
  player.isGuarding = false; // hủy guard khi tấn công

  // Poise passive: reset nếu có weapon passive consumePoise
  if (weapon.passive?.name?.includes("Orthodox")) {
    // Reset poise khi tấn công (passive của moonlit-azure-blade)
    player._orthodoxSkipTurn = false;
  }

  // Roll damage
  let dmgRoll = rollWeaponDamage(weapon);

  // Poise: tính crit rate (5% per poise stack)
  let isCrit = false;
  let poiseStacks = player.effects.poise ?? 0;
  if (poiseStacks >= 1) {
    const critChance = Math.min(poiseStacks * 0.05, 0.99);
    isCrit = Math.random() < critChance;
    if (isCrit) {
      dmgRoll = Math.ceil(dmgRoll * 1.3);
      // Halve poise sau khi crit
      player.effects.poise = poiseStacks / 2;
      if (player.effects.poise < 0.5) player.effects.poise = 0;
      addLog(battleId, `✨ CRIT! Poise kích hoạt → DMG x1.3`);
    }
  }

  // Sanity modifier: +1 sanity = +1% dice, -1 sanity = -1% dice
  const sanityMod = 1 + player.sanity / 100;
  let finalDmg = Math.ceil(dmgRoll * Math.max(0, sanityMod));

  // Mất tay: -50% dmg
  if (hasMissingArm) {
    finalDmg = Math.ceil(finalDmg * 0.5);
    addLog(battleId, `⚠️ Mất tay: DMG giảm còn ${finalDmg}`);
  }

  // Shin/Mang
  if (player.isMangActive) {
    finalDmg = Math.ceil(finalDmg * player._mangMul ?? 1.1);
    addLog(battleId, `⬛ Mang kích hoạt → DMG +${Math.round(((player._mangMul ?? 1.1) - 1) * 100)}%`);
  }

  const boss = targetBossId
    ? battle.bosses.find(b => b.bossId === targetBossId)
    : battle.bosses.find(b => b.hp > 0);
  if (!boss) return { error: "Không tìm thấy boss" };

  const hitResult = takeDamage(battleId, "boss", boss.bossId, {
    amount: finalDmg,
    type: weapon.type,
    isTrueDmg: player.isShinActive || player.isMangActive,
  });

  player.totalDmgDealt += hitResult?.finalDmg ?? 0;
  checkEmotionLevel(battleId, playerId);

  addLog(
    battleId,
    `⚔️ **${player.name}** [${weapon.name}] Roll: ${dmgRoll} → Sanity(${player.sanity >= 0 ? "+" : ""}${player.sanity}) → **${finalDmg} DMG**`
  );

  // Bleed tick khi địch hành động (tick mỗi lần hành động)
  _tickBleedOnAction(battleId, "boss", boss.bossId);

  return { player, weapon, roll: dmgRoll, finalDmg, isCrit, hitResult };
}

/**
 * Né (Dodge)
 */
function playerDodge(battleId, playerId) {
  const battle = COMBAT_STATE.get(battleId);
  const player = _getPlayer(battle, playerId);
  if (!player) return { error: "Không tìm thấy player" };
  if (player.isStaggered || player.isPanic) return { error: "Đang Stagger/Panic, không thể hành động" };

  if (player.injuries.includes("mất-chân")) {
    return { error: "Bị mất chân — không thể né" };
  }

  let staCost = 20;
  if (player.injuries.includes("gãy-chân")) staCost = 40; // gãy chân: x2 sta để né

  if (player.sta < staCost) return { error: `Không đủ Stamina (cần ${staCost})` };

  player.sta -= staCost;
  player.staUsedThisTurn += staCost;
  player.isGuarding = false;

  addLog(battleId, `💨 **${player.name}** né (Sta: -${staCost})`);
  return { success: true, staCost };
}

/**
 * Guard (giảm 90% dmg nhận)
 */
function playerGuard(battleId, playerId) {
  const battle = COMBAT_STATE.get(battleId);
  const player = _getPlayer(battle, playerId);
  if (!player) return { error: "Không tìm thấy player" };
  if (player.isStaggered || player.isPanic) return { error: "Đang Stagger/Panic, không thể hành động" };

  if (player.sta < 10) return { error: "Không đủ Stamina (cần 10)" };

  player.sta -= 10;
  player.staUsedThisTurn += 10;
  player.isGuarding = true;

  addLog(battleId, `🛡️ **${player.name}** Guard (Sta: -10) — Giảm 90% dmg`);
  return { success: true };
}

/**
 * Parry (player d20 vs boss d16)
 * Thắng: không nhận dmg, +10 sanity
 * Thua: -40 sta, nhận full dmg, -10 sanity
 */
function playerParry(battleId, playerId) {
  const battle = COMBAT_STATE.get(battleId);
  const player = _getPlayer(battle, playerId);
  if (!player) return { error: "Không tìm thấy player" };
  if (player.isStaggered || player.isPanic) return { error: "Đang Stagger/Panic, không thể hành động" };

  player.isGuarding = false;

  // Điều chỉnh dice theo injury
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
    addLog(
      battleId,
      `🎯 **${player.name}** Parry thành công! [${playerRoll} vs ${bossRoll}] (+10 Sanity)`
    );
    return { success: true, playerRoll, bossRoll, sanityChange: +10 };
  } else {
    // Thua: -40 sta
    let staPenalty = 40;
    if (player.injuries.includes("gãy-tay")) staPenalty *= 2; // gãy tay: parry hụt mất x2 sta

    player.sta = Math.max(0, player.sta - staPenalty);
    player.sanity = Math.max(-45, player.sanity - 10);

    addLog(
      battleId,
      `❌ **${player.name}** Parry thất bại [${playerRoll} vs ${bossRoll}] (-${staPenalty} Sta, -10 Sanity)`
    );

    // Check stagger sau khi mất sta
    if (player.sta <= 0 && !player.isStaggered) _applyStagger(battleId, player);
    // Check panic
    if (player.sanity <= -45 && !player.isPanic) _applyPanic(battleId, player);

    return { success: false, playerRoll, bossRoll, staPenalty, sanityChange: -10 };
  }
}

/**
 * Kích hoạt Shin/Mang (tốn 25 sanity, không dùng được khi sanity < -10)
 */
function playerActivateShin(battleId, playerId) {
  const battle = COMBAT_STATE.get(battleId);
  const player = _getPlayer(battle, playerId);
  if (!player) return { error: "Không tìm thấy player" };
  if (!canUseShin(playerId)) return { error: "Bạn chưa học được Shin" };
  if (player.sanity < -10) return { error: "Sanity quá thấp để dùng Shin (cần > -10)" };

  player.sanity -= 25;
  player.isShinActive = true;
  player.isMangActive = true;

  // Tính Mang multiplier: +10% base, +10% mỗi vòng (cần track turnMangActivated)
  player._mangStartTurn = battle.turnNumber;
  player._mangMul = 1.1;

  // Shin: giảm 0.2x mọi loại res
  player.res = {
    B: Math.max(0, player.res.B - 0.2),
    P: Math.max(0, player.res.P - 0.2),
    S: Math.max(0, player.res.S - 0.2),
  };

  addLog(battleId, `⬜ **${player.name}** kích hoạt Shin/Mang (-25 Sanity, Res -0.2x, Dmg +10%)`);
  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMOTION LEVEL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kiểm tra và cập nhật Emotion Level sau mỗi lần gây dmg
 */
function checkEmotionLevel(battleId, playerId) {
  const battle = COMBAT_STATE.get(battleId);
  const player = _getPlayer(battle, playerId);
  if (!player || player.emotionCooldown > 0) return;

  const totalDmg = player.totalDmgDealt;

  if (player.emotionLevel < 2 && totalDmg >= 500) {
    // Level 2
    player.emotionLevel = 2;
    player.emotionActiveTurns = 2;
    player.maxLight = Math.min(6, player.maxLight + (player.emotionLevel === 1 ? 1 : 2));
    const hpHeal = Math.ceil(player.maxHp * 0.10);
    player.hp = Math.min(player.maxHp, player.hp + hpHeal);
    addLog(
      battleId,
      `🔥 **${player.name}** → **Emotion Level 2**! (Max Light +2, Hồi ${hpHeal} HP, +2 Dice Up)`
    );
  } else if (player.emotionLevel < 1 && totalDmg >= 200) {
    // Level 1
    player.emotionLevel = 1;
    player.emotionActiveTurns = 2;
    player.maxLight = Math.min(6, player.maxLight + 1);
    const hpHeal = Math.ceil(player.maxHp * 0.05);
    player.hp = Math.min(player.maxHp, player.hp + hpHeal);
    addLog(
      battleId,
      `🔥 **${player.name}** → **Emotion Level 1**! (Max Light +1, Hồi ${hpHeal} HP, +1 Dice Up)`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EFFECTS TICK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tick Burn + Bleed cuối turn (end turn phase)
 * Burn: dmg = count * 2, halve; Bleed: halve (đã tick per-action)
 */
function tickEffectsEndTurn(battleId, targetType, targetId) {
  const battle = COMBAT_STATE.get(battleId);
  const target = _getTarget(battle, targetType, targetId);
  if (!target) return;

  // Burn: gây dmg = count * 2, sau đó halve
  if (target.effects.burn && target.effects.burn >= 1) {
    const burnDmg = Math.ceil(target.effects.burn * 2);
    target.hp = Math.max(0, target.hp - burnDmg);
    target.effects.burn = target.effects.burn / 2;
    if (target.effects.burn < 0.5) target.effects.burn = 0;
    addLog(battleId, `🔥 ${target.name} nhận ${burnDmg} Burn DMG (count còn ${target.effects.burn.toFixed(1)})`);
  }

  // Bleed: halve end turn (dmg đã tick per-action riêng)
  if (target.effects.bleed && target.effects.bleed >= 0.5) {
    target.effects.bleed = target.effects.bleed / 2;
    if (target.effects.bleed < 0.5) target.effects.bleed = 0;
  }
}

/**
 * Tick Bleed khi target hành động (per-action, không phải end turn)
 * Gây dmg = count / 4
 */
function _tickBleedOnAction(battleId, targetType, targetId) {
  const battle = COMBAT_STATE.get(battleId);
  const target = _getTarget(battle, targetType, targetId);
  if (!target || !target.effects.bleed || target.effects.bleed < 0.5) return;

  const bleedDmg = Math.ceil(target.effects.bleed / 4);
  target.hp = Math.max(0, target.hp - bleedDmg);
  addLog(battleId, `🩸 ${target.name} nhận ${bleedDmg} Bleed DMG (hành động)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// END TURN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kết thúc turn: hồi Stamina, Light recovery, Emotion tick, Effect halve, Stagger/Panic cleanup
 */
function endTurn(battleId) {
  const battle = COMBAT_STATE.get(battleId);
  if (!battle) return;

  for (const player of battle.participants) {
    // ── Stagger ──
    if (player.isStaggered) {
      player.staggerTurnsLeft--;
      if (player.staggerTurnsLeft <= 0) {
        player.isStaggered = false;
        player.sta = player.maxSta;
        player.res = { ...player.baseRes }; // restore base res
        addLog(battleId, `✅ **${player.name}** hết Stagger — Sta hồi đầy`);
      } else {
        addLog(battleId, `⚡ **${player.name}** vẫn đang Stagger (${player.staggerTurnsLeft} turn còn lại)`);
      }
    } else {
      // Hồi 30 Sta
      player.sta = Math.min(player.maxSta, player.sta + 30);
    }

    // ── Panic ──
    if (player.isPanic) {
      player.isPanic = false;
      player.sanity = 0;
      addLog(battleId, `✅ **${player.name}** hết Panic — Sanity reset về 0`);
    }

    // ── Light recovery ──
    // Đầu turn sau nhận pendingLight từ turn trước
    if (player.pendingLightGain > 0) {
      player.light = Math.min(player.maxLight, player.light + player.pendingLightGain);
      addLog(battleId, `💡 **${player.name}** nhận +${player.pendingLightGain} Light`);
      player.pendingLightGain = 0;
    }
    // Tính light cho turn kế: mỗi 20 sta đã dùng trong turn này = 1 light
    const newLight = Math.floor(player.staUsedThisTurn / 20);
    if (newLight > 0) player.pendingLightGain = newLight;
    player.staUsedThisTurn = 0;

    // ── Guard reset ──
    player.isGuarding = false;

    // ── Emotion Level tick ──
    if (player.emotionLevel > 0) {
      player.emotionActiveTurns--;
      if (player.emotionActiveTurns <= 0) {
        const prevLevel = player.emotionLevel;
        player.emotionLevel = 0;
        player.emotionCooldown = 5;
        // Giảm maxLight về lại mức cũ
        player.maxLight = Math.max(4, player.maxLight - (prevLevel === 2 ? 2 : 1));
        addLog(battleId, `📉 **${player.name}** mất Emotion Level — Cooldown 5 turn`);
      }
    }
    if (player.emotionCooldown > 0) {
      player.emotionCooldown--;
    }

    // ── Shin/Mang reset sau mỗi turn ──
    if (player.isShinActive) {
      // Mang mul tăng 10% mỗi turn
      player._mangMul = Math.min(player._mangMul + 0.1, 2.0); // cap 2x
    }

    // ── Burn/Bleed tick end turn ──
    tickEffectsEndTurn(battleId, "player", player.userId);

    // ── Cooldown reduction ──
    for (const skillId of Object.keys(player.skillCd)) {
      player.skillCd[skillId] = Math.max(0, player.skillCd[skillId] - 1);
    }
  }

  // Boss: burn/bleed tick + effect cleanup
  for (const boss of battle.bosses) {
    tickEffectsEndTurn(battleId, "boss", boss.bossId);
  }

  battle.turnNumber++;
  addLog(battleId, `⏭️ ─── End Turn ${battle.turnNumber - 1} → Turn ${battle.turnNumber} ───`);
}

// ─────────────────────────────────────────────────────────────────────────────
// INJURY
// ─────────────────────────────────────────────────────────────────────────────

function applyLightInjury(battleId, playerId) {
  const battle = COMBAT_STATE.get(battleId);
  const player = _getPlayer(battle, playerId);
  if (!player) return;

  const choices = ["gãy-tay", "gãy-chân", "gãy-xương", "choáng"];
  const injury = choices[Math.floor(Math.random() * choices.length)];

  if (injury === "gãy-xương") {
    player.maxHp = Math.max(1, player.maxHp - 30);
    player.hp = Math.min(player.hp, player.maxHp);
    addLog(battleId, `🩹 **${player.name}** Chấn thương nhẹ: **Gãy Xương** (Max HP -30 → ${player.maxHp})`);
  } else if (injury === "choáng") {
    player.stunsStacks = (player.stunsStacks ?? 0) + 1;
    addLog(
      battleId,
      `🩹 **${player.name}** Chấn thương nhẹ: **Choáng** (Stack ${player.stunsStacks}/2 — 2 stack sẽ tăng stagger từ 1 → 2 turn)`
    );
  } else {
    if (!player.injuries.includes(injury)) {
      player.injuries.push(injury);
      addLog(battleId, `🩹 **${player.name}** Chấn thương nhẹ: **${injury}**`);
    }
  }
}

function applyHeavyInjury(battleId, playerId) {
  const battle = COMBAT_STATE.get(battleId);
  const player = _getPlayer(battle, playerId);
  if (!player) return;

  const choices = ["mất-tay", "mất-chân", "vết-thương-lớn"];
  const injury = choices[Math.floor(Math.random() * choices.length)];

  if (injury === "vết-thương-lớn") {
    player.maxHp = Math.max(1, player.maxHp - 100);
    player.hp = Math.min(player.hp, player.maxHp);
    addLog(battleId, `💀 **${player.name}** Chấn thương nặng: **Vết Thương Lớn** (Max HP -100 → ${player.maxHp})`);
  } else {
    if (!player.injuries.includes(injury)) {
      player.injuries.push(injury);
      addLog(battleId, `💀 **${player.name}** Chấn thương nặng: **${injury}**`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGGER / PANIC
// ─────────────────────────────────────────────────────────────────────────────

function _applyStagger(battleId, player) {
  let staggerDuration = 1;

  // Choáng: 2 stack thì stagger tăng từ 1 → 2 turn
  if ((player.stunsStacks ?? 0) >= 2) {
    staggerDuration = 2;
    player.stunsStacks = 0; // reset sau khi trigger
    addLog(battleId, `⚡ **${player.name}** STAGGER ${staggerDuration} turn (Choáng x2!)`);
  } else {
    addLog(battleId, `⚡ **${player.name}** STAGGER — Không thể hành động 1 turn`);
  }

  player.isStaggered = true;
  player.staggerTurnsLeft = staggerDuration;
  // Set res về 2x trong khi stagger
  player.res = { B: 2, P: 2, S: 2 };
}

function _applyPanic(battleId, player) {
  player.isPanic = true;
  addLog(battleId, `😱 **${player.name}** PANIC — Không thể hành động 1 turn`);
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

function addLog(battleId, message) {
  const battle = COMBAT_STATE.get(battleId);
  if (!battle) return;
  battle.log.push(message);
  if (battle.log.length > 20) battle.log.shift();
}

function getBattle(battleId) {
  return COMBAT_STATE.get(battleId) ?? null;
}

function enableShinForUser(userId) {
  SHIN_ENABLED_USERS.add(userId);
}

function canUseShin(userId) {
  return SHIN_ENABLED_USERS.has(userId);
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
    ]
      .filter(Boolean)
      .join("  ") || "None",
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
  // Battle lifecycle
  generateBattleId,
  createBattle,
  addBoss,
  addPlayer,
  getBattle,
  endTurn,
  addLog,
  // Actions
  playerAttack,
  playerDodge,
  playerGuard,
  playerParry,
  playerActivateShin,
  // Damage / Effects
  takeDamage,
  tickEffectsEndTurn,
  // Injury
  applyLightInjury,
  applyHeavyInjury,
  // Emotion
  checkEmotionLevel,
  // Display
  formatParticipantStatus,
  formatBar,
  // Shin
  enableShinForUser,
  canUseShin,
  // State (for debugging/admin)
  COMBAT_STATE,
};
