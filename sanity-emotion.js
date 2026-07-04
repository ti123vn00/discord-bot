// sanity-emotion.js
// 4 hàm xử lý Sanity/Emotion Level (getEffectiveSanityForDiceBonus, applySanityGain,
// applyClashLossSanity, applyEmotionDelta) — tách khỏi index.js theo yêu cầu trực
// tiếp: "tách tiếp đi, một mạch luôn". Đều THUẦN (thao tác trực tiếp combatant
// object), chỉ cần hasPerk/getMaxEmotionLevel/EMOTION_LEVEL_TABLE/
// EMOTION_LEVEL_DURATION_TURNS/ENCOUNTER_SANITY_MAX inject vào.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ hasPerk, getMaxEmotionLevel, EMOTION_LEVEL_TABLE, EMOTION_LEVEL_DURATION_TURNS, ENCOUNTER_SANITY_MAX }) {

  function getEffectiveSanityForDiceBonus(combatant) {
    return hasPerk(combatant, "Negative Thoughts") ? -combatant.currentSanity : combatant.currentSanity;
  }
  
  function applySanityGain(combatant, amount) {
    if (hasPerk(combatant, "Negative Thoughts")) {
      combatant.currentSanity = Math.max(-ENCOUNTER_SANITY_MAX, combatant.currentSanity - amount);
    } else {
      combatant.currentSanity = Math.min(ENCOUNTER_SANITY_MAX, combatant.currentSanity + amount);
    }
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
    if (!delta) return notes;
    // BUG ĐÃ SỬA (xác nhận trực tiếp: "emotion level thì không cho âm coin, dù có
    // trừ thì tới 0 là dừng") — trước đây cộng delta trực tiếp KHÔNG clamp, coin
    // có thể âm vô hạn (VD Shin/Mang tốn 1 Coin nhiều lần liên tiếp).
    combatant.emotionCoin = Math.max(0, (combatant.emotionCoin ?? 0) + delta);
    const maxLevel = getMaxEmotionLevel(combatant);
    while (
      combatant.emotionLevel < maxLevel &&
      (combatant.emotionLevel > 0 || (combatant.emotionLevelCooldownLeft ?? 0) <= 0) &&
      combatant.emotionCoin >= EMOTION_LEVEL_TABLE[combatant.emotionLevel + 1].coinNeeded
    ) {
      const nextLevel = combatant.emotionLevel + 1;
      const tier = EMOTION_LEVEL_TABLE[nextLevel];
      combatant.emotionCoin -= tier.coinNeeded;
      combatant.emotionLevel = nextLevel;
      combatant.emotionLevelCooldownLeft = 0; // đang active — không còn CD nào treo nữa
      combatant.emotionLevelTurnsLeft = hasPerk(combatant, "Light Body") ? Infinity : EMOTION_LEVEL_DURATION_TURNS;
      const healAmount = Math.round(combatant.maxHp * tier.healPct / 100 * 100) / 100;
      combatant.currentHp = Math.min(combatant.maxHp, combatant.currentHp + healAmount);
      combatant.maxLight = combatant.baseMaxLight + tier.maxLightBonus;
      if (hasPerk(combatant, "Emotion Surge")) combatant.currentLight = combatant.maxLight;
      else combatant.currentLight = Math.min(combatant.currentLight, combatant.maxLight);
      notes.push(`🆙 Emotion Level ${nextLevel}! (+${healAmount.toFixed(2)} HP, +${tier.diceUp} Dice Up khi dùng skill, Max Light → ${combatant.maxLight})`);
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
