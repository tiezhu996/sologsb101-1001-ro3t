import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { db, DB_NAME, DB_VERSION } from '@/utils/db'
import { buildBackupPayload, importBackup, remapIds, validateBackup } from '@/utils/export'
import { createPinia, setActivePinia } from 'pinia'
import { useReportVersionStore } from '@/stores/reportVersionStore'

let passed = 0
function check(name: string, condition: boolean, extra = ''): void {
  if (!condition) throw new Error(`❌ ${name} ${extra}`)
  passed += 1
  console.log(`✅ ${name} ${extra}`)
}

async function main(): Promise<void> {
  /* ---------- 1. v1 老库 → v2 → v3 自动升级：老数据在、迁移执行、新表就绪 ---------- */
  const now = Date.now()
  // 用原始 Dexie 先建一个 v1 结构的库并写入老格式数据（缺 v2 新字段、索引也少）
  const legacy = new Dexie(DB_NAME)
  legacy.version(1).stores({
    turbines: 'id, code, model, commissionDate, updatedAt',
    blades: 'id, turbineId, serial, material, updatedAt',
    segments: 'id, bladeId, index, airfoil, updatedAt',
    defects: 'id, segmentId, type, severity, updatedAt',
    workOrders: 'id, defectId, team, state, updatedAt'
  })
  await legacy.table('turbines').put({
    id: 'tbn_old', code: 'WT-OLD', model: 'GW136-3.6MW', hubHeightM: 90,
    commissionDate: '2019-05-01', bladeCount: 1, createdAt: now, updatedAt: now
  })
  // 故意缺字段的 v1 老格式缺陷，验证 v1→v2 upgrade 的补全在 v3 升级链上仍执行
  await legacy.table('defects').put({
    id: 'dfc_old', segmentId: 'seg_x', type: '砂眼', severity: '轻度',
    createdAt: now, updatedAt: now
  })
  await legacy.close()

  // 应用侧 db 打开时应自动升到 v3
  check('应用库版本常量为 3', DB_VERSION === 3)
  {
    const ver = db.verno
    check('打开后实际 IndexedDB 版本为 3', ver === 3, `actual=${ver}`)
  }
  const oldTurbine = await db.turbines.get('tbn_old')
  check('升级后 v2 老机组仍在', oldTurbine?.code === 'WT-OLD')
  const oldDefect = await db.defects.get('dfc_old')
  check('v1→v2 迁移补全逻辑在 v3 升级链上仍执行（lengthMm=0/state=待处理）', oldDefect?.lengthMm === 0 && oldDefect?.state === '待处理')
  check('升级后 reportVersions 表可写', typeof db.reportVersions.put === 'function')
  await db.close()

  /* ---------- 2. 备份往返：出具两版 → 备份 → 清空 → 合并导入 → 关系完整 ---------- */
  indexedDB.deleteDatabase(DB_NAME)
  await db.open()
  setActivePinia(createPinia())
  const store = useReportVersionStore()
  const bladeId = 'bld_1'
  const segmentId = 'seg_1'
  const defectId = 'dfc_1'
  await db.transaction('rw', [db.turbines, db.blades, db.segments, db.defects, db.workOrders], async () => {
    await db.turbines.put({
      id: 'tbn_1', code: 'WT-B01', model: 'GW171-6.0MW', hubHeightM: 120,
      commissionDate: '2023-03-05', bladeCount: 1, createdAt: now, updatedAt: now
    })
    await db.blades.put({
      id: bladeId, turbineId: 'tbn_1', serial: 'A', lengthM: 84, material: '碳纤维',
      segmentCount: 1, createdAt: now, updatedAt: now
    })
    await db.segments.put({
      id: segmentId, bladeId, index: 1, startM: 0, endM: 28, airfoil: 'FX77-W-153',
      face: 'LE', sectionImage: '', createdAt: now, updatedAt: now
    })
    await db.defects.put({
      id: defectId, segmentId, type: '油污', severity: '轻度', lengthMm: 50, widthMm: 20,
      face: 'LE', positionM: 5, foundAt: '2026-09-10', state: '待处理', createdAt: now, updatedAt: now
    })
  })
  const v1 = await store.issueReport({ turbineId: 'tbn_1', issuedBy: '甲' })
  await db.defects.update(defectId, { severity: '重度', type: '裂纹' })
  const v2 = await store.reviseReport({ turbineId: 'tbn_1', issuedBy: '乙', revisionReason: '复核更正' })
  check('出具两版', v1.versionNo === 1 && v2.versionNo === 2)

  const backup = await buildBackupPayload()
  check('备份含 2 个报告版本', (backup.reportVersions?.length ?? 0) === 2)
  const validated = validateBackup(JSON.parse(JSON.stringify(backup)))
  check('备份自检通过', validated.ok)

  /* ---------- 3. 追加导入：id 重映射后版本链仍指得通，快照保持冻结内容 ---------- */
  const remapped = remapIds(backup)
  const rv1 = remapped.reportVersions!.find((v) => v.versionNo === 1)!
  const rv2 = remapped.reportVersions!.find((v) => v.versionNo === 2)!
  check('追加导入重分配版本 id', rv1.id !== v1.id && rv2.id !== v2.id)
  check('V2 的 supersedes 指向重映射后的 V1', rv2.supersedesVersionId === rv1.id)
  check('V1 的 supersededBy 指向重映射后的 V2', rv1.supersededByVersionId === rv2.id)
  check('追加导入机组 id 已重映射', rv1.turbineId !== 'tbn_1')
  check('版本链挂在同一重映射机组下', rv1.turbineId === rv2.turbineId)
  check('快照内部内容保持原样（仍为出具时的油污轻度）',
    rv1.snapshot.blades[0].segments[0].defects[0].severity === '轻度'
      && rv1.snapshot.blades[0].segments[0].defects[0].type === '油污')

  /* ---------- 4. 覆盖导入：清空后恢复，现行/替代关系不变 ---------- */
  const counts = await importBackup(backup, true)
  check('覆盖导入计数含报告版本', counts.reportVersions === 2)
  const restored1 = await db.reportVersions.get(v1.id)
  const restored2 = await db.reportVersions.get(v2.id)
  check('覆盖导入后 V1 已替代、V2 现行', restored1?.status === '已替代' && restored2?.status === '现行')
  check('覆盖导入后替代链完整', restored1.supersededByVersionId === v2.id && restored2.supersedesVersionId === v1.id)
  check('备份结构对旧文件（无 reportVersions）兼容', validateBackup({
    app: 'gbwindblade',
    turbines: [], blades: [], segments: [], defects: [], workOrders: []
  }).ok)

  console.log(`\n全部 ${passed} 项检查通过`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
