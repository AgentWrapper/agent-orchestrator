"use client";

import { createContext, useContext } from "react";

interface SidebarContextValue {
  onToggleSidebar: () => void;
  mobileSidebarOpen?: boolean;
}

export const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebarContext() {
  return useContext(SidebarContext);
}
