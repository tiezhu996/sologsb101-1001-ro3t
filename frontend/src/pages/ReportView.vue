<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
import {
  Delete,
  Document,
  Download,
  EditPen,
  Promotion,
  Refresh,
  Upload,
  View
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import SeverityTag from '@/components/common/SeverityTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useTurbineStore } from '@/stores/turbineStore'
import { useReportVersionStore } from '@/stores/reportVersionStore'
import {
  DB_NAME,
  DB_VERSION,
  clearAllTables,
  readLastBackupAt,
  readStampedDbVersion,
  seedDemoData
} from '@/utils/db'
import {
  countPayload,
  exportBackupJson,
  exportReportJson,
  importBackup,
  readFileText,
  remapIds,
  validateBackup
} from '@/utils/export'
import { buildTurbineReport, reportToText, type TurbineReport } from '@/utils/report'
import { reportStatusTagType, type ReportVersion } from '@/types/reportVersion'
import { formatArea, formatSize } from '@/utils/severity'
import { FACE_LABEL, formatRange, type SegmentFace } from '@/types/segment'
import { DEFECT_STATE_COLOR, type DefectState } from '@/types/defect'
import type { BackupPayload } from '@/utils/db'

const turbineStore = useTurbineStore()
const reportVersionStore = useReportVersionStore()

const selectedTurbineId = ref<string>(turbineStore.currentTurbineId ?? '')

watch(
  () => turbineStore.turbines.length,
  () => {
    const current = selectedTurbineId.value
    const stillExists = current.length > 0 && turbineStore.turbineById(current)
    if (stillExists) return
    const fallback =
      turbineStore.currentTurbineId && turbineStore.turbineById(turbineStore.currentTurbineId)
        ? turbineStore.currentTurbineId
        : turbineStore.turbines[0]?.id ?? ''
    selectedTurbineId.value = fallback
  },
  { immediate: true }
)

watch(selectedTurbineId, (value) => {
  if (value) turbineStore.setCurrentTurbine(value)
  // 切换机组默认回到台账实时预览，避免把上一台的快照误当成本台数据
  viewMode.value = 'current'
})

/* ---------------- 报告版本 ---------------- */
/** 预览口径：current=当前台账（未冻结）；snapshot=已出具版本的冻结快照 */
const viewMode = ref<'current' | 'snapshot'>('current')
const selectedVersionId = ref<string>('')

const turbineVersions = computed<ReportVersion[]>(() =>
  reportVersionStore.versionsOfTurbine(selectedTurbineId.value)
)
const latestVersion = computed<ReportVersion | null>(() =>
  selectedTurbineId.value ? reportVersionStore.latestVersionOfTurbine(selectedTurbineId.value) : null
)

watch(
  turbineVersions,
  (list) => {
    const stillBelongs = list.some((version) => version.id === selectedVersionId.value)
    if (!stillBelongs) selectedVersionId.value = latestVersion.value?.id ?? ''
  },
  { immediate: true }
)

const selectedVersion = computed<ReportVersion | undefined>(() =>
  selectedVersionId.value ? reportVersionStore.versionById(selectedVersionId.value) : undefined
)

/** 正在查看的版本：只有 snapshot 口径下存在；这是「同一版按快照」的唯一开关 */
const activeVersion = computed<ReportVersion | null>(
  () => (viewMode.value === 'snapshot' ? selectedVersion.value ?? null : null)
)

/** 按当前台账实时汇总（仅用于未冻结预览；出具 / 修订动作会在 store 里重新读库冻结） */
const liveReport = computed<TurbineReport | null>(() => {
  const turbine = turbineStore.turbineById(selectedTurbineId.value)
  if (!turbine) return null
  return buildTurbineReport(
    {
      id: turbine.id,
      code: turbine.code,
      model: turbine.model,
      hubHeightM: turbine.hubHeightM,
      commissionDate: turbine.commissionDate,
      bladeCount: turbine.bladeCount
    },
    {
      blades: turbineStore.blades,
      segments: turbineStore.segments,
      defects: turbineStore.defects,
      workOrders: turbineStore.workOrders
    },
    DB_VERSION
  )
})

/** 页面实际渲染的报告：查看版本时取冻结快照，否则取台账实时预览 */
const report = computed<TurbineReport | null>(() => {
  if (activeVersion.value) {
    return reportVersionStore.snapshotOf(activeVersion.value.id)
  }
  return liveReport.value
})

/** 当前预览是否属于已移出台账的机组（旧报告仍可打开导出） */
const activeVersionIsOrphan = computed<boolean>(
  () => activeVersion.value !== null && !turbineStore.turbineById(activeVersion.value.turbineId)
)

function viewVersion(versionId: string): void {
  selectedVersionId.value = versionId
  viewMode.value = 'snapshot'
}

function backToLive(): void {
  viewMode.value = 'current'
}

function formatTimestamp(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 19)
}

