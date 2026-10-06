import { defineStore } from 'pinia'
import { computed } from 'vue'
import { createId, db, DB_VERSION } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { ReportVersion } from '@/types/reportVersion'
import type { Turbine } from '@/types/turbine'
import type { Blade } from '@/types/blade'
import type { Segment } from '@/types/segment'
import type { Defect } from '@/types/defect'
import type { WorkOrder } from '@/types/workOrder'
import { attachVersionMeta, buildTurbineReport, deepFreeze } from '@/utils/report'
import { buildReportNo } from '@/types/reportVersion'
import { useTurbineStore } from '@/stores/turbineStore'

export interface IssueReportInput {
  turbineId: string
  issuedBy: string
}

export interface ReviseReportInput {
  turbineId: string
  issuedBy: string
  /** 修订说明（必填，月底对账时说明为什么更正） */
  revisionReason: string
}

/** 出具 / 修订时按机组从台账收集的整条链 */
interface TurbineChain {
  turbine: Turbine
  blades: Blade[]
  segments: Segment[]
  defects: Defect[]
  workOrders: WorkOrder[]
}

/**
 * 直接从 IndexedDB 读取机组 → 叶片 → 分段 → 缺陷 → 工单整条链。
 * 不走响应式 rows：出具必须取点击那一刻的台账，而不是页面可能尚未刷新的缓存。
 */
async function collectTurbineChain(turbineId: string): Promise<TurbineChain> {
  const turbine = await db.turbines.get(turbineId)
  if (!turbine) {
    throw new Error('机组已不在当前台账中，无法按当前台账出具 / 修订；历史版本仍可从版本列表打开')
  }
  const blades = await db.blades.where('turbineId').equals(turbineId).toArray()
  const bladeIds = blades.map((blade) => blade.id)
  const segments = bladeIds.length > 0
    ? await db.segments.where('bladeId').anyOf(bladeIds).toArray()
    : []
  const segmentIds = segments.map((segment) => segment.id)
  const defects = segmentIds.length > 0
    ? await db.defects.where('segmentId').anyOf(segmentIds).toArray()
    : []
  const defectIds = defects.map((defect) => defect.id)
  const workOrders = defectIds.length > 0
    ? await db.workOrders.where('defectId').anyOf(defectIds).toArray()
    : []
  return { turbine, blades, segments, defects, workOrders }
}

/**
 * 报告版本 store：报告出具（冻结快照）、修订（最新版 → 新版本 + 替代关系）。
 * 已出具版本的查看与导出只能读快照，当前台账仅在出具 / 修订动作发生时读取一次。
 */
