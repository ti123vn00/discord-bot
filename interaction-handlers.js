// interaction-handlers.js
// Toàn bộ xử lý interaction Discord (button, select menu, modal submit) cho
// mọi luồng: encounter combat panel, reactive defense buttons, GM panel,
// gacha, profile, give confirm, skill tree, equip, rtparry... — TÁCH khỏi
// index.js theo yêu cầu trực tiếp: "tách nhỏ file index.js ra các file js
// khác" (code đã lên tới 11k+ dòng).
//
// COPY NGUYÊN VĂN (không sửa 1 dòng logic nào). Dependency list (136 mục)
// được xác định qua PHÂN TÍCH AST CHÍNH XÁC (acorn) — không dựa vào suy đoán
// thủ công, để tránh sai sót ở khối lớn và phức tạp như thế này. Một số tên
// (performParry, executeGive, isCurrentTurnHolder...) đã được index.js
// destructure sẵn TỪ CÁC MODULE KHÁC đã tách trước đó (encounter-actions.js,
// player-actions.js, combat-utils.js, book-system.js) — vẫn cần truyền qua
// đây vì file MỚI không có sẵn chúng trong scope riêng của nó.
//
// Factory tự client.on("interactionCreate", ...) (nhiều listener riêng biệt,
// y hệt cấu trúc gốc) bên trong — không return gì cả.

