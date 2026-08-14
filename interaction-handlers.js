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

const fs = require("fs");
const path = require("path");

// Xem bgmAttachment ở message-create-handler.js — thiếu file nhạc thì bỏ đính
// kèm chứ không để discord.js ném ENOENT làm hỏng cả tương tác.
// specialActionInFlight — khoá CHỐNG BẤM ĐÚP cho panel Special (Manifest E.G.O,
// Shin/Mang, Overcharge...). Những hành động này đổi chỉ số VĨNH VIỄN trong trận
// nên bấm 2 lần là cộng dồn 2 lần. Khoá theo (channel, user, action).
// ❗ shortTokenFor — customId của Discord CHẶN CỨNG 100 KÝ TỰ.
// `enctarget:<channelId 19>:criticalhit:<encodeURIComponent(tên skill)>` vượt trần
// với các tên Critical DÀI của Caduceus ⇒ discord.js ném **"Invalid string length"**
// và người chơi kẹt luôn lượt. Đo thật:
//   Crit1 Blunt  94 ✅ · Crit1 Pierce 103 ❌ · Crit1 Slash 118 ❌ · Crit3 Pierce 102 ❌
// — khớp CHÍNH XÁC danh sách Fragaria báo.
// Nay nhét TOKEN NGẮN vào customId, tra ngược ra tên qua Map này.
const shortTokenRegistry = new Map();
let shortTokenSeq = 0;
function shortTokenFor(name) {
  const token = `k${(shortTokenSeq = (shortTokenSeq + 1) % 100000)}`;
  shortTokenRegistry.set(token, { name, at: Date.now() });
  // Dọn rác: bỏ token cũ hơn 30 phút (một trận dài cũng không quá mốc này).
  if (shortTokenRegistry.size > 500) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [k, v] of shortTokenRegistry) if (v.at < cutoff) shortTokenRegistry.delete(k);
  }
  return token;
}
/** resolveShortToken — nhận lại tên thật; nếu không phải token thì trả nguyên
 *  chuỗi (tương thích ngược với message CŨ đang còn trên màn hình). */
function resolveShortToken(raw) {
  const hit = shortTokenRegistry.get(raw);
  return hit ? hit.name : decodeURIComponent(raw);
}

/** takePendingBgmFiles — lấy file BGM đang chờ phát, ĐỌC XONG XOÁ CỜ.
 *
 *  ❗ Fragaria báo 2 lượt liền: "xài Furioso nhưng KHÔNG thấy gửi file BGM ngay như
 *  Manifested E.G.O Red Mist" — dù file ĐÃ CÓ trên server và dòng chữ vẫn hiện.
 *  Khác biệt giữa hai đường:
 *    • Manifest E.G.O — đính `files` THẲNG vào `interaction.reply` ⇒ CHẠY
 *    • Furioso        — gọi `announceBgmIfChanged` → `client.channels.fetch(...)`
 *                       → `channel.send(...)`, một message RIÊNG, và toàn bộ bọc
 *                       `.catch(() => {})` nên hỏng ở bất kỳ khâu nào cũng im lặng.
 *  Không lấy được log server ⇒ thay vì đoán tiếp khâu nào hỏng, **bỏ hẳn đường
 *  channel.send** và dùng ĐÚNG cơ chế đã được xác nhận là chạy.
 *  @returns { files, name } — `files` rỗng nếu không có gì để phát.
 */
// ❗❗ BUG ĐÃ SỬA (Fragaria: "❌ AttachmentBuilder is not defined khi xài clash
// của Furioso Replica"). HÀM NÀY nằm ở **module top-level**, NGOÀI thân factory,
// nhưng lại dùng `AttachmentBuilder` — vốn là **tham số DI của factory**, không
// tồn tại ở scope này ⇒ ReferenceError mỗi lần chạy.
// ⚠️ ĐÚNG Y HỆT cái bẫy đã được ghi rõ ngay dưới, ở `bgmAttachmentIH` — tôi đọc
// comment đó rồi vẫn viết lại hàm mới cùng hình dạng. Trước đây nó không lộ ra
// vì `announceBgmIfChanged` cướp cờ trước nên hàm này gần như không bao giờ
// chạm tới nhánh có `AttachmentBuilder`; sửa xong bug BGM thì lỗi này lộ ngay.
// NAY: nhận `AttachmentBuilder` làm THAM SỐ (cùng cách `bgmAttachmentIH` đang
// làm) — không mượn tên từ scope không có.

/** takePendingBgmFilesSafe — bản KHÔNG BAO GIỜ NÉM. BGM là thứ trang trí; hỏng
 *  nó không được phép làm hỏng luồng resolve/hiển thị (xem chuỗi nhân quả đầy đủ
 *  ở comment trong reactive-defense.js: một ReferenceError ở đây từng làm KẸT
 *  hẳn pendingAction Furioso). */
function takePendingBgmFilesSafe(encounter, AttachmentBuilder) {
  try { return takePendingBgmFiles(encounter, AttachmentBuilder); }
  catch { return { files: [], name: null }; }
}

function takePendingBgmFiles(encounter, AttachmentBuilder) {
  for (const pl of Object.values(encounter?.players ?? {})) {
    if (!pl?.bgmAnnounceNow) continue;
    const name = pl.bgmAnnounceNow;
    // Nhãn RIÊNG theo nguồn (Furioso / Manifest E.G.O / …) — Fragaria: "phần
    // description là của Furioso BGM, đừng lẫn hai cái vào nhau như phiên trước".
    const label = pl.bgmAnnounceLabel ?? null;
    pl.bgmAnnounceNow = null;
    pl.bgmAnnounceLabel = null;
    return { files: bgmAttachmentIH(AttachmentBuilder, name), name, label };
  }
  return { files: [], name: null };
}

const specialActionInFlight = new Set();
let bgmAttachmentLastMissing = null;
/** bgmAttachmentIH — trả [AttachmentBuilder] nếu file CÓ THẬT trên disk.
 *
 *  ❗ BUG NẶNG ĐÃ SỬA — vì sao `-encounter status` phát được BGM mà contract tự
 *  begin thì KHÔNG (Fragaria chỉ đúng điểm khác biệt này):
 *  Hàm này nằm ở **module top-level**, NGOÀI thân factory (khối nhận DI),
 *  nhưng lại gọi `AttachmentBuilder` — vốn là **tham số DI của factory**, không
 *  hề tồn tại ở scope này. Mỗi lần chạy là `ReferenceError: AttachmentBuilder is
 *  not defined`, và `try { … } catch { }` quanh từng ứng viên đường dẫn NUỐT SẠCH
 *  lỗi đó rồi rơi xuống `return []` ⇒ **luôn luôn không có file**, bất kể file có
 *  thật hay không.
 *  Bản ở `message-create-handler.js` nhận `AttachmentBuilder` làm THAM SỐ nên
 *  chạy đúng — đó chính là lý do `-encounter status` vẫn phát được.
 *
 *  ⚠️ Bài học kèm theo: `catch { }` trắng quanh code có thể ném ReferenceError
 *  biến lỗi lập trình thành "im lặng không hoạt động". Nay chỉ nuốt lỗi ĐỌC FILE,
 *  còn lỗi dựng attachment thì ném ra để thấy ngay.
 */
function bgmAttachmentIH(AttachmentBuilder, name) {
  bgmAttachmentLastMissing = null;
  if (!name) return [];
  const fs = require("fs");
  const nodePath = require("path");
  // `__dirname` = repo root (mọi .js nằm ở root) — relative path giải theo CWD
  // của tiến trình, mà Render không đảm bảo CWD là repo root.
  const candidates = [
    nodePath.join(__dirname, "assets", "audio", "bgm", name),
    nodePath.resolve("assets", "audio", "bgm", name),
  ];
  let found = null;
  for (const c of candidates) {
    // CHỈ bọc phép ĐỌC ĐĨA — không bọc `new AttachmentBuilder`.
    try { if (fs.existsSync(c)) { found = c; break; } } catch { /* ổ đĩa lỗi, thử ứng viên kế */ }
  }
  if (!found) {
    bgmAttachmentLastMissing = name;
    return [];
  }
  return [new AttachmentBuilder(found)];
}

