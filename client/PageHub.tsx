import { projectPages } from "../shared/pages";
import { Icon } from "./ui";
import "./page-hub.css";

const pageIcons = {
  customer: <Icon name="chat" />,
  agent: <Icon name="headset" />,
  merchant: (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round">
      <path d="M4.5 10v9.5h15V10M3 9.5l2-5h14l2 5a3 3 0 0 1-4.5 2 3 3 0 0 1-4.5 0 3 3 0 0 1-4.5 0 3 3 0 0 1-4.5-2Z" />
      <path d="M9 19.5v-5h6v5" />
    </svg>
  ),
  debug: <Icon name="workflow" />,
};

export function PageHub() {
  return (
    <div className="page-hub">
      <header className="app-header">
        <div className="hub-shell hub-topbar">
          <div className="brand"><span className="brand-mark"><Icon name="headset" /></span>客服中心</div>
        </div>
      </header>
      <main className="hub-shell hub-content" aria-labelledby="hub-title">
        <h1 id="hub-title">客服工作导航</h1>
        <nav className="hub-grid" aria-labelledby="hub-title">
          {projectPages.map(page => (
            <a className="hub-card" href={page.path} key={page.id} data-page={page.id}
              aria-labelledby={`hub-title-${page.id}`} aria-describedby={`hub-description-${page.id}`}>
              <span className="hub-mark">{pageIcons[page.id]}</span>
              <h2 id={`hub-title-${page.id}`}>{page.title}</h2>
              <p id={`hub-description-${page.id}`}>{page.description}</p>
              <span className="hub-arrow" aria-hidden="true"><Icon name="arrow" width="18" height="18" /></span>
            </a>
          ))}
        </nav>
      </main>
    </div>
  );
}
