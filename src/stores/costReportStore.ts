import { create } from "zustand";
import { EMPTY_FILTER, type CostReportFilter } from "../lib/costReport";
import type { ProjectCostReport } from "../lib/types";

// The per-image report (project_cost_lines) is a full project walk, not
// something disk-cached like the shot/sequence cost totals — so this store
// is what keeps the last-generated report + filter alive across closing and
// reopening Project Settings within the same app session, instead of
// silently discarding it (and forcing a re-walk) every time the dialog
// unmounts. In-memory only — a fresh app launch starts empty, same as
// before "Generate report" is first clicked.
type State = {
  reportData: ProjectCostReport | null;
  reportFilter: CostReportFilter;
};

type Actions = {
  setReportData: (data: ProjectCostReport | null) => void;
  setReportFilter: (updater: (f: CostReportFilter) => CostReportFilter) => void;
};

export const useCostReportStore = create<State & Actions>((set) => ({
  reportData: null,
  reportFilter: EMPTY_FILTER,
  setReportData(reportData) {
    set({ reportData });
  },
  setReportFilter(updater) {
    set((s) => ({ reportFilter: updater(s.reportFilter) }));
  },
}));
