export const hubPath = "/hub";

export const projectPages = [
  { id: "customer", path: "/", title: "顾客窗口", description: "向 AI 咨询、查订单，或在原对话中转人工。" },
  { id: "agent", path: "/agent", title: "坐席工作台", description: "接待等待中的顾客，核对交接记录并回复。" },
  { id: "merchant", path: "/merchant", title: "店铺资料管理", description: "维护商品、订单、政策版本和常见问答。" },
  { id: "debug", path: "/debug", title: "独立调试后台", description: "查看模块运行情况，按流程编号追查每一步。" },
] as const;
