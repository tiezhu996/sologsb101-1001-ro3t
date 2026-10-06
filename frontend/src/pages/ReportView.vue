<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
import { Delete, Document, Download, EditPen, Refresh, Stamp, Upload, View } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import ReportDetail from '@/components/common/ReportDetail.vue'
import { useTurbineStore } from '@/stores/turbineStore'
import { useReportStore } from '@/stores/reportStore'
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
  validateBackup,
  type PayloadCounts
} from '@/utils/export'
import {
  buildTurbineReport,
  reportFromSnapshot,
  reportToText,
  reportFileName,
  versionInfoOf,
  type TurbineReport
} from '@/utils/report'
import { REPORT_VERSION_STATUS_LABEL, type ReportVersion } from '@/types/reportVersion'
import type { BackupPayload } from '@/utils/db'

const turbineStore = useTurbineStore()
const reportStore = useReportStore()

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
})

/* ---------------- 实时台账草稿（未出具） ---------------- */

/** 草稿始终按当前台账实时计算，仅用于出具前预览，不会被保存 */
const draftReport = computed<TurbineReport | null>(() => {
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

/* ---------------- 已出具版本 ---------------- */

const selectedVersionId = ref<string>('')
const viewMode = ref<'draft' | 'version'>('draft')

/**
 * 工作区当前聚焦的机组 id：草稿模式等于选中机组；
 * 版本模式可能指向已从台账移走的机组（此时 selectedTurbine 为 null，但版本凭快照可看）
 */
const activeTurbineId = ref<string>(selectedTurbineId.value)

const selectedTurbine = computed(() => turbineStore.turbineById(selectedTurbineId.value) ?? null)
const turbineVersions = computed<ReportVersion[]>(() =>
  activeTurbineId.value ? reportStore.versionsOfTurbine(activeTurbineId.value) : []
)
const currentVersion = computed<ReportVersion | undefined>(() =>
  activeTurbineId.value ? reportStore.currentVersionOfTurbine(activeTurbineId.value) : undefined
)

/** 台账中已删除机组、但仍留有冻结报告的版本（旧报告仍能打开导出） */
const orphanVersions = computed<ReportVersion[]>(() =>
  reportStore.orphanVersions(new Set(turbineStore.turbines.map((turbine) => turbine.id)))
)

/** 版本台账：聚焦机组优先置顶，其后列出全库其他机组（含已移走机组的孤儿版本） */
const ledgerVersions = computed<ReportVersion[]>(() => {
  const focused = activeTurbineId.value
  const others = reportStore.versions.filter((version) => version.turbineId !== focused)
  return [...turbineVersions.value, ...others]
})

/** 当前正在查看的冻结版本（只读快照重建，绝不读实时台账） */
const activeVersion = computed<ReportVersion | undefined>(() =>
  selectedVersionId.value ? reportStore.versionById(selectedVersionId.value) : undefined
)

/** 页面正文实际展示的报告：版本模式取冻结快照，草稿模式取当前台账 */
const activeReport = computed<TurbineReport | null>(() => {
  if (viewMode.value === 'version') {
    const version = activeVersion.value
    if (!version) return null
    return reportFromSnapshot(version.snapshot, DB_VERSION, versionInfoOf(version))
  }
  return draftReport.value
})

/**
 * 机组选择器切换（只可能选到台账中存在的机组）：
 * 有已出具版本默认落到当前版本，否则回草稿。
 */
watch(
  selectedTurbineId,
  (turbineId) => {
    activeTurbineId.value = turbineId
    const list = turbineId ? reportStore.versionsOfTurbine(turbineId) : []
    if (list.length > 0) {
      selectedVersionId.value = reportStore.currentVersionOfTurbine(turbineId)?.id ?? list[list.length - 1].id
      viewMode.value = 'version'
    } else {
      selectedVersionId.value = ''
      viewMode.value = 'draft'
    }
  },
  { immediate: true }
)

/** 数据变化后聚焦机组的版本列表若整体消失（如清空数据），退回草稿 */
watch(turbineVersions, (list) => {
  if (viewMode.value === 'version' && list.length === 0 && activeTurbineId.value && turbineStore.turbineById(activeTurbineId.value)) {
    selectedVersionId.value = ''
    viewMode.value = 'draft'
  }
})

function viewVersion(version: ReportVersion): void {
  // 允许打开已移走机组的版本：只移动聚焦 id，不污染机组选择器
  activeTurbineId.value = version.turbineId
  selectedVersionId.value = version.id
  viewMode.value = 'version'
}

function switchVersion(id: string): void {
  selectedVersionId.value = id
  viewMode.value = 'version'
}

function onModeChange(value: string | number | boolean | undefined): void {
  if (value === 'version') {
    if (activeVersion.value) return
    if (currentVersion.value) switchVersion(currentVersion.value.id)
  } else {
    // 回草稿：聚焦回到选择器中真实存在的机组
    activeTurbineId.value = selectedTurbineId.value
    selectedVersionId.value = ''
  }
}

/** 机组已被移走的版本，选择器里按机组编号兜底显示 */
function turbineOptionLabel(version: ReportVersion): string {
  const turbine = turbineStore.turbineById(version.turbineId)
  return turbine ? `${turbine.code}（${turbine.model}）` : `${version.turbineCode}（机组已移走）`
}

/* ---------------- 出具 / 修订 ---------------- */

const issueVisible = ref(false)
const issueSubmitting = ref(false)
/** revise 为修订（从选中版本发起），issue 为首次出具（V1） */
const issueMode = ref<'issue' | 'revise'>('issue')
const issueBaseVersionId = ref<string>('')
const issueIssuedBy = ref('')
const issueNote = ref('')

const issueDialogTitle = computed(() => (issueMode.value === 'revise' ? '发起修订（生成下一版本）' : '出具巡检报告（冻结 V1）'))
const issueNoteLabel = computed(() => (issueMode.value === 'revise' ? '更正说明（必填）' : '出具说明'))
const issueConfirmText = computed(() => (issueMode.value === 'revise' ? '出具修订版' : '冻结并出具'))

function openIssue(): void {
  if (!selectedTurbine.value) {
    ElMessage.warning('请先选择机组')
    return
  }
  issueMode.value = 'issue'
  issueBaseVersionId.value = ''
  issueIssuedBy.value = ''
  issueNote.value = ''
  issueVisible.value = true
}

function openRevise(version?: ReportVersion): void {
  const base = version ?? currentVersion.value
  if (!base) {
    ElMessage.warning('该机组还没有已出具的版本，请先出具 V1')
    return
  }
  if (base.status !== 'current') {
    ElMessage.warning('只能从最新版本发起修订')
    return
  }
  if (!turbineStore.turbineById(base.turbineId)) {
    ElMessageBox.alert(
      '该报告所属机组已从当前台账移走，无法按当前台账生成修订版；历史版本仍可打开与导出。',
      '无法修订',
      { type: 'warning', confirmButtonText: '知道了' }
    )
    return
  }
  issueMode.value = 'revise'
  issueBaseVersionId.value = base.id
  issueIssuedBy.value = ''
  issueNote.value = ''
  issueVisible.value = true
}

async function submitIssue(): Promise<void> {
  if (!selectedTurbine.value) return
  if (issueMode.value === 'revise' && issueNote.value.trim().length === 0) {
    ElMessage.warning('请填写更正说明，说明本版相对原版改了什么')
    return
  }
  issueSubmitting.value = true
  try {
    const payload = { issuedBy: issueIssuedBy.value, revisionNote: issueNote.value }
    if (issueMode.value === 'revise') {
      const result = await reportStore.reviseReport(issueBaseVersionId.value, payload)
      ElMessage.success(`已出具修订版 V${result.version.versionNo}，原版本保留并标记为「已被替代」`)
      afterIssued(result.version)
    } else {
      const result = await reportStore.issueReport(selectedTurbine.value.id, payload)
      ElMessage.success(`已冻结出具 V${result.version.versionNo}，此后台账变动不影响本版`)
      afterIssued(result.version)
    }
    issueVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '出具失败，请重试')
  } finally {
    issueSubmitting.value = false
  }
}

function afterIssued(version: ReportVersion): void {
  selectedTurbineId.value = version.turbineId
  selectedVersionId.value = version.id
  viewMode.value = 'version'
}

/* ---------------- 本地数据元信息 ---------------- */

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
  reportVersions: reportStore.versions.length
}))