module.exports = function ({ SKILL_MAX_MULTI, consumeCaduceusFaceUse, POISE_MAX, drainAwaitingPrompts, applyShieldLoss, isPermanentInjury, applyFuriosoUseCosts, clashDiceOf, attackerClashDiceOf, findSingularity, describeEncounterBgm, resolveEncounterBgm, CADUCEUS_DICE, CADUCEUS_STAMINA_PER_CHARGE, validateAccessoryEquip, GRADE_MIN, calcGrade, calcInjuryMaxHpPenalty, mostRecentHpResetBoundaryUtc, egoBgmFor, performMimicryForm, applyHpLoss, shopWeeklyStockMap, isConsumableItem, ADMIN_IDS, buildReuseVariants, resolveSkillKey, cdKeyFor, findOwnedPageKey, pityKeyFor, pityPoolFor, buildShopEmbed, buildShopComponents, buildQuantityComponents, shopPurchase, shopResetSkillTree, ActionRowBuilder, AttachmentBuilder, BOOK_GRANTS, BRANCH_KEYS, ButtonBuilder, ButtonStyle, CONTRACTS, CRAFT_RECIPES, EGO_TIER_SLOT_ORDER, ENCOUNTER_DEFAULT_MAX_STAMINA, ENCOUNTER_KEY_MAX_LENGTH, ENCOUNTER_STAMINA_REGEN_PER_TURN, GACHA_BANNERS, GACHA_PITY_MAX, MAX_PROFILES, MessageFlags, ModalBuilder, OPEN_COUNT_MAX, PARRY_MAX_ROLLS, PERK_BRANCH, PERK_POINT_COSTS, PROFILE_EMOJIS, PROFILE_LABELS, PROFILE_NAME_MAX_LENGTH, STATUS_CAPS_SHARED, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TREMOR_VARIANT_MAX, TextInputBuilder, TextInputStyle, UNIVERSALLY_KNOWN_WEAPONS, WEAPON_DEFENSE_HITS, WEAPON_STAMINA_COST, advanceToNextTurnHolder, announceCurrentTurn, appendActionLog, applyClashLossSanity, applyDullahanParryCounter, applyEmotionDelta, applySanityGain, applyStatusEntries, attachCounterContext, autoBuildDmgStrFromSkillRoll, buildBalanceEmbed, buildBookChoiceComponents, buildBossActionPanel, buildDothihelpEmbed, buildEncounterActionPanel, buildEncounterBoardEmbed, buildGmPanelContent, buildEnemyTargetOptions, buildAllyTargetOptions, buildMovesPanel, buildSpecialPanel, buildItemsPanel, buildGachaPanelButtons, buildGachaPanelEmbed, buildGiveConfirmRow, buildGivePreviewLines, buildProfileInfoEmbed, buildRollDescription, buildRtparryLinkButton, buildSkillListResult, buildSkillRollResult, buildTurnOrderText, calcBranchPointsAllocated, calcMath, calcMathCore, calcSkillTreePointsEarned, cancelPartyBoard, checkStaggerPanic, claimDailyLogin, client, combatantResStr, computeDefenseOptions, createCombatant, createRtparryToken, deleteEncounter, doEnemyAttack, doPlayerAttack, doPlayerHit, encounterKey, executeCraft, executeGive, executeReadBookChoose, executeRemove, fetchInventoryReply, finalizeReactiveChoice, findAccessory, findBook, findExclusiveConflict, findItem, findItemAdmin, findOutfit, findSkill, findWeaponAnywhere, formatNumber, getActiveProfileSlot, getBookGroupChoices, getEgoTier, getEncounter, getParryClashPenalty, getPlayerData, getPlayerDataWithSlot, getProfileNames, getUserActiveEncounterChannel, handleOpenChipboardCache, handleOpenRandomBook, handleOpenSealedBook, hasEncounterStarted, hasPerk, insertIntoTurnOrderMidRound, isBannerActive, isCurrentTurnHolder, isOnCooldown, joinPartyBoard, leavePartyBoard, log, maybeRunAiTurn, normalizeEnemyKey, normalizeWeaponWeight, parseAoeInfo, parseBatchEntries, parsePerHitBypass, parseSkillCooldownTurns, parseSkillCost, parseStatusFreeText, pendingGives, performEndTurn, performFollowUp, performGachaPull, performGuardEvade, performManifestEgo, performOvercharge, performParry, performPityExchange, performShinMang, performUseItem, registerPendingGive, replyOnCooldown, resolveCombatant, resolveOnePendingAction, resolveProfileLabel, resolveSkillVerification, runParryRolls, saveEncounter, savePlayerData, sendReactiveDefensePrompt, setActiveProfileSlot, setProfileName, setUserActiveEncounterChannel, startPartyBoard, validateMathInputs, webParrySessions, withDoubleLock, withLock }) {
  // ⚠️ ĐẶT TRONG THÂN FACTORY (không phải top-level): hàm này dùng `client`,
  // `ActionRowBuilder`, `StringSelectMenuBuilder`, `StringSelectMenuOptionBuilder`
  // — đều là THAM SỐ DI. Tôi đã viết nhầm ở top-level và `t-di.js` bắt được ngay
  // ("dùng ngoài scope: client (trong sendAstralTargetPrompts)…") — đúng bẫy
  // AttachmentBuilder cũ, lần này test chặn trước khi tới tay người chơi.
/** sendAstralTargetPrompts — bắn dropdown "chọn mục tiêu Astral Quantization"
 *  cho NGƯỜI BUFF, ở mốc cuối Turn Order.
 *  Số dmg đã được `performEndTurn` chốt TRƯỚC khi `advanceCombatantTurn` reset
 *  `dmgDealtThisTurn` — ở đây tuyệt đối KHÔNG tính lại, nếu không sẽ ra 0. */
async function sendAstralTargetPrompts(channelId, encounter) {
  const queue = encounter?.pendingAstralChoice ?? [];
  if (queue.length === 0) return;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) return;
  for (let i = 0; i < queue.length; i++) {
    const aq = queue[i];
    const opts = Object.entries(encounter.enemies ?? {})
      .filter(([, e]) => (e?.currentHp ?? 0) > 0)
      .slice(0, 25)
      .map(([k, e]) => new StringSelectMenuOptionBuilder()
        .setLabel(`${e.name ?? k}`.slice(0, 100))
        .setDescription(`${Math.round(e.currentHp)}/${Math.round(e.maxHp)} HP`.slice(0, 100))
        .setValue(k));
    if (opts.length === 0) continue;
    await ch.send({
      content: `<@${aq.userId}>`,
      embeds: [{
        title: "🌌 Astral Quantization — chọn mục tiêu",
        description: `**${aq.amount}** dmg (**${aq.pct}%** của **${aq.totalDealt}** tổng dmg <@${aq.allyId}> đã gây trong turn).`
          + `\nChọn **một** đối thủ để nhận đòn này:`,
        color: 0x8e44ad,
      }],
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`astraltarget:${channelId}:${i}`)
          .setPlaceholder("Chọn đối thủ...")
          .setMinValues(1).setMaxValues(1)
          .addOptions(...opts),
      )],
    }).catch(() => {});
  }
}


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
      const activeChan = await getUserActiveEncounterChannel(targetUserId);
      if (activeChan) {
        return interaction.reply({ content: `⚠️ Bạn đang trong 1 encounter (channel <#${activeChan}>) — không thể đổi profile giữa trận.`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
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

  // "partyjoin:"/"partyleave:"/"partybegin:"/"partycancel:" — Task yêu cầu
  // trực tiếp: "nút join leave party thì nằm ở chỗ party board luôn" — thay
  // thế hoàn toàn cho `-contract join/leave/begin/cancel` (text, đã gỡ).
  function formatBoardTextInline(board, contract) {
    const guestLines = board.guests.length > 0 ? board.guests.map(g => `<@${g.id}>`).join(", ") : "*(chưa có ai)*";
    return `📋 **Party Board** — Contract: **${contract.name}** (${contract.description})\n` +
      `> 👑 Host: <@${board.hostId}>\n` +
      `> 🧑‍🤝‍🧑 Guest: ${guestLines}\n` +
      `> 🎁 Thưởng: ${contract.expReward} EXP, ${contract.ahnReward.toLocaleString("vi-VN")} Ahn (mỗi người, nếu còn lượt contract trong ngày)`;
  }
  function buildPartyBoardComponentsInline(channelId) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`partyjoin:${channelId}`).setLabel("🎒 Tham gia").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`partyleave:${channelId}`).setLabel("👋 Rời party").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`partybegin:${channelId}`).setLabel("▶️ Bắt đầu (host)").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`partycancel:${channelId}`).setLabel("❌ Huỷ (host)").setStyle(ButtonStyle.Danger),
    )];
  }
  if (interaction.customId.startsWith("partyjoin:")) {
    const [, channelId] = interaction.customId.split(":");
    try {
      const activeChan = await getUserActiveEncounterChannel(interaction.user.id);
      if (activeChan) throw new Error(`Bạn đang trong 1 encounter khác (channel <#${activeChan}>) — không thể join party mới cho tới khi kết thúc encounter đó.`);
      const board = await joinPartyBoard(channelId, interaction.user.id, interaction.user.username);
      const contract = CONTRACTS[board.contractKey];
      await interaction.update({ content: `✅ <@${interaction.user.id}> đã tham gia party.\n${formatBoardTextInline(board, contract)}`, components: buildPartyBoardComponentsInline(channelId) }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  if (interaction.customId.startsWith("partyleave:")) {
    const [, channelId] = interaction.customId.split(":");
    try {
      const { board, disbanded } = await leavePartyBoard(channelId, interaction.user.id);
      if (disbanded) { await interaction.update({ content: "👋 Đã rời party — party không còn ai nên đã tự giải tán.", components: [] }).catch(() => {}); return; }
      const contract = CONTRACTS[board.contractKey];
      await interaction.update({ content: `👋 <@${interaction.user.id}> đã rời party.\n${formatBoardTextInline(board, contract)}`, components: buildPartyBoardComponentsInline(channelId) }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  // ── SHOP (shop.js) ────────────────────────────────────────────────────────
  // Mọi nhánh đều kiểm ownerId ở customId — tránh người khác bấm mua/reset hộ.
  // LƯU Ý: `shopbuy:` KHÔNG nằm ở đây — nó là StringSelectMenu, xử lý ở listener
  // riêng bên dưới (tìm "shopbuy:"). Listener NÀY bắt đầu bằng
  // `if (!interaction.isButton()) return;` nên mọi dropdown rơi vào đây đều CHẾT.
  if (interaction.customId.startsWith("shopqty:")
      || interaction.customId.startsWith("shopreset:") || interaction.customId.startsWith("shopback:")) {
    const parts = interaction.customId.split(":");
    const ownerId = parts[1];
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "⚠️ Đây là cửa hàng của người khác — gõ `-shop` để mở của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      if (parts[0] === "shopback") {
        const { data } = await getPlayerDataWithSlot(ownerId);
        // content: "" — xoá dòng kết quả của lần mua trước, nếu không nó treo
        // lại phía trên embed mãi (đúng cảnh Fragaria chụp: text cũ + "(edited)").
        return interaction.update({ content: "", embeds: [buildShopEmbed(data, await shopWeeklyStockMap())], components: buildShopComponents(ownerId) }).catch(() => {});
      }
      // shopqty / shopreset — có I/O (đọc + ghi profile) nên defer trước cho an
      // toàn với hạn 3 giây của Discord (bài học từ bug treo contract begin).
      await interaction.deferUpdate().catch(() => {});
      const result = parts[0] === "shopreset"
        ? await shopResetSkillTree(ownerId)
        : await shopPurchase(ownerId, parts[2], parts[3]);
      const freshData = result.data ?? (await getPlayerDataWithSlot(ownerId)).data;
      // Fragaria: "phần shop nên để text ở DƯỚI embed shop để tiện theo dõi".
      // Discord LUÔN render `content` phía TRÊN embed — không có cách nào đảo
      // thứ tự đó. Nên kết quả mua/reset được đưa vào EMBED THỨ HAI: nhiều embed
      // render theo đúng thứ tự trong mảng, nên nó nằm ngay dưới embed cửa hàng,
      // sát trên hàng nút. `content: ""` để xoá dòng text cũ còn sót từ lần
      // trước (editReply không tự xoá field không truyền).
      await interaction.editReply({
        content: "",
        embeds: [
          buildShopEmbed(freshData, await shopWeeklyStockMap()),
          { description: result.message, color: result.ok ? 0x2ecc71 : 0xe74c3c },
        ],
        components: buildShopComponents(ownerId),
      }).catch(() => {});
    } catch (err) {
      log("error", "shop", interaction.user.id, err.stack ?? err.message);
      await interaction.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  if (interaction.customId.startsWith("partybegin:")) {
    const [, channelId] = interaction.customId.split(":");
    try {
      // BUG ĐÃ SỬA (Fragaria: "contract bị treo sau khi bấm nút bắt đầu luôn, không
      // thể giải quyết được" — nút kẹt ở trạng thái "...").
      //
      // NGUYÊN NHÂN GỐC: Discord huỷ interaction nếu KHÔNG được phản hồi trong
      // **3 GIÂY**. `startPartyBoard` làm rất nhiều việc I/O trước khi tới
      // `interaction.update()`: đọc profile TỪNG thành viên, chạy
      // buildJoinedCombatant cho từng người (mỗi lần lại đọc+ghi profile), spawn
      // mob, roll turn order, save encounter — với Upstash Redis từ Render (chưa
      // kể cold start) là rất dễ vượt 3s. Quá hạn thì `interaction.update()` ném
      // "Unknown interaction", rơi vào catch, `interaction.reply` cũng chết theo
      // → nút đứng im mãi ở "...".
      //
      // Chú ý: đây KHÔNG phải do đoạn phát BGM (nó chạy SAU update). Việc thêm
      // BGM chỉ trùng thời điểm — thủ phạm là tổng thời gian I/O đã sát ngưỡng
      // từ trước, các thay đổi gần đây (ghi thêm field Shin/Mang, accessory vào
      // profile lúc join) đẩy nó vượt hẳn.
      //
      // SỬA: `deferUpdate()` NGAY LẬP TỨC — báo Discord "đã nhận, đang xử lý"
      // (nút hết xoay), nới hạn phản hồi lên 15 phút. Rồi mới làm việc nặng và
      // `editReply` sau.
      await interaction.deferUpdate().catch(() => {});
      const { encounter: startedEnc, contract: startedContract, prescriptNotesInit, memberStartNotes } = await startPartyBoard(channelId, interaction.user.id);
      await interaction.editReply({ content: `▶️ Contract **${startedContract.name}** đã bắt đầu!`, components: [] }).catch(() => {});
      // BUG ĐÃ SỬA (Fragaria báo trực tiếp: "sau khi contract bắt đầu thì không
      // tự hiện encounter board mà phải tự gõ encounter status mới hiện").
      // NGUYÊN NHÂN GỐC: nút này chỉ update message party board thành dòng chữ
      // "xem bên dưới" — nhưng KHÔNG có gì được gửi bên dưới cả. startPartyBoard
      // trả về encounter nhưng giá trị bị bỏ đi hoàn toàn (`await` trần).
      // Giờ gửi board + panel hành động y như `-encounter status`.
      const startChannel = await client.channels.fetch(channelId).catch(() => null);
      if (startChannel) {
        await startChannel.send({
          embeds: [buildEncounterBoardEmbed(startedEnc)],
          content: [
            ...(memberStartNotes ?? []).map(n => `> 🆙 ${n}`),
            ...(prescriptNotesInit ?? []).map(n => `> ${n}`),
          ].join("\n") || undefined,
        }).catch(() => {});
        // BUG ĐÃ SỬA (Fragaria: "Dropdown lúc contract begin hiện ra liên tục 3
        // cái") — do CHÍNH bản fix "tự hiện board" của tôi: nó gửi panel hành
        // động cho TỪNG player, trong khi `announceCurrentTurn` ngay bên dưới VỐN
        // ĐÃ gửi panel cho người tới lượt. Kết quả: panel bị nhân đôi/nhân ba
        // (mỗi panel lại gồm 3 dropdown Moves/Special/Items nên càng rối).
        // Bỏ vòng lặp này — để announceCurrentTurn lo, đúng như luồng encounter
        // thường vẫn chạy.
      }
      // BGM — GAP ĐÃ SỬA (Fragaria: "Contract khi begin không play bgm").
      // `startPartyBoard` ĐÃ chọn sẵn `currentBgm` (party-board.js), nhưng đường
      // contract chưa bao giờ ĐÍNH FILE — chỉ `-encounter start` mới đính. Người
      // chơi vào contract không nghe được gì.
      if (startChannel && startedEnc.currentBgm) {
        // `new AttachmentBuilder(...)` chạy ĐỒNG BỘ như tham số nên `.catch()` của
        // `.send()` KHÔNG bắt được nó — phải bọc try riêng, nếu không file BGM
        // thiếu/đường dẫn sai sẽ ném thẳng ra ngoài và phá cả luồng bắt đầu trận.
        try {
          await startChannel.send({
            content: (() => {
              const f = bgmAttachmentIH(AttachmentBuilder, startedEnc.currentBgm);
              return f.length
                ? `> 🎵 BGM trận này: **${startedEnc.currentBgm}**`
                : `> ⚠️ Không tìm thấy file BGM **${startedEnc.currentBgm}** — đặt nó vào \`assets/audio/bgm/\` trong repo rồi deploy lại.`;
            })(),
            files: bgmAttachmentIH(AttachmentBuilder, startedEnc.currentBgm),
          }).catch(() => {});
        } catch (bgmErr) {
          log("error", "partybegin-bgm", interaction.user.id, bgmErr.message);
        }
      }
      announceCurrentTurn(channelId, startedEnc, true).catch(() => {});
      maybeRunAiTurn(channelId).catch(() => {});
    } catch (err) {
      // Đã deferUpdate ở trên → `interaction.reply` KHÔNG dùng được nữa (interaction
      // đã được acknowledge). Phải followUp, và fallback gửi thẳng vào channel nếu
      // followUp cũng hỏng — để lỗi KHÔNG BAO GIỜ im lặng như trước.
      log("error", "partybegin", interaction.user.id, err.stack ?? err.message);
      const failed = await interaction.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => null);
      if (!failed) {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch) await ch.send({ content: `❌ <@${interaction.user.id}> Không bắt đầu được contract: ${err.message}` }).catch(() => {});
      }
    }
    return;
  }
  if (interaction.customId.startsWith("partycancel:")) {
    const [, channelId] = interaction.customId.split(":");
    try {
      await cancelPartyBoard(channelId, interaction.user.id);
      await interaction.update({ content: "❌ Đã huỷ party board.", components: [] }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }


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
        // ❗❗ BUG ĐÃ SỬA (Fragaria, lô 12/08: "Furioso Replica vẫn chưa tự động
        // phát BGM ổn, BGM vẫn được chạy ngầm khi gọi -encounter status sẽ hiện
        // ra; cái quan trọng là khi kích hoạt không tự động gửi file phát lên
        // như EGO Red Mist").
        // GỐC: `announceBgmIfChanged` ĐỌC XONG XOÁ cờ `bgmAnnounceNow` rồi tự gửi
        // bằng `channel.send` — đúng con đường đã bị bác ở lượt (W) vì hỏng khâu
        // nào cũng im lặng. Nó chạy TRƯỚC `takePendingBgmFiles` nên CƯỚP MẤT cờ:
        // hàm đính-file-vào-reply (đường ĐÃ XÁC NHẬN CHẠY của Red Mist) luôn thấy
        // rỗng ⇒ không bao giờ có file. Bỏ hẳn lời gọi này cho Furioso.
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
        // ⚠️ GIỮ LẠI action vừa được SINH RA TRONG lúc resolve (Payback) — chúng
        // chưa được GM duyệt, chưa ai phòng thủ, mà dòng `= []` cũ xoá sạch cả
        // chúng ⇒ đòn phản biến mất im lặng ở đúng đường force-confirm.
        encounter.pendingActions = (encounter.pendingActions ?? []).filter(pa => pa.awaitingPrompt);
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
        // PAYBACK — đường force-confirm KHÔNG đi qua `finalizeReactiveChoice`
        // nên phải drain tại đây. Fire-and-forget, đứng SAU saveEncounter vì
        // drain đọc encounter TƯƠI từ Redis.
        drainAwaitingPrompts(channelId).catch(() => {});
        // Stage 5 (quest system) — nếu quest vừa kết thúc (thắng/thua) ngay
        // trong action này, xoá encounter NGAY SAU khi save (cùng nguyên tắc
        // thứ tự với reactive-defense.js's finalizeReactiveChoice). GAP ĐÃ SỬA
        // (rà soát sau bug report treo encounter) — nếu đã xoá, BỎ QUA gửi board
        // embed (dòng 358-361 gốc) và announceCurrentTurn — cả 2 đều dùng
        // `encounter` biến CŨ, đã hết tồn tại trong Redis, gửi ra là dữ liệu ảo.
        if (encounter._deleteAfterSave) {
          await deleteEncounter(channelId).catch((err) => log("error", "confirmall-deleteEncounter", interaction.user.id, err.message));
          await interaction.update({
            content: "", // xoá text/mention cũ — update KHÔNG tự xoá field không truyền
            embeds: [{
              title: isConfirm ? "✅ Đã xác nhận tất cả" : "❌ Đã reject tất cả",
              description: (resultLines.join("\n") || "*(không có gì)*") + victoryNote,
              color: isConfirm ? 0x2ecc71 : 0xe74c3c,
            }],
            components: [],
          }).catch(() => {});
          return;
        }

        await interaction.update({
          content: "", // xoá text/mention cũ — update KHÔNG tự xoá field không truyền
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
        .setPlaceholder("rupture: 5 | res: 1.3xB 1xP 1xS | speedrange: 3~6 | set emotioncoin: 2 | cd durandal: 3")
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

  // Nút "🎛️ Mở GM Panel" (xem message-create-handler.js's -encounter start) —
  // GAP MỚI (xác nhận trực tiếp): "có thể tạo 1 nút ở dưới khiến GM có thẩm
  // quyền mở được gmpanel luôn" — tái dùng buildGmPanelContent (đã tách sang
  // gmpanel-builder.js) thay vì lặp lại logic.
  if (interaction.customId.startsWith("gmpanelopenbtn:")) {
    const [, channelId, ownerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
      return interaction.reply({ content: "⚠️ Chỉ người tạo encounter này mới bấm được.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      const content = await buildGmPanelContent(channelId, interaction.user.id);
      await interaction.reply(content);
    } catch (err) {
      await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // GAP ĐÃ SỬA (xác nhận trực tiếp: "add... enemy") — nút "➕ Add Enemy" trong
  // gmpanel, mở Modal nhập key/name/hp/res/weapon (tái dùng field giống lệnh
  // text -encounter addenemy).
  if (interaction.customId.startsWith("gmpaneladdskill:")) {
    const [, channelId, ownerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
      return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới bấm được.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Encounter không còn tồn tại.");
      const enemyOptions = Object.entries(encounter.enemies).filter(([, e]) => e.currentHp > 0)
        .map(([k, e]) => new StringSelectMenuOptionBuilder().setLabel(`👹 ${e.name} (${k})`).setValue(k));
      if (enemyOptions.length === 0) throw new Error("Chưa có enemy nào còn sống.");
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`gmaddskillenemyselect:${channelId}:${ownerId}`)
        .setPlaceholder("Chọn enemy sẽ nhận skill riêng...")
        .addOptions(...enemyOptions.slice(0, 25));
      await interaction.reply({
        embeds: [{ title: "📖 Add Skill — Bước 1: Chọn enemy", color: 0xf39c12 }],
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } catch (err) {
      interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

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
    // Pity dùng chung nhóm → cho chọn Tier 3 của CẢ NHÓM (6 banner Herta), không
    // chỉ banner đang mở. Nếu bó vào 1 banner thì "share pity" chỉ đúng một nửa.
    const rareOptions = pityPoolFor(bannerKey).map(item => new StringSelectMenuOptionBuilder().setLabel(item).setValue(item));
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
      // BGM có thể vừa đổi trong vòng turn vừa qua (Furioso → Saikai1, mặt nạ vỡ
      // → Saikai2, Manifest E.G.O bật/tắt). GỬI FILE ngay tại mốc kết thúc turn —
      // đây là điểm duy nhất chắc chắn chạy MỖI VÒNG cho MỌI người.
      announceBgmIfChanged(channelId, encounter, "trạng thái trong trận thay đổi").catch(() => {});
      // BUG THẬT phát hiện qua báo cáo trực tiếp (Fragaria: "encounter bị treo
      // cứng, mob không hành động tiếp") — đây là NÚT BẤM (khác lệnh text
      // `-encounter endturn` đã có hook từ trước) — thiếu trigger AI cho round
      // MỚI nếu người đi ĐẦU turnOrder mới là enemy aiControlled.
      maybeRunAiTurn(channelId).catch(() => {});
      // ❗ Fragaria (12/08): "ở cuối Turn Order trước khi kết thúc sẽ cho NGƯỜI
      // BUFF Astral Quantization (không phải người nhận buff) chỉ định nó."
      // performEndTurn đã CHỐT SẴN số dmg (trước lúc reset bộ đếm) và xếp vào
      // `pendingAstralChoice`; ở đây chỉ dựng dropdown cho đúng người buff.
      sendAstralTargetPrompts(channelId, encounter).catch(() => {});
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
    const [, channelId, pendingId, targetId, choice, counterSkillKeyOrHitIdx, dashSkillKey] = interaction.customId.split(":");
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
        // KIỂM LẠI Ở SERVER — nút đã gửi ra rồi thì vẫn bấm được kể cả khi điều
        // kiện đã đổi (message cũ, hoặc nhóm hit trước vừa tiêu mất tài nguyên).
        // Lọc lúc DỰNG nút (reactive-defense.js) là chưa đủ; đây là chốt chặn thật.
        {
          const encCounterCheck = await getEncounter(channelId);
          const meCounter = encCounterCheck?.players?.[targetId] ?? encCounterCheck?.enemies?.[targetId];
          if (meCounter) {
            const cdLeftCounter = meCounter.skillCooldowns?.[cdKeyFor(counterSkillKey)] ?? 0;
            if (cdLeftCounter > 0) {
              await interaction.reply({ content: `⚠️ **${counterSkill.name}** đang cooldown — còn ${cdLeftCounter} turn.`, flags: MessageFlags.Ephemeral }).catch(() => {});
              return;
            }
            // You're Too Slow: còn DẤU chưa đâm thì không được counter tiếp
            // (xem comment đầy đủ ở reactive-defense.js).
            if (counterSkillKey === "you're too slow" && meCounter.youreTooSlowMark?.markedTargetId) {
              await interaction.reply({ content: "⚠️ Bạn đang còn **dấu You're Too Slow** chưa dùng — mở dropdown **Moves** để tung đòn đâm trước đã.", flags: MessageFlags.Ephemeral }).catch(() => {});
              return;
            }
            const counterCost = parseSkillCost(counterSkill.cost);
            if ((meCounter.currentLight ?? 0) < (counterCost.light ?? 0)) {
              await interaction.reply({ content: `⚠️ Không đủ Light cho **${counterSkill.name}** (cần ${counterCost.light}, đang có ${meCounter.currentLight ?? 0}).`, flags: MessageFlags.Ephemeral }).catch(() => {});
              return;
            }
          }
        }
        await interaction.reply({
          embeds: [{ title: `⚔️ ${counterSkill.name} — Counter`, description: "Bấm nút dưới để mở Parry Real Time. Thắng = counter thành công, thua = không phòng thủ được (ăn dmg thường).", color: 0xf39c12 }],
          flags: MessageFlags.Ephemeral,
        });
        const sentMsg = await interaction.fetchReply();
        const linkInfo = await createRtparryToken({ userId: interaction.user.id, channelId: interaction.channelId, messageId: sentMsg.id, skill: counterSkill });
        if (!linkInfo) {
          await interaction.followUp({ content: "⚠️ Bot chưa biết URL public (thiếu RENDER_EXTERNAL_URL/PUBLIC_URL).", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
        // Gắn thêm context ĐỂ route /rtparry/:token/result biết đây LÀ 1 page
        // counter đang chờ áp dụng, không phải rtparry thường (chỉ hiển thị
        // AMAZING/GREAT không ảnh hưởng gameplay) — xem comment đầy đủ ở route đó.
        // attachCounterContext — GHI LẠI xuống Redis (không chỉ sửa object trong
        // RAM như trước) — xem comment ở rtparry.js.
        // groupIdx — BẮT BUỘC (xem comment ở nút Counter trong reactive-defense.js).
        // Thiếu nó thì express-routes.js không biết counter nhóm nào và phải
        // finalize cả pendingAction → thắng/thua gì cũng ăn sạch mọi group hit.
        // Nút cũ (message còn sót trước khi deploy) không có ô này → NaN, fallback
        // về nhóm chưa quyết định đầu tiên ở phía express-routes.
        const counterGroupIdx = parseInt(dashSkillKey, 10);
        await attachCounterContext(linkInfo.token, {
          encChannelId: channelId, pendingId, targetId, counterSkillKey,
          groupIdx: Number.isFinite(counterGroupIdx) ? counterGroupIdx : null,
        });
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
        content: "", // xoá text/mention cũ — update KHÔNG tự xoá field không truyền
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
        // ❗❗ BUG ĐÃ SỬA (Fragaria: "Các Critical hiện tại của Caduceus bao gồm cả
        // Furioso chưa cho phép người dùng sử dụng Clash").
        // GỐC 1: danh sách ứng viên chỉ có `weaponCriticalKey` — mà Caduceus khai
        // `criticalSkillKey: null` trong weapon.js (9 Critical của nó là SKILL
        // RIÊNG, chọn theo bậc/type ở panel Moves) ⇒ KHÔNG món nào lọt vào đây.
        // Bổ sung đúng bộ mà panel Moves đang bày, dùng CÙNG điều kiện gate
        // (bậc Unlock cho Furioso, đủ 9 Procuration hoặc Shin - Rien follow-up) —
        // hai nơi lệch nhau là hiện nút rồi bấm lại báo lỗi.
        const candidateNames = [clasher.weaponCriticalKey, ...(clasher.unlockedPagesSnapshot ?? [])].filter(Boolean);
        if (findWeaponAnywhere(clasher.weaponName)?.caduceus) {
          for (const tier of [1, 2, 3]) {
            for (const ty of ["blunt", "pierce", "slash"]) candidateNames.push(`caduceus crit${tier} ${ty}`);
          }
          const furiosoKeyCl = furiosoClashKeyFor(clasher);
          if (furiosoKeyCl) candidateNames.push(furiosoKeyCl);
        }
        const clashOptions = [];
        const addedClashKeys = new Set();
        for (const name of candidateNames) {
          const sk = findSkill(name);
          if (!sk || sk.promptArg) continue; // promptArg cần input đặc biệt, giống hạn chế của "-encounter clash" gốc
          // Fragaria: "Light Dash xuất hiện trong phần clashable trong khi đáng lẽ
          // nó không phải là thứ sẽ có thể clash được." Cờ `unclashable` khai ở
          // skills.js (pounce / follow-up / light dash / fleet footsteps /
          // borrowed eyes) — lọc TẠI ĐÂY và ở `pickClashSkill` của AI (enemy-ai.js).
          if (sk.unclashable) continue;
          // ❗❗ BUG ĐÃ SỬA (user: "em xài Learn again Kid trước đó rồi, sau clash
          // vẫn xài được Learn again Kid").
          // GỐC: `key` chỉ `toLowerCase()` TÊN HIỂN THỊ — "Learn again, Kid" ra
          // `"learn again, kid"` (CÓ DẤU PHẨY), trong khi CD được lưu dưới key
          // chuẩn `"learn again kid"`. Tra `skillCooldowns` TRƯỢT ⇒ page đang CD
          // vẫn lọt vào dropdown Clash, và dùng xong lại ghi CD vào ô SAI nốt.
          // `resolveSkillKey` là hàm chuẩn hoá DUY NHẤT (bỏ dấu câu, alias…) —
          // mọi nơi khác đã dùng nó, riêng chỗ này bị bỏ quên.
          const key = resolveSkillKey(name) ?? name.trim().toLowerCase();
          if (addedClashKeys.has(key)) continue; // GAP ĐÃ SỬA: tránh 2 option TRÙNG value nếu equip cùng tên vào 2 slot
          if ((clasher.skillCooldowns?.[cdKeyFor(key)] ?? 0) > 0) continue;
          const cost = parseSkillCost(sk.cost);
          if ((clasher.currentLight ?? 0) < (cost.light ?? 0)) continue;
          addedClashKeys.add(key);
          clashOptions.push({ key, name: sk.name });
        }
        if (clashOptions.length === 0) {
          const reason = candidateNames.length === 0
            ? "chưa có Page/Critical/skill nào được gán (nếu là enemy, dùng `skills:` ở `-encounter addenemy` hoặc `skills+:` qua GM Panel để gán trước)"
            : "tất cả Page/Critical hiện có đều KHÔNG đủ Light hoặc đang trong CD";
          await interaction.reply({ content: `❌ Không thể Clash — ${reason}.`, flags: MessageFlags.Ephemeral }).catch(() => {});
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
        // Khai NGOÀI khối `withLock` (gán bên trong, đọc lúc gửi tin nhắn).
        let bgmYourShield = { files: [], name: null };
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
          bgmYourShield = finalized.bgm ?? bgmYourShield;
          displayText = finalized.resultText;
        });
        await interaction.update({
          content: bgmYourShield.name
            ? `🎵 ${bgmYourShield.label ?? `BGM đổi sang **${bgmYourShield.name}**`}${bgmYourShield.files.length ? "" : " ⚠️ *(không tìm thấy file — đặt vào `assets/audio/bgm/`)*"}`
            : "", // xoá text/mention cũ — update KHÔNG tự xoá field không truyền
          embeds: [{ title: "🛡️ Your Shield — Kết quả", description: displayText, color: 0x9b59b6 }],
          components: [],
          files: bgmYourShield.files,
        }).catch(() => {});
        {
          const encAfterYourShield = await getEncounter(channelId);
          if (encAfterYourShield && !(p.attackerType === "enemy" && encAfterYourShield.enemies[p.attackerId]?.aiControlled)) {
            announceCurrentTurn(channelId, encAfterYourShield, true).catch(() => {});
          }
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
      // Khai NGOÀI khối `withLock` — gán bên trong, ĐỌC ở phần gửi tin nhắn phía
      // sau (đúng bài học "biến khai trong khối lồng thì không dùng lại được").
      let bgmReactive = { files: [], name: null };
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
        let target = targetResolved.combatant; // `let` — nhánh Zwei "block giùm" đổi sang người đỡ
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
        // "Chain-Dashes" (Giày Wan MK3) — cờ đánh dấu bonus VỪA được tiêu thụ ở
        // lần né NÀY (chỉ có ý nghĩa khi choice==="evade") — khai báo ở scope
        // NGOÀI if/else-if (giống choiceNote) vì cần đọc lại SAU t.perHitChoices[groupIdx]
        // = choiceNote (nằm ngoài khối if/else-if) để gộp nhóm hit kế tiếp.
        let chainDashesBonusConsumedThisTurn = false;
        // ── ZWEI ASSOCIATION: BLOCK GIÙM ĐỒNG MINH ──────────────────────────
        // Người mặc Zwei bấm nút này ⇒ CHUYỂN mục tiêu của nhóm hit sang CHÍNH HỌ
        // rồi xử lý như một cú Guard bình thường của họ.
        // Luật: chỉ mỗi BLOCK · mỗi turn chỉ đỡ cho ĐÚNG 1 người.
        if (choice === "zweiblock") {
          const zweiId = interaction.user.id;
          const zwei = encounter.players?.[zweiId];
          if (!zwei?.hasZweiAssociation) throw new Error("Chỉ người mặc **Zwei Association** mới đỡ đòn giùm được.");
          if (zweiId === t.targetId) throw new Error("Đây là đòn nhắm vào chính bạn — dùng nút Guard thường.");
          if ((zwei.currentHp ?? 0) <= 0 || zwei.staggered) throw new Error("Bạn không ở trạng thái đỡ đòn được.");
          if (zwei.zweiProtectingId && zwei.zweiProtectingId !== t.targetId) {
            throw new Error(`Turn này bạn đã nhận đỡ cho **${encounter.players?.[zwei.zweiProtectingId]?.name ?? "người khác"}** — mỗi turn chỉ đỡ giùm cho **1 người**.`);
          }
          if (thisGroupBypass.blockGuard) throw new Error("Nhóm hit này có tag Unblockable — không đỡ giùm được.");
          const guardCost = opts.guard.cost ?? 0;
          if ((zwei.currentStamina ?? 0) < guardCost) {
            throw new Error(`Không đủ Stamina để đỡ giùm (cần ${guardCost}, bạn có ${Math.round(zwei.currentStamina ?? 0)}).`);
          }
          zwei.zweiProtectingId = t.targetId;
          const protectedName = target.name ?? "đồng minh";
          // CHUYỂN mục tiêu: từ đây nhóm hit này đánh vào người mặc Zwei.
          t.targetId = zweiId;
          target = zwei;
          choice = "guard"; // xử lý tiếp y hệt Guard thường của người đỡ
          choiceNote = `🛡️ **Zwei Association** — ${zwei.name ?? "Người đỡ"} chịu đòn thay **${protectedName}**`;
        }
        if (choice === "guard") {
          if (!opts.guard.available) {
            if (thisGroupBypass.blockGuard) throw new Error("Nhóm hit này có tag Unblockable — không thể Guard.");
            throw new Error(`Không đủ Stamina để Guard nhóm này (cần ${opts.guard.cost}, hiện có ${target.currentStamina}).`);
          }
          target.currentStamina -= opts.guard.cost;
          // GAP MỚI (audit accessory.js) — "Resourceful" (Giày Wan MK3): "Các
          // hành động phòng thủ được refund 1/4 Stamina" — hoàn lại NGAY sau
          // khi trừ, áp cho MỌI hành động phòng thủ có tốn Stamina thật (Guard
          // ở đây, Evade ở nhánh dưới — Parry vốn đã 0 Sta nên không cần).
          if (opts.guard.cost > 0 && (target.equippedAccessoriesSnapshot ?? []).map(a => a.toLowerCase()).includes("giày wan mk3")) {
            target.currentStamina = Math.min(target.maxStamina, target.currentStamina + opts.guard.cost / 4);
          }
          // GAP ĐÃ SỬA — "Overflowing Guard" (Envy 45): luật là "≥7 Charge → Guard
          // giảm 1 nửa Stamina, ĐỒNG THỜI giảm 1 Charge bản thân". Bản fix trước
          // của tôi chỉ port phần GIẢM GIÁ vào computeDefenseOptions mà quên phần
          // TIÊU CHARGE — thành ra perk mạnh hơn luật (giảm giá vĩnh viễn, không
          // mất gì). Trừ ở ĐÂY vì đây mới là nơi commit lựa chọn thật.
          if (opts.overflowingGuardApplies) target.charge = Math.max(0, (target.charge ?? 0) - 1);
          target.guardCharges = (target.guardCharges ?? 0) + opts.guard.chargesNeededNet;
          target.guardHitSelections = target.guardHitSelections ?? [];
          target.guardHitSelections.push(...realHitIndices);
          if (target.hasIronHorus) target.ironHorusGuardActiveThisTurn = true;
          if (targetResolved.type === "player") target.prescriptBlocked = true;
          if (target.hasZweiAssociation) target.zweiAssociationPendingTremor = true;
          choiceNote = `🛡️ Guard (-${opts.guard.cost} Sta)${(opts.perkNotes ?? []).length > 0 ? ` [${opts.perkNotes.join(", ")}]` : ""}`;
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
            applyHpLoss(tsAtk, tsResult.totalDmg); // đếm vào hpLostThisTurn (Hana)
            tsAtk.currentStamina = Math.max(0, tsAtk.currentStamina - tsResult.totalTremorStaminaLoss);
            tsAtk.tremor = tsResult.finalTremor;
            tsAtk.tremorReverb = Math.min(TREMOR_VARIANT_MAX, (tsAtk.tremorReverb ?? 0) + 1);
            choiceNote += ` + [Tactical Suppression: húc ${attacker.label}, Tremor Burst -${tsResult.totalTremorStaminaLoss} Sta/-${tsResult.totalDmg.toFixed(3)} HP, +1 Tremor Reverb]`;
          }
        } else if (choice === "evade") {
          if (!opts.evade.available) throw new Error(opts.evade.blockedReason ? `Evade bị khoá: ${opts.evade.blockedReason}.` : `Không đủ Stamina để Evade nhóm này (cần ${opts.evade.cost}, hiện có ${target.currentStamina}).`);
          target.currentStamina -= opts.evade.cost;
          // "Resourceful" (Giày Wan MK3) — xem comment đầy đủ ở nhánh Guard.
          if (opts.evade.cost > 0 && (target.equippedAccessoriesSnapshot ?? []).map(a => a.toLowerCase()).includes("giày wan mk3")) {
            target.currentStamina = Math.min(target.maxStamina, target.currentStamina + opts.evade.cost / 4);
          }
          // GAP MỚI (audit accessory.js) — "Chain-Dashes" (Giày Wan MK3): xử lý
          // ĐẦY ĐỦ ở dưới (sau khi commit choice nhóm này) — gộp LUÔN nhóm hit
          // KẾ TIẾP vào cùng lần né này khi có bonus (xem sau t.perHitChoices[groupIdx]
          // = choiceNote bên dưới) — KHÔNG sửa chargesNeeded ở đây vì mỗi nhóm
          // vốn đã được chia vừa đúng 1 charge từ đầu (nhân đôi hitsPerCharge ở
          // computeDefenseOptions không có tác dụng gì, đã thử và xác nhận qua
          // test thật nên bỏ đi).
          target.evadeCharges = (target.evadeCharges ?? 0) + opts.evade.chargesNeededNet;
          target.evadeHitSelections = target.evadeHitSelections ?? [];
          target.evadeHitSelections.push(...realHitIndices);
          // GAP ĐÃ SỬA — "Fleeting Steps" (Sloth 10): bộ đếm né PHẢI tăng ở đây.
          // computeDefenseOptions chỉ ĐỌC (nó bị gọi nhiều lần chỉ để dựng UI —
          // tăng ở đó sẽ nhảy số loạn mỗi lần refresh prompt). Bản fix trước của
          // tôi ghi chú "bộ đếm tăng ở handler" nhưng KHÔNG hề thêm dòng nào —
          // hệ quả: bộ đếm đứng yên ở 0, `(0+1)%4` không bao giờ bằng 0, perk
          // KHÔNG BAO GIỜ kích hoạt dù đã port công thức.
          if (hasPerk(target, "Fleeting Steps")) {
            target.evadeCountForFleetingSteps = (target.evadeCountForFleetingSteps ?? 0) + 1;
          }
          if (opts.evade.cost === 0 && (target.lightDashFreeEvadeCharges ?? 0) > 0) target.lightDashFreeEvadeCharges -= 1;
          if (targetResolved.type === "player") target.prescriptEvaded = true;
          if (target.hasZweiAssociation) target.zweiAssociationPendingTremor = true;
          // GAP MỚI (audit accessory.js) — "Shimmering" (Composition Tool):
          // "Cho 1 Light khi né hoặc parry thành công" — evade ĐÃ resolve
          // thành công tới đây (không throw ở check available phía trên) nên
          // tính là "thành công", cộng ngay 1 Light.
          if ((target.equippedAccessoriesSnapshot ?? []).map(a => a.toLowerCase()).includes("composition tool")) {
            target.currentLight = Math.min(target.maxLight, (target.currentLight ?? 0) + 1);
          }
          // "Chain-Dashes" (Giày Wan MK3) — tiêu thụ cờ bonus (nếu vừa dùng
          // xong) rồi MỚI tăng evadeCount + set cờ mới cho lần né KẾ TIẾP (thứ
          // tự: tiêu trước, tăng/set sau — tránh 1 lần né vừa tiêu vừa tự cấp
          // lại bonus cho chính nó). Việc GỘP nhóm hit kế tiếp thật sự (nếu cờ
          // đang tiêu thụ ở lần né NÀY) nằm ở đoạn code SAU t.perHitChoices[groupIdx]
          // = choiceNote bên dưới (cần biết groupIdx/groupCount/hitsPerCharge đã
          // tính sẵn ở phạm vi ngoài, và cần chắc chắn choice CHÍNH THỨC đã ghi
          // nhận trước khi gộp thêm nhóm sau).
          let chainDashesNote = "";
          if (target.chainDashesBonusHitPending) {
            target.chainDashesBonusHitPending = false;
            chainDashesBonusConsumedThisTurn = true;
            chainDashesNote = " ⚡[Chain-Dashes: gộp luôn nhóm hit tiếp theo]";
          }
          if ((target.equippedAccessoriesSnapshot ?? []).map(a => a.toLowerCase()).includes("giày wan mk3")) {
            target.evadeCount = (target.evadeCount ?? 0) + 1;
            if (target.evadeCount % 2 === 0) {
              target.chainDashesBonusHitPending = true;
              chainDashesNote += " 💨[Chain-Dashes: lần né tiếp theo sẽ gộp nhóm kế]";
            }
          }
          choiceNote = `💨 Evade (-${opts.evade.cost} Sta)${opts.evade.cost === 0 && (target.lightDashFreeEvadeCharges ?? 0) >= 0 && !opts.fleetingStepsFree ? " [Light Dash miễn phí]" : ""}${(opts.perkNotes ?? []).length > 0 ? ` [${opts.perkNotes.join(", ")}]` : ""}${chainDashesNote}`;
        } else if (choice === "dash") {
          // GAP ĐÃ SỬA (Fragaria: "light dash và fleetfoot steps vẫn chưa thấy
          // nút bấm ở reactive defense"). Về mặt cơ chế đây là 1 lần NÉ MIỄN PHÍ
          // (0 Stamina, 0 charge phải mua) kèm hiệu ứng riêng của page:
          //   - Light Dash      : +2 Light
          //   - Fleet Footsteps : +2 Haste (page này CÓ dice dmg riêng khi dùng
          //     chủ động, nhưng ở luồng PHẢN ỨNG chỉ dùng phần né — không gây
          //     dmg ngược, tránh chế thêm luật không có trong mô tả gốc)
          // Trừ Light + set cooldown THẬT ở đây (khác Guard/Evade thường vốn
          // không tốn Light/không có CD).
          const dashSkill = findSkill(dashSkillKey ?? "");
          if (!dashSkill) throw new Error("Không tìm thấy page né này.");
          if (thisGroupBypass.blockEvade) throw new Error(`Nhóm hit này có tag Undodgeable — ${dashSkill.name} không né được.`);
          const dashKeyNorm = (dashSkillKey ?? "").trim().toLowerCase();
          const ownedDash = new Set([
            ...(target.unlockedPagesSnapshot ?? []),
            ...(target.unlockedEgoPagesSnapshot ?? []),
          ].filter(Boolean).map(n => n.trim().toLowerCase()));
          if (!ownedDash.has(dashKeyNorm)) throw new Error(`Bạn chưa mở khoá page "${dashSkill.name}".`);
          if ((target.skillCooldowns?.[cdKeyFor(dashKeyNorm)] ?? 0) > 0) {
            throw new Error(`"${dashSkill.name}" đang cooldown — còn ${target.skillCooldowns[cdKeyFor(dashKeyNorm)]} turn.`);
          }
          const dashCost = parseSkillCost(dashSkill.cost);
          if ((target.currentLight ?? 0) < (dashCost.light ?? 0)) {
            throw new Error(`Không đủ Light để dùng "${dashSkill.name}" (cần ${dashCost.light}, hiện có ${target.currentLight ?? 0}).`);
          }
          target.currentLight = (target.currentLight ?? 0) - (dashCost.light ?? 0);
          const dashCd = parseSkillCooldownTurns(dashSkill.cd);
          if (dashCd > 0) {
            target.skillCooldowns = target.skillCooldowns ?? {};
            // ❗ BUG ĐÃ SỬA (Fragaria/user: "light dash cd nhanh hơn bình thường").
            // Mọi đường khác đặt `cooldownTurns + 1` (resolve-pending-action:1797,
            // clash:1496) — cái `+1` bù cho cú đếm ngược chạy NGAY cuối turn này.
            // Riêng dash đặt trần `dashCd` ⇒ mất đúng 1 turn CD so với mọi page khác.
            target.skillCooldowns[cdKeyFor(dashKeyNorm)] = dashCd + 1;
          }
          // Né THẬT cho nhóm hit này — cùng field với nhánh "evade" (evadeCharges
          // + evadeHitSelections) để resolveOnePendingAction xử lý y hệt, KHÔNG
          // trừ Stamina và KHÔNG tiêu lightDashFreeEvadeCharges (charge đó dành
          // cho lần né THƯỜNG sau khi dùng page chủ động — cơ chế riêng, không
          // gộp vào đây kẻo tiêu 2 lần cho 1 lần dùng).
          target.evadeCharges = (target.evadeCharges ?? 0) + 1;
          target.evadeHitSelections = target.evadeHitSelections ?? [];
          target.evadeHitSelections.push(...realHitIndices);
          if (targetResolved.type === "player") target.prescriptEvaded = true;
          if (target.hasZweiAssociation) target.zweiAssociationPendingTremor = true;
          let dashEffectNote = "";
          if (dashKeyNorm === "light dash") {
            const beforeL = target.currentLight ?? 0;
            target.currentLight = Math.min(target.maxLight ?? beforeL, beforeL + 2);
            dashEffectNote = ` [+${target.currentLight - beforeL} Light]`;
          } else if (dashKeyNorm === "fleet footsteps") {
            target.haste = (target.haste ?? 0) + 2;
            dashEffectNote = ` [+2 Haste → ${target.haste}]`;
          }
          choiceNote = `💨 ${dashSkill.name} — né miễn phí (0 Sta${dashCost.light ? `, -${dashCost.light} Light` : ""})${dashEffectNote}`;
        } else if (choice === "parry") {
          // ❗ Fragaria: "thay vì giải quyết per hit thì bị STACK PARRY ĐƯỢC MÃI MÃI
          // khi 0 Stamina — dùng Wound-Casing Mask thì miễn nhiễm Stagger thành ra
          // có thể parry mãi."
          // Parry tốn 0 Stamina; rủi ro DUY NHẤT của nó là thua → −40 Sta → Stagger.
          // Ai miễn nhiễm Stagger thì mất sạch rủi ro ⇒ spam vô hạn.
          // Gate ở ĐÂY (đường NÚT BẤM reactive) — lượt trước tôi chỉ gate ở
          // `performParry` (đường lệnh text) nên nút bấm vẫn spam được.
          // ❗ SỬA LẠI (Fragaria: "gate parry VẪN SAI — Eye Gouger đánh 1 group
          // 16 đòn lúc tôi còn 2 Stamina, tôi cứ bấm parry mãi vì Wound-Casing
          // Mask không cho stagger, tới lúc tổng kết thì 1 lượt parry 16 group").
          //
          // GỐC của lần sửa hỏng trước: Parry tốn **0 Stamina lúc CHỌN**; khoản
          // −40 khi THUA chỉ trừ lúc RESOLVE (cuối đòn). Nên trong suốt lúc chọn,
          // `currentStamina` vẫn nguyên 2 ⇒ gate `<= 0` không bao giờ chạm.
          //
          // Nay tính **CHI PHÍ ĐÃ ĐẶT CỌC**: mỗi nhóm đã chọn Parry là một khoản
          // −40 tiềm tàng. Chỉ cho chọn thêm khi Stamina còn đủ cho TẤT CẢ các
          // lượt parry đã đặt + lượt này.
          // ⚠️ ĐÍNH CHÍNH (Fragaria): gate "đặt cọc" này **CHỈ áp cho người MIỄN
          // NHIỄM Stagger** (Wound-Casing Mask). Người BÌNH THƯỜNG không cần gate:
          // thua parry là tụt Stamina → Stagger NGAY GIỮA CHUỖI, và Stagger tự
          // chặn các nhóm sau — đó mới là cơ chế hãm tự nhiên của game.
          // Gate cứng cho cả hai sẽ tước mất lựa chọn hợp lệ của người chơi thường.
          const PARRY_FAIL_STA = (hasPerk(target, "Mastered Breaths") ? 30 : 40)
            * ((target.injuries ?? []).includes("Gãy tay") ? 2 : 1);
          const staggerImmune = !!target.hasWoundCasingMask;
          const parriesChosen = (t.perHitChoices ?? []).filter(c => typeof c === "string" && /parry/i.test(c)).length;
          const staAfterAllParries = (target.currentStamina ?? 0) - PARRY_FAIL_STA * (parriesChosen + 1);
          if ((target.currentStamina ?? 0) <= 0 || (staggerImmune && staAfterAllParries <= -PARRY_FAIL_STA)) {
            return interaction.reply({
              content: `❌ Không đủ Stamina để Parry thêm — bạn còn **${Math.round(target.currentStamina ?? 0)}** Sta`
                + (parriesChosen > 0 ? ` và đã đặt **${parriesChosen}** lượt Parry (mỗi lượt thua tốn ${PARRY_FAIL_STA} Sta)` : "")
                + `.\n> Parry không tốn Stamina lúc chọn, nhưng THUA thì mất ${PARRY_FAIL_STA} Sta.`
                + (staggerImmune ? `\n> Bạn đang **miễn nhiễm Stagger** nên không thể đặt cược nhiều hơn số Stamina đang có.` : ""),
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
          }
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
          // "Shimmering" (Composition Tool) — xem comment đầy đủ ở nhánh evade.
          if ((target.equippedAccessoriesSnapshot ?? []).map(a => a.toLowerCase()).includes("composition tool")) {
            target.currentLight = Math.min(target.maxLight, (target.currentLight ?? 0) + 1);
          }
          const dullahanDmg = applyDullahanParryCounter(target, attacker.combatant);
          if (dullahanDmg !== null) target.dullahanParriedThisTurn = true;
          choiceNote = `🗡️ Parry (${opts.chargesNeeded} roll, 0 Sta)${dullahanDmg !== null ? ` + [Dullahan: đánh thường trả đũa -${dullahanDmg.toFixed(3)} HP]` : ""}`;
        } else {
          choiceNote = "❌ Không phòng thủ";
        }
        t.perHitChoices[groupIdx] = choiceNote;
        // "Chain-Dashes" (Giày Wan MK3) — GAP MỚI (audit accessory.js): nếu
        // bonus VỪA được tiêu thụ ở lần né NÀY, TỰ ĐỘNG gộp luôn nhóm hit KẾ
        // TIẾP (nếu còn) vào cùng kết quả evade — không cần prompt riêng cho
        // nhóm đó, không tốn thêm Stamina (bonus miễn phí, đã trừ Sta đúng 1
        // lần cho nhóm HIỆN TẠI ở trên rồi). Đánh dấu perHitChoices[groupIdx+1]
        // (khác null) để sendReactiveDefensePrompt (dùng
        // t.perHitChoices.findIndex(c => c === null)) TỰ BỎ QUA nhóm này khi
        // tìm nhóm kế tiếp cần hỏi — không cần sửa gì ở reactive-defense.js.
        if (chainDashesBonusConsumedThisTurn && groupIdx + 1 < groupCount && t.perHitChoices[groupIdx + 1] === null) {
          const nextGroupHitsInGroup = Math.min(hitsPerCharge, hitCount - (groupIdx + 1) * hitsPerCharge);
          const nextGroupHitIndices = [];
          for (let i = 0; i < nextGroupHitsInGroup; i++) nextGroupHitIndices.push((groupIdx + 1) * hitsPerCharge + i + 1);
          target.evadeHitSelections = target.evadeHitSelections ?? [];
          target.evadeHitSelections.push(...nextGroupHitIndices);
          t.perHitChoices[groupIdx + 1] = "💨 Evade (gộp tự động từ Chain-Dashes, 0 Sta)";
        }
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
        // BGM (Furioso → Saikai1/2) — đòn resolve TẠI ĐÂY khi người bị đánh tự
        // bấm phòng thủ, nên đây cũng phải đính file (cùng cơ chế Red Mist).
        bgmReactive = finalized.bgm ?? bgmReactive;
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
        content: bgmReactive.name
          ? `🎵 ${bgmReactive.label ?? `BGM đổi sang **${bgmReactive.name}**`}${bgmReactive.files.length ? "" : " ⚠️ *(không tìm thấy file — đặt vào `assets/audio/bgm/`)*"}`
          : "",
        embeds: stillWaitingFor
          ? [{ title: "⏳ Đã ghi nhận — đang chờ người khác", description: resultText, color: 0xf39c12 }]
          : [{ title: "⚔️ Đã xử lý", description: resultText, color: 0x2ecc71 }, boardPayloadForUpdate.embed],
        components: boardPayloadForUpdate ? boardPayloadForUpdate.components : [],
        files: bgmReactive.files,
      }).catch(() => {});
      // GAP ĐÃ SỬA (xác nhận trực tiếp qua ảnh chụp: "Dropdown vẫn còn bị che
      // rất nặng bởi các message sau khi kẻ địch đã thực thi xong reactive
      // defense") — nhánh Guard/Evade/Parry/Không phòng thủ (PHỔ BIẾN NHẤT)
      // TRƯỚC ĐÂY HOÀN TOÀN THIẾU resend này (chỉ nhánh Clash bên dưới có) —
      // gửi lại dropdown turn NGAY sau khi phản hồi xong, để nó luôn ở CUỐI
      // kênh (dễ thấy nhất), không bị "Đã xử lý"/board embed mới hơn che khuất.
      //
      // BUG THẬT MỚI phát hiện (Fragaria báo trực tiếp kèm ảnh chụp: "liên tiếp
      // hiện 2 dropdown") — nếu attacker của pendingAction này là enemy
      // aiControlled, hệ thống AI (enemy-ai.js's maybeRunAiTurn, trigger từ hook
      // TRONG chính finalizeReactiveChoice ở trên) ĐÃ TỰ announce đúng turn mới
      // rồi (qua passMobTurn) — resend THỦ CÔNG ở đây thành TRÙNG LẶP (2 dropdown
      // giống hệt nhau cho CÙNG 1 turn). Bỏ qua bước này cho đúng trường hợp đó —
      // giữ nguyên resend cho trường hợp GỐC (attacker là player, hoặc enemy
      // KHÔNG aiControlled — GM điều khiển thủ công, turn KHÔNG tự advance, vẫn
      // cần resend để tránh bị che như bug gốc).
      if (!stillWaitingFor && !(p.attackerType === "enemy" && encounter.enemies[p.attackerId]?.aiControlled)) {
        const encAfterMainReactive = await getEncounter(channelId);
        if (encAfterMainReactive) announceCurrentTurn(channelId, encAfterMainReactive, true).catch(() => {});
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


// ─── SHOP — dropdown chọn món (StringSelectMenu) ──────────────────────────
// BUG ĐÃ SỬA (Fragaria báo trực tiếp kèm ảnh chụp: "bug shop không mua đồ được,
// bị didn't respond in time").
//
// NGUYÊN NHÂN GỐC: nhánh `shopbuy:` TRƯỚC ĐÂY nằm CHUNG khối với shopqty/
// shopreset/shopback ở listener phía trên — mà listener đó mở đầu bằng
// `if (!interaction.isButton()) return;`. shopqty/shopreset/shopback ĐÚNG là
// Button nên chạy bình thường; nhưng `shopbuy:` là **StringSelectMenu** (xem
// buildShopComponents trong shop.js) → `isButton()` trả false → listener return
// NGAY, KHÔNG handler nào đụng tới interaction đó → Discord chờ 3 giây không
// thấy ai ack → hiện "didn't respond in time". Đây không phải chậm I/O (nhánh
// này còn không đọc Redis) mà là interaction bị ROUTE SAI LOẠI hoàn toàn.
//
// GOTCHA CHUNG (đã ghi vào HANDOFF): customId của dropdown KHÔNG được đặt trong
// listener isButton, và ngược lại. Thêm 1 customId mới thì phải kiểm nó thuộc
// loại component nào TRƯỚC khi chọn listener.
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("shopbuy:")) return;
  const ownerId = interaction.customId.split(":")[1];
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Đây là cửa hàng của người khác — gõ `-shop` để mở của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  try {
    // Bước 1 → 2: chọn món xong thì hỏi số lượng. Không có I/O nên update thẳng
    // được (vẫn thừa sức trong 3 giây), không cần defer.
    const itemKey = (interaction.values?.[0] ?? "").replace(/^item:/, "");
    const qtyComponents = buildQuantityComponents(ownerId, itemKey);
    if (!qtyComponents) {
      // buildQuantityComponents trả null khi itemKey không có trong SHOP_CATALOG
      // — PHẢI ack bằng reply, nếu để throw thì lại rơi vào đúng cảnh "không ai
      // trả lời" như bug gốc.
      return interaction.reply({ content: "❌ Món này không có trong cửa hàng.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    await interaction.update({ components: qtyComponents }).catch(() => {});
  } catch (err) {
    log("error", "shopbuy", interaction.user.id, err.stack ?? err.message);
    await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
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
  // Khai NGOÀI khối `withLock` (gán bên trong, đọc lúc gửi tin nhắn).
  let bgmClash = { files: [], name: null };
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

      // ❗ KIỂM LẠI ĐIỀU KIỆN NGAY LÚC BẤM — dropdown có thể đã cũ (gửi từ lúc
      // đòn địch bay tới, người chơi xài Furioso xong mới bấm). Xem giải thích
      // đầy đủ ở `furiosoClashKeyFor`.
      if (chosenSkill.caduceusFurioso) {
        const stillEligible = furiosoClashKeyFor(clasher);
        if (stillEligible !== chosenKey) {
          const procNow = (clasher.procurationHermes ?? []).length;
          displayText = `❌ Không đủ điều kiện Clash bằng **${chosenSkill.name}** — cần **9** <:Procuration:1528452494945157281>Procuration [Hermes] (đang có **${procNow}**). Dùng Furioso xong là Procuration về 0.`;
          return;
        }
      }
      // Skill khai `unclashable` (Light Dash, Borrowed Eyes, đòn Nothing There…)
      // — chặn cả khi lọt qua menu cũ.
      if (chosenSkill.unclashable) { displayText = `❌ **${chosenSkill.name}** không dùng để Clash được.`; return; }

      const myRoll = buildSkillRollResult({ skill: chosenSkill });
      // GỐC 2 của bug Caduceus: `firstDiceValue` chỉ có khi skill gọi `r()` —
      // họ Caduceus tự bốc mặt bằng Math.random() nên LUÔN null ⇒ bị chặn ở
      // đúng dòng này. `clashDiceOf` đọc dice TỪ DÒNG DICE ĐÃ ROLL (index.js),
      // và tự áp luật "Furioso clash bằng TỔNG 9 Dice" qua `clashUsesTotalDice`.
      const myClashDice = clashDiceOf(chosenSkill, myRoll);
      if (myRoll.error || myClashDice === null) { displayText = `❌ ${myRoll.error ?? "Skill này không có Dice để Clash."}`; return; }

      // Dice Clash của attacker: LẤY TỪ p.dmgStr đã roll sẵn lúc declare (KHÔNG
      // roll lại — dùng đúng giá trị người chơi đã thấy). `attackerClashDiceOf`
      // áp cùng luật cho chiều ngược lại: đòn Furioso bị clash phải đem TỔNG 9
      // Dice ra so, không phải mỗi mặt đầu.
      const attackerFirstDiceValue = attackerClashDiceOf(p, attackerResolved.combatant);
      if (attackerFirstDiceValue === null) { displayText = "❌ Đòn tấn công này không có Dice hợp lệ để Clash."; return; }

      // "Clasher" (người BẤM và THỰC HIỆN Clash) roll/tiêu resource/nhận
      // Sanity+Coin — CÓ THỂ khác "target" (người bị tấn công, chỉ được ngắt
      // dmg nếu clasher thắng) — xác nhận trực tiếp: "A Clash THAY cho B".
      const myPenalty = getParryClashPenalty(clasher);
      const oppPenalty = getParryClashPenalty(attackerResolved.combatant);
      const myEffectiveDice = myClashDice - myPenalty + (clasher.clashAttackBoost ?? 0) + (clasher.clashPowerUp ?? 0);
      const oppEffectiveDice = attackerFirstDiceValue - oppPenalty + (attackerResolved.combatant.clashAttackBoost ?? 0) + (attackerResolved.combatant.clashPowerUp ?? 0);

      // Tiêu Light/CD cho skill VỪA DÙNG để Clash (của CLASHER, không phải
      // target), bất kể thắng thua (đã dùng là dùng, giống "-encounter clash"
      // gốc không hoàn resource khi thua).
      const cost = parseSkillCost(chosenSkill.cost);
      clasher.currentLight = Math.max(0, (clasher.currentLight ?? 0) - (cost.light ?? 0));
      const cdTurns = parseSkillCooldownTurns(chosenSkill.cd);
      clasher.skillCooldowns = clasher.skillCooldowns ?? {};
      clasher.skillCooldowns[cdKeyFor(chosenKey)] = cdTurns + 1;

      // ❗ SẮC LỆNH #4 ("Clash với 1 skill của kẻ địch trong turn") — cờ
      // `prescriptClashed` TRƯỚC ĐÂY KHÔNG AI SET, nên sắc lệnh này KHÔNG BAO GIỜ
      // hoàn thành được: người chơi clash đúng vẫn bị tính trượt + ăn 5 Karmic.
      // Đánh dấu ngay tại nơi clash THỰC SỰ diễn ra (thắng hay thua đều tính —
      // luật chỉ đòi "clash", không đòi "thắng clash").
      clasher.prescriptClashed = true;
      // ❗ CHI PHÍ của Furioso khi đem đi Clash. Furioso khai `cost: "—"` và
      // `cd: "—"` nên 2 dòng trừ Light/CD ở trên KHÔNG lấy gì cả — không có khối
      // này thì clash bằng Furioso là MIỄN PHÍ và lặp vô hạn (9 Procuration không
      // bị tiêu). Dùng CHUNG `applyFuriosoUseCosts` với đường tấn công thật
      // (resolve-pending-action.js) để 2 đường không bao giờ lệch luật.
      let furiosoClashNote = "";
      if (chosenSkill.caduceusFurioso) {
        furiosoClashNote = applyFuriosoUseCosts(clasher, chosenSkill).join("");
      }
      const clasherLabel = clasherId === targetId ? "Bạn" : clasherResolved.label;
      let choiceNote;
      let choiceNote2Unbreakable = "";
      if (myEffectiveDice > oppEffectiveDice) {
        // THẮNG Clash — HUỶ TOÀN BỘ đòn nhắm vào TARGET (không phải clasher —
        // dù clasher là người thắng, người được "cứu" khỏi dmg vẫn là target
        // gốc của đòn tấn công) — văn bản gốc: "người bị clash thua sẽ bị hủy
        // toàn bộ dice của skill/page". Tái dùng evadeCharges (perHitMult=0).
        const hitCount = Math.max(1, p.targets.find(tg => tg.targetId === targetId)?.preview?.dmgValues?.length ?? 1);
        // [Unbreakable Dice] (Furioso rework — Fragaria xác nhận trực tiếp: "khi
        // thua clash sẽ VẪN TIẾN HÀNH sử dụng thay vì bị huỷ, với 50% sát thương
        // gốc"). Đòn có tag này KHÔNG bị huỷ khi thua clash — chỉ giảm nửa dmg.
        // Nên KHÔNG cộng evadeCharges (đó là cơ chế "né sạch"); thay vào đó đặt
        // cờ để resolve-pending-action.js nhân 0.5 vào dmg cuối.
        // Signature ĐÚNG: (skillRollEmbedDescription, tags, totalHits) — xem cách
        // gọi ở nhánh reactive defense phía trên, KHÔNG đoán thêm tham số.
        const attackBypassForClash = (parsePerHitBypass(p.skillRollEmbed?.description, p.tags, hitCount) ?? [])[0] ?? {};
        if (attackBypassForClash.unbreakableDice) {
          p.unbreakableDiceHalved = true;
          choiceNote2Unbreakable = ` ⚠️ **Unbreakable Dice** — đòn KHÔNG bị huỷ, chỉ còn **50% dmg gốc**.`;
        } else {
          target.evadeCharges = (target.evadeCharges ?? 0) + hitCount;
        }
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
        // Task yêu cầu trực tiếp: "chuyển hết qua encclashselect rồi xóa text đi"
        // — port 3 perk từ "-encounter clash" (lệnh text CŨ, đã xoá) sang đây,
        // áp dụng NGUYÊN VẸN cho CLASHER khi thắng (không đổi logic gốc).
        // Voracity (Desire, [30 Points]): thắng Clash +2 Light, chỉ 1 lần/turn.
        if (hasPerk(clasher, "Voracity") && !clasher.voracityUsedThisTurn) {
          clasher.currentLight = Math.min(clasher.maxLight, clasher.currentLight + 2);
          clasher.voracityUsedThisTurn = true;
          choiceNote += ` ✨+2 Light (Voracity) cho ${clasherLabel}.`;
        }
        // Pressure Point (Pride, [15 Points]): thắng Clash +5 Poise.
        if (hasPerk(clasher, "Pressure Point")) {
          clasher.poise = Math.min(99, (clasher.poise ?? 0) + 5);
          choiceNote += ` 💪+5 Poise (Pressure Point) cho ${clasherLabel}.`;
        }
        // Thorns (Gluttony, [30 Points]): người THẮNG có Thorns → áp Rupture LÊN
        // người THUA (attackerResolved — kẻ tấn công ban đầu, đã thua Clash).
        if (hasPerk(clasher, "Thorns")) {
          const thornsRupture = clasher.hasSevenAssociation ? Math.round(7 * 1.5) : 7;
          attackerResolved.combatant.rupture = Math.min(99, (attackerResolved.combatant.rupture ?? 0) + thornsRupture);
          choiceNote += ` 🌵+${thornsRupture} Rupture (Thorns) lên ${attackerResolved.label}.`;
        }
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
          // "You're Too Slow" thắng Clash — cùng luồng MỚI với counter qua rtparry
          // (đánh dấu → option ở Moves → đâm → mới vào CD). Xem express-routes.js.
          if (chosenKey === "you're too slow") {
            delete clasher.skillCooldowns?.[cdKeyFor(chosenKey)];
            clasher.youreTooSlowMark = { markedTargetId: p.attackerId, markedLabel: attackerResolved.label };
            choiceNote += ` ⚡ **You're Too Slow** đánh dấu ${attackerResolved.label} — mở **Moves** để tung đòn đâm (CD chỉ bắt đầu sau khi đâm).`;
          } else if (!clashCounterEffect.noDirectDamage) {
            const built = autoBuildDmgStrFromSkillRoll(chosenSkill);
            if (built.dmgStr) {
              let counterDmgStr = built.dmgStr;
              if (clashCounterEffect.customHitMultiplier) {
                counterDmgStr = Array(clashCounterEffect.customHitMultiplier).fill(built.dmgStr).join(" + ");
              }
              const counterResStr = combatantResStr(attackerResolved.combatant);
              const counterPreview = calcMathCore({ dmgStr: counterDmgStr, resStr: counterResStr, poiseInit: clasher.poise, chargeInit: clasher.charge });
              applyHpLoss(attackerResolved.combatant, counterPreview.totalDmg);
              if (clashCounterEffect.smokePerHit) {
                const hits = clashCounterEffect.customHitMultiplier ?? 1;
                attackerResolved.combatant.smoke = (attackerResolved.combatant.smoke ?? 0) + clashCounterEffect.smokePerHit * hits;
              }
              if (clashCounterEffect.paralyzeAfter) {
                attackerResolved.combatant.paralyze = (attackerResolved.combatant.paralyze ?? 0) + clashCounterEffect.paralyzeAfter;
              }
              choiceNote += ` Đồng thời phản công gây ${attackerResolved.label} -${counterPreview.totalDmg.toFixed(3)} HP (hiệu ứng page-counter).`;
            }
          } else {
            choiceNote += ` (Page-counter — ngắt đòn, không tự gây dmg riêng.)`;
          }
        } else {
          // GAP ĐÃ SỬA (Fragaria: "sau khi clash thắng cũng không tung đòn vào
          // người thua clash nữa. Khi thắng clash xong vẫn sẽ tiếp tục thực thi
          // đòn đã clash lên kẻ địch").
          // TRƯỚC ĐÂY thắng Clash chỉ NGẮT đòn địch rồi thôi — skill đã tiêu
          // Light/CD nhưng không gây một điểm dmg nào (trừ page-counter có
          // counterEffect riêng ở nhánh trên). Người chơi mất tài nguyên vô ích.
          // Giờ skill dùng để clash được THỰC THI luôn lên kẻ thua clash.
          // Áp THẲNG dmg thay vì tạo pendingAction mới: kẻ thua clash vừa bị
          // "áp đảo" nên KHÔNG được phòng thủ lại — tạo pendingAction sẽ mở
          // prompt reactive defense cho họ, sai luật và dễ gây treo lượt.
          const winBuilt = autoBuildDmgStrFromSkillRoll(chosenSkill);
          if (winBuilt.dmgStr) {
            const winResStr = combatantResStr(attackerResolved.combatant);
            const winPreview = calcMathCore({
              dmgStr: winBuilt.dmgStr, resStr: winResStr,
              poiseInit: clasher.poise, chargeInit: clasher.charge,
              sanityBonusPct: clasher.currentSanity ?? 0,
            });
            applyHpLoss(attackerResolved.combatant, winPreview.totalDmg);
            // Poise/Charge tự thân của skill ghi ngược về clasher (cùng cách
            // resolve-pending-action.js làm) để không mất buff của chính page.
            if (Number.isFinite(winPreview.finalPoiseStacks)) clasher.poise = winPreview.finalPoiseStacks;
            if (Number.isFinite(winPreview.finalCharge)) clasher.charge = winPreview.finalCharge;
            checkStaggerPanic(attackerResolved.combatant);
            choiceNote += ` ⚔️ **${chosenSkill.name}** tung thẳng vào ${attackerResolved.label}: **-${winPreview.totalDmg.toFixed(3)} HP** (còn ${attackerResolved.combatant.currentHp.toFixed(1)}).`;
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

      // Ghi chú chi phí Furioso (vỡ mặt nạ / BGM / Procuration) nối vào KẾT QUẢ
      // — người chơi phải thấy mình vừa trả giá gì, cả khi thắng lẫn thua clash.
      if (furiosoClashNote) choiceNote += furiosoClashNote;
      const finalized = await finalizeReactiveChoice(channelId, encounter, p, targetId, choiceNote, `<@${targetId}>`);
      displayText = finalized.resultText;
      // BGM (Furioso → Saikai1/2): `finalizeReactiveChoice` là nơi đòn resolve
      // nên nó lấy sẵn cờ và trả ra — mọi caller chỉ việc đính vào tin nhắn.
      bgmClash = finalized.bgm ?? bgmClash;
    });
    await interaction.update({
      content: bgmClash.name
        ? `🎵 ${bgmClash.label ?? `BGM đổi sang **${bgmClash.name}**`}${bgmClash.files.length ? "" : " ⚠️ *(không tìm thấy file — đặt vào `assets/audio/bgm/`)*"}`
        : "", // xoá text/mention cũ — update KHÔNG tự xoá field không truyền
      embeds: [{ title: "⚔️ Clash — Kết quả", description: displayText, color: 0x2ecc71 }],
      components: [],
      files: bgmClash.files,
    }).catch(() => {});
    // GAP ĐÃ SỬA (xác nhận trực tiếp): "sau khi responsive guard được thực thi
    // xong thì bị che mất luôn phần dropdown turn của người đang trong turn
    // khiến khó mà lần theo" — gửi lại (resend) dropdown turn hiện tại NGAY
    // sau khi phản hồi xong, để nó luôn nằm Ở CUỐI kênh (dễ thấy nhất), không
    // bị các tin nhắn reactive defense/kết quả mới hơn che khuất lên trên.
    //
    // BUG THẬT MỚI (cùng nguyên nhân với nhánh Guard/Evade/Parry/Không phòng
    // thủ chính — xem comment đầy đủ ở đó) — nếu attacker là enemy aiControlled,
    // hệ thống AI đã TỰ announce đúng turn mới rồi (qua finalizeReactiveChoice's
    // hook trong reactive-defense.js) — resend ở đây thành TRÙNG LẶP.
    {
      const encAfterReactive = await getEncounter(channelId);
      if (encAfterReactive && !(p.attackerType === "enemy" && encAfterReactive.enemies[p.attackerId]?.aiControlled)) {
        announceCurrentTurn(channelId, encAfterReactive, true).catch(() => {});
      }
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
      // Pity đọc theo NHÓM (banner Herta dùng chung 1 ô) — xem pityKeyFor ở
      // gacha-system.js. Banner không thuộc nhóm nào thì pityKeyFor trả về chính
      // bannerKey nên hành vi cũ không đổi.
      const pity = profileData.gachaPity?.[pityKeyFor(bannerKey)] ?? 0;
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
          throw new Error("Không tìm thấy dữ liệu vũ khí — báo GM/admin kiểm tra lại (bình thường mọi người join đều tự có ít nhất Brawler mặc định).");
        }
        // GAP SỬA LẦN 2 (xác nhận trực tiếp): "Firing passive là biến base dmg
        // 12 Slash thành 16 Pierce chứ không phải +4 flat, nó khác nhau nhé
        // thành 16 Base Dmg thì mạnh hơn đó, và các logic bonus % ảnh hưởng
        // được" — TRƯỚC ĐÂY dùng flatDmgPerHit (+4 CỘNG SAU khi các % bonus đã
        // tính trên 12 gốc) — SAI, vì % bonus (Attack Power Up, outfit, v.v.)
        // đáng lẽ phải áp dụng lên TOÀN BỘ 16 (base THẬT đã đổi), không phải chỉ
        // 12 rồi cộng thêm 4 riêng. Giờ sửa base NUMBER trong dmgStr thành 16
        // trực tiếp (xoá flatDmgPerHit's +4 tương ứng ở doPlayerAttack).
        // BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận trực tiếp qua ảnh chụp: "Required
        // field with custom id 'usebullet' not found... khi không nạp đạn thì
        // không thể m1 được") — field "usebullet" CHỈ được thêm vào Modal có
        // điều kiện (Soldato Rifle + có đạn — xem chỗ build Modal phía trên),
        // nhưng dòng đọc lại KHÔNG kiểm tra điều kiện tương ứng, gọi
        // getTextInputValue("usebullet") VÔ ĐIỀU KIỆN — Discord.js THROW lỗi
        // nếu field không tồn tại trong Modal, làm CRASH toàn bộ M1 cho bất kỳ
        // ai không có đạn (hoặc dùng vũ khí khác Soldato Rifle). Bọc try/catch
        // để an toàn mặc định về undefined khi field không có mặt.
        var useBulletInputValue;
        try { useBulletInputValue = interaction.fields.getTextInputValue("usebullet")?.trim() || undefined; }
        catch { useBulletInputValue = undefined; }
        const willUseBulletForType = ["yes", "true", "1"].includes((useBulletInputValue ?? "").toLowerCase());
        // Type text (Blunt/Pierce/Slash) → chữ cái dmgStr cần (B/P/S).
        const normalTypeLetter = { Blunt: "B", Pierce: "P", Slash: "S" }[combatant.weaponType];
        if (!normalTypeLetter) throw new Error(`Type vũ khí "${combatant.weaponType}" không nhận diện được (cần Blunt/Pierce/Slash).`);
        // BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận trực tiếp): "4 lần đánh kèm Firing...
        // chỉ tốn 1 stack đạn và chỉ gây 2 Burn" + "5 lần đánh, tôi chỉ có 1
        // stack đạn... nhưng thực tế 5 lần đánh đều hưởng dmg từ 5 stack đạn" —
        // TRƯỚC ĐÂY toàn bộ hitCount hit đều coi là "có bắn đạn" (Pierce+4dmg)
        // KHÔNG kiểm tra thực tế có đủ đạn hay không, và CHỈ trừ CỐ ĐỊNH 1 viên
        // dù bắn bao nhiêu hit. Giờ CHIA dmgStr thành 2 phần: phần "có đạn"
        // (Pierce+4dmg, GIỚI HẠN đúng bằng số đạn THẬT có, tối đa = hitCount)
        // và phần "cận chiến" (type/dmg gốc vũ khí, cho các hit CÒN LẠI không
        // đủ đạn) — số đạn tiêu = ĐÚNG số hit thật sự được chuyển đổi.
        var effectiveBulletCountForM1 = 0;
        var caduceusMeta = null;
        // ⚠️ ĐỪNG "SỬA" M1 ĐỂ ĂN DICE UP — đã thử và Fragaria bác thẳng:
        // "Dice Up chỉ tăng cho critical và page thôi, tức là những thứ CÓ DICE.
        //  Sanity cũng tương tự. M1 KHÔNG bị ảnh hưởng bởi Dice Up."
        // M1 dùng `weaponBaseDamage` cố định, KHÔNG phải dice → mọi bonus dạng
        // dice (diceUp/diceDown/freeble/tremorChain/sanityBonus) đều không áp.
        // Đây là LUẬT, không phải thiếu sót — xem computeDiceModifier trong
        // combat-utils.js, hàm đó CHỈ dành cho đường skill/critical.
        if (willUseBulletForType) {
          const bulletsAvailable = combatant.bulletStack ?? 0;
          const bulletedHits = Math.min(hitCount, bulletsAvailable);
          const normalHits = hitCount - bulletedHits;
          effectiveBulletCountForM1 = bulletedHits;
          const effectiveBaseDmg = combatant.weaponBaseDamage + 4;
          const bulletedPart = bulletedHits > 0 ? (bulletedHits > 1 ? `${effectiveBaseDmg}x${bulletedHits}P` : `${effectiveBaseDmg}P`) : "";
          const normalPart = normalHits > 0 ? (normalHits > 1 ? `${combatant.weaponBaseDamage}x${normalHits}${normalTypeLetter}` : `${combatant.weaponBaseDamage}${normalTypeLetter}`) : "";
          dmgStr = [bulletedPart, normalPart].filter(Boolean).join("+");
          if (bulletedHits === 0) {
            // Chọn "dùng đạn" nhưng KHÔNG còn viên nào — báo rõ thay vì âm thầm
            // đánh cận chiến hết (người chơi tưởng đã bắn nhưng thực ra không).
            throw new Error(`Không còn viên đạn nào trong súng — không thể dùng Firing. Bỏ trống ô "Dùng đạn?" để đánh cận chiến bình thường, hoặc Reload trước.`);
          }
        } else if (findWeaponAnywhere(combatant.weaponName)?.caduceus) {
          // ── ORACLE DEVICE [CADUCEUS] — "Will of Hermes" ───────────────────
          // ❗ ĐÃ SỬA THỨ TỰ (Fragaria: "logic đánh thường của Caduceus chưa trơn
          // tru — có vẻ nó random thuật toán RỒI MỚI consume stamina"; và "khi
          // đánh M1 mà không đủ stamina để act, huỷ kết quả dmg + MẤT stamina").
          // Trình tự ĐÚNG: roll → tính giá → **KIỂM ĐỦ STAMINA** → mới trừ.
          // Không đủ thì THOÁT SỚM, KHÔNG trừ gì cả, KHÔNG vào CD.
          const rolled = Array.from({ length: hitCount }, () => CADUCEUS_DICE[Math.floor(Math.random() * CADUCEUS_DICE.length)]);
          let caduceusEffectNotes = [];
          const encCad = await getEncounter(channelId);
          const meCad = encCad?.players?.[interaction.user.id];
          // ── GRACE OF GOD (Prescript Device, Unlock ≥ II) ──────────────────
          const wantFace = parseInt((() => { try { return interaction.fields.getTextInputValue("caduceusface"); } catch { return ""; } })(), 10);
          if (meCad?.hasPrescriptDevice && (meCad?.prescriptUnlockLevel ?? 0) >= 2
              && !meCad?.graceOfGodUsedThisTurn && wantFace >= 1 && wantFace <= 9) {
            rolled[0] = CADUCEUS_DICE[wantFace - 1];
            meCad.graceOfGodUsedThisTurn = true;
          }
          let staTotal = rolled.reduce((a, d) => a + d.stamina, 0);
          // Singleton (The Index Oracle's Proxy) — "refund 1/5 Stamina khi đánh
          // thường". Refund = giảm 20% giá phải trả, tính TRƯỚC khi kiểm đủ.
          let refunded = 0;
          if (meCad?.singleton && meCad?.hasIndexOraclesProxy) {
            refunded = Math.round(staTotal / 5);
            staTotal -= refunded;
          }
          if ((meCad?.currentStamina ?? 0) < staTotal) {
            return interaction.reply({
              content: `❌ Không đủ Stamina — cần **${staTotal}** cho ${hitCount} hit Caduceus`
                + (refunded > 0 ? ` *(đã trừ ${refunded} refund từ Singleton)*` : "")
                + `, còn **${Math.round(meCad?.currentStamina ?? 0)}**.`
                + `\n> Các mặt vừa roll: ${rolled.map(d => `Dice ${d.n} (${d.stamina} Sta)`).join(" · ")}`
                + `\n> *Chưa trừ Stamina, chưa vào CD — chọn số hit ít hơn rồi thử lại.*`,
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
          }
          // Mặt 9 `self:alwaysCrit` — Fragaria: "dice 9 vẫn luôn luôn critical
          // cho M1". Gắn `+Crit100` vào ĐÚNG hit của mặt đó (damage-calc đọc
          // `+CritN` theo TỪNG hit), không phải cờ chung cho cả đòn.
          dmgStr = rolled.map(d => `${d.dmg}${d.type[0]}${d.effect === "self:alwaysCrit" ? "+Crit100" : ""}`).join("+");
          const newFaces = [];
          if (meCad) {
            // Procuration [Hermes] — lưu TẬP mặt đã dùng (không phải bộ đếm).
            meCad.procurationHermes = meCad.procurationHermes ?? [];
            for (const d of rolled) {
              if (!meCad.procurationHermes.includes(d.n)) { meCad.procurationHermes.push(d.n); newFaces.push(d.n); }
            }
            meCad.currentStamina = Math.max(0, (meCad.currentStamina ?? 0) - staTotal);
            // ❗ BUG ĐÃ SỬA (Fragaria: "M1 của Caduceus chưa cho nhận Light").
            // Luật chung: mỗi 20 Stamina đã dùng trong turn = 1 Light
            // (turn-advance đọc `staminaUsedThisTurn`). Caduceus trừ Stamina bằng
            // đường RIÊNG nên không đi qua chỗ ghi field này ⇒ mãi không có Light.
            meCad.staminaUsedThisTurn = (meCad.staminaUsedThisTurn ?? 0) + staTotal;
            meCad.caduceusHitsPerCharge = Math.max(1,
              Math.round(CADUCEUS_STAMINA_PER_CHARGE / Math.max(1, Math.round(staTotal / Math.max(1, hitCount)))));
            // "Caduceus bị mặc định base dmg là 8 trong khi đáng lẽ nó KHÔNG có
            // base dmg cố định" — mọi logic dựa vào base dmg (Renegade…) phải lấy
            // theo MẶT CUỐI CÙNG vừa dùng. Ghi đè luôn weaponBaseDamage/Type/Weight.
            const last = rolled[rolled.length - 1];
            meCad.weaponBaseDamage = last.dmg;
            meCad.weaponType = last.type;
            meCad.caduceusLastFace = last.n;
            // ❗❗ Fragaria 12/08: `CADUCEUS_DICE[].effect` từng là DỮ LIỆU CHẾT —
            // 9 mặt khai `effect` mà KHÔNG NƠI NÀO ĐỌC. M1 Caduceus chỉ trừ
            // Stamina + đổi base dmg; mọi hiệu ứng mặt đều KHÔNG chạy.
            // Fragaria chốt: "cả dice 9 vẫn luôn luôn critical cho M1, nó được
            // hưởng HẾT" ⇒ nối TOÀN BỘ 9 effect ngay tại đây.
            const cadTargetKey = normalizeEnemyKey(targetStr ?? "");
            const cadFoe = cadTargetKey ? encCad?.enemies?.[cadTargetKey] : null;
            const TYPE_KEY_CAD = { Blunt: "B", Pierce: "P", Slash: "S" };
            // Trần "2 lần/turn" ghi trong desc của mặt 3/4/6/7/8 (constants.js).
            // Đếm theo SỐ MẶT đã kích trong turn, reset ở advanceCombatantTurn.
            meCad.caduceusFaceUses = meCad.caduceusFaceUses ?? {};
            // ✅ Fragaria 14/08 XÁC NHẬN: trần là RIÊNG BIỆT TỪNG DICE (mặt này
            // 2 lần/turn, không phải "tất cả dice chung 2 lần"), và chỉ MỘT SỐ
            // mặt mới bị giới hạn.
            // Tập mặt + con số nay KHÔNG hardcode nữa — `consumeCaduceusFaceUse`
            // đọc thẳng "(N lần/turn)" từ `desc` trong constants.js. Sửa desc là
            // luật đổi theo. Cùng hàm đó cũng chặn nhánh CRITICAL (bộ đếm dùng
            // chung), nên hai đường không thể lệch luật nữa.
            const cadNotes = [];
            for (const d of rolled) {
              const [scope, kind, amtRaw] = String(d.effect ?? "").split(":");
              const amt = parseFloat(amtRaw) || 0;
              // ❗ BUG ĐÃ SỬA: trước đây quota bị TIÊU **TRƯỚC** khi biết hiệu ứng
              // có áp được không. 4/5 mặt bị giới hạn (4/6/7/8) đều là `foe:`, mà
              // ngay dưới có `if (!cadFoe) continue` — không tra ra mục tiêu là
              // mặt đó mất 1 trong 2 lượt mà KHÔNG gây hiệu ứng nào. Người chơi
              // roll trúng mặt 4 ba lần trong turn thì lần thứ ba im lặng không
              // chạy dù thực tế mới áp được một lần.
              // Nay: chặn điều kiện KHÔNG-ÁP-ĐƯỢC trước, rồi mới tiêu quota.
              if (scope === "foe" && !cadFoe) continue;
              if (!consumeCaduceusFaceUse(meCad, d.n)) continue;   // đã đủ hạn mức turn này
              if (scope === "foe") {
                if (kind === "takeDmg") {
                  cadFoe.dmgTakenPctTurn = (cadFoe.dmgTakenPctTurn ?? 0) + amt;
                  cadNotes.push(`địch +${amt}% Dmg Taken`);
                } else if (kind === "takeDmgType") {
                  cadFoe.dmgTakenPctByType = cadFoe.dmgTakenPctByType ?? { B: 0, P: 0, S: 0 };
                  const tk = TYPE_KEY_CAD[d.type];
                  if (tk) {
                    cadFoe.dmgTakenPctByType[tk] = (cadFoe.dmgTakenPctByType[tk] ?? 0) + amt;
                    cadNotes.push(`địch +${amt}% Dmg Taken từ ${d.type}`);
                  }
                } else if (kind === "sinking") {
                  // ⚠️ `STATUS_CAPS_SHARED` là OBJECT tra theo tên status, KHÔNG
                  // phải một con số — `Math.min(object, n)` ra **NaN** và sẽ phá
                  // huỷ Sinking của địch. Sinking không nằm trong bảng đó (nó có
                  // hằng riêng), nên kẹp 99 giống mọi nơi khác trong codebase.
                  cadFoe.sinking = Math.min(99, (cadFoe.sinking ?? 0) + amt);
                  cadNotes.push(`địch +${amt} Sinking`);
                } else if (kind === "drainStamina") {
                  cadFoe.currentStamina = Math.max(0, (cadFoe.currentStamina ?? 0) - amt);
                  cadNotes.push(`địch −${amt} Stamina`);
                }
              } else if (scope === "self") {
                if (kind === "poise") {
                  meCad.poise = Math.min(POISE_MAX, (meCad.poise ?? 0) + amt);
                  cadNotes.push(`+${amt} Poise`);
                } else if (kind === "dmgUpNextTurn") {
                  // "turn SAU" — cộng vào ô CHỜ, `advanceCombatantTurn` mới đổ
                  // sang ô đang-hiệu-lực. Cộng thẳng vào ô hiệu lực là ăn ngay
                  // turn này, sai luật.
                  meCad.caduceusDmgUpPendingPct = (meCad.caduceusDmgUpPendingPct ?? 0) + amt;
                  cadNotes.push(`+${amt}% Dmg turn sau`);
                }
                // `self:alwaysCrit` (mặt 9) KHÔNG xử lý ở đây — nó phải đi vào
                // ĐÚNG HIT của mặt đó, nên gắn `+Crit100` vào dmgStr bên dưới.
              }
            }
            if (cadNotes.length) caduceusEffectNotes = cadNotes;
            await saveEncounter(channelId, encCad);
          }
          caduceusMeta = {
            faces: rolled.map(d => d.n), staminaTotal: staTotal, refunded,
            hitsPerCharge: meCad?.caduceusHitsPerCharge ?? 1,
            newProcuration: newFaces, procurationTotal: (meCad?.procurationHermes ?? []).length,
            lastFace: rolled[rolled.length - 1],
            effectNotes: caduceusEffectNotes,
          };
        } else {
          dmgStr = hitCount > 1 ? `${combatant.weaponBaseDamage}x${hitCount}${normalTypeLetter}` : `${combatant.weaponBaseDamage}${normalTypeLetter}`;
        }
      } else {
        dmgStr = interaction.fields.getTextInputValue("dmgStr");
      }
      if (typeof caduceusMeta !== "undefined" && caduceusMeta) {
        // Báo rõ Caduceus vừa roll ra gì — không thấy dice thì người chơi không
        // hiểu vì sao mỗi hit một con số khác nhau.
        const facesTxt = caduceusMeta.faces.map(fn => {
          const d = CADUCEUS_DICE[fn - 1];
          return `**Dice ${d.n}** ${d.dmg} ${d.type} *(${d.stamina} Sta)*`;
        }).join(" · ");
        await interaction.followUp({
          content: `<:Prescript:1528452494945157281> **Will of Hermes** — ${facesTxt}`
            + `\n> - Tiêu **${caduceusMeta.staminaTotal} Stamina**`
            + `\n> - **${caduceusMeta.hitsPerCharge} hit / 1 charge** phòng thủ`
            + (caduceusMeta.refunded > 0 ? `\n> - Singleton refund **${caduceusMeta.refunded} Stamina** (1/5)` : "")
            + `\n> - Base Dmg hiện tại theo mặt cuối: **${caduceusMeta.lastFace.dmg} ${caduceusMeta.lastFace.type}**`
            + `\n> - Procuration [Hermes]: **${caduceusMeta.procurationTotal}/9**`
            + (caduceusMeta.newProcuration.length ? ` *(+${caduceusMeta.newProcuration.length} mặt mới)*` : "")
            + (caduceusMeta.effectNotes?.length ? `\n> - Hiệu ứng mặt: **${caduceusMeta.effectNotes.join("**, **")}**` : ""),
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      const { embed } = await doPlayerAttack(channelId, interaction.user.id, interaction.user.toString(), dmgStr, targetStr, { ammotype: ammoTypeInput, usebullet: useBulletInputValue, bulletcount: effectiveBulletCountForM1 });
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
      .setPlaceholder("rupture: 5 | res: 1.3xB 1xP 1xS | speedrange: 3~6 | set emotioncoin: 2 | cd durandal: 3")
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
    // ❗ ĐÃ DỌN (t-ui-audit báo: "addOptions map động mà không slice").
    // TRƯỚC ĐÂY chia CỨNG làm 2 nhóm. Hiện có 14 status ⇒ 7/nhóm, chưa chạm
    // trần 25 của Discord — nhưng thêm status tới 51 cái là mỗi nhóm > 25 và
    // dropdown vỡ. Nay chia ĐỘNG 25/menu, và tràn thì BÁO chứ không cắt im lặng.
    const PER_MENU = 25;
    const MAX_MENUS = 5;                    // Discord chặn cứng 5 action row/message
    const chunks = [];
    for (let i = 0; i < allKeys.length; i += PER_MENU) chunks.push(allKeys.slice(i, i + PER_MENU));
    const shown = chunks.slice(0, MAX_MENUS);
    const hiddenCount = allKeys.length - shown.reduce((a, c) => a + c.length, 0);
    const menus = shown.map((keys, gi) => new StringSelectMenuBuilder()
      .setCustomId(`gmquickstatuspick:${channelId}:${ownerId}:${targetSpec}:g${gi + 1}`)
      .setPlaceholder(`Status (nhóm ${gi + 1}/${shown.length}: ${keys[0]}...${keys[keys.length - 1]})`.slice(0, 150))
      .addOptions(...keys.slice(0, 25).map(k => new StringSelectMenuOptionBuilder().setLabel(String(k).slice(0, 100)).setValue(k))));
    await interaction.update({
      embeds: [{
        title: "🎯 Set Status — Bước 2: Chọn status",
        description: `Danh sách chia ${shown.length} nhóm do giới hạn Discord (tối đa 25 lựa chọn/dropdown).`
          + (hiddenCount > 0 ? `\n⚠️ Còn **${hiddenCount}** status nữa không hiện được — dùng \`-encounter setstatus\` để set trực tiếp.` : ""),
        color: 0xf39c12,
      }],
      components: menus.map(m => new ActionRowBuilder().addComponents(m)),
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
    // GAP ĐÃ SỬA (xác nhận trực tiếp): "khi bấm reload thì trực tiếp cho họ nạp
    // đạn từ trong inventory vào luôn... bước xài lệnh để lấy đạn vào encounter
    // rất không cần thiết" — BỎ HẲN kho dự trữ Encounter (player.ammo/
    // frostAmmo/incendiaryAmmo) — Reload giờ đọc + trừ THẲNG từ Inventory
    // (profileData.items), không cần `-encounter reload` bước trung gian nữa.
    const RELOAD_ITEM_MAP = { ammo: "Ammo", frost: "Frost Ammo", incendiary: "Incendiary Ammo" };
    const itemName = RELOAD_ITEM_MAP[typeRaw];
    if (!itemName) throw new Error(`Loại đạn không hợp lệ: "${typeRaw}" — dùng ammo/frost/incendiary.`);
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Encounter không còn tồn tại.");
      const player = encounter.players[interaction.user.id];
      if (!player) throw new Error("Bạn chưa tham gia encounter này.");
      if (player.weaponName !== "Soldato Rifle") throw new Error("Chỉ dùng được với vũ khí Soldato Rifle.");
      if ((player.bulletStack ?? 0) > 0 && player.bulletStackType && player.bulletStackType !== typeRaw) {
        throw new Error(`Đang còn ${player.bulletStack} đạn loại **${player.bulletStackType}** trong súng — phải dùng hết (Firing khi M1) trước khi nạp loại **${typeRaw}** khác.`);
      }
      const { data: profileData, slot } = await getPlayerDataWithSlot(interaction.user.id);
      const owned = profileData.items?.[itemName] ?? 0;
      const roomLeft = 8 - (player.bulletStack ?? 0);
      const actualAmount = Math.min(amountRaw, owned, roomLeft);
      if (actualAmount <= 0) {
        throw new Error(owned <= 0
          ? `Inventory không còn **${itemName}** nào.`
          : `Súng đã đầy (${player.bulletStack}/8) — không nạp thêm được.`);
      }
      profileData.items[itemName] = owned - actualAmount;
      if (profileData.items[itemName] <= 0) delete profileData.items[itemName];
      await savePlayerData(interaction.user.id, profileData, slot);
      player.bulletStack = Math.min(8, (player.bulletStack ?? 0) + actualAmount);
      player.bulletStackType = typeRaw;
      // Snapshot số lượng CÒN LẠI trong Inventory (sau khi trừ) — GAP MỚI (xác
      // nhận trực tiếp): "vẫn sẽ có text tracking số ammo còn lại trong
      // inventory ở status" — hiển thị trên board (encounter-display.js) mà
      // không cần fetch profileData mỗi lần render — cập nhật lại MỖI khi
      // Reload (thời điểm DUY NHẤT Inventory ammo thay đổi từ hành động trong
      // combat).
      player.ammoInventorySnapshot = player.ammoInventorySnapshot ?? {};
      player.ammoInventorySnapshot[itemName] = profileData.items[itemName] ?? 0;
      appendActionLog(encounter, `🔫 <@${interaction.user.id}>: Reload ${typeRaw} +${actualAmount} vào Soldato Rifle (${player.bulletStack}/8) — Inventory còn ${profileData.items[itemName] ?? 0}.`);
      await saveEncounter(channelId, encounter);
      await interaction.reply({
        embeds: [{ title: "🔫 Reload", description: `Đã nạp **+${actualAmount} ${typeRaw}** từ Inventory vào súng — hiện có **${player.bulletStack}/8**.${actualAmount < amountRaw ? ` *(giới hạn bởi ${owned < amountRaw ? "Inventory" : "sức chứa súng"})*` : ""}\n> **${itemName}** còn lại trong Inventory: **${profileData.items[itemName] ?? 0}**.`, color: 0x2ecc71 }],
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
    // Ô cảnh báo tràn 25 lựa chọn (xem buildMovesPanel) — không phải hành động,
    // chỉ để player BIẾT là còn page bị ẩn. Ack rồi thôi, tránh interaction treo.
    if (value === "toomanypages") {
      return interaction.reply({
        content: "⚠️ Discord chỉ cho tối đa 25 lựa chọn mỗi dropdown nên một số page của bạn chưa hiện được. Báo GM để dùng lệnh text cho những page đó.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
      // ❗❗ BUG ĐÃ SỬA (user: "Chọn Moves → Back. Chọn Moves khác thì sẽ bị LOCK
      // hành động. Khá hên xui để get out"; góp ý: "bỏ luôn nút Back khi đang
      // chọn target đi").
      // GỐC: Back chỉ VẼ LẠI panel mà KHÔNG gỡ `pendingCriticalRolls` — kết quả
      // roll cũ vẫn treo, nên mọi skill khác đều bị chặn bởi "đang có 1 kết quả
      // roll chưa chọn target". Người chơi kẹt cho tới khi TTL hết.
      // CÁCH SỬA (giữ được nút Back, không phải bỏ đi — nhẹ hơn cả việc bỏ):
      // Back GỠ pending. Trước đây tôi cố ý KHÔNG gỡ vì sợ "Back = huỷ để roll
      // lại" thành lối tắt farm dice đẹp — nhưng nỗi lo đó ĐÃ ĐƯỢC `pageRollCache`
      // giải quyết: bấm lại CÙNG skill sẽ tái dùng đúng kết quả roll cũ, không
      // roll mới. Nên gỡ pending là an toàn, và không tốn thêm tài nguyên gì.
    if (value === "back") {
      const encBack = await getEncounter(channelId);
      const combatantBack = encBack?.players?.[interaction.user.id];
      if (!combatantBack) return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
      if (pendingCriticalRolls.delete(`${channelId}:${interaction.user.id}`)) {
        // (không báo gì thêm — người chơi chỉ thấy panel quay lại như mong đợi)
      }
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
      const critRaw = value.slice(9);
      // BUG ĐÃ SỬA (Fragaria: "Mook workshop và Thrust đang TỰ Ý REUSE thay vì
      // hỏi ý player muốn reuse mấy lần").
      // NGUYÊN NHÂN GỐC: dropdown chọn số lần Reuse chỉ được dựng ở nhánh
      // `hit:` (page thường). **Mook Workshop là CRITICAL của vũ khí** nên đi
      // nhánh `critical:` này — nhánh đó chưa từng biết tới `reuseSpec`, nên
      // `resolveReuseTimes` nhận `variantKey = undefined` ⇒ hiểu là "max" ⇒
      // tự reuse hết mức. Thrust cũng dính khi được dùng qua đường Critical.
      // Value giờ mang thêm "|<số lần>" y như nhánh page.
      const critPipeIdx = critRaw.indexOf("|");
      const critSkillName = critPipeIdx >= 0 ? critRaw.slice(0, critPipeIdx) : critRaw;
      let critReuseKey = critPipeIdx >= 0 ? critRaw.slice(critPipeIdx + 1) : null;
      const encounter = await getEncounter(channelId);
      const combatant = encounter?.players?.[interaction.user.id];
      if (!combatant) {
        return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      {
        const critSkillForReuse = findSkill(critSkillName);
        if (critSkillForReuse?.reuseSpec && critReuseKey === null) {
          const opts = buildReuseVariants(critSkillForReuse, combatant.currentLight ?? 0);
          if (opts && opts.length > 1) {
            return interaction.update({
              embeds: [{
                title: `🔁 ${critSkillForReuse.name} — chọn số lần Reuse`,
                description:
                  `Mỗi lần Reuse tiêu tài nguyên thật của bạn, nên bạn tự quyết.\n` +
                  `> Đang có **${combatant.currentLight ?? 0}** <:Light:1513786082502770719>Light — tối đa **${opts.length - 1}** lần Reuse.`,
                color: 0x9b59b6,
              }],
              components: [new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                  .setCustomId(`encmenumoves:${channelId}:${interaction.user.id}`)
                  .setPlaceholder("Chọn số lần Reuse...")
                  .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"),
                    ...opts.slice(0, 24).map(v => new StringSelectMenuOptionBuilder()
                      .setLabel(`${v.emoji ?? "▪"} ${v.label}`.slice(0, 100))
                      .setValue(`critical:${critSkillName}|${v.key}`.slice(0, 100))),
                  ),
              )],
            }).catch(() => {});
          }
          critReuseKey = "0"; // không đủ Light reuse lần nào → đi thẳng đòn gốc
        }
      }
      if (!hasEncounterStarted(encounter)) {
        return interaction.reply({ content: "⚠️ Encounter chưa bắt đầu — GM cần chạy `-encounter rollspeed` trước.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (!isCurrentTurnHolder(encounter, interaction.user.id)) {
        return interaction.reply({ content: "⚠️ Chưa tới lượt bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      // BUG NGHIÊM TRỌNG ĐÃ SỬA (xác nhận trực tiếp): "bấm vào skill/page sau đó
      // back ra, hệ thống sẽ vẫn tiếp tục reroll... player có thể abuse để
      // reroll liên tục cho tới khi ra dice max" — TRƯỚC ĐÂY mỗi lần CHỌN LẠI
      // skill (kể cả sau khi đã Back) đều gọi resolveSkillVerification MỚI
      // (roll() mới), ghi đè thẳng lên pendingCriticalRolls cũ mà KHÔNG kiểm
      // tra đã có 1 roll đang chờ hay chưa — người chơi có thể roll lại vô hạn
      // lần cho tới khi được kết quả dice tốt, MIỄN PHÍ (Light/Cooldown chỉ
      // thực sự trừ SAU khi chọn target, không phải lúc roll hiển thị). Giờ
      // CHẶN: nếu đã có 1 roll pending CHƯA hết hạn cho user này, không cho
      // roll skill mới nào nữa cho tới khi roll cũ được dùng (chọn target)
      // hoặc tự hết hạn (PENDING_CRITICAL_ROLL_TTL_MS).
      // ❗ BUG ĐÃ SỬA (Fragaria: "bấm page rồi lỡ bấm Back thì KHÔNG CHO XÀI SKILL
      // LUÔN"). Cách chống-exploit CŨ là **CHẶN HẲN** mọi lần chọn skill khác cho
      // tới khi roll cũ hết TTL ⇒ lỡ Back một cái là khoá cứng người chơi.
      // Nay đã có `pageRollCache` (cache kết quả roll theo page + biến thể trong
      // CÙNG TURN): chọn lại trả về ĐÚNG roll cũ, không roll lại, không cộng Coin
      // ⇒ exploit đã bị chặn ở gốc mà KHÔNG cần khoá người chơi.
      // Chỉ còn chặn khi chọn **skill KHÁC** trong lúc còn roll treo — đúng ý ban
      // đầu (không cho đổi skill để né kết quả xấu), nhưng chọn LẠI CHÍNH NÓ thì
      // cho phép, vì kết quả đã bị khoá bởi cache.
      const pendingKeyCheck = `${channelId}:${interaction.user.id}`;
      const existingPending = pendingCriticalRolls.get(pendingKeyCheck);
      if (existingPending && existingPending.expiresAt > Date.now()
          && existingPending.skillKey && existingPending.skillKey !== critSkillName) {
        return interaction.reply({
          content: `⚠️ Bạn đang có 1 kết quả roll (**${existingPending.skillKey}**) chưa chọn target.`
            + `\n> Chọn target cho nó, hoặc bấm lại **chính ${existingPending.skillKey}** để tiếp tục — không đổi sang skill khác được.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      // Cache roll cho Critical — GIỐNG HỆT page (xem `pageRollCache`): bấm lại
      // cùng Critical trong CÙNG TURN trả về đúng kết quả cũ, không roll lại.
      const critCacheKey = `crit::${critSkillName}::${critReuseKey ?? ""}`;
      const cachedCrit = combatant.pageRollCache?.key === critCacheKey ? combatant.pageRollCache.verify : null;
      let verify;
      if (cachedCrit) { verify = cachedCrit; }
      else
      try {
        // Truyền số lần Reuse người chơi vừa chọn (tham số variantKey) — thiếu
        // nó thì resolveReuseTimes hiểu là "max" và tự reuse hết mức.
        verify = await resolveSkillVerification(channelId, combatant, critSkillName, null, true, critReuseKey ?? undefined);
      } catch (err) {
        // ❗ BUG ĐÃ SỬA (user: "chiêu lỗi hoặc dùng khi chưa xong CD, KHÔNG REFUND
        // mà còn ĐẶT Ở CD, không cho sử dụng skill khác mà bắt phải aim chiêu đã
        // bị huỷ đó").
        // GỐC: verification ném lỗi ở GIỮA CHỪNG — có thể đã trừ Light/Sanity và
        // đã ghi cooldown (resolveSkillVerification mutate combatant khi roll()).
        // Trả lời rồi `return` mà KHÔNG dọn ⇒ combatant kẹt ở trạng thái dở dang,
        // còn `pendingCriticalRolls` vẫn giữ entry cũ nên panel cứ bắt aim lại.
        // ⚠️ KHÔNG dùng `pendingKey` ở đây — nó khai MÃI PHÍA DƯỚI (TDZ).
        // Dựng lại key tại chỗ bằng cùng công thức.
        pendingCriticalRolls.delete(`${channelId}:${interaction.user.id}`);
        await interaction.reply({
          content: `❌ ${err.message}\n> *Đã hoàn lại Light/Sanity và KHÔNG tính cooldown — chọn hành động khác bình thường.*`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        // Dọn mọi mutate dở dang: nạp lại combatant TỪ REDIS (bản chưa bị đụng)
        // thay vì tự đoán phải hoàn cái gì — an toàn hơn hẳn việc trừ ngược tay.
        try {
          const encFresh = await getEncounter(channelId);
          if (encFresh?.players?.[interaction.user.id]) await saveEncounter(channelId, encFresh);
        } catch { /* không nạp lại được thì thôi, đã báo lỗi cho người chơi */ }
        return;
      }
      if (!cachedCrit) {
        try {
          const encCC = await getEncounter(channelId);
          const meCC = encCC?.players?.[interaction.user.id];
          if (meCC) { meCC.pageRollCache = { key: critCacheKey, verify }; await saveEncounter(channelId, encCC); }
        } catch { /* cache lỗi không chặn việc đánh */ }
      }
      // GAP ĐÃ SỬA (phát hiện qua rà soát khi thêm Shock Round): resolveSkillVerification
      // CÓ THỂ mutate combatant NGAY lúc roll() (VD Shock Round trừ bulletStack,
      // paralyze/chains/busyAsTribbie các skill khác) — nhưng nhánh "có
      // autoDmgStr" (skill dmg thường) TRƯỚC ĐÂY không save encounter ở đây,
      // chỉ lưu tạm vào pendingCriticalRolls (Map riêng) rồi CHỜ TỚI lúc target
      // đã chọn mới save — nhưng bước đó fetch encounter MỚI (getEncounter),
      // làm MẤT TRẮNG mutation vừa làm ở đây. Save NGAY để không mất.
      await saveEncounter(channelId, encounter);
      // ❗ BUG ĐÃ SỬA (Fragaria: "Designant không target được và Astral
      // Quantization vừa không target được vừa không hoạt động").
      // GỐC: khối này nằm SAU nhánh `if (!verify.autoDmgStr)` — mà nhánh đó
      // resolve rồi `return` NGAY ⇒ code chọn đồng đội KHÔNG BAO GIỜ chạy tới.
      // Lượt trước tôi dời nó xuống để né TDZ `pendingKey`, vô tình đặt sau
      // điểm return. Nay đặt ĐÚNG CHỖ (trước nhánh đó) và dựng key tại chỗ.
      // ⚠️ ĐÃ DI CHUYỂN — khối này TRƯỚC ĐÂY nằm PHÍA TRÊN dòng khai
      // `const pendingKey` ⇒ "Cannot access 'pendingKey' before initialization"
      // (Fragaria gửi ảnh: Designant chết ngay khi bấm). Đúng lớp lỗi TDZ tôi
      // đã cảnh báo nhiều lần trong chính file HAND-OFF này mà vẫn tái phạm.
      // ── Skill KHÔNG có dmg nhưng CẦN chọn đồng đội (Designant.) ───────────
      // Phải chặn TRƯỚC nhánh `!verify.autoDmgStr` bên dưới: nhánh đó dựng
      // pendingAction với `targets: []` rồi resolve NGAY, không chỗ nào hỏi ai.
      const critSkillObj = findSkill(critSkillName);
      if (!verify.autoDmgStr && critSkillObj?.needsAllyTarget) {
        const allyOptions = buildAllyTargetOptions(encounter, interaction.user.id);
        if (allyOptions.length === 0) {
          return interaction.reply({ content: "⚠️ Không còn đồng đội nào (còn sống) để chỉ định.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        pendingCriticalRolls.set(`${channelId}:${interaction.user.id}`, {
          skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns,
          emotionDelta: verify.emotionDelta ?? 0, emotionPlus: verify.emotionPlus ?? 0, lightCost: verify.lightCost,
          sanityCost: verify.sanityCost, skillRollEmbed: verify.skillRollEmbed,
          expiresAt: Date.now() + PENDING_CRITICAL_ROLL_TTL_MS,
        });
        await interaction.update({
          embeds: [verify.skillRollEmbed, { title: `⚡ ${critSkillName} — chọn người được chỉ định`, description: critSkillObj.allyTargetPrompt ?? "Chọn 1 đồng đội (hoặc chính bạn):", color: 0x3498db }],
          components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`encallytarget:${channelId}:${shortTokenFor(critSkillName)}`)
              .setPlaceholder("Chọn người được chỉ định...")
              .setMinValues(1).setMaxValues(1)
              // ❗ Fragaria (12/08): "Dùng Designant. với Astral Quantization
              // không có nút Back". Mọi dropdown chọn target khác đều có "◀ Back"
              // làm option ĐẦU TIÊN — riêng nhánh chọn ĐỒNG ĐỘI bị bỏ sót.
              .addOptions(new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"), ...allyOptions),
          )],
        }).catch(() => {});
        return;
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
          // ❗❗ BUG ĐÃ SỬA (Fragaria báo LẦN 2: "Borrowed Eyes vẫn chưa hoạt động").
          // Lần trước tôi sửa nơi ĐỌC (resolve đọc số charge từ dòng dice trong
          // `p.skillRollEmbed`) nhưng nhánh dựng `p` NÀY — đường thật của mọi
          // Critical/Page KHÔNG có dmg — lại KHÔNG hề gắn `skillRollEmbed` vào p.
          // ⇒ resolve vẫn không có gì để đọc, vẫn rơi về `dmgStr` = "Critical:
          // Borrowed Eyes" (không có chữ số) ⇒ vẫn 0 charge.
          // ⚠️ Test cũ của tôi XANH GIẢ vì nó TỰ cấp `skillRollEmbed` cho p —
          // tức là tôi test giả định của mình, không phải nhánh thật.
          skillRollEmbed: verify.skillRollEmbed,
          rollText: verify.skillRollEmbed?.description ?? "",
          skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: verify.emotionDelta ?? 0, emotionPlus: verify.emotionPlus ?? 0, orlandoFuriosoBypassConsumed: verify.orlandoFuriosoBypassConsumed ?? false, quickstepBypassConsumed: verify.quickstepBypassConsumed ?? false,
          lightCost: verify.lightCost, sanityCost: verify.sanityCost,
        };
        const lines = await resolveOnePendingAction(encounter, p);
        // ❗❗ BUG ĐÃ SỬA (Fragaria, lô 12/08: "Furioso Replica vẫn chưa tự động
        // phát BGM ổn, BGM vẫn được chạy ngầm khi gọi -encounter status sẽ hiện
        // ra; cái quan trọng là khi kích hoạt không tự động gửi file phát lên
        // như EGO Red Mist").
        // GỐC: `announceBgmIfChanged` ĐỌC XONG XOÁ cờ `bgmAnnounceNow` rồi tự gửi
        // bằng `channel.send` — đúng con đường đã bị bác ở lượt (W) vì hỏng khâu
        // nào cũng im lặng. Nó chạy TRƯỚC `takePendingBgmFiles` nên CƯỚP MẤT cờ:
        // hàm đính-file-vào-reply (đường ĐÃ XÁC NHẬN CHẠY của Red Mist) luôn thấy
        // rỗng ⇒ không bao giờ có file. Bỏ hẳn lời gọi này cho Furioso.
        // GAP ĐÃ SỬA (xác nhận trực tiếp: "1 turn act bao nhiêu lần cũng được")
        // — không còn advance turn tự động sau hành động này nữa.
        // Critical ĐÃ dùng thật ⇒ xoá cache roll (giữ lại thì turn sau bấm lại
        // cùng Critical sẽ ăn kết quả cũ).
        if (encounter.players?.[interaction.user.id]) encounter.players[interaction.user.id].pageRollCache = null;
        await saveEncounter(channelId, encounter);
        // Stage 5 (quest system) — nếu quest vừa kết thúc (thắng/thua) ngay
        // trong action này, xoá encounter NGAY SAU khi save (cùng nguyên tắc
        // thứ tự với reactive-defense.js's finalizeReactiveChoice). GAP ĐÃ SỬA
        // (rà soát sau bug report treo encounter) — TRƯỚC ĐÂY vẫn gọi
        // announceCurrentTurn(encounter) NGAY SAU dù đã xoá — dùng `encounter`
        // biến CŨ (đã hết tồn tại trong Redis), gửi board/thông báo dựa trên dữ
        // liệu lỗi thời — giờ return SỚM, bỏ qua hẳn bước đó khi đã kết thúc.
        if (encounter._deleteAfterSave) {
          await deleteEncounter(channelId).catch((err) => log("error", "critical-deleteEncounter", interaction.user.id, err.message));
          {
            const bgm = takePendingBgmFilesSafe(encounter, AttachmentBuilder);
            return interaction.reply({
              content: bgm.name ? `🎵 ${bgm.label ?? `BGM đổi sang **${bgm.name}**`}${bgm.files.length ? "" : " ⚠️ *(không tìm thấy file — đặt vào `assets/audio/bgm/`)*"}` : undefined,
              embeds: lines.length ? [verify.skillRollEmbed, { description: lines.join("\n"), color: 0x95a5a6 }] : [verify.skillRollEmbed],
              files: bgm.files,
            }).catch(() => {});
          }
        }
        announceCurrentTurn(channelId, encounter).catch(() => {});
        {
          // BGM (Furioso → Saikai1/2) đính THẲNG vào reply này — cùng cơ chế với
          // Manifest E.G.O (đã xác nhận chạy), thay cho channel.send riêng.
          const bgm = takePendingBgmFilesSafe(encounter, AttachmentBuilder);
          return interaction.reply({
            content: bgm.name ? `🎵 ${bgm.label ?? `BGM đổi sang **${bgm.name}**`}${bgm.files.length ? "" : " ⚠️ *(không tìm thấy file — đặt vào `assets/audio/bgm/`)*"}` : undefined,
            embeds: lines.length ? [verify.skillRollEmbed, { description: lines.join("\n"), color: 0x95a5a6 }] : [verify.skillRollEmbed],
            files: bgm.files,
          }).catch(() => {});
        }
      }
      const pendingKey = `${channelId}:${interaction.user.id}`;
      pendingCriticalRolls.set(pendingKey, {
        dmgStr: verify.autoDmgStr,
        skillRollEmbed: verify.skillRollEmbed,
        skillKey: verify.skillKey,
        cooldownTurns: verify.cooldownTurns,
        emotionDelta: verify.emotionDelta, emotionPlus: verify.emotionPlus ?? 0,
        lightCost: verify.lightCost,
        sanityCost: verify.sanityCost,
        autoWarnings: verify.autoWarnings,
        orlandoFuriosoBypassConsumed: verify.orlandoFuriosoBypassConsumed ?? false, quickstepBypassConsumed: verify.quickstepBypassConsumed ?? false,
        // GAP ĐÃ SỬA (xác nhận trực tiếp: "Critical Shock Round... chả áp burn
        // nào") — pendingCriticalRolls trước đây KHÔNG lưu effectiveBulletType/
        // effectiveBulletCount từ verify, làm MẤT thông tin loại/số đạn đã tiêu
        // giữa lúc roll xong và lúc target được chọn (dropdown Critical đi qua
        // Map trung gian này, khác luồng M1 gọi doPlayerHit trực tiếp).
        effectiveBulletType: verify.effectiveBulletType, effectiveBulletCount: verify.effectiveBulletCount ?? 0,
        // Re-Load — biến thể người chơi chọn CHÍNH LÀ loại đạn muốn nạp. Map sang
        // `loadType` để resolve-pending-action.js dùng (nó đã đọc `p.loadType`
        // từ trước, chỉ thiếu người truyền vào).
        loadType: verify.skillKey === "re-load" ? (chosenVariantKey ?? "ammo") : undefined,
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
            .setCustomId(`enctarget:${channelId}:criticalhit:${shortTokenFor(critSkillName)}`)
            .setPlaceholder("Chọn target...")
            .setMinValues(1)
            .setMaxValues(isAoeThisCritical ? Math.min(aoeMaxThisCritical, targetOptions.length) : 1)
            .addOptions(new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"), ...targetOptions),
        )],
      }).catch(() => {});
      return;
    }
    if (value === "ytsfollowup") {
      // Đòn đâm của "You're Too Slow" — bước 2 của luồng counter (xem
      // express-routes.js). CD chỉ set SAU đòn này, đúng yêu cầu "sau đó skill
      // sẽ bắt đầu cd".
      const encYts = await getEncounter(channelId);
      const meYts = encYts?.players?.[interaction.user.id];
      if (!meYts) return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
      if (!meYts.youreTooSlowMark?.markedTargetId) {
        return interaction.reply({ content: "⚠️ Bạn không có mục tiêu nào đang bị **You're Too Slow** đánh dấu.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (!isCurrentTurnHolder(encYts, interaction.user.id)) {
        return interaction.reply({ content: "⚠️ Chưa tới lượt bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      let ytsText = "";
      await withLock(encounterKey(channelId), async () => {
        const enc = await getEncounter(channelId);
        const me = enc?.players?.[interaction.user.id];
        if (!me?.youreTooSlowMark?.markedTargetId) { ytsText = "⚠️ Dấu đã mất hiệu lực."; return; }
        const markedResolved = resolveCombatant(enc, me.youreTooSlowMark.markedTargetId);
        if (!markedResolved || markedResolved.combatant.currentHp <= 0) {
          me.youreTooSlowMark = null;
          ytsText = "⚠️ Mục tiêu đã bị đánh dấu không còn sống — dấu bị huỷ.";
          await saveEncounter(channelId, enc);
          return;
        }
        const ytsSkill = findSkill("you're too slow");
        const built = autoBuildDmgStrFromSkillRoll(ytsSkill);
        const preview = calcMathCore({
          dmgStr: built.dmgStr, resStr: combatantResStr(markedResolved.combatant),
          poiseInit: me.poise, chargeInit: me.charge,
        });
        applyHpLoss(markedResolved.combatant, preview.totalDmg);
        // Status từ dmgStr (3 Bleed) — đòn này KHÔNG đi qua reactive defense
        // (địch đang bị đánh dấu, không được phòng thủ), nên áp thẳng.
        markedResolved.combatant.bleed = preview.bleedStacksAfter ?? markedResolved.combatant.bleed;
        checkStaggerPanic(markedResolved.combatant);
        // CD bắt đầu TỪ ĐÂY (không phải lúc counter).
        me.skillCooldowns = me.skillCooldowns ?? {};
        me.skillCooldowns["you're too slow"] = parseSkillCooldownTurns(ytsSkill.cd) + 1;
        me.youreTooSlowMark = null;
        ytsText = `⚡ **You're Too Slow** — đâm ${markedResolved.label} **-${preview.totalDmg.toFixed(3)} HP** (còn ${markedResolved.combatant.currentHp.toFixed(1)}). Skill vào cooldown ${parseSkillCooldownTurns(ytsSkill.cd)} turn.`;
        appendActionLog(enc, ytsText);
        await saveEncounter(channelId, enc);
      });
      const encAfterYts = await getEncounter(channelId);
      if (encAfterYts) announceCurrentTurn(channelId, encAfterYts, true).catch(() => {});
      return interaction.update({ content: "", embeds: [{ title: "⚡ You're Too Slow", description: ytsText, color: 0x1abc9c }], components: [] }).catch(() => {});
    }
    if (value.startsWith("hit:")) {
      // LỖ HỔNG BẢO MẬT ĐÃ SỬA (xác nhận trực tiếp qua ảnh chụp thật: "dù Blade
      // Flourish đã roll sẵn ở dropdown rồi nhưng vẫn bắt tôi nhập dmg thành ra
      // tôi có thể thử nhập 50x3B") — TRƯỚC ĐÂY roll skill CHỈ để hiển thị embed
      // tham khảo, còn damage THẬT vẫn lấy từ Modal field gõ tay (không hề liên
      // quan tới roll) — giờ ÁP DỤNG Y HỆT fix đã làm cho Critical: roll NGAY lúc
      // chọn dropdown, lưu autoDmgStr server-side, Modal (nếu cần) không còn field
      // dmgStr gõ tay nữa.
      // Fragaria yêu cầu trực tiếp: "nên thêm nút để chọn biến thể".
      // Format value: "hit:<Tên Page>" HOẶC "hit:<Tên Page>|<variantKey>" khi đã
      // chọn biến thể. Dùng "|" (KHÔNG phải ":") vì customId/value đã dùng ":"
      // làm dấu phân cách chính — thêm 1 dấu ":" nữa sẽ phá destructuring.
      const rawPageValue = value.slice(4);
      const pipeIdx = rawPageValue.indexOf("|");
      const pageName = pipeIdx >= 0 ? rawPageValue.slice(0, pipeIdx) : rawPageValue;
      let chosenVariantKey = pipeIdx >= 0 ? rawPageValue.slice(pipeIdx + 1) : null;
      const encounter = await getEncounter(channelId);
      const combatant = encounter?.players?.[interaction.user.id];
      if (!combatant) {
        return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      // Skill có nhiều biến thể LOẠI TRỪ nhau (VD Extreme Edge: Mặt đất / Trên
      // không / Dưới 33% HP — mỗi cái dải dice + tag khác hẳn) — hỏi TRƯỚC khi
      // roll. Dùng LẠI customId "encmenumoves:" nên rơi vào đúng handler này ở
      // lần chọn sau, không cần handler riêng.
      const variantSkill = findSkill(pageName);
      // ══ DROPDOWN REUSE ĐỘNG (Thrust / Mook Workshop) ═════════════════════
      // Fragaria cảnh báo: "player có thể nhập tùy ý ví dụ nhập 9 lần reuse dù
      // chỉ đang có 4 Light". Kẹp ở server (resolveReuseTimes) là bắt buộc,
      // nhưng CHƯA ĐỦ về mặt UX: người chơi chọn "9" rồi bị âm thầm kẹp về 2 sẽ
      // tưởng mình đã reuse 9 lần. Nên dựng danh sách theo Light THẬT ngay tại
      // UI — chỉ hiện đúng những lựa chọn khả thi.
      const reuseCombatant = encounter?.players?.[interaction.user.id];
      // ══ TÍCH TỤ — BẤM LẦN 1 = BẮT ĐẦU TÍCH, BẤM LẦN 2 = PHÓNG ═══════════
      // Fragaria mô tả trực tiếp: "khi bấm skill sẽ tính là bắt đầu tích (charge
      // khởi đầu là 0), có thể bấm thêm một lần nữa để phóng ra số turn đã tích"
      // + "đang tích mà bị Stagger hay bị đánh sẽ KHÔNG mất".
      // Lần 1 KHÔNG roll, KHÔNG tốn CD, KHÔNG tạo pendingAction — chỉ ghi state
      // rồi thoát. Lần 2 rơi xuống luồng dùng skill bình thường, và
      // skill-verification.js đọc chargingTurns làm rollArgs.
      const chargeKey = variantSkill?.chargeSpec ? resolveSkillKey(pageName) : null;
      if (chargeKey && reuseCombatant && reuseCombatant.chargingSkillKey !== chargeKey) {
        // Đang tích skill KHÁC → phải huỷ cái cũ, không giữ 2 charge cùng lúc.
        const previous = reuseCombatant.chargingSkillKey;
        await withLock(encounterKey(channelId), async () => {
          const encForCharge = await getEncounter(channelId);
          const meCharge = encForCharge?.players?.[interaction.user.id];
          if (!meCharge) return;
          meCharge.chargingSkillKey = chargeKey;
          meCharge.chargingTurns = 0;
          await saveEncounter(channelId, encForCharge);
        });
        return interaction.update({
          content: "", // xoá text/mention cũ — update KHÔNG tự xoá field không truyền
          embeds: [{
            title: `🔋 ${variantSkill.name} — bắt đầu tích tụ`,
            description:
              `Đã bắt đầu tích (**0**/${variantSkill.chargeSpec.maxTurns} Turn).\n` +
              `> Mỗi Turn trôi qua tích thêm 1. Bấm lại **${variantSkill.name}** để **phóng**.\n` +
              `> Bị Stagger hay bị đánh **KHÔNG** làm mất tiến độ tích.` +
              (previous ? `\n> ⚠️ Đã huỷ tiến độ tích của **${previous}** trước đó.` : ""),
            color: 0xe67e22,
          }],
          components: [],
        }).catch(() => {});
      }
      const dynamicReuseVariants = variantSkill?.reuseSpec
        ? buildReuseVariants(variantSkill, reuseCombatant?.currentLight ?? 0)
        : null;
      if (!chosenVariantKey && dynamicReuseVariants) {
        // Không đủ tài nguyên để reuse lần nào → khỏi hỏi, đi thẳng đòn gốc.
        if (dynamicReuseVariants.length <= 1) {
          chosenVariantKey = "0";
        } else {
          return interaction.update({
            embeds: [{
              title: `🔁 ${variantSkill.name} — chọn số lần Reuse`,
              description:
                `Mỗi lần Reuse tiêu tài nguyên thật của bạn, nên bạn tự quyết.\n` +
                `> Đang có **${reuseCombatant?.currentLight ?? 0}** <:Light:1513786082502770719>Light — ` +
                `tối đa **${dynamicReuseVariants.length - 1}** lần Reuse.`,
              color: 0x9b59b6,
            }],
            components: [new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`encmenumoves:${channelId}:${interaction.user.id}`)
                .setPlaceholder("Chọn số lần Reuse...")
                .addOptions(
                  new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"),
                  ...dynamicReuseVariants.slice(0, 24).map(v => new StringSelectMenuOptionBuilder()
                    .setLabel(`${v.emoji ?? "▪"} ${v.label}`.slice(0, 100))
                    .setValue(`hit:${pageName}|${v.key}`)),
                ),
            )],
          }).catch(() => {});
        }
      }
      if (!chosenVariantKey && Array.isArray(variantSkill?.variants) && variantSkill.variants.length > 0) {
        return interaction.update({
          embeds: [{
            title: `🔀 ${variantSkill.name} — chọn tình huống`,
            description: "Page này có nhiều biến thể loại trừ nhau (dải dice và tag khác nhau). Chọn đúng tình huống hiện tại của bạn:",
            color: 0x9b59b6,
          }],
          components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`encmenumoves:${channelId}:${interaction.user.id}`)
              .setPlaceholder("Chọn biến thể...")
              .addOptions(
                new StringSelectMenuOptionBuilder().setLabel("◀ Back").setValue("back"),
                ...variantSkill.variants.slice(0, 24).map(v => new StringSelectMenuOptionBuilder()
                  .setLabel(`${v.emoji ?? "▪"} ${v.label}`)
                  .setValue(`hit:${pageName}|${v.key}`)),
              ),
          )],
        }).catch(() => {});
      }
      if (!hasEncounterStarted(encounter)) {
        return interaction.reply({ content: "⚠️ Encounter chưa bắt đầu — GM cần chạy `-encounter rollspeed` trước.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (!isCurrentTurnHolder(encounter, interaction.user.id)) {
        return interaction.reply({ content: "⚠️ Chưa tới lượt bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      // ❗❗ LỖ HỔNG ĐÃ VÁ (Fragaria): "bấm page, KHÔNG chọn target, back ra, M1,
      // rồi bấm page lại — lặp liên tục sẽ RESET KẾT QUẢ DICE theo ý thích và
      // được Emotion Coin thoải mái."
      // GỐC: mỗi lần chọn page là `resolveSkillVerification` roll LẠI từ đầu —
      // không có gì ràng buộc kết quả đã roll. Người chơi bấm-back-bấm tới khi ra
      // dice đẹp, mỗi lần lại +Emotion Coin.
      // SỬA: CACHE kết quả roll trên chính combatant theo (page, biến thể). Bấm
      // lại cùng page trong CÙNG TURN ⇒ trả về ĐÚNG kết quả cũ, không roll lại,
      // không cộng Coin lần nữa. Cache xoá ở advanceCombatantTurn.
      const rollCacheKey = `${pageName}::${chosenVariantKey ?? ""}`;
      let verify;
      const cachedRoll = combatant.pageRollCache?.key === rollCacheKey ? combatant.pageRollCache.verify : null;
      if (cachedRoll) {
        verify = cachedRoll;
      } else {
        try {
          verify = await resolveSkillVerification(channelId, combatant, pageName, null, false, chosenVariantKey);
        } catch (err) {
          return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        try {
          const encCache = await getEncounter(channelId);
          const meCache = encCache?.players?.[interaction.user.id];
          if (meCache) {
            meCache.pageRollCache = { key: rollCacheKey, verify };
            await saveEncounter(channelId, encCache);
          }
        } catch { /* cache lỗi không được chặn việc đánh */ }
      }
      const pendingKey = `${channelId}:${interaction.user.id}`;
      pendingCriticalRolls.set(pendingKey, {
        dmgStr: verify.autoDmgStr,
        skillRollEmbed: verify.skillRollEmbed,
        skillKey: verify.skillKey,
        cooldownTurns: verify.cooldownTurns,
        emotionDelta: verify.emotionDelta, emotionPlus: verify.emotionPlus ?? 0,
        lightCost: verify.lightCost,
        sanityCost: verify.sanityCost,
        autoWarnings: verify.autoWarnings,
        orlandoFuriosoBypassConsumed: verify.orlandoFuriosoBypassConsumed ?? false, quickstepBypassConsumed: verify.quickstepBypassConsumed ?? false,
        // GAP ĐÃ SỬA (xác nhận trực tiếp: "Critical Shock Round... chả áp burn
        // nào") — pendingCriticalRolls trước đây KHÔNG lưu effectiveBulletType/
        // effectiveBulletCount từ verify, làm MẤT thông tin loại/số đạn đã tiêu
        // giữa lúc roll xong và lúc target được chọn (dropdown Critical đi qua
        // Map trung gian này, khác luồng M1 gọi doPlayerHit trực tiếp).
        effectiveBulletType: verify.effectiveBulletType, effectiveBulletCount: verify.effectiveBulletCount ?? 0,
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
          // Cùng lý do với nhánh Critical ở trên — Page không có dmg cũng phải
          // mang theo embed roll để resolve đọc được con số trong dòng dice.
          skillRollEmbed: verify.skillRollEmbed,
          rollText: verify.skillRollEmbed?.description ?? "",
          skillKey: verify.skillKey, cooldownTurns: verify.cooldownTurns, emotionDelta: verify.emotionDelta ?? 0, emotionPlus: verify.emotionPlus ?? 0, orlandoFuriosoBypassConsumed: verify.orlandoFuriosoBypassConsumed ?? false, quickstepBypassConsumed: verify.quickstepBypassConsumed ?? false,
          lightCost: verify.lightCost, sanityCost: verify.sanityCost,
        };
        const lines = await resolveOnePendingAction(encounter, p);
        // ❗❗ BUG ĐÃ SỬA (Fragaria, lô 12/08: "Furioso Replica vẫn chưa tự động
        // phát BGM ổn, BGM vẫn được chạy ngầm khi gọi -encounter status sẽ hiện
        // ra; cái quan trọng là khi kích hoạt không tự động gửi file phát lên
        // như EGO Red Mist").
        // GỐC: `announceBgmIfChanged` ĐỌC XONG XOÁ cờ `bgmAnnounceNow` rồi tự gửi
        // bằng `channel.send` — đúng con đường đã bị bác ở lượt (W) vì hỏng khâu
        // nào cũng im lặng. Nó chạy TRƯỚC `takePendingBgmFiles` nên CƯỚP MẤT cờ:
        // hàm đính-file-vào-reply (đường ĐÃ XÁC NHẬN CHẠY của Red Mist) luôn thấy
        // rỗng ⇒ không bao giờ có file. Bỏ hẳn lời gọi này cho Furioso.
        // GAP ĐÃ SỬA (xác nhận trực tiếp: "1 turn act bao nhiêu lần cũng được")
        // — không còn advance turn tự động sau hành động này nữa.
        // Lấy file BGM đang chờ TRƯỚC khi save (đọc xong xoá cờ, save luôn thấy sạch).
        const bgmCrit = takePendingBgmFilesSafe(encounter, AttachmentBuilder);
          // Page ĐÃ dùng thật ⇒ xoá cache roll (nếu giữ, turn sau bấm lại
          // cùng page sẽ ăn kết quả cũ).
          if (encounter.players?.[interaction.user.id]) encounter.players[interaction.user.id].pageRollCache = null;
        await saveEncounter(channelId, encounter);
        // Stage 5 (quest system) — nếu quest vừa kết thúc (thắng/thua) ngay
        // trong action này, xoá encounter NGAY SAU khi save (cùng nguyên tắc
        // thứ tự với reactive-defense.js's finalizeReactiveChoice). GAP ĐÃ SỬA
        // (rà soát sau bug report treo encounter) — return SỚM, không gọi
        // announceCurrentTurn với `encounter` đã hết tồn tại trong Redis.
        if (encounter._deleteAfterSave) {
          await deleteEncounter(channelId).catch((err) => log("error", "page-deleteEncounter", interaction.user.id, err.message));
          return interaction.update({
            content: bgmCrit.name ? `🎵 ${bgmCrit.label ?? `BGM đổi sang **${bgmCrit.name}**`}${bgmCrit.files.length ? "" : " ⚠️ *(không tìm thấy file)*"}` : "", // BGM Furioso đính THẲNG vào reply (giống Manifest E.G.O)
            embeds: lines.length ? [verify.skillRollEmbed, { description: lines.join("\n"), color: 0x95a5a6 }] : [verify.skillRollEmbed],
            components: [],
            files: bgmCrit.files,
          }).catch(() => {});
        }
        announceCurrentTurn(channelId, encounter).catch(() => {});
        return interaction.update({
            content: bgmCrit.name ? `🎵 ${bgmCrit.label ?? `BGM đổi sang **${bgmCrit.name}**`}${bgmCrit.files.length ? "" : " ⚠️ *(không tìm thấy file)*"}` : "", // BGM Furioso đính THẲNG vào reply (giống Manifest E.G.O)
          embeds: lines.length ? [verify.skillRollEmbed, { description: lines.join("\n"), color: 0x95a5a6 }] : [verify.skillRollEmbed],
          components: [],
            files: bgmCrit.files,
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
            .setCustomId(`enctarget:${channelId}:hit:${shortTokenFor(pageName)}`)
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
        // BUG THẬT phát hiện qua báo cáo trực tiếp (Fragaria: "bấm nút kết thúc
        // lượt trong dropdown rồi mob tiếp theo không hành động, encounter bị
        // treo") — ĐÂY LÀ ĐƯỜNG DROPDOWN (khác lệnh text `-encounter pass` đã có
        // hook từ trước) — thiếu trigger AI cho turn holder MỚI nếu là enemy
        // aiControlled. Đặt NGOÀI withLock (bên dưới, sau khối này) để tránh
        // reentrant lock.
        resultText = `🏁 Bạn đã kết thúc lượt.${wrapped ? "\n> 🔄 Đã hết 1 vòng turn order — GM dùng nút **🔄 Kết thúc Turn** trong GM Panel để bắt đầu turn mới." : ""}`;
      });
      maybeRunAiTurn(channelId).catch(() => {});
      // content: "" — XOÁ dòng text cũ của panel. Không truyền thì Discord GIỮ
      // NGUYÊN content cũ, người chơi thấy "Chọn hành động..." lơ lửng trên kết
      // quả kết thúc lượt. (t-ui.js bắt được sau khi tôi thêm code làm lệch cửa
      // sổ 12 dòng — trước đó nó pass NHỜ MAY, không phải vì đúng.)
      await interaction.update({ content: "", embeds: [{ description: resultText, color: 0x95a5a6 }], components: [] }).catch(() => {});
      return;
    }
    const isAdmin = ADMIN_IDS.has(interaction.user.id);
    // ❗ BUG NẶNG ĐÃ SỬA (Fragaria: "Manifest E.G.O bấm KHÔNG PHẢN HỒI, không thấy
    // thông báo nhưng VẪN XỬ LÝ NGẦM thành công. User spam liên tục dẫn tới được
    // thực thi ngầm liên tục, hệ lụy là 500 Max Stamina, -45 Sanity").
    // GỐC: `interaction.reply(...)` ở CUỐI hàm chạy SAU khi đã xử lý xong. Nếu quá
    // 3 giây (Redis chậm/lock) Discord huỷ token ⇒ reply ném ⇒ `.catch(()=>{})`
    // nuốt ⇒ người chơi thấy "không phản hồi" và bấm lại, mỗi lần bấm là một lần
    // CỘNG DỒN +100 Max Stamina / −30 Sanity.
    // SỬA 2 LỚP:
    //  (1) `deferReply` NGAY để giữ token 15 phút — hết cảnh "không phản hồi".
    //  (2) KHOÁ CHỐNG BẤM ĐÚP theo (user, action): lần bấm thứ 2 khi lần 1 chưa
    //      xong thì bị chặn, KHÔNG chạy tiếp.
    const specialLockKey = `${channelId}:${interaction.user.id}:${value}`;
    if (specialActionInFlight.has(specialLockKey)) {
      return interaction.reply({ content: "⏳ Hành động trước chưa xong — đừng bấm lại, chờ kết quả nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    specialActionInFlight.add(specialLockKey);
    let deferred = false;
    try { await interaction.deferReply(); deferred = true; } catch { /* token đã chết, xử lý xong vẫn gửi được qua channel */ }
    let resultMsg;
    try {
    if (value === "shinmang") resultMsg = await performShinMang(channelId, interaction.user.id);
    else if (value === "manifestego") resultMsg = await performManifestEgo(channelId, interaction.user.id);
    else if (value === "overcharge") resultMsg = await performOvercharge(channelId, interaction.user.id);
    // "The Mimic" — đổi dạng Kiếm ⇄ Lưỡi hái của Mimicry: Synchronization.
    // value mang sẵn dạng đích ("mimicryform:scythe") thay vì toggle mù: nút được
    // dựng từ state lúc mở panel, nếu người chơi mở 2 panel rồi bấm cả hai thì
    // toggle sẽ lật qua lật lại; ghi rõ đích thì bấm mấy lần cũng ra đúng dạng đó.
    else if (value.startsWith("mimicryform:")) resultMsg = await performMimicryForm(channelId, interaction.user.id, value.slice(12));
    // Shin - Rien follow-up — TÙY CHỌN, người chơi tự bấm mới chạy.
    else if (value === "shinrienfurioso") {
      resultMsg = await (async () => {
        let out = "";
        await withLock(encounterKey(channelId), async () => {
          const enc = await getEncounter(channelId);
          const me = enc?.players?.[interaction.user.id];
          if (!me) throw new Error("Bạn chưa tham gia encounter này.");
          if (!me.shinRienFuriosoOffer) throw new Error("Cửa sổ **Shin - Rien follow-up** không mở (chỉ mở 1 turn sau khi Wound-Casing Mask vỡ).");
          if (me.shinRienFuriosoUsed) throw new Error("**Shin - Rien follow-up** chỉ dùng được **1 lần mỗi Encounter**.");
          me.shinRienFuriosoUsed = true;
          me.shinRienFuriosoReady = true;   // mở Furioso ở panel Moves (không cần đủ 9 Procuration)
          // Trần 1 (Fragaria chốt 12/08) — giống chỗ cộng bên combat-utils.js.
          me.indulgenceInPrescript = Math.min(1, (me.indulgenceInPrescript ?? 0) + 1);
          // ⚠️ **+35 Karmic** — đây là CÁI GIÁ phải NHẬN THÊM (debuff), không phải
          // tiêu hao trừ đi. Karmic càng nhiều càng ăn nhiều dmg (+1%/stack).
          const before = me.karmicConsequence ?? 0;
          me.karmicConsequence = Math.min(100, before + 35);
          await saveEncounter(channelId, enc);
          out = `🩸 **Shin - Rien** — nhận **+1 Indulgence in Prescript** và mở **Furioso follow-up** ngay turn này.`
            + `\n> ⚠️ Cái giá: **+35 Karmic Consequence** (${before} → **${me.karmicConsequence}** — bạn nhận thêm ${me.karmicConsequence}% Dmg).`
            + `\n> Chọn Furioso ở panel **Moves**; không dùng trong turn này thì cửa sổ đóng.`;
        });
        return out;
      })();
    }
    else if (value.startsWith("useitem:")) resultMsg = await performUseItem(channelId, interaction.user.id, value.slice(8));
    else {
      specialActionInFlight.delete(specialLockKey);
      const bad = deferred
        ? interaction.editReply({ content: "⚠️ Hành động không hợp lệ." })
        : interaction.reply({ content: "⚠️ Hành động không hợp lệ.", flags: MessageFlags.Ephemeral });
      await bad.catch(() => {});
      return;
    }
    // BGM riêng của Manifested E.G.O (ego.js `bgm`) — đính kèm NGAY lúc kích hoạt
    // để nó bắt đầu phát. Discord không phát nhạc nền liên tục được, nên "kéo dài
    // tới hết Manifest" thể hiện bằng: `resolveEncounterBgm` trả về bài này ở MỌI
    // lần hiện `-encounter status` cho tới khi Manifest tắt.
    let egoBgmFiles = [];
    if (value === "manifestego") {
      try {
        const encAfter = await getEncounter(channelId);
        const bgmName = egoBgmFor(encAfter?.players?.[interaction.user.id]);
        if (bgmName) {
          egoBgmFiles = bgmAttachmentIH(AttachmentBuilder, bgmName);
          resultMsg += `\n> 🎵 BGM đổi sang **${bgmName}** cho tới khi hết Manifest E.G.O.`;
        }
      } catch (bgmErr) {
        // Thiếu file audio KHÔNG được làm hỏng cú Manifest (đã trừ Sanity, đã
        // bật buff rồi). Log lại thay vì nuốt im lặng.
        log("error", "egoBgm", interaction.user?.id ?? "unknown", bgmErr.message);
      }
    }
    // deferReply đã dùng ⇒ phải editReply. Nếu token chết từ đầu thì gửi thẳng
    // vào channel để người chơi VẪN thấy kết quả (thay vì "không phản hồi").
    if (deferred) {
      await interaction.editReply({ content: resultMsg, files: egoBgmFiles }).catch(async () => {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch) await ch.send({ content: `${interaction.user} ${resultMsg}`, files: egoBgmFiles }).catch(() => {});
      });
    } else {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch) await ch.send({ content: `${interaction.user} ${resultMsg}`, files: egoBgmFiles }).catch(() => {});
    }
    } finally {
      specialActionInFlight.delete(specialLockKey);
    }
  } catch (err) {
    log("error", "encMenuSelect", interaction.user?.id ?? "unknown", err.message);
    await interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ─── 🩹 CHỮA TRỊ (shophealopen: / healpick:) ────────────────────────────────
// GAP ĐÃ SỬA (Fragaria: "làm heal thành dropdown ở shop thay vì lệnh text khó
// xài, hiện giờ gần như KHÔNG THỂ xài để heal injury bằng text").
// Lệnh cũ `-heal injury: <tên>` so khớp bằng `includes()` trên tên chấn thương
// tiếng Việt CÓ DẤU — người chơi phải mở `-balance` chép tay từng chữ, sai dấu
// là báo "không tìm thấy". Dropdown liệt kê sẵn nên không còn gõ gì.
//
// LUẬT GIỮ NGUYÊN, không tự ý đổi:
//   • Chấn thương: 50.000 Ahn/cái, không giới hạn số lần.
//   • HP: 1.500 Ahn/HP, **1 lần mỗi chu kỳ**, làm mới ở mốc 0h/12h giờ VN
//     (dùng CHUNG mostRecentHpResetBoundaryUtc với reset HP — tự đếm 12 tiếng
//     từ lần heal sẽ lệch dần khỏi mốc đó và người chơi không đoán được).
const INJURY_HEAL_COST_UI = 50000;
const HP_HEAL_RATE_AHN_UI = 1500;

async function buildHealPanel(userId) {
  const { data } = await getPlayerDataWithSlot(userId);
  const { grade } = calcGrade(data.exp ?? 0);
  const gradeBasedMaxHp = 140 + 20 * (GRADE_MIN - grade);
  const effectiveMaxHp = Math.max(1, gradeBasedMaxHp - calcInjuryMaxHpPenalty(data.injuries ?? []));
  const currentHp = Math.min(data.currentHp ?? effectiveMaxHp, effectiveMaxHp);
  const missingHp = Math.max(0, effectiveMaxHp - currentHp);
  const ahn = data.ahn ?? 0;
  const injuries = data.injuries ?? [];
  const healUsed = (data.lastPaidHealAt ?? 0) >= mostRecentHpResetBoundaryUtc(Date.now());

  const options = [];
  injuries.forEach((name, i) => {
    // ❗ Chấn thương VĨNH VIỄN (Sizzling Wound) KHÔNG vào danh sách chữa được —
    // Fragaria: "chỉ có GM gõ lệnh mới có thể chữa được". Handler bên dưới cũng
    // chặn lần nữa, phòng menu cũ (bài học "kiểm nơi hiển thị, quên nơi thực thi").
    if (isPermanentInjury(name)) return;
    options.push(new StringSelectMenuOptionBuilder()
      .setLabel(`🩹 ${name}`.slice(0, 100))
      .setDescription(`${formatNumber(INJURY_HEAL_COST_UI)} Ahn${ahn < INJURY_HEAL_COST_UI ? " — KHÔNG đủ Ahn" : ""}`.slice(0, 100))
      // Mang theo TÊN để đối chiếu lúc bấm: index có thể lệch nếu người chơi
      // chữa ở cửa sổ khác trước đó.
      .setValue(`injury:${i}|${name.slice(0, 70)}`.slice(0, 100)));
  });
  if (missingHp > 0 && !healUsed) {
    // 3 mốc cho nhanh, khỏi gõ số. Cap theo Ahn đang có để không hiện lựa chọn
    // chắc chắn thất bại.
    const affordable = Math.floor(ahn / HP_HEAL_RATE_AHN_UI);
    for (const [label, amt] of [["Hồi đầy", missingHp], ["Hồi 1/2", Math.ceil(missingHp / 2)], ["Hồi 10 HP", Math.min(10, missingHp)]]) {
      if (amt <= 0 || amt > affordable) continue;
      if (options.some(o => o.data?.value === `hp:${amt}`)) continue;
      options.push(new StringSelectMenuOptionBuilder()
        .setLabel(`❤️ ${label} (+${amt} HP)`.slice(0, 100))
        .setDescription(`${formatNumber(amt * HP_HEAL_RATE_AHN_UI)} Ahn — 1 lần/chu kỳ`.slice(0, 100))
        .setValue(`hp:${amt}`));
    }
  }
  const notes = [];
  notes.push(`❤️ HP: **${currentHp}/${effectiveMaxHp}**${missingHp === 0 ? " (đã đầy)" : ""}`);
  notes.push(`💰 Ahn: **${formatNumber(ahn)}**`);
  if (injuries.length === 0) notes.push("🩹 Không có chấn thương nào.");
  if (healUsed) notes.push("⚠️ Đã dùng lượt hồi HP bằng Ahn của chu kỳ này — làm mới ở mốc **0h/12h giờ VN**.");
  if (missingHp > 0 && !healUsed && ahn < HP_HEAL_RATE_AHN_UI) notes.push(`⚠️ Không đủ Ahn để hồi HP (cần tối thiểu ${formatNumber(HP_HEAL_RATE_AHN_UI)} Ahn/HP).`);

  return {
    embeds: [{ title: "🩹 Chữa trị", description: notes.join("\n"), color: 0x2ecc71 }],
    components: options.length > 0
      ? [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`healpick:${userId}`)
            .setPlaceholder("Chọn thứ muốn chữa...")
            .setMinValues(1).setMaxValues(1)
            .addOptions(options.slice(0, 25)))]
      : [],
  };
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("shophealopen:")) return;
  const ownerId = interaction.customId.split(":")[1];
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Đây là bảng của người khác — gõ `-shop` để mở bảng của bạn.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await interaction.editReply(await buildHealPanel(ownerId));
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` }).catch(() => {});
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("healpick:")) return;
  const ownerId = interaction.customId.split(":")[1];
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Đây là bảng của người khác.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (isOnCooldown(interaction.user.id, "healpick", 3000)) {
    return interaction.reply({ content: "⏳ Bạn bấm quá nhanh, chờ 3 giây nhé.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferUpdate().catch(() => {});
  const raw = interaction.values[0];
  try {
    let msg = "";
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      const { grade } = calcGrade(data.exp ?? 0);
      const gradeBasedMaxHp = 140 + 20 * (GRADE_MIN - grade);
      const effectiveMaxHp = Math.max(1, gradeBasedMaxHp - calcInjuryMaxHpPenalty(data.injuries ?? []));
      const currentHp = Math.min(data.currentHp ?? effectiveMaxHp, effectiveMaxHp);

      if (raw.startsWith("injury:")) {
        const body = raw.slice(7);
        const sep = body.indexOf("|");
        const idx = parseInt(body.slice(0, sep), 10);
        const namePart = body.slice(sep + 1);
        const list = data.injuries ?? [];
        // Đối chiếu TÊN chứ không tin index — người chơi có thể đã chữa ở bảng khác.
        if (!Number.isInteger(idx) || !list[idx] || !String(list[idx]).startsWith(namePart)) {
          throw new Error("Danh sách chấn thương đã thay đổi — mở lại bảng chữa trị.");
        }
        if ((data.ahn ?? 0) < INJURY_HEAL_COST_UI) {
          throw new Error(`Cần ${formatNumber(INJURY_HEAL_COST_UI)} Ahn — bạn chỉ có ${formatNumber(data.ahn ?? 0)} Ahn.`);
        }
        const removed = list[idx];
        if (isPermanentInjury(removed)) {
          throw new Error(`**${removed}** là chấn thương VĨNH VIỄN — không chữa được bằng Ahn, K-Corp Ampule hay bất kỳ hình thức nào. Chỉ GM mới gỡ được.`);
        }
        list.splice(idx, 1);
        data.injuries = list;
        data.ahn = (data.ahn ?? 0) - INJURY_HEAL_COST_UI;
        await savePlayerData(ownerId, data, slot);
        msg = `🩹 Đã chữa **${removed}** — tốn ${formatNumber(INJURY_HEAL_COST_UI)} Ahn (còn ${formatNumber(data.ahn)} Ahn). Max HP hồi lại tương ứng.`;
        return;
      }
      if (raw.startsWith("hp:")) {
        const want = parseInt(raw.slice(3), 10);
        const missing = effectiveMaxHp - currentHp;
        if (!(want > 0)) throw new Error("Lựa chọn không hợp lệ.");
        if (missing <= 0) throw new Error("Bạn đã đầy HP rồi.");
        if ((data.lastPaidHealAt ?? 0) >= mostRecentHpResetBoundaryUtc(Date.now())) {
          throw new Error("Bạn đã dùng lượt hồi HP bằng Ahn của chu kỳ này rồi — mỗi chu kỳ **1 lần**, làm mới ở mốc **0h/12h giờ VN**.");
        }
        const actual = Math.min(want, missing);
        const cost = actual * HP_HEAL_RATE_AHN_UI;
        if ((data.ahn ?? 0) < cost) {
          throw new Error(`Cần ${formatNumber(cost)} Ahn để hồi ${actual} HP — bạn chỉ có ${formatNumber(data.ahn ?? 0)} Ahn.`);
        }
        data.ahn = (data.ahn ?? 0) - cost;
        data.currentHp = currentHp + actual;
        data.lastPaidHealAt = Date.now();
        await savePlayerData(ownerId, data, slot);
        msg = `❤️ Đã hồi **${actual} HP** (${currentHp} → ${data.currentHp}/${effectiveMaxHp}) — tốn ${formatNumber(cost)} Ahn (còn ${formatNumber(data.ahn)} Ahn).\n> ⚠️ Đây là **lượt hồi duy nhất** của chu kỳ này.`;
        return;
      }
      throw new Error("Lựa chọn không hợp lệ.");
    });
    // Dựng lại bảng để người chơi thấy Ahn/HP/chấn thương đã cập nhật và chữa tiếp.
    const panel = await buildHealPanel(ownerId);
    await interaction.editReply({ content: msg, embeds: panel.embeds, components: panel.components }).catch(() => {});
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}`, embeds: [], components: [] }).catch(() => {});
  }
});


/** furiosoClashKeyFor — biến thể Furioso mà `clasher` ĐỦ ĐIỀU KIỆN đem đi Clash,
 *  hoặc null nếu không đủ.
 *
 *  ❗ BUG ĐÃ SỬA (Fragaria 12/08 lần 2: "sau khi sử dụng Furioso rồi thì tôi vẫn
 *  clash tiếp bằng Furioso được; phải để check ở clash là đủ 9 Procuration thì
 *  mới clash bằng Furioso được, tôi vừa xài Furioso nên số Procuration về 0 rồi
 *  thì làm sao mà clash được nữa").
 *  GỐC: điều kiện chỉ nằm ở chỗ DỰNG dropdown. Dropdown Clash được gửi TỪ TRƯỚC
 *  (lúc đòn địch bay tới), người chơi xài Furioso xong mới bấm ⇒ menu đã cũ,
 *  handler `encclashselect` KHÔNG kiểm lại gì cả nên lọt thẳng. Đây là lớp lỗi
 *  "kiểm ở nơi HIỂN THỊ mà không kiểm ở nơi THỰC THI" — y như bài học "ẩn UI mà
 *  không chặn logic thì đường còn lại vẫn lọt".
 *  NAY: một hàm DUY NHẤT, gọi ở CẢ hai nơi — dựng menu và lúc bấm chọn.
 */
function furiosoClashKeyFor(clasher) {
  if (!clasher) return null;
  const unlock = clasher.prescriptUnlockLevel ?? 0;
  if (unlock < 1) return null;
  const proc = (clasher.procurationHermes ?? []).length;
  // ❗ ĐÍNH CHÍNH (Fragaria: "AttachmentBuilder is not defined khi xài clash của
  // Furioso Replica — LÚC NÀY TÔI CHƯA ĐỦ 9 PROCURATION").
  // Bản trước tôi cho `shinRienFuriosoReady` mở cả đường Clash. SAI: cửa sổ
  // Shin - Rien nói rõ "Chọn Furioso ở panel **Moves**" — nó mở đường TẤN CÔNG
  // follow-up, không phải đường Clash. Luật Clash Fragaria chốt chỉ có một vế:
  // **đủ 9 Procuration** mới clash bằng Furioso được.
  if (proc < 9) return null;
  return ["furioso replica", "furioso crescendo", "furioso lacrimosa crescendo"][unlock - 1] ?? null;
}

/** announceBgmIfChanged — GỬI FILE mỗi khi BGM đang-phát ĐỔI, không chỉ ghi chữ.
 *
 *  Fragaria: *"nên GỬI FILE phát bgm ghi đè luôn thay vì chỉ ghi mỗi text khi có
 *  bgm mới được ghi đè."* Trước đây chỉ Manifest E.G.O mới đính file; các đường
 *  ghi đè khác (Saikai1 khi dùng Furioso, Saikai2 khi mặt nạ vỡ) chỉ đổi chữ ⇒
 *  người chơi không nghe được gì.
 *
 *  So với `encounter.lastAnnouncedBgm` để KHÔNG spam lại cùng một bài mỗi lượt.
 */
async function announceBgmIfChanged(channelId, encounter, label = "") {
  try {
    // ❗ KHÔNG còn ĐỌC-XOÁ cờ `bgmAnnounceNow` ở đây nữa.
    // Fragaria: "BGM vẫn được chạy ngầm khi gọi -encounter status sẽ hiện ra;
    // cái quan trọng là khi kích hoạt không tự động gửi file phát lên."
    // Chính hàm này là thủ phạm: nó nuốt cờ (đường `channel.send`, hỏng khâu nào
    // cũng im lặng), khiến `takePendingBgmFiles` — đường đính file vào reply đã
    // được xác nhận CHẠY với Red Mist — không còn gì để phát. Nay cờ THUỘC VỀ
    // DUY NHẤT takePendingBgmFiles; hàm này chỉ lo BGM NỀN của encounter.
    const want = resolveEncounterBgm(encounter);
    if (!want) return;
    if (encounter.lastAnnouncedBgm === want) return;
    encounter.lastAnnouncedBgm = want;
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return;
    const files = bgmAttachmentIH(AttachmentBuilder, want);
    await ch.send({
      content: files.length
        ? `> 🎵 BGM đổi sang **${want}** — ${describeEncounterBgm(encounter)?.label ?? label ?? "BGM trận này"}`
        : `> ⚠️ BGM cần đổi sang **${want}** nhưng KHÔNG tìm thấy file — đặt vào \`assets/audio/bgm/\` rồi deploy lại.`,
      files,
    }).catch(() => {});
  } catch (err) {
    log("error", "announceBgm", "system", err.message);
  }
}

// ─── SELECT MENU: chọn ĐỒNG ĐỘI cho skill khai `needsAllyTarget` ────────────
// BUG ĐÃ SỬA (Fragaria: "Designant không cho chỉ định mà mặc định cho bản thân").
// Skill không có dice sát thương vốn đi thẳng resolve với `targets: []`, nên
// resolve-pending-action.js luôn rơi vào nhánh mặc định `?? p.attackerId`.
// Bước này lấp `targets` bằng người được chọn — resolve KHÔNG cần sửa gì, nó vốn
// đã đọc `(p.targets ?? [])[0]?.targetId` đúng.
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("encallytarget:")) return;
  const parts = interaction.customId.split(":");
  const channelId = parts[1];
  const critSkillName = resolveShortToken(parts.slice(2).join(":"));
  const chosenAllyId = interaction.values[0];
  // "◀ Back" — quay về dropdown top-level Attack/Moves/Special. CỐ Ý KHÔNG xoá
  // `pendingCriticalRolls`: roll cũ vẫn phải bị khoá cho tới khi hết TTL, không
  // mở lối tắt "Back = huỷ để roll lại" (xem cùng lý do ở nhánh enctarget).
  if (chosenAllyId === "back") {
    // Cùng lý do với nhánh `enctarget` ở trên — Back phải GỠ pending, nếu không
    // người chơi bị khoá mọi hành động khác cho tới khi TTL hết.
    const encBackAlly = await getEncounter(channelId).catch(() => null);
    const meBackAlly = encBackAlly?.players?.[interaction.user.id];
    if (!meBackAlly) return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
    pendingCriticalRolls.delete(`${channelId}:${interaction.user.id}`);
    return interaction.update({ components: buildEncounterActionPanel(channelId, meBackAlly, interaction.user.id) }).catch(() => {});
  }
  await interaction.deferUpdate().catch(() => {});
  // ⚠️ KEY PHẢI KHỚP bên ĐẶT. Bên đặt (nhánh Critical) dùng
  // `${channelId}:${userId}` — tôi viết bên đọc thành
  // `${channelId}:${userId}:${critSkillName}` nên KHÔNG BAO GIỜ tìm thấy, luôn
  // báo "lượt roll đã hết hạn". Hai đầu của một cái Map phải dựng key CÙNG CÔNG THỨC.
  const pendingKey = `${channelId}:${interaction.user.id}`;
  try {
    const pendingRoll = pendingCriticalRolls.get(pendingKey);
    if (!pendingRoll || pendingRoll.expiresAt < Date.now()) {
      pendingCriticalRolls.delete(pendingKey);
      return interaction.followUp({ content: "⚠️ Lượt roll đã hết hạn — chọn lại Critical.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    pendingCriticalRolls.delete(pendingKey);
    let outLines = [];
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Channel này chưa có encounter nào.");
      if (!encounter.players?.[chosenAllyId]) throw new Error("Người được chọn không còn trong encounter.");
      const p = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind: "critical", attackerId: interaction.user.id,
        // preview rỗng — skill này KHÔNG gây dmg, `targets` chỉ để CHỈ ĐỊNH người.
        targets: [{ targetId: chosenAllyId, preview: { totalDmg: 0, dmgValues: [] } }],
        dmgStr: `Critical: ${critSkillName}`, defenseBypass: {},
        // rollText — text ĐÃ ROLL thật. Skill không có dice sát thương thì
        // `dmgStr` chỉ là nhãn, mọi con số (VD "**41%**" của Astral Quantization)
        // đều nằm ở đây. Không truyền là resolve đọc ra 0.
        rollText: pendingRoll.skillRollEmbed?.description ?? "",
        skillKey: pendingRoll.skillKey, cooldownTurns: pendingRoll.cooldownTurns,
        emotionDelta: pendingRoll.emotionDelta ?? 0, emotionPlus: pendingRoll.emotionPlus ?? 0,
        lightCost: pendingRoll.lightCost, sanityCost: pendingRoll.sanityCost,
      };
      outLines = await resolveOnePendingAction(encounter, p);
      // KHÔNG gọi announceBgmIfChanged ở đây — nó cướp cờ `bgmAnnounceNow` của
      // `takePendingBgmFiles` ngay bên dưới (xem giải thích đầy đủ ở nhánh Critical).
      // Critical ĐÃ dùng thật ⇒ xoá cache roll (giữ lại thì turn sau bấm lại
      // cùng Critical sẽ ăn kết quả cũ).
      if (encounter.players?.[interaction.user.id]) encounter.players[interaction.user.id].pageRollCache = null;
      await saveEncounter(channelId, encounter);
    });
    const bgmAlly = takePendingBgmFilesSafe(await getEncounter(channelId).catch(() => null) ?? {}, AttachmentBuilder);
    // ❗ Fragaria (12/08): "xài xong phần target lên đồng minh của cả hai thì
    // không thấy dropdown chọn hành động hiện ra".
    // GỐC: `components: []` xoá sạch bảng điều khiển — người chơi kẹt, phải gọi
    // lại panel bằng tay. Mọi nhánh hành động khác đều dựng lại
    // `buildEncounterActionPanel` sau khi xử lý xong; riêng nhánh chọn đồng đội
    // bị bỏ sót (cùng chỗ bỏ sót nút Back ở trên).
    const encAfterAlly = await getEncounter(channelId).catch(() => null);
    const meAfterAlly = encAfterAlly?.players?.[interaction.user.id];
    await interaction.editReply({
      content: bgmAlly.name ? `🎵 ${bgmAlly.label ?? `BGM đổi sang **${bgmAlly.name}**`}` : undefined,
      embeds: [pendingRoll.skillRollEmbed, { description: outLines.join("\n") || "*(không có gì để hiện)*", color: 0x95a5a6 }],
      components: meAfterAlly ? buildEncounterActionPanel(channelId, meAfterAlly, interaction.user.id) : [],
      files: bgmAlly.files,
    }).catch(() => {});
  } catch (err) {
    log("error", "encallytarget", interaction.user?.id ?? "unknown", err.message);
    await interaction.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ─── SELECT MENU (astraltarget — NGƯỜI BUFF Astral Quantization chọn đối thủ
// nhận đòn trì hoãn, ở mốc cuối Turn Order) ──────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("astraltarget:")) return;
  const [, channelId, idxRaw] = interaction.customId.split(":");
  const idx = parseInt(idxRaw, 10);
  const foeKey = interaction.values[0];
  await interaction.deferUpdate().catch(() => {});
  try {
    let outText = "";
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Channel này chưa có encounter nào.");
      const queue = encounter.pendingAstralChoice ?? [];
      const aq = queue[idx];
      if (!aq) throw new Error("Đòn Astral Quantization này đã được xử lý rồi.");
      // Chỉ ĐÚNG người buff mới được chọn (Fragaria: "người buff nó chỉ định",
      // không phải người nhận buff).
      if (interaction.user.id !== aq.userId) {
        throw new Error(`Chỉ <@${aq.userId}> — người đã dùng **Astral Quantization** — mới được chọn mục tiêu.`);
      }
      const foe = encounter.enemies?.[foeKey];
      if (!foe || (foe.currentHp ?? 0) <= 0) throw new Error("Mục tiêu không còn hợp lệ.");
      const absorbed = applyShieldLoss(foe, Math.min(foe.shieldHp ?? 0, aq.amount));
      applyHpLoss(foe, aq.amount - absorbed);
      checkStaggerPanic(foe);
      outText = `🌌 **Astral Quantization** (<@${aq.userId}>) — **${aq.pct}%** tổng dmg của <@${aq.allyId}> (**${aq.totalDealt}**)`
        + ` → **${foe.name}** chịu **${aq.amount}** dmg (còn ${Math.round(foe.currentHp)}/${Math.round(foe.maxHp)} HP).`;
      appendActionLog(encounter, outText);
      // Gỡ khỏi hàng đợi bằng cách đánh dấu null — GIỮ NGUYÊN index của các mục
      // còn lại, vì customId của những dropdown đã gửi đi đang trỏ theo index.
      queue[idx] = null;
      if (queue.every(x => x === null)) encounter.pendingAstralChoice = [];
      await saveEncounter(channelId, encounter);
    });
    await interaction.editReply({
      embeds: [{ title: "🌌 Astral Quantization", description: outText, color: 0x8e44ad }],
      components: [],
    }).catch(() => {});
  } catch (err) {
    await interaction.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
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
    // ❗ multi-select (AOE) cho chọn NHIỀU giá trị ⇒ "back" có thể KHÔNG nằm ở
    // vị trí đầu. Kiểm `[0]` là bỏ sót — đúng lý do Fragaria thấy lỗi này "chỉ áp
    // dụng với skill AOE".
    if (interaction.values.includes("back")) {
      const encBackTarget = await getEncounter(channelId);
      const combatantBackTarget = encBackTarget?.players?.[interaction.user.id];
      if (!combatantBackTarget) return interaction.reply({ content: "⚠️ Bạn chưa tham gia encounter này.", flags: MessageFlags.Ephemeral }).catch(() => {});
      // GAP MỚI (xác nhận trực tiếp: "bấm vào skill/page sau đó back ra, hệ
      // thống sẽ vẫn tiếp tục reroll") — CỐ Ý KHÔNG xoá pendingCriticalRolls ở
      // đây — chính đường Back-rồi-chọn-lại là nơi exploit xảy ra, nên roll cũ
      // phải VẪN bị khoá (xem check ở nhánh "critical:" phía trên) cho tới khi
      // TTL tự hết hạn — không cung cấp lối tắt "Back = huỷ để roll lại".
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
        // GAP ĐÃ SỬA (xác nhận trực tiếp qua ảnh chụp: "Mặc dù có đạn nhưng M1
        // của Soldato Rifle không biến đổi nhờ Firing Passive") — dropdown Attack
        // (mode "auto") TRƯỚC ĐÂY không có cách nào truyền usebullet: yes (chỉ
        // tồn tại qua lệnh text tự gõ tay) — thêm field TUỲ CHỌN ("Có thể tiêu
        // đạn" — đúng tinh thần passive, KHÔNG bắt buộc), CHỈ hiện khi đang cầm
        // Soldato Rifle VÀ có ít nhất 1 viên trong súng.
        // Grace of God — ô chọn mặt dice đầu, CHỈ hiện khi đủ điều kiện.
        if (findWeaponAnywhere(combatant?.weaponName)?.caduceus
            && combatant?.hasPrescriptDevice && (combatant?.prescriptUnlockLevel ?? 0) >= 2
            && !combatant?.graceOfGodUsedThisTurn) {
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("caduceusface")
              .setLabel("Grace of God — chọn mặt dice đầu (1-9)".slice(0, 45))
              .setPlaceholder("Để trống = roll ngẫu nhiên như thường")
              .setStyle(TextInputStyle.Short).setRequired(false)));
        }
        if (combatant?.weaponName === "Soldato Rifle" && (combatant?.bulletStack ?? 0) > 0) {
          const useBulletInput = new TextInputBuilder()
            .setCustomId("usebullet")
            .setLabel(`Dùng đạn? (Firing: Pierce +4 dmg, còn ${combatant.bulletStack})`.slice(0, 45))
            .setPlaceholder("yes / để trống = cận chiến như thường").setStyle(TextInputStyle.Short).setRequired(false);
          modal.addComponents(new ActionRowBuilder().addComponents(useBulletInput));
        }
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
      const skillName = resolveShortToken(extra);
      const pendingKey = `${channelId}:${interaction.user.id}`;
      const pending = pendingCriticalRolls.get(pendingKey);
      if (!pending) {
        return interaction.reply({ content: "⚠️ Phiên roll đã hết hạn (quá 5 phút) — chọn lại từ dropdown hành động để roll mới.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      pendingCriticalRolls.delete(pendingKey); // single-use
      const { embed, skillRollEmbed } = await doPlayerHit(channelId, interaction.user.id, interaction.user.toString(), pending.dmgStr, targetStr, {
        prefilledVerify: {
          skillRollEmbed: pending.skillRollEmbed, skillKey: pending.skillKey, cooldownTurns: pending.cooldownTurns,
          emotionDelta: pending.emotionDelta, emotionPlus: pending.emotionPlus ?? 0, lightCost: pending.lightCost, sanityCost: pending.sanityCost,
          refSnippet: null, refLink: null, orlandoFuriosoBypassConsumed: pending.orlandoFuriosoBypassConsumed ?? false,
          effectiveBulletType: pending.effectiveBulletType, effectiveBulletCount: pending.effectiveBulletCount ?? 0,
        },
        // Re-Load: loại đạn người chơi chọn ở bước variant. doPlayerHit đọc param
        // `loadtype` (index.js) rồi gắn vào pendingAction.loadType — đây là mắt
        // xích TỪNG THIẾU khiến Page Re-Load luôn nạp đạn thường.
        ...(pending.loadType ? { loadtype: pending.loadType } : {}),
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
        content: "", // xoá text/mention cũ — update KHÔNG tự xoá field không truyền
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
        resultText = `🏁 **${encounter.enemies[enemyKey]?.name ?? enemyKey}** đã kết thúc lượt.${wrapped ? "\n> 🔄 Đã hết 1 vòng turn order — GM dùng nút **🔄 Kết thúc Turn** trong GM Panel để bắt đầu turn mới." : ""}`;
      });
      // Cùng bug với player endmyturn ở trên — thiếu trigger AI cho turn holder
      // MỚI (nếu GM bấm hộ 1 enemy KHÔNG aiControlled kết thúc lượt, người kế
      // tiếp trong turnOrder có thể LÀ 1 enemy aiControlled khác).
      maybeRunAiTurn(channelId).catch(() => {});
      await interaction.update({ content: "", embeds: [{ description: resultText, color: 0x95a5a6 }], components: [] }).catch(() => {});
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
        changes.push(`Text: "${beforeNote}" → **"${noteRaw || "(trống)"}"**`);
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

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("gmaddskillenemyselect:")) return;
  const [, channelId, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId && !ADMIN_IDS.has(interaction.user.id)) {
    return interaction.reply({ content: "⚠️ Chỉ người mở bảng điều khiển này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const enemyKey = interaction.values[0];
  // GAP MỚI (audit accessory.js/addenemyskill theo yêu cầu trực tiếp) — Bước
  // 2/2: modal nhập thông tin skill. Discord modal giới hạn TỐI ĐA 5 field —
  // addenemyskill (text command) có 7 tham số (name/dice/light/cd/tags/
  // narrative/sfx) nên GỘP light+cd vào 1 field và narrative+sfx vào 1 field
  // (phân cách bằng dấu phẩy/gạch đứng), parse lại ở lúc submit.
  const modal = new ModalBuilder()
    .setCustomId(`gmaddskillmodal:${channelId}:${enemyKey}`)
    .setTitle("📖 Add Skill riêng cho Enemy");
  const nameInput = new TextInputBuilder().setCustomId("name").setLabel("Tên skill").setPlaceholder("VD: Iron Fist").setStyle(TextInputStyle.Short).setRequired(true);
  const diceInput = new TextInputBuilder().setCustomId("dice").setLabel("Công thức dmg (dice)").setPlaceholder("VD: 40x2B").setStyle(TextInputStyle.Short).setRequired(true);
  const lightCdInput = new TextInputBuilder().setCustomId("lightcd").setLabel("Light cost, CD turn (tuỳ chọn)").setPlaceholder("VD: 3, 3 — để trống nếu không có").setStyle(TextInputStyle.Short).setRequired(false);
  const tagsInput = new TextInputBuilder().setCustomId("tags").setLabel("Tags (tuỳ chọn)").setPlaceholder("VD: guardbreak").setStyle(TextInputStyle.Short).setRequired(false);
  const narrativeSfxInput = new TextInputBuilder().setCustomId("narrativesfx").setLabel("Narrative | SFX file (tuỳ chọn)").setPlaceholder("VD: Mo dồn lực vào 1 cú đấm. | iron_fist.mp3").setStyle(TextInputStyle.Paragraph).setRequired(false);
  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(diceInput),
    new ActionRowBuilder().addComponents(lightCdInput),
    new ActionRowBuilder().addComponents(tagsInput),
    new ActionRowBuilder().addComponents(narrativeSfxInput),
  );
  await interaction.showModal(modal).catch(() => {});
});

// Submit modal Add Skill (bước 2/2) — TÁI DÙNG chính xác logic của lệnh text
// `-encounter addenemyskill` (cùng validate/cùng field customSkills), chỉ đổi
// nguồn input từ kv text sang Modal fields + dropdown đã chọn enemy trước đó.
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("gmaddskillmodal:")) return;
  const [, channelId, enemyKey] = interaction.customId.split(":");
  try {
    const name = interaction.fields.getTextInputValue("name").trim();
    const dice = interaction.fields.getTextInputValue("dice").trim();
    if (!name || !dice) throw new Error("Tên skill và công thức dmg không được để trống.");
    const lightCdRaw = (interaction.fields.getTextInputValue("lightcd") ?? "").trim();
    const [lightRaw, cdRaw] = lightCdRaw.split(",").map(s => (s ?? "").trim());
    const lightCost = parseInt(lightRaw ?? "", 10);
    const cooldownTurns = parseInt(cdRaw ?? "", 10);
    const tags = (interaction.fields.getTextInputValue("tags") ?? "").trim();
    const narrativeSfxRaw = (interaction.fields.getTextInputValue("narrativesfx") ?? "").trim();
    const [narrativeRaw, sfxRaw] = narrativeSfxRaw.split("|").map(s => (s ?? "").trim());
    const narrative = narrativeRaw ?? "";
    const sfx = sfxRaw ?? "";
    if (sfx && !fs.existsSync(path.join(__dirname, "assets", "audio", "sfx", sfx))) {
      throw new Error(`Không tìm thấy file \`${sfx}\` trong \`/assets/audio/sfx/\` — kiểm tra lại tên file/đã bỏ file vào repo chưa.`);
    }
    await withLock(encounterKey(channelId), async () => {
      const encounter = await getEncounter(channelId);
      if (!encounter) throw new Error("Encounter không còn tồn tại.");
      const enemy = encounter.enemies[enemyKey];
      if (!enemy) throw new Error(`Enemy "${enemyKey}" không còn tồn tại (có thể đã bị xoá).`);
      enemy.customSkills = enemy.customSkills ?? [];
      const idx = enemy.customSkills.findIndex(s => s.name.toLowerCase() === name.toLowerCase());
      const skillDef = {
        name, dice,
        lightCost: Number.isFinite(lightCost) && lightCost > 0 ? lightCost : 0,
        cooldownTurns: Number.isFinite(cooldownTurns) && cooldownTurns > 0 ? cooldownTurns : 0,
        tags, narrative, sfx: sfx || null,
      };
      if (idx === -1) enemy.customSkills.push(skillDef); else enemy.customSkills[idx] = skillDef;
      await saveEncounter(channelId, encounter);
      await interaction.reply({
        content: `✅ Đã thêm skill riêng **${name}** cho **${enemy.name}** (key: \`${enemyKey}\`).\n> Dice: \`${dice}\`${lightCost > 0 ? ` | Light: ${lightCost}` : ""}${cooldownTurns > 0 ? ` | CD: ${cooldownTurns} turn` : ""}${tags ? ` | Tags: ${tags}` : ""}${sfx ? ` | SFX: ${sfx}` : ""}\n> Dùng qua bossmenu/gmpanel (chọn "📖 Skill/Critical") hoặc \`-encounter enemyattack key: ${enemyKey} target: <...> customskill: ${name}\`.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    });
  } catch (err) {
    interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});


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

// ─── SELECT MENU (-balance: Weapon/Outfit/Accessory — equip ➕ VÀ gỡ ➖) ──────
// Fragaria: "sửa lại equip accessory và page ở balance giống kiểu consumable
// item có nút equip và gỡ khỏi loadout vì hiện tại nó khá clunky".
//
// 3 BUG của bản cũ được sửa cùng lúc ở đây:
//  (1) KHÔNG có đường gỡ qua UI — chỉ có lệnh text `-unequipaccessory <slot>`.
//  (2) Đầy 3 slot → `findIndex(s => !s)` trả -1 → code cũ ép `targetSlot = 0`
//      ⇒ GHI ĐÈ slot #1 mà người chơi không chọn. Giờ NÉM LỖI, không ghi đè.
//  (3) `exclusive` / `exclusiveType` KHÔNG được kiểm ở đường dropdown (chỉ lệnh
//      text `-equipaccessory` mới kiểm) ⇒ đeo được 2 "Nón Ánh Sáng" qua UI.
//      ⚠️ `exclusive: true` (Memories: Compassion) TRƯỚC ĐÂY KHÔNG ĐƯỢC ĐỌC Ở
//      BẤT KỲ ĐÂU trong repo — kể cả lệnh text. Nay chặn ở đây.
//
// THỨ TỰ XỬ LÝ: gỡ TRƯỚC, equip SAU — người chơi chọn "gỡ #1" + "equip X" cùng
// lượt thì X lấp đúng ô vừa trống. Làm ngược lại sẽ báo "đủ slot" một cách vô lý.
// AN TOÀN VỚI INDEX: `equippedAccessories` là mảng CỐ ĐỊNH 3 ô, gỡ = gán null
// (KHÔNG splice như consumable) nên index không xê dịch giữa các thao tác cùng lô.
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
    const results = [];
    const picks = interaction.values.filter(v => v !== "noop");
    if (picks.length === 0) {
      return interaction.editReply({ content: "⛔ Dòng đó chỉ là ghi chú, không phải lựa chọn. Gỡ bớt slot rồi thử lại." });
    }
    // Gỡ trước, equip sau (xem comment trên).
    const ordered = [
      ...picks.filter(v => v.startsWith("unacc:") || v.startsWith("unoutfit:") || v.startsWith("unsing:")),
      ...picks.filter(v => !v.startsWith("unacc:") && !v.startsWith("unoutfit:") && !v.startsWith("unsing:")),
    ];
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      data.equippedAccessories = data.equippedAccessories ?? [null, null, null];
      for (const raw of ordered) {
        const chosenType = raw.split(":")[0];
        const chosenName = raw.split(":").slice(1).join(":");
        try {
          if (chosenType === "unoutfit") {
            if (!data.equippedOutfit) throw new Error("Bạn không mặc outfit nào.");
            const removed = data.equippedOutfit;
            data.equippedOutfit = null;
            results.push(`🗑️ Đã gỡ Outfit **${removed}**.`);
            continue;
          }
          if (chosenType === "unsing") {
            if (!data.equippedSingularity) throw new Error("Bạn không mang Singularity nào.");
            const removedS = data.equippedSingularity;
            data.equippedSingularity = null;
            results.push(`🗑️ Đã gỡ Singularity **${removedS}**.`);
            continue;
          }
          if (chosenType === "singularity") {
            const sg = findSingularity ? findSingularity(chosenName) : null;
            if (!sg) throw new Error("Không tìm thấy Singularity này.");
            if ((data.items?.[sg.name] ?? 0) < 1) throw new Error("Không còn sở hữu — dùng lại `-balance` để cập nhật.");
            // ĐÚNG 1 SLOT: đeo món mới thì món cũ tự bị thay.
            const prevS = data.equippedSingularity;
            data.equippedSingularity = sg.name;
            results.push(`✅ Singularity **${sg.name}**${prevS && prevS !== sg.name ? ` *(thay **${prevS}**)*` : ""}.`);
            continue;
          }
          if (chosenType === "unacc") {
            // value = "unacc:<index>|<tên đã cắt 70 ký tự>" — cắt tên để tổng
            // value không vượt trần 100 ký tự của Discord; đối chiếu bằng
            // startsWith nên vẫn bắt được trường hợp loadout đã đổi giữa chừng.
            const sep = chosenName.indexOf("|");
            const idx = parseInt(chosenName.slice(0, sep), 10);
            const namePart = chosenName.slice(sep + 1);
            const cur = data.equippedAccessories[idx];
            if (!Number.isInteger(idx) || idx < 0 || idx > 2 || !cur || !String(cur).startsWith(namePart)) {
              throw new Error("Slot đã thay đổi — mở lại `-balance` rồi thử lại.");
            }
            data.equippedAccessories[idx] = null;
            results.push(`🗑️ Đã gỡ Accessory **${cur}** khỏi slot #${idx + 1}.`);
            continue;
          }
          const isUniversalChosen = chosenType === "weapon" && UNIVERSALLY_KNOWN_WEAPONS.has(chosenName.toLowerCase());
          if (!isUniversalChosen && (data.items?.[chosenName] ?? 0) < 1) throw new Error(`Không còn sở hữu — dùng lại \`-balance\` để cập nhật.`);
          if (chosenType === "weapon") {
            const weapon = findWeaponAnywhere(chosenName);
            if (!weapon) throw new Error("Không tìm thấy vũ khí này.");
            data.equippedWeapon = weapon.name;
            results.push(`✅ Vũ khí **${weapon.name}** (${weapon.weight}/${weapon.type}, Base Dmg ${weapon.baseDamage}).`);
          } else if (chosenType === "outfit") {
            const outfit = findOutfit(chosenName);
            if (!outfit) throw new Error("Không tìm thấy outfit này.");
            data.equippedOutfit = outfit.name;
            const r = outfit.resistance;
            results.push(`✅ Outfit **${outfit.name}** (Res: ${r.B}xB ${r.P}xP ${r.S}xS).`);
          } else if (chosenType === "accessory") {
            const accessory = findAccessory(chosenName);
            if (!accessory) throw new Error("Không tìm thấy accessory này.");
            // MỘT luật duy nhất cho cả dropdown lẫn lệnh text — xem
            // validateAccessoryEquip trong accessory.js. Trước đây 2 đường equip
            // kiểm KHÁC NHAU nên đeo được 2 Composition Tool qua dropdown.
            const vres = validateAccessoryEquip({
              accessory,
              equipped: data.equippedAccessories,
              ownedCount: data.items?.[accessory.name] ?? 0,
              owner: { faction: data.faction, title: data.title, equippedOutfit: data.equippedOutfit, injuries: data.injuries ?? [] },
            });
            if (!vres.ok) throw new Error(vres.reason);
            const targetSlot = data.equippedAccessories.findIndex(s2 => !s2);
            // KHÔNG ghi đè slot #1 khi đầy nữa (bug cũ) — báo rõ để người chơi
            // chủ động gỡ, đúng mô hình consumable (đủ 4 thì từ chối xếp thêm).
            if (targetSlot === -1) throw new Error(`Đã đủ 3/3 slot accessory — gỡ bớt 1 món trước (dropdown có sẵn dòng "➖ Gỡ Accessory").`);
            data.equippedAccessories[targetSlot] = accessory.name;
            const refineTier = data.accessoryRefine?.[accessory.name];
            results.push(`✅ Accessory **${accessory.name}**${refineTier ? ` *(Tinh Luyện ${refineTier})*` : ""} vào slot #${targetSlot + 1}.`);
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

// ─── SELECT MENU (-balance: Page & E.G.O Page — equip ➕ VÀ gỡ ➖) ────────────
// BỎ HẲN bước 2 "chọn slot 1–5" của bản cũ — đó chính là chỗ clunky. Slot của
// Page KHÔNG mang ý nghĩa cơ chế nào: `player-join-builder.js` đọc
// `(profileData.equippedPages ?? []).filter(Boolean)` nên thứ tự bị vứt đi hoàn
// toàn lúc vào trận. Giờ equip = lấp ô trống đầu tiên; muốn đổi chỗ thì gỡ rồi
// xếp lại, đúng mô hình consumable.
// Vẫn chấp nhận customId "balequipego:" — message CŨ đã gửi trước bản này vẫn
// còn dropdown đó, không được để người chơi bấm vào là im lặng.
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
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
    const results = [];
    const picks = interaction.values.filter(v => v !== "noop" && v !== "toomanypages");
    if (picks.length === 0) {
      return interaction.editReply({ content: "⛔ Dòng đó chỉ là ghi chú, không phải lựa chọn. Gỡ bớt slot rồi thử lại." });
    }
    const ordered = [
      ...picks.filter(v => v.startsWith("unpage:") || v.startsWith("unego:")),
      ...picks.filter(v => !v.startsWith("unpage:") && !v.startsWith("unego:")),
    ];
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      data.equippedPages = data.equippedPages ?? [null, null, null, null, null];
      data.equippedEgoPages = data.equippedEgoPages ?? [null, null, null, null, null];
      for (const raw of ordered) {
        const chosenType = raw.split(":")[0];
        const chosenName = raw.split(":").slice(1).join(":");
        try {
          if (chosenType === "unpage" || chosenType === "unego") {
            const listKey = chosenType === "unego" ? "equippedEgoPages" : "equippedPages";
            const sep = chosenName.indexOf("|");
            const idx = parseInt(chosenName.slice(0, sep), 10);
            const namePart = chosenName.slice(sep + 1);
            const cur = data[listKey][idx];
            if (!Number.isInteger(idx) || idx < 0 || idx > 4 || !cur || !String(cur).startsWith(namePart)) {
              throw new Error("Slot đã thay đổi — mở lại `-balance` rồi thử lại.");
            }
            data[listKey][idx] = null;
            results.push(`🗑️ Đã gỡ ${chosenType === "unego" ? "E.G.O " : ""}**${cur}** khỏi slot #${idx + 1}.`);
            continue;
          }
          const isEgo = chosenType === "egopage";
          const skill = findSkill(chosenName);
          if (!skill) throw new Error(`Không tìm thấy Page trong hệ thống.`);
          // Tra sở hữu theo ĐỊNH DANH SKILL (findOwnedPageKey) — kho `data.pages`
          // có thể lưu tên LỆCH với skill.name (5 page đã biết). So chuỗi thô sẽ
          // báo "chưa sở hữu" cho page họ thật sự có.
          if (!findOwnedPageKey(data.pages, skill)) throw new Error(`Không còn sở hữu — dùng lại \`-balance\` để cập nhật.`);
          const listKey = isEgo ? "equippedEgoPages" : "equippedPages";
          let targetSlot;
          let slotNote = "";
          if (isEgo) {
            // E.G.O Page: slot do TIER quyết định, không chọn tay được.
            const skillTier = getEgoTier(skill);
            if (!skillTier) throw new Error(`Không xác định được Tier của "${skill.name}".`);
            targetSlot = EGO_TIER_SLOT_ORDER.indexOf(skillTier);
            const occupying = data[listKey][targetSlot];
            slotNote = ` (Tier ${skillTier}${occupying && occupying !== skill.name ? `, thay **${occupying}**` : ""})`;
          } else {
            targetSlot = data[listKey].findIndex(s2 => !s2);
            if (targetSlot === -1) throw new Error(`Đã đủ 5/5 slot Page — gỡ bớt 1 page trước (dropdown có sẵn dòng "➖ Gỡ Page").`);
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

// ─── LOADOUT CONSUMABLE (balequipconsumable: / balunequipconsumable:) ───────
// Fragaria: "-balance chưa có chỗ để equip consumable item đem vào encounter".
// LUẬT: tối đa **4 item/trận**, và **mỗi turn chỉ dùng được 1 item**.
// Vế "1 lần/turn" đã có sẵn (`usedItemThisTurn` ở encounter-actions.js, reset ở
// turn-advance.js) — ở đây chỉ lo phần XẾP LOADOUT.
//
// Loadout lưu trên PROFILE (`data.equippedConsumables`) chứ không phải trên
// encounter: đặt 1 lần dùng cho mọi trận, giống weapon/outfit/accessory/page.
// `player-join-builder.js` chép sang `combatant.consumablesLoadout` lúc join và
// LỌC LẠI theo kho thật (có thể đã bán/dùng hết từ lúc xếp).
// KHÔNG trừ item lúc equip — item chỉ tiêu lúc DÙNG trong trận.
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  // Một dropdown DUY NHẤT cho cả xếp lẫn gỡ — Discord chặn cứng 5 action row
  // mỗi message, 2 dropdown riêng đẩy -balance lên 6 hàng và nuốt mất hàng cuối
  // (Fragaria báo: mất phần mở khoá perk).
  if (!interaction.customId.startsWith("balconsumable:")) return;
  const rawPick = interaction.values[0] ?? "";
  const isUnequip = rawPick.startsWith("del:");
  const ownerId = interaction.customId.split(":")[1];
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới sửa được loadout.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferUpdate().catch(() => {});
  try {
    let note = "";
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      data.equippedConsumables = data.equippedConsumables ?? [];
      if (isUnequip) {
        // value = "del:<index>|<tên>" — cần index vì có thể xếp NHIỀU món TRÙNG
        // TÊN, gỡ theo tên sẽ không biết gỡ cái nào.
        const raw = rawPick.slice(4);
        const sep = raw.indexOf("|");
        const idx = parseInt(raw.slice(0, sep), 10);
        const name = raw.slice(sep + 1);
        if (!Number.isInteger(idx) || data.equippedConsumables[idx] !== name) {
          throw new Error("Loadout đã thay đổi — mở lại `-balance` rồi thử lại.");
        }
        data.equippedConsumables.splice(idx, 1);
        note = `🗑️ Đã gỡ **${name}** khỏi loadout (còn ${data.equippedConsumables.length}/4).`;
      } else {
        const added = [], skipped = [];
        for (const raw of interaction.values) {
          const name = raw.slice(4); // bỏ tiền tố "add:"
          // CHỈ nhận item có cờ consumable (constants.js) — chặn Fixer's Note,
          // Sealed Book Cache, Perfect Cube… lọt vào loadout.
          if (!isConsumableItem(name)) { skipped.push(`${name} (không phải consumable)`); continue; }
          if (data.equippedConsumables.length >= 4) { skipped.push(`${name} (đã đủ 4 slot)`); continue; }
          const owned = data.items?.[name] ?? 0;
          const alreadyIn = data.equippedConsumables.filter(n => n === name).length;
          // Cùng luật với `-encounter additem`: xếp bao nhiêu cái cùng tên cũng
          // được, miễn KHÔNG vượt số đang sở hữu.
          if (alreadyIn >= owned) { skipped.push(`${name} (chỉ có ${owned} cái, đã xếp đủ)`); continue; }
          data.equippedConsumables.push(name);
          added.push(name);
        }
        if (added.length === 0 && skipped.length > 0) throw new Error(`Không xếp được: ${skipped.join(", ")}.`);
        note = `🎒 Đã xếp **${added.join("**, **")}** vào loadout (${data.equippedConsumables.length}/4).`
          + (skipped.length ? `\n> ⚠️ Bỏ qua: ${skipped.join(", ")}` : "");
      }
      await savePlayerData(ownerId, data, slot);
    });
    await interaction.editReply({
      content: `${note}\n> Mỗi turn trong trận chỉ dùng được **1 item**. Dùng lại \`-balance\` để xem cập nhật.`,
      components: [],
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}`, components: [] }).catch(() => {});
  }
});

// ─── (DI SẢN) balpageslot: — bước 2 "chọn slot" của bản CŨ ──────────────────
// -balance KHÔNG còn dựng dropdown này nữa (bước 2 chính là chỗ clunky Fragaria
// yêu cầu bỏ). GIỮ handler lại vì message CŨ đã gửi trước bản này vẫn còn
// dropdown đó trên màn hình người chơi — xoá handler = bấm vào thì Discord báo
// "This interaction failed" mà không ai hiểu vì sao.
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("balpageslot:")) return;
  const [, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "⚠️ Chỉ chủ nhân profile này mới chọn được.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  await interaction.deferUpdate().catch(() => {});
  try {
    const raw = interaction.values[0] ?? "";
    const sep = raw.indexOf("|");
    const slotIdx = parseInt(raw.slice(0, sep), 10);
    const chosenName = raw.slice(sep + 1);
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx > 4) throw new Error("Slot không hợp lệ.");
    let note = "";
    await withLock(ownerId, async () => {
      const { data, slot } = await getPlayerDataWithSlot(ownerId);
      // Tra sở hữu theo ĐỊNH DANH SKILL (xem findOwnedPageKey trong skills.js) —
      // kho có thể lưu tên cũ lệch với skill.name.
      const skill = findSkill(chosenName);
      if (!skill) throw new Error(`Không tìm thấy Page "${chosenName}".`);
      if (!findOwnedPageKey(data.pages, skill)) throw new Error("Không còn sở hữu — dùng lại `-balance`.");
      data.equippedPages = data.equippedPages ?? [null, null, null, null, null];
      const replaced = data.equippedPages[slotIdx];
      data.equippedPages[slotIdx] = skill.name;
      await savePlayerData(ownerId, data, slot);
      note = `✅ Đã equip **${skill.name}** vào slot #${slotIdx + 1}${replaced ? ` (thay **${replaced}**)` : ""}.`;
    });
    await interaction.editReply({ content: `${note}\n> Dùng lại \`-balance\` để xem cập nhật.`, components: [] });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}`, components: [] }).catch(() => {});
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

    const linkInfo = await createRtparryToken({ userId: interaction.user.id, channelId: interaction.channelId, messageId: sentMsg.id, skill: targetSkill });
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
      // Dice Up / Dice Down — hai option RIÊNG (đều ≥ 0) cho dễ hiểu, gộp lại
      // thành một số NET vì `buildSkillRollResult` đã nhận sẵn `diceModifier`
      // (cùng cơ chế `computeDiceModifier` mà encounter dùng). Không phải viết
      // logic dice mới — chỉ lộ ra thứ có sẵn.
      const diceUp = interaction.options.getInteger("diceup") ?? 0;
      const diceDown = interaction.options.getInteger("dicedown") ?? 0;
      const diceModifier = diceUp - diceDown;

      // Nhiều skill trong MỘT lượt — ngăn bằng `|`. Chọn `|` chứ không phải dấu
      // phẩy vì tên skill có thể chứa dấu phẩy ("Sever, Then Sunder").
      const names = nameInput.split("|").map(x => x.trim()).filter(Boolean);
      if (names.length === 0) {
        await interaction.editReply({ content: "❌ Bạn chưa nhập tên skill nào." });
        return;
      }
      if (names.length > SKILL_MAX_MULTI) {
        await interaction.editReply({ content: `❌ Tối đa **${SKILL_MAX_MULTI}** skill mỗi lệnh (bạn nhập ${names.length}).` });
        return;
      }
      // Tra CẢ danh sách TRƯỚC khi roll — sai một tên thì báo luôn, không roll
      // nửa vời rồi mới báo lỗi (người chơi sẽ không biết cái nào đã tính).
      const found = [];
      for (const n of names) {
        const sk = findSkill(n);
        if (!sk) {
          await interaction.editReply({ content: `❌ Không tìm thấy skill: \`${n}\`\nDùng \`/skill list\` để xem danh sách.` });
          return;
        }
        found.push(sk);
      }
      // `count` và `arg` áp cho TỪNG skill (mỗi skill tự clamp theo maxUses riêng).
      const embeds = [];
      for (const sk of found) {
        const r = buildSkillRollResult({ skill: sk, rollCount, promptArgRaw: argInput, forceDullahan, diceModifier });
        if (r.error) { await interaction.editReply({ content: `❌ **${sk.name}**: ${r.error.replace(/^❌\s*/, "")}` }); return; }
        embeds.push(r.embed);
      }
      const modNote = diceModifier !== 0
        ? `${diceModifier > 0 ? "🔼" : "🔽"} **Dice ${diceModifier > 0 ? "Up" : "Down"} ${Math.abs(diceModifier)}** áp cho mọi dice ở trên.`
        : "";
      await interaction.editReply({ content: modNote || undefined, embeds });
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
    // %DmgTaken — số hạng RIÊNG trong ngoặc, bão hoà riêng (saturateDmgTakenPct).
    const dmgTakenPct = interaction.options.getNumber("dmgtaken") ?? 0;
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
      dmgTakenPct,
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
      const result = await claimDailyLogin(interaction.user.id);
      if (result.alreadyDone) {
      // BUG ĐÃ SỬA (Fragaria: "-daily quest thứ 3 ra null"). TRƯỚC ĐÂY phần hiển
      // thị vẫn giả định 2 biến thể "ahn"/"books" TỰ HOÀN THÀNH, nên in
      // `result.task3AutoNote` — biến đó giờ luôn null (đã bỏ auto-complete để
      // nhiệm vụ 3 không còn "gõ -daily là xong"). Kết quả: "(null)" trên màn hình.
      // Giờ mô tả THỐNG NHẤT cho cả 3 biến thể: đều là hạ mob, chỉ khác ngưỡng và
      // phần thưởng (xem TASK3_KILL_TARGET_BY_VARIANT ở daily-quest.js).
      const task3Line = (d) => {
        const target = { killmobs: 3, books: 4, ahn: 5 }[d.task3Variant] ?? 3;
        const bonus = { ahn: " + 200.000 Ahn", books: " + 3 Random Book" }[d.task3Variant] ?? "";
        const done = Math.min(d.killCount ?? 0, target);
        return `${d.task3Done ? "✅" : "⬜"} Nhiệm vụ ngẫu nhiên: hạ **${target} mob/boss bất kỳ** (${done}/${target}) — +2 Exp${bonus} khi đủ`;
      };
      const d = result.data;
        const taskLines = [
          `${d.loginDone ? "✅" : "⬜"} Login hôm nay (\`/daily\`)`,
          `${d.contractDone ? "✅" : "⬜"} Hoàn thành 1 contract bất kỳ`,
          task3Line(d),
        ];
        await interaction.editReply({
          content: `${interaction.user}, bạn đã điểm danh hôm nay rồi.\n${taskLines.join("\n")}\n` +
            `🔥 Streak (đủ cả 3 nhiệm vụ liên tục): **${d.streak ?? 0}/7** ngày\n` +
            `Thời gian còn lại đến reset: **${result.hours}h ${result.minutes}m ${result.seconds}s**.`,
        });
        return;
      }
      const d = result.data;
      const taskLines = [
        `✅ Login hôm nay: +2 Exp`,
        `${d.contractDone ? "✅" : "⬜"} Hoàn thành 1 contract bất kỳ: +2 Exp`,
        task3Line(d),
      ];
      let replyMsg = `🎉 ${interaction.user} đã điểm danh thành công!\n${taskLines.join("\n")}\n🔥 Streak (đủ cả 3 nhiệm vụ liên tục 7 ngày): **${d.streak ?? 0}/7** ngày`;
      if (result.weeklyBonusNote) replyMsg += `\n\n${result.weeklyBonusNote}`;
      await interaction.editReply({ content: replyMsg });
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
      const activeChanSlash = await getUserActiveEncounterChannel(userId);
      if (activeChanSlash) {
        await interaction.reply({ content: `⚠️ Bạn đang trong 1 encounter (channel <#${activeChanSlash}>) — không thể đổi profile giữa trận.`, flags: MessageFlags.Ephemeral });
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

  // Trả ra NGOÀI để enemy-ai.js dùng CÙNG hàm này (qua aiHooks) — đường AI tự
  // phòng thủ cũng phải đính file BGM vào tin nhắn kết quả, nếu không thì đòn
  // Furioso đánh vào mob do AI điều khiển sẽ lại "im lặng" y như trước.
  // Bọc lại để nơi gọi bên ngoài (enemy-ai.js / reactive-defense.js qua aiHooks)
  // KHÔNG phải tự biết tới AttachmentBuilder — nó là DI của factory này.
  return { takePendingBgmFiles: (enc) => takePendingBgmFilesSafe(enc, AttachmentBuilder) };

};
