import { create } from "zustand";
import { EMPTY_FILTER, type CostReportFilter } from "../lib/costReport";
import type { ProjectCostReport } from "../lib/types";

// The per-image report (project_cost_lines) is a full project walk, not
// something disk-cached like the shot/sequence cost totals — so this store
// is what keeps the last-generated report + filter alive across leaving and
// re-entering AUDIT within the same app session, instead of silently
// discarding it (and forcing a re-walk) every time the mode unmounts.
// In-memory only — a fresh app launch starts empty and AUDIT loads it once.
type State = {
  reportData: ProjectCostReport | null;
  /** Which project `reportData` describes. AUDIT loads the report by itself
   *  now, so this is both the "already loaded, don't re-walk" guard and what
   *  stops a project switch from showing the previous project's numbers. */
  reportProject: string | null;
  reportFilter: CostReportFilter;
};

type Actions = {
  setReportData: (data: ProjectCostReport | null, project: string | null) => void;
  setReportFilter: (updater: (f: CostReportFilter) => CostReportFilter) => void;
};

export const useCostReportStore = create<State & Actions>((set) => ({
  reportData: null,
  reportProject: null,
  reportFilter: EMPTY_FILTER,
  setReportData(reportData, reportProject) {
    set({ reportData, reportProject });
  },
  setReportFilter(updater) {
    set((s) => ({ reportFilter: updater(s.reportFilter) }));
  },
}));
