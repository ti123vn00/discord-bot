/**
 * combat-ui.js
 * Discord UI cho hệ thống combat — navigation menu
 *
 * PANEL LAYOUT:
 *   Main Panel  → [⚔️ Tấn Công] [🛡️ Phòng Thủ] [✦ Special]
 *   Tấn Công    → [Đánh Thường] [Page] [Critical] [Follow-Up] [E.G.O Page] [← Quay lại]
 *   Phòng Thủ   → [Guard] [Né] [Parry] [← Quay lại]
 *   Special     → [Shin/Mang] [Manifested E.G.O] [← Quay lại]
 *
 * BUGS FIXED (vs phiên bản cũ):
 *   #2  reply "Đánh" dùng result.modifiedDmg   → result.finalDmg
 *   #3  reply "Né"   dùng result.sta            → result.staCost
 *   #4  button Parry check result?.clash        → result?.success
 *   #5  boss selector / lookup dùng b.id        → b.bossId
 *   #6  Emotion Level 2 cộng dồn maxLight sai   → dùng baseMaxLight
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const {
  initCombatRedis,
  createBattle,
  addBoss,
  addPlayer,
  playerAttack,
  playerDodge,
  playerGuard,
  playerParry,
  playerActivateShin,
  endTurn,
  getBattle,
  saveBattle,
  formatParticipantStatus,
  formatBar,
} = require("./combat-system");

const { listWeapons, getWeapon } = require("./weapons");

// ─── Init ─────────────────────────────────────────────────────────────────────
function initCombatUI(redisClient, withTimeoutFn) {
  initCombatRedis(redisClient, withTimeoutFn);
}

// ─── Slash Command Definition ─────────────────────────────────────────────────

const COMBAT_COMMAND_DEF = new SlashCommandBuilder()
  .setName("combat")
  .setDescription("Quản lý trận đấu")
  .addSubcommand(sub =>
    sub.setName("create").setDescription("GM tạo trận đấu mới")
      .addStringOption(opt => opt.setName("battlename").setDescription("Tên trận").setRequired(true))
      .addStringOption(opt => opt.setName("bossname").setDescription("Tên boss đầu tiên").setRequired(true))
      .addIntegerOption(opt => opt.setName("bosshp").setDescription("HP boss").setRequired(true))
      .addIntegerOption(opt => opt.setName("bosssta").setDescription("Stamina boss (mặc định 100)").setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName("join").setDescription("Player tham gia trận đấu")
      .addStringOption(opt => opt.setName("battleid").setDescription("ID trận (từ GM)").setRequired(true))
      .addStringOption(opt => opt.setName("charname").setDescription("Tên nhân vật").setRequired(true))
      .addStringOption(opt => {
        const choices = listWeapons().map(w => ({ name: w.name, value: w.id }));
        return opt.setName("weapon").setDescription("Chọn vũ khí").setRequired(true).addChoices(...choices);
      })
      .addIntegerOption(opt => opt.setName("maxhp").setDescription("Max HP").setRequired(true))
      .addIntegerOption(opt => opt.setName("maxlight").setDescription("Max Light (mặc định 4)").setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName("addmob").setDescription("GM thêm boss/mob vào trận")
      .addStringOption(opt => opt.setName("battleid").setDescription("ID trận").setRequired(true))
      .addStringOption(opt => opt.setName("mobname").setDescription("Tên boss/mob").setRequired(true))
      .addIntegerOption(opt => opt.setName("hp").setDescription("HP").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("addplayer").setDescription("GM thêm player vào trận thủ công")
      .addStringOption(opt => opt.setName("battleid").setDescription("ID trận").setRequired(true))
      .addUserOption(opt => opt.setName("user").setDescription("User Discord của player").setRequired(true))
      .addStringOption(opt => opt.setName("charname").setDescription("Tên nhân vật").setRequired(true))
      .addStringOption(opt => {
        const choices = listWeapons().map(w => ({ name: w.name, value: w.id }));
        return opt.setName("weapon").setDescription("Chọn vũ khí").setRequired(true).addChoices(...choices);
      })
      .addIntegerOption(opt => opt.setName("maxhp").setDescription("Max HP").setRequired(true))
      .addIntegerOption(opt => opt.setName("maxlight").setDescription("Max Light (mặc định 4)").setRequired(false))
      .addIntegerOption(opt => opt.setName("maxsta").setDescription("Max Stamina (mặc định 100)").setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName("panel").setDescription("Mở panel GM hoặc player")
      .addStringOption(opt => opt.setName("battleid").setDescription("ID trận").setRequired(true))
  );

// ─── parseCustomId ────────────────────────────────────────────────────────────
// Format: action::battleId::playerId::extra
function parseCustomId(customId) {
  const parts = customId.split("::");
  return {
    action:   parts[0] ?? null,
    battleId: parts[1] ?? null,
    extra:    parts[2] ?? null,
    extra2:   parts[3] ?? null,
  };
}

// ─── PANEL BUILDERS ───────────────────────────────────────────────────────────

/**
 * Embed trạng thái player (dùng chung cho mọi trang)
 */
