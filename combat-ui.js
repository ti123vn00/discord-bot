/**
 * combat-ui.js
 * Discord UI cho hệ thống combat: embeds, buttons, modals, slash commands
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
  createBattle,
  addBoss,
  addPlayer,
  playerAttack,
  playerDodge,
  playerGuard,
  playerParry,
  endTurn,
  getBattle,
  formatParticipantStatus,
  formatBar,
} = require("./combat-system");

const { listWeapons, getWeapon } = require("./weapons");

/**
 * Slash Command Definition
 */
const COMBAT_COMMAND_DEF = new SlashCommandBuilder()
  .setName("combat")
  .setDescription("Quản lý trận đấu")
  .addSubcommand(sub =>
    sub
      .setName("create")
      .setDescription("GM tạo trận đấu mới")
      .addStringOption(opt => opt.setName("battlename").setDescription("Tên trận").setRequired(true))
      .addStringOption(opt => opt.setName("bossname").setDescription("Tên boss đầu tiên").setRequired(true))
      .addIntegerOption(opt => opt.setName("bosshp").setDescription("HP boss").setRequired(true))
      .addIntegerOption(opt => opt.setName("bosssta").setDescription("Stamina boss (mặc định 100)").setRequired(false))
  )
  .addSubcommand(sub =>
    sub
      .setName("join")
      .setDescription("Player tham gia trận đấu")
      .addStringOption(opt => opt.setName("battleid").setDescription("ID trận (từ GM)").setRequired(true))
      .addStringOption(opt => opt.setName("charname").setDescription("Tên nhân vật").setRequired(true))
      .addStringOption(opt => {
        const weaponChoices = listWeapons().map(w => ({ name: w.name, value: w.id }));
        return opt.setName("weapon").setDescription("Chọn vũ khí").setRequired(true).addChoices(...weaponChoices);
      })
      .addIntegerOption(opt => opt.setName("maxhp").setDescription("Max HP").setRequired(true))
      .addIntegerOption(opt => opt.setName("maxlight").setDescription("Max Light (mặc định 4)").setRequired(false))
  )
  .addSubcommand(sub =>
    sub
      .setName("addmob")
      .setDescription("GM thêm boss/mob vào trận")
      .addStringOption(opt => opt.setName("battleid").setDescription("ID trận").setRequired(true))
      .addStringOption(opt => opt.setName("mobname").setDescription("Tên boss/mob").setRequired(true))
      .addIntegerOption(opt => opt.setName("hp").setDescription("HP").setRequired(true))
  )
  .addSubcommand(sub =>
    sub
      .setName("addplayer")
      .setDescription("GM thêm player vào trận thủ công")
      .addStringOption(opt => opt.setName("battleid").setDescription("ID trận").setRequired(true))
      .addUserOption(opt => opt.setName("user").setDescription("User Discord của player").setRequired(true))
      .addStringOption(opt => opt.setName("charname").setDescription("Tên nhân vật").setRequired(true))
      .addStringOption(opt => {
        const weaponChoices = listWeapons().map(w => ({ name: w.name, value: w.id }));
        return opt.setName("weapon").setDescription("Chọn vũ khí").setRequired(true).addChoices(...weaponChoices);
      })
      .addIntegerOption(opt => opt.setName("maxhp").setDescription("Max HP").setRequired(true))
      .addIntegerOption(opt => opt.setName("maxlight").setDescription("Max Light (mặc định 4)").setRequired(false))
      .addIntegerOption(opt => opt.setName("maxsta").setDescription("Max Stamina (mặc định 100)").setRequired(false))
  )
  .addSubcommand(sub =>
    sub
      .setName("panel")
      .setDescription("Mở panel GM hoặc player")
      .addStringOption(opt => opt.setName("battleid").setDescription("ID trận").setRequired(true))
  );

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse customId dạng "action::battleId::extra"
 * Dùng :: thay vì _ để tránh conflict với battleId chứa dấu _
 */
function parseCustomId(customId) {
  const parts = customId.split("::");
  return {
    action: parts[0],
    battleId: parts[1] ?? null,
    extra: parts[2] ?? null,
    extra2: parts[3] ?? null,
  };
}

// ─── Slash command handlers ──────────────────────────────────────────────────

