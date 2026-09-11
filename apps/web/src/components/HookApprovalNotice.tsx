import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";

import { pendingHookApprovalRequestsAtom } from "../state/hookApprovals";
import { buildThreadRouteParams } from "../threadRoutes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function HookApprovalNotice() {
  const request = useAtomValue(pendingHookApprovalRequestsAtom)[0] ?? null;

  if (request === null) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label="Open pending custom hook approval"
            className="pointer-events-auto inline-flex size-[var(--workspace-titlebar-control-size)] items-center justify-center rounded-[var(--control-radius)] text-amber-700 outline-none hover:bg-amber-500/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background dark:text-amber-300"
            params={buildThreadRouteParams(request)}
            to="/$environmentId/$threadId"
          >
            <CircleAlertIcon aria-hidden className="size-4" />
          </Link>
        }
      />
      <TooltipPopup side="bottom">Custom hook approval needed</TooltipPopup>
    </Tooltip>
  );
}
