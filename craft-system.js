// craft-system.js
// Hàm executeCraft (craft vật phẩm bằng nguyên liệu trong kho) — tách khỏi
// index.js theo yêu cầu trực tiếp: "tiếp tục tách đi". Chỉ cần CRAFT_RECIPES
// (const, định nghĩa TRƯỚC vị trí gốc trong index.js — không có rủi ro TDZ) +
// getPlayerDataWithSlot/savePlayerData (Redis, inject).
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ CRAFT_RECIPES, getPlayerDataWithSlot, savePlayerData }) {

  async function executeCraft(userId, itemName, craftCount) {
    const recipe = CRAFT_RECIPES[itemName];
    const { data, slot } = await getPlayerDataWithSlot(userId);
    const totalCost = {};
    for (const [mat, qty] of Object.entries(recipe.inputs)) totalCost[mat] = qty * craftCount;
    const shortages = [];
    for (const [mat, needed] of Object.entries(totalCost)) {
      const owned = data.items[mat] ?? 0;
      if (owned < needed) shortages.push(`• **${mat}**: cần **${needed}**, có **${owned}** (thiếu **${needed - owned}**)`);
    }
    if (shortages.length > 0) {
      throw new Error(`Không đủ nguyên liệu để craft **${craftCount}× ${itemName}**:\n` + shortages.join("\n"));
    }
    for (const [mat, needed] of Object.entries(totalCost)) {
      data.items[mat] = (data.items[mat] ?? 0) - needed;
      if (data.items[mat] <= 0) delete data.items[mat];
    }
    const outputLines = [];
    for (const [out, qty] of Object.entries(recipe.output)) {
      const gained = qty * craftCount;
      data.items[out] = (data.items[out] ?? 0) + gained;
      outputLines.push(`**${gained}× ${out}**`);
    }
    await savePlayerData(userId, data, slot);
    const costLines = Object.entries(totalCost)
      .map(([mat, qty]) => `• -${qty} **${mat}** (còn lại: ${data.items[mat] ?? 0})`);
    return { outputLines, costLines };
  }

  return { executeCraft };
};
