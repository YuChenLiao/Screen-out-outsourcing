/* 派遣/外包判定 —— 单一事实来源(Single Source of Truth)
 *
 * 需求:岗位「直接表明」是派遣或外包时标红。
 * 因此判定只针对招聘方主动写出的标识,不做任何推断。
 *
 * 判定顺序(顺序本身是正确性的一部分):
 *   1. 否定/排除表述优先 —— "非外包"、"不限外包"、"甲方直招" 必须不被当成外包
 *   2. 强标识词 —— 派遣 / 外包 / 外派 / 劳务 等
 *   3. 都不命中 -> false
 *
 * 与已被删除的"双休判定"的关键差异:
 *   双休判定的依据字段(福利标签)在真实数据里几乎从不包含该信息,
 *   所以结果多为 null(未知);外包标识则由招聘方主动写在岗位名或公司名里,
 *   命中即确定,不命中就是未标明 —— 无需三态。
 */
(function (root) {
  'use strict';

  // 排除表述:出现即认定「不是外包/派遣」,必须最优先判断。
  // 真实场景里"非外包""甲方直招"是招聘方用来吸引候选人的卖点。
  const EXCLUDE = [
    /非\s*外包/,
    /不\s*是\s*外包/,
    /无\s*外包/,
    /不做\s*外包/,
    /非\s*派遣/,
    /不\s*是\s*派遣/,
    /无\s*派遣/,
    /甲方\s*直招/,
    /甲方\s*直聘/,
    /正式\s*编制/,
    /自有\s*员工/,
    /内\s*包/,
  ];

  // 强标识词。按词长降序排列,便于报告命中的最具体词。
  const OUTSOURCE_WORDS = [
    '劳务派遣',
    '人力派遣',
    '人才派遣',
    '服务外包',
    '项目外包',
    '人力外包',
    '软件外包',
    '业务外包',
    '技术外包',
    '研发外包',
    '岗位外包',
    '外包服务',
    '人力资源服务',
    '灵活用工',
    '派遣',
    '外包',
    '外派',
    '驻场',
    '乙方',
    '劳务',
  ];

  // 以"人"为口径的表述:这些词常出现在描述里而非岗位标识,单独列出以便收紧时排除
  const WEAK_WORDS = new Set(['乙方', '劳务', '驻场', '外派']);

  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  function matchWord(s) {
    for (const w of OUTSOURCE_WORDS) {
      if (s.includes(w.toLowerCase())) return w;
    }
    return null;
  }

  function isExcluded(s) {
    return EXCLUDE.some((re) => re.test(s));
  }

  /**
   * 判定单段文本是否直接表明外包/派遣。
   * @returns {{ hit: boolean, word: string|null, excluded: boolean }}
   */
  function judgeText(text) {
    const s = normalize(text);
    if (!s) return { hit: false, word: null, excluded: false };
    if (isExcluded(s)) return { hit: false, word: null, excluded: true };
    const w = matchWord(s);
    return { hit: !!w, word: w, excluded: false };
  }

  /**
   * 从岗位对象判定。只看「招聘方主动写出的标识性字段」:
   *   jobName(岗位名) 与 company(公司名) —— 这两个位置的表态才是明确标识。
   * 描述类文本(postsDescription 等)不参与,避免"外包给客户"这类叙述造成误判。
   *
   * @returns {{ isOutsourcing: boolean, word: string|null, field: string|null, excluded: boolean }}
   */
  function judgeJob(job) {
    const fields = [
      ['jobName', job && job.title],
      ['company', job && job.company],
    ];

    // 先整体扫一遍排除表述,再做命中判定。
    // 曾经写成"命中即 return",导致岗位名含"外包"时直接返回,
    // 公司名里的"甲方直招"根本没被检查 —— 排除必须全局优先。
    let excluded = false;
    for (const [, val] of fields) {
      if (judgeText(val).excluded) excluded = true;
    }
    if (excluded) return { isOutsourcing: false, word: null, field: null, excluded: true };

    for (const [name, val] of fields) {
      const r = judgeText(val);
      if (r.hit) {
        return { isOutsourcing: true, word: r.word, field: name, excluded: false };
      }
    }
    return { isOutsourcing: false, word: null, field: null, excluded: false };
  }

  /**
   * 宽松判定:额外扫描福利标签与技能标签。默认不启用,
   * 供「严格模式以外」的场景使用。
   */
  function judgeJobLoose(job) {
    const strict = judgeJob(job);
    if (strict.isOutsourcing || strict.excluded) return strict;

    const extra = [
      ['welfare', ((job && job.welfare) || []).join(' ')],
      ['tags', ((job && job.tags) || []).join(' ')],
    ];
    for (const [name, val] of extra) {
      const r = judgeText(val);
      if (r.hit) return { isOutsourcing: true, word: r.word, field: name, excluded: false };
    }
    return strict;
  }

  const api = {
    judgeText,
    judgeJob,
    judgeJobLoose,
    EXCLUDE,
    OUTSOURCE_WORDS,
    WEAK_WORDS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__LCS_JUDGE__ = api;
})(typeof window !== 'undefined' ? window : null);
