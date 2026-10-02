/* ============================================================
   todo.js — 看板「待办清单」组件（v1.5.0）
   数据存 settings.todoItems = [{ id, text, done }]（chrome.storage.sync，走合并写）
   本文件同时作为 P2「组件注册表」抽象的验证：新增看板组件只需
     ① index.html 加一个 data-widget 卡片  ② DASHBOARD_WIDGETS 登记一行
     ③ 本模块提供 init + 渲染（在 main.js init 里调一次）
   ============================================================ */

var TODO_MAX_ITEMS = 50;
var TODO_MAX_LEN = 80;

function getTodoItems() {
  if (!currentSettings || !Array.isArray(currentSettings.todoItems)) return [];
  return currentSettings.todoItems;
}

function _saveTodoItems(items) {
  if (!currentSettings) currentSettings = {};
  currentSettings.todoItems = items.slice(0, TODO_MAX_ITEMS);
  if (typeof saveSettings === 'function') saveSettings(currentSettings);
}

function _todoEsc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** 渲染清单（只重建列表容器，输入框保留焦点与内容） */
function renderTodo() {
  var list = document.getElementById('todo-list');
  if (!list) return;
  var items = getTodoItems();

  if (items.length === 0) {
    list.innerHTML = '<div class="todo-empty">还没有待办，下面输入后回车添加</div>';
  } else {
    list.innerHTML = items.map(function (it) {
      return '<div class="todo-item' + (it.done ? ' done' : '') + '" data-id="' + _todoEsc(it.id) + '">' +
        '<input type="checkbox" class="todo-check" data-action="toggle" data-id="' + _todoEsc(it.id) + '"' + (it.done ? ' checked' : '') + ' aria-label="完成">' +
        '<span class="todo-text">' + _todoEsc(it.text) + '</span>' +
        '<button class="todo-del" data-action="delete" data-id="' + _todoEsc(it.id) + '" title="删除" aria-label="删除待办">✕</button>' +
        '</div>';
    }).join('');
  }

  // 列表长度变化会改变看板高度 → 触发碰撞检测（否则可能压住卡片）
  if (typeof _debounceCollisionCheck === 'function') _debounceCollisionCheck();

  // 进度
  var counter = document.getElementById('todo-count');
  if (counter) {
    var done = items.filter(function (i) { return i.done; }).length;
    counter.textContent = items.length ? (done + '/' + items.length) : '';
  }
}

function addTodoItem(text) {
  text = String(text || '').trim().slice(0, TODO_MAX_LEN);
  if (!text) return false;
  var items = getTodoItems();
  if (items.length >= TODO_MAX_ITEMS) {
    if (typeof showToast === 'function') showToast('待办最多 ' + TODO_MAX_ITEMS + ' 条', 'warning');
    return false;
  }
  items.push({ id: 'td' + Date.now() + '_' + Math.floor(Math.random() * 1000), text: text, done: false });
  _saveTodoItems(items);
  renderTodo();
  return true;
}

function toggleTodoItem(id) {
  var items = getTodoItems();
  var it = items.find(function (x) { return x.id === id; });
  if (!it) return;
  it.done = !it.done;
  _saveTodoItems(items);
  renderTodo();
}

function deleteTodoItem(id) {
  _saveTodoItems(getTodoItems().filter(function (x) { return x.id !== id; }));
  renderTodo();
}

function clearDoneTodoItems() {
  var items = getTodoItems();
  var left = items.filter(function (x) { return !x.done; });
  if (left.length === items.length) return;
  _saveTodoItems(left);
  renderTodo();
  if (typeof showToast === 'function') showToast('已清理 ' + (items.length - left.length) + ' 条已完成', 'info');
}

function initTodo() {
  var root = document.getElementById('dash-todo');
  if (!root) return;

  renderTodo();

  // 事件委托：勾选 / 删除
  root.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    var id = btn.dataset.id;
    if (!id) return;
    e.stopPropagation();
    if (btn.dataset.action === 'toggle') toggleTodoItem(id);
    else if (btn.dataset.action === 'delete') deleteTodoItem(id);
  });

  // 输入框：回车添加
  var input = document.getElementById('todo-input');
  if (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      if (addTodoItem(this.value)) this.value = '';
    });
  }
  var addBtn = document.getElementById('todo-add');
  if (addBtn) {
    addBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var i = document.getElementById('todo-input');
      if (i && addTodoItem(i.value)) i.value = '';
    });
  }
  // 点击组件内部不冒泡到卡片区（避免触发搜索框聚焦/沉浸模式双击）
  root.addEventListener('click', function (e) { e.stopPropagation(); });

  // 清理已完成按钮（看板组件上的小按钮，hover 显示）
  var clearBtn = document.getElementById('todo-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', function (e) { e.stopPropagation(); clearDoneTodoItems(); });
  }
}
