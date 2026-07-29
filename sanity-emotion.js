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
    // GAP MỚI (audit accessory.js theo yêu cầu trực tiếp) — "Energetic"
    // (Composition Tool): "Gia tăng x2 hiệu quả nhận Emotion Coin" — CHỈ nhân
    // khi delta DƯƠNG (nhận thêm coin), KHÔNG nhân khi delta ÂM (tiêu coin,
    // VD Shin/Mang) — "nhận" trong mô tả gốc chỉ nói việc CỘNG thêm. Đặt Ở
    // ĐÂY (hàm trung tâm duy nhất mọi nơi gọi applyEmotionDelta) để áp dụng
    // đồng nhất cho MỌI nguồn Emotion Coin (M1, Critical, Emotion Coin từ
    // giết địch/đồng đội chết...), không cần sửa từng điểm gọi riêng lẻ.
    const effectiveDelta = delta > 0 && (combatant.equippedAccessoriesSnapshot ?? []).map(a => a.toLowerCase()).includes("composition tool") ? delta * 2 : delta;
    // BUG ĐÃ SỬA (xác nhận trực tiếp: "emotion level thì không cho âm coin, dù có
    // trừ thì tới 0 là dừng") — trước đây cộng delta trực tiếp KHÔNG clamp, coin
    // có thể âm vô hạn (VD Shin/Mang tốn 1 Coin nhiều lần liên tiếp).
    combatant.emotionCoin = Math.max(0, (combatant.emotionCoin ?? 0) + effectiveDelta);
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
