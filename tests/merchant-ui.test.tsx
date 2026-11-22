import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { MerchantEditor } from "../client/MerchantEditor";
import { MerchantTrial, TrialComparison } from "../client/MerchantTrial";
import { merchantRequest } from "../client/merchant-library";
import { merchantFields, type MerchantRow } from "../shared/merchant";

afterEach(() => vi.unstubAllGlobals());
const library = { fields: merchantFields, data: { products: [], orders: [], policies: [], faqs: [] } };
const callbacks = { onClose: () => {}, onSaved: () => {} };
const base: MerchantRow = {
  "条款编号": "R", "版本": "V1", "名称": "旅行杯期限", "适用店铺": "测试店", "渠道": "网页", "活动": "日常销售",
  "生效时间（含）": "2026-11-01 00:00:00", "发布状态": "已发布", "条款原文": "签收次日起7个日历日内可申请退货。",
};

it("copies a published policy as a new draft with an empty activation date", () => {
  const html = renderToStaticMarkup(<MerchantEditor library={library} kind="policies" source={base} mode="copy" {...callbacks}/>);
  expect(html).toContain("保存草稿");
  expect(html).toContain('value="草稿"');
  expect(html).not.toContain("2026-11-01T00:00:00");
  expect(html).toContain(base["条款原文"]);
});

it("keeps the stored text while copying an approved FAQ to a new draft", () => {
  const source = { "问答编号": "FAQ-1", "版本": "F1", "顾客常用问法": "哪款是绿色？", "标准答复": "选绿色规格。", "状态": "已审核" };
  const html = renderToStaticMarkup(<MerchantEditor library={library} kind="faqs" source={source} mode="copy" {...callbacks}/>);
  expect(html).toContain("新建问答版本");
  expect(html).toContain(source["标准答复"]);
  expect(html).toContain('<option selected="">草稿</option>');
  expect(html).not.toContain('value="F1"');
});

it("preselects distinct purchases within scope for the first policy and hides publish until a trial", () => {
  const orders = ["2026-11-11", "2026-11-13"].map((date, index) => ({
    "订单号": "T-" + index, "下单时间": date + " 08:00:00", "店铺": "测试店", "成交渠道": "网页", "成交活动": "日常销售",
  }));
  const html = renderToStaticMarkup(<MerchantTrial policy={{...base, "发布状态":"草稿"}} orders={orders} policies={[]} {...callbacks}/>);
  expect(html).toContain('<option value="T-0" selected="">');
  expect(html).toContain('<option value="T-1" selected="">');
  expect(html).toContain("运行试算");
  expect(html).not.toContain("确认发布此版本");
});

it("confirms the unchanged workbook bytes with its preview token and displays per-row errors", async () => {
  const file = new File(["worksheet"], "店铺.xlsx");
  const transport = vi.fn().mockResolvedValue(Response.json({errors:["已售明细第 6 行：时间冲突。"]}, {status:422}));
  vi.stubGlobal("fetch", transport);
  await expect(merchantRequest("/import/commit", file, {"X-Import-Preview":"approved"})).rejects.toThrow("第 6 行");
  expect(transport).toHaveBeenCalledWith("/api/merchant/import/commit", expect.objectContaining({
    body:file, headers:{"Content-Type":"application/octet-stream", "X-Import-Preview":"approved"},
  }));
});

it("displays archived decisions as the two sides at publication without a publishing control", () => {
  const before = {status:"expired", version:"V1", deadline:"2026-11-23 23:59:59", reason:"按旧版计算已到期。"};
  const after = {status:"eligible", version:"V2", deadline:"2026-11-30 23:59:59", reason:"发布时匹配十四天期限。"};
  const report = {asOf:"2026-11-24 00:00:00", issues:[], results:[
    {orderId:"OLD-1", before, after:before, changed:false, reason:"结果一致"},
    {orderId:"NEW-2", before, after, changed:true, reason:"版本变化"},
  ]};
  const html = renderToStaticMarkup(<TrialComparison report={report} archived />);
  for (const text of ["OLD-1","NEW-2","发布前","发布后",before.reason,after.reason,after.deadline,report.asOf]) expect(html).toContain(text);
  expect(html).not.toContain("确认发布");
  expect(html).not.toContain("当前政策");
});

