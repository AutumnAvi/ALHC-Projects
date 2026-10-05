"use client";

import { createContext, useContext, type ReactNode } from "react";
import { hasPortfolioRole, type PortfolioRole } from "@/lib/roles";

// The viewer's role in the current portfolio. Only hides controls; the database enforces the rules.
const PortfolioRoleContext = createContext<PortfolioRole | null>(null);

export function PortfolioAccessProvider({ role, children }: { role: PortfolioRole | null; children: ReactNode }) {
  return <PortfolioRoleContext.Provider value={role}>{children}</PortfolioRoleContext.Provider>;
}

export function usePortfolioRole() {
  return useContext(PortfolioRoleContext);
}

export function usePortfolioCan(min: PortfolioRole) {
  return hasPortfolioRole(useContext(PortfolioRoleContext), min);
}
