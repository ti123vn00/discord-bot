// enemy-ai.js
// Stage 3 — AI phòng thủ cho enemy đánh dấu `aiControlled: true` (quest mob, xem
// party-board.js). Enemy "hành động như player" theo luật xác nhận trực tiếp:
//
//   1. LUÔN Guard nếu gặp 1 hit trong nhóm > 10% Max HP của mob.
//   2. LUÔN Guard nếu HP hiện tại ≤ 20% Max HP.
//   3. Nếu Guard không đủ Stamina → chuyển qua Evade.
//   4. Nếu Guard/Evade đã chọn sẽ khiến tự Stagger (Stamina về ≤0) → dùng Parry
//      thay (Parry 0 Sta lúc quyết định — rủi ro nằm ở kết quả roll).
//   5. Ngoài 2 điều kiện (1)+(2) — GIẢ ĐỊNH đã báo Fragaria: không phòng thủ (ăn
//      đòn để tiết kiệm Stamina cho tấn công), vì luật gốc không nói rõ case này.
//
// QUAN TRỌNG: hàm applyDefenseChoiceToTarget bên dưới CHỈ code phần cơ chế CỐT
// LÕI (Stamina cost, charges, hitSelections, parry roll) — KHÔNG xử lý các
// nhánh outfit/accessory đặc thù (Iron Horus, Zwei Association, Composition
// Tool, Giày Wan MK3 Resourceful/Chain-Dashes, Tactical Suppression...) vì mob
// do createCombatant tạo KHÔNG BAO GIỜ có các field cờ đó (chỉ player mới có,
// gán qua buildJoinedCombatant) — bỏ qua các nhánh này là AN TOÀN và ĐÚNG, không
// phải thiếu sót. Nếu sau này mob có hệ thống trang bị riêng, cần bổ sung lại.
//
// entry point: resolveAiDefenseForTarget(channelId, pendingId, targetId) — gọi
// từ reactive-defense.js's sendReactiveDefensePrompt khi target.aiControlled.
// Tự loop QUA TẤT CẢ nhóm hit còn lại cho target này trong 1 lần (không cần
// round-trip Discord như người thật), rồi tự finalizeReactiveChoice.
//
// aiHooks — object MUTABLE rỗng lúc require, được index.js gán field
// `finalizeReactiveChoice` vào NGAY SAU khi cả 2 module (enemy-ai.js VÀ
// reactive-defense.js) đã require xong — TRÁNH circular dependency thật (2 file
// cần lẫn nhau: reactive-defense.js cần resolveAiDefenseForTarget của file
// này, file này cần finalizeReactiveChoice của reactive-defense.js). Đọc qua
// aiHooks.finalizeReactiveChoice (LAZY, lúc GỌI hàm) thay vì inject trực tiếp
// (lúc CONSTRUCT factory) — an toàn vì mọi require() chạy xong TRƯỚC khi bot
// bắt đầu nhận message/interaction thật.

