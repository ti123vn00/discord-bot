// damage-reduction.js
// Hàm computeDefenderDmgReduction (tổng hợp % giảm/tăng dmg nhận vào từ perk +
// 50-Status Nhóm 1: Fragile/Protection/Charge Shield) — tách khỏi index.js theo
// yêu cầu trực tiếp: "tiếp tục tách đi". HOÀN TOÀN THUẦN, chỉ cần hasPerk.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ hasPerk }) {

  function computeDefenderDmgReduction(defender) {
    let reductionPct = 0;
    if (hasPerk(defender, "Smoldering Resolve") && defender.currentHp < defender.maxHp * 0.4) reductionPct += 10;
    if (hasPerk(defender, "No Will To Break") && defender.manifestedEGO) reductionPct += 20;
    // 50-Status Nhóm 1 — Fragile TĂNG dmg nhận (dấu ÂM, ngược Protection/Charge
    // Shield vốn GIẢM dmg nhận). Charge Shield reset về 0 SAU MỖI LẦN áp dụng (xem
    // nơi gọi hàm này lúc confirm — decrement ngay sau khi tính finalDmg).
    reductionPct -= (defender.fragile ?? 0) * 1;
    reductionPct += (defender.protection ?? 0) * 5;
    reductionPct += (defender.chargeShieldStack ?? 0) * 10;
    return reductionPct;
  }

  return { computeDefenderDmgReduction };
};
