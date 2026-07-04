// encounter-persistence.js
// Lớp Redis persistence của encounter (encounterKey, getEncounter, saveEncounter,
// deleteEncounter) — tách khỏi index.js theo yêu cầu trực tiếp: "tiếp tục tách
// đi". Dùng RẤT RỘNG khắp file (73 lần) nhưng chỉ cần sửa 1 nơi định nghĩa (mọi
// nơi gọi không cần đổi gì). Đã có 1 file khác (encounter-actions.js) inject
// sẵn 3 trong 4 hàm này — vị trí require nằm SAU dòng này trong index.js nên an
// toàn (không TDZ).
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

module.exports = function ({ redis, withTimeout }) {

  function encounterKey(channelId) {
    return `encounter:${channelId}`;
  }
  
  async function getEncounter(channelId) {
    const raw = await withTimeout(redis.get(encounterKey(channelId)));
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  
  async function saveEncounter(channelId, data) {
    await withTimeout(redis.set(encounterKey(channelId), JSON.stringify(data)));
  }
  
  async function deleteEncounter(channelId) {
    await withTimeout(redis.del(encounterKey(channelId)));
  }

  return { encounterKey, getEncounter, saveEncounter, deleteEncounter };
};
