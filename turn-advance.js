// turn-advance.js
// Hàm advanceCombatantTurn (toàn bộ logic decay status mỗi cuối turn — Burn/
// Bleed/Stagger/Panic/Emotion Level/Manifest E.G.O/50-Status Nhóm 1/Iron Horus...)
// — tách khỏi index.js theo yêu cầu trực tiếp: "tiếp tục tách đi". Dù RẤT DÀI
// (144 dòng), về mặt DEPENDENCY lại hoàn toàn đơn giản — chỉ đọc/ghi trực tiếp
// combatant object, không gọi bất kỳ hàm phức tạp nào khác (không Redis, không
// computeAttackerPerkContext).
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ applyEmotionDelta, KARMIC_MAX, FURIOSO_KARMIC_COST, SIZZLING_WOUND_BURN_BLEED_MUL, POISE_MAX, SINGLETON_UNLOCK_PROTECTION, applySanityGain, syncCompassionPhantomHp, healHpCapped, applyHpLoss, endManifestedEgoState, hasPerk, ENCOUNTER_STAMINA_REGEN_PER_TURN, EMOTION_LEVEL_COOLDOWN_TURNS }) {

  function advanceCombatantTurn(combatant) {
    // LƯỚI AN TOÀN — Memories: Compassion chỉ hiệu lực khi CẦM Lucent Historia
    // (Fragaria: "nếu họ đổi qua cái khác mà nó hoạt động thì đã sai về logic").
    // Đặt ở đây vì advanceCombatantTurn chạy cho MỌI combatant mỗi vòng turn ⇒
    // bắt được mọi đường đổi vũ khí, kể cả đường thêm mới sau này mà quên gọi sync.
    const compassionNote = syncCompassionPhantomHp ? syncCompassionPhantomHp(combatant) : "";
    // Ghi vào FIELD chứ không push vào `notes`: biến đó khai ở DƯỚI trong hàm
    // này (đọc từ đây là ReferenceError — đúng lớp lỗi scope đã dính nhiều lần).
    combatant.compassionSyncNote = compassionNote || null;

    combatant.currentSpeed = null; // phải roll lại mỗi turn mới (xem -encounter rollspeed)
    // "Blade Lineage Salsu" (outfit) — GAP MỚI (xác nhận trực tiếp): "Vào turn
    // start nếu Poise >=10, add vào base dmg của page/critical theo 1/2 lượng
    // Poise" — lưu tạm để áp dụng cho lần dùng skill/Critical TIẾP THEO trong
    // turn này (xem attacker-perk-context.js — CHỈ áp khi isM1=false).
    if (combatant.equippedOutfit === "Blade Lineage Salsu" && (combatant.poise ?? 0) >= 10) {
      combatant.blSalsuBonusDmgPending = Math.floor(combatant.poise / 2);
    }
    // "Waltz In Black" (Page): "Nếu turn trước địch dính Waltz In White: skill
    // này thành 3x Dice Multiplier và Unevadeable" — xác nhận trực tiếp: "turn
    // trước" = 1 VÒNG turnOrder trước (round-based, không phải lượt riêng của
    // ai), và điều kiện track trên TARGET (kẻ ĐÃ BỊ đánh) — bất kỳ ai dùng Waltz
    // In Black sau đó đều được hưởng, không chỉ người đã dùng Waltz In White.
    // advanceCombatantTurn chạy cho MỌI combatant mỗi khi round mới bắt đầu
    // (performEndTurn) — đúng thời điểm để "gạt" cờ round trước/round này.
    combatant.waltzInWhiteHitLastRound = combatant.waltzInWhiteHitThisRound ?? false;
    combatant.waltzInWhiteHitThisRound = false;
    // Burn — gây dmg = count×2 lúc CUỐI turn, SAU ĐÓ mới giảm nửa (đúng thứ tự luật:
    // "gây dmg... sau đó giảm nó đi 1 nửa"). Bleed dmg = count/4 mỗi khi CHÍNH kẻ
    // mang Bleed hành động tấn công — xử lý ở CONFIRM HANDLER (mỗi lần attacker thực
    // hiện attack/hit/enemyattack), KHÔNG ở đây — chỉ giảm nửa COUNT của Bleed ở đây.
    if ((combatant.burn ?? 0) > 0) {
      // Sizzling Wound (50-Status Nhóm 2, xác nhận trực tiếp): "+50% Dmg từ Burn
      // và Bleed" — nhân trực tiếp vào dmg Burn thật gây ra.
      // ── DAWN OFFICE: giảm một nửa Dmg từ Burn (Fragaria 14/08) ────────────
      // Yuna: khi dưới **75%** HP. Salvador: khi dưới **50%** HP.
      // KHÔNG stack (mặc một outfit tại một thời điểm), nhưng viết dạng cờ chung
      // để sau này thêm nguồn khác không phải sửa công thức.
      const hpPct = (combatant.currentHp ?? 0) / Math.max(1, combatant.maxHp ?? 1);
      const dawnBurnHalf = (combatant.hasDawnYuna && hpPct < 0.75)
        || (combatant.hasDawnSalvador && hpPct < 0.5);
      const burnDmg = (dawnBurnHalf ? 0.5 : 1) * combatant.burn * 2 * (combatant.sizzlingWound ? 1.5 : 1) * (combatant.burningSensation ? 3 : 1);
      // ⚠️ KHÔNG nhân 1.5 lần nữa ở đây — `burnDmg` NGAY TRÊN đã có
      // `(combatant.sizzlingWound ? 1.5 : 1)`. Sizzling Wound vốn ĐÃ tồn tại
      // trong repo (cờ `sizzlingWound`, nối sẵn ở turn-advance + 2 chỗ Bleed +
      // encounter-display). Thêm cờ thứ hai sẽ thành nhân đôi ×2.25.
      applyHpLoss(combatant, burnDmg, { countHana: false, source: "burn" });
    }
    combatant.burn = Math.floor((combatant.burn ?? 0) / 2);
    combatant.bleed = Math.floor((combatant.bleed ?? 0) / 2);
    // Haou Flame (xác nhận trực tiếp): "Gây x10 Dmg... vào end turn sau đó /2,
    // nếu đạt về 0,5 thì kết thúc" — CÙNG cấu trúc Burn (dmg TRƯỚC, decay SAU),
    // chỉ khác hệ số (x10 thay vì x2) và field riêng (max 99, không chung "burn").
    if ((combatant.haouFlame ?? 0) > 0) {
      applyHpLoss(combatant, combatant.haouFlame * 10, { countHana: false });
    }
    combatant.haouFlame = Math.floor((combatant.haouFlame ?? 0) / 2);
    // Haou Bleed (xác nhận trực tiếp): dmg tự gây mỗi hành động xử lý riêng ở
    // COMMIT HANDLER (index.js, cùng chỗ với Bleed thường) — ở đây chỉ /2 count
    // mỗi end turn, giống hệt Bleed thường.
    combatant.haouBleed = Math.floor((combatant.haouBleed ?? 0) / 2);
    // Haou Sinking (xác nhận trực tiếp): "mất sạch count khi end turn" — KHÁC
    // Haou Bleed/Flame (chỉ /2), Sinking mất HOÀN TOÀN mỗi turn.
    combatant.haouSinking = 0;
    // Hemorrhage (xác nhận trực tiếp): "reset sau 1 turn KHÔNG áp Bleed" — nếu
    // turn này KHÔNG có Bleed mới được áp (hemorrhageAppliedThisTurn vẫn false),
    // reset hẳn về 0. Luôn reset flag về false cho turn tiếp theo (dù có hay
    // không), để turn kế tiếp phải tự áp Bleed mới lại từ đầu mới giữ được stack.
    // Luật reset (Fragaria đưa nguyên văn): "reset sau 1 turn KHÔNG áp Bleed,
    // HOẶC khi 5 điểm Hemorrhage tồn tại trong 1 turn".
    // Vế 2 TRƯỚC ĐÂY thiếu hẳn — Hemorrhage 5 stack cứ thế đứng mãi.
    if ((combatant.hemorrhage ?? 0) >= 5) {
      if (combatant.hemorrhageMaxHeldTurn) {
        combatant.hemorrhage = 0;
        combatant.hemorrhageMaxHeldTurn = false;
      } else {
        // Turn ĐẦU chạm 5 — chưa reset, phải "tồn tại trong 1 turn" đã.
        combatant.hemorrhageMaxHeldTurn = true;
      }
    } else {
      combatant.hemorrhageMaxHeldTurn = false;
    }
    if (!combatant.hemorrhageAppliedThisTurn) {
      combatant.hemorrhage = 0;
      combatant.hemorrhageMaxHeldTurn = false;
    }
    combatant.hemorrhageAppliedThisTurn = false;
    // Busy as Tribbie: "Một turn chỉ kích một lần" — reset cho turn mới.
    combatant.busyAsTribbieTriggeredThisTurn = false;
    // Time Moratorium (xác nhận trực tiếp): "sau 3 turn gây (dmg tích lại) x
    // (Tremor/2)%" — đếm ngược, khi hết hạn thì "nổ" 1 lần rồi tắt hẳn status
    // (accumulated reset về 0, không còn chặn dmg nữa cho tới khi được gắn lại).
    if (combatant.timeMoratorium && combatant.timeMoratoriumTurnsLeft > 0) {
      combatant.timeMoratoriumTurnsLeft -= 1;
      if (combatant.timeMoratoriumTurnsLeft <= 0) {
        const explosionDmg = combatant.timeMoratoriumAccumulated * ((combatant.tremor ?? 0) / 2) / 100;
        applyHpLoss(combatant, explosionDmg, { countHana: false });
        combatant.timeMoratorium = false;
        combatant.timeMoratoriumAccumulated = 0;
      }
    }
    if (combatant.staggered) {
      combatant.staggerTurnsLeft -= 1;
      if (combatant.staggerTurnsLeft <= 0) {
        combatant.staggered = false;
        // ❗ Fragaria: "Stamina được hồi đột ngột khi MIỄN NHIỄM Stagger — nên gate:
        // dù Stamina có về 0 đi nữa cũng chỉ hồi 30 Sta mỗi turn chứ không hồi full.
        // Logic đúng là CHỈ KHI BỊ STAGGER thì hết Stagger mới hồi lại full."
        if (combatant.hasWoundCasingMask && !combatant.staggered) {
          combatant.currentStamina = Math.min(combatant.maxStamina,
            (combatant.currentStamina ?? 0) + (ENCOUNTER_STAMINA_REGEN_PER_TURN ?? 30));
        } else combatant.currentStamina = combatant.maxStamina; // hồi đầy sau khi hết Stagger
        // Choáng — cleanse: SAU KHI 1 lần Stagger 2-turn (lastStaggerWas2Turn, set
        // ĐÚNG lúc trigger lần này — xem checkStaggerPanic) ĐÃ THỰC SỰ KẾT THÚC,
        // dazedStacks reset về 0, bắt đầu đếm lại từ đầu cho chu kỳ Stagger tiếp theo
        // (1, 1, 2-cleanse, lặp lại) — xác nhận trực tiếp từ GM.
        if (combatant.lastStaggerWas2Turn) {
          combatant.dazedStacks = 0;
        }
      }
      // Đang stagger thì KHÔNG hồi 30 Stamina thường — turn này coi như "không hành
      // động được", hồi đầy 1 LẦN lúc hết stagger (đã xử lý ở trên).
    } else {
      // `staminaRegenPerTurn` — trần hồi RIÊNG của combatant, ghi đè hằng chung.
      // Fragaria: Nothing There "Stamina không hồi mỗi turn mà chỉ 1 điểm cố
      // định" ⇒ khai 1 ở quest-data.js. Combatant KHÔNG khai giữ nguyên như cũ.
      // Nhánh "hồi FULL sau khi hết Stagger" nằm ở trên và áp cho MỌI combatant
      // nên không phải làm gì thêm — đúng luật Fragaria mô tả.
      const regenPerTurn = combatant.staminaRegenPerTurn ?? ENCOUNTER_STAMINA_REGEN_PER_TURN;
      // Nothing There (và mọi mob khai `noStaminaRegen`) KHÔNG hồi Stamina mỗi turn.
      if (!combatant.noStaminaRegen) combatant.currentStamina = Math.min(combatant.maxStamina, combatant.currentStamina + regenPerTurn);
      // "Airborne" (GAP ĐÃ SỬA — Fragaria: "Airborne cũng chưa được implement"):
      // "kẻ địch bị hất tung nhận 10 Dmg vào End Turn. Biến mất sau End Turn
      // hoặc sau bị dính đòn có condition Airborne".
      // Dmg 10 là CỐ ĐỊNH, KHÔNG qua resistance/DR (luật ghi thẳng "nhận 10
      // Dmg", không nói giảm trừ gì) — đây là dmg do rơi xuống đất, không phải
      // đòn đánh. Áp TRƯỚC Perfect Body để "hồi 10 HP" không che mất sát thương.
      if (combatant.airborne) {
        combatant.currentHp = Math.max(0, (combatant.currentHp ?? 0) - 10);
        combatant.airborne = false;
        combatant.airborneEndTurnDmgApplied = 10; // caller đọc để ghi log/thông báo
      } else {
        combatant.airborneEndTurnDmgApplied = 0;
      }
      // "Perfect Body" (Perfect Cube) — GAP ĐÃ SỬA: "Mỗi turn end được hồi 10 HP".
      // Chỉ hồi cho người CÒN SỐNG (0 HP là đã gục — hồi sẽ tự hồi sinh, sai luật).
      if (combatant.hasPerfectCube && combatant.currentHp > 0) {
        // healHpCapped — không hồi vào 100 máu ẢO của "Memories: Compassion".
        healHpCapped(combatant, 10);
      }
    }
    // Haou Tremor (xác nhận trực tiếp): "Khi end turn sẽ tự động kích Tremor
    // Burst trên người kẻ địch [chính mình], ứng với mỗi 1 stack thì giảm kẻ địch
    // 15 Stamina, sau end turn sẽ tiêu thụ hết stack" — tự trừ Sta trực tiếp
    // (không qua calcMathCore vì không phải từ 1 hit cụ thể nào), tiêu TOÀN BỘ
    // stack ngay sau đó (KHÁC Tremor thường vốn chỉ /2). BUG THẬT ĐÃ SỬA (phát
    // hiện qua test thật): đặt SAU regen/stagger (không phải TRƯỚC như bản đầu) —
    // nếu đặt trước, +30 Sta regen chạy SAU sẽ "bù lại" một phần khoản đã trừ
    // (VD 3 stack đáng lẽ -45 nhưng vì regen bù nên chỉ còn -15 thực tế).
    if ((combatant.haouTremor ?? 0) > 0) {
      combatant.currentStamina = Math.max(0, combatant.currentStamina - combatant.haouTremor * 15);
      combatant.haouTremor = 0;
    }
    // Spectro Frazzle (xác nhận trực tiếp): "giảm khi hồi lại Stamina" — áp dụng
    // NGAY SAU khi Stamina vừa hồi (bất kể từ nhánh regen thường hay hồi đầy sau
    // Stagger ở trên) — trừ tiếp từ pending "nợ" (đã nhân đôi từ lúc gán stack).
    if ((combatant.spectroFrazzlePendingLoss ?? 0) > 0 && combatant.currentStamina > 0) {
      const applied = Math.min(combatant.currentStamina, combatant.spectroFrazzlePendingLoss);
      combatant.currentStamina -= applied;
      combatant.spectroFrazzlePendingLoss -= applied;
    }
    if (combatant.panic) {
      combatant.panicTurnsLeft -= 1;
      if (combatant.panicTurnsLeft <= 0) {
        combatant.panic = false;
        combatant.currentSanity = 0; // reset Sanity về 0 sau khi hết Panic
      }
    }
    // BUG ĐÃ SỬA (xác nhận trực tiếp: "cứ đánh đủ 20 Stamina sẽ được 1 Light...
    // đánh 40 stamina = 2 light, 60 = 3, 80 = 4, 100 = 5. Chứ không phải giới hạn
    // 1 light") — trước đây CHỈ cộng +1 CỐ ĐỊNH nếu đạt ngưỡng ≥20, KHÔNG scale
    // theo số Stamina thật đã dùng — SAI, đúng phải là floor(staminaUsed/20).
    if (combatant.staminaUsedThisTurn >= 20) {
      const lightGained = Math.floor(combatant.staminaUsedThisTurn / 20);
      combatant.currentLight = Math.min(combatant.maxLight, combatant.currentLight + lightGained);
    }
    // Light Dash perk (mở khóa từ Skill Tree) — +2 Light mỗi turn start, CỘNG THÊM
    // (không thay thế) cơ chế +1 Light từ staminaUsedThisTurn>=20 phía trên.
    if (hasPerk(combatant, "Light Dash")) {
      combatant.currentLight = Math.min(combatant.maxLight, combatant.currentLight + 2);
    }
    combatant.staminaUsedThisTurn = 0;
    // "Guard/Evade charge dư qua turn" — GAP ĐÃ SỬA (xác nhận trực tiếp): "nếu
    // charge dư nhưng không bị tấn công thì sẽ bị mất sau khi end turn" —
    // TRƯỚC ĐÂY chỉ hasIronHorus mới được reset (xem chỗ khác trong file này),
    // combatant thường KHÔNG BAO GIỜ mất charge Guard/Evade dư (chỉ trừ khi
    // dùng hết qua bị tấn công) — giờ reset về 0 mỗi khi hết turn của CHÍNH
    // combatant đó, bất kể có Iron Horus hay không.
    combatant.guardCharges = 0;
    combatant.evadeCharges = 0;
    // eyeOfHorusAmmo — GAP ĐÃ SỬA (xác nhận trực tiếp): "khi về 0 thì không thể
    // M1 trong turn đó nữa mà phải đợi hết turn thì số ammo sẽ reset về 8" —
    // reset về full (8) mỗi khi hết turn CỦA CHÍNH combatant này (không liên
    // quan gì tới ammo/frostAmmo/incendiaryAmmo reload từ inventory).
    // eyeOfHorusAmmo — BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận trực tiếp): "bạn hiểu
    // sai về nội tại ammo rồi; nội tại ammo của nó là khi về 0 thì khi hết 1
    // turn mới reset chứ không phải là cứ qua turn là reset về 8" — VD: Turn 1
    // hết ammo còn 0 → Turn 2 VẪN 0 (tốn nguyên 1 turn để nạp đạn) → Turn 3 mới
    // đầy lại. TRƯỚC ĐÂY reset về 8 VÔ ĐIỀU KIỆN mỗi turn-end (SAI hoàn toàn —
    // biến ammo thành "luôn đầy mỗi turn", không có giá phải trả khi hết sạch).
    // Giờ: nếu ammo ĐANG = 0 và CHƯA đánh dấu "đang nạp" (eyeOfHorusReloadPending
    // false) → đây là lần hết turn ĐẦU TIÊN kể từ lúc về 0 → đánh dấu đang nạp,
    // GIỮ NGUYÊN 0 (không reset). Nếu ĐÃ đang nạp (true, tức đã "chịu" 1 turn ở
    // mức 0 rồi) → nạp xong, reset về 8, tắt cờ. Nếu ammo KHÔNG phải 0 → reset về
    // 8 bình thường như thiết kế gốc (không có gì phải "trả giá").
    // eyeOfHorusAmmo — BUG NGHIÊM TRỌNG ĐÃ SỬA LẦN 2 (xác nhận trực tiếp): "qua
    // turn cũng không nạp lại đạn nữa, chỉ khi hết đạn mới tốn 1 turn để nạp" —
    // TRƯỚC ĐÂY vẫn còn nhánh "không phải 0 thì reset về 8 mỗi turn" — SAI, vì
    // ammo phải TỒN TẠI XUYÊN SUỐT nhiều turn (không tự đầy lại nếu chưa dùng
    // hết) — CHỈ reset về 8 khi ĐÃ về đúng 0 và đã "chịu" đủ 1 turn chờ nạp. Nếu
    // ammo > 0, KHÔNG làm gì cả — giữ nguyên y hệt giá trị hiện tại sang turn sau.
    if (combatant.eyeOfHorusAmmo === 0) {
      if (combatant.eyeOfHorusReloadPending) {
        combatant.eyeOfHorusAmmo = 8;
        combatant.eyeOfHorusReloadPending = false;
      } else {
        combatant.eyeOfHorusReloadPending = true;
      }
    }
    // ironHorusGuardActiveThisTurn — GAP ĐÃ SỬA (xác nhận trực tiếp) — reset về
    // false mỗi khi hết turn CỦA CHÍNH combatant này, giống các "ThisTurn" flag
    // khác — turn kế tiếp cần bấm Guard lại 1 lần để kích hoạt lại.
    combatant.ironHorusGuardActiveThisTurn = false;
    // paybackUsedThisTurn — GAP ĐÃ SỬA (dự án tự động hoá, batch 3) — reset mỗi
    // khi hết turn CỦA CHÍNH combatant này (không phải hết vòng turnOrder).
    combatant.paybackUsedThisTurn = false;
    // eyeOfHorusTargetHitCounts — GAP ĐÃ SỬA HOÀN TOÀN LẦN THỨ 3 — reset mỗi
    // khi hết turn CỦA CHÍNH combatant này, "Foreclosure Task Force President"
    // đếm lại từ đầu mỗi turn mới.
    combatant.eyeOfHorusTargetHitCounts = {};
    // Emotion Level — đếm ngược Duration (Infinity nếu có Light Body = không bao giờ
    // hết tới khi encounter kết thúc). Hết Duration → rớt về Level 0, maxLight về lại
    // baseMaxLight, vào CD EMOTION_LEVEL_COOLDOWN_TURNS turn (không lên lại được dù
    // coin đủ — xem applyEmotionDelta). Nếu KHÔNG có level active, đếm ngược CD nếu có.
    if (combatant.emotionLevel > 0 && Number.isFinite(combatant.emotionLevelTurnsLeft)) {
      combatant.emotionLevelTurnsLeft -= 1;
      if (combatant.emotionLevelTurnsLeft <= 0) {
        combatant.emotionLevel = 0;
        combatant.maxLight = combatant.baseMaxLight;
        combatant.currentLight = Math.min(combatant.currentLight, combatant.maxLight);
        combatant.emotionLevelCooldownLeft = EMOTION_LEVEL_COOLDOWN_TURNS;
      }
    } else if ((combatant.emotionLevelCooldownLeft ?? 0) > 0) {
      combatant.emotionLevelCooldownLeft -= 1;
      // ❗ BUG ĐÃ SỬA (Fragaria: "khi toàn bộ Emotion Level đang CD, Coin THỪA sẽ
      // ĐỌNG LẠI — VD 9/3 — đến khi Emotion Level hết CD thì TỰ ĐỘNG mở luôn").
      // Trước đây Coin đọng đúng, nhưng KHÔNG AI kích lại lúc CD về 0 ⇒ người
      // chơi phải chờ tới lần nhận Coin kế tiếp mới lên level.
      // Nay CD vừa hết thì gọi lại applyEmotionDelta(0) — nó chạy vòng while
      // level-up với số Coin đang có, tự lên NHIỀU cấp một lúc nếu đủ (heal lần
      // lượt từng cấp), và cấp CAO HƠN ghi đè cấp thấp (đúng luật "luôn lấy
      // Emotion Level cao hơn").
      if (combatant.emotionLevelCooldownLeft <= 0 && applyEmotionDelta) {
        const lvNotes = applyEmotionDelta(combatant, 0) ?? [];
        if (lvNotes.length > 0) {
          combatant.emotionAutoLevelNote = `⏳ Hết CD Emotion Level — Coin đọng đủ, lên cấp ngay: ${lvNotes.join(" · ")}`;
        }
      }
    }
    // Giảm cooldown skill — xoá hẳn khi về 0 (không giữ key rác trong object).
    if (combatant.skillCooldowns) {
      for (const sk of Object.keys(combatant.skillCooldowns)) {
        combatant.skillCooldowns[sk] -= 1;
        if (combatant.skillCooldowns[sk] <= 0) delete combatant.skillCooldowns[sk];
      }
    }
    // ── Skill Tree — reset/đếm ngược các cờ/CD theo turn ─────────────────────────
    // Battle Ignition: "turn TRƯỚC đánh ≥10 lần" — shift count turn này thành "turn
    // trước" cho lần check kế tiếp, rồi reset bộ đếm turn mới.
    combatant.lastTurnAttackCount = combatant.attacksThisTurn ?? 0;
    combatant.attacksThisTurn = 0;
    // Follow-Up/Pounce + Craving Synergy/Thirst/Break the Dams ("đòn đầu tiên mỗi
    // turn") — đều là cờ 1 LẦN/turn, reset về false mỗi turn mới.
    combatant.followUpUsedThisTurn = false;
    combatant.usedItemThisTurn = false;
    combatant.unlockUsedThisTurn = false;
    combatant.voracityUsedThisTurn = false;
    // Shin/Mang chỉ active TRONG TURN đã kích hoạt — hết turn thì tắt hẳn (phải dùng
    // lại -encounter shinmang, tốn thêm 25 Sanity, nếu muốn duy trì turn sau).
    // Buff PHÁI SINH của Mang (+Dice Up / +Clash Power Up) chỉ sống trong turn.
    // LƯU Ý: KHÔNG cần tự trừ Dice Up ở đây — `combatant.diceUp = 0` đã có sẵn ở
    // khối reset status cuối hàm này (cùng advanceCombatantTurn), Dice Up vốn là
    // status theo-turn. Chỉ `clashPowerUp` là field MỚI nên phải reset tường minh.
    // `mangDiceUpApplied` vẫn giữ để performShinMang biết phần Dice Up nào là của
    // Mang khi kích hoạt LẠI trong CÙNG turn (tránh cộng chồng).
    combatant.mangDiceUpApplied = 0;
    combatant.clashPowerUp = 0;
    // mangLevel là chỉ số profile — KHÔNG reset theo turn.
    // ❗ BUG ĐÃ SỬA (Fragaria: "kích hoạt Shin của Shin - Rien chỉ kéo dài 1 turn
    // trong khi đáng lẽ phải VĨNH VIỄN cho tới hết Encounter").
    // GỐC: dòng này reset Shin MỖI TURN — đúng cho Shin/Mang thường (bật theo
    // lượt), nhưng Shin do **Shin - Rien** cấp là tới hết Encounter.
    // `shinRienActive` là cờ đánh dấu nguồn ⇒ giữ Shin bật.
    if (!combatant.shinRienActive) combatant.shinMangActive = false;
    combatant.shinMangUsedThisTurn = false;
    combatant.bleedFirstHitUsedThisTurn = false;
    if ((combatant.breakTheDamsCdLeft ?? 0) > 0) combatant.breakTheDamsCdLeft -= 1;
    // Manifest E.G.O — đếm ngược Duration (Level×3 turn), hết thì tắt + vào CD 5 turn.
    // Nếu KHÔNG active, đếm ngược CD nếu có.
    if (combatant.manifestedEGO) {
      // "The Strongest" — kiểm tra NGƯỠNG DMG *TRƯỚC* khi trừ turn: điều kiện là
      // "nếu trong 1 TURN bạn không gây ra dmg tối thiểu 15% Max HP của kẻ địch"
      // ⇒ chấm ở cuối turn đó. `dmgDealtByTargetThisTurn` bị RESET về 0 ở cuối
      // chính hàm này, nên đọc muộn hơn là luôn ra 0 (đúng cái bẫy đã dính 1 lần
      // với Astral Quantization/Swan Song — xem HANDOFF).
      // Chấm ngưỡng theo VÒNG TURN ORDER (Fragaria: "turn này là turn order ấy
      // nhé, không phải là turn sau khi turn end của từng người đâu").
      // ĐÃ ĐÚNG SẴN, không phải sửa: `advanceCombatantTurn` CHỈ được gọi từ
      // `performEndTurn` (reactive-defense.js:153-154) — chạy MỘT LẦN cho TOÀN BỘ
      // combatant khi GM bấm "🔄 Kết thúc Turn", tức đúng nhịp vòng turn order,
      // KHÔNG phải lúc từng người kết thúc lượt riêng.
      if (combatant.theStrongestActive) {
        const perTarget = combatant.dmgDealtByTargetThisTurn ?? {};
        const enemyMaxHps = combatant.theStrongestEnemyMaxHpSnapshot ?? {};
        // "dmg tối thiểu bằng 15% Max HP CỦA KẺ ĐỊCH" — đủ điều kiện nếu có ÍT
        // NHẤT 1 kẻ địch bị ăn ≥15% Max HP của chính nó. Dùng ngưỡng theo TỪNG
        // mục tiêu (không phải tổng dmg) vì spec viết "của kẻ địch" số ít.
        let reached = false;
        for (const [tid, dealt] of Object.entries(perTarget)) {
          const maxHp = enemyMaxHps[tid];
          if (!maxHp) continue;
          if (dealt >= maxHp * 0.15) { reached = true; break; }
        }
        if (!reached) {
          const penalty = Math.floor((combatant.maxStamina ?? 0) * 0.5);
          combatant.currentStamina = Math.max(0, (combatant.currentStamina ?? 0) - penalty);
          combatant.theStrongestPenaltyNote = `🔥 **The Strongest** — vòng turn này bạn không TỰ gây đủ 15% Max HP lên kẻ địch nào ⇒ −${penalty} Stamina.`;
        } else {
          combatant.theStrongestPenaltyNote = null;
        }
      }
      combatant.manifestedEGOTurnsLeft -= 1;
      if (combatant.manifestedEGOTurnsLeft <= 0) {
        // Đi qua endManifestedEgoState để TRẢ LẠI mọi thứ đã cấp (Max Stamina,
        // vũ khí Mimicry: Synchronization → Mimicry Blade). Tự set
        // `manifestedEGO = false` ở đây như bản cũ sẽ để combatant kẹt vĩnh viễn
        // với +100 Max Stamina và cây vũ khí biến hình.
        combatant.manifestEndNote = endManifestedEgoState
          ? endManifestedEgoState(combatant)
          : (combatant.manifestedEGO = false, combatant.manifestedEGOCooldownLeft = 5, "");
      }
    } else if ((combatant.manifestedEGOCooldownLeft ?? 0) > 0) {
      combatant.manifestedEGOCooldownLeft -= 1;
    }
    // Shattered E.G.O — 3 Turn (dmg ×0.5 + mọi Dice ra Min Dice). Đếm ngược
    // ĐỘC LẬP với Manifest: nó chỉ tồn tại SAU khi Manifest đã bị cắt.
    if ((combatant.shatteredEgoTurnsLeft ?? 0) > 0) combatant.shatteredEgoTurnsLeft -= 1;
    // Erosion (Falco Berigora) — "chỉ áp dụng 1 Turn".
    if ((combatant.erosionTurnsLeft ?? 0) > 0) {
      combatant.erosionTurnsLeft -= 1;
      if (combatant.erosionTurnsLeft <= 0) { combatant.erosion = 0; combatant.erosionBy = {}; }
    }
    // False Throne — hồi sinh CHỈ 1 Turn, hết turn thì gục lại.
    if ((combatant.falseThroneRevivedTurnsLeft ?? 0) > 0) {
      combatant.falseThroneRevivedTurnsLeft -= 1;
      if (combatant.falseThroneRevivedTurnsLeft <= 0 && (combatant.currentHp ?? 0) > 0) {
        combatant.currentHp = 0;
        combatant.staggered = true;
        combatant.falseThroneCollapsed = true;
      }
    }
    // K-Corp Ampule — CD 2 turn RIÊNG của item này (xem -encounter useitem).
    if ((combatant.kCorpAmpuleCooldownLeft ?? 0) > 0) {
      combatant.kCorpAmpuleCooldownLeft -= 1;
    }
    // Táo (item): -1 Dmg/hit CHỈ tới hết turn hiện tại — reset về false mỗi endturn.
    combatant.appleDmgReductionActive = false;
    // Eye Of Horus (weapon passive "Foreclosure Task Force President") — reset TOÀN
    // BỘ counter mỗi endturn (luật: "trong 1 turn khi tấn công 1 đối tượng").
    combatant.m1CountThisTurnByTarget = {};
    // Set Fire — đếm ngược 3 turn, hết thì tắt buff (KHÔNG reset về 0 ngay như apple —
    // đây là counter thật, giảm dần từ 3→2→1→0).
    if (combatant.setFireTurnsLeft > 0) combatant.setFireTurnsLeft -= 1;
    // 50-Status NHÓM 1 — decay "biến mất sau End Turn" (Fragile/Attack Power Up-
    // Down/Defense Up-Down/Clash Attack Boost/Unopposed Attack Boost) — reset THẲNG
    // về 0, KHÔNG đếm ngược (đúng luật "biến mất sau End Turn", không phải "kéo dài
    // N turn"). Protection KHÁC — "biến mất sau mỗi 2 turn" nên dùng counter riêng.
    combatant.fragile = 0;
    combatant.attackPowerUp = 0;
    combatant.attackPowerDown = 0;
    combatant.defenseUp = 0;
    combatant.defenseDown = 0;
    combatant.clashAttackBoost = (combatant.blackSuitPersistentBonus ?? 0); // "Black Suit" — GAP MỚI: Clash Attack Boost từ Emotion Level KÉO DÀI hết encounter (không như reset=0 thông thường), cộng LẠI ngay sau reset mỗi turn.
    combatant.unopposedAttackBoost = 0;
    // "Blade Lineage Mentor" (outfit) — Rending kéo dài ĐẾN HẾT TURN (không
    // phải vĩnh viễn như Black Suit) — reset mỗi turn mới.
    combatant.renderingActive = false;
    combatant.diceUpSlashOnly = 0;
    if ((combatant.protectionTurnsLeft ?? 0) > 0) {
      combatant.protectionTurnsLeft -= 1;
      if (combatant.protectionTurnsLeft <= 0) combatant.protection = 0;
    }
    // "The Middle Little/Big Sibling" (outfit) — Enhancement Tattoos kéo dài 2
    // Turn, cùng pattern với Protection ở trên.
    if ((combatant.enhancementTattoosTurnsLeft ?? 0) > 0) {
      combatant.enhancementTattoosTurnsLeft -= 1;
      if (combatant.enhancementTattoosTurnsLeft <= 0) combatant.enhancementTattoosStack = 0;
    }
    // Regen/Charge Shield KHÔNG decay theo turn (chỉ mất khi ĐÃ hồi HP / ĐÃ bị tấn
    // công tương ứng) — KHÔNG có dòng reset ở đây, đúng chủ ý.
    // Iron Horus — Guard "cả turn chặn TOÀN BỘ đòn" nghĩa là hiệu lực ĐÚNG 1 turn
    // (KHÔNG kéo dài mãi mãi) — vì charge KHÔNG BAO GIỜ tự trừ theo hit (xem khối xử
    // lý Guard lúc confirm), cần RESET THỦ CÔNG ở đây mỗi endturn. Người KHÔNG có
    // Iron Horus KHÔNG cần dòng này — charge của họ tự nhiên hết khi ăn đủ N hit.
    if (combatant.hasIronHorus && combatant.guardCharges > 0) combatant.guardCharges = 0;
    // BUG THẬT ĐÃ SỬA (phát hiện khi rà lại theo tài liệu mới): Haste/Bind chưa
    // TỪNG có decay logic thật nào — chỉ có comment mô tả ý định từ trước, chưa
    // triển khai. "Sau turn end của turn được cộng speed từ Haste thì toàn bộ
    // stack sẽ mất" (xác nhận trực tiếp) — reset THẲNG về 0 mỗi endturn, giống
    // Nhóm 1. Đặt TRƯỚC khối Borrowed Time bên dưới — Borrowed Time cấp Haste MỚI
    // cho turn TIẾP THEO, không phải giữ Haste cũ của turn vừa dùng để roll Speed.
    combatant.haste = 0;
    combatant.bind = 0;
    // — 50-STATUS NHÓM 2 (batch 1, xác nhận trực tiếp từng cái từ tài liệu gốc) —
    // Dice Up/Down: "biến mất sau End Turn" — reset thẳng về 0, giống Nhóm 1.
    combatant.diceUp = 0;
    // Boss theo kịch bản: reset bộ đếm đòn/turn (điều kiện DỪNG duy nhất của
    // boss khai `noStaminaCost` — xem attemptOneMobAction trong enemy-ai.js).
    combatant.bossAttacksThisTurn = 0;
    // "Swan Song" (Lucent Historia) hồi 20% lượng Shield MẤT trong turn — phải
    // reset bộ đếm ở ĐẦU turn mới, nếu không nó cộng dồn cả trận.
    // ⚠️ Hiệu ứng hồi máu CHƯA nối (xem HANDOFF) — reset đặt sẵn để khi nối
    // không phải sửa 2 chỗ.
    combatant.shieldLostThisTurn = 0;
    // Tổng dmg gây ra trong turn — "Astral Quantization" đọc trước khi reset
    // (reactive-defense.js bắn dmg trì hoãn TRƯỚC khi gọi advanceCombatantTurn).
    combatant.dmgDealtThisTurn = 0;
    // Dmg theo TỪNG mục tiêu — Astral Quantization tính % riêng cho mỗi kẻ địch.
    combatant.dmgDealtByTargetThisTurn = {};
    // "Vừa bị AI nhắm" — giảm dần mỗi turn để người bị dồn đòn turn trước được
    // trở lại vòng quay bình thường (xem enemy-ai.js's pickAiTargets).
    if ((combatant.aiRecentTargetCount ?? 0) > 0) combatant.aiRecentTargetCount -= 1;
    // TÍCH TỤ (chargeSpec) — mỗi turn giữ nguyên trạng thái tích thì +1.
    // KHÔNG kẹp ở đây (skills.js's roll() tự kẹp theo chargeSpec.maxTurns) để
    // turn-advance không phải biết luật của từng skill.
    if (combatant.chargingSkillKey) {
      combatant.chargingTurns = Math.min(10, (combatant.chargingTurns ?? 0) + 1);
    }
    // Augury Kick — cộng LẠI bonus còn hiệu lực ngay sau khi diceUp bị reset.
    if ((combatant.auguryKickTurnsLeft ?? 0) > 0) combatant.diceUp += (combatant.auguryKickDiceUpBonus ?? 0);
    // Dice Up có thời hạn từ PAGE (Focus Spirit…) — cùng khuôn Augury Kick.
    if ((combatant.pageDiceUpTurnsLeft ?? 0) > 0) combatant.diceUp += (combatant.pageDiceUpBonus ?? 0);
    // "Overcharged Vessel" — BUG ĐÃ SỬA (phát hiện khi làm Augury Kick, cùng cơ
    // chế): `overchargedDiceUpBonus` được GHI (encounter-actions.js), được DECAY
    // (cuối file này) và được HIỂN THỊ (encounter-display.js) — nhưng KHÔNG nơi
    // nào cộng nó vào `diceUp`. Nửa "Dice Up" của perk chưa từng có tác dụng;
    // chỉ nửa `overchargedDmgBonusPct` chạy (qua attacker-perk-context.js).
    if ((combatant.overchargedTurnsLeft ?? 0) > 0) combatant.diceUp += (combatant.overchargedDiceUpBonus ?? 0);
    // Manifested E.G.O — +3 Dice Up là NỀN CHUNG của MỌI Manifested E.G.O.
    // `diceUp` bị reset về 0 ở ngay trên trong CÙNG hàm này ⇒ phải cộng LẠI mỗi
    // turn, đúng khuôn blackSuitPersistentBonus/Augury Kick ngay bên cạnh.
    // ĐẶT SAU khối đếm ngược Manifest ở trên: Manifest vừa hết turn này thì
    // `manifestedEGO` đã là false ⇒ không cộng nhầm cho turn sau.
    if (combatant.manifestedEGO) combatant.diceUp = (combatant.diceUp ?? 0) + 3;
    // ── SINGLETON (The Index Oracle's Proxy) ─────────────────────────────────
    // "Nhận 5 Dice Up và refund 1/5 Stamina khi đánh thường". Dice Up bị reset
    // mỗi turn nên phải cộng LẠI ở đây (khuôn blackSuitPersistentBonus).
    // Saikai1.mp3 — "trong turn VÀ turn kế" ⇒ đúng 2 vòng turn order.
    if ((combatant.saikai1TurnsLeft ?? 0) > 0) combatant.saikai1TurnsLeft -= 1;
    if ((combatant.saikai2TurnsLeft ?? 0) > 0) combatant.saikai2TurnsLeft -= 1;
    // ── Status HẸN TURN SAU (Furioso) ────────────────────────────────────────
    // "Gây … ở TURN SAU khi đòn tấn công này kết thúc" — áp ở đầu vòng turn kế,
    // không phải ngay lúc đánh (sai một nhịp turn).
    if (combatant.pendingNextTurnStatus) {
      const q = combatant.pendingNextTurnStatus;
      if (q.bleed) combatant.bleed = Math.min(99, (combatant.bleed ?? 0) + q.bleed);
      if (q.bind) combatant.bind = Math.min(20, (combatant.bind ?? 0) + q.bind);
      if (q.fragile) combatant.fragile = Math.min(99, (combatant.fragile ?? 0) + q.fragile);
      combatant.pendingNextTurnStatus = null;
    }

    // ── SHIN - RIEN (The Index Oracle's Proxy) ────────────────────────────────
    // "Khi nhận sát thương vượt ngưỡng NỬA MAX HP, bạn ngừng nhận dmg ở turn này.
    //  End turn, bạn tháo Wound-Casing Mask …, tiến vào trạng thái Shin VĨNH VIỄN
    //  kéo dài tới hết Encounter, đồng thời nhận thêm 1 Dice Up với mỗi 20 HP đã
    //  mất kéo dài đến hết Encounter."
    // Ngưỡng chấm ở ĐÂY (cuối vòng turn) — `hpLostThisTurn` bị reset ngay bên dưới
    // trong CÙNG hàm này nên đọc muộn hơn là luôn ra 0.
    if (combatant.hasIndexOraclesProxy) {
      const halfMax = (combatant.maxHp ?? 0) * 0.5;
      // Dùng CỜ do applyHpLoss bật (nguồn sự thật duy nhất) thay vì tự tính lại
      // theo hpLostThisTurn — cách cũ bỏ sót người đang ở dưới nửa thanh sẵn.
      if (!combatant.shinRienActive && combatant.shinRienTriggered) {
        combatant.shinRienActive = true;   // kéo dài TỚI HẾT ENCOUNTER (không reset ở đâu)
        combatant.shinMangActive = true;   // vào trạng thái Shin thật sự (Res/hiển thị)
        // ❗ LỖ HỔNG THIẾT KẾ Fragaria phát hiện: địch dồn dmg quá nhanh ⇒ Shin -
        // Rien bật SỚM khi người chơi chưa kịp có Unlock nào ⇒ follow-up Furioso
        // vô dụng vì không có biến thể nào mở. Chốt: **tự cấp Unlock - I** nếu
        // đang ở tầng 0 lúc Shin kích hoạt.
        if ((combatant.prescriptUnlockLevel ?? 0) === 0) {
          combatant.prescriptUnlockLevel = 1;
          combatant.prescriptUnlockJustReached = 1;
          combatant.shinRienNote = (combatant.shinRienNote ? combatant.shinRienNote + " " : "")
            + "<:Unlock:1528452595859849406> Chưa có Unlock nào ⇒ **Shin - Rien tự cấp Unlock - I** để follow-up Furioso dùng được.";
        }
        // Tháo mặt nạ (nếu đang đeo) — Sizzling Wound quay lại, ĐÚNG như khi vỡ.
        if (combatant.woundCasingMaskIntact) {
          combatant.woundCasingMaskIntact = false;
          combatant.sizzlingWound = true;
        }
        // "Turn SAU khi gỡ Wound-Casing Mask, bạn CÓ LỰA CHỌN nhận 1 stack
        //  Indulgence in Prescript và follow-up bằng Furioso" — mở cửa sổ 1 turn.
        // ❗ BUG ĐÃ SỬA (Fragaria: "vào turn sau… vẫn không thấy option follow-up
        // Furioso"). Đặt = 1 rồi khối đếm ngược Ở NGAY DƯỚI chạy trong CÙNG lượt
        // advanceCombatantTurn này ⇒ về 0 tức thì, offer chưa kịp hiện đã đóng.
        // Đặt = 2 để sống qua đúng **turn kế tiếp** — đúng luật "TURN SAU khi gỡ
        // Wound-Casing Mask".
        combatant.shinRienFuriosoWindow = 2;
        combatant.shinRienNote = "🩸 **Shin - Rien** — mất quá nửa Max HP trong 1 turn: tháo **Wound-Casing Mask**, vào trạng thái **Shin** vĩnh viễn tới hết Encounter.";
      }
      // "+1 Dice Up với mỗi 20 HP ĐÃ MẤT" — tính trên tổng HP đang thiếu, cộng lại
      // mỗi turn vì `diceUp` bị reset.
      if (combatant.shinRienActive) {
        const lost = Math.max(0, (combatant.maxHp ?? 0) - (combatant.currentHp ?? 0));
        combatant.diceUp = (combatant.diceUp ?? 0) + Math.floor(lost / 20);
      }
      // ── Follow-up Furioso của Shin - Rien ────────────────────────────────
      // Spec mới nhất: *"TURN SAU, Rien SẼ NHẬN ĐƯỢC 1 stack Indulgence in
      // Prescript, và follow-up bằng Furioso… với cái giá là 35 Karmic
      // Consequences"* — TỰ ĐỘNG, không phải "có lựa chọn" như bản trước.
      // "Chỉ kích hoạt MỘT LẦN mỗi Encounter"; "nếu không dùng Furioso trong
      // turn đó thì kĩ năng biến mất khi qua turn sau".
      // ── Cửa sổ follow-up Furioso của Shin - Rien ─────────────────────────
      // ⚠️ Fragaria đính chính: đây là **TÙY CHỌN CÓ RỦI RO**, KHÔNG được tự động
      // chạy. Turn-advance chỉ MỞ CỬA SỔ; người chơi tự bấm nút ở panel Special
      // nếu muốn trả giá. Cũng đính chính cách nói: là **+35 Karmic Consequence**
      // (NHẬN THÊM debuff), không phải "trừ 35" — Karmic là stack xấu.
      if ((combatant.shinRienFuriosoWindow ?? 0) > 0) {
        combatant.shinRienFuriosoOffer = true;
        combatant.shinRienFuriosoWindow -= 1;
        if (combatant.shinRienFuriosoWindow <= 0) {
          combatant.shinRienFuriosoOffer = false;
          combatant.shinRienFuriosoReady = false;
          combatant.shinRienNote = (combatant.shinRienNote ? combatant.shinRienNote + " " : "")
            + "🩸 Cửa sổ **Furioso follow-up** đã đóng (không dùng trong turn đó).";
        }
      }
    }

    // ── WOUND-CASING MASK ────────────────────────────────────────────────────
    if (combatant.hasWoundCasingMask) {
      // "Mỗi Turn Start nếu có Unlock - I/II/III nhận 5/10/20 Poise."
      const amt = ({ 1: 5, 2: 10, 3: 20 })[combatant.prescriptUnlockLevel ?? 0] ?? 0;
      if (amt > 0) combatant.poise = Math.min(POISE_MAX ?? 99, (combatant.poise ?? 0) + amt);
      // "Khi có Sizzling Wound … nhận được 3 Dice Up" — diceUp reset mỗi turn nên
      // phải cộng LẠI ở đây.
      if (combatant.sizzlingWound) combatant.diceUp = (combatant.diceUp ?? 0) + 3;
      // "Sanity bị cap lại ở mức -40; không thể bị giảm thêm bởi bất kỳ hình thức nào."
      if ((combatant.currentSanity ?? 0) < -40) combatant.currentSanity = -40;
    }
    if (combatant.singleton && combatant.hasIndexOraclesProxy) {
      combatant.diceUp = (combatant.diceUp ?? 0) + 5;
      // "Nhận 5/10/20 Protection và Regen mỗi turn khi Unlock - I/II/III".
      const lvl = combatant.prescriptUnlockLevel ?? 0;
      const amt = (SINGLETON_UNLOCK_PROTECTION ?? {})[lvl] ?? 0;
      if (amt > 0) {
        combatant.protection = (combatant.protection ?? 0) + amt;
        combatant.regen = (combatant.regen ?? 0) + amt;
      }
    }
    // ── UNDERTAKE PRESCRIPT (The Oracle's Proxy Prescript Device) ────────────
    // "Nếu turn TRƯỚC hoàn thành ít nhất 1 sắc lệnh thì turn này hồi 10 Sanity.
    //  Lần ĐẦU nhận Unlock I/II/III trong trận thì hồi thêm 10 Sanity nữa."
    if (combatant.hasPrescriptDevice) {
      let sanityGain = 0;
      if (combatant.prescriptSucceededLastTurn) sanityGain += 10;
      if (combatant.prescriptUnlockJustReached) { sanityGain += 10; combatant.prescriptUnlockJustReached = 0; }
      if (sanityGain > 0 && applySanityGain) applySanityGain(combatant, sanityGain);
    }
    // Khoá nạp Procuration sau khi dùng Furioso — mở lại ở turn kế (xem
    // applyFuriosoUseCosts trong combat-utils.js).
    combatant.furiosoUsedThisTurn = false;
    // Mặt 3 Caduceus "bản thân +10% Dmg turn SAU": ô CHỜ đổ sang ô hiệu lực ở
    // ĐÚNG mốc sang turn, và ô hiệu lực cũ hết hạn cùng lúc. Làm 1 dòng theo thứ
    // tự này để buff không bị ăn 2 turn liền.
    combatant.caduceusDmgUpPct = combatant.caduceusDmgUpPendingPct ?? 0;
    combatant.caduceusDmgUpPendingPct = 0;
    // Trần "2 lần/turn" của mặt 3/4/6/7/8 — đếm lại từ đầu mỗi turn.
    combatant.caduceusFaceUses = {};
    // "địch nhận thêm X% Dmg turn NÀY" — hết hiệu lực khi hết turn.
    combatant.dmgTakenPctTurn = 0;
    combatant.dmgTakenPctByType = { B: 0, P: 0, S: 0 };
    // Indulgence in Prescript — "sẽ biến mất khi end turn".
    if ((combatant.indulgenceInPrescript ?? 0) > 0) combatant.indulgenceInPrescript = 0;
    // Grace of God — 1 lần MỖI VÒNG TURN ORDER.
    combatant.graceOfGodUsedThisTurn = false;
    // Zwei Association — mỗi turn chỉ đỡ giùm cho 1 người; sang turn mới chọn lại.
    combatant.zweiProtectingId = null;
    // Cache roll của page — chỉ có ý nghĩa TRONG turn (chống bấm-back-reroll).
    // Sang turn mới thì roll lại là hợp lệ.
    combatant.pageRollCache = null;
    combatant.shinRienBlockedDmg = 0;
    combatant.shinRienTriggered = false;
    // Providence of the Prescript — "nhận Poise theo cách trên 3 lần thì TURN KẾ
    // Crit Mul +0.3". Chốt sổ ở đây rồi reset bộ đếm.
    if (combatant.hasProvidenceOfPrescript) {
      combatant.providenceCritMulNextTurn = (combatant.providencePoiseProcsThisTurn ?? 0) >= 3;
      combatant.providencePoiseProcsThisTurn = 0;
    }
    // "The Strongest" (Red Mist) — 10 Dice Up + 4 Haste CỘNG THÊM lên nền trên
    // (tổng 13 Dice Up), "kéo dài tới khi hết Manifested E.G.O".
    if (combatant.theStrongestActive) {
      combatant.diceUp = (combatant.diceUp ?? 0) + 10;
      combatant.haste = Math.min(20, (combatant.haste ?? 0) + 4);
    }
    // "The Red Mist" — 5 Dice Up mỗi kẻ địch đã hạ, "kéo dài TỚI HẾT ENCOUNTER".
    // KHÔNG gate theo manifestedEGO: Dice Up đã nhận thì giữ tới hết trận kể cả
    // sau khi Manifest tắt (chỉ việc NHẬN mới cần đang Manifest).
    if ((combatant.redMistPersistentDiceUp ?? 0) > 0) {
      combatant.diceUp = (combatant.diceUp ?? 0) + combatant.redMistPersistentDiceUp;
    }
    combatant.diceUp += (combatant.blackSuitPersistentBonus ?? 0); // "Black Suit" — GAP MỚI: Dice Up từ Emotion Level KÉO DÀI hết encounter, cộng LẠI ngay sau reset mỗi turn (TRƯỚC khi Rotate Trigram/Geon áp +3 riêng, để không bị ghi đè mất).
    // "Rotate Trigram" (Augury Spear passive) — xác nhận trực tiếp: "Vào đầu
    // mỗi turn start bạn nhận được các buff theo thứ tự sau Geon -> Gon -> Gam
    // -> Ri -> lặp lại". Geon: +3 Dice Up. Gon: +7 Protection (cap 20). Gam: +2
    // Light. Ri: đánh dấu chờ áp dụng vào M1 đầu tiên (xem doPlayerAttack) —
    // "phá hủy 2 Light" nếu đủ Light, ngược lại giảm 10% Stamina địch. ĐẶT SAU
    // dòng diceUp=0 ở trên — nếu đặt trước, Geon's +3 sẽ bị dòng đó ghi đè mất.
    if (combatant.weaponName === "Augury Spear") {
      const idx = combatant.rotateTrigramIndex ?? 0;
      if (idx === 0) { // Geon
        combatant.diceUp = (combatant.diceUp ?? 0) + 3;
      } else if (idx === 1) { // Gon
        combatant.protection = Math.min(20, (combatant.protection ?? 0) + 7);
      } else if (idx === 2) { // Gam
        combatant.currentLight = Math.min(combatant.maxLight, (combatant.currentLight ?? 0) + 2);
      } else if (idx === 3) { // Ri
        combatant.rotateTrigramRiPending = true;
      }
      combatant.rotateTrigramIndex = (idx + 1) % 4;
    }
    combatant.yourShieldUsedThisTurn = false;
    // "Tactical Suppression" (Eye Of Horus Critical) — xác nhận trực tiếp:
    // "50 HP Shield x Số lượng người trên sân trong 2 Turn. Heal lại lượng
    // máu = Lượng HP Shield hao hụt sau 2 turn" — sau 2 turn, heal lại phần
    // CHÊNH LỆCH giữa shieldGranted (lúc cấp) và shieldHp còn lại (phần đã
    // "hao hụt" do bị tấn công/tiêu thụ). CD "3 Turn SAU KHI HẾT Shield HP" —
    // track riêng: nếu shieldHp về 0 TRƯỚC khi hết 2 turn, bắt đầu đếm CD
    // ngay (không đợi hết 2 turn).
    if (combatant.tacticalSuppressionActive) {
      if ((combatant.shieldHp ?? 0) <= 0 && !combatant.tacticalSuppressionCdPending) {
        combatant.tacticalSuppressionCdPending = true;
        combatant.tacticalSuppressionCdTurnsLeft = 3;
      }
      combatant.tacticalSuppressionTurnsLeft -= 1;
      if (combatant.tacticalSuppressionTurnsLeft <= 0) {
        const depleted = Math.max(0, combatant.tacticalSuppressionShieldGranted - (combatant.shieldHp ?? 0));
        // healHpCapped — khiên Tactical Suppression chưa dùng hết chuyển lại
        // thành HP, cũng KHÔNG được lấp vào máu ảo của Compassion.
        healHpCapped(combatant, depleted);
        combatant.tacticalSuppressionActive = false;
        combatant.tacticalSuppressionShieldGranted = 0;
        if (!combatant.tacticalSuppressionCdPending) {
          combatant.tacticalSuppressionCdPending = true;
          combatant.tacticalSuppressionCdTurnsLeft = 3;
        }
      }
    }
    if (combatant.tacticalSuppressionCdPending && combatant.tacticalSuppressionCdTurnsLeft > 0) {
      combatant.tacticalSuppressionCdTurnsLeft -= 1;
      if (combatant.tacticalSuppressionCdTurnsLeft <= 0) combatant.tacticalSuppressionCdPending = false;
    }
    // "Dark Cloud" (Kurokumo Wakashu outfit) — xác nhận trực tiếp: "Mỗi turn trừ 2 Stack".
    if ((combatant.darkCloudOutfitStacks ?? 0) > 0) {
      combatant.darkCloudOutfitStacks = Math.max(0, combatant.darkCloudOutfitStacks - 2);
    }
    // "Ignite Weaponry" (Liu Association) — xác nhận trực tiếp: "Đốt cháy vũ
    // khí của bạn trong 2 Turn" — giảm dần mỗi turn end.
    if ((combatant.weaponIgnitedTurnsLeft ?? 0) > 0) {
      combatant.weaponIgnitedTurnsLeft -= 1;
    }
    // "Dullahan" (Fused Blade of Ruined Mirror Worlds passive) — xác nhận
    // trực tiếp: "Vào turn kế sau khi bạn Parry bạn sẽ nhận được 1 Stack
    // Dullahan và giảm bản thân 15 Sanity" (round-based, giống Waltz In
    // White/Black — parry ở round N thì +1 stack ở lúc round N+1 bắt đầu, đây
    // chính là thời điểm đó vì advanceCombatantTurn chạy mỗi khi round mới).
    if (combatant.dullahanParriedThisTurn) {
      combatant.dullahanStacks = (combatant.dullahanStacks ?? 0) + 1;
      combatant.currentSanity = (combatant.currentSanity ?? 0) - 15;
      combatant.dullahanParriedThisTurn = false;
    }
    // "...đồng thời mỗi turn end bạn sẽ mất (15 - số Coffin hiện tại trên bản
    // thân) Sanity" — CHỈ áp dụng khi ĐANG có Dullahan (câu mô tả nằm trong
    // "Khi có Dullahan..."). "Khi dưới -15 Sanity, mỗi turn end sẽ nhận được
    // thêm 1 Stack Dullahan" — check NGAY sau khi trừ Sanity ở trên.
    if ((combatant.dullahanStacks ?? 0) > 0) {
      combatant.currentSanity = (combatant.currentSanity ?? 0) - (15 - (combatant.coffinStacks ?? 0));
      if (combatant.currentSanity < -15) {
        combatant.dullahanStacks += 1;
      }
    }
    // "Hana Association" — reset HP mất trong turn cùng lúc với diceUp.
    // ── R CORP: cấp buff đã hẹn "ở TURN SAU" + reset bộ đếm proc ─────────────
    // Cấp Ở ĐÂY (cuối turn, ngay trước khi sang turn mới) nên buff có hiệu lực
    // đúng turn kế tiếp. Đọc-rồi-xoá để không cấp lặp.
    {
      const q = combatant.rcorpPendingNextTurn;
      if (q) {
        if (q.protection > 0) {
          combatant.protection = Math.min(20, (combatant.protection ?? 0) + q.protection);
          combatant.protectionTurnsLeft = 2;
        }
        if (q.haste > 0) combatant.haste = Math.min(20, (combatant.haste ?? 0) + q.haste);
        if (q.diceUp > 0) combatant.diceUp = (combatant.diceUp ?? 0) + q.diceUp;
        combatant.rcorpPendingNextTurn = null;
      }
      combatant.rcorpProcsThisTurn = 0;
    }
    // ── Reindeer "Survivor" (Fragaria 14/08) ────────────────────────────────
    // *"Mỗi lần bị Stagger, turn sau nhận 2 Dice Up và 2 Protection; TĂNG DẦN theo
    //  số lần bị Stagger (lần 2: 4 và 4, lần 3: 6 và 6…) [tối đa 5 lần]."*
    // ⇒ lần thứ N cho N×2 mỗi loại, đếm tối đa 5 LẦN (lần 6 trở đi vẫn cho như
    //   lần 5, không tăng nữa).
    if (combatant.hasReindeerRCorp && combatant.staggered && !combatant.survivorCountedThisStagger) {
      combatant.survivorCountedThisStagger = true;
      combatant.survivorStaggerCount = Math.min(5, (combatant.survivorStaggerCount ?? 0) + 1);
      const amt = combatant.survivorStaggerCount * 2;
      combatant.diceUp = (combatant.diceUp ?? 0) + amt;
      combatant.protection = Math.min(20, (combatant.protection ?? 0) + amt);
      combatant.protectionTurnsLeft = 2;
    }
    if (!combatant.staggered) combatant.survivorCountedThisStagger = false;
    // ── Lone Fixer (Yuna): "khi chỉ còn bản thân / người sống sót cuối cùng" ──
    // Tính LẠI mỗi turn thay vì set một lần — đồng đội hồi sinh thì cờ phải tắt.
    // `_alivePlayerCount` do performEndTurn bơm vào (xem reactive-defense.js).
    if (combatant.hasDawnYuna) {
      combatant.loneFixerActive = (combatant._alivePlayerCount ?? 0) === 1 && (combatant.currentHp ?? 0) > 0;
    }
    combatant.hpLostThisTurn = 0;
    combatant.diceDown = 0;
    // Smoke: "sau mỗi 1 turn sẽ mất 1 stack" — decay -1 (KHÔNG reset thẳng về 0
    // như Nhóm 1 — đây là "mất DẦN", floor tại 0).
    if ((combatant.smoke ?? 0) > 0) combatant.smoke = Math.max(0, combatant.smoke - 1);
    // Airborne: "nhận 10 Dmg vào End Turn. Biến mất sau End Turn..." — gây dmg
    // NGAY tại đây rồi tắt flag (nhánh còn lại "hoặc sau dính đòn có condition
    // Airborne" xử lý riêng ở nơi resolve defense-bypass tags, không phải ở đây).
    if (combatant.airborne) {
      applyHpLoss(combatant, 10, { countHana: false });
      combatant.airborne = false;
    }
    // Borrowed Time: "2 Haste và 1 Attack Power Up MỖI TURN (max 2 stack Borrowed
    // Time) tồn tại 3 turn" — áp SAU khi attackPowerUp đã reset về 0 ở trên (dòng
    // 126), để buff của turn MỚI này không bị chính dòng reset đó xoá mất. Haste
    // KHÔNG bị reset ở khối Nhóm 1 phía trên (Haste có decay riêng — xem dưới),
    // nên cộng thẳng vào.
    if ((combatant.borrowedTimeTurnsLeft ?? 0) > 0) {
      combatant.haste = Math.min(20, (combatant.haste ?? 0) + 2);
      combatant.attackPowerUp = Math.min(10, combatant.attackPowerUp + 1);
      combatant.borrowedTimeTurnsLeft -= 1;
      if (combatant.borrowedTimeTurnsLeft <= 0) combatant.borrowedTime = 0;
    }
    // Fairy: "biến mất khi hiệu lực đủ 2 Turn" — đếm ngược, hết HẲN (không giảm
    // dần như Smoke).
    if ((combatant.fairyTurnsLeft ?? 0) > 0) {
      combatant.fairyTurnsLeft -= 1;
      if (combatant.fairyTurnsLeft <= 0) combatant.fairy = 0;
    }
    // Chains: "(1 Turn)" — hết sau 1 turn NẾU chưa dùng skill nào để tiêu thụ
    // (việc tiêu thụ khi DÙNG skill xử lý ở resolveSkillVerification).
    if ((combatant.chainsTurnsLeft ?? 0) > 0) {
      combatant.chainsTurnsLeft -= 1;
      if (combatant.chainsTurnsLeft <= 0) combatant.chains = false;
    }
    // Freeble: "Max 5 Stack, mỗi turn trừ một nửa. Nếu dưới 1 thì hết."
    if ((combatant.freeble ?? 0) > 0) {
      combatant.freeble = Math.floor(combatant.freeble / 2);
      if (combatant.freeble < 1) combatant.freeble = 0;
    }
    // Gaze[Awe]/Contempt (xác nhận trực tiếp): "Khi có 7 Gaze[Awe] vào end turn,
    // sẽ chuyển thành Contempt vào turn kế" / "Contempt chuyển thành 7 Gaze[Awe]
    // vào turn kế" — chu kỳ 2 chiều, GIỮ NGUYÊN sourceId (vẫn cùng 1 "kẻ đã gắn").
    // Gaze[Awe] CHỈ chuyển hoá khi ĐẠT ĐÚNG 7 (max) — dưới 7 thì giữ nguyên,
    // không tự mất (khác Contempt luôn chuyển về Gaze[Awe] mỗi turn vì max chỉ 1).
    if (combatant.gazeAwe >= 7) {
      combatant.contempt = 1;
      combatant.contemptSourceId = combatant.gazeAweSourceId;
      combatant.gazeAwe = 0;
      combatant.gazeAweSourceId = null;
    } else if (combatant.contempt > 0) {
      combatant.gazeAwe = 7;
      combatant.gazeAweSourceId = combatant.contemptSourceId;
      combatant.contempt = 0;
      combatant.contemptSourceId = null;
    }
    // Gaze of Contempt/Contempt of the Gaze (xác nhận trực tiếp): "Chuyển hóa
    // thành Contempt of the Gaze vào Turn end khi đủ 7 Stack. Toàn bộ stack biến
    // mất khi turn end" (Gaze of Contempt) + "Stack biến mất khi turn end"
    // (Contempt of the Gaze) — THỨ TỰ ĐÚNG: (1) Contempt of the Gaze đã tồn tại
    // từ turn trước thì HẾT HẠN ngay tại đây (đã sống đủ 1 turn), (2) SAU ĐÓ mới
    // xét gazeOfContempt đạt 7 chưa để chuyển hoá MỚI (cho turn kế tiếp), (3)
    // gazeOfContempt LUÔN reset về 0 dù có đạt 7 hay không.
    combatant.contemptOfTheGaze = false;
    if (combatant.gazeOfContempt >= 7) {
      combatant.contemptOfTheGaze = true;
    }
    combatant.gazeOfContempt = 0;
    // Smoke Overload: Poise ĐÁNG LẼ bị giảm do crit trong turn (đã dồn lại, không trừ
    // ngay) — giờ mới trừ THẬT lúc end turn.
    if ((combatant.poiseReductionPending ?? 0) > 0) {
      combatant.poise = Math.max(0, combatant.poise - combatant.poiseReductionPending);
      combatant.poiseReductionPending = 0;
    }
    // Overcharged Vessel: hết Duration 3 turn thì mất hẳn bonus Dice Up/Dmg đã kích hoạt.
    // Augury Kick — hết 2 turn thì bỏ hẳn bonus Dice Up.
    if ((combatant.auguryKickTurnsLeft ?? 0) > 0) {
      combatant.auguryKickTurnsLeft -= 1;
      if (combatant.auguryKickTurnsLeft <= 0) combatant.auguryKickDiceUpBonus = 0;
    }
    if ((combatant.pageDiceUpTurnsLeft ?? 0) > 0) {
      combatant.pageDiceUpTurnsLeft -= 1;
      if (combatant.pageDiceUpTurnsLeft <= 0) combatant.pageDiceUpBonus = 0;
    }
    if ((combatant.overchargedTurnsLeft ?? 0) > 0) {
      combatant.overchargedTurnsLeft -= 1;
      if (combatant.overchargedTurnsLeft <= 0) {
        combatant.overchargedDiceUpBonus = 0;
        combatant.overchargedDmgBonusPct = 0;
      }
    }
  }

  return { advanceCombatantTurn };
};
