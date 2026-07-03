// book-system.js
// Hệ thống đọc sách (BOOK_GRANTS data + 5 hàm xử lý lựa chọn 2-tầng) — tách khỏi
// index.js theo yêu cầu trực tiếp: "tiếp tục tách hàm ra thành file riêng". Dùng
// pattern dependency-injection GIỐNG player-actions.js/skill-tree.js (factory
// function nhận dependency làm tham số, tránh circular require với index.js).
//
// findBook GIỮ NGUYÊN trong index.js (KHÔNG tách theo dù được dùng ở đây) — vì
// nó được dùng RỘNG RÃI ở NHIỀU nơi KHÁC không liên quan tới đọc sách (VD -give/
// -remove/-setplayer đều validate tên sách qua findBook) — inject vào thay vì
// định nghĩa lại 2 lần.
//
// discord.js builder classes (StringSelectMenuOptionBuilder/ActionRowBuilder/
// StringSelectMenuBuilder) require TRỰC TIẾP ở đây — AN TOÀN, discord.js là
// package NPM độc lập, không có circular dependency với index.js.
//
// COPY NGUYÊN VĂN từ index.js (không sửa 1 dòng logic nào).

const { StringSelectMenuOptionBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require("discord.js");

module.exports = function ({ findBook, getPlayerDataWithSlot, savePlayerData }) {

  const BOOK_GRANTS = {
    // "Book Thường" = "Book of Fixer" theo cách gọi ngoài đời (xác nhận trực tiếp từ
    // GM) — TÊN CHÍNH THỨC trong code/inventory LUÔN là "Book Thường".
    "Book Thường": {
      pages: [
        "Light Attack", "Crush", "You're Too Slow", "Dodge and Strike", "Fleet Footsteps",
        "Focused Strikes", "Charge and Cover", "Thrust", "Alleyway Counter", "Right Hook",
        "Opportunistic Slash", "Y-you Only Live Once", "Deep Cuts", "Mutilate", "Sky Kick",
        "Drop Kick", "Backstreets Scramble", "Stylish Sweeps", "Shocking Blow",
        "Onslaught Command", "Preemptive Strike", "Set Fire",
      ],
      weapons: [], outfits: ["Casual Outfit", "Rats Outfit", "Businessman", "Ambitious Fixer"],
    },
    "Zwei Association Book": {
      pages: ["Blade Whirl", "Client Protection", "Standoff", "Law and Order"],
      weapons: ["Zweihander"], outfits: ["Zwei Association"],
    },
    "Red Mist Book": {
      pages: ["Level Slash", "Onrush", "Spear", "Focus Spirit"],
      weapons: ["Mimicry Blade"], outfits: [],
    },
    "Hana Association Book": {
      pages: ["Augury Crusher", "Augury Infusion", "Celestial Sight", "Augury Kick"],
      weapons: ["Augury Spear"], outfits: ["Hana Association"],
    },
    "Kurokumo Syndicate Book": {
      pages: ["Cloud Cutter", "Sky Clearing Cut", "Shadowcloud Shattercleaver", "Dark Cloud Cleaver", "Sober Up", "Silent Mist", "Shadowcloud Kick"],
      weapons: ["Kurokumo Katana"], outfits: ["Kurokumo Wakashu"],
    },
    "Shi Association Book": {
      pages: ["Catch Breath", "Extreme Edge", "Flying Sword"],
      weapons: ["Shi Association Katana"], outfits: ["Shi Association"],
    },
    "Arbiter Book": {
      pages: ["Degraded Fairy", "Degraded Pillar", "Degraded Lock", "Degraded Shockwave"],
      weapons: [], outfits: [],
    },
    "Liu Association Book": {
      pages: ["Perfected Death Fist", "Raging Storm", "Fiery Waltz", "Red Kick", "Flowing Flame", "Fleet Edge", "Flow of the Sword"],
      weapons: ["Liu Martial Arts", "Liu Guan Dao"], outfits: ["Liu Association"],
    },
    "Dieci Association Book": {
      pages: ["Weight of Knowledge", "Illuminate Thy Vacuity", "Studious Dedication", "Scorch Knowledge"],
      weapons: ["Dieci Association Kata", "Dieci Association Key"], outfits: ["Dieci Association"],
    },
    "Thumb Syndicate Book": {
      pages: ["Coin Trick", "Summary Judgement", "Pistol Draw"],
      weapons: ["Soldato Rifle"], outfits: ["Thumb Soldato"],
    },
    "Black Silence Book": {
      pages: ["Blade Flourish", "Waltz in White", "Waltz in Black"],
      weapons: ["Durandal", "Mook Workshop", "Crystal Atelier", "Zelkova Workshop", "Atelier Logic", "Old Boys Workshop", "Wheel's Industry", "Allas Workshop", "Ranga Workshop"],
      outfits: [],
    },
    "Middle Syndicate Book": {
      pages: ["Proof of Loyalty", "Just A Vengeance", "Punching", "Kicking"],
      weapons: ["Chains of Loyalty"], outfits: ["The Middle Little Sibling"],
    },
    "The Middle Big Brother Book": {
      pages: ["My Hair Coupon", "Complete and Total Extermination!", "Vengeance Retaliation", "Stamp of Vengeance", "Punting"],
      weapons: [], outfits: ["The Middle Big Sibling"],
    },
    "Seven Association Book": {
      pages: ["Dissect Target", "Swash", "Profiling"],
      weapons: ["Seven Association Longsword"], outfits: ["Seven Association"],
    },
    "Udjat Book": {
      pages: ["Sand Split", "Furūsiyya", "Jamadhar", "Mirage Incision", "Khopesh Swordplay"],
      weapons: ["Udjat Khopesh"], outfits: ["Udjat"],
    },
    "Warp Corp Book": {
      pages: ["Charge Shield", "Leap", "Overcharged Ripple"],
      weapons: ["WARP Corp. Dagger", "WARP Corp. Gauntlets"], outfits: ["WARP Corp. Cleaner"],
    },
    "Reverbation Ensemble Book": {
      pages: ["Lupine Onslaught", "Kick And Stomps", "Rapacious Assault", "Pitch-Black Pulverizer"],
      weapons: ["L'Heure du Loup", "Yesterday's Promise", "Reverberation Scythe", "The Crying Children"],
      outfits: ["Reverberation Ensemble"],
    },
    "Cinq Association Book": {
      pages: ["Contre Attaque", "Engagement", "Balestra Fente"],
      weapons: ["Viriscent Pyrojade Ring", "Cinq Rapier"], outfits: ["Cinq Association"],
    },
    "Blade Lineage Syndicate Book": {
      pages: ["Slash Series", "Overthrow", "Moon Splitting Draw", "Red Plum Blossom Scatter", "Fare-Thee Well", "Draw of The Sword", "Acupuncture"],
      weapons: ["Blade Lineage Hwando"], outfits: ["Blade Lineage", "Blade Lineage Salsu", "Blade Lineage Mentor"],
    },
    "Ring Syndicate Book": {
      pages: ["Sanguine Painting", "Hematic Coloring", "Paint Over"],
      weapons: ["Pointillist Brush"], outfits: ["Pointillist's Uniform"],
    },
    "Fragment Book": {
      pages: ["Greatsword Rend", "Beheading", "Smackdown", "Memorial Procession"],
      weapons: ["Fused Blade of Ruined Mirror Worlds"], outfits: [],
    },
    "Index Syndicate Book": {
      pages: ["Execute Prescript", "Somber Procuration", "Will of The City"],
      weapons: ["Index Cleaver", "Index Longsword"], outfits: ["Index Proselyte"],
    },
    "Book of M.A.D.": {
      pages: ["Soulburn", "Inferno Burst", "Celestial Fire", "Take this, Kid", "Learn again, Kid"],
      weapons: [], outfits: [],
    },
    "Red Gaze Book": {
      pages: ["Silence", "Scorching Incision", "Following the Flow"],
      weapons: [], outfits: [],
    },
    "N Corp Book": {
      pages: ["Purify", "Cackle"],
      weapons: [], outfits: [],
    },
    "Sweeping Book": {
      pages: ["Extract Fuel", "Trash Disposal"],
      weapons: [], outfits: [],
    },
    "Library Book": {
      pages: ["Light Dash"],
      weapons: [], outfits: [],
      isEgoOnly: true,
      // groups — CẤU TRÚC THẬT (mảng tên, không phải text) để hệ thống CHỌN-1-KHI-ĐỌC
      // dựng dropdown được — 45 lựa chọn (1 Light Dash + 44 Page trong 7 nhóm) VƯỢT
      // giới hạn 25 option/dropdown của Discord, nên chọn theo 2 TẦNG: tầng 1 chọn
      // "Light Dash" HOẶC 1 trong 7 tên nhóm, nếu chọn nhóm thì tầng 2 mới chọn ĐÚNG
      // 1 Page cụ thể trong nhóm đó (mỗi nhóm 4-8 Page, luôn dưới 25).
      groups: {
        "Keter": ["Fervent Beats", "Wrist Cutter", "Marionette", "Aspiration", "Frost Splinter"],
        "Hod": ["Look of the Day", "Today's Expression", "Sanguine Desire", "Red Eyes", "Laetitia", "Black Swan"],
        "Netzach": ["Echoes from the Beyond", "The Finale", "Fragments from Somewhere", "Our Galaxy", "Pleasure", "Faint Aroma", "Da Capo"],
        "Yesod": ["Violence", "Grinder Mk. 5-2", "Harmony", "Solemn Lament", "Magic Bullet", "Regret"],
        "Malkuth": ["Display of Affection", "Fourth Match Flame", "Wingbeat", "Hornet", "Green Stem", "The Forgotten"],
        "Binah": ["Beak", "Punishing Beak", "Lamp", "Eyes Lamp", "Justitia", "The Justice Scale", "Twillight", "Apocalypse"],
        "Chesed": ["Torn Off Wisdom", "Harvest", "Logging", "The Homing Instinct", "Faded Memories", "False Throne"],
      },
      note: "Đọc 1 cuốn = CHỌN ĐÚNG 1 Page (Light Dash HOẶC 1 Page cụ thể trong 1 trong 7 nhóm Keter/Hod/Netzach/Yesod/Malkuth/Binah/Chesed) — TOÀN BỘ đều là E.G.O Page. Muốn Page khác cần đọc thêm cuốn khác.",
    },
  };
  
  function getBookTopLevelChoices(bookName) {
    const grants = BOOK_GRANTS[bookName];
    if (!grants) return [];
    const choices = [];
    for (const p of grants.pages ?? []) choices.push({ type: "page", name: p });
    for (const w of grants.weapons ?? []) choices.push({ type: "weapon", name: w });
    for (const o of grants.outfits ?? []) choices.push({ type: "outfit", name: o });
    if (grants.groups) {
      for (const groupName of Object.keys(grants.groups)) choices.push({ type: "group", name: groupName });
    }
    return choices;
  }
  
  /** getBookGroupChoices — TẦNG 2, CHỈ dùng cho sách có `groups` (hiện chỉ "Library
   *  Book") — trả về Page cụ thể TRONG 1 nhóm đã chọn ở tầng 1. */
  function getBookGroupChoices(bookName, groupName) {
    const grants = BOOK_GRANTS[bookName];
    const list = grants?.groups?.[groupName];
    if (!list) return [];
    return list.map(name => ({ type: "page", name }));
  }
  
  /** isValidBookChoice — validate 1 lựa chọn CUỐI CÙNG (page/weapon/outfit cụ thể,
   *  KHÔNG PHẢI tên nhóm) có thực sự thuộc sách này không — dùng khi CHỐT lựa chọn
   *  (qua text `-readbook <sách> choose: <tên>` hoặc qua UI 2 tầng). */
  function isValidBookChoice(bookName, chosenType, chosenName) {
    const grants = BOOK_GRANTS[bookName];
    if (!grants) return false;
    if (chosenType === "page") {
      if ((grants.pages ?? []).includes(chosenName)) return true;
      if (grants.groups) {
        for (const list of Object.values(grants.groups)) if (list.includes(chosenName)) return true;
      }
      return false;
    }
    if (chosenType === "weapon") return (grants.weapons ?? []).includes(chosenName);
    if (chosenType === "outfit") return (grants.outfits ?? []).includes(chosenName);
    return false;
  }
  
  /**
   * buildBookChoiceComponents — dựng {embeds, components} hiện danh sách lựa chọn
   * TẦNG 1 khi đọc 1 cuốn sách (dùng CHUNG cho -readbook text VÀ nút 📚 Đọc trong
   * -inventory). userId để gắn vào customId (chỉ chủ nhân được chọn).
   */
  function buildBookChoiceComponents(userId, bookName, owned) {
    const grants = BOOK_GRANTS[bookName];
    if (!grants) {
      return {
        embeds: [{ title: `📖 ${bookName}`, description: `*(Chưa có dữ liệu nội dung cụ thể cho sách này trong hệ thống — GM tự narrate.)*`, color: 0x5865f2 }],
        components: [],
      };
    }
    const choices = getBookTopLevelChoices(bookName);
    if (choices.length === 0) {
      return {
        embeds: [{ title: `📖 ${bookName}`, description: `*(Sách này không dạy Page/Weapon/Outfit cụ thể nào.)*`, color: 0x5865f2 }],
        components: [],
      };
    }
    const TYPE_ICON = { page: "📖", weapon: "⚔️", outfit: "🧥", group: "📂" };
    const options = choices.slice(0, 25).map(c =>
      new StringSelectMenuOptionBuilder()
        .setLabel(c.name.slice(0, 100))
        .setDescription(c.type === "group" ? "Nhóm — chọn để xem Page cụ thể bên trong" : `${c.type === "page" ? "Page" : c.type === "weapon" ? "Vũ khí" : "Outfit"}`)
        .setValue(`${c.type}:${c.name}`)
        .setEmoji(TYPE_ICON[c.type])
    );
    return {
      embeds: [{
        title: `📖 ${bookName} (còn ${owned} cuốn)`,
        description: `Chọn ĐÚNG 1 thứ để nhận (tiêu 1 cuốn ngay khi chọn):${grants.note ? `\n> ${grants.note}` : ""}`,
        color: 0x5865f2,
      }],
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`bookchoice:${userId}:${encodeURIComponent(bookName)}`)
          .setPlaceholder("Chọn Page/Vũ khí/Outfit...")
          .addOptions(options)
      )],
    };
  }
  
  /**
   * executeReadBookChoose — CHỐT 1 lựa chọn CỤ THỂ khi đọc sách (theo yêu cầu trực
   * tiếp: "đọc = CHỌN 1 trong page/weapon/outfit, KHÔNG PHẢI mở khoá tất cả" — bản
   * thiết kế CŨ cho lấy hết chỉ bằng 1 quyển sách rẻ tiền, ĐÃ THAY THẾ HOÀN TOÀN).
   * Tiêu 1 cuốn, cấp CHÍNH XÁC 1 thứ đã chọn: Page → profileData.pages (category
   * MỚI, giống books/items — trước đây Page hoàn toàn không có sở hữu), Weapon/
   * Outfit → profileData.items (khớp pattern ĐÃ CÓ SẴN, VD Hoshino's "Eye of Horus"
   * từng nằm trong items). PHẢI gọi trong withLock(userId).
   */
  async function executeReadBookChoose(userId, bookNameRaw, chosenType, chosenName) {
    const { data: profileData, slot } = await getPlayerDataWithSlot(userId);
    const bookName = findBook(bookNameRaw);
    if (!bookName) throw new Error(`Không nhận diện được sách "${bookNameRaw}".`);
    const owned = profileData.books?.[bookName] ?? 0;
    if (owned < 1) throw new Error(`Bạn không có (hoặc đã hết) **${bookName}** trong inventory.`);
    if (!isValidBookChoice(bookName, chosenType, chosenName)) {
      throw new Error(`"${chosenName}" không thuộc **${bookName}**.`);
    }
    profileData.books[bookName] = owned - 1;
    if (profileData.books[bookName] <= 0) delete profileData.books[bookName];
    if (chosenType === "page") {
      profileData.pages = profileData.pages ?? {};
      profileData.pages[chosenName] = (profileData.pages[chosenName] ?? 0) + 1;
    } else {
      profileData.items = profileData.items ?? {};
      profileData.items[chosenName] = (profileData.items[chosenName] ?? 0) + 1;
    }
    await savePlayerData(userId, profileData, slot);
    return { bookName, chosenType, chosenName, remaining: profileData.books[bookName] ?? 0 };
  }

  return {
    BOOK_GRANTS,
    getBookTopLevelChoices,
    getBookGroupChoices,
    isValidBookChoice,
    buildBookChoiceComponents,
    executeReadBookChoose,
  };
};
