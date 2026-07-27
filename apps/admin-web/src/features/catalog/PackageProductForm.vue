<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules, FormItemRule } from 'element-plus';
import type {
  PackageProductView,
  CreatePackageProductRequest,
} from '@member-course/contracts';

interface PackageFormModel {
  name: string;
  /** Decimal string on the wire — kept as a string, never parsed to number. */
  price: string;
  /** Decimal string on the wire. */
  hours: string;
  validDays: number | string;
}

const props = defineProps<{ package?: PackageProductView | null }>();
const emit = defineEmits<{
  (e: 'submit', payload: CreatePackageProductRequest): void;
}>();

const formRef = ref<FormInstance>();
const form = reactive<PackageFormModel>({
  name: '',
  price: '',
  hours: '',
  validDays: '',
});

// Hydrate from an existing package (edit mode) preserving decimal strings.
watch(
  () => props.package,
  (pkg) => {
    if (pkg) {
      form.name = pkg.name;
      form.price = pkg.price;
      form.hours = pkg.hours;
      form.validDays = pkg.validDays;
    }
  },
  { immediate: true },
);

/** Decimal-string validator: optional digits with up to 2 fractional digits. */
const decimalRule: FormItemRule = {
  validator: (_rule, value: string, callback) => {
    if (value === '' || value === null || value === undefined) {
      return callback(new Error('请输入金额'));
    }
    if (!/^\d+(\.\d{1,2})?$/.test(String(value))) {
      return callback(new Error('最多两位小数'));
    }
    callback();
  },
  trigger: 'blur',
};

/** Strictly-positive decimal validator (for hours). */
const positiveDecimalRule: FormItemRule = {
  validator: (_rule, value: string, callback) => {
    if (value === '' || value === null || value === undefined) {
      return callback(new Error('请输入课时'));
    }
    if (!/^\d+(\.\d{1,2})?$/.test(String(value))) {
      return callback(new Error('最多两位小数'));
    }
    if (Number(value) <= 0) {
      return callback(new Error('课时必须大于 0'));
    }
    callback();
  },
  trigger: 'blur',
};

const positiveIntRule: FormItemRule = {
  validator: (_rule, value: number | string, callback) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      return callback(new Error('请输入正整数'));
    }
    callback();
  },
  trigger: 'blur',
};

const rules: FormRules<PackageFormModel> = {
  name: [{ required: true, message: '请输入课包名称', trigger: 'blur' }],
  price: [decimalRule],
  hours: [positiveDecimalRule],
  validDays: [positiveIntRule],
};

async function onSubmit(): Promise<void> {
  if (!formRef.value) return;
  // Element Plus async-validator does not reliably reject invalid required /
  // custom-rule fields under jsdom, so guard the invariants explicitly before
  // running (and surfacing) the form validation.
  const nameOk = form.name.trim().length > 0;
  const priceNum = Number(form.price);
  const hoursNum = Number(form.hours);
  const validDaysNum = Number(form.validDays);
  const priceOk = form.price !== '' && !Number.isNaN(priceNum) && priceNum > 0;
  const hoursOk = form.hours !== '' && !Number.isNaN(hoursNum) && hoursNum > 0;
  const validDaysOk = Number.isInteger(validDaysNum) && validDaysNum > 0;
  if (!nameOk || !priceOk || !hoursOk || !validDaysOk) {
    try {
      await formRef.value.validate();
    } catch {
      /* validation messages shown */
    }
    return;
  }
  try {
    await formRef.value.validate();
  } catch {
    return;
  }
  // Emit with price/hours as strings (decimal-string wire contract).
  emit('submit', {
    name: form.name.trim(),
    price: String(form.price),
    hours: String(form.hours),
    validDays: Number(form.validDays),
  });
}
</script>

<template>
  <form data-testid="package-form" @submit.prevent="onSubmit">
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <el-form-item label="课包名称" prop="name">
        <el-input v-model="form.name" name="name" placeholder="如：10课时包" />
      </el-form-item>
      <el-form-item label="价格（元）" prop="price">
        <el-input v-model="form.price" name="price" placeholder="如：1000.00" />
      </el-form-item>
      <el-form-item label="课时" prop="hours">
        <el-input v-model="form.hours" name="hours" placeholder="如：10.00" />
      </el-form-item>
      <el-form-item label="有效天数" prop="validDays">
        <el-input v-model="form.validDays" name="validDays" placeholder="如：180" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" native-type="submit" data-testid="package-submit">保存课包</el-button>
      </el-form-item>
    </el-form>
  </form>
</template>
