// damage-calc.js
// Công cụ tính damage THUẦN (pure function — không đụng Redis/Discord/client,
// chỉ nhận input trả output) — tách khỏi index.js theo yêu cầu trực tiếp: "file
// index.js giờ hơi dài... nên tiếp tục tách hàm ra thành file riêng". Đây LÀ
// candidate AN TOÀN NHẤT để tách trước (không side-effect, test được độc lập
// bằng cách so sánh input→output y hệt trước/sau khi tách).
//
// Bao gồm: filterZeroFields (nội bộ, KHÔNG export), saturateBonusPct, saturateDR,
// validateMathInputs, calcMathCore (core damage engine — dùng bởi doPlayerAttack/
// doPlayerHit/doEnemyAttack trong index.js VÀ trực tiếp bởi calcMath), calcMath
// (wrapper build embed cho lệnh -math/`/math`).
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào) — chỉ thêm phần import
// hằng số ở đầu + module.exports ở cuối.

const {
  SANITY_MIN,
  POISE_MAX,
  SINKING_MAX,
  RUPTURE_MAX,
  BURN_MAX,
  TREMOR_MAX,
  BLEED_MAX,
  CHARGE_MAX,
  BUTTERFLY_LIVING_MAX,
  BUTTERFLY_DEPARTED_MAX,
} = require("./constants");
// 2 hằng số NÀY khai báo LOCAL trong index.js gốc (không từ constants.js) — mang
// theo nguyên giá trị, vì CHỈ dùng trong phạm vi calcMathCore/calcMath.
const POISE_CRIT_BONUS_PER_STACK = 0.05;
const POISE_RESET_THRESHOLD = 1;

function filterZeroFields(fields) {
  return fields.filter((f) => {
    if (f.alwaysShow) return true;
    if ("showIf" in f) return f.showIf;
    // Fallback cho các field không có showIf
    const v = String(f.value).trim();
    return v !== "0" && v !== "No";
  });
}

/**
 * Bão hòa % Dmg Bonus:
 *  0–100%   → tỷ lệ 1:1   (đầy đủ)
 *  100–200% → tỷ lệ 0.5:1 (mỗi 1% chỉ còn 0.5%)
 *  200%+    → tỷ lệ 0.25:1 (mỗi 1% chỉ còn 0.25%)
 */
function saturateBonusPct(raw) {
  if (raw <= 100) return raw;
  if (raw <= 200) return 100 + (raw - 100) * 0.5;
  if (raw <= 300) return 150 + (raw - 200) * 0.25;
  return 175 + (raw - 300) * 0.125; // 100 + 50 + 25 + (raw-300)*0.125
}

/**
 * Bão hòa % Damage Reduction (dr < 1x):
 *  DR 0–25%  → tỷ lệ 1:1
 *  DR 25–50% → tỷ lệ 0.5:1
 *  DR 50%+   → tỷ lệ 0.05:1
 * DR >= 1x (vulnerability hoặc neutral) không bị ảnh hưởng.
 * CHỈ áp dụng cho Damage Reduction (dr) — Res (B/P/S) không còn bị bão hòa.
 */
function saturateDR(mult) {
  if (mult >= 1) return mult;
  const drRaw = (1 - mult) * 100;
  let drEff;
  if (drRaw <= 25)       drEff = drRaw;
  else if (drRaw <= 50)  drEff = 25 + (drRaw - 25) * 0.5;
  else                   drEff = 37.5 + (drRaw - 50) * 0.05;
  return 1 - drEff / 100;
}

function validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit, theLiving = 0, theDeparted = 0, burnInit = 0, bleedInit = 0, bleedActions = 1, tremorInit = 0, chargeInit = 0 }) {
  const errors = [];
  if (isNaN(bonusPct))       errors.push("bonus phải là số");
  if (isNaN(sanityBonusPct)) errors.push("sanitybonus phải là số");
  if (isNaN(critMul))        errors.push("critmul phải là số");
  if (isNaN(diceMul))        errors.push("dicemul phải là số");
  if (isNaN(sinkingInit))    errors.push("sinking phải là số");
  if (isNaN(ruptureInit))    errors.push("rupture phải là số");
  if (isNaN(sanityInit))     errors.push("sanity phải là số");
  if (poiseInit < 0 || poiseInit > POISE_MAX) errors.push(`Poise phải từ 0–${POISE_MAX}`);
  if (!isNaN(critMul) && critMul < 1) errors.push("CritMul phải ≥ 1");
  if (!isNaN(diceMul) && diceMul < 0) errors.push("DiceMul phải ≥ 0");
  if (!isNaN(sinkingInit) && !Number.isInteger(sinkingInit)) errors.push("sinking phải là số nguyên");
  if (!isNaN(ruptureInit) && !Number.isInteger(ruptureInit)) errors.push("rupture phải là số nguyên");
  if (!isNaN(sanityInit) && !Number.isInteger(sanityInit)) errors.push("sanity phải là số nguyên");
  if (!isNaN(sinkingInit) && (sinkingInit < 0 || sinkingInit > SINKING_MAX)) errors.push(`Sinking phải từ 0–${SINKING_MAX}`);
  if (!isNaN(ruptureInit) && (ruptureInit < 0 || ruptureInit > RUPTURE_MAX)) errors.push(`Rupture phải từ 0–${RUPTURE_MAX}`);
  if (!isNaN(sanityInit) && sanityInit < SANITY_MIN) errors.push(`Sanity phải ≥ ${SANITY_MIN}`);
  if (!Number.isInteger(theLiving) || theLiving < 0 || theLiving > BUTTERFLY_LIVING_MAX) errors.push(`The Living phải từ 0–${BUTTERFLY_LIVING_MAX}`);
  if (!Number.isInteger(theDeparted) || theDeparted < 0 || theDeparted > BUTTERFLY_DEPARTED_MAX) errors.push(`The Departed phải từ 0–${BUTTERFLY_DEPARTED_MAX}`);
  if (isNaN(burnInit) || !Number.isInteger(burnInit) || burnInit < 0 || burnInit > BURN_MAX) errors.push(`Burn phải từ 0–${BURN_MAX}`);
  if (isNaN(bleedInit) || !Number.isInteger(bleedInit) || bleedInit < 0 || bleedInit > BLEED_MAX) errors.push(`Bleed phải từ 0–${BLEED_MAX}`);
  if (isNaN(bleedActions) || !Number.isInteger(bleedActions) || bleedActions < 0) errors.push("bleedactions phải là số nguyên ≥ 0");
  if (isNaN(tremorInit) || !Number.isInteger(tremorInit) || tremorInit < 0 || tremorInit > TREMOR_MAX) errors.push(`Tremor phải từ 0–${TREMOR_MAX}`);
  if (isNaN(chargeInit) || !Number.isInteger(chargeInit) || chargeInit < 0 || chargeInit > CHARGE_MAX) errors.push(`Charge phải từ 0–${CHARGE_MAX}`);
  return errors;
}
function calcMathCore(opts) {
  const {
    dmgStr = "",
    resStr = "",
    drStr = "",
    bonusPct = 0,
    sanityBonusPct = 0,
    critMul = 1,
    poiseInit = 0,
    critDiv = 0,
    sanityInit = 0,
    diceMul = 1,
    sinkingInit = 0,
    ruptureInit = 0,
    theLiving = 0,
    theDeparted = 0,
    burnInit = 0,
    bleedInit = 0,
    bleedActions = 1, // số lần địch hành động trong turn — Bleed trigger MỖI LẦN địch
                       // hành động (không phải lúc bị mình tấn công), /math không tự
                       // biết enemy hành động mấy lần nên cần nhập tay số này.
    tremorInit = 0,
    chargeInit = 0,
    // flatDmgPerHit — Attack Power Up/Down (50-Status Nhóm 1): "+1/-1 dmg cho MỌI
    // dmg gây ra" — CỘNG THẲNG (không phải %) vào MỖI hit TRƯỚC khi nhân bonus%/
    // Res/DR, giống cách "dmg" gốc hoạt động. Default 0 — AN TOÀN TUYỆT ĐỐI, không
    // ảnh hưởng bất kỳ caller nào hiện có KHÔNG truyền tham số này (mọi lệnh
    // -math/-encounter cũ vẫn chạy y hệt trước, đã verify bằng test thật).
    flatDmgPerHit = 0,
    // 6 biến thể Tremor (50-Status Nhóm 2, xác nhận trực tiếp từng cái) — TRÊN
    // TARGET đang bị Tremor Burst kích hoạt lên người:
    //   Everlasting: 50% (100% nếu target có Borrowed Time active) re-trigger
    //     THÊM 1 lần Burst nữa KHÔNG tốn thêm Tremor.
    //   Fracture: nếu Tremor ≥12 lúc kích hoạt, +10 Sta loss (1 lần/lần kích hoạt).
    //   Reverb: +dmg = Tremor hiện tại (TRƯỚC khi giảm nửa) mỗi lần kích hoạt.
    //   Decay/Chain: +5 Sta loss/stack mỗi lần kích hoạt (CỘNG THÊM vào cơ chế
    //     gốc) — giảm 1 count decay/chain mỗi lần NHẬN Tremor Burst (trả về qua
    //     tremorDecayConsumed/tremorChainConsumed để caller tự trừ field thật).
    tremorEverlastingStacks = 0,
    tremorEverlastingBoosted = false, // true nếu target ĐANG có Borrowed Time active
    tremorFractureStacks = 0,
    tremorReverbStacks = 0,
    tremorDecayStacks = 0,
    tremorChainStacks = 0,
    // Scorch/Hemorrhage (xác nhận trực tiếp): "Khi kích hoạt Tremor Burst, gây dmg
    // = (Tremor+Burn hoặc Bleed)/2" — TRÊN ATTACKER (người gây Tremor Burst),
    // KHÁC 5 biến thể trên (đặt trên target).
    tremorScorchActive = false,
    tremorHemorrhageActive = false,
  } = opts;

  const resValues = { B: 1, P: 1, S: 1 };
  const resRegex = /([\d.]+)(?:x)?([BPS])/gi;
  let match;
  while ((match = resRegex.exec(resStr)) !== null) {
    resValues[match[2].toUpperCase()] = parseFloat(match[1]);
  }
  // Res (B/P/S) không bị bão hòa nữa — chỉ DR mới bị bão hòa.
  const resRaw = { ...resValues };

  // DR: flat, áp lên tất cả damage type, độc lập với res
  // Final DMG = (DMG × bonusFactor) × res × dr
  const drRawPct = drStr ? parseFloat(drStr) : 0;
  const hasDR = !isNaN(drRawPct) && drRawPct !== 0;
  const drMult = hasDR ? saturateDR(1 - drRawPct / 100) : 1;

  const dmgValues = [];
  // Poise/Charge/Burn/Bleed/Tremor hỗ trợ CẢ +N (cộng) và -N (tiêu thụ/trừ) — VD Draw
  // of the Sword: "Nhận 2 Poise. Tiêu thụ 6 Poise để nhận 2 Light" → dmgStr ghi
  // "+2Poise-6Poise" trên CÙNG 1 hit. Sinking/Rupture/Living/Departed GIỮ NGUYÊN chỉ
  // +N (không đổi) — không có yêu cầu hỗ trợ trừ cho 4 cái này.
  //
  // QUAN TRỌNG: "TremorBurst" PHẢI đứng TRƯỚC "Tremor" trong alternation — vì
  // "TremorBurst" CHỨA chuỗi "Tremor" làm tiền tố. Nếu "Tremor" được thử trước,
  // regex sẽ khớp nhầm "+3Tremor" (trong "+3TremorBurst") rồi để lại "Burst" dư ra
  // không khớp được gì cả → cả tag TremorBurst bị "nuốt mất" âm thầm, không lỗi gì
  // nhưng hiệu ứng biến mất khỏi effectsStr hoàn toàn.
  // QUAN TRỌNG: hỗ trợ multiplier "x<N>" ở CẢ 2 vị trí — TRƯỚC type letter (cú pháp
  // gốc, VD "15x2B+3Poise") VÀ NGAY SAU type letter, TRƯỚC effects (cú pháp tự nhiên
  // hay viết nhầm, VD "15Bx2+3Poise") — trước đây CHỈ hỗ trợ vị trí đầu, viết theo
  // thứ tự sau sẽ làm "x2" bị bỏ qua (không nhân hit) RỒI "2" còn sót lại bị regex
  // hiểu lầm thành 1 hit MỚI, sai hoàn toàn (VD "+3Poise" sau "x2" bị nuốt mất, biến
  // "2+3Poise" thành hit giả "2 dmg +3% bonus Pierce"). Giờ khớp được CẢ 2, lấy bất
  // kỳ bên nào có giá trị.
  const damageRegex =
    /([\d.]+)(?:x([\d.]+))?(?:\+([\d.]+)%?)?\s*(Dice)?([BPSbps])(?:x([\d.]+))?((?:\+\d*Sinking|\+\d*Rupture|[+-]\d*Poise|[+-]\d*Charge|[+-]\d*Burn|[+-]\d*Bleed|\+\d*TremorBurst|[+-]\d*Tremor|\+\d*Living|\+\d*Departed|\+Crit\d+)*)/gi;
  // sumSignedTag — tách riêng GAIN (tổng "+N<tag>") và CONSUME (tổng "-N<tag>", dạng
  // số dương) trong effectsStr của 1 hit — KHÔNG gộp net ngay ở đây, vì cần biết riêng
  // 2 phần để phát hiện "tiêu thụ không đủ" (VD: +2Poise-6Poise mà lúc áp dụng chỉ có
  // 4 Poise sau gain thì thiếu 2, cần báo rõ thay vì chỉ lặng lẽ clamp về 0).
  // excludeSuffix: negative lookahead để loại match bị "lẫn" vào tag dài hơn cùng tiền
  // tố (VD tagName="Tremor", excludeSuffix="Burst" → "+3Tremor" trong "+3TremorBurst"
  // KHÔNG được tính là gain Tremor, vì đó thực ra là số lần TremorBurst).
  function sumSignedTag(effectsStr, tagName, excludeSuffix = null) {
    if (!effectsStr) return { gain: 0, consume: 0 };
    const lookahead = excludeSuffix ? `(?!${excludeSuffix})` : "";
    const re = new RegExp(`([+-])(\\d*)${tagName}${lookahead}`, "gi");
    let gain = 0, consume = 0, m;
    while ((m = re.exec(effectsStr)) !== null) {
      const count = m[2] ? parseInt(m[2], 10) : 1;
      if (m[1] === "-") consume += count; else gain += count;
    }
    return { gain, consume };
  }
  while ((match = damageRegex.exec(dmgStr)) !== null) {
    const base = parseFloat(match[1]);
    const multiplier = match[2] ? parseInt(match[2]) : (match[6] ? parseInt(match[6]) : 1);
    const extraPct = match[3] ? parseFloat(match[3]) : 0;
    const isDice = !!match[4];
    const dmgType = match[5] ? match[5].toUpperCase() : "B";
    const effectsStr = match[7] || "";
    const sinkingMatch = effectsStr.match(/\+(\d+)?Sinking/i);
    const ruptureMatch = effectsStr.match(/\+(\d+)?Rupture/i);
    const livingMatch = effectsStr.match(/\+(\d+)?Living/i);
    const departedMatch = effectsStr.match(/\+(\d+)?Departed/i);
    // TremorBurst — giờ CÓ số đếm tùy chọn ("+NTremorBurst" = kích hoạt chu kỳ
    // dùng+giảm-nửa N LẦN trên CÙNG hit này, mặc định N=1 nếu không ghi số).
    const tremorBurstMatch = effectsStr.match(/\+(\d*)TremorBurst/i);
    const tremorBurstCount = tremorBurstMatch ? parseInt(tremorBurstMatch[1] || "1", 10) : 0;
    const sinkingToApply = sinkingMatch ? parseInt(sinkingMatch[1] || "1") : 0;
    const ruptureToApply = ruptureMatch ? parseInt(ruptureMatch[1] || "1") : 0;
    const livingToApply = livingMatch ? parseInt(livingMatch[1] || "1") : 0;
    const departedToApply = departedMatch ? parseInt(departedMatch[1] || "1") : 0;
    // Poise/Charge/Burn/Bleed/Tremor — giữ riêng gain/consume (không gộp net) để phát
    // hiện thiếu hụt lúc áp dụng thật (xem comment ở khối "Apply stack mới" trong loop).
    const poiseTag = sumSignedTag(effectsStr, "Poise");
    const chargeTag = sumSignedTag(effectsStr, "Charge");
    const burnTag = sumSignedTag(effectsStr, "Burn");
    const bleedTag = sumSignedTag(effectsStr, "Bleed");
    const tremorTag = sumSignedTag(effectsStr, "Tremor", "Burst");
    for (let i = 0; i < multiplier; i++) {
      dmgValues.push({ value: base, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseTag, chargeTag, burnTag, bleedTag, tremorTag, tremorBurstCount, livingToApply, departedToApply, effectsStr });
    }
  }
  if (dmgValues.length === 0) {
    const zeroTag = { gain: 0, consume: 0 };
    dmgValues.push({ value: 0, type: "B", isDice: false, extraPct: 0, sinkingToApply: 0, ruptureToApply: 0, poiseTag: zeroTag, chargeTag: zeroTag, burnTag: zeroTag, bleedTag: zeroTag, tremorTag: zeroTag, tremorBurstCount: 0, livingToApply: 0, departedToApply: 0, effectsStr: "" });
  }

  let sanity = sanityInit;
  let totalDmg = 0;
  let totalPoise = poiseInit;
  let totalCharge = Math.min(Math.max(chargeInit, 0), CHARGE_MAX); // Charge: cộng/trừ qua dmg tag, KHÔNG có decay tự động (không như Poise crit-halve)
  let enemySinking = Math.min(sinkingInit, SINKING_MAX);
  let enemyTremor = Math.min(tremorInit, TREMOR_MAX);
  let totalTremorStaminaLoss = 0; // tích lũy từ các hit có +TremorBurst
  let totalTremorDecayConsumed = 0, totalTremorChainConsumed = 0; // tích lũy số lần Tremor Decay/Chain bị tiêu thụ (mỗi lần kích hoạt Tremor Burst)
  let enemyRupture = Math.min(ruptureInit, RUPTURE_MAX);
  // Burn/Bleed giờ là biến THEO DÕI được (giống enemySinking/enemyRupture), KHÔNG còn
  // là input tĩnh chỉ dùng 1 lần — vì dmg tag +N/-NBurn, +N/-NBleed có thể sửa số
  // count NGAY TRONG lúc đang tính các hit, trước khi áp dụng công thức end-turn-tick
  // (×2 dmg rồi giảm nửa cho Burn; ÷4×actions dmg rồi giảm nửa cho Bleed) ở CUỐI.
  let enemyBurn = Math.min(Math.max(burnInit, 0), BURN_MAX);
  let enemyBleed = Math.min(Math.max(bleedInit, 0), BLEED_MAX);
  let livingStacks = Math.min(theLiving, BUTTERFLY_LIVING_MAX);     // Count The Living hiện tại, có thể tăng qua +Living trong dmg
  let departedStacks = Math.min(theDeparted, BUTTERFLY_DEPARTED_MAX); // Count The Departed hiện tại, có thể tăng qua +Departed trong dmg
  let totalSanityHeal = 0;   // tích lũy từ The Living qua các hit
  let totalDepartedDmg = 0;  // tích lũy bonus dmg từ The Departed
  // Sanity Bonus hiệu dụng tích lũy: bắt đầu từ sanityBonusPct (input),
  // cộng thêm livingHeal sau mỗi hit — áp dụng cho Dice hit tiếp theo.
  let effectiveSanityBonus = sanityBonusPct;
  const instanceResults = [];

  for (const dmgObj of dmgValues) {
    const { value: dmg, type: dmgType, isDice, extraPct, sinkingToApply, ruptureToApply, poiseTag, chargeTag, burnTag, bleedTag, tremorTag, tremorBurstCount, livingToApply, departedToApply, effectsStr } = dmgObj;
    const currentRes = resValues[dmgType] ?? 1.0;
    const currentDR  = drMult;

    const critFromPoise = totalPoise * POISE_CRIT_BONUS_PER_STACK;
    const critMatch = effectsStr ? effectsStr.match(/\+Crit(\d+)/i) : null;
    const bonusCritRate = critMatch ? parseInt(critMatch[1]) / 100 : 0;
    const rawCritChance = critFromPoise + bonusCritRate;
    const critChance = Math.min(rawCritChance, 1);
    const poiseOverflow = Math.max(0, rawCritChance - 1);

    const didCrit = critChance >= 1 ? true : Math.random() < critChance;

    const multiplier = didCrit ? critMul : 1;
    const rawTotalPct = bonusPct + extraPct;
    const effTotalPct = saturateBonusPct(rawTotalPct) + (isDice ? effectiveSanityBonus : 0);
    const bonusFactor = 1 + effTotalPct / 100;
    let instanceDmg = Math.max(0, dmg + flatDmgPerHit) * bonusFactor * multiplier * currentRes * currentDR;
    if (isDice) instanceDmg *= diceMul;

    // Sinking: chỉ trừ sanity địch khi địch đang có Sinking stacks (đúng cơ chế).
    // REWORK (xác nhận trực tiếp): "giảm sanity theo mỗi hit theo công thức số
    // count / 15 (làm tròn xuống và tối thiểu 1)" — TRƯỚC ĐÂY cố định -1/hit,
    // GIỜ scale theo Sinking HIỆN TẠI (trước khi tiêu 1 stack ở dòng dưới) — vẫn
    // tiêu 1 stack/hit như cũ, chỉ đổi CÔNG THỨC lượng sanity mất.
    // sinkingBeforeProc được lưu trước khi drain, để The Departed dùng đúng giá trị hiện tại.
    const sinkingBeforeProc = enemySinking;
    let sinkingBonus = 0;
    if (enemySinking > 0) {
      const sanityBefore = sanity;
      const sanityLoss = Math.max(1, Math.floor(enemySinking / 15));
      sanity = Math.max(sanity - sanityLoss, SANITY_MIN);
      if (sanityBefore <= SANITY_MIN || sanity <= SANITY_MIN) {
        instanceDmg += enemySinking;
        sinkingBonus = enemySinking;
      }
      enemySinking = Math.max(enemySinking - 1, 0);
    }

    let ruptureBonus = 0;
    if (enemyRupture > 0) {
      ruptureBonus = enemyRupture;
      instanceDmg += ruptureBonus;
      enemyRupture = Math.max(enemyRupture - 1, 0);
    }

    // ── Butterfly: The Departed ───────────────────────────────────────────────
    // Bonus dmg = floor(Sinking hiện tại / 2) + The Departed count hiện tại (trước khi cộng stack của đòn này).
    // Cap 30 nếu địch còn Sanity (> SANITY_MIN, chưa chạm đáy), cap 15 nếu địch đã hết Sanity (== SANITY_MIN).
    let departedBonus = 0;
    if (departedStacks > 0) {
      const departedRaw = Math.floor(sinkingBeforeProc / 2) + departedStacks;
      const departedCap = sanity > SANITY_MIN ? 30 : 15;
      departedBonus = Math.min(departedRaw, departedCap);
      instanceDmg += departedBonus;
      totalDepartedDmg += departedBonus;
    }

    // ── Butterfly: The Living ────────────────────────────────────────────────
    // Hồi Sanity người dùng = floor(The Living / 4) mỗi hit, dùng Count hiện tại (trước khi cộng stack của đòn này).
    // Sanity hồi được cộng vào effectiveSanityBonus để Dice hit TIẾP THEO hưởng bonus (không áp dụng cho hit hiện tại).
    const livingHeal = livingStacks > 0 ? Math.floor(livingStacks / 4) : 0;
    const sanityBonusUsed = effectiveSanityBonus; // snapshot dùng cho hit này (trước khi cộng heal)
    totalSanityHeal += livingHeal;
    effectiveSanityBonus += livingHeal;

    totalDmg += instanceDmg;

    // Apply stack mới từ đòn này sau khi đã tính dmg xong. Poise/Charge/Burn/Bleed áp
    // GAIN trước (cộng, clamp max) RỒI MỚI CONSUME (trừ, không cho âm) — khớp đúng
    // tường thuật "Nhận 2 Poise. Tiêu thụ 6 Poise" (cộng trước, trừ sau trên CÙNG 1
    // hit). Nếu consume > số đang có SAU gain (VD: crit ở hit trước đã làm hao Poise,
    // hit này gain không đủ bù) → shortfall > 0, được báo RÕ trong breakdown (xem
    // dưới) thay vì lặng lẽ clamp về 0 như trước — đúng câu hỏi: "lỡ không đủ thì sao?"
    const poiseAfterRawGain = Math.min(totalPoise + poiseTag.gain, POISE_MAX);
    const poiseShortfall = Math.max(0, poiseTag.consume - poiseAfterRawGain);
    totalPoise = Math.max(0, poiseAfterRawGain - poiseTag.consume);

    const chargeAfterRawGain = Math.min(totalCharge + chargeTag.gain, CHARGE_MAX);
    const chargeShortfall = Math.max(0, chargeTag.consume - chargeAfterRawGain);
    totalCharge = Math.max(0, chargeAfterRawGain - chargeTag.consume);

    const burnAfterRawGain = Math.min(enemyBurn + burnTag.gain, BURN_MAX);
    const burnShortfall = Math.max(0, burnTag.consume - burnAfterRawGain);
    enemyBurn = Math.max(0, burnAfterRawGain - burnTag.consume);

    const bleedAfterRawGain = Math.min(enemyBleed + bleedTag.gain, BLEED_MAX);
    const bleedShortfall = Math.max(0, bleedTag.consume - bleedAfterRawGain);
    enemyBleed = Math.max(0, bleedAfterRawGain - bleedTag.consume);

    // Tremor: GAIN/CONSUME (từ tag +N/-NTremor) áp dụng TRƯỚC, RỒI MỚI tới TremorBurst
    // (dùng giá trị tremor đã cập nhật — nếu hit này VỪA gây thêm Tremor vừa Burst,
    // Burst sẽ dùng được cả phần mới gây ra, khớp đúng tường thuật "gây X Tremor rồi
    // Burst luôn" trong 1 hit).
    const tremorAfterRawGain = Math.min(enemyTremor + tremorTag.gain, TREMOR_MAX);
    const tremorShortfall = Math.max(0, tremorTag.consume - tremorAfterRawGain);
    enemyTremor = Math.max(0, tremorAfterRawGain - tremorTag.consume);

    // ── Tremor Burst — "+NTremorBurst" lặp lại chu kỳ (dùng×5 Sta rồi giảm nửa) N
    // LẦN trên CÙNG hit này (mặc định N=1 nếu chỉ ghi "+TremorBurst" không số). Dừng
    // sớm nếu tremor về 0 giữa chừng (không có gì để Burst tiếp). LÀM TRÒN XUỐNG sau
    // mỗi lần giảm nửa (VD: 7→3, không phải 3.5) — Math.floor thay vì chia thường.
    //
    // 5 biến thể Tremor (50-Status Nhóm 2, xác nhận trực tiếp) tích hợp NGAY TẠI
    // ĐÂY — mỗi biến thể áp dụng cho MỖI LẦN burstIdx thật sự kích hoạt (nhất quán
    // độ hạt với cơ chế +5 Sta/Tremor gốc):
    //   Fracture: Tremor≥12 lúc kích hoạt → +10 Sta loss CỐ ĐỊNH (không nhân stack
    //     — khác phần "-5 Sta/stack Fracture" ngay sau, CÓ nhân stack).
    //   Reverb: +dmg = Tremor hiện tại × số stack Reverb (giả định nhất quán với
    //     Fracture/Decay/Chain đều /stack — bản mô tả gốc không ghi rõ "/stack"
    //     cho riêng Reverb, nhưng cùng nhóm nên suy luận tương tự).
    //   Decay/Chain: +5 Sta loss × stack MỖI lần kích hoạt.
    //   Everlasting: SAU khi burst gốc xong, 50% (100% nếu Borrowed Time active)
    //     re-trigger THÊM 1 lần (Sta loss tính theo Tremor HIỆN TẠI, nhưng KHÔNG
    //     giảm nửa Tremor thêm — "không tốn số Tremor có trên người"). Cap an
    //     toàn 10 lần re-trigger liên tiếp/hit (phòng lý thuyết vô hạn nếu luôn
    //     may mắn trúng — xác suất thực tế cực thấp, không ảnh hưởng gameplay).
    let tremorStaminaLoss = 0;
    let tremorVariantBonusDmg = 0;
    let tremorDecayConsumed = 0, tremorChainConsumed = 0;
    for (let burstIdx = 0; burstIdx < tremorBurstCount; burstIdx++) {
      if (enemyTremor <= 0) break;
      if (tremorFractureStacks > 0 && enemyTremor >= 12) tremorStaminaLoss += 10;
      if (tremorReverbStacks > 0) tremorVariantBonusDmg += enemyTremor * tremorReverbStacks;
      if (tremorScorchActive) tremorVariantBonusDmg += (enemyTremor + enemyBurn) / 2;
      if (tremorHemorrhageActive) tremorVariantBonusDmg += (enemyTremor + enemyBleed) / 2;
      tremorStaminaLoss += enemyTremor * 5;
      tremorStaminaLoss += tremorDecayStacks * 5;
      tremorStaminaLoss += tremorChainStacks * 5;
      if (tremorDecayStacks > 0) tremorDecayConsumed += 1;
      if (tremorChainStacks > 0) tremorChainConsumed += 1;
      enemyTremor = Math.floor(enemyTremor / 2);
      // Everlasting — re-trigger (KHÔNG tính vào burstIdx gốc, không giảm nửa
      // Tremor thêm nữa mỗi lần re-trigger, chỉ tính Sta loss lặp lại).
      if (tremorEverlastingStacks > 0) {
        const chance = tremorEverlastingBoosted ? 1 : 0.5;
        let retriggerGuard = 0;
        while (enemyTremor > 0 && Math.random() < chance && retriggerGuard < 10) {
          tremorStaminaLoss += enemyTremor * 5;
          retriggerGuard += 1;
        }
      }
    }
    totalTremorStaminaLoss += tremorStaminaLoss;
    totalTremorDecayConsumed += tremorDecayConsumed;
    totalTremorChainConsumed += tremorChainConsumed;
    totalDmg += tremorVariantBonusDmg;

    if (sinkingToApply > 0) enemySinking = Math.min(enemySinking + sinkingToApply, SINKING_MAX);
    if (ruptureToApply > 0) enemyRupture = Math.min(enemyRupture + ruptureToApply, RUPTURE_MAX);
    if (livingToApply > 0) livingStacks = Math.min(livingStacks + livingToApply, BUTTERFLY_LIVING_MAX);
    if (departedToApply > 0) departedStacks = Math.min(departedStacks + departedToApply, BUTTERFLY_DEPARTED_MAX);

    // Ghi lại poise sau gain nhưng trước critDiv để hiển thị trong breakdown
    const poiseAfterGain = totalPoise;

    if (didCrit && critDiv > 1) {
      totalPoise = Math.floor(totalPoise / critDiv);
      if (totalPoise < POISE_RESET_THRESHOLD) totalPoise = 0;
    }

    const poiseToApply = poiseTag.gain - poiseTag.consume; // net, dùng cho hiển thị +/-N gọn
    const chargeToApply = chargeTag.gain - chargeTag.consume;
    const burnToApply = burnTag.gain - burnTag.consume;
    const bleedToApply = bleedTag.gain - bleedTag.consume;
    const tremorToApply = tremorTag.gain - tremorTag.consume;

    instanceResults.push({
      dmg, dmgType, didCrit, critChance, poiseOverflow,
      poiseStacksAfter: totalPoise,  // sau critDiv — giá trị thực dùng cho hit tiếp theo
      poiseAfterGain,                 // sau gain, trước critDiv — để hiển thị gain chính xác
      poiseShortfall,
      instanceDmg, ruptureBonus, sinkingBonus,
      sinkingApplied: sinkingToApply,
      ruptureApplied: ruptureToApply,
      poiseApplied: poiseToApply,
      chargeApplied: chargeToApply, chargeStacksAfter: totalCharge, chargeShortfall,
      burnApplied: burnToApply, burnStacksAfter: enemyBurn, burnShortfall,
      bleedApplied: bleedToApply, bleedStacksAfter: enemyBleed, bleedShortfall,
      tremorApplied: tremorToApply, tremorStacksAfter: enemyTremor, tremorShortfall,
      tremorStaminaLoss, tremorBurstCount, tremorVariantBonusDmg, tremorDecayConsumed, tremorChainConsumed,
      effectsStr, isDice,
      departedBonus, livingHeal,
      livingApplied: livingToApply,
      departedApplied: departedToApply,
      livingStacksAfter: livingStacks,
      departedStacksAfter: departedStacks,
      sanityBonusUsed, // Sanity Bonus hiệu dụng đã dùng cho hit này
    });
  }

  const finalPoiseStacks = totalPoise;

  const critCount = instanceResults.filter((r) => r.didCrit).length;

  // ── Burn (end-turn tick) ─────────────────────────────────────────────────────
  // "1 burn count sẽ gây dmg = 2x count mỗi khi end turn, sau đó giảm 1 NỬA (không
  // phải -1 như Sinking/Rupture)." — tính SAU khi đã áp dụng hết mọi +N/-NBurn từ các
  // hit trong dmgStr (enemyBurn, không phải burnInit thô) — để skill có thể "gây thêm
  // Burn" hoặc "tiêu thụ Burn" ngay trong cùng 1 lần roll, rồi mới tick cuối turn trên
  // số liệu CUỐI CÙNG. LÀM TRÒN XUỐNG sau khi giảm nửa (VD: 7→3, không phải 3.5).
  const burnDmgThisTurn = enemyBurn * 2;
  const burnAfter = Math.floor(enemyBurn / 2);

  // ── Bleed (trigger mỗi lần ĐỊCH hành động tấn công — không phải lúc bị tấn công
  // — RỒI giảm 1 nửa lúc end turn, đây là 2 thời điểm KHÁC NHAU) ────────────────
  // "1 bleed count gây dmg = 1/4 count mỗi khi địch hành động tấn công trong turn,
  // giảm 1 nửa sau end turn." — bleedActions = số lần địch hành động turn này (không
  // tự suy ra được, phải nhập tay vì /math không mô phỏng hành động của địch). Cũng
  // tính trên enemyBleed SAU khi áp dụng +N/-NBleed từ dmgStr, giống Burn ở trên.
  // LÀM TRÒN XUỐNG sau khi giảm nửa, giống Burn/Tremor.
  const bleedDmgPerAction = enemyBleed / 4;
  const bleedDmgThisTurn = bleedDmgPerAction * Math.max(0, bleedActions);
  const bleedAfter = Math.floor(enemyBleed / 2);

  // Trả về TẤT CẢ biến cần cho phần display (calcMath) VÀ cho hệ thống khác (encounter)
  // muốn lấy số liệu thuần để lưu lại — không lọc bớt, tránh sót biến nào cần dùng sau.
  return {
    // Input gốc (echo lại để display dùng, không cần destructure lại opts)
    dmgStr, resStr, drStr, bonusPct, sanityBonusPct, critMul, poiseInit, critDiv,
    sanityInit, diceMul, sinkingInit, ruptureInit, theLiving, theDeparted,
    burnInit, bleedInit, bleedActions, tremorInit, chargeInit,
    // Kết quả tính toán — DÙNG ĐỂ LƯU LẠI cho encounter (số liệu mới sau hit này)
    totalDmg, finalSanity: sanity, finalPoiseStacks, finalSinking: enemySinking,
    finalRupture: enemyRupture, finalLivingStacks: livingStacks, finalDepartedStacks: departedStacks,
    finalCharge: totalCharge,
    totalSanityHeal, totalDepartedDmg, critCount,
    // Burn/Bleed (end-turn tick) — KHÔNG cộng vào totalDmg, vì đây là dmg ở 1 THỜI
    // ĐIỂM KHÁC (end turn), không phải dmg của hit đang tính.
    burnDmgThisTurn, finalBurn: burnAfter,
    // GAP NGHIÊM TRỌNG ĐÃ SỬA (phát hiện qua test thực tế: tag "+NBurn" gõ tay
    // hoàn toàn không hoạt động) — "finalBurn" (burnAfter) đã qua END-TURN TICK
    // (floor(enemyBurn/2)) — KHÔNG PHẢI giá trị "ngay sau khi gắn tag" như
    // finalTremor/finalSinking/finalRupture. Đây mới là giá trị ĐÚNG để lưu vào
    // target.burn ngay lúc commit hit (enemyBurn CHƯA qua tick, chỉ áp dụng
    // +N/-NBurn từ dmgStr).
    burnStackAfterHit: enemyBurn,
    bleedDmgThisTurn, finalBleed: bleedAfter,
    // Tremor Burst (per-hit, đã tích lũy trong loop ở trên)
    totalTremorStaminaLoss, finalTremor: enemyTremor,
    totalTremorDecayConsumed, totalTremorChainConsumed,
    // Chi tiết — dùng để build breakdown display trong calcMath()
    instanceResults, dmgValues, resRaw, resValues, hasDR, drMult, drRawPct, effectiveSanityBonus,
  };
}

