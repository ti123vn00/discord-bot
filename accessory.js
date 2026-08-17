// accessory.js — Dữ liệu Accessory, tách riêng khỏi skills.js theo yêu cầu. Mỗi
// người được mang tối đa 3 Accessory (xem luật "Trang bị" — 1 vũ khí + 1 outfit +
// 3 accessory). Mỗi Accessory có passives (mô tả TỰ DO, GM tự áp dụng).
//
// QUAN TRỌNG (phát hiện sau khi đối chiếu): "Furioso" (đòn ultimate 9-dice của Găng
// Tay Câm Lặng) ĐÃ CÓ SẴN trong skills.js (key "furioso") với ĐÚNG 9 dice/effect —
// KHÔNG lặp lại roll() ở đây nữa, chỉ giữ criticalSkillKey để biết roll qua đâu.
// 3 passive (Dimension Pocket/A Prayer For Loving Sorrow/Orlando Furioso) KHÔNG bị
// trùng ở đâu khác — vẫn giữ nguyên mô tả đầy đủ ở đây.
const A_REALIZATION = "<:Realization:1449582220481134705>Realization";
const A_BLACKSILENCE = "<:BlackSilence:1449581989400281260>Struggling";

const ACCESSORIES = {
  "memories compassion": {
    name: "Memories: Compassion",
    exclusive: true,
    // CHỈ có tác dụng khi đang dùng Lucent Historia (Fragaria ghi rõ) — mọi hiệu
    // ứng bên dưới đều kiểm `weaponName === "Lucent Historia"` trong code.
    requiresWeapon: "Lucent Historia",
    passives: [
      { name: "Memories: Compassion", desc: "*Chỉ có tác dụng khi dùng **Lucent Historia***\n> - Gia tăng **100 Max HP**, nhưng bạn KHÔNG BAO GIỜ đạt được hay heal lên ngưỡng 100 máu thêm này\n> - Gia tăng **x2 hiệu quả nhận Shield** cho đồng đội khi họ dưới 30% HP\n> - Đồng đội nhận được Shield sẽ **giảm 0,2x mọi Resistance** cho bản thân" },
    ],
  },
  "day one of my new life": {
    name: "Day One of My New Life",
    // "Nón Ánh Sáng (Bảo Hộ)" — LOẠI exclusive MỚI: chỉ đeo được 1 Nón Ánh Sáng
    // cùng lúc (khác `exclusive: true` vốn là "không trùng chính nó").
    exclusiveType: "Nón Ánh Sáng",
    // Tinh luyện 1→5, ghép 2 cái cùng tên lên 1 tầng. Hiệu suất tạo khiên
    // 16% + 2%/tầng vượt 1 ⇒ tầng 5 = 16 + 2×4 = 24%.
    refinable: { maxTier: 5, baseShieldPct: 16, perTierShieldPct: 2 },
    passives: [
      { name: "At This Very Moment", desc: "• Gia tăng **16% hiệu suất tạo khiên** (mỗi tầng tinh luyện +2%, tối đa **24%** ở tầng 5)\n> - Giảm **0,1x Res** của TOÀN BỘ đồng đội khi bạn còn ở trên sân *(không stack nếu người khác cũng có passive này)*" },
      { name: "Nón Ánh Sáng", desc: "Độc nhất — không thể equip Accessory khác thuộc loại **Nón Ánh Sáng**. Khi trang bị, bạn chuyển thành vận mệnh của nó." },
    ],
  },

  "gang tay cam lang": {
    name: "Găng Tay Câm Lặng",
    passives: [
      { name: "Dimension Pocket", desc: "Cho phép bạn trữ toàn bộ vũ khí của Black Silence bên trong cặp găng [Maximum 9 cái]. Có thể thay đổi vũ khí giữa trận bằng cách tiêu hao 1 Light" },
      { name: "A Prayer For Loving Sorrow", desc: `Mỗi lần đổi vũ khí Black Silence bằng Dimension Pocket và sử dụng Critical của chúng bạn nhận được 1 ${A_REALIZATION} [Mỗi vũ khí chỉ cho 1 ${A_REALIZATION} cho đến khi tổng số stack được reset lại]. Khi trên hoặc bằng 5 ${A_REALIZATION} bạn nhận được một buff **Mặt nạ chống nhận thức** cho phép đòn tấn công của bạn trở thành Unclashable và đòn tấn công cuối cùng của bạn vào mỗi turn sẽ nhận được hiệu ứng [Unevadeable] [Unblockable] [Unparriable]` },
      { name: "Orlando Furioso", desc: `Khi đủ 9 ${A_REALIZATION} lần tiếp theo bạn đổi vũ khí, thay vì đổi bạn sẽ sử dụng Furioso. Xóa toàn bộ stack ${A_REALIZATION} hiện tại trên người và nhận được 1 Stack ${A_BLACKSILENCE} trong 3 Turn. Trong lúc có stack ${A_BLACKSILENCE} bạn sẽ không thể nhận được thêm ${A_REALIZATION} và mọi page bạn xài sẽ được -1 Light Cost [Page có Light Cost là 1 thì vẫn là 1] đồng thời mọi critical của vũ khí của bạn được +4 Dice Up` },
    ],
    // Furioso ĐÃ CÓ trong skills.js (key "furioso") — roll qua `-skill furioso`.
    criticalSkillKey: "furioso",
  },
  "perfect cube": {
    name: "Perfect Cube",
    passives: [
      { name: "Perfect Start", desc: "Bạn start encounter với 50% Max Light hiện tại" },
      { name: "Perfect Mind", mechanicId: "perfect_mind_double_coin_sanity",
        desc: "Nhận **x2 hiệu quả Sanity** từ Emotion Coin." },
      { name: "Perfect Body", desc: "Mỗi turn end được hồi 10 HP" },
    ],
  },
  "giay wan mk3": {
    name: "Giày Wan MK3",
    passives: [
      { name: "Quickstep", desc: "Mỗi 3 đòn Critical của bạn, đòn critical tiếp theo sẽ reset cd ngay (Phải cùng là 1 đòn)" },
      { name: "Chain-Dashes", desc: "Cứ mỗi hai lần né thì lần né tiếp theo sẽ né được 2 hit" },
      { name: "Resourceful", desc: "Các hành động phòng thủ được refund 1/4 Stamina" },
    ],
  },
  "wound casing mask": {
    name: "Wound-Casing Mask",
    exclusive: true,
    requiresFaction: "The Index Syndicate",
    // Gate ĐẶC BIỆT: phải ĐANG mang injury "Sizzling Wound" mới đeo được.
    requiresInjury: "Sizzling Wound",
    passives: [
      { name: "Wound-Casing Mask", mechanicId: "index_wound_casing_mask",
        desc: "Vô hiệu hoá **Sizzling Wound** của bạn. Mặt nạ **VỠ** khi bạn bị Stagger hoặc dùng biến thể **Furioso** lần đầu — vết thương cũ quay lại, **Sizzling Wound** hoạt động tới hết Encounter\n> - Miễn nhiễm **Stagger**\n> - **50% Dmg Reduction**\n> - Sanity bị cap ở **-40** (không thể giảm thêm)\n> - Dmg từ Burn/Bleed **không thể giết** bạn\n> - Start Encounter: Sanity set về **45**. Khi **Sizzling Wound** hoạt động: Dmg Reduction **50% → 75%** và nhận **3 Dice Up**\n> - Mỗi Turn Start, nếu có **Unlock - I/II/III**: nhận **5/10/20 Poise**; mỗi 1 Poise thừa sau 20 cho **+2% Dmg Bonus**" + " Nhận **x2 hiệu quả Sanity** từ Emotion Coin." },
    ],
  },
  "the oracles proxy prescript device": {
    name: "The Oracle's Proxy Prescript Device",
    exclusive: true,
    // Gate KÉP: phải ở The Index Syndicate VÀ đang mặc The Index Oracle's Proxy.
    requiresFaction: "The Index Syndicate",
    requiresOutfit: "The Index Oracle's Proxy",
    passives: [
      { name: "Undertake Prescript", mechanicId: "index_undertake_prescript",
        desc: "Nếu turn TRƯỚC bạn hoàn thành ít nhất 1 sắc lệnh, turn này hồi **10 Sanity**. Lần ĐẦU nhận **Unlock - I/II/III** trong trận thì hồi thêm **20 Sanity** mỗi tầng." },
      { name: "Grace of God", mechanicId: "index_grace_of_god",
        desc: "Từ **Unlock - II** trở đi, **dice đầu tiên của Caduceus mỗi turn do bạn tự chọn**" },
      { name: "Prescript Delivered on a Device", mechanicId: "index_prescript_device",
        desc: "Vào **Unlock - III**: không còn nhận **Karmic Consequence** khi trượt sắc lệnh. Đồng thời mọi Dice thành **Unbreakable Dice** — thua clash vẫn gây **50%** sát thương ban đầu" },
    ],
  },
  "providence of the prescript": {
    name: "Providence of the Prescript",
    exclusive: true,
    requiresFaction: "The Index Syndicate",
    passives: [
      { name: "Providence of the Prescript", mechanicId: "index_providence",
        desc: "Khi gây <:Sinking:1513762793436741652>Sinking/<:Rupture:1513762812722155682>Rupture, nhận thêm 3 <:Poise:1513762945715142736>Poise\n> - Nhận Poise theo cách trên **3 lần** thì turn kế **Crit Mul +0.3**\n> - Khi bản thân có **≥20 Poise**: mỗi đòn đánh trúng gây thêm 1 Sinking và 1 Rupture" },
    ],
  },
  "composition tool": {
    name: "Composition Tool",
    passives: [
      { name: "Reactive", desc: "Cho khả năng kháng Stagger hai lần mỗi encounter" },
      { name: "Shimmering", desc: "Cho 1 <:Light:1513786082502770719>Light khi né hoặc parry thành công" },
      { name: "Energetic", desc: "Gia tăng x2 hiệu quả nhận Emotion Coin" },
    ],
  },
};

