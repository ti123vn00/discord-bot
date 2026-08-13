// gacha-system.js
// Logic gacha (pull, đổi Pity) + UI panel — TÁCH khỏi index.js theo yêu cầu
// trực tiếp: "tách nhỏ file index.js ra các file js khác" (code đã lên tới
// 11k+ dòng). COPY NGUYÊN VĂN (không sửa 1 dòng logic nào).

module.exports = function ({ ActionRowBuilder, ButtonBuilder, ButtonStyle, GACHA_BANNERS, GACHA_COST_PER_PULL, GACHA_PITY_MAX, GACHA_RATES, VALID_BOOKS, formatNumber, getPlayerDataWithSlot, isBannerActive, rollGachaOnce, savePlayerData, withLock }) {

/** pityKeyFor — ô đếm Pity của banner. Banner khai `pityGroup` dùng CHUNG ô đó
 *  với mọi banner cùng nhóm; không khai thì dùng chính bannerKey (hành vi cũ). */
function pityKeyFor(bannerKey) {
  return GACHA_BANNERS[bannerKey]?.pityGroup ?? bannerKey;
}

/** pityPoolFor — danh sách Tier 3 được phép đổi bằng Pity ở banner này. Nếu
 *  banner thuộc 1 nhóm chung pity thì gom Tier 3 của TOÀN BỘ nhóm. */
function pityPoolFor(bannerKey) {
  const group = GACHA_BANNERS[bannerKey]?.pityGroup;
  if (!group) return GACHA_BANNERS[bannerKey]?.poolRare ?? [];
  return [...new Set(Object.values(GACHA_BANNERS)
    .filter(b => b.pityGroup === group)
    .flatMap(b => b.poolRare))];
}

async function performGachaPull(userId, count, bannerKey) {
  let resultInfo;
  await withLock(userId, async () => {
    const banner = GACHA_BANNERS[bannerKey];
    if (!banner) throw new Error(`Banner "${bannerKey}" không tồn tại.`);
    if (!isBannerActive(bannerKey)) {
      throw new Error(`**${banner.name}** đã kết thúc — không thể pull nữa.`);
    }
    const { data: profileData, slot } = await getPlayerDataWithSlot(userId);
    const totalCost = GACHA_COST_PER_PULL * count;
    const currentLunacy = profileData.lunacy ?? 0;
    if (currentLunacy < totalCost) {
      throw new Error(`Không đủ <:Lunacy:1524989409529823342>Lunacy — cần **${formatNumber(totalCost)}** (${count} lần × ${GACHA_COST_PER_PULL}), hiện có **${formatNumber(currentLunacy)}**.`);
    }
    profileData.lunacy = currentLunacy - totalCost;
    profileData.items = profileData.items ?? {};
    profileData.books = profileData.books ?? {};
    // pity — GAP ĐÃ SỬA (xác nhận trực tiếp): "khi chưa roll ra 1 món đồ nào của
    // Tier 3 thì sẽ tích Pity, 1 Pity = 1 roll khi đạt 100 có thể đổi bất kỳ 1
    // món từ Tier 3" — lưu riêng theo TỪNG banner (profileData.gachaPity[bannerKey]).
    // pityKeyFor — banner khai `pityGroup` thì DÙNG CHUNG một ô đếm pity với mọi
    // banner cùng nhóm (Fragaria: "6 banner share chung pity"). Banner không khai
    // thì giữ nguyên hành vi cũ (pity riêng theo bannerKey) — không phá dữ liệu
    // pity đã tích của Standard/Naruto.
    const pityKey = pityKeyFor(bannerKey);
    profileData.gachaPity = profileData.gachaPity ?? {};
    profileData.gachaPity[pityKey] = profileData.gachaPity[pityKey] ?? 0;
    const results = [];
    const rareHits = [];
    for (let i = 0; i < count; i++) {
      const { item, tier } = rollGachaOnce(bannerKey);
      // BUG ĐÃ SỬA (xác nhận trực tiếp): trước đây MỌI thứ rớt ra (kể cả sách)
      // đều bị cộng thẳng vào profileData.items — sách phải nằm ở profileData.books
      // (đúng chỗ -inventory/-give hiện có đã phân biệt từ trước, VALID_BOOKS là
      // danh sách sách hợp lệ CHUẨN — dùng lại để định tuyến đúng, không đoán).
      if (VALID_BOOKS.includes(item)) {
        profileData.books[item] = (profileData.books[item] ?? 0) + 1;
      } else {
        profileData.items[item] = (profileData.items[item] ?? 0) + 1;
      }
      results.push(item);
      if (tier === 3) {
        rareHits.push(item);
        // ❗❗ BUG ĐÃ SỬA (Fragaria 12/08: "user đủ 100 pity bấm -gacha, không đổi
        // ngay mà -gacha tiếp là MẤT SẠCH pity" — ảnh: "cần 100, hiện có 0").
        // GỐC: rơi Tier 3 tự nhiên `= 0` xoá TRẮNG, kể cả phần đã đủ 100 mà người
        // chơi CHƯA kịp đổi. Quyền đổi đã kiếm được bị bốc hơi chỉ vì họ pull thêm.
        // LUẬT ĐÚNG: Tier 3 xoá **tiến độ đang tích dở**, KHÔNG xoá **quyền đổi đã
        // đủ**. Giữ lại bội số nguyên của 100, bỏ phần lẻ.
        //   pity 150 + Tier 3 → 100 (còn 1 quyền đổi)   ·   pity 50 → 0
        const pityNow = profileData.gachaPity[pityKey] ?? 0;
        profileData.gachaPity[pityKey] = Math.floor(pityNow / GACHA_PITY_MAX) * GACHA_PITY_MAX;
      } else {
        profileData.gachaPity[pityKey] += 1;
      }
    }
    await savePlayerData(userId, profileData, slot);
    const counted = {};
    for (const item of results) counted[item] = (counted[item] ?? 0) + 1;
    const resultLines = Object.entries(counted).map(([item, n]) => `${banner.poolRare.includes(item) ? "🌟" : banner.poolMid.includes(item) ? "✨" : "▫️"} ${item}${n > 1 ? ` x${n}` : ""}`);
    resultInfo = { totalCost, resultLines, rareHits, remainingLunacy: profileData.lunacy, pity: profileData.gachaPity[pityKey], pityShared: pityKey !== bannerKey };
  });
  return resultInfo;
}

/** performPityExchange — GAP ĐÃ SỬA (xác nhận trực tiếp): "1 Pity = 1 roll khi
 *  đạt 100 có thể đổi bất kỳ 1 món từ Tier 3" — trừ đúng 100 Pity, cộng thẳng
 *  item Tier 3 đã chọn vào inventory (KHÔNG reset Pity về 0 hoàn toàn — chỉ trừ
 *  đúng 100 đã dùng, phần dư nếu có vẫn giữ lại, dù hiếm khi vượt quá 100 vì
 *  UI chỉ cho đổi khi vừa chạm mốc). */
async function performPityExchange(userId, bannerKey, chosenItem) {
  let resultInfo;
  await withLock(userId, async () => {
    const banner = GACHA_BANNERS[bannerKey];
    if (!banner) throw new Error(`Banner "${bannerKey}" không tồn tại.`);
    // Pity dùng chung nhóm thì phần thưởng đổi cũng phải chọn được từ CẢ NHÓM —
    // nếu không thì "share pity" chỉ đúng một nửa (tích chung mà tiêu bị bó vào
    // đúng 1 banner).
    const allowedRare = pityPoolFor(bannerKey);
    if (!allowedRare.includes(chosenItem)) {
      throw new Error(`"${chosenItem}" không thuộc Tier 3 có thể đổi ở **${banner.name}**.`);
    }
    const { data: profileData, slot } = await getPlayerDataWithSlot(userId);
    const pityKey = pityKeyFor(bannerKey);
    profileData.gachaPity = profileData.gachaPity ?? {};
    const currentPity = profileData.gachaPity[pityKey] ?? 0;
    if (currentPity < GACHA_PITY_MAX) {
      throw new Error(`Chưa đủ Pity — cần **${GACHA_PITY_MAX}**, hiện có **${currentPity}**.`);
    }
    profileData.gachaPity[pityKey] = currentPity - GACHA_PITY_MAX;
    profileData.items = profileData.items ?? {};
    profileData.items[chosenItem] = (profileData.items[chosenItem] ?? 0) + 1;
    await savePlayerData(userId, profileData, slot);
    resultInfo = { chosenItem, remainingPity: profileData.gachaPity[pityKey] };
  });
  return resultInfo;
}

/** buildGachaPanelEmbed — bảng UI gacha đẹp (xác nhận trực tiếp: "nên làm ra một
 *  cái UI gacha cùng với hiển thị rate, danh sách để cho nó đẹp") — hiện đủ 3
 *  tier + % TỪNG item (tính từ GACHA_RATES/pool.length, không phải chỉ % tổng
 *  tier) + Lunacy hiện có + Pity hiện tại + nút Pull x1/x10. */
function buildGachaPanelEmbed(lunacy, bannerKey, pity) {
  const banner = GACHA_BANNERS[bannerKey];
  const rateHigh = (GACHA_RATES.high / banner.poolHigh.length).toFixed(2);
  const rateMid = (GACHA_RATES.mid / banner.poolMid.length).toFixed(2);
  const rateRare = (GACHA_RATES.rare / banner.poolRare.length).toFixed(2);
  // Banner chung pity — nói rõ để người chơi biết roll ở banner nào cũng cộng
  // chung, và đổi Pity được chọn Tier 3 của cả nhóm.
  const groupBanners = banner.pityGroup
    ? Object.values(GACHA_BANNERS).filter(b => b.pityGroup === banner.pityGroup)
    : [];
  const sharedPityNote = groupBanners.length > 1
    ? `\n🔗 **Pity dùng CHUNG** với ${groupBanners.length} banner Herta — đổi Pity chọn được Tier 3 của bất kỳ banner nào trong nhóm:\n> ${pityPoolFor(bannerKey).map(i => `🌟 ${i}`).join(" · ")}`
    : "";
  const deadlineNote = banner.expiresAt
    ? `\n⏳ Kết thúc: **${new Date(banner.expiresAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}** (giờ VN)`
    : "";
  return {
    title: `🎰 Gacha — ${banner.name}`,
    color: 0x9b59b6,
    description: `Bạn có **${formatNumber(lunacy)}** <:Lunacy:1524989409529823342>Lunacy | Chi phí: **${GACHA_COST_PER_PULL}**/lần\n` +
      `🎯 Pity: **${pity}/${GACHA_PITY_MAX}** (đủ 100 → đổi bất kỳ 1 item Tier 3)${sharedPityNote}${deadlineNote}`,
    fields: [
      {
        name: `▫️ Rate cao — ${GACHA_RATES.high}% tổng (mỗi item ${rateHigh}%)`,
        value: banner.poolHigh.map(i => `• ${i}`).join("\n"),
        inline: false,
      },
      {
        name: `✨ Rate trung bình — ${GACHA_RATES.mid}% tổng (mỗi item ${rateMid}%)`,
        value: banner.poolMid.map(i => `• ${i}`).join("\n"),
        inline: false,
      },
      {
        name: `🌟 Rate rất thấp — ${GACHA_RATES.rare}% tổng (mỗi item ${rateRare}%)`,
        value: banner.poolRare.map(i => `• ${i}`).join("\n"),
        inline: false,
      },
    ],
    footer: { text: "Trúng item rất thấp (🌟) → liên hệ GM để thiết kế cụ thể." },
  };
}

function buildGachaPanelButtons(userId, bannerKey, pity) {
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gachapull:${userId}:1:${bannerKey}`).setLabel(`🎰 Pull x1 (${GACHA_COST_PER_PULL} Lunacy)`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gachapull:${userId}:10:${bannerKey}`).setLabel(`🎰 Pull x10 (${GACHA_COST_PER_PULL * 10} Lunacy)`).setStyle(ButtonStyle.Success),
  )];
  // Nút "Đổi Pity" — GAP ĐÃ SỬA (xác nhận trực tiếp): chỉ hiện khi đã đủ 100,
  // bấm vào sẽ mở dropdown chọn 1 trong các item Tier 3 của banner này.
  if (pity >= GACHA_PITY_MAX) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gachapity:${userId}:${bannerKey}`).setLabel(`🎯 Đổi Pity (${pity}/${GACHA_PITY_MAX})`).setStyle(ButtonStyle.Danger),
    ));
  }
  return rows;
}

  return { performGachaPull, performPityExchange, pityKeyFor, pityPoolFor, buildGachaPanelEmbed, buildGachaPanelButtons };
};
