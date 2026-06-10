// ═══════════════════════════════════════════════════════════════════════════
// combat-ui.js — Combat UI Module
// Thêm vào index.js:
//   1. const { registerCombatCommand, handleCombatInteraction } = require("./combat-ui");
//   2. Đăng ký slash command "combat" trong danh sách commands
//   3. Trong interactionCreate: await handleCombatInteraction(interaction);
// ═══════════════════════════════════════════════════════════════════════════

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require("discord.js");

// ─── COMBAT SESSION STORE ─────────────────────────────────────────────────────
// Map<sessionId, CombatState>
// sessionId = `${channelId}:${messageId}` sau khi tạo, hoặc `pending:${userId}` lúc setup
const combatSessions = new Map();

// Dọn session quá cũ (> 3 tiếng)
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of combatSessions) {
    if (s.createdAt < cutoff) combatSessions.delete(id);
  }
}, 10 * 60 * 1000);

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MAX_HP_DEFAULT = 140;
const MAX_STA_DEFAULT = 100;
const MAX_SANITY = 45;
const SANITY_MIN = -45;
const LIGHT_DEFAULT = 4;

const WEAPON_STA_COST = { light: 5, medium: 10, heavy: 20 };
const DODGE_STA_COST = 20;
const GUARD_STA_COST = 10;

const STATUS_EMOJIS = {
  burn:    "🔥",
  tremor:  "🌊",
  rupture: "💢",
  poise:   "✨",
  bleed:   "🩸",
  sinking: "🌀",
  charge:  "⚡",
};

// ─── STATE FACTORY ────────────────────────────────────────────────────────────
function createCombatState({ ownerId, ownerName, weaponType = "medium", pages = [] }) {
  return {
    ownerId,
    ownerName,
    createdAt: Date.now(),
    turn: 1,
    weaponType, // "light" | "medium" | "heavy"

    // Stats
    hp: MAX_HP_DEFAULT,
    maxHp: MAX_HP_DEFAULT,
    sta: MAX_STA_DEFAULT,
    maxSta: MAX_STA_DEFAULT,
    sanity: 0,
    light: LIGHT_DEFAULT,
    maxLight: LIGHT_DEFAULT,

    // Resistance (hiển thị)
    res: { B: 1.0, P: 1.0, S: 1.0 },

    // Status effects — giá trị là số count
    statuses: {
      burn: 0, tremor: 0, rupture: 0,
      poise: 0, bleed: 0, sinking: 0, charge: 0,
    },

    // Buffs & Debuffs dạng text (GM nhập)
    buffs: [],
    debuffs: [],

    // Pages đã chọn (tối đa 5 regular + 5 EGO)
    pages,

    // Skill cooldowns: { skillKey: turnsRemaining }
    skillCds: {},

    // Stamina tích lũy trong turn để tính Light
    staSpentThisTurn: 0,

    // Light pending: sẽ nhận vào turn kế
    pendingLight: 0,

    // Trạng thái đặc biệt
    isStaggered: false,
    isPanicked: false,
    staggerTurnsLeft: 0,
    panicTurnsLeft: 0,

    // Emotion Level
    totalDmgDealt: 0,
    emotionLevel: 0,
    emotionTurnsLeft: 0,
    emotionCooldown: 0,

    // EGO Manifest
    egoManifested: false,
    egoTurnsLeft: 0,
    egoCooldown: 0,

    // Shin/Mang
    shinActive: false,
    mangActive: false,

    // Lịch sử hành động trong turn hiện tại
    actionLog: [],

    // messageId để update embed
    messageId: null,
    channelId: null,
  };
}