function buildPlayerEmbed(player, battle) {
  const status = formatParticipantStatus(player);
  const weapon = getWeapon(player.weapon);

  const stateNote = status.stateFlags !== "None" ? `\n${status.stateFlags}` : "";
  const emotionNote = player.emotionLevel > 0
    ? `\n🔥 Emotion Lv.${player.emotionLevel} (${player.emotionActiveTurns} turn)`
    : "";

  return new EmbedBuilder()
    .setTitle(`⚔️ ${player.name} — Turn ${battle.turnNumber}`)
    .setColor(0x3498db)
    .addFields(
      { name: "❤️ HP",          value: status.hpBar,    inline: false },
      { name: "⚡ Stamina",     value: status.staBar,   inline: false },
      { name: "💡 Light",       value: status.light,    inline: true  },
      { name: "🧠 Sanity",      value: status.sanity,   inline: true  },
      { name: "🛡️ Resistance", value: status.res,      inline: false },
      { name: "🔥 Effects",     value: status.effects,  inline: false },
      { name: "🎁 Buff",        value: status.buff,     inline: true  },
      { name: "🛑 Injury",      value: status.injuries, inline: true  }
    )
    .setFooter({ text: `Vũ khí: ${weapon?.name ?? player.weapon}${stateNote}${emotionNote}` });
}

/**
 * Trang chính: [⚔️ Tấn Công] [🛡️ Phòng Thủ] [✦ Special]
 */
function buildMainMenuComponents(battle, player) {
  const bid = battle.battleId;
  const pid = player.userId;
  const locked = player.isStaggered || player.isPanic;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`menu::${bid}::${pid}::attack`)
      .setLabel("⚔️ Tấn Công")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(locked),
    new ButtonBuilder()
      .setCustomId(`menu::${bid}::${pid}::defense`)
      .setLabel("🛡️ Phòng Thủ")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(locked),
    new ButtonBuilder()
      .setCustomId(`menu::${bid}::${pid}::special`)
      .setLabel("✦ Special")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(locked),
  );

  return [row];
}

/**
 * Trang Tấn Công:
 *   [Đánh Thường] [Page] [Critical] [Follow-Up] [E.G.O Page]
 *   [← Quay lại]
 * Discord cho tối đa 5 nút/row và 5 row → split thành 2 row
 */
function buildAttackMenuComponents(battle, player) {
  const bid = battle.battleId;
  const pid = player.userId;
  const weapon = getWeapon(player.weapon);
  const staCost = weapon?.staCost ?? 5;

  // Critical skill cooldown check
  const critCd = weapon?.critical ? (player.skillCd?.[`crit_${weapon.id}`] ?? 0) : 99;
  const critLabel = weapon?.critical
    ? (critCd > 0 ? `${weapon.critical.name} (CD: ${critCd})` : weapon.critical.name)
    : "Critical";

  // Light cost cho critical
  const critLightCost = weapon?.critical?.cost
    ? parseInt(weapon.critical.cost) : 3;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`action::${bid}::${pid}::normalatk`)
      .setLabel(`Đánh Thường (${staCost} Sta)`)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(player.sta < staCost),
    new ButtonBuilder()
      .setCustomId(`action::${bid}::${pid}::page`)
      .setLabel("Page")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true), // coming soon
    new ButtonBuilder()
      .setCustomId(`action::${bid}::${pid}::critical`)
      .setLabel(critLabel)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!weapon?.critical || critCd > 0 || player.light < critLightCost),
    new ButtonBuilder()
      .setCustomId(`action::${bid}::${pid}::followup`)
      .setLabel("Follow-Up")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true), // coming soon
    new ButtonBuilder()
      .setCustomId(`action::${bid}::${pid}::egopage`)
      .setLabel("E.G.O Page")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true), // coming soon
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`menu::${bid}::${pid}::main`)
      .setLabel("← Quay lại")
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
}

/**
 * Trang Phòng Thủ:
 *   [Guard] [Né] [Parry] [← Quay lại]
 */
function buildDefenseMenuComponents(battle, player) {
  const bid = battle.battleId;
  const pid = player.userId;

  const dodgeCost = player.injuries.includes("gãy-chân") ? 40 : 20;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`action::${bid}::${pid}::guard`)
      .setLabel("🛡️ Guard (10 Sta)")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(player.sta < 10),
    new ButtonBuilder()
      .setCustomId(`action::${bid}::${pid}::dodge`)
      .setLabel(`💨 Né (${dodgeCost} Sta)`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(player.sta < dodgeCost || player.injuries.includes("mất-chân")),
    new ButtonBuilder()
      .setCustomId(`action::${bid}::${pid}::parry`)
      .setLabel("🎯 Parry (0 Sta)")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`menu::${bid}::${pid}::main`)
      .setLabel("← Quay lại")
      .setStyle(ButtonStyle.Secondary),
  );

  return [row];
}

/**
 * Trang Special:
 *   [Shin/Mang] [Manifested E.G.O] [← Quay lại]
 */
