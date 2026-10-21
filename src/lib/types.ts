/** 领域模型：只保留分类和建歌单真正用得到的字段。 */

export interface NeteaseProfile {
  userId: number
  nickname: string
  avatarUrl?: string
}

export interface PlaylistBrief {
  id: number
  name: string
  /** 5 = 「我喜欢的音乐」，这是识别它的唯一可靠标志 */
  specialType: number
  trackCount: number
  userId: number
}

export interface Song {
  id: number
  name: string
  artists: string[]
  album: string
  albumId: number
  /** 发行时间（毫秒）。年代维度的唯一可信来源。 */
  publishTime?: number
  /** 时长（毫秒） */
  duration: number
}

/** 单首歌在某个维度上的归类结果 */
export interface SongClass {
  songId: number
  category: string | string[]
  /** 由谁判定：rules = 本地规则，llm = 模型，manual = 用户手改 */
  source: 'rules' | 'llm' | 'manual'
  reason?: string
}

/** 分类维度标识 */
export type DimensionKey = 'artist' | 'mood' | 'genre' | 'language' | 'era'

export type PlaylistNameStyle =
  | 'japanese-literary'
  | 'concise'
  | 'retro-record'
  | 'cinematic'
  | 'custom'

export interface Dimension {
  key: DimensionKey
  /** 维度名，会拼进歌单名，例如「情绪 · 深夜」 */
  label: string
  /** 该维度下允许的类目 */
  categories: string[]
  /** 可选的类目判定说明，会随分类提示发送给模型 */
  categoryHints?: Record<string, string>
  /** 关闭的维度不参与分类；每次只能启用一个维度 */
  enabled: boolean
  /** 内部分类名对应的建议歌单名，可在导入预览时选用或修改 */
  playlistNames?: Record<string, string>
}
