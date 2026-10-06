import 'fake-indexeddb/auto'
import { useReportVersionStore } from '@/stores/reportVersionStore'
import { db, clearAllTables, createId } from '@/utils/db'
import type { Turbine } from '@/types/turbine'
import type { Blade } from '@/types/blade'
import type { Segment } from '@/types/segment'
import type { Defect } from '@/types/defect'
import type { WorkOrder } from '@/types/workOrder'
import { createPinia, setActivePinia } from 'pinia'

let passed = 0
function check(name: string, condition: boolean, extra = ''): void {
  if (!condition) throw new Error(`❌ ${name} ${extra}`)
  passed += 1
  console.log(`✅ ${name} ${extra}`)
}

async function seedChain(): Promise<{ turbineId: string; defectId: string }> {
  setActivePinia(createPinia())
  await clearAllTables()
  const now = Date.now()
  const turbineId = createId('tbn')
  const bladeId = createId('bld')
  const segmentId = createId('seg')
  const defectId = createId('dfc')
  const turbine: Turbine = {
    id: turbineId,
    code: 'WT-T01',
    model: 'GW155-4.5MW',
    hubHeightM: 110,
    commissionDate: '2022-01-01',
    bladeCount: 1,
    createdAt: now,
    updatedAt: now
  }
  const blade: Blade = {
    id: bladeId,
    turbineId,
    serial: 'A',
    lengthM: 68.5,
    material: '玻璃纤维',
    segmentCount: 1,
    createdAt: now,
    updatedAt: now
  }
  const segment: Segment = {
    id: segmentId,
    bladeId,
    index: 1,
    startM: 0,
    endM: 22.8,
    airfoil: 'DU-91-W2-250',
    face: 'PS',
    sectionImage: '',
    createdAt: now,
    updatedAt: now
  }
  const defect: Defect = {
    id: defectId,
    segmentId,
    type: '裂纹',
    severity: '中度',
    lengthMm: 100,
    widthMm: 5,
    face: 'PS',
    positionM: 10,
    foundAt: '2026-09-01',
    state: '待处理',
    createdAt: now,
    updatedAt: now
  }
  const order: WorkOrder = {
    id: createId('wo'),
    defectId,
    team: '叶片检修一班',
    dueDate: '2026-10-20',
    state: '待派',
    acceptor: '',
    closedAt: null,
    createdAt: now,
    updatedAt: now
  }
  await db.transaction('rw', [db.turbines, db.blades, db.segments, db.defects, db.workOrders], async () => {
    await db.turbines.put(turbine)
    await db.blades.put(blade)
    await db.segments.put(segment)
    await db.defects.put(defect)
    await db.workOrders.put(order)
  })
  return { turbineId, defectId }
}

