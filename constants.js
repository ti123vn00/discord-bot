// constants.js
// Các giá trị giới hạn được dùng chung giữa index.js (logic + xử lý lệnh)
// và deploy-commands.js (khai báo slash command với Discord).
//
// Mục đích: tránh duplicate magic numbers ở 2 file — nếu sau này cần đổi 1
// giới hạn (VD: tăng SINKING_MAX, tăng số lần mở cache tối đa, thêm profile...)
// thì chỉ cần sửa ở đây, cả slash command validation (Discord) và logic xử lý
// (index.js) sẽ tự động đồng bộ.

module.exports = {
  // /math: Sanity ban đầu của địch tối thiểu (dùng để tính Sinking khi địch đạt -45)
  SANITY_MIN: -45,

  // /math: Poise stacks tối đa (1 stack = 5% crit)
  POISE_MAX: 99,

  // /math: Sinking counts tối đa của địch
  SINKING_MAX: 99,

  // /math: Rupture counts tối đa của địch
  RUPTURE_MAX: 99,

  // /parry: số lần roll tối đa mỗi lệnh
  PARRY_MAX_ROLLS: 30,

  // /randombook, /randomsealedbook, /chipboardcache: số lần mở tối đa mỗi lệnh
  OPEN_COUNT_MAX: 20,

  // /profile: số lượng save profile tối đa cho mỗi user
  MAX_PROFILES: 3,
};