async function handleCombatCreate(interaction) {
  const battleName = interaction.options.getString("battlename");
  const bossName = interaction.options.getString("bossname");
  const bossHp = interaction.options.getInteger("bosshp");
  const bossSta = interaction.options.getInteger("bosssta") ?? 100;

  const battleId = createBattle(interaction.user.id, battleName);
  addBoss(battleId, { name: bossName, hp: bossHp, sta: bossSta });

  const battle = getBattle(battleId);
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ ${battleName} - GM Panel`)
    .setColor(0xe74c3c)
    .setDescription(
      `Trận đấu được tạo bởi ${interaction.user}\n\n**Battle ID:** \`${battleId}\`\nGửi ID này cho players để họ join trận`
    )
    .addFields(
      { name: "🐉 Bosses", value: battle.bosses.map(b => `**${b.name}** - HP: ${b.hp}/${b.maxHp}`).join("\n") },
      { name: "⚔️ Players", value: "Chưa có" }
    )
    .setFooter({ text: "Dùng /combat addplayer hoặc /combat join để thêm player" });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCombatJoin(interaction) {
  const battleId = interaction.options.getString("battleid");
  const charName = interaction.options.getString("charname");
  const weaponId = interaction.options.getString("weapon");
  const maxHp = interaction.options.getInteger("maxhp");
  const maxLight = interaction.options.getInteger("maxlight") ?? 4;

  const battle = getBattle(battleId);
  if (!battle) { await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true }); return; }

  const weapon = getWeapon(weaponId);
  if (!weapon) { await interaction.reply({ content: "❌ Vũ khí không hợp lệ", ephemeral: true }); return; }

  addPlayer(battleId, interaction.user.id, {
    name: charName, hp: maxHp, weaponId, maxLight: Math.min(6, maxLight),
  });

  const embed = new EmbedBuilder()
    .setTitle(`✅ Tham gia thành công`)
    .setColor(0x2ecc71)
    .setDescription(`${interaction.user} đã tham gia trận **${battle.battleName}**`)
    .addFields(
      { name: "Nhân vật", value: charName },
      { name: "Vũ khí", value: `${weapon.name} (${weapon.type} - ${weapon.category})` },
      { name: "HP", value: `${maxHp}/${maxHp}` },
      { name: "Max Light", value: `${maxLight}` }
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCombatAddPlayer(interaction) {
  const battleId = interaction.options.getString("battleid");
  const targetUser = interaction.options.getUser("user");
  const charName = interaction.options.getString("charname");
  const weaponId = interaction.options.getString("weapon");
  const maxHp = interaction.options.getInteger("maxhp");
  const maxLight = interaction.options.getInteger("maxlight") ?? 4;
  const maxSta = interaction.options.getInteger("maxsta") ?? 100;

  const battle = getBattle(battleId);
  if (!battle) { await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true }); return; }
  if (battle.gmId !== interaction.user.id) { await interaction.reply({ content: "❌ Chỉ GM mới có thể thêm player", ephemeral: true }); return; }

  const weapon = getWeapon(weaponId);
  if (!weapon) { await interaction.reply({ content: "❌ Vũ khí không hợp lệ", ephemeral: true }); return; }

  const alreadyIn = battle.participants.find(p => p.userId === targetUser.id);
  if (alreadyIn) {
    await interaction.reply({ content: `❌ ${targetUser} đã có trong trận rồi (nhân vật: **${alreadyIn.name}**)`, ephemeral: true });
    return;
  }

  addPlayer(battleId, targetUser.id, { name: charName, hp: maxHp, maxSta, weaponId, maxLight: Math.min(6, maxLight) });

  const embed = new EmbedBuilder()
    .setTitle("✅ Thêm Player thành công")
    .setColor(0x2ecc71)
    .setDescription(`GM đã thêm ${targetUser} vào trận **${battle.battleName}**`)
    .addFields(
      { name: "Nhân vật", value: charName, inline: true },
      { name: "Vũ khí", value: `${weapon.name} (${weapon.type})`, inline: true },
      { name: "HP", value: `${maxHp}/${maxHp}`, inline: true },
      { name: "Max Stamina", value: `${maxSta}`, inline: true },
      { name: "Max Light", value: `${Math.min(6, maxLight)}`, inline: true },
    )
    .setFooter({ text: `${targetUser.username} dùng /combat panel ${battleId} để mở panel` });

  await interaction.reply({ embeds: [embed], ephemeral: false });
}