module.exports = function ({ ADMIN_IDS, ActionRowBuilder, BOOK_GRANTS, BRANCH_KEYS, ButtonBuilder, ButtonStyle, CRAFT_RECIPES, EGO_TIER_SLOT_ORDER, ENCOUNTER_DEFAULT_MAX_STAMINA, ENCOUNTER_KEY_MAX_LENGTH, ENCOUNTER_STAMINA_REGEN_PER_TURN, GACHA_BANNERS, GACHA_PITY_MAX, MAX_PROFILES, MessageFlags, ModalBuilder, OPEN_COUNT_MAX, PARRY_MAX_ROLLS, PERK_BRANCH, PERK_POINT_COSTS, PROFILE_EMOJIS, PROFILE_LABELS, PROFILE_NAME_MAX_LENGTH, STATUS_CAPS_SHARED, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TREMOR_VARIANT_MAX, TextInputBuilder, TextInputStyle, UNIVERSALLY_KNOWN_WEAPONS, WEAPON_DEFENSE_HITS, WEAPON_STAMINA_COST, advanceToNextTurnHolder, announceCurrentTurn, appendActionLog, applyClashLossSanity, applyDullahanParryCounter, applyEmotionDelta, applySanityGain, applyStatusEntries, autoBuildDmgStrFromSkillRoll, buildBalanceEmbed, buildBookChoiceComponents, buildBossActionPanel, buildDothihelpEmbed, buildEncounterActionPanel, buildEncounterBoardEmbed, buildEnemyTargetOptions, buildMovesPanel, buildSpecialPanel, buildItemsPanel, buildGachaPanelButtons, buildGachaPanelEmbed, buildGiveConfirmRow, buildGivePreviewLines, buildProfileInfoEmbed, buildRollDescription, buildRtparryLinkButton, buildSkillListResult, buildSkillRollResult, buildTurnOrderText, calcBranchPointsAllocated, calcMath, calcMathCore, calcSkillTreePointsEarned, checkStaggerPanic, client, combatantResStr, computeDefenseOptions, createCombatant, createRtparryToken, doEnemyAttack, doPlayerAttack, doPlayerHit, encounterKey, executeCraft, executeGive, executeReadBookChoose, executeRemove, fetchInventoryReply, finalizeReactiveChoice, findAccessory, findBook, findExclusiveConflict, findItem, findItemAdmin, findOutfit, findSkill, findWeaponAnywhere, formatNumber, getActiveProfileSlot, getBookGroupChoices, getEgoTier, getEncounter, getParryClashPenalty, getPlayerData, getPlayerDataWithSlot, getProfileNames, handleOpenChipboardCache, handleOpenRandomBook, handleOpenSealedBook, hasEncounterStarted, insertIntoTurnOrderMidRound, isBannerActive, isCurrentTurnHolder, isOnCooldown, log, normalizeEnemyKey, normalizeWeaponWeight, parseAoeInfo, parseBatchEntries, parsePerHitBypass, parseSkillCooldownTurns, parseSkillCost, parseStatusFreeText, pendingGives, performEndTurn, performFollowUp, performGachaPull, performGuardEvade, performManifestEgo, performOvercharge, performParry, performPityExchange, performShinMang, performUseItem, processDailyClaimForUser, registerPendingGive, replyOnCooldown, resolveCombatant, resolveOnePendingAction, resolveProfileLabel, resolveSkillVerification, runParryRolls, saveEncounter, savePlayerData, sendReactiveDefensePrompt, setActiveProfileSlot, setProfileName, validateMathInputs, webParrySessions, withDoubleLock, withLock }) {

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  try {

  // ── Nút phân trang inventory ──
  if (interaction.customId.startsWith("invpage:")) {
    const [, targetUserId, pageStr] = interaction.customId.split(":");
    const page = parseInt(pageStr, 10);
    // Chỉ chủ nhân của inventory được bấm Prev/Next — tránh người khác thao túng
    // trang hiển thị trong embed (dù /inventory là public).
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({
        content: "⚠️ Chỉ chủ nhân của inventory này mới có thể chuyển trang.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
    try {
      const targetUser = await client.users.fetch(targetUserId).catch(() => null);
      if (!targetUser) {
        return interaction.reply({ content: "❌ Không tìm thấy người dùng.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      const reply = await fetchInventoryReply(targetUser, page);
      if (!reply) {
        return interaction.reply({ content: "📦 Kho hiện đã trống.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      await interaction.update(reply);
    } catch (err) {
      log("error", "invpage button", interaction.user?.id ?? "unknown", err.message);
      interaction.reply({ content: "❌ Có lỗi xảy ra khi lấy dữ liệu.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // ── Nút xem thông tin item (từ select menu inventory) ──
  if (interaction.customId.startsWith("invinfo:")) {
    const parts = interaction.customId.split(":");
    const targetUserId = parts[1];
    const itemType = parts[2];
    const itemName = parts.slice(3).join(":");
    try {
      const infoMap = {
        "Random Book": "Mở ra 1 sách ngẫu nhiên từ pool thường.",
        "Sealed Book Cache": "Mở ra 1 sách hiếm ngẫu nhiên từ pool sealed.",
        "Chipboard Cache": "Mở ra Chipboard MK1–MK3 ngẫu nhiên.",
      };
      const recipe = CRAFT_RECIPES[itemName];
      let desc = infoMap[itemName] ?? `${itemType === "book" ? "📚 Sách" : "🔩 Vật phẩm"}: **${itemName}**`;
      if (recipe) {
        const inputs = Object.entries(recipe.inputs).map(([k, v]) => `${v}× ${k}`).join(", ");
        const outputs = Object.entries(recipe.output).map(([k, v]) => `${v}× ${k}`).join(", ");
        desc += `\n> 🔨 Craft: ${inputs} → ${outputs}`;
      }
      const data = await getPlayerData(targetUserId);
      const store = itemType === "book" ? (data.books ?? {}) : (data.items ?? {});
      const count = store[itemName] ?? 0;
      await interaction.reply({
        embeds: [{ title: itemName, description: desc, color: 0x5865f2, footer: { text: `Số lượng trong kho: ${count}` } }],
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      log("error", "invinfo button", interaction.user?.id ?? "unknown", err.message);
      interaction.reply({ content: "❌ Có lỗi xảy ra khi lấy dữ liệu.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // ── Nút Mở (sách) / Craft (item) — từ select menu inventory ──
  // ── Nút "📚 Đọc" — từ select menu inventory, CHỈ cho sách có trong BOOK_GRANTS
  // (khác invact's "Mở" dành cho Random Book/Sealed Book Cache/Chipboard Cache).
  if (interaction.customId.startsWith("invread:")) {
    const parts = interaction.customId.split(":");
    const targetUserId = parts[1];
    // BUG ĐÃ SỬA (phát hiện qua test thật, không phải chỉ đọc code): customId chứa
    // TÊN SÁCH ĐÃ encodeURIComponent (xem nơi tạo nút, dòng ~8335 `invread:...:
    // ${itemName}` — itemName ở ĐÓ CHÍNH LÀ tên đã encode) — nhưng handler này
    // ĐỌC THẲNG RAW, KHÔNG decodeURIComponent lại, khiến MỌI tên sách có khoảng
    // trắng (gần như toàn bộ — VD "Library Book" → "Library%20Book") tra sai key
    // trong inventory, LUÔN báo "không còn trong inventory" dù sách THẬT SỰ CÓ.
    const bookName = decodeURIComponent(parts.slice(3).join(":")); // parts[2] luôn là "book" ở đây, bỏ qua
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: "⚠️ Đây không phải inventory của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    if (isOnCooldown(interaction.user.id, "invread", 2000)) {
      return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      const { data: profileData } = await getPlayerDataWithSlot(targetUserId);
      const owned = profileData.books?.[bookName] ?? 0;
      if (owned < 1) { return interaction.reply({ content: `❌ Không còn **${bookName}** trong inventory.`, flags: MessageFlags.Ephemeral }).catch(() => {}); }
      await interaction.reply({ ...buildBookChoiceComponents(targetUserId, bookName, owned), flags: MessageFlags.Ephemeral });
    } catch (err) {
      await interaction.reply({ content: `❌ ${err.message ?? "Có lỗi xảy ra."}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.customId.startsWith("invact:")) {
    const parts = interaction.customId.split(":");
    const targetUserId = parts[1];
    const itemType = parts[2];
    const itemName = parts.slice(3).join(":");
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: "⚠️ Đây không phải inventory của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    // Mọi command khác (prefix + slash) đều có cooldown qua isOnCooldown — button này
    // ban đầu thiếu, cho phép spam-click dồn áp lực lên Redis qua withLock retry.
    if (isOnCooldown(interaction.user.id, "invact", 2000)) {
      return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (itemType === "book") {
        const handlerMap = {
          "Random Book": () => handleOpenRandomBook(targetUserId, 1),
          "Sealed Book Cache": () => handleOpenSealedBook(targetUserId, 1),
          "Chipboard Cache": () => handleOpenChipboardCache(targetUserId, 1),
        };
        const handler = handlerMap[itemName];
        if (!handler) { await interaction.editReply({ content: "❌ Không thể mở loại sách này." }); return; }
        const { success, data, results } = await handler();
        if (!success) { await interaction.editReply({ content: `❌ Không có **${itemName}** trong kho.` }); return; }
        await interaction.editReply({ content: `✅ Mở **${itemName}** → nhận được **${results[0]}**!\n> Còn lại: ${data.books[itemName] ?? 0}` });
      } else {
        if (!CRAFT_RECIPES[itemName]) { await interaction.editReply({ content: "❌ Vật phẩm này không thể craft." }); return; }
        // Tách interaction.editReply ra ngoài withLock — nếu Discord API chậm, lock
        // TTL có thể hết hạn trong khi vẫn đang giữ lock. executeCraft chỉ cần Redis.
        const { outputLines, costLines } = await withLock(targetUserId, () =>
          executeCraft(targetUserId, itemName, 1)
        );
        await interaction.editReply({ content: `✅ Craft thành công!\n${costLines.join("\n")}\n→ ${outputLines.join(", ")}` });
      }
    } catch (err) {
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra."}` });
    }
    return;
  }

  // ── Nút Xóa 1 — từ select menu inventory ──
  if (interaction.customId.startsWith("invdel:")) {
    const parts = interaction.customId.split(":");
    const targetUserId = parts[1];
    const itemType = parts[2];
    const itemName = parts.slice(3).join(":");
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: "⚠️ Đây không phải inventory của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    if (isOnCooldown(interaction.user.id, "invdel", 2000)) {
      return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const bookEntries = itemType === "book" ? [{ name: itemName, count: 1 }] : [];
      const itemEntries = itemType === "item" ? [{ name: itemName, count: 1 }] : [];
      await withLock(targetUserId, () => executeRemove({
        actorId: targetUserId, targetId: targetUserId,
        isAdmin: false, expRemove: 0, ahnRemove: 0, bookEntries, itemEntries,
      }));
      await interaction.editReply({ content: `🗑️ Đã xóa **1× ${itemName}** khỏi kho.` });
    } catch (err) {
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra."}` });
    }
    return;
  }

  // ── Nút chuyển profile (từ /profile info hoặc -profile info) ──
  if (interaction.customId.startsWith("profswitch:")) {
    const [, targetUserId, slotStr] = interaction.customId.split(":");
    const slot = parseInt(slotStr, 10);
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: "⚠️ Chỉ chủ nhân mới có thể đổi profile.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    if (isOnCooldown(interaction.user.id, "profswitch", 1500)) {
      return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 1.5 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      await setActiveProfileSlot(targetUserId, slot);
      // Rebuild embed để nút của slot mới được disable đúng (đang dùng) và phản ánh data mới.
      const { embed, components } = await buildProfileInfoEmbed(
        targetUserId,
        interaction.user.displayName ?? interaction.user.username,
        `Dùng -profile switch <1-${MAX_PROFILES}> hoặc bấm nút bên dưới để đổi profile`
      );
      await interaction.update({ embeds: [embed], components });
    } catch (err) {
      log("error", "profswitch button", interaction.user?.id ?? "unknown", err.message);
      interaction.reply({ content: "❌ Có lỗi xảy ra khi chuyển profile.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // ── Nút Xác nhận /give ──
  if (interaction.customId.startsWith("giveconfirm:")) {
    const giveId = interaction.customId.slice("giveconfirm:".length);
    const pending = pendingGives.get(giveId);
    if (!pending) {
      return interaction.update({ content: "⚠️ Giao dịch đã hết hạn hoặc đã được xử lý.", embeds: [], components: [] }).catch(() => {});
    }
    if (interaction.user.id !== pending.senderId) {
      return interaction.reply({ content: "⚠️ Chỉ người tạo lệnh /give mới được xác nhận.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    pendingGives.delete(giveId);
    await interaction.deferUpdate();
    try {
      const { senderId, targetId, isAdmin, params } = pending;
      const runGive = () => executeGive({ senderId, targetId, isAdmin, ...params });
      const changes = await withDoubleLock(senderId, targetId, runGive);
      await interaction.editReply({
        content: `✅ <@${senderId}> đã ${isAdmin ? "tặng" : "chuyển"} cho <@${targetId}>:\n` + changes.map(c => `> ${c}`).join("\n"),
        embeds: [], components: [],
      });
    } catch (err) {
      log("error", "giveconfirm button", interaction.user?.id ?? "unknown", err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}`, embeds: [], components: [] }).catch(() => {});
    }
    return;
  }

  // ── Nút Hủy /give ──
  if (interaction.customId.startsWith("givecancel:")) {
    const giveId = interaction.customId.slice("givecancel:".length);
    const pending = pendingGives.get(giveId);
    if (pending && interaction.user.id !== pending.senderId) {
      return interaction.reply({ content: "⚠️ Chỉ người tạo lệnh /give mới được hủy.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    pendingGives.delete(giveId);
    await interaction.update({ content: "❌ Đã hủy giao dịch.", embeds: [], components: [] }).catch(() => {});
    return;
  }

  // "encboardpage:" — GAP ĐÃ SỬA (xác nhận trực tiếp): "thay vì phân luồng thì
  // làm 1 nút để sang trang thì sao?" — nút lật trang board khi encounter quá
  // đông. LUÔN đọc encounter MỚI NHẤT lúc bấm (không dùng snapshot cũ), chỉ
  // GIỮ nguyên các component KHÁC đã có trên message (VD dropdown encmenu)
  // nếu có, chỉ thay riêng row pagination.
  if (interaction.customId.startsWith("encboardpage:")) {
    const [, channelId, pageRaw] = interaction.customId.split(":");
    const page = parseInt(pageRaw, 10) || 0;
    try {
      const encounter = await getEncounter(channelId);
      if (!encounter) return interaction.reply({ content: "⚠️ Encounter không còn tồn tại.", flags: MessageFlags.Ephemeral }).catch(() => {});
      const boardPayload = buildEncounterBoardEmbed(encounter, channelId, page);
      const existingRows = (interaction.message.components ?? []).filter(row => !row._c?.[0]?._id?.startsWith("encboardpage:"));
      await interaction.update({
        embeds: [boardPayload.embed],
        components: [...existingRows, ...boardPayload.components],
      }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // (Nút action panel cũ "encact:" đã bỏ — thay bằng dropdown "encmenu:", xem
  // listener riêng "SELECT MENU INTERACTIONS (encounter)" phía dưới.)


  if (interaction.customId.startsWith("encconfirmall:") || interaction.customId.startsWith("encrejectall:")) {
    const isConfirm = interaction.customId.startsWith("encconfirmall:");
    const channelId = interaction.customId.slice((isConfirm ? "encconfirmall:" : "encrejectall:").length);
    try {
      await withLock(encounterKey(channelId), async () => {
        const encounter = await getEncounter(channelId);
        if (!encounter || (encounter.pendingActions ?? []).length === 0) {
          return interaction.reply({ content: "⚠️ Không có action nào chờ xác nhận (có thể đã xử lý rồi).", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const isAdmin = ADMIN_IDS.has(interaction.user.id);
        if (!isAdmin && interaction.user.id !== encounter.gmId) {
          return interaction.reply({ content: "⚠️ Chỉ GM tạo encounter này (hoặc admin khác) mới được xác nhận/từ chối.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const resultLines = [];
        if (isConfirm) {
          // QUAN TRỌNG: đây là lúc DUY NHẤT state thật của encounter bị thay đổi —
          // lúc declare (-encounter attack/hit/enemyattack) chỉ TÍNH TRƯỚC (preview),
          // không áp dụng gì cả. Xử lý TUẦN TỰ từng pending action theo đúng thứ tự
          // đã declare (FIFO) — quan trọng vì action sau có thể phụ thuộc trạng thái
          // (HP/status) do action trước vừa đổi (VD: 2 player cùng đánh 1 enemy).
          for (const p of encounter.pendingActions) {
            const lines = await resolveOnePendingAction(encounter, p);
            resultLines.push(...lines);
          }
        } else {
          for (const p of encounter.pendingActions) {
            const attacker = resolveCombatant(encounter, p.attackerId);
            resultLines.push(`${attacker?.label ?? p.attackerId} (\`${p.dmgStr}\`) — đã reject`);
          }
        }

        // Ghi vào actionLog (xem -encounter log) — lưu NGUYÊN VĂN resultLines (full
        // detail, đúng những gì vừa hiện trong embed confirm) kèm Turn number lúc
        // ghi. Cap 100 entries gần nhất (drop entry CŨ NHẤT khi vượt) — tránh phình
        // vô hạn dữ liệu lưu trên Redis qua trận dài.
        if (resultLines.length > 0) {
          encounter.actionLog = encounter.actionLog ?? [];
          encounter.actionLog.push({
            turn: encounter.turnNumber ?? 1,
            type: isConfirm ? "confirm" : "reject",
            lines: resultLines,
            timestamp: Date.now(),
          });
          if (encounter.actionLog.length > 100) {
            encounter.actionLog = encounter.actionLog.slice(encounter.actionLog.length - 100);
          }
        }
        encounter.pendingActions = [];
        // Chiến thắng — luật xác nhận: cần thông báo RÕ RÀNG khi TẤT CẢ enemy đã hạ,
        // không chỉ đổi màu embed (GM dễ bỏ sót). victoryAnnounced chặn báo LẶP LẠI
        // mỗi lần confirm sau đó trong cùng trạng thái "đã thắng" — tự RESET về false
        // ngay khi có enemy MỚI còn sống (VD GM thêm enemy tiếp theo bằng addenemy),
        // để lần thắng KẾ TIẾP vẫn báo đúng.
        const allEnemiesDeadNow = Object.keys(encounter.enemies).length > 0 && Object.values(encounter.enemies).every(e => e.currentHp <= 0);
        let victoryNote = "";
        if (allEnemiesDeadNow && !encounter.victoryAnnounced) {
          encounter.victoryAnnounced = true;
          victoryNote = "\n\n🎉 **CHIẾN THẮNG!** Toàn bộ enemy đã bị hạ — dùng `-encounter end` để kết thúc trận (sẽ tự gửi lại action log đầy đủ trước khi xoá), hoặc `-encounter addenemy` nếu muốn thêm đợt tiếp theo.";
        } else if (!allEnemiesDeadNow) {
          encounter.victoryAnnounced = false;
        }
        await saveEncounter(channelId, encounter);

        await interaction.update({
          embeds: [{
            title: isConfirm ? "✅ Đã xác nhận tất cả" : "❌ Đã reject tất cả",
            description: (resultLines.join("\n") || "*(không có gì)*") + victoryNote,
            color: isConfirm ? 0x2ecc71 : 0xe74c3c,
          }],
          components: [],
        }).catch(() => {});
        if (isConfirm) {
          const boardPayload = buildEncounterBoardEmbed(encounter, channelId);
          await interaction.channel.send({ embeds: [boardPayload.embed], components: boardPayload.components }).catch(() => {});
        }
        announceCurrentTurn(channelId, encounter).catch(() => {});
      });
    } catch (err) {
      log("error", "encounterConfirmAll", interaction.user?.id ?? "unknown", err.message);
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // GAP ĐÃ SỬA (xác nhận trực tiếp: "gm có thể chỉnh sửa bất cứ thứ gì...
  // add, edit enemy, status") — "control" giữ NGUYÊN hành vi cũ (buildBossActionPanel);
  // "edit" mở Modal mới cho phép sửa HP/Stamina/Sanity/Light + status tự do
  // (tái dùng cú pháp -encounter setstatus qua 1 ô Paragraph).
  if (interaction.customId.startsWith("gmenemymode:")) {
    const [, channelId, ekey, ownerId, mode] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
      return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Encounter không còn tồn tại.");
      const enemy = encounter.enemies[ekey];
      if (!enemy) throw new Error("Không tìm thấy enemy này (có thể đã bị xoá).");
      if (mode === "control") {
        await interaction.update({
          embeds: [{ title: `👹 Điều khiển: ${enemy.name} (${ekey})`, description: `HP: ${enemy.currentHp}/${enemy.maxHp} | Stamina: ${enemy.currentStamina}/${enemy.maxStamina}\nChọn hành động:`, color: 0xe74c3c }],
          components: buildBossActionPanel(channelId, ekey, interaction.user.id),
        }).catch(() => {});
        return;
      }
      // mode === "edit"
      const modal = new ModalBuilder()
        .setCustomId(`gmeditmodal:${channelId}:enemy:${ekey}`)
        .setTitle(`Chỉnh sửa: ${enemy.name}`.slice(0, 45));
      const hpInput = new TextInputBuilder().setCustomId("hp").setLabel("HP").setStyle(TextInputStyle.Short).setValue(String(enemy.currentHp)).setRequired(true);
      const staInput = new TextInputBuilder().setCustomId("stamina").setLabel("Stamina").setStyle(TextInputStyle.Short).setValue(String(enemy.currentStamina)).setRequired(true);
      const sanLightInput = new TextInputBuilder().setCustomId("sanlight").setLabel("Sanity/Light").setStyle(TextInputStyle.Short).setValue(`${enemy.currentSanity ?? 0}/${enemy.currentLight ?? 0}`).setRequired(true);
      const statusInput = new TextInputBuilder()
        .setCustomId("status")
        .setLabel("Status/Set/Injury/CD (xem placeholder)")
        .setPlaceholder("rupture: 5 | set emotioncoin: 2 | injury+: Gãy chân | cd durandal: 3")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);
      const noteInput = new TextInputBuilder().setCustomId("addnote").setLabel("Ghi chú (narrate/mechanic thuần text)").setPlaceholder("Để trống nếu không đổi").setStyle(TextInputStyle.Paragraph).setValue(enemy.gmNote ?? "").setRequired(false);
      modal.addComponents(
        new ActionRowBuilder().addComponents(hpInput),
        new ActionRowBuilder().addComponents(staInput),
        new ActionRowBuilder().addComponents(sanLightInput),
        new ActionRowBuilder().addComponents(statusInput),
        new ActionRowBuilder().addComponents(noteInput),
      );
      await interaction.showModal(modal).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // GAP ĐÃ SỬA (xác nhận trực tiếp: "add... enemy") — nút "➕ Add Enemy" trong
  // gmpanel, mở Modal nhập key/name/hp/res/weapon (tái dùng field giống lệnh
  // text -encounter addenemy).
  if (interaction.customId.startsWith("gmpaneladdenemy:")) {
    const [, channelId, ownerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
      return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới bấm được.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const modal = new ModalBuilder()
      .setCustomId(`gmaddenemymodal:${channelId}`)
      .setTitle("➕ Add Enemy");
    const keyInput = new TextInputBuilder().setCustomId("key").setLabel("Key (định danh ngắn, không dấu)").setPlaceholder("VD: mo, goblin1").setStyle(TextInputStyle.Short).setRequired(true);
    const nameInput = new TextInputBuilder().setCustomId("name").setLabel("Tên hiển thị").setPlaceholder("VD: Mo Xù").setStyle(TextInputStyle.Short).setRequired(true);
    const hpInput = new TextInputBuilder().setCustomId("hp").setLabel("HP (hoặc HP/Stamina)").setPlaceholder("VD: 500 hoặc 500/150 (mặc định Stamina=100)").setStyle(TextInputStyle.Short).setRequired(true);
    const resInput = new TextInputBuilder().setCustomId("res").setLabel("Resistance (tuỳ chọn)").setPlaceholder("VD: 1.5xB 1xP 0.8xS — để trống = 1x cả 3").setStyle(TextInputStyle.Short).setRequired(false);
    const weaponInput = new TextInputBuilder().setCustomId("weapon").setLabel("Weapon weight (tuỳ chọn)").setPlaceholder("light/medium/heavy — để trống = medium").setStyle(TextInputStyle.Short).setRequired(false);
    modal.addComponents(
      new ActionRowBuilder().addComponents(keyInput),
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(hpInput),
      new ActionRowBuilder().addComponents(resInput),
      new ActionRowBuilder().addComponents(weaponInput),
    );
    await interaction.showModal(modal).catch(() => {});
    return;
  }

  // GAP ĐÃ SỬA (xác nhận trực tiếp: "ở phần set status thì nên hiện dropdown
  // để chọn những status có sẵn trong game để tự gắn") — Bước 1/3: chọn TARGET
  // (enemy hoặc player, gộp chung 1 dropdown vì chỉ cần chọn 1).
  if (interaction.customId.startsWith("gmpanelquickstatus:")) {
    const [, channelId, ownerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
      return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới bấm được.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Encounter không còn tồn tại.");
      const targetOptions = [
        ...Object.entries(encounter.enemies).map(([k, e]) => new StringSelectMenuOptionBuilder().setLabel(`👹 ${e.name} (${k})`).setValue(`enemy:${k}`)),
        ...Object.entries(encounter.players).map(([pid, p]) => new StringSelectMenuOptionBuilder().setLabel(`🧑 ${p.name}`).setValue(`player:${pid}`)),
      ];
      if (targetOptions.length === 0) throw new Error("Encounter chưa có ai cả.");
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`gmquickstatustarget:${channelId}:${ownerId}`)
        .setPlaceholder("Chọn người/enemy muốn gắn status...")
        .addOptions(...targetOptions.slice(0, 25));
      await interaction.reply({
        embeds: [{ title: "🎯 Set Status — Bước 1: Chọn mục tiêu", color: 0xf39c12 }],
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.customId.startsWith("gmpanelstatus:")) {
    const [, channelId, ownerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
      return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới xem được.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Encounter không còn tồn tại.");
      const boardPayload = buildEncounterBoardEmbed(encounter, channelId);
      await interaction.reply({ embeds: [boardPayload.embed], components: boardPayload.components, flags: MessageFlags.Ephemeral }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.customId.startsWith("gachapull:")) {
    const [, ownerId, countStr, bannerKey] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "⚠️ Chỉ chủ nhân bảng gacha này mới bấm được — dùng `-gacha` để mở bảng riêng của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const count = parseInt(countStr, 10);
    try {
      const { totalCost, resultLines, rareHits, remainingLunacy, pity } = await performGachaPull(interaction.user.id, count, bannerKey);
      // Cập nhật LẠI panel (Lunacy mới, Pity mới) NGAY trong cùng message —
      // người chơi bấm tiếp được luôn, không cần gõ `-gacha` lại mỗi lần.
      await interaction.update({
        embeds: [buildGachaPanelEmbed(remainingLunacy, bannerKey, pity)],
        components: buildGachaPanelButtons(ownerId, bannerKey, pity),
      }).catch(() => {});
      await interaction.followUp({
        content:
          `🎰 **${GACHA_BANNERS[bannerKey].name} x${count}** (-${formatNumber(totalCost)} <:Lunacy:1524989409529823342>Lunacy, còn **${formatNumber(remainingLunacy)}**):\n` +
          resultLines.map(l => `> ${l}`).join("\n") +
          (rareHits.length > 0 ? `\n\n🎉 **CỰC HIẾM!** Trúng: ${rareHits.join(", ")} — liên hệ GM để thiết kế cụ thể.` : "") +
          `\n🎯 Pity: **${pity}/${GACHA_PITY_MAX}**`,
      }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // "Đổi Pity" — GAP ĐÃ SỬA (xác nhận trực tiếp): mở dropdown chọn 1 trong các
  // item Tier 3 của banner này để đổi (thay vì đổi ngẫu nhiên).
  if (interaction.customId.startsWith("gachapity:")) {
    const [, ownerId, bannerKey] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "⚠️ Chỉ chủ nhân bảng gacha này mới bấm được.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const banner = GACHA_BANNERS[bannerKey];
    if (!banner) return interaction.reply({ content: "⚠️ Banner không hợp lệ.", flags: MessageFlags.Ephemeral }).catch(() => {});
    const rareOptions = banner.poolRare.map(item => new StringSelectMenuOptionBuilder().setLabel(item).setValue(item));
    await interaction.update({
      embeds: [{ title: `🎯 Đổi Pity — ${banner.name}`, description: "Chọn 1 item Tier 3 muốn đổi (trừ đúng 100 Pity):", color: 0xe74c3c }],
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`gachapityitem:${ownerId}:${bannerKey}`).setPlaceholder("Chọn item...").addOptions(...rareOptions),
      )],
    }).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith("encendturn:")) {
    const [, channelId, gmIdFromButton] = interaction.customId.split(":");
    try {
      const isAdmin = ADMIN_IDS.has(interaction.user.id);
      if (interaction.user.id !== gmIdFromButton && !isAdmin) {
        return interaction.reply({ content: "⚠️ Chỉ GM/admin mới được kết thúc turn.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      const { encounter, shroudedNotes, prescriptNotes } = await performEndTurn(channelId, interaction.user.id, isAdmin);
      await interaction.update({
        content: null,
        embeds: [{
          title: "🔄 Đã kết thúc Turn",
          description: `Hồi ${ENCOUNTER_STAMINA_REGEN_PER_TURN} Stamina (trừ ai đang Stagger), đếm ngược Stagger/Panic.` +
            (shroudedNotes.length > 0 ? `\n> ${shroudedNotes.join(", ")}` : "") +
            (prescriptNotes.length > 0 ? `\n${prescriptNotes.map(n => `> ${n}`).join("\n")}` : "") +
            `\n> 🎲 Thứ tự Turn mới:\n${buildTurnOrderText(encounter)}`,
          color: 0x2ecc71,
        }],
        components: [],
      }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (interaction.customId.startsWith("encreactivedef:")) {
    const [, channelId, pendingId, targetId, choice, counterSkillKeyOrHitIdx] = interaction.customId.split(":");
    const counterSkillKey = counterSkillKeyOrHitIdx; // dùng khi choice === "counter"
    // "Counter" (page-counter) — KHÁC HOÀN TOÀN guard/evade/parry/none: KHÔNG
    // resolve ngay (phải chờ kết quả minigame rtparry trước), nên tách riêng
    // NGOÀI withLock/finalizeReactiveChoice flow bình thường bên dưới.
    if (choice === "counter") {
      try {
        const isAdmin = ADMIN_IDS.has(interaction.user.id);
        if (interaction.user.id !== targetId && !isAdmin) {
          await interaction.reply({ content: "⚠️ Chỉ người bị tấn công (hoặc admin) mới được dùng counter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
        const counterSkill = findSkill(counterSkillKey);
        if (!counterSkill || !counterSkill.counterEffect) {
          await interaction.reply({ content: "❌ Không tìm thấy page counter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
        await interaction.reply({
          embeds: [{ title: `⚔️ ${counterSkill.name} — Counter`, description: "Bấm nút dưới để mở Parry Real Time. Thắng = counter thành công, thua = không phòng thủ được (ăn dmg thường).", color: 0xf39c12 }],
          flags: MessageFlags.Ephemeral,
        });
        const sentMsg = await interaction.fetchReply();
        const linkInfo = createRtparryToken({ userId: interaction.user.id, channelId: interaction.channelId, messageId: sentMsg.id, skill: counterSkill });
        if (!linkInfo) {
          await interaction.followUp({ content: "⚠️ Bot chưa biết URL public (thiếu RENDER_EXTERNAL_URL/PUBLIC_URL).", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
        // Gắn thêm context ĐỂ route /rtparry/:token/result biết đây LÀ 1 page
        // counter đang chờ áp dụng, không phải rtparry thường (chỉ hiển thị
        // AMAZING/GREAT không ảnh hưởng gameplay) — xem comment đầy đủ ở route đó.
        const session = webParrySessions.get(linkInfo.token);
        if (session) {
          session.counterContext = { encChannelId: channelId, pendingId, targetId, counterSkillKey };
        }
        await interaction.followUp({
          embeds: [{ title: `⚔️ ${counterSkill.name}`, description: "Bấm nút dưới để mở Parry Real Time.", color: 0xf39c12 }],
          components: [buildRtparryLinkButton(linkInfo.url)],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      } catch (err) {
        log("error", "counterRtparry", interaction.user.id, err.message);
        await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    // "Clash" responsive — bấm nút → hiện dropdown chọn 1 Page/Critical của
    // CHÍNH target để đem ra so Dice (chỉ đọc, không sửa gì nên KHÔNG cần
    // withLock — dropdown chọn xong mới thật sự khoá/xử lý ở handler riêng
    // "encclashselect:").
    // "Không Clash" (nút huỷ, xác nhận trực tiếp theo tester) — chỉ ẩn prompt
    // này đi, không làm gì khác — người khác vẫn có thể Clash nếu muốn.
    if (choice === "clashdecline") {
      await interaction.update({
        embeds: [{ title: "❌ Đã bỏ qua", description: "Bạn chọn không Clash hộ lần này.", color: 0x95a5a6 }],
        components: [],
      }).catch(() => {});
      return;
    }
    if (choice === "clash") {
      // counterSkillKey field TÁI DÙNG làm clasherId ở đây (choice="clash"
      // dùng khác ý nghĩa so với choice="counter") — NGƯỜI THỰC HIỆN Clash,
      // CÓ THỂ KHÁC targetId (VD A Clash thay cho B — targetId=B, clasherId=A).
      const clasherId = counterSkillKey;
      try {
        const isAdmin = ADMIN_IDS.has(interaction.user.id);
        if (interaction.user.id !== clasherId && !isAdmin) {
          await interaction.reply({ content: "⚠️ Chỉ đúng người được quyền Clash (hoặc admin) mới bấm được.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
        const encounter = await getEncounter(channelId);
        if (!encounter) { await interaction.reply({ content: "⚠️ Encounter không còn tồn tại.", flags: MessageFlags.Ephemeral }).catch(() => {}); return; }
        const clasherResolved = resolveCombatant(encounter, clasherId);
        if (!clasherResolved) { await interaction.reply({ content: "⚠️ Không tìm thấy bạn trong encounter.", flags: MessageFlags.Ephemeral }).catch(() => {}); return; }
        const clasher = clasherResolved.combatant;
        const candidateNames = [clasher.weaponCriticalKey, ...(clasher.unlockedPagesSnapshot ?? [])].filter(Boolean);
        const clashOptions = [];
        const addedClashKeys = new Set();
        for (const name of candidateNames) {
          const sk = findSkill(name);
          if (!sk || sk.promptArg) continue; // promptArg cần input đặc biệt, giống hạn chế của "-encounter clash" gốc
          const key = name.trim().toLowerCase();
          if (addedClashKeys.has(key)) continue; // GAP ĐÃ SỬA: tránh 2 option TRÙNG value nếu equip cùng tên vào 2 slot
          if ((clasher.skillCooldowns?.[key] ?? 0) > 0) continue;
          const cost = parseSkillCost(sk.cost);
          if ((clasher.currentLight ?? 0) < (cost.light ?? 0)) continue;
          addedClashKeys.add(key);
          clashOptions.push({ key, name: sk.name });
        }
        if (clashOptions.length === 0) {
          await interaction.reply({ content: "❌ Không có Page/Critical nào đủ điều kiện để Clash (đủ Light, chưa hết CD).", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`encclashselect:${channelId}:${pendingId}:${targetId}:${clasherId}`)
          .setPlaceholder("Chọn Page/Critical để Clash")
          .addOptions(clashOptions.slice(0, 25).map(o => new StringSelectMenuOptionBuilder().setLabel(o.name).setValue(o.key)));
        await interaction.reply({
          embeds: [{ title: "⚔️ Chọn Page/Critical để Clash", description: "So Dice đầu tiên — thắng thì ngắt hết đòn địch, thua thì ăn đủ dmg.", color: 0xf39c12 }],
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      } catch (err) {
        log("error", "clashSelect", interaction.user.id, err.message);
        await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    // "Your Shield" (Zweihander passive) — GAP ĐÃ SỬA (xác nhận trực tiếp:
    // "giống Clash-hộ nhưng dùng Guard, không cần speed cao hơn, không cần
    // roll") — đơn giản hơn Clash nhiều: áp Guard NGAY (tiêu Stamina của
    // CHÍNH người can thiệp — entryId, không phải targetId), ngắt dmg cho
    // targetId, đánh dấu yourShieldUsedThisTurn (giới hạn 1 lần/turn).
    if (choice === "yourshield") {
      const entryId = counterSkillKey; // tái dùng field thứ 6 (xem comment ở nhánh "clash")
      try {
        let displayText = "";
        await withLock(encounterKey(channelId), async () => {
          const encounter = await getEncounter(channelId);
          if (!encounter) { displayText = "⚠️ Encounter không còn tồn tại."; return; }
          const p = (encounter.pendingActions ?? []).find(pa => pa.id === pendingId);
          if (!p) { displayText = "⚠️ Action này đã được xử lý rồi."; return; }
          if (p.reactedTargetIds?.includes(targetId)) { displayText = "⚠️ Đòn này đã được xử lý rồi."; return; }
          const targetResolved = resolveCombatant(encounter, targetId);
          const entryResolved = resolveCombatant(encounter, entryId);
          const attackerResolved = resolveCombatant(encounter, p.attackerId);
          if (!targetResolved || !entryResolved || !attackerResolved) { displayText = "⚠️ Không tìm thấy target/người can thiệp/attacker."; return; }
          const target = targetResolved.combatant;
          const entry = entryResolved.combatant;
          if (entry.weaponName !== "Zweihander") { displayText = "⚠️ Bạn không còn trang bị Zweihander."; return; }
          if (entry.yourShieldUsedThisTurn) { displayText = "⚠️ Bạn đã dùng Your Shield trong turn này rồi."; return; }
          const isM1Type = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
          const attackerWeapon = attackerResolved.combatant.weaponWeight ?? "medium";
          const t = p.targets.find(tg => tg.targetId === targetId);
          const hitCount = Math.max(1, t?.preview?.dmgValues?.length ?? 1);
          const opts = computeDefenseOptions(entry, attackerWeapon, hitCount, isM1Type, p.defenseBypass ?? {}, p.isEyeOfHorusFixedBurst);
          if (!opts.guard.available) { displayText = `❌ Không đủ Stamina để Guard hộ (cần ${opts.guard.cost}, hiện có ${entry.currentStamina}).`; return; }
          entry.currentStamina -= opts.guard.cost;
          entry.yourShieldUsedThisTurn = true;
          // Ngắt TOÀN BỘ dmg đòn này cho target (Your Shield chặn hộ nguyên
          // đòn, không phải per-hit như Guard thường — giống tinh thần "block
          // đòn thay cho 1 đồng đội" nguyên văn).
          target.evadeCharges = (target.evadeCharges ?? 0) + hitCount;
          const finalized = await finalizeReactiveChoice(channelId, encounter, p, targetId, `🛡️ **${entry.name ?? entryId}** dùng Your Shield — Guard thay cho ${targetResolved.label} (-${opts.guard.cost} Sta của người dùng Shield).`, `<@${entryId}>`);
          displayText = finalized.resultText;
        });
        await interaction.update({
          embeds: [{ title: "🛡️ Your Shield — Kết quả", description: displayText, color: 0x9b59b6 }],
          components: [],
        }).catch(() => {});
        {
          const encAfterYourShield = await getEncounter(channelId);
          if (encAfterYourShield) announceCurrentTurn(channelId, encAfterYourShield).catch(() => {});
        }
      } catch (err) {
        log("error", "yourShield", interaction.user.id, err.message);
        await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    try {
      let resultText = null;
      let stillWaitingFor = null;
      let encounterSnapshot = null;
      let showHitPicker = null; // { maxAffordable, hitCount, choice, costPerCharge } — CHỈ dùng cho Eye Of Horus fixedBurst (giữ nguyên logic cũ)
      let needsNextHitPrompt = false;
      await withLock(encounterKey(channelId), async () => {
        const encounter = await getEncounter(channelId);
        encounterSnapshot = encounter;
        if (!encounter) throw new Error("Encounter không còn tồn tại.");
        const p = (encounter.pendingActions ?? []).find(pa => pa.id === pendingId);
        if (!p) throw new Error("Action này đã được xử lý rồi (có thể GM đã confirm/reject cả loạt trước đó).");
        const isAdmin = ADMIN_IDS.has(interaction.user.id);
        if (interaction.user.id !== targetId && !isAdmin && interaction.user.id !== encounter.gmId) {
          throw new Error("Chỉ người bị tấn công (hoặc GM) mới được chọn phòng thủ này.");
        }
        if (p.reactedTargetIds?.includes(targetId)) {
          throw new Error("Bạn đã chọn phòng thủ cho đòn này rồi.");
        }
        const targetResolved = resolveCombatant(encounter, targetId);
        if (!targetResolved) throw new Error("Không tìm thấy target.");
        const target = targetResolved.combatant;
        const attacker = resolveCombatant(encounter, p.attackerId);
        if (!attacker) throw new Error("Không tìm thấy attacker.");
        const isM1Type = p.kind === "attack" || (p.kind === "enemyattack" && !p.skillKey);
        const attackerWeapon = attacker.combatant.weaponWeight ?? "medium";
        const bypass = p.defenseBypass ?? {};
        const t = p.targets.find(tg => tg.targetId === targetId);
        const hitCount = Math.max(1, t?.preview?.dmgValues?.length ?? 1);

        // GAP ĐÃ SỬA (xác nhận trực tiếp: "Durandal crit có 3 hit... hiện cơ
        // chế chỉ cho phép 1 hành động thủ duy nhất trong khi đáng lẽ có thể...
        // hit 1 né, hit 2 guard, hit 3 né/parry") — REDESIGN: bỏ hẳn dropdown
        // "chọn nhóm hit" (groupCount/showHitPicker) — giờ MỖI HIT xử lý NGAY
        // tại đây (hitCount=1 luôn, vì mỗi lần bấm chỉ ứng với ĐÚNG 1 hitIdx cụ
        // thể từ customId). GAP ĐÃ SỬA THÊM (xác nhận trực tiếp: "20 hit của
        // light weapon... nên nhóm 4 lần m1 thành 1") — per-hit CHỈ áp dụng cho
        // skill/Critical/Page — M1 (isM1Type=true, bao gồm Eye Of Horus
        // fixedBurst) GIỮ NGUYÊN ghép nhóm theo weapon weight cũ.
        // GAP ĐÃ SỬA (xác nhận trực tiếp: "guard/evade/parry m1 không như tôi
        // bảo bạn... medium weapon đánh 6 hit, thì hãy group lại... group nó
        // lại thành 3 lần hỏi người dùng để họ tự ý chọn đỡ hit nào... chứ
        // không phải 1 lần là bắt guard thì guard cả 3, né thì né cả 3") —
        // REDESIGN THỐNG NHẤT: bỏ hẳn nhánh M1 riêng (dropdown "chọn nhóm hit"
        // showHitPicker — chỉ cho 1 loại phòng thủ áp dụng cho TOÀN BỘ hành
        // động) — giờ M1/Skill/Critical/Eye Of Horus dùng CHUNG hệ thống
        // per-NHÓM (groupSize = hitsPerCharge: Skill/Critical=1 hit/nhóm —
        // hành vi cũ giữ nguyên; M1=theo weapon weight VD medium=2; Eye Of
        // Horus fixedBurst=9 — tự động thành đúng 1 nhóm). Mỗi nhóm hỏi riêng,
        // lặp tự động, MỖI NHÓM CHỌN ĐỘC LẬP (mix Guard/Evade/Parry/Không
        // phòng thủ tuỳ ý giữa các nhóm khác nhau).
        const hitsPerCharge = p.isEyeOfHorusFixedBurst ? 9 : (isM1Type ? (WEAPON_DEFENSE_HITS[attackerWeapon] ?? 1) : 1);
        const groupCount = Math.ceil(hitCount / hitsPerCharge);
        const groupIdx = parseInt(counterSkillKeyOrHitIdx, 10);
        t.perHitBypass = t.perHitBypass ?? parsePerHitBypass(p.skillRollEmbed?.description, p.tags, groupCount);
        t.perHitChoices = t.perHitChoices ?? new Array(groupCount).fill(null);
        if (!Number.isFinite(groupIdx) || groupIdx < 0 || groupIdx >= groupCount || t.perHitChoices[groupIdx] !== null) {
          throw new Error("Nhóm hit này đã được quyết định rồi hoặc không hợp lệ — dùng lại bảng phản ứng mới nhất.");
        }
        const thisGroupBypass = t.perHitBypass[groupIdx];
        const hitsInThisGroup = Math.min(hitsPerCharge, hitCount - groupIdx * hitsPerCharge);
        const opts = computeDefenseOptions(target, attackerWeapon, hitsInThisGroup, isM1Type, thisGroupBypass, p.isEyeOfHorusFixedBurst ?? false);
        // Danh sách hit THẬT (1-based) trong nhóm này — ghi TOÀN BỘ vào
        // *HitSelections thay vì chỉ 1 index, để resolveOnePendingAction áp
        // đúng lựa chọn cho CẢ NHÓM (không phải chỉ 1 hit lẻ).
        const realHitIndices = [];
        for (let i = 0; i < hitsInThisGroup; i++) realHitIndices.push(groupIdx * hitsPerCharge + i + 1);
        let choiceNote = "";
        if (choice === "guard") {
          if (!opts.guard.available) {
            if (thisGroupBypass.blockGuard) throw new Error("Nhóm hit này có tag Unblockable — không thể Guard.");
            throw new Error(`Không đủ Stamina để Guard nhóm này (cần ${opts.guard.cost}, hiện có ${target.currentStamina}).`);
          }
          target.currentStamina -= opts.guard.cost;
          target.guardCharges = (target.guardCharges ?? 0) + opts.chargesNeeded;
          target.guardHitSelections = target.guardHitSelections ?? [];
          target.guardHitSelections.push(...realHitIndices);
          if (target.hasIronHorus) target.ironHorusGuardActiveThisTurn = true;
          if (targetResolved.type === "player") target.prescriptBlocked = true;
          if (target.hasZweiAssociation) target.zweiAssociationPendingTremor = true;
          choiceNote = `🛡️ Guard (-${opts.guard.cost} Sta)`;
          // "Tactical Suppression" (Eye Of Horus Critical) — xác nhận trực
          // tiếp: "Nếu Block trong trạng thái này, húc vào 1 kẻ địch và kích
          // hoạt Tremor Burst cùng Tremor Reverb lên người kẻ địch" — "1 kẻ
          // địch" = chính attacker đang bị Guard/Block ở đây (ngữ cảnh tự
          // nhiên nhất: đang Guard đòn của ai thì "húc" thẳng vào người đó).
          if (target.tacticalSuppressionActive) {
            const tsAtk = attacker.combatant;
            const tsResult = calcMathCore({
              dmgStr: "0B+TremorBurst", resStr: combatantResStr(tsAtk),
              tremorInit: tsAtk.tremor ?? 0, tremorReverbStacks: tsAtk.tremorReverb ?? 0,
            });
            tsAtk.currentHp = Math.max(0, tsAtk.currentHp - tsResult.totalDmg);
            tsAtk.currentStamina = Math.max(0, tsAtk.currentStamina - tsResult.totalTremorStaminaLoss);
            tsAtk.tremor = tsResult.finalTremor;
            tsAtk.tremorReverb = Math.min(TREMOR_VARIANT_MAX, (tsAtk.tremorReverb ?? 0) + 1);
            choiceNote += ` + [Tactical Suppression: húc ${attacker.label}, Tremor Burst -${tsResult.totalTremorStaminaLoss} Sta/-${tsResult.totalDmg.toFixed(3)} HP, +1 Tremor Reverb]`;
          }
        } else if (choice === "evade") {
          if (!opts.evade.available) throw new Error(opts.evade.blockedReason ? `Evade bị khoá: ${opts.evade.blockedReason}.` : `Không đủ Stamina để Evade nhóm này (cần ${opts.evade.cost}, hiện có ${target.currentStamina}).`);
          target.currentStamina -= opts.evade.cost;
          target.evadeCharges = (target.evadeCharges ?? 0) + opts.chargesNeeded;
          target.evadeHitSelections = target.evadeHitSelections ?? [];
          target.evadeHitSelections.push(...realHitIndices);
          if (opts.evade.cost === 0 && (target.lightDashFreeEvadeCharges ?? 0) > 0) target.lightDashFreeEvadeCharges -= 1;
          if (targetResolved.type === "player") target.prescriptEvaded = true;
          if (target.hasZweiAssociation) target.zweiAssociationPendingTremor = true;
          choiceNote = `💨 Evade (-${opts.evade.cost} Sta)${opts.evade.cost === 0 ? " [Light Dash miễn phí]" : ""}`;
        } else if (choice === "parry") {
          if (!opts.parry.available) throw new Error("Parry bị khoá cho nhóm này (Unparriable).");
          target.parryRolls = target.parryRolls ?? [];
          target.parryHitSelections = target.parryHitSelections ?? [];
          const penalty = getParryClashPenalty(target);
          for (let i = 0; i < opts.chargesNeeded; i++) {
            const rawRoll = 1 + Math.floor(Math.random() * 20);
            target.parryRolls.push(rawRoll - penalty);
          }
          target.parryHitSelections.push(...realHitIndices);
          if (targetResolved.type === "player") target.prescriptParried = true;
          if (target.hasZweiAssociation) target.zweiAssociationPendingTremor = true;
          const dullahanDmg = applyDullahanParryCounter(target, attacker.combatant);
          if (dullahanDmg !== null) target.dullahanParriedThisTurn = true;
          choiceNote = `🗡️ Parry (${opts.chargesNeeded} roll, 0 Sta)${dullahanDmg !== null ? ` + [Dullahan: đánh thường trả đũa -${dullahanDmg.toFixed(3)} HP]` : ""}`;
        } else {
          choiceNote = "❌ Không phòng thủ";
        }
        t.perHitChoices[groupIdx] = choiceNote;
        await saveEncounter(channelId, encounter);

        if (t.perHitChoices.some(c => c === null)) {
          // Còn nhóm chưa quyết định — KHÔNG finalize, sẽ gửi prompt nhóm tiếp
          // theo sau khi thoát withLock (tránh gọi sendReactiveDefensePrompt —
          // hàm này tự getEncounter/withLock riêng — TRONG lock hiện tại).
          needsNextHitPrompt = true;
          resultText = `Đã ghi nhận: ${choiceNote} cho nhóm ${groupIdx + 1}/${groupCount} (hit ${realHitIndices[0]}${realHitIndices.length > 1 ? `-${realHitIndices[realHitIndices.length - 1]}` : ""}/${hitCount}).`;
          return;
        }
        // Tất cả nhóm đã quyết định — finalize như bình thường.
        const finalized = await finalizeReactiveChoice(channelId, encounter, p, targetId, `Đã chọn phòng thủ riêng cho từng hit (${hitCount} hit).`, interaction.user.toString());
        resultText = finalized.resultText;
        stillWaitingFor = finalized.stillWaitingFor;
      });
      if (needsNextHitPrompt) {
        await interaction.update({
          content: `✅ ${resultText}`,
          embeds: [],
          components: [],
        }).catch(() => {});
        await sendReactiveDefensePrompt(channelId, pendingId);
        return;
      }
      const boardPayloadForUpdate = stillWaitingFor ? null : buildEncounterBoardEmbed(encounterSnapshot, channelId);
      await interaction.update({
        embeds: stillWaitingFor
          ? [{ title: "⏳ Đã ghi nhận — đang chờ người khác", description: resultText, color: 0xf39c12 }]
          : [{ title: "⚔️ Đã xử lý", description: resultText, color: 0x2ecc71 }, boardPayloadForUpdate.embed],
        components: boardPayloadForUpdate ? boardPayloadForUpdate.components : [],
      }).catch(() => {});
      // GAP ĐÃ SỬA (xác nhận trực tiếp qua ảnh chụp: "Dropdown vẫn còn bị che
      // rất nặng bởi các message sau khi kẻ địch đã thực thi xong reactive
      // defense") — nhánh Guard/Evade/Parry/Không phòng thủ (PHỔ BIẾN NHẤT)
      // TRƯỚC ĐÂY HOÀN TOÀN THIẾU resend này (chỉ nhánh Clash bên dưới có) —
      // gửi lại dropdown turn NGAY sau khi phản hồi xong, để nó luôn ở CUỐI
      // kênh (dễ thấy nhất), không bị "Đã xử lý"/board embed mới hơn che khuất.
      if (!stillWaitingFor) {
        const encAfterMainReactive = await getEncounter(channelId);
        if (encAfterMainReactive) announceCurrentTurn(channelId, encAfterMainReactive).catch(() => {});
      }
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  } catch (err) {
    log("error", "buttonInteraction", interaction.user?.id ?? "unknown", err.message);
    interaction.reply({ content: "❌ Có lỗi không mong muốn xảy ra.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});


// ─── SELECT MENU INTERACTIONS (encclashselect — Clash responsive, xác nhận
// trực tiếp: "khi bị đòn skill/page có dice đánh thì nếu có speed cao hơn thì
// sẽ có thể tiến hành bấm nút clash, ở đó sẽ hiện ra page/critical bản thân có
// thể dùng để clash") — sau khi chọn skill từ dropdown, roll THẬT skill đó, so
// Dice đầu tiên với attacker (lấy từ p.dmgStr — đã roll sẵn lúc declare, không
// roll lại), áp dụng ĐÚNG công thức thắng/thua Sanity+Coin của "-encounter
// clash" gốc, rồi hoặc HUỶ toàn bộ đòn (thắng) hoặc để nguyên ăn đủ dmg (thua).
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("encclashselect:")) return;
  const [, channelId, pendingId, targetId, clasherId] = interaction.customId.split(":");
  const chosenKey = interaction.values[0];
  try {
    let displayText = "";
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) { displayText = "⚠️ Encounter không còn tồn tại."; return; }
      const p = (encounter.pendingActions ?? []).find(pa => pa.id === pendingId);
      if (!p) { displayText = "⚠️ Action này đã được xử lý rồi."; return; }
      if (p.reactedTargetIds?.includes(targetId)) { displayText = "⚠️ Đòn này đã được xử lý rồi."; return; }
      const targetResolved = resolveCombatant(encounter, targetId);
      const clasherResolved = resolveCombatant(encounter, clasherId);
      const attackerResolved = resolveCombatant(encounter, p.attackerId);
      if (!targetResolved || !clasherResolved || !attackerResolved) { displayText = "⚠️ Không tìm thấy target/người Clash/attacker."; return; }
      const target = targetResolved.combatant;
      const clasher = clasherResolved.combatant;
      const chosenSkill = findSkill(chosenKey);
      if (!chosenSkill) { displayText = "❌ Không tìm thấy skill đã chọn."; return; }

      const myRoll = buildSkillRollResult({ skill: chosenSkill });
      if (myRoll.error || myRoll.firstDiceValue === null) { displayText = `❌ ${myRoll.error ?? "Skill này không có Dice để Clash."}`; return; }

      // firstDiceValue của attacker: LẤY TỪ p.dmgStr đã roll sẵn lúc declare
      // (KHÔNG roll lại — dùng đúng giá trị người chơi đã thấy), số ĐẦU TIÊN
      // trong chuỗi (VD "6S+8S+9S" → 6).
      const attackerFirstDiceMatch = (p.dmgStr ?? "").match(/^([\d.]+)/);
      const attackerFirstDiceValue = attackerFirstDiceMatch ? parseFloat(attackerFirstDiceMatch[1]) : null;
      if (attackerFirstDiceValue === null) { displayText = "❌ Đòn tấn công này không có Dice hợp lệ để Clash."; return; }

      // "Clasher" (người BẤM và THỰC HIỆN Clash) roll/tiêu resource/nhận
      // Sanity+Coin — CÓ THỂ khác "target" (người bị tấn công, chỉ được ngắt
      // dmg nếu clasher thắng) — xác nhận trực tiếp: "A Clash THAY cho B".
      const myPenalty = getParryClashPenalty(clasher);
      const oppPenalty = getParryClashPenalty(attackerResolved.combatant);
      const myEffectiveDice = myRoll.firstDiceValue - myPenalty + (clasher.clashAttackBoost ?? 0);
      const oppEffectiveDice = attackerFirstDiceValue - oppPenalty + (attackerResolved.combatant.clashAttackBoost ?? 0);

      // Tiêu Light/CD cho skill VỪA DÙNG để Clash (của CLASHER, không phải
      // target), bất kể thắng thua (đã dùng là dùng, giống "-encounter clash"
      // gốc không hoàn resource khi thua).
      const cost = parseSkillCost(chosenSkill.cost);
      clasher.currentLight = Math.max(0, (clasher.currentLight ?? 0) - (cost.light ?? 0));
      const cdTurns = parseSkillCooldownTurns(chosenSkill.cd);
      clasher.skillCooldowns = clasher.skillCooldowns ?? {};
      clasher.skillCooldowns[chosenKey] = cdTurns + 1;

      const clasherLabel = clasherId === targetId ? "Bạn" : clasherResolved.label;
      let choiceNote;
      if (myEffectiveDice > oppEffectiveDice) {
        // THẮNG Clash — HUỶ TOÀN BỘ đòn nhắm vào TARGET (không phải clasher —
        // dù clasher là người thắng, người được "cứu" khỏi dmg vẫn là target
        // gốc của đòn tấn công) — văn bản gốc: "người bị clash thua sẽ bị hủy
        // toàn bộ dice của skill/page". Tái dùng evadeCharges (perHitMult=0).
        const hitCount = Math.max(1, p.targets.find(tg => tg.targetId === targetId)?.preview?.dmgValues?.length ?? 1);
        target.evadeCharges = (target.evadeCharges ?? 0) + hitCount;
        const myBefore = clasher.currentSanity;
        applySanityGain(clasher, 10);
        applyEmotionDelta(clasher, 2);
        const oppBefore = attackerResolved.combatant.currentSanity;
        applyClashLossSanity(attackerResolved.combatant);
        applyEmotionDelta(attackerResolved.combatant, -1);
        checkStaggerPanic(clasher); checkStaggerPanic(attackerResolved.combatant);
        const myDelta = clasher.currentSanity - myBefore;
        const oppDelta = attackerResolved.combatant.currentSanity - oppBefore;
        choiceNote = `🏆 ${clasherLabel} THẮNG Clash! **${chosenSkill.name}** (${myEffectiveDice} vs ${oppEffectiveDice}) — ngắt toàn bộ đòn nhắm vào ${targetResolved.label}, ${myDelta >= 0 ? "+" : ""}${myDelta} Sanity +2 Coin cho ${clasherLabel}, đối thủ ${oppDelta >= 0 ? "+" : ""}${oppDelta} Sanity -1 Coin.`;
        // GAP ĐÃ SỬA (xác nhận trực tiếp: "các page counter vẫn có thể dùng để
        // clash được đó... trong trường hợp clash thắng thì sẽ tiến hành bước
        // gây dmg và hiệu ứng của page counter luôn") — nếu skill vừa dùng để
        // Clash CŨNG là 1 page-counter, áp dụng THÊM dmg/hiệu ứng riêng của nó
        // (giống hệt logic counter thành công ở route /rtparry — không tái
        // dùng trực tiếp được vì khác context, viết lại tương tự ở đây). Hiệu
        // ứng phụ (Protection/DefenseUp/Light...) áp lên CLASHER — người chủ
        // động dùng skill này, không phải target.
        const clashCounterEffect = chosenSkill.counterEffect;
        if (clashCounterEffect) {
          if (clashCounterEffect.light) clasher.currentLight = Math.min(clasher.maxLight, (clasher.currentLight ?? 0) + clashCounterEffect.light);
          if (clashCounterEffect.protection) clasher.protection = (clasher.protection ?? 0) + clashCounterEffect.protection;
          if (clashCounterEffect.defenseUp) clasher.defenseUp = (clasher.defenseUp ?? 0) + clashCounterEffect.defenseUp;
          if (clashCounterEffect.unlocksSkillKey) clasher.unlockedFollowUpSkillKey = clashCounterEffect.unlocksSkillKey;
          if (!clashCounterEffect.noDirectDamage) {
            const built = autoBuildDmgStrFromSkillRoll(chosenSkill);
            if (built.dmgStr) {
              let counterDmgStr = built.dmgStr;
              if (clashCounterEffect.customHitMultiplier) {
                counterDmgStr = Array(clashCounterEffect.customHitMultiplier).fill(built.dmgStr).join(" + ");
              }
              const counterResStr = combatantResStr(attackerResolved.combatant);
              const counterPreview = calcMathCore({ dmgStr: counterDmgStr, resStr: counterResStr, poiseInit: clasher.poise, chargeInit: clasher.charge });
              attackerResolved.combatant.currentHp = Math.max(0, attackerResolved.combatant.currentHp - counterPreview.totalDmg);
              if (clashCounterEffect.smokePerHit) {
                const hits = clashCounterEffect.customHitMultiplier ?? 1;
                attackerResolved.combatant.smoke = (attackerResolved.combatant.smoke ?? 0) + clashCounterEffect.smokePerHit * hits;
              }
              if (clashCounterEffect.paralyzeAfter) {
                attackerResolved.combatant.paralyze = (attackerResolved.combatant.paralyze ?? 0) + clashCounterEffect.paralyzeAfter;
              }
              if (chosenKey === "you're too slow") {
                clasher.youreTooSlowPending = { markedTargetId: p.attackerId, dmgStr: counterDmgStr };
              }
              choiceNote += ` Đồng thời phản công gây ${attackerResolved.label} -${counterPreview.totalDmg.toFixed(3)} HP (hiệu ứng page-counter).`;
            }
          } else {
            choiceNote += ` (Page-counter — ngắt đòn, không tự gây dmg riêng.)`;
          }
        }
      } else {
        // THUA (hoặc hoà — hoà tính thua theo đúng "-encounter clash" gốc,
        // dùng ">" nghiêm ngặt) — target vẫn ăn đủ dmg như bình thường (không
        // ai tiêu evadeCharges), CLASHER (người tham gia và thua) nhận Sanity
        // âm/-1 Coin, không phải target.
        const myBefore = attackerResolved.combatant.currentSanity;
        applySanityGain(attackerResolved.combatant, 10);
        applyEmotionDelta(attackerResolved.combatant, 2);
        const oppBefore = clasher.currentSanity;
        applyClashLossSanity(clasher);
        applyEmotionDelta(clasher, -1);
        checkStaggerPanic(clasher); checkStaggerPanic(attackerResolved.combatant);
        const myDelta = attackerResolved.combatant.currentSanity - myBefore;
        const oppDelta = clasher.currentSanity - oppBefore;
        choiceNote = `💔 ${clasherLabel} THUA Clash! **${chosenSkill.name}** (${myEffectiveDice} vs ${oppEffectiveDice}) — ${targetResolved.label} ăn đủ dmg, đối thủ ${myDelta >= 0 ? "+" : ""}${myDelta} Sanity +2 Coin, ${clasherLabel} ${oppDelta >= 0 ? "+" : ""}${oppDelta} Sanity -1 Coin.`;
      }

      const finalized = await finalizeReactiveChoice(channelId, encounter, p, targetId, choiceNote, `<@${targetId}>`);
      displayText = finalized.resultText;
    });
    await interaction.update({
      embeds: [{ title: "⚔️ Clash — Kết quả", description: displayText, color: 0x2ecc71 }],
      components: [],
    }).catch(() => {});
    // GAP ĐÃ SỬA (xác nhận trực tiếp): "sau khi responsive guard được thực thi
    // xong thì bị che mất luôn phần dropdown turn của người đang trong turn
    // khiến khó mà lần theo" — gửi lại (resend) dropdown turn hiện tại NGAY
    // sau khi phản hồi xong, để nó luôn nằm Ở CUỐI kênh (dễ thấy nhất), không
    // bị các tin nhắn reactive defense/kết quả mới hơn che khuất lên trên.
    {
      const encAfterReactive = await getEncounter(channelId);
      if (encAfterReactive) announceCurrentTurn(channelId, encAfterReactive).catch(() => {});
    }
  } catch (err) {
    interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId.startsWith("gachabanner:")) {
    const [, ownerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "⚠️ Chỉ chủ nhân bảng này mới chọn được — dùng `-gacha` để mở bảng riêng của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const bannerKey = interaction.values[0];
    if (!isBannerActive(bannerKey)) {
      return interaction.reply({ content: `⚠️ **${GACHA_BANNERS[bannerKey]?.name ?? bannerKey}** đã kết thúc.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      const { data: profileData } = await getPlayerDataWithSlot(interaction.user.id);
      const pity = profileData.gachaPity?.[bannerKey] ?? 0;
      await interaction.update({
        embeds: [buildGachaPanelEmbed(profileData.lunacy ?? 0, bannerKey, pity)],
        components: buildGachaPanelButtons(interaction.user.id, bannerKey, pity),
      }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  if (interaction.customId.startsWith("gachapityitem:")) {
    const [, ownerId, bannerKey] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "⚠️ Chỉ chủ nhân bảng này mới đổi được.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const chosenItem = interaction.values[0];
    try {
      const { remainingPity } = await performPityExchange(interaction.user.id, bannerKey, chosenItem);
      const { data: profileData } = await getPlayerDataWithSlot(interaction.user.id);
      await interaction.update({
        embeds: [{ title: "🎯 Đã đổi Pity thành công!", description: `Nhận được: **${chosenItem}**\nPity còn lại: **${remainingPity}/${GACHA_PITY_MAX}**`, color: 0x2ecc71 }],
        components: [],
      }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
});

// ─── MODAL SUBMIT INTERACTIONS (encounter attack/hit qua nút) ────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("encmodal:")) return;
  const parts = interaction.customId.split(":");
  const channelId = parts[1];
  const action = parts[2];
  const encodedPageName = parts[3]; // chỉ có khi action === "hit" VÀ chọn từ dropdown 1 Page cụ thể
  try {
    if (action === "repeat") {
      // Guard/Evade/Parry — Modal CHỈ có field "count" (không có targetStr) — PHẢI
      // xử lý TRƯỚC dòng đọc targetStr chung, vì field đó không tồn tại trong Modal
      // này (đọc field không tồn tại → Discord.js throw lỗi).
      const repeatType = parts[3]; // "guard" | "evade" | "parry"
      const countRaw = interaction.fields.getTextInputValue("count").trim();
      const count = countRaw === "" ? 1 : parseInt(countRaw, 10);
      if (!Number.isFinite(count) || count < 1 || count > 20) {
        throw new Error(`Số lần phải từ 1-20 (để trống = 1). Nhận được: "${countRaw}".`);
      }
      const isAdminRepeat = ADMIN_IDS.has(interaction.user.id);
      const lines = [];
      let stoppedEarly = false;
      for (let i = 0; i < count; i++) {
        try {
          let r;
          if (repeatType === "parry") r = await performParry(channelId, interaction.user.id, isAdminRepeat);
          else r = await performGuardEvade(channelId, interaction.user.id, isAdminRepeat, repeatType);
          lines.push(r);
        } catch (err) {
          lines.push(`❌ Dừng ở lần ${i + 1}/${count}: ${err.message}`);
          stoppedEarly = true;
          break;
        }
      }
      await interaction.reply({ content: lines.join("\n") + (stoppedEarly ? "" : ` ✅ (${count}/${count} lần)`) });
      return;
    }
    // bossattack/attack/criticalhit/hit KHÔNG còn field "targetStr" (đã chuyển
    // sang chọn qua dropdown enctarget/bossattacktarget TRƯỚC khi mở Modal) — target
    // giờ nằm trong customId (parts[4], đã encode lúc chọn dropdown), không phải
    // đọc từ field Modal nữa — đọc field không tồn tại sẽ throw lỗi.
    const targetFromCustomId = ["attack", "criticalhit", "hit"].includes(action);
    const targetStr = action === "bossattack" ? null
      : targetFromCustomId ? decodeURIComponent(parts[4] ?? "")
      : interaction.fields.getTextInputValue("targetStr");
    // messageId của dropdown gốc (chỉ "attack" có — xem enctarget handler,
    // parts[5]) — dùng để xoá HẲN message đó sau khi resolve xong, thay vì để
    // lại nguyên dropdown không còn tác dụng gì.
    const dropdownMessageId = action === "attack" ? parts[5] : null;
    if (action === "attack") {
      const isAutoCalc = parts[3] === "auto";
      const isFixedBurst = parts[3] === "fixedburst";
      let dmgStr, ammoTypeInput;
      if (isFixedBurst) {
        // GAP ĐÃ SỬA HOÀN TOÀN LẦN THỨ 3 (xác nhận trực tiếp kèm passive text
        // đầy đủ) — KHÔNG còn field "volleys" để đọc nữa — doPlayerAttack giờ
        // tự tính hoàn toàn dựa trên per-target hit counter, không cần input gì.
        ammoTypeInput = interaction.fields.getTextInputValue("ammotype")?.trim() || undefined;
        dmgStr = ""; // doPlayerAttack tự xây dựng riêng từng target, không cần dmgStr ở đây
      } else if (isAutoCalc) {
        const hitCountRaw = interaction.fields.getTextInputValue("hitCount");
        const hitCount = parseInt(hitCountRaw.trim(), 10);
        if (!Number.isFinite(hitCount) || hitCount < 1 || hitCount > 50) {
          throw new Error(`"Đánh mấy lần?" phải là số nguyên từ 1-50 (nhận được: "${hitCountRaw}").`);
        }
        const encounter = await getEncounter(channelId);
        const combatant = encounter?.players?.[interaction.user.id];
        if (!combatant || !Number.isFinite(combatant.weaponBaseDamage) || !combatant.weaponType) {
          throw new Error("Không tìm thấy dữ liệu vũ khí — dùng `-encounter attack target: ... dmg: ...` (lệnh text) thay vào đó.");
        }
        // Type text (Blunt/Pierce/Slash) → chữ cái dmgStr cần (B/P/S).
        const typeLetter = { Blunt: "B", Pierce: "P", Slash: "S" }[combatant.weaponType];
        if (!typeLetter) throw new Error(`Type vũ khí "${combatant.weaponType}" không nhận diện được (cần Blunt/Pierce/Slash).`);
        dmgStr = hitCount > 1 ? `${combatant.weaponBaseDamage}x${hitCount}${typeLetter}` : `${combatant.weaponBaseDamage}${typeLetter}`;
      } else {
        dmgStr = interaction.fields.getTextInputValue("dmgStr");
      }
      const { embed } = await doPlayerAttack(channelId, interaction.user.id, interaction.user.toString(), dmgStr, targetStr, { ammotype: ammoTypeInput });
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "Xóa HẳN embed này... XÓA LUÔN tin
      // nhắn dropdown đó") — xoá message dropdown gốc (đã hết tác dụng), reply
      // ephemeral ngắn gọn (chỉ người dùng thấy) thay vì embed công khai đầy đủ.
      if (dropdownMessageId) {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        const oldMsg = ch ? await ch.messages.fetch(dropdownMessageId).catch(() => null) : null;
        if (oldMsg) await oldMsg.delete().catch(() => {});
      }
      await interaction.reply({ content: "✅ Đã xác nhận đòn đánh — xem kết quả ở board/reactive-defense.", flags: MessageFlags.Ephemeral }).catch(() => {});
    } else if (action === "bossattack") {
      // Boss UI (theo yêu cầu trực tiếp: "phần encounter của boss cần 1 lệnh UI",
      // mở rộng thêm sau đó: "boss có thể được GM customize rất nhiều... 1 số đòn
      // không dmg nhưng hiệu ứng") — enemyKey nằm ở parts[3], targetId (đã chọn từ
      // dropdown bossattacktarget) nằm ở parts[4].
      const enemyKey = parts[3];
      const bossTargetId = parts[4];
      const bossIsM1Flag = parts[5]; // "m1" hoặc "skill" — xem bossmenu/bossattacktarget handler
      const bossTargetStr = bossTargetId === "all" ? "all" : `<@${bossTargetId}>`;
      const dmgStr = interaction.fields.getTextInputValue("dmgStr");
      const tags = interaction.fields.getTextInputValue("tags")?.trim() || undefined;
      const note = interaction.fields.getTextInputValue("note")?.trim() || undefined;
      const { summary, skillRollEmbed } = await doEnemyAttack(channelId, interaction.user.id, enemyKey, dmgStr, bossTargetStr, { tags, ism1: bossIsM1Flag === "m1" ? "yes" : undefined });
      const finalSummary = note ? `${summary}\n> 📝 **Hiệu ứng:** ${note}` : summary;
      await interaction.reply({ content: finalSummary, embeds: skillRollEmbed ? [skillRollEmbed] : [] });
      // hit/criticalhit (Modal) ĐÃ GỠ — thực thi trực tiếp từ dropdown enctarget
      // (không còn Modal nào cho 2 nhánh này nữa — xem subAction === "criticalhit"
      // || "hit" ở handler đó, LỖ HỔNG BẢO MẬT ĐÃ SỬA: dmgStr giờ roll thật +
      // lưu server-side, không còn field Modal nào để "tưởng sửa được").
      // followup (Modal) ĐÃ GỠ — thực thi trực tiếp từ dropdown enctarget, xem
      // subAction === "followup" ở handler đó (không cần Modal vì không còn field
      // nào khác ngoài target).
    }
  } catch (err) {
    log("error", "encModalSubmit", interaction.user?.id ?? "unknown", err.message);
    await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// GAP ĐÃ SỬA (xác nhận trực tiếp: "Bot tự roll Durandal, tự cho vào phần modal
// Dmg ra dmg đầu cuối lên kẻ địch") — Map<key, session> lưu TẠM kết quả roll thật
// giữa lúc chọn "Critical" từ dropdown (roll + build Modal) và lúc submit Modal
// (tính dmg cuối) — Discord KHÔNG cho hiện cả embed lẫn Modal cùng lúc trên 1
// interaction, nên roll THẬT phải xảy ra lúc chọn dropdown (pre-fill dmgStr vào
// Modal), rồi lúc submit PHẢI tái dùng CHÍNH kết quả đó (không roll lại lần 2 —
// nếu roll lại sẽ ra dice khác, dmgStr pre-fill không khớp embed thật, sai lệch
// nghiêm trọng). TTL ngắn (RAM, không cần Upstash) — cùng pattern webParrySessions
// (rtparry.js): key sống vài phút, nếu bot restart giữa chừng thì coi như hỏng
// phiên, chấp nhận được vì tần suất cực thấp.
const pendingCriticalRolls = new Map();
const PENDING_CRITICAL_ROLL_TTL_MS = 5 * 60_000; // 5 phút — đủ để mở Modal và điền
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of pendingCriticalRolls) if (s.expiresAt < now) pendingCriticalRolls.delete(key);
}, 60_000);

// ─── SELECT MENU INTERACTIONS (encounter) ────────────────────────────────────
// Dropdown hành động ĐỘNG (xem buildEncounterActionPanel) — thay cho 2 nút
// Attack/Hit cố định cũ. attack/hit:<page> mở Modal (cần target+dmg); followup mở
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("gmpanelselect:")) return;
  const [, channelId, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
    return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const ekey = interaction.values[0];
  try {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Encounter không còn tồn tại.");
    const enemy = encounter.enemies[ekey];
    if (!enemy) throw new Error("Không tìm thấy enemy này (có thể đã bị xoá).");
    // GAP ĐÃ SỬA (xác nhận trực tiếp: "gm có thể chỉnh sửa bất cứ thứ gì...
    // add, edit enemy, status") — thay vì thẳng vào Attack panel, hiện 2 lựa
    // chọn: Điều khiển (M1/Guard/Evade/Parry như cũ) HAY Chỉnh sửa (HP/Stamina/
    // Status qua Modal mới).
    await interaction.update({
      embeds: [{ title: `👹 ${enemy.name} (${ekey})`, description: `HP: ${enemy.currentHp}/${enemy.maxHp} | Stamina: ${enemy.currentStamina}/${enemy.maxStamina}\nBạn muốn làm gì?`, color: 0xe74c3c }],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gmenemymode:${channelId}:${ekey}:${interaction.user.id}:control`).setLabel("⚔️ Điều khiển").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`gmenemymode:${channelId}:${ekey}:${interaction.user.id}:edit`).setLabel("✏️ Chỉnh sửa").setStyle(ButtonStyle.Secondary),
      )],
    }).catch(() => {});
  } catch (err) {
    interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// GAP ĐÃ SỬA (xác nhận trực tiếp: "làm điều tương tự với player") — dropdown
// chọn player từ gmpanel, mở THẲNG Modal chỉnh sửa (không có bước "Điều khiển"
// trung gian như enemy, vì GM không "điều khiển" combat thay player).
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("gmpanelplayerselect:")) return;
  const [, channelId, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
    return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const targetPlayerId = interaction.values[0];
  try {
    const encounter = await getEncounter(channelId);
    if (!encounter) throw new Error("Encounter không còn tồn tại.");
    const player = encounter.players[targetPlayerId];
    if (!player) throw new Error("Không tìm thấy player này (có thể đã rời encounter).");
    const modal = new ModalBuilder()
      .setCustomId(`gmeditmodal:${channelId}:player:${targetPlayerId}`)
      .setTitle(`Chỉnh sửa: ${player.name}`.slice(0, 45));
    const hpInput = new TextInputBuilder().setCustomId("hp").setLabel("HP").setStyle(TextInputStyle.Short).setValue(String(player.currentHp)).setRequired(true);
    const staInput = new TextInputBuilder().setCustomId("stamina").setLabel("Stamina").setStyle(TextInputStyle.Short).setValue(String(player.currentStamina)).setRequired(true);
    // GAP ĐÃ SỬA (xác nhận trực tiếp: "thêm 1 mục modal là 1 phần addnote...
    // để narrate") — Modal Discord giới hạn CỨNG 5 TextInput/Modal, đã đủ 5
    // (hp/stamina/sanity/light/status) — gộp Sanity+Light thành 1 field
    // (cú pháp "sanity/light", giống tinh thần HP/Stamina gộp ở addenemy) để
    // giải phóng 1 slot riêng cho addnote.
    const sanLightInput = new TextInputBuilder().setCustomId("sanlight").setLabel("Sanity/Light").setStyle(TextInputStyle.Short).setValue(`${player.currentSanity ?? 0}/${player.currentLight ?? 0}`).setRequired(true);
    const statusInput = new TextInputBuilder()
      .setCustomId("status")
      .setLabel("Status/Set/Injury/CD (xem placeholder)")
      .setPlaceholder("rupture: 5 | set emotioncoin: 2 | injury+: Gãy chân | cd durandal: 3")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);
    // "addnote" — field RIÊNG BIỆT (KHÁC hẳn cú pháp "note:" gộp trong ô Status
    // ở trên — vẫn giữ nguyên cú pháp đó cho tương thích) — 1 dòng text tự do
    // để narrate hoặc ghi chú mechanic thuần text, hiển thị dưới status của
    // player/boss trong board (dùng CHUNG field gmNote đã có sẵn).
    const noteInput = new TextInputBuilder().setCustomId("addnote").setLabel("Ghi chú (narrate/mechanic thuần text)").setPlaceholder("Để trống nếu không đổi").setStyle(TextInputStyle.Paragraph).setValue(player.gmNote ?? "").setRequired(false);
    modal.addComponents(
      new ActionRowBuilder().addComponents(hpInput),
      new ActionRowBuilder().addComponents(staInput),
      new ActionRowBuilder().addComponents(sanLightInput),
      new ActionRowBuilder().addComponents(statusInput),
      new ActionRowBuilder().addComponents(noteInput),
    );
    await interaction.showModal(modal).catch(() => {});
  } catch (err) {
    interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// GAP ĐÃ SỬA — Bước 2/3: sau khi chọn target, hiện dropdown CHỌN STATUS (35
// status hợp lệ trong STATUS_CAPS_SHARED — vượt giới hạn 25 option/dropdown
// của Discord, nên chia làm 2 dropdown riêng, GM chọn 1 trong 2).
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("gmquickstatustarget:")) return;
  const [, channelId, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
    return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const targetSpec = interaction.values[0]; // "enemy:<key>" hoặc "player:<id>"
  try {
    const allKeys = Object.keys(STATUS_CAPS_SHARED);
    const half = Math.ceil(allKeys.length / 2);
    const group1 = allKeys.slice(0, half);
    const group2 = allKeys.slice(half);
    const menu1 = new StringSelectMenuBuilder()
      .setCustomId(`gmquickstatuspick:${channelId}:${ownerId}:${targetSpec}:g1`)
      .setPlaceholder(`Status (nhóm 1/2: ${group1[0]}...${group1[group1.length - 1]})`)
      .addOptions(...group1.map(k => new StringSelectMenuOptionBuilder().setLabel(k).setValue(k)));
    const menu2 = new StringSelectMenuBuilder()
      .setCustomId(`gmquickstatuspick:${channelId}:${ownerId}:${targetSpec}:g2`)
      .setPlaceholder(`Status (nhóm 2/2: ${group2[0]}...${group2[group2.length - 1]})`)
      .addOptions(...group2.map(k => new StringSelectMenuOptionBuilder().setLabel(k).setValue(k)));
    await interaction.update({
      embeds: [{ title: "🎯 Set Status — Bước 2: Chọn status", description: "Danh sách chia 2 nhóm do giới hạn Discord (tối đa 25 lựa chọn/dropdown).", color: 0xf39c12 }],
      components: [new ActionRowBuilder().addComponents(menu1), new ActionRowBuilder().addComponents(menu2)],
    }).catch(() => {});
  } catch (err) {
    interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// GAP ĐÃ SỬA — Bước 3/3: sau khi chọn status, mở Modal nhỏ nhập số lượng
// (+/-), rồi áp dụng qua applyStatusEntries (dùng CHUNG logic với setstatus/
// gmeditmodal — không viết lại).
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("gmquickstatuspick:")) return;
  const [, channelId, ownerId, targetType, targetId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
    return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const statusKey = interaction.values[0];
  const modal = new ModalBuilder()
    .setCustomId(`gmquickstatusmodal:${channelId}:${targetType}:${targetId}:${statusKey}`)
    .setTitle(`Set ${statusKey}`.slice(0, 45));
  const amountInput = new TextInputBuilder().setCustomId("amount").setLabel(`Số lượng ${statusKey} (cộng thêm, có thể âm)`).setPlaceholder("VD: 5 hoặc -3").setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
  await interaction.showModal(modal).catch(() => {});
});

// Áp dụng cuối cùng — TÁI DÙNG applyStatusEntries (KHÔNG viết lại logic status).
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("gmquickstatusmodal:")) return;
  const [, channelId, targetType, targetId, statusKey] = interaction.customId.split(":");
  try {
    const amountRaw = interaction.fields.getTextInputValue("amount").trim();
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Encounter không còn tồn tại.");
      const resolved = resolveCombatant(encounter, targetId);
      if (!resolved) throw new Error(`Không tìm thấy ${targetType === "enemy" ? "enemy" : "player"} này.`);
      const changes = applyStatusEntries(resolved, [{ type: "status", key: statusKey, raw: amountRaw }], null, checkStaggerPanic);
      await saveEncounter(channelId, encounter);
      appendActionLog(encounter, `📊 ${resolved.label}: ${changes.join(", ")} (qua Set Status nhanh)`);
      await interaction.reply({
        embeds: [{ title: "✅ Đã set status", description: `${resolved.label}: ${changes.join(", ")}`, color: 0x2ecc71 }],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    });
  } catch (err) {
    interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});
// "Reload" (nút riêng, KHÁC Page "Re-Load") — xác nhận trực tiếp: "Nạp tùy ý
// ví dụ nạp 5 xong sau đó nạp thêm 3 cũng được. Chỉ là không nạp được quá hơn
// max ammo của vũ khí" — nạp từ kho dự trữ Encounter (ammo/frostAmmo/
// incendiaryAmmo, đã có sẵn qua -encounter reload) vào bulletStack, KHÔNG
// giới hạn số lần/turn, KHÔNG tốn Light/Stamina, tôn trọng "chỉ 1 loại tại 1
// thời điểm" giống Re-Load Page.
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("reloadmodal:")) return;
  const [, channelId] = interaction.customId.split(":");
  try {
    const amountRaw = parseInt(interaction.fields.getTextInputValue("amount").trim(), 10);
    const typeRaw = interaction.fields.getTextInputValue("type").trim().toLowerCase();
    if (!Number.isFinite(amountRaw) || amountRaw < 1) throw new Error("Số lượng phải là số nguyên ≥1.");
    const RELOAD_FIELD_MAP = { ammo: "ammo", frost: "frostAmmo", incendiary: "incendiaryAmmo" };
    const sourceField = RELOAD_FIELD_MAP[typeRaw];
    if (!sourceField) throw new Error(`Loại đạn không hợp lệ: "${typeRaw}" — dùng ammo/frost/incendiary.`);
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Encounter không còn tồn tại.");
      const player = encounter.players[interaction.user.id];
      if (!player) throw new Error("Bạn chưa tham gia encounter này.");
      if (player.weaponName !== "Soldato Rifle") throw new Error("Chỉ dùng được với vũ khí Soldato Rifle.");
      if ((player.bulletStack ?? 0) > 0 && player.bulletStackType && player.bulletStackType !== typeRaw) {
        throw new Error(`Đang còn ${player.bulletStack} đạn loại **${player.bulletStackType}** trong súng — phải dùng hết (usebullet: yes qua M1) trước khi nạp loại **${typeRaw}** khác.`);
      }
      const owned = player[sourceField] ?? 0;
      const roomLeft = 8 - (player.bulletStack ?? 0);
      const actualAmount = Math.min(amountRaw, owned, roomLeft);
      if (actualAmount <= 0) {
        throw new Error(owned <= 0
          ? `Không còn **${typeRaw}** nào trong kho dự trữ Encounter — dùng \`-encounter reload amount: <số> type: ${typeRaw}\` trước.`
          : `Súng đã đầy (${player.bulletStack}/8) — không nạp thêm được.`);
      }
      player[sourceField] = owned - actualAmount;
      player.bulletStack = Math.min(8, (player.bulletStack ?? 0) + actualAmount);
      player.bulletStackType = typeRaw;
      appendActionLog(encounter, `🔫 <@${interaction.user.id}>: Reload ${typeRaw} +${actualAmount} vào Soldato Rifle (${player.bulletStack}/8)`);
      await saveEncounter(channelId, encounter);
      await interaction.reply({
        embeds: [{ title: "🔫 Reload", description: `Đã nạp **+${actualAmount} ${typeRaw}** vào súng — hiện có **${player.bulletStack}/8**.${actualAmount < amountRaw ? ` *(giới hạn bởi ${owned < amountRaw ? "kho dự trữ" : "sức chứa súng"})*` : ""}`, color: 0x2ecc71 }],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    });
  } catch (err) {
    interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});
// Modal đơn giản hơn (chỉ target); còn lại (guard/evade/parry/shinmang/
// manifestego/overcharge) thực thi NGAY qua các hàm perform* dùng CHUNG với lệnh
// text -encounter (xem định nghĩa performGuardEvade/performParry/...).
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("encmenu:") && !interaction.customId.startsWith("encmenumoves:") && !interaction.customId.startsWith("encmenuspecial:") && !interaction.customId.startsWith("encmenuitems:")) return;
  const [, channelId, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân dropdown này mới chọn được — dùng `-encounter status` để có dropdown riêng của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const value = interaction.values[0];
  try {
    // "Stagger" — GAP ĐÃ SỬA (xác nhận trực tiếp): người đang Stagger "không
    // thể sử dụng reactive defense hay hành động tiếp được nữa" — trước đây
    // dropdown encmenu HOÀN TOÀN không check staggered, cho phép họ tiếp tục
    // hành động chủ động (M1/skill/critical...) dù đang Stagger — chỉ cho
    // "endmyturn" đi qua (để không bị kẹt UI, dù về lý thuyết turn của họ đã
    // tự động bị advanceToNextTurnHolder bỏ qua).
    if (value !== "endmyturn") {
      const encStaggerCheck = await getEncounter(channelId);
      const combatantStaggerCheck = encStaggerCheck?.players?.[interaction.user.id];
      if (combatantStaggerCheck?.staggered) {
        return interaction.reply({ content: "⚠️ Bạn đang bị Stagger — không thể hành động (kể cả phòng thủ) cho tới khi tỉnh lại.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    if (value === "back") {
      const encBack = await getEncounter(channelId);
      const combatantBack = encBack?.players?.[interaction.user.id];
      if (!combatantBack) return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return interaction.update({ components: buildEncounterActionPanel(channelId, combatantBack, interaction.user.id) }).catch(() => {});
    }
    if (value === "openmoves" || value === "openspecial" || value === "openitems") {
      const encOpenSub = await getEncounter(channelId);
      const combatantOpenSub = encOpenSub?.players?.[interaction.user.id];
      if (!combatantOpenSub) return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
      const panel = value === "openmoves" ? buildMovesPanel(channelId, combatantOpenSub, interaction.user.id)
        : value === "openspecial" ? buildSpecialPanel(channelId, combatantOpenSub, interaction.user.id)
        : buildItemsPanel(channelId, combatantOpenSub, interaction.user.id);
      return interaction.update({ components: panel }).catch(() => {});
    }
    if (value === "attack") {
      // "M1 cạn Stamina" — GAP ĐÃ SỬA (xác nhận trực tiếp): "dùng m1 cạn
      // stamina xong vẫn còn act được thông qua dropdown" — trước đây KHÔNG
      // check Stamina tối thiểu TRƯỚC khi mở target dropdown, chỉ throw lỗi
      // SAU khi đã chọn target + nhập dmg (Modal) — để chặn SỚM ngay từ
      // dropdown, không để họ đi hết luồng rồi mới báo lỗi.
      const encStamCheck = await getEncounter(channelId);
      const combatantStamCheck = encStamCheck?.players?.[interaction.user.id];
      const minStaminaCost = WEAPON_STAMINA_COST[combatantStamCheck?.weaponWeight ?? "medium"];
      if ((combatantStamCheck?.currentStamina ?? 0) < minStaminaCost) {
        return interaction.reply({ content: `⚠️ Không đủ Stamina để đánh thường (cần tối thiểu ${minStaminaCost}, hiện có ${combatantStamCheck?.currentStamina ?? 0}).`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      // M1 (Đánh thường) — theo yêu cầu trực tiếp: hỏi "đánh mấy lần" thay vì bắt
      // gõ tay cả công thức dmgStr — tự tính từ vũ khí đã equip (weaponBaseDamage/
      // weaponType lưu trên combatant, xem createCombatant/join/swapweapon). Nếu
      // KHÔNG có dữ liệu vũ khí (chưa từng equip gì rõ ràng) → fallback về Modal
      // dmgStr CŨ (gõ tay), để không chặn hoàn toàn player chưa equip.
      const encounter = await getEncounter(channelId);
      const combatant = encounter?.players?.[interaction.user.id];
      const hasWeaponData = combatant && Number.isFinite(combatant.weaponBaseDamage) && combatant.weaponType;
      // Eye Of Horus — BUG ĐÃ SỬA (xác nhận trực tiếp từ GM): "M1 của Eye of Horus
      // là 3x9P — 1 lần đánh sẽ ra 9 hit" — nghĩa là số hit KHÔNG PHẢI player tự
      // chọn (khác mọi vũ khí khác), mà LUÔN CỐ ĐỊNH 9 mỗi lần "đánh thường" (vũ
      // khí burst cố định, gắn liền với cơ chế Ammo). Trước đây dùng CHUNG Modal
      // "hỏi mấy lần" như vũ khí thường — sai hoàn toàn, cho phép player tự ý nhập
      // số hit tuỳ ý thay vì luôn đúng 9.
      const isFixedBurstWeapon = hasWeaponData && (combatant.weaponName ?? "").toLowerCase() === "eye of horus";
      const mode = isFixedBurstWeapon ? "fixedburst" : hasWeaponData ? "auto" : "manual";
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "phần target... nên sửa lại thành cho bấm
      // thay vì là key... giống 1 game hơn") — chọn target qua DROPDOWN (tên thật,
      // multi-select cho AOE) TRƯỚC, Modal sau đó CHỈ hỏi phần dmg (không còn gõ
      // tay key enemy nữa).
      // M1 (Đánh thường) LUÔN single-target — KHÔNG có vũ khí nào AOE (đã kiểm
      // tra weapon.js) — BUG BẢO MẬT ĐÃ SỬA (xác nhận trực tiếp: "có trường hợp
      // có những người cố tình cheating chọn tất cả (AOE) dù đòn của họ chỉ 1
      // target") — isAoe=false + setMaxValues(1), không còn option "all" nữa
      // nên length===0 (chứ không phải ===1) mới là "hết enemy".
      const targetOptions = buildEnemyTargetOptions(encounter, false);
      if (targetOptions.length === 0) {
        return interaction.reply({ content: "⚠️ Không còn enemy nào (còn sống) để nhắm.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      await interaction.update({
        embeds: [{ title: "⚔️ Đánh thường (M1) — chọn target", description: "Chọn 1 enemy muốn nhắm:", color: 0x3498db }],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`enctarget:${channelId}:attack:${mode}`)
            .setPlaceholder("Chọn target...")
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"), ...targetOptions),
        )],
      }).catch(() => {});
      return;
    }
    if (value.startsWith("critical:")) {
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "Bot tự roll Durandal, tự cho vào phần
      // modal Dmg ra dmg đầu cuối lên kẻ địch") — roll skill THẬT NGAY LÚC CHỌN
      // dropdown (Discord không cho hiện embed + Modal cùng lúc trên 1 interaction),
      // lưu kết quả vào pendingCriticalRolls để MODAL SUBMIT tái dùng (không roll
      // lại lần 2 — xem comment đầy đủ ở khai báo Map phía trên), rồi pre-fill
      // field dmgStr với công thức đã tính.
      const critSkillName = value.slice(9);
      const encounter = await getEncounter(channelId);
      const combatant = encounter?.players?.[interaction.user.id];
      if (!combatant) {
        return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (!hasEncounterStarted(encounter)) {
        return interaction.reply({ content: "⚠️ Encounter chưa bắt đầu — GM cần chạy `-encounter rollspeed` trước.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (!isCurrentTurnHolder(encounter, interaction.user.id)) {
        return interaction.reply({ content: "⚠️ Chưa tới lượt bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      let verify;
      try {
        verify = await resolveSkillVerification(channelId, combatant, critSkillName, null, true);
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (!verify.autoDmgStr) {
        // BUG NGHIÊM TRỌNG ĐÃ SỬA (phát hiện qua ảnh chụp thật của user — "Durandal"
        // Critical không có dmg trực tiếp): TRƯỚC ĐÂY nhánh này chỉ hiện embed rồi
        // DỪNG HẲN — resolveSkillVerification ĐÃ mutate combatant (paralyze/chains/
        // busyAsTribbie) NHƯNG KHÔNG saveEncounter nào cả (mất trắng thay đổi), Light
        // Cost/Cooldown KHÔNG được áp dụng (skill dùng "miễn phí"), VÀ turn KHÔNG bao
        // giờ advance (kẹt game — mọi người bị Turn Order Enforcement chặn vĩnh viễn
        // cho tới khi ai đó tự gõ `-encounter pass`). Sửa: build 1 pendingAction với
        // targets RỖNG (không có dmg/target nào để tính) nhưng ĐẦY ĐỦ skillKey/
        // cooldownTurns/emotionDelta/lightCost/sanityCost — route qua ĐÚNG
        // resolveOnePendingAction (tái dùng nguyên logic áp dụng side-effect, y hệt
        // mọi hành động khác), rồi advance turn + save như bình thường.
        const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const p = {
          id: pendingId, kind: "critical", attackerId: interaction.user.id,
          targets: [], dmgStr: `Critical: ${critSkillName}`, defenseBypass: {},
          skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: verify.emotionDelta ?? 0, orlandoFuriosoBypassConsumed: verify.orlandoFuriosoBypassConsumed ?? false,
          lightCost: verify.lightCost, sanityCost: verify.sanityCost,
        };
        const lines = await resolveOnePendingAction(encounter, p);
        // GAP ĐÃ SỬA (xác nhận trực tiếp: "1 turn act bao nhiêu lần cũng được")
        // — không còn advance turn tự động sau hành động này nữa.
        await saveEncounter(channelId, encounter);
        announceCurrentTurn(channelId, encounter).catch(() => {});
        return interaction.reply({
          embeds: [verify.skillRollEmbed, { description: `*(Critical này không có dice sát thương trực tiếp để tự tính dmg — dùng \`-encounter buff\`/lệnh liên quan để narrate hiệu ứng nếu cần.)*${lines.length ? `\n${lines.join("\n")}` : ""}`, color: 0x95a5a6 }],
        }).catch(() => {});
      }
      const pendingKey = `${channelId}:${interaction.user.id}`;
      pendingCriticalRolls.set(pendingKey, {
        dmgStr: verify.autoDmgStr,
        skillRollEmbed: verify.skillRollEmbed,
        skillKey: verify.skillKey,
        cooldownTurns: verify.cooldownTurns,
        emotionDelta: verify.emotionDelta,
        lightCost: verify.lightCost,
        sanityCost: verify.sanityCost,
        autoWarnings: verify.autoWarnings,
        orlandoFuriosoBypassConsumed: verify.orlandoFuriosoBypassConsumed ?? false,
        expiresAt: Date.now() + PENDING_CRITICAL_ROLL_TTL_MS,
      });
      // GAP ĐÃ SỬA (xác nhận trực tiếp: target dropdown thay vì gõ key) — chọn
      // target TRƯỚC (dropdown tên thật), Modal sau đó CHỈ hỏi dmg (đã roll sẵn,
      // pre-fill, vẫn được bảo vệ bởi fix bảo mật trước đó — sửa trong Modal
      // không ảnh hưởng dmg thật). BUG BẢO MẬT ĐÃ SỬA (cùng nguyên nhân với M1):
      // isAoe/maxTargets đọc TRỰC TIẾP từ tag "[AOE...]" trong text roll() thật
      // của Critical này — không phải LUÔN cho phép chọn tối đa mọi enemy (VD
      // "[AOE 3 người]" chỉ được chọn ĐÚNG tối đa 3, không phải toàn bộ).
      const { isAoe: isAoeThisCritical, maxTargets: aoeMaxThisCritical } = parseAoeInfo(verify.skillRollEmbed?.description);
      const targetOptions = buildEnemyTargetOptions(encounter, isAoeThisCritical && aoeMaxThisCritical === Infinity);
      if (targetOptions.length === 0) {
        pendingCriticalRolls.delete(pendingKey);
        return interaction.reply({ content: "⚠️ Không còn enemy nào (còn sống) để nhắm.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      await interaction.update({
        embeds: [verify.skillRollEmbed, { title: `⚡ Critical: ${critSkillName} — chọn target`, description: isAoeThisCritical ? `Chọn tối đa ${Math.min(aoeMaxThisCritical, targetOptions.length)} enemy muốn nhắm:` : "Chọn 1 enemy muốn nhắm:", color: 0x3498db }],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`enctarget:${channelId}:criticalhit:${encodeURIComponent(critSkillName)}`)
            .setPlaceholder("Chọn target...")
            .setMinValues(1)
            .setMaxValues(isAoeThisCritical ? Math.min(aoeMaxThisCritical, targetOptions.length) : 1)
            .addOptions(new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"), ...targetOptions),
        )],
      }).catch(() => {});
      return;
    }
    if (value.startsWith("hit:")) {
      // LỖ HỔNG BẢO MẬT ĐÃ SỬA (xác nhận trực tiếp qua ảnh chụp thật: "dù Blade
      // Flourish đã roll sẵn ở dropdown rồi nhưng vẫn bắt tôi nhập dmg thành ra
      // tôi có thể thử nhập 50x3B") — TRƯỚC ĐÂY roll skill CHỈ để hiển thị embed
      // tham khảo, còn damage THẬT vẫn lấy từ Modal field gõ tay (không hề liên
      // quan tới roll) — giờ ÁP DỤNG Y HỆT fix đã làm cho Critical: roll NGAY lúc
      // chọn dropdown, lưu autoDmgStr server-side, Modal (nếu cần) không còn field
      // dmgStr gõ tay nữa.
      const pageName = value.slice(4);
      const encounter = await getEncounter(channelId);
      const combatant = encounter?.players?.[interaction.user.id];
      if (!combatant) {
        return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (!hasEncounterStarted(encounter)) {
        return interaction.reply({ content: "⚠️ Encounter chưa bắt đầu — GM cần chạy `-encounter rollspeed` trước.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (!isCurrentTurnHolder(encounter, interaction.user.id)) {
        return interaction.reply({ content: "⚠️ Chưa tới lượt bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      let verify;
      try {
        verify = await resolveSkillVerification(channelId, combatant, pageName, null, false);
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      const pendingKey = `${channelId}:${interaction.user.id}`;
      pendingCriticalRolls.set(pendingKey, {
        dmgStr: verify.autoDmgStr,
        skillRollEmbed: verify.skillRollEmbed,
        skillKey: verify.skillKey,
        cooldownTurns: verify.cooldownTurns,
        emotionDelta: verify.emotionDelta,
        lightCost: verify.lightCost,
        sanityCost: verify.sanityCost,
        autoWarnings: verify.autoWarnings,
        orlandoFuriosoBypassConsumed: verify.orlandoFuriosoBypassConsumed ?? false,
        expiresAt: Date.now() + PENDING_CRITICAL_ROLL_TTL_MS,
      });
      if (!verify.autoDmgStr) {
        // Page không có dice sát thương trực tiếp (thuần hiệu ứng/buff) — cùng
        // fallback đã dùng cho Critical không dmg: resolve NGAY qua pendingAction
        // targets rỗng, không cần chọn target/Modal nào cả.
        pendingCriticalRolls.delete(pendingKey);
        const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const p = {
          id: pendingId, kind: "hit", attackerId: interaction.user.id,
          targets: [], dmgStr: `Page: ${pageName}`, defenseBypass: {},
          skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: verify.emotionDelta ?? 0, orlandoFuriosoBypassConsumed: verify.orlandoFuriosoBypassConsumed ?? false,
          lightCost: verify.lightCost, sanityCost: verify.sanityCost,
        };
        const lines = await resolveOnePendingAction(encounter, p);
        // GAP ĐÃ SỬA (xác nhận trực tiếp: "1 turn act bao nhiêu lần cũng được")
        // — không còn advance turn tự động sau hành động này nữa.
        await saveEncounter(channelId, encounter);
        announceCurrentTurn(channelId, encounter).catch(() => {});
        return interaction.update({
          embeds: [verify.skillRollEmbed, { description: `*(Page này không có dice sát thương trực tiếp — dùng \`-encounter buff\`/lệnh liên quan để narrate hiệu ứng nếu cần.)*${lines.length ? `\n${lines.join("\n")}` : ""}`, color: 0x95a5a6 }],
          components: [],
        }).catch(() => {});
      }
      // BUG BẢO MẬT ĐÃ SỬA (cùng nguyên nhân với M1/Critical): isAoe/maxTargets
      // đọc TRỰC TIẾP từ tag "[AOE...]" trong text roll() thật của Page này —
      // VD "[AOE 3 người]" chỉ được chọn tối đa 3, không phải toàn bộ enemy.
      const { isAoe: isAoeThisPage, maxTargets: aoeMaxThisPage } = parseAoeInfo(verify.skillRollEmbed?.description);
      const targetOptions = buildEnemyTargetOptions(encounter, isAoeThisPage && aoeMaxThisPage === Infinity);
      if (targetOptions.length === 0) {
        pendingCriticalRolls.delete(pendingKey);
        return interaction.reply({ content: "⚠️ Không còn enemy nào (còn sống) để nhắm.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      await interaction.update({
        embeds: [verify.skillRollEmbed, { title: `📖 ${pageName} — chọn target`, description: isAoeThisPage ? `Chọn tối đa ${Math.min(aoeMaxThisPage, targetOptions.length)} enemy muốn nhắm:` : "Chọn 1 enemy muốn nhắm:", color: 0x3498db }],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`enctarget:${channelId}:hit:${encodeURIComponent(pageName)}`)
            .setPlaceholder("Chọn target...")
            .setMinValues(1)
            .setMaxValues(isAoeThisPage ? Math.min(aoeMaxThisPage, targetOptions.length) : 1)
            .addOptions(new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"), ...targetOptions),
        )],
      }).catch(() => {});
      return;
    }
    if (value === "followup") {
      const encounter = await getEncounter(channelId);
      // Follow-Up/Pounce là hành động từ perk (không phải skill roll từ
      // skills.js) — không có tag [AOE] nào để đọc, mặc định LUÔN single-target.
      const targetOptions = buildEnemyTargetOptions(encounter, false);
      if (targetOptions.length === 0) {
        return interaction.reply({ content: "⚠️ Không còn enemy nào (còn sống) để nhắm.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      await interaction.update({
        embeds: [{ title: "⚡ Follow-Up/Pounce — chọn target", description: "Chọn 1 enemy muốn nhắm:", color: 0x3498db }],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`enctarget:${channelId}:followup`)
            .setPlaceholder("Chọn target...")
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"), ...targetOptions),
        )],
      }).catch(() => {});
      return;
    }
    // guard/evade/parry (Modal "mấy lần?" trigger) ĐÃ GỠ cùng dropdown option —
    // xem buildEncounterActionPanel (encounter-panels.js).
    // "Reload" (nút RIÊNG, KHÁC Page "Re-Load") — xác nhận trực tiếp: "Nạp
    // tùy ý ví dụ nạp 5 xong sau đó nạp thêm 3 cũng được. Chỉ là không nạp
    // được quá hơn max ammo của vũ khí" — mở Modal nhập amount + type, KHÔNG
    // giới hạn số lần/turn, KHÔNG tốn Light/Stamina (giống -encounter reload
    // có sẵn — chỉ khác đích đến là bulletStack thay vì ammo/frostAmmo/
    // incendiaryAmmo trực tiếp).
    if (value === "reload") {
      const modal = new ModalBuilder()
        .setCustomId(`reloadmodal:${channelId}`)
        .setTitle("🔫 Reload Soldato Rifle");
      const amountInput = new TextInputBuilder().setCustomId("amount").setLabel("Số lượng muốn nạp").setPlaceholder("VD: 5").setStyle(TextInputStyle.Short).setRequired(true);
      const typeInput = new TextInputBuilder().setCustomId("type").setLabel("Loại đạn (ammo/frost/incendiary)").setPlaceholder("ammo").setValue("ammo").setStyle(TextInputStyle.Short).setRequired(true);
      modal.addComponents(
        new ActionRowBuilder().addComponents(amountInput),
        new ActionRowBuilder().addComponents(typeInput),
      );
      await interaction.showModal(modal).catch(() => {});
      return;
    }
    if (value === "endmyturn") {
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "1 turn act bao nhiêu lần cũng được...
      // chỉ khi họ bấm nút End Turn thì mới End Turn của họ") — TÁI DÙNG NGUYÊN
      // logic của "-encounter pass" (advance + announce) — chỉ khác cách kích
      // hoạt (dropdown thay vì gõ lệnh text).
      let resultText = null;
      await withLock(encounterKey(channelId), async () => {
        const encounter = await getEncounter(channelId);
        if (!encounter) throw new Error("Encounter không còn tồn tại.");
        if (!hasEncounterStarted(encounter)) {
          throw new Error("⚠️ Encounter chưa bắt đầu — GM cần chạy `-encounter rollspeed` trước.");
        }
        if (!isCurrentTurnHolder(encounter, interaction.user.id)) {
          throw new Error("Chưa/không còn tới lượt bạn nữa — không cần kết thúc lượt.");
        }
        const { wrapped, prescriptNotes } = advanceToNextTurnHolder(encounter);
        appendActionLog(encounter, `🏁 <@${interaction.user.id}> đã kết thúc lượt.`);
        await saveEncounter(channelId, encounter);
        announceCurrentTurn(channelId, encounter).catch(() => {});
        resultText = `🏁 Bạn đã kết thúc lượt.${prescriptNotes.length > 0 ? "\n" + prescriptNotes.map(n => `> ${n}`).join("\n") : ""}${wrapped ? "\n> 🔄 Đã hết 1 vòng turn order — dùng `-encounter endturn` để bắt đầu turn mới." : ""}`;
      });
      await interaction.update({ embeds: [{ description: resultText, color: 0x95a5a6 }], components: [] }).catch(() => {});
      return;
    }
    const isAdmin = ADMIN_IDS.has(interaction.user.id);
    let resultMsg;
    if (value === "shinmang") resultMsg = await performShinMang(channelId, interaction.user.id);
    else if (value === "manifestego") resultMsg = await performManifestEgo(channelId, interaction.user.id);
    else if (value === "overcharge") resultMsg = await performOvercharge(channelId, interaction.user.id);
    else if (value.startsWith("useitem:")) resultMsg = await performUseItem(channelId, interaction.user.id, value.slice(8));
    else { await interaction.reply({ content: "⚠️ Hành động không hợp lệ.", flags: MessageFlags.Ephemeral }).catch(() => {}); return; }
    await interaction.reply({ content: resultMsg });
  } catch (err) {
    log("error", "encMenuSelect", interaction.user?.id ?? "unknown", err.message);
    await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (enctarget — chọn target sau khi chọn hành động,
// dùng CHUNG cho attack/criticalhit/hit/followup — GAP ĐÃ SỬA: "phần target ở
// toàn bộ dropdown nên sửa lại thành cho bấm thay vì là key... giống 1 game
// hơn") ─────────────────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("enctarget:")) return;
  const parts = interaction.customId.split(":");
  const channelId = parts[1];
  const subAction = parts[2]; // "attack" | "criticalhit" | "hit" | "followup"
  const extra = parts[3]; // mode (attack) | critSkillName encoded (criticalhit) | pageName encoded (hit) | undefined (followup)
  try {
    // "Back" — GAP ĐÃ SỬA (xác nhận trực tiếp qua ảnh chụp: "Chỗ attack thiếu
    // nút back") — dropdown chọn target (Attack/Critical/Page/Follow-Up) trước
    // đây KHÔNG có cách quay lui nếu bấm nhầm — giờ thêm "◀ Back" làm option
    // ĐẦU TIÊN (xem chỗ buildEnemyTargetOptions được gọi phía trên), quay thẳng
    // về dropdown top-level Attack/Moves/Special.
    if (interaction.values[0] === "back") {
      const encBackTarget = await getEncounter(channelId);
      const combatantBackTarget = encBackTarget?.players?.[interaction.user.id];
      if (!combatantBackTarget) return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return interaction.update({ components: buildEncounterActionPanel(channelId, combatantBackTarget, interaction.user.id) }).catch(() => {});
    }
    // "all" ưu tiên nếu có trong lựa chọn (multi-select có thể lẫn "all" với
    // enemy cụ thể — coi như muốn AOE toàn bộ), ngược lại nối các key đã chọn.
    const targetStr = interaction.values.includes("all") ? "all" : interaction.values.join(",");
    const encodedTarget = encodeURIComponent(targetStr);
    if (subAction === "attack") {
      const mode = extra; // auto | fixedburst | manual
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "XÓA LUÔN tin nhắn dropdown đó") — lưu
      // messageId của dropdown gốc vào customId Modal (Modal Submit là 1
      // interaction HOÀN TOÀN KHÁC, không tự biết message dropdown gốc là gì
      // nếu không lưu lại) — để sau khi Modal submit, xoá đúng message này.
      const dropdownMessageId = interaction.message.id;
      const modal = new ModalBuilder()
        .setCustomId(`encmodal:${channelId}:attack:${mode}:${encodedTarget}:${dropdownMessageId}`)
        .setTitle("Đánh thường (M1)");
      if (mode === "fixedburst") {
        // GAP ĐÃ SỬA HOÀN TOÀN LẦN THỨ 3 (xác nhận trực tiếp kèm passive text
        // đầy đủ "Foreclosure Task Force President") — KHÔNG còn field "volleys"
        // nữa — số volley/base dmg/bonus giờ HOÀN TOÀN TỰ ĐỘNG theo số lần đã
        // đánh CHÍNH target này trong turn (per-target counter), người chơi
        // không cần tự nhập gì cả, chỉ còn chọn loại đạn (optional).
        const ammoTypeInput = new TextInputBuilder()
          .setCustomId("ammotype").setLabel("Loại đạn (frost/incendiary/repeat)")
          .setPlaceholder("Để trống = bắn thường, không loại đạn đặc biệt")
          .setStyle(TextInputStyle.Short).setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(ammoTypeInput));
      } else if (mode === "auto") {
        const encounter = await getEncounter(channelId);
        const combatant = encounter?.players?.[interaction.user.id];
        const hitCountInput = new TextInputBuilder()
          .setCustomId("hitCount")
          .setLabel(`Đánh mấy lần? (${combatant?.weaponBaseDamage ?? "?"} ${combatant?.weaponType ?? ""}/hit)`.slice(0, 45))
          .setPlaceholder("VD: 4").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(hitCountInput));
      } else {
        const dmgInput = new TextInputBuilder()
          .setCustomId("dmgStr").setLabel("Công thức dmg (chưa rõ vũ khí — gõ tay)")
          .setPlaceholder("VD: 50x2B+2Sinking").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(dmgInput));
      }
      await interaction.showModal(modal).catch(() => {});
    } else if (subAction === "criticalhit" || subAction === "hit") {
      // LỖ HỔNG BẢO MẬT ĐÃ SỬA (xác nhận trực tiếp qua ảnh chụp thật) — TRƯỚC ĐÂY
      // vẫn mở Modal với field dmgStr "pre-fill nhưng sửa được", gây nhầm lẫn +
      // rủi ro gian lận. Giờ KHÔNG còn Modal nào nữa cho cả 2 nhánh này — dmgStr
      // đã roll thật + lưu server-side lúc chọn dropdown, thực thi NGAY sau khi
      // chọn target (giống followup), không còn bước nào để "tưởng sửa được".
      const skillName = decodeURIComponent(extra);
      const pendingKey = `${channelId}:${interaction.user.id}`;
      const pending = pendingCriticalRolls.get(pendingKey);
      if (!pending) {
        return interaction.reply({ content: "⚠️ Phiên roll đã hết hạn (quá 5 phút) — chọn lại từ dropdown hành động để roll mới.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      pendingCriticalRolls.delete(pendingKey); // single-use
      const { embed, skillRollEmbed } = await doPlayerHit(channelId, interaction.user.id, interaction.user.toString(), pending.dmgStr, targetStr, {
        prefilledVerify: {
          skillRollEmbed: pending.skillRollEmbed, skillKey: pending.skillKey, cooldownTurns: pending.cooldownTurns,
          emotionDelta: pending.emotionDelta, lightCost: pending.lightCost, sanityCost: pending.sanityCost,
          refSnippet: null, refLink: null, orlandoFuriosoBypassConsumed: pending.orlandoFuriosoBypassConsumed ?? false,
        },
      });
      // GAP ĐÃ SỬA (xác nhận trực tiếp: "Vẫn nên hiện bảng roll của -skill ra"
      // + "hiện bảng roll của -skill ra là hiện cả tag rồi, nên là phần này
      // rất dư thừa") — LẦN SỬA TRƯỚC xoá HẲN message (bao gồm cả
      // skillRollEmbed — bảng roll THẬT với đầy đủ dice/tag/hiệu ứng) khi chỉ
      // định xoá phần embed "Action đã thêm vào hàng chờ" (result.embed) —
      // giờ sửa lại ĐÚNG ý định: vẫn hiện skillRollEmbed (update tại chỗ,
      // không tạo "(edited)" mới vì đây LÀ nội dung hữu ích, không phải bỏ),
      // chỉ bỏ result.embed (verbose, dư thừa) và bỏ HẲN autoWarnings ephemeral
      // (tag/hiệu ứng đã có sẵn trong skillRollEmbed, nhắc "tự áp dụng" cũng
      // không còn đúng vì mọi field liên quan giờ đã tự động — không cần cảnh
      // báo dạng "tự gõ tay" nữa).
      await interaction.update({
        embeds: skillRollEmbed ? [skillRollEmbed] : [],
        components: [],
      }).catch(() => {});
    } else if (subAction === "followup") {
      // Follow-Up không cần Modal nữa (không có field nào khác ngoài target) —
      // thực thi NGAY sau khi chọn target, giống tinh thần "thuần menu UI".
      const { followupEmbed, hitEmbed } = await performFollowUp(channelId, interaction.user.id, interaction.user.toString(), targetStr);
      // GAP ĐÃ SỬA (cùng lý do với criticalhit/hit ở trên) — xoá hẳn message
      // dropdown gốc, KHÔNG còn hitEmbed ("Action đã thêm vào hàng chờ" — cùng
      // 1 embed y hệt, chỉ khác nguồn gọi) — followupEmbed (thông báo "Đã dùng
      // Follow-Up/Pounce") gửi như tin nhắn MỚI, không sửa lại message cũ.
      await interaction.deferUpdate().catch(() => {});
      await interaction.deleteReply().catch(() => {});
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel) await channel.send({ embeds: [followupEmbed] }).catch(() => {});
    }
  } catch (err) {
    log("error", "enctargetSelect", interaction.user?.id ?? "unknown", err.message);
    await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (bossmenu — GM điều khiển 1 enemy cụ thể) ───────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("bossmenu:")) return;
  const [, channelId, enemyKey, gmUserId] = interaction.customId.split(":");
  const isAdmin = ADMIN_IDS.has(interaction.user.id);
  if (interaction.user.id !== gmUserId && !isAdmin) {
    return interaction.reply({ content: "⚠️ Chỉ GM/admin điều khiển được enemy này.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const value = interaction.values[0];
  try {
    if (value === "endmyturn") {
      // GAP ĐÃ SỬA (xác nhận trực tiếp: cùng lý do với player) — check turn
      // holder theo enemyKey (không phải GM's user id, vì đây là lượt của
      // ENEMY đang kết thúc, GM chỉ bấm HỘ).
      let resultText = null;
      await withLock(encounterKey(channelId), async () => {
        const encounter = await getEncounter(channelId);
        if (!encounter) throw new Error("Encounter không còn tồn tại.");
        if (!hasEncounterStarted(encounter)) {
          throw new Error("⚠️ Encounter chưa bắt đầu — GM cần chạy `-encounter rollspeed` trước.");
        }
        if (!isCurrentTurnHolder(encounter, enemyKey)) {
          throw new Error(`Chưa/không còn tới lượt của "${enemyKey}" nữa — không cần kết thúc lượt.`);
        }
        const { wrapped, prescriptNotes } = advanceToNextTurnHolder(encounter);
        appendActionLog(encounter, `🏁 **${encounter.enemies[enemyKey]?.name ?? enemyKey}** đã kết thúc lượt.`);
        await saveEncounter(channelId, encounter);
        announceCurrentTurn(channelId, encounter).catch(() => {});
        resultText = `🏁 **${encounter.enemies[enemyKey]?.name ?? enemyKey}** đã kết thúc lượt.${prescriptNotes.length > 0 ? "\n" + prescriptNotes.map(n => `> ${n}`).join("\n") : ""}${wrapped ? "\n> 🔄 Đã hết 1 vòng turn order — dùng `-encounter endturn` để bắt đầu turn mới." : ""}`;
      });
      await interaction.update({ embeds: [{ description: resultText, color: 0x95a5a6 }], components: [] }).catch(() => {});
      return;
    }
    if (value === "attack" || value === "attackm1") {
      const isM1Flow = value === "attackm1";
      // BUG ĐÃ SỬA (xác nhận trực tiếp: "bấm dropdown của boss tôi lại không
      // target player được dù tag đúng tên họ") — Modal Text Input của Discord
      // KHÔNG hỗ trợ autocomplete mention (khác với gõ tin nhắn thường) — gõ
      // "@TênNgườiChơi" trong Modal chỉ tạo ra TEXT THÔ, không phải mention thật
      // `<@userId>`, nên resolveTargets không bao giờ khớp được. Sửa: chọn
      // target qua DROPDOWN (liệt kê đúng player đang có trong encounter) TRƯỚC,
      // chỉ Modal hỏi dmgStr — không cần gõ tay target nữa.
      const enc = await getEncounter(channelId);
      const alivePlayerIds = Object.keys(enc?.players ?? {}).filter(pid => enc.players[pid].currentHp > 0);
      if (alivePlayerIds.length === 0) {
        return interaction.reply({ content: "⚠️ Chưa có player nào (còn sống) trong encounter để nhắm.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      // BUG THỨ 2 ĐÃ SỬA (xác nhận trực tiếp: "target invalid... dropdown không
      // cho reselect") — trước đây dùng members.fetch() (GỌI API THẬT cho TỪNG
      // player) — đây là network call CHẬM, có thể vượt quá 3 giây Discord cho
      // phép để phản hồi 1 interaction, khiến TOÀN BỘ bước này timeout/fail âm
      // thầm (nuốt bởi .catch) — user thấy y hệt "không phản hồi, không chọn lại
      // được". Sửa: dùng cache ĐỒNG BỘ (đã có sẵn từ gateway, không cần gọi API
      // mới) — không bao giờ block vào network I/O, luôn phản hồi tức thời.
      const targetOptions = alivePlayerIds.map(pid => {
        const displayName = interaction.guild?.members?.cache?.get(pid)?.displayName
          ?? interaction.client.users.cache.get(pid)?.username
          ?? `Player ${pid.slice(-4)}`;
        return new StringSelectMenuOptionBuilder().setLabel(displayName.slice(0, 100)).setValue(pid);
      });
      targetOptions.push(new StringSelectMenuOptionBuilder().setLabel("🎯 Tất cả (AOE)").setValue("all"));
      await interaction.update({
        embeds: [{ title: `⚔️ ${enemyKey} tấn công — chọn target`, description: "Chọn người chơi muốn nhắm:", color: 0xe74c3c }],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`bossattacktarget:${channelId}:${enemyKey}:${gmUserId}:${isM1Flow ? "m1" : "skill"}`)
            .setPlaceholder("Chọn target...")
            .addOptions(...targetOptions.slice(0, 25)),
        )],
      }).catch(() => {});
      return;
    }
    // guard/evade/parry ĐÃ GỠ cùng dropdown option — xem buildBossActionPanel
    // (encounter-panels.js) — enemy giờ chỉ có "Tấn công", phòng thủ tự động qua
    // Reactive Defense khi bị tấn công.
    await interaction.reply({ content: "⚠️ Hành động không hợp lệ.", flags: MessageFlags.Ephemeral }).catch(() => {});
  } catch (err) {
    log("error", "bossMenuSelect", interaction.user?.id ?? "unknown", err.message);
    await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("bossattacktarget:")) return;
  const [, channelId, enemyKey, gmUserId, isM1Flag] = interaction.customId.split(":");
  const isAdmin = ADMIN_IDS.has(interaction.user.id);
  if (interaction.user.id !== gmUserId && !isAdmin) {
    return interaction.reply({ content: "⚠️ Chỉ GM/admin điều khiển được enemy này.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const targetId = interaction.values[0]; // playerId thật hoặc "all" — KHÔNG cần parse mention nữa
  const modal = new ModalBuilder()
    .setCustomId(`encmodal:${channelId}:bossattack:${enemyKey}:${targetId}:${isM1Flag ?? "skill"}`)
    .setTitle(`${enemyKey} tấn công`.slice(0, 45));
  // GAP ĐÃ SỬA (xác nhận trực tiếp: "boss có thể được GM customize rất nhiều...
  // 1 số đòn của boss không dmg nhưng hiệu ứng... không thể làm chỉ only m1 như
  // hiện tại") — mở rộng thêm 2 field TUỲ CHỌN (không bắt buộc điền):
  // - tags: bypass tag (Unblockable/Guard Break/Undodgeable/...) giống lệnh text
  // - note: ghi chú hiệu ứng TỰ DO (không qua resolveSkillVerification, vì boss
  //   không có object skill định sẵn như player) — hiển thị kèm kết quả, GM tự áp
  //   status liên quan qua `-encounter setstatus` sau nếu cần.
  const dmgInput = new TextInputBuilder()
    .setCustomId("dmgStr")
    .setLabel("Công thức dmg (0 nếu chỉ hiệu ứng, không dmg)")
    .setPlaceholder("VD: 50x2B+2Sinking — hoặc 0B nếu không gây dmg")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  const tagsInput = new TextInputBuilder()
    .setCustomId("tags")
    .setLabel("Tags (tuỳ chọn)")
    .setPlaceholder("VD: unblockable,guardbreak")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("Ghi chú hiệu ứng (tuỳ chọn)")
    .setPlaceholder("VD: Gây 2 Rupture, +1 Bleed — GM tự áp qua setstatus")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);
  modal.addComponents(
    new ActionRowBuilder().addComponents(dmgInput),
    new ActionRowBuilder().addComponents(tagsInput),
    new ActionRowBuilder().addComponents(noteInput),
  );
  await interaction.showModal(modal).catch(() => {});
});

// GAP ĐÃ SỬA (dự án GM Panel mở rộng, xác nhận trực tiếp: "gm có thể chỉnh sửa
// bất cứ thứ gì... edit enemy... làm điều tương tự với player") — submit Modal
// chỉnh sửa: HP/Stamina/Sanity/Light SET TUYỆT ĐỐI (khác setstatus vốn CỘNG
// DỒN — đây là "sửa lại đúng số", không phải "thêm vào"), status vẫn cộng dồn
// qua applyStatusEntries (giữ nguyên cú pháp quen thuộc).
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("gmeditmodal:")) return;
  const [, channelId, targetType, targetId] = interaction.customId.split(":");
  try {
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Encounter không còn tồn tại.");
      const resolved = resolveCombatant(encounter, targetId);
      if (!resolved) throw new Error(`Không tìm thấy ${targetType === "enemy" ? "enemy" : "player"} này (có thể đã bị xoá/rời encounter).`);
      const hpRaw = interaction.fields.getTextInputValue("hp");
      const staRaw = interaction.fields.getTextInputValue("stamina");
      const sanLightRaw = interaction.fields.getTextInputValue("sanlight");
      const statusRaw = interaction.fields.getTextInputValue("status");
      const noteRaw = interaction.fields.getTextInputValue("addnote");
      const hp = parseInt(hpRaw, 10);
      const sta = parseInt(staRaw, 10);
      const sanLightParts = sanLightRaw.split("/").map(s => s.trim());
      const san = parseInt(sanLightParts[0], 10);
      const light = parseInt(sanLightParts[1] ?? "", 10);
      if (![hp, sta, san, light].every(Number.isFinite)) throw new Error("HP/Stamina phải là số hợp lệ, Sanity/Light phải đúng cú pháp \"số/số\".");
      const changes = [];
      if (hp !== resolved.combatant.currentHp) { changes.push(`HP: ${resolved.combatant.currentHp} → **${Math.max(0, Math.min(resolved.combatant.maxHp, hp))}**`); resolved.combatant.currentHp = Math.max(0, Math.min(resolved.combatant.maxHp, hp)); }
      if (sta !== resolved.combatant.currentStamina) { changes.push(`Stamina: ${resolved.combatant.currentStamina} → **${Math.max(0, Math.min(resolved.combatant.maxStamina, sta))}**`); resolved.combatant.currentStamina = Math.max(0, Math.min(resolved.combatant.maxStamina, sta)); }
      if (san !== (resolved.combatant.currentSanity ?? 0)) { changes.push(`Sanity: ${resolved.combatant.currentSanity ?? 0} → **${san}**`); resolved.combatant.currentSanity = san; }
      if (light !== (resolved.combatant.currentLight ?? 0)) { changes.push(`Light: ${resolved.combatant.currentLight ?? 0} → **${Math.max(0, Math.min(resolved.combatant.maxLight, light))}**`); resolved.combatant.currentLight = Math.max(0, Math.min(resolved.combatant.maxLight, light)); }
      if (statusRaw && statusRaw.trim()) {
        const statusEntries = parseStatusFreeText(statusRaw);
        if (statusEntries.length > 0) {
          const statusChanges = applyStatusEntries(resolved, statusEntries, null, checkStaggerPanic);
          changes.push(...statusChanges);
        }
      }
      if (noteRaw !== (resolved.combatant.gmNote ?? "")) {
        const beforeNote = resolved.combatant.gmNote || "(trống)";
        resolved.combatant.gmNote = noteRaw;
        changes.push(`Note: "${beforeNote}" → **"${noteRaw || "(trống)"}"**`);
      }
      appendActionLog(encounter, `🎛️ GM chỉnh sửa ${resolved.label}: ${changes.length > 0 ? changes.join(", ") : "(không đổi gì)"}`);
      await saveEncounter(channelId, encounter);
      await interaction.reply({
        embeds: [{ title: `✅ Đã chỉnh sửa: ${resolved.label}`, description: changes.length > 0 ? changes.join("\n") : "*(không có gì thay đổi)*", color: 0x2ecc71 }],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    });
  } catch (err) {
    interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// GAP ĐÃ SỬA (xác nhận trực tiếp: "add... enemy") — submit Modal Add Enemy, TÁI
// DÙNG chính xác logic của lệnh text -encounter addenemy (createCombatant,
// insertIntoTurnOrderMidRound...), chỉ đổi nguồn input từ kv text sang Modal fields.
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("gmaddenemymodal:")) return;
  const [, channelId] = interaction.customId.split(":");
  try {
    const key = normalizeEnemyKey(interaction.fields.getTextInputValue("key"));
    const name = interaction.fields.getTextInputValue("name").trim();
    const hpRaw = interaction.fields.getTextInputValue("hp").trim();
    const hpStaminaMatch = hpRaw.match(/^([\d.]+)(?:\s*\/\s*([\d.]+))?$/);
    const hp = hpStaminaMatch ? parseFloat(hpStaminaMatch[1]) : NaN;
    const staminaInput = hpStaminaMatch?.[2] ? parseFloat(hpStaminaMatch[2]) : ENCOUNTER_DEFAULT_MAX_STAMINA;
    if (!key || key.length > ENCOUNTER_KEY_MAX_LENGTH || !/^[a-z0-9]+$/.test(key) || !name || !Number.isFinite(hp) || hp <= 0) {
      throw new Error("Key phải là chữ/số thường không dấu, Name không được trống, HP phải là số dương.");
    }
    const resRaw = interaction.fields.getTextInputValue("res") ?? "";
    const res = { B: 1, P: 1, S: 1 };
    for (const m of resRaw.matchAll(/([\d.]+)(?:x)?([BPS])/gi)) res[m[2].toUpperCase()] = parseFloat(m[1]);
    const weapon = normalizeWeaponWeight((interaction.fields.getTextInputValue("weapon") ?? "").trim() || "medium");
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Encounter không còn tồn tại.");
      if (encounter.players[key]) throw new Error(`Key "${key}" đang trùng với 1 player đã join — đổi key khác.`);
      const wasExisting = !!encounter.enemies[key];
      encounter.enemies[key] = createCombatant({
        name, maxHp: hp,
        maxStamina: staminaInput,
        weaponWeight: weapon, resistance: res, speedRangeMin: 3, speedRangeMax: 6,
      });
      if (!wasExisting) insertIntoTurnOrderMidRound(encounter, key, "enemy", encounter.enemies[key]);
      await saveEncounter(channelId, encounter);
      const boardPayload = buildEncounterBoardEmbed(encounter, channelId);
      await interaction.reply({
        embeds: [boardPayload.embed],
        components: boardPayload.components,
        content: `✅ ${wasExisting ? "Đã cập nhật lại" : "Đã thêm"} enemy **${name}** (key: \`${key}\`) với ${hp} HP.`,
      }).catch(() => {});
    });
  } catch (err) {
    interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("bookchoice:")) return;
  const [, ownerId, encodedBookName] = interaction.customId.split(":");
  const bookName = decodeURIComponent(encodedBookName);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const [chosenType, chosenName] = interaction.values[0].split(":");
  if (chosenType === "group") {
    // TẦNG 2 — hiện Page cụ thể TRONG nhóm đã chọn (CHỈ "Library Book" mới có
    // nhánh này, vì đây là sách DUY NHẤT có >25 lựa chọn cần chia 2 tầng).
    const groupChoices = getBookGroupChoices(bookName, chosenName);
    const options = groupChoices.slice(0, 25).map(c =>
      new StringSelectMenuOptionBuilder().setLabel(c.name.slice(0, 100)).setDescription("Page").setValue(`page:${c.name}`).setEmoji("📖")
    );
    return interaction.reply({
      embeds: [{ title: `📂 ${bookName} — Nhóm ${chosenName}`, description: "Chọn ĐÚNG 1 Page trong nhóm này:", color: 0x5865f2 }],
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`bookchoice:${ownerId}:${encodeURIComponent(bookName)}`).setPlaceholder("Chọn Page...").addOptions(options)
      )],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
  // page/weapon/outfit cụ thể — CHỐT LUÔN.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await withLock(ownerId, () => executeReadBookChoose(ownerId, bookName, chosenType, chosenName));
    const typeLabel = chosenType === "page" ? "Page" : chosenType === "weapon" ? "Vũ khí" : "Outfit";
    await interaction.editReply({
      embeds: [{
        title: `📖 Đã đọc: ${result.bookName}`,
        description: `Nhận được: **${result.chosenName}** (${typeLabel})\n\n*Còn lại: ${result.remaining} cuốn.*`,
        color: 0x5865f2,
      }],
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (-balance: phân bổ điểm / unlock perk) ─────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("balbranch:")) return;
  const [, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const branchKey = interaction.values[0].split(":")[1]; // "branch:sloth" → "sloth"
  const modal = new ModalBuilder()
    .setCustomId(`balmodal:${ownerId}:${branchKey}`)
    .setTitle(`Phân bổ điểm — ${branchKey[0].toUpperCase() + branchKey.slice(1)}`);
  const amountInput = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("Số điểm muốn cộng thêm")
    .setPlaceholder("VD: 10")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
  await interaction.showModal(modal).catch(() => {});
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("balmodal:")) return;
  const [, ownerId, branchKey] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const addAmount = parseInt(interaction.fields.getTextInputValue("amount").trim(), 10);
    if (!Number.isFinite(addAmount) || addAmount <= 0) throw new Error("Số điểm phải là số dương.");
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      data.branchPoints = data.branchPoints ?? {};
      const before = data.branchPoints[branchKey] ?? 0;
      const proposedBranchPoints = { ...data.branchPoints, [branchKey]: before + addAmount };
      const proposedTotal = BRANCH_KEYS.reduce((sum, k) => sum + (proposedBranchPoints[k] ?? 0), 0);
      const pool = calcSkillTreePointsEarned(data);
      if (proposedTotal > pool) {
        const currentAllocated = calcBranchPointsAllocated(data);
        throw new Error(`Không đủ điểm — tổng sẽ thành ${proposedTotal}, vượt quá pool ${pool} (còn dư ${pool - currentAllocated} điểm).`);
      }
      // Gate CỨNG — đồng bộ với -allocatepoints text command (xem comment đầy đủ ở
      // đó). Dropdown này LUÔN self-service (đã check user.id===ownerId ở trên).
      if ((branchKey === "shin" && !data.ShinUnlock) || (branchKey === "light" && !data.LightSkillTreeUnlock)) {
        throw new Error(`Bạn CHƯA đủ điều kiện phân bổ điểm vào nhánh ${branchKey[0].toUpperCase() + branchKey.slice(1)} (chưa được GM xác nhận) — liên hệ GM.`);
      }
      data.branchPoints[branchKey] = proposedBranchPoints[branchKey];
      await savePlayerData(ownerId, data, slot);
      await interaction.editReply({ content: `✅ ${branchKey[0].toUpperCase() + branchKey.slice(1)}: ${before} → **${data.branchPoints[branchKey]}** [tổng: ${proposedTotal}/${pool}]\n> Dùng lại \`-balance\` để thấy cập nhật.` });
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` }).catch(() => {});
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("balunlock:")) return;
  const [, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (isOnCooldown(interaction.user.id, "balunlock", 2000)) {
    return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    // GAP ĐÃ SỬA (multi-select — xác nhận trực tiếp phản hồi tester) — LOOP
    // TUẦN TỰ qua từng perk đã chọn (không phải Promise.all song song), vì
    // unlock perk A trước có thể ẢNH HƯỞNG tới check exclusive-conflict của
    // perk B chọn cùng lúc — mỗi perk thành công/thất bại độc lập, không dừng
    // toàn bộ batch nếu 1 perk lỗi.
    const results = [];
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      data.unlockedSkillTree = data.unlockedSkillTree ?? [];
      for (const raw of interaction.values) {
        const perkName = raw.split(":").slice(1).join(":");
        try {
          if (data.unlockedSkillTree.includes(perkName)) throw new Error(`Đã có rồi.`);
          const conflict = findExclusiveConflict(data.unlockedSkillTree, perkName);
          if (conflict) throw new Error(`Loại trừ với "${conflict}" đã có.`);
          const cost = PERK_POINT_COSTS[perkName];
          const branch = PERK_BRANCH[perkName];
          const branchHave = (data.branchPoints ?? {})[branch] ?? 0;
          if (branchHave < cost) throw new Error(`Cần ${cost} điểm ${branch} — hiện chỉ có ${branchHave}.`);
          data.unlockedSkillTree.push(perkName);
          results.push(`✅ **${perkName}** (${branch}, ${cost} điểm)`);
        } catch (err) {
          results.push(`❌ **${perkName}**: ${err.message}`);
        }
      }
      await savePlayerData(ownerId, data, slot);
    });
    await interaction.editReply({ content: `${results.join("\n")}\n> Dùng lại \`-balance\` để thấy cập nhật.` });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (-balance: equip weapon/outfit/accessory) ──────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("balequipgear:")) return;
  const [, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (isOnCooldown(interaction.user.id, "balequipgear", 2000)) {
    return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    // GAP ĐÃ SỬA (multi-select) — LOOP TUẦN TỰ qua từng gear đã chọn, mỗi item
    // độc lập thành công/thất bại (VD equip 2 accessory cùng tên nhưng chỉ sở
    // hữu 1 — cái đầu thành công, cái sau báo lỗi thiếu, không mất cái đầu).
    const results = [];
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      for (const raw of interaction.values) {
        const chosenType = raw.split(":")[0];
        const chosenName = raw.split(":").slice(1).join(":");
        try {
          const isUniversalChosen = chosenType === "weapon" && UNIVERSALLY_KNOWN_WEAPONS.has(chosenName.toLowerCase());
          if (!isUniversalChosen && (data.items?.[chosenName] ?? 0) < 1) throw new Error(`Không còn sở hữu — dùng lại \`-balance\` để cập nhật.`);
          if (chosenType === "weapon") {
            const weapon = findWeaponAnywhere(chosenName);
            data.equippedWeapon = weapon.name;
            results.push(`✅ Vũ khí **${weapon.name}** (${weapon.weight}/${weapon.type}, Base Dmg ${weapon.baseDamage}).`);
          } else if (chosenType === "outfit") {
            const outfit = findOutfit(chosenName);
            data.equippedOutfit = outfit.name;
            const r = outfit.resistance;
            results.push(`✅ Outfit **${outfit.name}** (Res: ${r.B}xB ${r.P}xP ${r.S}xS).`);
          } else if (chosenType === "accessory") {
            const accessory = findAccessory(chosenName);
            data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
            const ownedCount = data.items?.[accessory.name] ?? 0;
            const usedInAnySlot = data.equippedAccessories.filter(name => name === accessory.name).length;
            if (usedInAnySlot >= ownedCount) throw new Error(`Chỉ sở hữu ${ownedCount}, đã dùng hết ở các slot hiện tại.`);
            let targetSlot = data.equippedAccessories.findIndex(s => !s);
            const overwritten = targetSlot === -1;
            if (overwritten) targetSlot = 0;
            data.equippedAccessories[targetSlot] = accessory.name;
            results.push(`✅ Accessory **${accessory.name}** vào slot #${targetSlot + 1}${overwritten ? " (GHI ĐÈ slot đầy)" : ""}.`);
          } else {
            throw new Error("Loại trang bị không hợp lệ.");
          }
        } catch (err) {
          results.push(`❌ **${chosenName}**: ${err.message}`);
        }
      }
      await savePlayerData(ownerId, data, slot);
    });
    await interaction.editReply({ content: `${results.join("\n")}\n> Dùng lại \`-balance\`/\`-equipment\` để xem cập nhật.` });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (-balance: equip Page/E.G.O Page) ──────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  // Chấp nhận CẢ 2 customId (Page thường VÀ E.G.O Page) — BUG ĐÃ SỬA: trước đây
  // CẢ 2 dropdown (Page thường/E.G.O Page trong -balance) dùng CHUNG 1 customId
  // "balequippage:" y hệt nhau (Discord không thể phân biệt 2 component TRÙNG
  // customId trong cùng 1 message) — đã tách riêng "balequipego:" cho dropdown
  // E.G.O Page, giờ handler CHUNG này chấp nhận CẢ 2 (logic bên trong ĐÃ phân biệt
  // đúng qua giá trị chọn "page:"/"egopage:", không cần customId phân biệt).
  if (!interaction.customId.startsWith("balequippage:") && !interaction.customId.startsWith("balequipego:")) return;
  const [, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (isOnCooldown(interaction.user.id, "balequippage", 2000)) {
    return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 2 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    // GAP ĐÃ SỬA (multi-select) — LOOP TUẦN TỰ qua từng Page đã chọn.
    const results = [];
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      for (const raw of interaction.values) {
        const chosenType = raw.split(":")[0];
        const chosenName = raw.split(":").slice(1).join(":");
        const isEgo = chosenType === "egopage";
        try {
          if ((data.pages?.[chosenName] ?? 0) < 1) throw new Error(`Không còn sở hữu — dùng lại \`-balance\` để cập nhật.`);
          const skill = findSkill(chosenName);
          if (!skill) throw new Error(`Không tìm thấy Page trong hệ thống.`);
          const listKey = isEgo ? "equippedEgoPages" : "equippedPages";
          data[listKey] = data[listKey] ?? [null, null, null, null, null];
          let targetSlot;
          let slotNote = "";
          if (isEgo) {
            const skillTier = getEgoTier(skill);
            if (!skillTier) throw new Error(`Không xác định được Tier của "${skill.name}".`);
            targetSlot = EGO_TIER_SLOT_ORDER.indexOf(skillTier);
            slotNote = ` (Tier ${skillTier})`;
          } else {
            targetSlot = data[listKey].findIndex(s => !s);
            if (targetSlot === -1) { targetSlot = 0; slotNote = " (GHI ĐÈ slot đầy)"; }
          }
          data[listKey][targetSlot] = skill.name;
          results.push(`✅ **${skill.name}** vào ${isEgo ? "E.G.O " : ""}slot #${targetSlot + 1}${slotNote}.`);
        } catch (err) {
          results.push(`❌ **${chosenName}**: ${err.message}`);
        }
      }
      await savePlayerData(ownerId, data, slot);
    });
    await interaction.editReply({ content: `${results.join("\n")}\n> Dùng lại \`-balance\`/\`-pages\` để xem cập nhật.` });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` }).catch(() => {});
  }
});

// ─── SELECT MENU INTERACTIONS (inventory) ────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("invsel:")) return;
  try {
    const [, targetUserId] = interaction.customId.split(":");
    // Chỉ chủ nhân inventory mới được chọn — tránh người khác thao túng select menu
    // trên 1 message public (dù /inventory hiển thị công khai).
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({
        content: "⚠️ Chỉ chủ nhân inventory này mới có thể chọn.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    const value = interaction.values[0]; // "book:Random Book" hoặc "item:Chipboard MK1"
    const colonIdx = value.indexOf(":");
    const itemType = value.slice(0, colonIdx);
    const itemName = value.slice(colonIdx + 1);

    const data = await getPlayerData(targetUserId);
    const store = itemType === "book" ? (data.books ?? {}) : (data.items ?? {});
    const currentCount = store[itemName] ?? 0;

    const canOpen = itemType === "book" && ["Random Book", "Sealed Book Cache", "Chipboard Cache"].includes(itemName);
    const canCraft = itemType === "item" && !!CRAFT_RECIPES[itemName];
    // canRead — sách "kiến thức" (có trong BOOK_GRANTS, VD "Cinq Association Book")
    // KHÁC hẳn "Random Book"/"Sealed Book Cache"/"Chipboard Cache" (hộp/gói ngẫu
    // nhiên dùng nút "Mở") — GAP ĐÃ SỬA: trước đây các sách kiến thức hoàn toàn
    // KHÔNG có nút hành động nào phù hợp trong menu này (chỉ "Xem info"/"Xóa"), dù
    // lệnh text `-readbook` đã tồn tại — giờ thêm nút riêng "📚 Đọc" để dùng được
    // ngay từ menu -inventory (xác nhận trực tiếp từ GM: "-readbook là phần sử
    // dụng sách trong menu của -inventory").
    const canRead = itemType === "book" && !!BOOK_GRANTS[itemName];

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`invinfo:${targetUserId}:${itemType}:${itemName}`)
        .setLabel("ℹ️ Xem info")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(canRead ? `invread:${targetUserId}:${itemType}:${itemName}` : `invact:${targetUserId}:${itemType}:${itemName}`)
        .setLabel(canRead ? "📚 Đọc" : (itemType === "book" ? "📖 Mở" : "⚙️ Craft"))
        .setStyle(ButtonStyle.Success)
        .setDisabled(!canOpen && !canCraft && !canRead),
      new ButtonBuilder()
        .setCustomId(`invdel:${targetUserId}:${itemType}:${itemName}`)
        .setLabel("🗑️ Xóa 1")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(currentCount === 0),
    );

    await interaction.reply({
      content: `**${itemName}** × ${currentCount}\nChọn hành động:`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    log("error", "invsel select", interaction.user?.id ?? "unknown", err.message);
    interaction.reply({ content: "❌ Có lỗi xảy ra khi lấy dữ liệu.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {

  // ── /rtparry ── (tương đương -rtparry, nhưng link gửi qua EPHEMERAL thay vì DM —
  // slash command mới ephemeral được, prefix message thường thì Discord không hỗ trợ.
  // Cooldown dùng key "parryrt_web" THỦ CÔNG (không qua replyOnCooldown — hàm đó tự
  // dùng interaction.commandName làm key, sẽ tạo cooldown RIÊNG cho slash command,
  // cho phép spam đổi qua đổi lại -rtparry/`/rtparry` để né cooldown 5s).
  if (interaction.commandName === "rtparry") {
    const nameArg = interaction.options.getString("name");
    let targetSkill = null;
    if (nameArg) {
      targetSkill = findSkill(nameArg);
      if (!targetSkill) {
        await interaction.reply({ content: `⚠️ Không tìm thấy skill **"${nameArg}"**. Bỏ trống \`name\` cho bản mặc định.`, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
    }
    // targetSkill = null nếu bỏ trống name — KHÔNG tự chọn random skill, xem comment
    // đầy đủ ở createRtparryToken().

    if (isOnCooldown(interaction.user.id, "parryrt_web", 5000)) {
      await interaction.reply({ content: "⏳ Chờ vài giây trước khi thử lại nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    // Reply CÔNG KHAI trước (placeholder, sẽ edit lại khi có kết quả) — y như prefix,
    // để channel vẫn thấy được thành tích. Message ephemeral KHÔNG fetch/edit lại
    // được qua API channel thường (chỉ qua webhook token riêng, hết hạn sau interaction
    // token ~15 phút — không đáng thêm phức tạp đó chỉ để né 1 placeholder công khai).
    let sentMsg;
    try {
      await interaction.reply({
        embeds: [{
          title: "⚔️ Parry Real Time",
          description: `${interaction.user} đang chơi Parry Real Time…` +
            (targetSkill ? `\n> Page: **${targetSkill.name}**` : ""),
          color: 0xf39c12,
          footer: { text: "Kết quả sẽ tự hiện lại ở đây sau khi chơi xong" },
        }],
      });
      sentMsg = await interaction.fetchReply();
    } catch (err) {
      log("error", "parryrt", interaction.user.id, err.message);
      return;
    }

    const linkInfo = createRtparryToken({ userId: interaction.user.id, channelId: interaction.channelId, messageId: sentMsg.id, skill: targetSkill });
    if (!linkInfo) {
      await interaction.followUp({
        embeds: [{
          title: "⚔️ Parry Real Time",
          description:
            "⚠️ Bot chưa biết URL public của mình (thiếu env var `RENDER_EXTERNAL_URL` hoặc `PUBLIC_URL`).\n" +
            "> Báo admin set 1 trong 2 biến này thì lệnh này mới hoạt động được.",
          color: 0xe74c3c,
        }],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    // Link riêng qua ephemeral — chỉ người gõ lệnh thấy, không cần DM, không ai
    // khác trong channel bấm hộ được.
    await interaction.followUp({
      embeds: [{ title: "⚔️ Parry Real Time", description: "Bấm nút dưới để mở Parry Real Time.", color: 0xf39c12 }],
      components: [buildRtparryLinkButton(linkInfo.url)],
      flags: MessageFlags.Ephemeral,
    }).catch(err => log("error", "parryrt_ephemeral", interaction.user.id, err.message));
    return;
  }

  // ── /skill ── (tương đương -skill, dùng CHUNG buildSkillListResult/buildSkillRollResult
  // để đảm bảo hành vi giống prefix 100% — không tự viết lại logic riêng ở đây)
  if (interaction.commandName === "skill") {
    if (await replyOnCooldown(interaction, 2000)) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "list") {
      await interaction.deferReply();
      const keyword = interaction.options.getString("keyword");
      const page = interaction.options.getInteger("page") ?? 1;
      const result = buildSkillListResult({ keyword, page });
      if (result.error) { await interaction.editReply({ content: result.error }); return; }
      await interaction.editReply({ embeds: [result.embed] });
      return;
    }

    if (sub === "roll") {
      await interaction.deferReply();
      const nameInput = interaction.options.getString("name") ?? "";
      const rollCount = interaction.options.getInteger("count") ?? 1;
      // "arg" dùng cho skill có promptArg (VD: Thrust cần nhập Light hiện tại qua arg).
      const argInput = interaction.options.getString("arg");
      const forceDullahan = interaction.options.getBoolean("dullahan") ?? false;

      const skill = findSkill(nameInput);
      if (!skill) {
        await interaction.editReply({ content: `❌ Không tìm thấy skill: \`${nameInput}\`\nDùng \`/skill list\` để xem danh sách.` });
        return;
      }

      const result = buildSkillRollResult({ skill, rollCount, promptArgRaw: argInput, forceDullahan });
      if (result.error) { await interaction.editReply({ content: result.error }); return; }
      await interaction.editReply({ embeds: [result.embed] });
      return;
    }
    return;
  }

  if (interaction.commandName === "math") {
    if (await replyOnCooldown(interaction, 2000)) return;
    await interaction.deferReply();
    const dmgStr = interaction.options.getString("dmg") ?? "";
    if (!dmgStr.trim()) {
      await interaction.editReply({
        content:
          "⚠️ Bạn chưa nhập `dmg`. Vui lòng nhập công thức damage.\n" +
          "> VD: `10B`, `5x3B`, `8S+Crit50`, `1DiceB`"
      });
      return;
    }
    const poiseInit = interaction.options.getInteger("poise") ?? 0;
    const critMul = interaction.options.getNumber("critmul") ?? 1.3;
    const diceMul = interaction.options.getNumber("dicemul") ?? 1;
    const sinkingInit = interaction.options.getInteger("sinking") ?? 0;
    const ruptureInit = interaction.options.getInteger("rupture") ?? 0;
    const sanityInit = interaction.options.getInteger("sanity") ?? 0;
    const theLiving = interaction.options.getInteger("living") ?? 0;
    const theDeparted = interaction.options.getInteger("departed") ?? 0;
    const burnInit = interaction.options.getInteger("burn") ?? 0;
    const bleedInit = interaction.options.getInteger("bleed") ?? 0;
    const bleedActions = interaction.options.getInteger("bleedactions") ?? 1;
    const tremorInit = interaction.options.getInteger("tremor") ?? 0;
    const chargeInit = interaction.options.getInteger("charge") ?? 0;
    const bonusPct = interaction.options.getNumber("bonus") ?? 0;
    const sanityBonusPct = interaction.options.getNumber("sanitybonus") ?? 0;
    const errors = validateMathInputs({ bonusPct, sanityBonusPct, critMul, poiseInit, diceMul, sinkingInit, ruptureInit, sanityInit, theLiving, theDeparted, burnInit, bleedInit, bleedActions, tremorInit, chargeInit });
    if (errors.length > 0) { await interaction.editReply({ content: `❌ Input không hợp lệ:\n${errors.map(e => `• ${e}`).join("\n")}` }); return; }
    const critDivOption = (interaction.options.getString("critdiv") ?? "").trim().toLowerCase() || null;
    let critDivSlash = 0;
    if (critDivOption === "yes" || critDivOption === "true" || critDivOption === "1") {
      critDivSlash = 2;
    } else if (typeof critDivOption === "string") {
      const p = parseFloat(critDivOption);
      if (!isNaN(p) && p > 1) critDivSlash = p;
    }

    await interaction.editReply(calcMath({
      dmgStr,
      resStr: interaction.options.getString("res") ?? "",
      drStr: interaction.options.getString("dr") ?? "",
      bonusPct,
      sanityBonusPct,
      critMul,
      poiseInit,
      critDiv: critDivSlash,
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

  if (interaction.commandName === "parry") {
    if (await replyOnCooldown(interaction, 3000)) return;
    await interaction.deferReply();
    const rolls = Math.min(interaction.options.getInteger("rolls") ?? 1, PARRY_MAX_ROLLS);
    const { successCount, failCount, lines } = runParryRolls(rolls);
    let body = `**Parry ${rolls} lần:**\n${lines.join("\n")}\n**Kết quả tổng kết:**\n• Thành công: \`${successCount}\` lần\n• Thất bại: \`${failCount}\` lần`;
    if (body.length > 2000) body = body.substring(0, 1990) + "\n…(bị cắt bớt)";
    await interaction.editReply({ content: body });
    return;
  }

  if (interaction.commandName === "daily") {
    if (await replyOnCooldown(interaction, 3000)) return;
    await interaction.deferReply();
    try {
      const result = await processDailyClaimForUser(interaction.user.id);
      if (result.alreadyClaimed) {
        await interaction.editReply({ content: `${interaction.user}, bạn đã nhận daily hôm nay rồi.\nThời gian còn lại đến reset: **${result.hours}h ${result.minutes}m ${result.seconds}s**.` });
      } else {
        await interaction.editReply({ content: result.replyMsg.replace("{USER}", interaction.user.toString()) });
      }
    } catch (err) {
      log("error", "/daily", interaction.user.id, err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}` });
    }
    return;
  }

  if (interaction.commandName === "randombook") {
    if (await replyOnCooldown(interaction, 3000)) return;
    await interaction.deferReply();
    const userId = interaction.user.id;
    const count = Math.min(Math.max(1, interaction.options.getInteger("count") ?? 1), OPEN_COUNT_MAX);
    try {
      const { success, data, results, partial } = await handleOpenRandomBook(userId, count);
      if (!success) {
        await interaction.editReply({ content: "❌ Bạn không có **Random Book** nào trong kho hoặc không đủ số lượng." });
        return;
      }
      await interaction.editReply({
        embeds: [{
          title: `📖 Mở Random Book${results.length > 1 ? ` × ${results.length}` : ""}`,
          color: 0x2ecc71,
          description: buildRollDescription({
            user: interaction.user,
            cacheType: "Random Book",
            results,
            remainingCount: data.books["Random Book"] ?? 0,
          }),
          footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Random Book nên chỉ mở được ${results.length} lần.` } : undefined,
        }],
      });
    } catch (err) {
      log("error", "/randombook", userId, err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}` });
    }
    return;
  }

  if (interaction.commandName === "randomsealedbook") {
    if (await replyOnCooldown(interaction, 3000)) return;
    await interaction.deferReply();
    const userId = interaction.user.id;
    const count = Math.min(Math.max(1, interaction.options.getInteger("count") ?? 1), OPEN_COUNT_MAX);
    try {
      const { success, data, results, partial } = await handleOpenSealedBook(userId, count);
      if (!success) {
        await interaction.editReply({ content: "❌ Bạn không có **Sealed Book Cache** nào trong kho hoặc không đủ số lượng." });
        return;
      }
      await interaction.editReply({
        embeds: [{
          title: `🔮 Mở Sealed Book Cache${results.length > 1 ? ` × ${results.length}` : ""}`,
          color: 0x9b59b6,
          description: buildRollDescription({
            user: interaction.user,
            cacheType: "Sealed Book Cache",
            results,
            remainingCount: data.books["Sealed Book Cache"] ?? 0,
          }),
          footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Sealed Book Cache nên chỉ mở được ${results.length} lần.` } : undefined,
        }],
      });
    } catch (err) {
      log("error", "/randomsealedbook", userId, err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}` });
    }
    return;
  }

  if (interaction.commandName === "chipboardcache") {
    if (await replyOnCooldown(interaction, 3000)) return;
    await interaction.deferReply();
    const userId = interaction.user.id;
    const count = Math.min(Math.max(1, interaction.options.getInteger("count") ?? 1), OPEN_COUNT_MAX);
    try {
      const { success, data, results, partial } = await handleOpenChipboardCache(userId, count);
      if (!success) {
        await interaction.editReply({ content: "❌ Bạn không có **Chipboard Cache** nào trong kho hoặc không đủ số lượng." });
        return;
      }
      await interaction.editReply({
        embeds: [{
          title: `🔩 Mở Chipboard Cache${results.length > 1 ? ` × ${results.length}` : ""}`,
          color: 0xe67e22,
          description: buildRollDescription({
            user: interaction.user,
            cacheType: "Chipboard Cache",
            results,
            remainingCount: data.items["Chipboard Cache"] ?? 0,
          }),
          footer: partial ? { text: `⚠️ Bạn chỉ có ${results.length}/${count} Chipboard Cache nên chỉ mở được ${results.length} lần.` } : undefined,
        }],
      });
    } catch (err) {
      log("error", "/chipboardcache", userId, err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra, thử lại sau nhé."}` });
    }
    return;
  }

  if (interaction.commandName === "balance") {
    if (await replyOnCooldown(interaction, 2000)) return;
    await interaction.deferReply();
    const targetUser = interaction.options.getUser("user") ?? interaction.user;
    try {
      await interaction.editReply(await buildBalanceEmbed(targetUser, targetUser.id === interaction.user.id));
    } catch (err) {
      log("error", "/balance", targetUser.id, err.message);
      await interaction.editReply({ content: "❌ Có lỗi xảy ra khi lấy dữ liệu." });
    }
    return;
  }

  if (interaction.commandName === "inventory") {
    if (await replyOnCooldown(interaction, 2000)) return;
    await interaction.deferReply();
    const targetUser = interaction.options.getUser("user") ?? interaction.user;
    try {
      const reply = await fetchInventoryReply(targetUser);
      if (!reply) {
        await interaction.editReply({ content: `📦 ${targetUser} không có gì trong kho.` });
        return;
      }
      await interaction.editReply(reply);
    } catch (err) {
      log("error", "/inventory", targetUser.id, err.message);
      await interaction.editReply({ content: "❌ Có lỗi xảy ra khi lấy dữ liệu." });
    }
    return;
  }

  if (interaction.commandName === "use") {
    if (await replyOnCooldown(interaction, 2000)) return; 
    const userId = interaction.user.id;
    await interaction.deferReply();
    const itemInput = interaction.options.getString("item") ?? "";
    const craftCount = Math.max(1, interaction.options.getInteger("count") ?? 1);
    const itemName = findItem(itemInput);
    if (!itemName) {
      await interaction.editReply({ content: `❌ Vật phẩm không hợp lệ: \`${itemInput}\`\nDùng \`/items\` để xem danh sách, \`/recipes\` để xem công thức craft.` });
      return;
    }
    const recipe = CRAFT_RECIPES[itemName];
    if (!recipe) {
      await interaction.editReply({ content: `❌ **${itemName}** không có công thức craft.\nDùng \`/recipes\` để xem các vật phẩm có thể craft.` });
      return;
    }
    try {
      // Tách interaction.editReply ra ngoài withLock: nếu Discord API chậm (network lag,
      // rate limit), lock TTL có thể hết hạn trong khi vẫn đang giữ lock, cho phép
      // concurrent operation trên cùng userId. executeCraft chỉ cần Redis — giữ trong lock.
      const { outputLines, costLines } = await withLock(userId, () =>
        executeCraft(userId, itemName, craftCount)
      );
      await interaction.editReply({
        content:
          `⚒️ ${interaction.user} đã craft thành công!\n` +
          `> 🎁 Nhận được: ${outputLines.join(", ")}\n` +
          `> 📦 Nguyên liệu đã dùng:\n` +
          costLines.map(l => `> ${l}`).join("\n"),
      });
    } catch (err) {
      log("error", "/use", userId, err.message);
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}` });
    }
    return;
  }

  if (interaction.commandName === "give") {
    if (await replyOnCooldown(interaction, 3000)) return;
    const isAdmin = ADMIN_IDS.has(interaction.user.id);
    await interaction.deferReply();
    const targetUser = interaction.options.getUser("user");
    if (!targetUser) { await interaction.editReply({ content: "❌ Không tìm thấy người nhận." }); return; }
    if (targetUser.id === interaction.user.id) { await interaction.editReply({ content: "❌ Không thể tặng cho chính mình." }); return; }

    const ahnGain = interaction.options.getInteger("ahn") ?? 0;
    const bookRaw = interaction.options.getString("book") ?? null;
    const bookCount = Math.max(1, interaction.options.getInteger("bookcount") ?? 1);
    const itemRaw = interaction.options.getString("item") ?? null;
    const itemCount = Math.max(1, interaction.options.getInteger("itemcount") ?? 1);
    const expGain = interaction.options.getInteger("exp") ?? 0;
    const gradeTarget = interaction.options.getInteger("grade") ?? null;

    if (!isAdmin && (expGain !== 0 || gradeTarget !== null)) {
      await interaction.editReply({ content: "❌ Bạn không thể tặng EXP cho người khác." });
      return;
    }
    if (!isAdmin && ahnGain < 0) { await interaction.editReply({ content: "❌ Không thể chuyển số Ahn âm." }); return; }

    let bookName = null;
    if (bookRaw) {
      bookName = findBook(bookRaw);
      if (!bookName) { await interaction.editReply({ content: `❌ Tên sách không hợp lệ: \`${bookRaw}\`` }); return; }
    }
    let itemName = null;
    if (itemRaw) {
      itemName = isAdmin ? findItemAdmin(itemRaw) : findItem(itemRaw);
      if (!itemName) { await interaction.editReply({ content: `❌ Tên vật phẩm không hợp lệ: \`${itemRaw}\`` }); return; }
    }
    if (ahnGain === 0 && !bookName && !itemName && expGain === 0 && gradeTarget === null) {
      await interaction.editReply({ content: "❌ Cần chỉ định ít nhất một trong: `ahn`, `book`, `item`" + (isAdmin ? ", `exp`, `grade`." : ".") });
      return;
    }

    // Thay vì thực hiện ngay, hiển thị preview + nút Xác nhận/Hủy — nhất quán với
    // prefix -give, tránh chuyển nhầm người/nhầm số lượng.
    const previewLines = buildGivePreviewLines({ ahnGain, bookName, bookCount, itemName, itemCount, expGain, gradeTarget });
    const giveId = registerPendingGive(interaction.user.id, targetUser.id, isAdmin, {
      ahnGain, bookName, bookCount, itemName, itemCount, expGain, gradeTarget,
    });
    await interaction.editReply({
      embeds: [{
        title: "📦 Xác nhận chuyển đồ",
        description:
          `${interaction.user} muốn ${isAdmin ? "tặng" : "chuyển"} cho ${targetUser}:\n` +
          previewLines.map(l => `> ${l}`).join("\n"),
        color: 0xf0a500,
        footer: { text: "Hết hạn sau 60 giây" },
      }],
      components: [buildGiveConfirmRow(giveId)],
    });
    return;
  }

  if (interaction.commandName === "remove") {
    if (await replyOnCooldown(interaction, 3000)) return;
    const isAdmin = ADMIN_IDS.has(interaction.user.id);
    await interaction.deferReply();
    const mentionedUser = interaction.options.getUser("user");
    let targetUser;
    if (mentionedUser) {
      if (!isAdmin && mentionedUser.id !== interaction.user.id) {
        await interaction.editReply({ content: "❌ Bạn chỉ có thể xóa đồ của chính mình." });
        return;
      }
      targetUser = mentionedUser;
    } else {
      targetUser = interaction.user;
    }

    const expRemove = interaction.options.getInteger("exp") ?? 0;
    const ahnRemove = interaction.options.getInteger("ahn") ?? 0;
    const bookRaw = interaction.options.getString("book") ?? null;
    const bookCount = Math.max(1, interaction.options.getInteger("bookcount") ?? 1);
    const itemRaw = interaction.options.getString("item") ?? null;
    const itemCount = Math.max(1, interaction.options.getInteger("itemcount") ?? 1);

    if (!isAdmin && (expRemove !== 0 || ahnRemove !== 0)) {
      await interaction.editReply({ content: "❌ Bạn chỉ có thể tự xóa sách hoặc vật phẩm của mình." });
      return;
    }

    const bookEntries = [];
    if (bookRaw) {
      const bookName = findBook(bookRaw);
      if (!bookName) { await interaction.editReply({ content: `❌ Tên sách không hợp lệ: \`${bookRaw}\`` }); return; }
      bookEntries.push({ name: bookName, count: bookCount });
    }
    const booksRaw = interaction.options.getString("books") ?? null;
    if (booksRaw) {
      const result = parseBatchEntries(booksRaw, findBook, "sách");
      if (result.error) { await interaction.editReply({ content: result.error }); return; }
      bookEntries.push(...result.entries);
    }
    const itemEntries = [];
    if (itemRaw) {
      const itemName = isAdmin ? findItemAdmin(itemRaw) : findItem(itemRaw);
      if (!itemName) { await interaction.editReply({ content: `❌ Tên vật phẩm không hợp lệ: \`${itemRaw}\`` }); return; }
      itemEntries.push({ name: itemName, count: itemCount });
    }
    const itemsRaw = interaction.options.getString("items") ?? null;
    if (itemsRaw) {
      const findFn = isAdmin ? findItemAdmin : findItem;
      const result = parseBatchEntries(itemsRaw, findFn, "vật phẩm");
      if (result.error) { await interaction.editReply({ content: result.error }); return; }
      itemEntries.push(...result.entries);
    }

    if (expRemove === 0 && ahnRemove === 0 && bookEntries.length === 0 && itemEntries.length === 0) {
      await interaction.editReply({ content: "❌ Cần chỉ định ít nhất một trong: `exp`, `ahn`, `book`, `item`, `books`, `items`." });
      return;
    }

    try {
      const changes = await withLock(targetUser.id, () => executeRemove({
        actorId: interaction.user.id, targetId: targetUser.id,
        isAdmin, expRemove, ahnRemove, bookEntries, itemEntries,
      }));
      const isSelf = targetUser.id === interaction.user.id;
      await interaction.editReply({
        content: (isSelf ? `🗑️ ${interaction.user} đã xóa khỏi kho của mình:` : `🗑️ ${interaction.user} (admin) đã xóa khỏi kho của ${targetUser}:`) +
          "\n" + changes.map(c => `> ${c}`).join("\n"),
      });
    } catch (err) {
      log("error", "/remove", targetUser.id, err.message, { actor: interaction.user.id });
      await interaction.editReply({ content: `❌ ${err.message ?? "Có lỗi xảy ra khi lưu dữ liệu."}` });
    }
    return;
  }

  // ── /profile ──
  // ── /dothihelp — ephemeral (chỉ người dùng lệnh thấy được), theo yêu cầu trực
  // tiếp — KHÁC -dothihelp (gửi qua DM).
  if (interaction.commandName === "dothihelp") {
    const isAdminHelp = ADMIN_IDS.has(interaction.user.id);
    await interaction.reply({ embeds: [buildDothihelpEmbed(isAdminHelp)], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  if (interaction.commandName === "profile") {
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand();

    if (sub === "switch") {
      if (await replyOnCooldown(interaction, 2000)) return;
      const slot = interaction.options.getInteger("slot");
      const currentSlot = await getActiveProfileSlot(userId);
      if (slot === currentSlot) {
        const names = await getProfileNames(userId);
        await interaction.reply({
          content: `ℹ️ Bạn đang ở **${resolveProfileLabel(names, slot)}** rồi.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await setActiveProfileSlot(userId, slot);
      const names = await getProfileNames(userId);
      const label = resolveProfileLabel(names, slot);
      await interaction.reply({
        content: `✅ Đã chuyển sang **${PROFILE_EMOJIS[slot]} ${label}**!\n> Tất cả lệnh từ bây giờ sẽ dùng save này.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "info") {
      if (await replyOnCooldown(interaction, 2000)) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { embed, components } = await buildProfileInfoEmbed(
        userId,
        interaction.user.displayName ?? interaction.user.username,
        "Bấm nút bên dưới để đổi profile"
      );
      await interaction.editReply({ embeds: [embed], components });
      return;
    }

    if (sub === "rename") {
      if (await replyOnCooldown(interaction, 2000)) return;
      const currentSlot = await getActiveProfileSlot(userId);
      const rawName = (interaction.options.getString("name") ?? "").trim();

      // Validate
      if (rawName.length > PROFILE_NAME_MAX_LENGTH) {
        await interaction.reply({
          content: `❌ Tên profile tối đa ${PROFILE_NAME_MAX_LENGTH} ký tự.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await setProfileName(userId, currentSlot, rawName || null);
      const newLabel = rawName || PROFILE_LABELS[currentSlot];
      await interaction.reply({
        content: rawName
          ? `✅ Đã đặt tên **${PROFILE_EMOJIS[currentSlot]} Profile ${currentSlot}** thành **"${newLabel}"**!`
          : `✅ Đã reset tên **${PROFILE_EMOJIS[currentSlot]} Profile ${currentSlot}** về mặc định **"${newLabel}"**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    return;
  }
  } catch (err) {
    log("error", "interactionCreate", interaction.user?.id ?? "unknown", err.message, { cmd: interaction.commandName });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Có lỗi không mong muốn xảy ra.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});
};