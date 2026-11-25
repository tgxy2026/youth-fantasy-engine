import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  Award,
  Beer,
  BookMarked,
  BookOpen,
  BookText,
  BrainCircuit,
  Calendar,
  Compass,
  Cpu,
  Dices,
  EyeOff,
  FileCheck,
  FileSearch,
  FileSpreadsheet,
  FileText,
  Flag,
  Flame,
  FolderKanban,
  Gem,
  GitBranch,
  GitFork,
  Globe,
  Handshake,
  Heart,
  History,
  Landmark,
  Layers,
  LayoutDashboard,
  Library,
  Lightbulb,
  ListChecks,
  ListTodo,
  Map as MapIcon,
  MapPin,
  MessageSquare,
  MessageSquareHeart,
  Network,
  Newspaper,
  Package,
  PenTool,
  Route,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Swords,
  Tags,
  UserCheck,
  UserCog,
  UserPlus,
  Users,
  Wand2,
} from 'lucide-react'
import type { TabDef } from '@/lib/types'

interface TabVisualMeta {
  icon: LucideIcon
  /** 控制在 6–9 个汉字内，保证 224px 窄侧栏不截断 */
  subtitle: string
}

const TAB_META: Record<string, TabVisualMeta> = {
  // 工作面板
  'dashboard': { icon: LayoutDashboard, subtitle: '写作概览与继续创作' },
  'model-settings': { icon: Cpu, subtitle: '模型接口、提示词配置' },
  'task-center': { icon: ListTodo, subtitle: '长任务进度与回看' },
  'guide': { icon: Compass, subtitle: '内置手册与更新说明' },
  'about': { icon: Heart, subtitle: '版本信息与支持作者' },

  // 正文写作
  'editor': { icon: PenTool, subtitle: '分卷章节与沉浸码字' },
  'community': { icon: Newspaper, subtitle: '社区投稿与码字排行' },

  // 灵感工具
  'inspire-tools': { icon: Lightbulb, subtitle: '取名器与脑暴参谋' },
  'bookbreak': { icon: BookMarked, subtitle: '外部文本智能拆解' },
  'creative-writing': { icon: Wand2, subtitle: '想法到章节自动串联' },
  'check-tools': { icon: ShieldCheck, subtitle: '连续性体检与审计' },
  'material-library': { icon: Library, subtitle: '内置参考资料素材库' },

  // 开书定位
  'positioning': { icon: Flag, subtitle: '题材赛道与核心卖点' },
  'worldbase': { icon: Globe, subtitle: '地理环境与世界规则' },
  'power': { icon: Flame, subtitle: '境界等级与能力体系' },
  'politics': { icon: Landmark, subtitle: '政权结构与权力秩序' },
  'economy': { icon: Gem, subtitle: '货币贸易与资源流通' },
  'belief': { icon: Sparkles, subtitle: '宗教信仰与精神体系' },
  'justice': { icon: Scale, subtitle: '律法准则与奖惩机制' },

  // 角色管理
  'char-main': { icon: UserCheck, subtitle: '核心主角档案设定' },
  'char-secondary': { icon: Users, subtitle: '重要配角资料清单' },
  'char-npc': { icon: UserPlus, subtitle: '龙套与群像人物卡' },
  'char-bio': { icon: BookText, subtitle: '人物小传与节点事件' },
  'relations': { icon: Network, subtitle: '人物羁绊与关系图谱' },

  // 世界构建
  'nations': { icon: ShieldAlert, subtitle: '国家宗门与组织档案' },
  'faction-rels': { icon: Handshake, subtitle: '阵营外交与冲突格局' },
  'geography': { icon: MapPin, subtitle: '地域风貌与场景地点' },
  'geography-map': { icon: MapIcon, subtitle: '交互式地图绘制编辑' },
  'races': { icon: Dices, subtitle: '智慧族群与奇异生灵' },
  'items': { icon: Package, subtitle: '神兵法宝与物品流转' },
  'history': { icon: History, subtitle: '纪元大事与历史年表' },
  'terms': { icon: Tags, subtitle: '专有名词与设定词条' },
  'misc-settings': { icon: Layers, subtitle: '未归类补充设定档案' },
  'worlds': { icon: OrbitFallback(), subtitle: '跨作品复用世界包' },

  // 大纲规划
  'master': { icon: BookOpen, subtitle: '全书主线与结局规划' },
  'chapter-master': { icon: FileSpreadsheet, subtitle: '按卷查看章节台账' },
  'volume-outline': { icon: FolderKanban, subtitle: '分卷阶段目标与结构' },
  'chapter-outline': { icon: ListChecks, subtitle: '单章剧情与事件细纲' },

  // 酒馆模式
  'tavern-control': { icon: BrainCircuit, subtitle: '推演参数与提示词' },
  'tavern-world': { icon: ScrollText, subtitle: '场景规则与背景注入' },
  'tavern-plot': { icon: Swords, subtitle: '多角色扮演剧情推演' },
  'tavern-report': { icon: FileCheck, subtitle: '推演合理性诊断报告' },
  'tavern-free': { icon: MessageSquare, subtitle: '自由对戏与情景对话' },
  'tavern-run': { icon: Beer, subtitle: 'AI KP 跑团检定互动' },
  'tavern-script': { icon: FileText, subtitle: '分场剧本与导入导出' },
  'tavern-card': { icon: UserCog, subtitle: '酒馆独立角色卡库' },

  // 创作管理
  'foreshadow': { icon: FileSearch, subtitle: '伏笔埋设与回收追踪' },
  'timeline': { icon: Calendar, subtitle: '历法换算与故事时间' },
  'plot-canvas': { icon: GitBranch, subtitle: '节点连线推演画布' },
  'hookpoints': { icon: Activity, subtitle: '章节爽点与节奏曲线' },
  'progress': { icon: Award, subtitle: '更新进度与产量记录' },
  'subplots': { icon: GitFork, subtitle: '多线叙事与支线状态' },
  'secrets': { icon: EyeOff, subtitle: '角色知情与防剧透表' },
  'trajectory': { icon: Route, subtitle: '创作轨迹与过程自证' },

  // 运营维护
  'style': { icon: BookOpen, subtitle: '文风准则与写作规范' },
  'changelog': { icon: History, subtitle: '设定修订历史台账' },
  'ideas': { icon: Lightbulb, subtitle: '灵感碎片与备忘收集' },
  'feedback': { icon: MessageSquareHeart, subtitle: '读者建议与修正清单' },
}

function OrbitFallback(): LucideIcon {
  return Globe
}

/** 根据页签元数据获取展示图标 */
export function getTabIcon(tab: TabDef, size = 15) {
  const Icon = TAB_META[tab.id]?.icon ?? FileText
  return <Icon size={size} />
}

/** 获取窄侧栏展示用的精简副标题（控制长度避免截断） */
export function getTabSubtitle(tab: TabDef): string {
  const preset = TAB_META[tab.id]?.subtitle
  if (preset) return preset
  const raw = (tab.description || '').split(/[。！？；：\n（]/)[0]?.trim() || ''
  return raw ? raw.slice(0, 11) : '点击打开此页面'
}
