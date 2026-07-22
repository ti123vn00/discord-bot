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

module.exports = function ({ RTPARRY_MIN_HUMAN_MS, WEAPON_DEFENSE_HITS, app, autoBuildDmgStrFromSkillRoll, getBotReady, calcMathCore, client, combatantResStr, encounterKey, finalizeReactiveChoice, findSkill, getEncounter, log, parseSkillCooldownTurns, parseSkillCost, renderParryWebPage, resolveCombatant, webParrySessions, withLock }) {

app.get("/", (req, res) => getBotReady() ? res.send("Bot is alive and kicking!") : res.status(503).send("Bot is starting up..."));

// GET /rtparry/:token — serve trang test phản xạ (chỉ nếu token còn hợp lệ).
app.get("/rtparry/:token", (req, res) => {
  const session = webParrySessions.get(req.params.token);
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
  const session = webParrySessions.get(req.params.token);
  if (!session || session.expiresAt < Date.now()) {
    return res.status(404).json({ ok: false, error: "Link đã hết hạn hoặc đã được dùng." });
  }
  webParrySessions.delete(req.params.token); // single-use — dùng 1 lần là xoá ngay

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

        // Áp dụng hiệu ứng phụ + cooldown/Light — CHỈ khi thành công, TRỪ
        // "alwaysUnlocks" (Yield My Flesh: mở khoá To Claim Their Bones dù
        // thắng hay thua minigame).
        if (isSuccess || effect.alwaysUnlocks) {
          const cost = parseSkillCost(counterSkill.cost);
          target.currentLight = Math.max(0, (target.currentLight ?? 0) - (cost.light ?? 0));
          const cdTurns = parseSkillCooldownTurns(counterSkill.cd);
          target.skillCooldowns = target.skillCooldowns ?? {};
          target.skillCooldowns[counterSkillKey] = cdTurns + 1;
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

        if (isSuccess) {
          // Tiêu hit THEO WEAPON WEIGHT (tái dùng đúng cơ chế evadeCharges có
          // sẵn — "né/ngắt" đòn địch, resolveOnePendingAction sẽ tự set
          // perHitMult=0 theo số charge này, y hệt Evade thường).
          const isM1Type = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
          const attackerWeapon = attackerResolved.combatant.weaponWeight ?? "medium";
          const hitCount = Math.max(1, p.targets.find(tg => tg.targetId === targetId)?.preview?.dmgValues?.length ?? 1);
          const hitsPerCharge = p.isEyeOfHorusFixedBurst ? 9 : (isM1Type ? (WEAPON_DEFENSE_HITS[attackerWeapon] ?? 1) : 1);
          const chargesNeeded = isM1Type ? Math.ceil(hitCount / hitsPerCharge) : 1;
          target.evadeCharges = (target.evadeCharges ?? 0) + chargesNeeded;

          // Gây dmg phản công NGAY (nếu skill này tự gây dmg — noDirectDamage
          // = false/undefined) — dùng chính công thức dice roll() của
          // counterSkill, TỰ tính riêng (không qua p/resolveOnePendingAction
          // của đòn đang chờ, vì đây là 1 hành động MỚI hoàn toàn — phản công).
          if (!effect.noDirectDamage) {
            const built = autoBuildDmgStrFromSkillRoll(counterSkill);
            if (built.dmgStr) {
              let counterDmgStr = built.dmgStr;
              if (effect.customHitMultiplier) {
                counterDmgStr = Array(effect.customHitMultiplier).fill(built.dmgStr).join(" + ");
              }
              const counterResStr = combatantResStr(attackerResolved.combatant);
              const counterPreview = calcMathCore({ dmgStr: counterDmgStr, resStr: counterResStr, poiseInit: target.poise, chargeInit: target.charge });
              attackerResolved.combatant.currentHp = Math.max(0, attackerResolved.combatant.currentHp - counterPreview.totalDmg);
              if (effect.smokePerHit) {
                const hits = effect.customHitMultiplier ?? 1;
                attackerResolved.combatant.smoke = (attackerResolved.combatant.smoke ?? 0) + effect.smokePerHit * hits;
              }
              if (effect.paralyzeAfter) {
                attackerResolved.combatant.paralyze = (attackerResolved.combatant.paralyze ?? 0) + effect.paralyzeAfter;
              }
              choiceNote = `⚔️ Counter thành công! **${counterSkill.name}** phản công ${attackerResolved.label} -${counterPreview.totalDmg.toFixed(3)} HP`;
              // GAP ĐÃ SỬA — "You're Too Slow": "turn sau kích hoạt lại 1 lần"
              // — lưu lại target đã đánh dấu + dmgStr đã roll, TỰ ĐỘNG kích
              // hoạt lại (không cần rtparry lần 2) ở advanceCombatantTurn khi
              // tới lượt kế tiếp của người dùng counter này (turn-advance.js).
              if (counterSkillKey === "you're too slow") {
                target.youreTooSlowPending = { markedTargetId: p.attackerId, dmgStr: counterDmgStr };
              }
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

        const finalized = await finalizeReactiveChoice(encChannelId, encounter, p, targetId, choiceNote, `<@${targetId}>`);
        displayText = finalized.resultText;
      });

      const channel = await client.channels.fetch(session.channelId).catch(() => null);
      if (channel) {
        const msg = await channel.messages.fetch(session.messageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [{ title: "⚔️ Page Counter — Kết quả", description: displayText, color: isSuccess ? 0x2ecc71 : 0xe74c3c }] }).catch(() => {});
        }
      }
    } catch (err) {
      log("error", "counterResolve", session.userId, err.message);
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