async function handleCombatAddmob(interaction) {
  const battleId = interaction.options.getString("battleid");
  const mobName = interaction.options.getString("mobname");
  const hp = interaction.options.getInteger("hp");

  const battle = getBattle(battleId);
  if (!battle || battle.gmId !== interaction.user.id) {
    await interaction.reply({ content: "❌ Bạn không phải GM của trận này", ephemeral: true });
    return;
  }

  addBoss(battleId, { name: mobName, hp });

  const embed = new EmbedBuilder()
    .setTitle("✅ Thêm Boss thành công")
    .setColor(0x2ecc71)
    .setDescription(`**${mobName}** đã được thêm vào trận\n\nHiện tại: ${battle.bosses.length} boss(es)`);

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCombatPanel(interaction) {
  const battleId = interaction.options.getString("battleid");
  const battle = getBattle(battleId);
  if (!battle) { await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true }); return; }

  const isGM = battle.gmId === interaction.user.id;
  const player = battle.participants.find(p => p.userId === interaction.user.id);

  if (player) {
    await showPlayerPanel(interaction, battle, player);
    if (isGM) await showGMPanel(interaction, battle, true); // followUp
  } else if (isGM) {
    await showGMPanel(interaction, battle, false);
  } else {
    await interaction.reply({ content: "❌ Bạn không có trong trận này", ephemeral: true });
  }
}

// ─── Panel builders ──────────────────────────────────────────────────────────

/**
 * GM Panel — hiển thị overview + boss action controls
 * @param {boolean} asFollowUp - true nếu reply đã dùng (GM là player)
 */
async function showGMPanel(interaction, battle, asFollowUp = false) {
  const aliveBosses = battle.bosses.filter(b => b.hp > 0);
  const alivePlayers = battle.participants.filter(p => p.hp > 0);

  // ── Embed overview ──
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ ${battle.battleName} — GM Panel (Turn ${battle.turnNumber})`)
    .setColor(0xe74c3c)
    .addFields(
      {
        name: "🐉 Bosses",
        value: battle.bosses.map(b =>
          `**${b.name}** ${b.hp <= 0 ? "☠️ Dead" : `HP: ${formatBar(b.hp, b.maxHp, 10)} Sta: ${b.sta}/${b.maxSta ?? 100}`}`
        ).join("\n") || "Không có",
        inline: false,
      },
      {
        name: "⚔️ Players",
        value: battle.participants.map(p =>
          `**${p.name}** ${p.hp <= 0 ? "☠️ Dead" : `HP: ${formatBar(p.hp, p.maxHp, 10)} Sta: ${p.sta}/${p.maxSta ?? 100}`}`
        ).join("\n") || "Chưa có",
        inline: false,
      },
      {
        name: "📋 Recent Log",
        value: battle.log.slice(-6).map(l => `> ${l}`).join("\n") || "Trống",
        inline: false,
      }
    )
    .setFooter({ text: `Battle ID: ${battle.battleId}` });

  const components = [];

  // ── Row 1: Chọn Boss đang hành động (nếu có ≥2 boss sống) ──
  if (aliveBosses.length > 1) {
    const bossSelect = new StringSelectMenuBuilder()
      .setCustomId(`gm::selboss::${battle.battleId}`)
      .setPlaceholder("Chọn Boss sẽ hành động")
      .addOptions(aliveBosses.map(b => ({
        label: b.name,
        description: `HP: ${b.hp}/${b.maxHp} | Sta: ${b.sta}`,
        value: b.id ?? b.name,
      })));
    components.push(new ActionRowBuilder().addComponents(bossSelect));
  }

  // ── Row 2: Chọn Target Player (nếu có player) ──
  if (alivePlayers.length > 0) {
    const targetSelect = new StringSelectMenuBuilder()
      .setCustomId(`gm::seltarget::${battle.battleId}`)
      .setPlaceholder("Chọn Target (player sẽ nhận đòn)")
      .addOptions(alivePlayers.map(p => ({
        label: p.name,
        description: `HP: ${p.hp}/${p.maxHp} | Sta: ${p.sta}`,
        value: p.userId,
      })));
    components.push(new ActionRowBuilder().addComponents(targetSelect));
  }

  // ── Row 3: Boss action buttons ──
  // Boss index mặc định là 0 nếu chỉ có 1 boss
  const defaultBossId = aliveBosses.length === 1 ? (aliveBosses[0].id ?? aliveBosses[0].name) : "0";
  const actionRow = new ActionRowBuilder().addComponents(
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
  );
  components.push(actionRow);

  const payload = { embeds: [embed], components, ephemeral: true };
  if (asFollowUp) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

async function showPlayerPanel(interaction, battle, player) {
  const status = formatParticipantStatus(player);
  const weapon = getWeapon(player.weapon);

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ ${player.name} — Combat Panel`)
    .setColor(0x3498db)
    .addFields(
      { name: "❤️ HP", value: status.hpBar, inline: false },
      { name: "⚡ Stamina", value: status.staBar, inline: false },
      { name: "💡 Light", value: status.light, inline: true },
      { name: "🧠 Sanity", value: status.sanity, inline: true },
      { name: "🛡️ Resistance", value: status.res, inline: false },
      { name: "🔥 Effects", value: status.effects, inline: false },
      { name: "🎁 Buff", value: status.buff, inline: true },
      { name: "🛑 Injury", value: status.injuries, inline: true }
    )
    .setFooter({ text: `Vũ khí: ${weapon.name}` });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`attack::${battle.battleId}::${player.userId}`)
      .setLabel("⚔️ Đánh")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(player.sta < weapon.staCost),
    new ButtonBuilder()
      .setCustomId(`dodge::${battle.battleId}::${player.userId}`)
      .setLabel("💨 Né")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(player.sta < 20),
    new ButtonBuilder()
      .setCustomId(`guard::${battle.battleId}::${player.userId}`)
      .setLabel("🛡️ Guard")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(player.sta < 10),
    new ButtonBuilder()
      .setCustomId(`parry::${battle.battleId}::${player.userId}`)
      .setLabel("🎯 Parry")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`skill::${battle.battleId}::${player.userId}`)
      .setLabel("✨ Skill")
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({ embeds: [embed], components: [buttons], ephemeral: false });
}

