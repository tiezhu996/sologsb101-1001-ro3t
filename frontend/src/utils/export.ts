import {
  clearAllTables,
  createId,
  db,
  DB_VERSION,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import { reportFileName, type TurbineReport } from '@/utils/report'
import type { ReportVersion } from '@/types/reportVersion'

const COLLECTIONS = ['turbines', 'blades', 'segments', 'defects', 'workOrders'] as const
/** 报告版本表不做强制校验（v2 时代的备份文件里没有该字段，按空数组兼容） */
const OPTIONAL_COLLECTIONS = ['reportVersions'] as const

type CollectionKey = (typeof COLLECTIONS)[number]
type OptionalCollectionKey = (typeof OPTIONAL_COLLECTIONS)[number]

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
  for (const key of COLLECTIONS) {
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
    reportVersions: sanitizeReportVersions(obj.reportVersions)
  }
  return { ok: true, errors, payload }
}

/**
 * 报告版本字段兜底：只保留结构完整的版本记录。
 * 快照缺失的旧 / 脏文件不入库，避免打开已出具版本时拿到空快照。
 */
function sanitizeReportVersions(input: ReportVersion[] | undefined): ReportVersion[] {
  if (!Array.isArray(input)) return []
  return input.filter((version): version is ReportVersion => {
    if (typeof version !== 'object' || version === null) return false
    const snapshot = version.snapshot
    return (
      typeof version.id === 'string' &&
      typeof version.reportSeriesId === 'string' &&
      typeof version.turbineId === 'string' &&
      typeof version.versionNo === 'number' &&
      (version.status === 'current' || version.status === 'superseded') &&
      typeof version.frozenAt === 'string' &&
      typeof snapshot === 'object' &&
      snapshot !== null &&
      typeof snapshot.turbine === 'object' &&
      Array.isArray(snapshot.blades) &&
      Array.isArray(snapshot.segments) &&
      Array.isArray(snapshot.defects) &&
      Array.isArray(snapshot.workOrders)
    )
  })
}

/** 组装当前本地数据的全量备份对象（含已出具报告版本的冻结快照） */
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

export interface PayloadCounts extends Record<CollectionKey, number>, Record<OptionalCollectionKey, number> {}

export function countPayload(payload: BackupPayload): PayloadCounts {
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
  counts: PayloadCounts
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
): Promise<PayloadCounts> {
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

  // 报告版本两轮映射：先分配版本 id（含 baseVersionId / supersededById 互链），
  // 再重建快照内 turbineId 及叶片 / 分段 / 缺陷 / 工单全链外键，保证旧报告仍能独立打开
  const versionIdMap = new Map<string, string>()
  const seriesIdMap = new Map<string, string>()
  const rawVersions = payload.reportVersions ?? []
  const remappedVersions = rawVersions.map((version) => {
    const newId = createId('rpt')
    versionIdMap.set(version.id, newId)
    let seriesId = seriesIdMap.get(version.reportSeriesId)
    if (!seriesId) {
      seriesId = createId('rsr')
      seriesIdMap.set(version.reportSeriesId, seriesId)
    }
    // 全量备份下列表里必然有对应机组；极端残缺文件下用同一个兜底 id 保持版本头与快照一致
    const remappedTurbineId =
      turbineIdMap.get(version.turbineId) ??
      turbineIdMap.get(version.snapshot.turbine.id) ??
      createId('tbn')
    return {
      ...version,
      id: newId,
      reportSeriesId: seriesId,
      turbineId: remappedTurbineId,
      snapshot: remapSnapshot(version, remappedTurbineId)
    }
  })
  const reportVersions = remappedVersions.map((version) => ({
    ...version,
    baseVersionId: version.baseVersionId ? versionIdMap.get(version.baseVersionId) ?? null : null,
    supersededById: version.supersededById ? versionIdMap.get(version.supersededById) ?? null : null
  }))

  function remapSnapshot(version: ReportVersion, remappedTurbineId: string): ReportVersion['snapshot'] {
    const snapshot = version.snapshot
    return {
      turbine: {
        ...snapshot.turbine,
        id: remappedTurbineId
      },
      blades: snapshot.blades.map((blade) => ({
        ...blade,
        id: bladeIdMap.get(blade.id) ?? createId('bld'),
        turbineId: remappedTurbineId
      })),
      segments: snapshot.segments.map((segment) => ({
        ...segment,
        id: segmentIdMap.get(segment.id) ?? createId('seg'),
        bladeId: bladeIdMap.get(segment.bladeId) ?? createId('bld')
      })),
      defects: snapshot.defects.map((defect) => ({
        ...defect,
        id: defectIdMap.get(defect.id) ?? createId('dfc'),
        segmentId: segmentIdMap.get(defect.segmentId) ?? createId('seg')
      })),
      workOrders: snapshot.workOrders.map((order) => ({
        ...order,
        id: createId('wo'),
        defectId: defectIdMap.get(order.defectId) ?? createId('dfc')
      }))
    }
  }

  return { ...payload, turbines, blades, segments, defects, workOrders, reportVersions }
}
