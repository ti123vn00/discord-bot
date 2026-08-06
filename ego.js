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

module.exports = { MANIFESTED_EGOS, findManifestedEgo, resolveManifestedEgo, egoSkillKeysFor };
