import type { TurbineReport } from '@/utils/report'

/** 报告版本状态 */
export type ReportVersionStatus = '现行' | '已替代' | '已作废'

export const REPORT_VERSION_STATUSES: ReportVersionStatus[] = ['现行', '已替代', '已作废']

/**
 * 巡检报告版本：点「出具」时按当时台账冻结的不可变快照。
 *
 * 口径约定（对账关键）：
 * - 同一机组一条版本链，首版 V1；更正只能从最新版发起修订，生成 V2、V3……
 * - 已出具版本的查看与导出永远读 snapshot（快照口径），不得再按当前台账重算；
 * - 修订按当前台账重新冻结，原版保留并互标替代关系（supersedes / supersededBy）；
 * - 机组、叶片或工单日后被删除 / 移走，快照不受影响，旧报告仍可打开导出。
 */
export interface ReportVersion {
  id: string
  /** 报告编号，同一条版本链共用（机组编号 + 首版年月） */
  reportNo: string
  /** 出具时所属机组 id；机组日后被删除，本记录作为历史报告留存 */
  turbineId: string
  /** 冗余机组编号，机组被移走后历史报告列表仍能展示 */
  turbineCode: string
  /** 版本号，从 1 递增 */
  versionNo: number
  status: ReportVersionStatus
  /** 出具时间戳 */
  issuedAt: number
  /** 出具人 */
  issuedBy: string
  /** 修订说明；首版为空字符串 */
  revisionReason: string
  /** 本版替代的上一版 id；首版为 null */
  supersedesVersionId: string | null
  /** 替代本版的更新版 id；现行版本为 null */
  supersededByVersionId: string | null
  /** 冻结快照：报告 → 叶片 → 分段 → 缺陷 → 工单，出具后不再随台账变化 */
  snapshot: TurbineReport
  createdAt: number
  updatedAt: number
}

/** Element Plus 标签配色 */
export function reportStatusTagType(status: ReportVersionStatus): 'success' | 'info' | 'danger' {
  if (status === '现行') return 'success'
  if (status === '已作废') return 'danger'
  return 'info'
}

/** 报告编号：RPT-<机组编号字母数字>-<首版年月 YYYYMM>，如 RPT-WTA01-202610 */
export function buildReportNo(turbineCode: string, issuedAtIso: string): string {
  const month = issuedAtIso.slice(0, 7).replace('-', '')
  const code = turbineCode.replace(/[^A-Za-z0-9]/g, '')
  return `RPT-${code}-${month}`
}
