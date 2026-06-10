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
      .setName("panel")
      .setDescription("Mở panel GM hoặc player")
      .addStringOption(opt => opt.setName("battleid").setDescription("ID trận").setRequired(true))
  );

/**
 * Handle /combat create
 */
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
    .setFooter({ text: "Dùng /combat join <battleid> để player tham gia" });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

/**
 * Handle /combat join
 */
async function handleCombatJoin(interaction) {
  const battleId = interaction.options.getString("battleid");
  const charName = interaction.options.getString("charname");
  const weaponId = interaction.options.getString("weapon");
  const maxHp = interaction.options.getInteger("maxhp");
  const maxLight = interaction.options.getInteger("maxlight") ?? 4;

  const battle = getBattle(battleId);
  if (!battle) {
    await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true });
    return;
  }

  const weapon = getWeapon(weaponId);
  if (!weapon) {
    await interaction.reply({ content: "❌ Vũ khí không hợp lệ", ephemeral: true });
    return;
  }

  addPlayer(battleId, interaction.user.id, {
    name: charName,
    hp: maxHp,
    weaponId: weaponId,
    maxLight: Math.min(6, maxLight),
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

/**
 * Handle /combat addmob
 */
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

/**
 * Handle /combat panel - Show GM or Player interface
 */
async function handleCombatPanel(interaction) {
  const battleId = interaction.options.getString("battleid");
  const battle = getBattle(battleId);
  if (!battle) {
    await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true });
    return;
  }

  const isGM = battle.gmId === interaction.user.id;
  const player = battle.participants.find(p => p.userId === interaction.user.id);

  if (isGM) {
    await showGMPanel(interaction, battle);
  } else if (player) {
    await showPlayerPanel(interaction, battle, player);
  } else {
    await interaction.reply({ content: "❌ Bạn không có trong trận này", ephemeral: true });
  }
}

/**
 * Show GM Panel
 */
async function showGMPanel(interaction, battle) {
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ ${battle.battleName} - GM Panel (Turn ${battle.turnNumber})`)
    .setColor(0xe74c3c)
    .addFields(
      {
        name: "🐉 Bosses",
        value: battle.bosses.map(b => `**${b.name}** - HP: ${formatBar(b.hp, b.maxHp, 10)}`).join("\n"),
        inline: false,
      },
      {
        name: "⚔️ Players",
        value:
          battle.participants.map(p => `**${p.name}** - HP: ${formatBar(p.hp, p.maxHp, 10)}`).join("\n") || "Chưa có",
        inline: false,
      },
      {
        name: "📋 Recent Log",
        value: battle.log.slice(-5).map(l => `> ${l}`).join("\n") || "Trống",
        inline: false,
      }
    )
    .setFooter({ text: `Battle ID: ${battle.battleId}` });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gm_end_boss_turn_${battle.battleId}`)
      .setLabel("⏭️ End Boss Turn")
      .setStyle(ButtonStyle.Success)
  );

  await interaction.reply({ embeds: [embed], components: [buttons], ephemeral: false });
}

/**
 * Show Player Panel
 */
async function showPlayerPanel(interaction, battle, player) {
  const status = formatParticipantStatus(player);
  const weapon = getWeapon(player.weapon);

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ ${player.name} - Combat Panel`)
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
      .setCustomId(`attack_${battle.battleId}_${player.userId}`)
      .setLabel("⚔️ Đánh")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(player.sta < weapon.staCost),
    new ButtonBuilder()
      .setCustomId(`dodge_${battle.battleId}_${player.userId}`)
      .setLabel("💨 Né")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(player.sta < 20),
    new ButtonBuilder()
      .setCustomId(`guard_${battle.battleId}_${player.userId}`)
      .setLabel("🛡️ Guard")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(player.sta < 10),
    new ButtonBuilder()
      .setCustomId(`parry_${battle.battleId}_${player.userId}`)
      .setLabel("🎯 Parry")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`skill_${battle.battleId}_${player.userId}`)
      .setLabel("✨ Skill")
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({ embeds: [embed], components: [buttons], ephemeral: false });
}

/**
 * Interaction handler
 */
async function handleCombatInteraction(interaction) {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== "combat") return false;

    const subcommand = interaction.options.getSubcommand();
    try {
      switch (subcommand) {
        case "create":
          await handleCombatCreate(interaction);
          return true;
        case "join":
          await handleCombatJoin(interaction);
          return true;
        case "addmob":
          await handleCombatAddmob(interaction);
          return true;
        case "panel":
          await handleCombatPanel(interaction);
          return true;
      }
    } catch (error) {
      console.error(`Combat error in ${subcommand}:`, error);
      await interaction.reply({ content: `❌ Lỗi: ${error.message}`, ephemeral: true });
    }
  }

  if (interaction.isButton()) {
    const [action, battleId, userId] = interaction.customId.split("_");
    const battle = getBattle(battleId);

    if (!battle) {
      await interaction.reply({ content: "❌ Trận đấu không tìm thấy", ephemeral: true });
      return true;
    }

    try {
      if (action === "attack") {
        const result = playerAttack(battleId, userId);
        if (result?.error) {
          await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        } else {
          await interaction.reply({
            content:
              `⚔️ **${result.player.name}** đánh với **${result.weapon.name}**\n` +
              `Roll: **${result.roll}** → DMG: **${result.modifiedDmg}** (Sanity mod)`,
            ephemeral: true,
          });
        }
        return true;
      }

      if (action === "dodge") {
        const result = playerDodge(battleId, userId);
        if (result?.error) {
          await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        } else {
          await interaction.reply({ content: `💨 Né thành công (-${result.sta} Sta)`, ephemeral: true });
        }
        return true;
      }

      if (action === "guard") {
        const result = playerGuard(battleId, userId);
        if (result?.error) {
          await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        } else {
          await interaction.reply({ content: `🛡️ Guard đã bật (-10 Sta)`, ephemeral: true });
        }
        return true;
      }

      if (action === "parry") {
        const result = playerParry(battleId, userId);
        if (result?.clash) {
          const status = result.success ? "✅ Thành công" : "❌ Thất bại";
          const extra = result.success ? `(+10 Sanity)` : `(-40 Sta, -10 Sanity)`;
          await interaction.reply({ content: `🎯 Parry ${status} ${extra}`, ephemeral: true });
        }
        return true;
      }

      if (action === "skill") {
        await interaction.reply({ content: "⚠️ Skill system coming soon", ephemeral: true });
        return true;
      }

      if (action === "gm") {
        if (battle.gmId !== interaction.user.id) {
          await interaction.reply({ content: "❌ Chỉ GM mới có thể kết thúc turn boss", ephemeral: true });
          return true;
        }

        endTurn(battle.battleId);
        await interaction.reply({ content: `✅ Kết thúc turn boss, chuyển sang player turn`, ephemeral: true });
        return true;
      }
    } catch (error) {
      console.error(`Combat button error:`, error);
      await interaction.reply({ content: `❌ Lỗi: ${error.message}`, ephemeral: true });
    }
  }

  return false;
}

module.exports = {
  COMBAT_COMMAND_DEF,
  handleCombatInteraction,
};