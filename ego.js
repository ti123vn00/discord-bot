// ego.js — Dữ liệu MANIFESTED E.G.O, mỗi nhân vật MỘT cái riêng.
//
// Fragaria chốt trực tiếp: "phần Manifested E.G.O thì MỖI NGƯỜI SẼ CÓ 1
// MANIFESTED E.G.O KHÁC NHAU nên KHÔNG THỂ DÙNG CHUNG như hiện tại được".
//
// VẤN ĐỀ CỦA BẢN CŨ: Manifest E.G.O chỉ là 1 cái CỜ (`player.manifestedEGO`) +
// cờ unlock `ManifestedEGOUnlock`. Danh sách skill E.G.O nằm rải trong skills.js
// gắn qua `weaponOf: "Manifested E.G.O (Hoshino)"` v.v., KHÔNG có gì buộc người
// chơi X chỉ được dùng E.G.O của X — ai unlock cũng xài chung kho.
//
// CÁCH LÀM: mỗi E.G.O là 1 entry có `owner` (tên nhân vật) + `skillKeys` (Critical
// riêng). Profile lưu `data.ManifestedEGO = "<key>"` — GM cấp qua `-flag`/
// `-setprofile`. Lúc join encounter, `player-join-builder.js` chép sang combatant
// để panel chỉ hiện ĐÚNG skill của E.G.O người đó.
//
// KHÔNG viết roll() ở đây — Critical vẫn nằm trong skills.js để dùng lại toàn bộ
// cơ chế sẵn có (autoBuildDmgStrFromSkillRoll / cdKeyFor / parser hiệu ứng).
// File này chỉ trả lời câu hỏi "E.G.O này của AI, gồm những skill nào".

const MANIFESTED_EGOS = {
  hoshino: {
    key: "hoshino",
    name: "Manifested E.G.O (Hoshino)",
    owner: "Hoshino",
    skillKeys: ["falco berigora", "wedjat"],
  },
  nihil: {
    key: "nihil",
    name: "Manifested E.G.O: Nihil",
    owner: null, // chưa gán chủ — GM chỉ định khi cấp
    skillKeys: ["beam of nihil", "abyssial life"],
  },
  havoc: {
    key: "havoc",
    name: "Manifested E.G.O (Havoc)",
    owner: null,
    skillKeys: ["instant of annihilation", "deadening abyss"],
  },
  // ── ID: "redmist" ────────────────────────────────────────────────────────
  // Cấp cho người chơi bằng: `-setprofile ManifestedEGO: redmist`
  // (hoặc `-setprofile ManifestedEGO: Red Mist` — findManifestedEgo tra được cả
  //  key, tên hiển thị lẫn tên chủ nhân).
  // ⚠️ NHỚ cấp KÈM cờ `ManifestedEGOUnlock` qua `-flag`, nếu không người chơi
  //    vẫn không bấm được nút Manifest (2 thứ độc lập: cờ mở khoá vs E.G.O nào).
  redmist: {
    key: "redmist",
    name: "Manifested E.G.O: Red Mist",
    owner: null, // chưa gán chủ — Fragaria chỉ định khi cấp
    skillKeys: ["reaching hand", "dense flesh"],
    // BGM riêng — phát khi Manifest bật, kéo dài tới khi Manifest hết.
    // CHỈ tên file; code tự ghép với /assets/audio/bgm/ (cùng quy ước
    // sfx-config.js). File .mp3 THẬT do Fragaria đặt vào repo.
    bgm: "Red Mist.mp3",
    // passives — MÔ TẢ để hiện cho người chơi. Phần CHẠY THẬT nằm ở code, tra
    // qua `mechanicId` (cùng khuôn với weapon.js/outfit.js passives).
    passives: [
      {
        name: "The Strongest",
        mechanicId: "redmist_the_strongest",
        desc: "Khi ở trạng thái Manifested E.G.O toàn bộ Dice bạn gieo đều **chắc chắn ra Max Dice**, nhận 100% Dmg Bonus, 10 <:DiceUp:1513767795681398894>Dice Up, 4 <:Fix_Haste:1513768004222062632>Haste, 100 Max Stamina, 50% Dmg Reduction kéo dài tới khi hết Manifested E.G.O. Nếu trong 1 Turn bạn không gây ra dmg tối thiểu bằng 15% Max HP của kẻ địch thì bản thân sẽ bị trừ một lượng Stamina bằng 50% Max Stamina. Nếu bạn bị Stagger ở trong trạng thái Manifested E.G.O, lập tức kết thúc trạng thái và bản thân nhận phải debuff **Shattered E.G.O**; khiến cho mọi sát thương của bản thân bị giảm một nửa, và mọi Dice bạn gieo đều **chắc chắn sẽ ra Min Dice** kéo dài trong 3 Turn",
      },
      {
        name: "The Red Mist",
        mechanicId: "redmist_the_red_mist",
        desc: "Cứ mỗi một kẻ địch bạn tiêu diệt được ở trong trạng thái Manifested E.G.O, bản thân nhận được 5 <:DiceUp:1513767795681398894>Dice Up kéo dài tới hết Encounter. Bạn được hồi máu dựa vào 4% sát thương gây ra",
      },
      {
        name: "The Mimic",
        mechanicId: "redmist_the_mimic",
        desc: "Nếu bạn đang sử dụng **Mimicry Blade**, biến nó trở thành **Mimicry: Synchronization**, cường hóa và khiến nó mở thêm một hình thái mới. Ở dạng kiếm sẽ có 28 Base Dmg/Slash/Medium. Ở dạng lưỡi hái sẽ có 56 Base Dmg/Slash/Heavy, đồng thời hiệu ứng Dmg Bonus từ Passive **The Imitation** được gia tăng gấp đôi. Yêu cầu HP để sử dụng Great Split: Horizontal được gỡ bỏ",
      },
    ],
  },
  // Bộ CHUNG cũ — giữ lại để profile đã cấp trước đây không mất E.G.O.
  // Ai chưa được gán E.G.O riêng thì rơi về đây (xem resolveManifestedEgo).
  default: {
    key: "default",
    name: "Manifested E.G.O",
    owner: null,
    skillKeys: ["crescent divinity", "purge of light"],
    isFallback: true,
  },
};

