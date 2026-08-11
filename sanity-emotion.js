// sanity-emotion.js
// 4 hàm xử lý Sanity/Emotion Level (getEffectiveSanityForDiceBonus, applySanityGain,
// applyClashLossSanity, applyEmotionDelta) — tách khỏi index.js theo yêu cầu trực
// tiếp: "tách tiếp đi, một mạch luôn". Đều THUẦN (thao tác trực tiếp combatant
// object), chỉ cần hasPerk/getMaxEmotionLevel/EMOTION_LEVEL_TABLE/
// EMOTION_LEVEL_DURATION_TURNS/ENCOUNTER_SANITY_MAX inject vào.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ healHpCapped, hasPerk, getMaxEmotionLevel, EMOTION_LEVEL_TABLE, EMOTION_LEVEL_DURATION_TURNS, ENCOUNTER_SANITY_MAX }) {

  function getEffectiveSanityForDiceBonus(combatant) {
    return hasPerk(combatant, "Negative Thoughts") ? -combatant.currentSanity : combatant.currentSanity;
  }
  
  function applySanityGain(combatant, amount) {
    // Địch khai `noSanity: true` (CHỈ boss "Nothing There") thì mọi nguồn Sanity
    // phải TRƯỢT hoàn toàn.
    // ⚠️ KHÔNG suy từ `maxSanity <= 0` — Fragaria xác nhận Rats/Hook Gang/Amon
    // ĐỀU CÓ Sanity, chỉ là START ở 0 rồi trôi tới ±45. Suy từ maxSanity sẽ vô
    // hiệu hoá Sanity của cả 4 mob đó (tôi đã sai đúng chỗ này 1 lần).
    // TRƯỚC ĐÂY vẫn cộng/trừ bình thường vào `currentSanity`, nên đủ nguồn thì
    // chỉ số này trôi tới ±45 và `checkStaggerPanic` cho boss **PANIC** — trạng
    // thái mà một sinh vật "không có Sanity" đáng lẽ miễn nhiễm.
    // Chặn Ở ĐÂY (nguồn duy nhất cộng Sanity) thay vì vá từng nơi gọi.
    if (combatant.noSanity === true) return;
    // BUG ĐÃ SỬA (test tự bắt): mỗi nhánh TRƯỚC ĐÂY chỉ kẹp MỘT phía —
    // nhánh thường chỉ `Math.min(+45, …)`, nhánh Negative Thoughts chỉ
    // `Math.max(-45, …)`. Gọi với `amount` ÂM ở nhánh thường (hoặc DƯƠNG ở nhánh
    // Negative Thoughts) là trôi vượt biên: đo được **-200** sau 20 lần
    // `applySanityGain(mob, -10)`.
    // Fragaria xác nhận biên đúng là **-45 … +45**. Kẹp CẢ HAI phía ở CẢ HAI
    // nhánh — không phụ thuộc vào việc caller có truyền số âm hay không.
    // (Hiện mọi caller đều truyền số dương nên chưa lộ, nhưng đây là hàm dùng
    // chung, không được để bẫy sẵn.)
    const raw = hasPerk(combatant, "Negative Thoughts")
      ? combatant.currentSanity - amount
      : combatant.currentSanity + amount;
    combatant.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, Math.min(ENCOUNTER_SANITY_MAX, raw));
  }
  
  /**
   * applyClashLossSanity — Sanity của bên THUA Clash. Bình thường -10 (luật gốc).
   * Negative Thoughts (Gloom, [30 Points]) có EXCEPTION RIÊNG cho đúng trường hợp
   * này: "khi thua clash sẽ tăng 30 Sanity" — đây KHÔNG phải chỉ đảo dấu -10 thành
   * +10 theo rule chung "nguồn tăng→giảm" (vì -10 vốn dĩ ĐÃ là nguồn giảm, rule
   * chung không đảo phần này) — mà là 1 con số HOÀN TOÀN RIÊNG (+30) được luật ghi
   * rõ, nên tách hẳn thành helper riêng thay vì tái dùng applySanityGain.
   */
  function applyClashLossSanity(combatant) {
    if (hasPerk(combatant, "Negative Thoughts")) {
      combatant.currentSanity = Math.min(ENCOUNTER_SANITY_MAX, combatant.currentSanity + 30);
    } else {
      combatant.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, combatant.currentSanity - 10);
    }
  }
  
  function applyEmotionDelta(combatant, delta) {
    const notes = [];
    // ❗ KHÔNG thoát sớm khi delta = 0.
    // `applyEmotionDelta(c, 0)` là cách turn-advance kích lại vòng level-up khi
    // Emotion CD vừa hết (Coin đã đọng sẵn, chỉ chờ được phép lên cấp).
    // Thoát sớm ở đây khiến cờ đó vô dụng — chính test này lôi ra.
    if (!delta && (combatant.emotionLevelCooldownLeft ?? 0) > 0) return notes;
    // "Energetic" (Composition Tool) — GAP ĐÃ SỬA (Fragaria: "toàn bộ accessory
    // trong accessory.js đều chưa được implement"): "Gia tăng x2 hiệu quả nhận
    // Emotion Coin". CHỈ nhân chiều DƯƠNG (nhận coin) — chiều âm là chi phí
    // (VD Shin/Mang tốn coin), nhân đôi chi phí là phản tác dụng hoàn toàn.
    if (delta > 0 && combatant.hasCompositionTool) delta *= 2;
    // BUG ĐÃ SỬA (xác nhận trực tiếp: "emotion level thì không cho âm coin, dù có
    // trừ thì tới 0 là dừng") — trước đây cộng delta trực tiếp KHÔNG clamp, coin
    // có thể âm vô hạn (VD Shin/Mang tốn 1 Coin nhiều lần liên tiếp).
    combatant.emotionCoin = Math.max(0, (combatant.emotionCoin ?? 0) + delta);
    const maxLevel = getMaxEmotionLevel(combatant);
    while (
      combatant.emotionLevel < maxLevel &&
      (combatant.emotionLevel > 0 || (combatant.emotionLevelCooldownLeft ?? 0) <= 0) &&
      // Chặn cứng: bảng có thể KHÔNG có cấp kế tiếp (dữ liệu thiếu / mock trong
      // test). Trước đây truy thẳng `.coinNeeded` ⇒ TypeError làm chết cả action.
      EMOTION_LEVEL_TABLE[combatant.emotionLevel + 1] != null &&
      combatant.emotionCoin >= EMOTION_LEVEL_TABLE[combatant.emotionLevel + 1].coinNeeded
    ) {
      const nextLevel = combatant.emotionLevel + 1;
      const tier = EMOTION_LEVEL_TABLE[nextLevel];
      combatant.emotionCoin -= tier.coinNeeded;
      combatant.emotionLevel = nextLevel;
      combatant.emotionLevelCooldownLeft = 0; // đang active — không còn CD nào treo nữa
      combatant.emotionLevelTurnsLeft = hasPerk(combatant, "Light Body") ? Infinity : EMOTION_LEVEL_DURATION_TURNS;
      // BUG ĐÃ SỬA (Fragaria: "Emotion level heal được máu ảo của Memories:
      // Compassion, cần gate kỹ hơn").
      // % hồi VẪN tính trên `maxHp` (đã gồm 100 máu ảo) — đó là phần thưởng của
      // món đồ, hồi nhiều hơn là đúng. Nhưng TRẦN hồi phải là `healCapHp`
      // (= maxHp GỐC): luật của Compassion là "+100 Max HP nhưng KHÔNG hồi lên
      // tới đó được". `Math.min(maxHp, …)` cũ cho hồi thẳng vào 100 máu ảo.
      const healAmount = Math.round(combatant.maxHp * tier.healPct / 100 * 100) / 100;
      const healedReal = healHpCapped ? healHpCapped(combatant, healAmount) : (() => {
        const b = combatant.currentHp; combatant.currentHp = Math.min(combatant.maxHp, b + healAmount); return combatant.currentHp - b;
      })();
      combatant.maxLight = combatant.baseMaxLight + tier.maxLightBonus;
      if (hasPerk(combatant, "Emotion Surge")) combatant.currentLight = combatant.maxLight;
      else combatant.currentLight = Math.min(combatant.currentLight, combatant.maxLight);
      notes.push(`🆙 Emotion Level ${nextLevel}! (+${healedReal.toFixed(2)} HP, +${tier.diceUp} Dice Up khi dùng skill, Max Light → ${combatant.maxLight})`);
      // "Black Suit" (outfit) — GAP MỚI (xác nhận trực tiếp): "Mỗi khi đạt
      // Emotion Level nhận được 1 Dice Up, 1 Clash Power và 1 Protection kéo
      // dài cho đến hết encounter" — Protection dùng ĐÚNG cơ chế
      // protectionTurnsLeft=Infinity đã có sẵn (không cần field mới). Dice
      // Up/Clash Attack Boost cần accumulator RIÊNG (persistentBonus) vì cả 2
      // đều bị reset về 0 mỗi turn ở turn-advance.js — được cộng LẠI mỗi turn
      // ở đó (xem comment tương ứng).
      if (combatant.equippedOutfit === "Black Suit") {
        combatant.blackSuitPersistentBonus = (combatant.blackSuitPersistentBonus ?? 0) + 1;
        combatant.protection = Math.min(20, (combatant.protection ?? 0) + 1);
        combatant.protectionTurnsLeft = Infinity;
        notes.push(`🖤 **Black Suit** — +1 Dice Up/Clash Attack Boost (kéo dài hết encounter, tổng ${combatant.blackSuitPersistentBonus}) và +1 Protection vĩnh viễn.`);
      }
    }
    return notes;
  }

  return {
    getEffectiveSanityForDiceBonus,
    applySanityGain,
    applyClashLossSanity,
    applyEmotionDelta,
  };
};
