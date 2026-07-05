// encounter-actions.js
// 6 hàm "perform*" xử lý hành động tức thời của encounter (Guard/Evade, Parry,
// Shin/Mang, Manifest E.G.O, Overcharge, Follow-Up/Pounce) — dùng CHUNG cho cả
// lệnh text (-encounter guard/...) VÀ dropdown UI (encmenu handler). Tách khỏi
// index.js theo yêu cầu trực tiếp: "tiếp tục tách hàm ra thành file riêng".
//
// ĐÂY LÀ NHÓM DEPENDENCY LỚN NHẤT TỪ TRƯỚC TỚI NAY (12 thứ cần inject) — vì các
// hàm này ASYNC, dùng Redis trực tiếp (withLock/getEncounter/saveEncounter), gọi
// checkStaggerPanic/appendActionLog (đã tách ở combat-utils.js), VÀ performFollowUp
// còn gọi doPlayerHit (hàm attack pipeline lớn, CHƯA tách — vẫn ở index.js, chỉ
// cần biết GỌI nó như 1 hàm, không cần hiểu chi tiết bên trong).
//
// r() là random-range helper đến từ skills.js (không phải tự định nghĩa trong
// index.js) — vẫn inject qua factory như các dependency khác để nhất quán pattern.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ withLock, encounterKey, getEncounter, saveEncounter, normalizeEnemyKey, hasPerk, getParryClashPenalty, checkStaggerPanic, appendActionLog, ENCOUNTER_SANITY_MAX, r, doPlayerHit }) {

  async function performGuardEvade(channelId, userId, isAdmin, type, enemyKeyRaw = "") {
    let result;
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Channel này chưa có encounter nào.");
      let combatant, label;
      if (enemyKeyRaw) {
        if (!isAdmin && userId !== encounter.gmId) throw new Error("Chỉ GM/admin mới điều khiển được enemy.");
        const ekey = normalizeEnemyKey(enemyKeyRaw);
        combatant = encounter.enemies[ekey];
        if (!combatant) throw new Error(`Không tìm thấy enemy "${enemyKeyRaw}".`);
        label = `**${combatant.name}**`;
      } else {
        combatant = encounter.players[userId];
        if (!combatant) throw new Error("Bạn chưa tham gia encounter này.");
        label = `<@${userId}>`;
      }
      if (combatant.staggered) throw new Error(`${label} đang bị Stagger — không thể hành động.`);
      if (type === "evade" && (combatant.injuries ?? []).includes("Mất Chân")) {
        throw new Error(`${label} đã Mất Chân — không thể Evade được nữa.`);
      }
      let cost = type === "guard" ? 10 : 20;
      if (type === "evade" && (combatant.injuries ?? []).includes("Gãy chân")) cost *= 2;
      // Iron Horus (Abydos's Uniform - Lazy Style, outfit passive): Guard tốn 40 Sta
      // (thay vì 10 mặc định) — ĐỔI LẠI giảm 100% dmg thay vì 90%/99% (xem
      // guardReductionPct trong khối xử lý damage lúc confirm — check combatant.
      // hasIronHorus ở đó). Set CỨNG 40 (không cộng dồn với Overflowing Guard/khác —
      // outfit override hẳn cơ chế Guard cơ bản, không phải % giảm thêm).
      if (type === "guard" && combatant.hasIronHorus) {
        cost = 40;
      }
      // Defense Up (50-Status Nhóm 2, xác nhận trực tiếp): "Nếu block đạt 100%
      // giảm sát thương sẽ đổi qua với mỗi 3 Defense Up giảm 1 Stamina cho Block."
      // Tính % giảm dmg Guard RAW (giống hệt công thức lúc commit dmg — xem
      // guardReductionPct trong index.js) — nếu RAW (chưa clamp) vượt quá 100%,
      // phần Defense Up "dư" (không còn tác dụng giảm dmg vì đã chạm trần) đổi
      // sang giảm Stamina, cứ 3 điểm dư = -1 Stamina (làm tròn xuống). KHÔNG áp
      // dụng cho Iron Horus (đã set cứng 100% + cost 40 riêng, không cộng dồn).
      let defenseUpStaminaDiscount = 0;
      if (type === "guard" && !combatant.hasIronHorus) {
        const baseGuardPctForCost = hasPerk(combatant, "Fortified Resolve") ? 0.99 : 0.9;
        const defenseUpDownPctForCost = ((combatant.defenseUp ?? 0) * 1 - (combatant.defenseDown ?? 0) * 5) / 100;
        const rawGuardPct = baseGuardPctForCost + defenseUpDownPctForCost;
        if (rawGuardPct > 1) {
          const excessDefenseUpPct = (rawGuardPct - 1) * 100; // %-điểm dư, = số Defense Up dư (vì +1%/stack)
          defenseUpStaminaDiscount = Math.floor(excessDefenseUpPct / 3);
          cost = Math.max(0, cost - defenseUpStaminaDiscount);
        }
      }
      // Overflowing Guard (Envy, [45 Points]): ≥7 Charge → Guard giảm 1 nửa Stamina,
      // đồng thời giảm 1 Charge bản thân.
      let overflowingGuardUsed = false;
      if (type === "guard" && hasPerk(combatant, "Overflowing Guard") && (combatant.charge ?? 0) >= 7) {
        cost = Math.ceil(cost / 2);
        overflowingGuardUsed = true;
      }
      // Close Call Wind (Wrath, [10 Points]): dưới 50% HP → Evade -5 Stamina.
      if (type === "evade" && hasPerk(combatant, "Close Call Wind") && combatant.currentHp < combatant.maxHp * 0.5) {
        cost = Math.max(0, cost - 5);
      }
      // Fleeting Steps (Sloth, [10 Points]): cứ 3 lần né, lần né tiếp theo (lần thứ 4,
      // 8, 12...) KHÔNG tốn Stamina — đếm TRƯỚC khi tính cost, áp dụng NGAY lần này
      // nếu rơi đúng mốc (không phải "lần tới mới free", mà CHÍNH lần thứ 4 này free).
      let freeFromFleetingSteps = false;
      if (type === "evade" && hasPerk(combatant, "Fleeting Steps")) {
        combatant.evadeCountForFleetingSteps = (combatant.evadeCountForFleetingSteps ?? 0) + 1;
        if (combatant.evadeCountForFleetingSteps % 4 === 0) { freeFromFleetingSteps = true; cost = 0; }
      }
      if (combatant.currentStamina < cost) throw new Error(`Không đủ Stamina — cần ${cost}, còn ${combatant.currentStamina}.`);
      combatant.currentStamina -= cost;
      if (overflowingGuardUsed) combatant.charge = Math.max(0, (combatant.charge ?? 0) - 1);
      // KHÔNG cộng vào staminaUsedThisTurn ở đây — counter này CHỈ tính Stamina tiêu
      // qua ĐÁNH THƯỜNG (M1) theo đúng luật ("đánh thường đủ 20 Stamina... +1 Light",
      // "20 Stamina tiêu thụ thông qua đánh thường" cho Pounce/Follow-Up) — Guard/Evade
      // là phòng thủ, KHÔNG phải đánh thường, không được tính vào đây (bug cũ đã sửa:
      // trước đây Guard/Evade vô tình làm Light-gain/Pounce kích hoạt sai khi người
      // chơi CHỈ phòng thủ, chưa hề M1).
      const chargeField = type === "guard" ? "guardCharges" : "evadeCharges";
      combatant[chargeField] = (combatant[chargeField] ?? 0) + 1;
      checkStaggerPanic(combatant);
      result = `${type === "guard" ? "🛡️ Guard" : "💨 Evade"}! ${label} -${cost} Stamina${freeFromFleetingSteps ? " (Fleeting Steps — FREE lần này!)" : ""}${overflowingGuardUsed ? " (Overflowing Guard — giảm 1 nửa Sta, -1 Charge)" : ""}${defenseUpStaminaDiscount > 0 ? ` (Defense Up dư — giảm thêm ${defenseUpStaminaDiscount} Sta)` : ""} → đang có ${combatant[chargeField]} charge ${type} (1 charge chặn 4 hit M1 Light / 2 hit Medium / 1 hit Heavy của đối phương).`;
      appendActionLog(encounter, result);
      await saveEncounter(channelId, encounter);
    });
    return result;
  }
  
  /** performParry — logic CHUNG cho -encounter parry VÀ dropdown hành động. */
  async function performParry(channelId, userId, isAdmin, enemyKeyRaw = "") {
    let result;
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Channel này chưa có encounter nào.");
      let combatant, label;
      if (enemyKeyRaw) {
        if (!isAdmin && userId !== encounter.gmId) throw new Error("Chỉ GM/admin mới điều khiển được enemy.");
        const ekey = normalizeEnemyKey(enemyKeyRaw);
        combatant = encounter.enemies[ekey];
        if (!combatant) throw new Error(`Không tìm thấy enemy "${enemyKeyRaw}".`);
        label = `**${combatant.name}**`;
      } else {
        combatant = encounter.players[userId];
        if (!combatant) throw new Error("Bạn chưa tham gia encounter này.");
        label = `<@${userId}>`;
      }
      if (combatant.staggered) throw new Error(`${label} đang bị Stagger — không thể hành động.`);
      const rawRoll = 1 + Math.floor(Math.random() * 20);
      const penalty = getParryClashPenalty(combatant);
      const roll = rawRoll - penalty;
      combatant.parryRolls = combatant.parryRolls ?? [];
      combatant.parryRolls.push(roll);
      result = `🗡️ Parry! ${label} roll được **${rawRoll}**${penalty > 0 ? ` -${penalty} (chấn thương) = **${roll}**` : ""} (0 Stamina) — đang có ${combatant.parryRolls.length} lần parry chờ sẵn.`;
      appendActionLog(encounter, result);
      await saveEncounter(channelId, encounter);
    });
    return result;
  }
  
  /** performShinMang — logic CHUNG cho -encounter shinmang VÀ dropdown hành động. */
  async function performShinMang(channelId, userId) {
    let result;
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Channel này chưa có encounter nào.");
      const player = encounter.players[userId];
      if (!player) throw new Error("Bạn chưa tham gia encounter này.");
      if (!hasPerk(player, "Shin")) throw new Error("Bạn chưa sở hữu Shin (GM cấp qua `-unlockskilltree @bạn Shin` nếu thực sự có sở hữu).");
      if (player.shinMangUsedThisTurn) throw new Error("Đã dùng Shin/Mang trong turn này rồi — chỉ 1 lần/turn.");
      // Decimate Mind (Shin, [20 Points]): cho phép hi sinh vượt mốc -10 (xuống tới
      // -35) để kích hoạt Shin/Mang — KHÔNG có perk thì mốc giới hạn vẫn là -10 như
      // luật gốc.
      const sanityFloorForShin = hasPerk(player, "Decimate Mind") ? -35 : -10;
      if (player.currentSanity <= sanityFloorForShin) throw new Error(`Không thể hi sinh để dùng Shin/Mang khi Sanity hiện tại ≤ ${sanityFloorForShin} (hiện tại: ${player.currentSanity}).`);
      player.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, player.currentSanity - 25);
      player.shinMangActive = true;
      player.shinMangUsedThisTurn = true;
      player.shinMangRounds = (player.shinMangRounds ?? 0) + 1;
      checkStaggerPanic(player);
      // Defensive Light (Shin, [10 Points]): +0,1x giảm Res CỘNG THÊM (trên nền -0,2x
      // gốc) cho MỖI 10 Shin Level hiện có. shinLevel mặc định = 10 (luật: "Khởi điểm
      // với 10 Shin Lvl") — KHÔNG có cơ chế nào khác cho biết Shin Lvl tăng/giảm theo
      // gì, nên tạm coi là hằng số 10 trừ khi có thêm luật rõ hơn.
      const shinLevel = player.shinLevel ?? 10;
      const defensiveLightNote = hasPerk(player, "Defensive Light")
        ? ` Defensive Light: thêm -${(Math.floor(shinLevel / 10) * 0.1).toFixed(1)}x Res (Shin Lvl ${shinLevel}).`
        : "";
      result =
        `🌑 **Shin/Mang kích hoạt!** -25 Sanity (còn ${player.currentSanity}) → Shin: -0,2x mọi Res bản thân.${defensiveLightNote} ` +
        `Mang: +${player.shinMangRounds * 10}% Dmg M1+skill turn này (vòng ${player.shinMangRounds}), gây True Dmg.`;
      appendActionLog(encounter, result);
      await saveEncounter(channelId, encounter);
    });
    return result;
  }
  
  /** performManifestEgo — logic CHUNG cho -encounter manifestego VÀ dropdown hành động. */
  async function performManifestEgo(channelId, userId) {
    let result;
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Channel này chưa có encounter nào.");
      const player = encounter.players[userId];
      if (!player) throw new Error("Bạn chưa tham gia encounter này.");
      if ((player.emotionLevel ?? 0) < 1) throw new Error("Cần đang ở Emotion Level ≥1 mới kích hoạt được Manifest E.G.O.");
      if (!player.manifestedEGO && (player.manifestedEGOCooldownLeft ?? 0) > 0) {
        throw new Error(`Đang trong CD Manifest E.G.O — còn ${player.manifestedEGOCooldownLeft} turn.`);
      }
      player.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, player.currentSanity - 30);
      player.manifestedEGO = true;
      player.manifestedEGOTurnsLeft = player.emotionLevel * 3;
      player.manifestedEGOCooldownLeft = 0;
      checkStaggerPanic(player);
      let healNote = "";
      if (!player.firstManifestEGOUsed && hasPerk(player, "Comeback Time")) {
        const healAmt = Math.round(player.maxHp * 0.25 * 100) / 100;
        player.currentHp = Math.min(player.maxHp, player.currentHp + healAmt);
        healNote = ` 🩹+${healAmt} HP (Comeback Time — lần đầu Manifest E.G.O)`;
      }
      player.firstManifestEGOUsed = true;
      result =
        `😈 **Manifest E.G.O!** -30 Sanity (còn ${player.currentSanity}) → Duration ${player.manifestedEGOTurnsLeft} turn ` +
        `(theo Emotion Level ${player.emotionLevel}) — +3 Dice Up, +30% Dmg M1+skill.${healNote}`;
      appendActionLog(encounter, result);
      await saveEncounter(channelId, encounter);
    });
    return result;
  }
  
  /** performOvercharge — logic CHUNG cho -encounter overcharge VÀ dropdown hành động. */
  async function performOvercharge(channelId, userId) {
    let result;
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Channel này chưa có encounter nào.");
      const player = encounter.players[userId];
      if (!player) throw new Error("Bạn chưa tham gia encounter này.");
      if (!hasPerk(player, "Overcharged Vessel")) throw new Error("Bạn chưa mở khóa perk Overcharged Vessel.");
      if (player.charge < 10) throw new Error(`Cần ≥10 Charge để kích hoạt (hiện tại: ${player.charge}).`);
      const tiers = Math.floor(player.charge / 10);
      player.overchargedDiceUpBonus = tiers;
      player.overchargedDmgBonusPct = tiers * 5;
      player.overchargedTurnsLeft = 3;
      player.charge = 0;
      result = `⚡ **Overcharged!** Tiêu ${tiers * 10} Charge → +${tiers} Dice Up, +${tiers * 5}% Dmg trong 3 turn.`;
      appendActionLog(encounter, result);
      await saveEncounter(channelId, encounter);
    });
    return result;
  }
  
  /** performFollowUp — logic CHUNG cho -encounter followup VÀ dropdown hành động.
   *  Trả về { followupEmbed, hitEmbed } — caller tự gửi 2 embed này. */
  async function performFollowUp(channelId, userId, userMention, targetStr) {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Channel này chưa có encounter nào.");
    const player = encounter.players[userId];
    if (!player) throw new Error("Bạn chưa tham gia encounter này.");
    const hasFollowUp = hasPerk(player, "Follow-Up");
    const hasPounce = hasPerk(player, "Pounce");
    if (!hasFollowUp && !hasPounce) throw new Error("Bạn chưa mở khóa perk Follow-Up hoặc Pounce.");
    if (player.staminaUsedThisTurn < 20) throw new Error(`Cần tiêu ≥20 Stamina qua đánh thường trong turn này trước (hiện tại: ${player.staminaUsedThisTurn}).`);
    if (player.followUpUsedThisTurn) throw new Error("Đã dùng Follow-Up/Pounce trong turn này rồi — chỉ 1 lần/turn.");
    const dmgStr = hasFollowUp ? `${r(10, 14)}B` : `${r(8, 30)}B`;
    // Shin Follow Up (Shin, [5 Points]): Follow-Up/Pounce LUÔN LUÔN xài Mang (True
    // Dmg + bonus% theo shinMangRounds hiện có) — kể cả khi CHƯA tự kích hoạt Shin/
    // Mang turn này. "Ép" tạm thời shinMangActive=true CHỈ cho lượt hit này (lưu
    // trước khi gọi doPlayerHit vì hàm đó tự fetch/save encounter riêng, rồi khôi
    // phục lại giá trị gốc ngay sau — không làm thay đổi trạng thái Shin/Mang thật
    // của người chơi cho các hành động KHÁC trong turn).
    const forceMangForFollowUp = !player.shinMangActive && hasPerk(player, "Shin Follow Up");
    if (forceMangForFollowUp) {
      player.shinMangActive = true;
      await saveEncounter(channelId, encounter);
    }
    const { embed: hitEmbed } = await doPlayerHit(channelId, userId, userMention, dmgStr, targetStr, {});
    if (forceMangForFollowUp) {
      await withLock(encounterKey(channelId), async () => {
        const enc3 = await getEncounter(channelId);
        if (enc3?.players[userId]) {
          enc3.players[userId].shinMangActive = false;
          await saveEncounter(channelId, enc3);
        }
      });
    }
    // Đánh dấu đã dùng NGAY lúc declare (không đợi confirm) — chấp nhận sai số nhỏ
    // này (nếu GM reject thì vẫn coi như đã dùng) để tránh phải thêm field riêng
    // theo dõi pending cho 1 trường hợp hiếm.
    await withLock(encounterKey(channelId), async () => {
      const enc2 = await getEncounter(channelId);
      if (enc2?.players[userId]) {
        enc2.players[userId].followUpUsedThisTurn = true;
        await saveEncounter(channelId, enc2);
      }
    });
    const followupEmbed = {
      title: hasFollowUp ? "⚡ Follow-Up!" : "🐾 Pounce!",
      description: `Tung đòn theo sau: \`${dmgStr}\`${hasFollowUp ? " — kẻ địch rơi vào **[Airborne]** (tự narrate, không phải status hệ thống)" : ""}`,
      color: 0xf39c12,
    };
    return { followupEmbed, hitEmbed };
  }

  return {
    performGuardEvade,
    performParry,
    performShinMang,
    performManifestEgo,
    performOvercharge,
    performFollowUp,
  };
};