function buildSpecialMenuComponents(battle, player) {
  const bid = battle.battleId;
  const pid = player.userId;

  const canShin = !player.isShinActive && player.sanity >= -10;
  const canEgo  = player.emotionLevel > 0 && player.emotionCooldown === 0;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`action::${bid}::${pid}::shin`)
      .setLabel("⬜ Shin/Mang (-25 Sanity)")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!canShin),
    new ButtonBuilder()
      .setCustomId(`action::${bid}::${pid}::manifestego`)
      .setLabel(`✨ Manifested E.G.O${player.emotionLevel > 0 ? ` (Lv.${player.emotionLevel})` : ""}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canEgo || player.isEgoManifested),
    new ButtonBuilder()
      .setCustomId(`menu::${bid}::${pid}::main`)
      .setLabel("← Quay lại")
      .setStyle(ButtonStyle.Secondary),
  );

  return [row];
}

/**
 * Helper: build embed + components cho một trang và update/reply interaction
 * mode: "reply" | "update"
 */
async function renderPage(interaction, battle, player, page, mode = "update") {
  const embed = buildPlayerEmbed(player, battle);
  let components;

  switch (page) {
    case "attack":  components = buildAttackMenuComponents(battle, player);  break;
    case "defense": components = buildDefenseMenuComponents(battle, player); break;
    case "special": components = buildSpecialMenuComponents(battle, player); break;
    default:        components = buildMainMenuComponents(battle, player);    break;
  }

  const payload = { embeds: [embed], components, ephemeral: true };

  if (mode === "reply") {
    await interaction.reply(payload);
  } else {
    await interaction.update(payload);
  }
}

// ─── GM Panel ─────────────────────────────────────────────────────────────────

async function showGMPanel(interaction, battle, asFollowUp = false) {
  const aliveBosses  = battle.bosses.filter(b => b.hp > 0);
  const alivePlayers = battle.participants.filter(p => p.hp > 0);

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ ${battle.battleName} — GM Panel (Turn ${battle.turnNumber})`)
    .setColor(0xe74c3c)
    .addFields(
      {
        name: "🐉 Bosses",
        value: battle.bosses.map(b =>
          b.hp <= 0
            ? `☠️ **${b.name}** — Dead`
            : `🐉 **${b.name}** HP: ${formatBar(b.hp, b.maxHp, 10)} Sta: ${b.sta}/${b.maxSta ?? 100}`
        ).join("\n") || "Không có",
      },
      {
        name: "⚔️ Players",
        value: battle.participants.map(p =>
          p.hp <= 0
            ? `☠️ **${p.name}** — Dead`
            : `⚔️ **${p.name}** HP: ${formatBar(p.hp, p.maxHp, 10)} Sta: ${p.sta}/${p.maxSta ?? 100}`
        ).join("\n") || "Chưa có",
      },
      {
        name: "📋 Recent Log",
        value: battle.log.slice(-6).map(l => `> ${l}`).join("\n") || "Trống",
      }
    )
    .setFooter({ text: `Battle ID: ${battle.battleId}` });

  const components = [];

  // Row: chọn boss (nếu ≥2)
  if (aliveBosses.length > 1) {
    const bossSelect = new StringSelectMenuBuilder()
      .setCustomId(`gm::selboss::${battle.battleId}`)
      .setPlaceholder("Chọn Boss sẽ hành động")
      // FIX #5: dùng b.bossId
      .addOptions(aliveBosses.map(b => ({
        label: b.name,
        description: `HP: ${b.hp}/${b.maxHp}`,
        value: b.bossId,
      })));
    components.push(new ActionRowBuilder().addComponents(bossSelect));
  }

  // Row: chọn target player
  if (alivePlayers.length > 0) {
    const targetSelect = new StringSelectMenuBuilder()
      .setCustomId(`gm::seltarget::${battle.battleId}`)
      .setPlaceholder("Chọn Target player")
      .addOptions(alivePlayers.map(p => ({
        label: p.name,
        description: `HP: ${p.hp}/${p.maxHp}`,
        value: p.userId,
      })));
    components.push(new ActionRowBuilder().addComponents(targetSelect));
  }

  // Row: boss actions
  // FIX #5: dùng bossId
  const defaultBossId = aliveBosses.length === 1 ? aliveBosses[0].bossId : "none";
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gm::bossatk::${battle.battleId}::${defaultBossId}`)
      .setLabel("⚔️ Boss Attack")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(aliveBosses.length === 0 || alivePlayers.length === 0),
    new ButtonBuilder()
      .setCustomId(`gm::bossguard::${battle.battleId}::${defaultBossId}`)
      .setLabel("🛡️ Boss Guard")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(aliveBosses.length === 0),
    new ButtonBuilder()
      .setCustomId(`gm::bossheal::${battle.battleId}::${defaultBossId}`)
      .setLabel("💊 Boss Heal")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(aliveBosses.length === 0),
    new ButtonBuilder()
      .setCustomId(`gm::endturn::${battle.battleId}`)
      .setLabel("⏭️ End Boss Turn")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`gm::endencounter::${battle.battleId}`)
      .setLabel("🏁 End Encounter")
      .setStyle(ButtonStyle.Secondary),
  ));

  const payload = { embeds: [embed], components, ephemeral: true };
  if (asFollowUp) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

// ─── Slash command handlers ───────────────────────────────────────────────────

async function handleCombatCreate(interaction) {
  const battleName = interaction.options.getString("battlename");
  const bossName   = interaction.options.getString("bossname");
  const bossHp     = interaction.options.getInteger("bosshp");
  const bossSta    = interaction.options.getInteger("bosssta") ?? 100;

  const battleId = await createBattle(interaction.user.id, battleName);
  await addBoss(battleId, { name: bossName, hp: bossHp, sta: bossSta });

  const battle = await getBattle(battleId);
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ ${battleName} — GM Panel`)
    .setColor(0xe74c3c)
    .setDescription(
      `Trận đấu được tạo bởi ${interaction.user}\n\n**Battle ID:** \`${battleId}\`\nGửi ID này cho players để họ join`
    )
    .addFields(
      { name: "🐉 Bosses", value: battle.bosses.map(b => `**${b.name}** — HP: ${b.hp}/${b.maxHp}`).join("\n") },
      { name: "⚔️ Players", value: "Chưa có" }
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCombatJoin(interaction) {
  const battleId = interaction.options.getString("battleid");
  const charName  = interaction.options.getString("charname");
  const weaponId  = interaction.options.getString("weapon");
  const maxHp     = interaction.options.getInteger("maxhp");
  const maxLight  = Math.min(6, interaction.options.getInteger("maxlight") ?? 4);

  const battle = await getBattle(battleId);
  if (!battle) { await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true }); return; }

  const weapon = getWeapon(weaponId);
  if (!weapon) { await interaction.reply({ content: "❌ Vũ khí không hợp lệ", ephemeral: true }); return; }

  const ok = await addPlayer(battleId, interaction.user.id, {
    name: charName, hp: maxHp, weaponId, maxLight,
  });
  if (!ok) {
    await interaction.reply({ content: "❌ Không thể tham gia (đã trong trận hoặc lỗi)", ephemeral: true });
    return;
  }

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ Tham gia thành công")
        .setColor(0x2ecc71)
        .setDescription(`${interaction.user} đã tham gia trận **${battle.battleName}**`)
        .addFields(
          { name: "Nhân vật", value: charName, inline: true },
          { name: "Vũ khí", value: `${weapon.name} (${weapon.type} — ${weapon.category})`, inline: true },
          { name: "HP", value: `${maxHp}/${maxHp}`, inline: true },
          { name: "Max Light", value: `${maxLight}`, inline: true }
        )
    ],
    ephemeral: true,
  });
}

