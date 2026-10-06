<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import SeverityTag from '@/components/common/SeverityTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import type { TurbineReport } from '@/utils/report'
import { formatArea, formatSize } from '@/utils/severity'
import { FACE_LABEL, formatRange, type SegmentFace } from '@/types/segment'
import { DEFECT_STATE_COLOR, type DefectState } from '@/types/defect'

const props = defineProps<{ report: TurbineReport }>()

/** 面位中文标签（模板内免去类型断言） */
function faceText(face: string): string {
  return FACE_LABEL[face as SegmentFace] ?? face
}

/** 缺陷状态配色（模板内免去类型断言） */
function stateColor(state: string): string {
  return DEFECT_STATE_COLOR[state as DefectState] ?? '#4a5b63'
}

const bladePanels = computed(() => props.report.blades)
const activePanels = ref<string[]>([])

// 切换版本 / 机组后重新默认展开全部叶片
watch(
  bladePanels,
  (panels) => {
    activePanels.value = panels.map((panel) => panel.blade.id)
  },
  { immediate: true }
)
</script>

<template>
  <div>
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
          巡检报告 · {{ report.turbine.code }}（{{ report.turbine.model }}）
        </h3>
        <span class="muted">
          风险分 {{ report.summary.riskScore }} ·
          {{ report.versionInfo ? `出具时间 ${report.versionInfo.frozenAt.replace('T', ' ').slice(0, 19)}` : `生成时间 ${report.generatedAt.replace('T', ' ').slice(0, 19)}` }}
        </span>
      </div>
      <el-descriptions :column="4" size="small" border class="report-meta">
        <el-descriptions-item label="轮毂高度">{{ report.turbine.hubHeightM }} m</el-descriptions-item>
        <el-descriptions-item label="投运日期">{{ report.turbine.commissionDate }}</el-descriptions-item>
        <el-descriptions-item label="登记叶片数">{{ report.turbine.bladeCount }} 片</el-descriptions-item>
        <el-descriptions-item label="结构版本">v{{ report.dbVersion }}</el-descriptions-item>
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
      <EmptyPanel
        v-if="bladePanels.length === 0"
        title="该机组尚未登记叶片"
        description="到机组合账编辑机组补足叶片数，或在叶片分段页生成展向分段。"
        compact
      />
      <el-collapse v-else v-model="activePanels">
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
  </div>
</template>

<style scoped>
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
</style>