/** findManifestedEgo — tra theo key, tên hiển thị, hoặc tên CHỦ NHÂN. */
function findManifestedEgo(raw) {
  const key = (raw ?? "").toLowerCase().trim();
  if (!key) return null;
  if (MANIFESTED_EGOS[key]) return MANIFESTED_EGOS[key];
  for (const e of Object.values(MANIFESTED_EGOS)) {
    if (e.name.toLowerCase() === key) return e;
    if (e.owner && e.owner.toLowerCase() === key) return e;
  }
  return null;
}

/** resolveManifestedEgo — E.G.O mà combatant/profile này ĐƯỢC PHÉP dùng.
 *
 *  Thứ tự: cờ đã gán (`ManifestedEGO`) → khớp theo tên nhân vật → bộ chung cũ.
 *  Rơi về bộ chung là CÓ CHỦ ĐÍCH: profile được cấp `ManifestedEGOUnlock` từ
 *  trước bản này chưa có `ManifestedEGO`, không được để họ mất sạch E.G.O.
 */
function resolveManifestedEgo(profileOrCombatant) {
  if (!profileOrCombatant) return null;
  const explicit = profileOrCombatant.ManifestedEGO ?? profileOrCombatant.manifestedEgoKey;
  if (explicit) {
    const found = findManifestedEgo(explicit);
    if (found) return found;
  }
  const charName = profileOrCombatant.name ?? profileOrCombatant.characterName;
  if (charName) {
    const byOwner = findManifestedEgo(String(charName));
    if (byOwner) return byOwner;
  }
  return MANIFESTED_EGOS.default;
}

/** egoSkillKeysFor — danh sách Critical mà người này được dùng khi Manifest.
 *  Panel E.G.O đọc hàm này thay vì quét toàn bộ skills.js theo `weaponOf`. */
function egoSkillKeysFor(profileOrCombatant) {
  return resolveManifestedEgo(profileOrCombatant)?.skillKeys ?? [];
}

/** egoPassivesFor — passive của Manifested E.G.O người này đang mang.
 *  Dùng cho phần HIỂN THỊ (panel/`-balance`). Logic thật tra bằng hasEgoMechanic. */
function egoPassivesFor(profileOrCombatant) {
  return resolveManifestedEgo(profileOrCombatant)?.passives ?? [];
}

/** hasEgoMechanic — combatant này có passive E.G.O mang `mechanicId` đó không.
 *
 *  ⚠️ CHỈ đúng khi đang BẬT Manifest. Passive của Manifested E.G.O không phải
 *  buff bị động thường trực — nó chỉ tồn tại trong lúc trạng thái đang chạy.
 *  Gate luôn ở đây thay vì bắt 8 nơi gọi tự nhớ kiểm `manifestedEGO` (sót 1 chỗ
 *  là passive rò rỉ ra ngoài trạng thái, rất khó thấy).
 *
 *  KHÔNG dùng `egoSkillKeysFor` để suy ra passive — người chơi rơi về bộ chung
 *  (`default`) thì KHÔNG có passive nào, đúng như trước bản này.
 */
function hasEgoMechanic(combatant, mechanicId) {
  if (!combatant?.manifestedEGO) return false;
  return egoPassivesFor(combatant).some(p => p.mechanicId === mechanicId);
}

