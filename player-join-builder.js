// player-join-builder.js
// buildJoinedCombatant — TÁCH từ logic "-encounter join" (message-create-handler.js)
// thành 1 hàm TRẢ VỀ { joined, wasJoined, equipNotes, startNotes, finalHp,
// gradeBasedMaxHp, gradeBasedMaxLight, playerGrade } (không tự saveEncounter/reply)
// — dùng chung cho CẢ lệnh text "-encounter join" LẪN auto-join từ Party Board
// (quest system, xem party-board.js) — tránh COPY lại ~150 dòng logic profile-
// loading đã có NHIỀU lần sửa lỗi (equippedOutfit snapshot, Udjat Protection
// duration, Index Proselyte prescript...) ở 2 chỗ khác nhau, dễ lệch/tái phát bug
// cũ nếu chỉ sửa 1 nơi sau này.
//
// COPY NGUYÊN VĂN logic từ message-create-handler.js (không đổi 1 dòng tính toán
// nào) — chỉ đổi message.author.id/username thành tham số userId/displayName, và
// kv (parseKeyValues(rest)) thành tham số truyền vào (rỗng {} cho quest auto-join).
//
// LƯU Ý QUAN TRỌNG cho caller: hàm này MUTATE trực tiếp encounter.players[userId]
// (set = createCombatant(...)) và profileDataForDefaults (nếu HP auto-reset) —
// PHẢI gọi bên trong withLock(encounterKey(...)) như -encounter join gốc, và
// caller vẫn phải tự saveEncounter sau khi gọi xong.

