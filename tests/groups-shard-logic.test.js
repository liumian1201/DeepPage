/*
   BUG-089 分组分片存储的纯逻辑测试（不需要浏览器）
   验证 groups-store.js 的三件事：
     ① itemBytes 的「最坏情况体积」估算不会低估（低估 = 真机上 kQuotaBytesPerItem）
     ② build() 的切块：每块都 ≤ 预算、顺序与内容零丢失、键名安全且唯一
     ③ decode() 的还原与兼容：meta 优先、旧版单项 groups 兜底、都没有则 null
   运行: node tests/groups-shard-logic.test.js
   退出码: 0 = 全部通过 ｜ 1 = 有断言失败
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.resolve(__dirname, '../src/js/groups-store.js');
const code = fs.readFileSync(SRC, 'utf8');
const sandbox = { TextEncoder, JSON, Math, Date, console, chrome: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code + '\n;globalThis.__GS = GroupsStore;', sandbox, { filename: SRC });
const GS = sandbox.__GS;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

console.log('BUG-089 分组分片存储逻辑测试');
check('模块已导出预期 API',
  ['itemBytes', 'build', 'decode', 'readSync', 'writeSync', 'clearSync', 'isSelfMetaWrite', 'affectsGroups']
    .every(k => typeof GS[k] === 'function'));
check('预算明显低于实测单项上限 7973 字节（不能贴着写）', GS.ITEM_BUDGET <= 6000 && GS.ITEM_BUDGET > 0, GS.ITEM_BUDGET);

// ---- ① itemBytes：只能高估，不能低估 ----
console.log('\n[1] itemBytes（最坏情况体积估算）');
const utf8 = (s) => new TextEncoder().encode(s).length;
const ascii = { name: 'abc', url: 'https://x.example.com/' };
check('纯 ASCII：等于 JSON 的 UTF-8 字节数', GS.itemBytes(ascii) === utf8(JSON.stringify(ascii)), {
  got: GS.itemBytes(ascii), want: utf8(JSON.stringify(ascii))
});
const cn = { name: '中文卡片名', url: 'https://例子.中国/' };
check('中文：估算 ≥ UTF-8 字节数（保守，含 \\uXXXX 转义空间）',
  GS.itemBytes(cn) >= utf8(JSON.stringify(cn)) && GS.itemBytes(cn) > 0, {
  got: GS.itemBytes(cn), utf8: utf8(JSON.stringify(cn))
});
const emoji = { name: '😀😀', url: 'https://e.example.com/' };
check('emoji（代理对）：估算 ≥ UTF-8 字节数', GS.itemBytes(emoji) >= utf8(JSON.stringify(emoji)), {
  got: GS.itemBytes(emoji), utf8: utf8(JSON.stringify(emoji))
});
check('空字符串 / 数字 / null 均不抛错且 ≥ 2',
  GS.itemBytes('') >= 2 && GS.itemBytes(0) >= 1 && GS.itemBytes(null) >= 4);

// ---- ② build()：切块 ----
console.log('\n[2] build()（切块）');
const mkCard = (i, pad) => ({
  id: 'c' + i, name: '卡片' + i + (pad ? 'X'.repeat(pad) : ''),
  url: 'https://site' + i + '.example.com/path' + i,
  color: 'hsl(59, 64%, 47%)', image: 'idx:cardimg_c' + i,
  visitCount: i, createdAt: 1700000000000, lastOpened: 1700000000000, themeColor: '#74646e'
});
const small = [{ id: 'g1', name: '常用', sortMode: 'manual', cards: [mkCard(1), mkCard(2)] }];
const smallBuilt = GS.build(small);
check('小数据只切一块', smallBuilt.keys.length === 1, smallBuilt.keys);
check('meta 携带 id / name / sortMode / 键列表',
  smallBuilt.meta.length === 1 && smallBuilt.meta[0].id === 'g1' && smallBuilt.meta[0].name === '常用'
    && smallBuilt.meta[0].sortMode === 'manual' && Array.isArray(smallBuilt.meta[0].k) && smallBuilt.meta[0].k.length === 1);
check('每块体积 ≤ 预算', smallBuilt.keys.every(k => GS.itemBytes(smallBuilt.items[k]) <= GS.ITEM_BUDGET));

const bigCards = [];
for (let i = 0; i < 60; i++) bigCards.push(mkCard(i));
const big = [{ id: 'gbig', name: '大组', sortMode: 'manual', cards: bigCards }];
const bigBuilt = GS.build(big);
check('大数据被切成多块', bigBuilt.keys.length >= 2, bigBuilt.keys.length);
check('每块体积都 ≤ 预算（含边界块）',
  bigBuilt.keys.every(k => GS.itemBytes(bigBuilt.items[k]) <= GS.ITEM_BUDGET),
  bigBuilt.keys.map(k => GS.itemBytes(bigBuilt.items[k])));
check('切块后卡片总数不变', bigBuilt.keys.reduce((n, k) => n + bigBuilt.items[k].length, 0) === 60);
check('切块后顺序不变', bigBuilt.keys.map(k => bigBuilt.items[k]).flat().map(c => c.id).join(',') === bigCards.map(c => c.id).join(','));

const emptyGroup = GS.build([{ id: 'ge', name: '空组', cards: [] }]);
check('空分组不产生任何 chunk 键', emptyGroup.keys.length === 0 && emptyGroup.meta[0].k.length === 0);
check('没有 cards 字段的分组也不抛错', GS.build([{ id: 'gx', name: '无cards' }]).keys.length === 0);
check('空数组 / 非数组入参不抛错', GS.build([]).keys.length === 0 && GS.build(null).keys.length === 0);

// 键名安全：id 来自导入文件，不能直接拼进 storage 键
const weird = GS.build([{ id: '../../evil key:中', name: '怪 id', cards: [mkCard(1)] }]);
check('怪 id 生成的键只含 [A-Za-z0-9_-]（防键名注入 / 非法键）',
  weird.keys.every(k => /^gc_[A-Za-z0-9_-]+_\d+$/.test(k)), weird.keys);
check('怪 id 的键仍指向同一份卡片', weird.keys.length === 1 && weird.items[weird.keys[0]].length === 1);

const dupIds = GS.build([
  { id: 'same', name: 'A', cards: [mkCard(1)] },
  { id: 'same', name: 'B', cards: [mkCard(2)] }
]);
check('重复分组 id 时键仍唯一（不会互相覆盖）', dupIds.keys.length === 2 && new Set(dupIds.keys).size === 2, dupIds.keys);

// 单张卡片自身就超预算 → 仍必须单独成块（不能丢、不能死循环）
const huge = [{ id: 'gh', name: '巨卡', cards: [mkCard(1, 9000)] }];
const hugeBuilt = GS.build(huge);
check('单卡超预算时单独成块（不丢数据、不死循环）',
  hugeBuilt.keys.length === 1 && hugeBuilt.items[hugeBuilt.keys[0]].length === 1 && GS.itemBytes(hugeBuilt.items[hugeBuilt.keys[0]]) > GS.ITEM_BUDGET);

// ---- ③ decode()：还原与兼容 ----
console.log('\n[3] decode()（还原 / 兼容旧格式）');
function packAs(built, extra) {
  const data = {};
  built.keys.forEach(k => { data[k] = built.items[k]; });
  data[GS.META_KEY] = { v: 1, w: 'test-token', g: built.meta };
  return Object.assign(data, extra || {});
}
const roundTrip = GS.decode(packAs(bigBuilt));
check('往返一致（分组数 / 卡片顺序 / 卡片内容）',
  roundTrip.length === 1 && roundTrip[0].id === 'gbig'
    && roundTrip[0].cards.map(c => c.id).join(',') === bigCards.map(c => c.id).join(',')
    && JSON.stringify(roundTrip[0].cards) === JSON.stringify(bigCards));
check('多分组顺序保持', (() => {
  const b = GS.build([
    { id: 'a', name: 'A', cards: [mkCard(1)] },
    { id: 'b', name: 'B', cards: [mkCard(2)] },
    { id: 'c', name: 'C', cards: [] }
  ]);
  return GS.decode(packAs(b)).map(g => g.id).join(',') === 'a,b,c';
})());
check('缺 sortMode 时回落 manual', GS.decode(packAs(GS.build([{ id: 'z', name: 'Z' }])))[0].sortMode === 'manual');
check('meta 缺失时回退旧版单项 groups（升级迁移用）',
  JSON.stringify(GS.decode({ groups: [{ id: 'legacy', name: 'L', cards: [{ id: 'x' }] }] }).map(g => g.id)) === '["legacy"]');
check('meta 与旧版同时存在时以 meta 为准（新格式是唯一写入方）', (() => {
  const d = packAs(smallBuilt, { groups: [{ id: 'legacy', name: 'L', cards: [] }] });
  return GS.decode(d)[0].id === 'g1';
})());
check('两边都没有 → null（交由上层走 local 兜底）',
  GS.decode({}) === null && GS.decode(null) === null && GS.decode({ groups: [] }) === null);
check('chunk 键缺失时该组卡片为空数组（不抛错，也不吞掉其它分组）', (() => {
  const b = GS.build([{ id: 'a', name: 'A', cards: [mkCard(1)] }, { id: 'b', name: 'B', cards: [mkCard(2)] }]);
  const d = packAs(b);
  delete d[b.meta[1].k[0]];
  const out = GS.decode(d);
  return out.length === 2 && out[0].cards.length === 1 && out[1].cards.length === 0;
})());

// ---- ④ affectsGroups / 回声令牌 ----
console.log('\n[4] 变更判定与回声令牌');
check('meta 变化算分组变更', GS.affectsGroups({ [GS.META_KEY]: { newValue: {} } }) === true);
check('chunk 变化算分组变更', GS.affectsGroups({ gc_g1_0: { newValue: [] } }) === true);
check('旧版 groups 变化算分组变更', GS.affectsGroups({ groups: { newValue: [] } }) === true);
check('settings / activeGroup 变化不算分组变更',
  GS.affectsGroups({ settings: { newValue: {} }, activeGroup: { newValue: 1 } }) === false);
check('空变更集不算分组变更', GS.affectsGroups({}) === false && GS.affectsGroups(null) === false);
check('未写过时任何 meta 都不算自己的回声', GS.isSelfMetaWrite({ w: 'whatever' }) === false && GS.isSelfMetaWrite(null) === false);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
