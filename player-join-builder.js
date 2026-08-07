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

// Cap Shin/Mang — DUY NHẤT 1 nguồn sự thật, encounter-actions.js import lại từ đây.
const SHIN_MAX_LEVEL = 50;
const MANG_MAX_LEVEL = 5;

module.exports = function ({ isConsumableItem,
  createCombatant, findWeaponAnywhere, findOutfit, normalizeWeaponWeight,
  calcGrade, GRADE_MIN, calcInjuryMaxHpPenalty, getEffectiveCurrentHp,
  getPlayerDataWithSlot, savePlayerData, hasEncounterStarted,
  validateAndRerollPrescript, hasPerk, POISE_MAX, ENCOUNTER_DEFAULT_MAX_STAMINA,
  ENCOUNTER_SANITY_MAX,
}) {
  async function buildJoinedCombatant(encounter, userId, displayName, profileDataForDefaults, kv = {}) {
    const hp = parseInt(kv["hp"] ?? "", 10);
    const stamina = parseInt(kv["stamina"] ?? "", 10);
    const light = parseInt(kv["light"] ?? "", 10);
    // Task yêu cầu trực tiếp (phát hiện qua ảnh chụp thật: player chưa equip vũ
    // khí có thể gõ tay dmg TÙY Ý, VD "4000x2P" — bug thật vì hoàn toàn không
    // giới hạn) — "nếu player không chọn vũ khí thì hãy để họ tự động sử dụng
    // Brawler" — mặc định Brawler (light, Blunt, baseDamage 5) thay vì null khi
    // chưa equip gì, để modal M1 luôn rơi vào nhánh "auto" (tự tính từ vũ khí),
    // không còn rơi vào nhánh "gõ tay tùy ý" nữa.
    const equippedWeaponObj = profileDataForDefaults.equippedWeapon ? findWeaponAnywhere(profileDataForDefaults.equippedWeapon) : findWeaponAnywhere("Brawler");
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
    // Slot SINGULARITY (1 slot riêng) + E.G.O RIÊNG của từng nhân vật — xem
    // singularity.js / ego.js. Chép sang combatant để panel encounter chỉ hiện
    // ĐÚNG Critical của người đó, không xài chung kho như trước.
    // Loadout consumable đặt sẵn ở -balance → mang thẳng vào trận.
    // LỌC LẠI theo kho THẬT lúc join: người chơi có thể đã bán/dùng hết món đã
    // xếp từ trước, mang vào rồi mới báo "không còn trong inventory" lúc dùng là
    // quá muộn. Cap 4 (luật: tối đa 4 item/trận) và tôn trọng số lượng sở hữu
    // (xếp 2 Chuối mà chỉ còn 1 thì chỉ mang 1).
    {
      const remaining = { ...(profileData.items ?? {}) };
      joined.consumablesLoadout = [];
      for (const n of (profileData.equippedConsumables ?? [])) {
        if (joined.consumablesLoadout.length >= 4) break;
        // Lọc 2 lớp: phải LÀ consumable (Fragaria chốt danh sách) VÀ còn hàng.
        // Loadout cũ lưu từ trước bản này có thể chứa item không hợp lệ.
        if (isConsumableItem && !isConsumableItem(n)) continue;
        if ((remaining[n] ?? 0) <= 0) continue;
        remaining[n] -= 1;
        joined.consumablesLoadout.push(n);
      }
    }
    joined.equippedSingularity = profileData.equippedSingularity ?? null;
    joined.manifestedEgoKey = profileData.ManifestedEGO ?? null;
    // ── ACCESSORY passive lúc VÀO TRẬN (GAP ĐÃ SỬA — Fragaria: "toàn bộ
    // accessory ở trong accessory.js đều chưa được implement"). Audit lại thì
    // Giày Wan MK3 (Resourceful/Chain-Dashes/Quickstep) và Composition Tool
    // (Shimmering) ĐÃ có; còn thiếu Perfect Cube (cả 3), Composition Tool
    // (Reactive/Energetic) và Realization của Găng Tay Câm Lặng — bổ sung ở đây.
    // BUG ĐÃ SỬA (Fragaria báo trực tiếp: "Perfect Cube có hoạt động đâu?") —
    // lỗi do CHÍNH bản fix trước của tôi. TRƯỚC ĐÓ tôi đặt guard `!wasJoined` vì
    // sợ "join lại nhiều lần sẽ cộng Light/Sanity vô hạn". Giả định đó SAI:
    // `encounter.players[userId] = createCombatant({...})` ngay đầu hàm này TẠO
    // OBJECT MỚI HOÀN TOÀN mỗi lần gọi — currentLight/currentSanity đã bị reset
    // về mặc định rồi, nên KHÔNG hề có chuyện cộng dồn.
    // Hệ quả của guard sai: player join → nhớ ra chưa đeo Perfect Cube → equip →
    // `-encounter join` lại (HỢP LỆ, được phép trước khi rollspeed) → combatant
    // bị reset nhưng bonus KHÔNG được cấp lại → Light 0, Sanity 0. Đúng kịch bản
    // Fragaria gặp: "đeo Perfect Cube mà chẳng thấy gì".
    // Giờ áp dụng LUÔN LUÔN — đúng ngữ nghĩa "chỉ số khởi điểm khi vào trận".
    const accessoriesLower = joined.equippedAccessoriesSnapshot.map(a => String(a).toLowerCase());
    // (Perfect Start / Perfect Mind áp ở khối startNotes bên dưới — xem lý do ở đó.)
    // "Perfect Body" (+10 HP mỗi turn end) và "Reactive" (kháng Stagger 2 lần/
    // encounter) cần state riêng — đọc ở turn-advance.js / checkStaggerPanic.
    joined.hasPerfectCube = accessoriesLower.includes("perfect cube");
    // "Reactive" — cùng lý do trên: đây là số lượt kháng KHỞI ĐIỂM của encounter,
    // createCombatant không có field này nên rejoin để lại `undefined` (mất sạch).
    if (accessoriesLower.includes("composition tool")) {
      joined.reactiveStaggerResistLeft = 2;
    }
    joined.hasCompositionTool = accessoriesLower.includes("composition tool");
    joined.hasGangTayCamLang = accessoriesLower.includes("gang tay cam lang") || accessoriesLower.includes("găng tay câm lặng");
    // BUG ĐÃ SỬA (Fragaria: "Shin chưa có dropdown ở special để sử dụng cho
    // những người unlock được Shin") — LẦN 2, nguyên nhân KHÁC hẳn lần trước.
    // Lần trước tôi tưởng Shin mở khoá qua PERK ("Shin" trong unlockedSkillTree)
    // nên thêm perk đó vào bảng + viết hasShinAccess đọc `unlockedPerks`.
    // Nhưng cơ chế THẬT của dự án là cờ RIÊNG trên profile: `data.ShinUnlock`
    // (GM bật qua `-setprofile ... shinunlock: ...`, xem UNLOCK_FLAG_KEYS) — nó
    // chính là điều kiện để được phân bổ điểm vào nhánh shin
    // (message-create-handler.js). Cờ này TRƯỚC GIỜ chưa bao giờ được copy sang
    // combatant, nên dropdown Special không có cách nào biết → người đã unlock
    // Shin đúng cách vẫn không thấy nút.
    joined.hasShinUnlock = !!profileData.ShinUnlock;
    // Shin Lvl / Mang Lvl là chỉ số PROFILE (xem player-data.js) — copy sang
    // combatant mỗi lần join. Kẹp trong cap để profile lỗi không phá cân bằng.
    joined.shinLevel = Math.min(SHIN_MAX_LEVEL, Math.max(1, profileData.ShinLevel ?? 10));
    joined.mangLevel = Math.min(MANG_MAX_LEVEL, Math.max(1, profileData.MangLevel ?? 1));
    joined.hasIronHorus = (profileData.equippedOutfit ?? "").toLowerCase().replace(/^["']+|["']+$/g, "") === "abydos's uniform - lazy style";
    const equippedOutfitNameNormalized = (profileData.equippedOutfit ?? "").toLowerCase().replace(/^["']+|["']+$/g, "");
    joined.hasReverberationEnsemble = equippedOutfitNameNormalized === "reverberation ensemble";
    // Ambitious Fixer +3 Haste — BUG CÙNG LOẠI (có SẴN từ trước, không phải do
    // đợt này): createCombatant đặt `haste: 0`, guard `!wasJoined` khiến rejoin
    // mất luôn 3 Haste khởi điểm. Bỏ guard theo cùng lý do.
    if (equippedOutfitNameNormalized === "ambitious fixer") {
      joined.haste = (joined.haste ?? 0) + 3;
    }
    joined.hasAmbitiousFixer = equippedOutfitNameNormalized === "ambitious fixer";
    joined.hasThumbSoldato = equippedOutfitNameNormalized === "thumb soldato";
    joined.hasWarpCorpCleaner = equippedOutfitNameNormalized === "warp corp. cleaner";
    joined.hasSevenAssociation = equippedOutfitNameNormalized === "seven association";
    joined.hasLiuAssociation = equippedOutfitNameNormalized === "liu association";
    joined.hasCinqAssociation = equippedOutfitNameNormalized === "cinq association";
    joined.hasDieciAssociation = equippedOutfitNameNormalized === "dieci association";
    // ── 4 MÓN MỚI (Fragaria) ───────────────────────────────────────────────
    // Wanderer's Teatime Clothes — khiên mở màn, 1 LẦN mỗi encounter.
    joined.hasWandererTeatime = equippedOutfitNameNormalized === "wanderer's teatime clothes";
    joined.wandererTeatimeUsed = false;
    // Memories: Compassion — CHỈ tác dụng khi dùng Lucent Historia; điều kiện vũ
    // khí kiểm ở NƠI DÙNG (grantShieldHp/combatantResStr) chứ không kiểm ở đây,
    // vì người chơi có thể đổi vũ khí giữa trận (Dimension Pocket).
    const accNamesNorm = (profileData.equippedAccessories ?? []).filter(Boolean).map(n => n.trim().toLowerCase());
    joined.hasMemoriesCompassion = accNamesNorm.includes("memories: compassion");
    // "+100 Max HP nhưng KHÔNG BAO GIỜ heal lên được ngưỡng 100 thêm này"
    // → cộng vào maxHp để hiển thị/tính %, nhưng chặn trần hồi máu ở
    // `healCapHp` (mọi nguồn heal kẹp theo giá trị này, không phải maxHp).
    // Fragaria làm rõ: *"ví dụ người dùng có 310 HP thì sẽ thành **310/410 HP**
    // trong trận — mục đích chủ yếu là khiến % Max HP của người đó CAO HƠN,
    // tương tác tốt với 1 số thứ, chứ nó chỉ là số máu ẢO không thể heal hay
    // đạt được ngần đó."*
    // → maxHp +100 (để MỌI phép tính theo % Max HP dùng con số mới), currentHp
    //   GIỮ NGUYÊN, và trần HỒI kẹp ở maxHp GỐC qua `healCapHp`.
    //   Dmg vẫn trừ bình thường — 100 máu ảo chỉ chặn HỒI, không chặn MẤT.
    if (joined.hasMemoriesCompassion) {
      joined.healCapHp = joined.maxHp;
      joined.maxHp += 100;
      joined.compassionPhantomHp = 100;
    }
    // Day One of My New Life — hiệu suất tạo khiên theo TẦNG TINH LUYỆN.
    // Tầng lưu ở profile theo tên accessory (`data.accessoryRefine`), mặc định 1.
    if (accNamesNorm.includes("day one of my new life")) {
      // Tầng dùng trong trận = bản CAO NHẤT đang sở hữu. Đọc mảng tầng mới
      // trước, rồi mới tới field số đơn cũ (dữ liệu chưa từng `-refine`).
      const tierArr = profileData.accessoryRefineTiers?.["Day One of My New Life"];
      const tierRaw = Array.isArray(tierArr) && tierArr.length > 0
        ? Math.max(...tierArr)
        : (profileData.accessoryRefine?.["Day One of My New Life"] ?? 1);
      const tier = Math.max(1, Math.min(5, tierRaw));
      joined.dayOneTier = tier;
      joined.shieldEfficiencyPct = 16 + (tier - 1) * 2;
      joined.hasDayOneAura = true;   // -0,1x Res cho đồng đội, KHÔNG stack
    }
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
    // BUG CÙNG LOẠI ĐÃ SỬA (có SẴN từ trước, lộ ra khi truy bug "Perfect Cube
    // không hoạt động"): guard `!wasJoined` ở đây khiến MỌI bonus khởi điểm biến
    // mất khi player `-encounter join` LẠI để đổi trang bị (thao tác HỢP LỆ,
    // được phép trước rollspeed). Lý do: `createCombatant` đầu hàm tạo object
    // MỚI HOÀN TOÀN — currentLight/poise/currentSanity/protection đã reset về
    // mặc định, rồi guard lại chặn không cấp lại. Không hề có nguy cơ "cộng dồn
    // vô hạn" như guard này giả định.
    // → Bỏ guard: đây là "chỉ số KHỞI ĐIỂM khi vào trận", tính lại mỗi lần dựng
    // combatant là đúng ngữ nghĩa.
    const startNotes = [];
    if (hasPerk(joined, "Here We Go Again")) { joined.currentLight = Math.min(joined.maxLight, 3); startNotes.push("+3 Light (Here We Go Again)"); }
    if (hasPerk(joined, "Adrenaline Rush")) { joined.poise = Math.min(POISE_MAX, 10); startNotes.push("+10 Poise (Adrenaline Rush)"); }
    // No Mind To Cure áp Ở CUỐI (sau accessory) — xem comment ở khối accessory.
    if ((equippedOutfitObj?.name ?? "").toLowerCase() === "udjat") {
      joined.protection = Math.min(20, (joined.protection ?? 0) + 10);
      joined.protectionTurnsLeft = 2;
      startNotes.push("+10 Protection (Udjat, hết sau 2 turn)");
    }
    // ── ACCESSORY (Fragaria: "Perfect Cube có hoạt động đâu?") ────────────────
    // startNotes hiện ra trong reply của `-encounter join` — TRƯỚC ĐÂY accessory
    // áp âm thầm không báo gì, nên dù có chạy cũng không ai thấy.
    if (accessoriesLower.includes("perfect cube")) {
      const lightGain = Math.floor((joined.maxLight ?? 0) / 2);
      joined.currentLight = Math.min(joined.maxLight, (joined.currentLight ?? 0) + lightGain);
      joined.currentSanity = Math.min(ENCOUNTER_SANITY_MAX, (joined.currentSanity ?? 0) + 30);
      startNotes.push(`+${lightGain} Light & +30 Sanity (Perfect Cube: Perfect Start + Perfect Mind)`);
    }
    if (accessoriesLower.includes("composition tool")) {
      startNotes.push("Kháng Stagger 2 lần (Composition Tool: Reactive)");
    }
    if (accessoriesLower.includes("giày wan mk3")) {
      startNotes.push("Phòng thủ hoàn 1/4 Sta, cứ 2 lần né thì lần 3 né 2 nhóm hit (Giày Wan MK3)");
    }
    // "No Mind To Cure" — ÁP CUỐI CÙNG, GHI ĐÈ tuyệt đối (xác nhận trực tiếp từ
    // Fragaria: "No Mind To Cure có ưu tiên cao hơn nên sau cùng player sẽ thành
    // -25 sanity thay vì 30 khi encounter start").
    // Nghĩa là perk này THẮNG mọi nguồn cộng Sanity khởi điểm khác — kể cả
    // Perfect Mind (+30) của Perfect Cube. Vì vậy phải chạy SAU accessory, không
    // phải trước (bản trước cho ra -25+30 = 5, SAI).
    if (hasPerk(joined, "No Mind To Cure")) {
      joined.currentSanity = -25;
      startNotes.push("-25 Sanity (No Mind To Cure — ghi đè mọi bonus Sanity khởi điểm)");
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
