// express-routes.js
// 3 route Express cho trang web "Parry Real Time" (health check, serve trang
// đo phản xạ, nhận kết quả đo từ trình duyệt — bao gồm cả nhánh page-counter
// riêng) — TÁCH khỏi index.js theo yêu cầu trực tiếp: "tách nhỏ file index.js
// ra các file js khác" (code đã lên tới 11k+ dòng).
//
// LƯU Ý QUAN TRỌNG: "botReady" trong index.js là biến `let` được mutate SAU
// (client.once("ready")) — truyền GIÁ TRỊ trực tiếp qua factory sẽ "đóng
// băng" false vĩnh viễn (factory chạy TRƯỚC ready event). Dùng getBotReady
// (closure function luôn đọc giá trị MỚI NHẤT) thay vì botReady trực tiếp.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào, TRỪ việc đổi
// "botReady" → "getBotReady()" ở route "/" — đây là thay đổi CẦN THIẾT để
// giữ đúng hành vi gốc qua ranh giới module, không phải sửa logic).

module.exports = function ({ applyHpLoss, cdKeyFor, RTPARRY_MIN_HUMAN_MS, WEAPON_DEFENSE_HITS, app, autoBuildDmgStrFromSkillRoll, getBotReady, calcMathCore, client, combatantResStr, encounterKey, finalizeReactiveChoice, findSkill, getEncounter, log, parseSkillCooldownTurns, parseSkillCost, renderParryWebPage, resolveCombatant, saveEncounter, sendReactiveDefensePrompt, webParrySessions, withLock, deleteEncounter }) {

app.get("/", (req, res) => getBotReady() ? res.send("Bot is alive and kicking!") : res.status(503).send("Bot is starting up..."));

// GET /rtparry/:token — serve trang test phản xạ (chỉ nếu token còn hợp lệ).
app.get("/rtparry/:token", async (req, res) => {
  // async — webParrySessions giờ đọc từ Redis (xem rtparry.js)
  const session = await webParrySessions.get(req.params.token);
  if (!session || session.expiresAt < Date.now()) {
    return res.status(404).send(
      "<!DOCTYPE html><html><body style='font-family:sans-serif;text-align:center;padding:40px;background:#2c2f33;color:#fff'>" +
      "<h2>⚠️ Link đã hết hạn hoặc không hợp lệ</h2><p>Quay lại Discord và dùng <code>-rtparry</code> để lấy link mới.</p>" +
      "</body></html>"
    );
  }
  res.send(renderParryWebPage(req.params.token, session.windowMs, session.yellowMs, session.skillName));
});

// POST /rtparry/:token/result — nhận kết quả đo được TỪ TRÌNH DUYỆT user (đã tính
// xong reactionMs bằng performance.now() phía client), rồi edit lại message Discord
// gốc với kết quả thật, không lẫn latency.
app.post("/rtparry/:token/result", async (req, res) => {
  const session = await webParrySessions.get(req.params.token);
  if (!session || session.expiresAt < Date.now()) {
    return res.status(404).json({ ok: false, error: "Link đã hết hạn hoặc đã được dùng." });
  }
  await webParrySessions.delete(req.params.token); // single-use — dùng 1 lần là xoá ngay

  const { reactionMs, resultType } = req.body ?? {};
  // Validate input — đây là endpoint public, ai có token cũ (đã hết hạn nhưng đoán
  // được) hoặc tự curl cũng gọi được, nên không tin tưởng giá trị gửi lên vô điều
  // kiện. Tách riêng 2 loại: (a) dữ liệu hỏng hẳn (không phải number, NaN, âm, hoặc
  // >10s — gần như chỉ xảy ra khi tự gọi API thô, không phải từ trang web thật) thì
  // từ chối thẳng, message Discord giữ nguyên "đang chờ"; (b) số HỢP LỆ về kiểu dữ
  // liệu nhưng QUÁ NHANH để là phản xạ con người thật — đây mới là case đáng quan
  // tâm hơn, nên BÁO RÕ trong Discord (xem RTPARRY_MIN_HUMAN_MS) thay vì để message
  // treo mãi "đang chờ kết quả" không bao giờ cập nhật.
  const isNumberSane = typeof reactionMs === "number" && Number.isFinite(reactionMs) && reactionMs >= 0 && reactionMs < 10_000;
  if (resultType === "success" && !isNumberSane) {
    return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ." });
  }

  // QUAN TRỌNG: client tự báo "success" không có nghĩa nó THẬT — JS phía client có
  // thể bị sửa qua devtools/curl trực tiếp để bypass timeout WINDOW_MS và luôn báo
  // "success" với bất kỳ reactionMs nào. Server PHẢI tự validate lại: nếu reactionMs
  // vượt windowMs của session, ép về "missed" dù client gửi gì lên — đây chính là
  // bug đã gặp (1077ms vẫn báo "thành công") vì trước đây hoàn toàn tin client.
  let finalType = resultType;
  if (resultType === "success" && reactionMs > session.windowMs) {
    finalType = "missed";
  } else if (resultType === "success" && reactionMs < RTPARRY_MIN_HUMAN_MS) {
    // SÀN SINH LÝ HỌC: con người KHÔNG THỂ phản xạ thị giác dưới ~80ms dù luyện tập
    // nhiều (giới hạn dẫn truyền thần kinh-cơ, không phải kỹ năng). Random delay
    // 1.2-4s trước khi xanh chỉ chống được macro ĐOÁN timing cố định — không chống
    // được script tự động kiểu MutationObserver theo dõi class đổi thành "go" rồi
    // tự bắn click NGAY khi thấy (không đoán gì cả, phản ứng thật với sự kiện DOM)
    // — loại này luôn ra reactionMs ~1-10ms bất kể random delay bao nhiêu. Không
    // phải "chặn tuyệt đối mọi cheat" (vẫn có thể script giả lập delay 90-100ms để
    // né), nhưng chặn được trường hợp lộ liễu nhất, chi phí gần như 0.
    finalType = "rejected";
  }

  // GAP ĐÃ SỬA (dự án tự động hoá page-counter qua rtparry) — nếu session này
  // gắn với 1 pendingAction đang chờ counter (không phải rtparry thường), xử
  // lý HOÀN TOÀN RIÊNG: áp dụng thật vào encounter (tiêu hit theo weapon
  // weight, gây dmg phản công, áp counterEffect, set cooldown/Light), rồi
  // return NGAY — không chạy tiếp phần hiển thị "Parry Real Time — Web"
  // thông thường bên dưới (không liên quan gameplay).
  if (session.counterContext) {
    const { encChannelId, pendingId, targetId, counterSkillKey } = session.counterContext;
    const isSuccess = finalType === "success";
    try {
      let displayText = "";
      let questEndedHere = false, questEndText = "";
      let needNextGroupPrompt = false;
      await withLock(encounterKey(encChannelId), async () => {
        const encounter = await getEncounter(encChannelId);
        if (!encounter) { displayText = "⚠️ Encounter không còn tồn tại."; return; }
        const p = (encounter.pendingActions ?? []).find(pa => pa.id === pendingId);
        if (!p) { displayText = "⚠️ Action này đã được xử lý rồi."; return; }
        if (p.reactedTargetIds?.includes(targetId)) { displayText = "⚠️ Bạn đã chọn phòng thủ cho đòn này rồi."; return; }
        const targetResolved = resolveCombatant(encounter, targetId);
        const attackerResolved = resolveCombatant(encounter, p.attackerId);
        if (!targetResolved || !attackerResolved) { displayText = "⚠️ Không tìm thấy target/attacker."; return; }
        const target = targetResolved.combatant;
        const counterSkill = findSkill(counterSkillKey);
        const effect = counterSkill?.counterEffect ?? {};
        let choiceNote = "";
        let effectResultNote = "";

        // BUG ĐÃ SỬA (Fragaria: "You're Too Slow khi thua rtparry... cũng không bị
        // CD luôn").
        // NGUYÊN NHÂN GỐC: Light + cooldown TRƯỚC ĐÂY nằm TRONG `if (isSuccess ||
        // alwaysUnlocks)` — thua minigame là KHÔNG mất gì cả: không tốn Light,
        // không vào CD → bấm lại vô hạn cho tới khi may mắn ăn được. Counter page
        // trở thành phòng thủ miễn phí không rủi ro.
        // Luật đúng: ĐÃ PHÓNG PAGE RA là mất tài nguyên, thắng thua chỉ quyết
        // định có ngắt được đòn hay không (cùng nguyên tắc với Clash — thua clash
        // vẫn tiêu Light/CD, xem interaction-handlers.js).
        // → Tách phần CHI PHÍ ra khỏi phần HIỆU ỨNG.
        {
          const cost = parseSkillCost(counterSkill.cost);
          target.currentLight = Math.max(0, (target.currentLight ?? 0) - (cost.light ?? 0));
          const cdTurns = parseSkillCooldownTurns(counterSkill.cd);
          target.skillCooldowns = target.skillCooldowns ?? {};
          target.skillCooldowns[cdKeyFor(counterSkillKey)] = cdTurns + 1;
        }
        // Hiệu ứng phụ (Light hồi, Protection, mở khoá follow-up, nạp đạn...) —
        // vẫn CHỈ khi thành công, TRỪ "alwaysUnlocks" (Yield My Flesh: mở khoá
        // To Claim Their Bones dù thắng hay thua minigame).
        if (isSuccess || effect.alwaysUnlocks) {
          if (effect.light) target.currentLight = Math.min(target.maxLight, (target.currentLight ?? 0) + effect.light);
          if (effect.protection) target.protection = (target.protection ?? 0) + effect.protection;
          if (effect.defenseUp) target.defenseUp = (target.defenseUp ?? 0) + effect.defenseUp;
          if (effect.unlocksSkillKey) target.unlockedFollowUpSkillKey = effect.unlocksSkillKey;
          // "Tanglecleaver Reload" — loadsTigermarkRound: xác nhận trực tiếp
          // "nạp Tigermark Round... tương ứng với số dice gieo ra" — gọi
          // roll() THẬT để lấy đúng số dice (KHÔNG phải từ rtparry — rtparry
          // chỉ là minigame phản ứng thời gian, không có dice riêng). Chuyển
          // hoá qua Savage nếu Shin đang active (passive Tiantui Star's Blade).
          if (effect.loadsTigermarkRound) {
            const rollLines = counterSkill.roll();
            const diceMatch = rollLines[rollLines.length - 1].match(/\*\*(\d+)\*\*/);
            const rolledDiceValue = diceMatch ? parseInt(diceMatch[1], 10) : 0;
            if (target.shinMangActive) {
              target.savageTigermarkRound = Math.min(20, (target.savageTigermarkRound ?? 0) + (target.tigermarkRound ?? 0) + rolledDiceValue);
              target.tigermarkRound = 0;
              effectResultNote = ` — nạp +${rolledDiceValue} Savage Tigermark Round (chuyển hoá do Shin active, tổng ${target.savageTigermarkRound})`;
            } else {
              target.tigermarkRound = Math.min(20, (target.tigermarkRound ?? 0) + rolledDiceValue);
              effectResultNote = ` — nạp +${rolledDiceValue} Tigermark Round (tổng ${target.tigermarkRound})`;
            }
          }
        }

        // ── XÁC ĐỊNH NHÓM HIT ĐANG COUNTER ────────────────────────────────
        // Counter chỉ tác động lên ĐÚNG 1 nhóm (M1) — phải biết nhóm nào. Tính
        // y hệt reactive-defense.js/interaction-handlers.js để không lệch nhau.
        const tEntryForGroup = p.targets.find(tg => tg.targetId === targetId);
        const totalHitsForGroup = Math.max(1, tEntryForGroup?.preview?.dmgValues?.length ?? 1);
        const isM1ForGroup = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
        const attackerWeightForGroup = attackerResolved.combatant.weaponWeight ?? "medium";
        const hitsPerGroup = p.isEyeOfHorusFixedBurst ? 9 : (isM1ForGroup ? (WEAPON_DEFENSE_HITS[attackerWeightForGroup] ?? 1) : 1);
        const groupCount = Math.max(1, Math.ceil(totalHitsForGroup / hitsPerGroup));
        tEntryForGroup.perHitChoices = tEntryForGroup.perHitChoices ?? Array(groupCount).fill(null);
        // Nút Counter cũ (message gửi TRƯỚC khi deploy bản này) không mang
        // groupIdx → fallback về nhóm CHƯA quyết định đầu tiên, đúng nhóm đang
        // được hỏi trên thực tế.
        const rawGroupIdx = session.counterContext?.groupIdx;
        const fallbackIdx = tEntryForGroup.perHitChoices.findIndex(c => c === null);
        const counterGroupIdx = Number.isFinite(rawGroupIdx)
          ? Math.max(0, Math.min(groupCount - 1, rawGroupIdx))
          : (fallbackIdx === -1 ? 0 : fallbackIdx);
        // Chỉ số hit THẬT (1-based) thuộc nhóm này — cùng công thức với
        // realHitIndices ở interaction-handlers.js.
        const counterGroupHitIndices = [];
        for (let h = counterGroupIdx * hitsPerGroup; h < Math.min((counterGroupIdx + 1) * hitsPerGroup, totalHitsForGroup); h++) {
          counterGroupHitIndices.push(h + 1);
        }

        if (isSuccess) {
          // Tiêu hit THEO WEAPON WEIGHT (tái dùng đúng cơ chế evadeCharges có
          // sẵn — "né/ngắt" đòn địch, resolveOnePendingAction sẽ tự set
          // perHitMult=0 theo số charge này, y hệt Evade thường).
          const isM1Type = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
          const attackerWeapon = attackerResolved.combatant.weaponWeight ?? "medium";
          const hitCount = Math.max(1, p.targets.find(tg => tg.targetId === targetId)?.preview?.dmgValues?.length ?? 1);
          const hitsPerCharge = p.isEyeOfHorusFixedBurst ? 9 : (isM1Type ? (WEAPON_DEFENSE_HITS[attackerWeapon] ?? 1) : 1);
          // BUG KÉP ĐÃ SỬA — code cũ (`isM1Type ? Math.ceil(hitCount/hitsPerCharge) : 1`)
          // SAI CẢ HAI NHÁNH, theo đúng 2 báo cáo của Fragaria:
          //
          //  (a) Nhánh M1 quá MẠNH — "counter hiện tại đang counter né sạch cả
          //      rất nhiều group m1 thay vì theo 1 group hit. 1 page counter chỉ
          //      né được 1 group 4 hit của light weapon m1 thôi, medium thì 2
          //      còn heavy thì 1". Math.ceil(hitCount/hitsPerCharge) trả về SỐ
          //      GROUP (VD M1 light 12 hit = 3 group → 3 charge) nên 1 lần
          //      counter xoá sạch cả loạt. Đúng luật: 1 counter = ĐÚNG 1 group,
          //      tức 1 charge (charge đó tự phủ hitsPerCharge hit theo weapon
          //      weight — light 4 / medium 2 / heavy 1, xem WEAPON_DEFENSE_HITS).
          //
          //  (b) Nhánh SKILL quá YẾU — "sau khi xài you're too slow counter
          //      thành công bị dính 7 sinking từ stylish sweep mặc dù counter sẽ
          //      triệt tiêu đòn kẻ địch". Skill có hitsPerCharge = 1, mà chỉ cộng
          //      1 charge → né đúng 1 hit; các hit còn lại vẫn trúng nên
          //      `evadedCompletely` (resolve-pending-action.js) = false → toàn bộ
          //      status (Sinking/Rupture/Bleed...) vẫn bị áp. Counter NGẮT HẲN
          //      đòn skill nên phải phủ TẤT CẢ hit của skill đó.
          //
          // → M1: đúng 1 charge (1 group). Skill: đủ charge phủ hết hit.
          const chargesNeeded = isM1Type ? 1 : Math.ceil(hitCount / hitsPerCharge);
          // BUG NẶNG ĐÃ SỬA (Fragaria, kèm ảnh: "khi thắng hay thua rtparry của
          // You're Too Slow đều tính là ăn sạch cả toàn bộ group hit... rtparry
          // hiện tại đang giải quyết TOÀN BỘ group hit thay vì chỉ 1 group hit").
          //
          // `chargesNeeded` ở trên vốn đã ĐÚNG luật. Cái sai nằm ở chỗ counter
          // dùng `evadeCharges` TRẦN — resolve-pending-action.js chỉ tiêu charge
          // đó TỪ HIT SỐ 1 TRỞ ĐI (nhánh "né hit 1-4"), nên counter ở nhóm 2 lại
          // đi né nhóm 1. Đường nút bấm thường KHÔNG bị vậy vì nó ghi
          // `evadeHitSelections` = ĐÚNG chỉ số hit thật của nhóm đang chọn.
          // → Dùng CÙNG cơ chế evadeHitSelections, không dùng charge trần nữa.
          //
          // Phạm vi ngắt (Fragaria chốt trực tiếp): "counter chỉ ngắt 1 group hit
          // của M1, còn khi counter thành công page hay critical thì sẽ ngắt
          // TOÀN BỘ dice của critical hay page đó".
          target.evadeHitSelections = target.evadeHitSelections ?? [];
          if (isM1Type) {
            for (const h of counterGroupHitIndices) {
              if (!target.evadeHitSelections.includes(h)) target.evadeHitSelections.push(h);
            }
          } else {
            for (let h = 1; h <= hitCount; h++) {
              if (!target.evadeHitSelections.includes(h)) target.evadeHitSelections.push(h);
            }
          }
          target.evadeCharges = (target.evadeCharges ?? 0) + chargesNeeded;

          // Gây dmg phản công NGAY (nếu skill này tự gây dmg — noDirectDamage
          // = false/undefined) — dùng chính công thức dice roll() của
          // counterSkill, TỰ tính riêng (không qua p/resolveOnePendingAction
          // của đòn đang chờ, vì đây là 1 hành động MỚI hoàn toàn — phản công).
          // "You're Too Slow" — LUỒNG RIÊNG (Fragaria yêu cầu trực tiếp: "sau khi
          // dùng để counter thành công sẽ đánh dấu kẻ địch bị counter rồi hiện
          // tiếp option ở moves để tấn công kẻ địch gây dmg sau đó skill sẽ bắt
          // đầu cd").
          // KHÁC hoàn toàn counter page thường (gây dmg phản công NGAY tại đây):
          //   1. Counter thành công → CHỈ ngắt đòn + đánh dấu địch, KHÔNG dmg.
          //   2. Người chơi thấy option "⚡ You're Too Slow — Đâm <địch>" trong
          //      dropdown Moves, tự bấm khi muốn → lúc đó mới roll dice + gây dmg.
          //   3. CD chỉ bắt đầu SAU đòn đâm đó (xem huỷ CD ngay bên dưới +
          //      interaction-handlers.js's nhánh "ytsfollowup").
          // Cách cũ (tự bắn lại ở turn sau qua youreTooSlowPending) đã bỏ — nó
          // không cho người chơi chọn thời điểm và cũng không khớp mô tả.
          if (counterSkillKey === "you're too slow") {
            // Huỷ CD vừa set ở khối trên — CD chỉ tính sau khi đâm xong.
            delete target.skillCooldowns[cdKeyFor(counterSkillKey)];
            target.youreTooSlowMark = { markedTargetId: p.attackerId, markedLabel: attackerResolved.label };
            choiceNote = `⚡ **You're Too Slow** — né sạch đòn và ĐÁNH DẤU ${attackerResolved.label}! Mở dropdown **Moves** để tung đòn đâm (skill chỉ vào cooldown sau khi đâm).`;
          } else if (!effect.noDirectDamage) {
            const built = autoBuildDmgStrFromSkillRoll(counterSkill);
            if (built.dmgStr) {
              let counterDmgStr = built.dmgStr;
              if (effect.customHitMultiplier) {
                counterDmgStr = Array(effect.customHitMultiplier).fill(built.dmgStr).join(" + ");
              }
              const counterResStr = combatantResStr(attackerResolved.combatant);
              const counterPreview = calcMathCore({ dmgStr: counterDmgStr, resStr: counterResStr, poiseInit: target.poise, chargeInit: target.charge });
              applyHpLoss(attackerResolved.combatant, counterPreview.totalDmg);
              if (effect.smokePerHit) {
                const hits = effect.customHitMultiplier ?? 1;
                attackerResolved.combatant.smoke = (attackerResolved.combatant.smoke ?? 0) + effect.smokePerHit * hits;
              }
              if (effect.paralyzeAfter) {
                attackerResolved.combatant.paralyze = (attackerResolved.combatant.paralyze ?? 0) + effect.paralyzeAfter;
              }
              choiceNote = `⚔️ Counter thành công! **${counterSkill.name}** phản công ${attackerResolved.label} -${counterPreview.totalDmg.toFixed(3)} HP`;
            } else {
              choiceNote = `⚔️ Counter thành công! **${counterSkill.name}**`;
            }
          } else {
            choiceNote = `⚔️ Counter thành công! **${counterSkill.name}** — ngắt đòn tấn công${effectResultNote}`;
          }
        } else if (effect.alwaysUnlocks) {
          const unlockNote = effect.unlocksSkillKey ? `, nhưng vẫn mở khoá **${findSkill(effect.unlocksSkillKey)?.name ?? effect.unlocksSkillKey}**` : effectResultNote;
          choiceNote = `❌ Counter thất bại — ăn đủ dmg${unlockNote}`;
        } else {
          choiceNote = `❌ Counter thất bại — không phòng thủ (ăn dmg thường)`;
        }

        // ── GHI LỰA CHỌN CHO ĐÚNG NHÓM, KHÔNG FINALIZE CẢ ĐÒN ─────────────
        // BUG NẶNG ĐÃ SỬA (Fragaria, kèm ảnh "Hit 5-8/57 (Nhóm 2/15)" rồi kết
        // quả lại resolve trọn 57 hit → -413.400 HP → chết).
        //
        // NGUYÊN NHÂN GỐC: đường rtparry gọi THẲNG `finalizeReactiveChoice`,
        // BỎ QUA hoàn toàn máy `t.perHitChoices[]`. Đường nút bấm thường thì:
        // ghi perHitChoices[groupIdx] → CÒN nhóm null thì KHÔNG finalize, gửi
        // prompt nhóm kế. Gọi thẳng finalize = tuyên bố "mọi nhóm đã quyết
        // định" → resolveOnePendingAction xử hết 15 nhóm/57 hit trong 1 phát,
        // THẮNG HAY THUA CŨNG VẬY (thua thì càng thảm: không né được gì mà vẫn
        // ăn trọn mọi nhóm).
        //
        // SỬA: bám ĐÚNG luồng của nút bấm.
        //  • Counter M1 → ghi 1 ô perHitChoices, các nhóm khác vẫn được hỏi tiếp.
        //  • Counter page/critical THÀNH CÔNG → ngắt toàn bộ dice nên đánh dấu
        //    LUÔN mọi nhóm còn trống (không còn gì để hỏi nữa).
        //  • Counter THẤT BẠI → chỉ mất ĐÚNG nhóm này; nhóm sau vẫn được phòng thủ.
        const counterCoversWholeAction = isSuccess && !isM1ForGroup;
        if (counterCoversWholeAction) {
          for (let gi = 0; gi < tEntryForGroup.perHitChoices.length; gi++) {
            if (tEntryForGroup.perHitChoices[gi] === null) tEntryForGroup.perHitChoices[gi] = choiceNote;
          }
        } else {
          tEntryForGroup.perHitChoices[counterGroupIdx] = choiceNote;
        }
        const stillUndecided = tEntryForGroup.perHitChoices.some(c => c === null);
        if (stillUndecided) {
          // Còn nhóm chưa quyết định → LƯU rồi hỏi tiếp, KHÔNG resolve.
          await saveEncounter(encChannelId, encounter);
          const decidedCount = tEntryForGroup.perHitChoices.filter(c => c !== null).length;
          displayText = `${choiceNote}\n> Đã xử lý nhóm **${counterGroupIdx + 1}/${groupCount}** — còn **${groupCount - decidedCount}** nhóm hit nữa, xem prompt phòng thủ tiếp theo trong Discord.`;
          // KHÔNG gọi sendReactiveDefensePrompt ở ĐÂY: ta đang GIỮ
          // withLock(encounterKey) và hàm đó cũng cần chính cái lock ấy (xem
          // reactive-defense.js) — gọi lồng vào sẽ tự chặn mình. Đặt cờ, gọi
          // SAU KHI lock đã nhả.
          needNextGroupPrompt = true;
          return;
        }
        const finalized = await finalizeReactiveChoice(encChannelId, encounter, p, targetId, tEntryForGroup.perHitChoices.filter(Boolean).join(" · "), `<@${targetId}>`);
        displayText = finalized.resultText;
        // BUG ĐÃ SỬA (Fragaria: "sau khi fail counter tự dưng encounter tự kết
        // thúc luôn — -balance lên check HP thì có vẻ AI đã tự giải quyết ngầm
        // kết quả encounter, KHÔNG HIỆN LÊN").
        // NGUYÊN NHÂN GỐC: đòn resolve ở đây có thể GIẾT nốt người/mob cuối →
        // resolveOnePendingAction gọi finalizeQuestOutcome → quest kết thúc thật
        // (phát thưởng/Death Penalty, set `_deleteAfterSave`). Nhưng đường
        // rtparry này CHỈ sửa lại message minigame trên web — KHÔNG gửi gì vào
        // channel encounter và KHÔNG xử lý `_deleteAfterSave`. Người chơi thấy
        // trận "tự dưng biến mất" mà không có thông báo nào.
        questEndedHere = !!encounter._deleteAfterSave;
        questEndText = finalized.resultText;
      });
      // Hỏi phòng thủ cho nhóm hit KẾ TIẾP — phải nằm NGOÀI withLock ở trên.
      if (needNextGroupPrompt) {
        await sendReactiveDefensePrompt(encChannelId, pendingId).catch((err) => {
          log("error", "counterNextGroupPrompt", session.userId, err.stack ?? err.message);
        });
      }
      if (questEndedHere) {
        const encCh = await client.channels.fetch(encChannelId).catch(() => null);
        if (encCh) {
          await encCh.send({ embeds: [{ title: "🏁 Encounter kết thúc", description: questEndText, color: 0xf1c40f }] }).catch(() => {});
        }
        // KHÔNG gọi deleteEncounter ở đây: finalizeReactiveChoice ĐÃ tự xoá khi
        // thấy `_deleteAfterSave` (xem reactive-defense.js). Ở đây chỉ còn thiếu
        // phần THÔNG BÁO — đó mới là cái bị sót.
      }

      const channel = await client.channels.fetch(session.channelId).catch(() => null);
      if (channel) {
        const msg = await channel.messages.fetch(session.messageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [{ title: "⚔️ Page Counter — Kết quả", description: displayText, color: isSuccess ? 0x2ecc71 : 0xe74c3c }] }).catch(() => {});
        }
      }
    } catch (err) {
      // BUG ĐÃ SỬA (Fragaria: "thỉnh thoảng page counter bị kẹt ở rtparry, không
      // giải quyết được"). TRƯỚC ĐÂY exception ở khối resolve chỉ ghi log server
      // rồi trả `ok: true` — người chơi thấy trang web báo thành công nhưng trong
      // Discord KHÔNG có gì xảy ra, pendingAction treo mãi, không ai biết vì sao.
      // Giờ báo THẲNG vào channel encounter để GM/người chơi biết mà xử lý, và
      // trả lỗi về trang web thay vì giả vờ thành công.
      log("error", "counterResolve", session.userId, err.stack ?? err.message);
      const errCh = await client.channels.fetch(session.counterContext?.encChannelId ?? session.channelId).catch(() => null);
      if (errCh) {
        await errCh.send({
          embeds: [{
            title: "⚠️ Counter gặp lỗi khi xử lý",
            description: `<@${session.userId}> — page counter KHÔNG resolve được: \`${String(err.message).slice(0, 300)}\`\n` +
              "Đòn tấn công vẫn đang treo. GM có thể dùng bảng GM để kết thúc lượt thủ công.",
            color: 0xe74c3c,
          }],
        }).catch(() => {});
      }
      return res.status(500).json({ ok: false, error: String(err.message).slice(0, 200) });
    }
    return res.json({ ok: true });
  }

  try {
    const channel = await client.channels.fetch(session.channelId);
    const msg = await channel.messages.fetch(session.messageId);

    if (finalType === "early") {
      await msg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time — Web",
          description: `<@${session.userId}> đã **bấm sớm quá**! ❌` + (session.skillName ? `\n> Page: **${session.skillName}**` : ""),
          color: 0xe74c3c,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
      });
    } else if (finalType === "missed") {
      // reactionMs có giá trị thật khi user CÓ bấm nhưng trễ (server tự ép success→missed
      // vì vượt windowMs) — hiển thị số đó để họ biết chính xác trễ bao nhiêu. Chỉ khi
      // reactionMs null (failsafe client tự submit vì không bấm luôn) mới hiện chung chung.
      const lateMs = (typeof reactionMs === "number" && Number.isFinite(reactionMs)) ? Math.round(reactionMs) : null;
      await msg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time — Web",
          description:
            `<@${session.userId}> đã **bỏ lỡ** đòn! ❌\n` +
            (lateMs !== null
              ? `> Phản ứng: **${lateMs}ms** — chậm hơn cửa sổ **${session.windowMs}ms**`
              : `> Cửa sổ parry: **${session.windowMs}ms** — không bấm kịp!`) +
            (session.skillName ? `\n> Page: **${session.skillName}**` : ""),
          color: 0xe74c3c,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
      });
    } else if (finalType === "rejected") {
      await msg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time — Web",
          description:
            `<@${session.userId}> kết quả **không hợp lệ** ⚠️\n` +
            `> Phản ứng dưới **${RTPARRY_MIN_HUMAN_MS}ms** — nhanh hơn khả năng phản xạ thật của con người, không được tính.`,
          color: 0x95a5a6,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
      });
    } else {
      const ms = Math.round(reactionMs);
      const rating =
        // Mốc tính theo phản xạ thật (windowMs=250) — không còn latency Discord/CSS
        // pha trộn vào nữa, nên hạ hẳn so với mốc cũ (100/200/300, vốn tính trên số
        // đo bị thổi phồng do bug/latency). <120ms gần như chỉ người phản xạ rất tốt
        // hoặc có luyện tập mới đạt được liên tục; 250ms là giới hạn cứng (window).
        ms < 120 ? "🏆 **AMAZING!** Phản ứng SIÊU NHANH!" :
        ms < 160 ? "⚡ **GREAT!** Phản ứng rất nhanh!"   :
        ms < 200 ? "✅ **GOOD!** Phản ứng tốt!"          :
                   "😅 **NOT BAD!** Vừa kịp!";
      await msg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time — Web",
          description:
            `<@${session.userId}> **PARRY THÀNH CÔNG!** ✅\n` +
            `> ⚡ Phản ứng: **${ms}ms** — ${rating}\n` +
            `> Cửa sổ parry: **${session.windowMs}ms**` + (session.skillName ? ` · Page: **${session.skillName}**` : ""),
          color: 0x2ecc71,
          footer: { text: "Dùng -rtparry để thử lại" },
        }],
      });
    }
  } catch (err) {
    log("error", "parryrt_web_result", session.userId, err.message);
    // Vẫn trả ok cho client — họ đã đo xong, lỗi edit message Discord không phải
    // lỗi của họ, không cần báo lỗi lên trang web.
  }

  res.json({ ok: true });
});

};
