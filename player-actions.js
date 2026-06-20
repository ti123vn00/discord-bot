// player-actions.js
// Tách executeGive / executeRemove / buildProfileInfoEmbed ra khỏi index.js để file
// chính gọn hơn và dễ test độc lập 3 hàm này.
//
// Dùng dependency-injection factory (module.exports = (deps) => {...}) THAY VÌ để
// module này tự `require("@upstash/redis")` và tạo redis client riêng — nếu làm vậy
// sẽ có 2 client cùng trỏ vào 1 DB (tốn connection, dễ lệch nếu sau này thêm cache/retry
// logic ở 1 trong 2 nơi mà quên đồng bộ). Factory pattern đảm bảo CHỈ 1 nguồn redis
// client + helper (clampExp, calcGrade, v.v.) dùng chung giữa index.js và module này.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

module.exports = function createPlayerActions(deps) {
  const {
    redis,
    getPlayerDataWithSlot,
    saveMultiplePlayerData,
    savePlayerData,
    calcExpForGrade,
    clampExp,
    calcGrade,
    getActiveProfileSlot,
    getProfileNames,
    resolveProfileLabel,
    getVNDateString,
    playerKeyForSlot,
    dailyKeyForSlot,
    withTimeout,
    unwrapPipelineResults,
    formatNumber,
    auditLog,
    EXP_MAX,
    MAX_PROFILES,
    PROFILE_EMOJIS,
  } = deps;

  /**
   * executeGive — logic chung cho cả prefix -give và slash /give
   * @param {object} opts
   * @param {string}  opts.senderId
   * @param {string}  opts.targetId
   * @param {boolean} opts.isAdmin
   * @param {number}  opts.ahnGain    — 0 nếu không chuyển Ahn
   * @param {string|null} opts.bookName
   * @param {number}  opts.bookCount
   * @param {string|null} opts.itemName
   * @param {number}  opts.itemCount
   * @param {number|null} opts.expGain   — admin only, KHÔNG trừ kho admin (cấp phát, không phải chuyển)
   * @param {number|null} opts.gradeTarget — admin only, KHÔNG trừ kho admin (cấp phát, không phải chuyển)
   * @returns {Promise<string[]>} mảng change strings
   */
  async function executeGive({ senderId, targetId, isAdmin, ahnGain = 0, bookName = null, bookCount = 1, itemName = null, itemCount = 1, expGain = 0, gradeTarget = null }) {
    // QUAN TRỌNG: admin chuyển ahn/book/item cũng PHẢI mất tài nguyên thật của họ, giống
    // user thường — trước đây admin "cho" miễn phí (không trừ gì cả), tạo ra ahn/sách/item
    // ra từ không khí, phá vỡ economy. Chỉ exp/grade vẫn miễn phí cho admin vì đó là CẤP
    // PHÁT (set trực tiếp), không phải "chuyển" thứ admin đang có trong kho.
    const needsSenderData = ahnGain > 0 || !!bookName || !!itemName;
    let senderData = null, senderSlot = null;
    if (needsSenderData) {
      // Dùng getPlayerDataWithSlot để pin slot tại thời điểm đọc — tránh TOCTOU nếu user
      // switch profile giữa lúc đọc và lưu (saveMultiplePlayerData sẽ dùng slot này luôn).
      const r = await getPlayerDataWithSlot(senderId);
      senderData = r.data;
      senderSlot = r.slot;
      senderData.books = senderData.books ?? {};
      senderData.items = senderData.items ?? {};
    }
    const { data: recipientData, slot: recipientSlot } = await getPlayerDataWithSlot(targetId);
    recipientData.books = recipientData.books ?? {};
    recipientData.items = recipientData.items ?? {};

    // Validate đủ tài nguyên — áp dụng cho CẢ admin khi chuyển ahn/book/item (không còn
    // miễn trừ riêng cho admin ở phần này nữa).
    if (ahnGain > 0) {
      const senderAhn = senderData.ahn ?? 0;
      if (senderAhn < ahnGain) throw new Error(`Bạn không đủ Ahn. Bạn có **${formatNumber(senderAhn)} Ahn**, cần **${formatNumber(ahnGain)} Ahn**.`);
    }
    if (bookName) {
      const owned = senderData.books?.[bookName] ?? 0;
      if (owned < bookCount) throw new Error(`Bạn không đủ sách. Bạn có **${owned}** **${bookName}**, cần **${bookCount}**.`);
    }
    if (itemName) {
      const owned = senderData.items?.[itemName] ?? 0;
      if (owned < itemCount) throw new Error(`Bạn không đủ vật phẩm. Bạn có **${owned}** **${itemName}**, cần **${itemCount}**.`);
    }

    const changes = [];

    // Không cho phép dùng cả grade lẫn exp cùng lúc — grade overwrite exp về giá trị
    // cố định, khiến expGain bị nuốt hoàn toàn mà không báo lỗi (do else-if ẩn đi).
    if (gradeTarget !== null && expGain !== 0) {
      throw new Error("Không thể dùng `grade` và `exp` cùng lúc. Chọn một trong hai.");
    }

    if (gradeTarget !== null) {
      const expNeeded = calcExpForGrade(gradeTarget);
      recipientData.exp = expNeeded;
      changes.push(`Grade set → **Grade ${gradeTarget}** (EXP set thành **${expNeeded}**)`);
    } else if (expGain !== 0) {
      recipientData.exp = clampExp((recipientData.exp ?? 0) + expGain);
      changes.push(`${expGain > 0 ? "+" : ""}${expGain} EXP → tổng **${recipientData.exp}**/${EXP_MAX}`);
    }
    if (ahnGain !== 0) {
      const ahnBefore = recipientData.ahn ?? 0;
      recipientData.ahn = Math.max(0, ahnBefore + ahnGain);
      // Dùng actualAhnChange thay vì ahnGain để log đúng số tiền thực sự thay đổi
      // (VD: admin give ahn: -50000 cho user chỉ có 10000 → actualChange = -10000, không phải -50000)
      const actualAhnChange = recipientData.ahn - ahnBefore;
      changes.push(`${actualAhnChange >= 0 ? "+" : ""}${formatNumber(actualAhnChange)} Ahn`);
      // Chỉ trừ kho sender khi ahnGain > 0 (chuyển thật). ahnGain < 0 (chỉ admin mới được
      // phép) là admin XÓA Ahn của recipient — không liên quan đến kho của admin.
      if (ahnGain > 0) senderData.ahn = (senderData.ahn ?? 0) - ahnGain;
    }
    if (bookName) {
      recipientData.books[bookName] = Math.max(0, (recipientData.books[bookName] ?? 0) + bookCount);
      changes.push(`+${bookCount} 📚 **${bookName}**`);
      senderData.books[bookName] -= bookCount;
      if (senderData.books[bookName] <= 0) delete senderData.books[bookName];
    }
    if (itemName) {
      recipientData.items[itemName] = Math.max(0, (recipientData.items[itemName] ?? 0) + itemCount);
      changes.push(`+${itemCount} 🔩 **${itemName}**`);
      senderData.items[itemName] -= itemCount;
      if (senderData.items[itemName] <= 0) delete senderData.items[itemName];
    }

    const saveEntries = [{ userId: targetId, data: recipientData, slot: recipientSlot }];
    if (needsSenderData) saveEntries.push({ userId: senderId, data: senderData, slot: senderSlot });
    await saveMultiplePlayerData(saveEntries);

    // Audit log — chỉ ghi khi admin thực hiện, để có trail truy vết hành động quyền lực
    // (set grade, cộng/trừ exp/ahn cho người khác, v.v.). Give thường (non-admin, tự
    // chuyển tài sản của mình) không cần audit vì không có đặc quyền nào được dùng.
    if (isAdmin) {
      auditLog("give", senderId, targetId, { ahnGain, bookName, bookCount, itemName, itemCount, expGain, gradeTarget });
    }

    return changes;
  }

  /**
   * executeRemove — logic chung cho cả prefix -remove và slash /remove
   * @param {object} opts
   * @param {string}  opts.actorId    — userId người thực hiện lệnh
   * @param {string}  opts.targetId   — userId bị xóa
   * @param {boolean} opts.isAdmin
   * @param {number}  opts.expRemove
   * @param {number}  opts.ahnRemove
   * @param {Array<{name:string,count:number}>} opts.bookEntries  — có thể rỗng
   * @param {Array<{name:string,count:number}>} opts.itemEntries  — có thể rỗng
   * @returns {Promise<string[]>} mảng change strings
   */
  async function executeRemove({ actorId, targetId, isAdmin, expRemove = 0, ahnRemove = 0, bookEntries = [], itemEntries = [] }) {
    // ahnRemove âm sẽ khiến Math.max(0, before - ahnRemove) bên dưới "cộng" Ahn ngược lại
    // (before - (-x) = before + x) — chặn ngay từ đây để /remove không bị dùng như /give.
    if (ahnRemove < 0) throw new Error("Giá trị `ahn` để xóa không được âm. Dùng `/give` nếu muốn cộng thêm Ahn.");
    const { data, slot } = await getPlayerDataWithSlot(targetId);
    data.books = data.books ?? {};
    data.items = data.items ?? {};
    const changes = [];

    if (expRemove !== 0) {
      const before = data.exp ?? 0;
      data.exp = Math.max(0, before - expRemove);
      changes.push(`-${expRemove} EXP (${before} → ${data.exp})`);
    }
    if (ahnRemove !== 0) {
      const before = data.ahn ?? 0;
      data.ahn = Math.max(0, before - ahnRemove);
      changes.push(`-${formatNumber(ahnRemove)} Ahn (${formatNumber(before)} → ${formatNumber(data.ahn)})`);
    }
    for (const { name, count } of bookEntries) {
      const owned = data.books[name] ?? 0;
      if (owned < count && !isAdmin) throw new Error(`Bạn chỉ có **${owned}** **${name}**, không đủ để xóa **${count}**.`);
      const removed = Math.min(owned, count);
      data.books[name] = owned - removed;
      if (data.books[name] <= 0) delete data.books[name];
      changes.push(`-${removed} 📚 **${name}** (còn lại: ${data.books[name] ?? 0})`);
    }
    for (const { name, count } of itemEntries) {
      const owned = data.items[name] ?? 0;
      if (owned < count && !isAdmin) throw new Error(`Bạn chỉ có **${owned}** **${name}**, không đủ để xóa **${count}**.`);
      const removed = Math.min(owned, count);
      data.items[name] = owned - removed;
      if (data.items[name] <= 0) delete data.items[name];
      changes.push(`-${removed} 🔩 **${name}** (còn lại: ${data.items[name] ?? 0})`);
    }

    await savePlayerData(targetId, data, slot);

    // Audit log — chỉ ghi khi admin thực hiện (xóa exp/ahn của người khác, hoặc xóa
    // sách/item vượt quá số lượng thực có nhờ đặc quyền admin).
    if (isAdmin) {
      auditLog("remove", actorId, targetId, { expRemove, ahnRemove, bookEntries, itemEntries });
    }

    return changes;
  }

  /**
   * buildProfileInfoEmbed — logic chung cho cả prefix `-profile info` và slash `/profile info`.
   * Lấy dữ liệu của tất cả MAX_PROFILES profile (qua 1 pipeline) và build embed tổng quan.
   * @param {string} userId
   * @param {string} displayName — tên hiển thị của user (displayName ?? username)
   * @param {string} footerText  — text gợi ý lệnh đổi profile, khác nhau giữa prefix/slash
   * @returns {Promise<{embed: object, components: ActionRowBuilder[]}>} embed + nút chuyển profile
   */
  async function buildProfileInfoEmbed(userId, displayName, footerText) {
    const currentSlot = await getActiveProfileSlot(userId);

    // Lấy tất cả dữ liệu MAX_PROFILES profile trong 1 pipeline thay vì N lần gọi tuần tự
    const pipe = redis.pipeline();
    for (let s = 1; s <= MAX_PROFILES; s++) {
      pipe.get(playerKeyForSlot(userId, s));
      pipe.get(dailyKeyForSlot(userId, s));
    }
    const [pipeResults, profileNames] = await Promise.all([
      withTimeout(pipe.exec()).then(unwrapPipelineResults),
      getProfileNames(userId),
    ]);
    // pipeResults layout: [player1, daily1, player2, daily2, ...]

    const today = getVNDateString();
    const lines = [];
    for (let s = 1; s <= MAX_PROFILES; s++) {
      const label = resolveProfileLabel(profileNames, s);
      try {
        const rawPlayer = pipeResults[(s - 1) * 2];
        const rawDaily  = pipeResults[(s - 1) * 2 + 1];
        const d  = rawPlayer ? (typeof rawPlayer === "string" ? JSON.parse(rawPlayer) : rawPlayer) : null;
        const dd = rawDaily  ? (typeof rawDaily  === "string" ? JSON.parse(rawDaily)  : rawDaily)  : null;
        const claimedToday = dd && dd.lastClaim === today;
        const streak = dd ? (dd.streak ?? 0) : 0;
        if (d) {
          const { grade } = calcGrade(d.exp ?? 0);
          lines.push(
            `${s === currentSlot ? "▶️" : PROFILE_EMOJIS[s]} **${label}**${s === currentSlot ? " *(đang dùng)*" : ""}\n` +
            `> 🏅 Grade **${grade}** | EXP: ${d.exp ?? 0} | Ahn: ${(d.ahn ?? 0).toLocaleString()}\n` +
            `> 📅 Daily: ${claimedToday ? "✅ Đã nhận hôm nay" : "🔲 Chưa nhận"} | Streak: ${streak}/7`
          );
        } else {
          lines.push(
            `${s === currentSlot ? "▶️" : PROFILE_EMOJIS[s]} **${label}**${s === currentSlot ? " *(đang dùng)*" : ""}\n` +
            `> *(chưa có dữ liệu)*`
          );
        }
      } catch (e) {
        lines.push(`${PROFILE_EMOJIS[s]} **${label}**: *(lỗi: ${e.message})*`);
      }
    }

    // Nút chuyển profile — disable nút của slot đang dùng để tránh switch vào chính nó.
    const switchButtons = [];
    for (let s = 1; s <= MAX_PROFILES; s++) {
      const label = resolveProfileLabel(profileNames, s);
      switchButtons.push(
        new ButtonBuilder()
          .setCustomId(`profswitch:${userId}:${s}`)
          .setLabel(`${PROFILE_EMOJIS[s]} ${label}`)
          .setStyle(s === currentSlot ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(s === currentSlot)
      );
    }
    // Discord giới hạn tối đa 5 button/row — MAX_PROFILES = 5 vẫn vừa 1 row,
    // nhưng chia sẵn theo nhóm 5 để an toàn nếu sau này tăng thêm.
    const components = [];
    for (let i = 0; i < switchButtons.length; i += 5) {
      components.push(new ActionRowBuilder().addComponents(...switchButtons.slice(i, i + 5)));
    }

    return {
      embed: {
        title: `👤 Profiles của ${displayName}`,
        description: lines.join("\n\n"),
        color: 0x5865f2,
        footer: { text: footerText },
      },
      components,
    };
  }

  return { executeGive, executeRemove, buildProfileInfoEmbed };
};