// ─── EMBED BUILDER ────────────────────────────────────────────────────────────
function buildCombatEmbed(state) {
  const hpBar    = buildBar(state.hp,     state.maxHp,     10, "🟥", "⬛");
  const staBar   = buildBar(state.sta,    state.maxSta,    10, "🟨", "⬛");
  const sanBar   = buildSanityBar(state.sanity);
  const lightStr = "⬡".repeat(Math.max(0, state.light)) + "○".repeat(Math.max(0, state.maxLight - state.light));

  // Header status
  let statusLine = "";
  if (state.isStaggered) statusLine += " 💥**STAGGER**";
  if (state.isPanicked)  statusLine += " 😱**PANIC**";
  if (state.egoManifested) statusLine += " 🌟**EGO MANIFEST**";
  if (state.shinActive)  statusLine += " 🔵Shin";
  if (state.mangActive)  statusLine += " 🔴Mang";

  // Status effects
  const activeStatuses = Object.entries(state.statuses)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${STATUS_EMOJIS[k] ?? "●"}**${capitalize(k)}** ×${v}`)
    .join("  ");

  // Resistance
  const resStr = Object.entries(state.res)
    .map(([t, v]) => v !== 1.0 ? `${v}x${t}` : null)
    .filter(Boolean)
    .join(" | ") || "—";

  // Buffs / Debuffs
  const buffStr  = state.buffs.length  ? state.buffs.join(", ")  : "—";
  const debuffStr = state.debuffs.length ? state.debuffs.join(", ") : "—";

  // Action log (last 5)
  const logLines = state.actionLog.slice(-5);
  const logStr = logLines.length ? logLines.join("\n") : "*Chưa có hành động nào.*";

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ Combat — ${state.ownerName}${statusLine}`)
    .setColor(state.isStaggered ? 0xe74c3c : state.egoManifested ? 0xf1c40f : 0x2ecc71)
    .addFields(
      {
        name: `❤️ HP  ${state.hp}/${state.maxHp}`,
        value: hpBar,
        inline: false,
      },
      {
        name: `⚡ Stamina  ${state.sta}/${state.maxSta}`,
        value: staBar,
        inline: false,
      },
      {
        name: `🧠 Sanity  ${state.sanity}/${MAX_SANITY}`,
        value: sanBar,
        inline: false,
      },
      {
        name: `💡 Light`,
        value: `${lightStr}  (${state.light}/${state.maxLight})`,
        inline: true,
      },
      {
        name: `🛡️ Resistance`,
        value: resStr,
        inline: true,
      },
    );

  if (activeStatuses) {
    embed.addFields({ name: "🎯 Status Effects", value: activeStatuses, inline: false });
  }

  embed.addFields(
    { name: "✅ Buff",   value: buffStr,   inline: true },
    { name: "❌ Debuff", value: debuffStr, inline: true },
    { name: `📋 Turn ${state.turn} — Hành động gần đây`, value: logStr, inline: false },
  );

  // Emotion level
  if (state.emotionLevel > 0) {
    embed.addFields({
      name: `🌟 Emotion Lv.${state.emotionLevel}`,
      value: state.emotionTurnsLeft > 0
        ? `Còn ${state.emotionTurnsLeft} turn`
        : `CD: ${state.emotionCooldown} turn`,
      inline: true,
    });
  } else if (state.totalDmgDealt > 0) {
    const nextThreshold = state.totalDmgDealt < 200 ? 200 : 500;
    embed.addFields({
      name: "📈 Damage Dealt",
      value: `${state.totalDmgDealt} / ${nextThreshold} → Emotion Lv.${state.emotionLevel + 1}`,
      inline: true,
    });
  }

  // Skill CDs
  const activeCds = Object.entries(state.skillCds)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `\`${k}\` CD: ${v}`);
  if (activeCds.length) {
    embed.addFields({ name: "⏳ Skill Cooldown", value: activeCds.join("  "), inline: false });
  }

  embed.setFooter({ text: `Turn ${state.turn} | Vũ khí: ${state.weaponType} (${WEAPON_STA_COST[state.weaponType]} Sta/đòn)` });
  return embed;
}

function buildBar(current, max, segments, fillChar, emptyChar) {
  if (max <= 0) return emptyChar.repeat(segments);
  const filled = Math.round((Math.max(0, current) / max) * segments);
  return fillChar.repeat(filled) + emptyChar.repeat(segments - filled);
}

