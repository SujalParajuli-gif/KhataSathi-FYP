import { useEffect, useState } from "react";

const PURCHASE_COST_VISIBILITY_KEY = "khatasathi_purchase_cost_visible";

export function usePurchaseCostPrivacy(available: boolean) {
  const [purchaseCostVisible, setPurchaseCostVisible] = useState(() => {
    if (typeof window === "undefined" || !available) return false;
    return window.sessionStorage.getItem(PURCHASE_COST_VISIBILITY_KEY) === "visible";
  });

  useEffect(() => {
    if (!available) {
      setPurchaseCostVisible(false);
      return;
    }
    window.sessionStorage.setItem(
      PURCHASE_COST_VISIBILITY_KEY,
      purchaseCostVisible ? "visible" : "hidden",
    );
  }, [available, purchaseCostVisible]);

  return {
    purchaseCostVisible: available && purchaseCostVisible,
    togglePurchaseCostVisibility: () => {
      if (available) setPurchaseCostVisible((current) => !current);
    },
  };
}
