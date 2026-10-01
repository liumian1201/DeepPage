/* dashboard.js 逻辑冒烟测试（vm + 最小 DOM 桩，不依赖浏览器）
   运行: node tests/dashboard-logic.test.js
   覆盖: v1.3.1 P0-3 防抖写盘 / 边界不写盘 / 顺序未变不写盘 / 锁定拒绝 / ESC 暴露 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const code = fs.readFileSync(path.resolve(__dirname, '../src/js/dashboard.js'), 'utf8');

// ---- 最小 DOM 桩 ----
function makeItem(widget) {
  return { dataset: { widget }, closest: () => null };
}
const items = ['clock', 'weather', 'lunar'].map(makeItem);

const grid = {
  _children: items.slice(),
  _clickHandler: null,
  addEventListener(type, fn) { if (type === 'click') this._clickHandler = fn; },
  contains() { return true; },
  querySelector(sel) {
    const m = /data-widget="([^"]+)"/.exec(sel);
    if (m) return this._children.find(i => i.dataset.widget === m[1]) || null;
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '.dashboard-item') return this._children.slice();
    if (sel === '.dashboard-item[data-widget]') return this._children.slice();
    return [];
  },
  insertBefore(a, b) {
    const i = this._children.indexOf(a);
    if (i !== -1) this._children.splice(i, 1);
    const j = this._children.indexOf(b);
    this._children.splice(j === -1 ? this._children.length : j, 0, a);
  },
  appendChild(a) {
    const i = this._children.indexOf(a);
    if (i !== -1) this._children.splice(i, 1);
    this._children.push(a);
  }
};

const body = {
  _classes: new Set(),
  classList: {
    add(c) { body._classes.add(c); },
    remove(c) { body._classes.delete(c); },
    contains(c) { return body._classes.has(c); }
  }
};

const editBtn = { textContent: '', disabled: false, title: '', addEventListener() {} };

let saveCalls = [];
const ctx = {
  console,
  setTimeout, clearTimeout,
  document: {
    body,
    getElementById(id) {
      if (id === 'dashboard-grid') return grid;
      if (id === 'btn-dash-edit') return editBtn;
      return null;
    }
  },
  currentSettings: { dashboardOrder: ['clock', 'weather', 'lunar'] },
  saveSettings(s) { saveCalls.push(JSON.parse(JSON.stringify(s.dashboardOrder))); },
  isLocked: false,
  showToast(msg) { ctx._toasts.push(msg); },
  closeSettingsPanel() {},
  _toasts: []
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const order = () => grid._children.map(i => i.dataset.widget).join(',');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
}
function clickArrow(widget, dir) {
  const item = grid._children.find(i => i.dataset.widget === widget);
  const arrow = { dataset: { dir }, closest: (sel) => (sel === '.dashboard-item' ? item : null) };
  grid._clickHandler({
    target: { closest: (sel) => (sel === '.dash-arrow' ? arrow : null) },
    stopPropagation() {}
  });
}

(async () => {
  ctx.initDashboardGrid();
  check('init 后顺序恢复', order() === 'clock,weather,lunar', order());

  console.log('\n[1] 非编辑态点击箭头不应有任何反应');
  clickArrow('clock', 'right');
  await sleep(400);
  check('未进入编辑态 → 顺序不变', order() === 'clock,weather,lunar', order());
  check('未进入编辑态 → 未写盘', saveCalls.length === 0, JSON.stringify(saveCalls));

  console.log('\n[2] 进入编辑态');
  ctx.toggleDashEdit();
  check('body.dash-editing 已加', body.classList.contains('dash-editing'));
  check('按钮文案切换', editBtn.textContent === '✅ 完成编辑', editBtn.textContent);

  console.log('\n[3] 连点 5 次箭头 → 只写一次 sync（防抖）');
  // 独立参考模型：DOM insertBefore(a, b) = 把 a 移到 b 之前
  function refMove(list, widget, dir) {
    const out = list.slice();
    const i = out.indexOf(widget);
    if (dir === 'left' && i > 0) { out.splice(i, 1); out.splice(i - 1, 0, widget); }
    else if (dir === 'right' && i < out.length - 1) { out.splice(i, 1); out.splice(i + 1, 0, widget); }
    return out;
  }
  const clicks = [['clock', 'right'], ['clock', 'right'], ['clock', 'left'], ['weather', 'right'], ['weather', 'right']];
  let expected = ['clock', 'weather', 'lunar'];
  clicks.forEach(([w, d]) => { expected = refMove(expected, w, d); clickArrow(w, d); });
  check('DOM 顺序与参考模型一致', order() === expected.join(','), order() + ' vs ' + expected.join(','));
  check('防抖期间未写盘', saveCalls.length === 0, JSON.stringify(saveCalls));
  await sleep(400);
  check('连点 5 次只写 1 次', saveCalls.length === 1, 'calls=' + saveCalls.length);
  check('写入顺序正确', JSON.stringify(saveCalls[0]) === JSON.stringify(expected), JSON.stringify(saveCalls[0]));

  console.log('\n[4] 边界点击不写盘');
  const first = expected[0], last = expected[expected.length - 1];
  clickArrow(first, 'left');   // 最左再左移 → 无效
  clickArrow(last, 'right');   // 最右再右移 → 无效
  await sleep(400);
  check('边界点击无新增写盘', saveCalls.length === 1, 'calls=' + saveCalls.length);
  check('边界点击顺序不变', order() === expected.join(','), order());

  console.log('\n[5] 退出编辑态立即落盘 + 顺序未变不写');
  ctx.toggleDashEdit();
  check('body.dash-editing 已移除', !body.classList.contains('dash-editing'));
  check('按钮文案还原', editBtn.textContent === '✋ 编辑组件顺序', editBtn.textContent);
  check('退出时顺序未变 → 不重复写盘', saveCalls.length === 1, 'calls=' + saveCalls.length);

  clickArrow(expected[1], 'left'); // 编辑态外点击应无效
  check('编辑态外点击无效', order() === expected.join(','), order());
  ctx.toggleDashEdit();
  const moved = refMove(expected, expected[1], 'left');
  clickArrow(expected[1], 'left');
  ctx.toggleDashEdit(); // 退出 → 立即落盘（不等 300ms）
  check('编辑态内改动 + 退出 → 立即写盘', saveCalls.length === 2, 'calls=' + saveCalls.length);
  check('立即落盘内容正确', JSON.stringify(saveCalls[1]) === JSON.stringify(moved), JSON.stringify(saveCalls[1]));
  check('DOM 与参考模型一致（第二轮）', order() === moved.join(','), order() + ' vs ' + moved.join(','));

  console.log('\n[6] 锁定状态');
  ctx.isLocked = true;
  ctx.toggleDashEdit();
  check('锁定时拒绝进入编辑态', !ctx.isDashEditing());
  check('锁定时提示 Toast', ctx._toasts.some(t => t.includes('已锁定')), JSON.stringify(ctx._toasts));
  ctx.isLocked = false;

  console.log('\n[7] ESC 链所需的 isDashEditing 暴露');
  ctx.toggleDashEdit();
  check('编辑态 isDashEditing() === true', ctx.isDashEditing() === true);
  ctx.toggleDashEdit();
  check('退出后 isDashEditing() === false', ctx.isDashEditing() === false);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