async function handleCombatAddPlayer(interaction) {
  const battleId  = interaction.options.getString("battleid");
  const targetUser = interaction.options.getUser("user");
  const charName  = interaction.options.getString("charname");
  const weaponId  = interaction.options.getString("weapon");
  const maxHp     = interaction.options.getInteger("maxhp");
  const maxLight  = Math.min(6, interaction.options.getInteger("maxlight") ?? 4);
  const maxSta    = interaction.options.getInteger("maxsta") ?? 100;

  const battle = await getBattle(battleId);
  if (!battle) { await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true }); return; }
  if (battle.gmId !== interaction.user.id) { await interaction.reply({ content: "❌ Chỉ GM mới có thể thêm player", ephemeral: true }); return; }

  const weapon = getWeapon(weaponId);
  if (!weapon) { await interaction.reply({ content: "❌ Vũ khí không hợp lệ", ephemeral: true }); return; }

  if (battle.participants.find(p => p.userId === targetUser.id)) {
    await interaction.reply({ content: `❌ ${targetUser} đã có trong trận rồi`, ephemeral: true });
    return;
  }

  await addPlayer(battleId, targetUser.id, {
    name: charName, hp: maxHp, sta: maxSta, weaponId, maxLight,
  });

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ Thêm Player thành công")
        .setColor(0x2ecc71)
        .setDescription(`GM đã thêm ${targetUser} vào trận **${battle.battleName}**`)
        .addFields(
          { name: "Nhân vật", value: charName, inline: true },
          { name: "Vũ khí", value: weapon.name, inline: true },
          { name: "HP", value: `${maxHp}/${maxHp}`, inline: true },
          { name: "Max Sta", value: `${maxSta}`, inline: true },
          { name: "Max Light", value: `${maxLight}`, inline: true },
        )
        .setFooter({ text: `${targetUser.username} dùng /combat panel ${battleId} để mở panel` })
    ],
    ephemeral: false,
  });
}

async function handleCombatAddmob(interaction) {
  const battleId = interaction.options.getString("battleid");
  const mobName  = interaction.options.getString("mobname");
  const hp       = interaction.options.getInteger("hp");

  const battle = await getBattle(battleId);
  if (!battle || battle.gmId !== interaction.user.id) {
    await interaction.reply({ content: "❌ Bạn không phải GM của trận này", ephemeral: true });
    return;
  }

  await addBoss(battleId, { name: mobName, hp });
  await interaction.reply({
    content: `✅ **${mobName}** đã được thêm vào trận`,
    ephemeral: true,
  });
}

