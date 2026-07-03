// inventory-display.js
// Hệ thống hiển thị Inventory (buildInventoryPages, buildInvEmbed, buildInvRow,
// buildInvSelectMenu, fetchInventoryReply) — tách khỏi index.js theo yêu cầu
// trực tiếp: "tách tiếp đi, một mạch luôn". Dùng dependency-injection.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require("discord.js");

module.exports = function ({ getPlayerData, INV_PAGE_SIZE }) {

  function buildInventoryPages(targetUser, data) {
    const books = data.books ?? {};
    const items = data.items ?? {};
    const bookEntries = Object.entries(books).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));
    const itemEntries = Object.entries(items).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));
    if (bookEntries.length === 0 && itemEntries.length === 0) return null;
  
    const totalBooks = bookEntries.reduce((s, [, c]) => s + c, 0);
    const totalItems = itemEntries.reduce((s, [, c]) => s + c, 0);
    const pages = [];
  
    // ── Sách ──
    for (let i = 0; i < bookEntries.length; i += INV_PAGE_SIZE) {
      const chunk = bookEntries.slice(i, i + INV_PAGE_SIZE);
      const isLast = i + INV_PAGE_SIZE >= bookEntries.length;
      const from = i + 1, to = Math.min(i + INV_PAGE_SIZE, bookEntries.length);
      const fields = [{
        name: `📚 Sách (${from}–${to} / ${bookEntries.length})`,
        value: chunk.map(([name, count]) => `• **${name}** × ${count}`).join("\n"),
        inline: false,
      }];
      if (isLast) fields.push({ name: "📊 Tổng sách", value: `**${totalBooks}** cuốn`, inline: true });
      pages.push(fields);
    }
  
    // ── Vật phẩm ──
    for (let i = 0; i < itemEntries.length; i += INV_PAGE_SIZE) {
      const chunk = itemEntries.slice(i, i + INV_PAGE_SIZE);
      const isLast = i + INV_PAGE_SIZE >= itemEntries.length;
      const from = i + 1, to = Math.min(i + INV_PAGE_SIZE, itemEntries.length);
      const fields = [{
        name: `🔩 Vật phẩm (${from}–${to} / ${itemEntries.length})`,
        value: chunk.map(([name, count]) => `• **${name}** × ${count}`).join("\n"),
        inline: false,
      }];
      if (isLast) fields.push({ name: "📊 Tổng vật phẩm", value: `**${totalItems}** cái`, inline: true });
      pages.push(fields);
    }
  
    return pages;
  }
  
  /** Build embed object cho trang `page` (0-indexed).*/
  function buildInvEmbed(targetUser, pages, page) {
    return {
      title: `🎒 Inventory của ${targetUser.displayName ?? targetUser.username}`,
      color: 0xf0a500,
      fields: pages[page],
      footer: pages.length > 1 ? { text: `Trang ${page + 1} / ${pages.length}` } : undefined,
    };
  }
  
  /** Build ActionRow nút Prev/Next. */
  function buildInvRow(targetUserId, page, totalPages) {
    // Dùng Math.max/min để đảm bảo customId không chứa page âm (-1) hoặc vượt bound
    // khi button bị disabled. Không ảnh hưởng đến logic vì button disabled không click được,
    // nhưng tránh trường hợp Discord reject customId không hợp lệ.
    const prevPage = Math.max(0, page - 1);
    const nextPage = Math.min(totalPages - 1, page + 1);
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`invpage:${targetUserId}:${prevPage}`)
        .setLabel("◀ Trước")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`invpage:${targetUserId}:${nextPage}`)
        .setLabel("Sau ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === totalPages - 1),
    );
  }
  
  /**
   * Build StringSelectMenu chứa các item trên ĐÚNG trang đang hiển thị.
   * QUAN TRỌNG: buildInventoryPages sinh trang sách TRƯỚC (1..bookPageCount),
   * rồi trang item SAU — không gộp chung. Hàm này phải dùng đúng công thức
   * bookPageCount = Math.ceil(books.length / INV_PAGE_SIZE) để xác định trang
   * hiện tại đang ở phía "sách" hay phía "item", nếu không select menu sẽ liệt
   * kê sai item so với embed đang hiển thị.
   */
  function buildInvSelectMenu(targetUserId, data, page) {
    const books = Object.entries(data.books ?? {}).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));
    const items = Object.entries(data.items ?? {}).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));
  
    const bookPageCount = Math.ceil(books.length / INV_PAGE_SIZE); // = 0 nếu không có sách
  
    let chunk, type;
    if (page < bookPageCount) {
      chunk = books.slice(page * INV_PAGE_SIZE, (page + 1) * INV_PAGE_SIZE);
      type = "book";
    } else {
      const itemPage = page - bookPageCount;
      chunk = items.slice(itemPage * INV_PAGE_SIZE, (itemPage + 1) * INV_PAGE_SIZE);
      type = "item";
    }
    if (chunk.length === 0) return null;
  
    const options = chunk.map(([name, count]) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${name} ×${count}`)
        .setDescription(type === "book" ? "📚 Sách" : "🔩 Vật phẩm")
        .setValue(`${type}:${name}`)
        .setEmoji(type === "book" ? "📖" : "🔩")
    );
  
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`invsel:${targetUserId}:${page}`)
        .setPlaceholder("📋 Chọn item để thao tác...")
        .addOptions(options)
    );
  }
  
  /** Wrapper async dùng chung cho prefix và slash command. */
  async function fetchInventoryReply(targetUser, page = 0) {
    const data = await getPlayerData(targetUser.id);
    const pages = buildInventoryPages(targetUser, data);
    if (!pages) return null;
    const clampedPage = Math.max(0, Math.min(page, pages.length - 1));
    const embed = buildInvEmbed(targetUser, pages, clampedPage);
  
    const components = [];
    if (pages.length > 1) components.push(buildInvRow(targetUser.id, clampedPage, pages.length));
    const selectMenu = buildInvSelectMenu(targetUser.id, data, clampedPage);
    if (selectMenu) components.push(selectMenu);
  
    return { embeds: [embed], components };
  }

  return {
    buildInventoryPages,
    buildInvEmbed,
    buildInvRow,
    buildInvSelectMenu,
    fetchInventoryReply,
  };
};
