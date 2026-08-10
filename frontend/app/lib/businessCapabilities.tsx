import { createContext, useContext, type ReactNode } from "react";
import type { BusinessCapabilities } from "~/lib/api/endpoints";

const BusinessCapabilitiesContext = createContext<BusinessCapabilities | null>(null);

export function BusinessCapabilitiesProvider({
  capabilities,
  children,
}: {
  capabilities: BusinessCapabilities;
  children: ReactNode;
}) {
  return (
    <BusinessCapabilitiesContext.Provider value={capabilities}>
      {children}
    </BusinessCapabilitiesContext.Provider>
  );
}

export function useBusinessCapabilities() {
  const value = useContext(BusinessCapabilitiesContext);
  if (!value) {
    throw new Error("Business capabilities are unavailable outside AppLayout");
  }
  return value;
}
