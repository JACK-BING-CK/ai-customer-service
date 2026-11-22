import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import { hubPath, projectPages } from "../shared/pages";
import "./styles.css";

const path = location.pathname.replace(/\/+$/, "") || "/";
const Agent = lazy(() => import("./Agent").then(module => ({ default: module.Agent })));
const TraceMessage = lazy(() => import("./TraceMessage").then(module => ({ default: module.TraceMessage })));
const traceEvent = new URLSearchParams(location.search).get('traceEvent');
const Customer = lazy(() => import("./Customer").then(module => ({ default: module.Customer })));
const Debug = lazy(() => import("./Debug").then(module => ({ default: module.Debug })));
const Merchant = lazy(() => import("./Merchant").then(module => ({ default: module.Merchant })));
const PageHub = lazy(() => import("./PageHub").then(module => ({ default: module.PageHub })));
const page = projectPages.find(entry => entry.path === path);
const views = {
  customer: <Customer />,
  agent: traceEvent ? <TraceMessage eventId={traceEvent} /> : <Agent />,
  merchant: <Merchant />,
  debug: <Debug />,
};
document.title = path === hubPath ? "客服工作导航" : (page?.title ?? "在线客服") + " · 客服中心";
createRoot(document.getElementById("root")!).render(
  <Suspense fallback={<p role="status">正在打开页面…</p>}>
    {path === hubPath ? <PageHub /> : views[page?.id ?? "customer"]}
  </Suspense>
);
