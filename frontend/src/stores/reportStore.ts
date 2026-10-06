import { defineStore } from 'pinia'
import { computed } from 'vue'
import { createId, db } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { ReportVersion } from '@/types/reportVersion'
import { captureTurbineSnapshot } from '@/utils/report'

export interface IssueReportInput {
  /** 出具人（班组 / 人员） */
  issuedBy: string
  /** 出具 / 修订说明 */
  revisionNote: string
}

/** 出具 / 修订的返回结果，供页面提示与跳转 */
export interface IssueReportResult {
  version: ReportVersion
  /** first=true 为首次出具（V1）；false 为修订（产生新版本） */
  first: boolean
}

/** 同系列版本按版本号升序 */
function byVersionNoAsc(a: ReportVersion, b: ReportVersion): number {
  return a.versionNo - b.versionNo
}

/**
 * 报告版本 store：管理已出具报告的冻结版本与修订链。
 * 已出具版本一律以快照为准；修订只能从最新版本发起，旧版保留并标记替代关系。
 */
export const useReportStore = defineStore('reportVersion', () => {
  const versionsTable = useIdbTable<ReportVersion>((database) => database.reportVersions, {
    sortByUpdatedAt: false
  })

  /** 全部版本，按冻结时间倒序（新出具的在前） */
  const versions = computed<ReportVersion[]>(() =>
    [...versionsTable.rows.value].sort((a, b) => b.versionNo - a.versionNo || b.frozenAt.localeCompare(a.frozenAt))
  )
  const loading = computed(() => versionsTable.loading.value)
  const ready = computed(() => versionsTable.ready.value)

  function versionsOfTurbine(turbineId: string): ReportVersion[] {
    return versions.value.filter((version) => version.turbineId === turbineId).sort(byVersionNoAsc)
  }

  function seriesVersions(reportSeriesId: string): ReportVersion[] {
    return versions.value.filter((version) => version.reportSeriesId === reportSeriesId).sort(byVersionNoAsc)
  }

  /** 机组当前（最新有效）版本；未出具过返回 undefined */
  function currentVersionOfTurbine(turbineId: string): ReportVersion | undefined {
    const list = versionsOfTurbine(turbineId)
    return list.filter((version) => version.status === 'current').sort(byVersionNoAsc).at(-1)
  }

  function versionById(id: string): ReportVersion | undefined {
    return versions.value.find((version) => version.id === id)
  }

  /** 台账中机组已被删除、但仍留有历史报告的系列（旧报告仍能打开导出） */
  function orphanVersions(existingTurbineIds: Set<string>): ReportVersion[] {
    return versions.value.filter((version) => !existingTurbineIds.has(version.turbineId))
  }

  /**
   * 出具报告（首次）：按当前台账冻结快照，生成 V1。
   * 同一机组已有任一版本时拒绝，更正必须走 reviseReport（从最新版本发起修订）。
   */
  async function issueReport(turbineId: string, input: IssueReportInput): Promise<IssueReportResult> {
    const existing = versionsOfTurbine(turbineId)
    if (existing.length > 0) {
      throw new Error('该机组已出具过报告；如需更正，请从最新版本发起修订以保留替代关系')
    }

    const now = Date.now()
    const frozenAt = new Date(now).toISOString()
    const reportSeriesId = createId('rsr')
    let newVersion: ReportVersion | null = null

    await db.transaction(
      'rw',
      [db.turbines, db.blades, db.segments, db.defects, db.workOrders, db.reportVersions],
      async () => {
        // 事务内复查：防止双击 / 多标签页并发为同一机组出具两条 V1
        const occupied = await db.reportVersions.where('turbineId').equals(turbineId).count()
        if (occupied > 0) throw new Error('该机组已出具过报告；如需更正，请从最新版本发起修订以保留替代关系')
        const snapshot = await captureTurbineSnapshot(turbineId, db)
        newVersion = {
          id: createId('rpt'),
          reportSeriesId,
          turbineId,
          turbineCode: snapshot.turbine.code,
          versionNo: 1,
          status: 'current',
          frozenAt,
          issuedBy: input.issuedBy.trim(),
          revisionNote: input.revisionNote.trim(),
          baseVersionId: null,
          supersededById: null,
          snapshot,
          createdAt: now,
          updatedAt: now
        }
        await db.reportVersions.put(newVersion)
      }
    )

    if (!newVersion) throw new Error("出具失败：未生成报告版本")
    return { version: newVersion, first: true }
  }

  /**
   * 修订：从最新版本发起——按当前台账重新冻结生成下一版，
   * 原版本保留不动、状态落为 superseded 并回指新版本（替代关系）。
   */
  async function reviseReport(baseVersionId: string, input: IssueReportInput): Promise<IssueReportResult> {
    const base = versionById(baseVersionId)
    if (!base) throw new Error('原报告版本不存在，无法发起修订')
    if (base.status !== 'current') {
      throw new Error('只能从最新版本发起修订；该版本已被替代')
    }

    const nextNo =
      seriesVersions(base.reportSeriesId).reduce((max, item) => Math.max(max, item.versionNo), 0) + 1
    const now = Date.now()
    const frozenAt = new Date(now).toISOString()
    let newVersion: ReportVersion | null = null

    await db.transaction(
      'rw',
      [db.turbines, db.blades, db.segments, db.defects, db.workOrders, db.reportVersions],
      async () => {
        // 事务内复查原版状态：并发修订时第二个请求应失败，而不是再分叉一版
        const freshBase = await db.reportVersions.get(base.id)
        if (!freshBase || freshBase.status !== 'current') {
          throw new Error('原版本已被替代，请刷新后从最新版本发起修订')
        }
        // 新报告按当前台账生成；机组已被移走则无法修订（旧版本本身仍可打开导出）
        const snapshot = await captureTurbineSnapshot(base.turbineId, db)
        const nextId = createId('rpt')
        newVersion = {
          id: nextId,
          reportSeriesId: base.reportSeriesId,
          turbineId: base.turbineId,
          turbineCode: snapshot.turbine.code,
          versionNo: nextNo,
          status: 'current',
          frozenAt,
          issuedBy: input.issuedBy.trim(),
          revisionNote: input.revisionNote.trim(),
          baseVersionId: base.id,
          supersededById: null,
          snapshot,
          createdAt: now,
          updatedAt: now
        }
        // 原版保留：仅落状态与替代后链，正文快照不动
        await db.reportVersions.update(base.id, {
          status: 'superseded',
          supersededById: nextId,
          updatedAt: now
        })
        await db.reportVersions.put(newVersion)
      }
    )

    if (!newVersion) throw new Error("修订失败：未生成报告版本")
    return { version: newVersion, first: false }
  }

  return {
    versions,
    loading,
    ready,
    versionsOfTurbine,
    seriesVersions,
    currentVersionOfTurbine,
    versionById,
    orphanVersions,
    issueReport,
    reviseReport
  }
})
