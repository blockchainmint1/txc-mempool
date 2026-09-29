import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/api/")({
  beforeLoad: () => {
    throw redirect({ to: "/docs", replace: true });
  },
});