/* ---------------- 出具 ---------------- */
const issueVisible = ref(false)
const issueSubmitting = ref(false)
const issueForm = ref({ issuedBy: '' })

function openIssue(): void {
  issueForm.value = { issuedBy: '' }
  issueVisible.value = true
}

async function submitIssue(): Promise<void> {
  if (!selectedTurbineId.value || !issueForm.value.issuedBy.trim()) {
    ElMessage.warning('请填写出具人')
    return
  }
  issueSubmitting.value = true
  try {
    const version = await reportVersionStore.issueReport({
      turbineId: selectedTurbineId.value,
      issuedBy: issueForm.value.issuedBy
    })
    issueVisible.value = false
    ElMessage.success(`已出具 ${version.reportNo} V1：当前叶片、分段、缺陷、工单已冻结，之后改台账不影响本版`)
    viewVersion(version.id)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '出具失败')
  } finally {
    issueSubmitting.value = false
  }
}

/* ---------------- 修订 ---------------- */
const reviseVisible = ref(false)
const reviseSubmitting = ref(false)
const reviseForm = ref({ issuedBy: '', revisionReason: '' })

function openRevise(): void {
  if (!latestVersion.value) {
    ElMessage.warning('该机组还没有已出具版本，请先出具首版')
    return
  }
  reviseForm.value = { issuedBy: '', revisionReason: '' }
  reviseVisible.value = true
}

async function submitRevise(): Promise<void> {
  if (!selectedTurbineId.value) return
  if (!reviseForm.value.issuedBy.trim()) {
    ElMessage.warning('请填写出具人')
    return
  }
  if (!reviseForm.value.revisionReason.trim()) {
    ElMessage.warning('请填写修订说明，便于月底对账时说明更正原因')
    return
  }
  reviseSubmitting.value = true
  try {
    const version = await reportVersionStore.reviseReport({
      turbineId: selectedTurbineId.value,
      issuedBy: reviseForm.value.issuedBy,
      revisionReason: reviseForm.value.revisionReason
    })
    reviseVisible.value = false
    ElMessage.success(
      `已按当前台账生成 ${version.reportNo} V${version.versionNo}，上一版保留并标记为「已替代」`
    )
    viewVersion(version.id)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '修订失败')
  } finally {
    reviseSubmitting.value = false
  }
}

/* ---------------- 机组 / 叶片已移走的历史报告 ---------------- */
const orphanGroups = computed(() => {
  const groups = new Map<string, ReportVersion[]>()
  reportVersionStore.orphanVersions.forEach((version) => {
    const list = groups.get(version.turbineId) ?? []
    list.push(version)
    groups.set(version.turbineId, list)
  })
  return [...groups.entries()].map(([turbineId, list]) => {
    const sorted = [...list].sort((a, b) => b.versionNo - a.versionNo)
    return {
      turbineId,
      turbineCode: list[0]?.turbineCode ?? '—',
      count: list.length,
      latest: sorted[0] as ReportVersion
    }
  })
})

const dbMeta = computed(() => ({
  name: DB_NAME,
  version: DB_VERSION,
  stampedVersion: readStampedDbVersion(),
  lastBackupAt: readLastBackupAt(),
  turbines: turbineStore.turbines.length,
  blades: turbineStore.blades.length,
  segments: turbineStore.segments.length,
  defects: turbineStore.defects.length,
  workOrders: turbineStore.workOrders.length,
  reportVersions: reportVersionStore.versions.length
}))

/** 面位中文标签（模板内免去类型断言） */
function faceText(face: string): string {
  return FACE_LABEL[face as SegmentFace] ?? face
}

/** 缺陷状态配色（模板内免去类型断言） */
function stateColor(state: string): string {
  return DEFECT_STATE_COLOR[state as DefectState] ?? '#4a5b63'
}

const structureVisible = ref(false)
const structureText = computed(() => (report.value ? reportToText(report.value) : '请先选择机组'))

function openStructure(): void {
  structureVisible.value = true
}

/* ---------------- 导出 ---------------- */
async function handleExportBackup(): Promise<void> {
  const result = await exportBackupJson()
  ElMessage.success(
    `已导出备份 ${result.fileName}（机组 ${result.counts.turbines} · 叶片 ${result.counts.blades} · 分段 ${result.counts.segments} · 缺陷 ${result.counts.defects} · 工单 ${result.counts.workOrders} · 报告版本 ${result.counts.reportVersions}）`
  )
}

