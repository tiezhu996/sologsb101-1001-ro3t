import type { Blade } from '@/types/blade'
import type { Segment } from '@/types/segment'
import type { Defect } from '@/types/defect'
import type { WorkOrder } from '@/types/workOrder'

/**
 * 报告出具时冻结的台账快照。
 * 已出具版本只允许读这份快照，禁止再回链实时台账——
 * 否则事后修改缺陷 / 工单，已发出的报告会在库里悄悄改数。
 * 剖面图 DataURL 不入库（仅页面预览用），冻结时剥离以控制快照体积。
 */
export interface ReportSnapshot {
  /** 出具时点的机组台账头信息（机组后来被删除 / 改号，旧报告仍凭它打开导出） */
  turbine: {
    id: string
    code: string
    model: string
    hubHeightM: number
    commissionDate: string
    bladeCount: number
  }
  blades: Blade[]
  segments: Segment[]
  defects: Defect[]
  workOrders: WorkOrder[]
}

/** 报告版本状态：只有最新一版为 current，修订后旧版自动落为 superseded */
export type ReportVersionStatus = 'current' | 'superseded'

export const REPORT_VERSION_STATUS_LABEL: Record<ReportVersionStatus, string> = {
  current: '当前版本',
  superseded: '已被替代'
}

/**
 * 巡检报告版本（报告链上的一版）。
 * 同一机组的首版出具产生一个 reportSeriesId；之后每次更正从最新版本发起修订：
 * 原版本保留不动并标记 superseded，新版本继承同一系列、版本号 +1 并回指 baseVersionId。
 */
export interface ReportVersion {
  /** 版本主键，前缀 rpt_ */
  id: string
  /** 报告系列 id：同一机组各次出具 / 修订共享一个系列 id */
  reportSeriesId: string
  /** 出具时的机组 id（来源标识；机组被删除后此字段仍在，但不再能 join 实时台账） */
  turbineId: string
  /** 出具时点的机组编号冗余，机组被删后版本列表仍能显示归属 */
  turbineCode: string
  /** 版本号，系列内从 1 递增 */
  versionNo: number
  status: ReportVersionStatus
  /** 冻结时点（ISO 字符串），同时作为报告的出具时间 */
  frozenAt: string
  /** 出具人（班组 / 人员） */
  issuedBy: string
  /** 修订说明；首版为出具说明，修订版填写更正原因 */
  revisionNote: string
  /** 修订版回指的原版本 id；首版为 null（替代关系的正向前链） */
  baseVersionId: string | null
  /** 被哪个新版本替代；当前版本为 null（替代关系的反向后链） */
  supersededById: string | null
  /** 冻结快照，旧报告的唯一数据来源 */
  snapshot: ReportSnapshot
  createdAt: number
  updatedAt: number
}