const structureVisible = ref(false)
const structureText = computed(() =>
  activeReport.value ? reportToText(activeReport.value) : '请先选择机组或报告版本'
)

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
  const current = activeReport.value
  if (!current) {
    ElMessage.warning('请先选择机组或报告版本')
    return
  }
  // 导出的就是当前所见：版本模式导冻结快照，草稿模式导当前台账（文件名带 draft，不可冒充已出具版）
  const fileName = exportReportJson(current)
  ElMessage.success(
    current.versionInfo
      ? `已导出 ${current.turbine.code} V${current.versionInfo.versionNo} 冻结报告 ${fileName}`
      : `已导出当前台账草稿 ${fileName}（未经出具冻结）`
  )
}

/* ---------------- 导入 ---------------- */
const importVisible = ref(false)
const importSubmitting = ref(false)
const importFile = ref('')
const importMode = ref<'overwrite' | 'merge' | 'append'>('merge')
const importErrors = ref<string[]>([])
const importPayload = ref<BackupPayload | null>(null)
const importCounts = ref<PayloadCounts | null>(null)

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
      '清空会删除本浏览器 IndexedDB 中的全部机组、叶片、分段、缺陷、工单以及已出具报告版本（含冻结快照），且不可恢复。确认清空？',
      '清空本地数据确认',
      { type: 'warning', confirmButtonText: '确认清空', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  maintenanceWorking.value = true
  try {
    await clearAllTables()
    selectedVersionId.value = ''
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
    if (seeded) {
      selectedVersionId.value = ''
      viewMode.value = 'draft'
      ElMessage.success('已重新播种演示数据（含 WT-A01 的 V1→V2 报告修订链样例）')
    } else {
      ElMessage.warning('播种未执行，请刷新页面重试')
    }
  } finally {
    maintenanceWorking.value = false
  }
}

function formatTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16)
}

function statusTagType(status: ReportVersion['status']): 'success' | 'info' {
  return status === 'current' ? 'success' : 'info'
}

/** 状态中文文案（模板插槽 row 无类型，统一走函数） */
function statusLabel(status: ReportVersion['status']): string {
  return REPORT_VERSION_STATUS_LABEL[status]
}

/** 版本下拉选项文案：V2（当前版本）· 2026-10-06 14:30 */
function versionOptionLabel(version: ReportVersion): string {
  return `V${version.versionNo}（${REPORT_VERSION_STATUS_LABEL[version.status]}）· ${formatTime(version.frozenAt)}`
}

/** 行内「查看 / 修订 / 导出」所用的单版导出 */
function handleExportVersion(version: ReportVersion): void {
  const report = reportFromSnapshot(version.snapshot, DB_VERSION, versionInfoOf(version))
  const fileName = exportReportJson(report)
  ElMessage.success(`已导出 ${version.turbineCode} V${version.versionNo} 冻结报告 ${fileName}`)
}

const downloadFileName = computed(() => (activeReport.value ? reportFileName(activeReport.value) : ''))
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>报告与导出</h2>
        <p>出具即冻结当前机组「叶片 → 分段 → 缺陷 → 工单」全链快照；更正只能从最新版本修订，原版保留并标记替代关系。</p>
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
        <el-button :icon="Download" @click="handleExportReport" :disabled="!activeReport">
          导出{{ viewMode === 'version' ? '冻结报告' : '当前草稿' }}
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
      v-if="turbineStore.turbines.length === 0 && reportStore.versions.length === 0"
      title="暂无可生成报告的机组"
      description="先建立机组台账，或直接播种演示数据后再生成巡检报告。"
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
          <el-descriptions-item label="已出具报告版本">{{ dbMeta.reportVersions }} 版</el-descriptions-item>
        </el-descriptions>
      </div>

      <!-- 版本台账：全部已出具版本，含机组已移走的孤儿版本 -->
      <div class="section-card">
        <div class="section-card__head">
          <h3>报告版本台账</h3>
          <span class="muted">共 {{ ledgerVersions.length }} 版；已出具版本只读快照，台账后改不回写旧版</span>
        </div>
        <el-table :data="ledgerVersions" size="small" border>
          <el-table-column label="机组" min-width="180">
            <template #default="{ row }">
              <span>{{ turbineOptionLabel(row) }}</span>
              <el-tag v-if="!turbineStore.turbineById(row.turbineId)" size="small" type="warning" effect="plain" class="orphan-tag">
                机组已移走
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="版本" width="80">
            <template #default="{ row }">
              <el-button link type="primary" @click="viewVersion(row)">V{{ row.versionNo }}</el-button>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="statusTagType(row.status)">
                {{ statusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="替代关系" width="150">
            <template #default="{ row }">
              <span v-if="row.baseVersionId" class="muted">修订自 V{{ row.versionNo - 1 }}</span>
              <span v-else class="muted">首次出具</span>
            </template>
          </el-table-column>
          <el-table-column prop="issuedBy" label="出具人" width="130" />
          <el-table-column label="出具时间" width="150">
            <template #default="{ row }">
              <span class="mono">{{ formatTime(row.frozenAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="revisionNote" label="说明" min-width="220" show-overflow-tooltip />
          <el-table-column label="操作" width="220" fixed="right">
            <template #default="{ row }">
              <el-button size="small" :icon="View" @click="viewVersion(row)">打开</el-button>
              <el-button
                size="small"
                :icon="EditPen"
                :disabled="row.status !== 'current' || !turbineStore.turbineById(row.turbineId)"
                @click="openRevise(row)"
              >
                修订
              </el-button>
              <el-button size="small" :icon="Download" @click="handleExportVersion(row)">导出</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <span class="muted">尚无已出具报告；在下方预览当前台账后点击「出具冻结」生成 V1。</span>
          </template>
        </el-table>
      </div>

      <!-- 工作区：草稿 / 已出具版本切换 + 出具动作 -->
      <div class="section-card">
        <div class="issue-bar">
          <el-radio-group v-model="viewMode" @change="onModeChange">
            <el-radio-button value="draft">当前台账草稿（未出具）</el-radio-button>
            <el-radio-button value="version" :disabled="turbineVersions.length === 0">
              已出具版本（只读快照）{{ turbineVersions.length > 0 ? `· ${turbineVersions.length} 版` : '' }}
            </el-radio-button>
          </el-radio-group>
          <el-select
            v-if="viewMode === 'version'"
            :model-value="selectedVersionId"
            class="version-select"
            placeholder="选择版本"
            @update:model-value="switchVersion"
          >
            <el-option
              v-for="version in [...turbineVersions].reverse()"
              :key="version.id"
              :label="versionOptionLabel(version)"
              :value="version.id"
            />
          </el-select>
          <div class="issue-bar__actions">
            <template v-if="viewMode === 'draft'">
              <el-button
                type="primary"
                :icon="Stamp"
                :disabled="!draftReport || !!currentVersion"
                @click="openIssue"
              >
                {{ currentVersion ? '已出具，请在版本页修订' : '出具冻结（V1）' }}
              </el-button>
              <el-button v-if="currentVersion" type="warning" plain :icon="EditPen" @click="openRevise()">
                从 V{{ currentVersion.versionNo }} 发起修订
              </el-button>
            </template>
            <template v-else>
              <el-button
                type="warning"
                :icon="EditPen"
                :disabled="!activeVersion || activeVersion.status !== 'current' || !selectedTurbine"
                @click="openRevise(activeVersion)"
              >
                修订此版
              </el-button>
              <el-button v-if="activeVersion && activeVersion.versionNo > 1" text @click="activeVersion.baseVersionId && switchVersion(activeVersion.baseVersionId)">
                查看上一版 →
              </el-button>
            </template>
          </div>
        </div>

        <!-- 关键提示：当前所见数据来自哪里 -->
        <el-alert
          v-if="viewMode === 'version' && activeVersion"
          class="source-alert"
          :type="activeVersion.status === 'current' ? 'success' : 'info'"
          :closable="false"
          show-icon
        >
          <template #title>
            正在查看 <strong>{{ activeVersion.turbineCode }} V{{ activeVersion.versionNo }}</strong>
            （{{ REPORT_VERSION_STATUS_LABEL[activeVersion.status] }}）冻结于 {{ formatTime(activeVersion.frozenAt) }}，
            出具人 {{ activeVersion.issuedBy || '—' }}。本页数字全部来自该版快照，与当前台账无关。
          </template>
          <div class="source-alert__note">
            {{ activeVersion.revisionNote || '（无说明）' }}
            <template v-if="activeVersion.supersededById">
              ；本版已被
              <el-button link type="primary" @click="switchVersion(activeVersion.supersededById as string)">新版本</el-button>
              替代，仅供历史对账
            </template>
            <template v-else-if="activeVersion.baseVersionId">
              ；修订自
              <el-button link type="primary" @click="switchVersion(activeVersion.baseVersionId as string)">上一版</el-button>
            </template>
          </div>
        </el-alert>
        <el-alert
          v-else-if="viewMode === 'draft' && draftReport"
          class="source-alert"
          type="warning"
          :closable="false"
          show-icon
          :title="currentVersion
            ? `当前为实时台账草稿：台账改动会即时反映在此；已出具到 V${currentVersion.versionNo}，更正请「发起修订」，旧版不会被改动。`
            : '当前为实时台账草稿：缺陷、工单一改数字就会变；点击「出具冻结」生成 V1 后，已出具版本不再随台账变化。'"
        />

        <ReportDetail v-if="activeReport" :key="`${viewMode}-${activeReport.versionInfo?.versionId ?? 'draft'}-${activeTurbineId}`" :report="activeReport" />
        <EmptyPanel
          v-else-if="viewMode === 'version'"
          title="该机组暂无已出具版本"
          description="切回「当前台账草稿」后点击「出具冻结」生成首版。"
          compact
        />
        <EmptyPanel
          v-else
          title="请选择机组"
          description="选择一台机组后即可按当前台账预览草稿并出具。"
          compact
        />
      </div>

      <el-alert
        v-if="orphanVersions.length > 0"
        class="orphan-alert"
        type="info"
        :closable="false"
        show-icon
        :title="`有 ${orphanVersions.length} 版报告所属机组已从当前台账移走，仍可在上方版本台账打开、导出（数据取自各自冻结快照）。`"
      />
    </template>

    <!-- 出具 / 修订对话框 -->
    <el-dialog v-model="issueVisible" :title="issueDialogTitle" width="560px" destroy-on-close>
      <el-alert
        class="issue-alert"
        type="info"
        :closable="false"
        show-icon
        :title="issueMode === 'revise'
          ? '将按当前台账重新冻结生成下一版本；原版本保留不变并标记为「已被替代」。'
          : '将按当前台账冻结机组的叶片、分段、缺陷与工单快照并生成 V1；此后台账再改，本版数字不变。'"
      />
      <el-form label-position="top">
        <el-form-item label="出具人 / 班组">
          <el-input v-model="issueIssuedBy" placeholder="如：巡检班·周一组" maxlength="30" />
        </el-form-item>
        <el-form-item :label="issueNoteLabel">
          <el-input
            v-model="issueNote"
            type="textarea"
            :rows="3"
            :placeholder="issueMode === 'revise' ? '必填：更正了哪些缺陷 / 工单，为什么修订'
              : '可选：本月巡检范围、天气、班组等备注'"
            maxlength="300"
            show-word-limit
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="issueVisible = false">取消</el-button>
        <el-button type="primary" :loading="issueSubmitting" @click="submitIssue">
          {{ issueConfirmText }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="structureVisible" title="导出结构预览（纯文本）" width="860px">
      <pre class="structure-preview">{{ structureText }}</pre>
      <template #footer>
        <el-button @click="structureVisible = false">关闭</el-button>
        <el-button type="primary" :icon="Download" :disabled="!activeReport" @click="handleExportReport">
          导出 {{ downloadFileName }}
        </el-button>
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
          <el-descriptions-item label="报告版本">{{ importCounts.reportVersions }}</el-descriptions-item>
          <el-descriptions-item label="文件版本">v{{ importPayload.dbVersion }}</el-descriptions-item>
        </el-descriptions>
        <el-radio-group v-model="importMode" class="import-mode">
          <el-radio value="overwrite">覆盖导入（先清空本地全部数据，含已出具版本）</el-radio>
          <el-radio value="merge">按 id 合并（同 id 覆盖，含报告版本）</el-radio>
          <el-radio value="append">追加导入（重新分配 id，不覆盖现有记录，报告版本链一并重建）</el-radio>
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

.issue-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.issue-bar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.version-select {
  width: 320px;
}

.source-alert {
  margin-bottom: 14px;
}

.source-alert__note {
  margin-top: 4px;
  font-size: 12px;
  color: #4a5b63;
}

.orphan-tag {
  margin-left: 6px;
}

.orphan-alert {
  margin-top: 14px;
}

.issue-alert {
  margin-bottom: 14px;
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
