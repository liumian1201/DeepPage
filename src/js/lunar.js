/* ============================================================
   lunar.js — 农历转换核心逻辑
   纯 JS 实现，无外部依赖，支持 1900-2100 年
   ============================================================ */

/**
 * 农历数据 1900-2100（每个年份一个 16 进制数）
 * 格式：前 4 位表示闰月月份（0=无闰月），后 12 位表示每月大小（1=30天, 0=29天）
 */
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06aa0, 0x1a6c4, 0x0aae0, // 2050-2059
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a4d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520                                                                    // 2100
];

// 天干
const HEAVENLY_STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
// 地支
const EARTHLY_BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
// 生肖
const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
// 农历月份名称
const LUNAR_MONTHS = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
// 农历日期名称
const LUNAR_DAYS = [
  '', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'
];

/**
 * 获取指定公历日期的农历信息
 * @param {Date} [date=new Date()] - 公历日期
 * @returns {{ year: string, month: string, day: string, zodiac: string, full: string }}
 */
function getLunarDate(date) {
  date = date || new Date();
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  // 计算从 1900-01-31（农历 1900 年正月初一）到目标日期的天数差
  const baseDate = new Date(1900, 0, 31);
  let offset = Math.floor((date - baseDate) / 86400000);

  // 遍历农历年份，找到对应的农历年
  let lunarYear, lunarMonth, lunarDay;
  let temp = 0;
  let i;

  for (i = 1900; i < 2101 && offset > 0; i++) {
    temp = daysInLunarYear(i);
    if (offset - temp < 0) break;
    offset -= temp;
  }
  lunarYear = i;

  // 查找闰月
  const leapMonth = leapMonthOf(i);
  let isLeap = false;

  // 遍历农历月份
  for (i = 1; i < 13 && offset > 0; i++) {
    // 闰月
    if (leapMonth > 0 && i === leapMonth + 1 && !isLeap) {
      i--;
      isLeap = true;
      temp = daysInLeapMonth(lunarYear);
    } else {
      temp = daysInLunarMonth(lunarYear, i);
      isLeap = false;
    }
    if (offset - temp < 0) break;
    offset -= temp;
  }
  lunarMonth = i;
  lunarDay = offset + 1;

  // 天干地支纪年
  const stemIndex = (lunarYear - 4) % 10;
  const branchIndex = (lunarYear - 4) % 12;
  const stemBranch = HEAVENLY_STEMS[stemIndex] + EARTHLY_BRANCHES[branchIndex];
  const zodiacAnimal = ZODIAC[branchIndex];

  // 月份名称
  let monthName = (isLeap ? '闰' : '') + LUNAR_MONTHS[lunarMonth - 1] + '月';
  let dayName = LUNAR_DAYS[lunarDay];

  return {
    year: stemBranch + '年',
    month: monthName,
    day: dayName,
    zodiac: zodiacAnimal,
    full: stemBranch + '年 ' + monthName + dayName
  };
}

/** 农历年总天数 */
function daysInLunarYear(year) {
  let sum = 348; // 12 个月 × 29 天
  for (let i = 0x8000; i > 0x8; i >>= 1) {
    sum += (LUNAR_INFO[year - 1900] & i) ? 1 : 0;
  }
  return sum + daysInLeapMonth(year);
}

/** 闰月天数 */
function daysInLeapMonth(year) {
  if (leapMonthOf(year)) {
    return (LUNAR_INFO[year - 1900] & 0x10000) ? 30 : 29;
  }
  return 0;
}

/** 获取闰月月份（0=无闰月） */
function leapMonthOf(year) {
  return LUNAR_INFO[year - 1900] & 0xf;
}

/** 农历某月天数 */
function daysInLunarMonth(year, month) {
  return (LUNAR_INFO[year - 1900] & (0x10000 >> month)) ? 30 : 29;
}

/**
 * 更新页面上的农历显示
 */
function updateLunarDisplay() {
  var yearEl = document.querySelector('.lunar-year');
  var dateEl = document.querySelector('.lunar-date');
  var lunar = getLunarDate(new Date());
  var zodiacEmoji = { '鼠':'🐭','牛':'🐮','虎':'🐯','兔':'🐰','龙':'🐲','蛇':'🐍','马':'🐴','羊':'🐑','猴':'🐵','鸡':'🐔','狗':'🐶','猪':'🐷' };
  var style = (typeof currentSettings !== 'undefined' && currentSettings.lunarStyle) ? currentSettings.lunarStyle : 'double';
  if (style === 'single') {
    // 单行：干支年 月日 · 生肖
    if (yearEl) yearEl.textContent = lunar.full + ' · ' + (zodiacEmoji[lunar.zodiac] || '🐲') + lunar.zodiac;
    if (dateEl) dateEl.textContent = '';
  } else {
    // 双行：干支年+生肖 / 月日
    if (yearEl) yearEl.textContent = lunar.year + ' · ' + (zodiacEmoji[lunar.zodiac] || '🐲') + lunar.zodiac;
    if (dateEl) dateEl.textContent = lunar.month + lunar.day;
  }
  // 降级
  var lunarEl = document.querySelector('.lunar-text');
  if (lunarEl && !yearEl) lunarEl.textContent = lunar.full + ' · ' + (zodiacEmoji[lunar.zodiac] || '🐲') + lunar.zodiac;
}

/**
 * 初始化农历模块（由 main.js 调用）
 */
function initLunar() {
  updateLunarDisplay();
  // 每天凌晨更新（计算到下一个 00:00:01 的延时）
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const delay = tomorrow - now + 1000;
  // BUG-033: 递归 setTimeout 每次重新校准到次日 00:00:01，避免 setInterval 累积漂移
  function scheduleNext() {
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    var ms = next - now + 1000;
    setTimeout(function () {
      updateLunarDisplay();
      scheduleNext();
    }, ms);
  }
  setTimeout(function () {
    updateLunarDisplay();
    scheduleNext();
  }, delay);
}