function handleExportReport(): void {
  const current = report.value
  if (!current) {
    ElMessage.warning('请先选择机组或历史版本')
    return
  }
  const fileName = exportReportJson(current)
  ElMessage.success(
    current.version
      ? `已导出冻结快照 ${fileName}（${current.version.reportNo} V${current.version.versionNo}）`
      : `已导出当前台账预览 ${fileName}（未出具，非正式版本）`
  )
}

/* ---------------- 导入 ---------------- */
const importVisible = ref(false)
const importSubmitting = ref(false)
const importFile = ref('')
const importMode = ref<'overwrite' | 'merge' | 'append'>('merge')
const importErrors = ref<string[]>([])
const importPayload = ref<BackupPayload | null>(null)
const importCounts = ref<Record<string, number> | null>(null)

async function handleImportFile(file: UploadFile): Promise<void> {
  const raw = file.raw
  if (!raw) return
  importFile.value = raw.name
  const text = await readFileText(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    ElMessage.error('JSON 解析失败，请确认文件内容完整')
    return
  }
  const result = validateBackup(parsed)
  if (!result.ok || !result.payload) {
    importErrors.value = result.errors
    importPayload.value = null
    importCounts.value = null
    importVisible.value = true
    return
  }
  importErrors.value = []
  importPayload.value = result.payload
  importCounts.value = countPayload(result.payload)
  importMode.value = 'merge'
  importVisible.value = true
}

async function submitImport(): Promise<void> {
  const payload = importPayload.value
  if (!payload) return
  importSubmitting.value = true
  try {
    if (importMode.value === 'overwrite') {
      await importBackup(payload, true)
    } else if (importMode.value === 'append') {
      await importBackup(remapIds(payload), false)
    } else {
      await importBackup(payload, false)
    }
    importVisible.value = false
    const modeText =
      importMode.value === 'overwrite' ? '覆盖导入' : importMode.value === 'append' ? '追加导入（已重新分配 id）' : '按 id 合并导入'
    ElMessage.success(`${modeText}完成：机组 ${payload.turbines.length} · 叶片 ${payload.blades.length} · 分段 ${payload.segments.length} · 缺陷 ${payload.defects.length} · 工单 ${payload.workOrders.length} · 报告版本 ${payload.reportVersions?.length ?? 0}`)
  } finally {
    importSubmitting.value = false
  }
}

/* ---------------- 本地数据维护 ---------------- */
const maintenanceWorking = ref(false)

