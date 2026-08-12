export const ADMIN_STYLES = String.raw`
  :root {
    color-scheme: dark;
    --bg: #070a0f;
    --bg-glow: #10233a;
    --surface: #0d121a;
    --surface-raised: #121923;
    --surface-hover: #151f2b;
    --border: #222d3a;
    --border-strong: #334155;
    --text: #edf2f7;
    --text-muted: #8e9baa;
    --text-faint: #8492a4;
    --accent: #7dd3fc;
    --accent-strong: #38bdf8;
    --accent-soft: rgba(56, 189, 248, 0.12);
    --success: #4ade80;
    --success-soft: rgba(74, 222, 128, 0.11);
    --warning: #fbbf24;
    --warning-soft: rgba(251, 191, 36, 0.11);
    --danger: #fb7185;
    --danger-soft: rgba(251, 113, 133, 0.12);
    --radius: 0.75rem;
    --radius-lg: 1rem;
    --shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
  }

  * {
    box-sizing: border-box;
  }

  html {
    min-width: 20rem;
    background: var(--bg);
  }

  body {
    min-height: 100vh;
    margin: 0;
    color: var(--text);
    background:
      radial-gradient(circle at 20% -10%, var(--bg-glow) 0, transparent 30rem),
      var(--bg);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 0.9375rem;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  a {
    color: var(--accent);
    text-decoration: none;
  }

  a:hover {
    color: #bae6fd;
  }

  button,
  input,
  select {
    font: inherit;
  }

  button,
  a {
    -webkit-tap-highlight-color: transparent;
  }

  :focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  .shell {
    width: min(100%, 96rem);
    margin: 0 auto;
    padding: clamp(1.25rem, 3vw, 2.5rem);
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 2rem;
    margin-bottom: 1.75rem;
  }

  .brand {
    display: flex;
    align-items: flex-start;
    gap: 0.9rem;
  }

  .brand-mark {
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid rgba(125, 211, 252, 0.28);
    border-radius: 0.8rem;
    color: var(--accent);
    background: linear-gradient(145deg, rgba(56, 189, 248, 0.2), rgba(56, 189, 248, 0.04));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 1.15rem;
    font-weight: 750;
  }

  .eyebrow {
    margin: 0 0 0.15rem;
    color: var(--accent);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(1.7rem, 3vw, 2.25rem);
    line-height: 1.15;
    letter-spacing: -0.035em;
  }

  .subtitle {
    margin: 0.4rem 0 0;
    color: var(--text-muted);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.65rem;
  }

  .button,
  button {
    display: inline-flex;
    min-height: 2.5rem;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    border: 1px solid transparent;
    border-radius: 0.6rem;
    padding: 0.5rem 0.85rem;
    font-weight: 650;
    line-height: 1;
    cursor: pointer;
  }

  .button-secondary {
    border-color: var(--border);
    color: var(--text);
    background: rgba(13, 18, 26, 0.72);
  }

  .button-secondary:hover {
    border-color: var(--border-strong);
    color: var(--text);
    background: var(--surface-hover);
  }

  .filter-panel {
    margin-bottom: 1.25rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: rgba(13, 18, 26, 0.9);
    box-shadow: var(--shadow);
  }

  .quick-views {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.65rem;
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
    scrollbar-width: thin;
  }

  .quick-view {
    flex: 0 0 auto;
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 0.42rem 0.75rem;
    color: var(--text-muted);
    font-size: 0.82rem;
    font-weight: 650;
  }

  .quick-view:hover {
    color: var(--text);
    background: var(--surface-hover);
  }

  .quick-view[aria-current="page"] {
    border-color: rgba(125, 211, 252, 0.24);
    color: var(--accent);
    background: var(--accent-soft);
  }

  .filters {
    display: grid;
    grid-template-columns: minmax(15rem, 2fr) repeat(5, minmax(7.5rem, 1fr)) auto;
    gap: 0.8rem;
    align-items: end;
    padding: 1rem;
  }

  .field {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.35rem;
  }

  .field-label {
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.055em;
    text-transform: uppercase;
  }

  input,
  select {
    width: 100%;
    min-height: 2.5rem;
    border: 1px solid var(--border);
    border-radius: 0.55rem;
    padding: 0.48rem 0.7rem;
    color: var(--text);
    background: #0a0f16;
  }

  input::placeholder {
    color: var(--text-faint);
  }

  input:hover,
  select:hover {
    border-color: var(--border-strong);
  }

  input:focus,
  select:focus {
    border-color: var(--accent-strong);
    outline: none;
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .filter-submit {
    min-height: 2.5rem;
    color: #04131a;
    background: var(--accent-strong);
  }

  .filter-submit:hover {
    background: var(--accent);
  }

  .active-filter-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0 1rem 0.9rem;
    color: var(--text-muted);
    font-size: 0.82rem;
  }

  .reset-link {
    flex: 0 0 auto;
    font-weight: 650;
  }

  .table-card {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .table-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.1rem;
    border-bottom: 1px solid var(--border);
  }

  .table-title {
    margin: 0;
    font-size: 1rem;
    letter-spacing: -0.01em;
  }

  .result-count {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.82rem;
  }

  .result-count strong {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .table-scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    min-width: 66rem;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  th,
  td {
    padding: 0.9rem 1rem;
    text-align: left;
    vertical-align: top;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    color: var(--text-faint);
    background: #0a0f16;
    font-size: 0.68rem;
    font-weight: 750;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  tbody tr {
    border-top: 1px solid var(--border);
  }

  tbody tr:first-child {
    border-top: 0;
  }

  tbody tr:hover {
    background: rgba(255, 255, 255, 0.018);
  }

  .received {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .received-date,
  .received-time {
    display: block;
  }

  .received-date {
    color: var(--text);
    font-weight: 600;
  }

  .received-time {
    margin-top: 0.12rem;
    color: var(--text-faint);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.72rem;
  }

  .event-title {
    display: inline-block;
    max-width: 28rem;
    color: var(--text);
    font-weight: 650;
    line-height: 1.35;
  }

  a.event-title:hover {
    color: var(--accent);
  }

  .event-id {
    display: block;
    max-width: 28rem;
    margin-top: 0.35rem;
    overflow: hidden;
    color: var(--text-faint);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.71rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .route-line {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }

  .source-badge {
    border: 1px solid rgba(125, 211, 252, 0.18);
    border-radius: 0.35rem;
    padding: 0.1rem 0.38rem;
    color: var(--accent);
    background: var(--accent-soft);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.7rem;
    font-weight: 650;
  }

  .route-arrow {
    color: var(--text-faint);
  }

  .subscription {
    color: var(--text);
    font-weight: 600;
  }

  .event-type {
    max-width: 16rem;
    margin-top: 0.4rem;
    overflow: hidden;
    color: var(--text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .severity {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.18rem 0.48rem;
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.025);
    font-size: 0.68rem;
    font-weight: 750;
    letter-spacing: 0.035em;
    text-transform: uppercase;
  }

  .severity--warning {
    border-color: rgba(251, 191, 36, 0.22);
    color: var(--warning);
    background: var(--warning-soft);
  }

  .severity--error,
  .severity--critical {
    border-color: rgba(251, 113, 133, 0.22);
    color: var(--danger);
    background: var(--danger-soft);
  }

  .severity--info {
    border-color: rgba(125, 211, 252, 0.2);
    color: var(--accent);
    background: var(--accent-soft);
  }

  .delivery-list {
    display: flex;
    min-width: 13rem;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.42rem;
  }

  .delivery-row {
    display: flex;
    max-width: 100%;
    align-items: flex-start;
    gap: 0.4rem;
  }

  .delivery-details {
    min-width: 0;
  }

  .delivery-details summary {
    list-style: none;
  }

  .delivery-details summary::-webkit-details-marker {
    display: none;
  }

  .status-pill {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 0.38rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.22rem 0.52rem;
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.025);
    font-size: 0.72rem;
    font-weight: 650;
    line-height: 1.2;
    cursor: pointer;
    white-space: nowrap;
  }

  .status-pill:hover {
    filter: brightness(1.15);
  }

  .status-pill--success {
    border-color: rgba(74, 222, 128, 0.2);
    color: var(--success);
    background: var(--success-soft);
  }

  .status-pill--warning {
    border-color: rgba(251, 191, 36, 0.2);
    color: var(--warning);
    background: var(--warning-soft);
  }

  .status-pill--danger {
    border-color: rgba(251, 113, 133, 0.22);
    color: var(--danger);
    background: var(--danger-soft);
  }

  .status-dot {
    width: 0.42rem;
    height: 0.42rem;
    flex: 0 0 auto;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 0 0.18rem color-mix(in srgb, currentColor 12%, transparent);
  }

  .delivery-meta {
    max-width: 28rem;
    margin: 0.45rem 0 0 0.45rem;
    padding-left: 0.7rem;
    border-left: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-size: 0.72rem;
  }

  .delivery-facts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.8rem;
    margin: 0;
  }

  .delivery-facts div {
    display: flex;
    gap: 0.3rem;
  }

  .delivery-facts dt {
    color: var(--text-faint);
  }

  .delivery-facts dd {
    margin: 0;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .delivery-error {
    margin: 0.45rem 0 0;
    overflow-wrap: anywhere;
    color: #fda4af;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    line-height: 1.45;
  }

  .retry {
    margin: 0;
  }

  .retry-button {
    min-height: 1.75rem;
    border-color: rgba(251, 113, 133, 0.24);
    border-radius: 999px;
    padding: 0.25rem 0.55rem;
    color: var(--danger);
    background: var(--danger-soft);
    font-size: 0.68rem;
  }

  .retry-button:hover {
    border-color: rgba(251, 113, 133, 0.42);
    background: rgba(251, 113, 133, 0.2);
  }

  .raw-link {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    font-size: 0.78rem;
    font-weight: 650;
    white-space: nowrap;
  }

  .muted {
    color: var(--text-faint);
  }

  .empty-cell {
    padding: 4.5rem 1rem;
    text-align: center;
  }

  .empty-state {
    width: min(100%, 28rem);
    margin: 0 auto;
  }

  .empty-icon {
    display: grid;
    width: 2.8rem;
    height: 2.8rem;
    margin: 0 auto 0.9rem;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 50%;
    color: var(--text-faint);
    background: var(--surface-raised);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .empty-title {
    margin: 0;
    font-size: 1rem;
  }

  .empty-copy {
    margin: 0.4rem 0 0;
    color: var(--text-muted);
  }

  .pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem 1rem;
    border-top: 1px solid var(--border);
  }

  .pagination-position {
    color: var(--text-faint);
    font-size: 0.78rem;
  }

  .pagination-links {
    display: flex;
    gap: 0.5rem;
  }

  .page-link {
    display: inline-flex;
    min-height: 2.1rem;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.38rem 0.68rem;
    color: var(--text-muted);
    font-size: 0.78rem;
    font-weight: 650;
  }

  .page-link:hover {
    border-color: var(--border-strong);
    color: var(--text);
    background: var(--surface-hover);
  }

  .page-note {
    margin: 0.8rem 0 0;
    color: var(--text-faint);
    font-size: 0.72rem;
    text-align: right;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 76rem) {
    .filters {
      grid-template-columns: repeat(4, minmax(8rem, 1fr));
    }

    .field-search {
      grid-column: span 2;
    }
  }

  @media (max-width: 56rem) {
    .shell {
      padding: 1rem;
    }

    .filters {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .table-scroll {
      overflow: visible;
    }

    table,
    tbody,
    tr,
    td {
      display: block;
      width: 100%;
    }

    table {
      min-width: 0;
    }

    thead {
      display: none;
    }

    tbody {
      display: grid;
      gap: 0.75rem;
      padding: 0.75rem;
      background: #090d13;
    }

    tbody tr {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
    }

    tbody tr:first-child {
      border-top: 1px solid var(--border);
    }

    td {
      min-width: 0;
      padding: 0.8rem;
      border-top: 1px solid var(--border);
    }

    td::before {
      display: block;
      margin-bottom: 0.35rem;
      color: var(--text-faint);
      content: attr(data-label);
      font-size: 0.65rem;
      font-weight: 750;
      letter-spacing: 0.065em;
      text-transform: uppercase;
    }

    td:nth-child(1),
    td:nth-child(2) {
      border-top: 0;
    }

    td:nth-child(5) {
      grid-column: span 2;
    }

    .empty-cell {
      grid-column: span 2;
      padding: 3rem 1rem;
      border-top: 0;
    }

    .empty-cell::before {
      display: none;
    }

    .event-title,
    .event-id,
    .event-type {
      max-width: none;
    }
  }

  @media (max-width: 38rem) {
    .page-header,
    .table-toolbar,
    .pagination {
      align-items: flex-start;
      flex-direction: column;
    }

    .header-actions,
    .header-actions .button {
      width: 100%;
    }

    .filters {
      grid-template-columns: 1fr;
    }

    .field-search {
      grid-column: span 1;
    }

    .filter-submit {
      width: 100%;
    }

    .active-filter-bar {
      align-items: flex-start;
      flex-direction: column;
    }

    tbody tr {
      grid-template-columns: 1fr;
    }

    td:nth-child(2) {
      border-top: 1px solid var(--border);
    }

    td:nth-child(5),
    .empty-cell {
      grid-column: span 1;
    }

    .pagination-links {
      width: 100%;
    }

    .page-link {
      flex: 1;
      justify-content: center;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
    }
  }
`