it("shows each historical answer against the independently marked expectation and reports failures", async () => {
  const { ReplayComparison } = await import("../client/MerchantFeedback");
  const html = renderToStaticMarkup(<ReplayComparison report={{
    at: 1795478400000, passed: false, issues: ["存在答复不符合预期的历史案例。"],
    rows: [{caseId:"CASE-1", question:"可补发纸质说明书吗？", expected:"可以补寄。", before:"请转人工处理。", after:"只能下载电子版。", passed:false, detail:"标准答复与坐席预期不同。"}],
  }} />);
  for (const expected of ["可补发纸质说明书吗？","坐席预期","可以补寄。","回放时的已发布版本","请转人工处理。","本次修订","只能下载电子版。","标准答复与坐席预期不同。","未通过"]) expect(html).toContain(expected);
});

it("forwards the version and optional seat credential when replaying an operations draft", async () => {
  const { feedbackRequest } = await import("../client/feedback-api");
  const transport = vi.fn().mockResolvedValue(Response.json({item:{id:"one",version:8}}));
  vi.stubGlobal("fetch",transport);
  await feedbackRequest("/one/replay", {expectedVersion:7}, "demo-local");
  expect(transport).toHaveBeenCalledWith("/api/feedback/one/replay", expect.objectContaining({
    method:"POST", body:JSON.stringify({expectedVersion:7}), headers:expect.objectContaining({Authorization:"Bearer demo-local"}),
  }));
});

it("opens publication only after the saved revision passes its replay", async () => {
  const { CaseDetail } = await import("../client/MerchantFeedback");
  const item = {id:"CASE-1",conversationId:"conversation",messageId:"q",version:2,draftVersion:2,
    question:"可以补寄说明书吗？",originalAnswer:"需核实。",handoffReason:"顾客请求人工",reason:"faq_gap" as const,note:"",
    expected:{kind:"faq" as const,answer:"可以。"},createdAt:1,publishedAt:null,
    draft:{kind:"faq" as const,row:{"问答编号":"MANUAL","版本":"F2"}},replay:{at:2,passed:true,rows:[],issues:[]}};
  const callbacks = {library,onUpdate:()=>{},onPublished:()=>{},onReload:()=>{}};
  for (const [status,pass,disabled] of [["draft",true,true],["blocked",false,true],["passed",true,false]] as const) {
    const html=renderToStaticMarkup(<CaseDetail item={{...item,status,replay:status==="draft"?null:{...item.replay,passed:pass}}} {...callbacks}/>);
    const publishButton=html.match(/<button[^>]*>发布修订<\/button>/)?.[0];
    expect(html).toContain('/debug?conversation=conversation');
    expect(publishButton).toBeDefined();
    expect(publishButton!.includes("disabled")).toBe(disabled);
  }
});

it("offers both comparison orders in a policy feedback replay and the publication receipt for older cases", async () => {
  const {CaseDetail}=await import("../client/MerchantFeedback");
  const item={id:"c",conversationId:"s",messageId:"q",version:3,draftVersion:2,question:"还能退吗？",originalAnswer:"已过期",
    handoffReason:"顾客请求人工",reason:"policy_issue" as const,note:"",expected:{kind:"policy" as const,status:"eligible" as const},
    createdAt:1,publishedAt:null,draft:{kind:"policy" as const,row:base,orderIds:["OLD","NEW"]}};
  const old={status:"expired",version:"R1",deadline:"2026-11-23 23:59:59",reason:"七天已过。"};
  const next={status:"eligible",version:"R2",deadline:"2026-11-30 23:59:59",reason:"十四天内。"};
  const replay={at:2,passed:true,issues:[],rows:[]};
  const orderTrial={asOf:"2026-11-24 00:00:00",issues:[],results:[
    {orderId:"OLD",before:old,after:old,changed:false,reason:"结果一致"},
    {orderId:"NEW",before:old,after:next,changed:true,reason:"结果改变"},
  ]};
  const callbacks={library,onUpdate:()=>{},onPublished:()=>{},onReload:()=>{}};
  const html=renderToStaticMarkup(<CaseDetail item={{...item,status:"passed",replay:{...replay,orderTrial}}} {...callbacks}/>);
  for(const field of ["两笔订单的试算结果","OLD","NEW","判断一致","判断有变化","七天已过。","十四天内。"]) expect(html).toContain(field);
  const legacy=renderToStaticMarkup(<CaseDetail item={{...item,status:"published",publishedAt:3,replay}} {...callbacks}/>);
  expect(legacy).toContain("查看发布时的两单试算记录");
});