export const useReportVersionStore = defineStore('reportVersion', () => {
  const versionsTable = useIdbTable<ReportVersion>((database) => database.reportVersions, {
    sortByUpdatedAt: false
  })

  /** 全部版本，按机组编号聚合时用（版本号升序） */
  const versions = computed<ReportVersion[]>(() =>
    [...versionsTable.rows.value].sort((a, b) => {
      const group = a.turbineId.localeCompare(b.turbineId)
      if (group !== 0) return group
      return a.versionNo - b.versionNo
    })
  )

  /** 机组 id → 版本链（版本号升序） */
  const versionsByTurbine = computed<Map<string, ReportVersion[]>>(() => {
    const map = new Map<string, ReportVersion[]>()
    versions.value.forEach((version) => {
      const list = map.get(version.turbineId) ?? []
      list.push(version)
      map.set(version.turbineId, list)
    })
    map.forEach((list) => list.sort((a, b) => a.versionNo - b.versionNo))
    return map
  })

  /** 机组 id → 最新版（supersededByVersionId 为空且版本号最大） */
  const latestByTurbine = computed<Map<string, ReportVersion>>(() => {
    const map = new Map<string, ReportVersion>()
    versionsByTurbine.value.forEach((list, turbineId) => {
      const latest = list
        .filter((version) => version.supersededByVersionId === null)
        .sort((a, b) => b.versionNo - a.versionNo)[0]
      if (latest) map.set(turbineId, latest)
    })
    return map
  })

  /** 机组、叶片等已被移走但报告仍需保留：机组 id 不在台账里的版本 */
  const orphanVersions = computed<ReportVersion[]>(() => {
    const turbineIds = new Set(useTurbineStore().turbines.map((turbine) => turbine.id))
    return versions.value
      .filter((version) => !turbineIds.has(version.turbineId))
      .sort((a, b) =>
        a.turbineCode.localeCompare(b.turbineCode) || a.versionNo - b.versionNo
      )
  })

  /**
   * 版本 id → 冻结后的快照。
   * 快照对象整体 Object.freeze：任何把快照当台账改写的代码都会在开发期立刻报错，
   * 从机制上保证「同一版按快照、不按当前台账」。
   */
  const frozenSnapshotById = computed<Map<string, ReportVersion['snapshot']>>(() => {
    const map = new Map<string, ReportVersion['snapshot']>()
    versionsTable.rows.value.forEach((version) => {
      map.set(version.id, deepFreeze(version.snapshot))
    })
    return map
  })

  function versionsOfTurbine(turbineId: string): ReportVersion[] {
    return versionsByTurbine.value.get(turbineId) ?? []
  }

  function latestVersionOfTurbine(turbineId: string): ReportVersion | null {
    return latestByTurbine.value.get(turbineId) ?? null
  }

  function snapshotOf(versionId: string): ReportVersion['snapshot'] | null {
    return frozenSnapshotById.value.get(versionId) ?? null
  }

  function versionById(versionId: string): ReportVersion | undefined {
    return versionsTable.rows.value.find((version) => version.id === versionId)
  }

  /** 点「出具」：冻结当时机组 → 叶片 → 分段 → 缺陷 → 工单，生成 V1 与报告编号 */
  async function issueReport(input: IssueReportInput): Promise<ReportVersion> {
    const chain = await collectTurbineChain(input.turbineId)
    const issuedBy = input.issuedBy.trim()
    if (!issuedBy) throw new Error('请填写出具人')

    const existing = await db.reportVersions.where('turbineId').equals(input.turbineId).count()
    if (existing > 0) {
      throw new Error('该机组已出具过报告；如需更正请从最新版发起修订，旧版会保留')
    }

    const now = Date.now()
    const iso = new Date(now).toISOString()
    const reportNo = buildReportNo(chain.turbine.code, iso)
    const id = createId('rpv')
    const snapshot = attachVersionMeta(
      buildTurbineReport(
        {
          id: chain.turbine.id,
          code: chain.turbine.code,
          model: chain.turbine.model,
          hubHeightM: chain.turbine.hubHeightM,
          commissionDate: chain.turbine.commissionDate,
          bladeCount: chain.turbine.bladeCount
        },
        {
          blades: chain.blades,
          segments: chain.segments,
          defects: chain.defects,
          workOrders: chain.workOrders
        },
        DB_VERSION,
        iso
      ),
      {
        versionId: id,
        reportNo,
        versionNo: 1,
        issuedAt: iso,
        issuedBy,
        revisionReason: '',
        supersedesVersionId: null
      }
    )

    const version: ReportVersion = {
      id,
      reportNo,
      turbineId: chain.turbine.id,
      turbineCode: chain.turbine.code,
      versionNo: 1,
      status: '现行',
      issuedAt: now,
      issuedBy,
      revisionReason: '',
      supersedesVersionId: null,
      supersededByVersionId: null,
      snapshot,
      createdAt: now,
      updatedAt: now
    }
    await db.reportVersions.put(version)
    return version
  }

  /**
   * 点「修订」：必须从该机组最新版发起。
   * 按当前台账重新冻结为 V(n+1)，原最新版置「已替代」并互标替代关系；更早版本不动。
   */
  async function reviseReport(input: ReviseReportInput): Promise<ReportVersion> {
    const reason = input.revisionReason.trim()
    if (!reason) throw new Error('请填写修订说明')
    const issuedBy = input.issuedBy.trim()
    if (!issuedBy) throw new Error('请填写出具人')

    const chain = await collectTurbineChain(input.turbineId)
    const chainVersions = await db.reportVersions.where('turbineId').equals(input.turbineId).toArray()
    const latest = chainVersions
      .filter((version) => version.supersededByVersionId === null)
      .sort((a, b) => b.versionNo - a.versionNo)[0]
    if (!latest) throw new Error('该机组尚未出具过报告，请先点「出具」生成首版')

    const now = Date.now()
    const iso = new Date(now).toISOString()
    const versionNo = latest.versionNo + 1
    const id = createId('rpv')
    const snapshot = attachVersionMeta(
      buildTurbineReport(
        {
          id: chain.turbine.id,
          code: chain.turbine.code,
          model: chain.turbine.model,
          hubHeightM: chain.turbine.hubHeightM,
          commissionDate: chain.turbine.commissionDate,
          bladeCount: chain.turbine.bladeCount
        },
        {
          blades: chain.blades,
          segments: chain.segments,
          defects: chain.defects,
          workOrders: chain.workOrders
        },
        DB_VERSION,
        iso
      ),
      {
        versionId: id,
        reportNo: latest.reportNo,
        versionNo,
        issuedAt: iso,
        issuedBy,
        revisionReason: reason,
        supersedesVersionId: latest.id
      }
    )

    const version: ReportVersion = {
      id,
      reportNo: latest.reportNo,
      turbineId: chain.turbine.id,
      turbineCode: chain.turbine.code,
      versionNo,
      status: '现行',
      issuedAt: now,
      issuedBy,
      revisionReason: reason,
      supersedesVersionId: latest.id,
      supersededByVersionId: null,
      snapshot,
      createdAt: now,
      updatedAt: now
    }

    await db.transaction('rw', db.reportVersions, async () => {
      await db.reportVersions.put(version)
      await db.reportVersions.update(latest.id, {
        status: '已替代',
        supersededByVersionId: id,
        updatedAt: now
      })
    })
    return version
  }

  return {
    versions,
    versionsByTurbine,
    latestByTurbine,
    orphanVersions,
    versionsOfTurbine,
    latestVersionOfTurbine,
    versionById,
    snapshotOf,
    issueReport,
    reviseReport
  }
})
