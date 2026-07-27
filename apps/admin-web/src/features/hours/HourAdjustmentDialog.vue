<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import hoursApi from '../../api/hours';
import { ApiError } from '../../api/http';

/**
 * Manual lesson-hour adjustment dialog (Task 10).
 *
 * Two modes:
 *   - GRANT: posts a MANUAL_GRANT — needs units/startsOn/expiresOn/reason.
 *   - DEBIT: posts a MANUAL_DEBIT — needs units/reason (draws via FEFO).
 *
 * `units` is a decimal string end-to-end (never coerced to a JS number — the
 * ledger stores DECIMAL(10,2) and the wire contract is a 2-dp string). A
 * nonblank `reason` is required for both modes (auditable adjustment). On
 * success the parent is notified via `submitted` so it can refresh the ledger.
 */
type Mode = 'GRANT' | 'DEBIT';

interface AdjustmentForm {
  /** Decimal string, e.g. `"1.50"`. Preserved verbatim — never parsed to number. */
  units: string;
  /** `YYYY-MM-DD` Shanghai business date. GRANT-only. */
  startsOn: string;
  /** `YYYY-MM-DD` Shanghai business date. GRANT-only. */
  expiresOn: string;
  /** Nonblank admin reason (audited on the HourTransaction row). */
  reason: string;
}

const props = defineProps<{
  studentId: string;
  courseId: string;
}>();
const emit = defineEmits<{
  (e: 'submitted'): void;
}>();

const mode = ref<Mode>('GRANT');
const submitting = ref(false);

const form = reactive<AdjustmentForm>({
  units: '',
  startsOn: '',
  expiresOn: '',
  reason: '',
});

const isGrant = computed(() => mode.value === 'GRANT');

/** Validates the decimal shape without converting to a JS number. */
function isDecimalString(value: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(value);
}

function setMode(next: Mode): void {
  mode.value = next;
}

function reset(): void {
  form.units = '';
  form.startsOn = '';
  form.expiresOn = '';
  form.reason = '';
}

async function onSubmit(): Promise<void> {
  // Validate early and explicitly (Element Plus async-validator is unreliable
  // for required/custom rules under jsdom). units must be a positive decimal
  // string; reason must be nonblank.
  const units = form.units.trim();
  const reason = form.reason.trim();
  if (!units || !isDecimalString(units) || Number(units) <= 0) {
    ElMessage.warning('请输入有效的课时数（最多两位小数）');
    return;
  }
  if (!reason) {
    ElMessage.warning('请填写调整原因');
    return;
  }
  if (isGrant.value) {
    if (!form.startsOn || !form.expiresOn) {
      ElMessage.warning('请选择有效期起止日期');
      return;
    }
  }

  submitting.value = true;
  try {
    if (isGrant.value) {
      await hoursApi.grantHours(props.studentId, props.courseId, {
        units, // string preserved verbatim
        startsOn: form.startsOn,
        expiresOn: form.expiresOn,
        reason,
      });
      ElMessage.success('已发放课时');
    } else {
      await hoursApi.debitHours(props.studentId, props.courseId, {
        units,
        reason,
      });
      ElMessage.success('已扣减课时');
    }
    reset();
    emit('submitted');
  } catch (err) {
    if (err instanceof ApiError && err.code === 'INSUFFICIENT_HOURS') {
      ElMessage.error('可用课时不足，无法扣减');
    } else {
      const trace = err instanceof ApiError ? `（追踪号：${err.traceId}）` : '';
      ElMessage.error(`调整课时失败${trace}`);
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="hour-adjustment" data-testid="hour-adjustment">
    <div class="hour-adjustment-modes">
      <el-button
        size="small"
        :type="isGrant ? 'primary' : 'default'"
        data-testid="mode-grant"
        @click="setMode('GRANT')"
      >
        手动发放
      </el-button>
      <el-button
        size="small"
        :type="!isGrant ? 'primary' : 'default'"
        data-testid="mode-debit"
        @click="setMode('DEBIT')"
      >
        手动扣减
      </el-button>
    </div>

    <form @submit.prevent="onSubmit">
      <div class="hour-adjustment-field">
        <label>课时数</label>
        <input
          v-model="form.units"
          name="units"
          placeholder="如：1.50"
          data-testid="units-input"
        />
      </div>
      <template v-if="isGrant">
        <div class="hour-adjustment-field">
          <label>生效日期</label>
          <input v-model="form.startsOn" name="startsOn" type="date" />
        </div>
        <div class="hour-adjustment-field">
          <label>到期日期</label>
          <input v-model="form.expiresOn" name="expiresOn" type="date" />
        </div>
      </template>
      <div class="hour-adjustment-field">
        <label>调整原因（必填）</label>
        <input
          v-model="form.reason"
          name="reason"
          placeholder="如：补课、请假扣减"
          data-testid="reason-input"
        />
      </div>
      <el-button
        type="primary"
        native-type="submit"
        :loading="submitting"
        data-testid="hour-submit"
        @click="onSubmit"
      >
        提交
      </el-button>
    </form>
  </div>
</template>

<style scoped>
.hour-adjustment {
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 12px;
  background: #fff;
}
.hour-adjustment-modes {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.hour-adjustment-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.hour-adjustment-field label {
  width: 120px;
  font-size: 13px;
  color: #606266;
}
.hour-adjustment-field input {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  font-size: 13px;
}
</style>