/** egoBgmFor — file BGM của Manifested E.G.O người này ĐANG BẬT, hoặc null.
 *  Gate `manifestedEGO` ngay tại đây (cùng lý do với hasEgoMechanic). */
function egoBgmFor(combatant) {
  if (!combatant?.manifestedEGO) return null;
  return resolveManifestedEgo(combatant)?.bgm ?? null;
}

/** resolveEncounterBgm — BGM NÊN phát ở encounter này ngay lúc này.
 *
 *  Ưu tiên BGM của Manifested E.G.O đang bật; không ai đang Manifest thì trả
 *  BGM thường của trận (`encounter.currentBgm`).
 *
 *  ⚠️ CỐ Ý TÍNH LẠI TỪ STATE mỗi lần thay vì ghi đè `currentBgm` lúc Manifest
 *  rồi khôi phục lúc hết: cách ghi-đè-rồi-khôi-phục cần một cú "trả lại" chạy
 *  đúng ở MỌI đường kết thúc Manifest (hết Duration, bị Stagger, người chơi
 *  chết, encounter kết thúc giữa chừng...). Sót một đường là trận đó kẹt BGM
 *  E.G.O vĩnh viễn mà không ai biết vì sao. Hàm thuần này không thể kẹt.
 *
 *  Nhiều người cùng Manifest thì lấy người ĐẦU TIÊN có bgm — không trộn được 2
 *  bài, và không có luật nào nói ai ưu tiên nên chọn quy ước đơn giản, ổn định.
 */
function resolveEncounterBgm(encounter) {
  // Ưu tiên 1 — BGM TÌNH HUỐNG của The Index (Wound-Casing Mask / Furioso).
  // Fragaria:
  //   • Dùng Furioso mà VẪN CÒN mặt nạ ⇒ **Saikai1.mp3**, kéo dài turn này và
  //     turn kế (`saikai1TurnsLeft`, turn-advance đếm ngược).
  //   • Mặt nạ VỠ và Sizzling Wound quay lại ⇒ **Saikai2.mp3**.
  // ⚠️ Saikai1 đứng TRƯỚC Saikai2. Dùng Furioso khi còn mặt nạ sẽ LÀM VỠ mặt nạ
  // NGAY, nên cả hai điều kiện cùng đúng ở turn đó. Nếu để Saikai2 trước thì
  // Saikai1 KHÔNG BAO GIỜ phát được — trái hẳn "phát Saikai1 trong turn VÀ turn
  // kế". Saikai1 hết 2 turn thì Saikai2 (trạng thái không đảo ngược) tiếp quản.
  for (const p of Object.values(encounter?.players ?? {})) {
    if ((p?.saikai1TurnsLeft ?? 0) > 0) return "Saikai1.mp3";
  }
  for (const p of Object.values(encounter?.players ?? {})) {
    if (p?.hasWoundCasingMask && p?.woundCasingMaskIntact === false && p?.sizzlingWound) return "Saikai2.mp3";
  }
  // Ưu tiên 2 — BGM của Manifested E.G.O đang bật.
  for (const p of Object.values(encounter?.players ?? {})) {
    const bgm = egoBgmFor(p);
    if (bgm) return bgm;
  }
  return encounter?.currentBgm ?? null;
}

/** describeEncounterBgm — nhãn ĐÚNG NGUỒN cho bài đang phát.
 *  Fragaria: mô tả đang ghi "Saikai2.mp3 — BGM Manifested E.G.O (còn tới khi hết
 *  trạng thái)" trong khi đó là BGM của **Furioso**. Dán nhãn theo nguồn thật. */
function describeEncounterBgm(encounter) {
  const name = resolveEncounterBgm(encounter);
  if (!name) return null;
  for (const p of Object.values(encounter?.players ?? {})) {
    if ((p?.saikai1TurnsLeft ?? 0) > 0) {
      const v = p.lastFuriosoName ?? "Furioso";
      return { name, label: `BGM **${v}** (kéo dài 2 Turn)` };
    }
  }
  for (const p of Object.values(encounter?.players ?? {})) {
    if (p?.hasWoundCasingMask && p?.woundCasingMaskIntact === false && p?.sizzlingWound) {
      return { name, label: "BGM **Sizzling Wound** — Wound-Casing Mask đã vỡ (tới hết Encounter)" };
    }
  }
  for (const p of Object.values(encounter?.players ?? {})) {
    if (egoBgmFor(p)) return { name, label: "BGM **Manifested E.G.O** (còn tới khi hết trạng thái)" };
  }
  return { name, label: "BGM trận này" };
}

module.exports = { describeEncounterBgm, egoBgmFor, resolveEncounterBgm, MANIFESTED_EGOS, findManifestedEgo, resolveManifestedEgo, egoSkillKeysFor, egoPassivesFor, hasEgoMechanic };
