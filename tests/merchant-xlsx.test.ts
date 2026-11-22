import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as XLSX from "xlsx";
import { merchantFields, merchantRowNumber } from "../shared/merchant.ts";
import { merchantTemplatePath, parseMerchantWorkbook } from "../server/merchant-xlsx.ts";
import { openCommerce } from "../server/commerce.ts";
import { openMerchant } from "../server/merchant-store.ts";

function sample(name: string, values: unknown[][], edit?: (book: XLSX.WorkBook) => void) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(values), name);
  edit?.(book);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test("loads the exact previous template, ignoring instructions and formatted empty rows", async () => {
  const rows = await parseMerchantWorkbook(readFileSync(merchantTemplatePath));
  assert.deepEqual(Object.values(rows).map(group => group.length), [1, 2, 2, 2]);
  assert.equal(rows.products?.[0]["商品编码（SKU）"], "CUP-500-G");
  assert.equal(rows.orders?.[1]["订单号"], "DEMO-1002");
  assert.equal(rows.orders?.[1]["下单时间"], "2026-11-15 00:00:00");
  assert.equal(rows.policies?.[1]["失效时间（不含）"], "");
  assert.equal(merchantRowNumber(rows.faqs![1]), 6);
});

test("retains original row number and Beijing wall time for real Excel dates in both calendars", async () => {
  const stamp = Date.UTC(2026, 10, 14, 23, 59, 59);
  for (const date1904 of [false, true]) {
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const headers = ["下单时间", ...merchantFields.orders.filter(key => key !== "下单时间")];
    const file = sample("已售明细", [[], [], [], headers, [], [(stamp - base) / 86400000, "ORDER-1"]], book => {
      book.Workbook = { WBProps: { date1904 } };
      book.Sheets["已售明细"].A6.z = "yyyy-mm-dd hh:mm:ss";
    });
    const row = (await parseMerchantWorkbook(file)).orders![0];
    assert.equal(row["下单时间"], "2026-11-14 23:59:59");
    assert.equal(merchantRowNumber(row), 6);
  }
});

test("reports the sheet and cell for Excel formula, error and unexpected columns", async () => {
  for (const value of [{ t: "n", f: "1+1", v: 2 }, { t: "n", f: "1+1" }, { t: "e", v: 7 }]) {
    const file = sample("常见问答", [[], [], [], merchantFields.faqs, ["FAQ-X", "F1"]], book => {
      book.Sheets["常见问答"].B5 = value;
    });
    await assert.rejects(parseMerchantWorkbook(file), /常见问答.*第 5 行.*版本/);
  }
  const file = sample("常见问答", [[], [], [], merchantFields.faqs, [...merchantFields.faqs, "其他"]]);
  await assert.rejects(parseMerchantWorkbook(file), /常见问答.*第 5 行/);
});

test("unknown product codes report only their actual worksheet and row in preview and commit", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    openCommerce(db);
    const merchant = openMerchant(db);
    const order = ["PRIVATE-ORDER-1", "1", "A", "PRIVATE-TYPO", "旅行杯", "1", "演示店", "独立站",
      "秋季", "2026-11-12 11:00:00", "待发货", "", "2026-11-12 11:00:00"];
    const file = sample("已售明细", [[], [], [], merchantFields.orders, [], order, [], ["PRIVATE-ORDER-2", ...order.slice(1)]]);
    const rows = await parseMerchantWorkbook(file);
    const before = merchant.list();
    for (const commit of [false, true]) {
      const result = merchant.apply(rows, commit);
      assert.equal(result.ok, false);
      assert.deepEqual(result.importIssues, [
        { code: "unknown_product_sku", sheet: "已售明细", row: 6 },
        { code: "unknown_product_sku", sheet: "已售明细", row: 8 },
      ]);
      assert.deepEqual(merchant.list(), before);
    }
    const manual = merchant.apply({ orders: [{ ...rows.orders![0] }] }, true);
    assert.equal(manual.ok, false);
    assert.deepEqual(manual.importIssues, []);
  } finally {
    db.close();
  }
});

test("preserves zero-padded numeric SKU codes and diagnoses numeric IDs exceeding Excel precision", async () => {
  const fileFor = (code: number) => sample("商品资料", [[], [], [], merchantFields.products, [code]], book => {
    book.Sheets["商品资料"].A5.z = "000000";
  });
  assert.equal((await parseMerchantWorkbook(fileFor(15))).products![0]["商品编码（SKU）"], "000015");
  await assert.rejects(parseMerchantWorkbook(fileFor(1234567890123456)), /商品资料.*第 5 行.*设置为文本/);
});

test("rejects empty, non-template, corrupted and oversized workbooks in Chinese", async () => {
  await assert.rejects(parseMerchantWorkbook(Buffer.from("not an xlsx")), /Excel|xlsx/);
  await assert.rejects(parseMerchantWorkbook(Buffer.alloc(5 * 1024 * 1024 + 1)), /5 MB/);
  await assert.rejects(parseMerchantWorkbook(sample("工作表1", [["a"]])), /工作表1/);
  await assert.rejects(parseMerchantWorkbook(sample("已售明细", [[], [], [], ["买了什么"]])), /已售明细.*第 4 行/);
  await assert.rejects(parseMerchantWorkbook(sample("商品资料", [[], [], [], merchantFields.products])), /没有.*数据/);
});
