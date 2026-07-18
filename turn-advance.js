// turn-advance.js
// Hàm advanceCombatantTurn (toàn bộ logic decay status mỗi cuối turn — Burn/
// Bleed/Stagger/Panic/Emotion Level/Manifest E.G.O/50-Status Nhóm 1/Iron Horus...)
// — tách khỏi index.js theo yêu cầu trực tiếp: "tiếp tục tách đi". Dù RẤT DÀI
// (144 dòng), về mặt DEPENDENCY lại hoàn toàn đơn giản — chỉ đọc/ghi trực tiếp
// combatant object, không gọi bất kỳ hàm phức tạp nào khác (không Redis, không
// computeAttackerPerkContext).
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ hasPerk, ENCOUNTER_STAMINA_REGEN_PER_TURN, EMOTION_LEVEL_COOLDOWN_TURNS }) {

  function advanceCombatantTurn(combatant) {
    combatant.currentSpeed = null; // phải roll lại mỗi turn mới (xem -encounter rollspeed)
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
      const burnDmg = combatant.burn * 2 * (combatant.sizzlingWound ? 1.5 : 1) * (combatant.burningSensation ? 3 : 1);
      combatant.currentHp = Math.max(0, combatant.currentHp - burnDmg);
    }
    combatant.burn = Math.floor((combatant.burn ?? 0) / 2);
    combatant.bleed = Math.floor((combatant.bleed ?? 0) / 2);
    // Haou Flame (xác nhận trực tiếp): "Gây x10 Dmg... vào end turn sau đó /2,
    // nếu đạt về 0,5 thì kết thúc" — CÙNG cấu trúc Burn (dmg TRƯỚC, decay SAU),
    // chỉ khác hệ số (x10 thay vì x2) và field riêng (max 99, không chung "burn").
    if ((combatant.haouFlame ?? 0) > 0) {
      combatant.currentHp = Math.max(0, combatant.currentHp - combatant.haouFlame * 10);
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
    if (!combatant.hemorrhageAppliedThisTurn) {
      combatant.hemorrhage = 0;
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
        combatant.currentHp = Math.max(0, combatant.currentHp - explosionDmg);
        combatant.timeMoratorium = false;
        combatant.timeMoratoriumAccumulated = 0;
      }
    }
    if (combatant.staggered) {
      combatant.staggerTurnsLeft -= 1;
      if (combatant.staggerTurnsLeft <= 0) {
        combatant.staggered = false;
        combatant.currentStamina = combatant.maxStamina; // hồi đầy sau khi hết Stagger
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
      combatant.currentStamina = Math.min(combatant.maxStamina, combatant.currentStamina + ENCOUNTER_STAMINA_REGEN_PER_TURN);
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
    combatant.voracityUsedThisTurn = false;
    // Shin/Mang chỉ active TRONG TURN đã kích hoạt — hết turn thì tắt hẳn (phải dùng
    // lại -encounter shinmang, tốn thêm 25 Sanity, nếu muốn duy trì turn sau).
    combatant.shinMangActive = false;
    combatant.shinMangUsedThisTurn = false;
    combatant.bleedFirstHitUsedThisTurn = false;
    if ((combatant.breakTheDamsCdLeft ?? 0) > 0) combatant.breakTheDamsCdLeft -= 1;
    // Manifest E.G.O — đếm ngược Duration (Level×3 turn), hết thì tắt + vào CD 5 turn.
    // Nếu KHÔNG active, đếm ngược CD nếu có.
    if (combatant.manifestedEGO) {
      combatant.manifestedEGOTurnsLeft -= 1;
      if (combatant.manifestedEGOTurnsLeft <= 0) {
        combatant.manifestedEGO = false;
        combatant.manifestedEGOCooldownLeft = 5;
      }
    } else if ((combatant.manifestedEGOCooldownLeft ?? 0) > 0) {
      combatant.manifestedEGOCooldownLeft -= 1;
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
    combatant.clashAttackBoost = 0;
    combatant.unopposedAttackBoost = 0;
    if ((combatant.protectionTurnsLeft ?? 0) > 0) {
      combatant.protectionTurnsLeft -= 1;
      if (combatant.protectionTurnsLeft <= 0) combatant.protection = 0;
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
    // "Dark Cloud" (Kurokumo Wakashu outfit) — xác nhận trực tiếp: "Mỗi turn trừ 2 Stack".
    if ((combatant.darkCloudOutfitStacks ?? 0) > 0) {
      combatant.darkCloudOutfitStacks = Math.max(0, combatant.darkCloudOutfitStacks - 2);
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
    combatant.hpLostThisTurn = 0;
    combatant.diceDown = 0;
    // Smoke: "sau mỗi 1 turn sẽ mất 1 stack" — decay -1 (KHÔNG reset thẳng về 0
    // như Nhóm 1 — đây là "mất DẦN", floor tại 0).
    if ((combatant.smoke ?? 0) > 0) combatant.smoke = Math.max(0, combatant.smoke - 1);
    // Airborne: "nhận 10 Dmg vào End Turn. Biến mất sau End Turn..." — gây dmg
    // NGAY tại đây rồi tắt flag (nhánh còn lại "hoặc sau dính đòn có condition
    // Airborne" xử lý riêng ở nơi resolve defense-bypass tags, không phải ở đây).
    if (combatant.airborne) {
      combatant.currentHp = Math.max(0, combatant.currentHp - 10);
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
