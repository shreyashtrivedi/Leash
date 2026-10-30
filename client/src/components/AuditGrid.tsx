import { useMemo, useRef, useState } from "react";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import type { Agent, AuditEvent } from "../api";
import { eventMeta, formatTime } from "../format";
import { Icon } from "./Icon";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "'Instrument Sans', system-ui, sans-serif",
  fontSize: 14,
  accentColor: "#1F5F4A",
  borderColor: "#E3E1D9",
  headerBackgroundColor: "#FAF9F5",
  headerTextColor: "#5E6470",
  foregroundColor: "#16181D",
  rowHoverColor: "#F4F3EE",
  wrapperBorderRadius: 12,
});

function EventCell({ data }: ICellRendererParams<AuditEvent>) {
  if (!data) return null;
  const meta = eventMeta(data.type);
  return (
    <span className={`grid-event tone-${meta.tone}`}>
      <Icon name={meta.icon} size={14} /> {meta.label}
    </span>
  );
}

export default function AuditGrid({ events, agents }: { events: AuditEvent[]; agents: Agent[] }) {
  const grid = useRef<AgGridReact<AuditEvent>>(null);
  const [search, setSearch] = useState("");

  const columns = useMemo<ColDef<AuditEvent>[]>(
    () => [
      {
        headerName: "Time",
        field: "at",
        width: 190,
        sort: "desc",
        valueFormatter: ({ value }) => formatTime(value),
      },
      {
        headerName: "Agent",
        width: 160,
        valueGetter: ({ data }) => agents.find((agent) => agent.id === data?.agent_id)?.name ?? "Leash",
      },
      {
        headerName: "Event",
        width: 150,
        valueGetter: ({ data }) => eventMeta(data?.type ?? "").label,
        cellRenderer: EventCell,
      },
      {
        headerName: "Details",
        flex: 1,
        minWidth: 320,
        valueGetter: ({ data }) => [data?.summary, data?.explanation].filter(Boolean).join(" · "),
        tooltipValueGetter: ({ value }) => value,
      },
      {
        headerName: "Source",
        width: 110,
        valueGetter: ({ data }) => (data?.sample ? "Sample" : "Live"),
      },
    ],
    [agents],
  );

  return (
    <section className="panel audit">
      <div className="audit-tools">
        <div>
          <h2>Audit log</h2>
          <p>Append-only. Every decision, approval and payment, with its reason.</p>
        </div>
        <input
          type="search"
          placeholder="Search the log"
          aria-label="Search the audit log"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button className="button" onClick={() => grid.current?.api.exportDataAsCsv({ fileName: "leash-audit-log.csv" })}>
          Export CSV
        </button>
      </div>
      <div className="audit-grid">
        <AgGridReact<AuditEvent>
          ref={grid}
          theme={theme}
          rowData={events}
          columnDefs={columns}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={({ data }) => String(data.id)}
          quickFilterText={search}
          pagination
          paginationPageSize={20}
          paginationPageSizeSelector={[20, 50, 100]}
        />
      </div>
    </section>
  );
}
