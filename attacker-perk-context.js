// attacker-perk-context.js
// Hàm computeAttackerPerkContext (tính TẤT CẢ hiệu ứng từ perk/status của BÊN
// TẤN CÔNG lên 1 đòn đánh cụ thể — Eye Of Horus, Set Fire, Unopposed Attack
// Boost, Battle Ignition, Claim Their Heart, Tip-Toe Around...) — tách khỏi
// index.js theo yêu cầu trực tiếp: "tiếp tục tách đi". Dù RẤT DÀI và phức tạp về
// LOGIC (nhiều status effect check), về DEPENDENCY lại chỉ cần 2 thứ: hasPerk +
// applyStatusMultiplierToDmgStr (cả 2 từ skill-tree.js, đã định nghĩa TRƯỚC vị
// trí gốc — an toàn).
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ hasPerk, applyStatusMultiplierToDmgStr, KARMIC_MAX }) {

  function computeAttackerPerkContext(attacker, target, dmgStr, { isM1 = false, targetId = null, eyeOfHorusVolleys = null, eyeOfHorusNewCount = null, attackerId = null, willUseBullet = false, isMiddleSkill = false, skillKey = null } = {}) {
    let bonusPct = attacker.gmBonusPctOverride ?? 0;
    // %DmgTaken — TÁCH RIÊNG khỏi bonusPct (xem khối 6 status bên dưới).
    let dmgTakenPct = 0;
    // Hệ số nhân THẲNG vào dmg cuối (không đi qua saturateBonusPct). Mặc định 1.
    let outgoingDmgMul = 1;
    // "Dullahan" (Fused Blade passive) — xác nhận trực tiếp: "Khi có Dullahan
    // bạn nhận được 30% Dmg gây ra".
    if ((attacker.dullahanStacks ?? 0) > 0) bonusPct += 30;
    // "Eye Of Horus" (Foreclosure Task Force President) — GAP ĐÃ SỬA (xác nhận
    // trực tiếp): "Dưới hoặc bằng 2 lần: Đòn đánh thường nay sẽ được gia tăng
    // thêm 50% sát thương" — HOÀN TOÀN chưa từng được tự động hoá trước đây
    // (chỉ có số volley/base dice, KHÔNG có +50% dmg) — phát hiện qua test
    // thật: bắn lần 1 ra 72 thay vì 108 kỳ vọng (kết quả "108" trước đó hoá ra
    // là do tôi NHẦM gán cho Karmic Consequence, không liên quan gì thật).
    if (eyeOfHorusNewCount !== null && eyeOfHorusNewCount <= 2) bonusPct += 50;
    // "Index Proselyte" (Karmic Consequence) — GAP ĐÃ SỬA LẦN 2 (xác nhận
    // trực tiếp): "karmicconsequence ở trên là khiến người có nó nhận thêm
    // dmg% nhận vào chứ không phải tăng dmg% gây ra. Nó là debuff ấy" — đây là
    // DEBUFF lên chính TARGET (người đang có Karmic Consequence chịu thêm dmg
    // khi bị đánh), KHÔNG PHẢI buff cho attacker — check target, không phải
    // attacker (giống hệt pattern "target.staggered" ngay dưới).
    // ❗ DÒNG NÀY ĐÃ CHUYỂN XUỐNG KHỐI dmgTakenPct (Fragaria 12/08: "Karmic
    // Consequence là DmgTaken"). Giữ lại ở đây là ĐẾM HAI LẦN — chính đo thật
    // đã lôi ra: Karmic 40 cho `dmgTakenPct = 40` VÀ `bonusPct = 40`.
    // (Karmic còn từng có đường thứ 3: `incomingDmgMul` ở index.js, cũng đã bỏ.)
    // "Thumb Capo IIII" (outfit) — xác nhận trực tiếp: "Các vũ khí/skill/page
    // sử dụng đạn sẽ được tăng thêm 20% Dmg gây ra" — "chỉ áp dụng khi đòn đó
    // THỰC SỰ tiêu đạn/Round nào đó trong lượt này" — check stack > 0 TRƯỚC
    // khi resolveOnePendingAction's consumption hook chạy (sẽ tự tiêu nếu đủ,
    // theo xác nhận "tự động tiêu nếu đủ Stack, giống Bleed/Burn tự áp").
    if (attacker.equippedOutfit === "Thumb Capo IIII") {
      const willConsumeScorch = ["savage double slash", "savage triple slash", "blasting shatterslash", "tanglecleaver flurry"].includes(skillKey) && (attacker.scorchPropellantRound ?? 0) > 0;
      const willConsumeTigermark = skillKey === "triple slash blast [爆]" && (attacker.tigermarkRound ?? 0) > 0;
      const willConsumeSavageTigermark = skillKey === "savage tigerslayer's perfected flurry of blades [超絕猛虎殺擊亂斬]" && (attacker.savageTigermarkRound ?? 0) > 0;
      const willConsumeEyeOfHorusAmmo = isM1 && attacker.weaponName === "Eye Of Horus" && ((attacker.eyeOfHorusAmmo ?? 0) > 0 || (attacker.frostAmmo ?? 0) > 0 || (attacker.incendiaryAmmo ?? 0) > 0);
      if (willConsumeScorch || willConsumeTigermark || willConsumeSavageTigermark || willConsumeEyeOfHorusAmmo) bonusPct += 20;
    }
    // "Dark Cloud" (Kurokumo Wakashu outfit passive) — xác nhận trực tiếp:
    // "Bạn nhận 1% Dmg Up với mỗi 1 Bleed có trên người địch" — áp dụng CẢ
    // M1 lẫn Skill/Critical (xác nhận trực tiếp: "áp dụng chung mọi loại đòn").
    if (attacker.equippedOutfit === "Kurokumo Wakashu") bonusPct += (target.bleed ?? 0) * 1;
    // "The Middle Little/Big Sibling" (outfit) — GAP MỚI (xác nhận trực tiếp):
    // "tăng 10% Dmg gây ra với mỗi Stack" Enhancement Tattoos — áp dụng CẢ M1
    // lẫn Skill/Critical (không giới hạn, cùng tinh thần Kurokumo Wakashu).
    if (attacker.equippedOutfit === "The Middle Little Sibling" || attacker.equippedOutfit === "The Middle Big Sibling") {
      bonusPct += (attacker.enhancementTattoosStack ?? 0) * 10;
    }
    // "The Middle Big Sibling" — GAP MỚI (xác nhận trực tiếp): "+15% Dmg bản
    // thân gây ra" (KHÔNG chỉ Blunt, TOÀN BỘ) nếu địch có Vengeance Mark —
    // khác The Middle Little Sibling (chỉ +10% Dmg Blunt, xem damage-calc.js
    // hoặc nơi resistance/type được áp — đã lọc theo dmgStr type ở đó).
    if (attacker.equippedOutfit === "The Middle Big Sibling" && (target.vengeanceMark ?? 0) > 0) bonusPct += 15;
    // "The Middle Little Sibling" — GAP MỚI (xác nhận trực tiếp): "+10% Dmg
    // Blunt" — CHỈ khi dmgStr có hit Blunt (khác Big Sibling — toàn bộ, không
    // giới hạn type). Regex tránh nhầm với "Bleed"/chữ khác theo sau "B".
    if (attacker.equippedOutfit === "The Middle Little Sibling" && (target.vengeanceMark ?? 0) > 0 && /\dB(?![a-zA-Z])/.test(dmgStr ?? "")) bonusPct += 10;
    // "Blade Lineage Mentor" (outfit) — GAP MỚI (xác nhận trực tiếp): "gia
    // tăng 30% Dmg Slash" khi Rending đang active (kéo dài đến hết turn, xem
    // resolve-pending-action.js/turn-advance.js) — regex tránh nhầm "Sinking".
    if (attacker.equippedOutfit === "Blade Lineage Mentor" && attacker.renderingActive && /\dS(?![a-zA-Z])/.test(dmgStr ?? "")) bonusPct += 30;
    // GAP ĐÃ SỬA (xác nhận trực tiếp: "các status làm tăng dmg nhận đơn giản là
    // gộp làm một với dmg bonus nên là vẫn bão hòa thôi. Tuy nhưng khác biệt của
    // nó với Dmg Bonus là người khác cũng có thể hưởng lợi do là debuff lên
    // người kẻ địch") — CHUYỂN 6 status "tăng dmg nhận" (debuff áp lên TARGET,
    // BẤT KỲ ai tấn công target đó đều hưởng lợi) từ computeDefenderDmgReduction
    // (saturateDR — SAI, đó là công thức riêng cho REDUCTION của defender) sang
    // ĐÂY (bonusPct — ĐÚNG, cùng pool với dmg bonus của attacker, cùng đi qua
    // saturateBonusPct trong calcMathCore).
    // ❗❗ UPDATE LUẬT (Fragaria 12/08, đã thông báo cho player):
    //   FinalDmg = BaseDmg × (1 + %Bonus + %SanityBonus + **%DmgTaken**) × …
    // 6 status dưới đây là DEBUFF TRÊN NGƯỜI ĐỊCH ("địch nhận thêm X% Dmg"),
    // trước đây bị gộp thẳng vào `bonusPct` nên phải dùng chung đường bão hoà
    // của Dmg Bonus — vốn đã ngập vì buff của người tấn công ⇒ Fragile và đồng
    // loại gần như vô dụng. NAY dồn vào `dmgTakenPct` riêng, bão hoà theo bảng
    // riêng (0–50% 1:1 · 50–100% 1:0.25 · 100%+ 1:0.125 — saturateDmgTakenPct).
    // ⚠️ CÁCH NHẬN BIẾT một hiệu ứng thuộc nhóm nào (Fragaria chốt): nó là
    // DEBUFF nằm TRÊN NGƯỜI ĐỊCH (ai đánh con đó cũng hưởng) ⇒ DmgTaken;
    // còn BUFF nằm trên NGƯỜI DÙNG ⇒ DmgBonus. Mọi cách viết trong desc —
    // "tăng dmg nhận thêm", "địch nhận thêm dmg", "DmgTaken", "dmg phải nhận
    // thêm" — đều là MỘT thứ: DmgTaken.
    // Karmic Consequence — Fragaria chốt 12/08: "Karmic Consequence LÀ DmgTaken".
    // Trước đây nó là hệ số nhân riêng NGOÀI ngoặc (`incomingDmgMul`), không bão
    // hoà gì. Nay vào đúng pool DmgTaken: +1%/stack, trần KARMIC_MAX.
    dmgTakenPct += Math.min(KARMIC_MAX ?? 100, target.karmicConsequence ?? 0) * 1;
    dmgTakenPct += (target.fragile ?? 0) * 1;
    // Dòng dice "địch nhận thêm X% Dmg [từ Type] turn này" (mặt Caduceus 4/6/7/8).
    // Loại "mọi loại" cộng thẳng; loại theo TYPE chỉ cộng khi đòn này CÓ hit type
    // đó — regex tránh nhầm "B" của Bleed / "S" của Sinking (cùng cách đã dùng
    // cho The Middle Little Sibling ở trên).
    dmgTakenPct += target.dmgTakenPctTurn ?? 0;
    const dtByType = target.dmgTakenPctByType ?? {};
    if ((dtByType.B ?? 0) > 0 && /\dB(?![a-zA-Z])/.test(dmgStr ?? "")) dmgTakenPct += dtByType.B;
    if ((dtByType.P ?? 0) > 0 && /\dP(?![a-zA-Z])/.test(dmgStr ?? "")) dmgTakenPct += dtByType.P;
    if ((dtByType.S ?? 0) > 0 && /\dS(?![a-zA-Z])/.test(dmgStr ?? "")) dmgTakenPct += dtByType.S;
    if (isM1) dmgTakenPct += (target.smoke ?? 0) * 2.5;
    if (isMiddleSkill) dmgTakenPct += (target.vengeanceMark ?? 0) * 5;
    if ((target.tremorDecay ?? 0) > 0) dmgTakenPct += Math.floor((target.tremor ?? 0) / 4) * 1;
    if (target.gazeAwe > 0 && target.gazeAweSourceId === attackerId) dmgTakenPct += target.gazeAwe * 10;
    if ((target.hemorrhage ?? 0) > 0) dmgTakenPct += target.hemorrhage * 10;
    // dmgStrRewritten khai báo NGAY ĐẦU (thay vì giữa hàm như trước) — vì Eye Of
    // Horus (BUG ĐÃ SỬA, xem chi tiết bên dưới) giờ CẦN sửa THẬT dmgStr (không chỉ
    // %bonus), và block đó nằm TRƯỚC vị trí khai báo cũ.
    let dmgStrRewritten = dmgStr;
    // BUG ĐÃ SỬA: trước đây critMul khởi tạo = 1 (không có bonus crit dmg nào trừ
    // khi có Sharp Eyes) — SAI hoàn toàn so với luật ("crit dmg [1,3x]" là mặc định
    // CHO MỌI NGƯỜI, không phải đặc quyền của 1 perk). Mọi crit từ trước tới giờ
    // (M1/Page/enemy) ĐỀU không có bonus dmg nào trừ khi attacker có Sharp Eyes —
    // lỗi không bị phát hiện vì mọi test crit trước đó đều dùng Sharp Eyes (che mất
    // bug, vì 1.5x luôn được set ĐÚNG bất kể giá trị khởi tạo là gì).
    let critMul = 1.3;
    let critDivOverride = null;
    let instantKill = null;
  
    // GAP ĐÃ SỬA (xác nhận trực tiếp, sau khi user cung cấp mô tả đầy đủ 50+
    // status): "Red Plum Blossom" — "khi có Red Plum Blossom trên người kẻ địch
    // sẽ giúp bản thân tăng 10% Critical" — TRƯỚC ĐÂY dùng redPlumBlossomPoiseBonus
    // (dead code — field này KHÔNG BAO GIỜ được định nghĩa ở đâu cả, luôn = 0,
    // hoàn toàn không có tác dụng) để cộng vào Poise — SAI hoàn toàn so với mô
    // tả gốc (không liên quan gì tới Poise). Sửa đúng: +0.1 vào critMul (nhất
    // quán với critMul=1.3 mặc định đã có sẵn — "+10% Critical" = +10% hệ số
    // nhân khi Crit, không phải tỉ lệ NÉM ra Crit).
    if ((target.redPlumBlossom ?? 0) > 0) critMul += 0.1;
  
    // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit, batch 4) — "The
    // Imitation" (Mimicry Blade): mỗi 1 Imitation đã TIÊU THỤ (qua Great Split)
    // → +5% Dmg Bonus kéo dài tới hết Encounter, cap 50% (= 10 Imitation tiêu).
    // Không cần check weaponName ở đây — imitationConsumedTotal chỉ tăng khi
    // dùng ĐÚNG Great Split với Mimicry Blade (xem index.js), không nơi nào khác.
    // "The Mimic" (Manifested E.G.O: Red Mist) — Ở DẠNG LƯỠI HÁI: "hiệu ứng Dmg
    // Bonus từ Passive The Imitation được gia tăng GẤP ĐÔI".
    // ⚠️ CAP GIỮ NGUYÊN 50% (Fragaria đính chính: "The Imitation passive gốc của
    // Mimicry Blade cap nó vẫn là 50% Dmg Bonus thôi"). Nhân đôi ở đây là nhân
    // TỐC ĐỘ TÍCH, không phải nới trần: 5 Imitation đã tiêu (1 lần Great Split)
    // ở dạng lưỡi hái đã chạm thẳng 50%, thay vì phải tiêu đủ 10.
    // Bản trước tôi nhân đôi cả cap thành 100% — SAI, và lập luận "kẹp 50% thì
    // passive vô dụng" cũng sai: bonus kéo dài HẾT ENCOUNTER nên 2 lần Great
    // Split là ăn trọn 50% vĩnh viễn.
    const imitationMul = (attacker.mimicSyncActive && attacker.mimicryForm === "scythe") ? 2 : 1;
    bonusPct += Math.min(50, (attacker.imitationConsumedTotal ?? 0) * 5 * imitationMul);
    // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit, batch 5) — "The
    // Udjat" (Udjat Khopesh): mỗi 1 Protection hiện có → +1% Dmg Bonus (không
    // tiêu thụ, khác The Imitation — chỉ cần ĐANG CÓ, không cap theo document
    // gốc nhưng thực tế Protection tự cap 20 từ combatant-factory.js).
    if ((attacker.weaponName ?? "").toLowerCase() === "udjat khopesh") {
      bonusPct += (attacker.protection ?? 0);
    }
    // Karmic Consequence — BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận trực tiếp: "nhận
    // thêm 1% Dmg cho mỗi 1 Stack... là dmg BẢN THÂN NHẬN VÀO chứ không phải
    // gây ra") — ĐÃ XOÁ khỏi đây (outgoing dmg bonus) — chuyển đúng qua incoming
    // dmg taken, cùng chỗ với Fragile (xem index.js's resolveOnePendingAction).
    // Will of Prescript (Index Longsword/Cleaver): +5% Dmg/Grace of Prescript,
    // CHỈ khi target hiện tại ĐÚNG LÀ enemy đang bị đánh dấu "The Prescript
    // Target's - The Index" (prescriptTargetId).
    // ❗ GỘP (trước đây CỘNG HAI LẦN): khối này (+5%/Grace, Index Longsword) và
    // khối tôi thêm cho Caduceus (+10%/Grace) đều chạy ⇒ 4 Grace ra **60%** thay
    // vì 40%. Hai vũ khí có cùng TÊN passive "Will of Prescript" nhưng KHÁC hệ số,
    // nên phải chọn hệ số theo VŨ KHÍ ĐANG CẦM, không cộng dồn cả hai.
    if (targetId && attacker.prescriptTargetId === targetId) {
      const isCaduceus = attacker.weaponName === "Oracle Device [Caduceus]";
      bonusPct += (isCaduceus ? 10 : 5) * (attacker.graceOfPrescript ?? 0);
    }
    // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit) — "Ambitious Fixer"
    // (outfit): "Gia tăng 10% Dmg Slash" — dùng weaponType làm proxy hợp lý
    // (thông tin sẵn có duy nhất về loại dmg đang dùng, vì không có tham số
    // "dmgType" riêng truyền vào hàm này).
    if (attacker.hasAmbitiousFixer && (attacker.weaponType ?? "").toLowerCase() === "slash") {
      bonusPct += 10;
    }
    // "Thumb Soldato" (outfit): "Các vũ khí/skill/page sử dụng đạn sẽ được tăng
    // thêm 15% Dmg gây ra" — CHỈ khi đòn này THỰC SỰ đang tiêu đạn (willUseBullet).
    if (attacker.hasThumbSoldato && willUseBullet) {
      bonusPct += 15;
    }
    // "Dieci Association": "Khi có trên hoặc bằng 20 Shield HP bạn nhận được
    // 15% Dmg Up".
    if (attacker.hasDieciAssociation && (attacker.shieldHp ?? 0) >= 20) {
      bonusPct += 15;
    }

    // Battle Ignition: turn trước đánh ≥10 lần → +15% Dmg turn này
    if (hasPerk(attacker, "Battle Ignition") && (attacker.lastTurnAttackCount ?? 0) >= 10) bonusPct += 15;
    // Manifested E.G.O đang active: +30% Dmg M1+skill bản thân gây ra — cơ chế GỐC
    // của game (không phải Skill Tree perk), không cần hasPerk gate.
    // Manifested E.G.O — +30% Dmg là NỀN CHUNG của MỌI Manifested E.G.O
    // (Fragaria đính chính: "cái cơ bản của Manifested E.G.O là điểm chung của
    // toàn bộ Manifested E.G.O"). Passive riêng của từng E.G.O CỘNG DỒN lên nền
    // này, KHÔNG ghi đè.
    // ── R CORP / DAWN OFFICE keypage (Fragaria 14/08) ──────────────────────
    // Maximum Crash (Rhino): >20 Charge ⇒ +50% Dmg gây ra. Vế "giảm 50% dmg nhận"
    // là REDUCTION của defender ⇒ nằm ở computeDefenderDmgReduction, KHÔNG ở đây
    // (trộn hai chiều vào một chỗ là đúng bug Karmic đã dính).
    if (attacker.hasRhinoRCorp && (attacker.charge ?? 0) > 20) bonusPct += 50;
    // Lone Fixer (Yuna): khi là NGƯỜI SỐNG SÓT CUỐI CÙNG ⇒ +50% Dmg.
    // Vế "+15% Dmg Reduction" cũng thuộc defender ⇒ để bên kia.
    if (attacker.hasDawnYuna && attacker.loneFixerActive) bonusPct += 50;
    // Salvador: dưới 50% HP và skill NÀY gây Burn ⇒ +15% Dmg.
    if (attacker.hasDawnSalvador && (attacker.currentHp ?? 0) < (attacker.maxHp ?? 1) * 0.5
        // ⚠️ KHÔNG dùng `\bBurn\b`: trong dmgStr thật (`100B+3Burn`) ranh giới từ
        // nằm giữa `3` và `B` nên `\b` KHÔNG khớp — test bắt được (0 → 0).
        && /Burn/i.test(String(dmgStr ?? ""))) {
      bonusPct += 15;
    }
    if (attacker.manifestedEGO) bonusPct += 30;
    // "The Strongest" (Red Mist) — +100% CỘNG THÊM ⇒ tổng 130% khi Manifest.
    if (attacker.theStrongestActive) bonusPct += 100;
    // Wound-Casing Mask — "cứ mỗi 1 Poise thừa SAU 20 nhận 2% Dmg Bonus".
    if (attacker.hasWoundCasingMask) {
      const extraPoise = Math.max(0, (attacker.poise ?? 0) - 20);
      if (extraPoise > 0) bonusPct += extraPoise * 2;
    }
    // ── EROSION (Falco Berigora) ─────────────────────────────────────────────
    // Fragaria chốt: *"+0,1x res lên kẻ địch của Erosion CHỈ BẢN THÂN NGƯỜI GÂY RA
    // Erosion mới được hưởng thôi, những người khác thì không."*
    // ⇒ Erosion KHÔNG phải debuff Res chung trên mục tiêu — nó là bonus RIÊNG cho
    //   người đã áp. Nên lưu theo NGƯỜI GÂY (`erosionBy[attackerId]`) chứ không
    //   phải một con số chung; nếu lưu chung thì cả party ăn ké, sai luật.
    // ⚠️ ĐÍNH CHÍNH (Fragaria): *"Logic Erosion +10% Dmg sẽ gây BÃO HOÀ, còn
    // +0,1x res như text description thì KHÔNG."*
    // Đúng — `bonusPct` đi qua `saturateBonusPct()` nên +10%/stack bị cắt dần khi
    // bonus đã cao. Res thì nhân THẲNG vào dmg (`instanceDmg * currentRes`), tuyến
    // tính hoàn toàn. Nên Erosion phải là **cộng Res**, không phải cộng bonusPct.
    // Trả ra `resBonusFlat` để nơi gọi cộng vào resStr của mục tiêu.
    const myErosion = (target?.erosionBy ?? {})[attackerId] ?? 0;
    const resBonusFlat = myErosion * 0.1; // +0,1x Res mỗi stack, CHỈ người gây được hưởng
    // (Will of Prescript đã gộp ở khối phía trên — KHÔNG cộng lại ở đây.)
    // Shattered E.G.O — "mọi sát thương của bản thân bị giảm MỘT NỬA" trong 3
    // Turn. Đây là chia đôi dmg CUỐI, không phải -50% bonus: -50 vào bonusPct sẽ
    // đi qua saturateBonusPct (đường cong bão hoà) nên KHÔNG ra đúng một nửa.
    // Xử lý bằng hệ số nhân riêng `outgoingDmgMul` (xem nơi đọc ở damage-calc).
    if ((attacker.shatteredEgoTurnsLeft ?? 0) > 0) outgoingDmgMul *= 0.5;
    // Chấn thương nặng "Mất tay": -50% sát thương gây ra — cơ chế GỐC, không cần unlock.
    if ((attacker.injuries ?? []).includes("Mất tay")) bonusPct -= 50;
    // Backdraft: Stamina ≤50 (xấp xỉ "lúc turn start" bằng Stamina hiện tại, vì không
    // lưu snapshot riêng lúc turn start) → +20% Dmg. BUG ĐÃ SỬA: trước đây dùng >=50
    // (Stamina CAO mới buff) — ĐẢO NGƯỢC hoàn toàn ý nghĩa perk so với luật ("dưới
    // hoặc bằng 50 Stamina" — buff khi Stamina THẤP, hợp lý với tên "Backdraft").
    if (hasPerk(attacker, "Backdraft") && attacker.currentStamina <= 50) bonusPct += 20;
    // ❗ Fragaria chốt 12/08: "Death Comes For All là DmgTaken", "Break and Punish
    // là DmgTaken". Tôi đã xếp nhầm cả hai vào DmgBonus ở phiên trước (lý do:
    // chúng là PERK của người tấn công). Luật thật đi theo CÁI MÀ HIỆU ỨNG NHÌN
    // VÀO: cả hai đều kích khi ĐỊCH đang ở trạng thái nào đó (Rupture / Stagger)
    // ⇒ thuộc pool DmgTaken, bão hoà theo saturateDmgTakenPct.
    // (Đối chiếu: Kurokumo Wakashu và Middle Big/Little Sibling — Fragaria xác
    // nhận VẪN là DmgBonus dù cũng nhìn vào status địch, vì chúng là OUTFIT.)
    if (hasPerk(attacker, "Death Comes For All") && target.rupture > 0) dmgTakenPct += 30;
    if (hasPerk(attacker, "Break and Punish") && target.staggered) dmgTakenPct += 20;
    // Kinetic Energy: CHỈ áp cho M1, cần ≥10 Charge → +10% Dmg
    if (isM1 && hasPerk(attacker, "Kinetic Energy") && attacker.charge >= 10) bonusPct += 10;
    // Tip-Toe Around (Wrath, [25 Points]): sau khi Parry thành công, đòn tấn công
    // KẾ TIẾP +10% Dmg — tiêu thụ cờ NGAY khi tính bonus cho đòn này (chỉ áp 1 lần).
    if (attacker.tipToeBonusPending) {
      bonusPct += 10;
      attacker.tipToeBonusPending = false;
    }
    // Wail: bản thân dưới -25 Sanity → +10% Dmg
    if (hasPerk(attacker, "Wail") && attacker.currentSanity < -25) bonusPct += 10;
    // Borderline Breakdown: mỗi -5 Sanity (âm) → +2% Dmg, tối đa 18%
    if (hasPerk(attacker, "Borderline Breakdown") && attacker.currentSanity < 0) {
      bonusPct += Math.min(18, Math.floor(-attacker.currentSanity / 5) * 2);
    }
    // Sharp Eyes: Crit dmg multiplier → 1.5x (thay 1.3x mặc định)
    if (hasPerk(attacker, "Sharp Eyes")) critMul = 1.5;
    // Steady Breathing: Poise crit chia 1.5 thay vì giảm nửa (critDiv override)
    if (hasPerk(attacker, "Steady Breathing")) critDivOverride = 1.5;
    // Overcharged Vessel: đang active (overchargedTurnsLeft > 0) → +N% Dmg đã tính
    // sẵn lúc kích hoạt (xem -encounter overcharge). Dice Up bonus KHÔNG tự áp được
    // (ảnh hưởng lúc roll skill tay qua -skill, không phải lúc tính dmgStr ở đây) —
    // chỉ hiện trong status để player tự cộng tay lúc roll.
    if ((attacker.overchargedTurnsLeft ?? 0) > 0) bonusPct += attacker.overchargedDmgBonusPct ?? 0;
    // Mặt 3 Caduceus "bản thân +10% Dmg turn sau" — BUFF trên NGƯỜI DÙNG ⇒ đúng
    // là DmgBonus (không phải DmgTaken). turn-advance đổ pending → ô này.
    bonusPct += attacker.caduceusDmgUpPct ?? 0;
  
    // Eye Of Horus — passive vũ khí "Foreclosure Task Force President" (CHỈ áp cho
    // M1 — "nếu đánh thường"). MÔ HÌNH ĐÃ SỬA HOÀN TOÀN LẦN THỨ 2 (xác nhận trực
    // tiếp từ GM kèm 8 ví dụ cụ thể N=1..8) — trước đây hiểu "N lần" là ĐẾM CỘNG
    // DỒN qua NHIỀU LẦN bấm M1 riêng biệt lên CÙNG 1 target (m1CountThisTurnByTarget
    // counter) — SAI HOÀN TOÀN. Đúng phải là: "N lần" = SỐ VOLLEY người chơi TỰ
    // CHỌN bắn NGAY TRONG 1 HÀNH ĐỘNG duy nhất (giống chọn "đánh mấy lần" của vũ
    // khí thường, nhưng đơn vị là VOLLEY 9-hit thay vì HIT đơn lẻ) — KHÔNG CÓ
    // counter nào cả, N luôn được cung cấp TRỰC TIẾP bởi nơi gọi (verifyOpts /
    // modal / text command param "volleys:"), tính ĐỘC LẬP mỗi hành động, mỗi
    // target riêng biệt (không có state gì lưu lại giữa các hành động).
    //
    // Công thức (verify khớp chính xác cả 8 ví dụ N=1..8 GM cho):
    //   totalVolleys = N + (N===1 ? 1 : 0)   // Repeat Ammo = +1 volley CHỈ khi N=1
    //   base         = N<=6 ? 4 : 3          // "Base dmg nâng lên 4x9" nếu ≤6 lần
    //   bonusPct    += N<=3 ? 50 : 0          // "+50% sát thương" nếu ≤3 lần
    //   tremorCharge = 2 * totalVolleys       // "mỗi lần đánh thường: +2 Tremor +2
    //                                         // Charge" — nhân theo SỐ VOLLEY THẬT
    //                                         // (bao gồm cả volley Repeat Ammo)
    // dmgStr đã được XÂY DỰNG SẴN ở nơi gọi (đủ totalVolleys term nối bằng "+",
    // đúng base) — hàm này KHÔNG rewrite dmgStr nữa (khác cách cũ), chỉ cần tính
    // bonusPct + tremorChargeAmount dựa trên N nhận được.
    //
    // "Mỗi lần đánh thường: +2 Tremor +2 Charge" — Tremor gắn lên TARGET (kẻ địch),
    // Charge gắn lên BẢN THÂN (đã sửa ở lần trước — vẫn giữ nguyên đúng).
    let eyeOfHorusTremorChargeAmount = 0;
    if (isM1 && eyeOfHorusVolleys && (attacker.weaponName ?? "").toLowerCase() === "eye of horus") {
      const N = eyeOfHorusVolleys;
      const totalVolleys = N + (N === 1 ? 1 : 0);
      // GAP ĐÃ SỬA (xác nhận trực tiếp — passive text cập nhật): "Dưới hoặc bằng
      // 2 lần: +50% sát thương" — TRƯỚC ĐÂY sai ngưỡng (N<=3), giờ đúng N<=2.
      if (N <= 2) bonusPct += 50;
      eyeOfHorusTremorChargeAmount = 2 * totalVolleys;
    }
  
    // Unopposed Attack Boost (50-Status Nhóm 1): "+15% dmg nếu chiêu KHÔNG bị
    // Clash, +30% thêm nếu địch Stagger". Trong hệ thống HIỆN TẠI, -encounter clash
    // là 1 THAO TÁC TÁCH BIỆT (so 2 bên trực tiếp), KHÔNG can thiệp/chặn bất kỳ
    // pending action (attack/hit) nào — nên "KHÔNG bị Clash" LUÔN ĐÚNG cho mọi
    // attack/hit thông thường đi qua đây (không có cơ chế nào trong code khiến 1
    // action "bị Clash"), do đó +15% LUÔN áp dụng khi có status này. Phần +30% có
    // điều kiện RÕ RÀNG (target.staggered), check được chính xác.
    if ((attacker.unopposedAttackBoost ?? 0) > 0) {
      bonusPct += 15;
      if (target.staggered) bonusPct += 30;
    }
  
    // Claim Their Heart: target Stagger + dưới 15% HP → kết liễu ngay
    if (hasPerk(attacker, "Claim Their Heart") && target.staggered && target.currentHp > 0 && target.currentHp < target.maxHp * 0.15) {
      instantKill = "Claim Their Heart — Stagger + dưới 15% HP";
    }
  
    // Overwhelming Power (Shin, [50 Points]): đòn tấn công có Mang (attacker đang
    // shinMangActive) lên target dưới 10% HP → kết liễu ngay.
    if (hasPerk(attacker, "Overwhelming Power") && attacker.shinMangActive && target.currentHp > 0 && target.currentHp < target.maxHp * 0.1) {
      instantKill = "Overwhelming Power — Mang + dưới 10% HP";
    }
  
    // Multiplier áp status — viết lại dmgStr TRƯỚC khi đưa vào calcMathCore.
    // (dmgStrRewritten đã khai báo ở đầu hàm, chỉ tiếp tục dùng ở đây)
    if (hasPerk(attacker, "Tear To Shreds")) dmgStrRewritten = applyStatusMultiplierToDmgStr(dmgStrRewritten, "Rupture", 1.5);
    if (hasPerk(attacker, "A Beautiful Mess") && target.bleed >= 7) dmgStrRewritten = applyStatusMultiplierToDmgStr(dmgStrRewritten, "Bleed", 1.5);
    if (hasPerk(attacker, "Cry On Deaf Ears") && attacker.currentSanity < -25) dmgStrRewritten = applyStatusMultiplierToDmgStr(dmgStrRewritten, "Sinking", 1.5);
    if (hasPerk(attacker, "Inner Ardor")) {
      const burnMul = attacker.emotionLevel >= 2 ? 2 : attacker.emotionLevel === 1 ? 1.5 : 1;
      dmgStrRewritten = applyStatusMultiplierToDmgStr(dmgStrRewritten, "Burn", burnMul);
    }
    // Biting Embrace/Shockwave: target Stagger + hit có gây Rupture/Tremor → +5 nữa.
    // Chỉ áp khi dmgStr THỰC SỰ có tag tương ứng (không tự thêm tag mới nếu hit gốc
    // không nhắm tới status đó).
    if (target.staggered) {
      if (hasPerk(attacker, "Biting Embrace") && /\+\d*Rupture/i.test(dmgStrRewritten)) {
        dmgStrRewritten = dmgStrRewritten.replace(/\+(\d*)Rupture/gi, (m, n) => `+${(n ? parseInt(n, 10) : 1) + 5}Rupture`);
      }
      if (hasPerk(attacker, "Shockwave") && /\+\d*TremorBurst/i.test(dmgStrRewritten) === false && /[+-]\d*Tremor/i.test(dmgStrRewritten)) {
        dmgStrRewritten = dmgStrRewritten.replace(/\+(\d*)Tremor(?!Burst)/gi, (m, n) => `+${(n ? parseInt(n, 10) : 1) + 5}Tremor`);
      }
      if (hasPerk(attacker, "Wasted Hours, Lying Down") && /\+TremorBurst/i.test(dmgStrRewritten)) {
        // Gấp đôi Tremor Burst lên Stagger — nhân số LẦN burst (TremorBurst count), không phải tăng count Tremor.
        dmgStrRewritten = dmgStrRewritten.replace(/\+(\d*)TremorBurst/gi, (m, n) => `+${(n ? parseInt(n, 10) : 1) * 2}TremorBurst`);
      }
    }
  
    // Gaze[Awe]/Contempt (xác nhận trực tiếp): "mục tiêu có hiệu ứng này sẽ NHẬN
    // và GÂY thêm X% sát thương LÊN kẻ đã gắn nó" — đây là NỬA "GÂY" của mutual
    // bonus: nếu CHÍNH attacker (đang tấn công) có Gaze[Awe]/Contempt do target
    // HIỆN TẠI gắn lên, attacker tự gây thêm dmg. BUG ĐÃ SỬA (double-counting):
    // trước đây nhầm dùng target.gazeAwe (test thực tế cho 169=100×1.3² thay vì
    // 130=100×1.3 — chứng tỏ bonus bị cộng 2 lần cùng 1 hit) — SAI vì đó là kiểm
    // tra "target có Gaze[Awe] không", không phải "attacker có Gaze[Awe] không".
    // Nửa "NHẬN" còn lại nằm ở `dmgTakenPct` NGAY TRONG FILE NÀY (dòng có
    // `target.gazeAwe > 0 && target.gazeAweSourceId === attackerId`).
    // ⚠️ ĐÍNH CHÍNH — comment cũ ghi nhầm là ở `computeDefenderDmgReduction`
    // (misc-helpers.js). Grep file đó: KHÔNG có `gazeAwe` nào cả. Ai tin comment
    // cũ rồi "bổ sung" nửa NHẬN vào misc-helpers sẽ tạo ra ĐÚNG bug Karmic
    // Consequence: một hiệu ứng đi hai đường song song, mạnh gấp đôi ý định, mà
    // đọc riêng lẻ đường nào cũng thấy hợp lý.
    // Hai nửa hiện tại KHÔNG chồng nhau vì điều kiện khác nhau — nửa GÂY hỏi
    // "ATTACKER có giữ stack không", nửa NHẬN hỏi "TARGET có giữ stack không".
    if (attacker.gazeAwe > 0 && attacker.gazeAweSourceId === targetId) bonusPct += attacker.gazeAwe * 10;
    if (attacker.contempt > 0 && attacker.contemptSourceId === targetId) bonusPct -= 50;
    // Gaze of Contempt/Contempt of the Gaze — SELF-buff của ATTACKER, không liên
    // quan gì tới target đang đánh (khác 2 cái trên).
    if ((attacker.gazeOfContempt ?? 0) > 0) bonusPct += attacker.gazeOfContempt * 7;
    if (attacker.contemptOfTheGaze) bonusPct -= 70;
    // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit) — "Cinq Association":
    // "Nhận được 7% Crit Rate với mỗi 2 Haste (Tối đa 25%)" — ghép thêm tag
    // "+NCrit" vào dmgStrRewritten (calcMathCore parse effectsStr qua regex
    // /\+Crit(\d+)/i cho bonusCritRate — dùng đúng cơ chế có sẵn, không cần sửa
    // signature calcMathCore).
    if (attacker.hasCinqAssociation) {
      const cinqCritPct = Math.min(25, Math.floor((attacker.haste ?? 0) / 2) * 7);
      if (cinqCritPct > 0) dmgStrRewritten += ` +${cinqCritPct}Crit`;
    }

    // "Waltz In Black" (Page): "Nếu turn trước địch dính Waltz In White: skill
    // này thành 3x Dice Multiplier và Unevadeable" — xác nhận trực tiếp: track
    // trên TARGET (không phải người dùng), round-based (không phải turn riêng
    // của ai) — bất kỳ ai dùng Waltz In Black cũng được hưởng nếu target ĐÃ bị
    // Waltz In White đánh trúng ở round TRƯỚC (waltzInWhiteHitLastRound, reset
    // mỗi round mới ở advanceCombatantTurn). Phần "Unevadeable" áp dụng riêng ở
    // nơi gọi hàm này (doPlayerHit) vì cần sửa defenseBypass, không chỉ bonusPct.
    const waltzInBlackMultiplier = (skillKey === "waltz in black" && target?.waltzInWhiteHitLastRound) ? 3 : 1;

    // "Blade Lineage Salsu" (outfit) — GAP MỚI (xác nhận trực tiếp): "add vào
    // base dmg của page/critical theo 1/2 lượng Poise" — CHỈ áp cho
    // skill/Critical (isM1=false), tiêu ngay sau khi dùng (chỉ áp 1 lần/turn,
    // không phải mỗi đòn).
    let flatDmgBonus = 0;
    if (!isM1 && attacker.equippedOutfit === "Blade Lineage Salsu" && (attacker.blSalsuBonusDmgPending ?? 0) > 0) {
      flatDmgBonus = attacker.blSalsuBonusDmgPending;
      attacker.blSalsuBonusDmgPending = 0;
    }

    // Providence of the Prescript — "nhận Poise theo cách trên 3 lần thì vào TURN KẾ

    // Crit Mul của bạn được cộng thêm 0.3". Cờ do turn-advance chốt sổ cuối turn.

    if (attacker.providenceCritMulNextTurn) critMul = (critMul ?? 1) + 0.3;

    return { resBonusFlat, bonusPct, dmgTakenPct, critMul, critDivOverride, dmgStrRewritten, instantKill, eyeOfHorusTremorChargeAmount, waltzInBlackMultiplier, flatDmgBonus, outgoingDmgMul };
  }
  

  return { computeAttackerPerkContext };
};
