/* 派遣/外包判定的回归测试 —— node test/judge.test.js
 *
 * 覆盖三类容易出错的场景:
 *   1. 基础命中(派遣/外包/外派/驻场/劳务)
 *   2. 排除表述("非外包""甲方直招"不能误报)—— 这是最关键的一类
 *   3. 多字段组合(岗位名 + 公司名),以及"未标明"必须为 false
 */
const assert = require('assert');
const { judgeText, judgeJob, judgeJobLoose } = require('../src/shared/judge.js');

let pass = 0;
const fails = [];

function eq(actual, expected, note) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else fails.push(`  ✗ ${note}\n      期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`);
}

/* ---------------------------------------------------- 1. 基础命中判定 */
const hitCases = [
  ['Java开发工程师(外包)', '外包'],
  ['前端开发-派遣岗位', '派遣'],
  ['软件工程师（劳务派遣）', '劳务派遣'],
  ['高级开发工程师(外派阿里)', '外派'],
  ['测试工程师-驻场银行', '驻场'],
  ['人力外包服务专员', '人力外包'],
  ['【外包】后端开发', '外包'],
  ['岗位外包-运营支持', '岗位外包'],
  ['研发外包工程师', '研发外包'],
  ['业务外包专员', '业务外包'],
  ['灵活用工项目经理', '灵活用工'],
];

for (const [text, word] of hitCases) {
  const r = judgeText(text);
  eq({ hit: r.hit, word: r.word }, { hit: true, word }, `命中: ${text}`);
}

/* ------------------------------------------------ 2. 排除表述不得误报 */
// 这些是招聘方用来吸引候选人的卖点,判成外包会造成相反的误导
const excludeCases = [
  'Java开发工程师(非外包)',
  '前端开发-不是外包-甲方直招',
  '后端开发(无外包)',
  '测试工程师 甲方直招',
  '运营岗 甲方直聘',
  '开发工程师 正式编制',
  '不派遣 自有员工',
];

for (const text of excludeCases) {
  const r = judgeText(text);
  eq({ hit: r.hit, excluded: r.excluded }, { hit: false, excluded: true }, `排除: ${text}`);
}

/* -------------------------------------- 3. 明确排除必须优先于命中山 */
// "非外包"同时包含"非"和"外包",顺序错了就会误报
const r1 = judgeText('非外包');
eq({ hit: r1.hit, excluded: r1.excluded }, { hit: false, excluded: true }, '顺序: 非外包 必须排除而非命中');
const r2 = judgeText('甲方直招外包管理岗');
eq(r2.excluded, true, '顺序: 含"甲方直招"时整体排除');

/* ------------------------------------------------------- 4. 未标明情况 */
const missCases = ['Java开发工程师', '高级前端工程师', '算法工程师(AI方向)', '', null, undefined];
for (const text of missCases) {
  const r = judgeText(text);
  eq(r.hit, false, `未标明: ${JSON.stringify(text)}`);
}

/* ------------------------------------------------- 5. 岗位对象组合判定 */
const jobCases = [
  [{ title: 'Java开发工程师(外包)', company: '某某科技' }, true, '岗位名命中'],
  [{ title: 'Java开发工程师', company: '中软国际信息技术有限公司' }, false, '公司名不含关键词则为 false'],
  [{ title: 'Java开发工程师', company: '某某人力资源服务有限公司' }, true, '公司名含"人力资源服务"'],
  [{ title: '正常岗位', company: '正常公司' }, false, '都不命中'],
  [{ title: '非外包岗位', company: '正常公司' }, false, '"非外包"不得判为外包'],
];

for (const [job, expected, note] of jobCases) {
  eq(judgeJob(job).isOutsourcing, expected, `岗位: ${note}`);
}

// 岗位名命中时要能报出命中词与字段,便于在界面上说明理由
const detail = judgeJob({ title: '【外包】后端开发', company: 'X公司' });
eq({ word: detail.word, field: detail.field }, { word: '外包', field: 'jobName' }, '命中理由可追溯');

// 排除表述优先于岗位名命中:公司名说"甲方直招"时不应标红
const excl = judgeJob({ title: '外包岗位', company: '甲方直招' });
eq(excl.isOutsourcing, false, '公司名标注甲方直招 -> 不标红');

/* ------------------------------------------------------ 6. 宽松模式 */
// 宽松模式额外看福利/技能标签,但严格模式不应受其影响
const loose1 = judgeJobLoose({ title: '工程师', company: 'X公司', welfare: ['外包岗位补贴'] });
eq(loose1.isOutsourcing, true, '宽松模式: 福利标签命中');
const strict1 = judgeJob({ title: '工程师', company: 'X公司', welfare: ['外包岗位补贴'] });
eq(strict1.isOutsourcing, false, '严格模式: 不看福利标签');

/* ------------------------------------------------------------- 汇总 */
console.log(`外包判定测试: ${pass} 通过 / ${pass + fails.length} 总数`);
if (fails.length) {
  console.log('失败用例:');
  console.log(fails.join('\n'));
  process.exit(1);
}
console.log('全部通过');
