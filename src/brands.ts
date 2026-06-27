/**
 * Brand options the customer picks at the start of a conversation. The `value`
 * MUST exactly match what the Intercom Workflow's "Brand is <value>" branches
 * check (we set it on the contact's `Brand` attribute). `key` is the short id
 * carried in the button callback data.
 */
export interface BrandOption {
  key: string;
  value: string;
  label: string;
}

export const BRAND_OPTIONS: BrandOption[] = [
  { key: "igaming", value: "DKM-IGAMING", label: "网络博彩 / IGaming" },
  { key: "b2bprovider", value: "B2B Provider", label: "B2B 供应商 / B2B Provider" },
  { key: "payflow", value: "B2B Payment", label: "PayFlow" },
];

export const BRAND_PROMPT = "请选择您想咨询的品牌 / Please select the brand you'd like to inquire about:";

export function brandByKey(key: string): BrandOption | undefined {
  return BRAND_OPTIONS.find((b) => b.key === key);
}