function buildSanityBar(sanity) {
  // -45 ... 0 ... +45, center = 0
  const segments = 10;
  const half = segments / 2;
  if (sanity >= 0) {
    const filled = Math.round((sanity / MAX_SANITY) * half);
    return "⬛".repeat(half - filled) + "🟦".repeat(filled) + "🟩".repeat(half);
    // Hiển thị: negative side trống, positive side xanh
  } else {
    const filled = Math.round((Math.abs(sanity) / MAX_SANITY) * half);
    return "🟥".repeat(filled) + "⬛".repeat(half - filled) + "🟩".repeat(half);
  }
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── COMPONENT BUILDERS ───────────────────────────────────────────────────────

function buildActionRow(state) {
  const disabled = state.isStaggered || state.isPanicked;
  const staCost  = WEAPON_STA_COST[state.weaponType];
  const canAtk   = !disabled && state.sta >= staCost;
  const canDodge = !disabled && state.sta >= DODGE_STA_COST;
  const canGuard = !disabled && state.sta >= GUARD_STA_COST;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("combat:attack")
      .setLabel(`⚔️ Đánh (${staCost} Sta)`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!canAtk),

    new ButtonBuilder()
      .setCustomId("combat:dodge")
      .setLabel(`💨 Né (${DODGE_STA_COST} Sta)`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canDodge),

    new ButtonBuilder()
      .setCustomId("combat:guard")
      .setLabel(`🛡️ Guard (${GUARD_STA_COST} Sta)`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canGuard),

    new ButtonBuilder()
      .setCustomId("combat:parry")
      .setLabel("🎯 Parry (0 Sta)")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

function buildUtilRow(state) {
  const disabled = state.isStaggered || state.isPanicked;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("combat:skill")
      .setLabel("📖 Dùng Skill")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),

    new ButtonBuilder()
      .setCustomId("combat:endturn")
      .setLabel("⏭️ Kết thúc Turn")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("combat:editstatus")
      .setLabel("✏️ Sửa Status")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("combat:info")
      .setLabel("ℹ️ Cơ chế")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildSkillSelectRow(state) {
  // Lấy tối đa 25 skill từ pages hoặc hiện tất cả skills
  // Trong game thực tế, player chỉ mang 5 page; ta hiển thị từ state.pages
  const options = state.pages.length > 0
    ? state.pages.slice(0, 25).map((p) => ({
        label: p.name,
        description: `${p.cost || "?"} | CD: ${p.cd || "?"}`,
        value: `page:${p.key}`,
      }))
    : [{ label: "(Không có Page nào được chọn)", value: "none", description: "Thêm Page qua /combat setup" }];

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("combat:skillselect")
      .setPlaceholder("Chọn Skill / Page để dùng...")
      .addOptions(options),
  );
}

// ─── RESPONSE HELPER ──────────────────────────────────────────────────────────
function buildCombatResponse(state) {
  return {
    embeds: [buildCombatEmbed(state)],
    components: [buildActionRow(state), buildUtilRow(state)],
  };
}

// ─── ACTION HANDLERS ─────────────────────────────────────────────────────────

function handleAttack(state) {
  const cost = WEAPON_STA_COST[state.weaponType];
  if (state.sta < cost) return { error: `❌ Không đủ Stamina (cần ${cost}, còn ${state.sta}).` };

  state.sta -= cost;
  state.staSpentThisTurn += cost;

  // Roll dmg range tuỳ vũ khí (GM confirm sau, đây là UI aid)
  const dmgRange = { light: [3, 8], medium: [6, 14], heavy: [10, 22] }[state.weaponType];
  const rolled = Math.floor(Math.random() * (dmgRange[1] - dmgRange[0] + 1)) + dmgRange[0];

  // Check Light gain: 20 sta tích lũy trong turn
  const lightGained = Math.floor(state.staSpentThisTurn / 20) - Math.floor((state.staSpentThisTurn - cost) / 20);
  if (lightGained > 0) state.pendingLight += lightGained;

  state.actionLog.push(
    `⚔️ **Đánh thường** [${state.weaponType}] — Dice: **${rolled}** | -${cost} Sta` +
    (lightGained > 0 ? ` | +${lightGained}💡 kế` : ""),
  );
  checkStagger(state);
  return {};
}

function handleDodge(state) {
  if (state.sta < DODGE_STA_COST) return { error: `❌ Không đủ Stamina để né (cần ${DODGE_STA_COST}).` };
  state.sta -= DODGE_STA_COST;
  state.staSpentThisTurn += DODGE_STA_COST;
  const lightGained = Math.floor(state.staSpentThisTurn / 20) - Math.floor((state.staSpentThisTurn - DODGE_STA_COST) / 20);
  if (lightGained > 0) state.pendingLight += lightGained;

  state.actionLog.push(`💨 **Né** — không nhận sát thương | -${DODGE_STA_COST} Sta`);
  checkStagger(state);
  return {};
}

function handleGuard(state) {
  if (state.sta < GUARD_STA_COST) return { error: `❌ Không đủ Stamina để guard (cần ${GUARD_STA_COST}).` };
  state.sta -= GUARD_STA_COST;
  state.staSpentThisTurn += GUARD_STA_COST;

  state.actionLog.push(`🛡️ **Guard** — giảm 90% sát thương | -${GUARD_STA_COST} Sta`);
  checkStagger(state);
  return {};
}

function handleParry(state) {
  // Roll d16 attacker vs d20 defender (reroll on tie)
  let atk, pry, rerolls = 0;
  do {
    atk = Math.floor(Math.random() * 16) + 1;
    pry = Math.floor(Math.random() * 20) + 1;
    if (atk === pry) rerolls++;
  } while (atk === pry);

  const success = pry >= atk;
  if (!success) {
    // Parry hụt: mất 40 Sta
    const penalty = Math.min(40, state.sta);
    state.sta = Math.max(0, state.sta - 40);
    state.actionLog.push(
      `🎯 **Parry** ❌ — Atk: \`${atk}\` vs Def: \`${pry}\`${rerolls ? ` *(reroll ${rerolls}x)*` : ""} | -${penalty} Sta + nhận full dmg`,
    );
    checkStagger(state);
  } else {
    state.actionLog.push(
      `🎯 **Parry** ✅ — Atk: \`${atk}\` vs Def: \`${pry}\`${rerolls ? ` *(reroll ${rerolls}x)*` : ""} | không nhận dmg`,
    );
  }
  return { parryResult: success };
}

function handleEndTurn(state) {
  const log = [];

  // Bleed tick: khi kẻ địch hành động — không áp dụng ở đây cho bản thân
  // Burn tick trên bản thân (nếu bị burn)
  if (state.statuses.burn > 0) {
    const burnDmg = state.statuses.burn * 2;
    state.hp = Math.max(0, state.hp - burnDmg);
    state.statuses.burn = Math.floor(state.statuses.burn / 2);
    if (state.statuses.burn < 1) state.statuses.burn = 0;
    log.push(`🔥 Burn tick: -${burnDmg} HP (còn ${state.statuses.burn} stack)`);
  }

  // Countdown skill CDs
  for (const key of Object.keys(state.skillCds)) {
    if (state.skillCds[key] > 0) state.skillCds[key]--;
  }

  // Nhận Light pending
  if (state.pendingLight > 0) {
    const gained = Math.min(state.pendingLight, state.maxLight - state.light);
    state.light = Math.min(state.maxLight, state.light + state.pendingLight);
    state.pendingLight = 0;
    if (gained > 0) log.push(`💡 +${gained} Light từ đòn đánh turn trước`);
  }

  // Hồi Sta đầy nếu đang stagger (sau stagger)
  if (state.isStaggered && state.staggerTurnsLeft <= 0) {
    state.isStaggered = false;
    state.sta = state.maxSta;
    log.push("💥 Hết Stagger — hồi đầy Stamina");
  } else if (state.isStaggered) {
    state.staggerTurnsLeft--;
    log.push(`💥 Stagger — bỏ qua turn (còn ${state.staggerTurnsLeft} turn)`);
  }

  // Panic
  if (state.isPanicked && state.panicTurnsLeft <= 0) {
    state.isPanicked = false;
    state.sanity = 0;
    log.push("😱 Hết Panic — Sanity reset về 0");
  } else if (state.isPanicked) {
    state.panicTurnsLeft--;
    log.push(`😱 Panic — bỏ qua turn (còn ${state.panicTurnsLeft} turn)`);
  }

  // Emotion cooldown
  if (state.emotionTurnsLeft > 0) {
    state.emotionTurnsLeft--;
    if (state.emotionTurnsLeft === 0) {
      state.emotionCooldown = 5;
      log.push(`🌟 Emotion Lv.${state.emotionLevel} kết thúc — CD 5 turn`);
    }
  } else if (state.emotionCooldown > 0) {
    state.emotionCooldown--;
  }

  // EGO cooldown
  if (state.egoTurnsLeft > 0) {
    state.egoTurnsLeft--;
    if (state.egoTurnsLeft === 0) {
      state.egoManifested = false;
      state.egoCooldown = 5;
      log.push("🌟 EGO Manifest kết thúc — CD 5 turn");
    }
  } else if (state.egoCooldown > 0) {
    state.egoCooldown--;
  }

  // Reset turn tracking
  state.turn++;
  state.staSpentThisTurn = 0;
  state.actionLog = [];

  if (log.length) state.actionLog.push(...log.map(l => `> ${l}`));
  else state.actionLog.push(`> ⏭️ Turn ${state.turn} bắt đầu.`);

  return {};
}

function checkStagger(state) {
  if (state.sta <= 0 && !state.isStaggered) {
    state.sta = 0;
    state.isStaggered = true;
    state.staggerTurnsLeft = 1;
    // Resistance set 2x khi stagger
    state.res = { B: 2.0, P: 2.0, S: 2.0 };
    state.actionLog.push("💥 **STAGGER!** — bỏ qua turn kế, Resistance 2x tất cả");
  }
  if (state.sanity <= SANITY_MIN && !state.isPanicked) {
    state.isPanicked = true;
    state.panicTurnsLeft = 1;
    state.actionLog.push("😱 **PANIC!** — Sanity đạt -45, bỏ qua turn kế");
  }
}

// ─── EDIT STATUS MODAL ────────────────────────────────────────────────────────
function buildEditStatusModal(sessionId) {
  return new ModalBuilder()
    .setCustomId(`combat:editsave:${sessionId}`)
    .setTitle("✏️ Cập nhật trạng thái nhân vật")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("hpSta")
          .setLabel("HP / Stamina / Sanity (VD: hp:120 sta:80 san:15)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("hp:120 sta:80 san:15"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("lightRes")
          .setLabel("Light / Resistance (VD: light:3 res:1.3B 1.0P 1.5S)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("light:3 res:1.3B 1.0P 1.0S"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("effects")
          .setLabel("Status Effects (VD: burn:5 bleed:8 poise:10 sinking:3)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("burn:5 bleed:8 poise:10"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("buffDebuff")
          .setLabel("Buff / Debuff (VD: buff:Haste,ShieldUp debuff:Fragile)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("buff:ShieldUp debuff:Fragile"),
      ),
    );
}

function parseEditInput(input, state) {
  if (!input || !input.trim()) return;
  const tokens = input.trim().split(/\s+/);
  for (const tok of tokens) {
    const [key, val] = tok.split(":").map(s => s.trim());
    if (!key || val === undefined) continue;
    const k = key.toLowerCase();
    if (k === "hp")     state.hp      = Math.max(0, Math.min(state.maxHp, parseFloat(val) || state.hp));
    if (k === "sta")    state.sta     = Math.max(0, Math.min(state.maxSta, parseFloat(val) || state.sta));
    if (k === "san")    state.sanity  = Math.max(SANITY_MIN, Math.min(MAX_SANITY, parseFloat(val) || state.sanity));
    if (k === "light")  state.light   = Math.max(0, Math.min(state.maxLight, parseInt(val) || state.light));
    if (k === "maxhp")  { state.maxHp  = Math.max(1, parseInt(val) || state.maxHp); state.hp = Math.min(state.hp, state.maxHp); }
    if (k === "maxsta") { state.maxSta = Math.max(1, parseInt(val) || state.maxSta); state.sta = Math.min(state.sta, state.maxSta); }
    if (k === "maxlight") state.maxLight = Math.max(1, Math.min(6, parseInt(val) || state.maxLight));

    // Resistance: "res:1.3B" hoặc inline "1.3B"
    const resMatch = val.match(/^([\d.]+)([BPS])$/i);
    if (k === "res" || resMatch) {
      const target = resMatch || val.match(/^([\d.]+)([BPS])$/i);
      if (target) {
        state.res[target[2].toUpperCase()] = parseFloat(target[1]);
      } else {
        // Multiple: "1.3B 1.0P 1.5S" (đã split thành tokens nên không vào đây)
      }
    }

    // Status effects
    if (Object.keys(state.statuses).includes(k)) {
      state.statuses[k] = Math.max(0, Math.min(99, parseFloat(val) || 0));
    }
  }
}

function parseResInput(input, state) {
  if (!input || !input.trim()) return;
  // "light:3 res:1.3B 1.0P 1.5S" — res có thể là nhiều phần sau dấu :
  // Tách riêng res
  const resMatch = input.match(/res:([\d.\sBPS]+)/i);
  if (resMatch) {
    const parts = resMatch[1].match(/([\d.]+)([BPS])/gi) || [];
    for (const p of parts) {
      const m = p.match(/([\d.]+)([BPS])/i);
      if (m) state.res[m[2].toUpperCase()] = parseFloat(m[1]);
    }
  }
  const lightMatch = input.match(/light:(\d+)/i);
  if (lightMatch) state.light = Math.max(0, Math.min(state.maxLight, parseInt(lightMatch[1])));
}

function parseBuffDebuffInput(input, state) {
  if (!input || !input.trim()) return;
  const buffMatch = input.match(/buff:([\w,\s]+?)(?:\s+debuff:|$)/i);
  const debuffMatch = input.match(/debuff:([\w,\s]+?)(?:\s+buff:|$)/i);
  if (buffMatch) state.buffs = buffMatch[1].split(",").map(s => s.trim()).filter(Boolean);
  if (debuffMatch) state.debuffs = debuffMatch[1].split(",").map(s => s.trim()).filter(Boolean);
}

// ─── INFO EMBED ───────────────────────────────────────────────────────────────
function buildInfoEmbed() {
  return new EmbedBuilder()
    .setTitle("ℹ️ Cơ chế Combat")
    .setColor(0x5865f2)
    .addFields(
      { name: "⚔️ Đánh thường", value: "Light 5 Sta | Medium 10 Sta | Heavy 20 Sta\nMỗi 20 Sta tích lũy trong 1 turn → +1 Light vào turn kế", inline: false },
      { name: "💨 Né", value: "20 Sta — không nhận sát thương", inline: true },
      { name: "🛡️ Guard", value: "10 Sta — giảm 90% sát thương", inline: true },
      { name: "🎯 Parry", value: "0 Sta — roll d16 (Atk) vs d20 (Def)\nThành công: không nhận dmg | Thất bại: -40 Sta + nhận full dmg", inline: false },
      { name: "💥 Stagger", value: "Sta = 0 → Stagger 1 turn, hồi đầy Sta sau, Resistance 2x tất cả", inline: false },
      { name: "😱 Panic", value: "Sanity = -45 → Panic 1 turn, Sanity reset về 0", inline: false },
      { name: "🔥 Burn tick", value: "Cuối mỗi turn: dmg = 2×count, rồi count ÷2 (làm tròn xuống)", inline: false },
      { name: "✏️ Sửa Status", value: "Dùng nút **Sửa Status** để cập nhật HP/Sta/Sanity/Light/Resistance/Status Effects/Buff/Debuff thủ công (GM confirm sau combat)", inline: false },
    )
    .setFooter({ text: "Cơ chế đầy đủ trong rulebook của GM" });
}

// ─── SETUP MODAL ─────────────────────────────────────────────────────────────
function buildSetupModal() {
  return new ModalBuilder()
    .setCustomId("combat:setupsave")
    .setTitle("⚔️ Khởi tạo Combat")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("charName")
          .setLabel("Tên nhân vật")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("VD: Yujin"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("weaponType")
          .setLabel("Loại vũ khí: light / medium / heavy")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("medium"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("stats")
          .setLabel("Stats ban đầu (HP/MaxHP/Stamina/Light)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("hp:140 maxhp:140 sta:100 light:4 maxlight:4"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("resistance")
          .setLabel("Resistance (mặc định 1x nếu bỏ trống)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("1.3B 1.3P 1.0S"),
      ),
    );
}

// ─── EXPORTED: COMMAND DEFINITION ────────────────────────────────────────────
// Thêm vào mảng commands khi đăng ký slash commands
const COMBAT_COMMAND_DEF = {
  name: "combat",
  description: "Mở giao diện combat với buttons và tracker trạng thái",
  // Không cần options — setup qua modal
};

// ─── EXPORTED: MAIN HANDLER ──────────────────────────────────────────────────
/**
 * Gọi hàm này ở đầu interactionCreate, TRƯỚC các handler khác.
 * Trả về true nếu đã xử lý, false nếu không phải combat interaction.
 */
async function handleCombatInteraction(interaction) {
  // ── /combat slash command → mở setup modal ──
  if (interaction.isChatInputCommand() && interaction.commandName === "combat") {
    await interaction.showModal(buildSetupModal());
    return true;
  }

  // ── Modal: setup save ──
  if (interaction.isModalSubmit() && interaction.customId === "combat:setupsave") {
    const charName  = interaction.fields.getTextInputValue("charName").trim() || interaction.user.username;
    const weaponRaw = interaction.fields.getTextInputValue("weaponType").trim().toLowerCase();
    const weaponType = ["light", "medium", "heavy"].includes(weaponRaw) ? weaponRaw : "medium";
    const statsRaw  = interaction.fields.getTextInputValue("stats").trim();
    const resRaw    = interaction.fields.getTextInputValue("resistance").trim();

    const state = createCombatState({ ownerId: interaction.user.id, ownerName: charName, weaponType });

    // Parse stats
    if (statsRaw) {
      parseEditInput(statsRaw, state);
      // maxhp override
      const mhpM = statsRaw.match(/maxhp:(\d+)/i);
      if (mhpM) { state.maxHp = parseInt(mhpM[1]); state.hp = Math.min(state.hp, state.maxHp); }
      const mlM = statsRaw.match(/maxlight:(\d+)/i);
      if (mlM) state.maxLight = Math.max(1, Math.min(6, parseInt(mlM[1])));
    }

    // Parse resistance
    if (resRaw) {
      const parts = resRaw.match(/([\d.]+)([BPS])/gi) || [];
      for (const p of parts) {
        const m = p.match(/([\d.]+)([BPS])/i);
        if (m) state.res[m[2].toUpperCase()] = parseFloat(m[1]);
      }
    }

    await interaction.deferReply();
    const msg = await interaction.editReply(buildCombatResponse(state));

    // Lưu session
    const sessionId = `${interaction.channelId}:${msg.id}`;
    state.messageId = msg.id;
    state.channelId = interaction.channelId;
    combatSessions.set(sessionId, state);
    return true;
  }

  // ── Modal: edit status save ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("combat:editsave:")) {
    const sessionId = interaction.customId.replace("combat:editsave:", "");
    const state = combatSessions.get(sessionId);
    if (!state) {
      await interaction.reply({ content: "❌ Session combat không còn tồn tại. Dùng `/combat` để bắt đầu mới.", ephemeral: true });
      return true;
    }

    const hpSta    = interaction.fields.getTextInputValue("hpSta");
    const lightRes = interaction.fields.getTextInputValue("lightRes");
    const effects  = interaction.fields.getTextInputValue("effects");
    const buffDebuff = interaction.fields.getTextInputValue("buffDebuff");

    parseEditInput(hpSta, state);
    parseResInput(lightRes, state);
    parseEditInput(effects, state);
    parseBuffDebuffInput(buffDebuff, state);

    // Kiểm tra stagger/panic sau edit
    if (state.sta <= 0 && !state.isStaggered) {
      state.isStaggered = true;
      state.staggerTurnsLeft = 1;
      state.res = { B: 2.0, P: 2.0, S: 2.0 };
      state.actionLog.push("💥 **STAGGER** (từ edit status)");
    }
    if (state.sanity <= SANITY_MIN && !state.isPanicked) {
      state.isPanicked = true;
      state.panicTurnsLeft = 1;
      state.actionLog.push("😱 **PANIC** (từ edit status)");
    }

    await interaction.update(buildCombatResponse(state));
    return true;
  }

  // ── Button interactions ──
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return false;

  const [prefix, action, ...rest] = interaction.customId.split(":");
  if (prefix !== "combat") return false;

  // Tìm session theo message
  const sessionId = `${interaction.channelId}:${interaction.message.id}`;
  const state = combatSessions.get(sessionId);

  if (!state) {
    await interaction.reply({ content: "❌ Session này đã hết hạn. Dùng `/combat` để bắt đầu trận mới.", ephemeral: true });
    return true;
  }

  // Chỉ owner của session mới được thao tác
  if (interaction.user.id !== state.ownerId) {
    await interaction.reply({ content: "❌ Đây không phải combat của bạn.", ephemeral: true });
    return true;
  }

  // Xử lý từng action
  let result = {};

  switch (action) {
    case "attack":
      result = handleAttack(state);
      break;
    case "dodge":
      result = handleDodge(state);
      break;
    case "guard":
      result = handleGuard(state);
      break;
    case "parry":
      result = handleParry(state);
      break;
    case "endturn":
      result = handleEndTurn(state);
      break;
    case "skill":
      // Hiện skill select menu (ephemeral)
      if (state.pages.length === 0) {
        await interaction.reply({
          content: "📖 Bạn chưa có Page nào. Thêm skill vào Pages qua `/combat` setup.\n> Tạm thời dùng `-skill <tên>` để roll skill riêng.",
          ephemeral: true,
        });
        return true;
      }
      await interaction.reply({
        content: "📖 Chọn Skill / Page:",
        components: [buildSkillSelectRow(state)],
        ephemeral: true,
      });
      return true;
    case "skillselect": {
      // String select — dùng skill đã chọn
      const selected = interaction.values[0];
      if (selected === "none") {
        await interaction.update({ content: "Không có Page.", components: [] });
        return true;
      }
      const pageKey = selected.replace("page:", "");
      const page = state.pages.find(p => p.key === pageKey);
      if (!page) {
        await interaction.update({ content: "❌ Không tìm thấy Page.", components: [] });
        return true;
      }
      const cd = state.skillCds[pageKey] ?? 0;
      if (cd > 0) {
        await interaction.update({ content: `❌ **${page.name}** đang CD (còn ${cd} turn).`, components: [] });
        return true;
      }
      // Parse light cost
      const lightCostMatch = page.cost ? String(page.cost).match(/(\d+)/) : null;
      const lightCost = lightCostMatch ? parseInt(lightCostMatch[1]) : 0;
      if (state.light < lightCost) {
        await interaction.update({ content: `❌ Không đủ Light (cần ${lightCost}, còn ${state.light}).`, components: [] });
        return true;
      }
      state.light -= lightCost;
      // Set CD
      const cdMatch = page.cd ? String(page.cd).match(/(\d+)/) : null;
      state.skillCds[pageKey] = cdMatch ? parseInt(cdMatch[1]) : 0;
      // Roll skill nếu có
      const rollLines = typeof page.roll === "function" ? page.roll() : ["*(Không có dice roll)*"];
      state.actionLog.push(`📖 **${page.name}** — ${lightCost > 0 ? `-${lightCost}💡` : ""}\n> ${rollLines.slice(0, 3).join("\n> ")}`);
      await interaction.update({
        content: `🎲 **${page.name}**\n${rollLines.join("\n")}`,
        components: [],
      });
      // Update main message
      try {
        const channel = interaction.client.channels.cache.get(state.channelId);
        const msg = await channel?.messages.fetch(state.messageId);
        if (msg) await msg.edit(buildCombatResponse(state));
      } catch { /* ignore */ }
      return true;
    }
    case "editstatus":
      await interaction.showModal(buildEditStatusModal(sessionId));
      return true;
    case "info":
      await interaction.reply({ embeds: [buildInfoEmbed()], ephemeral: true });
      return true;
    default:
      return false;
  }

  if (result.error) {
    await interaction.reply({ content: result.error, ephemeral: true });
    return true;
  }

  await interaction.update(buildCombatResponse(state));
  return true;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
  COMBAT_COMMAND_DEF,
  handleCombatInteraction,
  combatSessions,
};

// ═══════════════════════════════════════════════════════════════════════════
// HƯỚNG DẪN TÍCH HỢP VÀO index.js
// ═══════════════════════════════════════════════════════════════════════════
//
// 1. Ở đầu file index.js, sau các require:
//    const { COMBAT_COMMAND_DEF, handleCombatInteraction } = require("./combat-ui");
//
// 2. Trong mảng commands đăng ký slash (chỗ bạn khai báo "math", "parry"...):
//    COMBAT_COMMAND_DEF,  // thêm dòng này
//
// 3. Trong client.on("interactionCreate", async (interaction) => { ... }):
//    Thêm TRƯỚC tất cả if khác:
//
//    if (await handleCombatInteraction(interaction)) return;
//
//    --- Ví dụ đầy đủ ---
//    client.on("interactionCreate", async (interaction) => {
//      if (await handleCombatInteraction(interaction)) return;  // ← THÊM DÒNG NÀY
//      if (!interaction.isChatInputCommand()) return;
//      try {
//        if (interaction.commandName === "math") { ... }
//        ...
//      }
//    });
//
// 4. Đăng ký lại slash commands (chạy register script hoặc khởi động lại bot)
//
// 5. THÊM PAGES vào combat:
//    Pages trong combat-ui.js lấy từ state.pages — mảng objects:
//    { key: "fare-thee-well", name: "Fare-Thee Well", cost: "3", cd: "2", roll: SKILLS["fare-thee well"].roll }
//    Hiện tại setup chưa parse pages từ modal. Bạn có thể:
//    a) Hardcode pages mặc định trong createCombatState
//    b) Cho GM add pages qua lệnh riêng sau khi session tạo
//    c) Mở rộng setup modal thêm field "pages"
//
// ═══════════════════════════════════════════════════════════════════════════