/** findAccessory — tra theo key chuẩn hoá hoặc tên hiển thị (case-insensitive). */
function findAccessory(raw) {
  const key = (raw ?? "").toLowerCase().trim();
  if (ACCESSORIES[key]) return ACCESSORIES[key];
  for (const a of Object.values(ACCESSORIES)) {
    if (a.name.toLowerCase() === key) return a;
  }
  return null;
}

/** validateAccessoryEquip — LUẬT DUY NHẤT quyết định có đeo được hay không.
 *
 *  Gom về MỘT chỗ vì trước đây luật nằm rải rác: lệnh text `-equipaccessory` kiểm
 *  `exclusiveType`, dropdown `-balance` kiểm thêm `exclusive`, còn "không cho cùng
 *  1 accessory ở nhiều slot" thì KHÔNG ĐÂU kiểm cả — nên đeo được 2 Composition
 *  Tool (Fragaria gửi ảnh). Fragaria cũng dặn trước: *"sau này cũng sẽ có 1 số
 *  loại passive không cho stack hay đi chung với nhau nên cần chú ý"* ⇒ mọi luật
 *  mới chỉ cần thêm vào ĐÂY, hai đường equip tự có ngay.
 *
 *  @param equipped mảng slot hiện tại (có thể chứa null), ĐÃ trừ slot đang thay.
 *  @returns { ok: true } | { ok: false, reason: "<lý do hiển thị cho người chơi>" }
 */
