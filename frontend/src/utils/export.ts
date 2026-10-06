import {
  clearAllTables,
  createId,
  db,
  DB_VERSION,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import type { ReportVersion } from '@/types/reportVersion'
import { reportFileName, type TurbineReport } from '@/utils/report'

/** 备份中参与计数 / 导入的集合（含报告版本） */
const COLLECTIONS = ['turbines', 'blades', 'segments', 'defects', 'workOrders', 'reportVersions'] as const

/** 旧版备份文件没有 reportVersions，校验时只强制五大台账数组 */
const REQUIRED_COLLECTIONS = ['turbines', 'blades', 'segments', 'defects', 'workOrders'] as const

type CollectionKey = (typeof COLLECTIONS)[number]

/** 校验备份对象的必备字段，返回错误信息数组（为空表示通过） */
export function validateBackup(input: unknown): {
  ok: boolean
  errors: string[]
  payload: BackupPayload | null
} {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbwindblade') errors.push('app 字段应为 gbwindblade，文件来源不明')
  for (const key of REQUIRED_COLLECTIONS) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }

  const payload: BackupPayload = {
    app: 'gbwindblade',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    turbines: obj.turbines ?? [],
    blades: obj.blades ?? [],
    segments: obj.segments ?? [],
    defects: obj.defects ?? [],
    workOrders: obj.workOrders ?? [],
    reportVersions: Array.isArray(obj.reportVersions) ? obj.reportVersions : []
  }
  return { ok: true, errors, payload }
}

/** 组装当前本地数据的全量备份对象 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [turbines, blades, segments, defects, workOrders, reportVersions] = await Promise.all([
    db.turbines.toArray(),
    db.blades.toArray(),
    db.segments.toArray(),
    db.defects.toArray(),
    db.workOrders.toArray(),
    db.reportVersions.toArray()
  ])
  return {
    app: 'gbwindblade',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    turbines,
    blades,
    segments,
    defects,
    workOrders,
    reportVersions
  }
}

/** 触发浏览器下载 */
function download(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function countPayload(payload: BackupPayload): Record<CollectionKey, number> {
  return {
    turbines: payload.turbines.length,
    blades: payload.blades.length,
    segments: payload.segments.length,
    defects: payload.defects.length,
    workOrders: payload.workOrders.length,
    reportVersions: payload.reportVersions?.length ?? 0
  }
}

/** 导出全量 JSON 备份到浏览器下载目录 */
export async function exportBackupJson(): Promise<{
  fileName: string
  counts: Record<CollectionKey, number>
}> {
  const payload = await buildBackupPayload()
  const fileName = `gbwindblade-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  download(fileName, JSON.stringify(payload, null, 2))
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 导出单台机组的巡检报告 JSON */
export function exportReportJson(report: TurbineReport): string {
  const fileName = reportFileName(report)
  download(fileName, JSON.stringify(report, null, 2))
  return fileName
}

/** 读取用户选择的文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入备份：overwrite=true 先清空全部表，否则按主键合并（同 id 覆盖） */
export async function importBackup(
  payload: BackupPayload,
  overwrite: boolean
): Promise<Record<CollectionKey, number>> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.turbines, db.blades, db.segments, db.defects, db.workOrders, db.reportVersions],
    async () => {
      await db.turbines.bulkPut(payload.turbines)
      await db.blades.bulkPut(payload.blades)
      await db.segments.bulkPut(payload.segments)
      await db.defects.bulkPut(payload.defects)
      await db.workOrders.bulkPut(payload.workOrders)
      if (payload.reportVersions) await db.reportVersions.bulkPut(payload.reportVersions)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id 并重建外键关系，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const turbineIdMap = new Map<string, string>()
  const bladeIdMap = new Map<string, string>()
  const segmentIdMap = new Map<string, string>()
  const defectIdMap = new Map<string, string>()

  const turbines = payload.turbines.map((turbine) => {
    const id = createId('tbn')
    turbineIdMap.set(turbine.id, id)
    return { ...turbine, id }
  })
  const blades = payload.blades.map((blade) => {
    const id = createId('bld')
    bladeIdMap.set(blade.id, id)
    return { ...blade, id, turbineId: turbineIdMap.get(blade.turbineId) ?? blade.turbineId }
  })
  const segments = payload.segments.map((segment) => {
    const id = createId('seg')
    segmentIdMap.set(segment.id, id)
    return { ...segment, id, bladeId: bladeIdMap.get(segment.bladeId) ?? segment.bladeId }
  })
  const defects = payload.defects.map((defect) => {
    const id = createId('dfc')
    defectIdMap.set(defect.id, id)
    return { ...defect, id, segmentId: segmentIdMap.get(defect.segmentId) ?? defect.segmentId }
  })
  const workOrders = payload.workOrders.map((order) => ({
    ...order,
    id: createId('wo'),
    defectId: defectIdMap.get(order.defectId) ?? order.defectId
  }))

  // 报告版本另起一条链：顶层引用（机组 / 上一版 / 新版）全部重映射；
  // snapshot 内部保持原样作为冻结档案，不与新台账的 id 发生关联
  const missingTurbineIdMap = new Map<string, string>()
  const oldVersionIdToNew = new Map<string, string>()
  const reportVersions: ReportVersion[] = (payload.reportVersions ?? [])
    .map((version) => {
      const newId = createId('rpv')
      oldVersionIdToNew.set(version.id, newId)
      let newTurbineId = turbineIdMap.get(version.turbineId)
      if (!newTurbineId) {
        // 备份机组表已没有该机组（历史遗留报告）：给同一条链的各版一个稳定的空挂机组 id
        newTurbineId = missingTurbineIdMap.get(version.turbineId)
        if (!newTurbineId) {
          newTurbineId = createId('tbn')
          missingTurbineIdMap.set(version.turbineId, newTurbineId)
        }
      }
      return { ...version, id: newId, turbineId: newTurbineId }
    })
    .map((version) => ({
      ...version,
      supersedesVersionId:
        version.supersedesVersionId !== null
          ? (oldVersionIdToNew.get(version.supersedesVersionId) ?? null)
          : null,
      supersededByVersionId:
        version.supersededByVersionId !== null
          ? (oldVersionIdToNew.get(version.supersededByVersionId) ?? null)
          : null
    }))

  return { ...payload, turbines, blades, segments, defects, workOrders, reportVersions }
}