async function handleCombatPanel(interaction) {
  const battleId = interaction.options.getString("battleid");
  const battle   = await getBattle(battleId);
  if (!battle) { await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true }); return; }

  const isGM  = battle.gmId === interaction.user.id;
  const player = battle.participants.find(p => p.userId === interaction.user.id);

  if (player) {
    await renderPage(interaction, battle, player, "main", "reply");
    if (isGM) await showGMPanel(interaction, battle, true);
  } else if (isGM) {
    await showGMPanel(interaction, battle, false);
  } else {
    await interaction.reply({ content: "❌ Bạn không có trong trận này", ephemeral: true });
  }
}

// ─── GM Modals ────────────────────────────────────────────────────────────────

async function showBossAttackModal(interaction, battleId, bossId, prefillTarget) {
  const modal = new ModalBuilder()
    .setCustomId(`gmmodal::bossatk::${battleId}::${bossId}::${prefillTarget ?? "none"}`)
    .setTitle("Boss Attack");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("dmg")
        .setLabel("Sát thương (VD: 45)")
        .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(6)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("dmgtype")
        .setLabel("Loại dmg (Slash / Pierce / Blunt)")
        .setStyle(TextInputStyle.Short).setPlaceholder("Slash").setRequired(true).setMaxLength(10)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("target")
        .setLabel("Target userId (để trống nếu đã chọn dropdown)")
        .setStyle(TextInputStyle.Short).setPlaceholder(prefillTarget ?? "userId")
        .setRequired(!prefillTarget).setMaxLength(30)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("note")
        .setLabel("Ghi chú (tên skill boss, ...)")
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)
    ),
  );

  await interaction.showModal(modal);
}

async function showBossHealModal(interaction, battleId, bossId) {
  const modal = new ModalBuilder()
    .setCustomId(`gmmodal::bossheal::${battleId}::${bossId}`)
    .setTitle("Boss Heal");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("heal")
        .setLabel("Lượng HP hồi").setStyle(TextInputStyle.Short)
        .setPlaceholder("VD: 50").setRequired(true).setMaxLength(6)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("note")
        .setLabel("Ghi chú").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)
    ),
  );

  await interaction.showModal(modal);
}

// ─── GM selection state (in-memory, GM-session only) ─────────────────────────
const gmSelections = new Map();

function getGmSel(battleId, gmId) {
  const key = `${battleId}::${gmId}`;
  if (!gmSelections.has(key)) gmSelections.set(key, { bossId: null, targetUserId: null });
  return gmSelections.get(key);
}

// ─── Main interaction handler ─────────────────────────────────────────────────