function calcMath(opts) {
  const calcResult = calcMathCore(opts);
  const {
    dmgStr, resStr, drStr, bonusPct, sanityBonusPct, critMul, poiseInit, critDiv,
    sanityInit, diceMul, sinkingInit, ruptureInit, theLiving, theDeparted,
    burnInit, bleedInit, bleedActions, tremorInit, chargeInit,
    totalDmg, finalSanity: sanity, finalPoiseStacks, finalSinking: enemySinking,
    finalRupture: enemyRupture, finalLivingStacks: livingStacks, finalDepartedStacks: departedStacks,
    finalCharge,
    totalSanityHeal, totalDepartedDmg, critCount,
    burnDmgThisTurn, finalBurn, bleedDmgThisTurn, finalBleed,
    totalTremorStaminaLoss, finalTremor,
    instanceResults, dmgValues, resRaw, resValues, hasDR, drMult, drRawPct, effectiveSanityBonus,
  } = calcResult;

  const breakdownLines = instanceResults.map((r, i) => {
    const rateStr = `${(r.critChance * 100).toFixed(1)}%`;
    const critLabel = r.didCrit ? "✅" : "❌";
    let extraInfo = "";
    if (r.poiseOverflow > 0) {
      const wastedStacks = Math.round(r.poiseOverflow / POISE_CRIT_BONUS_PER_STACK);
      extraInfo += ` | ${wastedStacks} <:Poise:1513762945715142736>Poise dư`;
    }
    if (r.sinkingBonus > 0) extraInfo += ` | +${r.sinkingBonus} dmg từ <:Sinking:1513762793436741652>Sinking`;
    if (r.sinkingApplied > 0) extraInfo += ` | áp ${r.sinkingApplied} <:Sinking:1513762793436741652>Sinking`;
    if (r.ruptureBonus > 0) extraInfo += ` | +${r.ruptureBonus} dmg từ <:Rupture:1513762812722155682>Rupture`;
    if (r.ruptureApplied > 0) extraInfo += ` | áp ${r.ruptureApplied} <:Rupture:1513762812722155682>Rupture`;
    if (r.poiseApplied !== 0) {
      const sign = r.poiseApplied > 0 ? "+" : "";
      const label = r.poiseApplied > 0 ? "" : " (tiêu thụ)";
      if (critDiv > 1 && r.didCrit && r.poiseAfterGain !== r.poiseStacksAfter) {
        extraInfo += ` | ${sign}${r.poiseApplied} <:Poise:1513762945715142736>Poise${label}: ${r.poiseAfterGain} → ÷${critDiv} = ${r.poiseStacksAfter} Counts`;
      } else {
        extraInfo += ` | ${sign}${r.poiseApplied} <:Poise:1513762945715142736>Poise${label} → ${r.poiseStacksAfter} Counts`;
      }
    }
    if (r.poiseShortfall > 0) extraInfo += ` | ⚠️ Thiếu ${r.poiseShortfall} <:Poise:1513762945715142736>Poise để tiêu thụ hết`;
    if (r.chargeApplied !== 0) {
      const sign = r.chargeApplied > 0 ? "+" : "";
      const label = r.chargeApplied > 0 ? "" : " (tiêu thụ)";
      extraInfo += ` | ${sign}${r.chargeApplied} <:Charge:1513762867558613033>Charge${label} → ${r.chargeStacksAfter} Counts`;
    }
    if (r.chargeShortfall > 0) extraInfo += ` | ⚠️ Thiếu ${r.chargeShortfall} <:Charge:1513762867558613033>Charge để tiêu thụ hết`;
    if (r.burnApplied !== 0) {
      const sign = r.burnApplied > 0 ? "+" : "";
      const label = r.burnApplied > 0 ? "" : " (tiêu thụ)";
      extraInfo += ` | ${sign}${r.burnApplied} <:Burn:1513762753691652177>Burn${label} → ${r.burnStacksAfter} Counts`;
    }
    if (r.burnShortfall > 0) extraInfo += ` | ⚠️ Thiếu ${r.burnShortfall} <:Burn:1513762753691652177>Burn để tiêu thụ hết`;
    if (r.bleedApplied !== 0) {
      const sign = r.bleedApplied > 0 ? "+" : "";
      const label = r.bleedApplied > 0 ? "" : " (tiêu thụ)";
      extraInfo += ` | ${sign}${r.bleedApplied} <:Bleed:1513762688226955285>Bleed${label} → ${r.bleedStacksAfter} Counts`;
    }
    if (r.bleedShortfall > 0) extraInfo += ` | ⚠️ Thiếu ${r.bleedShortfall} <:Bleed:1513762688226955285>Bleed để tiêu thụ hết`;
    if (r.effectsStr && /\+Crit(\d+)/i.test(r.effectsStr)) {
      const critVal = r.effectsStr.match(/\+Crit(\d+)/i)[1];
      extraInfo += ` | +Crit${critVal}%`;
    }
    if (r.isDice && diceMul !== 1) extraInfo += ` | DiceMul ${diceMul}x`;
    if (r.departedBonus > 0) extraInfo += ` | +${r.departedBonus} dmg <:Butterfly:1516679919399338074>Departed`;
    if (r.departedApplied > 0) extraInfo += ` | áp +${r.departedApplied} <:Butterfly:1516679919399338074>Departed (${r.departedStacksAfter} Count)`;
    if (r.livingHeal > 0) extraInfo += ` | +${r.livingHeal} Sanity hồi <:Butterfly:1516679919399338074>Living`;
    if (r.livingApplied > 0) extraInfo += ` | áp +${r.livingApplied} <:Butterfly:1516679919399338074>Living (${r.livingStacksAfter} Count)`;
    if (r.isDice && r.sanityBonusUsed > 0 && r.sanityBonusUsed !== sanityBonusPct)
      extraInfo += ` | Sanity: ${r.sanityBonusUsed} (+${r.sanityBonusUsed}% Dice)`;
    if (r.tremorApplied !== 0) {
      const sign = r.tremorApplied > 0 ? "+" : "";
      const label = r.tremorApplied > 0 ? "" : " (tiêu thụ)";
      extraInfo += ` | ${sign}${r.tremorApplied} <:Tremor:1513762737388257380>Tremor${label} → ${r.tremorStacksAfter} Counts`;
    }
    if (r.tremorShortfall > 0) extraInfo += ` | ⚠️ Thiếu ${r.tremorShortfall} <:Tremor:1513762737388257380>Tremor để tiêu thụ hết`;
    if (r.tremorStaminaLoss > 0) {
      const burstNote = r.tremorBurstCount > 1 ? ` (x${r.tremorBurstCount} lần)` : "";
      extraInfo += ` | <:TremorBurst:1513802464632246352>Tremor Burst${burstNote}: -${r.tremorStaminaLoss} Sta địch → ${r.tremorStacksAfter} Counts`;
    }
    return `#${i + 1}[${r.dmgType}](${rateStr}) ${critLabel} → ${r.instanceDmg.toFixed(2)}${extraInfo}`;
  });

  let breakdownValue = breakdownLines.join("\n");
  if (breakdownValue.length > 1024) {
    const shown = [];
    for (const line of breakdownLines) {
      if ((shown.join("\n") + "\n" + line).length > 990) {
        shown.push(`…+${breakdownLines.length - shown.length} more hits`);
        break;
      }
      shown.push(line);
    }
    breakdownValue = shown.join("\n");
  }

  const startingCritRate = poiseInit * POISE_CRIT_BONUS_PER_STACK;
  const finalCritRate = finalPoiseStacks * POISE_CRIT_BONUS_PER_STACK;
  let poiseDisplay;
  if (critDiv > 1 && critCount > 0) {
    poiseDisplay = `${poiseInit} → ${finalPoiseStacks} Counts (${critCount} crit${critCount > 1 ? "s" : ""}, ÷${critDiv})`;
  } else if (poiseInit !== finalPoiseStacks) {
    poiseDisplay = `${poiseInit} → ${finalPoiseStacks} Counts (${(startingCritRate * 100).toFixed(0)}% → ${(finalCritRate * 100).toFixed(0)}% crit)`;
  } else {
    poiseDisplay = `${poiseInit} Counts (${(startingCritRate * 100).toFixed(0)}% crit)`;
  }

  const resDisplay = ["B", "P", "S"].map(k => {
    const raw = resRaw[k], eff = resValues[k];
    return raw !== eff
      ? `${k}: ${raw}x → **${eff.toFixed(3)}x** *(bão hòa)*`
      : `${k}: ${raw}x`;
  }).join(" | ");
  const drEffPct = hasDR ? ((1 - drMult) * 100).toFixed(2) : null;
  const drDisplay = hasDR
    ? `${drRawPct}% raw → **${drEffPct}%** effective *(${drMult.toFixed(3)}x)*`
    : null;

  const finalLivingStacks = livingStacks;
  const finalDepartedStacks = departedStacks;
  const livingDisplay = theLiving !== finalLivingStacks
    ? `${theLiving} → ${finalLivingStacks} Count (hồi **${Math.floor(finalLivingStacks / 4)}** Sanity/hit ở cuối)`
    : `${theLiving} Count → hồi **${Math.floor(theLiving / 4)}** Sanity/hit`;
  const departedCapLabel = sanity > SANITY_MIN ? "30 (địch còn Sanity)" : "15 (địch hết Sanity)";
  const departedDisplay = theDeparted !== finalDepartedStacks
    ? `${theDeparted} → ${finalDepartedStacks} Count (cap: ${departedCapLabel})`
    : `${theDeparted} Count (cap: ${departedCapLabel})`;

  // Tính effective bonus để hiển thị (dùng worst-case: có cả sanityBonus nếu > 0)
  const rawBonusDisplay = bonusPct;
  const effBonusDisplay = saturateBonusPct(rawBonusDisplay);
  const isSaturated = rawBonusDisplay > 100;
  const bonusPctDisplay = isSaturated
    ? `${effBonusDisplay.toFixed(1)}% *(raw: ${rawBonusDisplay.toFixed(1)}%)*`
    : bonusPct.toFixed(1) + "%";

  const allFields = [
    { name: `Hits (${critCount}/${dmgValues.length} crit)`, value: breakdownValue, inline: false },
    { name: "% Dmg Bonus", value: bonusPctDisplay, inline: true, alwaysShow: true },
    { name: "Player's Sanity", value: totalSanityHeal > 0
        ? `${sanityBonusPct} (+${sanityBonusPct}% Dice bonus) → ${sanityBonusPct + totalSanityHeal} (+${sanityBonusPct + totalSanityHeal}% Dice bonus)`
        : `${sanityBonusPct} (+${sanityBonusPct}% Dice bonus)`,
      inline: true, showIf: effectiveSanityBonus !== 0 || sanityBonusPct !== 0 },
    { name: "CritMul", value: critMul + "x", inline: true, alwaysShow: true },
    { name: "Res Multipliers", value: resDisplay, inline: true, alwaysShow: true },
    { name: "Damage Reduction", value: drDisplay ?? "", inline: true, showIf: hasDR },
    { name: "Dice Multiplier", value: diceMul.toFixed(2) + "x", inline: true, showIf: diceMul !== 1 },
    { name: "<:Poise:1513762945715142736>Poise Counts", value: poiseDisplay, inline: true, alwaysShow: true },
    { name: "Crit Divide", value: critDiv > 1 ? `÷${critDiv} per crit` : "No", inline: true, showIf: critDiv > 1 },
    { name: "<:Butterfly:1516679919399338074>The Living", value: livingDisplay, inline: true, showIf: finalLivingStacks > 0 },
    { name: "<:Butterfly:1516679919399338074>The Departed", value: departedDisplay, inline: true, showIf: finalDepartedStacks > 0 },
    { name: "Final DMG", value: totalDmg.toFixed(3), inline: false, alwaysShow: true },
    { name: "<:Butterfly:1516679919399338074>Tổng Sanity hồi (The Living)", value: `+${totalSanityHeal}`, inline: true, showIf: totalSanityHeal > 0 },
    { name: "<:Butterfly:1516679919399338074>Tổng DMG Bonus (The Departed)", value: totalDepartedDmg.toFixed(2), inline: true, showIf: totalDepartedDmg > 0 },
    { name: "Enemy's Sanity", value: sanity.toString(), inline: true, showIf: sanity !== 0 },
    { name: "Enemy's <:Sinking:1513762793436741652>Sinking Counts", value: enemySinking.toString(), inline: true, showIf: enemySinking !== 0 },
    { name: "Enemy's <:Rupture:1513762812722155682>Rupture Counts", value: enemyRupture.toString(), inline: true, showIf: enemyRupture !== 0 },
    { name: "<:Burn:1513762753691652177>Burn (end turn)", value: `${burnDmgThisTurn.toFixed(2)} dmg — count: ${burnInit} → ${finalBurn}`, inline: true, showIf: burnInit > 0 || finalBurn > 0 || burnDmgThisTurn > 0 },
    { name: "Bleed (end turn)", value: `${bleedDmgThisTurn.toFixed(2)} dmg (x${bleedActions} hành động) — count: ${bleedInit} → ${finalBleed}`, inline: true, showIf: bleedInit > 0 || finalBleed > 0 || bleedDmgThisTurn > 0 },
    { name: "<:TremorBurst:1513802464632246352>Tremor Burst", value: `-${totalTremorStaminaLoss} Sta địch — count: ${tremorInit} → ${finalTremor}`, inline: true, showIf: tremorInit > 0 || finalTremor > 0 || totalTremorStaminaLoss > 0 },
    { name: "<:Charge:1513762867558613033>Charge Stacks", value: `${chargeInit} → ${finalCharge}`, inline: true, showIf: chargeInit > 0 || finalCharge > 0 },
  ];

  return {
    embeds: [{
      title: "📊 Kết quả tính DMG",
      color: 0x00ae86,
      fields: filterZeroFields(allFields),
    }],
  };
}

module.exports = { calcMathCore, calcMath, saturateBonusPct, saturateDR, validateMathInputs };
