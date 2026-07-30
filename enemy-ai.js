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

module.exports = function ({
  withLock, encounterKey, getEncounter, saveEncounter, resolveCombatant,
  computeDefenseOptions, getParryClashPenalty, aiHooks,
  parsePerHitBypass, WEAPON_DEFENSE_HITS, WEAPON_STAMINA_COST, client, log,
  doEnemyAttack, findSkill, parseSkillCost, parseSkillCooldownTurns,
  autoBuildDmgStrFromSkillRoll, extractDefenseBypassTags,
  hasUnresolvedTargetPending, isCurrentTurnHolder, advanceToNextTurnHolder,
  appendActionLog,
}) {
  /** decideDefenseChoice — thuần logic quyết định (không side-effect), nhận vào
   *  target combatant + options đã tính (opts) + dmg lớn nhất trong nhóm hit
   *  này (maxHitDmgInGroup) — trả về 1 trong "guard"/"evade"/"parry"/"none". */
  function decideDefenseChoice(target, opts, maxHitDmgInGroup) {
    const hpPct = target.maxHp > 0 ? target.currentHp / target.maxHp : 0;
    const bigHit = maxHitDmgInGroup > target.maxHp * 0.10;
    const lowHp = hpPct <= 0.20;
    if (!bigHit && !lowHp) return "none";

    let choice = opts.guard.available ? "guard" : (opts.evade.available ? "evade" : (opts.parry.available ? "parry" : "none"));

    // Rule 4: Guard/Evade đã chọn sẽ tự Stagger (Stamina về ≤0) → đổi qua Parry.
    if (choice === "guard" && (target.currentStamina - opts.guard.cost) <= 0 && opts.parry.available) {
      choice = "parry";
    } else if (choice === "evade" && (target.currentStamina - opts.evade.cost) <= 0 && opts.parry.available) {
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
      target.guardCharges = (target.guardCharges ?? 0) + opts.chargesNeeded;
      target.guardHitSelections = target.guardHitSelections ?? [];
      target.guardHitSelections.push(...realHitIndices);
      return `🛡️ Guard (-${opts.guard.cost} Sta)`;
    }
    if (choice === "evade") {
      target.currentStamina -= opts.evade.cost;
      target.evadeCharges = (target.evadeCharges ?? 0) + opts.chargesNeeded;
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
          const choice = decideDefenseChoice(target, opts, maxHitDmgInGroup);
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
  function pickOffensiveSkill(mob) {
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

  /** pickLivingTargetsSortedByHpPct — mob "thông minh" nhắm người HP% thấp
   *  nhất trước (GIẢ ĐỊNH đã báo Fragaria — luật gốc không chỉ định targeting). */
  function pickLivingTargetsSortedByHpPct(encounter) {
    return Object.entries(encounter.players)
      .filter(([, p]) => p.currentHp > 0)
      .map(([pid, p]) => ({ pid, p, hpPct: p.maxHp > 0 ? p.currentHp / p.maxHp : 0 }))
      .sort((a, b) => a.hpPct - b.hpPct);
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
    const sortedTargets = pickLivingTargetsSortedByHpPct(encounter);
    if (sortedTargets.length === 0) return false;
    const availableTargets = sortedTargets.filter(t => !hasUnresolvedTargetPending(encounter, t.pid));
    if (availableTargets.length === 0) return false; // mọi target đều đang chờ phản hồi đòn trước — đợi hook resolve gọi lại

    // 1) Skill trước (nếu đủ Light + không cooldown + không cần promptArg).
    const chosen = pickOffensiveSkill(mob);
    if (chosen) {
      const rolled = autoBuildDmgStrFromSkillRoll(chosen.skill);
      if (rolled.dmgStr) {
        const bypass = extractDefenseBypassTags(rolled.lines.join("\n"));
        const tagsStr = [bypass.blockGuard && "unblockable", bypass.blockEvade && "undodgeable", bypass.blockParry && "unparriable", bypass.guardBreak && "guardbreak", bypass.unclashable && "unclashable"].filter(Boolean).join(",");
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
          await saveEncounter(channelId, enc2);
        });
        if (stillValid) {
          for (const t of availableTargets) {
            try {
              await doEnemyAttack(channelId, encounter.gmId, mobKey, rolled.dmgStr, `<@${t.pid}>`, { tags: tagsStr, coin: String(rolled.totalEmotionDelta ?? 0) });
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
              return true;
            } catch { /* target vừa dính unresolved pending khác (race) — thử target kế */ }
          }
        }
      }
      // rolled.dmgStr null (skill không có phần dmg auto-parse được, VD thuần
      // buff) — rơi xuống thử M1 thay vì bỏ cuộc hẳn turn này.
    }

    // 2) M1 — dừng nếu ĐÃ đủ 20 Stamina dùng turn này (banked ≥1 Light cuối
    // turn) HOẶC hit tiếp theo sẽ khiến tự Stagger.
    const weaponWeight = mob.weaponWeight ?? "medium";
    const staCostPerHit = WEAPON_STAMINA_COST[weaponWeight] ?? 10;
    if ((mob.staminaUsedThisTurn ?? 0) >= 20) return false;
    if (mob.currentStamina - staCostPerHit <= 0) return false;
    for (const t of availableTargets) {
      const dmgStr = pickM1DmgStr(mob, t.p);
      try {
        await doEnemyAttack(channelId, encounter.gmId, mobKey, dmgStr, `<@${t.pid}>`, { ism1: "yes" });
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
          mob3.staminaUsedThisTurn = (mob3.staminaUsedThisTurn ?? 0) + staCostPerHit;
          await saveEncounter(channelId, enc3);
        });
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
      if (!wrapped) aiHooks.announceCurrentTurn(channelId, encounter).catch(() => {});
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

  return { decideDefenseChoice, applyDefenseChoiceToTarget, resolveAiDefenseForTarget, maybeRunAiTurn };
};
