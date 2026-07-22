// message-create-handler.js
// Toàn bộ xử lý lệnh prefix "-..." (encounter, profile, give, gacha, skill,
// craft, daily, parry, inventory, dothihelp...) — TÁCH khỏi index.js theo yêu
// cầu trực tiếp: "tách nhỏ file index.js ra các file js khác" (code đã lên
// tới 11k+ dòng).
//
// COPY NGUYÊN VĂN (không sửa 1 dòng logic nào). Dependency list (138 mục)
// được xác định qua PHÂN TÍCH AST CHÍNH XÁC (acorn) — không dựa vào suy đoán
// thủ công, để tránh sai sót ở 1 handler lớn và phức tạp như thế này.
//
// Factory tự client.on("messageCreate", ...) bên trong (không return gì cả —
// đăng ký listener là side-effect duy nhất, giống chính index.js gốc).

module.exports = function ({ ADMIN_IDS, AMMO_MAX, ActionRowBuilder, BRANCH_KEYS, ButtonBuilder, ButtonStyle, CRAFT_RECIPES, EGO_TIER_SLOT_ORDER, ENCOUNTER_DEFAULT_MAX_STAMINA, ENCOUNTER_KEY_MAX_LENGTH, ENCOUNTER_NAME_MAX_LENGTH, ENCOUNTER_STAMINA_REGEN_PER_TURN, EXP_MAX, GACHA_BANNERS, GACHA_COST_PER_PULL, GACHA_PITY_MAX, GACHA_RATES, GRADE_MAX, GRADE_MIN, MAX_PROFILES, MINOR_INJURIES, OPEN_COUNT_MAX, PARRY_MAX_ROLLS, PERK_BRANCH, PERK_POINT_COSTS, POISE_MAX, PRESCRIPT_TABLE, PROFILE_EMOJIS, PROFILE_LABELS, PROFILE_NAME_MAX_LENGTH, STATUS_CAPS_SHARED, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, UNIVERSALLY_KNOWN_WEAPONS, VALID_BOOKS, VALID_ITEMS, advanceToNextTurnHolder, announceCurrentTurn, appendActionLog, applyClashLossSanity, applyDeathPenalty, applyEmotionDelta, applySanityGain, applyStatusEntries, buildBalanceEmbed, buildBookChoiceComponents, buildBossActionPanel, buildDothihelpEmbed, buildEncounterActionPanel, buildEncounterBoardEmbed, buildGiveConfirmRow, buildGivePreviewLines, buildPendingListText, buildProfileInfoEmbed, buildRollDescription, buildRtparryLinkButton, buildSkillListResult, buildSkillRollResult, buildTurnOrderText, calcBranchPointsAllocated, calcExpForGrade, calcGrade, calcInjuryMaxHpPenalty, calcMath, calcSkillTreePointsEarned, checkStaggerPanic, clampExpWithLunacy, client, createCombatant, createRtparryToken, deleteEncounter, determineTurnOrder, doEnemyAttack, doPlayerAttack, doPlayerHit, encounterKey, executeCraft, executeReadBookChoose, executeRemove, extractDefenseBypassTags, fetchInventoryReply, findAccessory, findBook, findExclusiveConflict, findItem, findItemAdmin, findOutfit, findSkill, findWeaponAnywhere, formatEmotionSummary, formatNumber, getActionLogIcon, getActiveProfileSlot, getEffectiveCurrentHp, getEgoTier, getEncounter, getParryClashPenalty, getPlayerData, getPlayerDataWithSlot, getProfileNames, handleOpenChipboardCache, handleOpenRandomBook, handleOpenSealedBook, hasEncounterStarted, hasPerk, insertIntoTurnOrderMidRound, isBannerActive, isEgoSkill, isOnCooldown, isValidBookChoice, log, normalizeEnemyKey, normalizeWeaponWeight, parseBatchEntries, parseKeyValues, parseOpenCount, performEndTurn, performGachaPull, processDailyClaimForUser, r, redis, registerPendingGive, resolveCombatant, resolveEquipTarget, resolveGmLinkedChannel, resolveProfileLabel, restoreInjuryMaxHp, runParryRolls, saturateBonusPct, saturateDR, saveEncounter, savePlayerData, setActiveProfileSlot, setProfileName, startEmotionTracking, stopEmotionTracking, validateAndRerollPrescript, validateMathInputs, webParrySessions, withLock }) {

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  try {

  // ── -rolldice ──
  // Cú pháp: -rolldice <min>-<max> [x<lần>], <min>-<max> [x<lần>], ...
  // VD: -rolldice 3-7 | -rolldice 3-7 x5 | -rolldice 3-17 x14, 2-4, 2-7 x3
  if (message.content.startsWith("-rolldice")) {
    if (isOnCooldown(message.author.id, "rolldice", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const input = message.content.replace("-rolldice", "").trim();
    if (!input) {
      message.reply(
        "❌ Cú pháp:\n" +
        "> `-rolldice <min>-<max>` — roll 1 lần\n" +
        "> `-rolldice <min>-<max> x<lần>` — roll nhiều lần (tối đa 20)\n" +
        "> `-rolldice <range> x<lần>, <range>, <range> x<lần>` — nhiều dice, mỗi dice có số lần riêng\n" +
        "> VD: `-rolldice 3-7` | `-rolldice 3-7 x5` | `-rolldice 3-17 x14, 2-4, 2-7 x3`"
      );
      return;
    }

    const DICE_MAX_COUNT = 10;
    const ROLL_MAX_TIMES = 20;

    // Parse từng dice entry: "3-7 x5" hoặc "3-7"
    function parseDiceEntry(raw) {
      const trimmed = raw.trim();
      // Match: <min>-<max> x<times> hoặc <min>-<max>
      const match = trimmed.match(/^(\d+)-(\d+)(?:\s+x(\d+))?$/i);
      if (!match) return { error: `Định dạng không hợp lệ: \`${trimmed}\`` };
      const min = parseInt(match[1], 10);
      const max = parseInt(match[2], 10);
      const times = match[3] ? parseInt(match[3], 10) : 1;
      if (min >= max || min < 0) return { error: `Min phải nhỏ hơn Max và không âm: \`${trimmed}\`` };
      if (times <= 0) return { error: `Số lần roll phải lớn hơn 0: \`${trimmed}\`` };
      if (times > ROLL_MAX_TIMES) return { error: `Số lần roll tối đa là ${ROLL_MAX_TIMES}: \`${trimmed}\`` };
      return { min, max, times };
    }

    const rawEntries = input.split(",").map(s => s.trim()).filter(Boolean);
    if (rawEntries.length > DICE_MAX_COUNT) {
      message.reply(`❌ Tối đa ${DICE_MAX_COUNT} dice cùng lúc.`);
      return;
    }

    const diceList = [];
    for (const raw of rawEntries) {
      const parsed = parseDiceEntry(raw);
      if (parsed.error) {
        message.reply(`❌ ${parsed.error}\nĐúng: \`<min>-<max>\` hoặc \`<min>-<max> x<lần>\` (VD: \`3-7 x5\`)`);
        return;
      }
      diceList.push(parsed);
    }

    // Build output
    const outputLines = [];
    const allTracked = [];
    for (const { min, max, times } of diceList) {
      startEmotionTracking();
      const results = Array.from({ length: times }, () => r(min, max));
      const tracked = stopEmotionTracking();
      allTracked.push(...tracked);
      if (times === 1) {
        outputLines.push(`🎲 \`${min}-${max}\` → **${results[0]}** — ${formatEmotionSummary(tracked)}`);
      } else {
        const total = results.reduce((a, b) => a + b, 0);
        const avg = (total / times).toFixed(2);
        outputLines.push(
          `🎲 \`${min}-${max}\` ×${times}: **${total}** [${results.join(" ")}]` +
          ` *(avg: ${avg} | min: ${Math.min(...results)} | max: ${Math.max(...results)})*\n` +
          `> ${formatEmotionSummary(tracked)}`
        );
      }
    }

    const header = diceList.length > 1
      ? `${message.author} đã roll **${diceList.length} dice**:\n`
      : `${message.author} `;
    const footer = diceList.length > 1 ? `\n**Tổng cộng:** ${formatEmotionSummary(allTracked)}` : "";
    const body = header + outputLines.join("\n") + footer;
    message.reply(body.length > 2000 ? body.substring(0, 1990) + "\n…(bị cắt bớt)" : body);
    return;
  }

  // ── -Caduceus ──
  // Cú pháp:
  //   -Caduceus [số lần]                              — roll ngẫu nhiên hoàn toàn
  //   -Caduceus <Blunt|Pierce|Slash> [số lần] [karmic] — 75% ra đúng type (giảm theo Karmic Consequence)
  // Công thức Karmic: chance = max(0, 75 - karmic / 2) %
  if (message.content.toLowerCase().startsWith("-caduceus")) {
    if (isOnCooldown(message.author.id, "caduceus", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const CADUCEUS_MAX = 20;

    // Tách pool theo type dựa vào nội dung string trong PRESCRIPT_TABLE
    const TYPED_POOLS = {
      blunt:  PRESCRIPT_TABLE.filter(e => e.includes("Blunt")),
      pierce: PRESCRIPT_TABLE.filter(e => e.includes("Pierce")),
      slash:  PRESCRIPT_TABLE.filter(e => e.includes("Slash")),
    };
    const TYPE_LABELS = { blunt: "Blunt", pierce: "Pierce", slash: "Slash" };
    const TYPE_COLORS = { blunt: 0xe67e22, pierce: 0x3498db, slash: 0xe74c3c };
    const TYPE_ICONS  = { blunt: "<:Blunt:1513768529718022254>", pierce: "<:Pierce:1513768511179329556>", slash: "<:Slash:1513768633434640517>"};

    const arg = message.content.replace(/-caduceus/i, "").trim();
    const tokens = arg.split(/\s+/);

    // Kiểm tra token đầu có phải type không
    const firstLower = (tokens[0] ?? "").toLowerCase();
    const isTyped = firstLower in TYPED_POOLS;

    if (isTyped) {
      // -Caduceus <type> [times] [karmic]
      const typeKey  = firstLower;
      const timesRaw = parseInt(tokens[1], 10);
      const times    = (!isNaN(timesRaw) && timesRaw > 0) ? timesRaw : 1;
      if (times > CADUCEUS_MAX) {
        message.reply(`❌ Số lần roll tối đa là ${CADUCEUS_MAX}.`);
        return;
      }
      const karmicRaw = parseFloat(tokens[2]);
      const karmic    = (!isNaN(karmicRaw) && karmicRaw >= 0) ? karmicRaw : 0;
      const chance    = Math.max(0, 75 - karmic / 2); // % ra đúng type

      const typePool = TYPED_POOLS[typeKey];
      if (typePool.length === 0) {
        message.reply(`❌ Không tìm thấy entry nào với type **${TYPE_LABELS[typeKey]}** trong Prescript Table.`);
        return;
      }

      const results = Array.from({ length: times }, () => {
        const useTypePool = Math.random() * 100 < chance;
        const pool        = useTypePool ? typePool : PRESCRIPT_TABLE;
        const entry       = pool[Math.floor(Math.random() * pool.length)];
        // Đánh dấu dựa trên nội dung entry thực tế, không phải pool đã chọn
        const isCorrectType = entry.includes(TYPE_LABELS[typeKey]);
        const hitMark = isCorrectType ? " ✅" : " ❌";
        return entry + hitMark;
      });

      // Đếm số lần ra đúng type
      const hits = results.filter(r => r.endsWith("✅")).length;

      message.reply({
        embeds: [{
          title: `${TYPE_ICONS[typeKey]} Prescript — ${TYPE_LABELS[typeKey]}${times > 1 ? ` × ${times}` : ""}`,
          color: TYPE_COLORS[typeKey],
          description:
            `> **Tỷ lệ ra ${TYPE_LABELS[typeKey]}:** ${chance.toFixed(1)}%` +
            (karmic > 0 ? ` *(Karmic Consequence: ${karmic} → −${(karmic / 2).toFixed(1)}%)*` : "") +
            `\n> **Kết quả đúng type:** ${hits}/${times}\n\n` +
            results.join("\n"),
        }],
      });
      return;
    }

    // Mặc định: -Caduceus [số lần] (không typed)
    const timesRaw = parseInt(tokens[0], 10);
    const times    = (!isNaN(timesRaw) && timesRaw > 0) ? timesRaw : 1;
    if (times > CADUCEUS_MAX) {
      message.reply(`❌ Số lần roll tối đa là ${CADUCEUS_MAX}.`);
      return;
    }
    const results = Array.from({ length: times }, () =>
      PRESCRIPT_TABLE[Math.floor(Math.random() * PRESCRIPT_TABLE.length)]
    );
    message.reply({
      embeds: [{
        title: `🎲 Prescript${times > 1 ? ` × ${times}` : ""}`,
        color: 0xe74c3c,
        description: results.join("\n"),
      }],
    });
    return;
  }

  // ── -skill ──
  // Cú pháp: -skill <tên skill> | -skill list
  if (/^-skill(\s|$)/i.test(message.content)) {
    if (isOnCooldown(message.author.id, "skill", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const rawInput = message.content.replace("-skill", "").trim();

    // Cho phép thêm "dullahan" hoặc "no dullahan" / "nodullahan" ở cuối để buộc kết quả Dullahan on/off
    let forceDullahan = false;
    let input = rawInput;
    const dullahanMatch = input.match(/\s*(dullahan)\s*$/i);
    if (dullahanMatch) {
      forceDullahan = true;
      input = input.slice(0, dullahanMatch.index).trim();
    }

    // -skill list <keyword> [trang] — tìm skill theo keyword, có phân trang
    // VD: -skill list slash | -skill list slash 2
    if (/^list\s+[^\d]/i.test(input)) {
      const kwPageMatch = input.replace(/^list\s+/i, "").trim().match(/^(.+?)\s+(\d+)$/);
      const keyword = kwPageMatch ? kwPageMatch[1].trim() : input.replace(/^list\s+/i, "").trim();
      const page = kwPageMatch ? parseInt(kwPageMatch[2], 10) : 1;
      const result = buildSkillListResult({ keyword, page });
      if (result.error) { message.reply(result.error); return; }
      message.reply({ embeds: [result.embed] });
      return;
    }

    // -skill list [trang]
    // Cú pháp: -skill list | -skill list 2 | -skill list 3
    if (!input || input.toLowerCase() === "list" || /^list\s+\d+$/i.test(input)) {
      const pageMatch = input.match(/list\s+(\d+)/i);
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
      const result = buildSkillListResult({ page });
      message.reply({ embeds: [result.embed] });
      return;
    }

    // -skill <tên> <số lần> — roll skill đó nhiều lần liên tiếp trong 1 lệnh
    // (VD: -skill durandal 2). CHỈ áp dụng cho skill KHÔNG có promptArg — vì những
    // skill này (VD: sanguine pointilism) đã dùng số cuối cùng làm % reuse riêng,
    // không được hiểu lầm thành count. Thử tách trước; nếu tên không khớp hoặc
    // skill khớp lại có promptArg, fallback dùng input gốc (giữ hành vi cũ).
    let rollCount = 1;
    let skill = null;
    const countMatch = input.match(/^(.+?)\s+(\d+)$/);
    if (countMatch) {
      const candidate = findSkill(countMatch[1].trim());
      if (candidate && !candidate.promptArg) {
        skill = candidate;
        rollCount = parseInt(countMatch[2], 10);
      }
    }
    if (!skill) {
      skill = findSkill(input);
    }
    if (!skill) {
      message.reply(`❌ Không tìm thấy skill: \`${input}\`\nDùng \`-skill list\` để xem danh sách.`);
      return;
    }

    // promptArg skill dùng từ cuối cùng trong input làm arg (VD: "-skill thrust 4" → "4")
    const parts = input.trim().split(/\s+/);
    const promptArgRaw = parts[parts.length - 1];

    const result = buildSkillRollResult({ skill, rollCount, promptArgRaw, forceDullahan });
    if (result.error) { message.reply(result.error); return; }
    message.reply({ embeds: [result.embed] });
    return;
  }

  // ── -parry ──
  if (message.content.startsWith("-parry")) {
    if (isOnCooldown(message.author.id, "parry", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const args = message.content.replace("-parry", "").trim().split(/\s+/);
    const parsedRolls = parseInt(args[0]);
    if (!isNaN(parsedRolls) && parsedRolls <= 0) {
      message.reply("❌ Số lần roll phải lớn hơn 0.");
      return;
    }
    let rolls = (!isNaN(parsedRolls) && Number.isFinite(parsedRolls) && parsedRolls > 0) ? parsedRolls : 1;
    if (rolls > PARRY_MAX_ROLLS) {
      message.reply(`❌ Số lần roll tối đa là ${PARRY_MAX_ROLLS}.`);
      return;
    }
    const { successCount, failCount, lines } = runParryRolls(rolls);
    const summary = `**Kết quả tổng kết:**\n• Thành công: \`${successCount}\` lần\n• Thất bại: \`${failCount}\` lần`;
    const body = `**Parry ${rolls} lần:**\n${lines.join("\n")}\n${summary}`;
    if (body.length > 2000) {
      message.reply(body.substring(0, 1990) + "\n…(bị cắt bớt)");
    } else {
      message.reply(body);
    }
    return;
  }

  // ── -rtparry (Parry phản xạ thời gian thực — DM link, đo chính xác trên web) ──
  if (message.content.startsWith("-rtparry")) {
    const argStr = message.content.replace(/^-rtparry/i, "").trim();
    let targetSkill = null;
    if (argStr) {
      targetSkill = findSkill(argStr);
      if (!targetSkill) {
        message.reply(`⚠️ Không tìm thấy skill **"${argStr}"**. Dùng \`-rtparry\` không kèm tên cho bản mặc định.`);
        return;
      }
    }
    // targetSkill = null nếu không kèm tên — KHÔNG tự chọn random skill (trước đây có
    // làm vậy nhưng sai ý: "-rtparry" trần là bản mặc định đơn giản, không liên quan
    // page cụ thể nào, chỉ "-rtparry <tên>" mới cần tra tốc độ Page thật).

    if (isOnCooldown(message.author.id, "parryrt_web", 5000)) {
      message.reply("⏳ Chờ vài giây trước khi thử lại nhé.");
      return;
    }
    // Discord KHÔNG cho ephemeral với message thường (prefix) — chỉ interaction/slash
    // mới ephemeral được. Nên prefix vẫn phải DM để giữ link riêng tư (không công khai
    // trong channel, ai cầm link cũng chơi được thay được).
    let sentMsg;
    try {
      sentMsg = await message.reply({
        embeds: [{
          title: "⚔️ Parry Real Time",
          description: "📬 Đã gửi link qua **DM** cho bạn — mở DM để bắt đầu." +
            (targetSkill ? `\n> Page: **${targetSkill.name}**` : ""),
          color: 0xf39c12,
          footer: { text: "Kết quả sẽ tự hiện lại ở đây sau khi bạn chơi xong" },
        }],
      });
    } catch (err) {
      log("error", "parryrt", message.author.id, err.message);
      return;
    }

    const linkInfo = createRtparryToken({ userId: message.author.id, channelId: message.channel.id, messageId: sentMsg.id, skill: targetSkill });
    if (!linkInfo) {
      await sentMsg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time",
          description:
            "⚠️ Bot chưa biết URL public của mình (thiếu env var `RENDER_EXTERNAL_URL` hoặc `PUBLIC_URL`).\n" +
            "> Báo admin set 1 trong 2 biến này thì lệnh này mới hoạt động được.",
          color: 0xe74c3c,
        }],
      }).catch(() => {});
      return;
    }

    try {
      await message.author.send({
        embeds: [{ title: "⚔️ Parry Real Time", description: "Bấm nút dưới để mở Parry Real Time.", color: 0xf39c12 }],
        components: [buildRtparryLinkButton(linkInfo.url)],
      });
    } catch (err) {
      // DM thất bại (user tắt DM từ thành viên server) — báo lại trong channel, không
      // để họ chờ vô vọng không biết vì sao không thấy gì. Dọn session vì link sẽ
      // không ai dùng được nữa (không gửi đi được).
      log("error", "parryrt_dm", message.author.id, err.message);
      webParrySessions.delete(linkInfo.token);
      await sentMsg.edit({
        embeds: [{
          title: "⚔️ Parry Real Time",
          description:
            "❌ Không gửi được DM cho bạn — có thể bạn đã tắt **\"Allow direct messages from server members\"**.\n" +
            "> Bật lại trong Privacy Settings của server này rồi dùng lại lệnh này.",
          color: 0xe74c3c,
        }],
      }).catch(() => {});
    }
    return;
  }


  // ── -daily ──
  if (message.content.startsWith("-daily")) {
    if (isOnCooldown(message.author.id, "daily", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const userId = message.author.id;
    try {
      const result = await processDailyClaimForUser(userId);
      if (result.alreadyClaimed) {
        message.reply(
          `${message.author}, bạn đã nhận daily hôm nay rồi.\n` +
          `Thời gian còn lại đến reset: **${result.hours}h ${result.minutes}m ${result.seconds}s**.`
        );
      } else {
        message.reply(result.replyMsg.replace("{USER}", message.author.toString()));
      }
    } catch (err) {
      log("error", "daily", userId, err.message, { stack: err.stack });
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}`);
    }
    return;
  }

  // ── -balance ──
  if (message.content.startsWith("-balance")) {
    if (isOnCooldown(message.author.id, "balance", 2000)) { message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé."); return; }
    const targetUser = message.mentions.users.first() ?? message.author;
    try {
      message.reply(await buildBalanceEmbed(targetUser, targetUser.id === message.author.id));
    } catch (err) {
      log("error", "balance", targetUser.id, err.message);
      message.reply("❌ Có lỗi xảy ra khi lấy dữ liệu.");
    }
    return;
  }

  // ── -inventory ──
  if (message.content.startsWith("-inventory")) {
    if (isOnCooldown(message.author.id, "inventory", 2000)) { message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé."); return; }
    const targetUser = message.mentions.users.first() ?? message.author;
    try {
      const reply = await fetchInventoryReply(targetUser);
      if (!reply) {
        message.reply(`📦 ${targetUser} không có gì trong kho.`);
        return;
      }
      message.reply(reply);
    } catch (err) {
      log("error", "inventory", targetUser.id, err.message);
      message.reply("❌ Có lỗi xảy ra khi lấy dữ liệu.");
    }
    return;
  }

  // ── -give ──
  if (message.content.startsWith("-give")) {
    if (isOnCooldown(message.author.id, "give", 3000)) {
      message.reply("⏳ Chờ 3 giây trước khi dùng lệnh này tiếp nhé.");
      return;
    }
    const isAdmin = ADMIN_IDS.has(message.author.id);
    const targetUser = message.mentions.users.first();
    if (!targetUser) {
      message.reply("❌ Hãy mention người nhận. Ví dụ: `-give @user book: Random Book count: 1`");
      return;
    }
    if (targetUser.id === message.author.id) {
      message.reply("❌ Không thể tặng cho chính mình.");
      return;
    }
    const rawInput = message.content.replace("-give", "").replace(/<@!?\d+>/, "").trim();
    const kv = parseKeyValues(rawInput);
    // Dùng hàm helper để phân biệt "không nhập" (undefined→0) với "nhập sai" (NaN→error)
    // tránh bug parseInt("abc") || 0 nuốt giá trị không hợp lệ thành 0 không báo lỗi.
    function parseIntOrError(raw, fieldName) {
      if (raw == null) return { value: 0, error: null };
      const n = parseInt(raw, 10);
      if (isNaN(n)) return { value: null, error: `❌ \`${fieldName}\` phải là số nguyên, nhận được: \`${raw}\`` };
      return { value: n, error: null };
    }
    const expParsed  = parseIntOrError(kv["exp"],  "exp");
    const ahnParsed  = parseIntOrError(kv["ahn"],  "ahn");
    if (expParsed.error)  { message.reply(expParsed.error);  return; }
    if (ahnParsed.error)  { message.reply(ahnParsed.error);  return; }
    const expGain = expParsed.value;
    const ahnGain = ahnParsed.value;
    const bookRaw = kv["book"] ?? null;
    const bookCount = Math.max(1, parseInt(kv["count"] ?? "1", 10) || 1);
    const itemRaw = kv["item"] ?? null;
    const hasBook = !!bookRaw;
    // Nếu có cả book lẫn item, dùng itemcount: riêng để tránh nhầm lẫn với count: của book.
    // Nếu chỉ có item, itemcount: ưu tiên trước rồi mới fallback sang count:.
    const itemCountRaw = kv["itemcount"] ?? (hasBook ? "1" : kv["count"] ?? "1");
    const itemCount = Math.max(1, parseInt(itemCountRaw, 10) || 1);
    const gradeTarget = kv["grade"] ? parseInt(kv["grade"], 10) : null;

    if (!isAdmin && (expGain !== 0 || gradeTarget !== null)) {
      message.reply("❌ Bạn không thể tặng EXP cho người khác.");
      return;
    }
    if (!isAdmin && ahnGain < 0) {
      message.reply("❌ Không thể chuyển số Ahn âm.");
      return;
    }
    if (gradeTarget !== null && (isNaN(gradeTarget) || gradeTarget < GRADE_MAX || gradeTarget > GRADE_MIN)) {
      message.reply(`❌ Grade phải từ ${GRADE_MAX}–${GRADE_MIN}.`);
      return;
    }
    let bookName = null;
    if (bookRaw) {
      bookName = findBook(bookRaw);
      if (!bookName) {
        message.reply(`❌ Tên sách không hợp lệ: \`${bookRaw}\`\nDùng \`-books\` để xem danh sách sách hợp lệ.`);
        return;
      }
    }
    let itemName = null;
    if (itemRaw) {
      itemName = isAdmin ? findItemAdmin(itemRaw) : findItem(itemRaw);
      if (!itemName) {
        message.reply(`❌ Tên vật phẩm không hợp lệ: \`${itemRaw}\`\nDùng \`-items\` để xem danh sách vật phẩm hợp lệ.`);
        return;
      }
    }
    if (expGain === 0 && ahnGain === 0 && !bookName && !itemName && gradeTarget === null) {
      message.reply("❌ Cần chỉ định ít nhất một trong: `ahn`, `book`, `item`" + (isAdmin ? ", `exp`, `grade`." : "."));
      return;
    }

    // Thay vì thực hiện ngay, hiển thị preview + nút Xác nhận/Hủy để tránh
    // chuyển nhầm người/nhầm số lượng (đặc biệt nguy hiểm với admin give exp/grade/ahn).
    const previewLines = buildGivePreviewLines({ ahnGain, bookName, bookCount, itemName, itemCount, expGain, gradeTarget });
    const giveId = registerPendingGive(message.author.id, targetUser.id, isAdmin, {
      ahnGain, bookName, bookCount, itemName, itemCount, expGain, gradeTarget,
    });
    message.reply({
      embeds: [{
        title: "📦 Xác nhận chuyển đồ",
        description:
          `${message.author} muốn ${isAdmin ? "tặng" : "chuyển"} cho ${targetUser}:\n` +
          previewLines.map(l => `> ${l}`).join("\n"),
        color: 0xf0a500,
        footer: { text: "Hết hạn sau 60 giây" },
      }],
      components: [buildGiveConfirmRow(giveId)],
    });
    return;
  }

  // ── -remove ──
  if (message.content.startsWith("-remove")) {
    if (isOnCooldown(message.author.id, "remove", 3000)) {
      message.reply("⏳ Chờ 3 giây trước khi dùng lệnh này tiếp nhé.");
      return;
    }
    const isAdmin = ADMIN_IDS.has(message.author.id);
    const mentionedUser = message.mentions.users.first();
    let targetUser;
    if (mentionedUser) {
      if (!isAdmin && mentionedUser.id !== message.author.id) {
        message.reply("❌ Bạn chỉ có thể xóa đồ của chính mình.");
        return;
      }
      targetUser = mentionedUser;
    } else {
      targetUser = message.author;
    }
    const rawInput = message.content.replace("-remove", "").replace(/<@!?\d+>/, "").trim();
    const kv = parseKeyValues(rawInput);
    // parseInt || 0 nuốt NaN — validate trước để báo lỗi rõ ràng cho admin
    function parseRemoveInt(raw, fieldName) {
      if (raw == null) return { value: 0, error: null };
      const n = parseInt(raw, 10);
      if (isNaN(n)) return { value: null, error: `❌ \`${fieldName}\` phải là số nguyên, nhận được: \`${raw}\`` };
      return { value: n, error: null };
    }
    const expParsed = parseRemoveInt(kv["exp"], "exp");
    const ahnParsed = parseRemoveInt(kv["ahn"], "ahn");
    if (expParsed.error) { message.reply(expParsed.error); return; }
    if (ahnParsed.error) { message.reply(ahnParsed.error); return; }
    const expRemove = expParsed.value;
    const ahnRemove = ahnParsed.value;
    const bookRaw = kv["book"] ?? null;
    const bookCount = Math.max(1, parseInt(kv["count"] ?? "1", 10) || 1);
    const itemRaw = kv["item"] ?? null;
    const itemCount = Math.max(1, parseInt(kv["itemcount"] ?? kv["count"] ?? "1", 10) || 1);

    if (!isAdmin && (expRemove !== 0 || ahnRemove !== 0)) {
      message.reply("❌ Bạn chỉ có thể tự xóa sách hoặc vật phẩm của mình.");
      return;
    }

    const bookEntries = [];
    if (bookRaw) {
      const bookName = findBook(bookRaw);
      if (!bookName) { message.reply(`❌ Tên sách không hợp lệ: \`${bookRaw}\``); return; }
      bookEntries.push({ name: bookName, count: bookCount });
    }
    const itemEntries = [];
    if (itemRaw) {
      const itemName = isAdmin ? findItemAdmin(itemRaw) : findItem(itemRaw);
      if (!itemName) { message.reply(`❌ Tên vật phẩm không hợp lệ: \`${itemRaw}\``); return; }
      itemEntries.push({ name: itemName, count: itemCount });
    }

    const booksRaw = kv["books"] ?? null;
    if (booksRaw) {
      const result = parseBatchEntries(booksRaw, findBook, "sách");
      if (result.error) { message.reply(result.error); return; }
      bookEntries.push(...result.entries);
    }
    const itemsRaw = kv["items"] ?? null;
    if (itemsRaw) {
      const findFn = isAdmin ? findItemAdmin : findItem;
      const result = parseBatchEntries(itemsRaw, findFn, "vật phẩm");
      if (result.error) { message.reply(result.error); return; }
      itemEntries.push(...result.entries);
    }

    if (expRemove === 0 && ahnRemove === 0 && bookEntries.length === 0 && itemEntries.length === 0) {
      message.reply("❌ Cần chỉ định ít nhất một trong: `exp`, `ahn`, `book`, `item`, `books`, `items`.");
      return;
    }
    try {
      const changes = await withLock(targetUser.id, () => executeRemove({
        actorId: message.author.id, targetId: targetUser.id,
        isAdmin, expRemove, ahnRemove, bookEntries, itemEntries,
      }));
      const isSelf = targetUser.id === message.author.id;
      const header = isSelf
        ? `🗑️ ${message.author} đã xóa khỏi kho của mình:`
        : `🗑️ ${message.author} (admin) đã xóa khỏi kho của ${targetUser}:`;
      message.reply(header + "\n" + changes.map(c => `> ${c}`).join("\n"));
    } catch (err) {
      log("error", "remove", targetUser.id, err.message, { actor: message.author.id });
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}`);
    }
    return;
  }

  // ── -setplayer ──
  // ── -rewoundtime — hồi sinh nhân vật đang Permanent Death (luật: "có thể hồi
  // sinh lại bằng cách sử dụng rewound time; mỗi 1 profile sẽ có lần đầu hồi sinh
  // miễn phí"). Admin/GM dùng giúp player (vì player đã chết không tự gõ lệnh
  // được theo tinh thần luật, nhưng không hại gì nếu cho self-use — vẫn enforce
  // đúng giới hạn 1 lần miễn phí + cần item "Rewound Time" cho các lần sau).
  // ── -healitem — hồi HP NGOÀI encounter (luật: "HP persist nhưng vẫn có thể hồi
  // lại bằng cách dùng consumable item ở ngoài" — KHÁC -encounter useitem, lệnh đó
  // chỉ dùng được TRONG 1 encounter đang chạy, KHÔNG đụng tới currentHp đã persist
  // trên profile). Không có số liệu hồi cụ thể nào được luật cho — coi "dùng item
  // hồi phục" nghĩa là HỒI ĐẦY (full heal), hợp lý nhất cho 1 item hồi phục dùng
  // ngoài combat.
  // ── -readbook — "đọc" 1 cuốn sách, tiêu 1 cuốn khỏi inventory, hiện ĐẦY ĐỦ
  // Page/Weapon/Outfit sách đó dạy được (tra từ BOOK_GRANTS) — xác nhận trực tiếp
  // từ GM: KHÔNG chặn equip nếu chưa đọc (equip vẫn tự do như trước, sách chỉ mang
  // tính ghi nhận/tham khảo).
  // ── -readbook — theo yêu cầu trực tiếp: đọc = CHỌN ĐÚNG 1 Page/Weapon/Outfit
  // (KHÔNG PHẢI mở khoá tất cả — thiết kế CŨ bị coi là "lấy hết chỉ bằng 1 quyển
  // sách rẻ tiền", ĐÃ THAY THẾ HOÀN TOÀN). Không gõ `choose:` → hiện dropdown chọn.
  // Có `choose:` → chốt luôn (tiện cho GM cấp nhanh/player đã biết muốn gì).
  if (message.content.startsWith("-readbook")) {
    const rawInput = message.content.replace("-readbook", "").trim();
    const kv = parseKeyValues(rawInput);
    const chooseRaw = kv["choose"] ?? null;
    const bookNameRaw = chooseRaw ? rawInput.slice(0, rawInput.toLowerCase().indexOf("choose:")).trim() : rawInput;
    if (!bookNameRaw) { message.reply("⚠️ Cú pháp: `-readbook <tên sách>` (hiện dropdown chọn) hoặc `-readbook <tên sách> choose: <tên Page/Vũ khí/Outfit>` (chốt luôn).\n> Mẹo: dùng `-inventory` rồi bấm nút 📚 Đọc cho tiện hơn."); return; }
    try {
      const bookName = findBook(bookNameRaw);
      if (!bookName) throw new Error(`Không nhận diện được sách "${bookNameRaw}".`);
      const { data: profileData } = await getPlayerDataWithSlot(message.author.id);
      const owned = profileData.books?.[bookName] ?? 0;
      if (owned < 1) throw new Error(`Bạn không có (hoặc đã hết) **${bookName}** trong inventory.`);
      if (!chooseRaw) {
        message.reply(buildBookChoiceComponents(message.author.id, bookName, owned));
        return;
      }
      // choose: <tên> — cần biết đây là page/weapon/outfit — thử LẦN LƯỢT cả 3 loại.
      let matchedType = null;
      for (const t of ["page", "weapon", "outfit"]) {
        if (isValidBookChoice(bookName, t, chooseRaw.trim())) { matchedType = t; break; }
      }
      if (!matchedType) throw new Error(`"${chooseRaw.trim()}" không thuộc **${bookName}** (hoặc là TÊN NHÓM của Library Book — dùng dropdown thay vì gõ tay cho trường hợp này).`);
      await withLock(message.author.id, async () => {
        const result = await executeReadBookChoose(message.author.id, bookName, matchedType, chooseRaw.trim());
        message.reply({
          embeds: [{
            title: `📖 Đã đọc: ${result.bookName}`,
            description: `Nhận được: **${result.chosenName}** (${matchedType === "page" ? "Page" : matchedType === "weapon" ? "Vũ khí" : "Outfit"})\n\n*Còn lại: ${result.remaining} cuốn.*`,
            color: 0x5865f2,
          }],
        });
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-healitem")) {
    const itemNameRaw = message.content.replace("-healitem", "").trim();
    if (!itemNameRaw) { message.reply("⚠️ Cú pháp: `-healitem <tên item>` (hồi ĐẦY HP — dùng item hồi phục trong inventory, KHÔNG cần đang ở trong encounter)."); return; }
    try {
      await withLock(message.author.id, async () => {
        const { data: profileData, slot } = await getPlayerDataWithSlot(message.author.id);
        const itemName = findItem(itemNameRaw) ?? (profileData.items?.[itemNameRaw] > 0 ? itemNameRaw : null);
        if (!itemName) throw new Error(`Không tìm thấy item "${itemNameRaw}" trong inventory của bạn.`);
        const owned = profileData.items?.[itemName] ?? 0;
        if (owned < 1) throw new Error(`Không còn **${itemName}** trong inventory.`);
        profileData.items[itemName] = owned - 1;
        if (profileData.items[itemName] <= 0) delete profileData.items[itemName];
        const { grade } = calcGrade(profileData.exp ?? 0);
        // BUG ĐÃ SỬA: trước đây dùng maxHp THÔ theo Grade, KHÔNG trừ injury penalty
        // (Gãy Xương/Vết thương lớn) — "hồi đầy HP" có thể vượt quá Max HP THẬT của
        // player đang mang chấn thương, gây currentHp > maxHp cho tới lần join kế
        // tiếp mới tự sửa lại (vì join luôn tự clamp).
        const rawMaxHp = 140 + 20 * (GRADE_MIN - grade);
        const injuryPenalty = calcInjuryMaxHpPenalty(profileData.injuries);
        const maxHp = Math.max(1, rawMaxHp - injuryPenalty);
        profileData.currentHp = maxHp;
        profileData.hpLastResetCheck = Date.now();
        await savePlayerData(message.author.id, profileData, slot);
        message.reply(`🧪 ${message.author} đã dùng **${itemName}** — hồi đầy HP (${maxHp}/${maxHp})!${injuryPenalty > 0 ? ` (Max HP đang bị giảm ${injuryPenalty} do chấn thương chưa chữa — item này KHÔNG chữa injury, chỉ hồi HP.)` : ""}`);
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── -healinjuryahn — chữa 1 chấn thương NGOÀI encounter bằng Ahn (luật xác nhận
  // trực tiếp: "chỉ có dùng Ahn để chữa trị hoặc dùng item đặc biệt [K-Corp Ampule]
  // mới chữa khỏi TRONG encounter"). GM TỰ ĐỊNH GIÁ mỗi lần (không có mức cố định)
  // — GM gõ số Ahn cụ thể lúc dùng lệnh này. CHỈ admin/GM được dùng (vì GM là người
  // quyết định giá, không phải player tự trả tuỳ ý).
  if (message.content.startsWith("-healinjuryahn")) {
    const isAdminHealAhn = ADMIN_IDS.has(message.author.id);
    if (!isAdminHealAhn) { message.reply("⚠️ Chỉ admin/GM mới được dùng lệnh này (GM là người quyết định giá Ahn mỗi lần)."); return; }
    const targetUser = message.mentions.users.first();
    const kv = parseKeyValues(message.content.replace("-healinjuryahn", "").trim());
    const ahnCost = parseInt(kv["ahn"] ?? "", 10);
    const index = parseInt(kv["index"] ?? "", 10);
    if (!targetUser || !Number.isFinite(ahnCost) || ahnCost < 0 || !Number.isFinite(index) || index < 1) {
      message.reply("⚠️ Cú pháp: `-healinjuryahn @user ahn: <số Ahn GM tự định giá> index: <số thứ tự chấn thương, xem qua -profile hoặc -encounter status>`");
      return;
    }
    try {
      await withLock(targetUser.id, async () => {
        const { data: profileData, slot } = await getPlayerDataWithSlot(targetUser.id);
        const list = profileData.injuries ?? [];
        if (index > list.length) throw new Error(`${targetUser.username} chỉ có ${list.length} chấn thương đang mang — không có #${index}.`);
        if ((profileData.ahn ?? 0) < ahnCost) throw new Error(`${targetUser.username} không đủ Ahn — cần ${ahnCost}, hiện có ${profileData.ahn ?? 0}.`);
        const removed = list.splice(index - 1, 1)[0];
        profileData.ahn = (profileData.ahn ?? 0) - ahnCost;
        await savePlayerData(targetUser.id, profileData, slot);
        message.reply(`🩹💰 Đã chữa khỏi chấn thương của **${targetUser.username}**: "${removed}" (tốn ${ahnCost} Ahn, còn lại ${profileData.ahn} Ahn).\n> Lưu ý: nếu ${targetUser.username} đang ở TRONG 1 encounter khác, cần \`-encounter join\` lại để cập nhật Max HP/injury mới nhất.`);
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-rewoundtime")) {
    const isAdmin = ADMIN_IDS.has(message.author.id);
    const targetUser = message.mentions.users.first();
    if (!targetUser) { message.reply("⚠️ Cú pháp: `-rewoundtime @user`"); return; }
    if (!isAdmin && message.author.id !== targetUser.id) {
      message.reply("⚠️ Chỉ admin/GM hoặc chính người đó mới được tự hồi sinh.");
      return;
    }
    try {
      await withLock(targetUser.id, async () => {
        const { data: profileData, slot } = await getPlayerDataWithSlot(targetUser.id);
        if (!profileData.permanentlyDead) throw new Error(`${targetUser.username} không ở trạng thái Permanent Death — không cần hồi sinh.`);
        if (!profileData.hasUsedFreeRevive) {
          profileData.permanentlyDead = false;
          profileData.hasUsedFreeRevive = true;
          await savePlayerData(targetUser.id, profileData, slot);
          message.reply(`✨ Đã hồi sinh **${targetUser.username}** bằng **lần Rewound Time MIỄN PHÍ ĐẦU TIÊN** của profile này (đã dùng — lần permadeath sau sẽ cần item "Rewound Time").`);
          return;
        }
        const owned = profileData.items?.["Rewound Time"] ?? 0;
        if (owned < 1) throw new Error(`${targetUser.username} đã dùng hết lần hồi sinh miễn phí và không có item "Rewound Time" trong inventory để hồi sinh tiếp.`);
        profileData.items["Rewound Time"] = owned - 1;
        if (profileData.items["Rewound Time"] <= 0) delete profileData.items["Rewound Time"];
        profileData.permanentlyDead = false;
        await savePlayerData(targetUser.id, profileData, slot);
        message.reply(`✨ Đã hồi sinh **${targetUser.username}** bằng 1× item **Rewound Time** (còn lại: ${profileData.items["Rewound Time"] ?? 0}).`);
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-setplayer")) {
    if (!ADMIN_IDS.has(message.author.id)) {
      message.reply("❌ Bạn không có quyền dùng lệnh này.");
      return;
    }
    const targetUsers = [...message.mentions.users.values()];
    if (targetUsers.length === 0) {
      message.reply(
        "❌ Hãy mention ít nhất một người cần set. Ví dụ:\n" +
        "`-setplayer @user1 @user2 exp: 100 ahn: 50000 books: Random Book x3, N Corp Book x1 items: Tên Item x2`"
      );
      return;
    }
    const rawInput = message.content.replace("-setplayer", "").replace(/<@!?\d+>/g, "").trim();
    const kv = parseKeyValues(rawInput);
    const booksRaw = kv["books"] ?? null;
    const bookEntries = [];
    if (booksRaw) {
      const parts = booksRaw.split(",").map(s => s.trim()).filter(Boolean);
      for (const part of parts) {
        const match = part.match(/^(.+?)\s+(\+?)x(\d+)$/i);
        if (!match) {
          message.reply(`❌ Định dạng sách sai: \`${part}\`\nĐúng: \`Tên Sách x<số>\` hoặc \`Tên Sách +x<số>\` (VD: \`Random Book x5\` hoặc \`Random Book +x3\`)`);
          return;
        }
        const bookName = findBook(match[1].trim());
        if (!bookName) {
          message.reply(`❌ Tên sách không hợp lệ: \`${match[1].trim()}\`\nDùng \`-books\` để xem danh sách.`);
          return;
        }
        bookEntries.push({ name: bookName, count: parseInt(match[3], 10), isAdd: match[2] === "+" });
      }
    }
    const itemsRaw = kv["items"] ?? null;
    const itemEntries = [];
    if (itemsRaw) {
      const parts = itemsRaw.split(",").map(s => s.trim()).filter(Boolean);
      for (const part of parts) {
        const match = part.match(/^(.+?)\s+(\+?)x(\d+)$/i);
        if (!match) {
          message.reply(`❌ Định dạng vật phẩm sai: \`${part}\`\nĐúng: \`Tên Item x<số>\` hoặc \`Tên Item +x<số>\` (VD: \`Tên Item x2\` hoặc \`Tên Item +x2\`)`);
          return;
        }
        const itemName = findItemAdmin(match[1].trim());
        if (!itemName) {
          message.reply(`❌ Tên vật phẩm không hợp lệ hoặc quá dài: \`${match[1].trim()}\``);
          return;
        }
        itemEntries.push({ name: itemName, count: parseInt(match[3], 10), isAdd: match[2] === "+" });
      }
    }
    // pages: — GM cấp THẲNG 1 hoặc nhiều Page vào category "pages" (giống books:/
    // items:) — theo yêu cầu trực tiếp "hoặc GM cấp thẳng" (không cần qua đọc
    // sách). Dùng findSkill để validate tên Page/skill hợp lệ (không giới hạn chỉ
    // Page có trong BOOK_GRANTS — GM có thể cấp BẤT KỲ Page/skill hợp lệ nào tồn
    // tại trong skills.js, kể cả loại chưa gắn với sách nào).
    const pagesRaw = kv["pages"] ?? null;
    const pageEntries = [];
    if (pagesRaw) {
      const parts = pagesRaw.split(",").map(s => s.trim()).filter(Boolean);
      for (const part of parts) {
        const match = part.match(/^(.+?)\s+(\+?)x(\d+)$/i);
        if (!match) {
          message.reply(`❌ Định dạng Page sai: \`${part}\`\nĐúng: \`Tên Page x<số>\` hoặc \`Tên Page +x<số>\` (VD: \`Pounce x1\` hoặc \`Pounce +x1\`)`);
          return;
        }
        const skill = findSkill(match[1].trim());
        if (!skill) {
          message.reply(`❌ Tên Page không hợp lệ: \`${match[1].trim()}\``);
          return;
        }
        pageEntries.push({ name: skill.name, count: parseInt(match[3], 10), isAdd: match[2] === "+" });
      }
    }
    const expAddRaw = kv["exp"] ?? null;
    const ahnAddRaw = kv["ahn"] ?? null;
    const lunacyAddRaw = kv["lunacy"] ?? null;
    const expIsAdd = expAddRaw && expAddRaw.startsWith("+");
    const ahnIsAdd = ahnAddRaw && ahnAddRaw.startsWith("+");
    const lunacyIsAdd = lunacyAddRaw && lunacyAddRaw.startsWith("+");
    const expValue = expAddRaw ? parseInt(expAddRaw.replace("+", ""), 10) || 0 : null;
    const ahnValue = ahnAddRaw ? parseInt(ahnAddRaw.replace("+", ""), 10) || 0 : null;
    const lunacyValue = lunacyAddRaw ? parseInt(lunacyAddRaw.replace("+", ""), 10) || 0 : null;
    const gradeTarget = kv["grade"] ? parseInt(kv["grade"], 10) : null;
    if (gradeTarget !== null && (isNaN(gradeTarget) || gradeTarget < GRADE_MAX || gradeTarget > GRADE_MIN)) {
      message.reply(`❌ Grade phải từ ${GRADE_MAX}–${GRADE_MIN}.`);
      return;
    }
    // bonusskillpoints: — "điều kiện đặc biệt" để lên 50 điểm Skill Tree (luật:
    // "Để đạt 50 sẽ cần điều kiện đặc biệt" — KHÔNG được luật định nghĩa rõ điều
    // kiện cụ thể là gì, nên GM tự quyết định khi nào player đạt được, rồi cấp tay
    // qua tham số này — set tuyệt đối hoặc +N để cộng thêm, giống exp:/ahn:).
    const bonusSkillRaw = kv["bonusskillpoints"] ?? null;
    const bonusSkillIsAdd = bonusSkillRaw && bonusSkillRaw.startsWith("+");
    const bonusSkillValue = bonusSkillRaw ? parseInt(bonusSkillRaw.replace("+", ""), 10) : null;
    if (bonusSkillRaw && (bonusSkillValue === null || isNaN(bonusSkillValue))) {
      message.reply("❌ `bonusskillpoints:` phải là số.");
      return;
    }
    // hp: — set TRỰC TIẾP currentHp đã persist trên profile (KHÁC hp: của
    // -encounter join, vốn chỉ set cho 1 TRẬN cụ thể) — dùng cho trường hợp cần
    // khôi phục/nhập dữ liệu HP chính xác (VD import từ hệ thống cũ). Set kèm
    // hpLastResetCheck = NGAY BÂY GIỜ để tránh bị auto-reset về full ngay lần
    // join kế tiếp (xem getEffectiveCurrentHp).
    const hpSetRaw = kv["hp"] ?? null;
    const hpSetValue = hpSetRaw ? parseFloat(hpSetRaw) : null;
    if (hpSetRaw && (hpSetValue === null || isNaN(hpSetValue) || hpSetValue < 0)) {
      message.reply("❌ `hp:` phải là số ≥0.");
      return;
    }
    // 4 cờ điều kiện đặc biệt — theo yêu cầu trực tiếp: lưu vào Upstash để TRACK
    // xem player đã đủ điều kiện mở khoá Shin/Light/50 điểm/Manifested E.G.O tuỳ
    // chỉnh hay chưa (KHÁC branchPoints.shin/light — 2 field NÀY là CỜ ĐIỀU KIỆN
    // ĐỦ TƯ CÁCH, còn branchPoints là ĐIỂM ĐÃ PHÂN BỔ — 1 người có thể ĐỦ ĐIỀU KIỆN
    // [Unlock=true] nhưng CHƯA phân bổ điểm nào [branchPoints=0], hoặc ngược lại
    // không thể phân bổ nếu Unlock=false, xem gating ở -allocatepoints).
    const UNLOCK_FLAG_KEYS = { shinunlock: "ShinUnlock", lightskilltreeunlock: "LightSkillTreeUnlock", "50statunlock": "50StatUnlock", manifestedegounlock: "ManifestedEGOUnlock" };
    const unlockFlagUpdates = {};
    for (const [paramKey, fieldName] of Object.entries(UNLOCK_FLAG_KEYS)) {
      const raw = (kv[paramKey] ?? "").trim().toLowerCase();
      if (!raw) continue;
      if (["yes", "true", "1", "có"].includes(raw)) unlockFlagUpdates[fieldName] = true;
      else if (["no", "false", "0", "không"].includes(raw)) unlockFlagUpdates[fieldName] = false;
      else { message.reply(`❌ \`${paramKey}:\` phải là yes/no (hoặc true/false, có/không).`); return; }
    }
    // Branch Points — PHÂN BỔ điểm Skill Tree vào 1 trong 9 nhánh (wrath/desire/
    // sloth/gluttony/gloom/pride/envy/shin/light) — KIẾN TRÚC ĐÃ SỬA (xác nhận trực
    // tiếp từ GM): mỗi nhánh có ngưỡng RIÊNG, KHÔNG dùng chung 1 pool toàn cục cho
    // mọi perk. Set TUYỆT ĐỐI (VD `sloth: 20`) hoặc CỘNG THÊM (VD `sloth: +10`),
    // giống exp:/ahn:. Validate TỔNG các nhánh KHÔNG vượt tổng pool
    // (calcSkillTreePointsEarned theo Grade) — nếu vượt, BÁO LỖI RÕ chứ không tự ý
    // cắt bớt (để GM tự quyết định phân bổ lại).
    const branchUpdates = {};
    let hasBranchUpdate = false;
    for (const bKey of BRANCH_KEYS) {
      const raw = kv[bKey] ?? null;
      if (raw === null) continue;
      const isAdd = raw.startsWith("+");
      const value = parseInt(raw.replace("+", ""), 10);
      if (isNaN(value) || value < 0) { message.reply(`❌ \`${bKey}:\` phải là số ≥0 (hoặc +N để cộng thêm).`); return; }
      branchUpdates[bKey] = { isAdd, value };
      hasBranchUpdate = true;
    }
    if (expValue === null && ahnValue === null && lunacyValue === null && gradeTarget === null && bookEntries.length === 0 && itemEntries.length === 0 && pageEntries.length === 0 && bonusSkillValue === null && !hasBranchUpdate && hpSetValue === null && Object.keys(unlockFlagUpdates).length === 0) {
      message.reply(`❌ Không có gì để set. Dùng: \`exp\`, \`grade\`, \`ahn\`, \`lunacy\`, \`hp\`, \`books\`, \`items\`, \`bonusskillpoints\`, 9 nhánh Skill Tree (${BRANCH_KEYS.join("/")}), hoặc 4 cờ điều kiện (\`shinunlock\`/\`lightskilltreeunlock\`/\`50statunlock\`/\`manifestedegounlock\`: yes/no).\n> Thêm \`+\` trước số để cộng thêm, VD: \`exp: +50\` hoặc \`sloth: +10\``);
      return;
    }

    const results = await Promise.allSettled(
      targetUsers.map(targetUser =>
        withLock(targetUser.id, async () => {
          const { data, slot } = await getPlayerDataWithSlot(targetUser.id);
          data.books = data.books ?? {};
          data.items = data.items ?? {};
          const changes = [];
          if (gradeTarget !== null) {
            const expNeeded = calcExpForGrade(gradeTarget);
            data.exp = expNeeded;
            changes.push(`Grade → **Grade ${gradeTarget}** (EXP = **${expNeeded}**)`);
          } else if (expValue !== null) {
            if (expIsAdd) {
              const before = data.exp ?? 0;
              const lunacyBefore = data.lunacy ?? 0;
              data.exp = clampExpWithLunacy(data, before + expValue);
              const lunacyGained = (data.lunacy ?? 0) - lunacyBefore;
              changes.push(`EXP +${expValue} (${before} → **${data.exp}**) [max: ${EXP_MAX}]${lunacyGained > 0 ? ` (dư chuyển thành +${lunacyGained} <:Lunacy:1524989409529823342>Lunacy)` : ""}`);
            } else {
              const lunacyBefore = data.lunacy ?? 0;
              data.exp = clampExpWithLunacy(data, expValue);
              const lunacyGained = (data.lunacy ?? 0) - lunacyBefore;
              changes.push(`EXP set → **${data.exp}** [max: ${EXP_MAX}]${lunacyGained > 0 ? ` (dư chuyển thành +${lunacyGained} <:Lunacy:1524989409529823342>Lunacy)` : ""}`);
            }
          }
          if (ahnValue !== null) {
            if (ahnIsAdd) {
              const before = data.ahn ?? 0;
              data.ahn = Math.max(0, before + ahnValue);
              changes.push(`Ahn +${formatNumber(ahnValue)} (${formatNumber(before)} → **${formatNumber(data.ahn)}**)`);
            } else {
              data.ahn = Math.max(0, ahnValue);
              changes.push(`Ahn set → **${formatNumber(data.ahn)}**`);
            }
          }
          if (lunacyValue !== null) {
            if (lunacyIsAdd) {
              const before = data.lunacy ?? 0;
              data.lunacy = Math.max(0, before + lunacyValue);
              changes.push(`<:Lunacy:1524989409529823342>Lunacy +${formatNumber(lunacyValue)} (${formatNumber(before)} → **${formatNumber(data.lunacy)}**)`);
            } else {
              data.lunacy = Math.max(0, lunacyValue);
              changes.push(`<:Lunacy:1524989409529823342>Lunacy set → **${formatNumber(data.lunacy)}**`);
            }
          }
          if (bookEntries.length > 0) {
            for (const { name, count, isAdd } of bookEntries) {
              data.books[name] = isAdd ? (data.books[name] ?? 0) + count : count;
            }
            changes.push(`Sách:\n` + bookEntries.map(e => `> • 📚 **${e.name}** ${e.isAdd ? `+${e.count}` : `× ${e.count} (set)`}`).join("\n"));
          }
          if (itemEntries.length > 0) {
            for (const { name, count, isAdd } of itemEntries) {
              data.items[name] = isAdd ? (data.items[name] ?? 0) + count : count;
            }
            changes.push(`Vật phẩm:\n` + itemEntries.map(e => `> • 🔩 **${e.name}** ${e.isAdd ? `+${e.count}` : `× ${e.count} (set)`}`).join("\n"));
          }
          if (pageEntries.length > 0) {
            data.pages = data.pages ?? {};
            for (const { name, count, isAdd } of pageEntries) {
              data.pages[name] = isAdd ? (data.pages[name] ?? 0) + count : count;
            }
            changes.push(`Page:\n` + pageEntries.map(e => `> • 📖 **${e.name}** ${e.isAdd ? `+${e.count}` : `× ${e.count} (set)`}`).join("\n"));
          }
          if (bonusSkillValue !== null) {
            if (bonusSkillIsAdd) {
              const before = data.bonusSkillPoints ?? 0;
              data.bonusSkillPoints = Math.max(0, before + bonusSkillValue);
              changes.push(`Bonus Skill Points +${bonusSkillValue} (${before} → **${data.bonusSkillPoints}**) [điều kiện đặc biệt lên 50 điểm]`);
            } else {
              data.bonusSkillPoints = Math.max(0, bonusSkillValue);
              changes.push(`Bonus Skill Points set → **${data.bonusSkillPoints}**`);
            }
          }
          if (hpSetValue !== null) {
            const before = data.currentHp;
            data.currentHp = hpSetValue;
            data.hpLastResetCheck = Date.now();
            changes.push(`HP set → **${hpSetValue}**${before !== undefined ? ` (trước: ${before})` : ""}`);
          }
          for (const [fieldName, value] of Object.entries(unlockFlagUpdates)) {
            data[fieldName] = value;
            changes.push(`${fieldName}: ${value ? "✅ TRUE" : "❌ FALSE"}`);
          }
          if (Object.keys(branchUpdates).length > 0) {
            data.branchPoints = data.branchPoints ?? {};
            // Tính TRƯỚC giá trị CUỐI CÙNG (chưa gán thật) để validate tổng trước.
            const proposedBranchPoints = { ...data.branchPoints };
            for (const [bKey, { isAdd, value }] of Object.entries(branchUpdates)) {
              const before = data.branchPoints[bKey] ?? 0;
              proposedBranchPoints[bKey] = isAdd ? before + value : value;
            }
            const proposedTotal = BRANCH_KEYS.reduce((sum, k) => sum + (proposedBranchPoints[k] ?? 0), 0);
            const pool = calcSkillTreePointsEarned(data);
            if (proposedTotal > pool) {
              changes.push(`❌ KHÔNG áp dụng phân bổ nhánh — tổng sẽ thành ${proposedTotal} điểm, vượt quá pool ${pool} điểm (theo Grade${data.bonusSkillPoints ? " + bonusSkillPoints" : ""}). Giữ nguyên phân bổ cũ.`);
            } else {
              for (const [bKey, { isAdd, value }] of Object.entries(branchUpdates)) {
                const before = data.branchPoints[bKey] ?? 0;
                data.branchPoints[bKey] = proposedBranchPoints[bKey];
                changes.push(`${bKey[0].toUpperCase() + bKey.slice(1)}: ${isAdd ? `+${value} (${before} → ` : "set → "}**${data.branchPoints[bKey]}**${isAdd ? ")" : ""} [tổng nhánh: ${proposedTotal}/${pool}]`);
              }
            }
          }
          await savePlayerData(targetUser.id, data, slot);
          return changes;
        })
      )
    );

    const lines = results.map((r, i) => {
      const user = targetUsers[i];
      if (r.status === "fulfilled") {
        const changes = r.value;
        return `✅ **${user.username}**:\n` + changes.map(c => `> ${c}`).join("\n");
      } else {
        log("error", "setplayer", user.id, r.reason?.message, { actor: message.author.id });
        return `❌ **${user.username}**: ${r.reason?.message ?? "Lỗi không xác định"}`;
      }
    });

    const body = `📋 Kết quả \`-setplayer\` cho ${targetUsers.length} người:\n\n` + lines.join("\n\n");
    if (body.length > 2000) {
      const chunks = [];
      let current = "";
      for (const line of lines) {
        if ((current + "\n\n" + line).length > 1900) {
          chunks.push(current);
          current = line;
        } else {
          current = current ? current + "\n\n" + line : line;
        }
      }
      if (current) chunks.push(current);
      await message.reply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await message.channel.send(chunks[i]);
      }
    } else {
      message.reply(body);
    }
    return;
  }

  // ── -unlockskilltree / -ununlockskilltree ──────────────────────────────────
  // Lưu trên PROFILE (vĩnh viễn, theo slot đang active), KHÔNG còn lưu tạm trong
  // encounter (mất khi encounter kết thúc) như bản unlockperk cũ — vì đây là Point
  // thật đã tốn trong game, phải tồn tại qua mọi trận đấu, giống Grade/EXP. Admin
  // only — giống -setplayer, vì đây là tài nguyên cần GM duyệt, không phải thứ
  // player tự cấp cho mình.
  // ── -allocatepoints — TỰ PHÂN BỔ điểm Skill Tree vào 1 nhánh (theo yêu cầu trực
  // tiếp: "để player tự phân bổ stats... không nhất thiết cần GM"). CHỈ CHO TĂNG
  // (KHÔNG cho giảm qua lệnh này) — tránh làm "mồ côi" perk ĐÃ unlock dựa trên điểm
  // nhánh cũ (VD đã unlock Fortified Resolve cần Sloth≥20, nếu tự ý giảm Sloth
  // xuống 10 thì perk đó về mặt logic không còn đủ điều kiện nữa nhưng vẫn active
  // — để tránh case này, GIẢM/ĐIỀU CHỈNH LẠI vẫn cần GM qua `-setplayer` (admin,
  // có thể set tuyệt đối kể cả giảm, dùng cho các trường hợp đặc biệt/sửa lỗi).
  if (message.content.startsWith("-allocatepoints")) {
    const rawInputFull = message.content.replace("-allocatepoints", "").trim();
    const { targetUserId, targetLabel, remainingInput } = resolveEquipTarget(message, rawInputFull);
    const kv = parseKeyValues(remainingInput);
    const branchEntries = BRANCH_KEYS.filter(k => kv[k] !== undefined).map(k => ({ key: k, raw: kv[k] }));
    if (branchEntries.length === 0) {
      message.reply(`⚠️ Cú pháp: \`-allocatepoints [@user] <nhánh>: <số điểm muốn CỘNG THÊM>\` (CHỈ cộng, không trừ được qua lệnh này; thêm @user nếu admin muốn phân bổ hộ)\n> Nhánh hợp lệ: ${BRANCH_KEYS.join("/")}\n> VD: \`-allocatepoints sloth: 10\``);
      return;
    }
    try {
      await withLock(targetUserId, async () => {
        const { data, slot } = await getPlayerDataWithSlot(targetUserId);
        data.branchPoints = data.branchPoints ?? {};
        const proposedBranchPoints = { ...data.branchPoints };
        const changes = [];
        for (const { key, raw } of branchEntries) {
          const addAmount = parseInt(raw.replace(/^\+/, ""), 10);
          if (!Number.isFinite(addAmount) || addAmount <= 0) throw new Error(`\`${key}:\` phải là số dương (chỉ cộng thêm, không trừ được qua lệnh này — dùng số ≥1).`);
          proposedBranchPoints[key] = (data.branchPoints[key] ?? 0) + addAmount;
        }
        const proposedTotal = BRANCH_KEYS.reduce((sum, k) => sum + (proposedBranchPoints[k] ?? 0), 0);
        const pool = calcSkillTreePointsEarned(data);
        if (proposedTotal > pool) {
          const currentAllocated = calcBranchPointsAllocated(data);
          throw new Error(`Không đủ điểm — tổng sẽ thành ${proposedTotal}, vượt quá pool ${pool} (hiện đã phân bổ ${currentAllocated}, còn dư ${pool - currentAllocated} điểm để cộng).`);
        }
        // Gate CỨNG cho Shin/Light — theo yêu cầu trực tiếp (đã có field ShinUnlock/
        // LightSkillTreeUnlock để verify điều kiện, KHÔNG CÒN "cảnh báo mềm" như
        // trước — trước đây không chặn được vì "không có luật số để verify điều
        // kiện", giờ ĐÃ CÓ). Admin phân bổ HỘ người khác (targetLabel !== null) BỎ
        // QUA check này — admin có toàn quyền, giống pattern equip gating.
        const isAdminAction = targetLabel !== null;
        if (!isAdminAction) {
          const shinAttempt = branchEntries.find(e => e.key === "shin");
          const lightAttempt = branchEntries.find(e => e.key === "light");
          if (shinAttempt && !data.ShinUnlock) {
            throw new Error(`Bạn CHƯA đủ điều kiện phân bổ điểm vào nhánh Shin (ShinUnlock chưa được GM xác nhận) — liên hệ GM.`);
          }
          if (lightAttempt && !data.LightSkillTreeUnlock) {
            throw new Error(`Bạn CHƯA đủ điều kiện phân bổ điểm vào nhánh Light (LightSkillTreeUnlock chưa được GM xác nhận) — liên hệ GM.`);
          }
        }
        for (const { key, raw } of branchEntries) {
          const before = data.branchPoints[key] ?? 0;
          data.branchPoints[key] = proposedBranchPoints[key];
          changes.push(`${key[0].toUpperCase() + key.slice(1)}: ${before} → **${data.branchPoints[key]}**`);
        }
        await savePlayerData(targetUserId, data, slot);
        message.reply(`✅ ${targetLabel ? `**${targetLabel}**` : message.author}: ${changes.join(", ")} [tổng đã phân bổ: ${proposedTotal}/${pool}]`);
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unlockskilltree") || message.content.startsWith("-ununlockskilltree")) {
    const isUnlock = message.content.startsWith("-unlockskilltree");
    const isAdminUnlock = ADMIN_IDS.has(message.author.id);
    // TỰ PHỤC VỤ (theo yêu cầu trực tiếp: "để player tự phân bổ stats... không nhất
    // thiết cần GM") — KHÔNG có @mention → áp dụng cho CHÍNH NGƯỜI GÕ. CÓ @mention
    // VÀ là admin → admin làm hộ người khác (giữ khả năng override/hỗ trợ cũ). CÓ
    // @mention nhưng KHÔNG PHẢI admin → bỏ qua mention (an toàn, giống
    // resolveEquipTarget — tránh non-admin thao túng người khác).
    const mentionedUsers = [...message.mentions.users.values()];
    const targetUsers = (isAdminUnlock && mentionedUsers.length > 0) ? mentionedUsers : [message.author];
    const rawInput = message.content.replace(/^-(un)?unlockskilltree/, "").replace(/<@!?\d+>/g, "").trim();
    const perkName = rawInput.replace(/^text:\s*/i, "").trim();
    if (!perkName) {
      message.reply(
        `❌ Cú pháp: \`-${isUnlock ? "" : "un"}unlockskilltree [@user] <tên perk>\`\n` +
        `> VD: \`-unlockskilltree Ein Sof\` (tự mở cho chính mình) — thêm @user nếu admin muốn mở hộ.`
      );
      return;
    }
    try {
      const results = [];
      for (const user of targetUsers) {
        const { data, slot } = await getPlayerDataWithSlot(user.id);
        data.unlockedSkillTree = data.unlockedSkillTree ?? [];
        if (isUnlock) {
          if (data.unlockedSkillTree.includes(perkName)) { results.push(`⚠️ ${user.username}: đã có "${perkName}" rồi.`); continue; }
          const conflict = findExclusiveConflict(data.unlockedSkillTree, perkName);
          if (conflict) { results.push(`❌ ${user.username}: "${perkName}" loại trừ với "${conflict}" đã có sẵn — không thể có cả 2 (dùng \`-ununlockskilltree\` xoá "${conflict}" trước nếu muốn đổi).`); continue; }
          // Ngưỡng mở khoá THEO NHÁNH — CHỈ chặn nếu perk này có cost RÕ trong
          // PERK_POINT_COSTS (perk chưa rõ cost/nhánh thì cho qua tự do, không chặn
          // nhầm unlock cũ). KIẾN TRÚC ĐÃ SỬA (xác nhận trực tiếp từ GM): trong 1
          // NHÁNH, có N điểm branchPoints[nhánh] = mở được TẤT CẢ perk nhánh đó có
          // tag ≤N — KHÔNG trừ dần theo từng perk, KHÔNG dùng chung 1 pool toàn
          // cục cho mọi nhánh (mỗi nhánh độc lập hoàn toàn).
          const cost = PERK_POINT_COSTS[perkName];
          const branch = PERK_BRANCH[perkName];
          if (cost !== undefined && branch !== undefined) {
            const branchHave = (data.branchPoints ?? {})[branch] ?? 0;
            if (branchHave < cost) {
              results.push(`❌ ${user.username}: "${perkName}" (nhánh ${branch}) cần ${cost} điểm nhánh — hiện chỉ có ${branchHave} điểm ${branch} (dùng \`-allocatepoints ${branch}: <số>\` để phân bổ thêm).`);
              continue;
            }
          }
          data.unlockedSkillTree.push(perkName);
          await savePlayerData(user.id, data, slot);
          results.push(`✅ ${user.username}: mở khóa "${perkName}"${cost !== undefined ? ` (nhánh ${branch}, cần ${cost}/${(data.branchPoints ?? {})[branch] ?? 0} điểm ${branch})` : ""}.`);
        } else {
          const idx = data.unlockedSkillTree.indexOf(perkName);
          if (idx === -1) { results.push(`⚠️ ${user.username}: chưa có "${perkName}".`); continue; }
          data.unlockedSkillTree.splice(idx, 1);
          await savePlayerData(user.id, data, slot);
          results.push(`✅ ${user.username}: đã xoá "${perkName}".`);
        }
      }
      // Bọc embed (4096 ký tự) thay vì reply string thẳng (giới hạn 2000) — phòng
      // trường hợp admin mention NHIỀU user cùng lúc khiến kết quả gộp vượt giới
      // hạn text thường (bài học từ bug helpBody y hệt).
      const resultText = results.join("\n");
      if (resultText.length > 1900) {
        message.reply({ embeds: [{ description: resultText.slice(0, 4000), color: 0x5865f2 }] });
      } else {
        message.reply(resultText);
      }
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── equippage/unequippage/equipegopage/unequipegopage ──────────────────────
  // Tự phục vụ (player tự quản lý loadout của mình, KHÔNG admin-gated — khác
  // unlockskilltree vì đây là lựa chọn cá nhân, không phải tài nguyên GM cấp). 5
  // slot Page thường + 5 slot E.G.O Page RIÊNG (đúng luật "E.G.O Page không tính
  // slot chung với 5 Page thường"). Lưu trên PROFILE (vĩnh viễn, theo slot profile
  // đang active) — -encounter join sẽ tự lấy danh sách này để hiện trong dropdown
  // hành động (xem phần dropdown động).
  if (message.content.startsWith("-equippage") || message.content.startsWith("-equipegopage")) {
    const isEgo = message.content.startsWith("-equipegopage");
    const rawInputFull = message.content.replace(isEgo ? "-equipegopage" : "-equippage", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    const m = rawInput.match(/^([1-5])\s+(.+)$/);
    if (!m) {
      message.reply(`⚠️ Cú pháp: \`-${isEgo ? "equipegopage" : "equippage"} [@user] <slot 1-5> <tên skill>\`\n> VD: \`-${isEgo ? "equipegopage" : "equippage"} 1 sky kick\` (thêm @user nếu admin muốn equip hộ)` +
        (isEgo ? `\n> 5 slot E.G.O là 5 **Tier riêng** (không hoán đổi được): ${EGO_TIER_SLOT_ORDER.map((t, i) => `slot ${i + 1}=${t}`).join(", ")}.` : ""));
      return;
    }
    const slotNum = parseInt(m[1], 10);
    const skillNameRaw = m[2].trim();
    try {
      const skill = findSkill(skillNameRaw);
      if (!skill) throw new Error(`Không tìm thấy skill "${skillNameRaw}".`);
      const skillIsEgo = isEgoSkill(skill);
      if (isEgo && !skillIsEgo) throw new Error(`"${skill.name}" không phải E.G.O Page — dùng \`-equippage\` thay vào đó.`);
      if (!isEgo && skillIsEgo) throw new Error(`"${skill.name}" là E.G.O Page — dùng \`-equipegopage\` thay vào đó (5 slot riêng).`);
      // 5 E.G.O Slot là 5 Tier RIÊNG (ZAYIN/TETH/HE/WAW/ALEPH), KHÔNG phải 5 slot
      // chung — slot N CHỈ nhận đúng tier tương ứng, mỗi tier chỉ 1 page tại 1 thời
      // điểm (xác nhận trực tiếp từ GM).
      if (isEgo) {
        const expectedTier = EGO_TIER_SLOT_ORDER[slotNum - 1];
        const skillTier = getEgoTier(skill);
        if (!skillTier) {
          throw new Error(`Không xác định được Tier của "${skill.name}" (thiếu tag ZAYIN/TETH/HE/WAW/ALEPH) — không thể equip vào slot Tier.`);
        }
        if (skillTier !== expectedTier) {
          throw new Error(`"${skill.name}" là Tier **${skillTier}** — phải equip vào slot **${EGO_TIER_SLOT_ORDER.indexOf(skillTier) + 1}** (Tier ${skillTier}), không phải slot ${slotNum} (Tier ${expectedTier}).`);
        }
      }
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      // Ownership gate — Page giờ có category RIÊNG "pages" (giống books/items,
      // trước đây Page hoàn toàn tự do không cần sở hữu — theo yêu cầu trực tiếp:
      // "equip weapon/outfit/page đều phải SỞ HỮU trước").
      const isAdminAction = targetLabel !== null;
      if (!isAdminAction && (data.pages?.[skill.name] ?? 0) < 1) {
        throw new Error(`Bạn chưa sở hữu Page **${skill.name}** — cần đọc sách tương ứng để nhận (xem \`-readbook\`), hoặc nhờ GM cấp.`);
      }
      const listKey = isEgo ? "equippedEgoPages" : "equippedPages";
      data[listKey] = data[listKey] ?? [null, null, null, null, null];
      data[listKey][slotNum - 1] = skill.name;
      await savePlayerData(targetUserId, data, slot);
      message.reply(`✅ Đã equip **${skill.name}** vào ${isEgo ? "E.G.O " : ""}slot #${slotNum}${targetLabel ? ` cho **${targetLabel}**` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequippage") || message.content.startsWith("-unequipegopage")) {
    const isEgo = message.content.startsWith("-unequipegopage");
    const rawInputFull = message.content.replace(isEgo ? "-unequipegopage" : "-unequippage", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    const slotNum = parseInt(rawInput, 10);
    if (!Number.isFinite(slotNum) || slotNum < 1 || slotNum > 5) {
      message.reply(`⚠️ Cú pháp: \`-${isEgo ? "unequipegopage" : "unequippage"} [@user] <slot 1-5>\``);
      return;
    }
    try {
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      const listKey = isEgo ? "equippedEgoPages" : "equippedPages";
      data[listKey] = data[listKey] ?? [null, null, null, null, null];
      const removed = data[listKey][slotNum - 1];
      data[listKey][slotNum - 1] = null;
      await savePlayerData(targetUserId, data, slot);
      message.reply(removed ? `✅ Đã gỡ **${removed}** khỏi ${isEgo ? "E.G.O " : ""}slot #${slotNum}${targetLabel ? ` của **${targetLabel}**` : ""}.` : `⚠️ ${isEgo ? "E.G.O " : ""}Slot #${slotNum} đang trống${targetLabel ? ` (${targetLabel})` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── -pages: xem loadout hiện tại (5 Page + 5 E.G.O Page) ───────────────────
  if (message.content.startsWith("-pages")) {
    try {
      const targetUser = message.mentions.users.first() ?? message.author;
      const { data } = await getPlayerDataWithSlot(targetUser.id);
      const pages = data.equippedPages ?? [null, null, null, null, null];
      const egoPages = data.equippedEgoPages ?? [null, null, null, null, null];
      const fmt = (list) => list.map((p, i) => `**#${i + 1}** ${p ?? "*(trống)*"}`).join("\n");
      message.reply({
        embeds: [{
          title: `📖 Loadout Page — ${targetUser.username}`,
          description: `**5 Page thường:**\n${fmt(pages)}\n\n**5 E.G.O Page:**\n${fmt(egoPages)}`,
          color: 0x5865f2,
          footer: { text: "-equippage <slot> <skill> · -equipegopage <slot> <skill> · -unequippage/-unequipegopage <slot>" },
        }],
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── equipweapon/unequipweapon — lưu TÊN vũ khí (tra lại qua findWeapon() mỗi lần
  // cần dùng, KHÔNG lưu cả object — tránh dữ liệu cũ kẹt lại nếu weapon.js sau này
  // sửa số liệu). Tự phục vụ, không admin-gated (chọn trang bị là lựa chọn cá nhân).
  if (message.content.startsWith("-equipweapon")) {
    const rawInputFull = message.content.replace("-equipweapon", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    if (!rawInput) { message.reply("⚠️ Cú pháp: `-equipweapon [@user] <tên vũ khí>` (VD: `-equipweapon durandal`; thêm @user nếu admin muốn equip hộ)"); return; }
    try {
      const weapon = findWeaponAnywhere(rawInput);
      if (!weapon) throw new Error(`Không tìm thấy vũ khí "${rawInput}" trong weapon.js hoặc skills.js.`);
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      // Ownership gate — theo yêu cầu trực tiếp: "equip weapon/outfit/page đều
      // phải SỞ HỮU trước (qua chọn từ sách, hoặc GM cấp thẳng)". Admin equip HỘ
      // người khác (targetLabel !== null) BỎ QUA check này — admin có toàn quyền
      // cấp phát trực tiếp không cần qua sách (đúng "hoặc GM cấp thẳng").
      const isAdminAction = targetLabel !== null;
      const isUniversallyKnown = UNIVERSALLY_KNOWN_WEAPONS.has(weapon.name.toLowerCase());
      if (!isAdminAction && !isUniversallyKnown && (data.items?.[weapon.name] ?? 0) < 1) {
        throw new Error(`Bạn chưa sở hữu **${weapon.name}** — cần đọc sách tương ứng để nhận (xem \`-readbook\`), hoặc nhờ GM cấp.`);
      }
      data.equippedWeapon = weapon.name;
      await savePlayerData(targetUserId, data, slot);
      message.reply(`✅ Đã equip vũ khí **${weapon.name}** (${weapon.weight}/${weapon.type}, Base Dmg ${weapon.baseDamage})${targetLabel ? ` cho **${targetLabel}**` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequipweapon")) {
    const { targetUserId, targetLabel } = resolveEquipTarget(message, message.content.replace("-unequipweapon", "").trim());
    try {
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      const removed = data.equippedWeapon;
      data.equippedWeapon = null;
      await savePlayerData(targetUserId, data, slot);
      message.reply(removed ? `✅ Đã gỡ vũ khí **${removed}**${targetLabel ? ` của **${targetLabel}**` : ""}.` : `⚠️ ${targetLabel ? `**${targetLabel}** chưa` : "Chưa"} equip vũ khí nào.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-equipoutfit")) {
    const rawInputFull = message.content.replace("-equipoutfit", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    if (!rawInput) { message.reply("⚠️ Cú pháp: `-equipoutfit [@user] <tên outfit>` (VD: `-equipoutfit black suit`; thêm @user nếu admin muốn equip hộ)"); return; }
    try {
      const outfit = findOutfit(rawInput);
      if (!outfit) throw new Error(`Không tìm thấy outfit "${rawInput}" trong outfit.js.`);
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      const isAdminAction = targetLabel !== null;
      if (!isAdminAction && (data.items?.[outfit.name] ?? 0) < 1) {
        throw new Error(`Bạn chưa sở hữu **${outfit.name}** — cần đọc sách tương ứng để nhận (xem \`-readbook\`), hoặc nhờ GM cấp.`);
      }
      data.equippedOutfit = outfit.name;
      await savePlayerData(targetUserId, data, slot);
      const r = outfit.resistance;
      message.reply(`✅ Đã equip outfit **${outfit.name}** (Res: ${r.B}xB ${r.P}xP ${r.S}xS${outfit.speedRange ? `, Speed ${outfit.speedRange.min}~${outfit.speedRange.max}` : ""})${targetLabel ? ` cho **${targetLabel}**` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequipoutfit")) {
    const { targetUserId, targetLabel } = resolveEquipTarget(message, message.content.replace("-unequipoutfit", "").trim());
    try {
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      const removed = data.equippedOutfit;
      data.equippedOutfit = null;
      await savePlayerData(targetUserId, data, slot);
      message.reply(removed ? `✅ Đã gỡ outfit **${removed}**${targetLabel ? ` của **${targetLabel}**` : ""}.` : `⚠️ ${targetLabel ? `**${targetLabel}** chưa` : "Chưa"} equip outfit nào.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-equipaccessory")) {
    const rawInputFull = message.content.replace("-equipaccessory", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    const m = rawInput.match(/^([1-3])\s+(.+)$/);
    if (!m) { message.reply("⚠️ Cú pháp: `-equipaccessory [@user] <slot 1-3> <tên accessory>` (VD: `-equipaccessory 1 perfect cube`; thêm @user nếu admin muốn equip hộ)"); return; }
    const slotNum = parseInt(m[1], 10);
    try {
      const accessory = findAccessory(m[2].trim());
      if (!accessory) throw new Error(`Không tìm thấy accessory "${m[2].trim()}" trong accessory.js.`);
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      // Ownership gate — ÁP DỤNG NHẤT QUÁN với weapon/outfit/page (accessory vốn
      // ĐÃ nằm trong items từ trước, cùng pattern) — GM chỉ nhắc rõ weapon/outfit/
      // page trong yêu cầu gốc, đây là suy luận nhất quán, ĐIỀU CHỈNH nếu không
      // đúng ý.
      const isAdminAction = targetLabel !== null;
      const ownedCount = data.items?.[accessory.name] ?? 0;
      if (!isAdminAction && ownedCount < 1) {
        throw new Error(`Bạn chưa sở hữu **${accessory.name}** — nhờ GM cấp (hiện chưa có cơ chế sách nào dạy accessory).`);
      }
      data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
      // BUG ĐÃ SỬA (xác nhận trực tiếp: "1 player chỉ có 1 item accessory duy nhất
      // nhưng lại equip được cả ở 3 slot accessory") — trước đây CHỈ check "sở hữu
      // ≥1", KHÔNG check đã dùng accessory NÀY ở CÁC SLOT KHÁC bao nhiêu lần rồi —
      // với 3 slot nhưng chỉ 1 lần kiểm tra "sở hữu tối thiểu", 1 cái duy nhất có
      // thể nhét vào cả 3 slot cùng lúc. Đếm số slot KHÁC (không tính slot đang ghi
      // đè) đã dùng CÙNG accessory này, cộng 1 (cho slot sắp ghi) rồi so với số sở
      // hữu — admin bypass giống các gate khác.
      if (!isAdminAction) {
        const usedInOtherSlots = data.equippedAccessories.filter((name, idx) => idx !== slotNum - 1 && name === accessory.name).length;
        if (usedInOtherSlots + 1 > ownedCount) {
          throw new Error(`Bạn chỉ sở hữu **${ownedCount}** **${accessory.name}** nhưng đã dùng **${usedInOtherSlots}** ở slot khác rồi — không đủ để equip thêm slot này.`);
        }
      }
      data.equippedAccessories[slotNum - 1] = accessory.name;
      await savePlayerData(targetUserId, data, slot);
      message.reply(`✅ Đã equip accessory **${accessory.name}** vào slot #${slotNum}${targetLabel ? ` cho **${targetLabel}**` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-unequipaccessory")) {
    const rawInputFull = message.content.replace("-unequipaccessory", "").trim();
    const { targetUserId, targetLabel, remainingInput: rawInput } = resolveEquipTarget(message, rawInputFull);
    const slotNum = parseInt(rawInput, 10);
    if (!Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) { message.reply("⚠️ Cú pháp: `-unequipaccessory [@user] <slot 1-3>`"); return; }
    try {
      const { data, slot } = await getPlayerDataWithSlot(targetUserId);
      data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
      const removed = data.equippedAccessories[slotNum - 1];
      data.equippedAccessories[slotNum - 1] = null;
      await savePlayerData(targetUserId, data, slot);
      message.reply(removed ? `✅ Đã gỡ accessory **${removed}** khỏi slot #${slotNum}${targetLabel ? ` của **${targetLabel}**` : ""}.` : `⚠️ Slot #${slotNum} đang trống${targetLabel ? ` (${targetLabel})` : ""}.`);
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── -equipment: xem Weapon/Outfit/3 Accessory hiện tại ─────────────────────
  if (message.content.startsWith("-equipment")) {
    try {
      const targetUser = message.mentions.users.first() ?? message.author;
      const { data } = await getPlayerDataWithSlot(targetUser.id);
      const weapon = data.equippedWeapon ? findWeaponAnywhere(data.equippedWeapon) : null;
      const outfit = data.equippedOutfit ? findOutfit(data.equippedOutfit) : null;
      const accessories = (data.equippedAccessories ?? [null, null, null]).map(n => n ? findAccessory(n) : null);
      const lines = [];
      lines.push(`**⚔️ Vũ khí:** ${weapon ? `${weapon.name} (${weapon.weight}/${weapon.type}, Base Dmg ${weapon.baseDamage})` : "*(trống)*"}`);
      if (weapon?.passives?.length) lines.push(...weapon.passives.map(p => `> *${p.name}*: ${p.desc}`));
      lines.push("");
      lines.push(`**🧥 Outfit:** ${outfit ? `${outfit.name} (Res: ${outfit.resistance.B}xB ${outfit.resistance.P}xP ${outfit.resistance.S}xS)` : "*(trống)*"}`);
      if (outfit?.keypage?.length) lines.push(...outfit.keypage.map(k => `> ${k}`));
      lines.push("");
      lines.push("**💍 Accessory:**");
      accessories.forEach((a, i) => {
        lines.push(`**#${i + 1}** ${a ? a.name : "*(trống)*"}`);
        if (a?.passives?.length) lines.push(...a.passives.map(p => `> *${p.name}*: ${p.desc}`));
      });
      message.reply({
        embeds: [{
          title: `🎒 Trang bị hiện tại — ${targetUser.username}`,
          description: lines.join("\n"),
          color: 0x5865f2,
          footer: { text: "-equipweapon/-equipoutfit/-equipaccessory <slot> <tên> · -unequip... để gỡ" },
        }],
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  // ── -use ──
  if (message.content.startsWith("-use")) {
    if (isOnCooldown(message.author.id, "use", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const userId = message.author.id;
    const rawInput = message.content.replace("-use", "").trim();
    if (!rawInput) {
      message.reply(
        "❌ Cú pháp: `-use <tên vật phẩm> [count: <số>]`\n" +
        "> VD: `-use Chipboard MK2` — craft 1 cái\n" +
        "> VD: `-use Chipboard MK3 count: 5` — craft 5 cái\n" +
        "> Dùng `-recipes` để xem công thức craft."
      );
      return;
    }
    const countMatch = rawInput.match(/\s+count:\s*(\d+)$/i);
    const craftCount = countMatch ? Math.max(1, parseInt(countMatch[1], 10) || 1) : 1;
    const itemInput = countMatch ? rawInput.slice(0, countMatch.index).trim() : rawInput;
    const itemName = findItem(itemInput);
    if (!itemName) {
      message.reply(
        `❌ Vật phẩm không hợp lệ: \`${itemInput}\`\n` +
        `Dùng \`-items\` để xem danh sách, \`-recipes\` để xem công thức craft.`
      );
      return;
    }
    const recipe = CRAFT_RECIPES[itemName];
    if (!recipe) {
      message.reply(`❌ **${itemName}** không có công thức craft.\nDùng \`-recipes\` để xem các vật phẩm có thể craft.`);
      return;
    }
    try {
      // Tách Discord API call ra ngoài withLock: nếu message.reply chậm (network lag,
      // rate limit), lock TTL có thể hết hạn trong khi vẫn đang giữ lock, cho phép
      // concurrent operation trên cùng userId. executeCraft chỉ cần Redis — giữ trong lock.
      const { outputLines, costLines } = await withLock(userId, () =>
        executeCraft(userId, itemName, craftCount)
      );
      message.reply(
        `⚒️ ${message.author} đã craft thành công!\n` +
        `> 🎁 Nhận được: ${outputLines.join(", ")}\n` +
        `> 📦 Nguyên liệu đã dùng:\n` +
        costLines.map(l => `> ${l}`).join("\n")
      );
    } catch (err) {
      log("error", "use", userId, err.message);
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}`);
    }
    return;
  }

  // ── -recipes ──
  if (message.content.startsWith("-recipes")) {
    const recipeLines = Object.entries(CRAFT_RECIPES).map(([output, recipe]) => {
      const inputStr = Object.entries(recipe.inputs).map(([mat, qty]) => `${qty}× ${mat}`).join(" + ");
      const outputQty = recipe.output[output];
      return `\`${inputStr}\` → **${outputQty}× ${output}**`;
    });
    message.reply({
      embeds: [{
        title: "⚒️ Công thức Craft",
        color: 0xe74c3c,
        description: recipeLines.join("\n"),
        footer: { text: "Dùng -use <tên vật phẩm> [count: <số>] để craft" },
      }],
    });
    return;
  }

  // ── -books ──
  if (message.content.startsWith("-books")) {
    const cols = 2;
    const half = Math.ceil(VALID_BOOKS.length / cols);
    const col1 = VALID_BOOKS.slice(0, half).map((b, i) => `\`${i + 1}.\` ${b}`);
    const col2 = VALID_BOOKS.slice(half).map((b, i) => `\`${half + i + 1}.\` ${b}`);
    message.reply({
      embeds: [{
        title: "📚 Danh sách sách hợp lệ",
        color: 0x2ecc71,
        fields: [
          { name: "​", value: col1.join("\n"), inline: true },
          { name: "​", value: col2.join("\n"), inline: true },
        ],
        footer: { text: `Tổng cộng ${VALID_BOOKS.length} loại sách` },
      }],
    });
    return;
  }

  // ── -items ──
  if (message.content.startsWith("-items")) {
    const lines = VALID_ITEMS.map((item, i) => `\`${i + 1}.\` ${item}`);
    message.reply({
      embeds: [{
        title: "🔩 Danh sách vật phẩm hợp lệ",
        color: 0xe67e22,
        description: lines.join("\n"),
        footer: { text: `Tổng cộng ${VALID_ITEMS.length} loại vật phẩm` },
      }],
    });
    return;
  }

  // ── -dothihelp ──
  if (message.content.startsWith("-dothihelp")) {
    const isAdmin = ADMIN_IDS.has(message.author.id);
    // BUG ĐÃ SỬA (theo yêu cầu trực tiếp): trước đây gửi CÔNG KHAI trong channel —
    // giờ gửi qua DM (giống cách -rtparry đã làm) để không làm loãng channel chung,
    // kèm 1 xác nhận NGẮN trong channel để người dùng biết đã gửi (hoặc lỗi nếu DM
    // đóng). `/dothihelp` (slash command) thay vào đó dùng ephemeral — xem phần
    // slash command handler riêng.
    try {
      await message.author.send({ embeds: [buildDothihelpEmbed(isAdmin)] });
      message.reply("📬 Đã gửi danh sách lệnh qua DM cho bạn!");
    } catch {
      message.reply("⚠️ Không gửi được DM — kiểm tra lại cài đặt quyền riêng tư (Privacy Settings → Allow DMs from server members) rồi thử lại.");
    }
    return;
  }

  // ── -chipboardcache ──
  if (message.content.startsWith("-chipboardcache")) {
    if (isOnCooldown(message.author.id, "chipboardcache", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const userId = message.author.id;
    const args = message.content.replace("-chipboardcache", "").trim().split(/\s+/);
    const { count, error } = parseOpenCount(args[0], OPEN_COUNT_MAX);
    if (error) { message.reply(error); return; }
    try {
      const { success, data, results, partial } = await handleOpenChipboardCache(userId, count);
      if (!success) { message.reply("❌ Bạn không có **Chipboard Cache** nào trong kho hoặc không đủ số lượng."); return; }
      const desc = buildRollDescription({ user: message.author, cacheType: "Chipboard Cache", results, remainingCount: data.items["Chipboard Cache"] ?? 0 });
      message.reply({ embeds: [{ title: `🔩 Mở Chipboard Cache${results.length > 1 ? ` × ${results.length}` : ""}`, color: 0xe67e22, description: desc, footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Chipboard Cache nên chỉ mở được ${results.length} lần.` } : undefined }] });
    } catch (err) {
      log("error", "chipboardcache", userId, err.message);
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}`);
    }
    return;
  }

  // ── -randomsealedbook ── (phải đứng TRƯỚC -randombook)
  if (message.content.startsWith("-randomsealedbook")) {
    if (isOnCooldown(message.author.id, "randomsealedbook", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const userId = message.author.id;
    const args = message.content.replace("-randomsealedbook", "").trim().split(/\s+/);
    const { count, error } = parseOpenCount(args[0], OPEN_COUNT_MAX);
    if (error) { message.reply(error); return; }
    try {
      const { success, data, results, partial } = await handleOpenSealedBook(userId, count);
      if (!success) { message.reply("❌ Bạn không có **Sealed Book Cache** nào trong kho hoặc không đủ số lượng."); return; }
      const desc = buildRollDescription({ user: message.author, cacheType: "Sealed Book Cache", results, remainingCount: data.books["Sealed Book Cache"] ?? 0 });
      message.reply({ embeds: [{ title: `🔮 Mở Sealed Book Cache${results.length > 1 ? ` × ${results.length}` : ""}`, color: 0x9b59b6, description: desc, footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Sealed Book Cache nên chỉ mở được ${results.length} lần.` } : undefined }] });
    } catch (err) {
      log("error", "randomsealedbook", userId, err.message);
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}`);
    }
    return;
  }

  // ── -randombook ──
  if (message.content.startsWith("-randombook")) {
    if (isOnCooldown(message.author.id, "randombook", 3000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 3 giây nhé.");
      return;
    }
    const userId = message.author.id;
    const args = message.content.replace("-randombook", "").trim().split(/\s+/);
    const { count, error } = parseOpenCount(args[0], OPEN_COUNT_MAX);
    if (error) { message.reply(error); return; }
    try {
      const { success, data, results, partial } = await handleOpenRandomBook(userId, count);
      if (!success) { message.reply("❌ Bạn không có **Random Book** nào trong kho hoặc không đủ số lượng."); return; }
      const desc = buildRollDescription({ user: message.author, cacheType: "Random Book", results, remainingCount: data.books["Random Book"] ?? 0 });
      message.reply({ embeds: [{ title: `📖 Mở Random Book${results.length > 1 ? ` × ${results.length}` : ""}`, color: 0x2ecc71, description: desc, footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Random Book nên chỉ mở được ${results.length} lần.` } : undefined }] });
    } catch (err) {
      log("error", "randombook", userId, err.message);
      message.reply(`❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}`);
    }
    return;
  }

  // ── -profile ──
  // ─── REDEEM CODE ────────────────────────────────────────────────────────────
  // Danh sách code hợp lệ — dễ mở rộng thêm sau này (chỉ cần thêm entry mới).
  // GLORYTOPROJECTMOON (xác nhận trực tiếp): "cho 1k3 Lunacy lần đầu" — 1300.
  // APOLOGIZE (xác nhận trực tiếp): "book từ gacha bị vô cate vật phẩm thành ra
  // không dùng được, code này là để xin lỗi vì việc đó" — 10 Random Book + 5
  // Sealed Book Cache.
  // DATTEBAYO (xác nhận trực tiếp): 1300 Lunacy — NHƯNG giới hạn theo USER (toàn
  // bộ tài khoản Discord), KHÔNG PHẢI theo từng profile riêng như các code khác
  // — "1 người có 5 profile thì chỉ 1 trong 5 profile được xài thôi". perUser:
  // true đánh dấu điều này — check ở 1 Redis key RIÊNG (redeemUser:{userId}:...,
  // không phụ thuộc slot), tách biệt hoàn toàn khỏi profileData.redeemedCodes
  // (vốn lưu theo TỪNG slot/profile).
  const REDEEM_CODES = {
    GLORYTOPROJECTMOON: { lunacy: 1300 },
    APOLOGIZE: { books: { "Random Book": 10, "Sealed Book Cache": 5 } },
    DATTEBAYO: { lunacy: 1300, perUser: true },
  };
  // ─── GACHA ──────────────────────────────────────────────────────────────────
if (message.content.startsWith("-gacha")) {
    if (isOnCooldown(message.author.id, "gacha", 3000)) {
      message.reply("⏳ Chờ 3 giây trước khi dùng lệnh này tiếp nhé.");
      return;
    }
    const rawAfterCmd = message.content.replace(/^-gacha/i, "").trim();
    const kvGacha = parseKeyValues(rawAfterCmd);
    // Không nhập gì → hiện dropdown CHỌN BANNER trước (Standard/Naruto's), rồi
    // mới vào bảng UI (embed rate/danh sách + nút Pull x1/x10 + Đổi Pity) — xác
    // nhận trực tiếp: "Thêm pool banner giới hạn thời gian và pool banner thường".
    if (!rawAfterCmd) {
      const bannerOptions = Object.entries(GACHA_BANNERS)
        .filter(([key]) => isBannerActive(key))
        .map(([key, b]) => new StringSelectMenuOptionBuilder().setLabel(b.name).setValue(key)
          .setDescription(b.expiresAt ? `Giới hạn thời gian — kết thúc ${new Date(b.expiresAt).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}` : "Banner thường"));
      message.reply({
        embeds: [{ title: "🎰 Chọn Banner", description: "Chọn banner muốn quay:", color: 0x9b59b6 }],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId(`gachabanner:${message.author.id}`).setPlaceholder("Chọn banner...").addOptions(...bannerOptions),
        )],
      });
      return;
    }
    // Có nhập số (VD `-gacha 5` hoặc `-gacha 5 banner: naruto`) → pull trực tiếp
    // qua text, cho power user không cần bấm nút — banner mặc định "standard"
    // nếu không ghi rõ.
    const countRaw = Object.keys(kvGacha).length > 0
      ? rawAfterCmd.split(/\s+banner:/i)[0].trim()
      : rawAfterCmd;
    const bannerKeyRaw = (kvGacha["banner"] ?? "standard").toLowerCase().trim();
    const bannerKey = Object.keys(GACHA_BANNERS).find(k => k === bannerKeyRaw || GACHA_BANNERS[k].name.toLowerCase() === bannerKeyRaw);
    if (!bannerKey) {
      message.reply(`❌ Banner "${bannerKeyRaw}" không hợp lệ — dùng \`standard\` hoặc \`naruto\`.`);
      return;
    }
    const count = parseInt(countRaw, 10);
    if (!Number.isFinite(count) || count < 1 || count > 10) {
      message.reply(`⚠️ Cú pháp: \`-gacha [số lần, 1-10] banner: [standard/naruto]\` (bỏ trống để mở bảng UI chọn banner).\n> Chi phí: **${GACHA_COST_PER_PULL} <:Lunacy:1524989409529823342>Lunacy/lần**.\n> Rate: ${GACHA_RATES.high}% thường / ${GACHA_RATES.mid}% trung bình / ${GACHA_RATES.rare}% cực hiếm.`);
      return;
    }
    try {
      const { totalCost, resultLines, rareHits, remainingLunacy, pity } = await performGachaPull(message.author.id, count, bannerKey);
      message.reply(
        `🎰 **${GACHA_BANNERS[bannerKey].name} x${count}** (-${formatNumber(totalCost)} <:Lunacy:1524989409529823342>Lunacy, còn **${formatNumber(remainingLunacy)}**):\n` +
        resultLines.map(l => `> ${l}`).join("\n") +
        (rareHits.length > 0 ? `\n\n🎉 **CỰC HIẾM!** Trúng: ${rareHits.join(", ")} — liên hệ GM để thiết kế cụ thể.` : "") +
        `\n🎯 Pity: **${pity}/${GACHA_PITY_MAX}**`
      );
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-redeem")) {
    if (isOnCooldown(message.author.id, "redeem", 3000)) {
      message.reply("⏳ Chờ 3 giây trước khi dùng lệnh này tiếp nhé.");
      return;
    }
    const codeRaw = message.content.replace(/^-redeem/i, "").trim().toUpperCase();
    if (!codeRaw) {
      message.reply("⚠️ Cú pháp: `-redeem <code>` (VD: `-redeem GLORYTOPROJECTMOON`).");
      return;
    }
    const codeReward = REDEEM_CODES[codeRaw];
    if (!codeReward) {
      message.reply(`❌ Code "${codeRaw}" không hợp lệ hoặc đã hết hạn.`);
      return;
    }
    try {
      await withLock(message.author.id, async () => {
        // perUser — GAP ĐÃ SỬA (xác nhận trực tiếp): "code này chỉ duy nhất 1
        // profile của 1 user sử dụng được... 1 người có 5 profile thì chỉ 1
        // trong 5 profile được xài thôi" — check RIÊNG 1 Redis key theo userId
        // THUẦN (không kèm slot), tách biệt hoàn toàn khỏi profileData.redeemedCodes
        // (vốn lưu THEO TỪNG profile/slot — không đủ để chặn liên-profile).
        if (codeReward.perUser) {
          const userLockKey = `redeemUser:${message.author.id}:${codeRaw}`;
          const alreadyUsed = await redis.get(userLockKey);
          if (alreadyUsed) {
            throw new Error(`Code "${codeRaw}" đã được dùng bởi 1 trong các profile của bạn rồi — code này chỉ dùng được **1 lần trên toàn tài khoản**, không phải riêng từng profile.`);
          }
        }
        const { data: profileData, slot } = await getPlayerDataWithSlot(message.author.id);
        profileData.redeemedCodes = profileData.redeemedCodes ?? [];
        if (profileData.redeemedCodes.includes(codeRaw)) {
          throw new Error(`Bạn đã dùng code "${codeRaw}" ở profile này rồi — mỗi code chỉ dùng được 1 lần.`);
        }
        profileData.redeemedCodes.push(codeRaw);
        const rewardNotes = [];
        if (codeReward.lunacy) {
          profileData.lunacy = (profileData.lunacy ?? 0) + codeReward.lunacy;
          rewardNotes.push(`+${formatNumber(codeReward.lunacy)} <:Lunacy:1524989409529823342>Lunacy`);
        }
        if (codeReward.books) {
          profileData.books = profileData.books ?? {};
          for (const [bookName, count] of Object.entries(codeReward.books)) {
            profileData.books[bookName] = (profileData.books[bookName] ?? 0) + count;
            rewardNotes.push(`+${count} **${bookName}**`);
          }
        }
        await savePlayerData(message.author.id, profileData, slot);
        if (codeReward.perUser) {
          await redis.set(`redeemUser:${message.author.id}:${codeRaw}`, "1");
        }
        message.reply(`✅ Đã dùng code **${codeRaw}**: ${rewardNotes.join(", ")}.${codeReward.perUser ? "\n> ⚠️ Code này đã khoá trên toàn tài khoản — các profile khác của bạn không dùng được nữa." : ""}`);
      });
    } catch (err) {
      message.reply(`❌ ${err.message}`);
    }
    return;
  }

  if (message.content.startsWith("-profile")) {
    if (isOnCooldown(message.author.id, "profile", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const userId = message.author.id;
    const args = message.content.replace("-profile", "").trim().split(/\s+/);
    const sub = (args[0] ?? "").toLowerCase();

    // -profile switch <1|2|3>
    if (sub === "switch") {
      const slot = parseInt(args[1], 10);
      if (!slot || slot < 1 || slot > MAX_PROFILES) {
        message.reply(`❌ Slot không hợp lệ. Dùng \`-profile switch <1-${MAX_PROFILES}>\` (VD: \`-profile switch 1\`).`);
        return;
      }
      const currentSlot = await getActiveProfileSlot(userId);
      if (slot === currentSlot) {
        const names = await getProfileNames(userId);
        message.reply(`ℹ️ Bạn đang ở **${resolveProfileLabel(names, slot)}** rồi.`);
        return;
      }
      await setActiveProfileSlot(userId, slot);
      const names = await getProfileNames(userId);
      message.reply(`✅ Đã chuyển sang **${PROFILE_EMOJIS[slot]} ${resolveProfileLabel(names, slot)}**!\n> Tất cả lệnh từ bây giờ sẽ dùng save này.`);
      return;
    }

    // -profile rename <tên>
    if (sub === "rename") {
      const rawName = args.slice(1).join(" ").trim();
      if (rawName.length > PROFILE_NAME_MAX_LENGTH) {
        message.reply(`❌ Tên profile tối đa ${PROFILE_NAME_MAX_LENGTH} ký tự.`);
        return;
      }
      const currentSlot = await getActiveProfileSlot(userId);
      await setProfileName(userId, currentSlot, rawName || null);
      const newLabel = rawName || PROFILE_LABELS[currentSlot];
      message.reply(rawName
        ? `✅ Đã đặt tên **${PROFILE_EMOJIS[currentSlot]} Profile ${currentSlot}** thành **"${newLabel}"**!`
        : `✅ Đã reset tên **${PROFILE_EMOJIS[currentSlot]} Profile ${currentSlot}** về mặc định **"${newLabel}"**.`
      );
      return;
    }

    // -profile info
    if (sub === "info" || sub === "") {
      const { embed, components } = await buildProfileInfoEmbed(
        userId,
        message.author.displayName ?? message.author.username,
        `Dùng -profile switch <1-${MAX_PROFILES}> hoặc bấm nút bên dưới để đổi profile`
      );
      message.reply({ embeds: [embed], components });
      return;
    }

    message.reply(`❌ Lệnh không hợp lệ. Dùng:\n> \`-profile info\` — xem tổng quan tất cả profile\n> \`-profile switch <1-${MAX_PROFILES}>\` — chuyển sang profile khác\n> \`-profile rename <tên>\` — đặt tên cho profile hiện tại`);
    return;
  }

  // ── -math ──
  if (message.content.startsWith("-math")) {
    if (isOnCooldown(message.author.id, "math", 2000)) { message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé."); return; }
    const input = message.content.replace("-math", "").trim();
    const kv = parseKeyValues(input);
    const dmgStr = kv["dmg"] ?? "";
    if (!dmgStr.trim()) {
      message.reply(
        "⚠️ Bạn chưa nhập `dmg:`. Vui lòng nhập công thức damage.\n" +
        "> VD: `-math dmg: 10B poise: 10 critmul: 1.3`\n" +
        "> Định dạng dmg: `<số>[x<lần>][+<extra>%] [Dice]<B|P|S>[+<:Sinking:1513762793436741652>Sinking][+<:Rupture:1513762812722155682>Rupture][+<:Poise:1513762945715142736>Poise][+<:Butterfly:1516679919399338074>Living][+<:Butterfly:1516679919399338074>Departed][+Crit<n>]`\n" +
        "> VD: `10x12P+1Living` — mỗi hit cộng 1 Count The Living, áp dụng từ hit kế tiếp"
      );
      return;
    }
    const bonusPct = parseFloat((kv["bonus"] ?? "0").replace("%", ""));
    const sanityBonusPct = parseFloat((kv["sanitybonus"] ?? "0").replace("%", ""));
    // Default 1.3x (mặc định crit dmg theo luật) — KHÔNG phải 1 (bug cũ đã sửa, xem
    // comment đầy đủ ở computeAttackerPerkContext).
    const critMul = parseFloat((kv["critmul"] ?? "1.3").replace("x", ""));
    const poiseInit = parseInt(kv["poise"] ?? "0", 10) || 0;
    const diceMul = parseFloat((kv["dicemul"] ?? "1").replace("x", ""));
    const sinkingInit = parseInt(kv["sinking"] ?? "0", 10);
    const ruptureInit = parseInt(kv["rupture"] ?? "0", 10);
    const sanityInit = parseInt(kv["sanity"] ?? "0", 10);
    const theLiving = parseInt(kv["living"] ?? "0", 10) || 0;
    const theDeparted = parseInt(kv["departed"] ?? "0", 10) || 0;
    const burnInit = parseInt(kv["burn"] ?? "0", 10) || 0;
    const bleedInit = parseInt(kv["bleed"] ?? "0", 10) || 0;
    const bleedActions = parseInt(kv["bleedactions"] ?? "1", 10) || 1;
    const tremorInit = parseInt(kv["tremor"] ?? "0", 10) || 0;
    const chargeInit = parseInt(kv["charge"] ?? "0", 10) || 0;
    const errors = validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit, theLiving, theDeparted, burnInit, bleedInit, bleedActions, tremorInit, chargeInit });
    if (errors.length > 0) { message.reply(`❌ Input không hợp lệ:\n${errors.map(e => `• ${e}`).join("\n")}`); return; }
    const critDivStr = (kv["critdiv"] ?? "").trim().toLowerCase();
    let critDiv = 0;
    if (critDivStr === "yes" || critDivStr === "true" || critDivStr === "1") {
      critDiv = 2;
    } else {
      const parsed = parseFloat(critDivStr);
      if (!isNaN(parsed) && parsed > 1) critDiv = parsed;
    }

    message.reply(calcMath({
      dmgStr,
      resStr: kv["res"] ?? "",
      drStr: kv["dr"] ?? "",
      bonusPct,
      sanityBonusPct,
      critMul,
      poiseInit,
      critDiv,
      sanityInit,
      diceMul,
      sinkingInit,
      ruptureInit,
      theLiving,
      theDeparted,
      burnInit,
      bleedInit,
      bleedActions,
      chargeInit,
      tremorInit,
    }));
    return;
  }

  // ── -encounter ── (start / hit / status / end) — xem comment đầy đủ ở
  // buildEncounterBoardEmbed phía trên về lý do tách biệt hoàn toàn khỏi Profile.
  if (message.content.startsWith("-encounter")) {
    const isAdmin = ADMIN_IDS.has(message.author.id);
    // GM Control Panel (xác nhận trực tiếp): "1 bảng UI control enemy cho GM ở 1
    // kênh khác, vì nếu nhập lệnh liên tục ở kênh đang encounter thì sẽ trôi
    // chat" — resolveGmLinkedChannel cho phép GÕ LỆNH TỪ KÊNH GM RIÊNG (đã link
    // qua `-encounter linkgm`) mà vẫn điều khiển ĐÚNG encounter đang chạy ở kênh
    // khác — trả về CHÍNH encChannelId nếu không có mapping nào (hành vi
    // cũ, encounter ở đúng kênh gõ lệnh, không đổi gì với setup thông thường).
    const encChannelId = await resolveGmLinkedChannel(message.channel.id);
    const argStr = message.content.replace(/^-encounter/i, "").trim();
    const subMatch = argStr.match(/^(\S+)\s*/);
    const sub = (subMatch?.[1] ?? "").toLowerCase();
    const rest = subMatch ? argStr.slice(subMatch[0].length).trim() : "";

    if (sub === "linkgm") {
      // GM Control Panel (xác nhận trực tiếp): "1 bảng UI control enemy cho GM ở
      // 1 kênh khác" — chạy lệnh này TRONG kênh muốn dùng làm GM channel, chỉ
      // định encounter channel muốn điều khiển. Dùng message.channel.id THẬT
      // (không phải encChannelId đã resolve) vì đây CHÍNH LÀ bước tạo mapping.
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới được liên kết kênh điều khiển."); return; }
      const kv = parseKeyValues(rest);
      const targetChannelRaw = (kv["channel"] ?? "").trim();
      const targetChannelId = targetChannelRaw.replace(/[<#>]/g, "");
      if (!targetChannelId) {
        message.reply("⚠️ Cú pháp: `-encounter linkgm channel: <#kênh-encounter>` (chạy lệnh này TRONG kênh bạn muốn dùng làm bảng điều khiển GM).");
        return;
      }
      const targetEncounter = await getEncounter(targetChannelId);
      if (!targetEncounter) {
        message.reply(`⚠️ Không tìm thấy encounter nào đang chạy ở <#${targetChannelId}>.`);
        return;
      }
      if (!isAdmin && message.author.id !== targetEncounter.gmId) {
        message.reply("⚠️ Chỉ GM tạo encounter đó (hoặc admin) mới được liên kết.");
        return;
      }
      await redis.set(`gmlink:${message.channel.id}`, targetChannelId);
      targetEncounter.gmChannelId = message.channel.id;
      await saveEncounter(targetChannelId, targetEncounter);
      message.reply(`✅ Đã liên kết kênh này làm **bảng điều khiển GM** cho encounter **${targetEncounter.name}** (<#${targetChannelId}>).\n> Từ giờ mọi lệnh \`-encounter ...\` gõ TẠI ĐÂY sẽ tự động áp dụng cho encounter đó — dùng \`-encounter gmpanel\` để mở bảng điều khiển nhanh.`);
      return;
    }

    if (sub === "start") {
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới được tạo encounter."); return; }
      const kv = parseKeyValues(rest);
      const name = (kv["name"] ?? "").trim();
      if (!name || name.length > ENCOUNTER_NAME_MAX_LENGTH) {
        message.reply(`⚠️ Cú pháp: \`-encounter start name: <tên trận>\` (tối đa ${ENCOUNTER_NAME_MAX_LENGTH} ký tự). Thêm \`permadeath: yes\` nếu là Night in the Backstreet/dungeon đặc biệt (chết = permanent death thay vì Death Penalty thường). Thêm enemy sau bằng \`-encounter addenemy\`.`);
        return;
      }
      const permadeath = /^(yes|true|1|có)$/i.test((kv["permadeath"] ?? "").trim());
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const existing = await getEncounter(encChannelId);
          if (existing) throw new Error(`Channel này đang có encounter **${existing.name}** chạy — dùng \`-encounter end\` trước.`);
          const encounter = {
            name, enemies: {}, players: {},
            gmId: message.author.id, createdAt: Date.now(),
            pendingActions: [], permadeath,
            // turnNumber — bắt đầu 1 (Turn 1), tăng mỗi -encounter endturn.
            // actionLog — lịch sử ĐẦY ĐỦ các action đã CONFIRM (KHÔNG phải pending
            // — pendingActions là hàng chờ TRƯỚC khi confirm, actionLog là log SAU
            // khi đã confirm/reject) — xem -encounter log để xem lại.
            turnNumber: 1, actionLog: [],
          };
          await saveEncounter(encChannelId, encounter);
          await message.reply({
            content: `✅ Đã tạo encounter **${name}**${permadeath ? " ⚠️**PERMADEATH** (chết = permanent death, không phải Death Penalty thường)" : ""}. Dùng \`-encounter addenemy key: <key> name: <tên> hp: <số>\` để thêm enemy.`,
            embeds: [buildEncounterBoardEmbed(encounter)],
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "addenemy") {
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới được thêm enemy."); return; }
      const kv = parseKeyValues(rest);
      const key = normalizeEnemyKey(kv["key"] ?? "");
      const name = (kv["name"] ?? "").trim();
      const hp = parseInt(kv["hp"] ?? "", 10);
      if (!key || key.length > ENCOUNTER_KEY_MAX_LENGTH || !/^[a-z0-9]+$/.test(key) || !name || !Number.isFinite(hp) || hp <= 0) {
        message.reply(
          "⚠️ Cú pháp: `-encounter addenemy key: <key ngắn a-z0-9> name: <tên đầy đủ> hp: <số>` (tùy chọn `stamina:`/`weapon: light|medium|heavy`/`res: 1.3xB 1.3xP 1.3xS`/`perks: <tên1>,<tên2>`)\n" +
          "> VD: `-encounter addenemy key: mo name: Mo (Brother of Iron) hp: 240`\n" +
          "> Enemy không có profile nên perk phải gán trực tiếp qua `perks:` ở đây (player thì dùng `-unlockskilltree` riêng, lưu trên profile)."
        );
        return;
      }
      const stamina = parseInt(kv["stamina"] ?? "", 10);
      const weapon = normalizeWeaponWeight(kv["weapon"] ?? "medium");
      const resRaw = kv["res"] ?? "";
      const res = { B: 1, P: 1, S: 1 };
      for (const m of resRaw.matchAll(/([\d.]+)(?:x)?([BPS])/gi)) res[m[2].toUpperCase()] = parseFloat(m[1]);
      const perksRaw = (kv["perks"] ?? "").trim();
      const perksList = perksRaw ? perksRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
      const speedRangeMatch = (kv["speedrange"] ?? "").match(/(\d+)\s*[~\-]\s*(\d+)/);
      const speedRangeMin = speedRangeMatch ? parseInt(speedRangeMatch[1], 10) : 3;
      const speedRangeMax = speedRangeMatch ? parseInt(speedRangeMatch[2], 10) : 6;
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
          if (encounter.players[key]) throw new Error(`Key "${key}" đang trùng với 1 player đã join — đổi key khác.`);
          const wasExisting = !!encounter.enemies[key];
          encounter.enemies[key] = createCombatant({
            name, maxHp: hp,
            maxStamina: Number.isFinite(stamina) && stamina > 0 ? stamina : ENCOUNTER_DEFAULT_MAX_STAMINA,
            weaponWeight: weapon, resistance: res, speedRangeMin, speedRangeMax,
          });
          encounter.enemies[key].unlockedPerks = perksList;
          // GAP ĐÃ SỬA (phát hiện qua rà soát): thêm enemy GIỮA 1 round (đã
          // rollspeed) trước đây khiến enemy này KHÔNG BAO GIỜ được hành động
          // cho tới hết round — giờ tự động chèn vào turnOrder hiện tại.
          if (!wasExisting) insertIntoTurnOrderMidRound(encounter, key, "enemy", encounter.enemies[key]);
          await saveEncounter(encChannelId, encounter);
          await message.reply({
            content: `✅ ${wasExisting ? "Đã cập nhật lại" : "Đã thêm"} enemy **${name}** (key: \`${key}\`) với ${hp} HP.` +
              (perksList.length > 0 ? ` (Perk: ${perksList.join(", ")})` : ""),
            embeds: [buildEncounterBoardEmbed(encounter)],
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── removeenemy: gỡ 1 enemy KHỎI BOARD hoàn toàn (KHÁC với hạ HP về 0 — dùng
    // cho trường hợp enemy bỏ chạy/bị bắt sống/rút lui giữa trận, không phải chết).
    // Enemy đã gỡ KHÔNG còn trong actionLog tương lai, không tính vào "tất cả đã hạ"
    // (allDead) — nếu muốn loại enemy ra khỏi điều kiện thắng mà KHÔNG coi là enemy
    // đã chết, đây là lệnh đúng (thay vì set HP=0 sẽ kích hoạt Death Penalty/loot
    // logic dành cho "đã hạ").
    if (sub === "removeenemy") {
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới được gỡ enemy."); return; }
      const kv = parseKeyValues(rest);
      const keyRaw = (kv["key"] ?? "").trim();
      if (!keyRaw) { message.reply("⚠️ Cú pháp: `-encounter removeenemy key: <key>` (gỡ khỏi board — dùng cho bỏ chạy/bắt sống, KHÔNG phải chết)."); return; }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const key = normalizeEnemyKey(keyRaw);
          const enemy = encounter.enemies[key];
          if (!enemy) throw new Error(`Không tìm thấy enemy với key "${keyRaw}".`);
          const name = enemy.name;
          delete encounter.enemies[key];
          // Dọn pendingActions còn nhắm vào enemy vừa gỡ (tránh confirm sau đó bị lỗi
          // "không tìm thấy target").
          encounter.pendingActions = (encounter.pendingActions ?? []).filter(p =>
            p.attackerId !== key && !(p.targets ?? []).some(t => t.targetId === key)
          );
          appendActionLog(encounter, `🏃 Gỡ enemy **${name}** (key: \`${key}\`) khỏi board — bỏ chạy/bắt sống.`);
          await saveEncounter(encChannelId, encounter);
          await message.reply({
            content: `🏃 Đã gỡ enemy **${name}** (key: \`${key}\`) khỏi board — KHÔNG tính là đã hạ (bỏ chạy/bắt sống).`,
            embeds: [buildEncounterBoardEmbed(encounter)],
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "join") {
      const kv = parseKeyValues(rest);
      const hp = parseInt(kv["hp"] ?? "", 10);
      const stamina = parseInt(kv["stamina"] ?? "", 10);
      const light = parseInt(kv["light"] ?? "", 10);
      // Lấy profile TRƯỚC để biết Weapon/Outfit đã equip (nếu có) — làm GIÁ TRỊ MẶC
      // ĐỊNH cho weapon:/res:/speedrange: khi KHÔNG gõ tay tham số đó. Gõ tay vẫn
      // ĐÈ LÊN trang bị (linh hoạt cho trường hợp đặc biệt, không bắt buộc equip).
      const profileDataForDefaults = await getPlayerData(message.author.id);
      if (profileDataForDefaults.permanentlyDead) {
        message.reply("☠️ Nhân vật của bạn đang **Permanent Death** (chết vĩnh viễn từ 1 encounter permadeath trước đó) — không thể tham gia encounter nào cho tới khi được hồi sinh qua Rewound Time (`-rewoundtime` — GM/admin dùng giúp bạn).");
        return;
      }
      const equippedWeaponObj = profileDataForDefaults.equippedWeapon ? findWeaponAnywhere(profileDataForDefaults.equippedWeapon) : null;
      const equippedOutfitObj = profileDataForDefaults.equippedOutfit ? findOutfit(profileDataForDefaults.equippedOutfit) : null;
      const weapon = normalizeWeaponWeight(kv["weapon"] ?? equippedWeaponObj?.weight ?? "medium");
      const resRaw = kv["res"] ?? "";
      // BUG ĐÃ SỬA (xác nhận trực tiếp: "khi player không có outfit trên người thì
      // sẽ mặc định 3 loại kháng là 2x và speed range là 3~6, không có passive") —
      // trước đây mặc định 1x khi KHÔNG có outfit — SAI, đúng phải là 2x (không mặc
      // outfit = dễ bị tổn thương hơn, gấp đôi dmg nhận). Speed range 3~6 ĐÃ ĐÚNG
      // sẵn (xem speedRangeMin/Max bên dưới, fallback 6/3 khi không có outfit).
      // "Không có passive" tự động đúng — passive outfit (VD Iron Horus) check
      // equippedOutfit KHỚP TÊN CỤ THỂ, tự nhiên false khi null, không cần sửa gì.
      const res = equippedOutfitObj ? { ...equippedOutfitObj.resistance } : { B: 2, P: 2, S: 2 };
      for (const m of resRaw.matchAll(/([\d.]+)(?:x)?([BPS])/gi)) res[m[2].toUpperCase()] = parseFloat(m[1]);
      const speedRangeMatch = (kv["speedrange"] ?? "").match(/(\d+)\s*[~\-]\s*(\d+)/);
      const speedRangeMin = speedRangeMatch ? parseInt(speedRangeMatch[1], 10) : (equippedOutfitObj?.speedRange?.min ?? 3);
      const speedRangeMax = speedRangeMatch ? parseInt(speedRangeMatch[2], 10) : (equippedOutfitObj?.speedRange?.max ?? 6);
      // Max Light MẶC ĐỊNH tính theo Grade hiện tại (luật: "4 Max Light ở grade
      // 7/8/9, cứ cách 3 grade nhận thêm 1 (Max 6)") — GRADE_MIN=9 (thấp nhất),
      // GRADE_MAX=1 (cao nhất), grade GIẢM khi lên cấp. Công thức:
      // 4 + floor((GRADE_MIN - grade)/3), cap 6. Gõ tay light: vẫn ĐÈ lên được.
      const { grade: playerGrade } = calcGrade(profileDataForDefaults.exp ?? 0);
      const gradeBasedMaxLight = Math.min(6, 4 + Math.floor((GRADE_MIN - playerGrade) / 3));
      // Max HP MẶC ĐỊNH tính theo Grade (luật: "mỗi 1 grade... +20 Max HP", GM xác
      // nhận trực tiếp HP ở grade 9 (thấp nhất) = 140) — công thức: 140 + 20×(số
      // grade đã lên TỪ grade 9). Gõ tay hp: vẫn ĐÈ lên được (linh hoạt — đặc biệt
      // cần cho enemy/stat-block tuỳ ý không theo Grade).
      const gradeBasedMaxHp = 140 + 20 * (GRADE_MIN - playerGrade);
      // Chấn thương PERSIST qua encounter (luật xác nhận trực tiếp) — Gãy Xương/Vết
      // thương lớn trừ Max HP VĨNH VIỄN cho tới khi được chữa (bằng Ahn ngoài
      // encounter qua -healinjuryahn, HOẶC bằng K-Corp Ampule trong encounter — xem
      // -encounter useitem). Max HP THẬT = Grade-based TRỪ tổng penalty từ injuries
      // đang mang, floor tại 1 (không bao giờ về 0/âm).
      const persistedInjuries = profileDataForDefaults.injuries ?? [];
      const injuryMaxHpPenalty = calcInjuryMaxHpPenalty(persistedInjuries);
      const effectiveGradeMaxHp = Math.max(1, gradeBasedMaxHp - injuryMaxHpPenalty);
      // HP mặc định khi KHÔNG gõ tay hp: — dùng HP THẬT còn lại từ encounter trước
      // (persist qua profile.currentHp), áp auto-reset nếu đã qua mốc 0h/12h giờ
      // VN kể từ lần cập nhật gần nhất (xem getEffectiveCurrentHp). Nếu auto-reset
      // xảy ra ngay lúc này, lưu lại NGAY để lần check sau không reset lại lần nữa
      // trước mốc kế tiếp.
      const effectiveHp = getEffectiveCurrentHp(profileDataForDefaults, effectiveGradeMaxHp);
      if (effectiveHp.didReset) {
        profileDataForDefaults.currentHp = effectiveHp.hp;
        profileDataForDefaults.hpLastResetCheck = Date.now();
        const { slot: hpSlot } = await getPlayerDataWithSlot(message.author.id);
        await savePlayerData(message.author.id, profileDataForDefaults, hpSlot);
      }
      const finalHp = Number.isFinite(hp) && hp > 0 ? hp : effectiveHp.hp;
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào. Dùng `-encounter start` để tạo.");
          const wasJoined = !!encounter.players[message.author.id];
          encounter.players[message.author.id] = createCombatant({
            name: message.author.username, maxHp: finalHp,
            maxStamina: Number.isFinite(stamina) && stamina > 0 ? stamina : ENCOUNTER_DEFAULT_MAX_STAMINA,
            maxLight: Number.isFinite(light) && light > 0 ? light : gradeBasedMaxLight,
            weaponWeight: weapon,
            weaponBaseDamage: equippedWeaponObj?.baseDamage ?? null,
            weaponType: equippedWeaponObj?.type ?? null,
            weaponName: equippedWeaponObj?.name ?? null,
            weaponCriticalKey: equippedWeaponObj ? (equippedWeaponObj.criticalSkillKey ?? equippedWeaponObj.name) : null,
            // GAP NGHIÊM TRỌNG ĐÃ SỬA — combatant.equippedOutfit CHƯA TỪNG được
            // lưu lúc join (chỉ có weaponName, không có tương đương cho outfit)
            // — khiến MỌI check "attacker.combatant.equippedOutfit === ..."
            // trước đây (Dark Cloud/Kurokumo Wakashu, Thumb Capo IIII...) LUÔN
            // false (undefined), phát hiện qua test join THẬT (không phải gán
            // tay state trực tiếp).
            equippedOutfit: profileDataForDefaults.equippedOutfit ?? null,
            resistance: res, speedRangeMin, speedRangeMax,
          });
          // Copy Skill Tree đã mở khóa TỪ PROFILE (vĩnh viễn) vào combatant của
          // encounter này — snapshot lúc join, giống cách HP/Stamina/vũ khí cũng
          // được "chốt" lúc join (không tự đồng bộ real-time nếu admin unlock thêm
          // GIỮA lúc encounter đang chạy — phải join lại để cập nhật, y hệt nguyên
          // tắc đang áp dụng cho mọi field khác). Dùng LẠI profileDataForDefaults
          // đã fetch ở trên (tránh gọi Redis 2 lần + tránh race condition).
          const profileData = profileDataForDefaults;
          const joined = encounter.players[message.author.id];
          // GAP ĐÃ SỬA (phát hiện qua rà soát): join GIỮA 1 round (đã rollspeed)
          // trước đây khiến player này KHÔNG BAO GIỜ được hành động cho tới hết
          // round — giờ tự động chèn vào turnOrder hiện tại (chỉ lần join ĐẦU,
          // không phải update lại profile giữa chừng).
          if (!wasJoined) {
            insertIntoTurnOrderMidRound(encounter, message.author.id, "player", joined);
          }
          joined.unlockedPerks = [...(profileData.unlockedSkillTree ?? [])];
          // Injuries PERSIST qua encounter (xác nhận trực tiếp từ GM) — snapshot
          // TRỰC TIẾP từ profile (KHÔNG reset về rỗng như trước đây). maxHp đã tính
          // TRỪ injuryMaxHpPenalty ở effectiveGradeMaxHp phía trên rồi, nên ở đây chỉ
          // cần copy danh sách injuries (không cần trừ maxHp lần 2).
          joined.injuries = [...persistedInjuries];
          // Snapshot 5 Page + 5 E.G.O Page đã equip trên profile — dùng để build
          // dropdown hành động (xem buildEncounterActionPanel) — CHỐT lúc join, y
          // hệt nguyên tắc đang áp dụng cho unlockedPerks/HP/Stamina/... (đổi loadout
          // giữa trận thì phải join lại để cập nhật).
          joined.unlockedPagesSnapshot = (profileData.equippedPages ?? []).filter(Boolean);
          joined.unlockedEgoPagesSnapshot = (profileData.equippedEgoPages ?? []).filter(Boolean);
          // Snapshot 3 Accessory đã equip — dùng để check perk ĐẶC BIỆT gắn liền 1
          // accessory cụ thể (VD Dimension Pocket của Găng Tay Câm Lặng cho phép đổi
          // vũ khí giữa trận — xem -encounter swapweapon) — CHỐT lúc join, cùng
          // nguyên tắc snapshot như Page ở trên.
          joined.equippedAccessoriesSnapshot = (profileData.equippedAccessories ?? []).filter(Boolean);
          // Cờ passive GẮN LIỀN 1 outfit/weapon CỤ THỂ (tự động hoá theo yêu cầu trực
          // tiếp) — snapshot lúc join, cùng nguyên tắc như trên (đổi trang bị giữa
          // trận cần join lại để cập nhật).
          // Iron Horus (Abydos's Uniform - Lazy Style): Block tốn 40 Sta (thay vì 10)
          // nhưng giảm sát thương TOÀN BỘ đòn (100%, thay vì 90%/99% mặc định) — xem
          // performGuardEvade.
          joined.hasIronHorus = (profileData.equippedOutfit ?? "").toLowerCase().replace(/^["']+|["']+$/g, "") === "abydos's uniform - lazy style";
          // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit) — theo ĐÚNG
          // pattern hasIronHorus ở trên: mỗi outfit-specific mechanic tự set 1
          // boolean flag riêng lúc join (combatant không có field chung "outfit
          // name" nào). "Reverberation Ensemble": 40% Dmg Reduction cố định.
          const equippedOutfitNameNormalized = (profileData.equippedOutfit ?? "").toLowerCase().replace(/^["']+|["']+$/g, "");
          joined.hasReverberationEnsemble = equippedOutfitNameNormalized === "reverberation ensemble";
          // "Ambitious Fixer": "Khi vào Encounter bạn nhận được 3 Haste" — áp
          // dụng NGAY lúc join (chỉ lần join ĐẦU, không phải update lại giữa
          // chừng — khớp nguyên tắc "trang bị chốt lúc join" đã áp dụng chung).
          if (!wasJoined && equippedOutfitNameNormalized === "ambitious fixer") {
            joined.haste = (joined.haste ?? 0) + 3;
          }
          joined.hasAmbitiousFixer = equippedOutfitNameNormalized === "ambitious fixer";
          // "Thumb Soldato": "Các vũ khí/skill/page sử dụng đạn sẽ được tăng
          // thêm 15% Dmg gây ra" + "Mỗi đòn đánh thường thứ 4 nhận 1 đạn".
          joined.hasThumbSoldato = equippedOutfitNameNormalized === "thumb soldato";
          // "WARP Corp. Cleaner": "Gia tăng 1.5x hiệu quả nhận Charge của bản thân".
          joined.hasWarpCorpCleaner = equippedOutfitNameNormalized === "warp corp. cleaner";
          // "Seven Association": "Gia tăng 1.5x hiệu quả áp Rupture của bạn".
          joined.hasSevenAssociation = equippedOutfitNameNormalized === "seven association";
          // "Liu Association": "Nhận được thêm 2 Dice Up khi bạn ở trong Emotion
          // Level" + "Mỗi khi gây Burn cho kẻ địch, bạn giảm 5 Stamina của chúng".
          joined.hasLiuAssociation = equippedOutfitNameNormalized === "liu association";
          // "Cinq Association": "7% Crit Rate mỗi 2 Haste (max 25%)" + "2 Haste
          // mỗi 20 Stamina tiêu qua M1".
          joined.hasCinqAssociation = equippedOutfitNameNormalized === "cinq association";
          // "Dieci Association": Shield HP system + Sinking application.
          joined.hasDieciAssociation = equippedOutfitNameNormalized === "dieci association";
          // "Zwei Association": Tremor khi đỡ thành công + Critical áp Tremor
          // theo 1/2 bản thân + tiêu Defense Up để chống Guard Break.
          joined.hasZweiAssociation = equippedOutfitNameNormalized === "zwei association";
          // "Hana Association": "+1 Dice Up mỗi 10 HP mất trong turn".
          joined.hasHanaAssociation = equippedOutfitNameNormalized === "hana association";
          // BUG NGHIÊM TRỌNG ĐÃ SỬA — validateAndRerollPrescript (combat-utils.js)
          // check "c.equippedOutfit" (combatant-level) nhưng field này KHÔNG
          // BAO GIỜ tồn tại trên combatant thật (chỉ có trên profileData) —
          // nghĩa là Index Proselyte's roll dice CHƯA BAO GIỜ hoạt động đúng
          // trong thực tế từ trước tới giờ, dù test sandbox trước đó "pass" (vì
          // tự set field lên combatant trực tiếp, bypass flow join thật). Thêm
          // flag đúng pattern (giống hasZweiAssociation...) để sửa tận gốc.
          joined.hasIndexProselyte = equippedOutfitNameNormalized === "index proselyte";
          // GAP ĐÃ SỬA (xác nhận trực tiếp: "Index Proselyte outfit cũng chưa
          // tự động hóa phần roll dice 1-7 để lấy prescript") — player join
          // GIỮA encounter (sau khi rollspeed đã chạy) trước đây KHÔNG BAO GIỜ
          // được khởi tạo prescriptRoll. Đặt Ở ĐÂY (không phải ngay sau
          // insertIntoTurnOrderMidRound) vì cần hasIndexProselyte đã set XONG
          // trước đó — thứ tự sai lúc đầu khiến flag chưa tồn tại lúc gọi hàm.
          if (!wasJoined && hasEncounterStarted(encounter)) {
            validateAndRerollPrescript(encounter, null, { id: message.author.id, type: "player" });
          }
          // Perk "đầu encounter" — áp dụng 1 LẦN ngay lúc join (KHÔNG áp lại nếu join
          // lại để cập nhật stat — chỉ áp khi THỰC SỰ là lần tham gia đầu, tránh free
          // refill Light/Poise/Sanity mỗi lần gõ lại join).
          const startNotes = [];
          if (!wasJoined) {
            if (hasPerk(joined, "Here We Go Again")) { joined.currentLight = Math.min(joined.maxLight, 3); startNotes.push("+3 Light (Here We Go Again)"); }
            if (hasPerk(joined, "Adrenaline Rush")) { joined.poise = Math.min(POISE_MAX, 10); startNotes.push("+10 Poise (Adrenaline Rush)"); }
            if (hasPerk(joined, "No Mind To Cure")) { joined.currentSanity = -25; startNotes.push("-25 Sanity (No Mind To Cure)"); }
            // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit, batch 5) —
            // "Udjat" (outfit): "Khi start encounter bạn nhận được 10 Protection"
            // — áp dụng 1 LẦN lúc join thật đầu tiên, cùng nguyên tắc các perk
            // "đầu encounter" khác ở trên (không phải hasPerk vì đây là OUTFIT,
            // không phải Skill Tree).
            if ((equippedOutfitObj?.name ?? "").toLowerCase() === "udjat") {
              joined.protection = Math.min(20, (joined.protection ?? 0) + 10);
              // BUG ĐÃ SỬA (xác nhận trực tiếp: "Protection sẽ biến mất sau 2 turn
              // kể từ lúc nhận, cái này có tính chưa") — quên set protectionTurnsLeft
              // = 2 (Duration riêng, xem turn-advance.js's decay logic + comment
              // gốc ở combatant-factory.js) — nếu không, Protection sẽ đứng yên
              // mãi mãi (không bao giờ hết hạn tự nhiên qua decay thông thường).
              joined.protectionTurnsLeft = 2;
              startNotes.push("+10 Protection (Udjat, hết sau 2 turn)");
            }
          }
          await saveEncounter(encChannelId, encounter);
          const equipNotes = [];
          if (equippedWeaponObj && !kv["weapon"]) equipNotes.push(`Vũ khí: ${equippedWeaponObj.name} (${equippedWeaponObj.weight})`);
          if (equippedOutfitObj && !kv["res"]) equipNotes.push(`Outfit: ${equippedOutfitObj.name} (Res ${res.B}xB ${res.P}xP ${res.S}xS)`);
          if (!Number.isFinite(light) || light <= 0) equipNotes.push(`Max Light: ${gradeBasedMaxLight} (theo Grade ${playerGrade})`);
          if (!Number.isFinite(hp) || hp <= 0) {
            equipNotes.push(
              effectiveHp.hp < gradeBasedMaxHp
                ? `HP: ${effectiveHp.hp}/${gradeBasedMaxHp} (còn lại từ trước — chưa qua mốc reset 0h/12h giờ VN)`
                : `Max HP: ${gradeBasedMaxHp} (theo Grade ${playerGrade})`
            );
          }
          await message.reply({
            content: `✅ ${wasJoined ? "Đã cập nhật lại" : "Đã tham gia"} encounter **${encounter.name}** với ${finalHp} HP.` +
              (equipNotes.length > 0 ? `\n> 🎒 Tự lấy từ trang bị: ${equipNotes.join(", ")}` : "") +
              (joined.unlockedPerks.length > 0 ? ` (Perk từ profile: ${joined.unlockedPerks.join(", ")})` : "") +
              (startNotes.length > 0 ? `\n> 🆙 ${startNotes.join(", ")}` : ""),
            components: buildEncounterActionPanel(encChannelId, joined, message.author.id),
          });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── rollspeed: roll Speed cho TẤT CẢ combatant, quyết định thứ tự turn (xem
    // determineTurnOrder — xử lý tie cùng phe/khác phe khác nhau theo update mới).
    if (sub === "pass") {
      // Turn Order Enforcement: bỏ qua lượt CHỦ ĐỘNG (không hành động gì cả) —
      // cần thiết vì gate mới chặn M1/skill ngoài lượt, người/enemy có thể muốn
      // "nhường lượt" (VD hết Stamina, hoặc chủ động không làm gì turn này).
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const order = encounter.turnOrder ?? [];
          if (order.length === 0) throw new Error("Chưa roll Speed — dùng `-encounter rollspeed` trước.");
          const curEntry = order[encounter.currentTurnIndex ?? 0];
          if (!curEntry) throw new Error("Đã hết lượt cho turn này — dùng `-encounter endturn`.");
          const isAdmin2 = ADMIN_IDS.has(message.author.id);
          if (curEntry.type === "player" && message.author.id !== curEntry.id) throw new Error("Chỉ đúng người đang tới lượt mới pass được.");
          if (curEntry.type === "enemy" && !isAdmin2 && message.author.id !== encounter.gmId) throw new Error("Chỉ GM/admin mới pass lượt enemy được.");
          const label = curEntry.type === "enemy" ? `**${encounter.enemies[curEntry.id]?.name ?? curEntry.id}**` : `<@${curEntry.id}>`;
          const { wrapped, prescriptNotes } = advanceToNextTurnHolder(encounter);
          appendActionLog(encounter, `⏭️ ${label} bỏ qua lượt (pass).`);
          await saveEncounter(encChannelId, encounter);
          announceCurrentTurn(encChannelId, encounter).catch(() => {});
          message.reply(`⏭️ ${label} đã bỏ qua lượt.${prescriptNotes.length > 0 ? "\n" + prescriptNotes.map(n => `> ${n}`).join("\n") : ""}${wrapped ? "\n> 🔄 Đã hết 1 vòng turn order — dùng `-encounter endturn` để bắt đầu turn mới." : `\n> Tiếp theo: ${buildTurnOrderText(encounter)}`}`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "rollspeed") {
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          if (!isAdmin && message.author.id !== encounter.gmId) throw new Error("Chỉ GM (hoặc admin) mới roll thứ tự turn.");
          if (Object.keys(encounter.enemies).length + Object.keys(encounter.players).length < 1) throw new Error("Chưa có combatant nào để roll.");
          determineTurnOrder(encounter);
          // GAP ĐÃ SỬA (xác nhận trực tiếp: "test thì chỉ thấy sang turn vẫn
          // được 2 Light như thường, nhưng lúc encounter start... rollspeed
          // thì lại không được cộng light") — CÙNG NGUYÊN NHÂN với prescriptRoll
          // ngay bên dưới: rollspeed (round ĐẦU TIÊN) không đi qua
          // advanceCombatantTurn (turn-advance.js) — nơi Light Dash perk's +2
          // Light mỗi turn start được áp dụng — nên cần gọi riêng ở đây cho
          // TẤT CẢ combatant có perk này, y hệt logic gốc trong turn-advance.js.
          for (const c of [...Object.values(encounter.enemies), ...Object.values(encounter.players)]) {
            if (hasPerk(c, "Light Dash")) {
              c.currentLight = Math.min(c.maxLight, c.currentLight + 2);
            }
            // "Rotate Trigram" (Augury Spear) — CÙNG NGUYÊN NHÂN với Light Dash
            // ở trên: rollspeed (round đầu) không đi qua advanceCombatantTurn.
            if (c.weaponName === "Augury Spear") {
              const idx = c.rotateTrigramIndex ?? 0;
              if (idx === 0) c.diceUp = (c.diceUp ?? 0) + 3;
              else if (idx === 1) c.protection = Math.min(20, (c.protection ?? 0) + 7);
              else if (idx === 2) c.currentLight = Math.min(c.maxLight, (c.currentLight ?? 0) + 2);
              else if (idx === 3) c.rotateTrigramRiPending = true;
              c.rotateTrigramIndex = (idx + 1) % 4;
            }
          }
          // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit) — rollspeed
          // (lần ĐẦU TIÊN bắt đầu trận) không đi qua advanceToNextTurnHolder,
          // nên người ĐẦU TIÊN trong turnOrder sẽ không có prescriptRoll/
          // prescriptTargetId nếu không gọi riêng ở đây.
          const prescriptNotesInit = validateAndRerollPrescript(encounter, null, encounter.turnOrder[0] ?? null);
          appendActionLog(encounter, `🎲 Roll Speed — Thứ tự Turn mới:\n${buildTurnOrderText(encounter)}`);
          await saveEncounter(encChannelId, encounter);
          announceCurrentTurn(encChannelId, encounter).catch(() => {});
          message.reply({ embeds: [{ title: "🎲 Thứ tự Turn", description: buildTurnOrderText(encounter) + (prescriptNotesInit.length > 0 ? "\n\n" + prescriptNotesInit.join("\n") : ""), color: 0x3498db }] });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── haste/bind: chỉnh tay (GM/player) — 1 Haste +1 Speed, 1 Bind -1 Speed (xem
    // comment ở createCombatant — chưa tích hợp qua dmgStr tag như 7 status cũ).
    if (sub === "haste" || sub === "bind") {
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const amount = parseInt(kv["amount"] ?? "", 10);
      if (!targetRaw || !Number.isFinite(amount)) {
        message.reply(`⚠️ Cú pháp: \`-encounter ${sub} target: <key/userId/me> amount: <số, có thể âm để trừ>\``);
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          resolved.combatant[sub] = Math.max(0, (resolved.combatant[sub] ?? 0) + amount);
          appendActionLog(encounter, `${resolved.label}: ${sub === "haste" ? "Haste" : "Bind"} ${amount >= 0 ? "+" : ""}${amount} → còn ${resolved.combatant[sub]}.`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ ${resolved.label}: ${sub === "haste" ? "Haste" : "Bind"} ${amount >= 0 ? "+" : ""}${amount} → còn ${resolved.combatant[sub]}.`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── swapweapon: đổi vũ khí GIỮA TRẬN — luật xác nhận trực tiếp: "mỗi người chỉ
    // được trang bị 1 vũ khí + 1 outfit + 3 accessory, KHÔNG được đem vào/đổi giữa
    // trận TRỪ 1 số vũ khí/accessory ĐẶC BIỆT cho phép điều đó" — MẶC ĐỊNH CHẶN
    // HOÀN TOÀN, chỉ mở khi player sở hữu 1 trong số ít accessory/vũ khí được biết
    // là CÓ khả năng này (hiện tại: Dimension Pocket — passive của Găng Tay Câm
    // Lặng, "Có thể thay đổi vũ khí giữa trận bằng cách tiêu hao 1 Light"). DANH
    // SÁCH NÀY CỐ Ý NGẮN — chỉ thêm khi có xác nhận RÕ RÀNG 1 item khác cũng cho
    // phép, KHÔNG tự suy đoán/mở rộng.
    const MID_COMBAT_WEAPON_SWAP_SOURCES = {
      "găng tay câm lặng": { lightCost: 1, abilityName: "Dimension Pocket" },
    };
    if (sub === "swapweapon") {
      const weaponNameRaw = rest.trim();
      if (!weaponNameRaw) { message.reply("⚠️ Cú pháp: `-encounter swapweapon <tên vũ khí>` (CHỈ dùng được nếu sở hữu accessory/vũ khí có khả năng đổi giữa trận, VD Dimension Pocket của Găng Tay Câm Lặng)."); return; }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const player = encounter.players[message.author.id];
          if (!player) throw new Error("Bạn chưa tham gia encounter này.");
          const ownedAccessories = (player.equippedAccessoriesSnapshot ?? []).map(a => a.toLowerCase());
          const grantingSource = Object.keys(MID_COMBAT_WEAPON_SWAP_SOURCES).find(key => ownedAccessories.includes(key));
          if (!grantingSource) {
            throw new Error(`Trang bị bị KHOÁ trong suốt trận (luật: 1 vũ khí cố định/trận) — bạn không sở hữu accessory/vũ khí nào cho phép đổi giữa trận (VD Dimension Pocket của Găng Tay Câm Lặng).`);
          }
          const { lightCost, abilityName } = MID_COMBAT_WEAPON_SWAP_SOURCES[grantingSource];
          const newWeapon = findWeaponAnywhere(weaponNameRaw);
          if (!newWeapon) throw new Error(`Không tìm thấy vũ khí "${weaponNameRaw}" trong weapon.js hoặc skills.js.`);
          if (player.currentLight < lightCost) throw new Error(`Không đủ Light để đổi vũ khí qua ${abilityName} — cần ${lightCost}, hiện có ${player.currentLight}.`);
          const oldWeaponWeight = player.weaponWeight;
          player.currentLight -= lightCost;
          player.weaponWeight = newWeapon.weight;
          player.weaponBaseDamage = newWeapon.baseDamage ?? null;
          player.weaponType = newWeapon.type ?? null;
          player.weaponName = newWeapon.name ?? null;
          player.weaponCriticalKey = newWeapon.criticalSkillKey ?? newWeapon.name ?? null;
          // orlandoFuriosoBypass — GAP ĐÃ SỬA (xác nhận trực tiếp): swap qua vũ
          // khí có passive "Orlando Furioso" → Critical NGAY SAU đó miễn CD.
          const hasOrlandoFurioso = (newWeapon.passives ?? []).some(p => p.mechanicId === "orlando_furioso");
          if (hasOrlandoFurioso) player.orlandoFuriosoBypass = true;
          appendActionLog(encounter, `🔄 <@${message.author.id}> đổi vũ khí qua ${abilityName} (-${lightCost} Light): ${newWeapon.name} (${oldWeaponWeight} → ${newWeapon.weight}).${hasOrlandoFurioso ? " ⚡Orlando Furioso: Critical tiếp theo miễn CD." : ""}`);
          await saveEncounter(encChannelId, encounter);
          message.reply(
            `🔄 ${message.author} đổi vũ khí qua **${abilityName}** (-${lightCost} Light): **${newWeapon.name}** (${newWeapon.weight}/${newWeapon.type}, Base Dmg ${newWeapon.baseDamage}).\n` +
            `> Độ nặng vũ khí đổi từ \`${oldWeaponWeight}\` → \`${newWeapon.weight}\` (ảnh hưởng Stamina cost M1 + số hit Guard/Evade/Parry chặn được). GM tự xác nhận đây có đúng là vũ khí hợp lệ theo phạm vi ${abilityName} hay không (hệ thống không có danh sách phân loại để tự kiểm tra).${hasOrlandoFurioso ? "\n> ⚡ **Orlando Furioso**: Critical tiếp theo của bạn sẽ MIỄN CD (dùng 1 lần)." : ""}`
          );
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "status") {
      const encounter = await getEncounter(encChannelId);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào. Dùng `-encounter start` để tạo."); return; }
      message.reply({ embeds: [buildEncounterBoardEmbed(encounter)], components: buildEncounterActionPanel(encChannelId, encounter.players[message.author.id], message.author.id) });
      return;
    }

    if (sub === "pending") {
      const encounter = await getEncounter(encChannelId);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào."); return; }
      const pending = encounter.pendingActions ?? [];
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "cái pending tôi nghĩ không cần thiết nữa
      // vì mọi thứ giờ nên xử lý hoàn toàn tự động... vẫn giữ nguyên nhưng đổi
      // tên/cách hiển thị rõ hơn là dự phòng khẩn cấp") — Reactive Defense đã tự
      // động xử lý MỌI hành động ngay khi target chọn phòng thủ (hoặc dmg=0 tự
      // skip) — pendingActions giờ CHỈ còn ý nghĩa "vùng chờ tạm" trong lúc chưa
      // ai bấm nút, KHÔNG PHẢI luồng chính cần GM tự confirm/reject thủ công nữa.
      // Đổi embed rõ ràng: đây là fallback khẩn cấp (VD prompt gửi lỗi, target
      // rời server...), không phải bước bắt buộc mỗi turn.
      message.reply({
        embeds: [{
          title: `🆘 Dự phòng khẩn cấp — Action đang chờ (${pending.length})`,
          description:
            (pending.length === 0
              ? "✅ Không có action nào bị kẹt — mọi thứ đang tự xử lý bình thường qua Reactive Defense."
              : `${buildPendingListText(encounter)}\n\n⚠️ Đây là DỰ PHÒNG KHẨN CẤP — chỉ cần dùng nếu prompt phòng thủ (Guard/Evade/Parry) không gửi được hoặc target không thể bấm. Bình thường mọi thứ tự động xử lý, không cần GM can thiệp gì cả.`
            ) + `\n\n📜 Xem lại lịch sử action đã xử lý: \`-encounter log\`.`,
          color: pending.length === 0 ? 0x2ecc71 : 0xe74c3c,
        }],
        components: pending.length > 0 ? [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`encconfirmall:${encChannelId}`).setLabel("🆘 Force-confirm tất cả (khẩn cấp)").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`encrejectall:${encChannelId}`).setLabel("🆘 Force-reject tất cả (khẩn cấp)").setStyle(ButtonStyle.Danger),
        )] : [],
      });
      return;
    }

    // ── log: xem lại LỊCH SỬ các action ĐÃ CONFIRM/REJECT (full detail — nguyên
    // văn text đã hiện lúc confirm, xem actionLog ghi ở đâu trong confirm handler).
    // KHÁC "pending" — pending là hàng chờ TRƯỚC khi confirm, log là lịch sử SAU
    // khi đã xử lý xong. Mặc định hiện 5 turn GẦN NHẤT (tránh tràn message dài) —
    // `turn: N` để xem ĐÚNG 1 turn cụ thể, `turn: all` để xem TOÀN BỘ (tự cắt
    // thành nhiều embed nếu vượt 4096 ký tự/embed của Discord).
    if (sub === "log") {
      const encounter = await getEncounter(encChannelId);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào."); return; }
      const fullLog = encounter.actionLog ?? [];
      if (fullLog.length === 0) { message.reply("📜 Chưa có action nào được confirm/reject trong encounter này."); return; }
      const kv = parseKeyValues(rest);
      const turnFilter = (kv["turn"] ?? "").trim().toLowerCase();
      let entriesToShow;
      let headerNote;
      if (turnFilter === "all") {
        entriesToShow = fullLog;
        headerNote = `toàn bộ ${fullLog.length} entry`;
      } else if (turnFilter && /^\d+$/.test(turnFilter)) {
        const turnNum = parseInt(turnFilter, 10);
        entriesToShow = fullLog.filter(e => e.turn === turnNum);
        headerNote = `Turn ${turnNum} (${entriesToShow.length} entry)`;
        if (entriesToShow.length === 0) { message.reply(`📜 Không có log nào cho Turn ${turnNum} (hiện đang ở Turn ${encounter.turnNumber ?? 1}).`); return; }
      } else {
        const distinctTurns = [...new Set(fullLog.map(e => e.turn))]; // đã theo thứ tự thời gian (push tuần tự)
        const last5TurnNumbers = new Set(distinctTurns.slice(-5));
        entriesToShow = fullLog.filter(e => last5TurnNumbers.has(e.turn));
        headerNote = `5 turn gần nhất — dùng \`turn: N\` để xem turn cụ thể, \`turn: all\` để xem hết`;
      }
      // Build text, gộp theo Turn cho dễ đọc.
      const lines = [];
      let lastTurn = null;
      for (const entry of entriesToShow) {
        if (entry.turn !== lastTurn) { lines.push(`\n**── Turn ${entry.turn} ──**`); lastTurn = entry.turn; }
        const icon = getActionLogIcon(entry.type);
        for (const l of entry.lines) lines.push(`${icon} ${l}`);
      }
      const fullText = lines.join("\n").trim();
      // Cắt thành nhiều embed nếu vượt 4096 ký tự (giới hạn Discord) — cắt theo
      // DÒNG (không cắt giữa 1 dòng), mỗi embed tối đa ~3900 ký tự để có khoảng
      // đệm an toàn.
      const chunks = [];
      let current = "";
      for (const line of lines) {
        if ((current + "\n" + line).length > 3900) { chunks.push(current); current = line; }
        else current = current ? current + "\n" + line : line;
      }
      if (current) chunks.push(current);
      const embeds = chunks.map((c, i) => ({
        title: i === 0 ? `📜 Action Log — ${headerNote}` : `📜 Action Log (tiếp ${i + 1})`,
        description: c || "*(trống)*",
        color: 0x95a5a6,
      }));
      // Discord giới hạn 10 embed/message — nếu vượt, chỉ gửi 10 đầu kèm cảnh báo.
      if (embeds.length > 10) {
        message.reply({ content: `⚠️ Log quá dài (${embeds.length} phần) — chỉ hiện 10 phần đầu. Dùng \`turn: N\` để xem từng turn cụ thể thay vì \`all\`.`, embeds: embeds.slice(0, 10) });
      } else {
        message.reply({ embeds });
      }
      return;
    }

    // ── buff/debuff: thêm 1 dòng TỰ DO vào danh sách buff/debuff của 1 combatant
    // (enemy hoặc player) — KHÔNG tự tính/tự hết hạn (xem comment ở createCombatant).
    // target: có thể là key enemy, userId, hoặc "me" (chính người gõ lệnh).
    if (sub === "buff" || sub === "debuff") {
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const text = (kv["text"] ?? "").trim();
      if (!targetRaw || !text) {
        message.reply(`⚠️ Cú pháp: \`-encounter ${sub} target: <key/userId/me> text: <mô tả>\`\n> VD: \`-encounter buff target: me text: 3 Haste + 10% dmg slash\``);
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          const listKey = sub === "buff" ? "buffs" : "debuffs";
          resolved.combatant[listKey] = resolved.combatant[listKey] ?? [];
          resolved.combatant[listKey].push({ text, addedAt: Date.now() });
          appendActionLog(encounter, `${sub === "buff" ? "🟢" : "🔴"} ${resolved.label}: ${sub === "buff" ? "+buff" : "+debuff"} "${text}"`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ Đã thêm ${sub === "buff" ? "🟢 buff" : "🔴 debuff"} cho ${resolved.label}: "${text}"`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // -encounter setstatus — GM SET SỐ CỤ THỂ cho 10 status Nhóm 1 (khác buff/
    // debuff vốn chỉ TEXT tự do, KHÔNG ảnh hưởng số liệu thật) — CỘNG THÊM (không
    // set tuyệt đối) vào giá trị hiện có, cap đúng theo luật từng status. Theo
    // yêu cầu trực tiếp: "50 status đó cũng phải tự động tracking để cho giống 1
    // game đấy" — đây là lệnh GM dùng để ÁP các status này lên combatant trong
    // trận thật (trước đó CHỈ có field+decay+công thức tính, HOÀN TOÀN chưa có
    // cách nào set chúng vào combat).
    if (sub === "setstatus") {
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      // GAP ĐÃ SỬA (dự án GM Panel mở rộng) — logic CỐT LÕI đã tách ra
      // applyStatusEntries (dùng chung với gmpanel's Modal chỉnh sửa), giữ
      // NGUYÊN STATUS_CAPS_SHARED làm nguồn danh sách hợp lệ để hiện cú pháp.
      const entries = Object.keys(STATUS_CAPS_SHARED).filter(k => kv[k] !== undefined).map(k => ({ key: k, raw: kv[k] }));
      if (!targetRaw || entries.length === 0) {
        message.reply(`⚠️ Cú pháp: \`-encounter setstatus target: <key/userId/me> <status>: <số>\` (CỘNG THÊM vào giá trị hiện có)\n> Status hợp lệ: ${Object.keys(STATUS_CAPS_SHARED).join("/")}\n> VD: \`-encounter setstatus target: mo fragile: 5\``);
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          // Gaze[Awe]/Contempt (xác nhận trực tiếp): cần biết "kẻ đã gắn nó" — dùng
          // param riêng `source:` (key enemy hoặc mention player), KHÔNG nằm trong
          // STATUS_CAPS_SHARED (không phải 1 giá trị số cộng dồn như status khác).
          const sourceRaw = (kv["source"] ?? "").trim();
          let sourceId = null;
          if (sourceRaw) {
            const sourceEnemyKey = normalizeEnemyKey(sourceRaw);
            sourceId = encounter.enemies[sourceEnemyKey] ? sourceEnemyKey : sourceRaw.replace(/[<@!>]/g, "");
          }
          const changes = applyStatusEntries(resolved, entries, sourceId, checkStaggerPanic);
          appendActionLog(encounter, `📊 ${resolved.label}: setstatus ${changes.join(", ")}`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ ${resolved.label}: ${changes.join(", ")}`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "setflag") {
      // Status DẠNG FLAG (có/không, KHÔNG stack số) — khác setstatus (số nguyên,
      // cộng dồn có cap). Airborne/Chains/Sizzling Wound/PerceptionBlockingMask/
      // BlackSilence (Struggling) đều là boolean theo mô tả gốc (không nêu số
      // stack/max nào).
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const FLAG_FIELD_MAP = {
        airborne: "airborne", chains: "chains", sizzlingwound: "sizzlingWound",
        perceptionblockingmask: "perceptionBlockingMask", blacksilence: "blackSilence",
        tremorscorch: "tremorScorch", tremorhemorrhage: "tremorHemorrhage",
        burningsensation: "burningSensation",
        contemptofthegaze: "contemptOfTheGaze",
        busyastribbie: "busyAsTribbie",
        timemoratorium: "timeMoratorium",
      };
      const entries = Object.keys(FLAG_FIELD_MAP).filter(k => kv[k] !== undefined).map(k => ({ key: k, raw: (kv[k] ?? "").trim().toLowerCase() }));
      if (!targetRaw || entries.length === 0) {
        message.reply(`⚠️ Cú pháp: \`-encounter setflag target: <key/userId/me> <flag>: on/off\`\n> Flag hợp lệ: ${Object.keys(FLAG_FIELD_MAP).join("/")}\n> VD: \`-encounter setflag target: mo airborne: on\`\n> Busy as Tribbie cần thêm \`source: <key enemy hoặc mention player>\` để biết "người buff nó".`);
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          const sourceRaw = (kv["source"] ?? "").trim();
          const changes = [];
          for (const { key, raw } of entries) {
            if (raw !== "on" && raw !== "off") throw new Error(`\`${key}:\` phải là "on" hoặc "off".`);
            const field = FLAG_FIELD_MAP[key];
            resolved.combatant[field] = raw === "on";
            // Chains: "(1 Turn)" — set Duration khi bật.
            if (key === "chains" && raw === "on") resolved.combatant.chainsTurnsLeft = 1;
            // Time Moratorium: "sau 3 turn" — set Duration khi bật.
            if (key === "timemoratorium" && raw === "on") resolved.combatant.timeMoratoriumTurnsLeft = 3;
            // Busy as Tribbie: cần source: để biết "người buff nó" (ai bị FUA phản
            // công) — GIẢ ĐỊNH FUA nhắm vào chính target (xem combatant-factory.js).
            if (key === "busyastribbie" && raw === "on") {
              if (!sourceRaw) throw new Error(`Dùng "busyastribbie: on" cần kèm "source: <key enemy hoặc mention player>".`);
              const sourceEnemyKey = normalizeEnemyKey(sourceRaw);
              resolved.combatant.busyAsTribbieSourceId = encounter.enemies[sourceEnemyKey] ? sourceEnemyKey : sourceRaw.replace(/[<@!>]/g, "");
            }
            changes.push(`${key}: **${raw}**`);
          }
          appendActionLog(encounter, `📊 ${resolved.label}: setflag ${changes.join(", ")}`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ ${resolved.label}: ${changes.join(", ")}`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "reload") {
      // Ammo system (xác nhận trực tiếp): "Nhận được thông qua hành động Reload, 1
      // turn có thể Reload bao nhiêu tùy ý, nhưng sẽ tiêu hao số đạn trong
      // Inventory của bạn mỗi khi Reload." — chuyển đạn từ Inventory (persistent,
      // profileData.items) sang stack Encounter (combatant field), KHÔNG giới hạn
      // số lần gọi/turn (mỗi lần tự trừ đúng Inventory hiện có).
      const kv = parseKeyValues(rest);
      const amount = parseInt(kv["amount"] ?? "1", 10);
      const typeRaw = (kv["type"] ?? "ammo").trim().toLowerCase();
      const AMMO_ITEM_MAP = { ammo: { item: "Ammo", field: "ammo" }, frost: { item: "Frost Ammo", field: "frostAmmo" }, incendiary: { item: "Incendiary Ammo", field: "incendiaryAmmo" } };
      const ammoType = AMMO_ITEM_MAP[typeRaw];
      if (!Number.isFinite(amount) || amount < 1 || !ammoType) {
        message.reply(`⚠️ Cú pháp: \`-encounter reload amount: <số> type: ammo/frost/incendiary\` (mặc định type: ammo nếu bỏ trống)\n> VD: \`-encounter reload amount: 5\` hoặc \`-encounter reload amount: 2 type: frost\``);
        return;
      }
      try {
        // Bước 1: trừ Inventory (persistent, lock RIÊNG theo user — KHÔNG lồng
        // trong lock encounter để tránh deadlock nếu 2 lock khác thứ tự ở nơi khác).
        let actualAmount = 0;
        await withLock(message.author.id, async () => {
          const { data: profileData, slot } = await getPlayerDataWithSlot(message.author.id);
          const owned = profileData.items?.[ammoType.item] ?? 0;
          actualAmount = Math.min(amount, owned);
          if (actualAmount <= 0) throw new Error(`Không còn **${ammoType.item}** nào trong Inventory để Reload.`);
          profileData.items[ammoType.item] = owned - actualAmount;
          if (profileData.items[ammoType.item] <= 0) delete profileData.items[ammoType.item];
          await savePlayerData(message.author.id, profileData, slot);
        });
        // Bước 2: cộng vào stack Encounter (lock riêng của encounter).
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const player = encounter.players[message.author.id];
          if (!player) throw new Error("Bạn chưa tham gia encounter này.");
          const before = player[ammoType.field] ?? 0;
          player[ammoType.field] = Math.min(AMMO_MAX, before + actualAmount);
          appendActionLog(encounter, `🔫 <@${message.author.id}>: reload ${ammoType.item} +${actualAmount} (${before} → ${player[ammoType.field]})`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`🔫 Reload **${ammoType.item}**: +${actualAmount} (từ Inventory) → đang có **${player[ammoType.field]}** trong Encounter.`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "unbuff" || sub === "undebuff") {
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const index = parseInt(kv["index"] ?? "", 10);
      if (!targetRaw || !Number.isFinite(index) || index < 1) {
        message.reply(`⚠️ Cú pháp: \`-encounter ${sub} target: <key/userId/me> index: <số thứ tự trong -encounter status, bắt đầu từ 1>\``);
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = targetRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, ""));
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          const listKey = sub === "unbuff" ? "buffs" : "debuffs";
          const list = resolved.combatant[listKey] ?? [];
          if (index > list.length) throw new Error(`${resolved.label} chỉ có ${list.length} ${listKey === "buffs" ? "buff" : "debuff"} — không có #${index}.`);
          const removed = list.splice(index - 1, 1)[0];
          appendActionLog(encounter, `${listKey === "buffs" ? "🟢" : "🔴"} Đã xoá ${listKey === "buffs" ? "buff" : "debuff"} của ${resolved.label}: "${removed.text}"`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ Đã xoá ${listKey === "buffs" ? "🟢 buff" : "🔴 debuff"} #${index} của ${resolved.label}: "${removed.text}"`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── healinjury: GM xoá 1 chấn thương đã chữa khỏi (admin only — chấn thương là
    // hậu quả thật trong game, chỉ GM mới xác nhận đã chữa lành).
    if (sub === "healinjury") {
      if (!isAdmin) { message.reply("⚠️ Chỉ admin/GM mới xoá được chấn thương."); return; }
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const index = parseInt(kv["index"] ?? "", 10);
      if (!targetRaw || !Number.isFinite(index) || index < 1) {
        message.reply("⚠️ Cú pháp: `-encounter healinjury target: <key/userId> index: <số thứ tự trong -encounter status, bắt đầu từ 1>`");
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const targetId = encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, "");
          const resolved = resolveCombatant(encounter, targetId);
          if (!resolved) throw new Error(`Không tìm thấy "${targetRaw}" trong encounter.`);
          const list = resolved.combatant.injuries ?? [];
          if (index > list.length) throw new Error(`${resolved.label} chỉ có ${list.length} chấn thương — không có #${index}.`);
          const removed = list.splice(index - 1, 1)[0];
          restoreInjuryMaxHp(resolved.combatant, removed);
          if (resolved.type === "player") {
            try {
              const { data: injSyncData, slot: injSyncSlot } = await getPlayerDataWithSlot(targetId);
              injSyncData.injuries = [...(resolved.combatant.injuries ?? [])];
              await savePlayerData(targetId, injSyncData, injSyncSlot);
            } catch { /* không chặn lệnh chính nếu sync lỗi */ }
          }
          appendActionLog(encounter, `🩹 Đã chữa khỏi chấn thương của ${resolved.label}: "${removed}"`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`✅ Đã chữa khỏi chấn thương #${index} của ${resolved.label}: "${removed}"`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }


    if (sub === "end") {
      const encounter = await getEncounter(encChannelId);
      if (!encounter) { message.reply("⚠️ Channel này chưa có encounter nào."); return; }
      if (!isAdmin && message.author.id !== encounter.gmId) { message.reply("⚠️ Chỉ GM tạo encounter này (hoặc admin khác) mới được kết thúc."); return; }
      // BUG ĐÃ SỬA: trước đây xoá actionLog VĨNH VIỄN ngay khi end, không có cách
      // nào lấy lại lịch sử trận đấu sau đó — giờ tự động gửi TOÀN BỘ actionLog
      // (giống `-encounter log turn: all`) NGAY TRƯỚC KHI xoá, để GM còn cơ hội lưu
      // lại nếu cần (copy/paste, hoặc Discord tự lưu lịch sử chat).
      const fullLog = encounter.actionLog ?? [];
      if (fullLog.length > 0) {
        const lines = [];
        let lastTurn = null;
        for (const entry of fullLog) {
          if (entry.turn !== lastTurn) { lines.push(`\n**── Turn ${entry.turn} ──**`); lastTurn = entry.turn; }
          const icon = getActionLogIcon(entry.type);
          for (const l of entry.lines) lines.push(`${icon} ${l}`);
        }
        const chunks = [];
        let current = "";
        for (const line of lines) {
          if ((current + "\n" + line).length > 3900) { chunks.push(current); current = line; }
          else current = current ? current + "\n" + line : line;
        }
        if (current) chunks.push(current);
        const logEmbeds = chunks.slice(0, 10).map((c, i) => ({
          title: i === 0 ? `📜 Toàn bộ Action Log — ${encounter.name} (trước khi kết thúc)` : `📜 Action Log (tiếp ${i + 1})`,
          description: c || "*(trống)*",
          color: 0x95a5a6,
        }));
        await message.channel.send({ embeds: logEmbeds }).catch(() => {});
      }
      await deleteEncounter(encChannelId);
      message.reply(`✅ Đã kết thúc encounter **${encounter.name}**.${fullLog.length > 0 ? ` (Đã gửi lại toàn bộ ${fullLog.length} entry log ở trên trước khi xoá.)` : ""}`);
      return;
    }

    if (sub === "endturn") {
      try {
        const { encounter, shroudedNotes, prescriptNotes } = await performEndTurn(encChannelId, message.author.id, isAdmin);
        await message.reply({
          content: `🔄 **Hết turn** — hồi ${ENCOUNTER_STAMINA_REGEN_PER_TURN} Stamina (trừ ai đang Stagger), đếm ngược Stagger/Panic.` +
            (shroudedNotes.length > 0 ? `\n> ${shroudedNotes.join(", ")}` : "") +
            (prescriptNotes.length > 0 ? `\n${prescriptNotes.map(n => `> ${n}`).join("\n")}` : "") +
            `\n> 🎲 Thứ tự Turn mới:\n${buildTurnOrderText(encounter)}`,
          embeds: [buildEncounterBoardEmbed(encounter)],
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── hit: dùng Page/Skill (Light cost) lên 1 hoặc nhiều enemy (AOE qua target:
    // mo,arnold hoặc target: all) — KHÔNG tự trừ Stamina (Page tốn Light, tự khai
    // báo riêng). Thêm vào hàng chờ pendingActions, KHÔNG còn confirm ngay từng cái.
    if (sub === "hit") {
      const kv = parseKeyValues(rest);
      const dmgStr = kv["dmg"] ?? "";
      const targetStr = kv["target"] ?? "";
      if (!dmgStr.trim() || !targetStr.trim()) {
        message.reply(
          "⚠️ Cú pháp: `-encounter hit target: <key hoặc key1,key2 hoặc all> dmg: <công thức>`\n" +
          "> VD: `-encounter hit target: mo dmg: 50x2B+2Sinking res: 1.5xB bonus: 20`\n" +
          "> VD AOE: `-encounter hit target: mo,arnold dmg: 30Bx2`\n" +
          "> Tùy chọn `skill: <tên skill>` (tự roll thật + check cooldown + tự tính Emotion Coin) hoặc `ref: <link message>` (tham chiếu roll đã có) để GM dễ verify."
        );
        return;
      }
      const bonusPct = parseFloat((kv["bonus"] ?? "0").replace("%", ""));
      const sanityBonusPct = parseFloat((kv["sanitybonus"] ?? "0").replace("%", ""));
      // KHÔNG default "1" — để undefined nếu người dùng không gõ critmul:, vậy
      // doPlayerHit mới biết đây là "không gõ tay" và rơi về perkCtx.critMul (mặc
      // định 1.3x đúng luật) thay vì ép cứng về 1 (bug cũ, xem comment ở doPlayerHit).
      const critMul = kv["critmul"] ? parseFloat(kv["critmul"].replace("x", "")) : undefined;
      const diceMul = parseFloat((kv["dicemul"] ?? "1").replace("x", ""));
      if (isNaN(bonusPct) || isNaN(sanityBonusPct) || (critMul !== undefined && isNaN(critMul)) || isNaN(diceMul)) {
        message.reply("❌ bonus/sanitybonus/critmul/dicemul phải là số.");
        return;
      }
      const critDivStr = (kv["critdiv"] ?? "").trim().toLowerCase();
      let critDiv = 0;
      if (critDivStr === "yes" || critDivStr === "true" || critDivStr === "1") critDiv = 2;
      else { const p = parseFloat(critDivStr); if (!isNaN(p) && p > 1) critDiv = p; }

      try {
        const { embed, skillRollEmbed } = await doPlayerHit(encChannelId, message.author.id, message.author.toString(), dmgStr, targetStr, {
          resStr: kv["res"] ?? "", drStr: kv["dr"] ?? "", bonusPct, sanityBonusPct, critMul, diceMul, critDiv,
          skill: kv["skill"], ref: kv["ref"], coin: kv["coin"], tags: kv["tags"], loadtype: kv["loadtype"],
        });
        await message.reply({ embeds: skillRollEmbed ? [skillRollEmbed, embed] : [embed] });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── attack: M1 (đánh thường) lên 1 hoặc nhiều enemy — tự TÍNH Stamina cần, trừ
    // thật lúc GM confirmall (không trừ lúc declare — reject không mất Stamina oan).
    if (sub === "attack") {
      const kv = parseKeyValues(rest);
      const dmgStr = kv["dmg"] ?? "";
      const targetStr = kv["target"] ?? "";
      // GAP ĐÃ SỬA HOÀN TOÀN LẦN THỨ 3 — không còn "volleys:" nữa (Eye Of Horus
      // giờ hoàn toàn tự động theo per-target hit counter) — chỉ cần targetStr,
      // dmgStr có thể để trống nếu đang dùng Eye Of Horus (doPlayerAttack tự
      // kiểm tra weaponName và quyết định có bắt buộc dmg hay không).
      if (!targetStr.trim()) {
        message.reply(
          "⚠️ Cú pháp: `-encounter attack target: <key hoặc key1,key2 hoặc all> dmg: <công thức>` (M1 — tự trừ Stamina theo vũ khí của bạn).\n" +
          "> VD: `-encounter attack target: mo dmg: 20B`\n" +
          "> Đang dùng Eye Of Horus? Bỏ trống `dmg:` — hệ thống tự tính hoàn toàn theo số lần đã đánh target đó trong turn (VD: `-encounter attack target: mo`).\n" +
          "> Tùy chọn `skill: <tên skill>` hoặc `ref: <link message>` để GM dễ verify."
        );
        return;
      }
      try {
        const { embed, skillRollEmbed } = await doPlayerAttack(encChannelId, message.author.id, message.author.toString(), dmgStr, targetStr, {
          skill: kv["skill"], ref: kv["ref"], coin: kv["coin"], tags: kv["tags"], ammotype: kv["ammotype"], usebullet: kv["usebullet"],
        });
        await message.reply({ embeds: skillRollEmbed ? [skillRollEmbed, embed] : [embed] });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── enemyattack: GM cho 1 enemy đánh 1 hoặc nhiều player (AOE qua target:
    // <id1>,<id2> hoặc target: all).
    if (sub === "enemyattack") {
      const kv = parseKeyValues(rest);
      const enemyKey = kv["key"] ?? "";
      const dmgStr = kv["dmg"] ?? "";
      const targetStr = kv["target"] ?? (message.mentions.users.first()?.id ?? "");
      if (!enemyKey.trim() || !dmgStr.trim() || !targetStr.trim()) {
        message.reply(
          "⚠️ Cú pháp: `-encounter enemyattack key: <enemy key> target: <@player hoặc all> dmg: <công thức>`\n" +
          "> VD: `-encounter enemyattack key: mo target: all dmg: 20x3P` (AOE cả party)\n" +
          "> Tùy chọn `skill: <tên skill>` hoặc `ref: <link message>`."
        );
        return;
      }
      try {
        const { embed, skillRollEmbed } = await doEnemyAttack(encChannelId, message.author.id, enemyKey, dmgStr, targetStr, {
          skill: kv["skill"], ref: kv["ref"], coin: kv["coin"], tags: kv["tags"],
        });
        await message.reply({ embeds: skillRollEmbed ? [skillRollEmbed, embed] : [embed] });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // ── followup: Follow-Up (Wrath, [10~14] Blunt + Airborne) HOẶC Pounce (Sloth,
    // [8~30] Blunt) — 2 perk LOẠI TRỪ NHAU (không ai có cả 2), điều kiện kích hoạt
    // GIỐNG NHAU: turn này đã tiêu ≥20 Stamina qua đánh thường, CHỈ 1 LẦN/turn.
    // followup/overcharge (LỆNH TEXT) ĐÃ GỠ (xác nhận trực tiếp: dropdown option
    // "followup"/"overcharge" trong encmenu đã gọi ĐÚNG performFollowUp/
    // performOvercharge, không cần lệnh text riêng nữa).

    // guard/evade/parry (LỆNH TEXT CHỦ ĐỘNG) ĐÃ BỊ GỠ BỎ (xác nhận trực tiếp:
    // "nghĩ nên bỏ hẳn... vì đã sử dụng hệ thống guard mới rồi") — hệ thống
    // Reactive Defense (tự động hiện prompt Guard/Evade/Parry ngay khi bị tấn
    // công) đã thay thế hoàn toàn nhu cầu tự xây charge trước qua lệnh text.
    // performGuardEvade/performParry vẫn giữ nguyên (dùng chung bởi reactive
    // prompt handler "encreactivedef:") — chỉ gỡ 2 ĐIỂM VÀO qua lệnh text này.

    // ── clash: so dice ĐẦU TIÊN của 2 skill (luôn lấy Dice đầu, theo luật) — ai cao
    // hơn thắng. Thắng: +10 Sanity +2 Emotion Coin. Thua: -10 Sanity -1 Coin. Huề:
    // +1 Coin mỗi bên, Sanity không đổi. Quyền clash theo thứ tự turn ("người đi
    // trước clash được người đi sau, không ngược lại — và có thể clash HỘ cho người
    // khác") — check qua encounter.turnOrder nếu ĐÃ roll (xem -encounter rollspeed);
    // nếu chưa roll thì bỏ qua check này (không ép phải roll Speed trước mới clash
    // được — Speed là tính năng riêng, không phải điều kiện bắt buộc của Clash).
    // shinmang (LỆNH TEXT) ĐÃ GỠ (xác nhận trực tiếp: dropdown option "shinmang"
    // trong encmenu đã gọi ĐÚNG performShinMang, không cần lệnh text riêng nữa).

    // ── additem: mang 1 Consumable Item vào trận (tối đa 4 — luật "1 trận chỉ
    // được mang 4 item hồi phục") — CHỈ kiểm tra player ĐANG sở hữu đủ trong
    // inventory (chưa trừ thật, chỉ "đăng ký" sẽ mang) — trừ THẬT lúc -encounter
    // useitem. Có thể mang nhiều cái CÙNG TÊN (VD 2 Potion) miễn ≤4 slot tổng.
    if (sub === "additem") {
      const itemNameRaw = rest.trim();
      if (!itemNameRaw) { message.reply("⚠️ Cú pháp: `-encounter additem <tên item>` (tối đa 4 item/trận)."); return; }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const player = encounter.players[message.author.id];
          if (!player) throw new Error("Bạn chưa tham gia encounter này.");
          player.consumablesLoadout = player.consumablesLoadout ?? [];
          if (player.consumablesLoadout.length >= 4) throw new Error("Đã mang đủ 4 item — không thể mang thêm (luật: tối đa 4 item/trận).");
          const profileData = await getPlayerData(message.author.id);
          const itemName = findItem(itemNameRaw) ?? (profileData.items?.[itemNameRaw] > 0 ? itemNameRaw : null);
          if (!itemName) throw new Error(`Không tìm thấy item "${itemNameRaw}" trong inventory của bạn.`);
          const ownedCount = profileData.items?.[itemName] ?? 0;
          const alreadyBrought = player.consumablesLoadout.filter(n => n === itemName).length;
          if (alreadyBrought >= ownedCount) throw new Error(`Bạn chỉ có ${ownedCount}× **${itemName}** trong inventory — đã mang đủ số đó vào trận rồi.`);
          player.consumablesLoadout.push(itemName);
          appendActionLog(encounter, `🎒 <@${message.author.id}> mang **${itemName}** vào trận (${player.consumablesLoadout.length}/4).`);
          await saveEncounter(encChannelId, encounter);
          message.reply(`🎒 Đã mang **${itemName}** vào trận (${player.consumablesLoadout.length}/4 slot item).`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (sub === "useitem") {
      const itemNameRaw = rest.trim();
      if (!itemNameRaw) { message.reply("⚠️ Cú pháp: `-encounter useitem <tên item>` (chỉ item đã mang vào trận qua `-encounter additem`, tối đa 1 lần/turn)."); return; }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");
          const player = encounter.players[message.author.id];
          if (!player) throw new Error("Bạn chưa tham gia encounter này.");
          if (player.usedItemThisTurn) throw new Error("Đã dùng 1 item trong turn này rồi — chỉ được dùng 1 lần/turn.");
          const itemName = findItem(itemNameRaw) ?? itemNameRaw;
          const idx = (player.consumablesLoadout ?? []).findIndex(n => n.toLowerCase() === itemName.toLowerCase());
          if (idx === -1) throw new Error(`"${itemNameRaw}" không có trong số item đã mang vào trận — dùng \`-encounter additem\` trước (xem hiện tại bằng \`-encounter status\`).`);
          const actualName = player.consumablesLoadout[idx];
          // K-Corp Ampule — item ĐẶC BIỆT DUY NHẤT chữa được injury TRONG encounter
          // (xác nhận trực tiếp từ GM): "Lập tức hồi 100% Máu. Chữa toàn bộ Injuries
          // ngay lập tức. Dùng 2 cái liên tục trong 1 Encounter sẽ gây chết ngay lập
          // tức (cd 2 turn). Giá: 1 triệu Ahn." — CD 2 turn RIÊNG của item này (khác
          // "usedItemThisTurn" chung 1/turn cho MỌI item), và dùng LẦN THỨ 2 trong
          // CÙNG 1 encounter (dù đã hết CD hay chưa) → CHẾT NGAY (Death Penalty/
          // Permadeath như chết bình thường), KHÔNG hồi máu/chữa gì nữa.
          const isKCorpAmpule = actualName.toLowerCase() === "k-corp ampule";
          // 4 item consumable đơn giản khác (xác nhận trực tiếp từ GM, giá Ahn chỉ
          // mang tính THAM KHẢO — hệ thống hiện chưa có cơ chế "mua" item bằng Ahn,
          // items chỉ được GM cấp qua -setplayer items:, nên KHÔNG trừ Ahn ở đây).
          const isChuoi = actualName.toLowerCase() === "chuối";
          const isTao = actualName.toLowerCase() === "táo";
          const isDuaHau = actualName.toLowerCase() === "dưa hấu";
          const isMedkit = actualName.toLowerCase() === "medkit";
          if (isKCorpAmpule && (player.kCorpAmpuleCooldownLeft ?? 0) > 0) {
            throw new Error(`K-Corp Ampule đang trong CD — còn ${player.kCorpAmpuleCooldownLeft} turn nữa mới dùng lại được.`);
          }
          const { data: profileData, slot } = await getPlayerDataWithSlot(message.author.id);
          const owned = profileData.items?.[actualName] ?? 0;
          if (owned < 1) throw new Error(`Inventory không còn **${actualName}** để dùng (đã bị tiêu/mất từ trước).`);
          profileData.items[actualName] = owned - 1;
          if (profileData.items[actualName] <= 0) delete profileData.items[actualName];
          await savePlayerData(message.author.id, profileData, slot);
          player.consumablesLoadout.splice(idx, 1);
          player.usedItemThisTurn = true;
          let effectNote = "";
          if (isKCorpAmpule) {
            player.kCorpAmpuleUsesThisEncounter = (player.kCorpAmpuleUsesThisEncounter ?? 0) + 1;
            player.kCorpAmpuleCooldownLeft = 2;
            if (player.kCorpAmpuleUsesThisEncounter >= 2) {
              // Dùng lần 2 trong CÙNG encounter → CHẾT NGAY, bất kể HP/injury hiện
              // tại — dùng CHUNG applyDeathPenalty với cái chết combat bình thường.
              const wasAliveBeforeKCorp = player.currentHp > 0;
              player.currentHp = 0;
              if (wasAliveBeforeKCorp) {
                for (const otherPid of Object.keys(encounter.players)) {
                  if (otherPid === message.author.id) continue;
                  applyEmotionDelta(encounter.players[otherPid], 5);
                }
                const deathNote = await applyDeathPenalty(encounter, message.author.id);
                effectNote = ` ☠️ **DÙNG LẦN 2 TRONG CÙNG ENCOUNTER — CHẾT NGAY LẬP TỨC!**${deathNote}`;
              }
            } else {
              // Lần dùng ĐẦU TIÊN — hồi đầy HP + chữa TOÀN BỘ injury (kể cả maxHp
              // penalty từ Gãy Xương/Vết thương lớn được khôi phục đầy đủ).
              for (const inj of player.injuries ?? []) restoreInjuryMaxHp(player, inj);
              player.injuries = [];
              player.currentHp = player.maxHp;
              // Sync injury đã chữa sạch về profile NGAY (giống mọi lần chữa injury
              // khác trong trận).
              try {
                const { data: injSyncData, slot: injSyncSlot } = await getPlayerDataWithSlot(message.author.id);
                injSyncData.injuries = [];
                await savePlayerData(message.author.id, injSyncData, injSyncSlot);
              } catch { /* không chặn action chính nếu sync lỗi */ }
              effectNote = ` 💊 Hồi ĐẦY HP (${player.currentHp}/${player.maxHp}) + Chữa TOÀN BỘ injury! (CD 2 turn — dùng lần 2 trong trận này sẽ CHẾT NGAY.)`;
            }
          } else if (isChuoi) {
            // Chuối: hồi phục 10 HP, cap tại maxHp.
            const before = player.currentHp;
            player.currentHp = Math.min(player.maxHp, player.currentHp + 10);
            effectNote = ` 🍌 +${(player.currentHp - before).toFixed(0)} HP (${player.currentHp}/${player.maxHp}).`;
          } else if (isTao) {
            // Táo: giảm 1 Dmg/hit phải nhận tới hết turn hiện tại — set cờ, logic
            // trừ dmg THẬT nằm ở nhánh xử lý damage (xem comment "Táo (item)" gần
            // target.currentHp -= finalDmg).
            player.appleDmgReductionActive = true;
            effectNote = ` 🍎 Giảm 1 Dmg/hit phải nhận tới hết turn này.`;
          } else if (isDuaHau) {
            // Dưa hấu: hồi phục 20 Stamina, cap tại maxStamina.
            const before = player.currentStamina;
            player.currentStamina = Math.min(player.maxStamina, player.currentStamina + 20);
            effectNote = ` 🍉 +${(player.currentStamina - before).toFixed(0)} Stamina (${player.currentStamina}/${player.maxStamina}).`;
          } else if (isMedkit) {
            // Medkit: CHỈ chữa chấn thương NHẸ (Gãy tay/Gãy chân/Gãy Xương) —
            // KHÔNG chữa chấn thương NẶNG (Mất tay/Mất Chân/Vết thương lớn), khác
            // hẳn K-Corp Ampule (chữa TẤT CẢ). Chữa TOÀN BỘ chấn thương nhẹ đang
            // mang cùng lúc (không chỉ 1 cái).
            const before = [...(player.injuries ?? [])];
            const healedMinor = before.filter(inj => MINOR_INJURIES.some(m => inj.startsWith(m)));
            if (healedMinor.length === 0) {
              effectNote = ` 🩹 Không có chấn thương nhẹ nào để chữa (Medkit KHÔNG chữa được chấn thương nặng).`;
            } else {
              player.injuries = before.filter(inj => !MINOR_INJURIES.some(m => inj.startsWith(m)));
              for (const inj of healedMinor) restoreInjuryMaxHp(player, inj);
              try {
                const { data: injSyncData, slot: injSyncSlot } = await getPlayerDataWithSlot(message.author.id);
                injSyncData.injuries = [...player.injuries];
                await savePlayerData(message.author.id, injSyncData, injSyncSlot);
              } catch { /* không chặn action chính nếu sync lỗi */ }
              effectNote = ` 🩹 Đã chữa ${healedMinor.length} chấn thương nhẹ: ${healedMinor.join(", ")}. (Chấn thương nặng KHÔNG được chữa bởi Medkit.)`;
            }
          }
          appendActionLog(encounter, `🧪 <@${message.author.id}> dùng **${actualName}**.${effectNote}`);
          await saveEncounter(encChannelId, encounter);
          const isKnownItemWithEffect = isKCorpAmpule || isChuoi || isTao || isDuaHau || isMedkit;
          message.reply(`🧪 ${message.author} đã dùng **${actualName}**!${effectNote}${!isKnownItemWithEffect ? " (Trừ khỏi inventory — hiệu ứng hồi phục cụ thể do GM tự xác định/narrate, hệ thống chỉ enforce giới hạn mang/dùng.)" : ""}`);
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // manifestego (LỆNH TEXT) ĐÃ GỠ (xác nhận trực tiếp: dropdown option
    // "manifestego" trong encmenu đã gọi ĐÚNG performManifestEgo, không cần lệnh
    // text riêng nữa). Logic performManifestEgo vẫn giữ nguyên, chỉ gỡ điểm vào.

    // -encounter bossmenu key: <enemy> — hiện dropdown điều khiển boss (theo yêu
    // cầu trực tiếp: "phần encounter của boss cần 1 lệnh UI"). Chỉ GM/admin dùng
    // được (điều khiển enemy vốn đã giới hạn GM-only trong mọi lệnh liên quan).
    if (sub === "gmpanel") {
      // GM Control Panel (xác nhận trực tiếp): bảng điều khiển TỔNG QUÁT cho GM —
      // chọn enemy từ dropdown, sau đó hiện panel Attack/Guard/Evade/Parry (tái
      // dùng NGUYÊN buildBossActionPanel đã có sẵn cho bossmenu). Có thể gọi từ
      // kênh GM riêng (sau khi đã `-encounter linkgm`) hoặc ngay tại kênh encounter.
      // GAP ĐÃ SỬA (xác nhận trực tiếp): "gm có thể chỉnh sửa BẤT CỨ THỨ GÌ trong
      // encounter... điều khiển, add, edit enemy, status hoặc làm điều tương tự
      // với player" — mở rộng thêm: dropdown enemy giờ dẫn tới màn hình chọn
      // "⚔️ Điều khiển" HAY "✏️ Chỉnh sửa" (thay vì luôn thẳng vào Attack panel);
      // thêm dropdown player để chỉnh sửa TƯƠNG TỰ; thêm nút "➕ Add Enemy".
      try {
        const encounter = await getEncounter(encChannelId);
        if (!encounter) throw new Error("Channel này chưa có encounter nào — dùng `-encounter start` trước (hoặc `-encounter linkgm` nếu đang ở kênh điều khiển riêng).");
        const isAdmin = ADMIN_IDS.has(message.author.id);
        if (!isAdmin && message.author.id !== encounter.gmId) throw new Error("Chỉ GM/admin mới mở được bảng điều khiển.");
        const aliveEnemies = Object.entries(encounter.enemies).filter(([, e]) => e.currentHp > 0);
        const alivePlayers = Object.entries(encounter.players).filter(([, p]) => p.currentHp > 0);
        const components = [];
        if (aliveEnemies.length > 0) {
          const enemyOptions = aliveEnemies.map(([ekey, e]) =>
            new StringSelectMenuOptionBuilder().setLabel(`👹 ${e.name} (${ekey}) — ${e.currentHp}/${e.maxHp} HP`).setValue(ekey)
          );
          components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`gmpanelselect:${encChannelId}:${message.author.id}`)
              .setPlaceholder("Chọn enemy (điều khiển hoặc chỉnh sửa)...")
              .addOptions(...enemyOptions.slice(0, 25)),
          ));
        }
        if (alivePlayers.length > 0) {
          const playerOptions = alivePlayers.map(([pid, p]) =>
            new StringSelectMenuOptionBuilder().setLabel(`🧑 ${p.name} — ${p.currentHp}/${p.maxHp} HP`).setValue(pid)
          );
          components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`gmpanelplayerselect:${encChannelId}:${message.author.id}`)
              .setPlaceholder("Chọn player để chỉnh sửa...")
              .addOptions(...playerOptions.slice(0, 25)),
          ));
        }
        // Turn Order Enforcement UX (xác nhận trực tiếp): nút LUÔN sẵn có,
        // không cần đợi hết vòng turnOrder mới thấy — GM có thể chủ động kết
        // thúc sớm hoặc xem trạng thái bất cứ lúc nào từ bảng điều khiển.
        components.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`encendturn:${encChannelId}:${encounter.gmId}`).setLabel("🔄 Kết thúc Turn").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`gmpanelstatus:${encChannelId}:${message.author.id}`).setLabel("📊 Xem trạng thái").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`gmpaneladdenemy:${encChannelId}:${message.author.id}`).setLabel("➕ Add Enemy").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`gmpanelquickstatus:${encChannelId}:${message.author.id}`).setLabel("🎯 Set Status (chọn nhanh)").setStyle(ButtonStyle.Secondary),
        ));
        message.reply({
          embeds: [{
            title: `🎛️ Bảng điều khiển GM — ${encounter.name}`,
            description: `Turn **${encounter.turnNumber ?? 1}** | ${aliveEnemies.length} enemy còn sống | ${alivePlayers.length} player còn sống.` +
              (aliveEnemies.length === 0 ? "\n*(Chưa có enemy nào — dùng nút ➕ Add Enemy bên dưới.)*" : ""),
            color: 0x9b59b6,
          }],
          components,
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }
    if (sub === "bossmenu") {
      const kv = parseKeyValues(rest);
      const enemyKeyRaw = (kv["key"] ?? "").trim();
      if (!enemyKeyRaw) {
        message.reply("⚠️ Cú pháp: `-encounter bossmenu key: <enemy>` (VD: `-encounter bossmenu key: mo`)");
        return;
      }
      try {
        const encounter = await getEncounter(encChannelId);
        if (!encounter) throw new Error("Channel này chưa có encounter nào.");
        const isAdmin = ADMIN_IDS.has(message.author.id);
        if (!isAdmin && message.author.id !== encounter.gmId) throw new Error("Chỉ GM/admin mới điều khiển được enemy.");
        const ekey = normalizeEnemyKey(enemyKeyRaw);
        const enemy = encounter.enemies[ekey];
        if (!enemy) throw new Error(`Không tìm thấy enemy "${enemyKeyRaw}" — dùng \`-encounter status\` để xem danh sách.`);
        message.reply({
          embeds: [{ title: `👹 Điều khiển: ${enemy.name} (${ekey})`, description: "Chọn hành động từ dropdown bên dưới.", color: 0xe74c3c }],
          components: buildBossActionPanel(encChannelId, ekey, message.author.id),
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }
    if (sub === "clash") {
      const kv = parseKeyValues(rest);
      const targetRaw = (kv["target"] ?? "").trim();
      const mySkillRaw = (kv["skill"] ?? "").trim();
      const oppSkillRaw = (kv["oppskill"] ?? "").trim();
      const forRaw = (kv["for"] ?? "").trim(); // clash HỘ cho ai — mặc định là chính người gõ lệnh
      if (!targetRaw || !mySkillRaw || !oppSkillRaw) {
        message.reply(
          "⚠️ Cú pháp: `-encounter clash target: <key/userId đối thủ> skill: <skill của bên mình> oppskill: <skill của đối thủ>`\n" +
          "> Tùy chọn `for: <key/userId>` nếu clash HỘ cho người khác (mặc định là chính bạn).\n" +
          "> Bot tự roll CẢ 2 skill thật, so Dice đầu tiên — ai cao hơn thắng."
        );
        return;
      }
      try {
        await withLock(encounterKey(encChannelId), async () => {
          const encounter = await getEncounter(encChannelId);
          if (!encounter) throw new Error("Channel này chưa có encounter nào.");

          const forId = forRaw ? (forRaw.toLowerCase() === "me" ? message.author.id : (encounter.enemies[normalizeEnemyKey(forRaw)] ? normalizeEnemyKey(forRaw) : forRaw.replace(/[<@!>]/g, ""))) : message.author.id;
          const forResolved = resolveCombatant(encounter, forId);
          if (!forResolved) throw new Error(`Không tìm thấy "${forRaw || "bạn"}" trong encounter.`);
          const targetId = encounter.enemies[normalizeEnemyKey(targetRaw)] ? normalizeEnemyKey(targetRaw) : targetRaw.replace(/[<@!>]/g, "");
          const targetResolved = resolveCombatant(encounter, targetId);
          if (!targetResolved) throw new Error(`Không tìm thấy đối thủ "${targetRaw}" trong encounter.`);

          // Quyền ưu tiên theo thứ tự turn — CHỈ check nếu đã rollspeed (turnOrder tồn tại).
          if ((encounter.turnOrder ?? []).length > 0) {
            const forPos = encounter.turnOrder.findIndex(e => e.id === forId);
            const targetPos = encounter.turnOrder.findIndex(e => e.id === targetId);
            if (forPos !== -1 && targetPos !== -1 && forPos > targetPos) {
              throw new Error(`${forResolved.label} đi SAU ${targetResolved.label} trong thứ tự turn — không thể clash người đi trước mình.`);
            }
          }

          const mySkill = findSkill(mySkillRaw);
          if (!mySkill) throw new Error(`Không tìm thấy skill "${mySkillRaw}".`);
          if (mySkill.promptArg) throw new Error(`Skill "${mySkill.name}" cần input đặc biệt — chưa hỗ trợ clash trực tiếp qua lệnh này.`);
          const oppSkill = findSkill(oppSkillRaw);
          if (!oppSkill) throw new Error(`Không tìm thấy skill "${oppSkillRaw}".`);
          if (oppSkill.promptArg) throw new Error(`Skill "${oppSkill.name}" cần input đặc biệt — chưa hỗ trợ clash trực tiếp qua lệnh này.`);

          const myRoll = buildSkillRollResult({ skill: mySkill });
          if (myRoll.error) throw new Error(myRoll.error);
          const oppRoll = buildSkillRollResult({ skill: oppSkill });
          if (oppRoll.error) throw new Error(oppRoll.error);
          if (myRoll.firstDiceValue === null || oppRoll.firstDiceValue === null) {
            throw new Error("Chỉ skill có Dice mới clash được — 1 trong 2 skill không có Dice nào.");
          }
          // [Unclashable] — skill nào có tag này thì KHÔNG thể bị/được Clash, bất kể
          // bên nào dùng (xác nhận trực tiếp từ GM).
          if (extractDefenseBypassTags(myRoll.embed?.description).unclashable) {
            throw new Error(`Skill "${mySkill.name}" có tag [Unclashable] — không thể dùng để Clash.`);
          }
          if (extractDefenseBypassTags(oppRoll.embed?.description).unclashable) {
            throw new Error(`Skill "${oppSkill.name}" có tag [Unclashable] — không thể dùng để Clash.`);
          }
          // Chấn thương (Gãy tay/Gãy chân/Mất Chân) trừ thẳng vào Dice dùng để clash.
          const myPenalty = getParryClashPenalty(forResolved.combatant);
          const oppPenalty = getParryClashPenalty(targetResolved.combatant);
          // Clash Attack Boost (50-Status Nhóm 1): +1 điểm Clash FLAT/stack (max 8).
          const myEffectiveDice = myRoll.firstDiceValue - myPenalty + (forResolved.combatant.clashAttackBoost ?? 0);
          const oppEffectiveDice = oppRoll.firstDiceValue - oppPenalty + (targetResolved.combatant.clashAttackBoost ?? 0);
          // GAP ĐÃ SỬA (dự án tự động hoá toàn bộ weapon/outfit) — Index
          // Proselyte's Dice 7 ("Clash với 1 skill của kẻ địch") — chỉ người
          // CHỦ ĐỘNG clash (forResolved) mới tính, không phụ thuộc thắng/thua.
          if (forResolved.type === "player") forResolved.combatant.prescriptClashed = true;

          let resultText;
          if (myEffectiveDice > oppEffectiveDice) {
            const myBefore = forResolved.combatant.currentSanity;
            applySanityGain(forResolved.combatant, 10);
            applyEmotionDelta(forResolved.combatant, 2);
            const oppBefore = targetResolved.combatant.currentSanity;
            applyClashLossSanity(targetResolved.combatant);
            applyEmotionDelta(targetResolved.combatant, -1);
            checkStaggerPanic(forResolved.combatant); checkStaggerPanic(targetResolved.combatant);
            const myDelta = forResolved.combatant.currentSanity - myBefore;
            const oppDelta = targetResolved.combatant.currentSanity - oppBefore;
            resultText = `🏆 ${forResolved.label} THẮNG Clash! (${myEffectiveDice} vs ${oppEffectiveDice}${(myPenalty || oppPenalty || forResolved.combatant.clashAttackBoost || targetResolved.combatant.clashAttackBoost) ? `, gốc ${myRoll.firstDiceValue} vs ${oppRoll.firstDiceValue}, đã áp chấn thương/Clash Attack Boost` : ""}) — ${myDelta >= 0 ? "+" : ""}${myDelta} Sanity +2 Coin cho ${forResolved.label}, ${oppDelta >= 0 ? "+" : ""}${oppDelta} Sanity -1 Coin cho ${targetResolved.label}.`;
            // Voracity (Desire, [30 Points]): thắng Clash +2 Light, chỉ 1 lần/turn.
            if (hasPerk(forResolved.combatant, "Voracity") && !forResolved.combatant.voracityUsedThisTurn) {
              forResolved.combatant.currentLight = Math.min(forResolved.combatant.maxLight, forResolved.combatant.currentLight + 2);
              forResolved.combatant.voracityUsedThisTurn = true;
              resultText += ` ✨+2 Light (Voracity) cho ${forResolved.label}.`;
            }
            // Pressure Point (Pride, [15 Points]): thắng Clash +5 Poise.
            if (hasPerk(forResolved.combatant, "Pressure Point")) {
              forResolved.combatant.poise = Math.min(99, (forResolved.combatant.poise ?? 0) + 5);
              resultText += ` 💪+5 Poise (Pressure Point) cho ${forResolved.label}.`;
            }
            // Thorns (Gluttony, [30 Points]) — BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận
            // trực tiếp: "khi người dùng thắng clash thì sẽ gắn rupture tức là
            // kẻ thua clash sẽ ăn rupture đó, không phải kẻ thua là kẻ gắn") —
            // TRƯỚC ĐÂY SAI HOÀN TOÀN HƯỚNG: check NGƯỜI THUA có Thorns rồi cho
            // NGƯỜI THẮNG nhận Rupture. Đúng phải là: NGƯỜI THẮNG (forResolved)
            // có Thorns → áp Rupture LÊN người THUA (targetResolved).
            if (hasPerk(forResolved.combatant, "Thorns")) {
              // "Seven Association": 1.5x hiệu quả áp Rupture — người GẮN thật
              // sự là forResolved (người thắng, chủ sở hữu Thorns).
              const thornsRupture = forResolved.combatant.hasSevenAssociation ? Math.round(7 * 1.5) : 7;
              targetResolved.combatant.rupture = Math.min(99, (targetResolved.combatant.rupture ?? 0) + thornsRupture);
              resultText += ` 🌵+${thornsRupture} Rupture (Thorns) lên ${targetResolved.label}.`;
            }
          } else if (myEffectiveDice < oppEffectiveDice) {
            const oppBefore2 = targetResolved.combatant.currentSanity;
            applySanityGain(targetResolved.combatant, 10);
            applyEmotionDelta(targetResolved.combatant, 2);
            const myBefore2 = forResolved.combatant.currentSanity;
            applyClashLossSanity(forResolved.combatant);
            applyEmotionDelta(forResolved.combatant, -1);
            checkStaggerPanic(forResolved.combatant); checkStaggerPanic(targetResolved.combatant);
            const oppDelta2 = targetResolved.combatant.currentSanity - oppBefore2;
            const myDelta2 = forResolved.combatant.currentSanity - myBefore2;
            resultText = `💔 ${forResolved.label} THUA Clash! (${myEffectiveDice} vs ${oppEffectiveDice}${myPenalty || oppPenalty ? `, gốc ${myRoll.firstDiceValue} vs ${oppRoll.firstDiceValue}, đã trừ chấn thương` : ""}) — ${oppDelta2 >= 0 ? "+" : ""}${oppDelta2} Sanity +2 Coin cho ${targetResolved.label}, ${myDelta2 >= 0 ? "+" : ""}${myDelta2} Sanity -1 Coin cho ${forResolved.label}.`;
            if (hasPerk(targetResolved.combatant, "Voracity") && !targetResolved.combatant.voracityUsedThisTurn) {
              targetResolved.combatant.currentLight = Math.min(targetResolved.combatant.maxLight, targetResolved.combatant.currentLight + 2);
              targetResolved.combatant.voracityUsedThisTurn = true;
              resultText += ` ✨+2 Light (Voracity) cho ${targetResolved.label}.`;
            }
            if (hasPerk(targetResolved.combatant, "Pressure Point")) {
              targetResolved.combatant.poise = Math.min(99, (targetResolved.combatant.poise ?? 0) + 5);
              resultText += ` 💪+5 Poise (Pressure Point) cho ${targetResolved.label}.`;
            }
            // Thorns — cùng fix hướng như nhánh trên: NGƯỜI THẮNG (targetResolved
            // ở nhánh này) có Thorns → áp Rupture lên người THUA (forResolved).
            if (hasPerk(targetResolved.combatant, "Thorns")) {
              // "Seven Association": người GẮN thật sự là targetResolved (thắng).
              const thornsRupture2 = targetResolved.combatant.hasSevenAssociation ? Math.round(7 * 1.5) : 7;
              forResolved.combatant.rupture = Math.min(99, (forResolved.combatant.rupture ?? 0) + thornsRupture2);
              resultText += ` 🌵+${thornsRupture2} Rupture (Thorns) lên ${forResolved.label}.`;
            }
          } else {
            applyEmotionDelta(forResolved.combatant, 1);
            applyEmotionDelta(targetResolved.combatant, 1);
            resultText = `⚖️ HUỀ Clash! (${myEffectiveDice} vs ${oppEffectiveDice}) — mỗi bên +1 Coin, Sanity không đổi.`;
          }
          appendActionLog(encounter, `⚔️ Clash: ${resultText}`);
          await saveEncounter(encChannelId, encounter);
          await message.reply({ embeds: [myRoll.embed, oppRoll.embed, { title: "⚔️ Kết quả Clash", description: resultText, color: 0x9b59b6 }] });
        });
      } catch (err) {
        message.reply(`❌ ${err.message}`);
      }
      return;
    }

    // BUG ĐÃ SỬA: trước đây "-encounter help" (gõ ĐÚNG, có chủ đích xem hướng dẫn)
    // rơi vào CHUNG message "⚠️ Lệnh không hợp lệ" — gây hiểu lầm nghiêm trọng (nội
    // dung PHÍA SAU chính là help thật, nhưng tiêu đề khiến player tưởng mình gõ
    // sai). Giờ TÁCH RIÊNG: "help" → tiêu đề tích cực "📖 Hướng dẫn"; MỌI sub khác
    // không nhận diện được → giữ nguyên "⚠️ Lệnh không hợp lệ" (đúng bản chất).
    const helpBody =
      "**Setup & quản lý trận**\n" +
      "> `-encounter start name: <tên trận> [permadeath: yes]` (admin/GM) — permadeath cho Night in the Backstreet/dungeon đặc biệt\n" +
      "> `-encounter addenemy key: <key> name: <tên> hp: <số>` (admin/GM, tùy chọn `stamina:`/`weapon:`/`res:`/`perks:`/`speedrange:`)\n" +
      "> `-encounter removeenemy key: <key>` (admin/GM) — gỡ khỏi board (bỏ chạy/bắt sống, KHÔNG tính là đã hạ)\n" +
      "> `-encounter join` — HOÀN TOÀN TỰ ĐỘNG (không cần gõ gì) — tự lấy HP còn lại từ trận trước (hoặc full theo Grade), Max Light theo Grade, weapon/outfit/Res đã equip. Gõ tay `hp:`/`stamina:`/`light:`/`weapon:`/`res:`/`speedrange:` CHỈ để ĐÈ LÊN mặc định nếu cần trường hợp đặc biệt\n" +
      "> `-encounter status` · `-encounter end` (GM, tự gửi lại action log đầy đủ trước khi xoá) · `-encounter rollspeed` (GM)\n" +
      "> `-encounter log [turn: <số>/all]` — xem lại lịch sử action đã confirm/reject (mặc định 5 turn gần nhất)\n\n" +
      "**Tấn công & phòng thủ**\n" +
      "> `-encounter attack target: <key/all> dmg: <công thức> [skill:] [ref:] [coin:] [tags:]` — M1, tự trừ Stamina\n" +
      "> `-encounter hit target: <key/all> dmg: <công thức> [skill:] [ref:] [coin:] [tags:]` — Page/Skill, tự trừ Light/Sanity theo cost\n" +
      "> `-encounter enemyattack key: <enemy> target: <@player/all> dmg: <công thức> [skill:] [ref:] [coin:] [tags:]` (GM)\n" +
      "> `tags:` gõ tay thêm: undodgeable/unblockable/unparriable/guard break/unclashable (skill thật tự phát hiện từ text roll, không cần gõ)\n" +
      "> `-encounter guard/evade` — phòng thủ tự do, dùng bao nhiêu lần cũng được, TRỘN được nhiều loại để chặn 1 đòn M1 nhiều hit\n" +
      "> `-encounter parry` — 0 Sta, roll d20, ăn/thua so với roll đối phương lúc confirm\n" +
      "> `-encounter pending` — xem hàng chờ, confirm/reject tất cả · `-encounter endturn` (GM)\n\n" +
      "**Cơ chế đặc biệt**\n" +
      "> `-encounter clash target: <id> skill: <tên> oppskill: <tên> [for: <id>]` — so Dice đầu, ảnh hưởng Sanity+Coin (+Poise/Light/Rupture nếu có perk liên quan)\n" +
      "> `-encounter shinmang` — hi sinh 25 Sanity/turn (cần sở hữu Shin) · `-encounter manifestego` — -30 Sanity (cần Emotion Level ≥1)\n" +
      "> `-encounter followup target: <key>` — Follow-Up/Pounce (cần ≥20 Sta tiêu turn này) · `-encounter overcharge` — Overcharged Vessel\n" +
      "> `-encounter swapweapon <tên>` — đổi vũ khí GIỮA TRẬN — CHỈ dùng được nếu sở hữu accessory đặc biệt (VD Dimension Pocket)\n" +
      "> `-encounter additem <tên>` / `useitem <tên>` (tối đa 4 mang/trận, 1 dùng/turn) · `-encounter healinjury target: <key> index: <số>` (GM)\n" +
      "> Item có hiệu ứng CỤ THỂ (tự động, không cần GM narrate): Chuối (+10 HP), Táo (-1 Dmg/hit tới hết turn), Dưa hấu (+20 Stamina), Medkit (chữa TOÀN BỘ chấn thương NHẸ, không chữa chấn thương nặng), K-Corp Ampule (hồi đầy HP + chữa hết injury, dùng lần 2/trận = CHẾT)\n" +
      "> `-encounter haste/bind target: <key/me> amount: <số>` — chỉnh tay Speed\n\n" +
      "**Ngoài encounter (profile, không cần đang trong trận)**\n" +
      "> `-equipweapon/-equipoutfit <tên>` · `-equipaccessory <slot 1-3> <tên>` · `-equippage/-equipegopage <slot 1-5> <tên>` · `-equipment`/`-pages`\n" +
      "> `-healitem <tên>` — hồi đầy HP ngoài trận bằng item · `-rewoundtime @user` — hồi sinh Permanent Death (miễn phí lần đầu/profile)\n" +
      "> `-readbook <tên sách>` — tiêu 1 cuốn, hiện Page/Weapon/Outfit sách đó dạy (KHÔNG chặn equip — chỉ mang tính tham khảo)\n" +
      "> `-healinjuryahn @user ahn: <số> index: <số>` (admin/GM, GM tự định giá) — chữa 1 chấn thương NGOÀI trận. Chấn thương PERSIST qua encounter — chỉ chữa được bằng Ahn (ngoài trận) hoặc K-Corp Ampule (trong trận, hồi đầy HP + chữa hết injury, dùng lần 2/trận = CHẾT)\n" +
      "> `-allocatepoints <nhánh>: <số>` — TỰ phân bổ điểm Skill Tree (không cần GM) · `-unlockskilltree <perk>` — TỰ mở khoá perk cho chính mình\n" +
      "> Admin có thể làm hộ player khác bằng cách thêm @user vào các lệnh equip/unlockskilltree ở trên";
    // BUG ĐÃ SỬA (xác nhận trực tiếp: "-encounter help không hoạt động") — helpBody
    // dài ~3468 ký tự, VƯỢT giới hạn 2000 ký tự Discord cho tin nhắn TEXT THƯỜNG
    // (message.reply(string)) — Discord API THẬT âm thầm từ chối gửi tin nhắn quá
    // dài, khiến lệnh "không phản hồi gì" (mock test trước đây không mô phỏng giới
    // hạn ký tự thật của Discord nên không bắt được lỗi này). Chuyển sang EMBED
    // (giới hạn description 4096 ký tự — đủ chỗ) cho CẢ "help" LẪN "invalid
    // command" fallback bên dưới.
    if (sub === "help") {
      message.reply({ embeds: [{ title: "📖 Hướng dẫn -encounter", description: helpBody, color: 0x5865f2 }] });
      return;
    }
    // BUG/UX ĐÃ SỬA (xác nhận trực tiếp từ GM: "mỗi lần gõ lệnh sai thì nó ra
    // phần encounter help quá dài, khiến trôi chat rất nhiều") — trước đây fallback
    // NÀY dump NGUYÊN helpBody dài ~3400 ký tự MỖI LẦN gõ sai — giờ chỉ báo NGẮN
    // GỌN + trỏ user tự gõ `-encounter help` RIÊNG nếu cần xem đầy đủ. LƯU Ý KỸ
    // THUẬT: `-encounter` là PREFIX COMMAND (tin nhắn text thường qua
    // messageCreate), KHÔNG PHẢI slash command — Discord CHỈ hỗ trợ "ephemeral"
    // (tin nhắn riêng tư, tự ẩn) cho INTERACTION RESPONSE (slash command/button/
    // dropdown), KHÔNG CÓ CƠ CHẾ ephemeral nào cho message.reply() của tin nhắn
    // text thường — đây là giới hạn CỦA DISCORD, không phải hạn chế của code, nên
    // không thể "ẩn" phản hồi này dù muốn — rút ngắn là cách khả thi duy nhất.
    message.reply({ embeds: [{ title: "⚠️ Lệnh không hợp lệ", description: `Không nhận diện được subcommand \`${sub}\`.\n> Dùng \`-encounter help\` để xem đầy đủ danh sách lệnh.`, color: 0xe74c3c }] });
    return;
  }

  // ── -dmgbonus ──
  // Cú pháp: -dmgbonus <số>  (hoặc -dmgbonus: <số>)
  // Cho biết % Dmg Bonus thực tế (sau bão hòa) ứng với 1 số % raw.
  if (message.content.startsWith("-dmgbonus")) {
    if (isOnCooldown(message.author.id, "dmgbonus", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const raw = message.content.replace("-dmgbonus", "").trim().replace(/^:/, "").trim();
    const value = parseFloat(raw.replace("%", ""));
    if (!raw || isNaN(value)) {
      message.reply(
        "❌ Cú pháp: `-dmgbonus <số>`\n" +
        "> VD: `-dmgbonus 1000` → cho biết % Dmg Bonus thực tế sau khi bị bão hòa."
      );
      return;
    }
    const eff = saturateBonusPct(value);
    const isSaturated = value > 100;
    const display = isSaturated
      ? `**${eff.toFixed(2)}%** effective *(raw: ${value.toFixed(2)}%)*`
      : `${value.toFixed(2)}% *(chưa bị bão hòa)*`;
    message.reply(`✨ **% Dmg Bonus:** ${display}`);
    return;
  }

  // ── -dr ──
  // Cú pháp: -dr <số>  (hoặc -dr: <số>)
  // Cho biết % Damage Reduction thực tế (sau bão hòa) ứng với 1 số % raw.
  if (message.content.startsWith("-dr")) {
    if (isOnCooldown(message.author.id, "dr", 2000)) {
      message.reply("⏳ Bạn dùng lệnh này quá nhanh, chờ 2 giây nhé.");
      return;
    }
    const raw = message.content.replace("-dr", "").trim().replace(/^:/, "").trim();
    const value = parseFloat(raw.replace("%", ""));
    if (!raw || isNaN(value)) {
      message.reply(
        "❌ Cú pháp: `-dr <% DR>`\n" +
        "> VD: `-dr 1000` → cho biết % Damage Reduction thực tế sau khi bị bão hòa."
      );
      return;
    }
    const drMult = saturateDR(1 - value / 100);
    const effPct = (1 - drMult) * 100;
    const isSaturated = effPct.toFixed(2) !== value.toFixed(2);
    const display = isSaturated
      ? `${value.toFixed(2)}% raw → **${effPct.toFixed(2)}%** effective *(${drMult.toFixed(3)}x)*`
      : `${value.toFixed(2)}% *(chưa bị bão hòa)*`;
    message.reply(`🛡️ **Damage Reduction:** ${display}`);
    return;
  }

  } catch (err) {
    console.error("[messageCreate error]", err);
    try { message.reply("❌ Có lỗi không mong muốn xảy ra.").catch(() => {}); } catch {}
  }
});
};