async function handleClear(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '清空会删除本浏览器 IndexedDB 中的全部机组、叶片、分段、缺陷、工单与已出具报告版本，且不可恢复。确认清空？',
      '清空本地数据确认',
      { type: 'warning', confirmButtonText: '确认清空', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  maintenanceWorking.value = true
  try {
    await clearAllTables()
    ElMessage.success('本地数据已清空，可点击「重新播种演示数据」恢复样例')
  } finally {
    maintenanceWorking.value = false
  }
}

async function handleReseed(): Promise<void> {
  maintenanceWorking.value = true
  try {
    await clearAllTables()
    const seeded = await seedDemoData()
    if (seeded) ElMessage.success('已重新播种演示数据（2 台机组 × 各 2 片叶片 × 各 3 个分段）')
    else ElMessage.warning('播种未执行，请刷新页面重试')
  } finally {
    maintenanceWorking.value = false
  }
}

const bladePanels = computed(() => report.value?.blades ?? [])
const activePanels = ref<string[]>([])

watch(bladePanels, (panels) => {
  if (activePanels.value.length === 0 && panels.length > 0) {
    activePanels.value = panels.map((panel) => panel.blade.id)
  }
})
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>报告与导出</h2>
        <p>出具即冻结当时机组、叶片、分段、缺陷与工单并生成版本号；更正只能从最新版发起修订，旧版保留可对账。</p>
      </div>
      <div class="toolbar">
        <el-select v-model="selectedTurbineId" placeholder="选择机组" class="turbine-select">
          <el-option
            v-for="turbine in turbineStore.turbines"
            :key="turbine.id"
            :label="`${turbine.code}（${turbine.model}）`"
            :value="turbine.id"
          />
        </el-select>
        <el-button :icon="Document" @click="openStructure">查看导出结构</el-button>
        <el-button :icon="Download" @click="handleExportReport" :disabled="!report">
          {{ activeVersion ? '导出当前版本快照' : '导出本机组报告' }}
        </el-button>
        <el-button type="primary" :icon="Download" @click="handleExportBackup">导出全量备份</el-button>
        <el-upload
          :auto-upload="false"
          :show-file-list="false"
          accept=".json,application/json"
          :on-change="(file: UploadFile) => handleImportFile(file)"
        >
          <el-button :icon="Upload">导入 JSON</el-button>
        </el-upload>
      </div>
    </div>

    <EmptyPanel
      v-if="turbineStore.turbines.length === 0 && orphanGroups.length === 0"
      title="暂无可生成报告的机组"
      description="先建立机组台账，或直接播种演示数据后再出具巡检报告。"
      :show-seed="true"
      @seed="handleReseed"
    />

    <template v-else>
      <div class="section-card">
        <div class="section-card__head">
          <h3>本地数据与结构版本</h3>
          <div class="toolbar">
            <el-button :icon="Refresh" :loading="maintenanceWorking" @click="handleReseed">
              重新播种演示数据
            </el-button>
            <el-button type="danger" plain :icon="Delete" :loading="maintenanceWorking" @click="handleClear">
              清空本地数据
            </el-button>
          </div>
        </div>
        <el-descriptions :column="4" size="small" border>
          <el-descriptions-item label="IndexedDB 库名">{{ dbMeta.name }}</el-descriptions-item>
          <el-descriptions-item label="结构版本">v{{ dbMeta.version }}</el-descriptions-item>
          <el-descriptions-item label="本地标记版本">v{{ dbMeta.stampedVersion }}</el-descriptions-item>
          <el-descriptions-item label="上次备份">
            {{ dbMeta.lastBackupAt ? dbMeta.lastBackupAt.replace('T', ' ').slice(0, 19) : '尚未备份' }}
          </el-descriptions-item>
          <el-descriptions-item label="机组">{{ dbMeta.turbines }} 台</el-descriptions-item>
          <el-descriptions-item label="叶片">{{ dbMeta.blades }} 片</el-descriptions-item>
          <el-descriptions-item label="展向分段">{{ dbMeta.segments }} 段</el-descriptions-item>
          <el-descriptions-item label="缺陷 / 工单">
            {{ dbMeta.defects }} 条 / {{ dbMeta.workOrders }} 张
          </el-descriptions-item>
          <el-descriptions-item label="已出具报告版本">{{ dbMeta.reportVersions }} 个</el-descriptions-item>
        </el-descriptions>
      </div>

      <!-- 机组 / 叶片 / 工单已移走，但历史报告仍需可打开导出 -->
      <div v-if="orphanGroups.length > 0" class="section-card">
        <div class="section-card__head">
          <h3>已移出台账机组的历史报告</h3>
          <el-tag type="warning" effect="plain">快照随版本留存，不随删除消失</el-tag>
        </div>
        <el-table :data="orphanGroups" size="small" border>
          <el-table-column label="机组编号" prop="turbineCode" width="160">
            <template #default="{ row }">
              <span class="mono">{{ row.turbineCode }}</span>
              <el-tag size="small" type="info" effect="plain" class="orphan-tag">台账已无此机组</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="报告编号" width="220">
            <template #default="{ row }">
              <span class="mono">{{ row.latest.reportNo }}</span>
            </template>
          </el-table-column>
          <el-table-column label="最新版本" width="120">
            <template #default="{ row }">
              <el-tag size="small" :type="reportStatusTagType(row.latest.status)">
                V{{ row.latest.versionNo }} · {{ row.latest.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="历史版本数" prop="count" width="110" />
          <el-table-column label="操作" min-width="180">
            <template #default="{ row }">
              <el-button size="small" :icon="View" @click="viewVersion(row.latest.id)">打开最新版</el-button>
              <el-button size="small" :icon="Download" @click="exportReportJson(row.latest.snapshot)">
                导出
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <template v-if="selectedTurbineId">
        <div class="section-card">
          <div class="section-card__head">
            <h3>报告出具与修订</h3>
            <div class="toolbar">
              <el-tag v-if="latestVersion" type="success" effect="plain">
                最新版 {{ latestVersion.reportNo }} V{{ latestVersion.versionNo }}
              </el-tag>
              <el-button
                type="primary"
                :icon="Promotion"
                :disabled="turbineVersions.length > 0"
                @click="openIssue"
              >
                出具（冻结当前台账）
              </el-button>
              <el-button
                type="warning"
                plain
                :icon="EditPen"
                :disabled="!latestVersion"
                @click="openRevise"
              >
                从最新版发起修订
              </el-button>
            </div>
          </div>
          <el-alert
            v-if="turbineVersions.length === 0"
            type="info"
            :closable="false"
            show-icon
            title="该机组尚未出具报告：下方预览按当前台账实时计算，改缺陷或工单数字会跟着变，不能作为月底对账依据。"
            class="version-banner"
          />
          <el-table v-else :data="turbineVersions" size="small" border class="version-table">
            <el-table-column label="版本" width="130">
              <template #default="{ row }">
                <el-tag size="small" :type="reportStatusTagType(row.status)">
                  V{{ row.versionNo }} · {{ row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="报告编号" width="210">
              <template #default="{ row }"><span class="mono">{{ row.reportNo }}</span></template>
            </el-table-column>
            <el-table-column label="出具时间" width="180">
              <template #default="{ row }">{{ formatTimestamp(row.issuedAt) }}</template>
            </el-table-column>
            <el-table-column label="出具人" prop="issuedBy" width="110" />
            <el-table-column label="修订说明" min-width="220">
              <template #default="{ row }">
                <span v-if="row.revisionReason">{{ row.revisionReason }}</span>
                <span v-else class="muted">首版出具</span>
              </template>
            </el-table-column>
            <el-table-column label="替代关系" width="220">
              <template #default="{ row }">
                <template v-if="row.supersededByVersionId">
                  <el-tag
                    size="small"
                    type="info"
                    class="link-tag"
                    @click="viewVersion(row.supersededByVersionId!)"
                  >
                    已被 V{{ reportVersionStore.versionById(row.supersededByVersionId)?.versionNo }} 替代 →
                  </el-tag>
                </template>
                <template v-else-if="row.supersedesVersionId">
                  <el-tag
                    size="small"
                    type="warning"
                    effect="plain"
                    class="link-tag"
                    @click="viewVersion(row.supersedesVersionId!)"
                  >
                    ← 更正自 V{{ reportVersionStore.versionById(row.supersedesVersionId)?.versionNo }}
                  </el-tag>
                </template>
                <span v-else class="muted">首版</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="170">
              <template #default="{ row }">
                <el-button
                  size="small"
                  :icon="View"
                  :type="activeVersion?.id === row.id ? 'primary' : 'default'"
                  @click="viewVersion(row.id)"
                >
                  查看快照
                </el-button>
                <el-button size="small" :icon="Download" @click="exportReportJson(row.snapshot)">
                  导出
                </el-button>
              </template>
            </el-table-column>
            <template #empty>
              <span class="muted">尚无已出具版本</span>
            </template>
          </el-table>
        </div>
      </template>

      <template v-if="report">
        <!-- 口径提示：防止把快照错当当前台账，或把实时预览错当已出具报告 -->
        <el-alert
          v-if="activeVersion"
          :key="activeVersion.id"
          :type="activeVersionIsOrphan ? 'warning' : 'success'"
          :closable="false"
          show-icon
          class="version-banner"
        >
          <template #title>
            正在查看冻结快照 {{ activeVersion.reportNo }} V{{ activeVersion.versionNo }}
            （{{ activeVersion.status }}），出具于 {{ formatTimestamp(activeVersion.issuedAt) }}，
            出具人 {{ activeVersion.issuedBy }}。
            <span v-if="activeVersionIsOrphan">该机组已移出台账，以下为历史存档，仍可导出对账。</span>
            <span v-else>之后修改缺陷或工单不影响本版数字。</span>
            <el-button v-if="selectedTurbineId" link type="primary" @click="backToLive">
              返回当前台账预览
            </el-button>
          </template>
          <template #default>
            <span v-if="activeVersion.revisionReason">修订说明：{{ activeVersion.revisionReason }}</span>
          </template>
        </el-alert>
        <el-alert
          v-else
          type="warning"
          :closable="false"
          show-icon
          class="version-banner"
          :title="
            latestVersion
              ? `当前为台账实时预览，非正式版本；最新已出具为 ${latestVersion.reportNo} V${latestVersion.versionNo}，更正请点「从最新版发起修订」生成 V${latestVersion.versionNo + 1}。`
              : '当前为台账实时预览：数字随缺陷 / 工单编辑即时变化；点「出具」冻结为 V1 后才作为对账依据。'
          "
        />

        <div class="stat-row">
          <StatBadge label="叶片" :value="report.summary.bladeCount" suffix="片" tone="info" icon="Grid" />
          <StatBadge label="展向分段" :value="report.summary.segmentCount" suffix="段" tone="default" icon="Histogram" />
          <StatBadge label="缺陷总数" :value="report.summary.defectCount" suffix="条" tone="primary" icon="WarningFilled" />
          <StatBadge label="未闭环" :value="report.summary.openCount" suffix="条" tone="danger" icon="CircleCloseFilled" />
          <StatBadge
            label="重度占比"
            :value="report.summary.heavyPercent"
            :percent="report.summary.heavyPercent"
            suffix="%"
            tone="danger"
            icon="PieChart"
          />
          <StatBadge
            label="闭环率"
            :value="report.summary.closedPercent"
            :percent="report.summary.closedPercent"
            suffix="%"
            tone="success"
            icon="SuccessFilled"
          />
          <StatBadge label="损伤面积" :value="formatArea(report.summary.areaCm2)" tone="warning" icon="Odometer" />
          <StatBadge label="工单 / 超期" :value="`${report.summary.workOrderCount} / ${report.summary.overdueCount}`" tone="info" icon="Files" />
        </div>

        <div class="section-card">
          <div class="section-card__head">
            <h3>
              巡检报告{{ activeVersion ? '（冻结快照）' : '预览（当前台账）' }} · {{ report.turbine.code }}（{{ report.turbine.model }}）
            </h3>
            <span class="muted">
              风险分 {{ report.summary.riskScore }} ·
              {{ activeVersion ? '出具时间' : '生成时间' }}
              {{ report.generatedAt.replace('T', ' ').slice(0, 19) }}
            </span>
          </div>
          <el-descriptions :column="4" size="small" border class="report-meta">
            <el-descriptions-item label="轮毂高度">{{ report.turbine.hubHeightM }} m</el-descriptions-item>
            <el-descriptions-item label="投运日期">{{ report.turbine.commissionDate }}</el-descriptions-item>
            <el-descriptions-item label="登记叶片数">{{ report.turbine.bladeCount }} 片</el-descriptions-item>
            <el-descriptions-item label="结构版本">v{{ report.dbVersion }}</el-descriptions-item>
            <el-descriptions-item v-if="report.version" label="报告编号 / 版本">
              <span class="mono">{{ report.version.reportNo }} · V{{ report.version.versionNo }}</span>
            </el-descriptions-item>
            <el-descriptions-item v-else label="版本状态">
              <el-tag size="small" type="info" effect="plain">未出具（实时预览）</el-tag>
            </el-descriptions-item>
          </el-descriptions>

          <div class="dist-grid">
            <div class="dist-cell">
              <h4>严重程度分布</h4>
              <div v-for="row in report.severityDist" :key="row.label" class="dist-row">
                <span class="dist-row__label">{{ row.label }}</span>
                <el-progress :percentage="row.percent" :stroke-width="10" />
                <span class="dist-row__count mono">{{ row.count }} 条</span>
              </div>
            </div>
            <div class="dist-cell">
              <h4>缺陷类型分布</h4>
              <div v-for="row in report.typeDist" :key="row.label" class="dist-row">
                <span class="dist-row__label">{{ row.label }}</span>
                <el-progress :percentage="row.percent" :stroke-width="10" color="#0f5c7a" />
                <span class="dist-row__count mono">{{ row.count }} 条</span>
              </div>
            </div>
            <div class="dist-cell">
              <h4>处置状态分布</h4>
              <div v-for="row in report.stateDist" :key="row.label" class="dist-row">
                <span class="dist-row__label">{{ row.label }}</span>
                <el-progress :percentage="row.percent" :stroke-width="10" color="#1e8449" />
                <span class="dist-row__count mono">{{ row.count }} 条</span>
              </div>
            </div>
          </div>
        </div>

        <div class="section-card">
          <div class="section-card__head">
            <h3>叶片与展向分段明细</h3>
            <span class="muted">共 {{ bladePanels.length }} 片叶片</span>
          </div>
          <el-collapse v-model="activePanels">
            <el-collapse-item
              v-for="panel in bladePanels"
              :key="panel.blade.id"
              :name="panel.blade.id"
            >
              <template #title>
                <div class="panel-title">
                  <strong>叶片 {{ panel.blade.serial }}</strong>
                  <span class="muted">
                    {{ panel.blade.lengthM }} m · {{ panel.blade.material }} · {{ panel.segments.length }} 段
                  </span>
                  <el-tag size="small" type="warning">缺陷 {{ panel.defectCount }} 条</el-tag>
                  <el-tag size="small" type="danger" effect="plain">未闭环 {{ panel.openCount }} 条</el-tag>
                  <el-tag size="small" type="info" effect="plain">重度 {{ panel.heavyCount }} 条</el-tag>
                  <el-tag size="small" effect="plain">损伤 {{ formatArea(panel.areaCm2) }}</el-tag>
                </div>
              </template>
              <el-table :data="panel.segments" size="small" border>
                <el-table-column label="段序号" width="90">
                  <template #default="{ row }">第 {{ row.segment.index }} 段</template>
                </el-table-column>
                <el-table-column label="展向区间" width="150">
                  <template #default="{ row }">
                    <span class="mono">{{ formatRange(row.segment.startM, row.segment.endM) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="检修面" width="130">
                  <template #default="{ row }">{{ faceText(row.segment.face) }}</template>
                </el-table-column>
                <el-table-column label="翼型" prop="segment.airfoil" width="150" />
                <el-table-column label="剖面图" prop="segment.sectionImage" min-width="180">
                  <template #default="{ row }">
                    <span class="mono">{{ row.segment.sectionImage || '未上传' }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="缺陷 / 未闭环 / 重度" width="200">
                  <template #default="{ row }">
                    {{ row.defectCount }} / {{ row.openCount }} / {{ row.heavyCount }}
                  </template>
                </el-table-column>
                <el-table-column label="损伤面积" width="120">
                  <template #default="{ row }">{{ formatArea(row.areaCm2) }}</template>
                </el-table-column>
                <el-table-column type="expand" width="60">
                  <template #default="{ row }">
                    <el-table :data="row.defects" size="small" border class="defect-subtable">
                      <el-table-column label="类型" prop="type" width="110" />
                      <el-table-column label="程度" width="150">
                        <template #default="{ row: defect }">
                          <SeverityTag :severity="defect.severity" size="small" />
                        </template>
                      </el-table-column>
                      <el-table-column label="尺寸" width="180">
                        <template #default="{ row: defect }">
                          <span class="mono">{{ formatSize(defect.lengthMm, defect.widthMm) }}</span>
                        </template>
                      </el-table-column>
                      <el-table-column label="面位" prop="face" width="90" />
                      <el-table-column label="展向位置" width="110">
                        <template #default="{ row: defect }">{{ defect.positionM }} m</template>
                      </el-table-column>
                      <el-table-column label="发现日期" prop="foundAt" width="120" />
                      <el-table-column label="状态" width="100">
                        <template #default="{ row: defect }">
                          <span :style="{ color: stateColor(defect.state), fontWeight: 600 }">
                            {{ defect.state }}
                          </span>
                        </template>
                      </el-table-column>
                      <template #empty>
                        <span class="muted">该分段暂无缺陷</span>
                      </template>
                    </el-table>
                  </template>
                </el-table-column>
                <template #empty>
                  <span class="muted">该叶片尚未划分展向分段</span>
                </template>
              </el-table>
            </el-collapse-item>
          </el-collapse>
        </div>

        <div class="section-card">
          <div class="section-card__head">
            <h3>维修工单跟踪</h3>
            <span class="muted">共 {{ report.workOrders.length }} 张</span>
          </div>
          <el-table :data="report.workOrders" size="small" border>
            <el-table-column label="工单号" width="120">
              <template #default="{ row }">
                <span class="mono">#{{ row.order.id.slice(-6) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="定位" min-width="180">
              <template #default="{ row }">
                叶片 {{ row.bladeSerial }}｜第 {{ row.segmentIndex }} 段
              </template>
            </el-table-column>
            <el-table-column label="缺陷" min-width="150">
              <template #default="{ row }">{{ row.defectType }}（{{ row.severity }}）</template>
            </el-table-column>
            <el-table-column label="班组" prop="order.team" width="140" />
            <el-table-column label="限期" width="130">
              <template #default="{ row }">
                <span class="mono">{{ row.order.dueDate }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                {{ row.order.state }}
                <el-tag v-if="row.overdue" size="small" type="danger" effect="dark">超期</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="验收人" width="110">
              <template #default="{ row }">{{ row.order.acceptor || '—' }}</template>
            </el-table-column>
            <template #empty>
              <span class="muted">该机组暂无维修工单</span>
            </template>
          </el-table>
        </div>
      </template>
    </template>

    <!-- 出具对话框 -->
    <el-dialog v-model="issueVisible" title="出具巡检报告（冻结当前台账）" width="520px" destroy-on-close>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="出具瞬间会把机组 → 叶片 → 分段 → 缺陷 → 工单整条链复制为 V1 快照；之后再改缺陷或工单，本版数字不变。"
        class="import-alert"
      />
      <el-form label-width="80px">
        <el-form-item label="出具人" required>
          <el-input v-model="issueForm.issuedBy" placeholder="如：值班员张三" maxlength="20" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="issueVisible = false">取消</el-button>
        <el-button type="primary" :loading="issueSubmitting" @click="submitIssue">确认出具 V1</el-button>
      </template>
    </el-dialog>

    <!-- 修订对话框 -->
    <el-dialog v-model="reviseVisible" title="从最新版发起修订" width="560px" destroy-on-close>
      <el-alert
        v-if="latestVersion"
        type="warning"
        :closable="false"
        show-icon
        :title="`将按当前台账重新冻结，生成 ${latestVersion.reportNo} V${latestVersion.versionNo + 1}；V${latestVersion.versionNo} 原样保留并标记为「已替代」。`"
        class="import-alert"
      />
      <el-form label-width="80px">
        <el-form-item label="出具人" required>
          <el-input v-model="reviseForm.issuedBy" placeholder="如：值班员张三" maxlength="20" />
        </el-form-item>
        <el-form-item label="修订说明" required>
          <el-input
            v-model="reviseForm.revisionReason"
            type="textarea"
            :rows="3"
            placeholder="说明更正原因，如：缺陷等级现场复核由中度改重度、工单班组调整"
            maxlength="200"
            show-word-limit
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reviseVisible = false">取消</el-button>
        <el-button type="warning" :loading="reviseSubmitting" @click="submitRevise">
          确认修订为 V{{ (latestVersion?.versionNo ?? 1) + 1 }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="structureVisible" title="导出结构预览（纯文本）" width="860px">
      <pre class="structure-preview">{{ structureText }}</pre>
      <template #footer>
        <el-button @click="structureVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importVisible" title="导入本地数据" width="640px" destroy-on-close>
      <template v-if="importPayload">
        <el-alert
          type="success"
          :closable="false"
          show-icon
          :title="`文件 ${importFile} 校验通过，请选择导入方式。`"
          class="import-alert"
        />
        <el-descriptions v-if="importCounts" :column="3" size="small" border class="import-meta">
          <el-descriptions-item label="机组">{{ importCounts.turbines }}</el-descriptions-item>
          <el-descriptions-item label="叶片">{{ importCounts.blades }}</el-descriptions-item>
          <el-descriptions-item label="分段">{{ importCounts.segments }}</el-descriptions-item>
          <el-descriptions-item label="缺陷">{{ importCounts.defects }}</el-descriptions-item>
          <el-descriptions-item label="工单">{{ importCounts.workOrders }}</el-descriptions-item>
          <el-descriptions-item label="报告版本">{{ importCounts.reportVersions ?? 0 }}</el-descriptions-item>
          <el-descriptions-item label="文件版本">v{{ importPayload.dbVersion }}</el-descriptions-item>
        </el-descriptions>
        <el-radio-group v-model="importMode" class="import-mode">
          <el-radio value="overwrite">覆盖导入（先清空本地全部数据，含已出具报告版本）</el-radio>
          <el-radio value="merge">按 id 合并（同 id 覆盖）</el-radio>
          <el-radio value="append">追加导入（重新分配 id，不覆盖现有记录）</el-radio>
        </el-radio-group>
      </template>
      <template v-else>
        <el-alert
          type="error"
          :closable="false"
          show-icon
          title="文件校验未通过，未执行任何写入。"
          class="import-alert"
        />
        <ul class="import-errors">
          <li v-for="error in importErrors" :key="error">{{ error }}</li>
        </ul>
      </template>
      <template #footer>
        <el-button @click="importVisible = false">关闭</el-button>
        <el-button
          v-if="importPayload"
          type="primary"
          :loading="importSubmitting"
          @click="submitImport"
        >
          确认导入
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.turbine-select {
  width: 240px;
}

.version-banner {
  margin-bottom: 14px;
}

.version-table {
  margin-top: 12px;
}

.link-tag {
  cursor: pointer;
}

.orphan-tag {
  margin-left: 8px;
}

.report-meta {
  margin-bottom: 14px;
}

.dist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.dist-cell h4 {
  margin: 0 0 8px;
  font-size: 14px;
}

.dist-row {
  display: grid;
  grid-template-columns: 76px 1fr 70px;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 13px;
}

.dist-row__count {
  text-align: right;
  color: #4a5b63;
}

.panel-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.defect-subtable {
  margin: 8px 12px;
}

.structure-preview {
  max-height: 520px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  background: #f5f9fb;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.import-alert {
  margin-bottom: 12px;
}

.import-meta {
  margin-bottom: 12px;
}

.import-mode {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.import-errors {
  margin: 8px 0 0;
  padding-left: 20px;
  color: #c0392b;
  font-size: 13px;
}
</style>