async function main(): Promise<void> {
  const { turbineId, defectId } = await seedChain()
  const store = useReportVersionStore()

  // 1. 出具 V1，冻结当时数据
  const v1 = await store.issueReport({ turbineId, issuedBy: '张三' })
  check('出具首版为 V1', v1.versionNo === 1)
  check('报告编号形如 RPT-WTT01-202610', v1.reportNo.startsWith('RPT-WTT01-'), v1.reportNo)
  check('V1 状态现行', v1.status === '现行')
  check('V1 缺陷数 1', v1.snapshot.summary.defectCount === 1)
  check('V1 工单数 1', v1.snapshot.summary.workOrderCount === 1)
  check(
    'V1 快照缺陷为中度裂纹',
    v1.snapshot.blades[0].segments[0].defects[0].severity === '中度'
      && v1.snapshot.blades[0].segments[0].defects[0].type === '裂纹'
  )

  // 2. 重复出具必须被拒绝
  let blocked = false
  try {
    await store.issueReport({ turbineId, issuedBy: '李四' })
  } catch {
    blocked = true
  }
  check('同机组重复出具被拒绝（只能修订）', blocked)

  // 3. 改台账：缺陷升级为重度、类型改雷击，并删除工单
  await db.defects.update(defectId, { severity: '重度', type: '雷击', updatedAt: Date.now() })
  await db.workOrders.clear()

  // 4. V1 快照必须原样不变
  const v1Defect = v1.snapshot.blades[0].segments[0].defects[0]
  check('改台账后 V1 仍为中度裂纹（按快照）', v1Defect.severity === '中度' && v1Defect.type === '裂纹')
  check('改台账后 V1 工单数仍为 1', v1.snapshot.summary.workOrderCount === 1)

  // 5. 快照深冻：页面只通过 snapshotOf 读取，误写会被运行时拦截
  const frozenSnap = store.snapshotOf(v1.id)
  if (!frozenSnap) throw new Error('snapshotOf 读不到 V1')
  const frozenD = frozenSnap.blades[0].segments[0].defects[0]
  let frozen = false
  try {
    ;(frozenD as { severity: string }).severity = '轻度'
  } catch {
    frozen = true
  }
  check('V1 快照已冻结，误写直接抛错', frozen)
  check('冻结后值未被篡改', frozenD.severity === '中度')

  // 6. 从最新版修订：按当前台账生成 V2
  const v2 = await store.reviseReport({
    turbineId,
    issuedBy: '李四',
    revisionReason: '现场复核升级为重度雷击，工单撤回'
  })
  check('修订生成 V2', v2.versionNo === 2)
  check('V2 沿用同一报告编号', v2.reportNo === v1.reportNo)
  check('V2 按当前台账：重度雷击', v2.snapshot.blades[0].segments[0].defects[0].severity === '重度'
    && v2.snapshot.blades[0].segments[0].defects[0].type === '雷击')
  check('V2 按当前台账：工单已清空', v2.snapshot.summary.workOrderCount === 0)
  check('V2 supersedes 指向 V1', v2.supersedesVersionId === v1.id)
  check('V2 带修订说明', v2.revisionReason.includes('现场复核'))

  // 7. 替代关系落库：V1 已替代，V2 现行
  const v1Reloaded = await db.reportVersions.get(v1.id)
  check('V1 状态变为已替代', v1Reloaded?.status === '已替代')
  check('V1 supersededBy 指向 V2', v1Reloaded?.supersededByVersionId === v2.id)
  const latest = store.latestVersionOfTurbine(turbineId)
  check('最新版是 V2', latest?.id === v2.id && latest.status === '现行')
  check('版本链共 2 版', store.versionsOfTurbine(turbineId).length === 2)

  // 8. 修订必须带说明
  let reasonBlocked = false
  try {
    await store.reviseReport({ turbineId, issuedBy: '李四', revisionReason: '   ' })
  } catch {
    reasonBlocked = true
  }
  check('空修订说明被拒绝', reasonBlocked)
}

async function scenarioOrphan(): Promise<void> {
  const { turbineId } = await seedChain()
  const store = useReportVersionStore()
  await store.issueReport({ turbineId, issuedBy: '张三' })
  // 模拟级联删除机组（只删五大台账，reportVersions 保留）
  await db.transaction('rw', [db.turbines, db.blades, db.segments, db.defects, db.workOrders], async () => {
    await db.workOrders.clear()
    await db.defects.clear()
    await db.segments.clear()
    await db.blades.clear()
    await db.turbines.clear()
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('机组移走后仍保留 1 个报告版本', store.versions.length === 1)
  const orphan = store.orphanVersions
  check('旧报告进入「已移出台账」列表', orphan.length === 1 && orphan[0].turbineCode === 'WT-T01')
  const snap = store.snapshotOf(orphan[0].id)
  check('旧报告快照仍可打开', snap !== null && snap.summary.defectCount === 1)
  check('旧报告导出结构完整', snap?.version?.reportNo.startsWith('RPT-WTT01-') === true)
}

main()
  .then(() => scenarioOrphan())
  .then(() => {
    console.log(`\n全部 ${passed} 项检查通过`)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
