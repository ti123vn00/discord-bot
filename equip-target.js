// equip-target.js
// Hàm resolveEquipTarget (parse @mention prefix cho admin equip-hộ trong các lệnh
// -equipweapon/-equipoutfit/...) — tách khỏi index.js theo yêu cầu trực tiếp:
// "tiếp tục tách đi". HOÀN TOÀN THUẦN, chỉ cần ADMIN_IDS.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ ADMIN_IDS }) {

  function resolveEquipTarget(message, rawInput) {
    const isAdmin = ADMIN_IDS.has(message.author.id);
    const mentionMatch = rawInput.match(/^<@!?(\d+)>\s*/);
    if (isAdmin && mentionMatch) {
      const mentionedUser = message.mentions.users.first();
      return {
        targetUserId: mentionMatch[1],
        targetLabel: mentionedUser ? mentionedUser.username : mentionMatch[1],
        remainingInput: rawInput.slice(mentionMatch[0].length).trim(),
      };
    }
    return { targetUserId: message.author.id, targetLabel: null, remainingInput: rawInput };
  }

  return { resolveEquipTarget };
};