module.exports = function ({
  createCombatant, findWeaponAnywhere, findOutfit, normalizeWeaponWeight,
  calcGrade, GRADE_MIN, calcInjuryMaxHpPenalty, getEffectiveCurrentHp,
  getPlayerDataWithSlot, savePlayerData, hasEncounterStarted,
  validateAndRerollPrescript, hasPerk, POISE_MAX, ENCOUNTER_DEFAULT_MAX_STAMINA,
}) {
  async function buildJoinedCombatant(encounter, userId, displayName, profileDataForDefaults, kv = {}) {
    const hp = parseInt(kv["hp"] ?? "", 10);
    const stamina = parseInt(kv["stamina"] ?? "", 10);
    const light = parseInt(kv["light"] ?? "", 10);
    const equippedWeaponObj = profileDataForDefaults.equippedWeapon ? findWeaponAnywhere(profileDataForDefaults.equippedWeapon) : null;
    const equippedOutfitObj = profileDataForDefaults.equippedOutfit ? findOutfit(profileDataForDefaults.equippedOutfit) : null;
    const weapon = normalizeWeaponWeight(kv["weapon"] ?? equippedWeaponObj?.weight ?? "medium");
    const resRaw = kv["res"] ?? "";
    const res = equippedOutfitObj ? { ...equippedOutfitObj.resistance } : { B: 2, P: 2, S: 2 };
    for (const m of resRaw.matchAll(/([\d.]+)(?:x)?([BPS])/gi)) res[m[2].toUpperCase()] = parseFloat(m[1]);
    const speedRangeMatch = (kv["speedrange"] ?? "").match(/(\d+)\s*[~\-]\s*(\d+)/);
    const speedRangeMin = speedRangeMatch ? parseInt(speedRangeMatch[1], 10) : (equippedOutfitObj?.speedRange?.min ?? 3);
    const speedRangeMax = speedRangeMatch ? parseInt(speedRangeMatch[2], 10) : (equippedOutfitObj?.speedRange?.max ?? 6);
    const { grade: playerGrade } = calcGrade(profileDataForDefaults.exp ?? 0);
    const gradeBasedMaxLight = Math.min(6, 4 + Math.floor((GRADE_MIN - playerGrade) / 3));
    const gradeBasedMaxHp = 140 + 20 * (GRADE_MIN - playerGrade);
    const persistedInjuries = profileDataForDefaults.injuries ?? [];
    const injuryMaxHpPenalty = calcInjuryMaxHpPenalty(persistedInjuries);
    const effectiveGradeMaxHp = Math.max(1, gradeBasedMaxHp - injuryMaxHpPenalty);
    const effectiveHp = getEffectiveCurrentHp(profileDataForDefaults, effectiveGradeMaxHp);
    if (effectiveHp.didReset) {
      profileDataForDefaults.currentHp = effectiveHp.hp;
      profileDataForDefaults.hpLastResetCheck = Date.now();
      const { slot: hpSlot } = await getPlayerDataWithSlot(userId);
      await savePlayerData(userId, profileDataForDefaults, hpSlot);
    }
    const finalHp = Number.isFinite(hp) && hp > 0 ? hp : effectiveHp.hp;
    // BUG THẬT phát hiện qua báo cáo trực tiếp kèm ảnh chụp (Fragaria: "Grade 1
    // đáng lẽ 300 HP nhưng chỉ có 242, và số có phần thập phân lạ") — TRƯỚC ĐÂY
    // maxHp truyền cho createCombatant là `finalHp` (HP CARRY-OVER còn lại từ
    // trước, VD 242.2 dở dang) — nhưng createCombatant tự set currentHp=maxHp,
    // nên Max HP THẬT bị "co lại" vĩnh viễn thành đúng số carry-over đó thay vì
    // giữ nguyên gradeBasedMaxHp (300) — sai tích luỹ qua nhiều session join dở
    // dang. equipNotes bên dưới (dòng ~108) ĐÃ tính đúng ý định gốc là hiển thị
    // "HP: X/Y" (current/max riêng biệt) — chỉ có bước tạo combatant thật là
    // dùng sai giá trị. Sửa: maxHp LUÔN là effectiveGradeMaxHp thật (trừ khi gõ
    // tay hp: — giữ nguyên linh hoạt cho trường hợp đặc biệt), currentHp gán
    // riêng = finalHp nếu thấp hơn max.
    const finalMaxHp = Number.isFinite(hp) && hp > 0 ? hp : effectiveGradeMaxHp;

    const wasJoined = !!encounter.players[userId];
    encounter.players[userId] = createCombatant({
      name: displayName, maxHp: finalMaxHp,
      maxStamina: Number.isFinite(stamina) && stamina > 0 ? stamina : ENCOUNTER_DEFAULT_MAX_STAMINA,
      maxLight: Number.isFinite(light) && light > 0 ? light : gradeBasedMaxLight,
      weaponWeight: weapon,
      weaponBaseDamage: equippedWeaponObj?.baseDamage ?? null,
      weaponType: equippedWeaponObj?.type ?? null,
      weaponName: equippedWeaponObj?.name ?? null,
      weaponCriticalKey: equippedWeaponObj ? (equippedWeaponObj.criticalSkillKey ?? equippedWeaponObj.name) : null,
      equippedOutfit: profileDataForDefaults.equippedOutfit ?? null,
      resistance: res, speedRangeMin, speedRangeMax,
    });
    const profileData = profileDataForDefaults;
    const joined = encounter.players[userId];
    // GAP THẬT ĐÃ SỬA (cùng bug ở trên) — createCombatant mặc định currentHp =
    // maxHp (full máu), cần ghi đè lại ĐÚNG bằng finalHp (carry-over thật) nếu
    // nó THẤP HƠN max — chỉ áp dụng lúc join LẦN ĐẦU (wasJoined=false); join
    // LẠI (đổi trang bị giữa trận) không nên reset lại currentHp đang có.
    if (!wasJoined && finalHp < finalMaxHp) {
      joined.currentHp = finalHp;
    }
    joined.unlockedPerks = [...(profileData.unlockedSkillTree ?? [])];
    joined.injuries = [...persistedInjuries];
    joined.unlockedPagesSnapshot = (profileData.equippedPages ?? []).filter(Boolean);
    joined.unlockedEgoPagesSnapshot = (profileData.equippedEgoPages ?? []).filter(Boolean);
    joined.equippedAccessoriesSnapshot = (profileData.equippedAccessories ?? []).filter(Boolean);
    joined.hasIronHorus = (profileData.equippedOutfit ?? "").toLowerCase().replace(/^["']+|["']+$/g, "") === "abydos's uniform - lazy style";
    const equippedOutfitNameNormalized = (profileData.equippedOutfit ?? "").toLowerCase().replace(/^["']+|["']+$/g, "");
    joined.hasReverberationEnsemble = equippedOutfitNameNormalized === "reverberation ensemble";
    if (!wasJoined && equippedOutfitNameNormalized === "ambitious fixer") {
      joined.haste = (joined.haste ?? 0) + 3;
    }
    joined.hasAmbitiousFixer = equippedOutfitNameNormalized === "ambitious fixer";
    joined.hasThumbSoldato = equippedOutfitNameNormalized === "thumb soldato";
    joined.hasWarpCorpCleaner = equippedOutfitNameNormalized === "warp corp. cleaner";
    joined.hasSevenAssociation = equippedOutfitNameNormalized === "seven association";
    joined.hasLiuAssociation = equippedOutfitNameNormalized === "liu association";
    joined.hasCinqAssociation = equippedOutfitNameNormalized === "cinq association";
    joined.hasDieciAssociation = equippedOutfitNameNormalized === "dieci association";
    joined.hasZweiAssociation = equippedOutfitNameNormalized === "zwei association";
    joined.hasHanaAssociation = equippedOutfitNameNormalized === "hana association";
    joined.hasIndexProselyte = equippedOutfitNameNormalized === "index proselyte";
    // Task yêu cầu trực tiếp: "manifested ego không có check true false khiến
    // ai cũng có được dù đáng lẽ chỉ những ai có check true mới có" — GAP THẬT:
    // profileData.ManifestedEGOUnlock (cờ admin set qua -flag) đã tồn tại từ
    // trước nhưng CHƯA BAO GIỜ được copy vào combatant hay check ở đâu cả — copy
    // vào đây để performManifestEgo (encounter-actions.js) check được.
    joined.manifestedEGOUnlock = profileDataForDefaults.ManifestedEGOUnlock === true;
    if (!wasJoined && hasEncounterStarted(encounter)) {
      validateAndRerollPrescript(encounter, null, { id: userId, type: "player" });
    }
    const startNotes = [];
    if (!wasJoined) {
      if (hasPerk(joined, "Here We Go Again")) { joined.currentLight = Math.min(joined.maxLight, 3); startNotes.push("+3 Light (Here We Go Again)"); }
      if (hasPerk(joined, "Adrenaline Rush")) { joined.poise = Math.min(POISE_MAX, 10); startNotes.push("+10 Poise (Adrenaline Rush)"); }
      if (hasPerk(joined, "No Mind To Cure")) { joined.currentSanity = -25; startNotes.push("-25 Sanity (No Mind To Cure)"); }
      if ((equippedOutfitObj?.name ?? "").toLowerCase() === "udjat") {
        joined.protection = Math.min(20, (joined.protection ?? 0) + 10);
        joined.protectionTurnsLeft = 2;
        startNotes.push("+10 Protection (Udjat, hết sau 2 turn)");
      }
    }
    const equipNotes = [];
    if (equippedWeaponObj && !kv["weapon"]) equipNotes.push(`Vũ khí: ${equippedWeaponObj.name} (${equippedWeaponObj.weight})`);
    if (equippedOutfitObj && !kv["res"]) equipNotes.push(`Outfit: ${equippedOutfitObj.name} (Res ${res.B}xB ${res.P}xP ${res.S}xS)`);
    if (!Number.isFinite(light) || light <= 0) equipNotes.push(`Max Light: ${gradeBasedMaxLight} (theo Grade ${playerGrade})`);
    if (!Number.isFinite(hp) || hp <= 0) {
      // GAP ĐÃ SỬA (cùng đợt fix bug HP ở trên) — dùng effectiveGradeMaxHp (SAU
      // khi trừ injury) thay vì gradeBasedMaxHp (TRƯỚC injury) — khớp ĐÚNG với
      // maxHp THẬT combatant nhận được (line finalMaxHp phía trên), tránh hiện
      // sai số cho người đang mang chấn thương (VD Gãy Xương -30 Max HP).
      equipNotes.push(
        effectiveHp.hp < effectiveGradeMaxHp
          ? `HP: ${effectiveHp.hp}/${effectiveGradeMaxHp} (còn lại từ trước — chưa qua mốc reset 0h/12h giờ VN)`
          : `Max HP: ${effectiveGradeMaxHp} (theo Grade ${playerGrade})`
      );
    }
    return { joined, wasJoined, equipNotes, startNotes, finalHp, gradeBasedMaxHp, gradeBasedMaxLight, playerGrade };
  }

  return { buildJoinedCombatant };
};
