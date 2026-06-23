import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getTxcPrice, type TxcPrice } from "@/lib/txc/price.functions";

/** Shared TXC price query — single in-flight request across the app. */
export function useTxcPrice() {
  const fn = useServerFn(getTxcPrice);
  return useQuery<TxcPrice | null>({
    queryKey: ["txc-price"],
    queryFn: () => fn(),
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
}