// ─── Modal builder: GM Boss Attack ──────────────────────────────────────────

/**
 * Mở modal để GM nhập dmg, type, và target (nếu chưa chọn)
 * customId chứa battleId và bossId
 */
async function showBossAttackModal(interaction, battleId, bossId, prefillTarget) {
  const modal = new ModalBuilder()
    .setCustomId(`gmmodal::bossatk::${battleId}::${bossId}::${prefillTarget ?? "none"}`)
    .setTitle("Boss Attack");

  const dmgInput = new TextInputBuilder()
    .setCustomId("dmg")
    .setLabel("Sát thương (VD: 45)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Nhập số dmg boss gây ra")
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(6);

  const typeInput = new TextInputBuilder()
    .setCustomId("dmgtype")
    .setLabel("Loại dmg (Slash / Pierce / Blunt)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Slash")
    .setRequired(true)
    .setMaxLength(10);

  const targetInput = new TextInputBuilder()
    .setCustomId("target")
    .setLabel("Target userId (để trống nếu đã chọn)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(prefillTarget ?? "userId của player")
    .setRequired(!prefillTarget)
    .setMaxLength(30);

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("Ghi chú (VD: tên skill boss)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Heavy Smash, Ground Pound...")
    .setRequired(false)
    .setMaxLength(80);

  modal.addComponents(
    new ActionRowBuilder().addComponents(dmgInput),
    new ActionRowBuilder().addComponents(typeInput),
    new ActionRowBuilder().addComponents(targetInput),
    new ActionRowBuilder().addComponents(noteInput),
  );

  await interaction.showModal(modal);
}

async function showBossHealModal(interaction, battleId, bossId) {
  const modal = new ModalBuilder()
    .setCustomId(`gmmodal::bossheal::${battleId}::${bossId}`)
    .setTitle("Boss Heal");

  const healInput = new TextInputBuilder()
    .setCustomId("heal")
    .setLabel("Lượng HP hồi")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("VD: 50")
    .setRequired(true)
    .setMaxLength(6);

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("Ghi chú")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(80);

  modal.addComponents(
    new ActionRowBuilder().addComponents(healInput),
    new ActionRowBuilder().addComponents(noteInput),
  );

  await interaction.showModal(modal);
}

// ─── GM target state (in-memory per battle) ─────────────────────────────────
// Lưu target player đã chọn và boss đã chọn cho mỗi GM session
const gmSelections = new Map(); // key: `${battleId}::${gmUserId}` → { bossId, targetUserId }

function getGmSel(battleId, gmId) {
  const key = `${battleId}::${gmId}`;
  if (!gmSelections.has(key)) gmSelections.set(key, { bossId: null, targetUserId: null });
  return gmSelections.get(key);
}

// ─── Main interaction handler ────────────────────────────────────────────────

async function handleCombatInteraction(interaction) {
  // ── Slash commands ──
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== "combat") return false;
    const subcommand = interaction.options.getSubcommand();
    try {
      switch (subcommand) {
        case "create":   await handleCombatCreate(interaction);    return true;
        case "join":     await handleCombatJoin(interaction);      return true;
        case "addplayer": await handleCombatAddPlayer(interaction); return true;
        case "addmob":   await handleCombatAddmob(interaction);    return true;
        case "panel":    await handleCombatPanel(interaction);     return true;
      }
    } catch (err) {
      console.error(`Combat slash error [${subcommand}]:`, err);
      const msg = { content: `❌ Lỗi: ${err.message}`, ephemeral: true };
      interaction.replied || interaction.deferred
        ? await interaction.followUp(msg)
        : await interaction.reply(msg);
    }
  }

  // ── Select menus (GM chọn boss / target) ──
  if (interaction.isStringSelectMenu()) {
    const { action, battleId, extra } = parseCustomId(interaction.customId);
    if (action !== "gm") return false;
    const battle = getBattle(battleId);
    if (!battle || battle.gmId !== interaction.user.id) {
      await interaction.reply({ content: "❌ Không có quyền", ephemeral: true });
      return true;
    }
    const sel = getGmSel(battleId, interaction.user.id);

    if (extra === "selboss") {
      sel.bossId = interaction.values[0];
      await interaction.reply({ content: `✅ Boss đã chọn: **${sel.bossId}**`, ephemeral: true });
      return true;
    }
    if (extra === "seltarget") {
      sel.targetUserId = interaction.values[0];
      const target = battle.participants.find(p => p.userId === sel.targetUserId);
      await interaction.reply({ content: `✅ Target đã chọn: **${target?.name ?? sel.targetUserId}**`, ephemeral: true });
      return true;
    }
  }

  // ── Buttons ──
  if (interaction.isButton()) {
    const { action, battleId, extra, extra2 } = parseCustomId(interaction.customId);
    const battle = getBattle(battleId);
    if (!battle) { await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true }); return true; }

    try {
      // ── Player actions ──
      const playerId = extra; // cho player buttons: extra = userId

      if (action === "attack") {
        const result = playerAttack(battleId, playerId);
        if (result?.error) {
          await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        } else {
          await interaction.reply({
            content: `⚔️ **${result.player.name}** đánh với **${result.weapon.name}**\nRoll: **${result.roll}** → DMG: **${result.modifiedDmg}**`,
            ephemeral: true,
          });
        }
        return true;
      }

      if (action === "dodge") {
        const result = playerDodge(battleId, playerId);
        if (result?.error) { await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true }); }
        else { await interaction.reply({ content: `💨 Né thành công (-${result.sta} Sta)`, ephemeral: true }); }
        return true;
      }

      if (action === "guard") {
        const result = playerGuard(battleId, playerId);
        if (result?.error) { await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true }); }
        else { await interaction.reply({ content: `🛡️ Guard đã bật (-10 Sta)`, ephemeral: true }); }
        return true;
      }

      if (action === "parry") {
        const result = playerParry(battleId, playerId);
        if (result?.clash) {
          const st = result.success ? "✅ Thành công" : "❌ Thất bại";
          const ex = result.success ? "(+10 Sanity)" : "(-40 Sta, -10 Sanity)";
          await interaction.reply({ content: `🎯 Parry ${st} ${ex}`, ephemeral: true });
        }
        return true;
      }

      if (action === "skill") {
        await interaction.reply({ content: "⚠️ Skill system coming soon", ephemeral: true });
        return true;
      }

      // ── GM actions ──
      if (action !== "gm") return false;
      if (battle.gmId !== interaction.user.id) {
        await interaction.reply({ content: "❌ Chỉ GM mới dùng được nút này", ephemeral: true });
        return true;
      }

      const sel = getGmSel(battleId, interaction.user.id);
      // extra = sub-action (endturn / bossatk / bossguard / bossheal)
      // extra2 = bossId từ button (override nếu chưa chọn qua dropdown)
      const subAction = extra;
      const bossIdFromBtn = extra2;

      if (subAction === "endturn") {
        endTurn(battle.battleId);
        sel.targetUserId = null;
        await interaction.reply({ content: `✅ End Boss Turn → Player Phase bắt đầu`, ephemeral: true });
        return true;
      }

      if (subAction === "endencounter") {
        // Tổng kết encounter: Stamina hồi đầy, HP giữ nguyên
        const summary = battle.participants.map(p => {
          const survived = p.hp > 0;
          p.sta = p.maxSta ?? 100;
          return `${survived ? "✅" : "☠️"} **${p.name}** — HP: ${Math.max(0, p.hp)}/${p.maxHp}`;
        }).join("\n") || "Không có player";

        const bossSummary = battle.bosses.map(b =>
          `${b.hp <= 0 ? "☠️" : "🐉"} **${b.name}** — HP: ${Math.max(0, b.hp)}/${b.maxHp}`
        ).join("\n") || "Không có boss";

        battle.ended = true;
        battle.log.push(`[Turn ${battle.turnNumber}] 🏁 Encounter kết thúc bởi GM`);

        const embed = new EmbedBuilder()
          .setTitle(`🏁 Encounter Kết Thúc — ${battle.battleName}`)
          .setColor(0x95a5a6)
          .addFields(
            { name: "⚔️ Kết quả Players", value: summary, inline: false },
            { name: "🐉 Kết quả Bosses", value: bossSummary, inline: false },
            { name: "📊 Thống kê", value: `Turn: ${battle.turnNumber}
Log entries: ${battle.log.length}`, inline: false },
          )
          .setFooter({ text: "Stamina của tất cả player đã được hồi đầy. HP giữ nguyên." });

        await interaction.reply({ embeds: [embed], ephemeral: false });
        return true;
      }

      if (subAction === "bossguard") {
        const bossId = sel.bossId ?? bossIdFromBtn;
        const boss = battle.bosses.find(b => (b.id ?? b.name) === bossId) ?? battle.bosses.find(b => b.hp > 0);
        if (!boss) { await interaction.reply({ content: "❌ Không tìm thấy boss", ephemeral: true }); return true; }
        boss.guarding = true;
        await interaction.reply({ content: `🛡️ **${boss.name}** đang Guard — dmg nhận giảm 90%`, ephemeral: false });
        return true;
      }

      if (subAction === "bossatk") {
        const bossId = sel.bossId ?? bossIdFromBtn;
        const boss = battle.bosses.find(b => (b.id ?? b.name) === bossId) ?? battle.bosses.find(b => b.hp > 0);
        if (!boss) { await interaction.reply({ content: "❌ Không tìm thấy boss", ephemeral: true }); return true; }
        // Mở modal, prefill target nếu đã chọn
        await showBossAttackModal(interaction, battleId, boss.id ?? boss.name, sel.targetUserId);
        return true;
      }

      if (subAction === "bossheal") {
        const bossId = sel.bossId ?? bossIdFromBtn;
        const boss = battle.bosses.find(b => (b.id ?? b.name) === bossId) ?? battle.bosses.find(b => b.hp > 0);
        if (!boss) { await interaction.reply({ content: "❌ Không tìm thấy boss", ephemeral: true }); return true; }
        await showBossHealModal(interaction, battleId, boss.id ?? boss.name);
        return true;
      }

    } catch (err) {
      console.error("Combat button error:", err);
      const msg = { content: `❌ Lỗi: ${err.message}`, ephemeral: true };
      interaction.replied || interaction.deferred ? await interaction.followUp(msg) : await interaction.reply(msg);
    }
  }

  // ── Modals ──
  if (interaction.isModalSubmit()) {
    const { action, battleId, extra, extra2, extra3 } = (() => {
      const parts = interaction.customId.split("::");
      return { action: parts[0], battleId: parts[2], extra: parts[1], extra2: parts[3], extra3: parts[4] };
    })();

    if (action !== "gmmodal") return false;
    const battle = getBattle(battleId);
    if (!battle || battle.gmId !== interaction.user.id) {
      await interaction.reply({ content: "❌ Không có quyền", ephemeral: true });
      return true;
    }

    try {
      // extra = sub-action (bossatk / bossheal)
      if (extra === "bossatk") {
        const bossId = extra2;
        const prefillTarget = extra3 === "none" ? null : extra3;

        const rawDmg = parseInt(interaction.fields.getTextInputValue("dmg"), 10);
        const dmgType = interaction.fields.getTextInputValue("dmgtype").trim() || "Slash";
        const targetInput = interaction.fields.getTextInputValue("target").trim();
        const note = interaction.fields.getTextInputValue("note").trim();

        if (isNaN(rawDmg) || rawDmg < 0) {
          await interaction.reply({ content: "❌ Dmg không hợp lệ", ephemeral: true }); return true;
        }

        const targetUserId = targetInput || prefillTarget;
        const target = battle.participants.find(p => p.userId === targetUserId);
        if (!target) {
          await interaction.reply({ content: "❌ Không tìm thấy target. Hãy chọn target từ dropdown rồi thử lại.", ephemeral: true });
          return true;
        }

        const boss = battle.bosses.find(b => (b.id ?? b.name) === bossId) ?? battle.bosses.find(b => b.hp > 0);
        const resKey = ["Slash", "Pierce", "Blunt"].find(t => t.toLowerCase() === dmgType.toLowerCase()) ?? "Slash";
        const resMulti = target.res?.[resKey] ?? 1;
        const isGuarding = target.guarding ?? false;
        const finalDmg = Math.round(rawDmg * resMulti * (isGuarding ? 0.1 : 1));

        target.hp = Math.max(0, target.hp - finalDmg);
        if (isGuarding) { target.guarding = false; }

        const logLine = `[Turn ${battle.turnNumber}] 🐉 ${boss?.name ?? "Boss"} → ⚔️ ${target.name}: ${rawDmg} ${resKey} dmg × ${resMulti}x res${isGuarding ? " × 0.1 Guard" : ""} = **${finalDmg}** DMG${note ? ` (${note})` : ""}`;
        battle.log.push(logLine);

        const replyLines = [
          `🐉 **${boss?.name ?? "Boss"}** tấn công **${target.name}**`,
          `> ${rawDmg} ${resKey} × ${resMulti}x res${isGuarding ? " × 0.1 Guard" : ""} = **${finalDmg} DMG**`,
          `> HP còn lại: ${target.hp}/${target.maxHp}`,
        ];
        if (note) replyLines.push(`> _${note}_`);
        if (target.hp <= 0) replyLines.push(`> ☠️ **${target.name} đã chết!**`);

        await interaction.reply({ content: replyLines.join("\n"), ephemeral: false });
        return true;
      }

      if (extra === "bossheal") {
        const bossId = extra2;
        const healAmt = parseInt(interaction.fields.getTextInputValue("heal"), 10);
        const note = interaction.fields.getTextInputValue("note").trim();

        if (isNaN(healAmt) || healAmt <= 0) {
          await interaction.reply({ content: "❌ Lượng heal không hợp lệ", ephemeral: true }); return true;
        }

        const boss = battle.bosses.find(b => (b.id ?? b.name) === bossId) ?? battle.bosses.find(b => b.hp > 0);
        if (!boss) { await interaction.reply({ content: "❌ Không tìm thấy boss", ephemeral: true }); return true; }

        const before = boss.hp;
        boss.hp = Math.min(boss.maxHp, boss.hp + healAmt);
        const actual = boss.hp - before;
        const logLine = `[Turn ${battle.turnNumber}] 💊 ${boss.name} hồi ${actual} HP (${before} → ${boss.hp}/${boss.maxHp})${note ? ` — ${note}` : ""}`;
        battle.log.push(logLine);

        await interaction.reply({
          content: `💊 **${boss.name}** hồi **${actual} HP** (${before} → ${boss.hp}/${boss.maxHp})${note ? `\n> _${note}_` : ""}`,
          ephemeral: false,
        });
        return true;
      }
    } catch (err) {
      console.error("Combat modal error:", err);
      const msg = { content: `❌ Lỗi: ${err.message}`, ephemeral: true };
      interaction.replied || interaction.deferred ? await interaction.followUp(msg) : await interaction.reply(msg);
    }
  }

  return false;
}

module.exports = {
  COMBAT_COMMAND_DEF,
  handleCombatInteraction,
};
