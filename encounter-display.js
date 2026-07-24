// encounter-display.js
// Nhóm hàm tra cứu/hiển thị combatant thuần (resolveCombatant, resolveTargets,
// formatCombatantBlock) — tách khỏi index.js theo yêu cầu trực tiếp: "tiếp tục
// tách hàm ra thành file riêng". Dùng pattern dependency-injection GIỐNG các file
// đã tách trước (factory function nhận dependency làm tham số).
//
// LƯU Ý: 6 hàm performGuardEvade/performParry/performShinMang/performManifestEgo/
// performOvercharge/performFollowUp NẰM XEN GIỮA formatCombatantBlock và
// buildEncounterActionPanel trong index.js gốc, nhưng CỐ Ý KHÔNG tách theo đợt
// này — các hàm đó ASYNC, dùng Redis trực tiếp (withLock/getEncounter/
// saveEncounter) + nhiều dependency phức tạp khác, rủi ro cao hơn nếu vội. Để lại
// cho đợt tách riêng sau.
//
// normalizeEnemyKey/getMaxEmotionLevel/EMOTION_LEVEL_TABLE GIỮ NGUYÊN trong
// index.js (dùng RỘNG RÃI ở nhiều nơi khác không liên quan tới 3 hàm này) — inject
// vào thay vì định nghĩa lại.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ normalizeEnemyKey, getMaxEmotionLevel, EMOTION_LEVEL_TABLE }) {

  /** resolveCombatant — tra 1 "id" (key enemy HOẶC userId player) thành combatant
   *  thật + label hiển thị + loại ("enemy"|"player"). Dùng chung cho mọi nơi cần tra
   *  1 bên cụ thể (không phải multi-target — xem resolveTargets cho multi-target). */
  function resolveCombatant(encounter, id) {
    if (encounter.enemies[id]) return { combatant: encounter.enemies[id], label: `**${encounter.enemies[id].name}**`, type: "enemy" };
    if (encounter.players[id]) return { combatant: encounter.players[id], label: `<@${id}>`, type: "player" };
    return null;
  }
  
  /**
   * resolveTargets — tìm combatant theo target: <key/mention/all>.
   * allowedType:
   *   "enemy"  — CHỈ tìm trong enemies (hành vi cũ, doEnemyAttack KHÔNG dùng giá trị
   *              này — xem "player" dưới).
   *   "player" — CHỈ tìm trong players (doEnemyAttack — enemy đánh player, hành vi cũ
   *              giữ nguyên 100%).
   *   "enemy_or_player" — PvP: player M1/Page giờ có thể target ENEMY (ưu tiên thử
   *              trước, giữ đúng cú pháp key ngắn cũ "mo") HOẶC PLAYER khác (mention/ID
   *              — tự nhận diện, không cần cú pháp riêng). "all" vẫn chỉ áp dụng cho
   *              enemy (pool mặc định) — "tất cả" trong ngữ cảnh có cả PvE+PvP cùng lúc
   *              dễ gây nhầm lẫn nếu áp cho cả 2 phe, nên giữ AN TOÀN: phải gõ rõ từng
   *              player muốn nhắm nếu là PvP, "all" KHÔNG tự động gồm cả player.
   */
  function resolveTargets(encounter, targetStr, allowedType) {
    const searchEnemy = allowedType === "enemy" || allowedType === "enemy_or_player";
    const searchPlayer = allowedType === "player" || allowedType === "enemy_or_player";
    const primaryIsEnemy = allowedType === "enemy" || allowedType === "enemy_or_player";
    const primaryPool = primaryIsEnemy ? encounter.enemies : encounter.players;
    const primaryLabel = primaryIsEnemy ? "enemy" : "player";
    const trimmed = (targetStr ?? "").trim();
    if (!trimmed) throw new Error(`Cần chỉ định target: (VD: \`target: mo\` hoặc \`target: all\`).`);
    if (trimmed.toLowerCase() === "all") {
      const ids = Object.keys(primaryPool);
      if (ids.length === 0) throw new Error(`Chưa có ${primaryLabel} nào trong encounter để chọn "all".`);
      return ids.map(id => ({ id, combatant: primaryPool[id], label: primaryIsEnemy ? `**${primaryPool[id].name}**` : `<@${id}>`, type: primaryLabel }));
    }
    const rawKeys = trimmed.split(",").map(s => s.trim());
    const results = [];
    const notFound = [];
    for (const rawKey of rawKeys) {
      let matched = false;
      if (searchEnemy) {
        const enemyKey = normalizeEnemyKey(rawKey);
        if (encounter.enemies[enemyKey]) {
          results.push({ id: enemyKey, combatant: encounter.enemies[enemyKey], label: `**${encounter.enemies[enemyKey].name}**`, type: "enemy" });
          matched = true;
        }
      }
      if (!matched && searchPlayer) {
        const playerId = rawKey.replace(/[<@!>]/g, "");
        if (encounter.players[playerId]) {
          results.push({ id: playerId, combatant: encounter.players[playerId], label: `<@${playerId}>`, type: "player" });
          matched = true;
        }
      }
      if (!matched) notFound.push(rawKey);
    }
    if (notFound.length > 0) {
      const poolDesc = allowedType === "enemy_or_player" ? "enemy/player" : primaryLabel;
      throw new Error(`Không tìm thấy ${poolDesc}: ${notFound.join(", ")} — dùng \`-encounter status\` để xem danh sách.`);
    }
    return results;
  }
  
  /** Render 1 dòng trạng thái cho 1 combatant (enemy hoặc player) — dùng chung để
   *  không lặp code giữa phần hiện enemy và phần hiện từng player. */
  function formatCombatantBlock(combatant, label) {
    const hpPct = combatant.maxHp > 0 ? Math.max(0, combatant.currentHp / combatant.maxHp) : 0;
    const filled = Math.round(hpPct * 10);
    const hpBar = "🟥".repeat(filled) + "⬛".repeat(10 - filled);
    const r = combatant.resistance;
    const resLine = combatant.staggered
      ? `2x/2x/2x (STAGGER, gốc ${r.B}xB ${r.P}xP ${r.S}xS)`
      : combatant.shinMangActive
        ? `${Math.max(0, r.B - 0.2)}xB ${Math.max(0, r.P - 0.2)}xP ${Math.max(0, r.S - 0.2)}xS (gốc ${r.B}xB ${r.P}xP ${r.S}xS, đang Shin -0,2x)`
        : `${r.B}xB ${r.P}xP ${r.S}xS`;
    const lines = [
      `**${label}**${combatant.currentHp <= 0 ? " — ĐÃ HẠ! 💀" : ""}`,
      `${hpBar} **${Math.max(0, Math.round(combatant.currentHp * 100) / 100)}/${combatant.maxHp}** HP`,
      `> Stamina: **${combatant.currentStamina}/${combatant.maxStamina}**${combatant.maxSanity > 0 ? ` | Sanity: **${combatant.currentSanity}/${combatant.maxSanity}**` : ""}${combatant.maxLight > 0 ? ` | Light: **${combatant.currentLight}/${combatant.maxLight}**` : ""}`,
      `> Res: **${resLine}** | Vũ khí: **${combatant.weaponWeight}**`,
      `> Speed Range: **${combatant.speedRangeMin}~${combatant.speedRangeMax}**${combatant.currentSpeed !== null ? ` | Speed turn này: **${combatant.currentSpeed}**` : ""}${combatant.haste > 0 ? ` | <:Haste:1375181763994849333>${combatant.haste}` : ""}${combatant.bind > 0 ? ` | <:Fix_Bind:1513768025881317457>${combatant.bind}` : ""}`,
    ];
    // eyeOfHorusAmmo — GAP ĐÃ SỬA (xác nhận trực tiếp): "tôi không thấy phần
    // stack ammo ở phần encounter status" — pool NỘI TẠI riêng của Eye Of Horus
    // (8, reset mỗi turn), chỉ hiển thị cho người ĐANG cầm vũ khí này.
    if ((combatant.weaponName ?? "").toLowerCase() === "eye of horus") {
      lines.push(`> 🏹 Eye Of Horus Ammo: **${combatant.eyeOfHorusAmmo ?? 8}/8** (reset khi hết turn)`);
    }
    if ((combatant.guardCharges ?? 0) > 0 || (combatant.evadeCharges ?? 0) > 0) {
      const parts = [];
      if (combatant.guardCharges > 0) parts.push(`🛡️ Guard sẵn sàng x${combatant.guardCharges}`);
      if (combatant.evadeCharges > 0) parts.push(`💨 Evade sẵn sàng x${combatant.evadeCharges}`);
      lines.push(`> ${parts.join(" | ")}`);
    }
    const lvl = combatant.emotionLevel ?? 0;
    const maxLvl = getMaxEmotionLevel(combatant);
    let emotionLine = `> Emotion Level **${lvl}**`;
    if (lvl < maxLvl) emotionLine += ` [Coin: ${combatant.emotionCoin ?? 0}/${EMOTION_LEVEL_TABLE[lvl + 1].coinNeeded}]`;
    else emotionLine += ` (MAX) [Coin: ${combatant.emotionCoin ?? 0}]`;
    if (lvl > 0) {
      emotionLine += !Number.isFinite(combatant.emotionLevelTurnsLeft)
        ? ` — 🔆 vĩnh viễn (Light Body)`
        : ` — còn ${combatant.emotionLevelTurnsLeft} turn`;
    } else if ((combatant.emotionLevelCooldownLeft ?? 0) > 0) {
      emotionLine += ` — ⏳ CD còn ${combatant.emotionLevelCooldownLeft} turn`;
    }
    lines.push(emotionLine);
    if ((combatant.unlockedPerks ?? []).length > 0) lines.push(`> ✨ Perk: ${combatant.unlockedPerks.join(", ")}`);
    if ((combatant.overchargedTurnsLeft ?? 0) > 0) lines.push(`> ⚡ **Overcharged** — +${combatant.overchargedDiceUpBonus} Dice Up, +${combatant.overchargedDmgBonusPct}% Dmg — còn ${combatant.overchargedTurnsLeft} turn`);
    if ((combatant.breakTheDamsCdLeft ?? 0) > 0) lines.push(`> ⏳ Break the Dams CD — còn ${combatant.breakTheDamsCdLeft} turn`);
    if (combatant.shinMangActive) lines.push(`> 🌑 **Shin/Mang active** (vòng ${combatant.shinMangRounds}) — -0,2x Res bản thân, +${combatant.shinMangRounds * 10}% Dmg M1+skill, True Dmg`);
    if ((combatant.consumablesLoadout ?? []).length > 0) lines.push(`> 🎒 Item mang vào: ${combatant.consumablesLoadout.join(", ")} (${combatant.consumablesLoadout.length}/4)${combatant.usedItemThisTurn ? " — đã dùng 1 turn này" : ""}`);
    if (combatant.manifestedEGO) lines.push(`> 😈 **Manifest E.G.O** — còn ${combatant.manifestedEGOTurnsLeft} turn — +3 Dice Up, +30% Dmg M1+skill`);
    else if ((combatant.manifestedEGOCooldownLeft ?? 0) > 0) lines.push(`> ⏳ Manifest E.G.O CD — còn ${combatant.manifestedEGOCooldownLeft} turn`);
    if ((combatant.injuries ?? []).length > 0) lines.push(`> 🩻 Chấn thương: ${combatant.injuries.join(", ")}`);
    // gmNote (xác nhận trực tiếp: "thêm note lên chỗ status của player hoặc
    // boss/mob phòng trong các status đặc biệt mà chưa kịp implement vào
    // code") — chỉ hiện khi GM đã set nội dung.
    if (combatant.gmNote) lines.push(`> 📝 Text: ${combatant.gmNote}`);
    // Choáng (dazedStacks) — counter tự động mỗi lần Stagger (xem checkStaggerPanic),
    // KHÔNG còn nằm trong injuries[] nữa — hiển thị riêng để GM/player biết khi nào
    // Stagger sẽ kéo dài 2 turn thay vì 1 (từ stack thứ 2 trở lên).
    if ((combatant.dazedStacks ?? 0) > 0) lines.push(`> 💫 Choáng: ${combatant.dazedStacks} stack${combatant.dazedStacks >= 2 ? " (Stagger lần tới sẽ kéo dài 2 turn)" : ""}`);
    const statusParts = [];
    if (combatant.sinking > 0) statusParts.push(`<:Sinking:1513762793436741652>${combatant.sinking}`);
    if (combatant.rupture > 0) statusParts.push(`<:Rupture:1513762812722155682>${combatant.rupture}`);
    if (combatant.poise > 0) statusParts.push(`<:Poise:1513762945715142736>${combatant.poise}`);
    if (combatant.charge > 0) statusParts.push(`<:Charge:1513762867558613033>${combatant.charge}`);
    if (combatant.burn > 0) statusParts.push(`<:Burn:1513762753691652177>${combatant.burn}`);
    if (combatant.bleed > 0) statusParts.push(`<:Bleed:1513762688226955285>${combatant.bleed}`);
    if (combatant.tremor > 0) statusParts.push(`<:Tremor:1513762737388257380>${combatant.tremor}`);
    if (combatant.paralyze > 0) statusParts.push(`<:Paralyze:1513763316479295548>${combatant.paralyze}`);
    if (combatant.diceUp > 0) statusParts.push(`<:DiceUp:1513767795681398894>${combatant.diceUp}`);
    if (combatant.diceDown > 0) statusParts.push(`<:DiceDown:1513767826257874964>${combatant.diceDown}`);
    if (combatant.smoke > 0) statusParts.push(`<:Smoke:1513778039610282015>${combatant.smoke}`);
    if (combatant.vengeanceMark > 0) statusParts.push(`<:VengeanceMark:1513768136023740436>${combatant.vengeanceMark}`);
    if (combatant.nails > 0) statusParts.push(`<:Nails:1513768423124111482>${combatant.nails}`);
    if (combatant.redPlumBlossom > 0) statusParts.push(`<:Red_Plum_Blossom:1513768345521094668>${combatant.redPlumBlossom}`);
    // "Rà soát toàn bộ status" — GAP MỚI (xác nhận trực tiếp): "Bạn phải làm
    // toàn bộ status là buff lẫn debuff tự động hóa lẫn hiển thị chứ" — 7
    // status dưới đây ĐÃ tự động hoá đầy đủ từ trước (ảnh hưởng dmg/guard/
    // clash thật, xác nhận qua audit code) nhưng CHƯA TỪNG hiển thị trên board.
    if ((combatant.fragile ?? 0) > 0) statusParts.push(`Fragile${combatant.fragile}`);
    if ((combatant.attackPowerUp ?? 0) > 0) statusParts.push(`Attack Power Up${combatant.attackPowerUp}`);
    if ((combatant.attackPowerDown ?? 0) > 0) statusParts.push(`Attack Power Down${combatant.attackPowerDown}`);
    if ((combatant.defenseUp ?? 0) > 0) statusParts.push(`Defense Up${combatant.defenseUp}`);
    if ((combatant.defenseDown ?? 0) > 0) statusParts.push(`Defense Down${combatant.defenseDown}`);
    if ((combatant.clashAttackBoost ?? 0) > 0) statusParts.push(`Clash Attack Boost${combatant.clashAttackBoost}`);
    if ((combatant.chargeShieldStack ?? 0) > 0) statusParts.push(`Charge Shield${combatant.chargeShieldStack}`);
    if ((combatant.dullahanStacks ?? 0) > 0) statusParts.push(`Dullahan${combatant.dullahanStacks}`);
    if ((combatant.unopposedAttackBoost ?? 0) > 0) statusParts.push(`Unopposed Attack Boost${combatant.unopposedAttackBoost}`);
    if ((combatant.imitationConsumedTotal ?? 0) > 0) statusParts.push(`Imitation Consumed${combatant.imitationConsumedTotal}`);
    // Rà soát TOÀN BỘ 119 field combatant-factory.js (không chỉ danh sách GM
    // Panel) — GAP MỚI (xác nhận trực tiếp): "cứ rà hết đi" — 14 field dưới đây
    // ĐÃ tự động hoá đầy đủ (xác nhận qua audit code) nhưng CHƯA TỪNG hiển thị.
    if ((combatant.bulletStack ?? 0) > 0) statusParts.push(`🔫 Đạn Soldato Rifle: ${combatant.bulletStack}/8${combatant.bulletStackType ? ` (${combatant.bulletStackType})` : ""}`);
    if ((combatant.coffinStacks ?? 0) > 0) statusParts.push(`Coffin${combatant.coffinStacks}`);
    if ((combatant.darkCloudOutfitStacks ?? 0) > 0) statusParts.push(`Dark Cloud${combatant.darkCloudOutfitStacks}`);
    if ((combatant.graceOfPrescript ?? 0) > 0) statusParts.push(`Grace of Prescript${combatant.graceOfPrescript}`);
    if ((combatant.imitation ?? 0) > 0) statusParts.push(`Imitation${combatant.imitation}`);
    if (combatant.prescriptRoll !== null && combatant.prescriptRoll !== undefined) {
      const PRESCRIPT_ROLL_LABELS = { 1: "Tấn công 1 lần", 2: "Né 1 lần", 3: "Block 1 lần", 4: "Parry 1 lần", 5: "1 phòng thủ + 1 tấn công", 6: "Không làm gì", 7: "Clash với 1 skill" };
      statusParts.push(`<:Prescript:1528452494945157281>Sắc lệnh #${combatant.prescriptRoll} (${PRESCRIPT_ROLL_LABELS[combatant.prescriptRoll] ?? "?"})`);
    }
    if ((combatant.scorchPropellantRound ?? 0) > 0) statusParts.push(`<:Scorch_Propellant_Ammo:1528452773690085416>Scorch Propellant Round${combatant.scorchPropellantRound}`);
    if ((combatant.tigermarkRound ?? 0) > 0) statusParts.push(`<:Tigermark_Round:1528452815838777394>Tigermark Round${combatant.tigermarkRound}`);
    if ((combatant.savageTigermarkRound ?? 0) > 0) statusParts.push(`<:Savage_Tigermark_Round:1528452850248843304>Savage Tigermark Round${combatant.savageTigermarkRound}`);
    if (combatant.tacticalSuppressionCdPending) statusParts.push(`Tactical Suppression CD: còn ${combatant.tacticalSuppressionCdTurnsLeft ?? 0}T`);
    if ((combatant.weaponIgnitedTurnsLeft ?? 0) > 0) statusParts.push(`🔥 Vũ khí bốc cháy: còn ${combatant.weaponIgnitedTurnsLeft}T`);
    if ((combatant.setFireTurnsLeft ?? 0) > 0) statusParts.push(`🔥 Set Fire: còn ${combatant.setFireTurnsLeft}T`);
    if ((combatant.lightDashFreeEvadeCharges ?? 0) > 0) statusParts.push(`Light Dash Free Evade${combatant.lightDashFreeEvadeCharges}`);
    if ((combatant.gmBonusPctOverride ?? 0) !== 0) statusParts.push(`⚙️GM Dmg Override: ${combatant.gmBonusPctOverride >= 0 ? "+" : ""}${combatant.gmBonusPctOverride}%`);
    if ((combatant.gmReductionPctOverride ?? 0) !== 0) statusParts.push(`⚙️GM Reduction Override: ${combatant.gmReductionPctOverride >= 0 ? "+" : ""}${combatant.gmReductionPctOverride}%`);
    if (combatant.freeble > 0) statusParts.push(`Freeble${combatant.freeble}`);
    if (combatant.borrowedTime > 0) statusParts.push(`Borrowed Time${combatant.borrowedTime} (còn ${combatant.borrowedTimeTurnsLeft ?? 0}T)`);
    if (combatant.fairy > 0) statusParts.push(`<:Fairy:1513782007602216960>${combatant.fairy} (còn ${combatant.fairyTurnsLeft ?? 0}T)`);
    if (combatant.airborne) statusParts.push(`Airborne`);
    if (combatant.chains) statusParts.push(`<:chained:1513782041307643984>Chains`);
    if (combatant.sizzlingWound) statusParts.push(`Sizzling Wound`);
    if (combatant.perceptionBlockingMask) statusParts.push(`Perception Blocking Mask`);
    if (combatant.blackSilence) statusParts.push(`Struggling`);
    if (combatant.tremorEverlasting > 0) statusParts.push(`Tremor Everlasting${combatant.tremorEverlasting}`);
    if (combatant.tremorFracture > 0) statusParts.push(`Tremor Fracture${combatant.tremorFracture}`);
    if (combatant.tremorReverb > 0) statusParts.push(`Tremor Reverb${combatant.tremorReverb}`);
    if (combatant.tremorDecay > 0) statusParts.push(`Tremor Decay${combatant.tremorDecay}`);
    if (combatant.tremorChain > 0) statusParts.push(`Tremor Chain${combatant.tremorChain}`);
    if (combatant.tremorScorch) statusParts.push(`Tremor Scorch`);
    if (combatant.tremorHemorrhage) statusParts.push(`Tremor Hemorrhage`);
    if (combatant.spectroFrazzle > 0) statusParts.push(`Spectro Frazzle${combatant.spectroFrazzle}${combatant.spectroFrazzlePendingLoss > 0 ? ` (nợ ${combatant.spectroFrazzlePendingLoss} Sta chờ hồi)` : ""}`);
    if (combatant.gazeAwe > 0) statusParts.push(`<:Gaze_of_Contempt:1528452157932703934>Gaze[Awe]${combatant.gazeAwe}${combatant.gazeAweSourceId ? ` (↔${combatant.gazeAweSourceId})` : ""}`);
    if (combatant.contempt > 0) statusParts.push(`<:Contempt_of_the_Gaze:1528452101825495100>Contempt${combatant.contempt}${combatant.contemptSourceId ? ` (↔${combatant.contemptSourceId})` : ""}`);
    if (combatant.gazeOfContempt > 0) statusParts.push(`<:Gaze_of_Contempt:1528452157932703934>Gaze of Contempt${combatant.gazeOfContempt}`);
    if (combatant.contemptOfTheGaze) statusParts.push(`<:Contempt_of_the_Gaze:1528452101825495100>Contempt of the Gaze`);
    if (combatant.haouFlame > 0) statusParts.push(`Haou Flame${combatant.haouFlame}`);
    if (combatant.haouBleed > 0) statusParts.push(`Haou Bleed${combatant.haouBleed}`);
    if (combatant.haouTremor > 0) statusParts.push(`Haou Tremor${combatant.haouTremor}`);
    if (combatant.haouRupture > 0) statusParts.push(`Haou Rupture${combatant.haouRupture}`);
    if (combatant.haouSinking > 0) statusParts.push(`Haou Sinking${combatant.haouSinking}`);
    if (combatant.hemorrhage > 0) statusParts.push(`Hemorrhage${combatant.hemorrhage}`);
    if (combatant.burningSensation) statusParts.push(`Burning Sensation`);
    if (combatant.busyAsTribbie) statusParts.push(`Busy as Tribbie${combatant.busyAsTribbieSourceId ? ` (↔${combatant.busyAsTribbieSourceId})` : ""}`);
    if (combatant.timeMoratorium) statusParts.push(`Time Moratorium (tích ${combatant.timeMoratoriumAccumulated.toFixed(1)} dmg, còn ${combatant.timeMoratoriumTurnsLeft}T)`);
    if (combatant.ammo > 0) statusParts.push(`<:Ammo:1528452673664319629>Ammo${combatant.ammo}`);
    if (combatant.frostAmmo > 0) statusParts.push(`<:Ammo:1528452673664319629>Frost Ammo${combatant.frostAmmo}`);
    if (combatant.incendiaryAmmo > 0) statusParts.push(`<:Ammo:1528452673664319629>Incendiary Ammo${combatant.incendiaryAmmo}`);
    // "Protection"/"Regen" (50-Status Nhóm 1) — GAP ĐÃ SỬA: đã tự động hoá đầy
    // đủ logic (attacker-perk-context.js's dmg bonus, resolve-pending-action.js's
    // hồi HP) từ trước nhưng CHƯA TỪNG hiển thị trên board — thêm emoji mới,
    // hiển thị luôn cho player theo dõi.
    if (combatant.protection > 0) statusParts.push(`<:Protection:1528452299834261545>Protection${combatant.protection}${combatant.protectionTurnsLeft > 0 ? ` (còn ${combatant.protectionTurnsLeft}T)` : ""}`);
    if (combatant.regen > 0) statusParts.push(`<:Regen:1528452633122050279>Regen${combatant.regen}`);
    // "Shield HP" — GAP ĐÃ SỬA (xác nhận trực tiếp): "tôi không thấy shield hp"
    // — trước đây HOÀN TOÀN không hiển thị (dù đã có field/logic kích hoạt).
    if (combatant.shieldHp > 0) statusParts.push(`🛡️Shield HP${combatant.shieldHp.toFixed(1)}${combatant.tacticalSuppressionActive ? ` (còn ${combatant.tacticalSuppressionTurnsLeft ?? 0}T)` : ""}`);
    if (statusParts.length > 0) lines.push(`> ${statusParts.join(" | ")}`);
    // "Tổng hợp Dmg Bonus/Reduction" — GAP MỚI (xác nhận trực tiếp): "nên hiện
    // cả dmg reduction, dmg bonus... như 50 karmic consquence sẽ là +50% Dmg
    // taken... để player có thể check" — CHỈ tổng hợp các hiệu ứng SELF-
    // CONTAINED (không phụ thuộc đang đánh AI/dùng skill gì cụ thể — VD Gaze[Awe]
    // phụ thuộc target đang đánh nên KHÔNG hiện ở đây, xem attacker-perk-context.js
    // để biết đầy đủ những gì có ĐIỀU KIỆN theo từng đòn cụ thể).
    const dmgEffectParts = [];
    if ((combatant.karmicConsequence ?? 0) > 0) dmgEffectParts.push(`+${combatant.karmicConsequence}% Dmg Taken (Karmic Consequence)`);
    if ((combatant.fragile ?? 0) > 0) dmgEffectParts.push(`+${combatant.fragile}% Dmg Taken (Fragile)`);
    if ((combatant.hemorrhage ?? 0) > 0) dmgEffectParts.push(`+${combatant.hemorrhage * 10}% Dmg Taken (Hemorrhage)`);
    // "Gaze[Awe]"/"Contempt" — GAP ĐÃ SỬA (xác nhận trực tiếp): "vẫn nên làm
    // hiển thị trên người kẻ địch chứ, nó là debuff mà nên phải hiện ra hết" —
    // dữ liệu debuff (số stack + nguồn gắn CỐ ĐỊNH) luôn biết trước, không phụ
    // thuộc "đang đánh ai" — chỉ ĐIỀU KIỆN áp dụng mới phụ thuộc (đúng nguồn),
    // nên vẫn tóm tắt được, chỉ cần ghi rõ điều kiện áp dụng.
    if ((combatant.gazeAwe ?? 0) > 0) dmgEffectParts.push(`+${combatant.gazeAwe * 10}% Dmg Taken (Gaze[Awe], 2 chiều với ${combatant.gazeAweSourceId ? `<@${combatant.gazeAweSourceId}>` : "nguồn đã gắn"})`);
    if ((combatant.contempt ?? 0) > 0) dmgEffectParts.push(`-50% Dmg Taken & -50% Dmg Bonus khi đối đầu ${combatant.contemptSourceId ? `<@${combatant.contemptSourceId}>` : "nguồn đã gắn"} (Contempt)`);
    if ((combatant.protection ?? 0) > 0) dmgEffectParts.push(`-${combatant.protection}% Dmg Taken (Protection)`);
    if ((combatant.chargeShieldStack ?? 0) > 0) dmgEffectParts.push(`-${combatant.chargeShieldStack * 10}% Dmg Taken (Charge Shield)`);
    if ((combatant.dullahanStacks ?? 0) > 0) dmgEffectParts.push(`+30% Dmg Bonus (Dullahan)`);
    if ((combatant.gazeOfContempt ?? 0) > 0) dmgEffectParts.push(`+${combatant.gazeOfContempt * 7}% Dmg Bonus (Gaze of Contempt)`);
    if (combatant.contemptOfTheGaze) dmgEffectParts.push(`-70% Dmg Bonus (Contempt of the Gaze)`);
    if ((combatant.unopposedAttackBoost ?? 0) > 0) dmgEffectParts.push(`+15% Dmg Bonus (Unopposed Attack Boost)`);
    if ((combatant.imitationConsumedTotal ?? 0) > 0) dmgEffectParts.push(`+${Math.min(50, combatant.imitationConsumedTotal * 5)}% Dmg Bonus (The Imitation)`);
    if (dmgEffectParts.length > 0) lines.push(`> 📊 ${dmgEffectParts.join(" | ")}`);
    if (combatant.staggered) lines.push(`> 💫 **STAGGER** — còn ${combatant.staggerTurnsLeft} turn`);
    if (combatant.panic) lines.push(`> 😱 **PANIC** — còn ${combatant.panicTurnsLeft} turn`);
    if ((combatant.buffs ?? []).length > 0) lines.push(`> 🟢 Buff: ${combatant.buffs.map(b => b.text).join(" | ")}`);
    if ((combatant.debuffs ?? []).length > 0) lines.push(`> 🔴 Debuff: ${combatant.debuffs.map(d => d.text).join(" | ")}`);
    const cds = Object.entries(combatant.skillCooldowns ?? {});
    // BUG ĐÃ SỬA (xác nhận trực tiếp: "Durandal CD có 2 turn nhưng ở đây lại hiện
    // 3 turn") — giá trị NỘI BỘ (combatant.skillCooldowns) cố ý lưu = cooldownTurns
    // + 1 (xem comment đầy đủ ở nơi set giá trị này, lúc confirm action) để đảm
    // bảo đúng số turn phải chờ thật — nhưng HIỂN THỊ phải trừ lại 1 để khớp đúng
    // số CD ghi trên skill (VD "CD: 2 Turn" → hiện "2T" ngay lúc vừa dùng, không
    // phải "3T").
    if (cds.length > 0) lines.push(`> ⏱️ CD: ${cds.map(([k, v]) => `${k} (${v - 1}T)`).join(" | ")}`);
    return lines.join("\n");
  }

  return {
    resolveCombatant,
    resolveTargets,
    formatCombatantBlock,
  };
}; 