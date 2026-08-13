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

// Cap của Shin/Mang (xác nhận trực tiếp từ Fragaria).
// Mang: tối đa Lvl 5 (5 vòng) → 50% Dmg Bonus, +5 Dice Up, +5 Clash Power Up.
// Shin: tối đa Level 50 → Defensive Light cho tối đa -0,5x Res cộng thêm.
const MANG_MAX_LEVEL = 5;
const SHIN_MAX_LEVEL = 50;

module.exports = function ({ isPermanentInjury, hasEgoMechanic, applyMimicSynchronization, applyMimicryForm, MIMICRY_SYNC_FORMS, healHpCapped, withLock, encounterKey, getEncounter, saveEncounter, normalizeEnemyKey, hasPerk, hasShinAccess, getParryClashPenalty, checkStaggerPanic, appendActionLog, ENCOUNTER_SANITY_MAX, r, doPlayerHit, resolveCombatant, WEAPON_DEFENSE_HITS, findItem, getPlayerDataWithSlot, savePlayerData, restoreInjuryMaxHp, applyDeathPenalty, applyEmotionDelta, MINOR_INJURIES }) {

  async function performGuardEvade(channelId, userId, isAdmin, type, enemyKeyRaw = "", attackerKeyRaw = "", hitsRaw = "") {
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
      // Panic chặn hành động Y HỆT Stagger (Fragaria: "tuy panic và -45 sanity
      // nhưng VẪN ACT TIẾP ĐƯỢC… theo logic thì panic sẽ hoạt động như stagger").
      // Khác Stagger ở 2 điểm: KHÔNG giảm Res (xem combatantResStr) và chỉ 1 turn.
      if (combatant.staggered) throw new Error(`${label} đang bị Stagger — không thể hành động.`);
      if (combatant.panic) throw new Error(`${label} đang **PANIC** — không thể hành động (còn ${combatant.panicTurnsLeft ?? 1} turn).`);
      // Sắc lệnh #2/#3 — Guard/Evade qua LỆNH TEXT cũng phải đánh dấu.
      combatant.prescriptBlocked = true;
      combatant.prescriptEvaded = true;
      if (type === "evade" && (combatant.injuries ?? []).includes("Mất Chân")) {
        throw new Error(`${label} đã Mất Chân — không thể Evade được nữa.`);
      }
      // GAP ĐÃ SỬA (xác nhận trực tiếp): "Guard không tùy chọn được guard đòn nào
      // — chỉ có thể guard lần lượt 1 2 3 4 5, trong khi chơi thủ công có thể
      // chọn tùy thích (VD guard đòn 3 và 5)" — quy trình đã thống nhất: player
      // ĐỢI enemyattack declare trước (thấy rõ số hit), rồi gọi guard KÈM
      // `attacker:` (biết hitsPerCharge đúng của enemy đó) + `hits:` (danh sách
      // hit muốn che, 1-based, không cần liên tục). Số charge cần = SỐ HIT chỉ
      // định / hitsPerCharge (làm tròn lên) — GIỮ NGUYÊN ý nghĩa "1 charge = N
      // hit-worth" như cũ, chỉ đổi cách PHÂN BỔ (tùy chọn thay vì tuần tự).
      // MỞ RỘNG (cho luồng reactive defense prompt): "hits:" giờ CŨNG áp dụng cho
      // Evade — dùng để tự động build ĐỦ charge che TOÀN BỘ đòn đang tới trong 1
      // lần bấm, KHÔNG cần chọn hit cụ thể như Guard (Evade luôn che tuần tự từ
      // đầu — guardHitSelections chỉ gán cho type="guard", xem dưới) — chỉ mượn
      // "hits:" để TÍNH ĐÚNG chargesNeeded, không lưu selection gì cho Evade.
      let selectedHits = null;
      let chargesNeeded = 1;
      if ((type === "guard" || type === "evade") && hitsRaw && hitsRaw.trim()) {
        selectedHits = [...new Set(hitsRaw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n >= 1))];
        if (selectedHits.length === 0) throw new Error(`"hits:" không hợp lệ — cần danh sách số nguyên ≥1, cách nhau bằng dấu phẩy (VD: hits: 3,5).`);
        if (!attackerKeyRaw) throw new Error(`Dùng "hits:" cần kèm "attacker: <key enemy đang tấn công>" để tính đúng số charge cần (mỗi loại vũ khí che số hit khác nhau).`);
        const attackerCombatant = resolveCombatant(encounter, normalizeEnemyKey(attackerKeyRaw))?.combatant
          ?? resolveCombatant(encounter, attackerKeyRaw.replace(/[<@!>]/g, ""))?.combatant;
        if (!attackerCombatant) throw new Error(`Không tìm thấy "attacker: ${attackerKeyRaw}" trong encounter.`);
        const hitsPerCharge = WEAPON_DEFENSE_HITS[attackerCombatant.weaponWeight ?? "medium"] ?? 1;
        chargesNeeded = Math.ceil(selectedHits.length / hitsPerCharge);
      }
      let cost = (type === "guard" ? 10 : 20) * chargesNeeded;
      if (type === "evade" && (combatant.injuries ?? []).includes("Gãy chân")) cost *= 2;
      // Iron Horus (Abydos's Uniform - Lazy Style, outfit passive): Guard tốn 40 Sta
      // (thay vì 10 mặc định) — ĐỔI LẠI giảm 100% dmg thay vì 90%/99% (xem
      // guardReductionPct trong khối xử lý damage lúc confirm — check combatant.
      // hasIronHorus ở đó). Set CỨNG 40 (không cộng dồn với Overflowing Guard/khác —
      // outfit override hẳn cơ chế Guard cơ bản, không phải % giảm thêm).
      if (type === "guard" && combatant.hasIronHorus) {
        cost = 40;
        chargesNeeded = 1; // Iron Horus tự che TOÀN BỘ đòn với 1 charge duy nhất — không cần tính theo hitsPerCharge nữa dù có dùng "hits:" hay không.
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
      combatant[chargeField] = (combatant[chargeField] ?? 0) + chargesNeeded;
      // Lưu danh sách hit CỤ THỂ muốn che (nếu dùng "hits:") — QUEUE gộp từ nhiều
      // lần gọi guard khác nhau, tiêu thụ ở confirm handler (index.js) thay vì
      // "che tuần tự từ đầu" như logic cũ. CHỈ áp dụng cho Guard — Evade "hits:"
      // (mở rộng ở trên) chỉ dùng để TÍNH chargesNeeded, KHÔNG có selective
      // targeting (Evade luôn che tuần tự từ đầu theo charge có sẵn).
      if (selectedHits && type === "guard") {
        combatant.guardHitSelections = [...new Set([...(combatant.guardHitSelections ?? []), ...selectedHits])].sort((a, b) => a - b);
      }
      checkStaggerPanic(combatant);
      result = `${type === "guard" ? "🛡️ Guard" : "💨 Evade"}! ${label} -${cost} Stamina${freeFromFleetingSteps ? " (Fleeting Steps — FREE lần này!)" : ""}${overflowingGuardUsed ? " (Overflowing Guard — giảm 1 nửa Sta, -1 Charge)" : ""}${defenseUpStaminaDiscount > 0 ? ` (Defense Up dư — giảm thêm ${defenseUpStaminaDiscount} Sta)` : ""}${selectedHits ? ` (chỉ định che hit: ${selectedHits.join(",")})` : ""} → đang có ${combatant[chargeField]} charge ${type} (1 charge chặn 4 hit M1 Light / 2 hit Medium / 1 hit Heavy của đối phương).`;
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
      // Panic chặn hành động Y HỆT Stagger (Fragaria: "tuy panic và -45 sanity
      // nhưng VẪN ACT TIẾP ĐƯỢC… theo logic thì panic sẽ hoạt động như stagger").
      // Khác Stagger ở 2 điểm: KHÔNG giảm Res (xem combatantResStr) và chỉ 1 turn.
      if (combatant.staggered) throw new Error(`${label} đang bị Stagger — không thể hành động.`);
      if (combatant.panic) throw new Error(`${label} đang **PANIC** — không thể hành động (còn ${combatant.panicTurnsLeft ?? 1} turn).`);
      // ── GATE STAMINA = 0 ─────────────────────────────────────────────────
      // Fragaria: *"do cost parry là 0 nên vài trường hợp có kháng hay MIỄN NHIỄM
      // Stagger thì có thể SPAM PARRY mà không bị chút rủi ro nào."*
      // Đúng: Parry không tốn Stamina, và rủi ro duy nhất của nó là tụt Stamina →
      // Stagger. Ai miễn nhiễm Stagger (Wound-Casing Mask) hoặc đang kháng
      // (Composition Tool "Reactive") thì mất sạch rủi ro ⇒ parry vô hạn.
      // Chặn ở ĐÂY — choke point chung của cả `-encounter parry` lẫn dropdown.
      if ((combatant.currentStamina ?? 0) <= 0) {
        throw new Error(`${label} đã cạn Stamina — **không thể Parry**. Parry không tốn Stamina nhưng vẫn cần còn Stamina để thực hiện.`);
      }
      // Sắc lệnh #2/#3 — đánh dấu ĐÃ PHÒNG THỦ. Đường nút bấm đã set từ lâu,
      // đường LỆNH TEXT thì chưa ⇒ ai dùng lệnh text sẽ luôn trượt sắc lệnh.
      combatant.prescriptParried = true;
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
      // Cùng điều kiện với dropdown Special (encounter-panels.js) — nếu 2 nơi
      // lệch nhau thì nút hiện ra rồi bấm lại báo lỗi.
      if (!hasShinAccess(player)) throw new Error("Bạn chưa sở hữu Shin (GM cấp qua `-unlockskilltree @bạn Shin`).");
      // ❗ Fragaria: "Gate Shin của người dùng và báo với họ là đã kích hoạt Shin
      // rồi — Shin - Rien tự trigger Shin VĨNH VIỄN tới hết Encounter, để họ bấm
      // được nữa chỉ khiến họ phí Sanity vô ích."
      // Chặn ở ĐÂY (nguồn chung của cả lệnh text lẫn dropdown) chứ không chỉ ẩn
      // option — ẩn UI mà không chặn logic thì đường còn lại vẫn tiêu 25 Sanity.
      if (player.shinRienActive) {
        throw new Error("Bạn **đã ở trạng thái Shin** rồi — **Shin - Rien** đã tự kích hoạt và kéo dài **tới hết Encounter**. Bấm thêm chỉ mất 25 Sanity vô ích.");
      }
      if (player.shinMangUsedThisTurn) throw new Error("Đã dùng Shin/Mang trong turn này rồi — chỉ 1 lần/turn.");
      // BUG ĐÃ SỬA (Fragaria làm rõ trực tiếp): "Bạn không thể hi sinh để xài Shin
      // và Mang VƯỢT HƠN mốc cap -10 Sanity" — cap áp lên **KẾT QUẢ SAU KHI TRỪ
      // 25**, KHÔNG phải lên Sanity hiện tại.
      //   • Sanity 0  → 0 - 25 = -25, vượt cap -10 → CHẶN
      //   • Sanity 15 → 15 - 25 = -10, ĐÚNG BẰNG cap → CHO PHÉP ("không vượt qua")
      //   • Sanity 14 → -11 → CHẶN
      // ⇒ Sanity tối thiểu để dùng = cap + 25.
      // TRƯỚC ĐÂY code so `currentSanity <= sanityFloor` — tức chỉ chặn khi ĐANG
      // ở dưới cap, nên Sanity 0 vẫn dùng được và tụt thẳng xuống -25 (vượt cap 15
      // điểm). Sai hẳn hướng.
      // Decimate Mind (Shin, [20 Points]) nới cap xuống **-30** (xác nhận trực
      // tiếp — con số cũ trong code là -35, SAI).
      const SHIN_SANITY_COST = 25;
      const sanityFloorForShin = hasPerk(player, "Decimate Mind") ? -30 : -10;
      const sanityAfter = player.currentSanity - SHIN_SANITY_COST;
      if (sanityAfter < sanityFloorForShin) {
        throw new Error(
          `Không đủ Sanity để hi sinh cho Shin/Mang — cần tối thiểu **${sanityFloorForShin + SHIN_SANITY_COST}** Sanity ` +
          `(hiện tại ${player.currentSanity}; trừ ${SHIN_SANITY_COST} sẽ còn ${sanityAfter}, vượt mốc cap ${sanityFloorForShin}).`
        );
      }
      player.currentSanity = sanityAfter;
      player.shinMangActive = true;
      player.shinMangUsedThisTurn = true;
      // BUG ĐÃ SỬA (Fragaria làm rõ): "shinMangRounds tôi nói KHÔNG phải là số
      // vòng (turn) đã sử dụng Mang, mà là LVL MANG của player — 1 lvl Mang
      // tương ứng 1 vòng tròn sáng".
      // TRƯỚC ĐÂY code CỘNG THÊM 1 mỗi lần kích hoạt (coi như bộ đếm số lần
      // dùng) → dùng 5 turn là tự lên max 5 vòng miễn phí, hoàn toàn sai. Mang
      // Lvl là CHỈ SỐ CỦA PROFILE, chỉ tăng bằng vật phẩm (Fixer's Note); kích
      // hoạt Shin/Mang chỉ BẬT buff theo level ĐANG CÓ, không lên level.
      const mangLevel = Math.min(MANG_MAX_LEVEL, Math.max(1, player.mangLevel ?? 1));
      player.mangLevel = mangLevel;
      player.shinLevel = Math.min(SHIN_MAX_LEVEL, Math.max(1, player.shinLevel ?? 10));
      // GAP ĐÃ SỬA: "Với mỗi 1 vòng Mang thì sẽ gia tăng 10% Dmg Bonus, +1 Dice
      // Up, +1 Clash Power Up" — TRƯỚC ĐÂY chỉ có phần +10% Dmg, hoàn toàn thiếu
      // Dice Up và Clash Power Up.
      // Đặt BẰNG số vòng (không cộng dồn mỗi lần kích hoạt) — đây là giá trị
      // PHÁI SINH từ số vòng Mang, không phải buff cộng thêm; cộng dồn sẽ khiến
      // dùng lại nhiều turn thành +N vô hạn dù số vòng đã chạm cap.
      // Cả 2 đều reset về 0 khi Shin/Mang tắt (turn-advance.js).
      player.diceUp = (player.diceUp ?? 0) - (player.mangDiceUpApplied ?? 0) + mangLevel;
      player.mangDiceUpApplied = mangLevel;
      player.clashPowerUp = mangLevel;
      checkStaggerPanic(player);
      // Defensive Light (Shin, [10 Points]): +0,1x giảm Res CỘNG THÊM (trên nền -0,2x
      // gốc) cho MỖI 10 Shin Level hiện có. shinLevel mặc định = 10 (luật: "Khởi điểm
      // với 10 Shin Lvl") — KHÔNG có cơ chế nào khác cho biết Shin Lvl tăng/giảm theo
      // gì, nên tạm coi là hằng số 10 trừ khi có thêm luật rõ hơn.
      const shinLevel = Math.min(SHIN_MAX_LEVEL, player.shinLevel ?? 10);
      const defensiveLightNote = hasPerk(player, "Defensive Light")
        ? ` Defensive Light: thêm -${(Math.floor(shinLevel / 10) * 0.1).toFixed(1)}x Res (Shin Lvl ${shinLevel}).`
        : "";
      const cappedNote = mangLevel >= MANG_MAX_LEVEL ? ` *(đã ở cap)*` : "";
      result =
        `<:Shin:1528452250861699215> **Shin/Mang kích hoạt!** -25 Sanity (còn ${player.currentSanity}) → Shin: -0,2x mọi Res bản thân.${defensiveLightNote} ` +
        `Mang Lvl ${mangLevel}/${MANG_MAX_LEVEL}${cappedNote}: +${mangLevel * 10}% Dmg, +${mangLevel} Dice Up, +${mangLevel} Clash Power Up, gây True Dmg (M1+skill turn này).`;
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
      if (!player.manifestedEGOUnlock) throw new Error("Nhân vật của bạn chưa unlock Manifest E.G.O (cần GM/admin cấp cờ `ManifestedEGOUnlock` qua `-flag`).");
      if ((player.emotionLevel ?? 0) < 1) throw new Error("Cần đang ở Emotion Level ≥1 mới kích hoạt được Manifest E.G.O.");
      if (!player.manifestedEGO && (player.manifestedEGOCooldownLeft ?? 0) > 0) {
        throw new Error(`Đang trong CD Manifest E.G.O — còn ${player.manifestedEGOCooldownLeft} turn.`);
      }
      player.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, player.currentSanity - 30);
      player.manifestedEGO = true;
      player.manifestedEGOTurnsLeft = player.emotionLevel * 3;
      player.manifestedEGOCooldownLeft = 0;
      // ── PASSIVE RIÊNG THEO TỪNG MANIFESTED E.G.O (ego.js) ─────────────────
      // Bật cờ NGAY ở đây, TRƯỚC checkStaggerPanic bên dưới — nếu -30 Sanity
      // làm người chơi Panic/Stagger ngay lập tức thì luật "bị Stagger trong
      // lúc Manifest ⇒ Shattered E.G.O" phải áp được luôn, chứ không phải bỏ
      // qua chỉ vì cờ chưa kịp bật.
      // ── NỀN CHUNG của MỌI Manifested E.G.O ────────────────────────────────
      // Fragaria đính chính: "+100% riêng của Red Mist và +30% đều là chung, kể
      // cả cái Dice Up nữa — cái cơ bản của Manifested E.G.O là điểm chung của
      // TOÀN BỘ Manifested E.G.O".
      //
      // ⚠️ GAP ĐÃ SỬA (phát hiện khi làm Red Mist): "+3 Dice Up" của Manifest
      // TRƯỚC ĐÂY chỉ là CHỮ ở encounter-display.js — KHÔNG dòng nào cộng nó vào
      // `combatant.diceUp`. Mà `diceUp` CÓ đi vào dice roll thật (combat-utils
      // `computeDiceModifier` đọc nó). Nghĩa là mọi người dùng Manifest E.G.O từ
      // trước tới nay đều THIẾU 3 Dice Up so với luật. Nay áp thật.
      // Comment cũ ở combatant-factory.js ghi "chỉ hiển thị, không tự áp vào roll
      // skill — như mọi nguồn Dice Up khác" là SAI ở vế sau: nguồn Dice Up khác
      // (Augury Kick, Black Suit, Hana...) đều cộng thẳng vào `diceUp`.
      player.diceUp = (player.diceUp ?? 0) + 3;
      let egoPassiveNote = "";
      if (hasEgoMechanic(player, "redmist_the_strongest")) {
        player.theStrongestActive = true;
        // +100 Max Stamina — cộng cả maxStamina LẪN currentStamina (nếu chỉ
        // cộng trần thì "nhận 100 Max Stamina" chẳng cho người chơi thêm gì
        // dùng được ngay trong turn này). Lưu lại đúng phần đã cộng để
        // endManifestedEgoState trả về chính xác.
        player.theStrongestMaxStaminaBonus = 100;
        player.maxStamina = (player.maxStamina ?? 0) + 100;
        player.currentStamina = (player.currentStamina ?? 0) + 100;
        // Dice Up / Haste: `diceUp` và `haste` đều bị RESET VỀ 0 mỗi turn ở
        // advanceCombatantTurn ⇒ cấp một lần ở đây là mất ngay turn sau. Nên
        // turn-advance.js cộng LẠI mỗi turn khi còn `theStrongestActive`
        // (cùng khuôn với blackSuitPersistentBonus). Ở đây cấp cho TURN NÀY.
        player.diceUp = (player.diceUp ?? 0) + 10;
        player.haste = Math.min(20, (player.haste ?? 0) + 4);
        egoPassiveNote += ` 🔥**The Strongest** — Max Dice chắc chắn, +100% Dmg (tổng **130%** với nền Manifest), +10 Dice Up (tổng **13**), +4 Haste, +100 Max Stamina, 50% Dmg Reduction.`;
      }
      if (hasEgoMechanic(player, "redmist_the_mimic")) {
        egoPassiveNote += applyMimicSynchronization(player);
      }
      checkStaggerPanic(player);
      let healNote = "";
      if (!player.firstManifestEGOUsed && hasPerk(player, "Comeback Time")) {
        const healAmt = Math.round(player.maxHp * 0.25 * 100) / 100;
        healHpCapped(player, healAmt); // tôn trọng healCapHp (Memories: Compassion)
        healNote = ` 🩹+${healAmt} HP (Comeback Time — lần đầu Manifest E.G.O)`;
      }
      player.firstManifestEGOUsed = true;
      result =
        `😈 **Manifest E.G.O!** -30 Sanity (còn ${player.currentSanity}) → Duration ${player.manifestedEGOTurnsLeft} turn ` +
        `(theo Emotion Level ${player.emotionLevel}) — +3 Dice Up, +30% Dmg M1+skill.${healNote}${egoPassiveNote}` +
        // Bị Stagger NGAY lúc kích hoạt (do -30 Sanity) — checkStaggerPanic ở
        // trên đã tự tắt Manifest + gắn Shattered, phải báo cho người chơi biết
        // thay vì để họ tưởng vẫn đang Manifest.
        (player.staggerForcedNote ? `\n${player.staggerForcedNote}` : "");
      player.staggerForcedNote = null;
      appendActionLog(encounter, result);
      await saveEncounter(channelId, encounter);
    });
    return result;
  }

  /** performMimicryForm — đổi dạng Kiếm ⇄ Lưỡi hái của Mimicry: Synchronization.
   *
   *  Fragaria chốt: *"Họ sẽ có 1 nút ở Special để chuyển dạng lưỡi hái hay kiếm
   *  trong turn tùy ý thích"* ⇒ KHÔNG giới hạn số lần/turn, KHÔNG tốn Light,
   *  KHÔNG tốn hành động. Đây là lựa chọn dạng vũ khí, không phải một đòn đánh.
   *
   *  ⚠️ KHÔNG kiểm lượt (isCurrentTurnHolder): đổi dạng phải làm được cả lúc
   *  đang bị đánh, vì Base Dmg của dạng ảnh hưởng tới Parry counter-dmg và
   *  WEAPON_DEFENSE_HITS (số hit mỗi nhóm phòng thủ).
   */
  async function performMimicryForm(channelId, userId, wantForm = null) {
    let result;
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Channel này chưa có encounter nào.");
      const player = encounter.players[userId];
      if (!player) throw new Error("Bạn chưa tham gia encounter này.");
      if (!player.mimicSyncActive) {
        throw new Error("Bạn không ở dạng **Mimicry: Synchronization** — cần đang bật Manifest E.G.O và cầm Mimicry Blade.");
      }
      const next = wantForm ?? (player.mimicryForm === "scythe" ? "sword" : "scythe");
      if (!MIMICRY_SYNC_FORMS[next]) throw new Error(`Dạng "${next}" không hợp lệ.`);
      const f = applyMimicryForm(player, next);
      result = `🗡️ **Mimicry: Synchronization** → dạng **${f.label}** (${f.baseDamage} Base Dmg · ${f.type} · ${f.weight})` +
        (next === "scythe" ? ` — Dmg Bonus của **The Imitation** ×2.` : `.`);
      appendActionLog(encounter, result);
      await saveEncounter(channelId, encounter);
    });
    return result;
  }

  /** performUseItem — logic CHUNG cho -encounter useitem VÀ dropdown "Items" mới
   *  (encounter-panels.js) — TÁCH NGUYÊN VĂN từ message-create-handler.js (không
   *  đổi hành vi), chỉ đổi tham số messageAuthorId → userId và trả về result
   *  string thay vì message.reply trực tiếp. */
  /** applyFixersNote — "Fixer's Note" (Fragaria yêu cầu trực tiếp): "cho khả năng
   *  mở khoá Shin, tăng 10 lvl shin và 1 vòng mang nếu đã mở khoá".
   *  Lần đầu (chưa mở khoá) → BẬT ShinUnlock, giữ nguyên mốc khởi điểm 10 Lvl /
   *  1 vòng. Các lần sau → +10 Shin Lvl và +1 Mang Lvl, kẹp trong cap 50/5.
   *  Ghi vào PROFILE (không phải combatant) vì đây là chỉ số vĩnh viễn.
   *  @returns chuỗi mô tả kết quả để caller hiển thị. */
  function applyFixersNote(data) {
    data.ShinLevel = data.ShinLevel ?? 10;
    data.MangLevel = data.MangLevel ?? 1;
    if (!data.ShinUnlock) {
      data.ShinUnlock = true;
      return `<:Shin:1528452250861699215> **Fixer's Note** — đã MỞ KHOÁ Shin! Khởi điểm Shin Lvl ${data.ShinLevel}, Mang Lvl ${data.MangLevel}.`;
    }
    const beforeShin = data.ShinLevel, beforeMang = data.MangLevel;
    data.ShinLevel = Math.min(SHIN_MAX_LEVEL, beforeShin + 10);
    data.MangLevel = Math.min(MANG_MAX_LEVEL, beforeMang + 1);
    const parts = [];
    if (data.ShinLevel > beforeShin) parts.push(`Shin Lvl ${beforeShin} → **${data.ShinLevel}**`);
    else parts.push(`Shin Lvl đã ở cap ${SHIN_MAX_LEVEL}`);
    if (data.MangLevel > beforeMang) parts.push(`Mang Lvl ${beforeMang} → **${data.MangLevel}**`);
    else parts.push(`Mang Lvl đã ở cap ${MANG_MAX_LEVEL}`);
    return `<:Shin:1528452250861699215> **Fixer's Note** — ${parts.join(", ")}.`;
  }

  async function performUseItem(channelId, userId, itemNameRaw) {
    let result;
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Channel này chưa có encounter nào.");
      const player = encounter.players[userId];
      if (!player) throw new Error("Bạn chưa tham gia encounter này.");
      if (player.usedItemThisTurn) throw new Error("Đã dùng 1 item trong turn này rồi — chỉ được dùng 1 lần/turn.");
      const itemName = findItem(itemNameRaw) ?? itemNameRaw;
      const idx = (player.consumablesLoadout ?? []).findIndex(n => n.toLowerCase() === itemName.toLowerCase());
      if (idx === -1) throw new Error(`"${itemNameRaw}" không có trong số item đã mang vào trận — dùng \`-encounter additem\` trước (xem hiện tại bằng \`-encounter status\`).`);
      const actualName = player.consumablesLoadout[idx];
      const isKCorpAmpule = actualName.toLowerCase() === "k-corp ampule";
      const isChuoi = actualName.toLowerCase() === "chuối";
      const isTao = actualName.toLowerCase() === "táo";
      const isDuaHau = actualName.toLowerCase() === "dưa hấu";
      const isMedkit = actualName.toLowerCase() === "medkit";
      if (isKCorpAmpule && (player.kCorpAmpuleCooldownLeft ?? 0) > 0) {
        throw new Error(`K-Corp Ampule đang trong CD — còn ${player.kCorpAmpuleCooldownLeft} turn nữa mới dùng lại được.`);
      }
      const { data: profileData, slot } = await getPlayerDataWithSlot(userId);
      const owned = profileData.items?.[actualName] ?? 0;
      if (owned < 1) throw new Error(`Inventory không còn **${actualName}** để dùng (đã bị tiêu/mất từ trước).`);
      profileData.items[actualName] = owned - 1;
      if (profileData.items[actualName] <= 0) delete profileData.items[actualName];
      await savePlayerData(userId, profileData, slot);
      player.consumablesLoadout.splice(idx, 1);
      player.usedItemThisTurn = true;
      let effectNote = "";
      if (isKCorpAmpule) {
        player.kCorpAmpuleUsesThisEncounter = (player.kCorpAmpuleUsesThisEncounter ?? 0) + 1;
        player.kCorpAmpuleCooldownLeft = 2;
        if (player.kCorpAmpuleUsesThisEncounter >= 2) {
          const wasAliveBeforeKCorp = player.currentHp > 0;
          player.currentHp = 0;
          if (wasAliveBeforeKCorp) {
            for (const otherPid of Object.keys(encounter.players)) {
              if (otherPid === userId) continue;
              applyEmotionDelta(encounter.players[otherPid], 5);
            }
            const deathNote = await applyDeathPenalty(encounter, userId);
            effectNote = ` ☠️ **DÙNG LẦN 2 TRONG CÙNG ENCOUNTER — CHẾT NGAY LẬP TỨC!**${deathNote}`;
          }
        } else {
          // ❗ Sizzling Wound là chấn thương VĨNH VIỄN — K-Corp Ampule KHÔNG chữa
          // được (Fragaria: "không bao giờ chữa được bằng bất kỳ hình thức nào kể
          // cả K-Corp Ampule; chỉ có GM gõ lệnh mới chữa được"). Trước đây câu
          // `injuries = []` quét sạch không chừa gì.
          const keptPermanent = (player.injuries ?? []).filter(isPermanentInjury);
          for (const inj of player.injuries ?? []) { if (!isPermanentInjury(inj)) restoreInjuryMaxHp(player, inj); }
          player.injuries = keptPermanent;
          player.currentHp = player.maxHp;
          try {
            const { data: injSyncData, slot: injSyncSlot } = await getPlayerDataWithSlot(userId);
            injSyncData.injuries = (injSyncData.injuries ?? []).filter(isPermanentInjury);
            await savePlayerData(userId, injSyncData, injSyncSlot);
          } catch { /* không chặn action chính nếu sync lỗi */ }
          effectNote = ` 💊 Hồi ĐẦY HP (${player.currentHp}/${player.maxHp}) + Chữa TOÀN BỘ injury!`
            + (keptPermanent.length ? ` *(${keptPermanent.join(", ")} là vĩnh viễn — không chữa được)*` : "")
            + ` (CD 2 turn — dùng lần 2 trong trận này sẽ CHẾT NGAY.)`;
        }
      } else if (isChuoi) {
        const before = player.currentHp;
        healHpCapped(player, 10);
        effectNote = ` 🍌 +${(player.currentHp - before).toFixed(0)} HP (${player.currentHp}/${player.maxHp}).`;
      } else if (isTao) {
        player.appleDmgReductionActive = true;
        effectNote = ` 🍎 Giảm 1 Dmg/hit phải nhận tới hết turn này.`;
      } else if (isDuaHau) {
        const before = player.currentStamina;
        player.currentStamina = Math.min(player.maxStamina, player.currentStamina + 20);
        effectNote = ` 🍉 +${(player.currentStamina - before).toFixed(0)} Stamina (${player.currentStamina}/${player.maxStamina}).`;
      } else if (isMedkit) {
        const before = [...(player.injuries ?? [])];
        // (Medkit vốn chỉ đụng MINOR_INJURIES nên Sizzling Wound đã nằm ngoài,
        // nhưng lọc tường minh để sau này thêm tên vào MINOR_INJURIES cũng không lọt.)
        const healedMinor = before.filter(inj => !isPermanentInjury(inj) && MINOR_INJURIES.some(m => inj.startsWith(m)));
        if (healedMinor.length === 0) {
          effectNote = ` 🩹 Không có chấn thương nhẹ nào để chữa (Medkit KHÔNG chữa được chấn thương nặng).`;
        } else {
          player.injuries = before.filter(inj => !healedMinor.includes(inj));
          for (const inj of healedMinor) restoreInjuryMaxHp(player, inj);
          try {
            const { data: injSyncData, slot: injSyncSlot } = await getPlayerDataWithSlot(userId);
            injSyncData.injuries = [...player.injuries];
            await savePlayerData(userId, injSyncData, injSyncSlot);
          } catch { /* không chặn action chính nếu sync lỗi */ }
          effectNote = ` 🩹 Đã chữa ${healedMinor.length} chấn thương nhẹ: ${healedMinor.join(", ")}. (Chấn thương nặng KHÔNG được chữa bởi Medkit.)`;
        }
      }
      const isKnownItemWithEffect = isKCorpAmpule || isChuoi || isTao || isDuaHau || isMedkit;
      result = `🧪 đã dùng **${actualName}**!${effectNote}${!isKnownItemWithEffect ? " (Trừ khỏi inventory — hiệu ứng hồi phục cụ thể do GM tự xác định/narrate, hệ thống chỉ enforce giới hạn mang/dùng.)" : ""}`;
      appendActionLog(encounter, `🧪 <@${userId}> dùng **${actualName}**.${effectNote}`);
      await saveEncounter(channelId, encounter);
    });
    return result;
  }
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
    // Dmg + bonus% theo mangLevel hiện có) — kể cả khi CHƯA tự kích hoạt Shin/
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
    return {
    followupEmbed, hitEmbed };
  }

  return {
    applyFixersNote,
    performGuardEvade,
    performParry,
    performShinMang,
    performManifestEgo,
    performMimicryForm,
    performOvercharge,
    performFollowUp,
    performUseItem,
  };
};
