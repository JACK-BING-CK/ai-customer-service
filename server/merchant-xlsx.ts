import { fileURLToPath } from "node:url";
import { fromBufferPromise } from "yauzl";
import * as XLSX from "xlsx";
import {
  merchantFields, merchantKinds, merchantSheetNames, rememberMerchantRowNumber,
  type MerchantKind, type MerchantRow, type MerchantRows,
} from "../shared/merchant.ts";

export const merchantTemplatePath = fileURLToPath(new URL(
  "./assets/店铺客服资料录入模板.xlsx", import.meta.url,
));
export const merchantUploadLimit = 5 * 1024 * 1024;
const expandedLimit = 16 * 1024 * 1024;
const maxRowsPerSheet = 5000;
const dateFields = new Set(["下单时间", "签收时间", "物流更新时间", "生效时间（含）", "失效时间（不含）"]);
const idFields = new Set(["商品编码（SKU）", "订单号", "成交商品编码", "店铺会员编号", "条款编号", "问答编号", "版本"]);

class ImportError extends Error {}

// Verify decoded byte counts before passing the workbook to the in-memory reader.
async function checkArchive(buffer: Buffer) {
  const zip = await fromBufferPromise(buffer, { validateEntrySizes: true, strictFileNames: true });
  let bytes = 0;
  const names = new Set<string>();
  try {
    if (zip.entryCount > 200) throw new ImportError("Excel 文件内容过多，请使用资料模板分批导入。");
    for await (const entry of zip.eachEntry()) {
      if (names.has(entry.fileName) || !entry.canDecodeFileData()) {
        throw new ImportError("Excel 文件含重复、加密或不支持的内容，请重新保存为普通 .xlsx。");
      }
      names.add(entry.fileName);
      if (entry.uncompressedSize > expandedLimit - bytes) throw new ImportError("Excel 解压后超过 16 MB，请分批导入。");
      if (entry.fileName.endsWith("/")) continue;
      const stream = await zip.openReadStreamPromise(entry);
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > expandedLimit) throw new ImportError("Excel 解压后超过 16 MB，请分批导入。");
      }
    }
    if (!names.has("xl/workbook.xml") || !names.has("[Content_Types].xml") || names.has("xl/vbaProject.bin")) {
      throw new ImportError("请上传普通 .xlsx 格式的 Excel 资料模板。");
    }
  } finally {
    zip.close();
  }
}

// Excel serial dates are local wall-clock values, independent of the server's time zone.
function excelDate(value: number, date1904: boolean, where: string) {
  const day = Math.floor(value);
  if (!Number.isFinite(value) || value < 0 || (!date1904 && day === 60) || value > 2958465) {
    throw new ImportError(where + " 的日期无效。");
  }
  const origin = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, day < 60 ? 31 : 30);
  return new Date(origin + Math.round(value * 86400) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function cellValue(cell: XLSX.CellObject | undefined, field: string, where: string, date1904: boolean) {
  if (!cell) return "";
  if (cell.f !== undefined || cell.F !== undefined) {
    throw new ImportError(where + " 使用了公式，请在 Excel 中复制并粘贴为值。");
  }
  if (cell.t === "e") throw new ImportError(where + " 含有 Excel 错误值。");
  if (cell.t === "z" || cell.v === undefined || cell.v === null) return "";
  if (cell.t === "n" && typeof cell.v === "number") {
    if (dateFields.has(field)) return excelDate(cell.v, date1904, where);
    if (idFields.has(field)) {
      if (!Number.isSafeInteger(cell.v) || String(Math.abs(cell.v)).length > 15) {
        throw new ImportError(where + " 的数字编号可能被 Excel 舍入，请设置为文本并重新填写。");
      }
      if (cell.w && /^\d+$/.test(cell.w)) return cell.w;
    }
  }
  return String(cell.v).trim();
}

function parseSheet(sheet: XLSX.WorkSheet, kind: MerchantKind, date1904: boolean) {
  const name = merchantSheetNames[kind];
  const fields = merchantFields[kind];
  const columns = new Map<number, string>();
  const entries = Object.keys(sheet).filter(address => !address.startsWith("!"));

  for (const address of entries) {
    const { r, c } = XLSX.utils.decode_cell(address);
    if (r !== 3) continue;
    const header = cellValue(sheet[address], "", name + " 第 4 行 " + address, date1904);
    if (!header) continue;
    if (!fields.includes(header) || [...columns.values()].includes(header)) {
      throw new ImportError(name + " 第 4 行 " + address + " 的表头「" + header + "」未知或重复，请核对模板。");
    }
    columns.set(c, header);
  }
  const missing = fields.filter(field => ![...columns.values()].includes(field));
  if (missing.length) throw new ImportError(name + " 第 4 行缺少表头「" + missing.join("」「") + "」。");

  const rows = new Map<number, MerchantRow>();
  for (const address of entries) {
    const { r, c } = XLSX.utils.decode_cell(address);
    if (r < 4) continue;
    const field = columns.get(c);
    const where = name + " 第 " + (r + 1) + " 行 " + (field ? "「" + field + "」" : address);
    const value = cellValue(sheet[address], field ?? "", where, date1904);
    if (!value) continue;
    if (!field) throw new ImportError(where + " 有数据，但这一列没有模板表头。");
    let row = rows.get(r);
    if (!row) {
      if (rows.size >= maxRowsPerSheet) throw new ImportError(name + " 超过 5,000 行数据，请分批导入。");
      row = Object.fromEntries(fields.map(key => [key, ""]));
      rememberMerchantRowNumber(row, r + 1);
      rows.set(r, row);
    }
    row[field] = value;
  }
  return [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

export async function parseMerchantWorkbook(buffer: Buffer): Promise<MerchantRows> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ImportError("请上传 Excel 资料模板。");
  if (buffer.length > merchantUploadLimit) throw new ImportError("Excel 文件上限为 5 MB，请分批导入。");
  let workbook: XLSX.WorkBook;
  try {
    await checkArchive(buffer);
    workbook = XLSX.read(buffer, {
      type: "buffer", cellDates: false, cellFormula: true, cellHTML: false, sheetStubs: true,
    });
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("无法读取 Excel 文件，请确认文件完整并保存为未加密的 .xlsx。");
  }
  const result: MerchantRows = {};
  for (const name of workbook.SheetNames) {
    if (name === "填表说明") continue;
    const kind = merchantKinds.find(key => merchantSheetNames[key] === name);
    if (!kind) throw new ImportError("工作表「" + name + "」不属于模板，请核对表名。");
    result[kind] = parseSheet(workbook.Sheets[name], kind, Boolean(workbook.Workbook?.WBProps?.date1904));
  }
  if (!Object.values(result).some(rows => rows.length)) throw new ImportError("工作簿中没有可导入的数据，请从第 5 行开始填写。");
  return result;
}