function validateAccessoryEquip({ accessory, equipped = [], ownedCount = 0, owner = null }) {
  if (!accessory) return { ok: false, reason: "Không tìm thấy accessory này." };
  const worn = equipped.filter(Boolean);

  // (1) KHÔNG cho cùng 1 accessory ở nhiều slot — MẶC ĐỊNH cho MỌI accessory.
  //     Trước đây chỉ món khai `exclusive: true` mới bị chặn (mà cờ đó cũng chưa
  //     nơi nào đọc), nên Composition Tool xếp được 2 slot và passive chồng nhau.
  if (worn.some(n => n === accessory.name)) {
    return { ok: false, reason: `Bạn đã đeo **${accessory.name}** rồi — mỗi accessory chỉ đeo được **1 cái** cùng lúc, kể cả khi sở hữu nhiều bản.` };
  }

  // (2) Sở hữu đủ số lượng.
  if (ownedCount < 1) {
    return { ok: false, reason: "Bạn không còn sở hữu món này." };
  }

  // (3) exclusiveType — chỉ 1 món mỗi LOẠI (VD "Nón Ánh Sáng (Bảo Hộ)").
  if (accessory.exclusiveType) {
    const clash = worn.find(n => findAccessory(n)?.exclusiveType === accessory.exclusiveType);
    if (clash) {
      return { ok: false, reason: `Thuộc loại **${accessory.exclusiveType}** — bạn đang đeo **${clash}** (cùng loại). Chỉ được đeo 1 món loại này.` };
    }
  }

  // (3b) GATE THEO NGƯỜI CHƠI — faction / title / outfit / injury.
  //      Fragaria: *"sau này sẽ có nhiều đồ bị gate faction cũng như title"* ⇒ dựng
  //      sẵn cả 4 loại gate ở ĐÂY, món mới chỉ cần khai `requiresX` là có ngay.
  //      `owner` = { faction, title, equippedOutfit, injuries } — truyền từ nơi gọi;
  //      KHÔNG truyền thì bỏ qua gate (giữ tương thích với chỗ gọi cũ).
  if (owner) {
    const norm = (v) => String(v ?? "").trim().toLowerCase();
    if (accessory.requiresFaction && norm(owner.faction) !== norm(accessory.requiresFaction)) {
      return { ok: false, reason: `**${accessory.name}** chỉ dùng được khi bạn thuộc **${accessory.requiresFaction}**.` };
    }
    if (accessory.requiresTitle && norm(owner.title) !== norm(accessory.requiresTitle)) {
      return { ok: false, reason: `**${accessory.name}** yêu cầu chức danh **${accessory.requiresTitle}**.` };
    }
    if (accessory.requiresOutfit && norm(owner.equippedOutfit) !== norm(accessory.requiresOutfit)) {
      return { ok: false, reason: `**${accessory.name}** chỉ dùng được khi đang mặc **${accessory.requiresOutfit}**.` };
    }
    if (accessory.requiresInjury
        && !(owner.injuries ?? []).some(i => norm(i) === norm(accessory.requiresInjury))) {
      return { ok: false, reason: `**${accessory.name}** chỉ dùng được khi bạn đang mang **${accessory.requiresInjury}**.` };
    }
  }

  // (4) incompatibleWith — hai món KHÔNG đi chung được (chưa món nào dùng, dựng
  //     sẵn theo lời dặn của Fragaria). Kiểm CẢ HAI CHIỀU để chỉ cần khai 1 bên.
  const incompatible = (accessory.incompatibleWith ?? []).map(n => String(n).toLowerCase());
  const clash2 = worn.find(n => {
    const other = findAccessory(n);
    if (!other) return false;
    if (incompatible.includes(other.name.toLowerCase())) return true;
    return (other.incompatibleWith ?? []).some(x => String(x).toLowerCase() === accessory.name.toLowerCase());
  });
  if (clash2) {
    return { ok: false, reason: `**${accessory.name}** không đi chung được với **${clash2}** đang đeo.` };
  }
  return { ok: true };
}

/** dedupeEquippedAccessories — dọn loadout CŨ đã lỡ trùng trước khi có luật (1).
 *  Giữ bản ĐẦU TIÊN, các bản trùng sau đổi thành null (KHÔNG splice — slot là
 *  mảng cố định 3 ô, splice sẽ làm lệch index ở mọi nơi khác).
 *  @returns { list, removed: [tên đã gỡ] } */
function dedupeEquippedAccessories(equipped = []) {
  const seen = new Set();
  const removed = [];
  const list = equipped.map(n => {
    if (!n) return n;
    if (seen.has(n)) { removed.push(n); return null; }
    seen.add(n);
    return n;
  });
  return { list, removed };
}

module.exports = { ACCESSORIES, findAccessory, validateAccessoryEquip, dedupeEquippedAccessories };
