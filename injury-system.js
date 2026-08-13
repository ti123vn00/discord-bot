// injury-system.js
// getParryClashPenalty + rollInjury (hệ thống chấn thương ngẫu nhiên) — tách
// khỏi index.js theo yêu cầu trực tiếp: "tiếp tục tách đi". Cả 2 THUẦN, chỉ cần
// SEVERE_INJURIES/MINOR_INJURIES (const, định nghĩa TRƯỚC vị trí gốc — an toàn).
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ SEVERE_INJURIES, MINOR_INJURIES }) {

  function getParryClashPenalty(combatant) {
    const injuries = combatant.injuries ?? [];
    let penalty = 0;
    if (injuries.includes("Gãy tay")) penalty += 5;
    if (injuries.includes("Gãy chân")) penalty += 3;
    if (injuries.includes("Mất Chân")) penalty += 10;
    return penalty;
  }
  
  function rollInjury(combatant, dmgDealtThisHit) {
    if (dmgDealtThisHit <= combatant.maxHp * 0.3) return null;
    const roll = Math.random();
    let injuryName;
    if (roll < 0.10) injuryName = SEVERE_INJURIES[Math.floor(Math.random() * SEVERE_INJURIES.length)];
    else if (roll < 0.50) injuryName = MINOR_INJURIES[Math.floor(Math.random() * MINOR_INJURIES.length)];
    else return null;
  
    combatant.injuries = combatant.injuries ?? [];
    // ❗❗ BUG ĐÃ SỬA (Fragaria 12/08: "Bug chấn thương có thể bị lặp lại x2, chỉ
    // được 1 loại chấn thương thôi — như trên Gãy chân bị lặp tới 2 lần").
    // GỐC: `rollInjury` push thẳng, KHÔNG kiểm trùng ⇒ roll trúng cùng tên lần 2
    // là có 2 bản. Nguy hiểm gấp đôi ở "Gãy Xương"/"Vết thương lớn": mỗi bản
    // TRỪ TIẾP -30/-100 Max HP, và `calcInjuryMaxHpPenalty` cũng đếm cả 2 ⇒ mất
    // máu chồng chất. So khớp theo TÊN GỐC (bỏ phần "(-30 Max HP)") vì tên lưu
    // trong list đã kèm hậu tố.
    const already = combatant.injuries.some(x => String(x).startsWith(injuryName));
    if (already) return null;   // đã có loại này rồi ⇒ không nhận thêm bản thứ 2
    if (injuryName === "Gãy Xương") {
      combatant.maxHp = Math.max(1, combatant.maxHp - 30);
      combatant.currentHp = Math.min(combatant.currentHp, combatant.maxHp);
      combatant.injuries.push("Gãy Xương (-30 Max HP)");
    } else if (injuryName === "Vết thương lớn") {
      combatant.maxHp = Math.max(1, combatant.maxHp - 100);
      combatant.currentHp = Math.min(combatant.currentHp, combatant.maxHp);
      combatant.injuries.push("Vết thương lớn (-100 Max HP)");
    } else {
      combatant.injuries.push(injuryName);
    }
    return injuryName;
  }
  

  return { getParryClashPenalty, rollInjury };
};