async function handleCombatInteraction(interaction) {

  // ── Slash commands ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== "combat") return false;
    const sub = interaction.options.getSubcommand();
    try {
      switch (sub) {
        case "create":    await handleCombatCreate(interaction);    return true;
        case "join":      await handleCombatJoin(interaction);      return true;
        case "addplayer": await handleCombatAddPlayer(interaction); return true;
        case "addmob":    await handleCombatAddmob(interaction);    return true;
        case "panel":     await handleCombatPanel(interaction);     return true;
      }
    } catch (err) {
      console.error(`[combat slash][${sub}]`, err);
      const msg = { content: `❌ Lỗi: ${err.message}`, ephemeral: true };
      interaction.replied || interaction.deferred
        ? await interaction.followUp(msg)
        : await interaction.reply(msg);
    }
    return true;
  }

  // ── Select menus (GM) ───────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    const { action, battleId, extra } = parseCustomId(interaction.customId);
    if (action !== "gm") return false;

    const battle = await getBattle(battleId);
    if (!battle || battle.gmId !== interaction.user.id) {
      await interaction.reply({ content: "❌ Không có quyền", ephemeral: true });
      return true;
    }
    const sel = getGmSel(battleId, interaction.user.id);

    if (extra === "selboss") {
      sel.bossId = interaction.values[0];
      // FIX #5: lookup bằng bossId
      const boss = battle.bosses.find(b => b.bossId === sel.bossId);
      await interaction.reply({ content: `✅ Boss đã chọn: **${boss?.name ?? sel.bossId}**`, ephemeral: true });
      return true;
    }
    if (extra === "seltarget") {
      sel.targetUserId = interaction.values[0];
      const target = battle.participants.find(p => p.userId === sel.targetUserId);
      await interaction.reply({ content: `✅ Target: **${target?.name ?? sel.targetUserId}**`, ephemeral: true });
      return true;
    }
  }

  // ── Buttons ─────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const { action, battleId, extra: playerId, extra2: subAction } = parseCustomId(interaction.customId);

    const battle = await getBattle(battleId);
    if (!battle) {
      await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true });
      return true;
    }

    try {
      // ── Navigation: menu::battleId::playerId::page ──────────────────────────
      if (action === "menu") {
        // playerId = extra (3rd segment), subAction = extra2 (4th segment = page)
        const player = battle.participants.find(p => p.userId === playerId);
        if (!player) {
          await interaction.reply({ content: "❌ Không tìm thấy nhân vật", ephemeral: true });
          return true;
        }
        // Chỉ chính player đó mới được navigate
        if (interaction.user.id !== playerId) {
          await interaction.reply({ content: "❌ Đây không phải panel của bạn", ephemeral: true });
          return true;
        }
        await renderPage(interaction, battle, player, subAction ?? "main");
        return true;
      }

      // ── Player actions: action::battleId::playerId::subAction ───────────────
      if (action === "action") {
        const player = battle.participants.find(p => p.userId === playerId);
        if (!player) {
          await interaction.reply({ content: "❌ Không tìm thấy nhân vật", ephemeral: true });
          return true;
        }
        if (interaction.user.id !== playerId) {
          await interaction.reply({ content: "❌ Đây không phải panel của bạn", ephemeral: true });
          return true;
        }

        switch (subAction) {
          // ── Đánh thường ──
          case "normalatk": {
            const result = await playerAttack(battleId, playerId);
            if (result?.error) {
              await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
            } else {
              const critTxt = result.isCrit ? " ✨ **CRIT!**" : "";
              const staggerTxt = result.justStaggered ? "\n⚡ **STAGGER!** Không thể hành động turn kế tiếp" : "";
              await interaction.reply({
                content: `⚔️ **${result.player.name}** dùng **${result.weapon.name}**\nRoll: **${result.roll}**${critTxt} → DMG: **${result.finalDmg}**${staggerTxt}`,
                ephemeral: true,
              });
            }
            return true;
          }

          // ── Critical skill ──
          case "critical": {
            // TODO: implement critical skill system
            await interaction.reply({ content: "⚠️ Critical skill — coming soon", ephemeral: true });
            return true;
          }

          // ── Follow-Up / E.G.O Page ──
          case "followup":
          case "egopage":
          case "page": {
            await interaction.reply({ content: "⚠️ Coming soon", ephemeral: true });
            return true;
          }

          // ── Guard ──
          case "guard": {
            const result = await playerGuard(battleId, playerId);
            if (result?.error) {
              await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
            } else {
              await interaction.reply({ content: `🛡️ Guard đã bật (Sta: -10) — Giảm 90% dmg đòn tới`, ephemeral: true });
            }
            return true;
          }

          // ── Né ──
          case "dodge": {
            const result = await playerDodge(battleId, playerId);
            if (result?.error) {
              await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
            } else {
              // FIX #3: result.staCost
              await interaction.reply({ content: `💨 Né thành công (Sta: -${result.staCost}) — Không nhận sát thương`, ephemeral: true });
            }
            return true;
          }

          // ── Parry ──
          case "parry": {
            const result = await playerParry(battleId, playerId);
            if (result?.error) {
              await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
            } else {
              // FIX #4: result.success (không phải result.clash)
              if (result.success) {
                await interaction.reply({
                  content: `🎯 **Parry thành công!** [${result.playerRoll} vs ${result.bossRoll}]\n+10 Sanity — Không nhận sát thương`,
                  ephemeral: true,
                });
              } else {
                await interaction.reply({
                  content: `🎯 **Parry thất bại** [${result.playerRoll} vs ${result.bossRoll}]\n-${result.staPenalty} Sta, -10 Sanity — Nhận toàn bộ sát thương`,
                  ephemeral: true,
                });
              }
            }
            return true;
          }

          // ── Shin/Mang ──
          case "shin": {
            const result = await playerActivateShin(battleId, playerId);
            if (result?.error) {
              await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
            } else {
              await interaction.reply({
                content: `⬜ **Shin/Mang** kích hoạt!\n-25 Sanity | Res bản thân -0.2x | Dmg +10% (tăng thêm mỗi turn)`,
                ephemeral: true,
              });
            }
            return true;
          }

          // ── Manifested E.G.O ──
          case "manifestego": {
            // TODO: implement EGO manifest
            await interaction.reply({ content: "⚠️ Manifested E.G.O — coming soon", ephemeral: true });
            return true;
          }

          default:
            return false;
        }
      }

      // ── GM actions: gm::subAction::battleId::bossId ─────────────────────────
      if (action === "gm") {
        // Với GM buttons customId = gm::subAction::battleId::bossId
        // parseCustomId map: action=gm, battleId=subAction, extra=battleId(thật), extra2=bossId
        // → re-parse thủ công để lấy đúng
        const parts    = interaction.customId.split("::");
        const gmSub    = parts[1];
        const gmBattle = parts[2];
        const gmBossId = parts[3] ?? null;

        // Fetch lại battle bằng gmBattle (ID thật) thay vì battle đã fetch sai ở trên
        const gmBattleData = await getBattle(gmBattle);
        if (!gmBattleData) {
          await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true });
          return true;
        }
        if (gmBattleData.gmId !== interaction.user.id) {
          await interaction.reply({ content: "❌ Chỉ GM mới dùng được nút này", ephemeral: true });
          return true;
        }

        const sel = getGmSel(gmBattle, interaction.user.id);

        if (gmSub === "endturn") {
          await endTurn(gmBattle);
          sel.targetUserId = null;
          // Refresh GM panel
          const freshBattle = await getBattle(gmBattle);
          await interaction.reply({ content: `✅ End Boss Turn → Turn ${freshBattle.turnNumber} bắt đầu`, ephemeral: true });
          return true;
        }

        if (gmSub === "endencounter") {
          const freshBattle = await getBattle(gmBattle);
          const summary = freshBattle.participants.map(p => {
            p.sta = p.maxSta ?? 100;
            return `${p.hp > 0 ? "✅" : "☠️"} **${p.name}** — HP: ${Math.max(0, p.hp)}/${p.maxHp}`;
          }).join("\n") || "Không có player";
          const bossSummary = freshBattle.bosses.map(b =>
            `${b.hp <= 0 ? "☠️" : "🐉"} **${b.name}** — HP: ${Math.max(0, b.hp)}/${b.maxHp}`
          ).join("\n") || "Không có boss";

          freshBattle.ended = true;
          freshBattle.log.push(`[Turn ${freshBattle.turnNumber}] 🏁 Encounter kết thúc bởi GM`);
          await saveBattle(freshBattle);

          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle(`🏁 Encounter Kết Thúc — ${freshBattle.battleName}`)
                .setColor(0x95a5a6)
                .addFields(
                  { name: "⚔️ Players", value: summary },
                  { name: "🐉 Bosses", value: bossSummary },
                  { name: "📊 Turn", value: `${freshBattle.turnNumber}` },
                )
                .setFooter({ text: "Stamina player đã được hồi đầy. HP giữ nguyên." })
            ],
            ephemeral: false,
          });
          return true;
        }

        if (gmSub === "bossguard") {
          // FIX #5: tìm bằng bossId
          const bossId = sel.bossId ?? gmBossId;
          const freshBattle = await getBattle(gmBattle);
          const boss = freshBattle.bosses.find(b => b.bossId === bossId)
            ?? freshBattle.bosses.find(b => b.hp > 0);
          if (!boss) { await interaction.reply({ content: "❌ Không tìm thấy boss", ephemeral: true }); return true; }
          boss.guarding = true;
          await saveBattle(freshBattle);
          await interaction.reply({ content: `🛡️ **${boss.name}** đang Guard`, ephemeral: false });
          return true;
        }

        if (gmSub === "bossatk") {
          const bossId = sel.bossId ?? gmBossId;
          const freshBattle = await getBattle(gmBattle);
          const boss = freshBattle.bosses.find(b => b.bossId === bossId)
            ?? freshBattle.bosses.find(b => b.hp > 0);
          if (!boss) { await interaction.reply({ content: "❌ Không tìm thấy boss", ephemeral: true }); return true; }
          await showBossAttackModal(interaction, gmBattle, boss.bossId, sel.targetUserId);
          return true;
        }

        if (gmSub === "bossheal") {
          const bossId = sel.bossId ?? gmBossId;
          const freshBattle = await getBattle(gmBattle);
          const boss = freshBattle.bosses.find(b => b.bossId === bossId)
            ?? freshBattle.bosses.find(b => b.hp > 0);
          if (!boss) { await interaction.reply({ content: "❌ Không tìm thấy boss", ephemeral: true }); return true; }
          await showBossHealModal(interaction, gmBattle, boss.bossId);
          return true;
        }

        return false;
      }

    } catch (err) {
      console.error("[combat button]", err);
      const msg = { content: `❌ Lỗi: ${err.message}`, ephemeral: true };
      interaction.replied || interaction.deferred
        ? await interaction.followUp(msg)
        : await interaction.reply(msg);
    }
  }

  // ── Modals ───────────────────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    const parts = interaction.customId.split("::");
    // format: gmmodal::subAction::battleId::bossId::prefillTarget
    const [prefix, subAction, battleId, bossId, prefillTarget] = parts;
    if (prefix !== "gmmodal") return false;

    const battle = await getBattle(battleId);
    if (!battle || battle.gmId !== interaction.user.id) {
      await interaction.reply({ content: "❌ Không có quyền", ephemeral: true });
      return true;
    }

    try {
      if (subAction === "bossatk") {
        const rawDmg      = parseInt(interaction.fields.getTextInputValue("dmg"), 10);
        const dmgTypeRaw  = interaction.fields.getTextInputValue("dmgtype").trim() || "Slash";
        const targetInput = interaction.fields.getTextInputValue("target").trim();
        const note        = interaction.fields.getTextInputValue("note").trim();

        if (isNaN(rawDmg) || rawDmg < 0) {
          await interaction.reply({ content: "❌ Dmg không hợp lệ", ephemeral: true }); return true;
        }

        const targetUserId = targetInput || (prefillTarget !== "none" ? prefillTarget : null);
        const target = battle.participants.find(p => p.userId === targetUserId);
        if (!target) {
          await interaction.reply({ content: "❌ Không tìm thấy target — chọn từ dropdown rồi thử lại", ephemeral: true });
          return true;
        }

        // FIX #5: tìm boss bằng bossId
        const boss = battle.bosses.find(b => b.bossId === bossId) ?? battle.bosses.find(b => b.hp > 0);

        const resKeyMap = { slash: "S", pierce: "P", blunt: "B" };
        const resKey   = resKeyMap[dmgTypeRaw.toLowerCase()] ?? "S";
        const resMulti = target.res?.[resKey] ?? 1;
        const isGuarding = !!(target.isGuarding || target.guarding);
        const finalDmg = Math.round(rawDmg * resMulti * (isGuarding ? 0.1 : 1));

        target.hp = Math.max(0, target.hp - finalDmg);
        target.isGuarding = false;
        target.guarding   = false;

        // Injury check (dùng finalDmg thực tế, không phải rawDmg)
        let injuryNote = "";
        if (finalDmg > target.maxHp * 0.3) {
          const roll = Math.random() * 100;
          if (roll < 10) {
            const heavyChoices = ["mất-tay", "mất-chân", "vết-thương-lớn"];
            const injury = heavyChoices[Math.floor(Math.random() * heavyChoices.length)];
            if (injury === "vết-thương-lớn") {
              target.maxHp = Math.max(1, target.maxHp - 100);
              target.hp = Math.min(target.hp, target.maxHp);
              injuryNote = `💀 Chấn thương nặng: **Vết Thương Lớn** (Max HP -100 → ${target.maxHp})`;
            } else if (!target.injuries.includes(injury)) {
              target.injuries.push(injury);
              injuryNote = `💀 Chấn thương nặng: **${injury}**`;
            }
          } else if (roll < 50) {
            const lightChoices = ["gãy-tay", "gãy-chân", "gãy-xương", "choáng"];
            const injury = lightChoices[Math.floor(Math.random() * lightChoices.length)];
            if (injury === "gãy-xương") {
              target.maxHp = Math.max(1, target.maxHp - 30);
              target.hp = Math.min(target.hp, target.maxHp);
              injuryNote = `🩹 Chấn thương nhẹ: **Gãy Xương** (Max HP -30 → ${target.maxHp})`;
            } else if (injury === "choáng") {
              target.stunsStacks = (target.stunsStacks ?? 0) + 1;
              injuryNote = `🩹 Chấn thương nhẹ: **Choáng** (Stack ${target.stunsStacks}/2)`;
            } else if (!target.injuries.includes(injury)) {
              target.injuries.push(injury);
              injuryNote = `🩹 Chấn thương nhẹ: **${injury}**`;
            }
          }
        }

        // Panic check sau khi nhận dmg
        if (target.sanity !== undefined && target.sanity <= -45 && !target.isPanic) {
          target.isPanic = true;
          injuryNote += (injuryNote ? "\n" : "") + `😱 **${target.name}** PANIC — Không thể hành động 1 turn`;
        }

        const logLine = `[T${battle.turnNumber}] 🐉 ${boss?.name ?? "Boss"} → ${target.name}: ${rawDmg}×${resMulti}${isGuarding ? "×0.1G" : ""} = **${finalDmg}**${note ? ` (${note})` : ""}`;
        battle.log.push(logLine);
        if (injuryNote) battle.log.push(injuryNote);
        if (battle.log.length > 20) battle.log.shift();
        await saveBattle(battle);

        const lines = [
          `🐉 **${boss?.name ?? "Boss"}** tấn công **${target.name}**`,
          `> ${rawDmg} ${dmgTypeRaw} × ${resMulti}x${isGuarding ? " × 0.1 Guard" : ""} = **${finalDmg} DMG**`,
          `> HP còn lại: ${target.hp}/${target.maxHp}`,
        ];
        if (note) lines.push(`> _${note}_`);
        if (injuryNote) lines.push(`> ${injuryNote}`);
        if (target.hp <= 0) lines.push(`> ☠️ **${target.name} đã chết!**`);

        await interaction.reply({ content: lines.join("\n"), ephemeral: false });
        return true;
      }

      if (subAction === "bossheal") {
        const healAmt = parseInt(interaction.fields.getTextInputValue("heal"), 10);
        const note    = interaction.fields.getTextInputValue("note").trim();

        if (isNaN(healAmt) || healAmt <= 0) {
          await interaction.reply({ content: "❌ Lượng heal không hợp lệ", ephemeral: true }); return true;
        }

        // FIX #5: tìm bằng bossId
        const boss = battle.bosses.find(b => b.bossId === bossId) ?? battle.bosses.find(b => b.hp > 0);
        if (!boss) { await interaction.reply({ content: "❌ Không tìm thấy boss", ephemeral: true }); return true; }

        const before = boss.hp;
        boss.hp = Math.min(boss.maxHp, boss.hp + healAmt);
        const actual = boss.hp - before;

        battle.log.push(`[T${battle.turnNumber}] 💊 ${boss.name} hồi ${actual} HP → ${boss.hp}/${boss.maxHp}`);
        if (battle.log.length > 20) battle.log.shift();
        await saveBattle(battle);

        await interaction.reply({
          content: `💊 **${boss.name}** hồi **${actual} HP** (${before} → ${boss.hp}/${boss.maxHp})${note ? `\n> _${note}_` : ""}`,
          ephemeral: false,
        });
        return true;
      }
    } catch (err) {
      console.error("[combat modal]", err);
      const msg = { content: `❌ Lỗi: ${err.message}`, ephemeral: true };
      interaction.replied || interaction.deferred
        ? await interaction.followUp(msg)
        : await interaction.reply(msg);
    }
  }

  return false;
}

module.exports = {
  COMBAT_COMMAND_DEF,
  handleCombatInteraction,
  initCombatUI,
};
