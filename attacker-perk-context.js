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

module.exports = function ({ hasPerk, applyStatusMultiplierToDmgStr }) {

  function computeAttackerPerkContext(attacker, target, dmgStr, { isM1 = false, targetId = null } = {}) {
    let bonusPct = 0;
    // BUG ĐÃ SỬA: trước đây critMul khởi tạo = 1 (không có bonus crit dmg nào trừ
    // khi có Sharp Eyes) — SAI hoàn toàn so với luật ("crit dmg [1,3x]" là mặc định
    // CHO MỌI NGƯỜI, không phải đặc quyền của 1 perk). Mọi crit từ trước tới giờ
    // (M1/Page/enemy) ĐỀU không có bonus dmg nào trừ khi attacker có Sharp Eyes —
    // lỗi không bị phát hiện vì mọi test crit trước đó đều dùng Sharp Eyes (che mất
    // bug, vì 1.5x luôn được set ĐÚNG bất kể giá trị khởi tạo là gì).
    let critMul = 1.3;
    let critDivOverride = null;
    let instantKill = null;
  
    // Battle Ignition: turn trước đánh ≥10 lần → +15% Dmg turn này
    if (hasPerk(attacker, "Battle Ignition") && (attacker.lastTurnAttackCount ?? 0) >= 10) bonusPct += 15;
    // Manifested E.G.O đang active: +30% Dmg M1+skill bản thân gây ra — cơ chế GỐC
    // của game (không phải Skill Tree perk), không cần hasPerk gate.
    if (attacker.manifestedEGO) bonusPct += 30;
    // Chấn thương nặng "Mất tay": -50% sát thương gây ra — cơ chế GỐC, không cần unlock.
    if ((attacker.injuries ?? []).includes("Mất tay")) bonusPct -= 50;
    // Backdraft: Stamina ≤50 (xấp xỉ "lúc turn start" bằng Stamina hiện tại, vì không
    // lưu snapshot riêng lúc turn start) → +20% Dmg. BUG ĐÃ SỬA: trước đây dùng >=50
    // (Stamina CAO mới buff) — ĐẢO NGƯỢC hoàn toàn ý nghĩa perk so với luật ("dưới
    // hoặc bằng 50 Stamina" — buff khi Stamina THẤP, hợp lý với tên "Backdraft").
    if (hasPerk(attacker, "Backdraft") && attacker.currentStamina <= 50) bonusPct += 20;
    // Death Comes For All: target có Rupture → +30% Dmg
    if (hasPerk(attacker, "Death Comes For All") && target.rupture > 0) bonusPct += 30;
    // Break and Punish: target bị Stagger → +20% Dmg
    if (hasPerk(attacker, "Break and Punish") && target.staggered) bonusPct += 20;
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
  
    // Eye Of Horus — passive vũ khí "Foreclosure Task Force President" (CHỈ áp cho
    // M1 — "nếu đánh thường") — xác nhận trực tiếp từ GM: các mốc "≤3 lần"/"≤6 lần"
    // đều tính TỪ LẦN ĐÁNH ĐẦU TIÊN (KHÔNG PHẢI ngưỡng riêng biệt "bắt đầu từ lần
    // đó") — cụ thể: lần 1-3 có CẢ +50% dmg VÀ +33,33% dmg (tương đương base 3→4/
    // hit dùng % thay vì đổi số dice thật — an toàn hơn vì hoạt động đúng cho CẢ
    // dmgStr gõ tay lẫn dmgStr tự tính từ nút "Đánh mấy lần"), lần 4-6 CHỈ +33,33%,
    // lần 7+ về bình thường. Lần ĐẦU TIÊN (count===1) CÒN có thêm "Repeat Ammo" — 1
    // hit sát thương CHUẨN bổ sung, tính tương đương +(100/hitCount)% (hitCount parse
    // từ dmgStr dạng "NxM", đúng cho M1 đơn giản — không dùng cho Page/skill phức
    // tạp, đã giới hạn isM1). "Mỗi lần đánh thường: +2 Tremor +2 Charge lên bản
    // thân" trả về qua eyeOfHorusSelfTremorCharge (KHÔNG nhét vào dmgStrRewritten vì
    // đó áp lên TARGET, không phải bản thân — cần xử lý riêng ở nơi gọi).
    let eyeOfHorusSelfTremorCharge = false;
    if (isM1 && targetId && (attacker.weaponName ?? "").toLowerCase() === "eye of horus") {
      // CHỈ PEEK (đọc, KHÔNG ghi) ở đây — hàm này chạy lúc DECLARE (build preview),
      // KHÔNG PHẢI lúc CONFIRM. BUG ĐÃ TRÁNH: nếu tự TĂNG counter ngay tại đây, GM
      // reject action này sau đó vẫn để counter tăng sai (action không thực sự xảy
      // ra) — giống bài học evadedCompletely trước đó trong dự án này. Tăng THẬT
      // (commit) chỉ xảy ra ở confirm handler — xem comment "Eye Of Horus — commit"
      // trong khối xử lý M1 lúc confirm.
      const thisAttackNumber = (attacker.m1CountThisTurnByTarget?.[targetId] ?? 0) + 1;
      if (thisAttackNumber <= 6) bonusPct += 100 / 3; // base 3→4/hit (+33,33%)
      if (thisAttackNumber <= 3) bonusPct += 50;
      if (thisAttackNumber === 1) {
        const hitCountMatch = dmgStr.match(/^[\d.]+\s*x\s*(\d+)/i);
        const hitCount = hitCountMatch ? parseInt(hitCountMatch[1], 10) : 1;
        bonusPct += 100 / hitCount; // Repeat Ammo — 1 hit chuẩn bổ sung
      }
      eyeOfHorusSelfTremorCharge = true;
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
    let dmgStrRewritten = dmgStr;
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
  
    return { bonusPct, critMul, critDivOverride, dmgStrRewritten, instantKill, eyeOfHorusSelfTremorCharge };
  }
  

  return { computeAttackerPerkContext };
};
