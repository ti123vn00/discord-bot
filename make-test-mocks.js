// make-test-mocks.js — tạo `node_modules` GIẢ để chạy được bộ test.
//
// Repo thật KHÔNG commit node_modules, nhưng mọi file test đều cần
// discord.js / @upstash/redis / express / dotenv để `require` không nổ.
// Chạy MỘT LẦN trước khi test:  node make-test-mocks.js && node t-boot.js
//
// ⚠️ ĐỪNG deploy thư mục node_modules do file này tạo ra lên Render — đây là
// mock rỗng, bot thật cần package thật từ package.json.
const fs = require("fs");
const path = require("path");

const DISCORD = `
class B {
  constructor(){ this.d = {}; }
  setCustomId(v){ this.d.customId = v; return this; }
  setLabel(v){ this.d.label = v; return this; }
  setStyle(v){ this.d.style = v; return this; }
  setDisabled(v){ this.d.disabled = v; return this; }
  setEmoji(v){ this.d.emoji = v; return this; }
  setPlaceholder(v){ this.d.placeholder = v; return this; }
  setValue(v){ this.d.value = v; return this; }
  setDescription(v){ this.d.description = v; return this; }
  setTitle(v){ this.d.title = v; return this; }
  setMinValues(v){ this.d.minValues = v; return this; }
  setMaxValues(v){ this.d.maxValues = v; return this; }
  addOptions(...v){ this.d.options = (this.d.options || []).concat(v.flat()); return this; }
  addComponents(...v){ this.d.components = (this.d.components || []).concat(v.flat()); return this; }
  addFields(...v){ this.d.fields = (this.d.fields || []).concat(v.flat()); return this; }
  setColor(v){ this.d.color = v; return this; }
  setFooter(v){ this.d.footer = v; return this; }
}
class Client {
  constructor(){
    this.on = () => this; this.once = () => this; this.off = () => this;
    this.emit = () => false; this.removeAllListeners = () => this;
    this.setMaxListeners = () => this; this.login = async () => "ok";
    this.destroy = async () => {}; this.user = null;
    this.channels = { fetch: async () => null };
    this.users = { fetch: async () => null };
  }
}
module.exports = {
  Client, GatewayIntentBits: {}, Partials: {},
  ActionRowBuilder: B, ButtonBuilder: B,
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
  StringSelectMenuBuilder: B, StringSelectMenuOptionBuilder: B,
  ModalBuilder: B, TextInputBuilder: B, TextInputStyle: { Short: 1, Paragraph: 2 },
  AttachmentBuilder: B, MessageFlags: { Ephemeral: 64 }, EmbedBuilder: B, Events: {},
  REST: class { setToken(){ return this; } put(){ return Promise.resolve(); } },
  Routes: { applicationCommands: () => "" },
};
`;

const REDIS = `
module.exports = { Redis: class {
  constructor(){ this.s = new Map(); }
  async get(k){ return this.s.has(k) ? this.s.get(k) : null; }
  async set(k, v){ this.s.set(k, v); return "OK"; }
  async del(k){ this.s.delete(k); return 1; }
  async keys(){ return [...this.s.keys()]; }
  pipeline(){ const o = [], s = this.s; return {
    get(k){ o.push(["g", k]); return this; },
    set(k, v){ o.push(["s", k, v]); return this; },
    async exec(){ return o.map(x => x[0] === "g" ? (s.has(x[1]) ? s.get(x[1]) : null) : (s.set(x[1], x[2]), "OK")); },
  }; }
} };
`;

const EXPRESS = `
const e = () => ({ get: () => {}, post: () => {}, use: () => {}, listen: () => {} });
e.json = () => {}; e.urlencoded = () => {}; e.static = () => {};
module.exports = e;
`;

const DOTENV = `module.exports = { config: () => ({}) };\n`;

const MOCKS = [
  ["discord.js", DISCORD, "14.0.0"],
  ["@upstash/redis", REDIS, "1.0.0"],
  ["express", EXPRESS, "4.0.0"],
  ["dotenv", DOTENV, "16.0.0"],
];

for (const [name, body, version] of MOCKS) {
  const dir = path.join(__dirname, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.js"), body.trimStart());
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, main: "index.js", version }));
  console.log("  đã tạo mock:", name);
}
console.log("\nXong. Chạy test:\n  node t-boot.js && node t-ui.js && node t-hana.js && node t-page-effects.js && node t-heavy-bugs.js && node t-skillkey.js && node t-daily.js");
