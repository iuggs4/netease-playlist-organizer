/**
 * 规则层分类。
 *
 * 设计原则：只用**确实可信**的信号，绝不猜。
 *  - 年代：来自 publishTime，100% 可靠，完全不需要 LLM
 *  - 语种：靠 Unicode 区间 + 歌手名特征做预判（会被 LLM 复核）
 *  - 情绪 / 曲风：网易没有标签接口（已实测 /api/song/tags 返回 404），
 *    所以这里**不做**，全部交给 LLM
 */

import type { Song } from '@/lib/types'

export function decadeOf(publishTime?: number): string | null {
  // 注意：不能把 <= 0 当作无效值。1970 年之前的时间戳本身就是负数，
  // 而网易云上确实存在 60/70 年代的老录音，用 <= 0 判定会把这些歌漏掉。
  if (typeof publishTime !== 'number' || !Number.isFinite(publishTime)) return null
  if (publishTime === 0) return null

  const year = new Date(publishTime).getFullYear()
  // 反过来做一次合理性校验，挡掉明显异常的时间戳
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null

  if (year < 1970) return '60年代及更早'
  if (year < 1980) return '70年代'
  if (year < 1990) return '80年代'
  if (year < 2000) return '90年代'
  if (year < 2010) return '00年代'
  if (year < 2020) return '10年代'
  return '20年代'
}

const RE_CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/
const RE_KANA = /[\u3040-\u309f\u30a0-\u30ff]/
const RE_HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/
const RE_LATIN = /[A-Za-z]/

/**
 * 语种预判。只做「有把握」的判断，拿不准就返回 null 交给 LLM。
 * 假名 / 谚文是强信号；中文与拉丁文需要看名字整体构成。
 */
export function guessLanguage(song: Song): string | null {
  const text = `${song.name} ${song.artists.join(' ')}`
  if (RE_KANA.test(text)) return '日语'
  if (RE_HANGUL.test(text)) return '韩语'
  if (RE_CJK.test(text)) return '华语'
  if (RE_LATIN.test(text)) return '英语'
  return null
}

/** 纯音乐往往没有可靠文本信号，靠时长和歌名关键词做弱提示 */
const INSTRUMENTAL_HINT = /(instrumental|off\s*vocal|纯音乐|伴奏|钢琴曲|钢琴版|ost|bgm)/i

export function looksInstrumental(song: Song): boolean {
  return INSTRUMENTAL_HINT.test(`${song.name} ${song.album}`)
}