module.exports = function ({ applyHpLoss, cdKeyFor,
  withLock, encounterKey, getEncounter, saveEncounter, resolveCombatant,
  computeDefenseOptions, getParryClashPenalty, aiHooks,
  parsePerHitBypass, WEAPON_DEFENSE_HITS, WEAPON_STAMINA_COST, client, log,
  doEnemyAttack, findSkill, parseSkillCost, parseSkillCooldownTurns,
  autoBuildDmgStrFromSkillRoll, extractDefenseBypassTags,
  hasUnresolvedTargetPending, isCurrentTurnHolder, advanceToNextTurnHolder,
  appendActionLog, buildSkillRollResult, applySanityGain, applyEmotionDelta,
  applyClashLossSanity, checkStaggerPanic, hasPerk, combatantResStr, calcMathCore,
}) {
  /** decideDefenseChoice — thuần logic quyết định (không side-effect), nhận vào
   *  target combatant + options đã tính (opts) + dmg lớn nhất trong nhóm hit
   *  này (maxHitDmgInGroup) — trả về 1 trong "guard"/"evade"/"parry"/"none". */
  // Task yêu cầu trực tiếp: "cho AI có khả năng clash với skill của player" +
  // "AI có sử dụng được các page counter không" — CẢ 2 đều là quyết định "toàn
  // bộ pendingAction" (thắng = huỷ TOÀN BỘ đòn, không phải từng nhóm hit như
  // Guard/Evade/Parry) — nên xử lý RIÊNG, TRƯỚC vòng lặp per-group bên dưới.

  // pickClashSkill — tìm skill CÓ THỂ dùng để Clash: có Dice, không promptArg
  // (cần input đặc biệt, không tự động hoá được), đủ Light, không cooldown.
  // Ưu tiên Light cost CAO NHẤT (giống pickOffensiveSkill — giả định skill tốn
  // nhiều Light hơn thường mạnh/đáng tin hơn để đặt cược Clash).
  function pickClashSkill(target) {
    const candidates = [];
    for (const skillName of target.unlockedPagesSnapshot ?? []) {
      const skill = findSkill(skillName);
      if (!skill || skill.promptArg) continue;
      const cost = parseSkillCost(skill.cost);
      if ((cost.light ?? 0) > (target.currentLight ?? 0)) continue;
      const cdLeft = target.skillCooldowns?.[cdKeyFor(skillName)] ?? 0;
      if (cdLeft > 0) continue;
      const rolled = buildSkillRollResult({ skill });
      if (rolled.error || rolled.firstDiceValue === null) continue; // không có Dice thì không Clash được
      candidates.push({ skillKey: skillName.toLowerCase(), skill, lightCost: cost.light ?? 0, rolled });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.lightCost - a.lightCost);
    return candidates[0];
  }

  // pickCounterSkill — tìm page-counter (counterEffect) khả dụng, tương tự nhưng
  // KHÔNG cần Dice bắt buộc (nhiều counter page "noDirectDamage": true).
  function pickCounterSkill(target) {
    const candidates = [];
    for (const skillName of target.unlockedPagesSnapshot ?? []) {
      const skill = findSkill(skillName);
      if (!skill || !skill.counterEffect) continue;
      const cost = parseSkillCost(skill.cost);
      if ((cost.light ?? 0) > (target.currentLight ?? 0)) continue;
      const cdLeft = target.skillCooldowns?.[cdKeyFor(skillName)] ?? 0;
      if (cdLeft > 0) continue;
      candidates.push({ skillKey: skillName.toLowerCase(), skill, lightCost: cost.light ?? 0 });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.lightCost - a.lightCost);
    return candidates[0];
  }

  /** attemptAiClashOrCounter — thử Clash trước (nếu có skill), rồi Counter (nếu
   *  Clash không khả dụng hoặc thua) — CHỈ 1 TRONG 2, ưu tiên Clash vì Clash có
   *  thêm hiệu ứng phụ (Voracity/Pressure Point/Thorns) đa dạng hơn Counter.
   *  Trả về true nếu đã XỬ LÝ XONG toàn bộ pendingAction (thắng, huỷ hết đòn)
   *  — caller (resolveAiDefenseForTarget) SKIP vòng lặp per-group nếu true. */
  async function attemptAiClashOrCounter(channelId, encounter, p, target, targetId, attackerResolved) {
    const attackerFirstDiceMatch = (p.dmgStr ?? "").match(/^([\d.]+)/);
    const attackerFirstDiceValue = attackerFirstDiceMatch ? parseFloat(attackerFirstDiceMatch[1]) : null;
    if (attackerFirstDiceValue === null) return false; // đòn không có Dice thì Clash vô nghĩa

    // BUG ĐÃ SỬA (Fragaria: "Bug AI có thể clash dù tốc chậm hơn").
    // Clash là hành động CHẶN TRƯỚC đòn địch — chỉ người NHANH HƠN mới kịp ra tay.
    // Trước đây KHÔNG có một dòng so Speed nào ở cả 2 đường (AI lẫn player), nên
    // mob chậm hơn vẫn clash thoải mái.
    // Hoà Speed → KHÔNG clash được (phải NHANH HƠN, không phải "không chậm hơn").
    const clashSpeedOk = (target.currentSpeed ?? 0) > (attackerResolved.combatant.currentSpeed ?? 0);
    const clashPick = clashSpeedOk ? pickClashSkill(target) : null;
    if (clashPick) {
      const cost = parseSkillCost(clashPick.skill.cost);
      target.currentLight = Math.max(0, (target.currentLight ?? 0) - (cost.light ?? 0));
      const cdTurns = parseSkillCooldownTurns(clashPick.skill.cd);
      target.skillCooldowns = target.skillCooldowns ?? {};
      target.skillCooldowns[cdKeyFor(clashPick.skillKey)] = cdTurns + 1;
      const myPenalty = getParryClashPenalty(target);
      const oppPenalty = getParryClashPenalty(attackerResolved.combatant);
      const myEffectiveDice = clashPick.rolled.firstDiceValue - myPenalty + (target.clashAttackBoost ?? 0) + (target.clashPowerUp ?? 0);
      const oppEffectiveDice = attackerFirstDiceValue - oppPenalty + (attackerResolved.combatant.clashAttackBoost ?? 0) + (attackerResolved.combatant.clashPowerUp ?? 0);
      if (myEffectiveDice > oppEffectiveDice) {
        const hitCount = Math.max(1, p.targets.find(tg => tg.targetId === targetId)?.preview?.dmgValues?.length ?? 1);
        target.evadeCharges = (target.evadeCharges ?? 0) + hitCount;
        applySanityGain(target, 10);
        applyEmotionDelta(target, 2);
        applyClashLossSanity(attackerResolved.combatant);
        applyEmotionDelta(attackerResolved.combatant, -1);
        checkStaggerPanic(target); checkStaggerPanic(attackerResolved.combatant);
        let note = `⚔️🏆 **${target.name}** THẮNG Clash bằng **${clashPick.skill.name}** (${myEffectiveDice} vs ${oppEffectiveDice}) — huỷ toàn bộ đòn!`;
        if (hasPerk(target, "Voracity") && !target.voracityUsedThisTurn) {
          target.currentLight = Math.min(target.maxLight, target.currentLight + 2);
          target.voracityUsedThisTurn = true;
          note += ` ✨+2 Light (Voracity).`;
        }
        if (hasPerk(target, "Pressure Point")) {
          target.poise = Math.min(99, (target.poise ?? 0) + 5);
          note += ` 💪+5 Poise (Pressure Point).`;
        }
        if (hasPerk(target, "Thorns")) {
          const thornsRupture = target.hasSevenAssociation ? Math.round(7 * 1.5) : 7;
          attackerResolved.combatant.rupture = Math.min(99, (attackerResolved.combatant.rupture ?? 0) + thornsRupture);
          note += ` 🌵+${thornsRupture} Rupture (Thorns) lên attacker.`;
        }
        const finalized = await aiHooks.finalizeReactiveChoice(channelId, encounter, p, targetId, note, `🤖 **${target.name}**`);
        return { handled: true, resultText: finalized.resultText };
      }
      // Thua Clash — TIẾP TỤC thử Counter nếu có (không waste toàn bộ lượt phòng thủ chỉ vì thua Clash).
    }

    const counterPick = pickCounterSkill(target);
    if (counterPick) {
      const cost = parseSkillCost(counterPick.skill.cost);
      const effect = counterPick.skill.counterEffect ?? {};
      // Task yêu cầu trực tiếp: AI không thể chơi minigame real-time (rtparry)
      // như người thật — dùng xác suất cố định hợp lý thay thế (75% thành công,
      // tương đương phản xạ khá tốt của người chơi thật trung bình).
      const isSuccess = Math.random() < 0.75;
      if (isSuccess || effect.alwaysUnlocks) {
        target.currentLight = Math.max(0, (target.currentLight ?? 0) - (cost.light ?? 0));
        const cdTurns = parseSkillCooldownTurns(counterPick.skill.cd);
        target.skillCooldowns = target.skillCooldowns ?? {};
        target.skillCooldowns[counterPick.skillKey] = cdTurns + 1;
        if (effect.light) target.currentLight = Math.min(target.maxLight, (target.currentLight ?? 0) + effect.light);
        if (effect.protection) target.protection = (target.protection ?? 0) + effect.protection;
        if (effect.defenseUp) target.defenseUp = (target.defenseUp ?? 0) + effect.defenseUp;
        if (effect.unlocksSkillKey) target.unlockedFollowUpSkillKey = effect.unlocksSkillKey;
      }
      if (!isSuccess) return false; // thất bại — rơi về Guard/Evade/Parry bình thường
      let note = `🛡️✅ **${target.name}** Counter thành công bằng **${counterPick.skill.name}**!`;
      if (!effect.noDirectDamage) {
        const built = autoBuildDmgStrFromSkillRoll(counterPick.skill);
        if (built.dmgStr) {
          const counterResStr = combatantResStr(attackerResolved.combatant);
          const counterPreview = calcMathCore({ dmgStr: built.dmgStr, resStr: counterResStr, poiseInit: target.poise, chargeInit: target.charge });
          applyHpLoss(attackerResolved.combatant, counterPreview.totalDmg);
          note += ` Phản công gây -${counterPreview.totalDmg.toFixed(3)} HP.`;
        }
      }
      const hitCount2 = Math.max(1, p.targets.find(tg => tg.targetId === targetId)?.preview?.dmgValues?.length ?? 1);
      target.evadeCharges = (target.evadeCharges ?? 0) + hitCount2;
      const finalized = await aiHooks.finalizeReactiveChoice(channelId, encounter, p, targetId, note, `🤖 **${target.name}**`);
      return { handled: true, resultText: finalized.resultText };
    }
    return false;
  }

  function decideDefenseChoice(target, opts, maxHitDmgInGroup, hasGuardBreak = false) {
    const hpPct = target.maxHp > 0 ? target.currentHp / target.maxHp : 0;
    const bigHit = maxHitDmgInGroup > target.maxHp * 0.10;
    const lowHp = hpPct <= 0.20;
    const lethal = maxHitDmgInGroup >= target.currentHp;
    if (!bigHit && !lowHp && !lethal) return "none";

    // Task yêu cầu trực tiếp (xác nhận: "AI hiện tại giống bao cát... eye gouger
    // chả bao giờ guard, hay guard những đòn có guard break") — Guard Break vẫn
    // giảm được dmg (xem resolve-pending-action.js's applyDefenseChoiceToTarget)
    // NHƯNG gây Stagger ngay lập tức bất kể — Guard trong trường hợp này gần
    // như vô nghĩa (đỡ được dmg nhưng vẫn bị Stagger) — ưu tiên NÉ thay vì Guard
    // khi phát hiện tag Guard Break, nếu Evade khả thi.
    let choice;
    if (hasGuardBreak && opts.evade.available) {
      choice = "evade";
    } else {
      choice = opts.guard.available ? "guard" : (opts.evade.available ? "evade" : (opts.parry.available ? "parry" : "none"));
    }

    // Rule 4: Guard/Evade đã chọn sẽ tự Stagger (Stamina về ≤0) → đổi qua Parry.
    if (choice === "guard" && (target.currentStamina - opts.guard.cost) <= 0 && opts.parry.available) {
      choice = "parry";
    } else if (choice === "evade" && (target.currentStamina - opts.evade.cost) <= 0 && opts.parry.available) {
      choice = "parry";
    }
    // Task yêu cầu trực tiếp: "nếu không còn stamina để né hoặc đỡ nữa và khi
    // nhận đòn sẽ khiến HP về xuống hơn 0 thì AI sẽ bắt đầu parry" — trường hợp
    // CẢ Guard LẪN Evade đều KHÔNG khả thi (hết Stamina, không phải do tự
    // Stagger mà do không đủ trả phí) NHƯNG đòn này lại CHÍ MẠNG (lethal) — cố
    // Parry dù cost thường là 0 Sta (chỉ cần opts.parry.available), thay vì im
    // lặng chịu chết (choice="none" từ fallback chain phía trên nếu parry cũng
    // không available thì mới thật sự đành chịu).
    if (choice === "none" && lethal && opts.parry.available) {
      choice = "parry";
    }
    return choice;
  }

  /** applyDefenseChoiceToTarget — mutate target THEO ĐÚNG cơ chế cốt lõi, y hệt
   *  nhánh guard/evade/parry/none trong interaction-handlers.js's "encreactivedef"
   *  handler (đã bỏ các nhánh outfit/accessory không áp dụng cho mob — xem
   *  comment đầu file). Trả về choiceNote (string) để hiển thị. */
  function applyDefenseChoiceToTarget(choice, target, opts, realHitIndices) {
    if (choice === "guard") {
      target.currentStamina -= opts.guard.cost;
      target.guardCharges = (target.guardCharges ?? 0) + opts.guard.chargesNeededNet;
      target.guardHitSelections = target.guardHitSelections ?? [];
      target.guardHitSelections.push(...realHitIndices);
      return `🛡️ Guard (-${opts.guard.cost} Sta)`;
    }
    if (choice === "evade") {
      target.currentStamina -= opts.evade.cost;
      target.evadeCharges = (target.evadeCharges ?? 0) + opts.evade.chargesNeededNet;
      target.evadeHitSelections = target.evadeHitSelections ?? [];
      target.evadeHitSelections.push(...realHitIndices);
      return `💨 Evade (-${opts.evade.cost} Sta)`;
    }
    if (choice === "parry") {
      target.parryRolls = target.parryRolls ?? [];
      target.parryHitSelections = target.parryHitSelections ?? [];
      const penalty = getParryClashPenalty(target);
      for (let i = 0; i < opts.chargesNeeded; i++) {
        const rawRoll = 1 + Math.floor(Math.random() * 20);
        target.parryRolls.push(rawRoll - penalty);
      }
      target.parryHitSelections.push(...realHitIndices);
      return `🗡️ Parry (${opts.chargesNeeded} roll, 0 Sta)`;
    }
    return "❌ Không phòng thủ";
  }

  async function resolveAiDefenseForTarget(channelId, pendingId, targetId) {
    try {
      let postLockInfo = null;
      await withLock(encounterKey(channelId), async () => {
        const encounter = await getEncounter(channelId);
        if (!encounter) return;
        const p = (encounter.pendingActions ?? []).find(pa => pa.id === pendingId);
        if (!p) return; // đã bị xử lý trước đó
        if (p.reactedTargetIds?.includes(targetId)) return; // đã reacted rồi (race)
        const targetResolved = resolveCombatant(encounter, targetId);
        const attackerResolved = resolveCombatant(encounter, p.attackerId);
        if (!targetResolved || !attackerResolved) return;
        const target = targetResolved.combatant;
        const t = p.targets.find(tg => tg.targetId === targetId);
        if (!t) return;
        const isM1Type = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
        const attackerWeapon = attackerResolved.combatant.weaponWeight ?? "medium";
        const bypass = p.defenseBypass ?? {};
        const hitCount = Math.max(1, t.preview?.dmgValues?.length ?? 1);
        const hitsPerCharge = p.isEyeOfHorusFixedBurst ? 9 : (isM1Type ? (WEAPON_DEFENSE_HITS[attackerWeapon] ?? 1) : 1);
        const groupCount = Math.ceil(hitCount / hitsPerCharge);
        t.perHitBypass = t.perHitBypass ?? parsePerHitBypass(p.skillRollEmbed?.description, p.tags, groupCount);
        t.perHitChoices = t.perHitChoices ?? new Array(groupCount).fill(null);

        const decisionNotes = [];
        // Task yêu cầu trực tiếp: thử Clash/Counter TRƯỚC (quyết định 1 lần cho
        // TOÀN BỘ pendingAction, không phải per-group) — nếu thắng, huỷ hết đòn
        // và SKIP hẳn vòng lặp Guard/Evade/Parry per-group bên dưới.
        const clashOrCounterResult = await attemptAiClashOrCounter(channelId, encounter, p, target, targetId, attackerResolved);
        if (clashOrCounterResult && clashOrCounterResult.handled) {
          postLockInfo = { resultText: clashOrCounterResult.resultText, channelId, isEnemyTarget: true };
          return;
        }
        // Loop TOÀN BỘ nhóm còn lại (khác người thật — không cần round-trip
        // Discord, quyết định hết trong 1 lần khoá).
        let groupIdx;
        while ((groupIdx = t.perHitChoices.findIndex(c => c === null)) !== -1) {
          const thisGroupBypass = t.perHitBypass[groupIdx];
          const hitsInThisGroup = Math.min(hitsPerCharge, hitCount - groupIdx * hitsPerCharge);
          const opts = computeDefenseOptions(target, attackerWeapon, hitsInThisGroup, isM1Type, thisGroupBypass, p.isEyeOfHorusFixedBurst ?? false);
          const realHitIndices = [];
          for (let i = 0; i < hitsInThisGroup; i++) realHitIndices.push(groupIdx * hitsPerCharge + i + 1);
          const instancesInGroup = (t.preview?.instanceResults ?? []).slice(groupIdx * hitsPerCharge, groupIdx * hitsPerCharge + hitsInThisGroup);
          const maxHitDmgInGroup = instancesInGroup.length > 0 ? Math.max(...instancesInGroup.map(r => r.dmg ?? 0)) : 0;
          const choice = decideDefenseChoice(target, opts, maxHitDmgInGroup, !!thisGroupBypass?.guardBreak);
          const choiceNote = applyDefenseChoiceToTarget(choice, target, opts, realHitIndices);
          t.perHitChoices[groupIdx] = choiceNote;
          decisionNotes.push(`Nhóm ${groupIdx + 1}/${groupCount} (hit ${realHitIndices[0]}${realHitIndices.length > 1 ? `-${realHitIndices[realHitIndices.length - 1]}` : ""}): ${choiceNote}`);
        }

        const finalized = await aiHooks.finalizeReactiveChoice(channelId, encounter, p, targetId, decisionNotes.join(" | "), `🤖 **${target.name}**`);
        postLockInfo = { resultText: finalized.resultText, channelId, isEnemyTarget: true };
      });
      if (postLockInfo) {
        const ch = await client.channels.fetch(postLockInfo.channelId).catch(() => null);
        if (ch) {
          await ch.send({ embeds: [{ title: "🤖 AI tự động phòng thủ", description: postLockInfo.resultText, color: 0x9b59b6 }] }).catch(() => {});
        }
      }
    } catch (err) {
      log("error", "resolveAiDefenseForTarget", "system", err.message);
    }
  }

  // ── STAGE 4 — AI tấn công ──────────────────────────────────────────────────
  // Luật xác nhận trực tiếp: M1 liên tục tới khi staminaUsedThisTurn đạt 20
  // (đủ quy đổi 1 Light cuối turn, công thức có sẵn ở turn-advance.js) HOẶC hit
  // tiếp theo sẽ khiến tự Stagger (Stamina về ≤0) thì dừng. Skill: "có đủ Light
  // thì tự động xài, random hay ưu tiên tuỳ mình" — chọn skill TỐN LIGHT NHẤT
  // trong số đủ điều kiện (ưu tiên "mạnh nhất" khi đủ khả năng) — GIẢ ĐỊNH đã
  // báo Fragaria. Skill có `promptArg` (VD Thrust — cần nhập Light hiện tại)
  // KHÔNG được AI dùng (đúng hạn chế ghi rõ ở resolveSkillVerification).

  /** pickOffensiveSkill — chọn skill TỐN NHẤT trong số đủ Light + hết cooldown
   *  + không cần promptArg. Trả về {name, skill, key, lightCost} hoặc null. */
  /** pickPatternSkill — đòn KẾ TIẾP theo `attackPattern` của boss.
   *
   *  Fragaria: pattern Nothing There là "Turn 1: Jump Attack, Triple Swing,
   *  Swing / Turn 2: … / Turn 3: … / Turn 4: lặp lại từ đầu", và **"cả 3 đòn thì
   *  đều nên chia lẻ ra, và MỖI LẦN đều có aggro targeting KHÁC NHAU chứ không
   *  dồn hết cả 3 vào 1 người liên tục được"**.
   *
   *  → Trả về ĐÚNG MỘT đòn mỗi lần gọi, không gộp. `attemptOneMobAction` gọi lại
   *  cho từng đòn, và mỗi lần đều chạy `pickAiTargets` mới ⇒ 3 đòn = 3 lần rút
   *  mục tiêu ĐỘC LẬP. Xui thì vẫn có thể trúng cùng 1 người cả 3 lần — Fragaria
   *  xác nhận "nếu có người xui cả 3 lần random đó đều dính thì không sao".
   *
   *  `bossPatternIdx` đếm TỔNG số đòn đã tung, chia lấy dư theo độ dài turn để
   *  suy ra turn nào / đòn thứ mấy. Lưu trên combatant nên sống qua save/load.
   */
  function pickPatternSkill(mob) {
    const pattern = mob.attackPattern;
    if (!Array.isArray(pattern) || pattern.length === 0) return null;
    const perTurn = pattern[0].length || 1;
    const idx = mob.bossPatternIdx ?? 0;
    const turnRow = pattern[Math.floor(idx / perTurn) % pattern.length];
    const name = turnRow[idx % perTurn];
    const skill = findSkill(name);
    if (!skill) return null;
    // Boss KHÔNG tốn Light/CD cho pattern — đây là kịch bản cố định, không phải
    // lựa chọn tài nguyên. `lightCost: 0` để nhánh trừ Light phía dưới bỏ qua.
    return { name, skill, key: name.trim().toLowerCase(), lightCost: 0, fromPattern: true };
  }

  function pickOffensiveSkill(mob) {
    // Boss có kịch bản cố định thì KHÔNG tự chọn skill theo Light nữa.
    if (Array.isArray(mob.attackPattern) && mob.attackPattern.length > 0) return pickPatternSkill(mob);
    const candidates = [];
    for (const name of mob.unlockedPagesSnapshot ?? []) {
      const skill = findSkill(name);
      if (!skill || skill.promptArg) continue;
      const key = name.trim().toLowerCase();
      if ((mob.skillCooldowns?.[key] ?? 0) > 0) continue;
      const cost = parseSkillCost(skill.cost);
      if (cost.light == null || (mob.currentLight ?? 0) < cost.light) continue;
      candidates.push({ name, skill, key, lightCost: cost.light });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.lightCost - a.lightCost);
    return candidates[0];
  }

  /** pickM1DmgStr — Amon Syndicate ("có thể đổi Dmg M1 qua Pierce tùy thích")
   *  tự chọn loại dmg gây nhiều hơn dựa Res thật của target đang nhắm; mob
   *  khác chỉ có 1 công thức cố định. */
  function pickM1DmgStr(mob, targetCombatant) {
    if (!mob.m1DmgStrAlt) return mob.m1DmgStr ?? "5B";
    const typeOf = (s) => (/B$/i.test(s) ? "B" : /P$/i.test(s) ? "P" : "S");
    const res = targetCombatant.resistance ?? { B: 1, P: 1, S: 1 };
    const baseType = typeOf(mob.m1DmgStr ?? "5B");
    const altType = typeOf(mob.m1DmgStrAlt);
    return (res[altType] ?? 1) > (res[baseType] ?? 1) ? mob.m1DmgStrAlt : mob.m1DmgStr;
  }

  /** pickAiTargets — BUG ĐÃ SỬA (Fragaria báo trực tiếp: "AI chỉ đánh mỗi người
   *  host, tôi nghĩ nên cho AI đánh random hoặc một thuật toán aim 1 ai đó").
   *
   *  NGUYÊN NHÂN GỐC: bản cũ (pickLivingTargetsSortedByHpPct) sort THUẦN theo
   *  hpPct tăng dần, rồi caller LUÔN lấy phần tử đầu tiên khả dụng. Khi cả team
   *  còn full HP thì hpPct BẰNG NHAU hết → Array.sort ổn định (spec ES2019) giữ
   *  nguyên thứ tự Object.entries(players) = thứ tự JOIN = host luôn đứng đầu.
   *  Kết quả: mob đánh host mọi lượt, tới khi host tụt HP đủ thấp mới... vẫn
   *  đánh host (vì giờ hpPct thấp nhất thật). Không bao giờ đổi mục tiêu.
   *
   *  THUẬT TOÁN MỚI — 2 lớp:
   *  1. AGGRO LOCK (phần "aim 1 ai đó"): mob khoá mục tiêu trong AI_AGGRO_TURNS
   *     turn. Đánh dai một người thay vì nhảy lung tung mỗi hit — vừa giống hành
   *     vi boss thật, vừa cho party cơ hội xoay tank/heal có ý nghĩa.
   *  2. WEIGHTED RANDOM (phần "random") khi cần chọn mục tiêu MỚI: trọng số
   *     = 1 + (1 - hpPct) × 2. Người HP thấp bị nhắm nhiều hơn (giữ tinh thần
   *     "mob thông minh" của bản cũ) nhưng KHÔNG tuyệt đối — full HP vẫn có
   *     trọng số 1, người sắp chết có 3 → cao gấp 3, không phải 100%.
   *
   *  Trả về mảng ĐÃ SẮP theo độ ưu tiên (mục tiêu khoá đứng đầu) — caller vẫn
   *  giữ nguyên cách dùng cũ (lặp từ đầu, ai khả dụng thì đánh). */
  const AI_AGGRO_TURNS = 2;
  // Xác suất GIỮ mục tiêu đang khoá thay vì rút lại. Fragaria: "AI chỉ đang
  // target duy nhất một người, như vậy khá khó cho player... tôi cần một chút
  // RNG randomness hơn" — và giao tôi tự quyết con số.
  // Khoá cứng 2 turn = 1 người ăn TOÀN BỘ đòn trong 2 turn; với boss như Nothing
  // There (3 đòn/turn, có đòn 200 True AOE) là wipe chắc chắn. 0.6 giữ được cảm
  // giác "boss bám 1 người" nhưng vẫn có 40% đổi mục tiêu mỗi lần đánh.
  const AI_AGGRO_KEEP_CHANCE = 0.6;
  // Mỗi lần bị nhắm, người đó nặng thêm 1 điểm "vừa bị đánh" → trọng số CHIA cho
  // (1 + số điểm). Bị đánh 1 lần còn 1/2 cơ hội, 2 lần còn 1/3 — dồn sát thương
  // lên 1 người trở nên rất khó. Điểm này giảm 1 mỗi turn (turn-advance.js).
  const AI_RECENT_TARGET_DECAY_PER_TURN = 1;
  function pickAiTargets(encounter, mob) {
    const living = Object.entries(encounter.players)
      .filter(([, p]) => p.currentHp > 0)
      .map(([pid, p]) => ({ pid, p, hpPct: p.maxHp > 0 ? p.currentHp / p.maxHp : 0 }));
    if (living.length <= 1) return living;

    const turnNow = encounter.turnNumber ?? 1;
    // Mục tiêu đang khoá còn hiệu lực? (còn sống + chưa hết hạn aggro)
    // `aiSpreadTargets` (khai ở quest-data.js) — boss diện rộng KHÔNG khoá mục
    // tiêu bao giờ; mỗi đòn rút lại từ đầu.
    const lockedStillValid = !mob?.aiSpreadTargets
      && mob?.aiTargetId
      && living.some(t => t.pid === mob.aiTargetId)
      && (turnNow - (mob.aiTargetSetOnTurn ?? 0)) < AI_AGGRO_TURNS
      // Khoá KHÔNG còn tuyệt đối — 40% mỗi lần vẫn đổi mục tiêu.
      && Math.random() < AI_AGGRO_KEEP_CHANCE;

    // Weighted random shuffle — rút lần lượt không hoàn lại, nên TOÀN BỘ mảng
    // được xáo (không chỉ phần tử đầu). Quan trọng: nếu mục tiêu ưu tiên đang
    // bận (hasUnresolvedTargetPending ở caller), phần tử kế cũng phải ngẫu
    // nhiên chứ không quay về "host đầu danh sách" như bug cũ.
    const pool = [...living];
    const shuffled = [];
    while (pool.length > 0) {
      // TRỌNG SỐ ĐÃ ĐỔI (Fragaria yêu cầu thêm RNG, giao tôi quyết con số).
      //
      // CÔNG THỨC CŨ `1 + (1 - hpPct) * 2` là NGUỒN GỐC của "AI chỉ target 1
      // người": máu càng thấp trọng số càng cao (tối đa 3×), mà bị đánh thì máu
      // lại càng thấp ⇒ VÒNG XOÁY — ai trúng đòn đầu gần như chắc chắn ăn hết
      // phần còn lại rồi chết, trong khi người đầy máu hầu như không bị đụng.
      //
      // CÔNG THỨC MỚI:
      //   • Nền 1 cho mọi người — RNG công bằng là mặc định.
      //   • Ưu tiên máu thấp GIẢM từ ×3 xuống tối đa ×1.4 (vẫn còn "AI biết
      //     kết liễu", nhưng không đủ mạnh để tự khuếch đại).
      //   • CHIA cho (1 + số lần vừa bị nhắm) — người vừa ăn đòn tụt còn 1/2,
      //     ăn 2 đòn còn 1/3. Đây là phần THẬT SỰ rải sát thương ra.
      const weights = pool.map(t =>
        (1 + (1 - t.hpPct) * 0.4) / (1 + (t.p.aiRecentTargetCount ?? 0)));
      const total = weights.reduce((a, b) => a + b, 0);
      let roll = Math.random() * total;
      let idx = pool.length - 1;
      for (let i = 0; i < pool.length; i++) {
        roll -= weights[i];
        if (roll <= 0) { idx = i; break; }
      }
      shuffled.push(pool.splice(idx, 1)[0]);
    }

    if (lockedStillValid) {
      const locked = shuffled.find(t => t.pid === mob.aiTargetId);
      return [locked, ...shuffled.filter(t => t.pid !== mob.aiTargetId)];
    }
    return shuffled;
  }

  /** rememberAggroTarget — ghi mục tiêu vừa đánh vào state mob (aggro lock).
   *  CẢNH BÁO (bài học HANDOFF Sai Lầm #1 — "tính trên object A nhưng lưu qua
   *  object B tách biệt"): mọi nhánh trong attemptOneMobAction đều fetch LẠI
   *  encounter trong withLock riêng để lưu, nên KHÔNG được gán aiTargetId lên
   *  biến `mob` ngoài lock rồi tưởng nó tự được lưu — phải ghi vào ĐÚNG object
   *  vừa fetch trong lock. Hàm này tự lo trọn vẹn fetch → gán → save.
   *  Chỉ ghi khi mục tiêu THAY ĐỔI hoặc aggro đã hết hạn — tránh reset đồng hồ
   *  aggro mỗi hit (mob light weapon đánh 4 hit/turn sẽ khoá vĩnh viễn 1 người). */
  async function rememberAggroTarget(channelId, mobKey, targetPid) {
    await withLock(encounterKey(channelId), async () => {
      const enc = await getEncounter(channelId);
      // Cộng điểm "vừa bị nhắm" cho người bị đánh — trọng số lần rút kế tiếp sẽ
      // CHIA cho (1 + điểm này), nên sát thương tự rải sang người khác.
      // Ghi ở đây (trong lock, trên object vừa fetch) đúng cảnh báo Sai Lầm #1.
      const victim = enc?.players?.[targetPid];
      if (victim) victim.aiRecentTargetCount = Math.min(4, (victim.aiRecentTargetCount ?? 0) + 1);
      const m = enc?.enemies?.[mobKey];
      if (!m) return;
      const turnNow = enc.turnNumber ?? 1;
      const stillLocked = m.aiTargetId === targetPid
        && (turnNow - (m.aiTargetSetOnTurn ?? 0)) < AI_AGGRO_TURNS;
      if (stillLocked) return; // giữ nguyên đồng hồ aggro đang chạy
      m.aiTargetId = targetPid;
      m.aiTargetSetOnTurn = turnNow;
      await saveEncounter(channelId, enc);
    });
  }

  /** attemptOneMobAction — thử thực hiện ĐÚNG 1 hành động (1 skill HOẶC 1 M1)
   *  cho mob này. Trả về true nếu đã thực hiện (đã push 1 pendingAction THẬT —
   *  cần đợi target phản hồi xong mới nên thử tiếp, xem hook ở finalizeReactiveChoice),
   *  false nếu KHÔNG còn hành động nào hợp lệ (nên pass lượt). */
  async function attemptOneMobAction(channelId, mobKey) {
    const encounter = await getEncounter(channelId);
    if (!encounter) return false;
    const mob = encounter.enemies[mobKey];
    if (!mob || mob.currentHp <= 0) return false;
    // ── BOSS THEO KỊCH BẢN: DỪNG SAU ĐÚNG N ĐÒN/TURN ──────────────────────
    // BUG ĐÃ SỬA (Fragaria: "Nothing There không chịu end turn, tấn công mãi mãi").
    // NGUYÊN NHÂN GỐC: điều kiện dừng của AI hoàn toàn dựa trên NGÂN SÁCH
    // STAMINA (`staminaUsedThisTurn` vs `minStaminaReserve`). Nothing There khai
    // `noStaminaCost: true` — đòn của nó KHÔNG trừ Stamina ⇒ `staminaUsedThisTurn`
    // đứng yên ở 0 ⇒ **không bao giờ chạm ngưỡng dừng** ⇒ đánh vô hạn.
    // Boss có `attackPattern` thì số đòn/turn là CỐ ĐỊNH theo kịch bản (Fragaria:
    // "Turn 1: Jump Attack, Triple Swing, Swing" = 3 đòn), nên đếm ĐÒN thay vì
    // đếm Stamina. `bossAttacksThisTurn` reset mỗi turn ở turn-advance.js.
    if (Array.isArray(mob.attackPattern) && mob.attackPattern.length > 0) {
      const perTurn = mob.attackPattern[0].length || 1;
      if ((mob.bossAttacksThisTurn ?? 0) >= perTurn) return false;
    }
    const sortedTargets = pickAiTargets(encounter, mob);
    if (sortedTargets.length === 0) return false;
    const availableTargets = sortedTargets.filter(t => !hasUnresolvedTargetPending(encounter, t.pid));
    if (availableTargets.length === 0) return false; // mọi target đều đang chờ phản hồi đòn trước — đợi hook resolve gọi lại

    // 1) Skill trước (nếu đủ Light + không cooldown + không cần promptArg).
    const chosen = pickOffensiveSkill(mob);
    if (chosen) {
      const rolled = autoBuildDmgStrFromSkillRoll(chosen.skill);
      if (rolled.dmgStr) {
        // BUG ĐÃ SỬA (Fragaria: "HELP của Nothing There bị sai — nó chỉ làm 1
        // TRONG 10 đòn thành Unblockable/Undodgeable/Unparriable thôi chứ không
        // phải TOÀN BỘ group hit").
        //
        // NGUYÊN NHÂN GỐC: TRƯỚC ĐÂY gộp `rolled.lines.join()` rồi
        // `extractDefenseBypassTags` → tag của BẤT KỲ dòng nào cũng bật cờ, sau
        // đó nhét vào `tags:` = **TAG GÕ TAY**. Mà tag gõ tay theo thiết kế áp
        // cho MỌI HIT (`parsePerHitBypass` trả `manualBypass` cho toàn bộ hit).
        // ⇒ 1 dòng dice có [Unparriable] biến cả 10 hit thành Unparriable.
        // Đúng gotcha đã ghi: "Tag phòng thủ có 2 CẤP — dòng header = cả page,
        // dòng dice = riêng hit đó". AI đã phá cấp thứ 2.
        //
        // SỬA: truyền NGUYÊN VĂN mô tả roll qua `rollDescription`; doEnemyAttack
        // đưa thẳng vào `parsePerHitBypass` để nó tự tách header vs từng dòng dice.
        // KHÔNG còn dựng `tags:` từ dice nữa.
        const rollDescription = rolled.lines.join("\n");
        // Trừ Light + set cooldown THỦ CÔNG ở đây (KHÔNG dùng skill: của
        // doEnemyAttack — verify sẽ TỰ ROLL LẦN NỮA, cho dice KHÁC với
        // rolled ở trên — dùng autoBuildDmgStrFromSkillRoll 1 LẦN DUY NHẤT
        // rồi truyền thẳng dmgStr đã tính là cách AN TOÀN, không roll đôi).
        let stillValid = true;
        await withLock(encounterKey(channelId), async () => {
          const enc2 = await getEncounter(channelId);
          const mob2 = enc2?.enemies?.[mobKey];
          if (!mob2 || (mob2.currentLight ?? 0) < chosen.lightCost) { stillValid = false; return; }
          mob2.currentLight -= chosen.lightCost;
          const cd = parseSkillCooldownTurns(chosen.skill.cd);
          if (cd > 0) { mob2.skillCooldowns = mob2.skillCooldowns ?? {}; mob2.skillCooldowns[chosen.key] = cd; }
          // Boss theo kịch bản: TIẾN 1 ô trong pattern. Đặt Ở ĐÂY (trong lock,
          // trên object vừa fetch) đúng cảnh báo Sai Lầm #1 — gán lên biến `mob`
          // ngoài lock thì sẽ không được lưu.
          if (chosen.fromPattern) {
            mob2.bossPatternIdx = (mob2.bossPatternIdx ?? 0) + 1;
            // Đếm đòn ĐÃ tung trong turn này — điều kiện DỪNG duy nhất của boss
            // không tốn Stamina (xem gate ở đầu attemptOneMobAction).
            mob2.bossAttacksThisTurn = (mob2.bossAttacksThisTurn ?? 0) + 1;
          }
          await saveEncounter(channelId, enc2);
        });
        if (stillValid) {
          // Fragaria: "mỗi lần đều có aggro targeting KHÁC NHAU chứ không dồn hết
          // cả 3 vào 1 người liên tục được".
          // `availableTargets` được rút MỘT LẦN ở đầu attemptOneMobAction. Với
          // boss chạy pattern (mỗi lần gọi = 1 đòn) thì mỗi đòn đã tự đi qua một
          // vòng attemptOneMobAction mới ⇒ rút lại mục tiêu độc lập. Nhưng đòn
          // AOE (Goodbye) vẫn phải trúng TẤT CẢ, nên chỉ thu về 1 mục tiêu khi
          // đòn KHÔNG phải AOE.
          const isAoeSkill = /\[AOE\]/i.test(rolled.lines.join(" "));
          const targetsForThisHit = (chosen.fromPattern && !isAoeSkill)
            ? availableTargets.slice(0, 1)
            : availableTargets;
          for (const t of targetsForThisHit) {
            try {
              await doEnemyAttack(channelId, encounter.gmId, mobKey, rolled.dmgStr, `<@${t.pid}>`, { rollDescription, coin: String(rolled.totalEmotionDelta ?? 0), isAiCall: true });
              // Narrative — doEnemyAttack ở trên chỉ nhận dmgStr THUẦN SỐ (đã tự
              // build qua autoBuildDmgStrFromSkillRoll, KHÔNG dùng skill:/
              // customskill: để tránh roll đôi — xem comment phía trên) nên
              // KHÔNG tự hiện tên skill trong actionLog/summary — ghi thêm 1
              // dòng riêng để GM/player vẫn biết đây là skill nào, không chỉ
              // thấy 1 công thức dmg vô danh.
              await withLock(encounterKey(channelId), async () => {
                const enc4 = await getEncounter(channelId);
                if (!enc4) return;
                appendActionLog(enc4, `📖 **${mob.name}** dùng skill **${chosen.skill.name}**.`);
                await saveEncounter(channelId, enc4);
              });
              await rememberAggroTarget(channelId, mobKey, t.pid); // aggro lock — xem pickAiTargets
              return true;
            } catch { /* target vừa dính unresolved pending khác (race) — thử target kế */ }
          }
        }
      }
      // rolled.dmgStr null (skill không có phần dmg auto-parse được, VD thuần
      // buff) — rơi xuống thử M1 thay vì bỏ cuộc hẳn turn này.
    }

    // 2) M1 — theo yêu cầu trực tiếp (Fragaria báo trực tiếp: "AI chỉ đánh 1
    // hit khiến reactive defense phải lặp quá nhiều lần — vũ khí light nên
    // đánh gộp 4 hit, medium 2, heavy 1 mỗi lần khai báo"). TRƯỚC ĐÂY mỗi lần
    // chỉ khai báo 1 hit đơn (dmgStr "4P") → weapon light cần 4 lần
    // attemptOneMobAction (4 lần doEnemyAttack, 4 lần reactive defense riêng)
    // mới đủ 20 Stamina/1 Light. GIỜ dồn NGAY SỐ HIT = WEAPON_DEFENSE_HITS[vũ
    // khí] (4/2/1 cho light/medium/heavy — ĐÚNG BẰNG số hit cần để đủ 20
    // Stamina, không phải trùng hợp) vào 1 dmgStr multi-hit DUY NHẤT (cú pháp
    // "<base>x<soHit><LOẠI>", VD "4x4P" = 4 hit x 4 dmg Pierce) — reactive
    // defense sẽ tự gộp thành ĐÚNG 1 hit-group (hitsPerCharge = WEAPON_DEFENSE_
    // HITS CHÍNH nó) cho target, chỉ cần 1 lần phòng thủ thay vì N lần. Đồng
    // thời giảm hẳn số lần doEnemyAttack/announceCurrentTurn mỗi turn → cũng
    // giảm tần suất status board cập nhật (vấn đề "hiện liên tục" Fragaria báo).
    const weaponWeight = mob.weaponWeight ?? "medium";
    const staCostPerHit = WEAPON_STAMINA_COST[weaponWeight] ?? 10;
    // Task yêu cầu trực tiếp (xác nhận: "tần suất m1 của các AI boss cũng không
    // nhiều khiến player khá tiện về mặt phòng thủ") — TRƯỚC ĐÂY dừng CỨNG ngay
    // khi đủ 20 Stamina (1 Light) — quá thụ động, và LÃNG PHÍ cơ chế Light vốn
    // ĐÃ tự scale theo Stamina dùng (turn-advance.js: lightGained =
    // Math.floor(staminaUsedThisTurn/20) — dùng 60 Stamina = 3 Light, không chỉ
    // 1!). Giờ KHÔNG dừng cứng ở 20 nữa — tiếp tục burst thêm nếu vẫn AN TOÀN.
    //
    // BUG THẬT phát hiện qua phản biện trực tiếp: "mob Stamina chỉ ~60 như Rats
    // mà xài gần hết (chỉ cần >0) chẳng phải lố bịch sao" — ĐÚNG, bản sửa lần
    // trước CHỈ chặn tự Stagger NGAY (>0) mà KHÔNG dự trữ gì cho phòng thủ các
    // turn SAU — mob "cháy" hết Stamina 1 turn rồi bất lực Guard/Evade nhiều
    // turn liền cho tới khi hồi lại (ngược hẳn mục đích "thử thách hơn" của Task
    // 8). Giờ dự trữ tối thiểu 25% MAX Stamina (KHÔNG phải current) cho phòng
    // thủ — offense chỉ được tiêu tới ngưỡng này, không tiêu tới sát 0 nữa. 25%
    // là ước lượng hợp lý (đủ Guard/Evade ít nhất 1 đòn đáng kể sau đó) — có thể
    // điều chỉnh nếu cảm thấy chưa đúng ý.
    // Task yêu cầu trực tiếp: "nên random số lượng m1 lại, không phải lúc nào
    // cũng chỉ duy nhất 1 số lượng" — TRƯỚC ĐÂY dự trữ CỐ ĐỊNH 25% khiến mob
    // LUÔN dừng ở CÙNG 1 điểm mỗi turn (dễ đoán) — giờ RANDOM tỉ lệ dự trữ mỗi
    // turn (15%-40% max Stamina, roll 1 LẦN DUY NHẤT khi turn CỦA MOB NÀY bắt
    // đầu — staminaUsedThisTurn===0 — giữ NGUYÊN xuyên suốt turn đó, KHÔNG roll
    // lại giữa các burst cùng turn để tránh hành vi kỳ quặc "vừa nới lỏng vừa
    // xiết lại" giữa chừng).
    if ((mob.staminaUsedThisTurn ?? 0) === 0) {
      mob.thisTurnStaminaReservePct = 0.15 + Math.random() * 0.25;
    }
    const reservePct = mob.thisTurnStaminaReservePct ?? 0.25;
    const minStaminaReserve = Math.ceil((mob.maxStamina ?? 100) * reservePct);
    // BUG THẬT phát hiện qua báo cáo trực tiếp kèm giải thích chi tiết: "cứ
    // guard xong là đánh thêm 1 hit như thế gây waste guard của player... nên
    // cho AI group hết toàn bộ số m1 vào 1 instance để player reactive defense
    // dễ hơn" — TRƯỚC ĐÂY mỗi lần gọi hàm này CHỈ burst tối đa hitsPerBurst
    // (WEAPON_DEFENSE_HITS — VD 4 cho light) rồi DỪNG, để chu kỳ maybeRunAiTurn
    // tự lặp lại gọi THÊM 1 lần nữa cho phần Stamina còn lại — mỗi lần gọi lại
    // là 1 pendingAction MỚI, buộc player phải Guard/Evade/Parry RIÊNG cho
    // TỪNG lần, làm hao phí Guard charge của họ qua nhiều instance nhỏ thay vì
    // 1 instance lớn duy nhất. Giờ tính TOÀN BỘ số hit AN TOÀN cho CẢ TURN
    // (không giới hạn ở hitsPerBurst nữa — hitsPerCharge vẫn do reactive-
    // defense.js tự chia nhóm phòng thủ dựa trên tổng số hit này, KHÔNG cần
    // giới hạn số hit MỖI LẦN GỌI HÀM) rồi khai báo NGAY 1 LẦN DUY NHẤT.
    const maxPossibleHits = Math.ceil((mob.currentStamina ?? 0) / staCostPerHit) + 1;
    let safeHits = 0;
    for (let i = 1; i <= maxPossibleHits; i++) {
      if (mob.currentStamina - i * staCostPerHit < minStaminaReserve) break;
      safeHits = i;
    }
    if (safeHits === 0) return false; // không đủ Stamina dù chỉ 1 hit an toàn
    for (const t of availableTargets) {
      const singleHitDmgStr = pickM1DmgStr(mob, t.p);
      const dmgMatch = singleHitDmgStr.match(/^([\d.]+)([BPS])$/i);
      const dmgStr = dmgMatch ? `${dmgMatch[1]}x${safeHits}${dmgMatch[2]}` : singleHitDmgStr;
      const totalStaCost = staCostPerHit * safeHits;
      try {
        await doEnemyAttack(channelId, encounter.gmId, mobKey, dmgStr, `<@${t.pid}>`, { ism1: "yes", isAiCall: true });
        // GAP THẬT phát hiện qua test — doEnemyAttack's nhánh ism1 TRỪ
        // currentStamina nhưng KHÔNG cập nhật staminaUsedThisTurn (field này
        // trước giờ chỉ có player M1 dùng qua doPlayerAttack — enemy chưa từng
        // cần tới vì chưa có AI tự lặp M1 nhiều lần/turn). Tự cộng dồn ở ĐÂY
        // (KHÔNG sửa doEnemyAttack — hàm đó quá phức tạp/nhiều nơi gọi, rủi ro
        // cao hơn nhiều so với chỉ track thêm 1 field tại đây) — nhờ vậy vừa
        // đúng cho điều kiện dừng CỦA CHÍNH AI, vừa khiến advanceCombatantTurn
        // (turn-advance.js) tự cộng Light cuối turn ĐÚNG cho mob luôn (trước
        // giờ enemy M1 chưa từng lên Light qua cơ chế này vì thiếu bước track).
        await withLock(encounterKey(channelId), async () => {
          const enc3 = await getEncounter(channelId);
          const mob3 = enc3?.enemies?.[mobKey];
          if (!mob3) return;
          mob3.staminaUsedThisTurn = (mob3.staminaUsedThisTurn ?? 0) + totalStaCost;
          // BUG THẬT phát hiện qua test thật (random luôn ra CÙNG 1 kết quả dù
          // chạy nhiều lần riêng biệt) — mob3 là fetch MỚI, TÁCH BIỆT hoàn toàn
          // khỏi "mob" (biến ngoài, dòng ~230) — thisTurnStaminaReservePct vừa
          // random ở trên KHÔNG tự động có mặt trong mob3, bị mất trước khi lưu
          // nếu không copy tay. Copy sang đây để lưu ĐÚNG giá trị đã roll.
          mob3.thisTurnStaminaReservePct = mob.thisTurnStaminaReservePct;
          await saveEncounter(channelId, enc3);
        });
        await rememberAggroTarget(channelId, mobKey, t.pid); // aggro lock — xem pickAiTargets
        return true;
      } catch { /* thử target kế */ }
    }
    return false;
  }

  /** passMobTurn — mirror "-encounter pass" (message-create-handler.js) cho
   *  AI-controlled enemy — advanceToNextTurnHolder + log + save + announce. */
  async function passMobTurn(channelId, mobKey) {
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) return;
      if (!isCurrentTurnHolder(encounter, mobKey)) return; // đã đổi lượt (race) — bỏ qua
      const mob = encounter.enemies[mobKey];
      const label = mob ? `**${mob.name}**` : mobKey;
      const { wrapped } = advanceToNextTurnHolder(encounter);
      appendActionLog(encounter, `⏭️ ${label} (🤖 AI) bỏ qua lượt.`);
      await saveEncounter(channelId, encounter);
      // BUG THẬT phát hiện qua test tích hợp dài (nhiều vòng turnOrder) —
      // xác nhận trực tiếp: "-contract bị kẹt, không tự end turnorder" — TRƯỚC
      // ĐÂY chỉ gọi announceCurrentTurn khi "!wrapped" — nhưng CHÍNH LÚC
      // wrapped=true (hết 1 vòng turnOrder, entry tiếp theo undefined) MỚI LÀ
      // lúc auto-end-turn-order logic (nằm BÊN TRONG announceCurrentTurn, check
      // "if (!entry)") cần chạy nhất! Bỏ điều kiện !wrapped — LUÔN gọi
      // announceCurrentTurn để logic auto-end tự kiểm tra và xử lý đúng, dù
      // wrapped hay không.
      aiHooks.announceCurrentTurn(channelId, encounter).catch(() => {});
    });
    // BUG THẬT phát hiện qua test tích hợp (3 mob) — sau khi mob NÀY pass, nếu
    // combatant KẾ TIẾP trong turnOrder CŨNG là 1 AI-enemy KHÁC, không có gì tự
    // trigger nó hành động (chỉ có rollspeed/pass/endturn — lệnh CỦA NGƯỜI THẬT —
    // và hook trong finalizeReactiveChoice chỉ tiếp tục ĐÚNG combatant vừa attack
    // xong, không phải "combatant MỚI sau khi pass"). Gọi lại maybeRunAiTurn ở
    // ĐÂY (ngoài withLock trên — tránh reentrant lock; gọi TRỰC TIẾP closure
    // cùng file, không cần qua aiHooks vì không có circular dependency ở đây)
    // để dây chuyền AI KHÔNG bị đứt giữa nhiều enemy liên tiếp.
    maybeRunAiTurn(channelId).catch(() => {});
  }

  /** maybeRunAiTurn — entry point CHÍNH: gọi mỗi khi lượt CÓ THỂ vừa đổi (sau
   *  rollspeed/pass/endturn) HOẶC sau khi 1 đòn tấn công CỦA CHÍNH mob này vừa
   *  được resolve (xem hook ở finalizeReactiveChoice, index.js's aiHooks) —
   *  KHÔNG tự lặp nhiều hành động trong 1 lần gọi (mỗi pendingAction cần đợi
   *  target phản hồi xong — hasUnresolvedTargetPending — mới thử tiếp được),
   *  chỉ thử ĐÚNG 1 hành động rồi return; lần gọi TIẾP THEO (khi hành động đó
   *  resolve xong) sẽ tự tiếp tục hoặc pass nếu hết hành động hợp lệ. */
  async function maybeRunAiTurn(channelId) {
    try {
      const encounter = await getEncounter(channelId);
      if (!encounter || !encounter.turnOrder?.length) return;
      const cur = encounter.turnOrder[encounter.currentTurnIndex ?? 0];
      if (!cur || cur.type !== "enemy") return;
      const mob = encounter.enemies[cur.id];
      if (!mob || !mob.aiControlled) return;
      if (mob.staggered) { await passMobTurn(channelId, cur.id); return; }
      const acted = await attemptOneMobAction(channelId, cur.id);
      if (!acted) await passMobTurn(channelId, cur.id);
    } catch (err) {
      log("error", "maybeRunAiTurn", "system", err.message);
    }
  }

  // pickAiTargets export ra để TEST gọi được HÀM THẬT (không phải bản tái dựng
  // trong file test — bản tái dựng có thể lệch khỏi code thật mà không ai biết).
  // index.js KHÔNG cần destructure field này.
  return { decideDefenseChoice, applyDefenseChoiceToTarget, resolveAiDefenseForTarget, maybeRunAiTurn, pickAiTargets };
};
