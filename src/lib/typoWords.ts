// ============ 错别字检测 ============
// 复用「敏感词检测」的交互骨架：内置常见中文错别字词典（含"建议改为"），
// 扫描正文返回命中与上下文，支持一键替换。

export interface TypoHit {
  word: string
  suggest: string
  count: number
  context: string
}

/** 内置常见错别字 → 正确写法 */
export const BUILTIN_TYPOS: { word: string; suggest: string }[] = [
  { word: '帐号', suggest: '账号' },
  { word: '布署', suggest: '部署' },
  { word: '安祥', suggest: '安详' },
  { word: '必竟', suggest: '毕竟' },
  { word: '凑和', suggest: '凑合' },
  { word: '穿流不息', suggest: '川流不息' },
  { word: '渡假', suggest: '度假' },
  { word: '防碍', suggest: '妨碍' },
  { word: '甘败下风', suggest: '甘拜下风' },
  { word: '鬼鬼崇崇', suggest: '鬼鬼祟祟' },
  { word: '汗流夹背', suggest: '汗流浃背' },
  { word: '既往不究', suggest: '既往不咎' },
  { word: '娇揉造作', suggest: '矫揉造作' },
  { word: '精萃', suggest: '精粹' },
  { word: '决对', suggest: '绝对' },
  { word: '可望而不可及', suggest: '可望而不可即' },
  { word: '老俩口', suggest: '老两口' },
  { word: '美仑美奂', suggest: '美轮美奂' },
  { word: '迫不急待', suggest: '迫不及待' },
  { word: '气慨', suggest: '气概' },
  { word: '入场卷', suggest: '入场券' },
  { word: '善长', suggest: '擅长' },
  { word: '水泻不通', suggest: '水泄不通' },
  { word: '松驰', suggest: '松弛' },
  { word: '贪脏枉法', suggest: '贪赃枉法' },
  { word: '谈笑风声', suggest: '谈笑风生' },
  { word: '天翻地复', suggest: '天翻地覆' },
  { word: '突如奇来', suggest: '突如其来' },
  { word: '无可耐何', suggest: '无可奈何' },
  { word: '喜笑严开', suggest: '喜笑颜开' },
  { word: '相形见拙', suggest: '相形见绌' },
  { word: '消声匿迹', suggest: '销声匿迹' },
  { word: '额首称庆', suggest: '额手称庆' },
  { word: '一愁莫展', suggest: '一筹莫展' },
  { word: '一如继往', suggest: '一如既往' },
  { word: '遗撼', suggest: '遗憾' },
  { word: '振撼', suggest: '震撼' },
  { word: '重迭', suggest: '重叠' },
  { word: '自抱自弃', suggest: '自暴自弃' },
  { word: '姿式', suggest: '姿势' },
  { word: '坐阵', suggest: '坐镇' },
  { word: '走头无路', suggest: '走投无路' },
  { word: '饮鸠止渴', suggest: '饮鸩止渴' },
  { word: '明火执杖', suggest: '明火执仗' },
  { word: '出奇致胜', suggest: '出奇制胜' },
  { word: '礼上往来', suggest: '礼尚往来' },
  { word: '不径而走', suggest: '不胫而走' },
  { word: '再接再励', suggest: '再接再厉' },
]

/** 把一行上下文里的命中词高亮出来（供 UI 使用，不改写原文） */
export function scanTypos(text: string, dict?: { word: string; suggest: string }[]): TypoHit[] {
  const list = dict ?? BUILTIN_TYPOS
  const hits: TypoHit[] = []
  for (const { word, suggest } of list) {
    if (!word) continue
    let idx = text.indexOf(word)
    if (idx === -1) continue
    let count = 0
    let context = ''
    while (idx !== -1) {
      count++
      if (!context) {
        const start = Math.max(0, idx - 12)
        context = (start > 0 ? '…' : '') + text.slice(start, idx + word.length + 12).replace(/\n/g, ' ')
      }
      idx = text.indexOf(word, idx + word.length)
    }
    hits.push({ word, suggest, count, context })
  }
  return hits
}

/** 一次性替换全部命中词 */
export function replaceTypos(text: string, hits: TypoHit[]): string {
  let out = text
  for (const h of hits) {
    out = out.split(h.word).join(h.suggest)
  }
  return out
}
